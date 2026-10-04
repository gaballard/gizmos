# Bench Adapter

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

A dev-only OpenAI-compatible HTTP server over Pi. Benchmark harnesses drive it as if it were an OpenAI model, and every `/v1/chat/completions` call runs a real Pi turn - spawning a Pi agent session with the binding-check extension loaded - and returns the assistant reply plus a structured `binding_check` verdict. That way a bench can measure, per call, whether the agent turn closed prematurely.

> Note: the server verifies nothing itself - every verdict is produced by the binding-check extension it loads, not by this server.

## Quick Start

```bash
node server.ts
```

That starts the server on `127.0.0.1:8787` (overridable via `PORT`). It boots a Pi runtime, registers the `lmstudio` provider, and loads the binding-check extension - by default from `../extensions/binding-check/index.ts` relative to the repo's `packages/` dir, which is not in this workspace, so set `BINDING_CHECK_EXT` to a real binding-check extension build for the verdict to resolve. The server never verifies the path, so a wrong one boots normally and every completion returns `PASS`. Point a benchmark at `/v1/chat/completions` with any model id that is loaded in LM Studio:

```jsonc
// POST http://127.0.0.1:8787/v1/chat/completions
{ "model": "qwen3.8-4b-distill", "messages": [{ "role": "user", "content": "…" }] }
```

Response:

```jsonc
{
  "object": "chat.completion",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "…",
        "binding_check": { "verdict": "PASS" },
      },
    },
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "model_ms": 1234 },
}
```

## Verdicts

Each completion carries `binding_check` alongside the assistant reply:

| Verdict | Meaning                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PASS`  | No binding-check failure notice was found in the session after the turn ran - "no FAIL signal received", not proof of clean closure. |
| `FAIL`  | binding-check flagged the turn - `finding` carries the reason (present on `FAIL` only).                                              |

_Latency note:_ `usage` token counts are stubs (`0`); `model_ms` is real wall-clock time - the turn plus the verdict wait (up to a ~1.2 s grace window after the turn settles, capped by a 12 s hard timeout).

## Endpoints

- `POST /v1/chat/completions` - the `messages` may be a string or an array; every string-content block is joined into one prompt, and parts-style array content (non-string `content`) is silently dropped. No multi-turn is kept: each request is a fresh one-turn conversation.
- `/v1/models` - the live LM Studio model catalog. A completion's `model` id must be loaded there, or the request fails with a 400 (`unknown model '…' (is it loaded in LM Studio?)`).

Responses are single JSON completions - no streaming (SSE).

## Configuration

| Env var               | Default                                                                    | Purpose                                             |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `PORT`                | `8787`                                                                     | HTTP listen port (loopback only)                    |
| `LMSTUDIO_BASE_URL`   | `http://127.0.0.1:10103/v1`                                                | LM Studio OpenAI-compatible endpoint (model source) |
| `BINDING_CHECK_EXT`   | `extensions/binding-check/index.ts` relative to the repo's `packages/` dir | binding-check extension entrypoint to load          |
| `TURN_CHECK_PROVIDER` | `lmstudio`                                                                 | provider for the binding-check reviewer             |
| `TURN_CHECK_MODEL`    | first loaded LM Studio model                                               | reviewer model for binding-check                    |

_Note:_ `TURN_CHECK_MODEL` is applied only when `~/.pi/binding-check-reviewer.json` does not already exist - if a persisted `/reviewer` choice exists, it is deliberately left unset so the binding-check extension reuses it. The boot log prints the resolved reviewer.

## Scope limits

- One turn per request - each request spawns a fresh Pi session and disposes it; there are no multi-turn dialogs or tool-call continuations.
- No streaming (SSE) - single JSON completion.
- No verification of its own - the verdict comes from the binding-check extension, not this server.
- A wrong `BINDING_CHECK_EXT` path fails silently - the server boots and every completion returns `PASS`; verify the path before benchmarking.
- Models come from LM Studio only - a model id that is not loaded there does not resolve.
- Dev tool - loopback binding, no auth; not for shared or remote use.

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/bench-adapter/LICENSE.md)

## Resources

- [Pi coding agent](https://pi.dev)