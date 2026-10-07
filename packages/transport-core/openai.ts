/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenAI-compatible chat completion via fetch (Node global fetch). The ONE
// transport helper in the monorepo: extracted here (neutral core) per the
// sanity-check-trust-boundary track so quality-core and sanity-check-core no
// longer carry divergent copies. Hardening (H2):
// - baseURL is validateBaseURL()-checked BEFORE any fetch (HTTPS for
//   non-loopback, no userinfo, http(s)-only, no control chars).
// - an optional apiKey is sent ONLY as `Authorization: Bearer ...` and is
//   never interpolated into any thrown error string.

import { validateBaseURL } from './validate.ts';

export type ChatCompleteOpts = {
  baseURL: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** Supplied out-of-band by the caller (env var); sent only as a Bearer header. */
  apiKey?: string;
  /** Passed through verbatim as the OpenAI `response_format` body field
   *  (e.g. LM Studio json_schema mode). */
  responseFormat?: unknown;
  /** Conversation id for providers that route by session. Sent as
   *  `x-opencode-session` when the host is opencode.ai, which 400s with
   *  MissingSessionID otherwise. Ignored by every other host. */
  sessionId?: string;
};

const isOpenCodeHost = (baseURL: string): boolean => {
  try {
    return new URL(baseURL).hostname === 'opencode.ai';
  } catch {
    return false;
  }
};

export const chatComplete = async (opts: ChatCompleteOpts): Promise<string> => {
  // Reject before any network I/O; the reason is a static policy string, so
  // the key must never appear in the message.
  const url = validateBaseURL(opts.baseURL);
  if (!url.ok) throw new Error(`chatComplete refused baseURL: ${url.reason}`);
  const res = await fetch(`${url.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.sessionId && isOpenCodeHost(url.baseURL)
        ? { 'x-opencode-session': opts.sessionId }
        : {}),
      ...(opts.apiKey === undefined ? {} : { Authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? 800,
      temperature: 0,
      ...(opts.responseFormat === undefined ? {} : { response_format: opts.responseFormat }),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  return (body?.choices?.[0]?.message?.content?.trim?.() ?? '').toString();
};
