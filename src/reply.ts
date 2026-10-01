// SPDX-License-Identifier: Apache-2.0
//
// Values a command can return. They map 1:1 onto RESP2 reply types:
//   string       -> bulk string        ($)
//   number/bigint-> integer            (:)   (non-integer numbers -> bulk string)
//   null         -> null bulk string   ($-1)
//   SimpleString -> simple string      (+)
//   ReplyError   -> error              (-)
//   Reply[]      -> array              (*)
//   MapReply     -> map (%) in RESP3, flat key/value array in RESP2
//
// RESP3 differences are applied by the encoder: null -> `_`, maps -> `%`.

export class SimpleString {
  constructor(readonly value: string) {}
  toJSON(): string {
    return this.value;
  }
  toString(): string {
    return this.value;
  }
}

export const OK = new SimpleString('OK');

/** Text meant for humans (INFO, CLIENT INFO/LIST): RESP3 verbatim string `=…txt:`, RESP2 bulk string. */
export class VerbatimString {
  constructor(readonly value: string) {}
  toJSON(): string {
    return this.value;
  }
}

/** A null *array* (RESP2 `*-1`, RESP3 `_`): EXEC aborted by WATCH, LPOP key count on a missing key. */
export class NullArray {
  toJSON(): null {
    return null;
  }
}
export const NULL_ARRAY = new NullArray();
export const PONG = new SimpleString('PONG');

/** Key/value pairs: a RESP3 map, or a flat [k1, v1, k2, v2, ...] array in RESP2. */
export class MapReply {
  constructor(readonly entries: [Reply, Reply][]) {}
}

export type Reply = string | number | bigint | null | NullArray | VerbatimString | SimpleString | ReplyError | MapReply | Reply[];

// Error codes that may already start a message. Anything else gets "ERR "
// (e.g. "GT and LT options ..." or "MULTI calls can not be nested" are ERR errors).
const KNOWN_CODES = /^(ERR|WRONGTYPE|NOAUTH|WRONGPASS|NOPROTO|EXECABORT|NOPERM|NOSCRIPT|BUSY|LOADING|READONLY|OOM) /;

/**
 * An error sent back to the client. The message starts with an upper-case
 * error code, as in Redis ("ERR ...", "WRONGTYPE ...", "NOAUTH ...").
 */
export class ReplyError extends Error {
  readonly code: string;
  constructor(message: string, code?: string) {
    const prefix = code ?? (KNOWN_CODES.test(message) ? '' : 'ERR');
    super(prefix ? `${prefix} ${message}` : message);
    this.code = this.message.split(' ', 1)[0]!;
    this.name = 'ReplyError';
  }
}

export class WrongTypeError extends ReplyError {
  constructor() {
    super('Operation against a key holding the wrong kind of value', 'WRONGTYPE');
  }
}

export const syntaxError = (): ReplyError => new ReplyError('syntax error');

export const notInteger = (): ReplyError => new ReplyError('value is not an integer or out of range');
