/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Advisory, Ecosystem, OsvClient, PackageRef, Severity } from './contracts.ts';

/** Raised when the OSV endpoint cannot be reached / returns non-2xx. */
export class OsvTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsvTransportError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const KNOWN: Severity[] = ['low', 'moderate', 'high', 'critical'];

const normalizeSeverity = (s: unknown): Severity => {
  const v = String(s ?? '').toLowerCase() as Severity;
  return KNOWN.includes(v) ? v : 'unknown';
};

interface OsvEvent {
  introduced?: unknown;
  fixed?: unknown;
  last_affected?: unknown;
}
interface OsvRange {
  events?: OsvEvent[];
}
interface OsvAffected {
  ranges?: OsvRange[];
}
interface OsvVuln {
  id?: unknown;
  summary?: unknown;
  severity?: unknown;
  affected?: OsvAffected[];
}
interface OsvBody {
  vulns?: OsvVuln[];
}

const affectedVersions = (affected: OsvAffected[] | undefined): string[] => {
  const out: string[] = [];
  for (const a of affected ?? []) {
    for (const r of a?.ranges ?? []) {
      for (const e of r?.events ?? []) {
        const v = e?.introduced ?? e?.fixed ?? e?.last_affected;
        if (v != null) out.push(String(v));
      }
    }
  }
  return out;
};

/** Map an OSV query response to normalized advisories (FR-3). */
export const parseOsvResponse = (body: unknown): Advisory[] => {
  const b = body as OsvBody;
  return (b?.vulns ?? []).map((v) => ({
    id: String(v?.id ?? ''),
    summary: String(v?.summary ?? ''),
    severity: normalizeSeverity(v?.severity),
    affectedVersions: affectedVersions(v?.affected),
  }));
};

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  rust: 'crates.io',
};

/**
 * Create an OSV client. Transport failures surface as {@link OsvTransportError}
 * so "unable to check" is never mistaken for "no advisories" (NFR-1).
 */
export const createOsvClient = (fetchImpl: FetchLike = fetch): OsvClient => {
  const query = (pkg: PackageRef, version: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      package: { name: pkg.name, ecosystem: OSV_ECOSYSTEM[pkg.ecosystem] },
      version,
    }),
  });
  return {
    async queryAdvisories(pkg: PackageRef, version: string): Promise<Advisory[]> {
      let res: Response;
      try {
        res = await fetchImpl('https://api.osv.dev/v1/query', query(pkg, version));
      } catch (err) {
        throw new OsvTransportError(`OSV transport failure: ${String(err)}`);
      }
      if (!res.ok) throw new OsvTransportError(`OSV http ${res.status}`);
      return parseOsvResponse(await res.json());
    },
  };
};
