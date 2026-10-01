// SPDX-License-Identifier: Apache-2.0
//
// Library entry point: embed MIMIC in your own Node.js process, or use the
// `mimic` CLI (dist/cli.js) to run it as a daemon.

export { Database, Store } from './store.js';
export type { Entry, EntryType, KeyspaceListener, SetOptions, SetResult, ExpireOptions, GetExOptions, ScanOptions, StoreOptions, StoreInfo } from './store.js';
export { Keyspace } from './keyspace.js';
export { COMMANDS, execute } from './commands.js';
export type { CommandContext, CommandSpec, ConnectionHandle, InfoSections } from './commands.js';
export { MapReply, NULL_ARRAY, NullArray, OK, PONG, ReplyError, SimpleString, VerbatimString, WrongTypeError } from './reply.js';
export { MemoryGuard, OOM_MESSAGE } from './memory.js';
export type { MemoryGuardSource } from './memory.js';
export type { Reply } from './reply.js';
export { createRespServer } from './resp/server.js';
export type { Logger, RespServer, RespServerOptions } from './resp/server.js';
export { RespParser, ProtocolError } from './resp/parser.js';
export type { ParserLimits } from './resp/parser.js';
export { encode } from './resp/encoder.js';
export { createHttpServer } from './http/server.js';
export type { HttpServerOptions } from './http/server.js';
export { startDaemon } from './daemon.js';
export type { Daemon } from './daemon.js';
export { loadConfig, ConfigError } from './config.js';
export type { MimicConfig, LogLevel } from './config.js';
export { fromBuffer, toBuffer, fromText, toText } from './bytes.js';
export { VERSION } from './version.js';
