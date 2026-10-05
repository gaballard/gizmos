/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenAI-compatible chat completion via global fetch (Node). The one
// transport helper in the core: adapters that run outside a host LLM session
// (e.g. the Claude Code plugin CLI) call the provider endpoint directly,
// while in-session adapters use the host's own model API instead.
export const chatComplete = async (opts: {
  baseURL: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> => {
  const res = await fetch(`${opts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? 800,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  return (body?.choices?.[0]?.message?.content?.trim?.() ?? '').toString();
};
