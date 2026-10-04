/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Advisory, PackageRef, PerVersionVerdict, RegistryVersion } from './contracts.ts';

/** Published within this many days → `needs_review` + `tooNew` (blocked by the
 *  gate by default - supply-chain cooldown). Exported so the recommendation
 *  scan can pre-filter too-new candidates without spending vet queries. */
export const TOO_NEW_DAYS = 7;
const STALE_DAYS = 365;
const DAY_MS = 86_400_000;

/**
 * Combine advisories + publish recency into per-version verdicts (FR-4, NFR-1).
 *
 * A version is reported `safe` ONLY when: an OSV check completed for it
 * (`osvCheckedFor` true), it has no advisory, and it is neither too-new nor
 * stale-and-superseded. An unchecked version is never `safe` (AC-5).
 */
export const decideVersion = (
  _ref: PackageRef,
  versions: RegistryVersion[],
  advisoriesFor: (version: string) => Advisory[],
  osvCheckedFor: (version: string) => boolean,
  now: Date = new Date(),
): PerVersionVerdict[] => {
  const newest = versions.reduce<RegistryVersion | null>(
    (max, v) => (max === null || v.publishedAt > max.publishedAt ? v : max),
    null,
  );

  return versions.map((v) => {
    const advisories = advisoriesFor(v.version) ?? [];
    const verified = osvCheckedFor(v.version);
    const ageDays = (now.getTime() - new Date(v.publishedAt).getTime()) / DAY_MS;

    if (advisories.length > 0) {
      const ids = advisories.map((a) => a.id).join(', ');
      return {
        version: v.version,
        verdict: 'flagged',
        reason: `vulnerable: ${ids}`,
        advisories,
        isOsvChecked: true,
        tooNew: false,
      };
    }
    if (!verified) {
      return {
        version: v.version,
        verdict: 'needs_review',
        reason: 'OSV check not completed',
        advisories,
        isOsvChecked: false,
        tooNew: false,
      };
    }
    if (ageDays < TOO_NEW_DAYS) {
      return {
        version: v.version,
        verdict: 'needs_review',
        reason: `published ${Math.round(ageDays)}d ago; too new`,
        advisories,
        isOsvChecked: true,
        tooNew: true,
      };
    }
    if (newest && v.publishedAt < newest.publishedAt && ageDays > STALE_DAYS) {
      return {
        version: v.version,
        verdict: 'needs_review',
        reason: `stale (${Math.round(ageDays)}d old); newer version exists`,
        advisories,
        isOsvChecked: true,
        tooNew: false,
      };
    }
    return {
      version: v.version,
      verdict: 'safe',
      reason: 'no advisory, reasonable recency',
      advisories,
      isOsvChecked: true,
      tooNew: false,
    };
  });
};
