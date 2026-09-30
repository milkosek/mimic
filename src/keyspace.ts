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
// This is achieved with Redis' "reverse binary iteration" (see dictScan() in
// Redis' dict.c): the cursor's bits are incremented from the most significant
// end, so after a resize every not-yet-visited bucket maps onto buckets that
// have not been visited either. A key may be returned more than once (after a
// shrink); callers de-duplicate if they care, exactly as with Redis.

const MIN_BUCKETS = 16; // must be a power of two
const MAX_BUCKETS = 2 ** 30;
const GROW_LOAD = 4; // average keys per bucket before doubling
const SHRINK_LOAD = 0.5; // average keys per bucket before halving

/** Reverse the bits of a 32-bit unsigned integer. */
function rev32(v: number): number {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  return ((v >>> 16) | (v << 16)) >>> 0;
}

export class Keyspace<V> {
  #map = new Map<string, V>();
  #buckets: (string[] | undefined)[] = new Array(MIN_BUCKETS);
  // Random seed so bucket placement is not predictable from outside.
  readonly #seed = (Math.random() * 0x100000000) >>> 0;

  get size(): number {
    return this.#map.size;
  }

  /** Current number of buckets (exposed for INFO and tests). */
  get bucketCount(): number {
    return this.#buckets.length;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  set(key: string, value: V): void {
    if (!this.#map.has(key)) {
      this.#bucketAdd(this.#buckets, key);
      this.#map.set(key, value);
      if (this.#map.size > this.#buckets.length * GROW_LOAD && this.#buckets.length < MAX_BUCKETS) {
        this.#resize(this.#buckets.length * 2);
      }
    } else {
      this.#map.set(key, value);
    }
  }

  delete(key: string): boolean {
    if (!this.#map.delete(key)) return false;
    const idx = this.#hash(key) & (this.#buckets.length - 1);
    const bucket = this.#buckets[idx]!;
    const pos = bucket.indexOf(key);
    // swap-remove: bucket order does not matter
    bucket[pos] = bucket[bucket.length - 1]!;
    bucket.pop();
    if (bucket.length === 0) this.#buckets[idx] = undefined;
    if (this.#buckets.length > MIN_BUCKETS && this.#map.size < this.#buckets.length * SHRINK_LOAD) {
      this.#resize(this.#buckets.length / 2);
    }
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#buckets = new Array(MIN_BUCKETS);
  }

  keys(): IterableIterator<string> {
    return this.#map.keys();
  }

  entries(): IterableIterator<[string, V]> {
    return this.#map.entries();
  }

  /**
   * Visit one bucket: push its keys into `out` and return the next cursor
   * (0 when the iteration is complete).
   */
  scanStep(cursor: number, out: string[]): number {
    const mask = this.#buckets.length - 1;
    const bucket = this.#buckets[cursor & mask];
    if (bucket) for (const key of bucket) out.push(key);
    // Set the unmasked high bits, then increment the reversed cursor.
    let v = (cursor | ~mask) >>> 0;
    v = rev32(v);
    v = (v + 1) >>> 0;
    return rev32(v);
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

  #bucketAdd(buckets: (string[] | undefined)[], key: string): void {
    const idx = this.#hash(key) & (buckets.length - 1);
    const bucket = buckets[idx];
    if (bucket) bucket.push(key);
    else buckets[idx] = [key];
  }

  // Rehash everything at once. Amortised O(1) per insert; see README for the
  // incremental-rehash idea if multi-million-key tables ever need it.
  #resize(size: number): void {
    const next: (string[] | undefined)[] = new Array(size);
    for (const key of this.#map.keys()) this.#bucketAdd(next, key);
    this.#buckets = next;
  }
}
