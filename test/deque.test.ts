import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deque } from '../src/deque.js';

test('behaves like an array under random operations', () => {
  const d = new Deque<number>();
  const ref: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const op = Math.floor(Math.random() * 4);
    if (op === 0) (d.push(i), ref.push(i));
    else if (op === 1) (d.unshift(i), ref.unshift(i));
    else if (op === 2) assert.equal(d.shift(), ref.shift());
    else assert.equal(d.pop(), ref.pop());
    assert.equal(d.length, ref.length);
  }
  assert.deepEqual(d.toArray(), ref);
  assert.equal(d.at(-1), ref.at(-1));
  assert.deepEqual(d.slice(2, 10), ref.slice(2, 10));
});

test('keep() trims to a range', () => {
  const d = new Deque([1, 2, 3, 4, 5]);
  d.keep(1, 4);
  assert.deepEqual(d.toArray(), [2, 3, 4]);
});
