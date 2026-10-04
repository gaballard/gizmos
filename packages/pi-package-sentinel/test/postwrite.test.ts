/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import type { PerVersionVerdict } from 'package-sentinel-core';
import {
  detectKindFromName,
  diffManifests,
  extractDeps,
  validatePostWrite,
} from 'package-sentinel-core';
import { expect } from './expect.ts';

const kind = detectKindFromName('package.json')!;

describe('extractDeps', () => {
  test('parses package.json dependencies', () => {
    const content = JSON.stringify({
      dependencies: { lodash: '^4.17.21', react: '^18.2.0' },
      devDependencies: { typescript: '^5.0.0' },
    });
    expect(extractDeps(content, kind)).toEqual({
      lodash: '^4.17.21',
      react: '^18.2.0',
      typescript: '^5.0.0',
    });
  });
});

describe('diffManifests', () => {
  const before = JSON.stringify({
    dependencies: { lodash: '^4.17.20', react: '^18.0.0' },
  });
  const after = JSON.stringify({
    dependencies: { lodash: '4.17.19', react: '^18.0.0' },
  });

  test('detects a newly added / changed dependency', () => {
    const d = diffManifests(before, after, kind);
    // lodash moved ^4.17.20 -> 4.17.19: treat as added (new target version)
    expect(d.added).toEqual({ lodash: '4.17.19' });
  });

  test('unchanged content yields no diff', () => {
    expect(diffManifests(before, before, kind)).toEqual({
      added: {},
      removed: {},
    });
  });
});

describe('validatePostWrite', () => {
  const flagged = (version: string): PerVersionVerdict => ({
    version,
    verdict: 'flagged',
    reason: 'vulnerable',
    advisories: [{ id: 'GHSA-abc', summary: 'x', severity: 'high', affectedVersions: [] }],
    isOsvChecked: true,
  });

  test('flags a newly added flagged version after a tool ran (AC-3)', () => {
    const before = JSON.stringify({ dependencies: { react: '^18.0.0' } });
    const after = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '4.17.19' },
    });
    const verdictOf = (name: string) => (name === 'lodash' ? flagged('4.17.19') : null);
    const leaks = validatePostWrite(
      [{ path: '/x/package.json', content: before }],
      [{ path: '/x/package.json', content: after }],
      verdictOf,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].version).toBe('4.17.19');
    expect(leaks[0].manifestPath).toBe('/x/package.json');
  });

  test('unchanged manifest is a no-op', () => {
    const c = JSON.stringify({ dependencies: { react: '^18.0.0' } });
    expect(
      validatePostWrite([{ path: '/x', content: c }], [{ path: '/x', content: c }], () =>
        flagged('1.0'),
      ),
    ).toEqual([]);
  });

  test('safe change is a no-op', () => {
    const before = JSON.stringify({ dependencies: { react: '^18.0.0' } });
    const after = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '4.17.21' },
    });
    expect(
      validatePostWrite(
        [{ path: '/x', content: before }],
        [{ path: '/x', content: after }],
        () => null,
      ),
    ).toEqual([]);
  });
});
