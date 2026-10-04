/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { expect } from './expect.ts';
import { CratesAdapter, createAdapter, NpmAdapter, PypiAdapter } from '../src/registry.ts';

const npmBody = {
  name: 'lodash',
  versions: {
    '4.17.20': { name: 'lodash', version: '4.17.20' },
    '4.17.21': { name: 'lodash', version: '4.17.21' },
  },
  time: {
    '4.17.20': '2020-08-30T21:37:02.000Z',
    '4.17.21': '2021-02-20T20:00:11.460Z',
  },
};

const pypiBody = {
  releases: {
    '2.0': [{ upload_time: '2017-01-01T12:00:00Z', version: '2.0' }],
    '2.1': [{ upload_time: '2018-06-01T12:00:00Z', version: '2.1' }],
  },
};

const cratesBody = {
  versions: [
    { num: '1.0.0', created_at: '2017-03-15T00:00:00Z' },
    { num: '1.1.0', created_at: '2019-11-02T00:00:00Z' },
  ],
};

describe('NpmAdapter', () => {
  test('parses registry response into RegistryVersion[] with timestamps', () => {
    const out = new NpmAdapter().parseResponse(npmBody);
    expect(out).toEqual([
      { version: '4.17.20', publishedAt: '2020-08-30T21:37:02.000Z' },
      { version: '4.17.21', publishedAt: '2021-02-20T20:00:11.460Z' },
    ]);
  });

  test('handles missing time entries gracefully', () => {
    const out = new NpmAdapter().parseResponse({
      name: 'x',
      versions: { '1.0.0': { version: '1.0.0' } },
      time: {},
    });
    expect(out).toEqual([{ version: '1.0.0', publishedAt: '' }]);
  });
});

describe('PypiAdapter', () => {
  test('parses releases into RegistryVersion[]', () => {
    const out = new PypiAdapter().parseResponse(pypiBody);
    expect(out).toEqual([
      { version: '2.0', publishedAt: '2017-01-01T12:00:00Z' },
      { version: '2.1', publishedAt: '2018-06-01T12:00:00Z' },
    ]);
  });

  test('empty releases yields empty list', () => {
    expect(new PypiAdapter().parseResponse({ releases: {} })).toEqual([]);
  });
});

describe('CratesAdapter', () => {
  test('parses versions array into RegistryVersion[]', () => {
    const out = new CratesAdapter().parseResponse(cratesBody);
    expect(out).toEqual([
      { version: '1.0.0', publishedAt: '2017-03-15T00:00:00Z' },
      { version: '1.1.0', publishedAt: '2019-11-02T00:00:00Z' },
    ]);
  });
});

describe('createAdapter', () => {
  test('selects adapter by ecosystem', () => {
    expect(createAdapter('npm')).toBeInstanceOf(NpmAdapter);
    expect(createAdapter('pypi')).toBeInstanceOf(PypiAdapter);
    expect(createAdapter('rust')).toBeInstanceOf(CratesAdapter);
  });
});
