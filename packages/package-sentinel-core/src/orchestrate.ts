/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  Ecosystem,
  FlaggedLeak,
  ManifestDetection,
  ManifestSnapshot,
  OsvClient,
  PackageRef,
  PerVersionVerdict,
  RegistryVersion,
  VerdictLabel,
} from './contracts.ts';
import { decideVersion, TOO_NEW_DAYS } from './decide.ts';
import { detectManifest } from './detect.ts';
import { isBlocked } from './enforce.ts';
import { createOsvClient } from './osv.ts';
import { isRangeSpec, pickExactPin } from './pin.ts';
import { diffManifests, extractDeps } from './postwrite.ts';
import { createAdapter } from './registry.ts';

const MANIFEST_NAMES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
];

/** Directories never descended into when scanning for subfolder manifests. */
export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.git',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
];

/** Find the first supported manifest present under `cwd` (FR-1). */
export const findManifest = (cwd: string): ManifestDetection | null => {
  for (const name of MANIFEST_NAMES) {
    try {
      if (statSync(`${cwd}/${name}`).isFile()) return detectManifest(`${cwd}/${name}`);
    } catch {
      /* not present */
    }
  }
  return null;
};

/**
 * Find every supported manifest at `cwd` and below, for monorepos. Dirs are
 * skipped when their basename or their `cwd`-relative path matches a default
 * or user exclude. Results are sorted by path for deterministic reports.
 */
export const findManifests = (
  cwd: string,
  excludes: string[] = [],
  maxDepth = 10,
): ManifestDetection[] => {
  const skip = new Set([...DEFAULT_EXCLUDE_DIRS, ...excludes]);
  const found: ManifestDetection[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const name of MANIFEST_NAMES) {
      if (!files.has(name)) continue;
      const det = detectManifest(`${dir}/${name}`);
      if (det) found.push(det);
    }
    if (depth >= maxDepth) return;
    const rel = dir === cwd ? '' : `${dir.slice(cwd.length + 1)}/`;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name) || skip.has(`${rel}${e.name}`)) continue;
      walk(`${dir}/${e.name}`, depth + 1);
    }
  };
  walk(cwd, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
};

export interface SafeRecommendation {
  /** A version of the package the gate would not block. */
  version: string;
  /** Its verdict, so callers can label it `safe` / `needs_review`. */
  verdict: VerdictLabel;
}

/** Workspace-name sets, cached per manifest directory (one audit walk per dir). */
const workspaceNamesCache = new Map<string, Set<string>>();

/**
 * Names of packages linked by npm workspaces from the nearest ancestor
 * package.json that declares `workspaces`. Such deps resolve to local dirs at
 * install time; a registry vet can never succeed for them (private/local), so
 * the audit reports them as `workspace` instead of `unresolved`.
 */
export const npmWorkspaceNames = (manifestDir: string): Set<string> => {
  const cached = workspaceNamesCache.get(manifestDir);
  if (cached) return cached;
  const names = new Set<string>();
  let dir = resolve(manifestDir);
  let ws: unknown;
  for (;;) {
    try {
      ws = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).workspaces;
    } catch {
      ws = undefined;
    }
    if (ws !== undefined) break;
    const parent = dirname(dir);
    if (parent === dir) {
      workspaceNamesCache.set(manifestDir, names);
      return names;
    }
    dir = parent;
  }
  const patterns: unknown[] = Array.isArray(ws)
    ? ws
    : Array.isArray((ws as { packages?: unknown[] })?.packages)
      ? (ws as { packages: unknown[] }).packages
      : [];
  const nameOf = (d: string): string | null => {
    try {
      return String(JSON.parse(readFileSync(`${d}/package.json`, 'utf8')).name ?? '');
    } catch {
      return null;
    }
  };
  for (const raw of patterns.map(String)) {
    if (raw.endsWith('/*')) {
      // ponytail: one-level `*` globs only (npm's common form); recurse for deeper patterns if ever needed
      let entries;
      try {
        entries = readdirSync(`${dir}/${raw.slice(0, -2)}`, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const n = nameOf(`${dir}/${raw.slice(0, -2)}/${e.name}`);
        if (n) names.add(n);
      }
    } else {
      const n = nameOf(`${dir}/${raw}`);
      if (n) names.add(n);
    }
  }
  workspaceNamesCache.set(manifestDir, names);
  return names;
};

/** Newest-first scan depth for safe-version recommendations (bounds OSV cost). */
const RECOMMEND_SCAN_LIMIT = 10;

export interface Vetter {
  manifest: ManifestDetection | null;
  /** Vet one name@version against the registry + OSV. Returns null off-ecosystem. */
  vet(name: string, version: string): Promise<PerVersionVerdict | null>;
  /** List published versions for a package in the detected ecosystem. */
  versions(name: string): Promise<RegistryVersion[]>;
  /**
   * Recommend the most recent installable version (newest non-blocked) of a
   * package, or null when no known version is safe. Used to give a blocked
   * install an alternative instead of a bare refusal.
   */
  recommendSafeVersion(name: string): Promise<SafeRecommendation | null>;
}

/** Injectable collaborators for {@link createVetter} (test seams). */
export interface VetterDeps {
  adapter?: ReturnType<typeof createAdapter>;
  osv?: OsvClient;
  /** Share the per-version verdict cache across vetters (one audit pass). */
  cache?: Map<string, PerVersionVerdict | null>;
}

/**
 * Build a vetting closure for a project directory. The per-version cache makes
 * repeated checks cheap within a session (NFR-3, stateless by design).
 * `deps` are optional injection seams for tests.
 */
export const createVetter = (cwd: string, deps: VetterDeps = {}): Vetter => {
  const manifest = findManifest(cwd);
  const cache = deps.cache ?? new Map<string, PerVersionVerdict | null>();
  const recommendCache = new Map<string, SafeRecommendation | null>();
  if (!manifest)
    return {
      manifest: null,
      vet: async () => null,
      versions: async () => [],
      recommendSafeVersion: async () => null,
    };

  const ecosystem: Ecosystem = manifest.ecosystem;
  const adapter = deps.adapter ?? createAdapter(ecosystem);
  const osv = deps.osv ?? createOsvClient();

  const versions = (name: string) => adapter.listVersions({ name, ecosystem });

  return {
    manifest,
    versions,
    async recommendSafeVersion(name: string): Promise<SafeRecommendation | null> {
      const recKey = `${ecosystem}::${name}#rec`;
      if (recommendCache.has(recKey)) return recommendCache.get(recKey) ?? null;
      let list: RegistryVersion[];
      try {
        list = await versions(name);
      } catch {
        return null;
      }
      const sorted = [...list].sort((a, b) =>
        String(b.publishedAt).localeCompare(String(a.publishedAt)),
      );
      // Pre-filter versions published inside the too-new cooldown so a burst of
      // daily releases cannot exhaust the scan budget before reaching an
      // older, confirmable version. Unparseable dates are kept (vet decides).
      const nowMs = Date.now();
      const plausiblySafe = sorted.filter((v) => {
        const ts = Date.parse(v.publishedAt);
        return Number.isNaN(ts) || nowMs - ts >= TOO_NEW_DAYS * 86_400_000;
      });
      for (let i = 0; i < Math.min(RECOMMEND_SCAN_LIMIT, plausiblySafe.length); i++) {
        const candidate = plausiblySafe[i].version;
        const verdict = await this.vet(name, candidate);
        if (verdict && !isBlocked(verdict) && verdict.isOsvChecked) {
          const rec: SafeRecommendation = {
            version: candidate,
            verdict: verdict.verdict,
          };
          recommendCache.set(recKey, rec);
          return rec;
        }
      }
      recommendCache.set(recKey, null);
      return null;
    },
    async vet(name: string, version: string): Promise<PerVersionVerdict | null> {
      const key = `${ecosystem}::${name}@${version}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const ref: PackageRef = { name, ecosystem };
      let out: PerVersionVerdict | null = null;
      try {
        const versions = await adapter.listVersions(ref);
        const advisories = await osv.queryAdvisories(ref, version);
        const verdicts = decideVersion(
          ref,
          versions,
          (v) => (v === version ? advisories : []),
          (v) => v === version, // successful OSV query == isOsvChecked for this version
        );
        out = verdicts.find((v) => v.version === version) ?? {
          version,
          verdict: 'needs_review',
          reason: 'version not found in registry',
          advisories: [],
          isOsvChecked: false,
        };
      } catch (err) {
        // Any lookup failure leaves the version unvalidated. Fail closed:
        // represent as needs_review with isOsvChecked=false (blocked by the gate).
        out = {
          version,
          verdict: 'needs_review',
          reason: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          advisories: [],
          isOsvChecked: false,
        };
      }
      cache.set(key, out);
      return out;
    },
  };
};

/** Snapshot the detected manifest(s) under `cwd` for post-write diffing (FR-5b). */
export const snapshotManifests = (cwd: string): ManifestSnapshot[] => {
  const manifest = findManifest(cwd);
  if (!manifest) return [];
  try {
    return [
      {
        path: manifest.path,
        content: readFileSync(manifest.path, 'utf8'),
      },
    ];
  } catch {
    return [];
  }
};

/** Async post-write scan: surface `flagged` versions that leaked into a manifest. */
export const detectLeaks = async (
  before: ManifestSnapshot[],
  after: ManifestSnapshot[],
  vet: Vetter['vet'],
): Promise<FlaggedLeak[]> => {
  const leaks: FlaggedLeak[] = [];
  for (const snap of after) {
    const prior = before.find((s) => s.path === snap.path);
    const { added } = diffManifests(
      prior?.content ?? '',
      snap.content,
      detectManifest(snap.path)!.kind,
    );
    for (const [name, version] of Object.entries(added)) {
      const v = await vet(name, version);
      // Surface flagged AND (under fail-closed) unvalidated leaks.
      if (v && isBlocked(v)) {
        leaks.push({
          manifestPath: snap.path,
          pkg: {
            name,
            ecosystem: detectManifest(snap.path)!.ecosystem,
          },
          version,
          reason: v.reason,
        });
      }
    }
  }
  return leaks;
};

/** One line of the full-manifest audit report. */
export interface AuditEntry {
  name: string;
  /** Declared spec in the manifest (range or exact). */
  spec: string;
  /** Version actually vetted; null when a range could not resolve to a version. */
  version: string | null;
  verdict: PerVersionVerdict['verdict'] | 'unresolved' | 'workspace';
  reason: string;
  /** Blocked by the gate (respects the fail-open/fail-closed toggle). */
  blocked: boolean;
  /** OSV check did not complete (isOsvChecked === false). */
  unconfirmed: boolean;
}

const toAuditEntry = (
  name: string,
  spec: string,
  version: string | null,
  verdict: PerVersionVerdict | null,
): AuditEntry => ({
  name,
  spec,
  version,
  verdict: verdict ? verdict.verdict : 'unresolved',
  reason: verdict ? verdict.reason : 'could not be resolved/vetted',
  blocked: verdict ? isBlocked(verdict) : false,
  unconfirmed: verdict ? verdict.isOsvChecked === false : false,
});

/**
 * Full-manifest audit: vet EVERY dependency currently in the detected
 * manifest(s), not just recently added ones. Closes the gap the additive
 * gate leaves open (pre-existing vulnerabilities, range->range bumps).
 *
 * For an exact spec the declared version is vetted; for a range the newest
 * version satisfying it (what a fresh install resolves to) is vetted.
 * Blocked respects the fail-open/fail-closed toggle.
 */
export const auditManifest = async (
  vetter: Pick<Vetter, 'manifest' | 'vet' | 'versions'>,
): Promise<AuditEntry[]> => {
  const manifest = vetter.manifest;
  if (!manifest) return [];
  let content: string;
  try {
    content = readFileSync(manifest.path, 'utf8');
  } catch {
    return [];
  }
  const deps = extractDeps(content, manifest.kind);
  const localNames =
    manifest.ecosystem === 'npm' ? npmWorkspaceNames(dirname(manifest.path)) : new Set<string>();
  const out: AuditEntry[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (localNames.has(name)) {
      out.push({
        name,
        spec,
        version: null,
        verdict: 'workspace',
        reason: 'local workspace link (not on the public registry)',
        blocked: false,
        unconfirmed: false,
      });
      continue;
    }
    let version: string | null;
    if (isRangeSpec(spec)) {
      try {
        // Newest published version satisfying the declared range.
        version =
          (await pickExactPin(spec, await vetter.versions(name), async () => false)) ?? null;
      } catch {
        version = null;
      }
    } else {
      version = spec.trim();
    }
    const verdict = version ? await vetter.vet(name, version) : null;
    out.push(toAuditEntry(name, spec, version, verdict));
  }
  return out;
};

/** Audit report for one manifest found under the project root. */
export interface AuditResult {
  /** Absolute path of the audited manifest. */
  path: string;
  ecosystem: Ecosystem;
  entries: AuditEntry[];
  /** Safe-version suggestions for blocked entries of this ecosystem. */
  recommendSafeVersion: Vetter['recommendSafeVersion'];
}

/**
 * Audit every manifest at `cwd` and below (monorepo-aware). One vetter per
 * manifest directory, sharing a single verdict cache so a package that
 * appears in several manifests is only re-vetted against the network once.
 */
export const auditAllManifests = async (
  cwd: string,
  opts: { excludes?: string[]; deps?: VetterDeps } = {},
): Promise<AuditResult[]> => {
  const deps = opts.deps ?? {};
  const cache = deps.cache ?? new Map<string, PerVersionVerdict | null>();
  const results: AuditResult[] = [];
  for (const m of findManifests(cwd, opts.excludes ?? [])) {
    const v = createVetter(dirname(m.path), { ...deps, cache });
    results.push({
      path: m.path,
      ecosystem: m.ecosystem,
      entries: await auditManifest(v),
      recommendSafeVersion: (name: string) => v.recommendSafeVersion(name),
    });
  }
  return results;
};
