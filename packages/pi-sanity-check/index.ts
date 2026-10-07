/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  MAX_ROUNDS,
  PRODUCER_SYSTEM,
  REVIEWER_SYSTEM,
  applyRevision,
  classifyCompletion,
  classifyReport,
  classifyThrownCompletion,
  completionFailureReason,
  convergenceFor,
  extractLastAssistantText,
  frameDeliverable,
  parseAgree,
  resolveFullModel,
  resolveModel,
  type CompletionOutcome,
} from '@gizmos/sanity-check-core';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
// Sanity Check - cross-model agree/disagree loop (manually-driven skill,
// now automated in-session). Producer is the session model (A); reviewer is a
// DIFFERENT selected model (B). Same model-selection logic as binding-check /
// quality-check: env wins, then /reviewer state, then default; guard rejects A===B.

// The /reviewer choice is persisted so forked/reloaded processes keep it.
const STATE_PATH = process.env.SANITY_CHECK_STATE ?? `${homedir()}/.pi/sanity-check-reviewer.json`;
let PROVIDER = process.env.SANITY_CHECK_REVIEWER_PROVIDER ?? 'lmstudio';
let MODEL_ID = process.env.SANITY_CHECK_REVIEWER_MODEL ?? 'qwen3.8-4b-distill';
let SELECTED_MODEL: { provider: string; id: string } | undefined;
// Output budget for the sanity-check calls (sanity-check-max-reasoning-tokens):
// resolution is env > persisted state > 4000 default, with env read lazily per
// call so a launch override survives mid-session state edits.
let STATE_MAX_TOKENS: number | undefined;
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Thinking level for the completion calls (Phase 2): env > persisted state,
// 'off'/unset ⇒ plain complete() path. Values beyond the set are ignored.
let STATE_THINKING: string | undefined;
// Precedence: env var > persisted /reviewer state > default. Env wins so
// explicit launch overrides (e.g. per-benchmark SANITY_CHECK_REVIEWER_MODEL)
// still take effect.
try {
  const saved = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
    provider?: string;
    model?: string;
    maxTokens?: unknown;
    thinking?: unknown;
  };
  if (!process.env.SANITY_CHECK_REVIEWER_PROVIDER && saved.provider) PROVIDER = saved.provider;
  if (!process.env.SANITY_CHECK_REVIEWER_MODEL && saved.model) MODEL_ID = saved.model;
  if (saved.provider && saved.model) SELECTED_MODEL = { provider: saved.provider, id: saved.model };
  if (typeof saved.maxTokens === 'number' && saved.maxTokens > 0)
    STATE_MAX_TOKENS = saved.maxTokens;
  if (typeof saved.thinking === 'string' && THINKING_LEVELS.includes(saved.thinking))
    STATE_THINKING = saved.thinking;
} catch {
  /* no state yet */
}

/** Persist reviewer selection + budget knobs; unset knobs are omitted so the
 *  default applies on the next launch. */
type SanityCheckState = { provider: string; model: string; maxTokens?: number; thinking?: string };
const persistState = () => {
  const state: SanityCheckState = { provider: PROVIDER, model: MODEL_ID };
  if (STATE_MAX_TOKENS !== undefined) state.maxTokens = STATE_MAX_TOKENS;
  if (STATE_THINKING !== undefined) state.thinking = STATE_THINKING;
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {}
};

/** Output-token budget for review/revise calls: SANITY_CHECK_MAX_TOKENS env >
 *  persisted state (/sanity-checker --max-tokens) > the 4000 default. */
const maxTokensBudget = (): number => {
  const n = Number(process.env.SANITY_CHECK_MAX_TOKENS);
  if (Number.isFinite(n) && n > 0) return n;
  return STATE_MAX_TOKENS ?? 4000;
};

/** Thinking level for the calls: SANITY_CHECK_THINKING env > persisted state
 *  (/sanity-checker --thinking). Unset ⇒ the unchanged plain-complete path. */
const thinkingLevel = (): string | undefined => {
  const env = process.env.SANITY_CHECK_THINKING;
  if (env && THINKING_LEVELS.includes(env)) return env;
  return STATE_THINKING;
};

/** Run a one-shot completion; a provider/transport failure is classified as
 *  such rather than collapsed into an empty string, and a diagnostic dump is
 *  written for a non-body or genuinely-empty result. */
const complete = async (
  ctx: any,
  model: { provider: string; id: string },
  systemPrompt: string,
  userText: string,
): Promise<CompletionOutcome> => {
  // modelRegistry.complete expects a full Model (baseUrl/api/compat/config),
  // not a bare {provider,id}. resolveFullModel throws ModelNotFoundError on a
  // miss so the broken stripped-object path can never silently degrade.
  const target = resolveFullModel(ctx.modelRegistry, model);
  // opencode/opencode-go 400 with MissingSessionID unless the request carries
  // `x-opencode-session`. pi-ai derives that header only from
  // `options.sessionId`, which the agent turn sets for itself - an extension
  // one-shot completion has to pass it explicitly or the call is unroutable.
  const sessionId = ctx.sessionManager?.getSessionId?.() as string | undefined;

  let res:
    | {
        role?: unknown;
        content?: unknown;
        stopReason?: unknown;
        usage?: unknown;
        errorMessage?: unknown;
      }
    | undefined;
  let outcome: CompletionOutcome;
  const context = {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const thinking = thinkingLevel();
    // The provider-neutral thinking knob exists only on streamSimple
    // (SimpleStreamOptions.reasoning); plain complete() takes per-API options.
    // streamSimple delegates to the same stream with clampThinkingLevel(model,
    // reasoning) applied, so a non-reasoning model clamps to 'off'/'none'
    // inside pi - the adapter passes the configured level through untouched.
    res = thinking
      ? await ctx.modelRegistry
          .streamSimple(target, context, {
            maxTokens: maxTokensBudget(),
            temperature: 0,
            signal: ctx.signal,
            sessionId,
            reasoning: thinking,
          })
          .result()
      : await ctx.modelRegistry.complete(target, context, {
          maxTokens: maxTokensBudget(),
          temperature: 0,
          signal: ctx.signal,
          sessionId,
        });
    outcome = classifyCompletion(res ?? {});
  } catch (err) {
    const failure = classifyThrownCompletion(err);
    // The outer cancellation guard owns aborts (visible notice +
    // cancellations.jsonl); never downgrade a user cancellation to an empty
    // provider failure.
    if (failure.kind === 'aborted') throw err;
    outcome = failure;
  }

  // A resolved abort (no throw) must reach the same cancellation guard.
  if (outcome.kind === 'aborted') {
    const abortErr = new Error(outcome.reason ?? 'request aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  if ((outcome.kind !== 'body' || !outcome.text) && ctx.hasUI) {
    // Diagnostic dump: stopReason/usage/errorMessage for why nothing came back.
    try {
      const p = `${homedir()}/.pi/sanity-check-empty.json`;
      writeFileSync(
        p,
        JSON.stringify(
          {
            model,
            kind: outcome.kind,
            reason: outcome.reason,
            raw: {
              role: res?.role,
              content: res?.content,
              stopReason: res?.stopReason,
              usage: res?.usage,
              errorMessage: res?.errorMessage,
            },
          },
          null,
          2,
        ),
      );
      ctx.ui.notify?.(
        outcome.kind === 'body'
          ? `Empty review from ${model.provider}/${model.id}. Full message dumped to ${p}`
          : `Provider error from ${model.provider}/${model.id}: ${outcome.reason ?? 'unknown'} (dumped to ${p})`,
        'warning',
      );
    } catch {}
  }
  return outcome;
};

/** Read a skill file, returning its trimmed content (empty when missing or unreadable). */
const skillFile = (p: string): string => {
  try {
    const t = readFileSync(p, 'utf8').trim();
    return t ? `${t}\n` : '';
  } catch {
    return '';
  }
};

/** Skill text injected into B's (reviewer) context each round, so B applies
 *  the representational-binding sentinel (intake / verify-before-claim) and
 *  relevant agent-personas instead of hallucinating. */
const reviewSkillContext = (): string => {
  const sentinel = skillFile(
    `${homedir()}/.agents/skills/representational-binding-sentinel/SKILL.md`,
  );
  const personas = skillFile(`${homedir()}/.claude/skills/agent-personas/SKILL.md`);
  if (!sentinel && !personas) return '';
  let out = '\n=== BINDING + PERSONA SKILLS (apply these) ===\n';
  if (sentinel) out += `\n--- SKILL: representational-binding-sentinel ---\n${sentinel}\n`;
  if (personas) out += `\n--- SKILL: agent-personas (index) ---\n${personas}\n`;
  return out;
};

/** Git working-tree context, injected so B verifies claims against the code
 *  actually on disk rather than imagining it. Covers: tracked diffs (unstaged +,
 *  staged vs HEAD), plus untracked source files (so new files not yet git-added
 *  still reach B). Best-effort: empty when not a git repo / nothing changed. */
const reviewGitContext = (): string => {
  const run = (cmd: string): string => {
    try {
      const out = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return out;
    } catch {
      return '';
    }
  };

  const stat = run('git diff --stat HEAD');
  const diff = run('git diff HEAD');
  // Untracked files (not in git yet) never appear in `git diff`; list them and
  // inject their content so brand-new code is still on disk for B.
  const untracked = run('git ls-files --others --exclude-standard')
    .split('\n')
    .filter(Boolean)
    .filter((p) => /\.(ts|js|mjs|tsx|jsx|rs|go|py|md)$/.test(p))
    .slice(0, 6);

  let out = '\n=== CODE ON DISK (verify claims against real files) ===\n';
  if (stat) out += `\nChanged files:\n${stat}\n`;
  if (diff) {
    out += `\nDiff (working tree vs HEAD):\n${diff.slice(0, 20000)}${diff.length > 20000 ? '\n…(truncated)' : ''}\n`;
  }
  if (untracked.length) {
    out += '\nUntracked source files (content, since not in git diff):\n';
    for (const p of untracked) {
      const c = run(`cat ${JSON.stringify(p)}`);
      if (c) {
        out += `\n--- ${p} ---\n${c.slice(0, 8000)}${c.length > 8000 ? '\n…(truncated)' : ''}\n`;
      }
    }
  }
  return out === '\n=== CODE ON DISK (verify claims against real files) ===\n' ? '' : out;
};

/** Have reviewer B critique the deliverable, with binding/persona skills + git context injected. */
const review = async (
  ctx: any,
  deliverable: string,
  reviewer: { provider: string; id: string },
): Promise<CompletionOutcome> => {
  const skills = reviewSkillContext();
  const git = reviewGitContext();
  const system = REVIEWER_SYSTEM + skills + git;
  return complete(ctx, reviewer, system, frameDeliverable(deliverable));
};

/** Ask the session (producer A) to revise the deliverable in light of the reviewer's findings. */
const revise = async (
  ctx: any,
  deliverable: string,
  reviewText: string,
): Promise<CompletionOutcome> => {
  return complete(
    ctx,
    ctx.model!, // producer = the session model (A)
    PRODUCER_SYSTEM,
    `Original deliverable:\n\n${deliverable}\n\nReviewer's findings:\n\n${reviewText}`,
  );
};

export default (pi: ExtensionAPI) => {
  pi.registerCommand('sanity-checker', {
    description:
      'Sanity-check knobs: set reviewer model B (must differ from session model A) e.g. /sanity-checker ollama-cloud/glm-5.1, or a bare /sanity-checker glm-5.1; a trailing :cloud suffix is stripped if unregistered (glm-5.1:cloud → ollama-cloud/glm-5.1). Or set the output budget /sanity-checker --max-tokens <tokens|reset>, or the thinking level /sanity-checker --thinking <minimal|low|medium|high|xhigh|max|off>. No arg shows the current values',
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify(
          `Sanity-check reviewer (B): ${PROVIDER}/${MODEL_ID}  max output tokens: ${maxTokensBudget()}  thinking: ${thinkingLevel() ?? 'off'}`,
          'info',
        );
        return;
      }
      // Budget/thinking form: /sanity-checker --max-tokens <tokens|reset>
      // | --thinking <minimal|low|medium|high|xhigh|max|off>. Bare input
      // remains the model-spec form (provider/model or bare id).
      if (input.startsWith('--')) {
        const tokens = input.split(/\s+/).filter(Boolean);
        const value = tokens[1];
        if (tokens[0] === '--max-tokens') {
          if (value === 'reset') {
            STATE_MAX_TOKENS = undefined;
            persistState();
            ctx.ui.notify('Sanity-check max output tokens: reset (default 4000)', 'info');
            return;
          }
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) {
            ctx.ui.notify(`Invalid --max-tokens: ${value}`, 'warning');
            return;
          }
          STATE_MAX_TOKENS = n;
          persistState();
          ctx.ui.notify(`Sanity-check max output tokens: ${n} (persisted)`, 'info');
          if (process.env.SANITY_CHECK_MAX_TOKENS) {
            ctx.ui.notify(
              'warning: SANITY_CHECK_MAX_TOKENS env is set and overrides this choice',
              'warning',
            );
          }
          return;
        }
        if (tokens[0] === '--thinking') {
          if (value === 'off') {
            STATE_THINKING = undefined;
            persistState();
            ctx.ui.notify('Sanity-check thinking level: off (plain complete path)', 'info');
            return;
          }
          if (!value || !THINKING_LEVELS.includes(value)) {
            ctx.ui.notify(
              `Usage: /sanity-checker --thinking <${THINKING_LEVELS.join('|')}|off>`,
              'warning',
            );
            return;
          }
          STATE_THINKING = value;
          persistState();
          ctx.ui.notify(`Sanity-check thinking level: ${value} (persisted)`, 'info');
          if (process.env.SANITY_CHECK_THINKING) {
            ctx.ui.notify(
              'warning: SANITY_CHECK_THINKING env is set and overrides this choice',
              'warning',
            );
          }
          return;
        }
        ctx.ui.notify(
          'Usage: /sanity-checker --max-tokens <tokens|reset> | --thinking <level|off>',
          'warning',
        );
        return;
      }
      const slash = input.lastIndexOf('/');
      const provider = slash > 0 ? input.slice(0, slash) : undefined;
      const modelId = slash > 0 ? input.slice(slash + 1) : input;
      // Resolve with cloud-suffix fallback: bare name, provider/id, or a
      // `model:cloud`-style id that needs the suffix stripped.
      const available = ctx.modelRegistry.getAvailable() as Array<{
        provider: string;
        id: string;
      }>;
      const model = resolveModel(available, provider ? `${provider}/${modelId}` : modelId);
      if (!model) {
        ctx.ui.notify(`Model not found: ${provider ?? '?'}/${modelId}`, 'warning');
        return;
      }
      const sessionModel = `${ctx.model!.provider}/${ctx.model!.id}`;
      if (`${model.provider}/${model.id}` === sessionModel) {
        ctx.ui.notify(
          `Reviewer must differ from the session model (${sessionModel}). Not set.`,
          'warning',
        );
        return;
      }
      PROVIDER = model.provider;
      MODEL_ID = model.id;
      SELECTED_MODEL = { provider: PROVIDER, id: MODEL_ID };
      persistState();
      ctx.ui.notify(`Sanity-check reviewer changed to ${PROVIDER}/${MODEL_ID}`, 'info');
      // FR-2: an env pin silently overrides this switch on the next launch;
      // say so now instead of losing it.
      if (process.env.SANITY_CHECK_REVIEWER_PROVIDER || process.env.SANITY_CHECK_REVIEWER_MODEL) {
        ctx.ui.notify(
          'warning: SANITY_CHECK_REVIEWER_* env is set and will override this selection on the next launch',
          'warning',
        );
      }
    },
  });

  pi.registerCommand('sanity-check', {
    description:
      "Cross-model agree/disagree review: producer (session model A) vs a different reviewer model (B), looping to agreement or 3 rounds. Usage: /sanity-check <deliverable path>, or /sanity-check (no path = use the session's most recent assistant output as the deliverable)",
    handler: async (args: string, ctx: any) => {
      const arg = args.trim();
      const useLastOutput = !arg; // no path = deliverable is A's most recent output

      // --- Pick reviewer model B, MUST differ from session model A ---
      const sessionModel = `${ctx.model!.provider}/${ctx.model!.id}`;
      const pick = async (): Promise<boolean> => {
        const models = ctx.scopedModels.length
          ? ctx.scopedModels.map((e: any) => e.model)
          : ctx.modelRegistry.getAvailable();
        if (!models.length) return false;
        const options = models.map((m: any) => `${m.provider}/${m.id}`);
        const choice = await ctx.ui.select('Reviewer model (must differ from A):', options);
        if (!choice) return false;
        const chosen = models.find((m: any) => `${m.provider}/${m.id}` === choice);
        if (!chosen) return false;
        if (`${chosen.provider}/${chosen.id}` === sessionModel) {
          ctx.ui.notify(
            'Reviewer must differ from the session model (A). Picked again.',
            'warning',
          );
          return false;
        }
        SELECTED_MODEL = chosen;
        PROVIDER = chosen.provider;
        MODEL_ID = chosen.id;
        persistState();
        return true;
      };

      if (!SELECTED_MODEL) {
        if (ctx.hasUI) {
          let picked = false;
          while (!picked) {
            picked = await pick();
            if (!picked) {
              ctx.ui.notify('No valid reviewer model selected.', 'info');
              return;
            }
          }
        } else {
          ctx.ui.notify(
            `Reviewer model: ${PROVIDER}/${MODEL_ID}. Ensure it is not the session model (${sessionModel}).`,
            'info',
          );
        }
      }

      // Guard before round 1.
      if (SELECTED_MODEL && `${SELECTED_MODEL.provider}/${SELECTED_MODEL.id}` === sessionModel) {
        ctx.ui.notify(
          'Reviewer equals session model - not independent. Use /sanity-checker to set a different B.',
          'warning',
        );
        return;
      }
      const reviewer = SELECTED_MODEL; // non-null after guard (module-level not narrowed)
      if (!reviewer) return;

      // --- Read deliverable: file path, or the session's last assistant output ---
      let deliverable: string;
      if (useLastOutput) {
        const entries = (ctx.sessionManager?.buildContextEntries?.() ??
          ctx.sessionManager?.getEntries?.() ??
          []) as Array<{ [k: string]: unknown }>;
        deliverable = extractLastAssistantText(entries);
        if (!deliverable) {
          ctx.ui.notify(
            'No assistant output found in this session. Either produce something first, or pass a deliverable path.',
            'warning',
          );
          return;
        }
      } else {
        try {
          const { readFileSync } = await import('node:fs');
          deliverable = readFileSync(arg, 'utf8');
        } catch (err: any) {
          ctx.ui.notify(`Cannot read deliverable: ${arg} (${err.message})`, 'error');
          return;
        }
      }

      ctx.ui.notify(
        `Sanity Check: producer A=${sessionModel}  reviewer B=${reviewer.provider}/${reviewer.id}  (${MAX_ROUNDS} rounds max)`,
        'info',
      );

      let round = 1;
      let current = deliverable;
      let isConverged = false;
      let reason = '';
      let reviewedRounds = 0;
      let voidedRounds = 0;

      try {
        while (round <= MAX_ROUNDS) {
          ctx.ui.notify(
            `Round ${round}/${MAX_ROUNDS}: reviewer ${reviewer.provider}/${reviewer.id} analyzing…`,
            'info',
          );
          const reviewOutcome = await review(ctx, current, reviewer);

          // Track B FR-1/FR-3: a transport/provider failure is not a review -
          // render it as an error state, never as a `0 High / 0 Medium` verdict.
          if (reviewOutcome.kind !== 'body') {
            voidedRounds++;
            reason = completionFailureReason(reviewOutcome);
            pi.sendMessage(
              {
                customType: 'sanity-check-review',
                content: `[Round ${round}] ${reviewer.provider}/${reviewer.id} review FAILED (${reviewOutcome.kind}): ${reviewOutcome.reason ?? 'unknown error'}`,
                display: true,
              },
              { deliverAs: 'steer', triggerTurn: true },
            );
            break;
          }

          const reviewText = reviewOutcome.text;
          reviewedRounds++;
          const v = classifyReport(reviewText);
          const agreed = parseAgree(reviewText);

          pi.sendMessage(
            {
              customType: 'sanity-check-review',
              content: `[Round ${round}] ${reviewer.provider}/${reviewer.id}'s review (agree=${String(agreed)}, ${v.high} High / ${v.medium} Medium):\n\n${reviewText}`,
              display: true,
            },
            { deliverAs: 'steer', triggerTurn: true },
          );

          const verdict = convergenceFor(v);
          reason = verdict.reason;
          if (verdict.isConverged) {
            isConverged = true;
            break;
          }
          if (round === MAX_ROUNDS) break;

          ctx.ui.notify(
            `Round ${round}: producer ${sessionModel} revising in response to ${reviewer.provider}/${reviewer.id}'s analysis (${reason})…`,
            'info',
          );
          // Track B FR-2 (pi-sanity-check-blank-review-body): never feed B an
          // empty revision - retain the last good deliverable if the producer
          // came back blank (provider 4xx swallowed as empty text, reasoning
          // truncation). Mirrors packages/claude-sanity-check/cli.ts:122-128,
          // which already guards this.
          const revisedOutcome = await revise(ctx, current, reviewText);
          const revision = applyRevision(current, revisedOutcome);
          current = revision.deliverable;
          if (revision.retained) {
            ctx.ui.notify(
              revisedOutcome.kind === 'body'
                ? 'producer returned an empty revision - retaining previous deliverable'
                : `producer revision failed (${revisedOutcome.kind}): ${revisedOutcome.reason ?? 'unknown error'} - retaining previous deliverable`,
              'warning',
            );
          }
          round++;
        }

        const voidedNote =
          voidedRounds > 0
            ? `\nVoided rounds: ${voidedRounds} of ${reviewedRounds + voidedRounds} review attempt(s) failed at the transport/provider layer.`
            : '';
        const outcome = isConverged
          ? `CONVERGED at round ${round}: ${reason}`
          : reviewedRounds === 0
            ? `STOPPED at round ${round} (cap ${MAX_ROUNDS}): no rounds completed - every review call failed at the transport/provider layer`
            : `STOPPED at round ${round} (cap ${MAX_ROUNDS}): ${reason}`;

        pi.sendMessage(
          {
            customType: 'sanity-check-result',
            content:
              `Sanity Check - ${outcome}\n` +
              (voidedNote ? `${voidedNote}\n` : '') +
              `Producer A (session): ${sessionModel}   Reviewer B: ${reviewer?.provider}/${reviewer?.id}\n` +
              (isConverged
                ? '\nAgreement reached.'
                : '\nNot converged - surface residual disputes to the person.'),
            display: true,
          },
          { deliverAs: 'steer', triggerTurn: true },
        );
      } catch (err) {
        // Cancellation guard: escaping or sending a message mid-check aborts the
        // in-flight model call via ctx.signal. Surface it visibly instead of an
        // uncaught throw, so an interrupted run is never silent.
        const aborted =
          ctx.signal?.aborted ||
          (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message ?? '')));
        // N semantics: `round` is 1-indexed and increments only after a
        // non-converging review triggers a reconcile revision. So the value
        // reported here is the round whose in-flight call (review or revise)
        // was aborted. There is no 0 case: the catch only wraps the loop, and
        // round starts at 1 before the first review() call.
        if (aborted) {
          const msg = `Sanity Check cancelled during round ${round} (reviewer ${reviewer.provider}/${reviewer.id}). No rounds persisted; reviewer selection kept for a clean rerun.`;
          ctx.ui.notify(msg, 'warning');
          try {
            const { appendFileSync, mkdirSync } = await import('node:fs');
            const dir = `${homedir()}/.pi/sanity-check-logs`;
            mkdirSync(dir, { recursive: true });
            appendFileSync(
              `${dir}/cancellations.jsonl`,
              JSON.stringify({
                ts: new Date().toISOString(),
                round,
                provider: reviewer.provider,
                model: reviewer.id,
                reason: err instanceof Error ? err.message : String(err),
              }) + '\n',
            );
          } catch {}
        } else {
          ctx.ui.notify(
            `Sanity Check failed with an error during round ${round}: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        }
      }
    },
  });
};
