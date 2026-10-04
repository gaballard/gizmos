#!/usr/bin/env node

/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { auditAllManifests, createVetter, isBlocked } from 'package-sentinel-core';
import type { Vetter } from './shared.ts';
import { parseSpec } from './shared.ts';

/**
 * `package-sentinel` CLI - the agent-friendly way to vet before writing a dep.
 * This is the Claude Code counterpart of the pi extension's `assert_installable`
 * tool (FR-5), surfaced as a command + a PATH executable from bin/.
 *
 *   package-sentinel assert lodash@4.17.19 requests==2.28.2
 *   package-sentinel vet lodash 4.17.19
 *
 * Prints one verdict line per spec. Exits non-zero when any target is blocked
 * (flagged always; OSV-unchecked too under PACKAGE_SENTINEL_FAIL_CLOSED=1).
 */

/** Vet one spec and format a single verdict line; a blocked verdict appends a safe-version suggestion. */
const vetSpec = async (v: Vetter, name: string, version: string): Promise<string> => {
  if (!v.manifest) return `${name}@${version}: no supported manifest in cwd; not vetted`;
  const verdict = await v.vet(name, version);
  if (!verdict) return `${name}@${version}: no verdict`;
  let line = `${name}@${version}: ${verdict.verdict} - ${verdict.reason}`;
  if (isBlocked(verdict)) {
    const alt = await v.recommendSafeVersion(name);
    line += alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known';
  }
  return line;
};

export const main = async (args: string[]): Promise<number> => {
  const cmd = args[0];
  const v = createVetter(process.cwd());

  if (cmd === 'assert') {
    let blocked = false;
    const specs = args.slice(1);
    if (specs.length === 0) {
      console.error('usage: package-sentinel assert <name@version>...');
      return 2;
    }
    for (const spec of specs) {
      const ref = parseSpec(spec);
      if (!ref) {
        console.log('%s: invalid spec (use name@version or name==version)', spec);
        blocked = true;
        continue;
      }
      let verdict: Awaited<ReturnType<Vetter['vet']>> = null;
      if (v.manifest) verdict = await v.vet(ref.name, ref.version);
      if (!v.manifest || !verdict || isBlocked(verdict)) blocked = true;
      let line = `${ref.name}@${ref.version}: `;
      if (!v.manifest) line += 'no supported manifest in cwd; not vetted';
      else if (verdict) {
        line += `${verdict.verdict} - ${verdict.reason}`;
        if (isBlocked(verdict)) {
          const alt = await v.recommendSafeVersion(ref.name);
          line += alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known';
        }
      } else line += 'no verdict';
      console.log(line);
    }
    return blocked ? 1 : 0;
  }

  if (cmd === 'vet') {
    const line = await vetSpec(v, args[1], args[2]);
    console.log(line);
    const ref = parseSpec(`${args[1]}@${args[2]}`);
    let blocked = true;
    if (ref && v.manifest) {
      const verdict = await v.vet(ref.name, ref.version);
      blocked = !verdict || isBlocked(verdict);
    }
    return blocked ? 1 : 0;
  }

  if (cmd === 'audit') {
    const json = args.includes('--json');
    const excludes: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--exclude' && args[i + 1]) excludes.push(...args[++i].split(','));
    }
    const results = await auditAllManifests(process.cwd(), { excludes });
    if (!results.length) {
      console.log('no supported manifest in cwd or subfolders; nothing to audit');
      return 0;
    }
    const blocked = results.some((r) => r.entries.some((e) => e.blocked));
    if (json) {
      console.log(JSON.stringify({ manifests: results, blocked }, null, 2));
    } else {
      for (const r of results) {
        console.log(`${r.path}:`);
        for (const e of r.entries) {
          const ver = e.version ?? (e.verdict === 'workspace' ? '(local link)' : '(unresolved)');
          let line = `  ${e.name}@${ver}`;
          if (e.spec !== e.version) line += ` (declared ${e.spec})`;
          line += `: ${e.verdict} - ${e.reason}`;
          if (e.blocked) {
            const alt = await r.recommendSafeVersion(e.name);
            line += alt ? ` - try ${alt.version} (${alt.verdict})` : ' - no safe version known';
          } else if (e.unconfirmed) {
            line += ' (unverified - fail-open)';
          }
          console.log(line);
        }
      }
      const n = results.reduce((s, r) => s + r.entries.filter((e) => e.blocked).length, 0);
      console.log(
        n
          ? `audit FAIL: ${n} blocked across ${results.length} manifest${results.length > 1 ? 's' : ''}`
          : `audit OK (${results.length} manifest${results.length > 1 ? 's' : ''})`,
      );
    }
    return blocked ? 1 : 0;
  }

  console.error(
    'usage: package-sentinel (assert <spec>... | vet <name> <version> | audit [--json] [--exclude <dirs>])',
  );
  return 2;
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
