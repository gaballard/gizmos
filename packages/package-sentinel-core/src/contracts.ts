/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core domain contracts for Package Sentinel.
 *
 * These types and interfaces define the shared vocabulary across manifest
 * detection, registry resolution, OSV advisory lookup, safe-version
 * decisioning, and both enforcement firing points. Implementations live in
 * sibling modules (`detect.ts`, `registry.ts`, `osv.ts`, `decide.ts`, and the
 * enforcement hooks) and must satisfy these contracts.
 *
 * Design invariant (NFR-1 / AC-5): a version is reported `safe` only when an
 * OSV check was actually completed for it (`isOsvChecked === true`). No code
 * path may return `safe` for an unchecked version.
 */

/** Supported package ecosystems and their registries. */
export type Ecosystem = 'npm' | 'pypi' | 'rust';

/** A fully-qualified reference to a package in a specific ecosystem. */
export interface PackageRef {
  /** Package name as used by the registry (e.g. `lodash`, `requests`). */
  name: string;
  /** The ecosystem / registry this package belongs to. */
  ecosystem: Ecosystem;
}

/** A publishable version observed on a registry. */
export interface RegistryVersion {
  /** Version string as published (e.g. `4.17.21`). */
  version: string;
  /** ISO-8601 publish timestamp, used for recency decisions. */
  publishedAt: string;
}

/** Severity of a vulnerability advisory. */
export type Severity = 'unknown' | 'low' | 'moderate' | 'high' | 'critical';

/** A vulnerability advisory (e.g. from OSV) affecting a package. */
export interface Advisory {
  /** Advisory identifier (e.g. `GHSA-...`, `OSV-2020-...`). */
  id: string;
  /** Short human-readable summary. */
  summary: string;
  /** Severity if known, else `unknown`. */
  severity: Severity;
  /** Version ranges / versions affected by this advisory. */
  affectedVersions: string[];
}

/** Final safe-version verdict for a single candidate version. */
export type VerdictLabel = 'safe' | 'flagged' | 'needs_review';

/** Per-version decision produced by the decision engine. */
export interface PerVersionVerdict {
  /** The candidate version this verdict applies to. */
  version: string;
  verdict: VerdictLabel;
  /** Concise, human-readable reason. */
  reason: string;
  /** Advisories that influenced this verdict (empty when none found). */
  advisories: Advisory[];
  /** True iff an OSV check completed for this version. */
  isOsvChecked: boolean;
  /** True when the version was published within the "too new" cooldown
   *  (TOO_NEW_DAYS). The gate blocks these by default (supply-chain cooldown);
   *  the flag lets `isBlocked` act on recency without parsing the reason string. */
  tooNew?: boolean;
}

/** One supported manifest file name mapped to its ecosystem. */
export type ManifestKind =
  | { file: 'package.json'; ecosystem: 'npm' }
  | { file: 'pyproject.toml'; ecosystem: 'pypi' }
  | { file: 'requirements.txt'; ecosystem: 'pypi' }
  | { file: 'Pipfile'; ecosystem: 'pypi' }
  | { file: 'Cargo.toml'; ecosystem: 'rust' };

/** The result of successful manifest detection. */
export interface ManifestDetection {
  ecosystem: Ecosystem;
  kind: ManifestKind;
  /** Absolute path to the detected manifest. */
  path: string;
}

/**
 * Contract: detect the supported manifest at `path` and map it to its
 * ecosystem/registry. Returns `null` when `path` references no supported
 * manifest (FR-1).
 */
export type DetectManifest = (path: string) => ManifestDetection | null;

/** Contract: fetch published versions for a package from its registry. */
export interface RegistryAdapter {
  /** List publishable versions for `pkg` (FR-2). */
  listVersions(pkg: PackageRef): Promise<RegistryVersion[]>;
}

/** Contract: query OSV for advisories affecting a package/version (FR-3). */
export interface OsvClient {
  /**
   * Return advisories for `pkg` at `version`. Must throw a distinct transport
   * error on network failure so callers can never mistake "unable to check"
   * for "no advisories" (NFR-1).
   */
  queryAdvisories(pkg: PackageRef, version: string): Promise<Advisory[]>;
}

/**
 * Contract: combine advisories + publish recency into per-version verdicts.
 * `advisoriesFor(version)` returns the completed OSV result for a candidate;
 * callers must pass the full advisory set (or an explicit empty result), never
 * "skipped" (FR-4).
 */
export type DecideVersion = (
  ref: PackageRef,
  versions: RegistryVersion[],
  advisoriesFor: (version: string) => Advisory[],
  osvCheckedFor: (version: string) => boolean,
) => PerVersionVerdict[];

/** Firing Point 1 - pre-write enforcement gate (FR-5) */

/** Reason a `flagged` version cannot be installed or persisted. */
export interface BlockDecision {
  block: true;
  /** Human-readable reason including advisory ids/severity. */
  reason: string;
}

/** Contract for the `tool_call` blocker: veto calls targeting a flagged
 *  version (FR-5). */
export type ToolCallHook = (params: {
  /** Name of the tool the agent is about to call. */
  tool: string;
  /** Parsed tool arguments. */
  args: Record<string, unknown>;
}) => BlockDecision | { block: false };

/**
 * Contract: guard that refuses to install / save a `flagged` version.
 * Throws {@link FlaggedVersionError} when `verdict` is `flagged` (AC-3).
 */
export type AssertInstallable = (ref: PackageRef, verdict: PerVersionVerdict) => void;

/** Thrown by {@link AssertInstallable} for a blocked install/save. */
export class FlaggedVersionError extends Error {
  readonly ref: PackageRef;
  constructor(ref: PackageRef) {
    super(`Blocked: ${ref.name} is flagged (vulnerable). Refusing to install or save.`);
    this.name = 'FlaggedVersionError';
    this.ref = ref;
  }
}

/** Firing Point 2 - post-write validation (FR-5b / FR-6) */

/** Immutable capture of a manifest's content at a point in time. */
export interface ManifestSnapshot {
  /** Absolute path to the manifest. */
  path: string;
  /** Raw manifest content. */
  content: string;
}

/** A `flagged` version that leaked into a manifest after a tool ran. */
export interface FlaggedLeak {
  /** Manifest path that now contains the version. */
  manifestPath: string;
  pkg: PackageRef;
  version: string;
  /** Why it was flagged (e.g. advisory ids). */
  reason: string;
}

/**
 * Contract: snapshot-diff a detected manifest across a tool execution and
 * surface any `flagged` version that leaked in (FR-5b).
 */
export type ValidatePostWrite = (
  before: ManifestSnapshot[],
  after: ManifestSnapshot[],
  verdictOf: (pkg: PackageRef, version: string) => PerVersionVerdict | null,
) => FlaggedLeak[];
