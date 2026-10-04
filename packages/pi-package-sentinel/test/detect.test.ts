/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { detectKindFromName, detectManifest } from 'package-sentinel-core';
import { expect } from './expect.ts';

describe('detectKindFromName', () => {
  test('maps each supported manifest to its ecosystem', () => {
    expect(detectKindFromName('package.json')).toMatchObject({
      ecosystem: 'npm',
    });
    expect(detectKindFromName('pyproject.toml')).toMatchObject({
      ecosystem: 'pypi',
    });
    expect(detectKindFromName('requirements.txt')).toMatchObject({
      ecosystem: 'pypi',
    });
    expect(detectKindFromName('Pipfile')).toMatchObject({ ecosystem: 'pypi' });
    expect(detectKindFromName('Cargo.toml')).toMatchObject({
      ecosystem: 'rust',
    });
  });

  test('returns null for unsupported manifests', () => {
    expect(detectKindFromName('Gemfile')).toBeNull();
    expect(detectKindFromName('go.mod')).toBeNull();
    expect(detectKindFromName('yarn.lock')).toBeNull();
    expect(detectKindFromName('no-extension')).toBeNull();
  });
});

describe('detectManifest', () => {
  test('detects package.json as npm', () => {
    const d = detectManifest('/repo/app/package.json');
    expect(d).not.toBeNull();
    expect(d?.ecosystem).toBe('npm');
    expect(d?.path).toBe('/repo/app/package.json');
  });

  test('detects pyproject.toml / requirements.txt / Pipfile as pypi', () => {
    for (const file of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
      expect(detectManifest(`/repo/${file}`)?.ecosystem).toBe('pypi');
    }
  });

  test('detects Cargo.toml as rust', () => {
    expect(detectManifest('/repo/Cargo.toml')?.ecosystem).toBe('rust');
  });

  test('returns null for an unsupported or missing manifest', () => {
    expect(detectManifest('/repo/Gemfile')).toBeNull();
    expect(detectManifest('/repo/package-lock.json')).toBeNull();
  });
});
