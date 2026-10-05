# Sanity Check (Pi)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Sanity Check is a tool that stops a single model from rubber-stamping its own work.

It runs a cross-model agree/disagree review loop (`/sanity-check`) over a deliverable: your session model A produces it, an _independent_ reviewer model B critiques it; if B raises High/Medium findings, A revises and the loop repeats until agreement or the round cap (3). B is forced to differ from A - a single model reviewing its own work is the weakest review there is, and a hollow "AGREE: yes" never passes as clean.

B is set up to actually verify rather than imagine: the reviewer's context is injected with the binding-sentinel and agent-personas skills plus the git working-tree state (diff against HEAD and untracked source files), so the review checks claims against the code really on disk.

Sanity Check is also available as a [Claude Code](https://code.claude.com/) plugin at [`claude-sanity-check`](../claude-sanity-check/). The verdict logic is not duplicated - it lives in the shared [`@gizmos/sanity-check-core`](../sanity-check-core/) workspace package.

## Installation

Install from source (the npm package is planned but not yet published, so the registry form doesn't resolve yet):

```bash
pi install /path/to/gizmos/packages/pi-sanity-check
```

_Note: this extension is a wrapper around the verdict logic in [`sanity-check-core`](../sanity-check-core/)._

## Configuration

The extension needs one choice: reviewer model B. The first `/sanity-check` prompts you to pick one; it must differ from the session model. Set it persistently ahead of time with `/sanity-checker <model>`.

### Runtime flags

- `SANITY_CHECK_REVIEWER_PROVIDER`: provider hosting reviewer B. Defaults to `lmstudio`.
- `SANITY_CHECK_REVIEWER_MODEL`: reviewer B model id. Defaults to `qwen3.8-4b-distill`.
- `SANITY_CHECK_MAX_TOKENS`: output-token budget for each review/revision call (both A and B). Defaults to `4000`.
- `SANITY_CHECK_THINKING`: thinking level for those calls (`minimal` `low` `medium` `high` `xhigh` `max`). Unset keeps the plain completion path; pi clamps the level to the model's capability (a non-reasoning model opts out cleanly).
- `SANITY_CHECK_STATE`: where the reviewer selection and the two `/sanity-checker` knobs persist. Defaults to `~/.pi/sanity-check-reviewer.json`.

Precedence is **env var > persisted `/sanity-checker` state > default**. The loop cap (`MAX_ROUNDS = 3`) and both system prompts are constants in [`@gizmos/sanity-check-core`](../sanity-check-core/).

## Usage

Once installed, run `/sanity-check` after A produces a deliverable.

### Commands

- `/sanity-check <deliverable-path>`: reviews the file. Relative paths resolve against the session cwd (`ctx.cwd`); absolute paths pass through.
- `/sanity-check`: reviews A's most recent assistant output in this session.
- `/sanity-checker`: shows the current reviewer model B, output budget, and thinking level.
- `/sanity-checker <model>`: sets and persists reviewer B - bare id (`glm-5.1`), `provider/id` (`ollama-cloud/glm-5.1`), or a `:cloud` suffix (`glm-5.1:cloud`). A === B is refused.
- `/sanity-checker --max-tokens <tokens|reset>`: sets (or resets to the 4000 default) the per-call output budget; persists to `SANITY_CHECK_STATE`.
- `/sanity-checker --thinking <level|off>`: sets (or clears) the thinking level (`minimal`…`max`); persists to `SANITY_CHECK_STATE`.

_Note: every review and revision is a real model call - a full 3-round run is up to 5 completions._

## What you'll see in a session

- **A reviewer pick.** The first `/sanity-check` opens a model picker; a choice equal to the session model is refused. The headless (no-UI) run needs a prior in-session `/sanity-checker` selection instead.
- **A per-round review steer.** Each round posts `[Round N] <provider>/<id>'s review (agree=…, N High / N Medium)` with B's full review, delivered as a steer so the session sees it.
- **A verdict message.** `Sanity Check - CONVERGED at round N: <reason>` with "Agreement reached.", or `STOPPED at round N (cap 3)` with the directive to surface residual disputes to you rather than claim agreement.
- **A hollow-approval refusal.** A review that didn't follow the output format, or an `AGREE: yes` with no body, never counts as convergence.
- **A cancellation record.** Escaping mid-check surfaces a warning and appends the round, model, and reason to `~/.pi/sanity-check-logs/cancellations.jsonl` - an interrupted run is never silent.
- **An empty-reply diagnostic.** If B returns an empty review, the full assistant message (stopReason, usage, error) is dumped to `~/.pi/sanity-check-empty.json` with a warning.

## Scope

**Does:**

- Pick a reviewer B that must differ from the session model A (rejected at pick time, in `/sanity-checker`, and again before round 1).
- Loop up to `MAX_ROUNDS` (3): B reviews, classifies findings (High/Medium), parses the explicit `AGREE: yes|no` line; A revises on disagreement.
- Inject binding-sentinel + agent-personas skills and the git working-tree state (`git diff HEAD`, truncated; up to 6 untracked source files with content) into B's context.
- Persist the reviewer selection so later runs reuse it.

**Does not:**

- Trust a reviewer blindly - format-violating or bodyless approvals are refused by the shared core.
- Call any network endpoint directly - inference goes through Pi's model registry (`ctx.modelRegistry.complete`), including the revision call, which reuses the session model.
- Persist anything mid-run - a cancelled check leaves no rounds behind; only the cancellation log records that it happened.

## Latency and cost

Each round is two model calls (B's review, then A's revision), capped at 4000 tokens with temperature 0; convergence stops early, and B's context is re-injected (skills + git state) every round, so a reviewing model on a slow provider dominates the loop's wall time.

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/pi-sanity-check/LICENSE.md)

## Resources

- [sanity-check-core](../sanity-check-core/) - Shared library with core logic
- [claude-sanity-check](../claude-sanity-check/) - Claude Code version of this tool
- [Pi coding agent](https://pi.dev)
