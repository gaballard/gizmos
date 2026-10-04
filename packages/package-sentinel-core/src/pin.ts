/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { rcompare, satisfies } from 'semver';
import type {
  ManifestKind,
  ManifestSnapshot,
  PerVersionVerdict,
  RegistryVersion,
} from './contracts.ts';
import { detectKindFromName } from './detect.ts';
import { diffManifests } from './postwrite.ts';

/** Exact `1.2.3` (optional `v`/`=` prefix). A spec matching this is already pinned. */
const EXACT = /^[v=]?\d+\.\d+(\.\d+)?$/;

/** True when `spec` is a range (needs resolving to an exact pin), not an exact version. */
export const isRangeSpec = (spec: string): boolean => {
  return !EXACT.test(spec.trim());
};

/**
 * Resolve a range spec to the newest non-blocked exact version that satisfies it.
 * Returns null when the spec is already exact, nothing matches, or every match is blocked.
 */
export const pickExactPin = async (
  declaredSpec: string,
  versions: RegistryVersion[],
  isBlocked: (version: string) => boolean | Promise<boolean>,
): Promise<string | null> => {
  if (!isRangeSpec(declaredSpec)) return null;
  const matching = versions
    .filter((v) => satisfies(v.version, declaredSpec))
    .sort((a, b) => rcompare(a.version, b.version));
  for (const v of matching) {
    if (!(await isBlocked(v.version))) return v.version;
  }
  return null;
};

/** Rewrite `name: spec` deps of a package.json to the pinned exact versions. */
const applyPinsPackageJson = (content: string, pins: Record<string, string>): string => {
  let json: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;
  try {
    json = JSON.parse(content);
  } catch {
    return content;
  }
  if (!json) return content;
  for (const [name, version] of Object.entries(pins)) {
    if (json?.dependencies && name in json.dependencies) json.dependencies[name] = version;
    else if (json?.devDependencies && name in json.devDependencies)
      json.devDependencies[name] = version;
    else json.dependencies = { ...(json?.dependencies ?? {}), [name]: version };
  }
  return `${JSON.stringify(json, null, 2)}\n`;
};

/** Rewrite `name==range` / `name>=range` lines of a requirements.txt to `name==<pin>`. */
const applyPinsRequirements = (content: string, pins: Record<string, string>): string => {
  return content
    .split('\n')
    .map((line) => {
      for (const [name, pin] of Object.entries(pins)) {
        const re = new RegExp(
          `^(\\s*)${escapeRegex(name)}(\\s*(?:==|>=|<=|!=|~=|>|<)\\s*)[^\\s;#]+(.*)$`,
        );
        const m = line.match(re);
        if (m) return `${m[1]}${name}==${pin}${m[3]}`;
      }
      return line;
    })
    .join('\n');
};

const escapeRegex = (s: string): string => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/** Rewrite `name = "version"` / `name = { version = "version" }` TOML dep lines. */
const applyPinsToml = (content: string, pins: Record<string, string>): string => {
  const re = /^(\s*)([\w.-]+)(\s*=\s*)((?:\{\s*version\s*=\s*)?)(["'])([^"']+)(["'])(.*)$/;
  return content
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      if (m && m[2] in pins) {
        return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${pins[m[2]]}${m[7]}${m[8]}`;
      }
      return line;
    })
    .join('\n');
};

/** Rewrite `name: spec` deps to the pinned exact versions, per manifest format. */
export const applyPins = (
  content: string,
  kind: ManifestKind,
  pins: Record<string, string>,
): string => {
  switch (kind.file) {
    case 'package.json':
      return applyPinsPackageJson(content, pins);
    case 'requirements.txt':
      return applyPinsRequirements(content, pins);
    default:
      return applyPinsToml(content, pins); // pyproject.toml, Cargo.toml, Pipfile
  }
};

/**
 * Pin newly-added range deps in the post-snapshot to a safe exact version.
 * Only package.json manifests are rewritten. Returns updated snapshots (unchanged
 * content for manifests with nothing to pin).
 */
export const pinManifestChanges = async (
  before: ManifestSnapshot[],
  after: ManifestSnapshot[],
  versionsFor: (name: string) => Promise<RegistryVersion[]>,
  vet: (name: string, version: string) => Promise<PerVersionVerdict | null>,
): Promise<ManifestSnapshot[]> => {
  const out = [...after];
  for (const snap of after) {
    const kind =
      detectKindFromName(snap.path.split('/').pop() ?? '') ??
      ({ file: 'package.json', ecosystem: 'npm' } as ManifestKind);
    const prior = before.find((s) => s.path === snap.path);
    const { added } = diffManifests(prior?.content ?? '', snap.content, kind);
    const pins: Record<string, string> = {};
    for (const [name, spec] of Object.entries(added)) {
      if (!isRangeSpec(spec)) continue;
      let versions: RegistryVersion[];
      try {
        versions = await versionsFor(name);
      } catch {
        continue; // can't resolve - leave the range as-is
      }
      const isBlocked = async (v: string) => {
        const verdict = await vet(name, v);
        return verdict ? verdict.verdict === 'flagged' || !verdict.isOsvChecked : true;
      };
      const pin = await pickExactPin(spec, versions, isBlocked).catch(() => null);
      if (pin) pins[name] = pin;
    }
    if (Object.keys(pins).length > 0) {
      const idx = out.findIndex((s) => s.path === snap.path);
      out[idx] = { ...snap, content: applyPins(snap.content, kind, pins) };
    }
  }
  return out;
};
