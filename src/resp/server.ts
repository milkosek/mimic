// SPDX-License-Identifier: Apache-2.0
//
// RESP TCP server: speaks the Redis wire protocol (RESP2, and RESP3 after
// HELLO 3) so that redis-cli and standard Redis client libraries (ioredis,
// node-redis, redis-py, Predis, Jedis, ...) can use MIMIC as a drop-in cache.
//
// Also owns per-connection state: AUTH, client name, protocol version and
// transactions (MULTI/EXEC/DISCARD with optimistic WATCH).
//
// Hardening, as in Redis:
//   * clients that have not authenticated get tiny parser limits
//     (10 arguments, 16 KB per argument);
//   * each client's unparsed input is capped (client-query-buffer-limit);
//   * a "POST" or "Host:" line (an HTTP request sent to this port, e.g. by a
//     web page) drops the connection before anything else runs.

import net from 'node:net';
import { checkMemory, NO_AUTH_COMMANDS, resolveCommand, type CommandSpec, type ConnectionHandle, type InfoSections } from '../commands.js';
import { describeCommand, describeReply } from '../debuglog.js';
import { OOM_MESSAGE } from '../memory.js';
import { NULL_ARRAY, OK, ReplyError, SimpleString, type Reply } from '../reply.js';
import type { Store } from '../store.js';
import { safeEqual } from '../util.js';
import { encode, encodeError } from './encoder.js';
import { DEFAULT_LIMITS, ProtocolError, RespParser, UNAUTHENTICATED_LIMITS, type ParserLimits } from './parser.js';

const OOM_ERROR = `OOM ${OOM_MESSAGE}`;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  /** Present only when debug logging is on: every connection and command is logged. */
  debug?: (msg: string) => void;
}

export interface RespServerOptions {
  /** Password for AUTH (user "default"). Unset = no authentication. */
  password?: string;
  /** Refuse connections beyond this many clients. */
  maxClients?: number;
  /** Close connections idle for this many seconds (0 = never, the Redis default). */
  idleTimeoutSec?: number;
  limits?: Partial<ParserLimits>;
  /** Max unparsed input buffered per client (Redis: client-query-buffer-limit, 1 GB). */
  maxQueryBufferBytes?: number;
  /** @internal A closing connection is destroyed after this long without progress (default 5 s). */
  closeGraceMs?: number;
  logger?: Logger;
  /** Extra INFO sections (e.g. HTTP port) contributed by the daemon. */
  extraInfo?: () => InfoSections;
}

export interface RespServer extends net.Server {
  readonly stats: { connectedClients: number; totalConnections: number; totalCommands: number; rejectedConnections: number };
  /** Disconnect all clients (used on shutdown). */
  disconnectAll(): void;
  /** Stop listening to store changes (done automatically on 'close'; call it if listen() failed). */
  dispose(): void;
}

// Replies are written in pieces of about this size, so a big pipeline never
// builds one giant string (V8 strings top out around 512 MB) and backpressure
// can kick in between commands.
const WRITE_CHUNK = 64 * 1024;
// A closing connection is destroyed once its peer has read nothing for this long.
const CLOSE_GRACE_MS = 5000;

/** Bytes still waiting to be sent: Node's buffer and libuv's write queue. */
function sendProgress(socket: net.Socket): [number, number] {
  // writableLength stays at the full size of a large write until it completes;
  // libuv's writeQueueSize (internal but long-stable) shrinks as the kernel
  // accepts data, so it shows a slow reader is still reading.
  const handle = (socket as unknown as { _handle?: { writeQueueSize?: number } })._handle;
  return [socket.writableLength, handle?.writeQueueSize ?? 0];
}

/**
 * End the socket after `out`, then destroy it when everything has been sent.
 * If the peer stops reading (or never closes its side), give up once nothing
 * has moved for a whole grace period - but never while a slow reader is still
 * receiving a large final reply.
 */
function endAndRelease(socket: net.Socket, out: string, graceMs = CLOSE_GRACE_MS): void {
  socket.end(out, 'latin1', () => socket.destroy());
  let last = sendProgress(socket);
  let lastProgress = Date.now();
  const timer = setInterval(() => {
    if (socket.destroyed) return clearInterval(timer);
    const now = sendProgress(socket);
    if (now[0] < last[0] || now[1] < last[1]) lastProgress = Date.now();
    last = now;
    if (Date.now() - lastProgress >= graceMs) {
      clearInterval(timer);
      socket.destroy();
    }
  }, Math.max(50, Math.floor(graceMs / 4)));
  timer.unref();
  socket.once('close', () => clearInterval(timer));
}

const QUEUED = new SimpleString('QUEUED');

class Connection implements ConnectionHandle {
  readonly id: number;
  readonly createdAt = Date.now();
  lastActive = Date.now();
  lastCommand = 'NULL';
  name = '';
  libName = '';
  libVer = '';
  authenticated: boolean;
  db = 0;
  protocol: 2 | 3 = 2;
  closing = false;
  // Output is backed up: stop *running* commands until 'drain'. We keep
  // reading input, though: synchronous clients (redis-py, Predis, Jedis)
  // send a whole pipeline before reading any reply, so if we stopped reading
  // both sides would wait for each other forever. --max-query-buffer bounds
  // what can pile up meanwhile.
  waitingForDrain = false;
  // transaction state
  multi: string[][] | null = null;
  multiBytes = 0; // size of the queued commands (counts against the query buffer limit)
  multiError = false;
  dirty = false; // a WATCHed key was modified
  readonly watching = new Set<string>();

  constructor(
    id: number,
    readonly socket: net.Socket,
    readonly server: { password?: string; clients: Map<number, Connection> },
  ) {
    this.id = id;
    this.authenticated = !server.password;
  }

  authenticate(username: string | null, password: string): 'ok' | 'wrongpass' | 'nopass' {
    const expected = this.server.password;
    const userOk = username === null || username === 'default'; // the only user, as in Redis without ACLs
    if (!expected) {
      if (username === null) return 'nopass';
      return userOk ? 'ok' : 'wrongpass';
    }
    if (userOk && safeEqual(password, expected)) {
      this.authenticated = true;
      return 'ok';
    }
    return 'wrongpass';
  }

  reset(): void {
    this.name = '';
    this.db = 0;
    this.protocol = 2;
    this.authenticated = !this.server.password;
  }

  requestClose(): void {
    this.closing = true;
  }

  describe(): string {
    const now = Date.now();
    const s = this.socket;
    return [
      `id=${this.id}`,
      `addr=${s.remoteAddress}:${s.remotePort}`,
      `laddr=${s.localAddress}:${s.localPort}`,
      `name=${this.name}`,
      `age=${Math.floor((now - this.createdAt) / 1000)}`,
      `idle=${Math.floor((now - this.lastActive) / 1000)}`,
      `flags=${this.multi ? 'x' : 'N'}`,
      `db=${this.db}`,
      'sub=0',
      'psub=0',
      'ssub=0',
      `multi=${this.multi ? this.multi.length : -1}`,
      `cmd=${this.lastCommand.toLowerCase()}`,
      'user=default',
      'redir=-1',
      `resp=${this.protocol}`,
      `lib-name=${this.libName}`,
      `lib-ver=${this.libVer}`,
    ].join(' ');
  }

  listAll(): string {
    return [...this.server.clients.values()].map((c) => `${c.describe()}\n`).join('');
  }
}

export function createRespServer(store: Store, opts: RespServerOptions = {}): RespServer {
  const logger = opts.logger;
  const maxClients = opts.maxClients ?? 10_000;
  const clients = new Map<number, Connection>();
  const shared: { password?: string; clients: Map<number, Connection> } = { clients };
  if (opts.password) shared.password = opts.password;
  let nextId = 0;

  const stats = { connectedClients: 0, totalConnections: 0, totalCommands: 0, rejectedConnections: 0 };

  const serverInfo = (): InfoSections => {
    const extra = opts.extraInfo?.() ?? {};
    const address = server.address();
    return {
      ...extra,
      Server: {
        tcp_port: typeof address === 'object' && address ? address.port : 0,
        idle_timeout: opts.idleTimeoutSec ?? 0,
        max_bulk_bytes: opts.limits?.maxBulkLength ?? DEFAULT_LIMITS.maxBulkLength,
        ...extra['Server'],
      },
      Clients: { connected_clients: clients.size, maxclients: maxClients, ...extra['Clients'] },
      Stats: {
        total_connections_received: stats.totalConnections,
        total_commands_processed: stats.totalCommands,
        rejected_connections: stats.rejectedConnections,
        ...extra['Stats'],
      },
    };
  };

  // ---- WATCH bookkeeping: (db, key) -> connections watching it. The store
  // reports every real modification (from RESP, HTTP, expiry or embedding code).
  const watchers = new Map<string, Set<Connection>>();
  const watchKey = (db: number, key: string): string => `${db}\u0000${key}`; // db digits never contain NUL
  const unsubscribe = store.onChange((key, db, existed) => {
    if (watchers.size === 0) return;
    if (key === null) {
      // FLUSHDB / FLUSHALL / SWAPDB: only watched keys that existed are modified.
      const prefix = `${db}\u0000`;
      for (const [k, set] of watchers) {
        if (k.startsWith(prefix) && existed?.(k.slice(prefix.length))) for (const c of set) c.dirty = true;
      }
    } else {
      for (const c of watchers.get(watchKey(db, key)) ?? []) c.dirty = true;
    }
  });

  const watch = (conn: Connection, keys: string[]): void => {
    // Drop keys that are already expired first, so they don't count as "modified" later.
    store.db(conn.db).exists(keys);
    for (const key of keys) {
      const wk = watchKey(conn.db, key);
      conn.watching.add(wk);
      let set = watchers.get(wk);
      if (!set) watchers.set(wk, (set = new Set()));
      set.add(conn);
    }
  };
  const unwatch = (conn: Connection): void => {
    for (const k of conn.watching) {
      const set = watchers.get(k);
      set?.delete(conn);
      if (set?.size === 0) watchers.delete(k);
    }
    conn.watching.clear();
    conn.dirty = false;
  };
  const discard = (conn: Connection): void => {
    conn.multi = null;
    conn.multiBytes = 0;
    conn.multiError = false;
    unwatch(conn);
  };

  /** Run a resolved command; errors become error replies. */
  function dispatch(conn: Connection, argv: string[], spec: CommandSpec, guardMemory = true): Reply {
    try {
      const ctx = { store, db: store.db(conn.db), conn, serverInfo };
      if (guardMemory) checkMemory(ctx, spec, argv);
      return spec.run(ctx, argv.slice(1));
    } catch (err) {
      if (err instanceof ReplyError) return err;
      logger?.error(`[resp] command ${argv[0]} failed`, err);
      return new ReplyError('internal error');
    }
  }

  function exec(conn: Connection): Reply {
    // A watched key that expired since WATCH counts as modified (Redis >= 6.0.9):
    // looking it up deletes it lazily, which marks this connection dirty.
    for (const wk of conn.watching) {
      const sep = wk.indexOf('\u0000');
      store.db(Number(wk.slice(0, sep))).exists([wk.slice(sep + 1)]);
    }
    const queued = conn.multi ?? [];
    const failed = conn.multiError;
    const aborted = conn.dirty;
    discard(conn);
    // Like Redis, EXEC of a transaction with memory-growing commands is itself
    // refused while over the limit; once running, the queued commands are not
    // re-checked (all or nothing).
    if (store.memory.enabled && queued.some((argv) => resolveCommand(argv).flags.includes('denyoom')) && store.memory.overLimit()) {
      return new ReplyError(`Transaction discarded because of: ${OOM_ERROR}`, 'EXECABORT');
    }
    if (failed) return new ReplyError('Transaction discarded because of previous errors.', 'EXECABORT');
    if (aborted) return NULL_ARRAY; // a watched key changed: the client retries
    // Node runs this loop without yielding, so the transaction is atomic.
    return queued.map((argv) => dispatch(conn, argv, resolveCommand(argv), false));
  }

  function run(conn: Connection, argv: string[]): Reply {
    const name = argv[0]!.toUpperCase();
    // CLIENT INFO shows subcommands as Redis does, e.g. "client|info".
    conn.lastCommand = (name === 'CLIENT' || name === 'CONFIG' || name === 'COMMAND') && argv[1] ? `${name}|${argv[1]}` : name;
    stats.totalCommands++;

    // Same order as Redis' processCommand(): unknown command and arity errors
    // come before the authentication check.
    let spec: CommandSpec;
    try {
      spec = resolveCommand(argv);
    } catch (err) {
      if (conn.multi && name === 'EXEC') {
        // A broken EXEC ends the transaction (Redis: execCommandAbort).
        discard(conn);
        return new ReplyError(`Transaction discarded because of: ${(err as ReplyError).message.replace(/^ERR /, '')}`, 'EXECABORT');
      }
      if (conn.multi) conn.multiError = true;
      return err as ReplyError;
    }
    if (!conn.authenticated && !NO_AUTH_COMMANDS.has(name)) {
      if (conn.multi) conn.multiError = true;
      return new ReplyError('Authentication required.', 'NOAUTH');
    }

    if (conn.multi) {
      // Redis 7.0: while over the memory limit, queuing anything (even GET:
      // the queue itself grows) is refused and fails the transaction.
      if (name !== 'EXEC' && name !== 'DISCARD' && name !== 'QUIT' && name !== 'RESET' && store.memory.enabled) {
        let bytes = 0;
        for (const a of argv) bytes += a.length;
        if (store.memory.overLimit(bytes)) {
          conn.multiError = true;
          return new ReplyError(OOM_ERROR);
        }
      }
      switch (name) {
        case 'EXEC':
          return exec(conn);
        case 'DISCARD':
          discard(conn);
          return OK;
        case 'MULTI':
          return new ReplyError('MULTI calls can not be nested');
        case 'WATCH':
          return new ReplyError('WATCH inside MULTI is not allowed');
        case 'QUIT':
        case 'RESET':
          discard(conn);
          return dispatch(conn, argv, spec);
        default:
          conn.multi.push(argv);
          for (const a of argv) conn.multiBytes += a.length;
          return QUEUED;
      }
    }

    switch (name) {
      case 'MULTI':
        conn.multi = [];
        return OK;
      case 'EXEC':
        return new ReplyError('EXEC without MULTI');
      case 'DISCARD':
        return new ReplyError('DISCARD without MULTI');
      case 'WATCH':
        watch(conn, argv.slice(1));
        return OK;
      case 'UNWATCH':
        unwatch(conn);
        return OK;
      case 'RESET':
        discard(conn);
        break;
      default:
        break;
    }
    return dispatch(conn, argv, spec);
  }

  // Redis' securityWarningCommand(): these "commands" only ever come from an
  // HTTP request that was sent to the RESP port (cross-protocol scripting).
  const isHttpProbe = (argv: string[]): boolean => {
    const first = argv[0]!.toLowerCase();
    return first === 'post' || first === 'host:';
  };

  const normalLimits: ParserLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const limitsFor = (conn: Connection): ParserLimits => (conn.authenticated ? normalLimits : UNAUTHENTICATED_LIMITS);
  const maxQueryBuffer = opts.maxQueryBufferBytes ?? 1024 * 1024 * 1024;

  /** Close after flushing `out` (or at once, for silent drops). */
  function finishClose(conn: Connection, out: string, silent: boolean): void {
    if (silent) conn.socket.destroy();
    else endAndRelease(conn.socket, out, opts.closeGraceMs);
  }

  /**
   * Run every complete command the parser has, writing replies as we go. Stops
   * early when the socket's buffer is full (continued on 'drain'), when the
   * connection is closing, or when more input is needed.
   */
  function pump(conn: Connection, parser: RespParser): void {
    const socket = conn.socket;
    let out = '';
    let silent = false;
    // Returns false when the kernel buffer is full: wait for 'drain'.
    const flush = (): boolean => {
      if (!out) return true;
      const ok = socket.write(out, 'latin1');
      out = '';
      return ok;
    };
    try {
      for (;;) {
        parser.limits = limitsFor(conn); // AUTH / RESET change the limits for the next command
        if (conn.closing) break;
        const argv = parser.next();
        if (argv === undefined) break;
        if (isHttpProbe(argv)) {
          logger?.warn(
            `[resp] possible security attack: ${socket.remoteAddress} sent an HTTP request ("${argv[0]}") to the RESP port - connection aborted`,
          );
          conn.closing = true;
          silent = true; // like Redis: no reply, just drop it
          break;
        }
        let reply: string;
        try {
          if (logger?.debug) {
            const db = conn.db;
            const result = run(conn, argv);
            logger.debug(`[resp] client ${conn.id} db${db}: ${describeCommand(argv)} -> ${describeReply(result)}`);
            reply = encode(result, conn.protocol);
          } else {
            reply = encode(run(conn, argv), conn.protocol);
          }
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          reply = encodeError(new ReplyError('reply is too large to send')); // > V8's maximum string length
        }
        if (out.length + reply.length > WRITE_CHUNK && !flush()) {
          out = reply;
          conn.waitingForDrain = true; // backpressure: run nothing more until the client drains replies
          break;
        }
        out += reply;
      }
      const held = parser.buffered + conn.multiBytes;
      if (!conn.closing && held > maxQueryBuffer) {
        logger?.warn(`[resp] closing client ${conn.id}: query buffer of ${held} bytes exceeds the limit`);
        out += encodeError(new ReplyError('Protocol error: client query buffer exceeds limit'));
        conn.closing = true;
      }
    } catch (err) {
      // Protocol error: report it and drop the connection, like Redis. Replies
      // to the valid commands before the bad frame are kept.
      if (err instanceof ProtocolError) {
        out += encodeError(new ReplyError(err.message));
      } else {
        logger?.error(`[resp] unexpected error on client ${conn.id}`, err);
        out += encodeError(new ReplyError('internal error'));
      }
      conn.closing = true;
    }

    if (conn.closing) {
      conn.waitingForDrain = false;
      finishClose(conn, out, silent);
    } else if (!flush()) {
      conn.waitingForDrain = true;
    }
  }

  /** Input arriving while replies are backed up: buffer it, within the query buffer limit. */
  function bufferWhileBlocked(conn: Connection, parser: RespParser): void {
    const held = parser.buffered + conn.multiBytes;
    if (held <= maxQueryBuffer) return;
    logger?.warn(`[resp] closing client ${conn.id}: query buffer of ${held} bytes exceeds the limit (client is not reading replies)`);
    conn.closing = true;
    conn.waitingForDrain = false;
    // Like Redis (freeClientAsync): no reply, the client is not reading anyway.
    finishClose(conn, '', true);
  }

  const server = net.createServer((socket) => {
    // Always first: an unhandled 'error' (e.g. ECONNRESET) would crash the process.
    socket.on('error', () => {
      /* the 'close' handler cleans up */
    });

    if (clients.size >= maxClients) {
      stats.rejectedConnections++;
      endAndRelease(socket, '-ERR max number of clients reached\r\n', opts.closeGraceMs);
      return;
    }

    const conn = new Connection(++nextId, socket, shared);
    const parser = new RespParser(limitsFor(conn));
    clients.set(conn.id, conn);
    stats.totalConnections++;
    stats.connectedClients = clients.size;
    logger?.debug?.(`[resp] client ${conn.id} connected from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    if (opts.idleTimeoutSec && opts.idleTimeoutSec > 0) {
      socket.setTimeout(opts.idleTimeoutSec * 1000, () => socket.destroy());
    }

    socket.on('data', (chunk: Buffer) => {
      if (conn.closing) return;
      conn.lastActive = Date.now();
      parser.push(chunk);
      if (conn.waitingForDrain) bufferWhileBlocked(conn, parser);
      else pump(conn, parser);
    });
    socket.on('drain', () => {
      if (!conn.waitingForDrain || conn.closing) return;
      conn.waitingForDrain = false;
      pump(conn, parser); // run what was received meanwhile
    });
    socket.on('close', () => {
      logger?.debug?.(`[resp] client ${conn.id} disconnected`);
      unwatch(conn);
      clients.delete(conn.id);
      stats.connectedClients = clients.size;
    });
  }) as RespServer;

  server.on('close', unsubscribe);
  server.dispose = () => {
    unsubscribe();
  };
  Object.defineProperty(server, 'stats', { get: () => ({ ...stats, connectedClients: clients.size }) });
  server.disconnectAll = () => {
    for (const c of clients.values()) c.socket.destroy();
  };
  return server;
}
