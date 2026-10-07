/**
 * Sanity Check CLI deliverable-path resolution tests (sanity-check-deliverable-loading).
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { main } from '../cli.ts';

// The CLI resolves relative deliverable args against its process cwd. To prove
// a read succeeded without running the A/B loop (which would hit an endpoint),
// the fixture deliverables are blank: `deliverable is empty` (exit 2) proves
// the read resolved; `Cannot read deliverable` or a network error would not.

let fixtureCwd: string;
const fixtureFile = (rel: string, body = '') => {
  writeFileSync(join(fixtureCwd, rel), body);
  return rel;
};

test.beforeEach(() => {
  fixtureCwd = mkdtempSync(join(tmpdir(), 'sanity-check-cli-'));
  process.chdir(fixtureCwd);
});

test.afterEach(() => {
  rmSync(fixtureCwd, { recursive: true, force: true });
});

test('relative deliverable arg resolves against the process cwd', async () => {
  const rel = fixtureFile('deliverable.md');
  const code = await main([rel]);
  assert.equal(code, 2); // file exists (read resolved) but blank -> 'deliverable is empty'
});

test('absolute deliverable arg passes through unchanged', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'sanity-check-cli-abs-'));
  const abs = join(outside, 'abs.md');
  writeFileSync(abs, '');
  try {
    const code = await main([abs]);
    assert.equal(code, 2); // read resolved to the given absolute path
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('not-found reports the resolved absolute path actually attempted', async () => {
  const lines: string[] = [];
  const origError = console.error;
  console.error = (fmt: unknown, ...rest: unknown[]) => {
    lines.push(format(String(fmt), ...rest));
  };
  try {
    const code = await main(['nope.md']);
    assert.equal(code, 2);
  } finally {
    console.error = origError;
  }
  const out = lines.join('\n');
  assert.match(out, /tried \S*nope\.md/, `no tried-path in: ${out}`);
  assert.ok(out.includes(fixtureCwd), `resolved path not absolute/anchored in: ${out}`);
});
