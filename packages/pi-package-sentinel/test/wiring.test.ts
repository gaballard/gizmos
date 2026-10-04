/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { targetsFromTool } from '../src/index.ts';
import { expect } from './expect.ts';

describe('targetsFromTool (wiring target extraction)', () => {
  test('parses an npm add @-spec from a bash command', () => {
    expect(targetsFromTool({ command: 'npm add lodash@4.17.19' })).toEqual([
      { name: 'lodash', version: '4.17.19' },
    ]);
  });

  test('parses install --save @-spec from a bash command', () => {
    expect(targetsFromTool({ command: 'npm install --save lodash@4.17.19' })).toEqual([
      { name: 'lodash', version: '4.17.19' },
    ]);
  });

  test('parses structured args packages array', () => {
    expect(targetsFromTool({ packages: ['lodash@4.17.19', 'debug@2.0.0'] })).toEqual([
      { name: 'lodash', version: '4.17.19' },
      { name: 'debug', version: '2.0.0' },
    ]);
  });

  test('does not extract targets from a non-install command', () => {
    expect(targetsFromTool({ command: 'ls -la' })).toEqual([]);
  });

  test('returns [] for empty input', () => {
    expect(targetsFromTool({})).toEqual([]);
  });

  test('does not gate-extract pip == specs from a bash command (post-write catches these)', () => {
    expect(targetsFromTool({ command: 'pip install requests==2.28.2' })).toEqual([]);
  });

  test('parses a scoped name@version (regression: @types/* leak)', () => {
    expect(targetsFromTool({ command: 'npm install @types/node@24.13.6 --save-dev' })).toEqual([
      { name: '@types/node', version: '24.13.6' },
    ]);
  });

  test('ignores flags and bare scoped names with no version', () => {
    expect(targetsFromTool({ command: 'npm install @types/node --save-dev' })).toEqual([]);
  });
});
