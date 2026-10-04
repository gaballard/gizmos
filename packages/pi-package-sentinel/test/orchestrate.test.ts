/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  ManifestSnapshot,
  OsvClient,
  PerVersionVerdict,
  RegistryAdapter,
  RegistryVersion,
} from 'package-sentinel-core';
import { auditManifest, createVetter, detectLeaks } from 'package-sentinel-core';
import { expect } from './expect.ts';

const adapter: RegistryAdapter = {
  listVersions: async () => [
    { version: '4.17.21', publishedAt: '2021-01-01T00:00:00Z' },
    { version: '4.18.0', publishedAt: '2025-01-10T00:00:00Z' },
  ],
};
const osvEmpty: OsvClient = { queryAdvisories: async () => [] };

const fixture = (pkg: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...pkg }));
  return dir;
};

describe('createVetter (fail-closed, injected collaborators)', () => {
  test('returns safe for a reasonable, non-vulnerable version', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const v = createVetter(dir, { adapter, osv: osvEmpty });
      const out = await v.vet('lodash', '4.18.0');
      expect(out?.verdict).toBe('safe');
      expect(out?.isOsvChecked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns unvalidated needs_review when the OSV check fails (fail-closed)', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const failing: OsvClient = {
        queryAdvisories: async () => {
          throw new Error('osv down');
        },
      };
      const v = createVetter(dir, { adapter, osv: failing });
      const out = await v.vet('lodash', '4.18.0');
      expect(out?.verdict).toBe('needs_review');
      expect(out?.isOsvChecked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('version not in registry is fail-closed (needs_review, unchecked) not null', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const v = createVetter(dir, { adapter, osv: osvEmpty });
      // adapter lists 4.17.21/4.18.0 only; 9.9.9 does not exist
      const out = await v.vet('lodash', '9.9.9');
      expect(out).not.toBeNull();
      expect(out?.verdict).toBe('needs_review');
      expect(out?.isOsvChecked).toBe(false);
      expect(out?.reason).toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recommendSafeVersion returns the newest installable version when it is safe', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const v = createVetter(dir, { adapter, osv: osvEmpty });
      expect(await v.recommendSafeVersion('lodash')).toEqual({
        version: '4.18.0',
        verdict: 'safe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recommendSafeVersion reaches past a wall of too-new releases (cooldown burst)', async () => {
    // 15 versions published inside the 7-day cooldown (daily-publish pattern),
    // then older safe ones. The scan must pre-filter the too-new candidates or
    // its 10-slot budget is exhausted before reaching a confirmable version.
    const now = Date.now();
    const burst: RegistryVersion[] = [];
    for (let k = 20; k >= 1; k--) {
      burst.push({
        version: '1.0.' + k,
        publishedAt: new Date(now - ((20 - k) * 0.45 + 0.5) * 86400000).toISOString(),
      });
    }
    const dir = fixture({ dependencies: {} });
    try {
      const v = createVetter(dir, {
        adapter: { listVersions: async () => burst },
        osv: osvEmpty,
      });
      expect(await v.recommendSafeVersion('pkg')).toEqual({
        version: '1.0.5',
        verdict: 'safe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recommendSafeVersion downgrades to an older installable version when the newest is flagged', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const flagNewest: OsvClient = {
        queryAdvisories: async (_p, version) =>
          version === '4.18.0'
            ? [
                {
                  id: 'GHSA-x',
                  summary: 'vuln',
                  severity: 'high',
                  affectedVersions: [],
                },
              ]
            : [],
      };
      const v = createVetter(dir, { adapter, osv: flagNewest });
      expect(await v.recommendSafeVersion('lodash')).toEqual({
        version: '4.17.21',
        verdict: 'needs_review',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recommendSafeVersion returns null when no version is safe (total block)', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const allFlagged: OsvClient = {
        queryAdvisories: async () => [
          {
            id: 'GHSA-x',
            summary: 'vuln',
            severity: 'high',
            affectedVersions: [],
          },
        ],
      };
      const v = createVetter(dir, { adapter, osv: allFlagged });
      expect(await v.recommendSafeVersion('lodash')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when no manifest is present (off-ecosystem)', async () => {
    const dir = fixture({ dependencies: {} });
    try {
      const vetter = createVetter(join(dir, 'does-not-exist'));
      expect(await vetter.vet('lodash', '4.17.21')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const before: ManifestSnapshot[] = [
  {
    path: '/x/package.json',
    content: JSON.stringify({ dependencies: { react: '^18' } }),
  },
];
const flagged: PerVersionVerdict = {
  version: '4.17.19',
  verdict: 'flagged',
  reason: 'vuln GHSA-abc',
  advisories: [],
  isOsvChecked: true,
};
const unchecked: PerVersionVerdict = {
  version: '4.18.0',
  verdict: 'needs_review',
  reason: 'lookup failed: net down',
  advisories: [],
  isOsvChecked: false,
};

describe('detectLeaks (post-write, fail-closed)', () => {
  test('surfaces a flagged added dependency', async () => {
    const after = [
      {
        path: '/x/package.json',
        content: JSON.stringify({
          dependencies: { react: '^18', lodash: '4.17.19' },
        }),
      },
    ];
    const leaks = await detectLeaks(before, after, async () => flagged);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].version).toBe('4.17.19');
    expect(leaks[0].manifestPath).toBe('/x/package.json');
  });

  test('surfaces an unvalidated (osv-unchecked) added dependency under PACKAGE_SENTINEL_FAIL_CLOSED', async () => {
    const after = [
      {
        path: '/x/package.json',
        content: JSON.stringify({
          dependencies: { react: '^18', lodash: '4.18.0' },
        }),
      },
    ];
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      const leaks = await detectLeaks(before, after, async () => unchecked);
      expect(leaks).toHaveLength(1);
      expect(leaks[0].version).toBe('4.18.0');
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
  });

  test('does NOT surface an unvalidated added dependency by default (fail-open)', async () => {
    const after = [
      {
        path: '/x/package.json',
        content: JSON.stringify({
          dependencies: { react: '^18', lodash: '4.18.0' },
        }),
      },
    ];
    const leaks = await detectLeaks(before, after, async () => unchecked);
    expect(leaks).toEqual([]);
  });

  test('no leak for a safe add', async () => {
    const after = [
      {
        path: '/x/package.json',
        content: JSON.stringify({
          dependencies: { react: '^18', lodash: '4.17.21' },
        }),
      },
    ];
    const safe: PerVersionVerdict = {
      ...flagged,
      verdict: 'safe',
      version: '4.17.21',
      reason: 'ok',
      advisories: [],
    };
    expect(await detectLeaks(before, after, async () => safe)).toEqual([]);
  });
});

describe('auditManifest (full-manifest scan)', () => {
  const vulnerable: OsvClient = {
    queryAdvisories: async (_pkg, version) =>
      version === '4.17.21'
        ? [{ id: 'GHSA-bad', summary: 'vuln', severity: 'high', affectedVersions: [] }]
        : [],
  };

  test('flags a vulnerable exact dep, passes safe, marks unknown unconfirmed (fail-open)', async () => {
    const dir = fixture({
      dependencies: {
        lodash: '4.18.0',
        bad: '4.17.21',
        missing: '9.9.9',
        rangy: '^4.18.0',
      },
    });
    try {
      const v = createVetter(dir, { adapter, osv: vulnerable });
      const entries = await auditManifest(v);
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
      expect(byName['lodash']).toMatchObject({ verdict: 'safe', blocked: false });
      expect(byName['bad']).toMatchObject({
        verdict: 'flagged',
        blocked: true,
        version: '4.17.21',
      });
      expect(byName['missing']).toMatchObject({ unconfirmed: true, blocked: false });
      expect(byName['rangy']).toMatchObject({
        version: '4.18.0',
        verdict: 'safe',
        spec: '^4.18.0',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks an unconfirmed dep blocked under PACKAGE_SENTINEL_FAIL_CLOSED', async () => {
    const dir = fixture({ dependencies: { missing: '9.9.9' } });
    try {
      const v = createVetter(dir, { adapter, osv: osvEmpty });
      process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
      try {
        const [entry] = await auditManifest(v);
        expect(entry?.unconfirmed).toBe(true);
        expect(entry?.blocked).toBe(true);
      } finally {
        delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
