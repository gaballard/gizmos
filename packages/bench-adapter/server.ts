/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI-compatible adapter over pi. For each chat completion request it spawns a real
 * pi agent session with the binding-check extension loaded, runs one turn, and returns
 * the assistant reply plus the binding-check PASS/FAIL verdict as a custom reply field.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { AgentSession, CustomEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Config **/

const PORT = Number(process.env.PORT ?? 8787);
// The lmstudio provider points wherever your global lmstudio extension does.
const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:10103/v1';

// Resolved via import.meta.url so `node server.ts` and transpiled runs both work.
const adapterRoot = fileURLToPath(new URL('..', import.meta.url));
const BINDING_CHECK_EXT =
  process.env.BINDING_CHECK_EXT ?? `${adapterRoot}extensions/binding-check/index.ts`;

/** Types **/

// binding-check's unresolved-FAIL signal (its NOTICE_TYPE).
const NOTICE_TYPE = 'binding-check-note';
type TNotice = CustomEntry<{ title?: string; body?: string }>;
const isNotice = (e: SessionEntry): e is TNotice =>
  e.type === 'custom' && e.customType === NOTICE_TYPE;

/** Verdict outcome from binding-check: a notice entry means FAIL, otherwise PASS. */
type Verdict = 'PASS' | 'FAIL';
/** Result of one adapter turn: the stripped assistant reply plus the binding-check outcome. */
type VerdictResult = { verdict: Verdict; finding?: string };
/** LM Studio /models row (snake_case fields preserved from the wire). */
type TModelInfo = { id: string; name?: string; context_length?: number };
/** Parsed POST /v1/chat/completions request body. */
type TChatCompletionRequest = { model?: string; messages?: unknown };

/** Fetch the live LM Studio /models endpoint; [] when unreachable so the catalog heals on refresh. */
const lmStudioModels = async (): Promise<TModelInfo[]> => {
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return []; // e.g. LM Studio not loaded yet - catalog heals on refresh
    const payload = (await res.json()) as { data: TModelInfo[] };
    return payload.data;
  } catch {
    return []; // server unreachable at boot - refresh heals once it is
  }
};

/** Map a live LM Studio model list to the pi-registry shape used by the lmstudio extension. */
const lmStudioCatalog = async () => {
  const list = await lmStudioModels();
  return list
    .filter((m) => !/embed/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 8192,
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
      },
    }));
};

// Reviewer default: if unset, point at the first currently-loaded LM Studio model so
// binding-check resolves a reviewer out of the box. Set before the first loader.reload()
// because the extension reads these at module import. Don't clobber a persisted /reviewer
// choice - if one exists, leave TURN_CHECK_MODEL unset so the forked extension picks it up.
process.env.TURN_CHECK_PROVIDER ??= 'lmstudio';
const STATE_PATH = `${process.env.HOME}/.pi/binding-check-reviewer.json`;
if (!process.env.TURN_CHECK_MODEL && !existsSync(STATE_PATH))
  process.env.TURN_CHECK_MODEL = (await lmStudioModels())[0]?.id ?? '';

/** Runtime **/

const runtime = await ModelRuntime.create({ allowModelNetwork: false });

// Register the lmstudio provider directly on the shared runtime (mirroring the global
// lmstudio extension) so the model resolves before any session is created. Registration
// lands async via refresh, so await it before findModel is safe.
new ModelRegistry(runtime).registerProvider('lmstudio', {
  name: 'LM Studio',
  baseUrl: LMSTUDIO_BASE_URL,
  apiKey: 'lm-studio',
  api: 'openai-completions',
  models: await lmStudioCatalog(),
  refreshModels: async () => lmStudioCatalog(),
});
await runtime.refresh({ allowNetwork: false, force: true });

const loader = new DefaultResourceLoader({
  cwd: adapterRoot,
  agentDir: `${process.env.HOME}/.pi/agent`,
  additionalExtensionPaths: [BINDING_CHECK_EXT],
});
await loader.reload();

/** Resolve a model by id, refreshing the live LM Studio catalog once on a miss.
 *  @param id model id (optionally `lmstudio/`-prefixed)
 *  @returns the resolved model, or undefined if it still isn't catalogued */
const findModel = async (id: string) => {
  const registry = new ModelRegistry(runtime);
  const clean = id.replace(/^lmstudio\//, '');
  let model = registry.find('lmstudio', clean);
  // The catalog is fetched at boot; if LM Studio wasn't ready then (or a model was
  // loaded afterwards) the runtime has no models and never heals. Refresh once on a
  // miss before giving up - refreshModels re-queries the live /models endpoint.
  if (!model) {
    await runtime.refresh({ allowNetwork: false, force: true });
    model = registry.find('lmstudio', clean);
  }
  return model;
};

/** Verdict **/

/** Resolve the binding-check verdict. A notice entry means FAIL (short-circuits the moment it
 *  lands); otherwise PASS after `agent_settled` plus a 1200 ms grace window, or a 12 s hard timeout.
 *  @param session the running pi agent session
 *  @returns the verdict and optional finding */
const awaitVerdict = (session: AgentSession): Promise<VerdictResult> =>
  new Promise((resolve) => {
    let isDone = false;
    const finish = (v: VerdictResult) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(hard);
      unsub();
      resolve(v);
    };
    const hard = setTimeout(() => finish({ verdict: 'PASS' }), 12_000);
    const unsub = session.subscribe((ev) => {
      if (ev.type === 'agent_settled') {
        setTimeout(() => finish({ verdict: 'PASS' }), 1200);
      } else if (ev.type === 'entry_appended' && isNotice(ev.entry)) {
        finish({
          verdict: 'FAIL',
          finding: ev.entry.data?.body ?? ev.entry.data?.title,
        });
      }
    });
  });

/** Run one pi turn for a chat completion, returning the reply plus the binding-check verdict.
 *  @param modelId LM Studio model id
 *  @param userText the assembled prompt
 *  @returns the stripped assistant reply, verdict, and optional finding */
const runTurn = async (modelId: string, userText: string) => {
  const model = await findModel(modelId);
  if (!model)
    throw new ApiError(
      400,
      `unknown model '${modelId}' (is it loaded in LM Studio?)`,
      'invalid_request_error',
    );

  const manager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime: runtime,
    model,
  });
  try {
    const turn = awaitVerdict(session);
    await session.prompt(userText);
    const turnResult = await turn;
    const notice = manager.getEntries().find(isNotice);
    const lastAssistant = session.messages.filter((m) => m.role === 'assistant').at(-1);
    return {
      content: textOnly(lastAssistant?.content),
      // entry_appended may resolve before the notice is persisted to the manager; prefer it.
      verdict: notice ? 'FAIL' : turnResult.verdict,
      finding: notice?.data?.body ?? turnResult.finding,
    };
  } finally {
    session.dispose();
  }
};

/** HTTP server **/

/** Join a chat request's messages (string, or array of `{ content: string }` blocks) into one prompt.
 *  @param messages the `messages` field of the request body
 *  @returns the trimmed joined prompt */
const buildMessage = (messages: unknown): string => {
  if (typeof messages === 'string') return messages.trim();
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => typeof (m as any)?.content === 'string')
    .map((m) => (m as { content: string }).content)
    .join('\n')
    .trim();
};

class ApiError extends Error {
  status: number;
  type: string;
  constructor(status: number, message: string, type: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/** Strip thinking blocks from assistant content so the OpenAI `content` field is the plain reply.
 *  @param content the assistant message content (string or block array)
 *  @returns the joined text blocks */
const textOnly = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        (b as any).type === 'text' &&
        typeof (b as any).text === 'string',
    )
    .map((b) => (b as { text: string }).text)
    .join('\n');
};

/** Drain the request and return its raw UTF-8 body. */
const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** Write `body` as JSON with the given status code. */
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

/** Write an error response: `ApiError` maps to its status/type, everything else to 500. */
const sendError = (res: ServerResponse, e: unknown) => {
  if (e instanceof ApiError)
    return send(res, e.status, { error: { message: e.message, type: e.type } });
  return send(res, 500, {
    error: { message: (e as Error).message, type: 'server_error' },
  });
};

const main = () => {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/models') {
        const data = (await lmStudioModels()).map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'pi-adapter',
        }));
        return send(res, 200, { object: 'list', data });
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as TChatCompletionRequest;
        const model = body.model ?? '';
        const start = Date.now();
        const { content, verdict, finding } = await runTurn(model, buildMessage(body.messages));
        return send(res, 200, {
          id: `chatcmpl-pi-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(start / 1000),
          model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: content ?? '',
                binding_check: { verdict, finding: finding || undefined },
              },
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            model_ms: Date.now() - start,
          },
        });
      }
      return send(res, 404, {
        error: { message: `no route for ${url.pathname}`, type: 'not_found' },
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(
      'pi-adapter on http://127.0.0.1:%d/v1 (reviewer: %s)',
      PORT,
      process.env.TURN_CHECK_MODEL
        ? `${process.env.TURN_CHECK_PROVIDER}/${process.env.TURN_CHECK_MODEL}`
        : 'persisted /reviewer state',
    );
  });
};

main();
