// SPDX-License-Identifier: Apache-2.0
//
// Redis command table. Each command declares its arity the way Redis does
// (including the command name; negative = "at least"), which drives argument
// validation and the COMMAND reply that clients may introspect.

import { MapReply, NULL_ARRAY, OK, PONG, ReplyError, SimpleString, syntaxError, VerbatimString, type Reply } from './reply.js';
import { checkExpireFlags, invalidExpire, type Database, type ExpireOptions, type Store } from './store.js';
import { globMatch, toInt, toInt64 } from './util.js';
import { OOM_MESSAGE } from './memory.js';
import { NAME, REDIS_COMPAT_VERSION, VERSION } from './version.js';

/** What a transport (the RESP server) exposes about the current connection. */
export interface ConnectionHandle {
  readonly id: number;
  name: string;
  libName: string;
  libVer: string;
  authenticated: boolean;
  /** Selected database (SELECT). */
  db: number;
  /** RESP protocol version spoken on this connection (HELLO switches it). */
  protocol: 2 | 3;
  /** 'nopass' when the server has no password configured. */
  authenticate(username: string | null, password: string): 'ok' | 'wrongpass' | 'nopass';
  /** RESET: drop name, authentication state, selected database and protocol. */
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
  /** The whole store (all databases): FLUSHALL, MOVE, SWAPDB, INFO. */
  store: Store;
  /** The selected database: what data commands operate on. */
  db: Database;
  /** Present for RESP connections; absent over HTTP. */
  conn?: ConnectionHandle;
  /** Extra INFO sections supplied by the server (clients, stats, ports). */
  serverInfo?: () => InfoSections;
  /** Commands disabled with --disable-commands (upper case): they behave as unknown. */
  disabled?: ReadonlySet<string>;
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
// Redis' getPositiveLongFromObjectOrReply(): any failure, including a
// non-number, reports "must be positive".
const positiveInt = (v: string): number => {
  const mustBePositive = (): ReplyError => new ReplyError('value is out of range, must be positive');
  const n = toInt(v, mustBePositive);
  if (n < 0) throw mustBePositive();
  return n;
};

function pairs(cmd: string, args: string[], offset = 0): [string, string][] {
  const rest = args.length - offset;
  if (rest === 0 || rest % 2 !== 0) throw new ReplyError(`wrong number of arguments for '${cmd}' command`);
  const out: [string, string][] = [];
  for (let i = offset; i < args.length; i += 2) out.push([args[i]!, args[i + 1]!]);
  return out;
}

// ---- expire times: exact int64 checks with Redis' error messages

const LLONG_MAX = 2n ** 63n - 1n;
const LLONG_MIN = -(2n ** 63n);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

// Deadlines beyond 2^53 ms (~287,000 years) saturate; Redis would store them exactly.
const toSafeMs = (ms: bigint): number => Number(ms > MAX_SAFE ? MAX_SAFE : ms < MIN_SAFE ? MIN_SAFE : ms);

type ExpireKind = 'EX' | 'PX' | 'EXAT' | 'PXAT';
interface ExpireArg {
  kind: ExpireKind;
  raw: string;
}

/** SET / SETEX / PSETEX / GETEX: Redis' getExpireMillisecondsOrReply(). Returns an absolute deadline in ms. */
function setStyleDeadline(e: ExpireArg, cmd: string): number {
  let ms = toInt64(e.raw);
  const seconds = e.kind === 'EX' || e.kind === 'EXAT';
  if (ms <= 0n || (seconds && ms > LLONG_MAX / 1000n)) throw invalidExpire(cmd);
  if (seconds) ms *= 1000n;
  if (e.kind === 'EX' || e.kind === 'PX') {
    const now = BigInt(Date.now());
    if (ms > LLONG_MAX - now) throw invalidExpire(cmd);
    ms += now;
  }
  return toSafeMs(ms);
}

/** EXPIRE family: Redis' expireGenericCommand(). Negative values are allowed (they delete the key). */
function expireStyleDeadline(raw: string, seconds: boolean, absolute: boolean, cmd: string): number {
  let when = toInt64(raw);
  if (seconds) {
    if (when > LLONG_MAX / 1000n || when < LLONG_MIN / 1000n) throw invalidExpire(cmd);
    when *= 1000n;
  }
  const base = absolute ? 0n : BigInt(Date.now());
  if (when > LLONG_MAX - base) throw invalidExpire(cmd);
  return toSafeMs(when + base);
}

interface ExtendedStringOptions {
  nx?: boolean;
  xx?: boolean;
  get?: boolean;
  keepttl?: boolean;
  persist?: boolean;
  expire?: ExpireArg;
}

/**
 * Options of SET and GETEX, with the same acceptance rules as Redis 7.0's
 * parseExtendedStringArgumentsOrReply(): an expire option excludes the other
 * kinds (repeating the same one is allowed, the last wins), KEEPTTL/PERSIST
 * exclude expire options, NX and XX exclude each other; anything else is a
 * syntax error. Values are validated
 * afterwards (see setStyleDeadline), as in Redis.
 */
function parseExtendedOptions(tokens: string[], command: 'set' | 'getex'): ExtendedStringOptions {
  const o: ExtendedStringOptions = {};
  const isSet = command === 'set';
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!.toUpperCase();
    const next = tokens[i + 1];
    // Redis 7.0 allows repeating the *same* expire option (the last one wins),
    // but not mixing EX/PX/EXAT/PXAT/KEEPTTL/PERSIST.
    const expireAllowed = !o.keepttl && !o.persist && (!o.expire || o.expire.kind === flag);
    if (isSet && flag === 'NX' && !o.xx) o.nx = true;
    else if (isSet && flag === 'XX' && !o.nx) o.xx = true;
    else if (isSet && flag === 'GET') o.get = true;
    else if (isSet && flag === 'KEEPTTL' && !o.expire && !o.persist) o.keepttl = true;
    else if (!isSet && flag === 'PERSIST' && !o.expire && !o.keepttl) o.persist = true;
    else if ((flag === 'EX' || flag === 'PX' || flag === 'EXAT' || flag === 'PXAT') && expireAllowed && next !== undefined) {
      o.expire = { kind: flag, raw: next };
      i++;
    } else {
      throw syntaxError();
    }
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
  checkExpireFlags(o);
  return o;
}

const ULONG_MAX = 2n ** 64n - 1n;

/**
 * Redis parses SCAN cursors with strtoul(): an optional sign and digits, no
 * leading space, at most 2^64-1, negative values wrap ("-1" is valid). Only
 * the low 32 bits matter here: they address every bucket of the table.
 */
function parseScanCursor(v: string): number {
  if (v === '') return 0;
  const m = /^([+-]?)(\d+)$/.exec(v);
  if (!m) throw new ReplyError('invalid cursor');
  const digits = m[2]!.replace(/^0+(?=\d)/, ''); // strtoul accepts leading zeros
  if (digits.length > 20) throw new ReplyError('invalid cursor');
  const magnitude = BigInt(digits);
  if (magnitude > ULONG_MAX) throw new ReplyError('invalid cursor');
  const value = m[1] === '-' ? (ULONG_MAX + 1n - magnitude) & ULONG_MAX : magnitude;
  return Number(BigInt.asUintN(32, value));
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

const dbInRange = (ctx: CommandContext, index: number): boolean => index >= 0 && index < ctx.store.databases;

// Redis' getIntFromObjectOrReply(): a 64-bit integer that must also fit in 32 bits.
const INT32_RANGE = 'value is out of range, value must between -2147483648 and 2147483647';
function toInt32(v: string, err?: () => ReplyError): number {
  const n = toInt(v, err);
  if (n < -2147483648 || n > 2147483647) throw err ? err() : new ReplyError(INT32_RANGE);
  return n;
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
      maxmemory: ctx.store.memory.limitBytes,
      maxmemory_human: human(ctx.store.memory.limitBytes),
      maxmemory_policy: 'noeviction',
      [`${NAME}_heap_old_generation`]: ctx.store.memory.usedBytes,
      [`${NAME}_heap_limit`]: ctx.store.memory.heapLimitBytes,
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
    Keyspace: Object.fromEntries(
      Object.entries(s.keyspace).map(([name, k]) => [name, `keys=${k.keys},expires=${k.expires},avg_ttl=0`]),
    ),
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
    maxmemory: String(ctx.store.memory.limitBytes),
    'maxmemory-policy': 'noeviction',
    save: '',
    appendonly: 'no',
    databases: String(ctx.store.databases),
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
// Redis' denyoom: refused with -OOM when over the memory limit (see memory.ts).
const WD = ['write', 'denyoom', 'fast'];
const WDS = ['write', 'denyoom'];

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
  INFO: spec(-1, [], NOKEYS, (ctx, a) => new VerbatimString(formatInfo(ctx, a))),
  DBSIZE: spec(1, R, NOKEYS, (ctx) => ctx.db.dbsize()),
  FLUSHALL: spec(-1, ['write'], NOKEYS, (ctx, a) => (flushArgs(a), ctx.store.flushall(), ctx.store.memory.freed(), OK)),
  FLUSHDB: spec(-1, ['write'], NOKEYS, (ctx, a) => (flushArgs(a), ctx.db.flushdb(), ctx.store.memory.freed(), OK)),
  SWAPDB: spec(3, ['write', 'fast'], NOKEYS, (ctx, a) => {
    const first = toInt32(a[0]!, () => new ReplyError('invalid first DB index'));
    const second = toInt32(a[1]!, () => new ReplyError('invalid second DB index'));
    if (!dbInRange(ctx, first) || !dbInRange(ctx, second)) throw new ReplyError('DB index is out of range');
    ctx.store.swapdb(first, second);
    return OK;
  }),
  COMMAND: spec(-1, [], NOKEYS, (ctx, a) => commandReply(a, ctx.disabled)),
  CONFIG: spec(-2, ['admin'], NOKEYS, (ctx, a) => {
    const sub = a[0]!.toUpperCase();
    if (sub === 'GET') {
      if (a.length < 2) throw new ReplyError("wrong number of arguments for 'config|get' command");
      const params = configParams(ctx);
      // Like Redis: a plain name is looked up case-insensitively and echoed as
      // given; a glob returns the canonical (lower-case) names that match.
      const out = new Map<string, string>();
      for (const p of a.slice(1)) {
        if (!/[*?[]/.test(p)) {
          // Own properties only: "constructor" or "__proto__" must not reach Object.prototype.
          const name = p.toLowerCase();
          const value = Object.hasOwn(params, name) ? params[name] : undefined;
          if (value !== undefined) out.set(p, value);
        } else {
          for (const [k, v] of Object.entries(params)) if (globMatch(p, k, true)) out.set(k, v);
        }
      }
      return new MapReply([...out]);
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
        if (/[^!-~]/.test(name)) throw new ReplyError('Client names cannot contain spaces, newlines or special characters.');
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
  SELECT: spec(2, ['fast'], NOKEYS, (ctx, a) => {
    const conn = needConn(ctx);
    const index = toInt32(a[0]!);
    if (!dbInRange(ctx, index)) throw new ReplyError('DB index is out of range');
    conn.db = index;
    return OK;
  }),
  CLIENT: spec(-2, [], NOKEYS, (ctx, a) => {
    const conn = needConn(ctx);
    const sub = a[0]!.toUpperCase();
    // Subcommand arity, total argument count as in Redis (negative = at least).
    const arity: Record<string, number> = { ID: 2, GETNAME: 2, SETNAME: 3, SETINFO: 4, INFO: 2, LIST: -2 };
    const want = arity[sub];
    const total = a.length + 1;
    if (want !== undefined && (want > 0 ? total !== want : total < -want)) {
      throw new ReplyError(`wrong number of arguments for 'client|${sub.toLowerCase()}' command`);
    }
    switch (sub) {
      case 'ID':
        return conn.id;
      case 'GETNAME':
        return conn.name || null;
      case 'SETNAME':
        // Redis allows only printable ASCII without spaces ('!' .. '~').
        if (/[^!-~]/.test(a[1]!)) throw new ReplyError('Client names cannot contain spaces, newlines or special characters.');
        conn.name = a[1]!;
        return OK;
      case 'SETINFO': {
        const attr = a[1]!.toUpperCase();
        if (attr !== 'LIB-NAME' && attr !== 'LIB-VER') throw new ReplyError(`Unrecognized option '${a[1]}'`);
        // Same rule as Redis 7.2 (and CLIENT SETNAME): printable ASCII, no spaces.
        // Without it, a value with a newline could forge lines in CLIENT LIST.
        if (/[^!-~]/.test(a[2]!)) throw new ReplyError(`${attr.toLowerCase()} cannot contain spaces, newlines or special characters.`);
        if (attr === 'LIB-NAME') conn.libName = a[2]!;
        else conn.libVer = a[2]!;
        return OK;
      }
      case 'INFO':
        return new VerbatimString(`${conn.describe()}\n`);
      case 'LIST':
        return new VerbatimString(conn.listAll());
      default:
        throw new ReplyError(`unknown subcommand '${a[0]}'. Try CLIENT HELP.`);
    }
  }),

  // strings
  SET: spec(-3, WDS, K1, ({ db }, a) => {
    const o = parseExtendedOptions(a.slice(2), 'set');
    const pxat = o.expire ? setStyleDeadline(o.expire, 'set') : undefined;
    const r = db.set(a[0]!, a[1]!, { nx: !!o.nx, xx: !!o.xx, get: !!o.get, keepttl: !!o.keepttl, ...(pxat !== undefined ? { pxat } : {}) });
    if (o.get) return r.previous;
    return r.written ? OK : null;
  }),
  SETNX: spec(3, WD, K1, ({ db }, a) => (db.set(a[0]!, a[1]!, { nx: true }).written ? 1 : 0)),
  SETEX: spec(4, WDS, K1, ({ db }, a) => {
    const pxat = setStyleDeadline({ kind: 'EX', raw: a[1]! }, 'setex');
    db.set(a[0]!, a[2]!, { pxat });
    return OK;
  }),
  PSETEX: spec(4, WDS, K1, ({ db }, a) => {
    const pxat = setStyleDeadline({ kind: 'PX', raw: a[1]! }, 'psetex');
    db.set(a[0]!, a[2]!, { pxat });
    return OK;
  }),
  GET: spec(2, R, K1, ({ db }, a) => db.get(a[0]!)),
  GETDEL: spec(2, W, K1, ({ db }, a) => db.getdel(a[0]!)),
  GETEX: spec(-2, W, K1, ({ db }, a) => {
    // Same order as Redis: options, then the key (nil / WRONGTYPE), then the expire value.
    const o = parseExtendedOptions(a.slice(1), 'getex');
    const value = db.get(a[0]!);
    if (value === null) return null;
    if (o.expire) db.getex(a[0]!, { pxat: setStyleDeadline(o.expire, 'getex') }, false);
    else if (o.persist) db.getex(a[0]!, { persist: true }, false);
    return value;
  }),
  GETSET: spec(3, WD, K1, ({ db }, a) => db.set(a[0]!, a[1]!, { get: true }).previous),
  GETRANGE: spec(4, R, K1, ({ db }, a) => db.getrange(a[0]!, int(a[1]!), int(a[2]!))),
  MGET: spec(-2, R, ALLKEYS, ({ db }, a) => db.mget(a)),
  MSET: spec(-3, WDS, [1, -1, 2], ({ db }, a) => (db.mset(pairs('mset', a)), OK)),
  MSETNX: spec(-3, WDS, [1, -1, 2], ({ db }, a) => (db.msetnx(pairs('msetnx', a)) ? 1 : 0)),
  INCR: spec(2, WD, K1, ({ db }, a) => db.incrby(a[0]!, 1n)),
  DECR: spec(2, WD, K1, ({ db }, a) => db.incrby(a[0]!, -1n)),
  INCRBY: spec(3, WD, K1, ({ db }, a) => db.incrby(a[0]!, bigint(a[1]!))),
  DECRBY: spec(3, WD, K1, ({ db }, a) => {
    const by = bigint(a[1]!);
    if (by === -(2n ** 63n)) throw new ReplyError('decrement would overflow');
    return db.incrby(a[0]!, -by);
  }),
  APPEND: spec(3, WD, K1, ({ db }, a) => db.append(a[0]!, a[1]!)),
  STRLEN: spec(2, R, K1, ({ db }, a) => db.strlen(a[0]!)),

  // keys
  DEL: spec(-2, ['write'], ALLKEYS, ({ db }, a) => db.del(a)),
  UNLINK: spec(-2, W, ALLKEYS, ({ db }, a) => db.del(a)),
  EXISTS: spec(-2, R, ALLKEYS, ({ db }, a) => db.exists(a)),
  TOUCH: spec(-2, R, ALLKEYS, ({ db }, a) => db.exists(a)),
  TYPE: spec(2, R, K1, ({ db }, a) => new SimpleString(db.type(a[0]!))),
  KEYS: spec(2, ['readonly'], NOKEYS, ({ db }, a) => db.keys(a[0]!)),
  SCAN: spec(-2, ['readonly'], NOKEYS, ({ db }, a) => {
    const [next, keys] = db.scan(parseScanCursor(a[0]!), parseScanOptions(a.slice(1)));
    return [String(next), keys];
  }),
  RENAME: spec(3, ['write'], [1, 2, 1], ({ db }, a) => (db.rename(a[0]!, a[1]!), OK)),
  MOVE: spec(3, W, K1, (ctx, a) => {
    const target = toInt32(a[1]!);
    if (!dbInRange(ctx, target)) throw new ReplyError('DB index is out of range');
    return ctx.store.move(a[0]!, ctx.db.index, target);
  }),
  RENAMENX: spec(3, W, [1, 2, 1], ({ db }, a) => {
    if (db.exists([a[1]!])) {
      if (!db.exists([a[0]!])) throw new ReplyError('no such key');
      return 0;
    }
    db.rename(a[0]!, a[1]!);
    return 1;
  }),

  // TTL
  EXPIRE: spec(-3, W, K1, ({ db }, a) => {
    const opts = parseExpireOptions(a.slice(2));
    return db.pexpireat(a[0]!, expireStyleDeadline(a[1]!, true, false, 'expire'), opts);
  }),
  PEXPIRE: spec(-3, W, K1, ({ db }, a) => {
    const opts = parseExpireOptions(a.slice(2));
    return db.pexpireat(a[0]!, expireStyleDeadline(a[1]!, false, false, 'pexpire'), opts);
  }),
  EXPIREAT: spec(-3, W, K1, ({ db }, a) => {
    const opts = parseExpireOptions(a.slice(2));
    return db.pexpireat(a[0]!, expireStyleDeadline(a[1]!, true, true, 'expireat'), opts);
  }),
  PEXPIREAT: spec(-3, W, K1, ({ db }, a) => {
    const opts = parseExpireOptions(a.slice(2));
    return db.pexpireat(a[0]!, expireStyleDeadline(a[1]!, false, true, 'pexpireat'), opts);
  }),
  TTL: spec(2, R, K1, ({ db }, a) => db.ttl(a[0]!)),
  PTTL: spec(2, R, K1, ({ db }, a) => db.pttl(a[0]!)),
  EXPIRETIME: spec(2, R, K1, ({ db }, a) => {
    const t = db.pexpiretime(a[0]!);
    return t < 0 ? t : Math.round(t / 1000);
  }),
  PEXPIRETIME: spec(2, R, K1, ({ db }, a) => db.pexpiretime(a[0]!)),
  PERSIST: spec(2, W, K1, ({ db }, a) => db.persist(a[0]!)),

  // hashes
  HSET: spec(-4, WD, K1, ({ db }, a) => db.hset(a[0]!, pairs('hset', a, 1))),
  HMSET: spec(-4, WD, K1, ({ db }, a) => (db.hset(a[0]!, pairs('hmset', a, 1)), OK)),
  HSETNX: spec(4, WD, K1, ({ db }, a) => db.hsetnx(a[0]!, a[1]!, a[2]!)),
  HGET: spec(3, R, K1, ({ db }, a) => db.hget(a[0]!, a[1]!)),
  HMGET: spec(-3, R, K1, ({ db }, a) => db.hmget(a[0]!, a.slice(1))),
  HDEL: spec(-3, W, K1, ({ db }, a) => db.hdel(a[0]!, a.slice(1))),
  HGETALL: spec(2, ['readonly'], K1, ({ db }, a) => new MapReply(db.hgetall(a[0]!))),
  HEXISTS: spec(3, R, K1, ({ db }, a) => db.hexists(a[0]!, a[1]!)),
  HLEN: spec(2, R, K1, ({ db }, a) => db.hlen(a[0]!)),
  HKEYS: spec(2, ['readonly'], K1, ({ db }, a) => db.hkeys(a[0]!)),
  HVALS: spec(2, ['readonly'], K1, ({ db }, a) => db.hvals(a[0]!)),
  HINCRBY: spec(4, WD, K1, ({ db }, a) => db.hincrby(a[0]!, a[1]!, bigint(a[2]!))),

  // lists
  LPUSH: spec(-3, WD, K1, ({ db }, a) => db.lpush(a[0]!, a.slice(1))),
  RPUSH: spec(-3, WD, K1, ({ db }, a) => db.rpush(a[0]!, a.slice(1))),
  LPOP: spec(-2, W, K1, ({ db }, a) => {
    if (a.length > 2) throw new ReplyError("wrong number of arguments for 'lpop' command");
    if (a[1] === undefined) return db.lpop(a[0]!);
    return db.lpop(a[0]!, positiveInt(a[1])) ?? NULL_ARRAY; // with a count, a missing key is a null array
  }),
  RPOP: spec(-2, W, K1, ({ db }, a) => {
    if (a.length > 2) throw new ReplyError("wrong number of arguments for 'rpop' command");
    if (a[1] === undefined) return db.rpop(a[0]!);
    return db.rpop(a[0]!, positiveInt(a[1])) ?? NULL_ARRAY; // with a count, a missing key is a null array
  }),
  LRANGE: spec(4, ['readonly'], K1, ({ db }, a) => db.lrange(a[0]!, int(a[1]!), int(a[2]!))),
  LINDEX: spec(3, ['readonly'], K1, ({ db }, a) => db.lindex(a[0]!, a[1]!)),
  LTRIM: spec(4, ['write'], K1, ({ db }, a) => (db.ltrim(a[0]!, int(a[1]!), int(a[2]!)), OK)),
  LLEN: spec(2, R, K1, ({ db }, a) => db.llen(a[0]!)),
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

/** A command by name (any case), unless it doesn't exist or is disabled. */
function lookup(name: string, disabled?: ReadonlySet<string>): CommandSpec | undefined {
  const upper = name.toUpperCase();
  if (!Object.hasOwn(COMMANDS, upper) || disabled?.has(upper)) return undefined;
  return COMMANDS[upper];
}

// COMMAND, COMMAND COUNT, COMMAND INFO name..., COMMAND LIST, COMMAND DOCS.
// Disabled commands are left out, as with Redis' rename-command.
function commandReply(a: string[], disabled?: ReadonlySet<string>): Reply {
  const all = Object.entries(COMMANDS).filter(([n]) => !disabled?.has(n));
  if (a.length === 0) return all.map(([n, s]) => describeCommand(n, s));
  const sub = a[0]!.toUpperCase();
  if (sub === 'COUNT') return all.length;
  if (sub === 'LIST') return all.map(([n]) => n.toLowerCase());
  if (sub === 'DOCS') return []; // no docs; redis-cli falls back to its built-in hints
  if (sub === 'INFO') {
    return a.slice(1).map((n) => {
      const s = lookup(n, disabled);
      return s ? describeCommand(n, s) : null;
    });
  }
  throw new ReplyError(`unknown subcommand '${a[0]}'. Try COMMAND HELP.`);
}

/** Commands that can't be disabled: without them, clients couldn't authenticate or disconnect. */
export const ALWAYS_ENABLED = new Set(['AUTH', 'HELLO', 'QUIT', 'RESET', 'PING']);

/** Check a --disable-commands list; returns an error message, or null if it's fine. */
export function checkDisabledCommands(names: readonly string[]): string | null {
  for (const n of names) {
    if (!Object.hasOwn(COMMANDS, n)) return `--disable-commands: unknown command ${n}`;
    if (ALWAYS_ENABLED.has(n)) return `--disable-commands: ${n} can't be disabled`;
  }
  return null;
}

/** Look up a command and validate its arity. Throws the same errors Redis does. */
export function resolveCommand(argv: string[], disabled?: ReadonlySet<string>): CommandSpec {
  if (argv.length === 0) throw new ReplyError('empty command');
  const name = argv[0]!;
  const cmd = lookup(name, disabled);
  if (!cmd) {
    // Same text as Redis 7: each argument quoted and followed by a space, 128 chars in total.
    let args = '';
    for (let i = 1; i < argv.length && args.length < 128; i++) args += `'${argv[i]!.slice(0, 128 - args.length)}' `;
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
  const spec = resolveCommand(argv, ctx.disabled);
  checkMemory(ctx, spec, argv);
  return spec.run(ctx, argv.slice(1));
}

/** Refuse a memory-growing command while the store is over its memory limit (Redis: -OOM). */
export function checkMemory(ctx: CommandContext, spec: CommandSpec, argv: readonly string[]): void {
  if (!spec.flags.includes('denyoom')) return;
  let bytes = 0;
  for (let i = 1; i < argv.length; i++) bytes += argv[i]!.length;
  if (ctx.store.memory.overLimit(bytes)) throw new ReplyError(OOM_MESSAGE, 'OOM');
}
