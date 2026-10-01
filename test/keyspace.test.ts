import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keyspace } from '../src/keyspace.js';

function fullScan<V>(ks: Keyspace<V>, count: number, between?: (step: number) => void): string[] {
  const seen: string[] = [];
  let cursor = 0;
  let step = 0;
  do {
    const batch: string[] = [];
    let budget = count;
    do {
      cursor = ks.scanStep(cursor, batch);
    } while (cursor !== 0 && --budget > 0);
    seen.push(...batch);
    between?.(step++);
  } while (cursor !== 0);
  return seen;
}

test('basic map behaviour', () => {
  const ks = new Keyspace<number>();
  ks.set('a', 1);
  ks.set('a', 2);
  assert.equal(ks.get('a'), 2);
  assert.equal(ks.size, 1);
  assert.equal(ks.delete('a'), true);
  assert.equal(ks.delete('a'), false);
  assert.equal(ks.size, 0);
});

test('a full scan on a stable table returns every key exactly once', () => {
  const ks = new Keyspace<number>();
  for (let i = 0; i < 5000; i++) ks.set(`key:${i}`, i);
  const seen = fullScan(ks, 10);
  assert.equal(seen.length, 5000);
  assert.equal(new Set(seen).size, 5000);
});

test('scan of an empty table ends immediately', () => {
  const ks = new Keyspace<number>();
  const out: string[] = [];
  let c = 0;
  let steps = 0;
  do {
    c = ks.scanStep(c, out);
    steps++;
  } while (c !== 0);
  assert.equal(out.length, 0);
  assert.equal(steps, 16);
});

test('keys present for the whole scan are returned even while the table grows', () => {
  const ks = new Keyspace<number>();
  const stable = Array.from({ length: 300 }, (_, i) => `stable:${i}`);
  for (const k of stable) ks.set(k, 0);
  const before = ks.bucketCount;
  let n = 0;
  const seen = new Set(
    fullScan(ks, 3, (step) => {
      // Grow for a while, then stop (a table growing faster than it is scanned never finishes - same as Redis).
      if (step < 40) for (let i = 0; i < 200; i++) ks.set(`grow:${n++}`, 0);
    }),
  );
  assert.ok(ks.bucketCount > before * 8, `table should have grown several times (${before} -> ${ks.bucketCount})`);
  for (const k of stable) assert.ok(seen.has(k), `missing ${k}`);
});

test('keys present for the whole scan are returned even while the table shrinks', () => {
  const ks = new Keyspace<number>();
  const stable = Array.from({ length: 50 }, (_, i) => `stable:${i}`);
  const doomed = Array.from({ length: 20000 }, (_, i) => `doomed:${i}`);
  for (const k of [...stable, ...doomed]) ks.set(k, 0);
  const before = ks.bucketCount;
  const seen = new Set(
    fullScan(ks, 5, () => {
      for (let i = 0; i < 400 && doomed.length; i++) ks.delete(doomed.pop()!);
    }),
  );
  assert.ok(ks.bucketCount < before, `table should have shrunk (${before} -> ${ks.bucketCount})`);
  for (const k of stable) assert.ok(seen.has(k), `missing ${k}`);
});

test('random churn never loses a stable key', () => {
  for (let round = 0; round < 20; round++) {
    const ks = new Keyspace<number>();
    const stable = Array.from({ length: 200 }, (_, i) => `s:${round}:${i}`);
    for (const k of stable) ks.set(k, 0);
    const churn: string[] = [];
    let n = 0;
    const seen = new Set(
      fullScan(ks, 1 + (round % 7), () => {
        const adds = Math.floor(Math.random() * 300);
        for (let i = 0; i < adds; i++) {
          const k = `c:${n++}`;
          ks.set(k, 0);
          churn.push(k);
        }
        const dels = Math.floor(Math.random() * churn.length);
        for (let i = 0; i < dels; i++) ks.delete(churn.splice(Math.floor(Math.random() * churn.length), 1)[0]!);
      }),
    );
    for (const k of stable) assert.ok(seen.has(k), `round ${round}: missing ${k}`);
  }
});

test('growth is incremental: rehashing spreads over later writes', () => {
  const ks = new Keyspace<number>();
  let i = 0;
  while (!ks.isRehashing) ks.set(`k${i++}`, 0);
  const startedAt = i;
  while (ks.isRehashing) ks.set(`k${i++}`, 0);
  assert.ok(i - startedAt > 1, 'rehash should take several writes, not one');
  for (let j = 0; j < i; j++) assert.equal(ks.get(`k${j}`), 0);
  const seen = new Set(fullScan(ks, 10));
  assert.equal(seen.size, i);
});

test('rehashFor() finishes a rehash from the timer', () => {
  const ks = new Keyspace<number>();
  let i = 0;
  while (!ks.isRehashing) ks.set(`k${i++}`, 0);
  ks.rehashFor(50);
  assert.equal(ks.isRehashing, false);
});
