/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { expect } from './expect.ts';

// Network-gated live integration: drives the REAL hook boundary (a spawned
// hooks-handlers/handler.ts process speaking stdin/stdout JSON, as Claude Code
// does) against live OSV + the npm registry. Gated: skipped unless
// RUN_LIVE_TESTS=1, keeping CI green offline.
const LIVE = process.env.RUN_LIVE_TESTS === '1';
const maybe = (name: string, fn: () => Promise<void>) =>
  LIVE ? test(name, fn) : test.skip(name, fn);

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLER = join(PKG_ROOT, 'hooks-handlers', 'handler.ts');

type HookOut = {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

/** Run one synthetic hook event through the real handler process. */
const runHook = (event: object): Promise<HookOut> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [HANDLER], { cwd: PKG_ROOT });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => process.stderr.write(c));
    child.on('close', (code) => {
      try {
        expect(code).toBe(0); // the handler always exits 0; verdicts ride the payload
        resolve(JSON.parse(out) as HookOut);
      } catch (e) {
        reject(e);
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });

const fixture = (deps: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-claude-e2e-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps }),
  );
  return dir;
};

const evt = (hook: string, cwd: string, sessionId: string, extra: object = {}) => ({
  hook_event_name: hook,
  cwd,
  session_id: sessionId,
  ...extra,
});

describe('Phase 5 e2e (live network) - real hook boundary against OSV+npm', () => {
  maybe(
    'AC-3: PreToolUse denies npm add lodash@4.17.19 (real OSV); manifest unchanged',
    async () => {
      const dir = fixture();
      const res = await runHook(
        evt('PreToolUse', dir, 'e2e-ac3', { tool_input: { command: 'npm add lodash@4.17.19' } }),
      );
      const out = res.hookSpecificOutput ?? {};
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason ?? '').toContain(
        '[Package Sentinel] Refuse lodash@4.17.19',
      );
      expect(out.permissionDecisionReason ?? '').toContain('- try ');
      // the gate refused the call: the manifest was never touched
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"dependencies":{}');
      rmSync(dir, { recursive: true, force: true });
    },
  );

  maybe('does not block a non-vulnerable, successfully-checked version', async () => {
    // is-number@7.0.0 is currently `safe` against live OSV (probed by the pi
    // adapter's e2e). OSV adds advisories dynamically; retarget if this pick
    // stops being safe.
    const dir = fixture();
    const res = await runHook(
      evt('PreToolUse', dir, 'e2e-safe', { tool_input: { command: 'npm add is-number@7.0.0' } }),
    );
    expect((res.hookSpecificOutput ?? {}).permissionDecision).not.toBe('deny');
    rmSync(dir, { recursive: true, force: true });
  });

  maybe(
    'Firing Point 2 (leak): a flagged dep written behind the gate is flagged with rollback advice',
    async () => {
      const dir = fixture();
      // persist the "before" snapshot (any PreToolUse event does this)
      await runHook(evt('PreToolUse', dir, 'e2e-leak', { tool_input: {} }));
      // simulate a bypassed write of a vulnerable exact version into the manifest
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodash: '4.17.19' } }),
      );
      const res = await runHook(evt('PostToolUse', dir, 'e2e-leak'));
      const ctx = (res.hookSpecificOutput ?? {}).additionalContext ?? '';
      expect(ctx).toContain('[Package Sentinel] 1 flagged dep(s) leaked');
      expect(ctx).toContain('lodash@4.17.19');
      expect(ctx).toContain('- rollback recommended');
      rmSync(dir, { recursive: true, force: true });
    },
  );

  maybe(
    'Firing Point 2 (pin): a range dep added behind the gate is rewritten to exact safe',
    async () => {
      const dir = fixture();
      await runHook(evt('PreToolUse', dir, 'e2e-pin', { tool_input: {} }));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodash: '^4.17.0' } }),
      );
      await runHook(evt('PostToolUse', dir, 'e2e-pin'));
      const after = readFileSync(join(dir, 'package.json'), 'utf8');
      // rewritten to an exact semver (newest non-blocked matching version)
      expect(/\d+\.\d+\.\d+/.test(after)).toBe(true);
      expect((after.match(/"lodash":\s*"([^"]+)"/) ?? [])[1] === '^4.17.0').toBe(false);
      expect(after).not.toContain('^4.17.0');
      rmSync(dir, { recursive: true, force: true });
    },
  );

  maybe(
    'Stop: an unsupported dependency manifest gets a loud not-vetted note (not silence)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ps-claude-e2e-'));
      writeFileSync(join(dir, 'Gemfile'), "source 'https://rubygems.org'\n");
      const res = await runHook(evt('Stop', dir, 'e2e-unsupported'));
      expect((res.hookSpecificOutput ?? {}).additionalContext ?? '').toContain(
        'dependencies NOT vetted',
      );
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
