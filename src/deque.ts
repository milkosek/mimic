// SPDX-License-Identifier: Apache-2.0
//
// Growable ring buffer: O(1) push/pop at both ends (LPUSH/RPUSH/LPOP/RPOP),
// O(1) random access (LINDEX). A plain array's unshift() is O(n), which makes
// LPUSH on long lists quadratic.

export class Deque<T> {
  #buf: (T | undefined)[];
  #mask: number;
  #head = 0;
  #len = 0;

  constructor(items?: Iterable<T>) {
    this.#buf = new Array(8);
    this.#mask = 7;
    if (items) for (const item of items) this.push(item);
  }

  get length(): number {
    return this.#len;
  }

  at(index: number): T | undefined {
    const i = index < 0 ? this.#len + index : index;
    if (i < 0 || i >= this.#len) return undefined;
    return this.#buf[(this.#head + i) & this.#mask];
  }

  push(value: T): void {
    if (this.#len === this.#buf.length) this.#resize(this.#buf.length * 2);
    this.#buf[(this.#head + this.#len) & this.#mask] = value;
    this.#len++;
  }

  unshift(value: T): void {
    if (this.#len === this.#buf.length) this.#resize(this.#buf.length * 2);
    this.#head = (this.#head - 1) & this.#mask;
    this.#buf[this.#head] = value;
    this.#len++;
  }

  shift(): T | undefined {
    if (this.#len === 0) return undefined;
    const value = this.#buf[this.#head];
    this.#buf[this.#head] = undefined;
    this.#head = (this.#head + 1) & this.#mask;
    this.#len--;
    this.#maybeShrink();
    return value;
  }

  pop(): T | undefined {
    if (this.#len === 0) return undefined;
    const idx = (this.#head + this.#len - 1) & this.#mask;
    const value = this.#buf[idx];
    this.#buf[idx] = undefined;
    this.#len--;
    this.#maybeShrink();
    return value;
  }

  /** Items in [start, end) as an array. Indices must already be normalised. */
  slice(start = 0, end = this.#len): T[] {
    const s = Math.max(0, start);
    const e = Math.min(this.#len, end);
    const out = new Array<T>(Math.max(0, e - s));
    for (let i = s; i < e; i++) out[i - s] = this.#buf[(this.#head + i) & this.#mask] as T;
    return out;
  }

  /** Keep only [start, end) (LTRIM). */
  keep(start: number, end: number): void {
    const items = this.slice(start, end);
    this.#buf = new Array(8);
    this.#mask = 7;
    this.#head = 0;
    this.#len = 0;
    for (const item of items) this.push(item);
  }

  toArray(): T[] {
    return this.slice();
  }

  [Symbol.iterator](): Iterator<T> {
    return this.toArray()[Symbol.iterator]();
  }

  #maybeShrink(): void {
    if (this.#buf.length > 64 && this.#len < this.#buf.length / 4) this.#resize(this.#buf.length / 2);
  }

  #resize(capacity: number): void {
    const next = new Array<T | undefined>(capacity);
    for (let i = 0; i < this.#len; i++) next[i] = this.#buf[(this.#head + i) & this.#mask];
    this.#buf = next;
    this.#mask = capacity - 1;
    this.#head = 0;
  }
}
