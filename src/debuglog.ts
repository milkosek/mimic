// SPDX-License-Identifier: Apache-2.0
//
// One-line descriptions of commands and replies for --log-level debug
// (a lightweight stand-in for Redis' MONITOR). Only called when debug
// logging is on, so it costs nothing otherwise.

import { MapReply, NullArray, ReplyError, SimpleString, VerbatimString, type Reply } from './reply.js';

const MAX_ARG = 48; // characters shown per argument
const MAX_ARGS = 12; // arguments shown per command

/** Show a binary string readably: UTF-8 if it decodes, escaped bytes otherwise, truncated. */
function show(arg: string): string {
  let text = Buffer.from(arg, 'latin1').toString('utf8');
  if (text.includes('�')) text = arg; // not UTF-8: show the raw bytes (escaped by JSON)
  const quoted = JSON.stringify(text.length > MAX_ARG ? text.slice(0, MAX_ARG) : text);
  return text.length > MAX_ARG ? `${quoted.slice(0, -1)}…"(${arg.length} bytes)` : quoted;
}

/** Escape control characters, so client-supplied text can't start a fake log line. */
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** `SET "hello" "world"`; passwords are masked. */
export function describeCommand(argv: readonly string[]): string {
  const name = clean(argv[0]!.toUpperCase());
  const args = argv.slice(1).map(show);
  if (name === 'AUTH') args.fill('"(redacted)"');
  if (name === 'HELLO') {
    // Walk the options as HELLO parses them: HELLO protover [AUTH user pass] [SETNAME name].
    for (let i = 2; i < argv.length; i++) {
      const opt = argv[i]!.toUpperCase();
      if (opt === 'AUTH' && i + 2 < argv.length) {
        args[i + 1] = '"(redacted)"'; // args is argv without the command name
        i += 2;
      } else if (opt === 'SETNAME') {
        i += 1;
      }
    }
  }
  const shown = args.length > MAX_ARGS ? [...args.slice(0, MAX_ARGS), `… (+${args.length - MAX_ARGS} more)`] : args;
  return [name, ...shown].join(' ');
}

/** `OK`, `(nil)`, `(integer) 5`, `"world"`, `(array of 3)`, `(error) ERR ...`. */
export function describeReply(reply: Reply, depth = 0): string {
  if (reply === null || reply instanceof NullArray) return '(nil)';
  if (typeof reply === 'number' || typeof reply === 'bigint') return `(integer) ${reply}`;
  if (typeof reply === 'string') return show(reply);
  if (reply instanceof SimpleString) return clean(reply.value);
  if (reply instanceof ReplyError) return `(error) ${clean(reply.message)}`; // may quote the command name
  if (reply instanceof VerbatimString) return `(text, ${reply.value.length} bytes)`;
  const list = (items: string[], total: number): string =>
    `[${items.join(', ')}${total > items.length ? `, … (${total} in all)` : ''}]`;
  if (reply instanceof MapReply) {
    if (depth > 0) return `(map of ${reply.entries.length})`;
    const shown = reply.entries.slice(0, 6).map(([k, v]) => `${describeReply(k, 1)}: ${describeReply(v, 1)}`);
    return `{${list(shown, reply.entries.length).slice(1, -1)}}`;
  }
  if (Array.isArray(reply)) {
    if (depth > 0) return `(array of ${reply.length})`;
    return list(reply.slice(0, 8).map((r) => describeReply(r, 1)), reply.length);
  }
  return '(reply)';
}
