/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from 'node:test';
import type { PerVersionVerdict } from 'package-sentinel-core';
import {
  assertInstallable,
  FlaggedVersionError,
  guardToolCall,
  isBlocked,
  isUnconfirmedPass,
  makeAssertTool,
} from 'package-sentinel-core';
import { expect } from './expect.ts';

const verdict = (version: string, label: PerVersionVerdict['verdict']): PerVersionVerdict => {
  return {
    version,
    verdict: label,
    reason: label === 'flagged' ? 'vulnerable advisory GHSA-abc' : 'ok',
    advisories:
      label === 'flagged'
        ? [
            {
              id: 'GHSA-abc',
              summary: 'x',
              severity: 'high',
              affectedVersions: [],
            },
          ]
        : [],
    isOsvChecked: true,
  };
};

describe('assertInstallable', () => {
  test('throws FlaggedVersionError for a flagged version (AC-3)', () => {
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    const flagged = verdict('4.17.19', 'flagged');
    expect(() => assertInstallable(ref, flagged)).toThrow(FlaggedVersionError);
  });

  test('does not throw for safe or needs_review versions', () => {
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    expect(() => assertInstallable(ref, verdict('4.17.21', 'safe'))).not.toThrow();
    expect(() => assertInstallable(ref, verdict('4.18.0', 'needs_review'))).not.toThrow();
  });
});

describe('guardToolCall', () => {
  test('returns { block: true, reason } when a tool targets a flagged version', () => {
    const verdictOf = (name: string, version: string) =>
      name === 'lodash' ? verdict(version, 'flagged') : null;
    const out = guardToolCall(
      { tool: 'npm_add', args: { packages: ['lodash@4.17.19'] } },
      verdictOf,
    );
    expect(out.block).toBe(true);
    if (out.block) {
      expect(out.reason).toBeDefined();
    }
  });

  test('does not block safe or needs_review targets', () => {
    const verdictOf = (name: string, version: string) =>
      name === 'lodash' && version === '4.17.19'
        ? verdict(version, 'flagged')
        : verdict(version, 'safe');
    expect(
      guardToolCall({ tool: 'npm_add', args: { packages: ['lodash@4.17.21'] } }, verdictOf).block,
    ).toBe(false);
  });

  test('does not block when no target resolves to a verdict', () => {
    expect(guardToolCall({ tool: 'ls', args: { packages: [] } }, () => null).block).toBe(false);
  });
});

describe('makeAssertTool', () => {
  test('returns a blocking result object for flagged', () => {
    const tool = makeAssertTool(verdictOf);
    const res = tool({ packages: ['lodash@4.17.19'] });
    expect(res.blocked).toBe(true);
  });
});

const verdictOf = (_name: string, version: string) => {
  return version === '4.17.19' ? verdict(version, 'flagged') : verdict(version, 'safe');
};

describe('OSV-miss gate: fail-open by default, fail-closed under toggle', () => {
  const unchecked = (version: string): PerVersionVerdict => ({
    version,
    verdict: 'needs_review',
    reason: 'lookup failed: net down',
    advisories: [],
    isOsvChecked: false,
  });

  test('fail-open (default): an OSV-unconfirmed version is NOT blocked', () => {
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    expect(() => assertInstallable(ref, unchecked('4.18.0'))).not.toThrow();
    const out = guardToolCall(
      { tool: 'npm_add', args: { packages: ['lodash@4.18.0'] } },
      (_name, v) => unchecked(v),
    );
    expect(out.block).toBe(false);
  });

  test('PACKAGE_SENTINEL_FAIL_CLOSED=1 restores fail-closed (deny unconfirmed)', () => {
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      const ref = { name: 'lodash', ecosystem: 'npm' as const };
      expect(() => assertInstallable(ref, unchecked('4.18.0'))).toThrow(FlaggedVersionError);
      const out = guardToolCall(
        { tool: 'npm_add', args: { packages: ['lodash@4.18.0'] } },
        (_name, v) => unchecked(v),
      );
      expect(out.block).toBe(true);
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
  });

  test('flagged blocks in BOTH modes', () => {
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    expect(() => assertInstallable(ref, verdict('4.17.19', 'flagged'))).toThrow(
      FlaggedVersionError,
    );
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      expect(() => assertInstallable(ref, verdict('4.17.19', 'flagged'))).toThrow(
        FlaggedVersionError,
      );
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
  });

  test('a CHECKED needs_review without the tooNew flag (e.g. stale) is NOT blocked in either mode', () => {
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    expect(() => assertInstallable(ref, verdict('4.18.0', 'needs_review'))).not.toThrow();
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      expect(() => assertInstallable(ref, verdict('4.18.0', 'needs_review'))).not.toThrow();
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
  });

  test('a too-new version blocks in BOTH modes (supply-chain cooldown)', () => {
    const tooNew: PerVersionVerdict = {
      ...verdict('4.18.0', 'needs_review'),
      reason: 'published 2d ago; too new',
      tooNew: true,
    };
    const ref = { name: 'lodash', ecosystem: 'npm' as const };
    expect(isBlocked(tooNew)).toBe(true);
    expect(() => assertInstallable(ref, tooNew)).toThrow(FlaggedVersionError);
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      expect(() => assertInstallable(ref, tooNew)).toThrow(FlaggedVersionError);
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
  });

  test('isUnconfirmedPass reflects fail-open (true) vs fail-closed (false)', () => {
    expect(isUnconfirmedPass(unchecked('4.18.0'))).toBe(true);
    process.env.PACKAGE_SENTINEL_FAIL_CLOSED = '1';
    try {
      expect(isUnconfirmedPass(unchecked('4.18.0'))).toBe(false);
    } finally {
      delete process.env.PACKAGE_SENTINEL_FAIL_CLOSED;
    }
    expect(isUnconfirmedPass(verdict('4.18.0', 'safe'))).toBe(false);
    expect(isUnconfirmedPass(verdict('4.17.19', 'flagged'))).toBe(false);
  });
});
