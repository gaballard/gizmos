/**
 * Transport core - chatComplete hardened transport contract tests.
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatComplete } from '../index.ts';

const fetchCalls: Array<{ input: unknown; init: unknown }> = [];

const withFetch = (fn: () => Promise<unknown>, respond: (url: string, init: any) => Response) => {
  fetchCalls.length = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: unknown, init: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      fetchCalls.push({ input, init });
      return respond(url, init);
    }) as typeof fetch;
    return fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

const okJson = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('post to baseURL + /chat/completions, returns content', async () => {
  await withFetch(
    () =>
      chatComplete({
        baseURL: 'https://example.com/v1/',
        model: 'm',
        system: 's',
        user: 'u',
      }),
    (url) => {
      assert.match(url, /https:\/\/example\.com\/v1\/chat\/completions$/);
      return okJson('answer');
    },
  );
  assert.equal((await lastBody()).model, 'm');
});

const lastBody = async (): Promise<any> => {
  const init: any = (fetchCalls.at(-1) as any)?.init;
  return JSON.parse(init.body);
};

test('apiKey adds an Authorization Bearer header; absent apiKey adds none', async () => {
  await withFetch(
    () =>
      chatComplete({
        baseURL: 'https://example.com',
        model: 'm',
        system: 's',
        user: 'u',
        apiKey: 'k_secret_123',
      }),
    () => okJson('ok'),
  );
  const b = (await lastBody()) as never;
  const initA: any = (fetchCalls.at(-1) as any)?.init;
  assert.equal(initA.headers['Authorization'], 'Bearer k_secret_123');

  fetchCalls.length = 0;
  await withFetch(
    () => chatComplete({ baseURL: 'https://example.com', model: 'm', system: 's', user: 'u' }),
    () => okJson('ok'),
  );
  const initB: any = (fetchCalls.at(-1) as any)?.init;
  assert.equal(initB.headers['Authorization'], undefined);
  void b;
});

test('responseFormat is passed through verbatim; absent means the field is omitted', async () => {
  await withFetch(
    () =>
      chatComplete({
        baseURL: 'https://example.com',
        model: 'm',
        system: 's',
        user: 'u',
        responseFormat: { type: 'json_schema' },
      }),
    () => okJson('ok'),
  );
  assert.deepEqual((await lastBody()).response_format, { type: 'json_schema' });
  await withFetch(
    () => chatComplete({ baseURL: 'https://example.com', model: 'm', system: 's', user: 'u' }),
    () => okJson('ok'),
  );
  assert.equal((await lastBody()).response_format, undefined);
});

test('HTTP error message never echoes the apiKey', async () => {
  await withFetch(
    async () => {
      let msg = '';
      try {
        await chatComplete({
          baseURL: 'https://example.com',
          model: 'm',
          system: 's',
          user: 'u',
          apiKey: 'k_secret_123',
        });
      } catch (err) {
        msg = String((err as Error).message);
      }
      assert.ok(msg.length > 0, 'expected an error');
      assert.ok(!msg.includes('k_secret_123'), `key leaked: ${msg}`);
    },
    () => new Response('bad', { status: 500 }),
  );
});

test('invalid baseURL throws before any fetch', async () => {
  await withFetch(
    async () => {
      let msg = '';
      try {
        await chatComplete({
          baseURL: 'http://example.com',
          model: 'm',
          system: 's',
          user: 'u',
        });
      } catch (err) {
        msg = (err as Error).message;
      }
      assert.match(msg, /refused baseURL/i);
    },
    () => okJson('ok'),
  );
  assert.equal(fetchCalls.length, 0, 'fetch must not be reached for a rejected URL');
});
