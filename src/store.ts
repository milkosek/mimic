// SPDX-License-Identifier: Apache-2.0
//
// The in-memory data store (a process-wide singleton).
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
import { ReplyError, WrongTypeError } from './reply.js';
import { checkInt64, globToRegExp, normaliseRange, toInt64 } from './util.js';

export type Entry =
  | { type: 'string'; value: string }
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
  keys: number;
  keysWithTtl: number;
  buckets: number;
  hitRate: number;
  heapUsedBytes: number;
  config: Required<StoreOptions>;
}

const DEFAULTS: Required<StoreOptions> = Object.freeze({
  cleanupIntervalMs: 100,
  sampleSize: 20,
  repeatThreshold: 0.25,
  timeBudgetMs: 5,
});

const invalidExpire = (cmd: string): ReplyError => new ReplyError(`invalid expire time in '${cmd}' command`);

function positive(n: number | undefined, cmd: string): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isSafeInteger(n) || n <= 0) throw invalidExpire(cmd);
  return n;
}

/** Resolve EX/PX/EXAT/PXAT to an absolute deadline in ms, or undefined. */
function deadlineFrom(o: { ex?: number; px?: number; exat?: number; pxat?: number }, cmd: string): number | undefined {
  const given = [o.ex, o.px, o.exat, o.pxat].filter((v) => v !== undefined).length;
  if (given > 1) throw new ReplyError('syntax error');
  const now = Date.now();
  if (o.ex !== undefined) return now + positive(o.ex, cmd)! * 1000;
  if (o.px !== undefined) return now + positive(o.px, cmd)!;
  if (o.exat !== undefined) return positive(o.exat, cmd)! * 1000;
  if (o.pxat !== undefined) return positive(o.pxat, cmd)!;
  return undefined;
}

export class Store {
  static #instance: Store | null = null;
  static #constructing = false;

  readonly #data = new Keyspace<Entry>();
  readonly #expires = new Map<string, number>(); // key -> absolute deadline (ms since epoch)
  readonly #opts: Required<StoreOptions>;
  readonly #startedAt = Date.now();
  readonly #stats: StoreStats = {
    hits: 0,
    misses: 0,
    expiredLazy: 0,
    expiredActive: 0,
    cycles: 0,
    lastCycleMs: 0,
  };
  #timer: NodeJS.Timeout | null = null;
  #cursor: IterableIterator<[string, number]> | null = null; // persisted between active cycles

  /** @internal Use Store.getInstance(). */
  constructor(opts: StoreOptions = {}) {
    if (!Store.#constructing) throw new Error('Store is a singleton - use Store.getInstance()');
    this.#opts = { ...DEFAULTS, ...opts };
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

  /** Start the active expire cycle. */
  start(): this {
    if (!this.#timer) {
      this.#timer = setInterval(() => this.activeExpireCycle(), this.#opts.cleanupIntervalMs);
      this.#timer.unref(); // never keep the process alive on its own
    }
    return this;
  }

  stop(): this {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    return this;
  }

  // ------------------------------------------------------------------ internals

  #remove(key: string): boolean {
    this.#expires.delete(key);
    return this.#data.delete(key);
  }

  /** Every read path goes through here: this is where lazy expiration happens. */
  #lookup(key: string, countStats = true): Entry | undefined {
    const entry = this.#data.get(key);
    if (entry !== undefined) {
      const deadline = this.#expires.get(key);
      if (deadline === undefined || deadline > Date.now()) {
        if (countStats) this.#stats.hits++;
        return entry;
      }
      this.#remove(key);
      this.#stats.expiredLazy++;
    }
    if (countStats) this.#stats.misses++;
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
   * Active expiration, modelled on Redis' activeExpireCycle(): check
   * `sampleSize` keys that carry a TTL, delete the expired ones and, if more
   * than `repeatThreshold` of them had expired, assume there is more garbage
   * and go again - never beyond `timeBudgetMs`. The iterator survives between
   * runs so each cycle resumes where the previous one stopped.
   */
  activeExpireCycle(): number {
    const { sampleSize, repeatThreshold, timeBudgetMs } = this.#opts;
    const started = performance.now();
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
        const [key, deadline] = next.value;
        checked++;
        if (deadline <= now) {
          this.#remove(key);
          expired++;
        }
      }

      reclaimed += expired;
      const dirty = checked > 0 && expired / checked > repeatThreshold;
      if (!dirty || performance.now() - started >= timeBudgetMs) break;
    }

    this.#stats.cycles++;
    this.#stats.expiredActive += reclaimed;
    this.#stats.lastCycleMs = +(performance.now() - started).toFixed(3);
    return reclaimed;
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

    this.#data.set(key, { type: 'string', value });
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
  getex(key: string, opts: GetExOptions = {}): string | null {
    const deadline = deadlineFrom(opts, 'getex');
    if (deadline !== undefined && opts.persist) throw new ReplyError('syntax error');
    const value = this.get(key);
    if (value === null) return null;
    if (deadline !== undefined) this.#setDeadline(key, deadline);
    else if (opts.persist) this.#expires.delete(key);
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
    else this.#data.set(key, { type: 'string', value: next.toString() });
    return next;
  }

  append(key: string, suffix: string): number {
    const entry = this.#typed(key, 'string', false);
    if (entry) {
      entry.value += suffix;
      return entry.value.length;
    }
    this.#data.set(key, { type: 'string', value: suffix });
    return suffix.length;
  }

  strlen(key: string): number {
    return this.#typed(key, 'string', false)?.value.length ?? 0;
  }

  getrange(key: string, start: number, end: number): string {
    const value = this.get(key);
    if (value === null || value.length === 0) return '';
    const [s, e] = normaliseRange(start, end, value.length);
    return s > e ? '' : value.slice(s, e + 1);
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
    const re = pattern === '*' ? null : globToRegExp(pattern);
    const out: string[] = [];
    for (const key of [...this.#data.keys()]) {
      if (re && !re.test(key)) continue;
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
    const re = opts.match && opts.match !== '*' ? globToRegExp(opts.match) : null;
    const collected: string[] = [];
    let next = cursor;
    let budget = count * 10; // bound the work spent on sparse tables, like Redis
    do {
      next = this.#data.scanStep(next, collected);
    } while (next !== 0 && budget-- > 0 && collected.length < count);

    const keys = collected.filter((k) => {
      if (re && !re.test(k)) return false;
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
  }

  dbsize(): number {
    return this.#data.size; // like Redis, may include expired keys not yet reclaimed
  }

  flushall(): void {
    this.#data.clear();
    this.#expires.clear();
    this.#cursor = null;
  }

  // ------------------------------------------------------------------------ TTL

  /** Set an absolute deadline (ms). Returns 1 if the timeout was set, 0 otherwise. */
  pexpireat(key: string, deadlineMs: number, opts: ExpireOptions = {}): 0 | 1 {
    const flags = [opts.nx, opts.xx, opts.gt, opts.lt].filter(Boolean).length;
    if (flags > 1 && !(flags === 2 && opts.xx && (opts.gt || opts.lt))) {
      throw new ReplyError('NX and XX, GT or LT options at the same time are not compatible');
    }
    if (opts.gt && opts.lt) throw new ReplyError('GT and LT options at the same time are not compatible');
    if (!this.#lookup(key, false)) return 0;
    const current = this.#expires.get(key); // undefined = no TTL = "infinite"
    if (opts.nx && current !== undefined) return 0;
    if (opts.xx && current === undefined) return 0;
    if (opts.gt && (current === undefined || deadlineMs <= current)) return 0;
    if (opts.lt && current !== undefined && deadlineMs >= current) return 0;
    this.#setDeadline(key, deadlineMs);
    return 1;
  }

  expire(key: string, seconds: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, Date.now() + seconds * 1000, opts);
  }

  pexpire(key: string, ms: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, Date.now() + ms, opts);
  }

  expireat(key: string, unixSeconds: number, opts?: ExpireOptions): 0 | 1 {
    return this.pexpireat(key, unixSeconds * 1000, opts);
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
    return this.#expires.delete(key) ? 1 : 0;
  }

  // --------------------------------------------------------------------- hashes

  hset(key: string, pairs: [string, string][]): number {
    const { value: hash } = this.#getOrCreate(key, 'hash', () => new Map());
    let added = 0;
    for (const [f, v] of pairs) {
      if (!hash.has(f)) added++;
      hash.set(f, v);
    }
    return added;
  }

  hsetnx(key: string, field: string, value: string): 0 | 1 {
    const { value: hash } = this.#getOrCreate(key, 'hash', () => new Map());
    if (hash.has(field)) return 0;
    hash.set(field, value);
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
    return next;
  }

  // ---------------------------------------------------------------------- lists

  lpush(key: string, values: string[]): number {
    const { value: list } = this.#getOrCreate(key, 'list', () => new Deque<string>());
    for (const v of values) list.unshift(v); // LPUSH k a b c -> [c, b, a]
    return list.length;
  }

  rpush(key: string, values: string[]): number {
    const { value: list } = this.#getOrCreate(key, 'list', () => new Deque<string>());
    for (const v of values) list.push(v);
    return list.length;
  }

  #pop(key: string, count: number | undefined, left: boolean): string | string[] | null {
    const entry = this.#typed(key, 'list', false);
    if (!entry) return null;
    const list = entry.value;
    const n = Math.min(count ?? 1, list.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((left ? list.shift() : list.pop())!);
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

  lindex(key: string, index: number): string | null {
    return this.#typed(key, 'list')?.value.at(index) ?? null;
  }

  ltrim(key: string, start: number, stop: number): void {
    const entry = this.#typed(key, 'list', false);
    if (!entry) return;
    const [s, e] = normaliseRange(start, stop, entry.value.length);
    entry.value.keep(s, s > e ? s : e + 1);
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

  info(): StoreInfo {
    const { hits, misses } = this.#stats;
    return {
      uptimeSec: Math.floor((Date.now() - this.#startedAt) / 1000),
      keys: this.#data.size,
      keysWithTtl: this.#expires.size,
      buckets: this.#data.bucketCount,
      ...this.#stats,
      hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(4) : 0,
      heapUsedBytes: process.memoryUsage().heapUsed,
      config: { ...this.#opts },
    };
  }
}
