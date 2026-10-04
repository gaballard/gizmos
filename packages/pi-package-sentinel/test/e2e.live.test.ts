/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createVetter } from 'package-sentinel-core';
import extension from '../src/index.ts';
import { expect } from './expect.ts';

// Network-gated live integration: exercises the REAL extension wiring
// (handler closures registered by src/index.ts) against live OSV + npm registry.
// gated: skipped unless RUN_LIVE_TESTS=1 (keeps CI green offline).
const LIVE = process.env.RUN_LIVE_TESTS === '1';
const maybe = (name: string, fn: () => Promise<void>) =>
  LIVE ? test(name, fn) : test.skip(name, fn);

type Handler = (event: any, ctx: any) => unknown;

const harness = () => {
  const handlers: Record<string, Handler> = {};
  const tools: any[] = [];
  const notify: string[] = [];
  const api: any = {
    on: (name: string, h: Handler) => {
      handlers[name] = h;
    },
    registerTool: (t: any) => tools.push(t),
  };
  const ctx = (cwd: string, hasUI = true) => ({
    cwd,
    hasUI,
    ui: { notify: (m: string) => notify.push(m) },
  });
  return { handlers, tools, notify, api, ctx };
};

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-e2e-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', dependencies: {} }),
  );
  return dir;
};

describe('Phase 5 e2e (live network) - real wiring against OSV+npm', () => {
  maybe(
    'registers the gate, snapshot, validation handlers and assert_installable tool',
    async () => {
      const h = harness();
      await extension(h.api);
      for (const ev of ['tool_call', 'tool_execution_start', 'tool_execution_end', 'turn_end']) {
        expect(typeof h.handlers[ev]).toBe('function');
      }
      expect(h.tools.map((t) => t.name)).toContain('assert_installable');
    },
  );

  maybe(
    'AC-3: gate blocks a tool targeting lodash@4.17.19 (real OSV) and manifest stays clean',
    async () => {
      const h = harness();
      await extension(h.api);
      const dir = fixture();
      const res: any = await h.handlers['tool_call'](
        {
          type: 'tool_call',
          toolCallId: 'c1',
          toolName: 'bash',
          input: { command: 'npm add lodash@4.17.19' },
        },
        h.ctx(dir),
      );
      expect(res).toHaveProperty('block', true);
      expect(res.reason).toContain('lodash@4.17.19');
      // gate prevented the write: fixture manifest is unchanged (AC-3)
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"dependencies":{}');
      rmSync(dir, { recursive: true, force: true });
    },
  );

  maybe('does not block a non-vulnerable, successfully-checked version', async () => {
    // is-number@7.0.0 is currently `safe` against live OSV (probed). OSV adds
    // MAL-2025 advisories dynamically; if this pick stops being safe, retarget.
    const h = harness();
    await extension(h.api);
    const dir = fixture();
    const live = await createVetter(dir).vet('is-number', '7.0.0');
    expect(live?.verdict).toBe('safe');
    const res: any = await h.handlers['tool_call'](
      {
        type: 'tool_call',
        toolCallId: 'c2',
        toolName: 'bash',
        input: { command: 'npm add is-number@7.0.0' },
      },
      h.ctx(dir),
    );
    // gate must not over-block a checked, non-flagged verdict
    expect(res?.block ?? false).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  maybe('Firing Point 2: tool_execution_end flags a flagged version that leaked in', async () => {
    const h = harness();
    await extension(h.api);
    const dir = fixture();
    await h.handlers['tool_execution_start']({}, h.ctx(dir));
    // simulate a bypassed write of a vulnerable version into the manifest
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '1.0.0',
        dependencies: { lodash: '4.17.19' },
      }),
    );
    await h.handlers['tool_execution_end']({}, h.ctx(dir));
    expect(h.notify.join(' ')).toContain('4.17.19');
    rmSync(dir, { recursive: true, force: true });
  });
});
