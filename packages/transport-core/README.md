# Transport Core

Implementation-neutral OpenAI-compatible HTTP transport. Neither
quality-check nor sanity-check owns it; both cores re-export it
(`sanity-check-trust-boundary`, 2026-10-04).

## Surface (`src/openai.ts` + `src/validate.ts`)

- `chatComplete(opts)` - POST `{baseURL}/chat/completions` via Node `fetch`
  and return `choices[0].message.content`.
- `validateBaseURL(raw)` - URL policy, resolved before any fetch:
  - `http:`/`https:` only (`ws:`, `ftp:`, `file:` rejected)
  - cleartext `http:` only for loopback hosts (`localhost`, `127.0.0.1`,
    `[::1]` - keeps the default local llamacpp config-free)
  - URL userinfo (`https://user:pass@host`) rejected - pass `apiKey` instead
  - whitespace/control characters rejected (WHATWG `URL` strips them silently)
  - this is a guardrail against obviously-hostile URLs, not an SSRF firewall;
    the operator's config remains the documented trust model
- `isLoopbackHost(hostname)` - the loopback predicate above.
- `opts.apiKey` - sent only as `Authorization: Bearer …`; never interpolated
  into any thrown error or log line.
- `opts.responseFormat` - passthrough to the OpenAI `response_format` body
  field (e.g. LM Studio json_schema mode).

## Tests

`cheat: npm test` (Node built-in runner, offline - `fetch` is stubbed).

## Source-truth pointer

Behavior + policy rationale: `measure/product.md` "Security & Trust" and
`measure/design.md` "Transport".
