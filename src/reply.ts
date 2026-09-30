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
export const PONG = new SimpleString('PONG');

/** Key/value pairs: a RESP3 map, or a flat [k1, v1, k2, v2, ...] array in RESP2. */
export class MapReply {
  constructor(readonly entries: [Reply, Reply][]) {}
}

export type Reply = string | number | bigint | null | SimpleString | ReplyError | MapReply | Reply[];

/**
 * An error sent back to the client. The message starts with an upper-case
 * error code, as in Redis ("ERR ...", "WRONGTYPE ...", "NOAUTH ...").
 */
export class ReplyError extends Error {
  readonly code: string;
  constructor(message: string, code?: string) {
    const prefix = code ?? (/^[A-Z]+ /.test(message) ? '' : 'ERR');
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
