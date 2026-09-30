// SPDX-License-Identifier: Apache-2.0
//
// RESP2 / RESP3 reply encoder. Produces a binary string (one char = one
// byte) that the server writes with the 'latin1' encoding.
//
// A connection speaks RESP2 until it sends `HELLO 3`.

import { MapReply, ReplyError, SimpleString, type Reply } from '../reply.js';

export type Protocol = 2 | 3;

// Simple strings and errors must be single-line.
const oneLine = (s: string): string => (/[\r\n]/.test(s) ? s.replace(/[\r\n]+/g, ' ') : s);

const bulk = (s: string): string => `$${s.length}\r\n${s}\r\n`;

export function encode(reply: Reply | undefined, proto: Protocol = 2): string {
  if (reply === null || reply === undefined) return proto === 3 ? '_\r\n' : '$-1\r\n';
  switch (typeof reply) {
    case 'string':
      return bulk(reply);
    case 'number':
      if (Number.isInteger(reply)) return `:${reply}\r\n`;
      return proto === 3 ? `,${reply}\r\n` : bulk(String(reply));
    case 'bigint':
      return `:${reply}\r\n`;
    default:
      break;
  }
  if (reply instanceof SimpleString) return `+${oneLine(reply.value)}\r\n`;
  if (reply instanceof Error) return encodeError(reply);
  if (reply instanceof MapReply) {
    let out = proto === 3 ? `%${reply.entries.length}\r\n` : `*${reply.entries.length * 2}\r\n`;
    for (const [k, v] of reply.entries) out += encode(k, proto) + encode(v, proto);
    return out;
  }
  if (Array.isArray(reply)) {
    let out = `*${reply.length}\r\n`;
    for (const item of reply) out += encode(item, proto);
    return out;
  }
  throw new TypeError(`cannot encode reply of type ${typeof reply}`);
}

export function encodeError(err: Error): string {
  const message = err instanceof ReplyError ? err.message : `ERR ${err.message}`;
  return `-${oneLine(message)}\r\n`;
}
