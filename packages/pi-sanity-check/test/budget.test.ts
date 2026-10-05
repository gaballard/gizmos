/**
 * Sanity Check output-budget tests (sanity-check-max-reasoning-tokens).
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Seed a LEGACY state file (provider/model only, no budget keys) BEFORE
// importing the adapter: STATE_PATH is read at module load, so the temp file
// must exist first. Budget resolution reads env lazily per call, so env
// scenarios run in this one process. Same harness as logs.test.ts.
const dir = mkdtempSync(join(tmpdir(), 'sanity-check-budget-'));
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
  const completeCalls: Array<{ maxTokens: unknown }> = [];
  const streamCalls: Array<{ maxTokens?: unknown; reasoning?: unknown }> = [];
  const ctx: any = {
    model: { provider: 'a-prov', id: 'session-A' },
    hasUI: true,
    cwd: dir,
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
      complete: async (_m: unknown, _c: unknown, opts: { maxTokens: unknown }) => {
        completeCalls.push(opts);
        return {
          stopReason: 'stop',
          content: [{ type: 'text', text: 'AGREE: yes\nThe shape holds and the flow is sound.' }],
        };
      },
      // pi's streamSimple maps the provider-neutral `reasoning: ThinkingLevel`
      // through clampThinkingLevel (model.reasoning / thinkingLevelMap), so the
      // adapter delegating here IS the capability-clamp path. The fake models
      // carry no `reasoning` field on purpose: a non-reasoning model must still
      // get the level passed and let pi clamp it to a no-op ('off').
      streamSimple: (
        _m: unknown,
        _c: unknown,
        opts: { maxTokens?: unknown; reasoning?: unknown },
      ) => {
        streamCalls.push(opts);
        return {
          result: async () => ({
            stopReason: 'stop',
            content: [{ type: 'text', text: 'AGREE: yes\nThe shape holds and the flow is sound.' }],
          }),
        };
      },
    },
    ...over,
  };
  return { ctx, notifies, completeCalls, streamCalls };
};

const runOnce = async (handlers: Record<string, (args: string, ctx: any) => Promise<void>>) => {
  const { ctx, completeCalls } = makeCtx();
  await handlers['sanity-check']('', ctx);
  return completeCalls;
};

test('no config: complete is called with the 4000 default', async () => {
  const { handlers } = await register();
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  const { ctx, completeCalls } = makeCtx();
  await handlers['sanity-check']('', ctx);
  assert.equal(completeCalls.length, 1, 'round 1 review = one complete call');
  assert.equal(completeCalls[0].maxTokens, 4000);
});

test('env SANITY_CHECK_MAX_TOKENS wins over the persisted state', async () => {
  const { handlers } = await register();
  process.env.SANITY_CHECK_MAX_TOKENS = '9000';
  try {
    const { ctx, completeCalls } = makeCtx();
    await handlers['sanity-check']('', ctx);
    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0].maxTokens, 9000);
  } finally {
    delete process.env.SANITY_CHECK_MAX_TOKENS;
  }
});

test('non-numeric or non-positive env values fall back to the default', async () => {
  const { handlers } = await register();
  for (const bad of ['bogus', '0', '-5']) {
    process.env.SANITY_CHECK_MAX_TOKENS = bad;
    const completeCalls = await runOnce(handlers);
    assert.equal(completeCalls[0]?.maxTokens, 4000, `env "${bad}" must be ignored`);
  }
  delete process.env.SANITY_CHECK_MAX_TOKENS;
});

test('/sanity-checker --max-tokens persists and applies to the next run', async () => {
  const { handlers } = await register();
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  const { ctx, notifies } = makeCtx();
  await handlers['sanity-checker']('--max-tokens 8000', ctx);
  assert.ok(
    notifies.some((m) => m.includes('max output tokens: 8000')),
    notifies.join('\n'),
  );
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.maxTokens, 8000);
  assert.equal(saved.provider, REVIEWER.provider);
  assert.equal(saved.model, REVIEWER.id);
  const completeCalls = await runOnce(handlers);
  assert.equal(completeCalls[0]?.maxTokens, 8000);
});

test('/sanity-checker --max-tokens reset returns to the 4000 default', async () => {
  const { handlers } = await register();
  const { ctx } = makeCtx();
  await handlers['sanity-checker']('--max-tokens 8000', ctx);
  await handlers['sanity-checker']('--max-tokens reset', ctx);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.maxTokens, undefined);
  const completeCalls = await runOnce(handlers);
  assert.equal(completeCalls[0]?.maxTokens, 4000);
});

test('runOnce returns both registries for knob assertions', async () => {
  const { handlers } = await register();
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  delete process.env.SANITY_CHECK_THINKING;
  const { ctx, completeCalls, streamCalls } = makeCtx();
  await handlers['sanity-check']('', ctx);
  assert.equal(completeCalls.length, 1);
  assert.equal(streamCalls.length, 0, 'unset thinking must stay on the complete() path');
});

const runOnceBoth = async (handlers: Record<string, (args: string, ctx: any) => Promise<void>>) => {
  const { ctx, completeCalls, streamCalls } = makeCtx();
  await handlers['sanity-check']('', ctx);
  return { completeCalls, streamCalls };
};

test('/sanity-checker --thinking persists, routes to streamSimple with the level', async () => {
  const { handlers } = await register();
  delete process.env.SANITY_CHECK_MAX_TOKENS;
  delete process.env.SANITY_CHECK_THINKING;
  const { ctx, notifies } = makeCtx();
  await handlers['sanity-checker']('--thinking high', ctx);
  assert.ok(notifies.some((m) => m.includes('thinking level: high')), notifies.join('\n'));
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.thinking, 'high');
  const { completeCalls, streamCalls } = await runOnceBoth(handlers);
  assert.equal(completeCalls.length, 0, 'thinking path must bypass plain complete()');
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].reasoning, 'high');
  assert.equal(streamCalls[0].maxTokens, 4000);
});

test('/sanity-checker --thinking off clears the knob back to complete()', async () => {
  const { handlers } = await register();
  const { ctx } = makeCtx();
  await handlers['sanity-checker']('--thinking high', ctx);
  await handlers['sanity-checker']('--thinking off', ctx);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.thinking, undefined);
  const { completeCalls, streamCalls } = await runOnceBoth(handlers);
  assert.equal(streamCalls.length, 0);
  assert.equal(completeCalls.length, 1);
});

test('env SANITY_CHECK_THINKING wins over the persisted level', async () => {
  const { handlers } = await register();
  const { ctx } = makeCtx();
  await handlers['sanity-checker']('--thinking high', ctx);
  process.env.SANITY_CHECK_THINKING = 'medium';
  try {
    const { streamCalls } = await runOnceBoth(handlers);
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].reasoning, 'medium');
  } finally {
    delete process.env.SANITY_CHECK_THINKING;
  }
});

test('invalid --thinking is refused without changing state', async () => {
  const { handlers } = await register();
  const { ctx, notifies } = makeCtx();
  const before = readFileSync(statePath, 'utf8');
  await handlers['sanity-checker']('--thinking wat', ctx);
  assert.ok(/usage/i.test(notifies.find((m) => m.includes('thinking')) ?? ''), notifies.join('\n'));
  assert.equal(readFileSync(statePath, 'utf8'), before);
});

test('teardown', () => {
  rmSync(dir, { recursive: true, force: true });
});
