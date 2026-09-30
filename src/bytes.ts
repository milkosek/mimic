// SPDX-License-Identifier: Apache-2.0
//
// Keys and values in MIMIC are binary-safe, just like in Redis.
//
// Internally every key/value is a "binary string": a JS string in which each
// char code is exactly one byte (0-255), i.e. Buffer <-> string via 'latin1'.
// This keeps values compact (V8 stores them as one-byte strings), makes
// STRLEN/APPEND byte-exact, and round-trips arbitrary binary data from RESP
// clients without loss.
//
// Anything that deals with human text (the HTTP/JSON API, log lines) converts
// at the boundary with fromText()/toText().

const ASCII = /^[\x00-\x7f]*$/;

/** Bytes -> binary string. */
export function fromBuffer(buf: Buffer, start = 0, end = buf.length): string {
  return buf.toString('latin1', start, end);
}

/** Binary string -> bytes. */
export function toBuffer(s: string): Buffer {
  return Buffer.from(s, 'latin1');
}

/** Human (UTF-16) text -> binary string holding its UTF-8 bytes. */
export function fromText(s: string): string {
  return ASCII.test(s) ? s : Buffer.from(s, 'utf8').toString('latin1');
}

/** Binary string holding UTF-8 bytes -> human text. Invalid UTF-8 becomes U+FFFD. */
export function toText(s: string): string {
  return ASCII.test(s) ? s : Buffer.from(s, 'latin1').toString('utf8');
}
