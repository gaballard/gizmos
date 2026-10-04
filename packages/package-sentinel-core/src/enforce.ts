/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FlaggedVersionError,
  type BlockDecision,
  type PackageRef,
  type PerVersionVerdict,
} from './contracts.ts';

/** Type for a resolver mapping a target name@version to its verdict. */
export type VerdictResolver = (name: string, version: string) => PerVersionVerdict | null;

/**
 * Fail-open / fail-closed knob for the gate. Default (env unset) is FAIL OPEN:
 * only a version flagged with a known OSV advisory blocks. Set
 * `PACKAGE_SENTINEL_FAIL_CLOSED=1` (any truthy value: "1", "true", "on") to
 * additionally deny any install OSV could not positively confirm
 * (`isOsvChecked === false`, i.e. not listed / unchecked) - the prior strict
 * behavior.
 */
export const osvFailClosed = (): boolean => {
  const v = String(process.env.PACKAGE_SENTINEL_FAIL_CLOSED ?? '').toLowerCase();
  return v !== '' && !['0', 'false', 'no', 'off'].includes(v);
};

/** Gate predicate. `flagged` (known-vulnerable) and `tooNew` (published within
 *  the supply-chain cooldown) block unconditionally; an OSV-unconfirmed install
 *  blocks only under the fail-closed toggle. */
export const isBlocked = (verdict: PerVersionVerdict): boolean => {
  if (verdict.verdict === 'flagged') return true;
  if (verdict.tooNew === true) return true;
  return osvFailClosed() && verdict.isOsvChecked === false;
};

/** True when a verdict passed the gate solely because fail-open allows
 *  OSV-unconfirmed (not-listed / lookup-failed) installs. Under fail-closed
 *  such a version is blocked, so this is only ever true in fail-open mode.
 *  Adapters use it to surface a "not vetted" warning instead of a silent pass. */
export const isUnconfirmedPass = (verdict: PerVersionVerdict): boolean => {
  return verdict.isOsvChecked === false && !isBlocked(verdict);
};

/**
 * Firing Point 1 guard: throws {@link FlaggedVersionError} when installing /
 * saving a `flagged` version or a version whose OSV check did not complete
 * (FR-5, AC-3, fail-closed-on-unvalidated).
 */
export const assertInstallable = (ref: PackageRef, verdict: PerVersionVerdict): void => {
  if (isBlocked(verdict)) throw new FlaggedVersionError(ref);
};

/** Pull candidate `name@version` targets out of common tool-arg shapes. */
export const extractTargets = (
  args: Record<string, unknown>,
): Array<{ name: string; version: string }> => {
  const out: Array<{ name: string; version: string }> = [];
  const push = (s: unknown) => {
    if (typeof s !== 'string') return;
    const i = s.lastIndexOf('@');
    if (i > 0 && i < s.length - 1) out.push({ name: s.slice(0, i), version: s.slice(i + 1) });
  };
  for (const key of ['packages', 'dependencies', 'deps', 'targets', 'add']) {
    const v = args[key];
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  }
  if (typeof args.package === 'string' && typeof args.version === 'string') {
    out.push({ name: args.package, version: args.version });
  }
  return out;
};

/**
 * `tool_call` hook contract: veto a tool call that targets a `flagged`
 * version (FR-5). Returns `{ block: true, reason }` or `{ block: false }`.
 */
export const guardToolCall = (
  params: { tool: string; args: Record<string, unknown> },
  verdictOf: VerdictResolver,
): BlockDecision | { block: false } => {
  for (const t of extractTargets(params.args)) {
    const v = verdictOf(t.name, t.version);
    if (v && isBlocked(v)) {
      return {
        block: true,
        reason: `${t.name}@${t.version} blocked: ${v.verdict} - ${v.reason}`,
      };
    }
  }
  return { block: false };
};

/**
 * Build the `assert_installable` custom tool the agent calls pre-write.
 * Returns a blocking result for any `flagged` target (FR-5).
 */
export const makeAssertTool = (verdictOf: VerdictResolver) => {
  return (args: Record<string, unknown>): { blocked: boolean; reason?: string } => {
    for (const t of extractTargets(args)) {
      const v = verdictOf(t.name, t.version);
      if (v && isBlocked(v))
        return {
          blocked: true,
          reason: `${t.name}@${t.version} blocked: ${v.verdict} - ${v.reason}`,
        };
    }
    return { blocked: false };
  };
};
