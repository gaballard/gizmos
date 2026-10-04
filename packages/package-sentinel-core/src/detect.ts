/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManifestDetection, ManifestKind } from './contracts.ts';

const SUPPORTED: ManifestKind[] = [
  { file: 'package.json', ecosystem: 'npm' },
  { file: 'pyproject.toml', ecosystem: 'pypi' },
  { file: 'requirements.txt', ecosystem: 'pypi' },
  { file: 'Pipfile', ecosystem: 'pypi' },
  { file: 'Cargo.toml', ecosystem: 'rust' },
];

/** Map a bare manifest file name to its kind+ecosystem, or null when unsupported. */
export const detectKindFromName = (name: string): ManifestKind | null => {
  return SUPPORTED.find((k) => k.file === name) ?? null;
};

/** Detect a supported manifest at `path`, returning null when unsupported. */
export const detectManifest = (path: string): ManifestDetection | null => {
  const base = path.split('/').pop() ?? path;
  const kind = detectKindFromName(base);
  if (!kind) return null;
  return { ecosystem: kind.ecosystem, kind, path };
};
