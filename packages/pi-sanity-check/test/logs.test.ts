/**
 * Sanity Check adapter log/selection tests (sanity-check-reviewer-selection).
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Seed persisted reviewer state BEFORE importing the adapter: STATE_PATH is
// read at module load, so the temp file must exist first.
const dir = mkdtempSync(join(tmpdir(), 'sanity-check-test-'));
const statePath = join(dir, 'reviewer.json');
const REVIEWER = { provider: 'cloud-x', id: 'deepseek-v4.1-flash' };
writeFileSync(statePath, JSON.stringify({ provider: REVIEWER.provider, model: REVIEWER.id }));
process.env.SANITY_CHECK_STATE = statePath;

const register = async () => {
  delete process.env.SANITY_CHECK_REVIEWER_PROVIDER;
  delete process.env.SANITY_CHECK_REVIEWER_MODEL;
  const mod = await import('../index.ts');
  const handlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};
  const sent: string[] = [];
  const pi = {
    registerCommand: (_n: string, c: { handler: (args: string, ctx: any) => Promise<void> }) => {
      handlers[_n] = c.handler;
    },
    sendMessage: (_m: unknown, _o: unknown) => undefined,
  };
  // Capture messages: sendMessage is called via eloquent `pi.sendMessage` in
  // the closure; wrap so the content is recorded for assertions.
  (pi as any).sendMessage = (m: { content?: string }) => {
    sent.push(String(m?.content));
  };
  (mod.default as (p: unknown) => void)(pi);
  return { handlers, sent };
};

const models = [
  { provider: 'a-prov', id: 'session-A', baseUrl: 'http://a' },
  { provider: 'cloud-x', id: 'deepseek-v4.1-flash', baseUrl: 'http://b' },
  { provider: 'lmstudio', id: 'session-A', baseUrl: 'http://c' },
];

const makeCtx = (over: Record<string, unknown> = {}) => {
  const notifies: string[] = [];
  const ctx: any = {
    model: { provider: 'a-prov', id: 'session-A' },
    hasUI: true,
    ui: { notify: (m: string) => notifies.push(m) },
    signal: undefined,
    scopedModels: [],
    sessionManager: {
      buildContextEntries: () => [
        { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
        { message: { role: 'assistant', content: [{ type: 'text', text: 'the deliverable' }] } },
      ],
    },
    modelRegistry: {
      getAvailable: () => models,
      find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
      complete: async () => ({
        stopReason: 'stop',
        content: [{ type: 'text', text: 'AGREE: yes\nThe shape holds and the flow is sound.' }],
      }),
    },
    ...over,
  };
  return { ctx, notifies };
};

test('sanity-checker with no arg reports the current selection', async () => {
  const { handlers } = await register();
  const { ctx, notifies } = makeCtx();
  await handlers['sanity-checker']('', ctx);
  assert.ok(
    notifies.some((m) => m.includes(`${REVIEWER.provider}/${REVIEWER.id}`)),
    notifies.join('\n'),
  );
});

test('empty-args sanity-check is a no-op guard (no A/B summary yet)', async () => {
  const { handlers, sent } = await register();
  const { ctx } = makeCtx();
  await handlers['sanity-check']('', ctx);
  // Last assistant output ("the deliverable") is found, so a run report is sent.
  assert.ok(sent.length > 0, 'expected a run to complete');
});

test('opening log labels producer A and reviewer B by role', async () => {
  const { handlers, sent } = await register();
  const { ctx, notifies } = makeCtx();
  await handlers['sanity-check']('', ctx);
  const open = notifies.find((m) => m.includes('Sanity Check:')) ?? '';
  assert.match(open, /producer A=a-prov\/session-A\s+reviewer B=cloud-x\/deepseek-v4.1-flash/, open);
  const result = sent.find((m) => m.includes('Sanity Check -')) ?? '';
  assert.match(result, /Producer A \(session\): a-prov\/session-A\s+Reviewer B: cloud-x\/deepseek-v4.1-flash/, result);
});

test('switch persists the selection through the :cloud suffix path', async () => {
  const { handlers } = await register();
  const { ctx, notifies } = makeCtx();
  await handlers['sanity-checker']('deepseek-v4.1-flash:cloud', ctx);
  assert.ok(
    notifies.some((m) => m.includes(`changed to ${REVIEWER.provider}/${REVIEWER.id}`)),
    notifies.join('\n'),
  );
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(saved, { provider: REVIEWER.provider, model: REVIEWER.id });
  assert.ok(notifies.every((m) => !m.includes('env is set')), notifies.join('\n'));
});

test('switch to the session model is refused and state is untouched', async () => {
  const { handlers } = await register();
  const { ctx, notifies } = makeCtx();
  const before = readFileSync(statePath, 'utf8');
  await handlers['sanity-checker']('a-prov/session-A', ctx);
  assert.ok(
    notifies.some((m) => m.includes('Reviewer must differ from the session model')),
    notifies.join('\n'),
  );
  assert.equal(readFileSync(statePath, 'utf8'), before);
});

test('switch warns when a SANITY_CHECK_REVIEWER_* env pin contradicts it', async () => {
  const { handlers } = await register();
  const { ctx, notifies } = makeCtx();
  process.env.SANITY_CHECK_REVIEWER_MODEL = 'old-qwen-max';
  try {
    await handlers['sanity-checker'](`${REVIEWER.provider}/${REVIEWER.id}`, ctx);
    assert.ok(
      notifies.some((m) => m.includes('SANITY_CHECK_REVIEWER_') && m.includes('override')),
      notifies.join('\n'),
    );
  } finally {
    delete process.env.SANITY_CHECK_REVIEWER_MODEL;
  }
});

test('state-file teardown', () => {
  rmSync(dir, { recursive: true, force: true });
});
