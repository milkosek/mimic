// Differential test: the same commands are sent to MIMIC and to a real
// redis-server, and the raw reply bytes must be identical.
// Skipped when redis-server is not installed. Run with: npm run test:compat

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { Daemon } from '../src/daemon.js';
import { cmd, sleep, startTestDaemon } from './helpers.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;

/** Length of the first complete RESP2/RESP3 reply in `b` starting at `i`, or -1 if incomplete. */
function replyEnd(b: Buffer, i = 0): number {
  if (i >= b.length) return -1;
  const lineEnd = b.indexOf('\r\n', i);
  if (lineEnd === -1) return -1;
  const type = String.fromCharCode(b[i]!);
  const head = b.toString('latin1', i + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case '+': case '-': case ':': case '_': case ',': case '#': case '(':
      return next;
    case '$': case '=': case '!': {
      const n = Number(head);
      if (n < 0) return next;
      return next + n + 2 <= b.length ? next + n + 2 : -1;
    }
    case '*': case '~': case '>': case '%': {
      let n = Number(head);
      if (n < 0) return next;
      if (type === '%') n *= 2;
      let pos = next;
      for (let k = 0; k < n; k++) {
        pos = replyEnd(b, pos);
        if (pos === -1) return -1;
      }
      return pos;
    }
    default:
      throw new Error(`unknown reply type ${type}`);
  }
}

/** A connection that sends one command and waits for exactly one reply (or the close). */
class Conn {
  #socket: net.Socket;
  #buf = Buffer.alloc(0);
  #closed = false;
  #wake: (() => void) | null = null;

  constructor(port: number) {
    this.#socket = net.connect(port, '127.0.0.1');
    this.#socket.on('data', (c) => {
      this.#buf = Buffer.concat([this.#buf, c]);
      this.#wake?.();
    });
    this.#socket.on('close', () => {
      this.#closed = true;
      this.#wake?.();
    });
    this.#socket.on('error', () => {});
  }

  async send(payload: Buffer | string): Promise<string> {
    this.#socket.write(payload);
    for (;;) {
      const end = replyEnd(this.#buf);
      if (end !== -1) {
        const reply = this.#buf.toString('latin1', 0, end);
        this.#buf = this.#buf.subarray(end);
        return reply;
      }
      if (this.#closed) {
        const rest = this.#buf.toString('latin1');
        this.#buf = Buffer.alloc(0);
        return `${rest}<closed>`;
      }
      await new Promise<void>((r) => {
        this.#wake = r;
        setTimeout(r, 2000);
      });
      this.#wake = null;
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}

let redis: ChildProcess | undefined;
let redisPort = 0;
let mimic: Daemon;

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

describe('MIMIC vs redis-server', { skip: hasRedis ? false : 'redis-server not installed' }, () => {
  before(async () => {
    redisPort = await freePort();
    redis = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise<boolean>((r) => {
        const s = net.connect(redisPort, '127.0.0.1', () => (s.destroy(), r(true)));
        s.on('error', () => r(false));
      });
      if (ok) break;
      await sleep(50);
    }
    mimic = await startTestDaemon({ httpPort: null });
  });
  after(async () => {
    redis?.kill();
    await mimic?.close();
  });

  /** Run `commands` on fresh connections to both servers and compare reply by reply. */
  async function compare(name: string, commands: (string[] | Buffer | string)[], setup: string[][] = []): Promise<void> {
    const r = new Conn(redisPort);
    const m = new Conn(mimic.respPort);
    try {
      for (const c of [['FLUSHALL'], ...setup]) {
        await r.send(cmd(...c));
        await m.send(cmd(...c));
      }
      for (const c of commands) {
        const payload = Array.isArray(c) ? cmd(...c) : c;
        const [a, b] = [await r.send(payload), await m.send(payload)];
        assert.equal(b, a, `${name}: ${JSON.stringify(Array.isArray(c) ? c : c.toString())}\n  redis: ${JSON.stringify(a)}\n  mimic: ${JSON.stringify(b)}`);
        if (a.endsWith('<closed>')) break;
      }
    } finally {
      r.close();
      m.close();
    }
  }

  test('strings and SET options', () =>
    compare('strings', [
      ['SET', 'k', 'v'], ['GET', 'k'], ['GET', 'nope'], ['SET', 'k', 'v2', 'XX'], ['SET', 'k', 'v3', 'NX'], ['SET', 'n', '1', 'NX'],
      ['SET', 'k', 'v4', 'GET'], ['SET', 'new', 'x', 'GET'], ['SET', 'k', 'v', 'NX', 'XX'], ['SET', 'k', 'v', 'XX', 'NX'],
      ['SET', 'k', 'v', 'EX', '10', 'PX', '100'], ['SET', 'k', 'v', 'EX', '1', 'EX', '2'], ['SET', 'k', 'v', 'KEEPTTL', 'EX', '5'],
      ['SET', 'k', 'v', 'EX', '5', 'KEEPTTL'], ['SET', 'k', 'v', 'EX'], ['SET', 'k', 'v', 'EX', 'abc'], ['SET', 'k', 'v', 'EX', '0'],
      ['SET', 'k', 'v', 'EX', '-5'], ['SET', 'k', 'v', 'PX', '0'], ['SET', 'k', 'v', 'EX', '99999999999999999'],
      ['SET', 'k', 'v', 'EX', '9223372036854775807'], ['SET', 'k', 'v', 'PX', '9223372036854775807'], ['SET', 'k', 'v', 'EX', '9223372036854775808'],
      ['SET', 'k', 'v', 'EXAT', '0'], ['SET', 'k', 'v', 'BOGUS'], ['SET', 'k', 'v', 'GET', 'GET'], ['SET', 'k', 'v', 'NX', 'NX'],
      ['SET', 'k', 'v', 'NX', 'GET'], ['SET', 'k'], ['SET'], ['SET', 'k', 'v', 'EX', '100'], ['TTL', 'k'], ['SET', 'k', 'v', 'KEEPTTL'], ['TTL', 'k'],
      ['SET', 'k', 'v'], ['TTL', 'k'], ['SET', 'past', 'v', 'EXAT', '1'], ['EXISTS', 'past'],
      ['SETNX', 'k', 'x'], ['SETNX', 'k2', 'x'], ['SETEX', 'k', '100', 'v'], ['TTL', 'k'], ['SETEX', 'k', '0', 'v'], ['SETEX', 'k', 'x', 'v'],
      ['PSETEX', 'k', '-1', 'v'], ['PSETEX', 'k', '100000', 'v'], ['GETSET', 'k', 'z'], ['GETSET', 'none', 'z'], ['GETDEL', 'k'], ['GETDEL', 'k'],
      ['MSET', 'a', '1', 'b', '2'], ['MSET', 'a', '1', 'b'], ['MGET', 'a', 'b', 'c'], ['MSETNX', 'a', '1', 'z', '2'], ['MSETNX', 'y', '1', 'z', '2'],
      ['APPEND', 'a', 'xyz'], ['APPEND', 'fresh', 'abc'], ['STRLEN', 'a'], ['STRLEN', 'none'], ['GETRANGE', 'a', '0', '1'],
      ['GETRANGE', 'a', '-2', '-1'], ['GETRANGE', 'a', '5', '1'], ['GETRANGE', 'a', '0', '99999999999999999999'], ['GETRANGE', 'none', '0', '-1'],
      ['GETRANGE', 'a', '0', '9223372036854775807'],
    ]));

  test('GETEX', () =>
    compare('getex', [
      ['GETEX', 'k'], ['GETEX', 'k', 'EX', '0'], ['SET', 'k', 'v'], ['GETEX', 'k', 'EX', '100'], ['TTL', 'k'], ['GETEX', 'k', 'PERSIST'],
      ['TTL', 'k'], ['GETEX', 'k', 'EX', '0'], ['GETEX', 'k', 'EX', 'x'], ['GETEX', 'k', 'EX', '1', 'PERSIST'], ['GETEX', 'k', 'PERSIST', 'EX', '1'],
      ['GETEX', 'k', 'EX', '1', 'EX', '2'], ['GETEX', 'k', 'NX'], ['GETEX', 'k', 'KEEPTTL'], ['GETEX', 'k', 'EX'], ['HSET', 'h', 'f', 'v'],
      ['GETEX', 'h', 'EX', '0'],
    ]));

  test('counters', () =>
    compare('incr', [
      ['INCR', 'n'], ['INCRBY', 'n', '10'], ['DECR', 'n'], ['DECRBY', 'n', '3'], ['INCRBY', 'n', '-100'], ['SET', 'z', '007'], ['INCR', 'z'],
      ['SET', 'z', ' 7'], ['INCR', 'z'], ['SET', 'z', '7 '], ['INCR', 'z'], ['SET', 'z', '+7'], ['INCR', 'z'], ['SET', 'z', '-0'], ['INCR', 'z'],
      ['SET', 'z', '0'], ['INCR', 'z'], ['INCRBY', 'n', '+5'], ['INCRBY', 'n', '05'], ['INCRBY', 'n', 'abc'], ['INCRBY', 'n', '1.5'],
      ['SET', 'max', '9223372036854775806'], ['INCR', 'max'], ['INCR', 'max'], ['SET', 'min', '-9223372036854775807'], ['DECR', 'min'], ['DECR', 'min'],
      ['INCRBY', 'n', '9223372036854775807'], ['INCRBY', 'q', '9223372036854775808'], ['DECRBY', 'q', '-9223372036854775808'],
      ['SET', 'f', '1.5'], ['INCR', 'f'], ['SET', 'e', ''], ['INCR', 'e'], ['HSET', 'h', 'f', '1'], ['INCR', 'h'], ['INCR'], ['INCR', 'a', 'b'],
      ['SET', 'n', '5', 'EX', '100'], ['INCR', 'n'], ['TTL', 'n'],
    ]));

  test('keys', () =>
    compare('keys', [
      ['SET', 'a', '1'], ['SET', 'b', '2'], ['DEL', 'a', 'b', 'c'], ['DEL', 'a'], ['SET', 'a', '1'], ['EXISTS', 'a', 'a', 'x'], ['TOUCH', 'a', 'x'],
      ['UNLINK', 'a'], ['TYPE', 'a'], ['SET', 's', 'x'], ['TYPE', 's'], ['HSET', 'h', 'f', 'v'], ['TYPE', 'h'], ['RPUSH', 'l', 'x'], ['TYPE', 'l'],
      ['RENAME', 's', 's2'], ['GET', 's2'], ['RENAME', 'nope', 'x'], ['RENAME', 's2', 's2'], ['RENAMENX', 's2', 'h'], ['RENAMENX', 's2', 's3'],
      ['RENAMENX', 'nope', 'x'], ['DBSIZE'], ['FLUSHDB'], ['DBSIZE'], ['FLUSHALL', 'ASYNC'], ['FLUSHALL', 'BAD'], ['SELECT', '0'], ['SELECT', '1'],
      ['SELECT', 'x'], ['ECHO', 'hi'], ['PING'], ['PING', 'hello'], ['PING', 'a', 'b'],
    ]));

  test('KEYS and SCAN (order-independent)', async () => {
    const setup = ['user:1', 'user:2', 'user:10', 'order:1', 'a*b', 'a?b', 'xyz'].map((k) => ['SET', k, 'v']);
    setup.push(['HSET', 'user:h', 'f', 'v']);
    for (const pattern of ['*', 'user:*', 'user:?', 'user:[12]', 'user:[^1]*', 'a\\*b', 'a?b', '*:1*', 'nomatch*', '[a-o]*', 'user:[12', 'user:[]', 'a\\[*', '[z-a]*', 'user:\\1', '*?*?*?*?*?*?*?*?x', 'x[^]', '\\', 'user:[1-]']) {
      const r = new Conn(redisPort);
      const m = new Conn(mimic.respPort);
      for (const c of [['FLUSHALL'], ...setup]) {
        await r.send(cmd(...c));
        await m.send(cmd(...c));
      }
      const parse = (reply: string): string[] => reply.split('\r\n').filter((_, i) => i > 0 && i % 2 === 0).sort();
      assert.deepEqual(parse(await m.send(cmd('KEYS', pattern))), parse(await r.send(cmd('KEYS', pattern))), `KEYS ${pattern}`);
      const scanAll = async (c: Conn, ...opts: string[]): Promise<string[]> => {
        const seen = new Set<string>();
        let cursor = '0';
        do {
          const reply = await c.send(cmd('SCAN', cursor, 'MATCH', pattern, ...opts));
          const lines = reply.split('\r\n');
          cursor = lines[2]!;
          for (let i = 4; i < lines.length; i += 2) if (lines[i]) seen.add(lines[i]!);
        } while (cursor !== '0');
        return [...seen].sort();
      };
      assert.deepEqual(await scanAll(m, 'COUNT', '2'), await scanAll(r, 'COUNT', '2'), `SCAN MATCH ${pattern}`);
      assert.deepEqual(await scanAll(m, 'TYPE', 'hash'), await scanAll(r, 'TYPE', 'hash'), `SCAN MATCH ${pattern} TYPE hash`);
      r.close();
      m.close();
    }
    await compare('scan errors', [['SCAN', 'x'], ['SCAN', '0', 'COUNT', '0'], ['SCAN', '0', 'COUNT', 'x'], ['SCAN', '0', 'MATCH'], ['SCAN', '0', 'BOGUS', '1'], ['SCAN', '-1']]);
  });

  test('TTL commands', () =>
    compare('ttl', [
      ['TTL', 'k'], ['PTTL', 'k'], ['SET', 'k', 'v'], ['TTL', 'k'], ['EXPIRE', 'k', '100'], ['TTL', 'k'], ['EXPIRE', 'nope', '100'],
      ['EXPIRE', 'k', 'x'], ['EXPIRE', 'k', '1.5'], ['EXPIRE', 'k', '9223372036854775807'], ['EXPIRE', 'k', '-9223372036854775808'],
      ['PEXPIRE', 'k', '9223372036854775807'], ['EXPIREAT', 'k', '9223372036854775807'], ['PEXPIREAT', 'k', '9223372036854775807'],
      ['EXPIRE', 'k', '100', 'NX'], ['EXPIRE', 'k', '200', 'XX'], ['TTL', 'k'], ['EXPIRE', 'k', '50', 'GT'], ['EXPIRE', 'k', '500', 'GT'], ['TTL', 'k'],
      ['EXPIRE', 'k', '600', 'LT'], ['EXPIRE', 'k', '60', 'LT'], ['TTL', 'k'], ['EXPIRE', 'k', '1', 'GT', 'LT'], ['EXPIRE', 'k', '1', 'NX', 'XX'],
      ['EXPIRE', 'k', '1', 'NX', 'GT'], ['EXPIRE', 'k', '1', 'XX', 'GT'], ['EXPIRE', 'k', '1', 'BOGUS'], ['EXPIRE', 'k', 'x', 'GT', 'LT'],
      ['EXPIRE', 'nope', '1', 'GT', 'LT'], ['PERSIST', 'k'], ['PERSIST', 'k'], ['PERSIST', 'nope'], ['TTL', 'k'], ['EXPIRE', 'k', '100', 'GT'],
      ['EXPIRE', 'k', '100', 'LT'], ['TTL', 'k'], ['EXPIRETIME', 'nope'], ['SET', 'p', 'v'], ['EXPIRETIME', 'p'], ['PEXPIRETIME', 'p'],
      ['EXPIREAT', 'p', '4102444800'], ['EXPIRETIME', 'p'], ['PEXPIREAT', 'p', '4102444800123'], ['PEXPIRETIME', 'p'],
      ['EXPIRE', 'k', '-1'], ['EXISTS', 'k'], ['SET', 'k', 'v'], ['EXPIRE', 'k', '0'], ['EXISTS', 'k'], ['SET', 'k', 'v'], ['PEXPIREAT', 'k', '1'],
      ['EXISTS', 'k'], ['EXPIRE', 'k'], ['TTL'],
    ]));

  test('hashes', () =>
    compare('hash', [
      ['HSET', 'h', 'a', '1', 'b', '2'], ['HSET', 'h', 'a', '9'], ['HSET', 'h', 'a'], ['HGET', 'h', 'a'], ['HGET', 'h', 'z'], ['HGET', 'none', 'a'],
      ['HMGET', 'h', 'a', 'z', 'b'], ['HMSET', 'h', 'c', '3'], ['HMSET', 'h', 'c'], ['HSETNX', 'h', 'c', 'x'], ['HSETNX', 'h', 'd', 'x'],
      ['HGETALL', 'h'], ['HGETALL', 'none'], ['HKEYS', 'h'], ['HVALS', 'h'], ['HLEN', 'h'], ['HLEN', 'none'], ['HEXISTS', 'h', 'a'],
      ['HEXISTS', 'h', 'z'], ['HINCRBY', 'h', 'a', '5'], ['HINCRBY', 'h', 'new', '-5'], ['HINCRBY', 'h', 'd', '1'], ['HINCRBY', 'h', 'a', 'x'],
      ['HINCRBY', 'h', 'a', '9223372036854775807'], ['HDEL', 'h', 'a', 'z'], ['HDEL', 'h', 'b', 'c', 'd', 'new'], ['EXISTS', 'h'],
      ['SET', 's', 'x'], ['HSET', 's', 'f', 'v'], ['HGET', 's', 'f'], ['HGETALL', 's'], ['HDEL', 's', 'f'],
    ]));

  test('lists', () =>
    compare('list', [
      ['RPUSH', 'l', 'a', 'b', 'c'], ['LPUSH', 'l', 'z', 'y'], ['LRANGE', 'l', '0', '-1'], ['LRANGE', 'l', '-2', '-1'], ['LRANGE', 'l', '5', '1'],
      ['LRANGE', 'l', '-100', '100'], ['LRANGE', 'none', '0', '-1'], ['LRANGE', 'l', 'x', '1'], ['LINDEX', 'l', '0'], ['LINDEX', 'l', '-1'],
      ['LINDEX', 'l', '99'], ['LINDEX', 'l', 'x'], ['LLEN', 'l'], ['LLEN', 'none'], ['LPOP', 'l'], ['RPOP', 'l'], ['LPOP', 'l', '2'],
      ['LPOP', 'l', '0'], ['LPOP', 'l', '-1'], ['LPOP', 'l', 'x'], ['RPOP', 'l', '10'], ['EXISTS', 'l'], ['LPOP', 'l'], ['LPOP', 'l', '2'],
      ['RPOP', 'none', '0'], ['RPUSH', 'c', '1', '2', '3', '4', '5'], ['LTRIM', 'c', '1', '-2'], ['LRANGE', 'c', '0', '-1'], ['LTRIM', 'c', '5', '1'],
      ['EXISTS', 'c'], ['LTRIM', 'none', '0', '1'], ['SET', 's', 'x'], ['LPUSH', 's', 'a'], ['LRANGE', 's', '0', '1'], ['LPOP', 's'],
      ['LPOP', 'a', '1', '2'],
    ]));

  test('errors: unknown commands and arity', () =>
    compare('errors', [
      ['NOPE'], ['NOPE', 'a', 'b'], ['nope', 'x'], ['GET'], ['GET', 'a', 'b'], ['MGET'], ['DEL'], ['HSET', 'h'], ['HGETALL'], ['LPUSH', 'l'],
      ['EXISTS'], ['TYPE'], ['ECHO'], ['TTL', 'a', 'b'], ['EXPIRE', 'k'],
    ]));

  test('transactions', () =>
    compare('multi', [
      ['MULTI'], ['SET', 'a', '1'], ['INCR', 'a'], ['GET', 'a'], ['EXEC'], ['EXEC'], ['DISCARD'], ['MULTI'], ['MULTI'], ['SET', 'a', '2'],
      ['DISCARD'], ['GET', 'a'], ['MULTI'], ['SET', 'a', '3'], ['INCR', 'a', 'extra'], ['EXEC'], ['GET', 'a'], ['MULTI'], ['NOPE'], ['EXEC'],
      ['MULTI'], ['SET', 'h', 'x'], ['HSET', 'h', 'f', 'v'], ['GET', 'h'], ['EXEC'], ['MULTI'], ['WATCH', 'a'], ['EXEC'], ['WATCH', 'a'],
      ['SET', 'a', 'changed'], ['MULTI'], ['SET', 'a', 'tx'], ['EXEC'], ['GET', 'a'], ['WATCH', 'a'], ['UNWATCH'], ['SET', 'a', 'again'],
      ['MULTI'], ['GET', 'a'], ['EXEC'], ['WATCH', 'nope'], ['SET', 'nope', '1'], ['MULTI'], ['PING'], ['EXEC'], ['WATCH', 'a'], ['SETNX', 'a', 'x'],
      ['MULTI'], ['PING'], ['EXEC'], ['WATCH', 'gone'], ['DEL', 'gone'], ['EXPIRE', 'gone', '5'], ['MULTI'], ['PING'], ['EXEC'],
    ]));

  test('RESP3 replies', () =>
    compare('resp3', [
      ['SET', 'k', 'v'], ['HSET', 'h', 'a', '1', 'b', '2'], ['RPUSH', 'l', 'x'], ['GET', 'nope'], ['HGETALL', 'h'], ['HGETALL', 'nope'],
      ['LPOP', 'nope'], ['LPOP', 'nope', '2'], ['MGET', 'k', 'nope'], ['HMGET', 'h', 'a', 'z'], ['TTL', 'k'], ['TYPE', 'k'], ['EXEC'],
      ['MULTI'], ['GET', 'k'], ['GET', 'nope'], ['EXEC'], ['WATCH', 'k'], ['SET', 'k', 'w'], ['MULTI'], ['GET', 'k'], ['EXEC'], ['SCAN', '0', 'COUNT', '100', 'MATCH', 'k'],
    ], [['HELLO', '3']]));

  test('multiple databases: SELECT, MOVE, SWAPDB, FLUSHDB', () =>
    compare('databases', [
      ['SET', 'k', 'zero'], ['SELECT', '1'], ['GET', 'k'], ['SET', 'k', 'one'], ['DBSIZE'], ['SELECT', '0'], ['GET', 'k'], ['SELECT', '15'],
      ['SELECT', '16'], ['SELECT', '-1'], ['SELECT', 'x'], ['SELECT', '0'], ['MOVE', 'k', '1'], ['MOVE', 'k', '2'], ['GET', 'k'], ['SELECT', '2'],
      ['GET', 'k'], ['MOVE', 'k', '2'], ['MOVE', 'k', '16'], ['MOVE', 'k', 'x'], ['MOVE', 'nope', '3'], ['SET', 't', 'v', 'EX', '100'],
      ['MOVE', 't', '3'], ['SELECT', '3'], ['TTL', 't'], ['SWAPDB', '2', '3'], ['GET', 'k'], ['TTL', 't'], ['SWAPDB', '0', '0'],
      ['SWAPDB', '0', '16'], ['SWAPDB', 'x', '1'], ['SWAPDB', '1', 'y'], ['INFO', 'keyspace'], ['FLUSHDB'], ['DBSIZE'], ['SELECT', '1'],
      ['DBSIZE'], ['FLUSHALL'], ['DBSIZE'], ['SELECT', '0'], ['DBSIZE'], ['INFO', 'keyspace'], ['CONFIG', 'GET', 'databases'],
    ]));

  test('WATCH is per database', async () => {
    for (const [watchDb, writeDb] of [['0', '1'], ['1', '1']]) {
      const results: string[][] = [];
      for (const port of [redisPort, mimic.respPort]) {
        const a = new Conn(port);
        const b = new Conn(port);
        const out: string[] = [];
        await a.send(cmd('FLUSHALL'));
        out.push(await a.send(cmd('SELECT', watchDb)), await a.send(cmd('WATCH', 'w')));
        out.push(await b.send(cmd('SELECT', writeDb)), await b.send(cmd('SET', 'w', 'x')));
        out.push(await a.send(cmd('MULTI')), await a.send(cmd('PING')), await a.send(cmd('EXEC')));
        results.push(out);
        a.close();
        b.close();
      }
      assert.deepEqual(results[1], results[0], `watch db ${watchDb}, write db ${writeDb}`);
    }
  });

  for (const proto of [2, 3]) test(`random command stream, RESP${proto} (seeded fuzz)`, async () => {
    // Small PRNG so failures are reproducible: set FUZZ_SEED to replay a run.
    let seed = Number(process.env['FUZZ_SEED'] ?? 20261001);
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
    const key = (): string => pick(['a', 'b', 'c', 'h', 'l', 'n', 'x:1', 'x:2']);
    const val = (): string => pick(['', '0', '1', '-1', '007', '42', '9223372036854775807', '-9223372036854775808', 'abc', 'a b', '1.5', ' 1']);
    const num = (): string => pick(['0', '1', '2', '-1', '-2', '10', '100', 'x', '99999999999999999999', '9223372036854775807', '+1', '01']);
    const ttl = (): string => pick(['100', '1000', '0', '-1', 'x', '9223372036854775807']);
    const gen: (() => string[])[] = [
      () => ['SET', key(), val(), ...pick([[], ['NX'], ['XX'], ['GET'], ['EX', ttl()], ['PX', ttl()], ['KEEPTTL'], ['EX', '100', 'NX'], ['XX', 'GET'], ['EX', '5', 'PX', '5']])],
      () => ['GET', key()], () => ['GETDEL', key()], () => ['GETEX', key(), ...pick([[], ['PERSIST'], ['EX', ttl()], ['PX', ttl()]])],
      () => ['GETSET', key(), val()], () => ['SETNX', key(), val()], () => ['SETEX', key(), ttl(), val()], () => ['MGET', key(), key(), key()],
      () => ['MSET', key(), val(), key(), val()], () => ['MSETNX', key(), val(), key(), val()], () => ['INCR', key()], () => ['DECR', key()],
      () => ['INCRBY', key(), num()], () => ['DECRBY', key(), num()], () => ['APPEND', key(), val()], () => ['STRLEN', key()],
      () => ['GETRANGE', key(), num(), num()], () => ['DEL', key(), key()], () => ['EXISTS', key(), key()], () => ['TYPE', key()],
      () => ['RENAME', key(), key()], () => ['RENAMENX', key(), key()], () => ['TTL', key()], () => ['PERSIST', key()],
      () => ['EXPIRE', key(), ttl(), ...pick([[], ['NX'], ['XX'], ['NX', 'XX'], ['GT', 'LT']])], () => ['PEXPIRE', key(), ttl()],
      // GT/LT compare absolute deadlines; equal values set within the same millisecond would race, so draw from a wide range.
      () => ['EXPIRE', key(), String(200 + rnd(100000)), pick(['GT', 'LT'])],
      () => ['EXPIRETIME', key()], () => ['HSET', key(), pick(['f', 'g']), val()], () => ['HGET', key(), pick(['f', 'g'])],
      () => ['HDEL', key(), 'f'], () => ['HGETALL', key()], () => ['HINCRBY', key(), pick(['f', 'g']), num()], () => ['HLEN', key()],
      () => ['HSETNX', key(), 'f', val()], () => ['HMGET', key(), 'f', 'g'], () => ['LPUSH', key(), val()], () => ['RPUSH', key(), val(), val()],
      () => ['LPOP', key(), ...pick([[], [num()]])], () => ['RPOP', key(), ...pick([[], [num()]])], () => ['LRANGE', key(), num(), num()],
      () => ['LINDEX', key(), num()], () => ['LTRIM', key(), num(), num()], () => ['LLEN', key()], () => ['DBSIZE'],
      () => ['SELECT', pick(['0', '0', '0', '1', '16', 'x'])], () => ['MOVE', key(), pick(['0', '1', '2'])], () => ['SWAPDB', pick(['0', '1']), pick(['1', '2'])],
      () => ['MULTI'], () => ['EXEC'], () => ['DISCARD'], () => ['WATCH', key()], () => ['UNWATCH'],
    ];
    const r = new Conn(redisPort);
    const m = new Conn(mimic.respPort);
    try {
      await r.send(cmd('FLUSHALL'));
      await m.send(cmd('FLUSHALL'));
      if (proto === 3) {
        await r.send(cmd('HELLO', '3')); // server info differs (version, id): not compared
        await m.send(cmd('HELLO', '3'));
      }
      for (let i = 0; i < 4000; i++) {
        const c = pick(gen)();
        const [a, b] = [await r.send(cmd(...c)), await m.send(cmd(...c))];
        assert.equal(b, a, `RESP${proto} fuzz step ${i}: ${JSON.stringify(c)}\n  redis: ${JSON.stringify(a)}\n  mimic: ${JSON.stringify(b)}`);
      }
    } finally {
      r.close();
      m.close();
    }
  });

  test('glob matching (seeded fuzz of KEYS patterns)', async () => {
    let seed = Number(process.env['FUZZ_SEED'] ?? 4711);
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['a', 'b', 'c', '-', ']', '^'];
    const keys = new Set<string>(['', 'a', 'b', 'ab', 'ba', 'a-b', '^a', ']', 'a]b', 'a^b', 'abc', 'cab', '[', 'a[b', 'a\\b']);
    while (keys.size < 40) keys.add(Array.from({ length: 1 + rnd(5) }, () => alphabet[rnd(alphabet.length)]).join(''));
    const tokens = ['a', 'b', 'c', '-', '^', ']', '[', '*', '?', '\\', '[a-c]', '[^a]', '[]', '[c-a]', '\\*', '\\['];
    const r = new Conn(redisPort);
    const m = new Conn(mimic.respPort);
    try {
      for (const c of [cmd('FLUSHALL'), ...[...keys].map((k) => cmd('SET', k, '1'))]) {
        await r.send(c);
        await m.send(c);
      }
      const parse = (reply: string): string[] => reply.split('\r\n').filter((_, i) => i > 0 && i % 2 === 0).sort();
      for (let i = 0; i < 1500; i++) {
        const pattern = Array.from({ length: 1 + rnd(6) }, () => tokens[rnd(tokens.length)]).join('');
        assert.deepEqual(parse(await m.send(cmd('KEYS', pattern))), parse(await r.send(cmd('KEYS', pattern))), `KEYS ${JSON.stringify(pattern)}`);
      }
    } finally {
      r.close();
      m.close();
    }
  });

  test('transactions and WATCH edge cases', () =>
    compare('multi edge', [
      ['MULTI'], ['EXEC', 'x'], ['EXEC'], ['WATCH', 'nokey'], ['FLUSHDB'], ['MULTI'], ['PING'], ['EXEC'], ['SET', 'ex', '1'], ['WATCH', 'ex'],
      ['FLUSHDB'], ['MULTI'], ['PING'], ['EXEC'], ['WATCH', 'nokey'], ['FLUSHALL'], ['MULTI'], ['PING'], ['EXEC'], ['SELECT', '1'], ['SET', 'sw', '1'],
      ['SELECT', '0'], ['WATCH', 'sw'], ['SWAPDB', '0', '1'], ['MULTI'], ['PING'], ['EXEC'], ['WATCH', 'none'], ['SWAPDB', '0', '1'], ['MULTI'],
      ['PING'], ['EXEC'], ['MULTI'], ['DISCARD', 'x'], ['EXEC'], ['CLIENT', 'SETNAME', 'a\x01b'], ['CLIENT', 'SETNAME', 'a b'], ['CLIENT', 'SETNAME', 'ok~name'],
      ['HELLO', '2', 'AUTH', 'bob', 'x'], ['AUTH', 'bob', 'x'], ['AUTH', 'default', 'x'], ['HELLO', '2', 'SETNAME', 'bad name'],
      ['SCAN', '000000000000000000000000000000000000000000', 'COUNT', '1000'], ['SCAN', '99999999999999999999999'], ['SCAN', ' 1'],
    ]));

  test('inline commands', () =>
    compare('inline', [
      'SET greeting "hello world"\r\n', 'GET greeting\r\n', "SET q 'it\\'s'\r\n", 'GET q\r\n', 'SET e "a\\x41\\n\\t"\r\n', 'GET e\r\n',
      '   \r\nPING\r\n', 'PING\n', 'ECHO ""\r\n', 'SET a "foo\r\n',
    ]));

  for (const [name, bad] of [
    ['unbalanced quote', 'SET a "foo"bar\r\n'],
    ['single quote', "GET 'x\r\n"],
    ['bad multibulk', '*abc\r\n'],
    ['wrong type marker', '*1\r\n+PING\r\n'],
    ['negative bulk', '*1\r\n$-5\r\n'],
    ['valid then bad', Buffer.concat([cmd('SET', 'x', '1'), Buffer.from('*1\r\n+oops\r\n')])],
  ] as [string, string | Buffer][]) {
    test(`protocol error: ${name}`, () => compare(`protocol ${name}`, [bad, ['GET', 'x']]));
  }

  test('an HTTP request on the RESP port is dropped silently', () =>
    compare('http', ['POST / HTTP/1.1\r\nHost: localhost\r\n\r\nSET pwned 1\r\n']).then(async () => {
      const c = new Conn(mimic.respPort);
      assert.equal(await c.send(cmd('EXISTS', 'pwned')), ':0\r\n');
      c.close();
    }));

  test('authentication and pre-auth limits', async () => {
    const pw = 'sekret';
    const r0 = new Conn(redisPort);
    await r0.send(cmd('CONFIG', 'SET', 'requirepass', pw));
    r0.close();
    const secure = await startTestDaemon({ httpPort: null, password: pw });
    try {
      for (const script of [
        [cmd('GET', 'x'), cmd('FOOBAR', 'a'), cmd('GET'), cmd('MULTI'), cmd('AUTH', 'wrong'), cmd('AUTH', 'default', 'wrong'), cmd('AUTH', 'a', 'b', 'c'), cmd('AUTH', pw), cmd('PING')],
        ['*3000000000\r\n'],
        ['*1\r\n$600000000\r\n'],
        [cmd('HELLO', '2', 'AUTH', 'default', 'wrong'), cmd('PING')],
        [cmd('MULTI'), cmd('AUTH', pw), cmd('MULTI'), cmd('PING'), cmd('EXEC')],
        ['*11\r\n'],
        ['*1\r\n$16385\r\n'],
        [cmd('AUTH', pw), Buffer.concat([cmd('SET', 'big', 'x'.repeat(20000)), cmd('STRLEN', 'big')]), cmd('STRLEN', 'big')],
      ]) {
        const r = new Conn(redisPort);
        const m = new Conn(secure.respPort);
        for (const p of script) {
          const [a, b] = [await r.send(p), await m.send(p)];
          assert.equal(b, a, `auth: ${JSON.stringify(p.toString().slice(0, 60))}\n  redis: ${JSON.stringify(a)}\n  mimic: ${JSON.stringify(b)}`);
          if (a.endsWith('<closed>')) break;
        }
        r.close();
        m.close();
      }
    } finally {
      await secure.close();
      const r1 = new Conn(redisPort);
      await r1.send(cmd('AUTH', pw));
      await r1.send(cmd('CONFIG', 'SET', 'requirepass', ''));
      r1.close();
    }
  });
});
