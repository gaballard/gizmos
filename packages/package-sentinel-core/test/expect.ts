/**
 * Package Sentinel - Prevents agents from installing insecure dependencies.
 * Copyright (C) 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// Minimal jest-style `expect` for the node test runner. Covers exactly the
// matchers these test files use; anything else is a tsc error, on purpose.
import { deepStrictEqual } from 'node:assert/strict';

const deepEq = (actual: unknown, expected: unknown): boolean => {
  try {
    deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

const subset = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true;
  if (
    typeof actual !== 'object' ||
    actual === null ||
    typeof expected !== 'object' ||
    expected === null
  )
    return false;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => subset(actual[i], e))
    );
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return Object.keys(e).every((k) => k in a && subset(a[k], e[k]));
};

/**
 * Build an `expect` surface. When `awaitRejection` is true (via `.rejects`)
 * every matcher first awaits the wrapped promise and operates on the
 * rejection error; a promise that resolves instead fails the assertion.
 */
const expectFor = (actual: any, negated = false, awaitRejection = false): any => {
  const check = (ok: boolean, msg: string): void => {
    if (negated ? ok : !ok) throw new Error(`expect${negated ? '.not' : ''} failed: ${msg}`);
  };
  const run = <T>(fn: (v: any) => T): T | Promise<T> => {
    if (!awaitRejection) return fn(actual);
    return (actual as Promise<unknown>).then(
      () => {
        throw new Error('expected a rejection, but the promise resolved');
      },
      (err: unknown) => fn(err),
    );
  };
  return {
    toBe: (e: unknown) => run((v) => check(v === e, `${String(v)} !== ${String(e)}`)),
    toEqual: (e: unknown) => run((v) => check(deepEq(v, e), 'deep mismatch')),
    toStrictEqual: (e: unknown) => run((v) => check(deepEq(v, e), 'deep mismatch')),
    toBeNull: () => run((v) => check(v === null, `expected null, got ${String(v)}`)),
    toBeUndefined: () => run((v) => check(v === undefined, `expected undefined, got ${String(v)}`)),
    toBeDefined: () => run((v) => check(v !== undefined, 'expected a defined value')),
    toHaveLength: (n: number) =>
      run((v) =>
        check(
          (v as { length?: number })?.length === n,
          `length ${String((v as { length?: number })?.length)} !== ${String(n)}`,
        ),
      ),
    toContain: (e: unknown) =>
      run((v) =>
        check(
          typeof (v as string)?.includes === 'function' && (v as any).includes(e),
          `does not contain ${String(e)}`,
        ),
      ),
    toContainEqual: (e: unknown) =>
      run((v) =>
        check(
          Array.isArray(v) && v.some((x) => deepEq(x, e)),
          `no element deep-equals ${String(e)}`,
        ),
      ),
    toBeInstanceOf: (c: new () => unknown) =>
      run((v) => check(v instanceof c, `not an instance of ${String(c)}`)),
    toMatchObject: (e: unknown) => run((v) => check(subset(v, e), 'subset mismatch')),
    toThrow: (expected?: unknown) =>
      run((v) => {
        let threw = false;
        let err: unknown;
        try {
          (v as () => unknown)();
        } catch (caught) {
          threw = true;
          err = caught;
        }
        check(threw, 'expected to throw');
        if (threw && expected !== undefined) {
          if (typeof expected === 'string')
            check(String(err).includes(expected), `message ${String(err)} lacks "${expected}"`);
          else if (typeof expected === 'function')
            check(
              err instanceof expected,
              `not an instance of ${String((expected as { name?: string }).name)}`,
            );
          else check(err === expected, 'thrown error did not match expected value');
        }
      }),
    get not(): any {
      return expectFor(actual, !negated, awaitRejection);
    },
    get rejects(): any {
      return expectFor(actual, negated, true);
    },
  };
};

export const expect = (actual: any): any => expectFor(actual, false);
