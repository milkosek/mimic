// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from 'node:crypto';
import { notInteger, ReplyError } from './reply.js';

const INT_RE = /^-?\d+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Parse a Redis integer argument into a JS safe integer. */
export function toInt(value: string | number, err: () => ReplyError = notInteger): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw err();
  }
  if (!INT_RE.test(value)) throw err();
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw err();
  return n;
}

/** Parse a stored value as a signed 64-bit integer (INCR & friends), exactly like Redis. */
export function toInt64(value: string, err: () => ReplyError = notInteger): bigint {
  if (!INT_RE.test(value) || value.length > 20) throw err();
  const n = BigInt(value);
  if (n < INT64_MIN || n > INT64_MAX) throw err();
  return n;
}

export function checkInt64(n: bigint): bigint {
  if (n < INT64_MIN || n > INT64_MAX) throw new ReplyError('increment or decrement would overflow');
  return n;
}

/**
 * Redis glob -> RegExp. Supports *, ?, [abc], [^abc], [a-z] and backslash
 * escapes. Matching is byte-wise because keys are binary strings.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      re += escapeRe(pattern[++i]!);
    } else if (c === '*') {
      re += '[\\s\\S]*';
    } else if (c === '?') {
      re += '[\\s\\S]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith('^');
      if (negate) body = body.slice(1);
      body = body.replace(/[\\\]]/g, '\\$&');
      re += `[${negate ? '^' : ''}${body}]`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`${re}$`);
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Normalise Redis start/stop indices (negative counts from the end). */
export function normaliseRange(start: number, stop: number, length: number): [number, number] {
  const s = Math.max(start < 0 ? length + start : start, 0);
  const e = Math.min(stop < 0 ? length + stop : stop, length - 1);
  return [s, e];
}

/** Constant-time comparison for passwords/tokens (compares SHA-256 digests so lengths never leak). */
export function safeEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'latin1').digest();
  const b = createHash('sha256').update(expected, 'latin1').digest();
  return timingSafeEqual(a, b);
}
