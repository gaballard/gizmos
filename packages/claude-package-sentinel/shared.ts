/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vetter } from 'package-sentinel-core';
import {
  detectKindFromName,
  detectLeaks,
  diffManifests,
  extractTargets,
  pinManifestChanges,
  snapshotManifests,
} from 'package-sentinel-core';

export type { Vetter };

/** An install target: package name plus an exact version. */
type TInstallTarget = { name: string; version: string };

/**
 * Shared glue between the hook handler (hooks-handlers/handler.ts) and the
 * bundled `package-sentinel` CLI (cli.ts). Core vetting logic lives in the
 * `package-sentinel-core` package; anything that adapts to Claude Code's
 * hook/stdin convention lives here.
 */

/** Read the Claude Code hook input JSON from stdin. */
export const readEvent = async (): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** Cross-process state: PreToolUse must capture the manifest "before", and
 *  PostToolUse/Stop must read it back. Hooks run as separate processes per
 *  event, so the before-snapshot is persisted, keyed by session id. */

/** Base dir for persisted snapshots (CLAUDE_PLUGIN_DATA, else OS tmp), created on demand. */
export const dataDir = (): string => {
  const base = process.env.CLAUDE_PLUGIN_DATA;
  const dir = base ? join(base, 'package-sentinel') : join(tmpdir(), 'package-sentinel');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** Session-keyed snapshot file path with the id sanitized to a filesystem-safe token. */
const statePath = (sessionId: string): string => {
  const safe = (sessionId || 'anon').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(dataDir(), `snap-${safe}.json`);
};

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // stale before-snapshot is treated as absent

/** Persist a session's manifest snapshot atomically (write-then-rename, so concurrent
 *  hooks never read a torn file). */
export const saveSnapshot = (sessionId: undefined | string, snaps: unknown): void => {
  // Atomic: write-then-rename so concurrent hooks never read a torn snapshot.
  const p = statePath(sessionId || '');
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snaps ?? []), { mode: 0o600 });
  renameSync(tmp, p);
};

/** Read back a session's snapshot, treating stale (> SNAPSHOT_TTL_MS) or unreadable ones as absent. */
export const loadSnapshot = (sessionId: undefined | string): unknown[] => {
  const p = statePath(sessionId || '');
  if (!existsSync(p)) return [];
  try {
    if (Date.now() - statSync(p).mtimeMs > SNAPSHOT_TTL_MS) return [];
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
};

/** Install-target extraction from a Claude Code tool_input. Mirrors the pi extension's
 *  index.ts (targetsFromCommand) plus manifest-content parsing for Write/Edit.
 *  This feeds the PreToolUse gate. The gate only fires on install targets: bare
 *  `npm install`, non-additive manifest edits, and unrelated `@`-containing
 *  tokens are never targets. For a manifest Write/Edit, only deps ADDED by the
 *  edit (an exact version) become targets - pass the pre-edit manifest content
 *  via `beforeManifests` so existing deps are not re-vetted. */

/** Pull `name@version` install specs out of a shell command (best-effort). */
export const targetsFromCommand = (command: string): TInstallTarget[] => {
  if (!/\b(add|install|require|save)\b/i.test(command)) return [];
  const out: TInstallTarget[] = [];
  for (const tok of command.split(/\s+/)) {
    if (tok.includes('@') && !tok.startsWith('-')) {
      const i = tok.lastIndexOf('@');
      if (i > 0 && i < tok.length - 1)
        out.push({ name: tok.slice(0, i), version: tok.slice(i + 1) });
    }
  }
  return out;
};

/** Collect candidate install targets from a Claude Code tool input. Only additive
 *  installs surface targets: bare `npm install` (no name@version) and non-additive
 *  manifest edits yield nothing. `beforeManifests` (path -> pre-edit content) keeps
 *  the Write/Edit branch delta-aware so existing deps are never re-vetted. */
export const extractInstallTargets = (
  input: Record<string, unknown>,
  beforeManifests: Record<string, string> = {},
): TInstallTarget[] => {
  const targets = extractTargets(input);
  const command =
    typeof input.command === 'string'
      ? input.command
      : typeof input.command_text === 'string'
        ? input.command_text
        : null;
  if (command) targets.push(...targetsFromCommand(command));
  const content =
    typeof input.content === 'string'
      ? input.content
      : typeof input.content_text === 'string'
        ? input.content_text
        : null;
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.filePath === 'string'
        ? input.filePath
        : null;
  if (content && filePath) {
    const kind = detectKindFromName(filePath.split('/').pop() ?? '');
    if (kind) {
      // Delta-aware: only deps this edit ADDS (or changes to) an exact version
      // become targets; everything already in the manifest is ignored.
      for (const [dep, spec] of Object.entries(
        diffManifests(beforeManifests[filePath] ?? '', content, kind).added,
      )) {
        const exact = depVersion(spec);
        if (exact) targets.push({ name: dep, version: exact });
      }
    }
  }
  return targets.filter((t) => t.name && t.version);
};

/** Extract a bare exact `1.2.3` version from a spec, else null (ranges are
 *  handled by the post-write pin/leak path, not the gate). */
const depVersion = (spec: string): string | null => {
  const m = spec.match(/^[v=]?\s*(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)$/);
  return m ? m[1] : null;
};

/** Parse a `name@version` / `name==version` spec into a ref, or null. */
export const parseSpec = (spec: string): TInstallTarget | null => {
  const at = spec.lastIndexOf('@');
  const eq = spec.indexOf('==');
  const sep = at > -1 ? at : eq;
  if (sep < 0) return null;
  const name = spec.slice(0, sep).replace(/^@/, '').trim();
  const version = spec.slice(sep + (at > -1 ? 1 : 2)).trim();
  if (!name || !version) return null;
  return { name, version };
};

/**
 * Post-write scan + pin, shared by PostToolUse and Stop: diff the manifest
 * against the persisted before-snapshot, flag flagged/unvalidated leaks, and
 * rewrite newly-added range deps to exact safe pins. Persists the new snapshot
 * so the next event diffs from the corrected state. `note` carries a one-off
 * "not vetted" warning when no supported manifest is under `cwd` but an
 * unsupported dependency manifest is present.
 */
export const runPostWrite = async (
  vetter: Vetter,
  cwd: string,
  sessionId: undefined | string,
): Promise<{ leaks: string[]; note?: string }> => {
  if (!vetter.manifest) {
    const unsupported = findUnsupportedManifest(cwd);
    return unsupported
      ? {
          leaks: [],
          note: `[Package Sentinel] unsupported manifest (${unsupported}) - dependencies NOT vetted`,
        }
      : { leaks: [] };
  }
  const before = loadSnapshot(sessionId) as {
    path: string;
    content: string;
  }[];
  const after = snapshotManifests(cwd);

  const leaks = await detectLeaks(before, after, vetter.vet);
  const next = await pinManifestChanges(before, after, (name) => vetter.versions(name), vetter.vet);
  for (const ps of next) {
    const orig = after.find((s) => s.path === ps.path)?.content;
    if (orig !== undefined && orig !== ps.content) writeFileSync(ps.path, ps.content);
  }
  saveSnapshot(sessionId, next);
  return {
    leaks: leaks.map((l) => `${l.pkg.name}@${l.version}`),
  };
};

/** Names of dependency manifests this port does NOT vet (loud, not silent). */
const UNSUPPORTED_MANIFESTS = [
  'Gemfile',
  'go.mod',
  'composer.json',
  'build.gradle',
  'pom.xml',
  'Gemfile.lock',
  'go.sum',
];

/** Return the first unsupported manifest present under cwd, else null. */
const findUnsupportedManifest = (cwd: string): string | null => {
  for (const name of UNSUPPORTED_MANIFESTS) {
    try {
      if (existsSync(join(cwd, name)) && statSync(join(cwd, name)).isFile()) return name;
    } catch {
      /* ignore */
    }
  }
  return null;
};
