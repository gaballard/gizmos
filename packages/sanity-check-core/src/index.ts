/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public surface of the Sanity Check core.
 *
 * Single source of truth for the cross-model agree/disagree review loop
 * (producer A vs independent reviewer B, looping to agreement or the round
 * cap). Shared by the pi coding-agent extension and the Claude Code plugin
 * (and any future opencode adapter) - both import from here instead of
 * carrying their own copies, so a verdict fix reaches every surface.
 *
 * All logic is pure string/decision work over structural types: no runtime
 * imports, no environment config. The single transport helper `chatComplete`
 * serves adapters that run outside a host LLM session. Design invariants:
 *  - A report with no format markers, or a bodyless `AGREE: yes`, is refused
 *    as convergence (defense-in-depth against hollow approvals).
 *  - `blocksToText` never yields "" for a reasoning-only reply that exhausted
 *    its output budget in the thinking phase, so a revision/review is never
 *    silently empty.
 */

export {
  applyRevision,
  blocksToText,
  classifyCompletion,
  classifyReport,
  classifyThrownCompletion,
  completionFailureReason,
  convergenceFor,
  extractLastAssistantText,
  MAX_ROUNDS,
  parseAgree,
  PRODUCER_SYSTEM,
  resolveFullModel,
  resolveModel,
  REVIEWER_SYSTEM,
  type CompletionKind,
  type CompletionOutcome,
  type Nullable,
  type Verdict,
} from './core.ts';

// The transport helper serves adapters that run outside a host LLM session;
// it now lives in the neutral transport core (see sanity-check-trust-boundary).
export { chatComplete, type ChatCompleteOpts } from '@gizmos/transport-core';
// FR-4: deliverable framing marker helper (trust boundary).
export { frameDeliverable } from './framing.ts';
export { ModelNotFoundError } from './core.ts';
