/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { expect } from './expect.ts';
import type { ManifestSnapshot, RegistryVersion } from '../src/contracts.ts';
import { detectKindFromName } from '../src/detect.ts';
import { applyPins, isRangeSpec, pickExactPin, pinManifestChanges } from '../src/pin.ts';

const kind = detectKindFromName('package.json')!;
const requirements = detectKindFromName('requirements.txt')!;
const cargo = detectKindFromName('Cargo.toml')!;
const versions = (list: string[]): RegistryVersion[] =>
  list.map((version) => ({ version, publishedAt: '' }));

const safe = (version: string, verdict = 'safe') =>
  ({
    version,
    verdict,
    reason: 'x',
    advisories: [],
    isOsvChecked: true,
  }) as any;

describe('isRangeSpec', () => {
  test('exact versions are not ranges', () => {
    expect(isRangeSpec('1.2.3')).toBe(false);
    expect(isRangeSpec('1.2.0')).toBe(false);
    expect(isRangeSpec('10.11.12')).toBe(false);
  });
  test('range specs are ranges', () => {
    expect(isRangeSpec('^1.9.0')).toBe(true);
    expect(isRangeSpec('~1.1.0')).toBe(true);
    expect(isRangeSpec('>=1.0.0 <2.0.0')).toBe(true);
    expect(isRangeSpec('*')).toBe(true);
  });
});

describe('pickExactPin', () => {
  test('returns null for an already-exact spec', async () => {
    expect(await pickExactPin('1.9.0', versions(['1.9.0']), async () => false)).toBeNull();
  });

  test('picks the newest matching, non-blocked version', async () => {
    const v = versions(['1.9.0', '1.10.0', '2.0.0']);
    const blocked = (x: string) => x === '1.10.0' || x === '2.0.0';
    expect(await pickExactPin('^1.9.0', v, blocked)).toBe('1.9.0');
  });

  test('returns null when every match is blocked', async () => {
    expect(
      await pickExactPin('^1.9.0', versions(['1.9.0', '1.10.0']), async () => true),
    ).toBeNull();
  });

  test('returns null when nothing matches the range', async () => {
    expect(
      await pickExactPin('^3.0.0', versions(['1.9.0', '2.0.0']), async () => false),
    ).toBeNull();
  });
});

describe('applyPins', () => {
  test('rewrites a range to the pinned exact version in package.json', () => {
    const out = applyPins(JSON.stringify({ dependencies: { semver: '^1.9.0' } }), kind, {
      semver: '1.9.0',
    });
    expect(JSON.parse(out).dependencies.semver).toBe('1.9.0');
  });
  test('handles devDependencies', () => {
    const out = applyPins(JSON.stringify({ devDependencies: { semver: '^1.9.0' } }), kind, {
      semver: '1.9.0',
    });
    expect(JSON.parse(out).devDependencies.semver).toBe('1.9.0');
  });
  test('rewrites a requirements.txt range line to name==<pin>', () => {
    expect(
      applyPins('requests>=2.28\nurllib3==1.24', requirements, {
        requests: '2.31.0',
      }),
    ).toBe('requests==2.31.0\nurllib3==1.24');
  });

  test('rewrites TOML dep lines to the pinned exact version', () => {
    expect(applyPins('serde = "^1.0"\n', cargo, { serde: '1.0.219' })).toBe('serde = "1.0.219"\n');
    expect(applyPins('serde = { version = "^1.0" }\n', cargo, { serde: '1.0.219' })).toBe(
      'serde = { version = "1.0.219" }\n',
    );
  });
  test('leaves invalid JSON unchanged', () => {
    expect(applyPins('{ not json', kind, { semver: '1.9.0' })).toBe('{ not json');
  });
});

describe('pinManifestChanges', () => {
  const before: ManifestSnapshot[] = [
    { path: '/x/package.json', content: JSON.stringify({ dependencies: {} }) },
  ];

  test('pins a newly-added range dep to the newest safe matching version', async () => {
    const after: ManifestSnapshot[] = [
      {
        path: '/x/package.json',
        content: JSON.stringify({ dependencies: { semver: '^1.9.0' } }),
      },
    ];
    const versionsFor = async () => versions(['1.9.0', '1.10.0', '2.0.0']);
    const vet = async (_name: string, v: string) =>
      v === '1.9.0' ? safe(v) : v === '1.10.0' ? safe(v, 'flagged') : safe(v, 'flagged');
    const [pinned] = await pinManifestChanges(before, after, versionsFor, vet);
    expect(JSON.parse(pinned.content).dependencies.semver).toBe('1.9.0');
  });

  test('leaves an exact dep untouched', async () => {
    const after: ManifestSnapshot[] = [
      {
        path: '/x/package.json',
        content: JSON.stringify({ dependencies: { semver: '1.9.0' } }),
      },
    ];
    const [pinned] = await pinManifestChanges(
      before,
      after,
      async () => [],
      async () => safe('1.9.0'),
    );
    expect(pinned.content).toBe(after[0].content);
  });

  test('leaves a manifest unchanged when no safe version resolves', async () => {
    const after: ManifestSnapshot[] = [{ path: '/x/requirements.txt', content: 'semver==^1.9.0' }];
    const [pinned] = await pinManifestChanges(
      before,
      after,
      async () => [],
      async () => safe('1.9.0'),
    );
    expect(pinned.content).toBe(after[0].content);
  });

  test('pins a newly-added range dep in a requirements.txt', async () => {
    const after: ManifestSnapshot[] = [
      { path: '/x/requirements.txt', content: 'requests>=2.28\n' },
    ];
    const versionsFor = async () => versions(['2.28.2', '2.31.0']);
    const vet = async (_n: string, v: string) =>
      v === '2.31.0' || v === '2.28.2' ? safe(v) : safe(v, 'flagged');
    const [pinned] = await pinManifestChanges(before, after, versionsFor, vet);
    expect(pinned.content).toBe('requests==2.31.0\n');
  });

  test('pins a newly-added range dep in a Cargo.toml', async () => {
    const after: ManifestSnapshot[] = [
      { path: '/x/Cargo.toml', content: '[dependencies]\nserde = "^1.0"\n' },
    ];
    const versionsFor = async () => versions(['1.0.219', '1.0.1']);
    const vet = async (_n: string, v: string) => (v === '1.0.219' ? safe(v) : safe(v, 'flagged'));
    const [pinned] = await pinManifestChanges(before, after, versionsFor, vet);
    expect(pinned.content).toBe('[dependencies]\nserde = "1.0.219"\n');
  });
});
