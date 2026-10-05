# Sanity Check (Core)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Sanity Check is a tool that stops a single model from rubber-stamping its own work.

It runs the **cross-model agree/disagree review loop**: producer model **A** produces a deliverable, an _independent_ reviewer model **B** critiques it; if B raises High/Medium findings, A revises and the loop repeats until agreement or the round cap (3).

This package is the verdict engine both implementations are built on: it holds the reviewer and producer system prompts, the finding classifier, and the convergence rubric - with no agent code attached. If you want Sanity Check in your coding agent, install one of the implementations:

- [`@gizmos/pi-sanity-check`](../pi-sanity-check/) - the [Pi](https://pi.dev/) extension (this repo's default)
- [`@gizmos/claude-sanity-check`](../claude-sanity-check/) - the [Claude Code](https://code.claude.com/) plugin

Both adapters load the same engine here, so the review rules and convergence decisions below apply to whichever one you pick.

_Note: the npm package for this core is planned but not yet published; the adapters install it from a checkout of this repo._

## Verdicts

The reviewer's contract: findings tagged 🔴 High / 🟡 Medium / 🟢 Low, and the report ends with the line `AGREE: yes|no`. Each round, the engine reads B's report and decides:

| Reviewer report                                         | What happens in the loop                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `AGREE: yes` with a real body, 0 High, at most 1 Medium | Converged - agreement reached, the loop ends.                            |
| `AGREE: no`, any open High, or 2+ open Medium           | Not converged - A revises and the loop continues, up to the 3-round cap. |
| No `AGREE` line, format otherwise followed, 0 High      | Implicit agreement - converges.                                          |
| Freeform text with no severity markers                  | Refused - agreement cannot be verified, so the loop continues.           |
| `AGREE: yes` with an empty or trivial body              | Refused - a hollow approval never passes as a clean pass.                |

Severity markers are read generously: emoji (`🔴`/`🟡`/`🟢`), textual labels (`High Priority`, `[medium]`, `**High**`), heading style (`#### 🔴 High - …`) and bold items (`**H1.**`) all count - a reviewer that ignores the emoji contract is still understood.

## What it covers

**In scope** - the pure decision logic every surface shares:

- The two system prompts: reviewer B's (independent skeptic; ends `AGREE: yes|no`) and producer A's (revise, then a `[resolved]`/`[disputed]` changelog).
- Finding classification: High/Medium counts from a report in any of the recognized formats above.
- The convergence rubric and the `MAX_ROUNDS` (3) cap.
- Model resolution helpers (`provider/id` or bare id, with `:cloud`-style suffix preference) and an OpenAI-compatible completion helper.

**Out of scope by design:**

- Running the loop - that lives in each adapter: pi drives it in-session, Claude Code shells out to a CLI script.
- Any agent runtime or environment: no Pi/Claude/OpenCode imports, no env vars, no files, no persistence - pure functions over strings.

## Configuration

The engine has no configuration surface of its own - the implementations load it and expose the settings you actually set (reviewer model, endpoints, env flags - see their READMEs). The round cap and both system prompts are module constants here, not runtime-configurable.

## AI Use Disclaimer

This codebase has been built with the support of coding agents.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/sanity-check-core/LICENSE.md)

## Resources

- [pi-sanity-check](../pi-sanity-check/) - the same loop as a pi coding-agent extension
- [claude-sanity-check](../claude-sanity-check/) - the same loop as a Claude Code plugin
