# AGENTS.md - claude-sanity-check

Engineering reference for the Claude Code Sanity Check plugin. The end-user story (install, configuration, command usage) lives in README.md - keep the two consistent when you edit either. The verdict-core internals live in `../sanity-check-core/AGENTS.md`; this file covers only the adapter layer. The sibling adapter with the same shape: `../pi-sanity-check/AGENTS.md` (the pi↔Claude parity table is mirrored in both directions); the same-surface Claude plugin `../claude-package-sentinel/AGENTS.md` follows the same template.

## Design why

Claude Code slash commands can't drive a multi-round loop natively, so the loop runs as a CLI script that the `/sanity-check` command shells out to. And because the reviewer (B) isn't part of the Claude session, neither model can go through a session registry - instead **both** A and B are called as OpenAI-compatible completions via `chatComplete` (re-exported from `@gizmos/transport-core`), the same transport the opencode adapter uses. The documented trade-off: A is a configured producer model, not literally the live Claude session. In exchange, the verdict logic is not duplicated - a convergence/parse/completion fix in `@gizmos/sanity-check-core` lands in both runtimes at once.

## How it works

```text
/sanity-check (commands/sanity-check.md)
  -> `sanity-check <path>` (bin/sanity-check PATH shim -> cli.ts main())
  -> A/B loop, transcript printed to stdout, exit 0 | 1 | 2
```

`.claude-plugin/plugin.json` is the manifest (name `sanity-check`, v1.0.0, `plugin.schema.json`). It is **not** registered in the repo marketplace (`.claude-plugin/marketplace.json` at the repo root lists only `package-sentinel`); load it with `claude --plugin-dir`, a skills-dir copy, or `claude plugin validate .claude-plugin/plugin.json`.

**Command surface** (`commands/sanity-check.md`): tells Claude to run the `sanity-check` executable (on the Bash tool's PATH while the plugin is enabled) with a `node "${CLAUDE_PLUGIN_ROOT}/cli.ts"` fallback, and - when invoked without an argument - to write the most recent deliverable to a temp file first and pass that path. Reporting rules are keyed to exit codes: 0 = report convergence (round + residual findings); 1 = surface residual High/Medium disputes, never claim agreement; a format-violating or empty/bodyless `AGREE: yes` = treat as not-agreed.

**The loop** (`cli.ts`, `main(args)`):

1. Argument handling: no path → `usage: sanity-check <deliverable-path>` (exit 2); unreadable file (exit 2, error prints the path actually attempted - `tried <resolved>`); blank file → `deliverable is empty` (exit 2). Relative paths resolve against the CLI's process cwd (where Claude shells out); absolute paths pass through.
2. Equal-model check: A === B only **warns** (`producer model equals reviewer model (<B>) - not an independent review`) - unlike the pi adapter, which rejects. Deliberate: a single configured endpoint must still be runnable.
3. Rounds 1..`MAX_ROUNDS` (3, imported from the core):
   - `review(current)` → `classifyReport` + `parseAgree` → `convergenceFor(v)` decides the verdict.
   - Converged → `CONVERGED at round N: <reason>`, exit 0. Cap reached → `STOPPED at round N (cap 3): <reason>` plus the `do not claim agreement` directive, exit 1.
   - A non-`body` review outcome (a thrown transport/provider error, classified via `classifyThrownCompletion`) is **voided**: the round prints `[Round N] <B> review FAILED: <reason>` (`completionFailureReason` names the transport/provider layer) and the run exits 1 - never rendered as a `0 High / 0 Medium` verdict.
   - Otherwise `revise(current, reviewText)`; `applyRevision` retains the previous deliverable when the revision is empty or failed (`producer returned an empty revision - retaining previous deliverable` / `producer revision failed (<kind>) - retaining previous deliverable`), so B never reviews an empty deliverable.
4. Each round prints a banner (`Round N/3: reviewer <B> analyzing…`) and the tally (`[Round N] <B> review (agree=…, N High / N Medium)`) into the stdout transcript Claude reads back. No file state, nothing persisted.

**Model IO:** both calls go through `chatComplete` (re-exported from `@gizmos/transport-core`; system + user message, `maxTokens: 4000` per call here; the transport default is 800 with `temperature: 0`). `REVIEWER_SYSTEM`/`PRODUCER_SYSTEM` come from the core, so prompt fixes land in every surface; the reviewer user turn is `frameDeliverable(deliverable)` (FR-4: the deliverable is wrapped as untrusted data, not instructions). `review`/`revise` wrap `chatComplete` in a try/catch and classify a thrown error via `classifyThrownCompletion`; a non-`body` outcome voids the round and exits 1 with `review FAILED` - the run fails loudly, never as a false `CONVERGED`.

## Runtime parity: Pi ↔ Claude Code

Same verdict core, two surfaces; the same parity table is mirrored from the other direction in `../pi-sanity-check/AGENTS.md`.

> NOTE: Pi refers to the Pi agent harness, **not** Raspberry Pi.

| Pi adapter (pi-sanity-check)                                                                           | Claude Code adapter (this package)                                                         |
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

Core consumers: both use `classifyReport`/`convergenceFor`/`parseAgree`/`MAX_ROUNDS`/`REVIEWER_SYSTEM`/`PRODUCER_SYSTEM`/`applyRevision`/`completionFailureReason`/`frameDeliverable`/`CompletionOutcome`. The pi adapter additionally uses `classifyCompletion`/`classifyThrownCompletion`/`resolveModel`/`resolveFullModel`/`extractLastAssistantText` (session-registry + session-output work); this adapter uses `classifyThrownCompletion` and `chatComplete` (endpoint transport), resolving models from env instead of `resolveFullModel`.

## Invariants

- **Verdict logic is never reimplemented here:** convergence, format refusal, `AGREE` parsing, `MAX_ROUNDS` and both system prompts come from `@gizmos/sanity-check-core` - adapter edits never touch verdict semantics.
- **A hollow approval never passes:** a report without format markers, or a bodyless `AGREE: yes`, can't converge (`convergenceFor`); the loop then keeps revising or stops at the cap with exit 1, never reporting agreement.
- **A transport failure is not a review:** a thrown endpoint error is classified via `classifyThrownCompletion` and the round is voided (`review FAILED`, exit 1) - never a `0 High / 0 Medium` verdict; `completionFailureReason` names the transport/provider layer.
- **A blank/failed revision never reaches B:** `applyRevision` retains the previous deliverable on an empty body or a provider error (warning printed), so B never reviews an empty deliverable.
- **The deliverable is data, not instructions:** `frameDeliverable` wraps it before it reaches B; the verdict is read from B's report (not the deliverable), so a forged `AGREE` in the deliverable is not the verdict input.
- **Exit semantics are the contract:** 0 = converged, 1 = stopped at the cap unresolved (or a voided review), 2 = usage/IO error. README and the command doc describe exactly these.
- **Endpoint-only transport:** both models go through the OpenAI-compatible endpoint (`chatComplete`, re-exported from `@gizmos/transport-core`); the adapter never calls the Anthropic API or the live session. Endpoint failures surface loudly with the HTTP status.
- **A === B degrades to a loud warning, not an error** - the single-endpoint case must remain runnable.

## Files

- `cli.ts` - the A/B loop driver (`main(args)`): arg validation (relative paths anchored to process cwd, resolved-path not-found error), equal-model warning, review → classify → converge/revise loop, voided-round handling, `applyRevision` blank-revision guard, exit codes. `import.meta.main` entry; strict-mode typecheck via tsconfig.
- `bin/sanity-check` - PATH shim while the plugin is enabled; delegates to `cli.ts`'s `main`.
- `commands/sanity-check.md` - the `/sanity-check` slash-command prompt: invocation + node fallback, temp-file convention for the no-arg case, exit-code reporting rules.
- `.claude-plugin/plugin.json` - plugin manifest (name `sanity-check`). Not registered in the repo marketplace; load via `--plugin-dir` or skills-dir copy.
- `test/budget.test.ts` - per-call output-budget tests (`SANITY_CHECK_MAX_TOKENS` env > 4000 default; `SANITY_CHECK_THINKING` divergence warning).
- `test/deliverable.test.ts` - deliverable-path resolution tests (relative-against-cwd, absolute pass-through, resolved-path not-found error).
- Reuses `@gizmos/sanity-check-core` - verdict logic, completion classification, `frameDeliverable`, and the `chatComplete` transport (re-exported from `@gizmos/transport-core`; see the core AGENTS.md for the full API).

## Config (source locations)

| Knob                    | Where                                             | Notes                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SANITY_CHECK_BASE_URL` | `cli.ts` (`BASE_URL`)                             | default `http://localhost:1234/v1`                                                                                                                                                                                             |
| `SANITY_CHECK_A_MODEL`  | `cli.ts` (`PRODUCER_MODEL`)                       | default `claude-sonnet-4-20250514`                                                                                                                                                                                             |
| `SANITY_CHECK_B_MODEL`  | `cli.ts` (`REVIEWER_MODEL`)                       | default `qwen3.8-4b-distill`; equal to A only warns                                                                                                                                                                            |
| `MAX_ROUNDS`            | `../sanity-check-core/src/core.ts` (`MAX_ROUNDS`) | 3; imported, not runtime-configurable                                                                                                                                                                                          |
| Per-call `maxTokens`    | `cli.ts` (`maxTokensBudget`)                      | `SANITY_CHECK_MAX_TOKENS` env > 4000; applied to A and B                                                                                                                                                                       |
| `SANITY_CHECK_THINKING` | `cli.ts` (`main` startup warn)                    | documented divergence: the CLI transport (`@gizmos/transport-core` `chatComplete`) is plain OpenAI-compatible with no thinking field - a level set here warns and is NOT applied (the pi adapter honors it via `streamSimple`) |
| `chatComplete` request  | `../transport-core/openai.ts`                     | `temperature: 0`; trailing `/` stripped off baseURL                                                                                                                                                                            |

`engines.node >= 22.18` (`package.json`): type stripping lets the `.ts` entry run directly under node, and the command doc's `node` fallback loads it natively.

## Testing & validation

```bash
npm run check                                       # tsc --noEmit, strict - this adapter only
npm test                                            # node --test - in-package adapter tests (7 tests)
cd ../sanity-check-core && node src/self-check.ts   # verdict-core battery (72 assert calls)
cd .. && npm run check --workspaces --if-present    # everything
```

The in-package suite covers the adapter-specific surface: `test/budget.test.ts` (per-call `maxTokens` resolution, `SANITY_CHECK_THINKING` divergence warning) and `test/deliverable.test.ts` (relative-vs-absolute path resolution, resolved-path not-found error). The verdict-core battery (`classifyReport`/`convergenceFor`/`parseAgree`/completion-classification regressions, 72 assert calls) lives in `@gizmos/sanity-check-core` and guards the convergence semantics this package depends on.
