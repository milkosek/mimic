// SPDX-License-Identifier: Apache-2.0
//
// RESP TCP server: speaks the Redis wire protocol (RESP2, and RESP3 after
// HELLO 3) so that redis-cli and standard Redis client libraries (ioredis,
// node-redis, redis-py, Predis, Jedis, ...) can use MIMIC as a drop-in cache.
//
// Also owns per-connection state: AUTH, client name, protocol version and
// transactions (MULTI/EXEC/DISCARD with optimistic WATCH).

import net from 'node:net';
import { commandKeys, NO_AUTH_COMMANDS, resolveCommand, type CommandSpec, type ConnectionHandle, type InfoSections } from '../commands.js';
import { OK, ReplyError, SimpleString, type Reply } from '../reply.js';
import type { Store } from '../store.js';
import { safeEqual } from '../util.js';
import { encode, encodeError } from './encoder.js';
import { DEFAULT_LIMITS, ProtocolError, RespParser, type ParserLimits } from './parser.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export interface RespServerOptions {
  /** Password for AUTH (user "default"). Unset = no authentication. */
  password?: string;
  /** Refuse connections beyond this many clients. */
  maxClients?: number;
  /** Close connections idle for this many seconds (0 = never, the Redis default). */
  idleTimeoutSec?: number;
  limits?: Partial<ParserLimits>;
  logger?: Logger;
  /** Extra INFO sections (e.g. HTTP port) contributed by the daemon. */
  extraInfo?: () => InfoSections;
}

export interface RespServer extends net.Server {
  readonly stats: { connectedClients: number; totalConnections: number; totalCommands: number; rejectedConnections: number };
  /** Disconnect all clients (used on shutdown). */
  disconnectAll(): void;
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
  protocol: 2 | 3 = 2;
  closing = false;
  // transaction state
  multi: string[][] | null = null;
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
    if (!expected) return username === null ? 'nopass' : 'ok';
    const userOk = username === null || username === 'default';
    if (userOk && safeEqual(password, expected)) {
      this.authenticated = true;
      return 'ok';
    }
    return 'wrongpass';
  }

  reset(): void {
    this.name = '';
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
      `db=0`,
      `cmd=${this.lastCommand.toLowerCase()}`,
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

  // ---- WATCH bookkeeping: key -> connections watching it
  const watchers = new Map<string, Set<Connection>>();

  const touch = (keys: string[]): void => {
    for (const k of keys) for (const c of watchers.get(k) ?? []) c.dirty = true;
  };
  const touchAll = (): void => {
    for (const set of watchers.values()) for (const c of set) c.dirty = true;
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
    conn.multiError = false;
    unwatch(conn);
  };

  /** Run a resolved command; errors become error replies. */
  function dispatch(conn: Connection, argv: string[], spec: CommandSpec): Reply {
    let reply: Reply;
    try {
      reply = spec.run({ store, conn, serverInfo }, argv.slice(1));
    } catch (err) {
      if (err instanceof ReplyError) return err;
      logger?.error(`[resp] command ${argv[0]} failed`, err);
      return new ReplyError('internal error');
    }
    if (watchers.size > 0 && spec.flags.includes('write')) {
      if (/^FLUSH(ALL|DB)$/i.test(argv[0]!)) touchAll();
      else touch(commandKeys(spec, argv));
    }
    return reply;
  }

  function exec(conn: Connection): Reply {
    const queued = conn.multi ?? [];
    const failed = conn.multiError;
    const aborted = conn.dirty;
    discard(conn);
    if (failed) return new ReplyError('Transaction discarded because of previous errors.', 'EXECABORT');
    if (aborted) return null; // a watched key changed: the client retries
    // Node runs this loop without yielding, so the transaction is atomic.
    return queued.map((argv) => dispatch(conn, argv, resolveCommand(argv)));
  }

  function run(conn: Connection, argv: string[]): Reply {
    const name = argv[0]!.toUpperCase();
    conn.lastCommand = name;
    stats.totalCommands++;
    if (!conn.authenticated && !NO_AUTH_COMMANDS.has(name)) {
      return new ReplyError('Authentication required.', 'NOAUTH');
    }

    let spec: CommandSpec;
    try {
      spec = resolveCommand(argv);
    } catch (err) {
      if (conn.multi) conn.multiError = true;
      return err as ReplyError;
    }

    if (conn.multi) {
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
        for (const key of argv.slice(1)) {
          conn.watching.add(key);
          let set = watchers.get(key);
          if (!set) watchers.set(key, (set = new Set()));
          set.add(conn);
        }
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

  const server = net.createServer((socket) => {
    if (clients.size >= maxClients) {
      stats.rejectedConnections++;
      socket.end('-ERR max number of clients reached\r\n');
      return;
    }

    const conn = new Connection(++nextId, socket, shared);
    const parser = new RespParser(opts.limits);
    clients.set(conn.id, conn);
    stats.totalConnections++;
    stats.connectedClients = clients.size;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    if (opts.idleTimeoutSec && opts.idleTimeoutSec > 0) {
      socket.setTimeout(opts.idleTimeoutSec * 1000, () => socket.destroy());
    }

    socket.on('data', (chunk: Buffer) => {
      if (conn.closing) return;
      conn.lastActive = Date.now();

      let commands: string[][];
      let protocolError: Error | undefined;
      try {
        commands = parser.push(chunk);
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err;
        commands = [];
        protocolError = err;
      }

      // Pipelined commands in one chunk produce one write.
      let out = '';
      for (const argv of commands) {
        out += encode(run(conn, argv), conn.protocol);
        if (conn.closing) break;
      }

      if (protocolError) {
        // Like Redis: report the protocol error and drop the connection.
        out += encodeError(new ReplyError(protocolError.message));
        conn.closing = true;
      }

      if (conn.closing) {
        socket.end(out, 'latin1');
      } else if (out && !socket.write(out, 'latin1')) {
        socket.pause(); // backpressure: stop reading until the client drains replies
      }
    });

    socket.on('drain', () => socket.resume());
    socket.on('error', () => {
      /* ECONNRESET and friends: the 'close' handler cleans up */
    });
    socket.on('close', () => {
      unwatch(conn);
      clients.delete(conn.id);
      stats.connectedClients = clients.size;
    });
  }) as RespServer;

  Object.defineProperty(server, 'stats', { get: () => ({ ...stats, connectedClients: clients.size }) });
  server.disconnectAll = () => {
    for (const c of clients.values()) c.socket.destroy();
  };
  return server;
}
