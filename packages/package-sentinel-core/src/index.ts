/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public surface of the Package Sentinel vetting core.
 *
 * This is the single source of truth shared by the pi coding-agent extension
 * and the Claude Code plugin. Both import from here instead of carrying their
 * own copies, so a fix here reaches both surfaces.
 *
 * All logic is deterministic registry + OSV work - no LLM calls, no environment
 * config. Design invariant (NFR-1 / AC-5): a version is reported `safe` only
 * when an OSV check actually completed for it (`isOsvChecked === true`).
 */

// Contracts / shared types
export {
  FlaggedVersionError,
  type Advisory,
  type AssertInstallable,
  type BlockDecision,
  type DecideVersion,
  type DetectManifest,
  type Ecosystem,
  type FlaggedLeak,
  type ManifestDetection,
  type ManifestKind,
  type ManifestSnapshot,
  type OsvClient,
  type PackageRef,
  type PerVersionVerdict,
  type RegistryAdapter,
  type RegistryVersion,
  type Severity,
  type ToolCallHook,
  type ValidatePostWrite,
  type VerdictLabel,
} from './contracts.ts';

// Manifest detection
export { detectKindFromName, detectManifest } from './detect.ts';

// Registry resolution
export { CratesAdapter, createAdapter, NpmAdapter, PypiAdapter } from './registry.ts';

// OSV advisory lookup
export { createOsvClient, OsvTransportError, parseOsvResponse } from './osv.ts';

// Verdict engine
export { decideVersion } from './decide.ts';

// Enforcement (Firing Point 1 - the gate)
export {
  assertInstallable,
  extractTargets,
  guardToolCall,
  isBlocked,
  isUnconfirmedPass,
  makeAssertTool,
  osvFailClosed,
  type VerdictResolver,
} from './enforce.ts';

// Post-write validation + dependency parsing (Firing Point 2)
export { diffManifests, extractDeps, validatePostWrite } from './postwrite.ts';

// Safe-version pinning
export { applyPins, isRangeSpec, pickExactPin, pinManifestChanges } from './pin.ts';

// Wiring helpers shared by both hosts
export {
  auditAllManifests,
  auditManifest,
  createVetter,
  DEFAULT_EXCLUDE_DIRS,
  detectLeaks,
  findManifest,
  findManifests,
  snapshotManifests,
  type AuditEntry,
  type AuditResult,
  type SafeRecommendation,
  type Vetter,
  type VetterDeps,
} from './orchestrate.ts';
