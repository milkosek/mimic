import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { execute } from '../src/commands.js';
import { MapReply, OK } from '../src/reply.js';
import { Store } from '../src/store.js';
import { sleep } from './helpers.js';

let store: Store;
const run = (...argv: string[]) => execute({ store }, argv);

beforeEach(() => {
  store = Store.getInstance({ cleanupIntervalMs: 20 });
});
afterEach(() => Store.resetInstance());

test('is a singleton', () => {
  assert.equal(Store.getInstance(), store);
  assert.throws(() => new Store(), /singleton/);
});

test('SET / GET / DEL', () => {
  assert.equal(run('SET', 'a', 'hello'), OK);
  assert.equal(run('GET', 'a'), 'hello');
  assert.equal(run('DEL', 'a', 'missing'), 1);
  assert.equal(run('GET', 'a'), null);
});

test('SET NX / XX / GET', () => {
  assert.equal(run('SET', 'k', '1', 'XX'), null);
  assert.equal(run('SET', 'k', '1', 'NX'), OK);
  assert.equal(run('SET', 'k', '2', 'NX'), null);
  assert.equal(run('SET', 'k', '3', 'GET'), '1');
  assert.equal(run('GET', 'k'), '3');
  assert.throws(() => run('SET', 'k', 'v', 'NX', 'XX'), /syntax error/);
  assert.throws(() => run('SET', 'k', 'v', 'EX', '0'), /invalid expire time/);
  assert.throws(() => run('SET', 'k', 'v', 'EX', '10', 'PX', '10'), /syntax error/);
});

test('lazy expiration removes a key on access', async () => {
  run('SET', 'tmp', 'x', 'PX', '30');
  assert.equal(run('GET', 'tmp'), 'x');
  await sleep(50);
  assert.equal(store.dbsize(), 1, 'no cleanup timer running: key is still physically present');
  assert.equal(run('GET', 'tmp'), null);
  assert.equal(store.dbsize(), 0);
  assert.equal(store.info().expiredLazy, 1);
});

test('active expiration reclaims keys nobody reads', async () => {
  store.start();
  for (let i = 0; i < 500; i++) run('SET', `k${i}`, String(i), 'PX', '20');
  run('SET', 'keeper', 'stay');
  await sleep(200);
  assert.equal(store.dbsize(), 1);
  assert.equal(store.info().expiredActive, 500);
  assert.equal(run('GET', 'keeper'), 'stay');
});

test('TTL / PTTL / PERSIST / EXPIRE semantics', () => {
  assert.equal(run('TTL', 'nope'), -2);
  run('SET', 'k', 'v');
  assert.equal(run('TTL', 'k'), -1);
  assert.equal(run('EXPIRE', 'k', '100'), 1);
  assert.equal(run('TTL', 'k'), 100);
  assert.equal(run('PERSIST', 'k'), 1);
  assert.equal(run('TTL', 'k'), -1);
  run('SET', 'k', 'v', 'EX', '10');
  run('SET', 'k', 'v2'); // plain SET clears the TTL
  assert.equal(run('TTL', 'k'), -1);
  run('SET', 'k', 'v', 'EX', '10');
  run('SET', 'k', 'v3', 'KEEPTTL');
  assert.equal(run('TTL', 'k'), 10);
  assert.equal(run('EXPIRE', 'k', '-1'), 1); // expire in the past deletes
  assert.equal(run('EXISTS', 'k'), 0);
});

test('EXPIRE NX / XX / GT / LT', () => {
  run('SET', 'k', 'v');
  assert.equal(run('EXPIRE', 'k', '100', 'XX'), 0);
  assert.equal(run('EXPIRE', 'k', '100', 'GT'), 0); // no TTL counts as infinite
  assert.equal(run('EXPIRE', 'k', '100', 'NX'), 1);
  assert.equal(run('EXPIRE', 'k', '200', 'NX'), 0);
  assert.equal(run('EXPIRE', 'k', '50', 'GT'), 0);
  assert.equal(run('EXPIRE', 'k', '200', 'GT'), 1);
  assert.equal(run('EXPIRE', 'k', '300', 'LT'), 0);
  assert.equal(run('EXPIRE', 'k', '30', 'LT'), 1);
  assert.equal(run('TTL', 'k'), 30);
  assert.throws(() => run('EXPIRE', 'k', '1', 'NX', 'XX'), /not compatible/);
});

test('GETEX sets or clears the TTL (sliding expiration)', () => {
  run('SET', 'session', 'data', 'EX', '5');
  assert.equal(run('GETEX', 'session', 'EX', '60'), 'data');
  assert.equal(run('TTL', 'session'), 60);
  assert.equal(run('GETEX', 'session', 'PERSIST'), 'data');
  assert.equal(run('TTL', 'session'), -1);
  assert.equal(run('GETEX', 'missing', 'EX', '5'), null);
});

test('INCR is exact 64-bit, keeps the TTL and rejects non-integers', () => {
  run('SET', 'n', '10', 'EX', '100');
  assert.equal(run('INCRBY', 'n', '5'), 15n);
  assert.equal(run('TTL', 'n'), 100);
  assert.equal(run('GET', 'n'), '15');
  run('SET', 'max', '9223372036854775806');
  assert.equal(run('INCR', 'max'), 9223372036854775807n);
  assert.throws(() => run('INCR', 'max'), /overflow/);
  run('SET', 's', 'abc');
  assert.throws(() => run('INCR', 's'), /not an integer/);
  assert.throws(() => run('INCR', 'n', 'extra'), /wrong number of arguments/);
});

test('strings are binary-safe and byte-counted', () => {
  const utf8 = Buffer.from('zażółć', 'utf8').toString('latin1');
  run('SET', 'u', utf8);
  assert.equal(run('STRLEN', 'u'), 10);
  assert.equal(run('APPEND', 'u', '!'), 11);
  assert.equal(run('GETRANGE', 'u', '0', '1'), 'za');
});

test('hashes and lists, WRONGTYPE and removal of empty keys', () => {
  assert.equal(run('HSET', 'h', 'a', '1', 'b', '2'), 2);
  assert.deepEqual((run('HGETALL', 'h') as MapReply).entries, [['a', '1'], ['b', '2']]);
  assert.deepEqual(run('HMGET', 'h', 'a', 'zz'), ['1', null]);
  assert.equal(run('HINCRBY', 'h', 'a', '9'), 10n);
  assert.throws(() => run('GET', 'h'), { message: /^WRONGTYPE / });
  run('HDEL', 'h', 'a', 'b');
  assert.equal(run('EXISTS', 'h'), 0);

  run('RPUSH', 'l', 'a', 'b', 'c');
  run('LPUSH', 'l', 'z');
  assert.deepEqual(run('LRANGE', 'l', '0', '-1'), ['z', 'a', 'b', 'c']);
  assert.deepEqual(run('LRANGE', 'l', '-2', '-1'), ['b', 'c']);
  assert.equal(run('LINDEX', 'l', '-1'), 'c');
  assert.equal(run('RPOP', 'l'), 'c');
  assert.deepEqual(run('LPOP', 'l', '5'), ['z', 'a', 'b']);
  assert.equal(run('EXISTS', 'l'), 0);
  run('RPUSH', 'capped', '1', '2', '3', '4', '5');
  run('LTRIM', 'capped', '-3', '-1');
  assert.deepEqual(run('LRANGE', 'capped', '0', '-1'), ['3', '4', '5']);
});

test('KEYS and SCAN skip expired keys; SCAN supports MATCH, COUNT and TYPE', async () => {
  run('SET', 'user:1', 'a');
  run('SET', 'user:2', 'b', 'PX', '10');
  run('SET', 'order:1', 'c');
  run('HSET', 'user:hash', 'f', 'v');
  await sleep(20);
  assert.deepEqual((run('KEYS', 'user:*') as string[]).sort(), ['user:1', 'user:hash']);
  assert.deepEqual((run('KEYS', '*:[1]') as string[]).sort(), ['order:1', 'user:1']);

  const scanAll = (...opts: string[]): string[] => {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = run('SCAN', cursor, ...opts) as [string, string[]];
      out.push(...keys);
      cursor = next;
    } while (cursor !== '0');
    return out.sort();
  };
  assert.deepEqual(scanAll('COUNT', '1'), ['order:1', 'user:1', 'user:hash']);
  assert.deepEqual(scanAll('MATCH', 'user:*'), ['user:1', 'user:hash']);
  assert.deepEqual(scanAll('TYPE', 'hash'), ['user:hash']);
  assert.throws(() => run('SCAN', 'abc'), /invalid cursor/);
});

test('unknown commands and arity errors look like Redis', () => {
  assert.throws(() => run('NOPE', 'a'), { message: "ERR unknown command 'NOPE', with args beginning with: 'a'" });
  assert.throws(() => run('GET'), { message: "ERR wrong number of arguments for 'get' command" });
  assert.throws(() => run('MSET', 'a', '1', 'b'), /wrong number of arguments for 'mset'/);
});
