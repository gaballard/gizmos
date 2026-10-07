# AGENTS.md - pi-sanity-check

Engineering reference for the Pi Sanity Check extension. The end-user story (install, configuration, command usage) lives in README.md - keep the two consistent when you edit either. The verdict-core internals live in `../sanity-check-core/AGENTS.md`; this file covers only the adapter layer. The sibling adapter with the same shape: `../claude-sanity-check/AGENTS.md` (the pi↔Claude parity table is mirrored in both directions).

## Design why

Pi runs the loop _in-session_: the producer is the live session model (A), and the reviewer (B) is a different model picked from the host's model registry. So inference goes through `ctx.modelRegistry.complete` / `streamSimple` - not an HTTP endpoint - and A's revision reuses the very model the developer is talking to, which is the whole point of "stop a single model rubber-stamping its own work" done in-session. The trade-off: a headless (no-UI) run can't pop a model picker, so it needs a prior `/sanity-checker` selection. The verdict logic is not duplicated - a convergence/parse/completion fix in `@gizmos/sanity-check-core` lands in both runtimes at once.

## How it works

```text
/sanity-check            (index.ts command handler, in-session)
  -> pick reviewer B (must differ from session model A)
  -> deliverable = file path | A's most recent assistant output (extractLastAssistantText)
  -> A/B loop, review + revise steered into the live session, CONVERGED | STOPPED report
/sanity-checker          set/show reviewer B, --max-tokens, --thinking (persisted)
```

Registered as a pi extension in `package.json` (`pi.extensions: ["./index.ts"]`); the single source file `index.ts` is the whole adapter.

**Command surface** (`index.ts`):

- `/sanity-check <deliverable-path>`: reviews the file. Relative paths resolve against the extension process's cwd (a bare `readFileSync(arg)`); absolute paths pass through.
- `/sanity-check`: no arg → the deliverable is A's most recent assistant output, pulled via `extractLastAssistantText` from `ctx.sessionManager.buildContextEntries()` (falls back to `getEntries()`); if none, a warning and return.
- `/sanity-checker`: shows current reviewer B, output budget, and thinking level.
- `/sanity-checker <model>`: sets and persists B - bare id, `provider/id`, or a `:cloud` suffix; resolved against `ctx.modelRegistry.getAvailable()` via core `resolveModel`. A === B is refused. Warns when a `SANITY_CHECK_REVIEWER_*` env pin will override it on the next launch.
- `/sanity-checker --max-tokens <tokens|reset>`: sets (or resets to the 4000 default) the per-call output budget; persists.
- `/sanity-checker --thinking <level|off>`: sets (or clears) the thinking level (`minimal`…`max`); persists.

**The loop** (`index.ts`, `/sanity-check` handler):

1. Pick reviewer B (must differ from A): if no `SELECTED_MODEL`, a UI run pops `ctx.ui.select` and re-prompts while the choice equals the session model; a headless run just notifies. A guard before round 1 refuses again if B === A.
2. Read the deliverable: file path, or `extractLastAssistantText` of the session entries when no arg.
3. Rounds 1..`MAX_ROUNDS` (3, imported from the core):
   - `review(current, reviewer)` → `classifyReport` + `parseAgree` → `convergenceFor(v)` decides the verdict.
   - A non-`body` review outcome (transport/provider failure or abort) is **voided**: the round is reported as `review FAILED (<kind>)` via a steer and the loop breaks - never rendered as a `0 High / 0 Medium` verdict.
   - Each completed round posts a `sanity-check-review` steer (`[Round N] <B>'s review (agree=…, N High / N Medium):` + full text) into the live session.
   - Converged → `Sanity Check - CONVERGED at round N: <reason>` + "Agreement reached.", break. Cap reached → `STOPPED at round N (cap 3): <reason>` + directive to surface residual disputes, break.
   - Otherwise `revise(current, reviewText)`; `applyRevision` retains the previous deliverable when the revision is empty or failed (`retained: true`, with a warning naming the kind), so B never reviews an empty deliverable.
4. Final `sanity-check-result` steer reports the outcome, with a `Voided rounds: …` note when any review call failed at the transport/provider layer.

**Model IO** (`complete`): resolves the full model via `resolveFullModel(ctx.modelRegistry, model)` (throws `ModelNotFoundError` on a miss - no silent stripped fallback); uses `ctx.modelRegistry.streamSimple` with `reasoning: <level>` when a thinking level is set, else `ctx.modelRegistry.complete`; both pass `maxTokens: maxTokensBudget()`, `temperature: 0`, `signal: ctx.signal`. A resolved result is classified by `classifyCompletion`; a thrown error by `classifyThrownCompletion`. **Aborts are re-thrown** (and a resolved abort is converted to a thrown `AbortError`) so the outer cancellation guard owns them, never the empty-diagnostic path. A non-`body` or genuinely-empty result dumps the full assistant message (role/content/stopReason/usage/errorMessage) to `~/.pi/sanity-check-empty.json` with a warning.

**Reviewer context** (`review`): the system prompt is `REVIEWER_SYSTEM` + `reviewSkillContext()` + `reviewGitContext()`; the user turn is `frameDeliverable(deliverable)` (FR-4 trust-boundary: the deliverable is wrapped as untrusted data, not instructions). `reviewSkillContext` injects the representational-binding-sentinel and agent-personas skill files from `~/.agents/skills` / `~/.claude/skills` so B verifies rather than imagines. `reviewGitContext` injects the git working-tree state (`git diff --stat HEAD`, `git diff HEAD` truncated at 20000 chars, plus up to 6 untracked source files with content truncated at 8000) so B checks claims against the code really on disk. Both are best-effort (empty when not a git repo / skills missing / nothing changed).

**State** (`STATE_PATH`): `SANITY_CHECK_STATE` env, default `~/.pi/sanity-check-reviewer.json`. Read once at module load (provider/model/maxTokens/thinking), written by `persistState()` on every `/sanity-checker` change. Precedence is **env var > persisted state > default**, with env read lazily per call so a launch override survives mid-session state edits.

## Runtime parity: Pi ↔ Claude Code

Same verdict core, two surfaces; the same parity table is mirrored from the other direction in `../claude-sanity-check/AGENTS.md`.

> NOTE: Pi refers to the Pi agent harness, **not** Raspberry Pi.

| Pi adapter (this package)                                                                              | Claude Code adapter (claude-sanity-check)                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Loop in-session (`index.ts` command handler)                                                           | Loop in a CLI process (`cli.ts`); the slash command shells out and reads the transcript    |
| Inference via `ctx.modelRegistry.complete` / `streamSimple`                                            | Both A and B via `chatComplete` (OpenAI-compatible endpoint)                               |
| Reviewer B picked via `/sanity-checker` (env > persisted `~/.pi/sanity-check-reviewer.json` > default) | Both models from env (`SANITY_CHECK_A_MODEL`/`SANITY_CHECK_B_MODEL`); nothing persisted    |
| Rejects A === B                                                                                        | Warns on A === B but still runs (single-endpoint trade-off)                                |
| Reviews delivered into the live session (steer messages); final `sanity-check-result` report           | Exit code 0/1 + stdout transcript; the command doc tells Claude how to report              |
| Injects binding-sentinel + agent-personas skills and git working-tree state into B's context           | B sees only the deliverable under `REVIEWER_SYSTEM`                                        |
| Cancellation guard logs aborted runs (`~/.pi/sanity-check-logs/cancellations.jsonl`)                   | None - an aborted script just dies                                                         |
| Deliverable = last assistant output (core `extractLastAssistantText`) or a file path                   | Deliverable = file path; the command doc writes the latest output to a temp file           |
| Thinking level honored via `streamSimple` (`reasoning`)                                                | `SANITY_CHECK_THINKING` not applied - the CLI transport is plain OpenAI-compatible (warns) |
| Transport failure on a review voids the round and breaks the loop (steer + voided-rounds note)         | Transport failure stops the run with exit 1 and a `review FAILED` line                     |

Core consumers: both use `classifyReport`/`convergenceFor`/`parseAgree`/`MAX_ROUNDS`/`REVIEWER_SYSTEM`/`PRODUCER_SYSTEM`/`applyRevision`/`completionFailureReason`/`frameDeliverable`/`CompletionOutcome`. The pi adapter additionally uses `classifyCompletion`/`classifyThrownCompletion`/`resolveModel`/`resolveFullModel`/`extractLastAssistantText` (session-registry + session-output work); the claude adapter uses `classifyThrownCompletion` and `chatComplete` (endpoint transport), resolving models from env instead of `resolveFullModel`.

## Invariants

- **Verdict logic is never reimplemented here:** convergence, format refusal, `AGREE` parsing, completion classification, `MAX_ROUNDS` and both system prompts come from `@gizmos/sanity-check-core` - adapter edits never touch verdict semantics.
- **A hollow approval never passes:** a report without format markers, or a bodyless `AGREE: yes`, can't converge (`convergenceFor`); the loop keeps revising or stops at the cap, never claiming agreement.
- **A transport failure is not a review:** a non-`body` review outcome voids the round (steer + `review FAILED`), never a `0 High / 0 Medium` verdict; `completionFailureReason` names the transport/provider layer.
- **A blank/failed revision never reaches B:** `applyRevision` retains the previous deliverable on an empty body, an abort, or a provider error (`retained: true` + warning).
- **The deliverable is data, not instructions:** `frameDeliverable` wraps it before it reaches B; the verdict is read from B's report (not the deliverable), so a forged `AGREE` in the deliverable is not the verdict input.
- **Aborts belong to the cancellation guard:** a thrown or resolved abort is re-thrown, never downgraded to an empty provider failure; the guard surfaces it and appends to `~/.pi/sanity-check-logs/cancellations.jsonl`.
- **B must differ from A:** rejected at picker time, at `/sanity-checker`, and again before round 1.
- **No mid-run persistence:** a cancelled check leaves no rounds behind; only the cancellation log records that it happened. The reviewer selection itself persists across runs.

## Files

- `index.ts` - the whole adapter: `/sanity-checker` + `/sanity-check` command handlers, `complete`/`review`/`revise`, skill + git context injection, state load/persist, cancellation guard. Registered via `package.json` `pi.extensions`.
- Reuses `@gizmos/sanity-check-core` - verdict logic, completion classification, and `frameDeliverable` (see its AGENTS.md for the full API). Inference goes through the host registry, so this adapter does **not** import `chatComplete`.
- `test/budget.test.ts` - output-budget + thinking-level resolution tests (env > persisted state > default, `/sanity-checker --max-tokens` / `--thinking` persistence, streamSimple routing).
- `test/logs.test.ts` - reviewer-selection + logging tests (no-arg report, empty-args guard, A/B role labels, `:cloud` suffix persistence, A===B refused, env-pin warning).

## Config (source locations)

| Knob                             | Where                                             | Notes                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANITY_CHECK_REVIEWER_PROVIDER` | `index.ts` (`PROVIDER`)                           | default `lmstudio`; env > persisted state > default                                                                                                       |
| `SANITY_CHECK_REVIEWER_MODEL`    | `index.ts` (`MODEL_ID`)                           | default `qwen3.8-4b-distill`; env > persisted state > default                                                                                             |
| `SANITY_CHECK_MAX_TOKENS`        | `index.ts` (`maxTokensBudget`)                    | env > persisted `--max-tokens` state > `4000`; applied to A and B                                                                                         |
| `SANITY_CHECK_THINKING`          | `index.ts` (`thinkingLevel`)                      | env > persisted `--thinking` state; `minimal`/`low`/`medium`/`high`/`xhigh`/`max`; unset ⇒ plain `complete()` path; routed via `streamSimple` `reasoning` |
| `SANITY_CHECK_STATE`             | `index.ts` (`STATE_PATH`)                         | default `~/.pi/sanity-check-reviewer.json`; holds provider/model/maxTokens/thinking                                                                       |
| `MAX_ROUNDS`                     | `../sanity-check-core/src/core.ts` (`MAX_ROUNDS`) | 3; imported, not runtime-configurable                                                                                                                     |
| Skill files injected into B      | `index.ts` (`reviewSkillContext`)                 | `~/.agents/skills/representational-binding-sentinel/SKILL.md`, `~/.claude/skills/agent-personas/SKILL.md`; best-effort                                    |
| Git context injected into B      | `index.ts` (`reviewGitContext`)                   | `git diff HEAD` (truncated 20000) + up to 6 untracked source files (content truncated 8000); best-effort                                                  |
| Cancellation log                 | `index.ts` (catch block)                          | `~/.pi/sanity-check-logs/cancellations.jsonl` (ts, round, provider, model, reason)                                                                        |
| Empty-reply diagnostic           | `index.ts` (`complete`)                           | `~/.pi/sanity-check-empty.json` (full assistant message) for a non-`body` or empty result                                                                 |

`engines.node >= 20` (`package.json`). Peer-depends on `@earendil-works/pi-coding-agent` (the host registry/extension API).

## Testing & validation

```bash
npm run check                                       # tsc --noEmit, strict - this adapter only
npm test                                            # node --test - in-package adapter tests (18 tests)
cd ../sanity-check-core && node src/self-check.ts   # verdict-core battery (72 assert calls)
cd .. && npm run check --workspaces --if-present    # everything
```

The in-package suite covers the adapter-specific surface (budget/thinking resolution, `/sanity-checker` persistence, A===B refusal, env-pin warnings, streamSimple routing, logging) with stubbed `ctx`; the verdict-core battery (`classifyReport`/`convergenceFor`/`parseAgree`/completion classification regressions) lives in `@gizmos/sanity-check-core`.

| Area             | What it proves                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.test.ts` | 4000 default; env `SANITY_CHECK_MAX_TOKENS` wins over persisted state; non-numeric env falls back; `--max-tokens` persists + applies + `reset` returns to default; `--thinking` persists + routes to `streamSimple` with the level; `--thinking off` clears to `complete()`; env thinking wins; invalid level refused |
| `logs.test.ts`   | no-arg `/sanity-checker` reports selection; empty-args `/sanity-check` is a no-op guard; opening log labels A/B by role; `:cloud` suffix switch persists; switch to session model refused (state untouched); env-pin contradiction warns                                                                              |
