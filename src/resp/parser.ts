// SPDX-License-Identifier: Apache-2.0
//
// Streaming RESP request parser.
//
// Clients send commands as arrays of bulk strings:
//     *3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n
// or, when typed by hand (telnet / nc), as "inline" commands:
//     SET k v\r\n
//
// The parser is fed raw TCP chunks and returns every complete command it can
// find (pipelining). Partial frames are kept until more data arrives. Once a
// frame header tells us how many bytes are needed, chunks are only buffered
// (not re-parsed) until enough have arrived, so large values cost O(n).

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
  /** Max number of arguments in one command. */
  maxMultibulkLength: number;
  /** Max length of an inline command / header line. */
  maxInlineLength: number;
}

export const DEFAULT_LIMITS: ParserLimits = {
  maxBulkLength: 64 * 1024 * 1024,
  maxMultibulkLength: 1024 * 1024,
  maxInlineLength: 64 * 1024,
};

const CR = 13;
const LF = 10;
const STAR = 42;
const DOLLAR = 36;
const MINUS = 45;
const EMPTY = Buffer.alloc(0);

type Frame = { args: string[]; end: number };

/** Parse an ASCII integer in buf[start, end). NaN when malformed. */
function parseIntAt(buf: Buffer, start: number, end: number): number {
  if (start >= end) return NaN;
  let i = start;
  const neg = buf[i] === MINUS;
  if (neg && ++i === end) return NaN;
  let n = 0;
  for (; i < end; i++) {
    const d = buf[i]! - 48;
    if (d < 0 || d > 9) return NaN;
    n = n * 10 + d;
    if (n > Number.MAX_SAFE_INTEGER) return NaN;
  }
  return neg ? -n : n;
}

// Inline command tokenizer: whitespace separated, with "double" (escapes) and 'single' quotes.
const TOKEN = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\')*)'|(\S+)/g;
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '"': '"', '\\': '\\' };

function tokenizeInline(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      out.push(m[1].replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e: string) =>
        e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e),
      ));
    } else if (m[2] !== undefined) {
      out.push(m[2].replace(/\\'/g, "'"));
    } else {
      out.push(m[3]!);
    }
  }
  return out;
}

export class RespParser {
  readonly #limits: ParserLimits;
  #chunks: Buffer[] = [];
  #length = 0; // total buffered bytes
  #need = 0; // bytes required before it is worth parsing again

  constructor(limits: Partial<ParserLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Bytes buffered but not yet parsed. */
  get pending(): number {
    return this.#length;
  }

  /** Feed a chunk; returns the complete commands found. Throws ProtocolError. */
  push(chunk: Buffer): string[][] {
    if (chunk.length === 0) return [];
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    if (this.#length < this.#need) return [];

    const buf = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#length);
    const commands: string[][] = [];
    let offset = 0;
    this.#need = 0;
    while (offset < buf.length) {
      const frame = this.#parseOne(buf, offset);
      if (!frame) break;
      offset = frame.end;
      if (frame.args.length > 0) commands.push(frame.args);
    }

    const rest = offset === buf.length ? EMPTY : buf.subarray(offset);
    this.#chunks = rest.length ? [rest] : [];
    this.#length = rest.length;
    return commands;
  }

  /** Mark the frame starting at `start` incomplete; `minBytes` = bytes known to be required. */
  #incomplete(buf: Buffer, start: number, minBytes = 0): undefined {
    this.#need = Math.max(minBytes, buf.length - start + 1);
    return undefined;
  }

  /** Index of the CR in the next CRLF at or after `from`, -1 if not yet received. */
  #lineEnd(buf: Buffer, from: number, what: string): number {
    const cr = buf.indexOf(CR, from);
    if (cr === -1 || cr + 1 >= buf.length) {
      if (buf.length - from > this.#limits.maxInlineLength) throw new ProtocolError(`too big ${what}`);
      return -1;
    }
    if (cr - from > this.#limits.maxInlineLength) throw new ProtocolError(`too big ${what}`);
    if (buf[cr + 1] !== LF) throw new ProtocolError(`invalid ${what}`);
    return cr;
  }

  #parseOne(buf: Buffer, start: number): Frame | undefined {
    if (buf[start] !== STAR) return this.#parseInline(buf, start);

    const headerEnd = this.#lineEnd(buf, start + 1, 'mbulk count string');
    if (headerEnd < 0) return this.#incomplete(buf, start);
    const count = parseIntAt(buf, start + 1, headerEnd);
    if (Number.isNaN(count) || count > this.#limits.maxMultibulkLength) {
      throw new ProtocolError('invalid multibulk length');
    }
    let pos = headerEnd + 2;
    if (count <= 0) return { args: [], end: pos };

    const args = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      if (pos >= buf.length) return this.#incomplete(buf, start);
      if (buf[pos] !== DOLLAR) {
        throw new ProtocolError(`expected '$', got '${String.fromCharCode(buf[pos]!)}'`);
      }
      const lenEnd = this.#lineEnd(buf, pos + 1, 'bulk count string');
      if (lenEnd < 0) return this.#incomplete(buf, start);
      const len = parseIntAt(buf, pos + 1, lenEnd);
      if (Number.isNaN(len) || len < 0 || len > this.#limits.maxBulkLength) {
        throw new ProtocolError('invalid bulk length');
      }
      const dataStart = lenEnd + 2;
      const dataEnd = dataStart + len;
      if (dataEnd + 2 > buf.length) return this.#incomplete(buf, start, dataEnd + 2 - start);
      if (buf[dataEnd] !== CR || buf[dataEnd + 1] !== LF) throw new ProtocolError('expected CRLF after bulk data');
      args[i] = fromBuffer(buf, dataStart, dataEnd);
      pos = dataEnd + 2;
    }
    return { args, end: pos };
  }

  #parseInline(buf: Buffer, start: number): Frame | undefined {
    const lf = buf.indexOf(LF, start);
    if (lf === -1) {
      if (buf.length - start > this.#limits.maxInlineLength) throw new ProtocolError('too big inline request');
      return this.#incomplete(buf, start);
    }
    const lineEnd = lf > start && buf[lf - 1] === CR ? lf - 1 : lf;
    const line = fromBuffer(buf, start, lineEnd);
    const args = tokenizeInline(line);
    return { args, end: lf + 1 };
  }
}
