---
name: sanity-check
description: Cross-model agree/disagree review loop. An independent reviewer model B critiques a deliverable via an OpenAI-compatible endpoint; if it raises High/Medium findings, producer model A revises, looping to agreement or the 3-round cap. Usage: /sanity-check <deliverable path>, or /sanity-check (uses your latest deliverable - write it to a temp file first).
---

Run the bundled loop against the deliverable and report the outcome. The `sanity-check` executable is on your PATH because this plugin is enabled. If it is not, run it directly with `node "${CLAUDE_PLUGIN_ROOT}/cli.ts"`.

With a path argument:

```
sanity-check "$ARGUMENTS"
```

Without a path argument, your most recent deliverable is the subject: write it to a temp file first, then run `sanity-check <that file>`.

Config (env): `SANITY_CHECK_BASE_URL` (OpenAI-compatible host, default `http://localhost:1234/v1`), `SANITY_CHECK_A_MODEL` (producer, default `claude-sonnet-4-20250514`), `SANITY_CHECK_B_MODEL` (reviewer, default `qwen3.8-4b-distill`), and `SANITY_CHECK_MAX_TOKENS` (per-call output budget for A and B, default `4000`).

Report the result:

- **Exit 0 = CONVERGED.** Report the agreement (round and residual findings) to the user.
- **Exit 1 = STOPPED** at the 3-round cap without convergence. Surface the reviewer's residual High/Medium disputes to the user. Do NOT claim agreement.
- A reviewer that did not follow the output format, or returned an empty/bodyless review, is refused as convergence - treat it as not-agreed and keep working to resolve the disputes.
