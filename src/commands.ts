// SPDX-License-Identifier: Apache-2.0
//
// Redis command table. Each command declares its arity the way Redis does
// (including the command name; negative = "at least"), which drives argument
// validation and the COMMAND reply that clients may introspect.

import { MapReply, OK, PONG, ReplyError, SimpleString, syntaxError, type Reply } from './reply.js';
import type { ExpireOptions, GetExOptions, SetOptions, Store } from './store.js';
import { globToRegExp, toInt, toInt64 } from './util.js';
import { NAME, REDIS_COMPAT_VERSION, VERSION } from './version.js';

/** What a transport (the RESP server) exposes about the current connection. */
export interface ConnectionHandle {
  readonly id: number;
  name: string;
  libName: string;
  libVer: string;
  authenticated: boolean;
  /** RESP protocol version spoken on this connection (HELLO switches it). */
  protocol: 2 | 3;
  /** 'nopass' when the server has no password configured. */
  authenticate(username: string | null, password: string): 'ok' | 'wrongpass' | 'nopass';
  /** RESET: drop name and authentication state. */
  reset(): void;
  /** Close the connection after the current reply has been written. */
  requestClose(): void;
  /** CLIENT INFO line for this connection. */
  describe(): string;
  /** CLIENT LIST output for all connections. */
  listAll(): string;
}

export type InfoSections = Record<string, Record<string, string | number>>;

export interface CommandContext {
  store: Store;
  /** Present for RESP connections; absent over HTTP. */
  conn?: ConnectionHandle;
  /** Extra INFO sections supplied by the server (clients, stats, ports). */
  serverInfo?: () => InfoSections;
}

export interface CommandSpec {
  arity: number;
  flags: string[];
  /** [firstKey, lastKey, step] as in COMMAND's reply. */
  keys: [number, number, number];
  run(ctx: CommandContext, args: string[]): Reply;
}

// ------------------------------------------------------------------- helpers

const int = (v: string): number => toInt(v);
const bigint = (v: string): bigint => toInt64(v);
const positiveInt = (v: string): number => {
  const n = toInt(v);
  if (n < 0) throw new ReplyError('value is out of range, must be positive');
  return n;
};

function pairs(cmd: string, args: string[], offset = 0): [string, string][] {
  const rest = args.length - offset;
  if (rest === 0 || rest % 2 !== 0) throw new ReplyError(`wrong number of arguments for '${cmd}' command`);
  const out: [string, string][] = [];
  for (let i = offset; i < args.length; i += 2) out.push([args[i]!, args[i + 1]!]);
  return out;
}

// SET key value [NX|XX] [GET] [EX s|PX ms|EXAT ts|PXAT ts|KEEPTTL]
function parseSetOptions(tokens: string[]): SetOptions {
  const o: SetOptions = {};
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!.toUpperCase();
    const val = (): number => {
      if (i + 1 >= tokens.length) throw syntaxError();
      return int(tokens[++i]!);
    };
    if (flag === 'NX') o.nx = true;
    else if (flag === 'XX') o.xx = true;
    else if (flag === 'GET') o.get = true;
    else if (flag === 'KEEPTTL') o.keepttl = true;
    else if (flag === 'EX') o.ex = val();
    else if (flag === 'PX') o.px = val();
    else if (flag === 'EXAT') o.exat = val();
    else if (flag === 'PXAT') o.pxat = val();
    else throw syntaxError();
  }
  return o;
}

function parseGetExOptions(tokens: string[]): GetExOptions {
  const o: GetExOptions = {};
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!.toUpperCase();
    const val = (): number => {
      if (i + 1 >= tokens.length) throw syntaxError();
      return int(tokens[++i]!);
    };
    if (flag === 'PERSIST') o.persist = true;
    else if (flag === 'EX') o.ex = val();
    else if (flag === 'PX') o.px = val();
    else if (flag === 'EXAT') o.exat = val();
    else if (flag === 'PXAT') o.pxat = val();
    else throw syntaxError();
  }
  return o;
}

function parseExpireOptions(tokens: string[]): ExpireOptions {
  const o: ExpireOptions = {};
  for (const t of tokens) {
    const flag = t.toUpperCase();
    if (flag === 'NX' || flag === 'XX' || flag === 'GT' || flag === 'LT') {
      o[flag.toLowerCase() as keyof ExpireOptions] = true;
    } else {
      throw new ReplyError(`Unsupported option ${t}`);
    }
  }
  return o;
}

function parseScanCursor(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) > 0xffffffff) throw new ReplyError('invalid cursor');
  return Number(v);
}

function parseScanOptions(tokens: string[]): { match?: string; count?: number; type?: string } {
  const o: { match?: string; count?: number; type?: string } = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i]!.toUpperCase();
    const value = tokens[i + 1];
    if (value === undefined) throw syntaxError();
    if (flag === 'MATCH') o.match = value;
    else if (flag === 'COUNT') {
      o.count = int(value);
      if (o.count < 1) throw syntaxError();
    } else if (flag === 'TYPE') o.type = value.toLowerCase();
    else throw syntaxError();
  }
  return o;
}

function flushArgs(args: string[]): void {
  if (args.length > 1 || (args[0] && !/^(a?sync)$/i.test(args[0]))) throw syntaxError();
}

function needConn(ctx: CommandContext): ConnectionHandle {
  if (!ctx.conn) throw new ReplyError('this command is only available over the RESP protocol');
  return ctx.conn;
}

// --------------------------------------------------------------------- INFO

function formatInfo(ctx: CommandContext, wanted: string[]): string {
  const s = ctx.store.info();
  const extra = ctx.serverInfo?.() ?? {};
  const mem = process.memoryUsage();
  const human = (b: number): string => `${(b / 1024 / 1024).toFixed(2)}M`;
  const sections: InfoSections = {
    Server: {
      redis_version: REDIS_COMPAT_VERSION,
      [`${NAME}_version`]: VERSION,
      redis_mode: 'standalone',
      os: `${process.platform} ${process.arch}`,
      arch_bits: process.arch.includes('64') ? 64 : 32,
      node_version: process.version,
      process_id: process.pid,
      uptime_in_seconds: s.uptimeSec,
      uptime_in_days: Math.floor(s.uptimeSec / 86400),
      ...extra['Server'],
    },
    Clients: { ...extra['Clients'] },
    Memory: {
      used_memory: s.heapUsedBytes,
      used_memory_human: human(s.heapUsedBytes),
      used_memory_rss: mem.rss,
      used_memory_rss_human: human(mem.rss),
      maxmemory: 0,
      maxmemory_policy: 'noeviction',
    },
    Persistence: { loading: 0, rdb_bgsave_in_progress: 0, aof_enabled: 0 },
    Stats: {
      keyspace_hits: s.hits,
      keyspace_misses: s.misses,
      expired_keys: s.expiredLazy + s.expiredActive,
      [`${NAME}_expired_keys_lazy`]: s.expiredLazy,
      [`${NAME}_expired_keys_active`]: s.expiredActive,
      [`${NAME}_expire_cycles`]: s.cycles,
      [`${NAME}_last_expire_cycle_ms`]: s.lastCycleMs,
      ...extra['Stats'],
    },
    Replication: { role: 'master', connected_slaves: 0 },
    Keyspace: s.keys > 0 ? { db0: `keys=${s.keys},expires=${s.keysWithTtl},avg_ttl=0` } : {},
  };

  const all = wanted.length === 0 || wanted.some((w) => /^(all|everything|default)$/i.test(w));
  const lines: string[] = [];
  for (const [name, fields] of Object.entries(sections)) {
    if (!all && !wanted.some((w) => w.toLowerCase() === name.toLowerCase())) continue;
    if (lines.length) lines.push('');
    lines.push(`# ${name}`);
    for (const [k, v] of Object.entries(fields)) lines.push(`${k}:${v}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

// Read-only view of settings some clients and tools probe with CONFIG GET.
function configParams(ctx: CommandContext): Record<string, string> {
  const c = ctx.store.info().config;
  return {
    maxmemory: '0',
    'maxmemory-policy': 'noeviction',
    save: '',
    appendonly: 'no',
    databases: '1',
    timeout: String(ctx.serverInfo?.()['Server']?.['idle_timeout'] ?? 0),
    hz: String(Math.max(1, Math.round(1000 / c.cleanupIntervalMs))),
    'proto-max-bulk-len': String(ctx.serverInfo?.()['Server']?.['max_bulk_bytes'] ?? 0),
  };
}

// -------------------------------------------------------------------- table

const K1: [number, number, number] = [1, 1, 1];
const NOKEYS: [number, number, number] = [0, 0, 0];
const ALLKEYS: [number, number, number] = [1, -1, 1];

const spec = (arity: number, flags: string[], keys: [number, number, number], run: CommandSpec['run']): CommandSpec => ({
  arity,
  flags,
  keys,
  run,
});

const R = ['readonly', 'fast'];
const W = ['write', 'fast'];

export const COMMANDS: Record<string, CommandSpec> = {
  // connection / server
  PING: spec(-1, ['fast'], NOKEYS, (_, a) => {
    if (a.length > 1) throw new ReplyError("wrong number of arguments for 'ping' command");
    return a[0] ?? PONG;
  }),
  ECHO: spec(2, ['fast'], NOKEYS, (_, a) => a[0]!),
  TIME: spec(1, ['fast'], NOKEYS, () => {
    const ms = Date.now();
    return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
  }),
  INFO: spec(-1, [], NOKEYS, (ctx, a) => formatInfo(ctx, a)),
  DBSIZE: spec(1, R, NOKEYS, (ctx) => ctx.store.dbsize()),
  FLUSHALL: spec(-1, ['write'], NOKEYS, (ctx, a) => (flushArgs(a), ctx.store.flushall(), OK)),
  FLUSHDB: spec(-1, ['write'], NOKEYS, (ctx, a) => (flushArgs(a), ctx.store.flushall(), OK)),
  COMMAND: spec(-1, [], NOKEYS, (_, a) => commandReply(a)),
  CONFIG: spec(-2, ['admin'], NOKEYS, (ctx, a) => {
    const sub = a[0]!.toUpperCase();
    if (sub === 'GET') {
      if (a.length < 2) throw new ReplyError("wrong number of arguments for 'config|get' command");
      const params = configParams(ctx);
      const res = a.slice(1).map((p) => globToRegExp(p.toLowerCase()));
      return new MapReply(Object.entries(params).filter(([k]) => res.some((re) => re.test(k))));
    }
    if (sub === 'RESETSTAT') return OK;
    if (sub === 'SET') throw new ReplyError('CONFIG SET is not supported; configure MIMIC with flags or MIMIC_* environment variables');
    throw new ReplyError(`unknown subcommand '${a[0]}'. Try CONFIG HELP.`);
  }),

  AUTH: spec(-2, ['fast', 'no-auth'], NOKEYS, (ctx, a) => {
    const conn = needConn(ctx);
    if (a.length > 2) throw syntaxError();
    const [user, pass] = a.length === 2 ? [a[0]!, a[1]!] : [null, a[0]!];
    const result = conn.authenticate(user, pass);
    if (result === 'nopass') {
      throw new ReplyError(
        'AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
      );
    }
    if (result === 'wrongpass') throw new ReplyError('invalid username-password pair or user is disabled.', 'WRONGPASS');
    return OK;
  }),
  HELLO: spec(-1, ['fast', 'no-auth'], NOKEYS, (ctx, a) => {
    const conn = needConn(ctx);
    let proto = conn.protocol;
    let i = 0;
    if (a.length > 0) {
      const v = toInt(a[0]!, () => new ReplyError('Protocol version is not an integer or out of range'));
      if (v !== 2 && v !== 3) throw new ReplyError('unsupported protocol version', 'NOPROTO');
      proto = v;
      i = 1;
    }
    let name: string | undefined;
    for (; i < a.length; i++) {
      const opt = a[i]!.toUpperCase();
      if (opt === 'AUTH' && i + 2 < a.length) {
        const r = conn.authenticate(a[i + 1]!, a[i + 2]!);
        if (r === 'wrongpass') throw new ReplyError('invalid username-password pair or user is disabled.', 'WRONGPASS');
        i += 2;
      } else if (opt === 'SETNAME' && i + 1 < a.length) {
        name = a[++i]!;
      } else {
        throw new ReplyError(`Syntax error in HELLO option '${a[i]}'`);
      }
    }
    if (!conn.authenticated) {
      throw new ReplyError(
        'HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time',
        'NOAUTH',
      );
    }
    if (name !== undefined) conn.name = name;
    conn.protocol = proto;
    return new MapReply([
      ['server', 'redis'],
      ['version', REDIS_COMPAT_VERSION],
      ['proto', proto],
      ['id', conn.id],
      ['mode', 'standalone'],
      ['role', 'master'],
      ['modules', []],
    ]);
  }),
  QUIT: spec(-1, ['fast', 'no-auth'], NOKEYS, (ctx) => {
    ctx.conn?.requestClose();
    return OK;
  }),
  RESET: spec(1, ['fast', 'no-auth'], NOKEYS, (ctx) => {
    const conn = needConn(ctx);
    conn.reset();
    return new SimpleString('RESET');
  }),
  // Transactions are handled by the RESP server (they need per-connection state).
  MULTI: spec(1, ['fast'], NOKEYS, (ctx) => (needConn(ctx), OK)),
  EXEC: spec(1, [], NOKEYS, (ctx) => (needConn(ctx), null)),
  DISCARD: spec(1, ['fast'], NOKEYS, (ctx) => (needConn(ctx), OK)),
  WATCH: spec(-2, ['fast'], ALLKEYS, (ctx) => (needConn(ctx), OK)),
  UNWATCH: spec(1, ['fast'], NOKEYS, (ctx) => (needConn(ctx), OK)),
  SELECT: spec(2, ['fast'], NOKEYS, (_, a) => {
    if (toInt(a[0]!) !== 0) throw new ReplyError('DB index is out of range');
    return OK;
  }),
  CLIENT: spec(-2, [], NOKEYS, (ctx, a) => {
    const conn = needConn(ctx);
    const sub = a[0]!.toUpperCase();
    switch (sub) {
      case 'ID':
        return conn.id;
      case 'GETNAME':
        return conn.name || null;
      case 'SETNAME':
        if (a.length !== 2) throw syntaxError();
        if (/[\s]/.test(a[1]!)) throw new ReplyError('Client names cannot contain spaces, newlines or special characters.');
        conn.name = a[1]!;
        return OK;
      case 'SETINFO': {
        if (a.length !== 3) throw syntaxError();
        const attr = a[1]!.toUpperCase();
        if (attr === 'LIB-NAME') conn.libName = a[2]!;
        else if (attr === 'LIB-VER') conn.libVer = a[2]!;
        else throw new ReplyError(`Unrecognized option '${a[1]}'`);
        return OK;
      }
      case 'INFO':
        return `${conn.describe()}\n`;
      case 'LIST':
        return conn.listAll();
      default:
        throw new ReplyError(`unknown subcommand '${a[0]}'. Try CLIENT HELP.`);
    }
  }),

  // strings
  SET: spec(-3, ['write'], K1, ({ store }, a) => {
    const opts = parseSetOptions(a.slice(2));
    const r = store.set(a[0]!, a[1]!, opts);
    if (opts.get) return r.previous;
    return r.written ? OK : null;
  }),
  SETNX: spec(3, W, K1, ({ store }, a) => (store.set(a[0]!, a[1]!, { nx: true }).written ? 1 : 0)),
  SETEX: spec(4, ['write'], K1, ({ store }, a) => (store.set(a[0]!, a[2]!, { ex: int(a[1]!) }), OK)),
  PSETEX: spec(4, ['write'], K1, ({ store }, a) => (store.set(a[0]!, a[2]!, { px: int(a[1]!) }), OK)),
  GET: spec(2, R, K1, ({ store }, a) => store.get(a[0]!)),
  GETDEL: spec(2, W, K1, ({ store }, a) => store.getdel(a[0]!)),
  GETEX: spec(-2, W, K1, ({ store }, a) => store.getex(a[0]!, parseGetExOptions(a.slice(1)))),
  GETSET: spec(3, W, K1, ({ store }, a) => store.set(a[0]!, a[1]!, { get: true }).previous),
  GETRANGE: spec(4, R, K1, ({ store }, a) => store.getrange(a[0]!, int(a[1]!), int(a[2]!))),
  MGET: spec(-2, R, ALLKEYS, ({ store }, a) => store.mget(a)),
  MSET: spec(-3, ['write'], [1, -1, 2], ({ store }, a) => (store.mset(pairs('mset', a)), OK)),
  MSETNX: spec(-3, ['write'], [1, -1, 2], ({ store }, a) => (store.msetnx(pairs('msetnx', a)) ? 1 : 0)),
  INCR: spec(2, W, K1, ({ store }, a) => store.incrby(a[0]!, 1n)),
  DECR: spec(2, W, K1, ({ store }, a) => store.incrby(a[0]!, -1n)),
  INCRBY: spec(3, W, K1, ({ store }, a) => store.incrby(a[0]!, bigint(a[1]!))),
  DECRBY: spec(3, W, K1, ({ store }, a) => store.incrby(a[0]!, -bigint(a[1]!))),
  APPEND: spec(3, W, K1, ({ store }, a) => store.append(a[0]!, a[1]!)),
  STRLEN: spec(2, R, K1, ({ store }, a) => store.strlen(a[0]!)),

  // keys
  DEL: spec(-2, ['write'], ALLKEYS, ({ store }, a) => store.del(a)),
  UNLINK: spec(-2, W, ALLKEYS, ({ store }, a) => store.del(a)),
  EXISTS: spec(-2, R, ALLKEYS, ({ store }, a) => store.exists(a)),
  TOUCH: spec(-2, R, ALLKEYS, ({ store }, a) => store.exists(a)),
  TYPE: spec(2, R, K1, ({ store }, a) => new SimpleString(store.type(a[0]!))),
  KEYS: spec(2, ['readonly'], NOKEYS, ({ store }, a) => store.keys(a[0]!)),
  SCAN: spec(-2, ['readonly'], NOKEYS, ({ store }, a) => {
    const [next, keys] = store.scan(parseScanCursor(a[0]!), parseScanOptions(a.slice(1)));
    return [String(next), keys];
  }),
  RENAME: spec(3, ['write'], [1, 2, 1], ({ store }, a) => (store.rename(a[0]!, a[1]!), OK)),
  RENAMENX: spec(3, W, [1, 2, 1], ({ store }, a) => {
    if (store.exists([a[1]!])) {
      if (!store.exists([a[0]!])) throw new ReplyError('no such key');
      return 0;
    }
    store.rename(a[0]!, a[1]!);
    return 1;
  }),

  // TTL
  EXPIRE: spec(-3, W, K1, ({ store }, a) => store.expire(a[0]!, int(a[1]!), parseExpireOptions(a.slice(2)))),
  PEXPIRE: spec(-3, W, K1, ({ store }, a) => store.pexpire(a[0]!, int(a[1]!), parseExpireOptions(a.slice(2)))),
  EXPIREAT: spec(-3, W, K1, ({ store }, a) => store.expireat(a[0]!, int(a[1]!), parseExpireOptions(a.slice(2)))),
  PEXPIREAT: spec(-3, W, K1, ({ store }, a) => store.pexpireat(a[0]!, int(a[1]!), parseExpireOptions(a.slice(2)))),
  TTL: spec(2, R, K1, ({ store }, a) => store.ttl(a[0]!)),
  PTTL: spec(2, R, K1, ({ store }, a) => store.pttl(a[0]!)),
  EXPIRETIME: spec(2, R, K1, ({ store }, a) => {
    const t = store.pexpiretime(a[0]!);
    return t < 0 ? t : Math.round(t / 1000);
  }),
  PEXPIRETIME: spec(2, R, K1, ({ store }, a) => store.pexpiretime(a[0]!)),
  PERSIST: spec(2, W, K1, ({ store }, a) => store.persist(a[0]!)),

  // hashes
  HSET: spec(-4, W, K1, ({ store }, a) => store.hset(a[0]!, pairs('hset', a, 1))),
  HMSET: spec(-4, W, K1, ({ store }, a) => (store.hset(a[0]!, pairs('hmset', a, 1)), OK)),
  HSETNX: spec(4, W, K1, ({ store }, a) => store.hsetnx(a[0]!, a[1]!, a[2]!)),
  HGET: spec(3, R, K1, ({ store }, a) => store.hget(a[0]!, a[1]!)),
  HMGET: spec(-3, R, K1, ({ store }, a) => store.hmget(a[0]!, a.slice(1))),
  HDEL: spec(-3, W, K1, ({ store }, a) => store.hdel(a[0]!, a.slice(1))),
  HGETALL: spec(2, ['readonly'], K1, ({ store }, a) => new MapReply(store.hgetall(a[0]!))),
  HEXISTS: spec(3, R, K1, ({ store }, a) => store.hexists(a[0]!, a[1]!)),
  HLEN: spec(2, R, K1, ({ store }, a) => store.hlen(a[0]!)),
  HKEYS: spec(2, ['readonly'], K1, ({ store }, a) => store.hkeys(a[0]!)),
  HVALS: spec(2, ['readonly'], K1, ({ store }, a) => store.hvals(a[0]!)),
  HINCRBY: spec(4, W, K1, ({ store }, a) => store.hincrby(a[0]!, a[1]!, bigint(a[2]!))),

  // lists
  LPUSH: spec(-3, W, K1, ({ store }, a) => store.lpush(a[0]!, a.slice(1))),
  RPUSH: spec(-3, W, K1, ({ store }, a) => store.rpush(a[0]!, a.slice(1))),
  LPOP: spec(-2, W, K1, ({ store }, a) => {
    if (a.length > 2) throw syntaxError();
    return store.lpop(a[0]!, a[1] === undefined ? undefined : positiveInt(a[1]));
  }),
  RPOP: spec(-2, W, K1, ({ store }, a) => {
    if (a.length > 2) throw syntaxError();
    return store.rpop(a[0]!, a[1] === undefined ? undefined : positiveInt(a[1]));
  }),
  LRANGE: spec(4, ['readonly'], K1, ({ store }, a) => store.lrange(a[0]!, int(a[1]!), int(a[2]!))),
  LINDEX: spec(3, ['readonly'], K1, ({ store }, a) => store.lindex(a[0]!, int(a[1]!))),
  LTRIM: spec(4, ['write'], K1, ({ store }, a) => (store.ltrim(a[0]!, int(a[1]!), int(a[2]!)), OK)),
  LLEN: spec(2, R, K1, ({ store }, a) => store.llen(a[0]!)),
};

/** Commands that may run before AUTH succeeds. */
export const NO_AUTH_COMMANDS = new Set(
  Object.entries(COMMANDS)
    .filter(([, s]) => s.flags.includes('no-auth'))
    .map(([name]) => name),
);

function describeCommand(name: string, s: CommandSpec): Reply {
  return [name.toLowerCase(), s.arity, s.flags.map((f) => new SimpleString(f)), ...s.keys];
}

// COMMAND, COMMAND COUNT, COMMAND INFO name..., COMMAND LIST, COMMAND DOCS
function commandReply(a: string[]): Reply {
  if (a.length === 0) return Object.entries(COMMANDS).map(([n, s]) => describeCommand(n, s));
  const sub = a[0]!.toUpperCase();
  if (sub === 'COUNT') return Object.keys(COMMANDS).length;
  if (sub === 'LIST') return Object.keys(COMMANDS).map((n) => n.toLowerCase());
  if (sub === 'DOCS') return []; // no docs; redis-cli falls back to its built-in hints
  if (sub === 'INFO') {
    return a.slice(1).map((n) => {
      const s = COMMANDS[n.toUpperCase()];
      return s ? describeCommand(n, s) : null;
    });
  }
  throw new ReplyError(`unknown subcommand '${a[0]}'. Try COMMAND HELP.`);
}

/** Look up a command and validate its arity. Throws the same errors Redis does. */
export function resolveCommand(argv: string[]): CommandSpec {
  if (argv.length === 0) throw new ReplyError('empty command');
  const name = argv[0]!;
  const cmd = COMMANDS[name.toUpperCase()];
  if (!cmd) {
    const args = argv
      .slice(1, 8)
      .map((x) => `'${x.slice(0, 64)}'`)
      .join(' ');
    throw new ReplyError(`unknown command '${name.slice(0, 128)}', with args beginning with: ${args}`);
  }
  const n = argv.length;
  if (cmd.arity > 0 ? n !== cmd.arity : n < -cmd.arity) {
    throw new ReplyError(`wrong number of arguments for '${name.toLowerCase()}' command`);
  }
  return cmd;
}

/** The key arguments of a command, from its [first, last, step] key spec. */
export function commandKeys(spec: CommandSpec, argv: string[]): string[] {
  const [first, lastSpec, step] = spec.keys;
  if (first === 0) return [];
  const last = lastSpec < 0 ? argv.length + lastSpec : lastSpec;
  const keys: string[] = [];
  for (let i = first; i <= last && i < argv.length; i += step) keys.push(argv[i]!);
  return keys;
}

/**
 * Execute one command. `argv[0]` is the command name.
 * Throws ReplyError for anything the client should see as an error reply.
 */
export function execute(ctx: CommandContext, argv: string[]): Reply {
  return resolveCommand(argv).run(ctx, argv.slice(1));
}
