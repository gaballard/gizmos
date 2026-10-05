# AGENTS.md - claude-sanity-check

Engineering reference for the Claude Code Sanity Check plugin. The end-user story (install, configuration, command usage) lives in README.md - keep the two consistent when you edit either. The verdict-core internals live in `../sanity-check-core/AGENTS.md`; this file covers only the adapter layer. The same-surface sibling adapter (`../claude-package-sentinel/AGENTS.md`) follows the same shape.

## Design why

Claude Code slash commands can't drive a multi-round loop natively, so the loop runs as a CLI script that the `/sanity-check` command shells out to. And because the reviewer (B) isn't part of the Claude session, neither model can go through a session registry - instead **both** A and B are called as OpenAI-compatible completions via the core's `chatComplete`, the same transport the opencode adapter uses. The documented trade-off: A is a configured producer model, not literally the live Claude session. In exchange, the verdict logic is not duplicated - a convergence/parse fix in `@gizmos/sanity-check-core` lands in both runtimes at once.

## How it works

```text
/sanity-check (commands/sanity-check.md)
  -> `sanity-check <path>` (bin/sanity-check PATH shim -> cli.ts main())
  -> A/B loop, transcript printed to stdout, exit 0 | 1 | 2
```

`.claude-plugin/plugin.json` is the manifest (name `sanity-check`, v1.0.0, `plugin.schema.json`); it is registered as `sanity-check` in the repo marketplace (`.claude-plugin/marketplace.json` at the repo root).

**Command surface** (`commands/sanity-check.md`): tells Claude to run the `sanity-check` executable (on the Bash tool's PATH while the plugin is enabled) with a `node "${CLAUDE_PLUGIN_ROOT}/cli.ts"` fallback, and - when invoked without an argument - to write the most recent deliverable to a temp file first and pass that path. Reporting rules are keyed to exit codes: 0 = report convergence (round + residual findings); 1 = surface residual High/Medium disputes, never claim agreement; a format-violating or empty/bodyless `AGREE: yes` = treat as not-agreed.

**The loop** (`cli.ts`, `main(args)`):

1. Argument handling: no path → `usage: sanity-check <deliverable-path>` (exit 2); unreadable file (exit 2, error prints the path actually attempted - `tried <resolved>`); blank file → `deliverable is empty` (exit 2). Relative paths resolve against the CLI's process cwd (where Claude shells out); absolute paths pass through.
2. Equal-model check: A === B only **warns** (`producer model equals reviewer model (<B>) - not an independent review`) - unlike the pi adapter, which rejects. Deliberate: a single configured endpoint must still be runnable.
3. Rounds 1..`MAX_ROUNDS` (3, imported from the core):
   - `review(current)` → `classifyReport` + `parseAgree` → `convergenceFor(v)` decides the verdict.
   - Converged → `CONVERGED at round N: <reason>`, exit 0. Cap reached → `STOPPED at round N (cap 3): <reason>` plus the `do not claim agreement` directive, exit 1.
   - Otherwise `revise(current, reviewText)`; the result is trimmed and only accepted when non-empty - a blank revision retains the previous deliverable with a warning, so B never reviews an empty deliverable. (`chatComplete` trims content to a plain string, so the adapter's trim guard is the only empty-reply defense in this path - the pi adapter instead leans on the core's `blocksToText` thinking-fallback.)
4. Each round prints a banner (`Round N/3: reviewer <B> analyzing…`) and the tally (`[Round N] <B> review (agree=…, N High / N Medium)`) into the stdout transcript Claude reads back. No file state, nothing persisted.

**Model IO:** both calls go through core `chatComplete` (system + user message, `maxTokens: 4000` per call here; the core default is 800 with `temperature: 0`). `REVIEWER_SYSTEM`/`PRODUCER_SYSTEM` come from the core, so prompt fixes land in every surface. An endpoint failure throws with the HTTP status - the run fails loudly, never as a false `CONVERGED`.

## Runtime parity: Pi ↔ Claude Code

Same verdict core, two surfaces; the same parity table is mirrored from the other direction in `../pi-sanity-check/AGENTS.md`.

> NOTE: Pi refers to the Pi agent harness, **not** Raspberry Pi.

| Pi adapter (pi-sanity-check)                                                                           | Claude Code adapter (this package)                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Loop in-session (`index.ts` command handler)                                                           | Loop in a CLI process (`cli.ts`); the slash command shells out and reads the transcript |
| Inference via `ctx.modelRegistry.complete`                                                             | Both A and B via core `chatComplete` (OpenAI-compatible endpoint)                       |
| Reviewer B picked via `/sanity-checker` (env > persisted `~/.pi/sanity-check-reviewer.json` > default) | Both models from env (`SANITY_CHECK_A_MODEL`/`SANITY_CHECK_B_MODEL`); nothing persisted |
| Rejects A === B                                                                                        | Warns on A === B but still runs (single-endpoint trade-off)                             |
| Reviews delivered into the live session (steer messages); final `/sanity-check-result` report          | Exit code 0/1 + stdout transcript; the command doc tells Claude how to report           |
| Injects binding-sentinel + agent-personas skills and git working-tree state into B's context           | B sees only the deliverable under `REVIEWER_SYSTEM`                                     |
| Cancellation guard logs aborted runs (`~/.pi/sanity-check-logs/cancellations.jsonl`)                   | None - an aborted script just dies                                                      |
| Deliverable = last assistant output (core `extractLastAssistantText`) or a file path                   | Deliverable = file path; the command doc writes the latest output to a temp file        |

Core consumers: both use `classifyReport`/`convergenceFor`/`parseAgree`/`MAX_ROUNDS`/`REVIEWER_SYSTEM`/`PRODUCER_SYSTEM`. The pi adapter additionally uses `resolveModel`/`resolveFullModel`/`extractLastAssistantText`/`blocksToText` (session-registry work); this one uses `chatComplete` (endpoint transport) and resolves models from env instead of `resolveFullModel`.

## Invariants

- **Verdict logic is never reimplemented here:** convergence, format refusal, `AGREE` parsing, `MAX_ROUNDS` and both system prompts come from `@gizmos/sanity-check-core` - adapter edits never touch verdict semantics.
- **A hollow approval never passes:** a report without format markers, or a bodyless `AGREE: yes`, can't converge (`convergenceFor`); the loop then keeps revising or stops at the cap with exit 1, never reporting agreement.
- **A blank revision never reaches B:** `revise` output must be non-empty after trim, else the previous deliverable is retained with a warning.
- **Exit semantics are the contract:** 0 = converged, 1 = stopped at the cap unresolved, 2 = usage/IO error. README and the command doc describe exactly these.
- **Endpoint-only transport:** both models go through the OpenAI-compatible endpoint; the adapter never calls the Anthropic API or the live session. Endpoint failures surface loudly with the HTTP status.
- **A === B degrades to a loud warning, not an error** - the single-endpoint case must remain runnable.

## Files

- `cli.ts` - the A/B loop driver (`main(args)`): arg validation, equal-model warning, review → classify → converge/revise loop, blank-revision guard, exit codes. `import.meta.main` entry; strict-mode typecheck via tsconfig.
- `bin/sanity-check` - PATH shim while the plugin is enabled; delegates to `cli.ts`'s `main`.
- `commands/sanity-check.md` - the `/sanity-check` slash-command prompt: invocation + node fallback, temp-file convention for the no-arg case, exit-code reporting rules.
- `.claude-plugin/plugin.json` - plugin manifest (name `sanity-check`).
- Reuses `@gizmos/sanity-check-core` - verdict logic _and_ the `chatComplete` transport (see its AGENTS.md for the full API).

## Config (source locations)

| Knob                    | Where                                 | Notes                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SANITY_CHECK_BASE_URL` | `cli.ts` (`BASE_URL`)                 | default `http://localhost:1234/v1`                                                                                                                                                                                             |
| `SANITY_CHECK_A_MODEL`  | `cli.ts` (`PRODUCER_MODEL`)           | default `claude-sonnet-4-20250514`                                                                                                                                                                                             |
| `SANITY_CHECK_B_MODEL`  | `cli.ts` (`REVIEWER_MODEL`)           | default `qwen3.8-4b-distill`; equal to A only warns                                                                                                                                                                            |
| `MAX_ROUNDS`            | `../sanity-check-core/src/core.ts:15` | 3; imported, not runtime-configurable                                                                                                                                                                                          |
| Per-call `maxTokens`    | `cli.ts` (`maxTokensBudget`)          | `SANITY_CHECK_MAX_TOKENS` env > 4000; applied to A and B                                                                                                                                                                       |
| `SANITY_CHECK_THINKING` | `cli.ts` (`main` startup warn)        | documented divergence: the CLI transport (`@gizmos/transport-core` `chatComplete`) is plain OpenAI-compatible with no thinking field - a level set here warns and is NOT applied (the pi adapter honors it via `streamSimple`) |
| `chatComplete` request  | `../transport-core/openai.ts`         | `temperature: 0`; trailing `/` stripped off baseURL                                                                                                                                                                            |

`engines.node >= 22.18` (`package.json`): type stripping lets the `.ts` entry run directly under node, and the command doc's `node` fallback loads it natively.

## Testing & validation

```bash
npm run check                                       # tsc --noEmit, strict - this adapter only
cd ../sanity-check-core && node src/self-check.ts   # verdict-core battery - 50 assertions
cd .. && npm run check --workspaces --if-present    # everything
```

No in-package test suite on purpose: the adapter is a thin loop over the core, which carries the real battery (`classifyReport`/`convergenceFor`/`parseAgree`/`blocksToText` regressions, 50 assertions) guarding the convergence semantics this package depends on. The adapter-specific surface (arg/exit-code handling, blank-revision guard) is kept to one screen of code so it stays reviewable by eye.
