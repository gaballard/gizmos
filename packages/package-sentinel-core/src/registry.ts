/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Ecosystem, PackageRef, RegistryAdapter, RegistryVersion } from './contracts.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REGISTRY_URL: Record<Ecosystem, (name: string) => string> = {
  npm: (name) => `https://registry.npmjs.org/${name}`,
  pypi: (name) => `https://pypi.org/pypi/${name}/json`,
  rust: (name) => `https://crates.io/api/v1/crates/${name}`,
};

abstract class BaseAdapter implements RegistryAdapter {
  protected fetchImpl: FetchLike;
  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }
  abstract parseResponse(body: unknown): RegistryVersion[];
  async listVersions(pkg: PackageRef): Promise<RegistryVersion[]> {
    const res = await this.fetchImpl(REGISTRY_URL[pkg.ecosystem](encodeURIComponent(pkg.name)));
    if (!res.ok) throw new Error(`registry http ${res.status} for ${pkg.name}`);
    return this.parseResponse(await res.json());
  }
}

/** npm registry body: `versions` object + `time` map for publish timestamps. */
type TNpmResponse = {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
};

/** npm registry adapter: `versions` object + `time` map for publish timestamps. */
export class NpmAdapter extends BaseAdapter {
  parseResponse(body: unknown): RegistryVersion[] {
    const b = body as TNpmResponse;
    return Object.keys(b?.versions ?? {}).map((version) => ({
      version,
      publishedAt: b?.time?.[version] ?? '',
    }));
  }
}

/** PyPI body: `releases` object with `upload_time` on the first file. */
type TPypiResponse = {
  releases?: Record<string, Array<{ upload_time?: unknown }>>;
};

/** PyPI JSON adapter: `releases` object with `upload_time` on the first file. */
export class PypiAdapter extends BaseAdapter {
  parseResponse(body: unknown): RegistryVersion[] {
    const b = body as TPypiResponse;
    return Object.keys(b?.releases ?? {}).map((version) => ({
      version,
      publishedAt: String(b?.releases?.[version]?.[0]?.upload_time ?? ''),
    }));
  }
}

/** crates.io body: `versions` array of `{ num, created_at }`. */
type TCratesResponse = {
  versions?: Array<{ num?: unknown; created_at?: unknown }>;
};

/** crates.io adapter: `versions` array of `{ num, created_at }`. */
export class CratesAdapter extends BaseAdapter {
  parseResponse(body: unknown): RegistryVersion[] {
    const b = body as TCratesResponse;
    return (b?.versions ?? []).map((v) => ({
      version: String(v?.num ?? ''),
      publishedAt: String(v?.created_at ?? ''),
    }));
  }
}

/** Select the adapter for a detected ecosystem (FR-2). */
export const createAdapter = (ecosystem: Ecosystem): RegistryAdapter => {
  switch (ecosystem) {
    case 'npm':
      return new NpmAdapter();
    case 'pypi':
      return new PypiAdapter();
    case 'rust':
      return new CratesAdapter();
  }
};
