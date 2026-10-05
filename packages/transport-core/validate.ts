/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// Base-URL policy for the OpenAI-compatible transport (H2 hardening,
// track sanity-check-trust-boundary): HTTPS required for non-loopback hosts,
// userinfo/credentials rejected, non-http(s) schemes rejected, control
// characters rejected (WHATWG URL strips them silently - they must not be
// allowed to smuggle a different URL). Guardrail, not a firewall: the
// endpoint is operator-chosen by design (documented trust model).

export const isLoopbackHost = (hostname: string): boolean => {
  const h = hostname.replace(/\.+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
};

export const validateBaseURL = (
  raw: string,
): { ok: true; baseURL: string } | { ok: false; reason: string } => {
  const url = raw.trim();
  if (!url) return { ok: false, reason: 'baseURL is empty' };
  if (/[\s\u0000-\u001f]/.test(url)) {
    return { ok: false, reason: 'baseURL contains whitespace or control characters' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `baseURL is not a valid URL: refused` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `baseURL scheme must be http: or https: (got ${parsed.protocol})` };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'baseURL must not embed credentials (userinfo) - pass an apiKey option instead',
    };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        'cleartext http is only allowed for loopback hosts (localhost/127.0.0.1/[::1]) - use https for remote endpoints',
    };
  }
  return { ok: true, baseURL: url };
};
