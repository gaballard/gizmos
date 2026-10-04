/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { writeFileSync } from 'node:fs';
import type { FlaggedLeak, ManifestSnapshot, Vetter } from 'package-sentinel-core';
import {
  auditAllManifests,
  createVetter,
  detectLeaks,
  extractTargets,
  isBlocked,
  isUnconfirmedPass,
  pinManifestChanges,
  snapshotManifests,
} from 'package-sentinel-core';
import { Type } from 'typebox';

/** An install target: package name plus an exact version. */
type TInstallTarget = { name: string; version: string };

/** Pull `name@version` install specs out of a shell command (best-effort). */
const targetsFromCommand = (command: string): TInstallTarget[] => {
  if (!/\b(add|install|require|save|fetch)\b/i.test(command)) return [];
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

/** Collect candidate install targets from a tool-call's input. */
export const targetsFromTool = (input: unknown): TInstallTarget[] => {
  const rec = (input ?? {}) as Record<string, unknown>;
  const targets = extractTargets(rec);
  const command = typeof rec.command === 'string' ? rec.command : null;
  if (command && /\b(add|install|save)\b/i.test(command))
    targets.push(...targetsFromCommand(command));
  return targets;
};

export default async (pi: ExtensionAPI) => {
  let vetter: Vetter | null = null;
  let preSnapshot: ManifestSnapshot[] = [];
  const getVetter = (cwd: string) => (vetter ??= createVetter(cwd));

  // Firing Point 1: block tool calls that target a flagged version (FR-5, AC-3).
  pi.on('tool_call', async (event, ctx) => {
    const v = getVetter(ctx.cwd);
    if (!v.manifest) return;
    const warnings: string[] = [];
    for (const t of targetsFromTool((event as { input?: unknown }).input)) {
      const verdict = await v.vet(t.name, t.version);
      if (verdict && isBlocked(verdict)) {
        const alt = await v.recommendSafeVersion(t.name);
        return {
          block: true,
          reason:
            `[Package Sentinel] Refuse ${t.name}@${t.version}: ${verdict.reason}` +
            (alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known'),
        };
      }
      // Fail-open: allow but surface a loud "not vetted" notice so the pass is never silent.
      if (verdict && isUnconfirmedPass(verdict)) warnings.push(`${t.name}@${t.version}`);
    }
    if (warnings.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `[Package Sentinel] not vetted: ${warnings.join(', ')} - OSV check did not complete; install allowed (fail-open)`,
        'warning',
      );
    }
  });

  // Firing Point 2: capture the manifest before each tool runs (FR-6).
  pi.on('tool_execution_start', async (_event, ctx) => {
    preSnapshot = snapshotManifests(ctx.cwd);
  });

  // Firing Point 2: snapshot-diff across a tool/turn; leak-flag AND pin safe
  // range-added deps to their exact version (write-back).
  /** Snapshot-diff after a tool, leak-flag, and pin range-added deps to exact safe versions. */
  const pinAndClose = async (cwd: string): Promise<{ leaks: FlaggedLeak[] }> => {
    const v = getVetter(cwd);
    if (!v.manifest) return { leaks: [] };
    const after = snapshotManifests(cwd);
    const leaks = await detectLeaks(preSnapshot, after, v.vet);
    const next = await pinManifestChanges(preSnapshot, after, (name) => v.versions(name), v.vet);
    for (const ps of next) {
      const orig = after.find((s) => s.path === ps.path)?.content;
      if (orig !== undefined && orig !== ps.content) writeFileSync(ps.path, ps.content);
    }
    preSnapshot = next;
    return { leaks };
  };

  /** Join a list of flagged leaks into a single `name@version, ...` summary. */
  const leakDetail = (leaks: FlaggedLeak[]) =>
    leaks.map((l) => `${l.pkg.name}@${l.version}`).join(', ');

  pi.on('tool_execution_end', async (_event, ctx) => {
    const { leaks } = await pinAndClose(ctx.cwd);
    if (leaks.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `[Package Sentinel] ${leaks.length} flagged dep(s) leaked: ${leakDetail(leaks)} - rollback recommended`,
        'error',
      );
    }
  });

  // Safety net at turn end: same validation, in case an earlier hook was bypassed.
  pi.on('turn_end', async (_event, ctx) => {
    const { leaks } = await pinAndClose(ctx.cwd);
    if (leaks.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`[Package Sentinel] turn-end: ${leakDetail(leaks)} flagged`, 'error');
    }
  });

  // Explicit pre-write assertion tool the agent must call before saving a dep (FR-5).
  pi.registerTool({
    name: 'assert_installable',
    label: 'Assert installable',
    description:
      'Vet package/version(s) against the package registry + OSV advisories before installing/saving. Call this before writing any dependency to a manifest. Use with the exact version you intend to pin.',
    parameters: Type.Object({
      packages: Type.Array(Type.String(), {
        description: 'Specs like `lodash@4.17.19` or `requests==2.28.2`.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const v = getVetter(process.cwd());
      const lines: string[] = [];
      for (const spec of params.packages) {
        const i = spec.lastIndexOf('@');
        const at = spec.indexOf('==');
        const sep = i > -1 ? i : at;
        const name = spec.slice(0, sep).trim();
        const version = (i > -1 ? spec.slice(i + 1) : spec.slice(at + 2)).trim();
        if (!name || !version) {
          lines.push(`${spec}: invalid spec`);
          continue;
        }
        if (!v.manifest) {
          lines.push(`${name}@${version}: no supported manifest in cwd; not vetted`);
          continue;
        }
        const verdict = await v.vet(name, version);
        if (!verdict) {
          lines.push(`${name}@${version}: no verdict`);
          continue;
        }
        let line = `${name}@${version}: ${verdict.verdict} - ${verdict.reason}`;
        if (isBlocked(verdict)) {
          const alt = await v.recommendSafeVersion(name);
          line += alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known';
        }
        lines.push(line);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: null,
      };
    },
  });

  // Full-manifest audit: vet every existing dependency, not just additions.
  pi.registerCommand('audit', {
    description:
      'Audit every dependency in every manifest (cwd + subfolders) against the package registry + OSV. Append --json for structured output, --exclude <dirs> to skip folders.',
    handler: async (args, ctx) => {
      const json = /\bjson\b/i.test(args);
      const ex = /(?:--exclude\s+|exclude=)([^\s]+)/i.exec(args);
      const excludes = ex ? ex[1].split(',') : [];
      const results = await auditAllManifests(ctx.cwd, { excludes });
      if (!results.length) {
        ctx.ui.notify(
          '[Package Sentinel] no supported manifest in cwd or subfolders; nothing to audit',
          'warning',
        );
        return;
      }
      const blocked = results.some((r) => r.entries.some((e) => e.blocked));
      if (json) {
        ctx.ui.notify(
          JSON.stringify({ manifests: results, blocked }, null, 2),
          blocked ? 'error' : 'info',
        );
        return;
      }
      const lines: string[] = [];
      for (const r of results) {
        lines.push(`${r.path}:`);
        for (const e of r.entries) {
          const ver = e.version ?? (e.verdict === 'workspace' ? '(local link)' : '(unresolved)');
          let l = `  ${e.name}@${ver}`;
          if (e.spec !== e.version) l += ` (declared ${e.spec})`;
          l += `: ${e.verdict} - ${e.reason}`;
          if (e.blocked) {
            const alt = await r.recommendSafeVersion(e.name);
            l += alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known';
          } else if (e.unconfirmed) {
            l += ' (unverified - fail-open)';
          }
          lines.push(l);
        }
      }
      const n = results.reduce((s, r) => s + r.entries.filter((e) => e.blocked).length, 0);
      ctx.ui.notify(
        `[Package Sentinel] audit ${blocked ? `FAIL (${n} blocked)` : 'OK'} over ${results.length} manifest(s)\n${lines.join('\n')}`,
        blocked ? 'error' : 'info',
      );
    },
  });
};
