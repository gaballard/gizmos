/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import { createOsvClient, OsvTransportError, parseOsvResponse } from 'package-sentinel-core';
import { expect } from './expect.ts';

const osvBody = {
  vulns: [
    {
      id: 'GHSA-xxx-1234',
      summary: 'Prototype pollution in lodash',
      severity: 'HIGH',
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [{ introduced: '0' }, { fixed: '4.17.20' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('parseOsvResponse', () => {
  test('maps OSV vulns to Advisory[]', () => {
    const out = parseOsvResponse(osvBody);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('GHSA-xxx-1234');
    expect(out[0].summary).toContain('Prototype pollution');
    expect(out[0].severity).toBe('high');
  });

  test('empty/missing vulns yields empty list', () => {
    expect(parseOsvResponse({})).toEqual([]);
    expect(parseOsvResponse({ vulns: [] })).toEqual([]);
  });

  test('unknown severity maps to unknown', () => {
    const out = parseOsvResponse({
      vulns: [{ id: 'X', severity: 'nope', affected: [] }],
    });
    expect(out[0].severity).toBe('unknown');
  });
});

describe('createOsvClient', () => {
  test('returns advisories from a successful fetch', async () => {
    const client = createOsvClient(async () => {
      return { ok: true, json: async () => osvBody } as Response;
    });
    const out = await client.queryAdvisories({ name: 'lodash', ecosystem: 'npm' }, '4.17.19');
    expect(out).toHaveLength(1);
  });

  test('query returns empty when the HTTP call is ok but has no vulns', async () => {
    const client = createOsvClient(async () => {
      return { ok: true, json: async () => ({ vulns: [] }) } as Response;
    });
    expect(await client.queryAdvisories({ name: 'none', ecosystem: 'npm' }, '1.0.0')).toEqual([]);
  });

  test("transport failure surfaces as a distinct OsvTransportError (never 'no advisories')", async () => {
    const client = createOsvClient(async () => {
      throw new Error('net down');
    });
    await expect(
      client.queryAdvisories({ name: 'x', ecosystem: 'npm' }, '1.0.0'),
    ).rejects.toBeInstanceOf(OsvTransportError);
  });

  test('sends the version in the OSV query body (version-level lookup)', async () => {
    let sent = '';
    const client = createOsvClient(async (_url, init) => {
      sent = typeof init?.body === 'string' ? init.body : '';
      return { ok: true, json: async () => ({ vulns: [] }) } as Response;
    });
    await client.queryAdvisories({ name: 'semver', ecosystem: 'npm' }, '1.9.0');
    expect(JSON.parse(sent)).toMatchObject({
      package: { name: 'semver', ecosystem: 'npm' },
      version: '1.9.0',
    });
  });
});
