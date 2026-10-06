// SPDX-License-Identifier: Apache-2.0
//
// The in-memory data store.
//
// `Store` is the process-wide singleton. Like Redis it holds several numbered
// databases (16 by default, see SELECT); each one is a `Database` with its
// own keys and TTLs. The Store itself *is* database 0, so code that embeds
// MIMIC can simply call store.set()/store.get().
//
// Expiration works the way Redis does it, with two complementary mechanisms:
//   1. Lazy (passive): every access checks the key's deadline and deletes it
//      if it has passed, so a client can never observe an expired value.
//   2. Active: a periodic cycle walks the keys that carry a TTL in small,
//      time-boxed batches and reclaims expired keys nobody is reading
//      (otherwise they would leak memory forever).
//
// All keys, fields and values are binary strings (see bytes.ts).

import { performance } from 'node:perf_hooks';
import { Deque } from './deque.js';
import { Keyspace } from './keyspace.js';
import { MemoryGuard } from './memory.js';
import { ReplyError, WrongTypeError } from './reply.js';
import { checkInt64, globMatch, normaliseRange, toInt, toInt64 } from './util.js';

// Below this size APPEND just concatenates JS strings; above it the value
// moves into a growable byte buffer.
const APPEND_BUFFER_MIN = 4096;

/**
 * A string value (one char per byte, see bytes.ts).
 *
 * Normally a plain JS string. A JS string grown with `+=` is a rope that V8
 * re-flattens - copying the whole value - on the next slice, so the Redis
 * time-series pattern "APPEND log x; GETRANGE log -10 -1" would be O(n) per
 * round. Once a value grows past APPEND_BUFFER_MIN through APPEND it is kept
 * in a buffer with spare capacity instead: APPEND is amortised O(1) and
 * GETRANGE/STRLEN don't touch the rest of the value. Reading the whole value
 * (GET) turns it back into a string.
 */
export class StringEntry {
  readonly type = 'string' as const;
  #str: string | null;
  #buf: Buffer | null = null;
  #len: number;

  constructor(value: string) {
    this.#str = value;
    this.#len = value.length;
  }

  get value(): string {
    if (this.#str === null) {
      this.#str = this.#buf!.toString('latin1', 0, this.#len);
      this.#buf = null;
    }
    return this.#str;
  }

  set value(v: string) {
    this.#str = v;
    this.#buf = null;
    this.#len = v.length;
  }

  /** Length in bytes. */
  get length(): number {
    return this.#len;
  }

  /** Bytes [start, end) without materialising the whole value. */
  slice(start: number, end: number): string {
    return this.#buf ? this.#buf.toString('latin1', start, end) : this.#str!.slice(start, end);
  }

  append(suffix: string): number {
    const needed = this.#len + suffix.length;
    if (this.#buf === null) {
      if (needed < APPEND_BUFFER_MIN) {
        this.#str += suffix;
        this.#len = needed;
        return needed;
      }
      this.#buf = Buffer.allocUnsafe(Math.max(needed * 2, APPEND_BUFFER_MIN * 2));
      this.#buf.write(this.#str!, 0, 'latin1');
      this.#str = null;
    } else if (needed > this.#buf.length) {
      const grown = Buffer.allocUnsafe(Math.max(needed, this.#buf.length * 2));
      this.#buf.copy(grown, 0, 0, this.#len);
      this.#buf = grown;
    }
    this.#buf.write(suffix, this.#len, 'latin1');
    this.#len = needed;
    return needed;
  }
}

export type Entry =
  | StringEntry
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'list'; value: Deque<string> };

export type EntryType = Entry['type'];
type EntryOf<T extends EntryType> = Extract<Entry, { type: T }>;

export interface StoreOptions {
  /** How often the active expire cycle runs, in ms (Redis: hz 10 -> 100 ms). */
  cleanupIntervalMs?: number;
  /** Keys with a TTL checked per batch (Redis: 20). */
  sampleSize?: number;
  /** Run another batch while more than this fraction of the last one had expired (Redis: 25%). */
  repeatThreshold?: number;
  /** Hard cap on time spent per cycle, keeps the event loop responsive. */
  timeBudgetMs?: number;
  /** Number of databases (Redis: databases 16). */
  databases?: number;
  /**
   * Refuse memory-growing writes (-OOM) once the V8 heap passes this
   * percentage of its limit (like Redis' maxmemory + noeviction). 0 disables.
   */
  maxMemoryPercent?: number;
}

export interface SetOptions {
  /** Expire in N seconds. */ ex?: number;
  /** Expire in N milliseconds. */ px?: number;
  /** Expire at a unix time in seconds. */ exat?: number;
  /** Expire at a unix time in milliseconds. */ pxat?: number;
  /** Only set if the key does not exist. */ nx?: boolean;
  /** Only set if the key already exists. */ xx?: boolean;
  /** Keep the existing TTL. */ keepttl?: boolean;
  /** Return the previous value (SET ... GET). */ get?: boolean;
}

export interface SetResult {
  written: boolean;
  previous: string | null;
}

export interface ExpireOptions {
  nx?: boolean; // only if the key has no TTL
  xx?: boolean; // only if the key has a TTL
  gt?: boolean; // only if the new TTL is greater
  lt?: boolean; // only if the new TTL is less
}

export interface GetExOptions {
  ex?: number;
  px?: number;
  exat?: number;
  pxat?: number;
  persist?: boolean;
}

export interface ScanOptions {
  match?: string;
  count?: number;
  type?: string;
}

export interface StoreStats {
  hits: number;
  misses: number;
  expiredLazy: number;
  expiredActive: number;
  cycles: number;
  lastCycleMs: number;
}

export interface StoreInfo extends StoreStats {
  uptimeSec: number;
  /** Totals over all databases. */
  keys: number;
  keysWithTtl: number;
  buckets: number;
  /** Non-empty databases: { db0: { keys, expires }, ... } */
  keyspace: Record<string, { keys: number; expires: number }>;
  hitRate: number;
  heapUsedBytes: number;
  config: Required<StoreOptions>;
}

const DEFAULTS: Required<StoreOptions> = Object.freeze({
  cleanupIntervalMs: 100,
  sampleSize: 20,
  repeatThreshold: 0.25,
  timeBudgetMs: 5,
  databases: 16,
  maxMemoryPercent: 80,
});

export const invalidExpire = (cmd: string): ReplyError => new ReplyError(`invalid expire time in '${cmd}' command`);

const safeDeadline = (ms: number, cmd: string): number => {
  if (!Number.isSafeInteger(ms)) throw invalidExpire(cmd);
  return ms;
};

/** Redis' rules for combining EXPIRE's NX / XX / GT / LT flags (same order, same messages). */
export function checkExpireFlags(o: ExpireOptions): void {
  if (o.nx && (o.xx || o.gt || o.lt)) throw new ReplyError('NX and XX, GT or LT options at the same time are not compatible');
  if (o.gt && o.lt) throw new ReplyError('GT and LT options at the same time are not compatible');
}

function positive(n: number | undefined, cmd: string): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isSafeInteger(n) || n <= 0) throw invalidExpire(cmd);
  return n;
}

/** Resolve EX/PX/EXAT/PXAT to an absolute deadline in ms, or undefined. */
function deadlineFrom(o: { ex?: number; px?: number; exat?: number; pxat?: number }, cmd: string): number | undefined {
  const given = [o.ex, o.px, o.exat, o.pxat].filter((v) => v !== undefined).length;
  if (given > 1) throw new ReplyError('syntax error');
  let deadline: number | undefined;
  if (o.ex !== undefined) deadline = Date.now() + positive(o.ex, cmd)! * 1000;
  else if (o.px !== undefined) deadline = Date.now() + positive(o.px, cmd)!;
  else if (o.exat !== undefined) deadline = positive(o.exat, cmd)! * 1000;
  else if (o.pxat !== undefined) deadline = positive(o.pxat, cmd)!;
  if (deadline !== undefined && !Number.isSafeInteger(deadline)) throw invalidExpire(cmd);
  return deadline;
}

/**
 * Called after a key really changed (written, deleted, expired, TTL changed).
 * This is Redis' signalModifiedKey(): it is what WATCH relies on, whichever
 * front door (RESP, HTTP, embedding) made the change.
 *
 * For FLUSHDB / FLUSHALL / SWAPDB, `key` is null and `existed(k)` tells
 * whether k was present in the affected database(s) - as in Redis'
 * touchAllWatchedKeysInDb(), only keys that existed count as modified.
 */
export type KeyspaceListener = (key: string | null, db: number, existed?: (key: string) => boolean) => void;

/** State shared by all databases of one Store. */
interface Shared {
  readonly opts: Required<StoreOptions>;
  readonly stats: StoreStats;
  readonly listeners: Set<KeyspaceListener>;
  readonly startedAt: number;
}

/** One numbered database: keys, TTLs and every data command. */
export class Database {
  /** The database number (SELECT index). */
  readonly index: number;
  #data = new Keyspace<Entry>();
  #expires = new Map<string, number>(); // key -> absolute deadline (ms since epoch)
  #cursor: IterableIterator<[string, number]> | null = null; // persisted between active cycles
  readonly #shared: Shared;

  /** @internal Databases are created by the Store. */
  constructor(index: number, shared: Shared) {
    this.index = index;
    this.#shared = shared;
  }

  get keyCount(): number {
    return this.#data.size;
  }

  get ttlCount(): number {
    return this.#expires.size;
  }

  get bucketCount(): number {
    return this.#data.bucketCount;
  }

  // ------------------------------------------------------------------ internals

  #touch(key: string): void {
    const listeners = this.#shared.listeners;
    if (listeners.size === 0) return;
    for (const listener of listeners) listener(key, this.index);
  }

  #touchAll(existed: (key: string) => boolean): void {
    const listeners = this.#shared.listeners;
    if (listeners.size === 0) return;
    for (const listener of listeners) listener(null, this.index, existed);
  }

  #remove(key: string): boolean {
    this.#expires.delete(key);
    if (!this.#data.delete(key)) return false;
    this.#touch(key);
    return true;
  }

  /** Every read path goes through here: this is where lazy expiration happens. */
  #lookup(key: string, countStats = true): Entry | undefined {
    const stats = this.#shared.stats;
    const entry = this.#data.get(key);
    if (entry !== undefined) {
      const deadline = this.#expires.get(key);
      if (deadline === undefined || deadline > Date.now()) {
        if (countStats) stats.hits++;
        return entry;
      }
      this.#remove(key);
      stats.expiredLazy++;
    }
    if (countStats) stats.misses++;
    return undefined;
  }

  #typed<T extends EntryType>(key: string, type: T, countStats = true): EntryOf<T> | undefined {
    const entry = this.#lookup(key, countStats);
    if (entry && entry.type !== type) throw new WrongTypeError();
    return entry as EntryOf<T> | undefined;
  }

  #getOrCreate<T extends EntryType>(key: string, type: T, create: () => EntryOf<T>['value']): EntryOf<T> {
    let entry = this.#typed(key, type, false);
    if (!entry) {
      entry = { type, value: create() } as unknown as EntryOf<T>;
      this.#data.set(key, entry);
    }
    return entry;
  }

  // Redis deletes a hash/list key as soon as it becomes empty.
  #dropIfEmpty(key: string, entry: Entry): void {
    const size = entry.type === 'hash' ? entry.value.size : entry.type === 'list' ? entry.value.length : 1;
    if (size === 0) this.#remove(key);
  }

  #setDeadline(key: string, deadline: number): void {
    if (deadline <= Date.now()) this.#remove(key); // an expire in the past deletes the key
    else this.#expires.set(key, deadline);
  }

  /**
   * Active expiration for this database, modelled on Redis'
   * activeExpireCycle(): check `sampleSize` keys that carry a TTL, delete the
   * expired ones and, if more than `repeatThreshold` of them had expired,
   * assume there is more garbage and go again - until `deadline`
   * (performance.now() time). The iterator survives between runs so each
   * cycle resumes where the previous one stopped.
   * @internal Called by Store.activeExpireCycle().
   */
  expireCycle(deadline: number): number {
    const { sampleSize, repeatThreshold } = this.#shared.opts;
    let reclaimed = 0;
    for (;;) {
      const now = Date.now();
      let checked = 0;
      let expired = 0;
      while (checked < sampleSize) {
        this.#cursor ??= this.#expires.entries();
        const next = this.#cursor.next();
        if (next.done) {
          this.#cursor = null; // full pass done; the next batch restarts
          break;
        }
        const [key, keyDeadline] = next.value;
        checked++;
        if (keyDeadline <= now) {
          this.#remove(key);
          expired++;
        }
      }
      reclaimed += expired;
      const dirty = checked > 0 && expired / checked > repeatThreshold;
      if (!dirty || performance.now() >= deadline) break;
    }
    this.#shared.stats.expiredActive += reclaimed;
    return reclaimed;
  }

  /** @internal Incremental rehashing step, called from the Store's timer. */
  rehashFor(ms: number): void {
    this.#data.rehashFor(ms);
  }

  /** @internal Remove a key and hand back its entry and deadline (MOVE). */
  takeEntry(key: string): { entry: Entry; deadline: number | undefined } | null {
    const entry = this.#lookup(key, false);
    if (!entry) return null;
    const deadline = this.#expires.get(key);
    this.#remove(key);
    return { entry, deadline };
  }

  /** @internal Store an entry taken from another database (MOVE). */
  putEntry(key: string, entry: Entry, deadline: number | undefined): void {
    this.#data.set(key, entry);
    if (deadline !== undefined) this.#expires.set(key, deadline);
    this.#touch(key);
  }

  /** @internal Exchange all contents with another database (SWAPDB). */
  swapWith(other: Database): void {
    [this.#data, other.#data] = [other.#data, this.#data];
    [this.#expires, other.#expires] = [other.#expires, this.#expires];
    this.#cursor = null;
    other.#cursor = null;
    // A watched key counts as modified if it exists in either database.
    const inEither = (k: string): boolean => this.#data.has(k) || other.#data.has(k);
    this.#touchAll(inEither);
    other.#touchAll(inEither);
  }

  // -------------------------------------------------------------------- strings

  set(key: string, value: string, opts: SetOptions = {}): SetResult {
    if (opts.nx && opts.xx) throw new ReplyError('syntax error');
    const deadline = deadlineFrom(opts, 'set');
    if (deadline !== undefined && opts.keepttl) throw new ReplyError('syntax error');

    const existing = this.#lookup(key, false);
    if (opts.get && existing && existing.type !== 'string') throw new WrongTypeError();
    const previous = opts.get && existing ? (existing.value as string) : null;

    if ((opts.nx && existing) || (opts.xx && !existing)) return { written: false, previous };

    this.#data.set(key, new StringEntry(value));
    this.#touch(key);
    if (deadline !== undefined) this.#setDeadline(key, deadline);
    else if (!opts.keepttl) this.#expires.delete(key);
    return { written: true, previous };
  }

  get(key: string): string | null {
    return this.#typed(key, 'string')?.value ?? null;
  }

  getdel(key: string): string | null {
    const value = this.get(key);
    if (value !== null) this.#remove(key);
    return value;
  }

  /** GET with a TTL side effect: EX/PX/EXAT/PXAT sets it, PERSIST clears it. */
  getex(key: string, opts: GetExOptions = {}, countStats = true): string | null {
    const deadline = deadlineFrom(opts, 'getex');
    if (deadline !== undefined && opts.persist) throw new ReplyError('syntax error');
    const value = this.#typed(key, 'string', countStats)?.value ?? null;
    if (value === null) return null;
    if (deadline !== undefined) {
      this.#setDeadline(key, deadline);
      this.#touch(key);
    } else if (opts.persist && this.#expires.delete(key)) {
      this.#touch(key);
    }
    return value;
  }

  mget(keys: string[]): (string | null)[] {
    return keys.map((k) => {
      const e = this.#lookup(k);
      return e?.type === 'string' ? e.value : null;
    });
  }

  mset(pairs: [string, string][]): void {
    for (const [k, v] of pairs) this.set(k, v);
  }

  /** MSETNX: set all or nothing. */
  msetnx(pairs: [string, string][]): boolean {
    if (pairs.some(([k]) => this.#lookup(k, false))) return false;
    this.mset(pairs);
    return true;
  }

  incrby(key: string, by: bigint): bigint {
    const entry = this.#typed(key, 'string', false);
    const next = checkInt64((entry ? toInt64(entry.value) : 0n) + by);
    if (entry) entry.value = next.toString(); // keeps the TTL, like Redis
    else this.#data.set(key, new StringEntry(next.toString()));
    this.#touch(key);
    return next;
  }

  append(key: string, suffix: string): number {
    const entry = this.#typed(key, 'string', false);
    this.#touch(key);
    if (entry) return entry.append(suffix);
    this.#data.set(key, new StringEntry(suffix));
    return suffix.length;
  }

  strlen(key: string): number {
    return this.#typed(key, 'string', false)?.length ?? 0;
  }

  /** GETRANGE, with Redis' exact index rules (getrangeCommand in t_string.c). */
  getrange(key: string, start: number, end: number): string {
    const entry = this.#typed(key, 'string');
    if (!entry) return '';
    const len = entry.length;
    if (start < 0 && end < 0 && start > end) return '';
    let s = start < 0 ? len + start : start;
    let e = end < 0 ? len + end : end;
    if (s < 0) s = 0;
    if (e < 0) e = 0; // unlike LRANGE, a too-negative end clamps to the first byte
    if (e >= len) e = len - 1;
    if (s > e || len === 0) return '';
    return entry.slice(s, e + 1);
  }

  // ----------------------------------------------------------------------- keys

  del(keys: string[]): number {
    let n = 0;
    for (const k of keys) if (this.#lookup(k, false) && this.#remove(k)) n++;
    return n;
  }

  exists(keys: string[]): number {
    return keys.filter((k) => this.#lookup(k, false)).length;
  }

  type(key: string): EntryType | 'none' {
    return this.#lookup(key, false)?.type ?? 'none';
  }

  /** KEYS pattern: O(N) over the whole keyspace, prefer scan() in production. */
  keys(pattern = '*'): string[] {
    const all = pattern === '*'; // like Redis: "*" skips matching (it would also skip the empty key)
    const out: string[] = [];
    for (const key of [...this.#data.keys()]) {
      if (!all && !globMatch(pattern, key)) continue;
      if (this.#lookup(key, false)) out.push(key); // lazily drops expired keys
    }
    return out;
  }

  /**
   * SCAN with Redis semantics: a stateless cursor; a full iteration returns
   * every key present for its whole duration at least once, even if keys are
   * added/removed and the table is resized in between calls.
   * MATCH/TYPE filters are applied after the COUNT buckets' keys are
   * collected, so a call can legitimately return zero keys with a non-zero cursor.
   */
  scan(cursor: number, opts: ScanOptions = {}): [cursor: number, keys: string[]] {
    const count = opts.count ?? 10;
    const pattern = opts.match !== undefined && opts.match !== '*' ? opts.match : null;
    const collected: string[] = [];
    let next = cursor;
    let budget = count * 10; // bound the work spent on sparse tables, like Redis
    do {
      next = this.#data.scanStep(next, collected);
    } while (next !== 0 && budget-- > 0 && collected.length < count);

    const keys = collected.filter((k) => {
      if (pattern !== null && !globMatch(pattern, k)) return false;
      const entry = this.#lookup(k, false);
      return entry !== undefined && (!opts.type || entry.type === opts.type);
    });
    return [next, keys];
  }

  rename(src: string, dst: string): void {
    const entry = this.#lookup(src, false);
    if (!entry) throw new ReplyError('no such key');
    if (src === dst) return;
    const deadline = this.#expires.get(src);
    this.#remove(src);
    this.#remove(dst);
    this.#data.set(dst, entry);
    if (deadline !== undefined) this.#expires.set(dst, deadline);
    this.#touch(dst);
  }

  dbsize(): number {
    return this.#data.size; // like Redis, may include expired keys not yet reclaimed
  }

  /** FLUSHDB: delete every key of this database. */
  flushdb(): void {
    const old = this.#data;
    this.#data = new Keyspace<Entry>();
    this.#expires = new Map();
    this.#cursor = null;
    this.#touchAll((k) => old.has(k));
  }

  // ------------------------------------------------------------------------ TTL

  /** Set an absolute deadline (ms). Returns 1 if the timeout was set, 0 otherwise. */
  pexpireat(key: string, deadlineMs: number, opts: ExpireOptions = {}): 0 | 1 {
    checkExpireFlags(opts);
    if (!this.#lookup(key, false)) return 0;
    const current = this.#expires.get(key); // undefined = no TTL = "infinite"
    if (opts.nx && current !== undefined) return 0;
    if (opts.xx && current === undefined) return 0;
    if (opts.gt && (current === undefined || deadlineMs <= current)) return 0;
    if (opts.lt && current !== undefined && deadlineMs >= current) return 0;
    this.#setDeadline(key, deadlineMs);
    this.#touch(key);
    return 1;
  }

  expire(key: string, seconds: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, safeDeadline(Date.now() + seconds * 1000, 'expire'), opts);
  }

  pexpire(key: string, ms: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, safeDeadline(Date.now() + ms, 'pexpire'), opts);
  }

  expireat(key: string, unixSeconds: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, safeDeadline(unixSeconds * 1000, 'expireat'), opts);
  }

  /** Remaining TTL in ms: -2 = no such key, -1 = no TTL. */
  pttl(key: string): number {
    if (!this.#lookup(key, false)) return -2;
    const deadline = this.#expires.get(key);
    return deadline === undefined ? -1 : Math.max(deadline - Date.now(), 0);
  }

  /** Remaining TTL in seconds (rounded like Redis): -2 = no such key, -1 = no TTL. */
  ttl(key: string): number {
    const ms = this.pttl(key);
    return ms < 0 ? ms : Math.round(ms / 1000);
  }

  /** Absolute expiry as unix ms: -2 = no such key, -1 = no TTL. */
  pexpiretime(key: string): number {
    if (!this.#lookup(key, false)) return -2;
    return this.#expires.get(key) ?? -1;
  }

  persist(key: string): 0 | 1 {
    if (!this.#lookup(key, false)) return 0;
    if (!this.#expires.delete(key)) return 0;
    this.#touch(key);
    return 1;
  }

  // --------------------------------------------------------------------- hashes

  hset(key: string, pairs: [string, string][]): number {
    const { value: hash } = this.#getOrCreate(key, 'hash', () => new Map());
    let added = 0;
    for (const [f, v] of pairs) {
      if (!hash.has(f)) added++;
      hash.set(f, v);
    }
    this.#touch(key);
    return added;
  }

  hsetnx(key: string, field: string, value: string): 0 | 1 {
    const { value: hash } = this.#getOrCreate(key, 'hash', () => new Map());
    if (hash.has(field)) return 0;
    hash.set(field, value);
    this.#touch(key);
    return 1;
  }

  hget(key: string, field: string): string | null {
    return this.#typed(key, 'hash')?.value.get(field) ?? null;
  }

  hmget(key: string, fields: string[]): (string | null)[] {
    const hash = this.#typed(key, 'hash')?.value;
    return fields.map((f) => hash?.get(f) ?? null);
  }

  hdel(key: string, fields: string[]): number {
    const entry = this.#typed(key, 'hash', false);
    if (!entry) return 0;
    const n = fields.filter((f) => entry.value.delete(f)).length;
    if (n > 0) this.#touch(key);
    this.#dropIfEmpty(key, entry);
    return n;
  }

  /** All [field, value] pairs. */
  hgetall(key: string): [string, string][] {
    const entry = this.#typed(key, 'hash');
    return entry ? [...entry.value] : [];
  }

  hexists(key: string, field: string): 0 | 1 {
    return this.#typed(key, 'hash', false)?.value.has(field) ? 1 : 0;
  }

  hlen(key: string): number {
    return this.#typed(key, 'hash', false)?.value.size ?? 0;
  }

  hkeys(key: string): string[] {
    return this.hgetall(key).map(([f]) => f);
  }

  hvals(key: string): string[] {
    return this.hgetall(key).map(([, v]) => v);
  }

  hincrby(key: string, field: string, by: bigint): bigint {
    const { value: hash } = this.#getOrCreate(key, 'hash', () => new Map());
    const current = hash.get(field);
    const next = checkInt64((current === undefined ? 0n : toInt64(current, () => new ReplyError('hash value is not an integer'))) + by);
    hash.set(field, next.toString());
    this.#touch(key);
    return next;
  }

  // ---------------------------------------------------------------------- lists

  lpush(key: string, values: string[]): number {
    const { value: list } = this.#getOrCreate(key, 'list', () => new Deque<string>());
    for (const v of values) list.unshift(v); // LPUSH k a b c -> [c, b, a]
    this.#touch(key);
    return list.length;
  }

  rpush(key: string, values: string[]): number {
    const { value: list } = this.#getOrCreate(key, 'list', () => new Deque<string>());
    for (const v of values) list.push(v);
    this.#touch(key);
    return list.length;
  }

  #pop(key: string, count: number | undefined, left: boolean): string | string[] | null {
    const entry = this.#typed(key, 'list', false);
    if (!entry) return null;
    const list = entry.value;
    const n = Math.min(count ?? 1, list.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((left ? list.shift() : list.pop())!);
    if (n > 0) this.#touch(key);
    this.#dropIfEmpty(key, entry);
    return count === undefined ? (out[0] ?? null) : out;
  }

  lpop(key: string, count?: number): string | string[] | null {
    return this.#pop(key, count, true);
  }

  rpop(key: string, count?: number): string | string[] | null {
    return this.#pop(key, count, false);
  }

  lrange(key: string, start: number, stop: number): string[] {
    const entry = this.#typed(key, 'list');
    if (!entry) return [];
    const [s, e] = normaliseRange(start, stop, entry.value.length);
    return s > e ? [] : entry.value.slice(s, e + 1);
  }

  /** LINDEX. Like Redis, the key's type is checked before the index is parsed. */
  lindex(key: string, index: number | string): string | null {
    const list = this.#typed(key, 'list')?.value;
    if (!list) return null;
    return list.at(typeof index === 'string' ? toInt(index) : index) ?? null;
  }

  ltrim(key: string, start: number, stop: number): void {
    const entry = this.#typed(key, 'list', false);
    if (!entry) return;
    const [s, e] = normaliseRange(start, stop, entry.value.length);
    entry.value.keep(s, s > e ? s : e + 1);
    this.#touch(key);
    this.#dropIfEmpty(key, entry);
  }

  llen(key: string): number {
    return this.#typed(key, 'list', false)?.value.length ?? 0;
  }

  // ---------------------------------------------------------------------- admin

  /** Raw entry plus TTL, without touching hit/miss stats (HTTP API, debugging). */
  inspect(key: string): { type: EntryType; value: string | [string, string][] | string[]; ttlMs: number } | null {
    const entry = this.#lookup(key, false);
    if (!entry) return null;
    const value = entry.type === 'string' ? entry.value : entry.type === 'hash' ? [...entry.value] : entry.value.toArray();
    return { type: entry.type, value, ttlMs: this.pttl(key) };
  }

}

/**
 * The process-wide store: a singleton that owns all databases and the
 * background timer. It is database 0 itself.
 */
export class Store extends Database {
  static #instance: Store | null = null;
  static #constructing = false;

  readonly #dbs: Database[];
  readonly #state: Shared;
  /** Heap watcher behind -OOM (Redis maxmemory with noeviction). */
  readonly memory: MemoryGuard;
  #timer: NodeJS.Timeout | null = null;
  #nextDb = 0; // round-robin start for the active expire cycle, like Redis

  /** @internal Use Store.getInstance(). */
  constructor(opts: StoreOptions = {}) {
    if (!Store.#constructing) throw new Error('Store is a singleton - use Store.getInstance()');
    const options: Required<StoreOptions> = { ...DEFAULTS, ...opts };
    if (!Number.isInteger(options.databases) || options.databases < 1) throw new Error('databases must be a positive integer');
    const shared: Shared = {
      opts: options,
      stats: { hits: 0, misses: 0, expiredLazy: 0, expiredActive: 0, cycles: 0, lastCycleMs: 0 },
      listeners: new Set(),
      startedAt: Date.now(),
    };
    super(0, shared);
    this.#state = shared;
    this.memory = new MemoryGuard(options.maxMemoryPercent);
    this.#dbs = [this];
    for (let i = 1; i < options.databases; i++) this.#dbs.push(new Database(i, shared));
  }

  /** The process-wide store. Options only apply on the first call. */
  static getInstance(opts?: StoreOptions): Store {
    if (!Store.#instance) {
      Store.#constructing = true;
      try {
        Store.#instance = new Store(opts);
      } finally {
        Store.#constructing = false;
      }
    }
    return Store.#instance;
  }

  /** Stop the timer and drop the singleton (tests, embedding). */
  static resetInstance(): void {
    Store.#instance?.stop();
    Store.#instance = null;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the active expire cycle (and incremental rehashing). */
  start(): this {
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        this.activeExpireCycle();
        for (const db of this.#dbs) db.rehashFor(1); // like Redis' serverCron
        this.memory.refresh();
      }, this.#state.opts.cleanupIntervalMs);
      this.#timer.unref(); // never keep the process alive on its own
    }
    return this;
  }

  stop(): this {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    return this;
  }

  #holders = 0;
  #startedOutside = false;

  /**
   * Start the timer on behalf of one more user (a daemon). It keeps running
   * until the last user calls release() - and for good if something else had
   * already started it with start().
   */
  retain(): this {
    if (this.#holders++ === 0) {
      this.#startedOutside = this.running;
      this.start();
    }
    return this;
  }

  release(): void {
    if (this.#holders === 0) return;
    if (--this.#holders === 0 && !this.#startedOutside) this.stop();
  }

  /** Whether the background timer (active expiry, rehashing) is running. */
  get running(): boolean {
    return this.#timer !== null;
  }

  /** Subscribe to key modifications in any database. Returns an unsubscribe function. */
  onChange(listener: KeyspaceListener): () => void {
    this.#state.listeners.add(listener);
    return () => this.#state.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ databases

  get databases(): number {
    return this.#dbs.length;
  }

  /** Database `index` (0-based, like SELECT). */
  db(index: number): Database {
    const db = this.#dbs[index];
    if (!db) throw new ReplyError('DB index is out of range');
    return db;
  }

  /** FLUSHALL: empty every database. */
  flushall(): void {
    for (const db of this.#dbs) db.flushdb();
  }

  /** MOVE key from one database to another. 1 if moved, 0 if missing in source or present in target. */
  move(key: string, from: number, to: number): 0 | 1 {
    const src = this.db(from);
    const dst = this.db(to);
    if (src === dst) throw new ReplyError('source and destination objects are the same');
    if (dst.exists([key])) return 0;
    const taken = src.takeEntry(key);
    if (!taken) return 0;
    dst.putEntry(key, taken.entry, taken.deadline);
    return 1;
  }

  /** SWAPDB a b: exchange the contents of two databases. */
  swapdb(a: number, b: number): void {
    const x = this.db(a);
    const y = this.db(b);
    if (x !== y) x.swapWith(y);
  }

  /**
   * Run active expiration over all databases within one shared time budget,
   * starting from a different database each time so none starves.
   */
  activeExpireCycle(): number {
    const { timeBudgetMs } = this.#state.opts;
    const started = performance.now();
    const deadline = started + timeBudgetMs;
    let reclaimed = 0;
    const n = this.#dbs.length;
    for (let i = 0; i < n; i++) {
      const db = this.#dbs[(this.#nextDb + i) % n]!;
      if (db.ttlCount > 0) reclaimed += db.expireCycle(deadline);
      if (performance.now() >= deadline) {
        this.#nextDb = (this.#nextDb + i + 1) % n;
        break;
      }
    }
    const stats = this.#state.stats;
    stats.cycles++;
    stats.lastCycleMs = +(performance.now() - started).toFixed(3);
    return reclaimed;
  }

  info(): StoreInfo {
    const stats = this.#state.stats;
    const { hits, misses } = stats;
    const keyspace: StoreInfo['keyspace'] = {};
    let keys = 0;
    let keysWithTtl = 0;
    let buckets = 0;
    for (const db of this.#dbs) {
      keys += db.keyCount;
      keysWithTtl += db.ttlCount;
      buckets += db.bucketCount;
      if (db.keyCount > 0) keyspace[`db${db.index}`] = { keys: db.keyCount, expires: db.ttlCount };
    }
    return {
      uptimeSec: Math.floor((Date.now() - this.#state.startedAt) / 1000),
      keys,
      keysWithTtl,
      buckets,
      keyspace,
      ...stats,
      hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(4) : 0,
      heapUsedBytes: process.memoryUsage().heapUsed,
      config: { ...this.#state.opts },
    };
  }
}
