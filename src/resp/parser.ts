// SPDX-License-Identifier: Apache-2.0
//
// splitArgs() is a port of sdssplitargs() from Redis 7.0 (src/sds.c),
// Copyright (c) 2006-2015, Salvatore Sanfilippo; (c) 2015, Oran Agra;
// (c) 2015, Redis Labs, Inc. BSD 3-Clause license; see NOTICE and
// licenses/redis-BSD-3-Clause.txt.
//
// Streaming RESP request parser.
//
// Clients send commands as arrays of bulk strings:
//     *3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n
// or, when typed by hand (telnet / nc), as "inline" commands:
//     SET k v\r\n
//
// Usage: push() raw TCP chunks, then call next() until it returns undefined.
// next() hands out ONE command at a time, so the server can run it (and, for
// example, switch to post-AUTH limits) before the next one is parsed - and
// valid commands ahead of a malformed frame still run, like in Redis.
//
// Performance: a multibulk frame is consumed argument by argument and its
// progress is kept between chunks, so a command with 1M arguments is parsed
// in linear time. When a bulk string's length is known, chunks are only
// collected (not copied) until the whole value has arrived.
//
// Error messages match Redis' networking.c, so clients see the same text.

import { fromBuffer } from '../bytes.js';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`Protocol error: ${message}`);
    this.name = 'ProtocolError';
  }
}

export interface ParserLimits {
  /** Max size of one bulk string (Redis: proto-max-bulk-len, 512 MB). */
  maxBulkLength: number;
  /** Max number of arguments in one command (Redis: INT_MAX). */
  maxMultibulkLength: number;
  /** Max length of an inline command / header line (Redis: 64 KB). */
  maxInlineLength: number;
  /**
   * Apply Redis' extra limits for clients that have not authenticated yet:
   * at most 10 arguments and 16 KB per argument.
   */
  unauthenticated?: boolean;
}

const INT_MAX = 2 ** 31 - 1;
const UNAUTH_MAX_MULTIBULK = 10;
const UNAUTH_MAX_BULK = 16 * 1024;

export const DEFAULT_LIMITS: ParserLimits = {
  maxBulkLength: 64 * 1024 * 1024,
  maxMultibulkLength: INT_MAX,
  maxInlineLength: 64 * 1024,
};

/** Redis' limits for clients that have not authenticated yet. */
export const UNAUTHENTICATED_LIMITS: ParserLimits = { ...DEFAULT_LIMITS, unauthenticated: true };

// Once at least this much of a buffer has been consumed and only a small tail
// is left, the tail is copied out so the big buffer can be garbage collected.
const COMPACT_MIN_BYTES = 1024 * 1024;

const CR = 13;
const LF = 10;
const STAR = 42;
const DOLLAR = 36;
const MINUS = 45;
const EMPTY = Buffer.alloc(0);

/**
 * Parse an ASCII integer in buf[start, end) with Redis' string2ll() rules
 * (no leading zeros, no "-0"). NaN when malformed.
 */
function parseIntAt(buf: Buffer, start: number, end: number): number {
  if (start >= end) return NaN;
  let i = start;
  const neg = buf[i] === MINUS;
  if (neg && ++i === end) return NaN;
  if (buf[i] === 48 && (end - i > 1 || neg)) return NaN; // "03", "-0"
  let n = 0;
  for (; i < end; i++) {
    const d = buf[i]! - 48;
    if (d < 0 || d > 9) return NaN;
    n = n * 10 + d;
    if (n > Number.MAX_SAFE_INTEGER) return NaN;
  }
  return neg ? -n : n;
}

// C isspace(): skips between arguments and decides what may follow a closing quote.
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\v' || c === '\f';
// What ends an unquoted argument in sdssplitargs (\v and \f do not).
const endsToken = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\0';
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };

/**
 * Port of Redis' sdssplitargs(): whitespace-separated tokens, "double quotes"
 * with \n \r \t \b \a \xHH escapes, 'single quotes' with \' only. Returns null
 * for unbalanced quotes or a closing quote not followed by a space.
 */
export function splitArgs(line: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && isSpace(line[i])) i++;
    if (i >= n) return out;
    let inDouble = false;
    let inSingle = false;
    let done = false;
    let cur = '';
    while (!done) {
      const c = line[i];
      if (inDouble) {
        if (c === undefined) return null;
        if (c === '\\' && line[i + 1] === 'x' && isHex(line[i + 2]) && isHex(line[i + 3])) {
          cur += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
          i += 3;
        } else if (c === '\\' && i + 1 < n) {
          i++;
          const e = line[i]!;
          cur += ESCAPES[e] ?? e;
        } else if (c === '"') {
          if (i + 1 < n && !isSpace(line[i + 1])) return null; // closing quote must be followed by a space
          done = true;
        } else {
          cur += c;
        }
      } else if (inSingle) {
        if (c === undefined) return null;
        if (c === '\\' && line[i + 1] === "'") {
          i++;
          cur += "'";
        } else if (c === "'") {
          if (i + 1 < n && !isSpace(line[i + 1])) return null;
          done = true;
        } else {
          cur += c;
        }
      } else if (c === undefined || endsToken(c)) {
        done = true;
      } else if (c === '"') {
        inDouble = true;
      } else if (c === "'") {
        inSingle = true;
      } else {
        cur += c;
      }
      if (i < n) i++;
    }
    out.push(cur);
  }
}

export class RespParser {
  /** Limits applied to frames parsed from now on (the server swaps these after AUTH). */
  limits: ParserLimits;

  #buf: Buffer = EMPTY; // consolidated bytes, consumed up to #pos
  #pos = 0;
  #pending: Buffer[] = []; // chunks received but not yet appended to #buf
  #pendingLen = 0;
  #need = 0; // bytes (from #pos) required before parsing can make progress
  // Waiting for the end of a line (inline command or header): don't re-parse
  // until a chunk with a LF arrives, so a line sent byte by byte stays O(n).
  #waitingForLine = false;
  #pendingHasLF = false;

  // A multibulk frame in progress: arguments parsed so far and how many remain.
  #args: string[] | null = null;
  #remaining = 0;
  #argsBytes = 0; // size of the arguments in #args

  constructor(limits: Partial<ParserLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Bytes received but not yet parsed. */
  get pending(): number {
    return this.#buf.length - this.#pos + this.#pendingLen;
  }

  /**
   * What the client is making us hold: unparsed bytes plus the arguments of
   * a command that is still arriving (Redis counts both against
   * client-query-buffer-limit).
   */
  get buffered(): number {
    return this.pending + this.#argsBytes;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#pending.push(chunk);
    this.#pendingLen += chunk.length;
    if (this.#waitingForLine && !this.#pendingHasLF && chunk.indexOf(LF) !== -1) this.#pendingHasLF = true;
  }

  /** Parse and return the next complete command, or undefined if more data is needed. Throws ProtocolError. */
  next(): string[] | undefined {
    for (;;) {
      if (this.pending === 0 || this.pending < this.#need) return undefined;
      // Still inside an unfinished line and nothing new ends it: nothing to do
      // (unless the line is now too long - then parse, which reports the error).
      if (this.#waitingForLine && !this.#pendingHasLF && this.pending <= this.limits.maxInlineLength + 2) return undefined;
      this.#consolidate();
      this.#need = 0;
      this.#waitingForLine = false;
      this.#pendingHasLF = false;

      if (this.#args === null) {
        if (this.#buf[this.#pos] !== STAR) {
          const inline = this.#parseInline();
          if (inline === undefined) return undefined;
          if (inline.length === 0) continue; // blank line
          return inline;
        }
        if (!this.#parseMultibulkHeader()) return undefined;
        if (this.#args === null) continue; // *0 / *-1: empty command, skip
      }

      while (this.#remaining > 0) {
        if (!this.#parseBulk()) return undefined;
      }
      const args = this.#args!;
      this.#args = null;
      this.#argsBytes = 0;
      return args;
    }
  }

  // Append pending chunks to the unconsumed part of the buffer (one copy).
  #consolidate(): void {
    if (this.#pendingLen === 0) return;
    const rest = this.#pos < this.#buf.length ? this.#buf.subarray(this.#pos) : EMPTY;
    const parts = rest.length ? [rest, ...this.#pending] : this.#pending;
    this.#buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, rest.length + this.#pendingLen);
    this.#pos = 0;
    this.#pending = [];
    this.#pendingLen = 0;
  }

  #consume(to: number): void {
    this.#pos = to;
    const rest = this.#buf.length - this.#pos;
    if (rest === 0) {
      this.#buf = EMPTY; // let go of the old chunk
      this.#pos = 0;
    } else if (this.#pos >= COMPACT_MIN_BYTES && rest < this.#pos) {
      // A small tail must not keep a big (e.g. 32 MB) buffer alive.
      this.#buf = Buffer.from(this.#buf.subarray(this.#pos));
      this.#pos = 0;
    }
  }

  /** Mark that more bytes are needed; `atLeast` is the total (from #pos) known to be required. */
  #wait(atLeast = 0): false {
    this.#need = Math.max(atLeast, this.pending + 1);
    return false;
  }

  /** Mark that the end of a line is needed. */
  #waitLine(): false {
    this.#wait();
    this.#waitingForLine = true;
    this.#pendingHasLF = false;
    return false;
  }

  /** Index of the CR of the CRLF ending the line that starts at `from`; -1 if incomplete. */
  #lineEnd(from: number, what: string): number {
    const buf = this.#buf;
    const cr = buf.indexOf(CR, from);
    if (cr === -1 || cr + 1 >= buf.length) {
      if (buf.length - from > this.limits.maxInlineLength) throw new ProtocolError(`too big ${what}`);
      return -1;
    }
    if (cr - from > this.limits.maxInlineLength) throw new ProtocolError(`too big ${what}`);
    if (buf[cr + 1] !== LF) throw new ProtocolError(`invalid ${what}`);
    return cr;
  }

  #parseMultibulkHeader(): boolean {
    const start = this.#pos;
    const end = this.#lineEnd(start + 1, 'mbulk count string');
    if (end < 0) return this.#waitLine();
    const count = parseIntAt(this.#buf, start + 1, end);
    // Same checks, same order as Redis: the absolute limit first, then the pre-AUTH one.
    if (Number.isNaN(count) || count > INT_MAX) throw new ProtocolError('invalid multibulk length');
    if (this.limits.unauthenticated && count > UNAUTH_MAX_MULTIBULK) throw new ProtocolError('unauthenticated multibulk length');
    if (count > this.limits.maxMultibulkLength) throw new ProtocolError('invalid multibulk length');
    this.#consume(end + 2);
    if (count > 0) {
      this.#args = [];
      this.#remaining = count;
    }
    return true;
  }

  #parseBulk(): boolean {
    const buf = this.#buf;
    const start = this.#pos;
    if (start >= buf.length) return this.#wait();
    if (buf[start] !== DOLLAR) throw new ProtocolError(`expected '$', got '${String.fromCharCode(buf[start]!)}'`);
    const end = this.#lineEnd(start + 1, 'bulk count string');
    if (end < 0) return this.#waitLine();
    const len = parseIntAt(buf, start + 1, end);
    if (Number.isNaN(len) || len < 0 || len > this.limits.maxBulkLength) throw new ProtocolError('invalid bulk length');
    if (this.limits.unauthenticated && len > UNAUTH_MAX_BULK) throw new ProtocolError('unauthenticated bulk length');
    const dataStart = end + 2;
    const dataEnd = dataStart + len;
    if (dataEnd + 2 > buf.length) return this.#wait(dataEnd + 2 - start);
    if (buf[dataEnd] !== CR || buf[dataEnd + 1] !== LF) throw new ProtocolError('expected CRLF after bulk data');
    this.#args!.push(fromBuffer(buf, dataStart, dataEnd));
    this.#argsBytes += len;
    this.#remaining--;
    this.#consume(dataEnd + 2);
    return true;
  }

  #parseInline(): string[] | undefined {
    const buf = this.#buf;
    const start = this.#pos;
    const lf = buf.indexOf(LF, start);
    if (lf === -1) {
      if (buf.length - start > this.limits.maxInlineLength) throw new ProtocolError('too big inline request');
      this.#waitLine();
      return undefined;
    }
    if (lf - start > this.limits.maxInlineLength) throw new ProtocolError('too big inline request');
    const lineEnd = lf > start && buf[lf - 1] === CR ? lf - 1 : lf;
    const args = splitArgs(fromBuffer(buf, start, lineEnd));
    if (args === null) throw new ProtocolError('unbalanced quotes in request');
    this.#consume(lf + 1);
    return args;
  }
}
