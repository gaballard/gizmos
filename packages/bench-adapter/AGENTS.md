# AGENTS.md - bench-adapter

Engineering reference for the OpenAI-compatible bench server over pi. The end-user story (running the server, endpoints, the `binding_check` field) lives in README.md - keep the two consistent when you edit either.

**The design why:** you want to benchmark an _agent_ (pi + binding-check), not a plain LLM - premature closure is a property of the agent loop and only shows up when the harness drives the real thing. So every completion is a full pi session with the binding-check extension loaded, exposed through the one interface benchmark harnesses already know (OpenAI chat completions), with the verdict surfaced as a structured reply field instead of buried in prose.

## How it works

`server.ts` is the whole module (~330 lines, no `src/`). Boot order matters:

1. **Env defaults** (`/** Config **/`, server.ts:27-34): resolve `PORT`, `LMSTUDIO_BASE_URL`, `BINDING_CHECK_EXT`. `adapterRoot = fileURLToPath(new URL('..', import.meta.url))` resolves to the repo's `packages/` dir (the _parent_ of the package dir), so the default extension path is `<repo>/packages/extensions/binding-check/index.ts` (absent from this workspace - the README tells users to set `BINDING_CHECK_EXT`) and every per-request session runs with `cwd` set there.
2. **Reviewer wiring** (server.ts:91-95): `TURN_CHECK_PROVIDER ??= 'lmstudio'`; `TURN_CHECK_MODEL` is set to the first live LM Studio model **only when** `~/.pi/binding-check-reviewer.json` does not exist. This runs before `loader.reload()` because the binding-check extension reads the env at module import; an existing persisted `/reviewer` choice is deliberately left unset so the forked extension reuses it.
3. **Runtime** (server.ts:98-110): `await ModelRuntime.create({ allowModelNetwork: false })`, then the `lmstudio` provider is registered directly on the shared runtime (mirroring the global lmstudio extension) with `models: await lmStudioCatalog()`, followed by `await runtime.refresh(...)`. Registration lands async via refresh - it is awaited before `findModel` is safe.
4. **Resource loader** (server.ts:113-117): one shared `DefaultResourceLoader` (`cwd: adapterRoot`, `agentDir: ~/.pi/agent`, `additionalExtensionPaths: [BINDING_CHECK_EXT]`), reused by every per-request session.

### Module tour

```ts
runTurn(modelId, userText): Promise<{ content, verdict, finding }>
awaitVerdict(session): Promise<{ verdict: 'PASS' | 'FAIL'; finding?: string }>
findModel(id): Promise<Model | undefined>   // strips `lmstudio/` prefix; refresh-once on a miss
buildMessage(messages): string              // string → trim; array → join only string-`content` blocks ('\n'); parts-style messages silently dropped
textOnly(content): string                   // keep only `type: 'text'` blocks (thinking stripped); all-thinking reply → ''
lmStudioModels(): Promise<TModelInfo[]>     // live GET `${LMSTUDIO_BASE_URL}/models`; 4 s timeout; [] on failure
lmStudioCatalog(): Promise<pi model[]>      // embed models filtered out; fixed shapes below
```

The `FAIL` signal is binding-check's notice entry type `NOTICE_TYPE = 'binding-check-note'`: an entry is a notice iff `entry.type === 'custom' && entry.customType === NOTICE_TYPE` (`isNotice`, server.ts:41-42), with `data: { title?, body? }`.

### Verdict resolution (`awaitVerdict`, server.ts:143-161)

`runTurn` (server.ts:187-189) installs the subscription **before** the prompt runs: `const turn = awaitVerdict(session)` - the promise's executor subscribes synchronously - then `await session.prompt(userText)`, then `const turnResult = await turn`. First resolution wins (`isDone` guard; unsubscribes and clears the pending timer):

1. `entry_appended` carrying a `binding-check-note` entry → `{ verdict: 'FAIL', finding: notice body ?? title }` immediately - short-circuits everything else, including the still-running turn (which continues solely to collect the reply `content`).
2. `agent_settled` → `{ verdict: 'PASS' }` **1200 ms** later (grace window: gives the extension time to persist a late notice; it fires only after a run completes, SDK `core/agent-session.js`).
3. Neither within **12 s** (`setTimeout 12_000`) → force-resolve `{ verdict: 'PASS' }` - a hang-guard; a hung `session.prompt` still stalls that HTTP request regardless (no request timeout).

The final verdict then **prefers the persisted notice** (`manager.getEntries().find(isNotice)`, read after both the prompt and the `turn` await) over the subscription result, because `entry_appended` can resolve before the entry is persisted: `verdict: notice ? 'FAIL' : turnResult.verdict`, `finding: notice?.data?.body ?? turnResult.finding`. A `PASS` means "no `binding-check-note` entry in the session after the turn" - no FAIL signal received, not verified-clean closure (assuming the not-in-workspace forked binding-check emits its notice only during turns; a boot-time notice would instead fail every request).

The session is disposed in a `finally` - every completion is a throwaway `SessionManager.inMemory()` session.

### HTTP surface

| Route / error               | Behavior                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | `buildMessage(body.messages)` → one `runTurn` → `{ choices[].message.content + binding_check }`, `usage`: zeros plus `model_ms` (wall-clock: the turn plus the verdict wait - up to the 1200 ms grace window, capped by the 12 s hard timeout) |
| `/v1/models`                | Live LM Studio list mapped to `{ id, object: 'model', created: 0, owned_by: 'pi-adapter' }` - **raw list, embed models included**                                                                                                              |
| unknown model id            | `400` `{ type: 'invalid_request_error' }` - `` `unknown model '<id>' (is it loaded in LM Studio?)` ``                                                                                                                                          |
| unmatched route             | `404` `{ type: 'not_found' }` - `` `no route for <path>` ``                                                                                                                                                                                    |
| any other thrown error      | `500` `{ type: 'server_error' }` with the error message                                                                                                                                                                                        |
| missing `BINDING_CHECK_EXT` | Boot proceeds; the loader records `Extension path does not exist: <resolved>` in `loader.extensionsResult.errors` (SDK resource-loader, verified) - server.ts never inspects it, so every completion resolves `PASS`                           |

`binding_check.finding` is sent as `finding || undefined`, so PASS responses omit the key. The server listens on `127.0.0.1` only.

## Scope

**Does:**

- Build one prompt per request from `messages` (string, or array of `{ content: string }` blocks, joined with `\n`).
- Spawn one in-memory pi session per completion with binding-check loaded via `additionalExtensionPaths`, run exactly one turn, dispose the session.
- Resolve and return the binding-check verdict as a structured `binding_check` reply field.
- Proxy the live LM Studio catalog at `/v1/models` and register the `lmstudio` provider (`api: 'openai-completions'`) on a shared `ModelRuntime`; injected model shapes are fixed (`reasoning: false`, `input: ['text']`, zero cost, `contextWindow: 32000`, `maxTokens: 8192`, `compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }`).
- Refresh the model registry exactly once on a model miss (`findModel`) - a boot-time catalog that was empty because LM Studio wasn't ready heals here.

**Does not:**

- Multi-turn dialogs or tool-call continuations - each request is one turn in a fresh conversation.
- Streaming (SSE) - single JSON completion.
- Multimodal message shapes - only string-valued `content` contributes to the prompt; parts-style content blocks are silently dropped (empty prompt if none remain).
- Compute the verdict itself - every FAIL/PASS is the binding-check extension's outcome; this server only observes, times, and routes it.
- Auth or non-loopback binding - dev tool, listens on `127.0.0.1` only.

Note a deliberate asymmetry: the HTTP `/v1/models` route serves the **raw** LM Studio list (embed models included), while the pi registry catalog (`lmStudioCatalog`) filters `/embed/i` - so an embed model can be listed but never resolves as a completion model.

## Consumers

| Consumer                                                                   | Uses                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| External benchmark harness (not in this workspace)                         | `POST /v1/chat/completions`, `/v1/models`, reads `choices[].message.content` + `binding_check`                                                   |
| binding-check extension build (loaded per request via `BINDING_CHECK_EXT`) | `TURN_CHECK_PROVIDER`/`TURN_CHECK_MODEL` env, `~/.pi/binding-check-reviewer.json`; emits the `binding-check-note` entries that drive the verdict |
| `@earendil-works/pi-coding-agent` SDK                                      | `createAgentSession`, `DefaultResourceLoader`, `ModelRegistry`, `ModelRuntime`, `SessionManager`                                                 |

The root README lists this package among the private dev tools (`"private": true`, excluded from publishing - see `RELEASE_PLAN.md` holdback note).

## Configuration (source locations)

| Knob                           | Default / behavior                                                                                                                                                              | Location        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `PORT`                         | `8787`                                                                                                                                                                          | server.ts:27    |
| `LMSTUDIO_BASE_URL`            | `http://127.0.0.1:10103/v1` (model source)                                                                                                                                      | server.ts:29    |
| `BINDING_CHECK_EXT`            | `<repo>/packages/extensions/binding-check/index.ts` - via `adapterRoot` = the `packages/` dir, **not** the package dir                                                          | server.ts:32-34 |
| `TURN_CHECK_PROVIDER`          | `??=` `'lmstudio'` (only when unset in the environment)                                                                                                                         | server.ts:91    |
| `TURN_CHECK_MODEL`             | First live LM Studio model (first row of `/models` - order not guaranteed) - set **only** when `~/.pi/binding-check-reviewer.json` is absent; otherwise deliberately left unset | server.ts:91-95 |
| Reviewer state path            | `STATE_PATH = ${HOME}/.pi/binding-check-reviewer.json` (persisted `/reviewer` choice wins)                                                                                      | server.ts:92    |
| Verdict grace window           | `1200` ms after `agent_settled` → PASS                                                                                                                                          | server.ts:156   |
| Verdict hard timeout           | `12_000` ms → force PASS                                                                                                                                                        | server.ts:153   |
| LM Studio probe timeout        | `AbortSignal.timeout(4000)` - unreachable/`!ok` → `[]` (catalog heals on refresh)                                                                                               | server.ts:57    |
| Notice type                    | `NOTICE_TYPE = 'binding-check-note'` (binding-check's FAIL signal)                                                                                                              | server.ts:39    |
| Injected model shape constants | `contextWindow: 32000`, `maxTokens: 8192`, zero cost, text-only input                                                                                                           | server.ts:68-89 |

## Testing & validation

```bash
npm start                       # node server.ts - import-time and boot errors surface immediately
npx tsc --noEmit                # strict typecheck (tsconfig extends the repo root, include: server.ts)
```

The adapter is exercised by pointing an OpenAI-compatible benchmark harness at `/v1` and observing the reply plus the `binding_check` verdict. There is no unit suite.

## Invariants

- **One completion = one turn = one throwaway session** (`SessionManager.inMemory()`, disposed in `finally`) - no state, no history, no multi-turn.
- **The verdict is never computed here:** every `FAIL`/`PASS` is binding-check's outcome observed by subscription or persistence; this server only times and routes it.
- A `binding-check-note` entry is the only `FAIL` signal; a short-circuit FAIL resolves instantly, and the persisted-entry re-read (after the prompt and the verdict await) is the fallback/pass path - no notice in the session means `PASS` ("no signal received", not verified-clean closure).
- The verdict subscription is installed before the prompt runs (`awaitVerdict`'s executor subscribes synchronously; the promise is awaited only after `session.prompt`).
- The 12 s hard timeout and the 1200 ms `agent_settled` grace window bound the verdict wait inside the turn; `agent_settled` fires only after a run completes (SDK `_runAgentPrompt` `finally`).
- The `finish` race is first-wins (`isDone` guard): whoever resolves first unsubscribes and cancels the others.
- `adapterRoot` is the repo's `packages/` dir (parent of the package), not the package dir - it is both the session `cwd` and the base of the default `BINDING_CHECK_EXT` path.
- The boot-time catalog may be empty (LM Studio not ready); `refreshModels` + the refresh-once on a miss are the healing path - the runtime never retries more than once per `findModel` call.

## Files

- `server.ts` - the whole adapter: env config, notice typing, LM Studio catalog/shape mapping, runtime boot, `findModel`, `awaitVerdict`, `runTurn`, HTTP handlers.
- `package.json` - private dev tool (`"private": true`), `start` script runs `node server.ts`.
- `AGENTS.md` - this file.
