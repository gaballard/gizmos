/**
 * Sanity Check CLI output-budget tests (sanity-check-max-reasoning-tokens).
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI resolves the deliverable against its process cwd and calls the
// OpenAI-compatible transport via global fetch. Mocking fetch proves the
// budget reaches the wire (max_tokens in the request body) without a live
// endpoint: reviews answer AGREE: yes, so a converged loop is ONE review call;
// the A/B both-called scenario replays a no-then-agree review queue.

const dir = mkdtempSync(join(tmpdir(), 'sanity-check-cli-budget-'));
process.chdir(dir);
const deliverable = join(dir, 'deliverable.md');
writeFileSync(deliverable, 'a substantive deliverable body');

const AGREE = 'AGREE: yes\nThe shape holds and the flow is sound.';
const DISAGREE = '🔴 High: unsafe eval in render path.\n\nAGREE: no - the finding stands.';

type Captured = { model: string; body: any };
let captured: Captured[] = [];
let queue: string[] = [];

const restoreFetch = ((orig) => () => {
  globalThis.fetch = orig;
})(globalThis.fetch);

const mockFetch = () => {
  captured = [];
  queue = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { model?: string };
    captured.push({ model: body.model ?? '', body });
    const content = queue.length ? (queue.shift() ?? AGREE) : AGREE;
    const json = JSON.stringify({ choices: [{ message: { content } }] });
    return {
      ok: true,
      status: 200,
      text: async () => json,
      json: async () => JSON.parse(json),
    } as unknown as Response;
  }) as typeof fetch;
};

const run = async () => {
  const { main } = await import('../cli.ts');
  return main([deliverable]);
};

test.after(() => {
  restoreFetch();
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  delete process.env.SANITY_CHECK_THINKING;
  rmSync(dir, { recursive: true, force: true });
});

test('default: the review request carries max_tokens 4000', async () => {
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  mockFetch();
  const code = await run();
  assert.equal(code, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.max_tokens, 4000);
});

test('SANITY_CHECK_MAX_TOKENS env reaches both A and B request bodies', async () => {
  process.env.SANITY_CHECK_MAX_TOKENS = '9000';
  mockFetch();
  queue = [DISAGREE, AGREE]; // round 1 disagree -> revise (A) -> round 2 agree
  const code = await run();
  assert.equal(code, 0);
  assert.equal(captured.length, 3, 'review, revise, review');
  for (const call of captured) {
    assert.equal(call.body.max_tokens, 9000, `call for ${call.model} must honor the env budget`);
  }
  assert.ok(
    captured.some((c) => c.model !== captured[0].model),
    'both A and B were exercised',
  );
});

test('bad SANITY_CHECK_MAX_TOKENS falls back to 4000', async () => {
  process.env.SANITY_CHECK_MAX_TOKENS = 'bogus';
  mockFetch();
  const code = await run();
  assert.equal(code, 0);
  assert.equal(captured[0].body.max_tokens, 4000);
});

test('SANITY_CHECK_THINKING is loudly a divergence, not silently applied', async () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (fmt: unknown) => warns.push(String(fmt));
  process.env.SANITY_CHECK_THINKING = 'high';
  try {
    mockFetch();
    const code = await run();
    assert.equal(code, 0);
  } finally {
    console.warn = origWarn;
    delete process.env.SANITY_CHECK_THINKING;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.max_tokens, 4000);
  assert.ok(
    warns.some((w) => w.includes('SANITY_CHECK_THINKING') && w.includes('not applied')),
    warns.join('\n'),
  );
  const keys = Object.keys(captured[0].body);
  assert.ok(
    !keys.some((k) => /reasoning|thinking/i.test(k)),
    `no thinking fields may leak into the plain OpenAI-compat body: ${keys.join(',')}`,
  );
});
