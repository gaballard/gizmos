#!/usr/bin/env node

/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createVetter,
  isBlocked,
  isUnconfirmedPass,
  snapshotManifests,
} from 'package-sentinel-core';
import { extractInstallTargets, readEvent, runPostWrite, saveSnapshot } from '../shared.ts';

/**
 * Claude Code classic-hook handler for Package Sentinel (Firing Points 1 & 2).
 *
 *  PreToolUse  -> capture manifest "before", and deny the tool call when an
 *                 install target resolves to a flagged or too-new version
 *                 (OSV-unchecked passes with a "not vetted" warning under the
 *                 fail-open default; PACKAGE_SENTINEL_FAIL_CLOSED=1 denies it.
 *                 Same gate as the pi extension's tool_call hook.)
 *  PostToolUse -> snapshot-diff, flag flagged leaks, and pin range-added deps
 *                 to exact safe versions (write-back).
 *  Stop        -> turn-end safety net: last leak scan + pin.
 *
 * Registered from hooks/hooks.json. Reads the event JSON on stdin, writes the
 * hook result JSON on stdout (per Claude Code hook convention).
 */

/** Write the hook result as JSON on stdout and exit 0 (Claude Code hook convention). */
const jsonOut = (obj: unknown): never => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

/** Best-effort parse of a string `tool_input`; malformed JSON or non-object input yields an empty object. */
const parseToolInput = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Dispatch the event to its phase handler and write the hook result JSON. */
const main = async (): Promise<void> => {
  const event = await readEvent();
  const hook = String(event.hook_event_name ?? '');
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;

  const vetter = createVetter(cwd);

  if (hook === 'PreToolUse') {
    // Capture "before" for the matching post-write event and to keep the gate
    // delta-aware (only ADDED deps are vetted, never existing ones).
    const before = snapshotManifests(cwd);
    saveSnapshot(sessionId, before);
    if (!vetter.manifest) jsonOut({});

    const beforeByPath = Object.fromEntries(before.map((s) => [s.path, s.content]));

    const input = (
      typeof event.tool_input === 'object' && event.tool_input !== null
        ? (event.tool_input as Record<string, unknown>)
        : typeof event.tool_input === 'string'
          ? parseToolInput(event.tool_input)
          : {}
    ) as Record<string, unknown>;

    const warnings: string[] = [];
    for (const t of extractInstallTargets(input, beforeByPath)) {
      const verdict = await vetter.vet(t.name, t.version);
      if (verdict && isBlocked(verdict)) {
        const alt = await vetter.recommendSafeVersion(t.name);
        const reason =
          `[Package Sentinel] Refuse ${t.name}@${t.version}: ${verdict.reason}` +
          (alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known');
        jsonOut({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        });
      }
      if (verdict && isUnconfirmedPass(verdict))
        warnings.push(`${t.name}@${t.version} (OSV check did not complete)`);
    }
    if (warnings.length > 0) {
      // Fail-open: allow but surface a loud "not vetted" notice so the pass
      // is never silent.
      jsonOut({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `[Package Sentinel] not vetted: ${warnings.join(', ')} - install allowed (fail-open)`,
        },
      });
    }
    jsonOut({});
  }

  if (hook === 'PostToolUse' || hook === 'Stop') {
    if (!vetter.manifest && hook !== 'Stop') jsonOut({}); // only turn-end surfaces a "not vetted" note
    const { leaks, note } = await runPostWrite(vetter, cwd, sessionId);
    if (note && hook === 'Stop') {
      jsonOut({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: note },
      });
    }
    if (leaks.length > 0) {
      const ctx = `[Package Sentinel] ${leaks.length} flagged dep(s) leaked: ${leaks.join(', ')} - rollback recommended`;
      jsonOut({
        hookSpecificOutput: { hookEventName: hook, additionalContext: ctx },
      });
    }
    jsonOut({});
  }

  // Unknown / other events: no-op.
  jsonOut({});
};

main();
