# Sanity Check (Claude Code)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Sanity Check is a tool that stops a single model from rubber-stamping its own work.

It runs a cross-model agree/disagree review loop (`/sanity-check`) over a deliverable: a producer model A produces it, an _independent_ reviewer model B critiques it; if B raises High/Medium findings, A revises and the loop repeats until agreement or the round cap (3). B should differ from A (the CLI warns if they're equal) - a single model reviewing its own work is the weakest review there is, and a hollow "AGREE: yes" never passes as clean.

Claude Code slash commands can't drive a multi-round loop natively, so the loop runs as a script the `/sanity-check` command shells out to: both A and B are called as OpenAI-compatible completions against a configured endpoint, and A is a configured producer model, not literally your live Claude session. The deliverable is wrapped as untrusted data, not instructions, before B sees it.

Sanity Check is also available as a [Pi](https://pi.dev/) coding agent extension at [`pi-sanity-check`](../pi-sanity-check/).

## Installation

Load it for this session:

```bash
claude --plugin-dir /path/to/gizmos/packages/claude-sanity-check
```

Or as a skills-dir plugin (auto-loads every session):

```bash
cp -R /path/to/gizmos/packages/claude-sanity-check ~/.claude/skills/sanity-check
```

Validate the manifest any time with `claude plugin validate .claude-plugin/plugin.json`.

_Note: This plugin is a wrapper around the verdict logic in [`sanity-check-core`](../sanity-check-core/)._

## Configuration

Set the loop's endpoint and models as env vars in the shell that launches Claude Code (e.g. `SANITY_CHECK_A_MODEL=gpt-5 SANITY_CHECK_B_MODEL=glm-5.1`):

### Runtime flags

| Env var                   | Default                    | Purpose                                                                                                                                                                                |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANITY_CHECK_BASE_URL`   | `http://localhost:1234/v1` | OpenAI-compatible host for A and B                                                                                                                                                     |
| `SANITY_CHECK_A_MODEL`    | `claude-sonnet-4-20250514` | producer / reviser model                                                                                                                                                               |
| `SANITY_CHECK_B_MODEL`    | `qwen3.8-4b-distill`       | independent reviewer model                                                                                                                                                             |
| `SANITY_CHECK_MAX_TOKENS` | `4000`                     | output-token budget for every review/revision call (A and B)                                                                                                                           |
| `SANITY_CHECK_THINKING`   | unset                      | NOT applied on this adapter: the transport is plain OpenAI-compatible with no thinking field; the CLI warns and continues if you set it (the pi adapter applies it via `streamSimple`) |

Precedence is **env var > default** - nothing persists between runs. The loop cap (`MAX_ROUNDS = 3`) and both system prompts are constants in [`@gizmos/sanity-check-core`](../sanity-check-core/).

_Note: B must differ from A for the review to be independent - the CLI warns if they're equal._

## Usage

Once installed, run `/sanity-check` after A produces a deliverable.

### Commands

- `/sanity-check <deliverable-path>`: reviews the file. Relative paths resolve against the CLI's process cwd (the directory Claude shells out from); absolute paths pass through. An unreadable path reports the resolved path actually attempted.
- `/sanity-check`: uses your latest deliverable - the command writes it to a temp file first and passes that path.

The loop prints its transcript; the command reports the outcome using the CLI's exit code:

| Exit code | Meaning                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | `CONVERGED at round N` - agreement reached                                                                                            |
| `1`       | `STOPPED at round N (cap 3)`, or a review voided by a transport failure - residual High/Medium disputes remain, agreement not claimed |
| `2`       | Missing/unreadable deliverable path, or an empty deliverable                                                                          |

_Note: every review and revision is a real model call - a full 3-round run is up to 5 completions._

## What you'll see in a session

- **A round-by-round transcript.** Each round prints `Round N/3: reviewer <B> analyzing…` followed by B's full review and its tally (`agree=…, N High / N Medium`).
- **A convergence report.** On agreement: `CONVERGED at round N: <reason>`, exit 0.
- **A stop with residual disputes.** At the cap without agreement: `STOPPED at round N (cap 3): <reason>` plus the directive to surface the residual disputes and not claim agreement - exit 1.
- **A hollow-approval refusal.** A review that didn't follow the output format, or an `AGREE: yes` with no body, never counts as convergence.
- **A transport-failure void.** If a review call errors at the endpoint, that round is voided (`[Round N] <B> review FAILED: <reason>`) and the run stops at exit 1 - never misread as a clean pass.
- **A producer safeguard.** If A returns a blank or failed revision, the previous deliverable is retained (`producer returned an empty revision - retaining previous deliverable`) - B never reviews an empty deliverable.
- **An independence warning.** `warning: producer model equals reviewer model (<model>) - not an independent review` when A === B.

## Scope

**Does:**

- Run the A/B loop up to `MAX_ROUNDS` (3) over any text deliverable on disk.
- Classify B's findings (High/Medium) and its explicit `AGREE: yes|no` line, and decide convergence.

**Does not:**

- Call the Anthropic API or touch your live Claude session - both models go through the OpenAI-compatible endpoint.
- Inject skills or git state into B's context - unlike the Pi extension, B sees only the deliverable under the shared reviewer prompt.
- Persist anything between runs - the loop keeps no state beyond the printed transcript.

## Latency and cost

Each round is a network round-trip to `SANITY_CHECK_BASE_URL`: a full 3-round run is at most 5 completion calls (3 reviews + 2 revisions), each capped at 4000 tokens, and convergence stops early. If a review call fails at the endpoint, that round is voided (`review FAILED`) and the run stops at exit 1 rather than reporting false agreement.

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/claude-sanity-check/LICENSE.md)

## Resources

- [sanity-check-core](../sanity-check-core/) - Shared library with core logic
- [pi-sanity-check](../pi-sanity-check/) - Pi coding agent version of this tool
- [Claude Code](https://code.claude.com/)
