// SPDX-License-Identifier: Apache-2.0
//
// globMatch() is a port of stringmatchlen() from Redis 7.0 (src/util.c),
// Copyright (c) 2009-2012, Salvatore Sanfilippo, BSD 3-Clause license;
// see NOTICE and licenses/redis-BSD-3-Clause.txt.

import { createHash, timingSafeEqual } from 'node:crypto';
import { notInteger, ReplyError } from './reply.js';

// Redis' string2ll(): an optional '-', then either "0" or digits without a
// leading zero. No '+', no spaces, no "-0", no "007".
const INT_RE = /^(?:0|-?[1-9]\d*)$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Parse a Redis integer argument into a JS safe integer. */
export function toInt(value: string | number, err: () => ReplyError = notInteger): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw err();
  }
  // "-" + 19 digits is the longest int64; checking the length first also keeps
  // a multi-megabyte digit string from reaching BigInt().
  if (value.length > 20 || !INT_RE.test(value)) throw err();
  const n = Number(value);
  if (Number.isSafeInteger(n)) return n;
  // Valid for Redis (int64) but beyond 2^53: saturate. Indices, counts and
  // offsets behave the same; expire times use toInt64() for exact checks.
  const big = BigInt(value);
  if (!inInt64(big)) throw err();
  return big < 0n ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
}

/** Parse a stored value as a signed 64-bit integer (INCR & friends), exactly like Redis. */
export function toInt64(value: string, err: () => ReplyError = notInteger): bigint {
  if (!INT_RE.test(value) || value.length > 20) throw err();
  const n = BigInt(value);
  if (n < INT64_MIN || n > INT64_MAX) throw err();
  return n;
}

/** True if the bigint fits in a signed 64-bit integer (Redis long long). */
export function inInt64(n: bigint): boolean {
  return n >= INT64_MIN && n <= INT64_MAX;
}

export function checkInt64(n: bigint): bigint {
  if (n < INT64_MIN || n > INT64_MAX) throw new ReplyError('increment or decrement would overflow');
  return n;
}

const STAR = 42; // *
const QMARK = 63; // ?
const LBRACKET = 91; // [
const RBRACKET = 93; // ]
const BACKSLASH = 92; // \\
const CARET = 94; // ^
const DASH = 45; // -
const lower = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

/**
 * Glob matching exactly like Redis' stringmatchlen() (util.c): `*`, `?`,
 * `[abc]`, `[^abc]`, `[a-z]` (reversed ranges are swapped), `\\` escapes, and
 * the same quirks (an unterminated `[` is a class running to the end of the
 * pattern, `[]` matches nothing). Keys are binary strings, so matching is
 * byte-wise.
 *
 * No regular expressions: a pattern like `*?*?*?*?...x` made a regex
 * backtrack exponentially (the bug behind Redis' CVE-2022-36021). This port
 * keeps Redis' protections - stop retrying longer matches for earlier `*`s
 * once the rest of the pattern has failed everywhere, and a nesting limit -
 * so the cost stays polynomial.
 */
export function globMatch(pattern: string, str: string, nocase = false): boolean {
  return matchAt(pattern, 0, str, 0, nocase, { skipLonger: false }, 0);
}

function matchAt(p: string, pi: number, s: string, si: number, nocase: boolean, state: { skipLonger: boolean }, nesting: number): boolean {
  if (nesting > 1000) return false;
  const plen = p.length;
  const slen = s.length;
  const same = (a: number, b: number): boolean => (nocase ? lower(a) === lower(b) : a === b);

  while (pi < plen && si < slen) {
    switch (p.charCodeAt(pi)) {
      case STAR: {
        while (pi + 1 < plen && p.charCodeAt(pi + 1) === STAR) pi++;
        if (pi + 1 === plen) return true; // trailing * matches the rest
        while (si < slen) {
          if (matchAt(p, pi + 1, s, si, nocase, state, nesting + 1)) return true;
          if (state.skipLonger) return false;
          si++;
        }
        // The rest of the pattern matched nowhere in the rest of the string,
        // so letting an earlier * swallow more cannot help either.
        state.skipLonger = true;
        return false;
      }
      case QMARK:
        si++;
        break;
      case LBRACKET: {
        pi++;
        const not = pi < plen && p.charCodeAt(pi) === CARET;
        if (not) pi++;
        const c = s.charCodeAt(si);
        let match = false;
        for (;;) {
          if (pi < plen && p.charCodeAt(pi) === BACKSLASH && plen - pi >= 2) {
            pi++;
            if (same(p.charCodeAt(pi), c)) match = true;
          } else if (pi < plen && p.charCodeAt(pi) === RBRACKET) {
            break;
          } else if (pi >= plen) {
            pi--; // unterminated class: it ends with the pattern
            break;
          } else if (plen - pi >= 3 && p.charCodeAt(pi + 1) === DASH) {
            let start = p.charCodeAt(pi);
            let end = p.charCodeAt(pi + 2);
            let cc = c;
            if (start > end) [start, end] = [end, start];
            if (nocase) {
              start = lower(start);
              end = lower(end);
              cc = lower(cc);
            }
            pi += 2;
            if (cc >= start && cc <= end) match = true;
          } else if (same(p.charCodeAt(pi), c)) {
            match = true;
          }
          pi++;
        }
        if (not) match = !match;
        if (!match) return false;
        si++;
        break;
      }
      case BACKSLASH:
      default:
        // A backslash escapes the next character, which is then matched literally.
        if (p.charCodeAt(pi) === BACKSLASH && plen - pi >= 2) pi++;
        if (!same(p.charCodeAt(pi), s.charCodeAt(si))) return false;
        si++;
        break;
    }
    pi++;
    if (si >= slen) {
      while (pi < plen && p.charCodeAt(pi) === STAR) pi++;
      break;
    }
  }
  return pi >= plen && si >= slen;
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
