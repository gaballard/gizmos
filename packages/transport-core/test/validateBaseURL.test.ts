/**
 * Transport core - validateBaseURL/isLoopbackHost contract tests.
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, validateBaseURL } from '../index.ts';

test('loopback hosts', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost.'), true, 'trailing dot normalized');
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('sub.localhost.com'), false);
  assert.equal(isLoopbackHost(''), false);
});

test('https endpoints are accepted', () => {
  assert.equal(validateBaseURL('https://example.com/v1').ok, true);
});

test('cleartext http is rejected for non-loopback hosts, before any fetch', () => {
  const r = validateBaseURL('http://example.com');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /https|loopback/i);
});

test('cleartext http is allowed on loopback (default llamacpp must keep working)', () => {
  assert.equal(validateBaseURL('http://127.0.0.1:11666').ok, true);
  assert.equal(validateBaseURL('http://localhost:1234/v1').ok, true);
  assert.equal(validateBaseURL('http://[::1]:11666').ok, true);
});

test('non-http(s) schemes are rejected for any host', () => {
  for (const raw of ['ws://example.com', 'ftp://example.com', 'file:///etc/passwd']) {
    assert.equal(validateBaseURL(raw).ok, false, raw);
  }
});

test('URL userinfo (embedded credentials) is rejected', () => {
  const r = validateBaseURL('https://user:pass@example.com');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /user|credential|userinfo/i);
});

test('control characters and whitespace in the URL are rejected (WHATWG strips them)', () => {
  assert.equal(validateBaseURL('https://exa mple.com').ok, false);
  assert.equal(validateBaseURL('https://exp\tample.com').ok, false);
  assert.equal(validateBaseURL('https://exp\nample.com').ok, false);
});

test('unparseable URLs are rejected', () => {
  assert.equal(validateBaseURL('not a url').ok, false);
  assert.equal(validateBaseURL('').ok, false);
});
