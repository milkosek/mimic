import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Daemon } from '../src/daemon.js';
import { sleep, startTestDaemon } from './helpers.js';

let d: Daemon;
let base: string;
const TOKEN = 'secret';

before(async () => {
  d = await startTestDaemon({ password: TOKEN });
  base = `http://127.0.0.1:${d.httpPort}`;
});
after(() => d.close());

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('/health is public, everything else needs the token', async () => {
  assert.equal((await call('GET', '/health', undefined, null)).status, 200);
  assert.equal((await call('GET', '/info', undefined, null)).status, 401);
  assert.equal((await call('GET', '/info', undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', '/info')).status, 200);
});

test('POST /command accepts array and object form, errors are 400', async () => {
  assert.deepEqual((await call('POST', '/command', ['SET', 'greeting', 'cześć'])).body, { result: 'OK' });
  assert.deepEqual((await call('POST', '/command', { command: 'GET', args: ['greeting'] })).body, { result: 'cześć' });
  assert.deepEqual((await call('POST', '/command', ['STRLEN', 'greeting'])).body, { result: 7 }); // UTF-8 bytes, like Redis
  const bad = await call('POST', '/command', ['INCR', 'greeting']);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not an integer/);
  assert.equal((await call('POST', '/command', ['AUTH', 'x'])).status, 400); // RESP-only command
});

test('POST /pipeline runs commands in order', async () => {
  const { body } = await call('POST', '/pipeline', [['SET', 'c', 1], ['INCRBY', 'c', 4], ['GET', 'c'], ['NOPE']]);
  assert.deepEqual(body.results.slice(0, 3), [{ result: 'OK' }, { result: 5 }, { result: '5' }]);
  assert.match(body.results[3].error, /unknown command/);
});

test('REST key routes with TTL; JSON values are stored as JSON text', async () => {
  assert.equal((await call('PUT', '/keys/session%3Aabc', { value: { user: 42 }, px: 80 })).status, 200);
  const got = await call('GET', '/keys/session%3Aabc');
  assert.equal(got.body.value, '{"user":42}');
  assert.ok(got.body.ttlMs > 0);
  assert.equal((await call('PUT', '/keys/session%3Aabc', { value: 1, nx: true })).status, 409);
  await sleep(120);
  assert.equal((await call('GET', '/keys/session%3Aabc')).status, 404);
  assert.deepEqual((await call('DELETE', '/keys/greeting')).body, { deleted: 1 });
});

test('GET /keys with and without a cursor', async () => {
  await call('POST', '/pipeline', [['SET', 'scan:1', 'a'], ['SET', 'scan:2', 'b'], ['HSET', 'scan:h', 'f', 'v']]);
  assert.deepEqual((await call('GET', '/keys?pattern=scan:*')).body.keys.sort(), ['scan:1', 'scan:2', 'scan:h']);
  const keys: string[] = [];
  let cursor = '0';
  do {
    const { body } = await call('GET', `/keys?pattern=scan:*&count=1&cursor=${cursor}`);
    keys.push(...body.keys);
    cursor = body.cursor;
  } while (cursor !== '0');
  assert.deepEqual(keys.sort(), ['scan:1', 'scan:2', 'scan:h']);
});

test('bad JSON and unknown routes', async () => {
  const res = await fetch(`${base}/command`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal((await call('GET', '/nope')).status, 404);
});
