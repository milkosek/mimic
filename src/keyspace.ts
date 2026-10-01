// SPDX-License-Identifier: Apache-2.0
//
// Keyspace: a Map for O(1) lookups plus a power-of-two bucket table that
// exists only to support SCAN with the same guarantees Redis gives:
//
//   * a full iteration (cursor 0 -> ... -> 0) returns every key that was
//     present for the whole iteration at least once,
//   * even if the table grows or shrinks between SCAN calls,
//   * the cursor is stateless (the server keeps nothing per iteration).
//
// This is Redis' "reverse binary iteration" (dictScan() in dict.c): the
// cursor's bits are incremented from the most significant end, so after a
// resize every not-yet-visited bucket maps onto buckets that have not been
// visited either. A key may be returned more than once (after a shrink);
// callers de-duplicate if they care, exactly as with Redis.
//
// Resizing is incremental, like Redis: when the table needs to grow or
// shrink, a second table is allocated and buckets are moved a few at a time
// on every write (plus rehashFor() from the background timer), so no single
// operation pays for rehashing millions of keys. While rehashing, SCAN walks
// both tables the way dictScan() does.

const MIN_BUCKETS = 16; // must be a power of two
const MAX_BUCKETS = 2 ** 30;
const GROW_LOAD = 4; // average keys per bucket before doubling
const SHRINK_LOAD = 0.5; // average keys per bucket before halving
const STEP_BUCKETS = 4; // buckets migrated per write while rehashing

type Table = (string[] | undefined)[];

/** Reverse the bits of a 32-bit unsigned integer. */
function rev32(v: number): number {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  return ((v >>> 16) | (v << 16)) >>> 0;
}

/** Advance a reverse-binary cursor past all bits covered by `mask`. */
function advance(cursor: number, mask: number): number {
  let v = (cursor | ~mask) >>> 0;
  v = rev32(v);
  v = (v + 1) >>> 0;
  return rev32(v);
}

export class Keyspace<V> {
  // Note: V8 grows a Map by doubling and copying it, a pause of ~170 ms at 2M
  // keys. Sharding the Map would spread that out but costs a key hash on
  // every lookup (~200 ns); with GC pauses of the same order at that heap
  // size anyway, a single Map is the better trade.
  #map = new Map<string, V>();
  #table: Table = new Array(MIN_BUCKETS); // where new keys go
  #old: Table | null = null; // the table being drained while rehashing
  #rehashIdx = 0; // next bucket of #old to migrate
  // Random seed so bucket placement is not predictable from outside.
  readonly #seed = (Math.random() * 0x100000000) >>> 0;

  get size(): number {
    return this.#map.size;
  }

  /** Current number of buckets (exposed for INFO and tests). */
  get bucketCount(): number {
    return this.#table.length;
  }

  get isRehashing(): boolean {
    return this.#old !== null;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  set(key: string, value: V): void {
    if (this.#map.has(key)) {
      this.#map.set(key, value);
      return;
    }
    this.#map.set(key, value);
    this.#bucketAdd(this.#table, key);
    if (this.#old) this.#rehashStep(STEP_BUCKETS);
    else if (this.#map.size > this.#table.length * GROW_LOAD && this.#table.length < MAX_BUCKETS) {
      this.#startResize(this.#table.length * 2);
    }
  }

  delete(key: string): boolean {
    if (!this.#map.delete(key)) return false;
    const h = this.#hash(key);
    if (!this.#bucketRemove(this.#table, h, key) && this.#old) this.#bucketRemove(this.#old, h, key);
    if (this.#old) this.#rehashStep(STEP_BUCKETS);
    else if (this.#table.length > MIN_BUCKETS && this.#map.size < this.#table.length * SHRINK_LOAD) {
      this.#startResize(this.#table.length / 2);
    }
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#table = new Array(MIN_BUCKETS);
    this.#old = null;
    this.#rehashIdx = 0;
  }

  keys(): IterableIterator<string> {
    return this.#map.keys();
  }

  entries(): IterableIterator<[string, V]> {
    return this.#map.entries();
  }

  /** Migrate buckets for up to `ms` milliseconds (called from the background timer). */
  rehashFor(ms: number): void {
    if (!this.#old) return;
    const deadline = performance.now() + ms;
    while (this.#old && performance.now() < deadline) this.#rehashStep(100);
  }

  /**
   * Visit one cursor position: push its keys into `out` and return the next
   * cursor (0 when the iteration is complete).
   */
  scanStep(cursor: number, out: string[]): number {
    if (!this.#old) {
      const mask = this.#table.length - 1;
      const bucket = this.#table[cursor & mask];
      if (bucket) for (const key of bucket) out.push(key);
      return advance(cursor, mask);
    }
    // Rehashing: visit the bucket in the smaller table, then every bucket of
    // the larger table that it expands to (dictScan's two-table walk).
    const [small, large] = this.#old.length <= this.#table.length ? [this.#old, this.#table] : [this.#table, this.#old];
    const m0 = small.length - 1;
    const m1 = large.length - 1;
    let v = cursor;
    const b0 = small[v & m0];
    if (b0) for (const key of b0) out.push(key);
    do {
      const b1 = large[v & m1];
      if (b1) for (const key of b1) out.push(key);
      v = advance(v, m1);
    } while (v & (m0 ^ m1));
    return v;
  }

  // FNV-1a over the key's bytes (keys are binary strings: one byte per char).
  #hash(key: string): number {
    let h = (0x811c9dc5 ^ this.#seed) >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  #bucketAdd(table: Table, key: string, h = this.#hash(key)): void {
    const idx = h & (table.length - 1);
    const bucket = table[idx];
    if (bucket) bucket.push(key);
    else table[idx] = [key];
  }

  #bucketRemove(table: Table, h: number, key: string): boolean {
    const idx = h & (table.length - 1);
    const bucket = table[idx];
    if (!bucket) return false;
    const pos = bucket.indexOf(key);
    if (pos === -1) return false;
    bucket[pos] = bucket[bucket.length - 1]!; // swap-remove: order does not matter
    bucket.pop();
    if (bucket.length === 0) table[idx] = undefined;
    return true;
  }

  #startResize(size: number): void {
    this.#old = this.#table;
    this.#table = new Array(size);
    this.#rehashIdx = 0;
    this.#rehashStep(STEP_BUCKETS);
  }

  /** Move up to `n` non-empty buckets from the old table (visiting at most n*10 empty ones). */
  #rehashStep(n: number): void {
    const old = this.#old;
    if (!old) return;
    let emptyVisits = n * 10;
    while (n > 0 && this.#rehashIdx < old.length) {
      const bucket = old[this.#rehashIdx];
      if (!bucket) {
        this.#rehashIdx++;
        if (--emptyVisits === 0) return;
        continue;
      }
      for (const key of bucket) this.#bucketAdd(this.#table, key);
      old[this.#rehashIdx] = undefined;
      this.#rehashIdx++;
      n--;
    }
    if (this.#rehashIdx >= old.length) {
      this.#old = null;
      this.#rehashIdx = 0;
    }
  }
}
