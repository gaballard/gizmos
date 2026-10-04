/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createVetter } from 'package-sentinel-core';
import { extractInstallTargets, runPostWrite } from '../shared.ts';
import { expect } from './expect.ts';

describe('extractInstallTargets (Claude Code PreToolUse gate)', () => {
  test('parses an npm add @-spec from a Bash command', () => {
    expect(extractInstallTargets({ command: 'npm add lodash@4.17.19' })).toContainEqual({
      name: 'lodash',
      version: '4.17.19',
    });
  });

  test('parses install --save @-spec from a Bash command', () => {
    expect(extractInstallTargets({ command: 'npm install --save lodash@4.17.19' })).toContainEqual({
      name: 'lodash',
      version: '4.17.19',
    });
  });

  test('parses a scoped name@version from a Bash command (regression: @types/* leak)', () => {
    expect(
      extractInstallTargets({
        command: 'npm install @types/node@24.13.6 --save-dev',
      }),
    ).toContainEqual({ name: '@types/node', version: '24.13.6' });
  });

  test('ignores flags and bare scoped names with no version', () => {
    expect(extractInstallTargets({ command: 'npm install @types/node --save-dev' })).toEqual([]);
  });

  test('parses structured args packages array', () => {
    expect(extractInstallTargets({ packages: ['lodash@4.17.19', 'debug@2.0.0'] })).toEqual([
      { name: 'lodash', version: '4.17.19' },
      { name: 'debug', version: '2.0.0' },
    ]);
  });

  test('does not extract targets from a non-install command', () => {
    expect(extractInstallTargets({ command: 'ls -la' })).toEqual([]);
  });

  test('returns [] for empty input', () => {
    expect(extractInstallTargets({})).toEqual([]);
  });

  test('parses an exact pinned dependency from Write to package.json; ignores ranges (post-write path)', () => {
    const input = {
      file_path: '/proj/package.json',
      content: '{"name":"x","dependencies":{"lodash":"^4.17.19","express":"4.18.0"}}',
    };
    const targets = extractInstallTargets(input);
    expect(targets).toContainEqual({ name: 'express', version: '4.18.0' });
    expect(targets).not.toContainEqual({
      name: 'lodash',
      version: '^4.17.19',
    });
  });

  test('ignores Write content to a non-manifest file', () => {
    expect(
      extractInstallTargets({
        file_path: '/proj/README.md',
        content: '# title\nsome prose',
      }),
    ).toEqual([]);
  });

  test('bare npm install (no targets) yields []', () => {
    expect(extractInstallTargets({ command: 'npm install' })).toEqual([]);
    expect(extractInstallTargets({ command: 'npm install --save --force' })).toEqual([]);
  });

  test('manifest edit is delta-aware: only ADDED exact deps become targets', () => {
    const before = '{"name":"x","dependencies":{"lodash":"4.17.19"}}';
    const input = {
      file_path: '/proj/package.json',
      content: '{"name":"x","dependencies":{"lodash":"4.17.19","express":"4.18.0"}}',
    };
    // lodash already present pre-edit -> not re-vetted; express is the addition.
    expect(extractInstallTargets(input, { '/proj/package.json': before })).toEqual([
      { name: 'express', version: '4.18.0' },
    ]);
  });

  test('non-additive manifest edit (no new exact dep) yields []', () => {
    const before = '{"name":"x","dependencies":{"express":"4.18.0"}}';
    // Bump to a range / no exact addition -> nothing to gate.
    const input = {
      file_path: '/proj/package.json',
      content: '{"name":"x","dependencies":{"express":"^4.18.0"}}',
    };
    expect(extractInstallTargets(input, { '/proj/package.json': before })).toEqual([]);
  });
});

describe('runPostWrite (no supported manifest -> loud not-vetted note)', () => {
  test('returns a note when an unsupported dependency manifest is present', async () => {
    const dir = join(tmpdir(), `ps-unsup-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'Gemfile'), 'source "https://rubygems.org"\ngem "rails"\n');
      const vetter = createVetter(dir);
      const { leaks, note } = await runPostWrite(vetter, dir, 't1');
      expect(vetter.manifest).toBeNull();
      expect(leaks).toEqual([]);
      expect(note!.toLowerCase()).toContain('not vetted');
      expect(note).toContain('Gemfile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no note for an empty directory (nothing to protect, nothing to warn)', async () => {
    const dir = join(tmpdir(), `ps-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const vetter = createVetter(dir);
      const { leaks, note } = await runPostWrite(vetter, dir, 't2');
      expect(note).toBeUndefined();
      expect(leaks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
