// Compatibility tests against real Redis client libraries and redis-cli.
// Run with: npm run test:compat

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import type { Daemon } from '../src/daemon.js';
import { sleep, startTestDaemon } from './helpers.js';

let d: Daemon;
before(async () => {
  d = await startTestDaemon({ httpPort: null, password: 'pw' });
});
after(() => d.close());

describe('ioredis', () => {
  let r: Redis;
  before(async () => {
    r = new Redis({ port: d.respPort, host: '127.0.0.1', password: 'pw', connectionName: 'ioredis-test', lazyConnect: true });
    await r.connect(); // includes the INFO ready check
  });
  after(() => r.quit());

  test('strings, TTL and counters', async () => {
    assert.equal(await r.set('io:k', 'v', 'EX', 60), 'OK');
    assert.equal(await r.get('io:k'), 'v');
    assert.equal(await r.ttl('io:k'), 60);
    assert.equal(await r.set('io:k', 'v2', 'EX', 60, 'NX'), null);
    assert.equal(await r.incrby('io:n', 5), 5);
    assert.equal(await r.getex('io:k', 'PX', 5000), 'v');
    assert.ok((await r.pttl('io:k')) <= 5000);
  });

  test('pipeline and multi-key commands', async () => {
    const res = await r.pipeline().set('io:a', '1').set('io:b', '2').mget('io:a', 'io:b', 'io:none').exec();
    assert.deepEqual(res, [[null, 'OK'], [null, 'OK'], [null, ['1', '2', null]]]);
    assert.equal(await r.del('io:a', 'io:b'), 2);
  });

  test('binary Buffers round-trip', async () => {
    const bin = Buffer.from([0, 255, 13, 10, 42]);
    await r.set('io:bin', bin);
    assert.deepEqual(await r.getBuffer('io:bin'), bin);
  });

  test('hashes return objects, lists work', async () => {
    await r.hset('io:h', { a: '1', b: '2' });
    assert.deepEqual(await r.hgetall('io:h'), { a: '1', b: '2' });
    await r.rpush('io:l', 'x', 'y', 'z');
    assert.deepEqual(await r.lrange('io:l', 0, -1), ['x', 'y', 'z']);
  });

  test('scanStream visits every key', async () => {
    const pipe = r.pipeline();
    for (let i = 0; i < 1000; i++) pipe.set(`io:scan:${i}`, 'x');
    await pipe.exec();
    const seen = new Set<string>();
    for await (const keys of r.scanStream({ match: 'io:scan:*', count: 50 })) for (const k of keys as string[]) seen.add(k);
    assert.equal(seen.size, 1000);
  });

  test('errors surface as ReplyError', async () => {
    await assert.rejects(r.incr('io:k'), /not an integer/);
    await assert.rejects(r.hget('io:k', 'f'), /WRONGTYPE/);
  });

  test('MULTI/EXEC and WATCH', async () => {
    const res = await r.multi().set('io:tx', '1').incr('io:tx').exec();
    assert.deepEqual(res, [[null, 'OK'], [null, 2]]);
    const other = r.duplicate();
    await r.watch('io:tx');
    await other.set('io:tx', '100');
    assert.equal(await r.multi().set('io:tx', '0').exec(), null); // aborted
    other.disconnect();
  });

  test('client name was set', async () => {
    assert.equal(await r.client('GETNAME'), 'ioredis-test');
  });
});

describe('node-redis', () => {
  let c: ReturnType<typeof createClient>;
  before(async () => {
    c = createClient({ socket: { port: d.respPort, host: '127.0.0.1' }, password: 'pw', name: 'node-redis-test' });
    c.on('error', () => {});
    await c.connect();
  });
  after(async () => {
    await c.quit().catch(() => c.destroy());
  });

  test('strings with options', async () => {
    assert.equal(await c.set('nr:k', 'v', { EX: 30 }), 'OK');
    assert.equal(await c.get('nr:k'), 'v');
    assert.equal(await c.ttl('nr:k'), 30);
    assert.equal(await c.set('nr:k', 'x', { NX: true }), null);
  });

  test('hashes, lists, counters', async () => {
    await c.hSet('nr:h', { f1: 'a', f2: 'b' });
    assert.deepEqual({ ...(await c.hGetAll('nr:h')) }, { f1: 'a', f2: 'b' });
    await c.rPush('nr:l', ['1', '2', '3']);
    assert.deepEqual(await c.lRange('nr:l', 0, -1), ['1', '2', '3']);
    assert.equal(await c.incrBy('nr:n', 10), 10);
  });

  test('scanIterator visits every key', async () => {
    for (let i = 0; i < 300; i++) await c.set(`nr:scan:${i}`, 'x');
    const seen = new Set<string>();
    for await (const batch of c.scanIterator({ MATCH: 'nr:scan:*', COUNT: 25 })) {
      for (const k of [batch].flat() as string[]) seen.add(k);
    }
    assert.equal(seen.size, 300);
  });

  test('multi-command pipelines (auto-pipelining)', async () => {
    const [a, b] = await Promise.all([c.incr('nr:p'), c.incr('nr:p')]);
    assert.deepEqual([a, b], [1, 2]);
  });

  test('MULTI/EXEC', async () => {
    const res = await c.multi().set('nr:tx', '5').incrBy('nr:tx', 5).get('nr:tx').exec();
    assert.deepEqual(res, ['OK', 10, '10']);
  });

  test('keys expire', async () => {
    await c.set('nr:short', 'x', { PX: 30 });
    await sleep(60);
    assert.equal(await c.get('nr:short'), null);
  });
});

// Must be async: the server runs in this same process, a sync child would deadlock it.
const execFileAsync = promisify(execFile);
async function redisCli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('redis-cli', ['-p', String(d.respPort), '-a', 'pw', '--no-auth-warning', ...args]);
  return stdout.trim();
}

let hasRedisCli = true;
try {
  execFileSync('redis-cli', ['--version'], { stdio: 'ignore' });
} catch {
  hasRedisCli = false;
}

describe('redis-cli', { skip: hasRedisCli ? false : 'redis-cli not installed' }, () => {
  test('basic commands', async () => {
    assert.equal(await redisCli('PING'), 'PONG');
    assert.equal(await redisCli('SET', 'cli:k', 'hello', 'EX', '100'), 'OK');
    assert.equal(await redisCli('GET', 'cli:k'), 'hello');
    assert.equal(await redisCli('TTL', 'cli:k'), '100');
    assert.match(await redisCli('INFO', 'server'), /redis_version:/);
  });

  test('--scan iterates the keyspace', async () => {
    for (let i = 0; i < 50; i++) await redisCli('SET', `cli:scan:${i}`, 'x');
    const keys = (await redisCli('--scan', '--pattern', 'cli:scan:*')).split('\n');
    assert.equal(new Set(keys).size, 50);
  });
});
