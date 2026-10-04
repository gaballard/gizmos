/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Ecosystem,
  type FlaggedLeak,
  type ManifestKind,
  type ManifestSnapshot,
  type PerVersionVerdict,
} from './contracts.ts';
import { detectKindFromName } from './detect.ts';

/** Extract a {name: version} dependency map from manifest content. */
export const extractDeps = (content: string, kind: ManifestKind): Record<string, string> => {
  switch (kind.file) {
    case 'package.json': {
      let json: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      } | null = null;
      try {
        json = JSON.parse(content);
      } catch {
        return {};
      }
      return {
        ...(json?.dependencies ?? {}),
        ...(json?.devDependencies ?? {}),
      };
    }
    case 'requirements.txt': {
      // `name==ver`, `name>=ver`, `name~=ver`, etc. Keep the operator so range
      // specs stay pinnable (a version spec is required).
      const out: Record<string, string> = {};
      for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('-')) continue;
        const m = line.match(/^([\w.-]+)\s*(==|>=|<=|!=|~=|>|<)\s*(\S+)/);
        if (m) out[m[1]] = `${m[2]}${m[3]}`;
      }
      return out;
    }
    default: {
      // TOML-ish: `name = "version"` or `name = { version = "..." }` under [dependencies]
      const out: Record<string, string> = {};
      for (const raw of content.split('\n')) {
        const m = raw.match(/^\s*([\w.-]+)\s*=\s*(?:\{\s*version\s*=\s*)?["'](.+)["']/);
        if (m) out[m[1]] = m[2];
      }
      return out;
    }
  }
};

const kindFromPath = (path: string): ManifestKind => {
  return (
    detectKindFromName(path.split('/').pop() ?? '') ?? {
      file: 'package.json',
      ecosystem: 'npm',
    }
  );
};

const ecoFromPath = (path: string): Ecosystem => {
  return kindFromPath(path).ecosystem;
};

/** Diff two dependency maps into added / removed sets (version bumps = added). */
export const diffManifests = (
  beforeContent: string,
  afterContent: string,
  kind: ManifestKind,
): { added: Record<string, string>; removed: Record<string, string> } => {
  const before = extractDeps(beforeContent, kind);
  const after = extractDeps(afterContent, kind);
  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  for (const [name, ver] of Object.entries(after)) if (before[name] !== ver) added[name] = ver;
  for (const [name, ver] of Object.entries(before)) if (!(name in after)) removed[name] = ver;
  return { added, removed };
};

/**
 * Firing Point 2 validation: surface a `flagged` version that leaked into a
 * manifest after a tool ran (FR-5b). No-op for `safe` changes / unchanged.
 */
export const validatePostWrite = (
  before: ManifestSnapshot[],
  after: ManifestSnapshot[],
  verdictOf: (pkg: string, version: string) => PerVersionVerdict | null,
): FlaggedLeak[] => {
  const leaks: FlaggedLeak[] = [];
  for (const a of after) {
    const b = before.find((s) => s.path === a.path);
    const kind = kindFromPath(a.path);
    const { added } = diffManifests(b?.content ?? '', a.content, kind);
    for (const [name, version] of Object.entries(added)) {
      const v = verdictOf(name, version);
      if (v?.verdict === 'flagged') {
        leaks.push({
          manifestPath: a.path,
          pkg: { name, ecosystem: ecoFromPath(a.path) },
          version,
          reason: v.reason,
        });
      }
    }
  }
  return leaks;
};
