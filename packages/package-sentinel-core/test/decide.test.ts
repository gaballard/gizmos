/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { expect } from './expect.ts';
import type { Advisory, PerVersionVerdict } from '../src/contracts.ts';
import { decideVersion } from '../src/decide.ts';

const NOW = new Date('2026-01-15T00:00:00Z');

const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const advisory: Advisory = {
  id: 'GHSA-abc',
  summary: 'prototype pollution',
  severity: 'high',
  affectedVersions: ['<4.17.20'],
};

const run = (opts: {
  versions: { version: string; publishedAt: string }[];
  advisoriesFor: Record<string, Advisory[]>;
  checkedVersions?: string[];
  now?: Date;
}): PerVersionVerdict[] => {
  const checked = new Set(opts.checkedVersions ?? opts.versions.map((v) => v.version));
  return decideVersion(
    { name: 'lodash', ecosystem: 'npm' },
    opts.versions,
    (v) => opts.advisoriesFor[v] ?? [],
    (v) => checked.has(v),
    opts.now ?? NOW,
  );
};

const byVersion = (vs: PerVersionVerdict[]) =>
  Object.fromEntries(vs.map((v) => [v.version, v.verdict]));

describe('decideVersion', () => {
  test('version with an advisory is flagged', () => {
    const out = run({
      versions: [{ version: '4.17.19', publishedAt: day(500) }],
      advisoriesFor: { '4.17.19': [advisory] },
    });
    expect(byVersion(out)['4.17.19']).toBe('flagged');
    expect(out[0].advisories).toEqual([advisory]);
    expect(out[0].isOsvChecked).toBe(true);
  });

  test('version with no advisory and reasonable recency is safe', () => {
    const out = run({
      versions: [{ version: '4.17.21', publishedAt: day(100) }],
      advisoriesFor: {},
    });
    expect(byVersion(out)['4.17.21']).toBe('safe');
    expect(out[0].isOsvChecked).toBe(true);
    expect(out[0].tooNew).toBe(false);
  });

  test('too-new version without advisory is needs_review and flagged tooNew=true', () => {
    const out = run({
      versions: [{ version: '4.18.0', publishedAt: day(2) }],
      advisoriesFor: {},
    });
    expect(byVersion(out)['4.18.0']).toBe('needs_review');
    expect(out[0].tooNew).toBe(true);
  });

  test('stale version (not latest, old publish) is needs_review', () => {
    const out = run({
      versions: [
        { version: '4.17.21', publishedAt: day(100) },
        { version: '4.0.0', publishedAt: day(800) },
      ],
      advisoriesFor: {},
    });
    expect(byVersion(out)['4.0.0']).toBe('needs_review');
    expect(byVersion(out)['4.17.21']).toBe('safe');
  });

  test('version with no OSV check performed is NEVER safe (NFR-1 / AC-5)', () => {
    const out = run({
      versions: [{ version: '4.17.21', publishedAt: day(100) }],
      advisoriesFor: {},
      checkedVersions: [],
    });
    expect(byVersion(out)['4.17.21']).not.toBe('safe');
  });
});
