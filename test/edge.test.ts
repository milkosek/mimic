// Regression tests for the fourth review round ("hard edge cases").

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type { Daemon } from '../src/daemon.js';
import { Deque } from '../src/deque.js';
import { MemoryGuard } from '../src/memory.js';
import { RespParser } from '../src/resp/parser.js';
import { createRespServer } from '../src/resp/server.js';
import { Store } from '../src/store.js';
import { cmd, rawExchange, sleep, startTestDaemon } from './helpers.js';

function post(port: number, path: string, body: string, method = 'POST'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

let d: Daemon;
before(async () => {
  d = await startTestDaemon();
});
after(() => d.close());

const resp = (payload: string | Buffer, until: (s: string) => boolean = (s) => s.includes('\r\n')) =>
  rawExchange(d.respPort, payload, until);

describe('pipelining and backpressure', () => {
  test('a client that writes its whole pipeline before reading anything does not deadlock', async () => {
    await resp(cmd('SET', 'pv', 'v'.repeat(256)));
    const n = 150_000; // ~3 MB of commands, ~40 MB of replies: more than the socket buffers hold
    const one = cmd('GET', 'pv');
    const payload = Buffer.concat(Array.from({ length: n }, () => one));
    const reply = `$256\r\n${'v'.repeat(256)}\r\n`.length;
    const received = await new Promise<number>((resolve, reject) => {
      const s = net.connect(d.respPort, '127.0.0.1');
      let bytes = 0;
      const timer = setTimeout(() => (s.destroy(), reject(new Error(`stuck: ${bytes} bytes received`))), 30_000);
      s.pause(); // like a synchronous client: no reading until everything is written
      s.on('error', reject);
      s.on('connect', () =>
        s.write(payload, () => {
          s.on('data', (c) => {
            bytes += c.length;
            if (bytes >= n * reply) {
              clearTimeout(timer);
              s.destroy();
              resolve(bytes);
            }
          });
          s.resume();
        }),
      );
    });
    assert.equal(received, n * reply);
  });

  test('a client that never reads is disconnected once its query buffer passes the limit', async () => {
    const srv = createRespServer(Store.getInstance(), { maxQueryBufferBytes: 1024 * 1024 });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      await rawExchange(port, cmd('SET', 'big', 'b'.repeat(64 * 1024)), (s) => s.includes('\r\n'));
      const s = net.connect(port, '127.0.0.1');
      s.on('error', () => {});
      s.pause();
      await new Promise((r) => s.once('connect', r));
      const chunk = Buffer.concat(Array.from({ length: 1000 }, () => cmd('GET', 'big')));
      for (let i = 0; i < 200 && !s.destroyed; i++) s.write(chunk); // ~4 MB of GETs, 13 GB of would-be replies
      let closed = false;
      for (let i = 0; i < 100 && !closed; i++) {
        await sleep(50);
        closed = srv.stats.connectedClients === 0;
      }
      s.destroy();
      assert.ok(closed, 'the server must drop the client instead of buffering forever');
    } finally {
      srv.disconnectAll();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('memory guard', () => {
  test('MemoryGuard: a share of the V8 old-space limit, with headroom, re-measured as writes come in', () => {
    const MiB = 1024 * 1024;
    let used = 0;
    const guard = new MemoryGuard(80, { measure: () => used, heapSizeLimit: 1072 * MiB, oldSpaceFlagMb: 1024 });
    assert.equal(guard.heapLimitBytes, 1024 * MiB);
    assert.equal(guard.limitBytes, Math.floor(1024 * MiB * 0.8));
    used = 800 * MiB;
    guard.refresh();
    assert.equal(guard.overLimit(), false);
    used = 900 * MiB;
    assert.equal(guard.overLimit(100 * 1024), false, 'not re-measured yet');
    assert.equal(guard.overLimit(200 * 1024), true, 'a few hundred KB of writes trigger a re-measure');
    used = 100 * MiB;
    let reopened = false;
    for (let i = 0; i < 300 && !reopened; i++) reopened = !guard.overLimit(); // and so do a few hundred small ones
    assert.ok(reopened);

    // Without the flag: heap_size_limit minus the 48 MB young generation.
    assert.equal(new MemoryGuard(50, { measure: () => 0, heapSizeLimit: 4144 * MiB, oldSpaceFlagMb: null }).heapLimitBytes, 4096 * MiB);
    // Small heaps keep 32 MB free for V8 whatever the percentage, but at least half is usable.
    assert.equal(new MemoryGuard(100, { measure: () => 0, heapSizeLimit: 176 * MiB, oldSpaceFlagMb: 128 }).limitBytes, 96 * MiB);
    assert.equal(new MemoryGuard(90, { measure: () => 0, heapSizeLimit: 112 * MiB, oldSpaceFlagMb: 64 }).limitBytes, 32 * MiB);
    assert.equal(new MemoryGuard(10, { measure: () => 0, heapSizeLimit: 112 * MiB, oldSpaceFlagMb: 64 }).limitBytes, Math.floor(6.4 * MiB));
    assert.equal(new MemoryGuard(0, { measure: () => 9e9, oldSpaceFlagMb: null }).overLimit(1e9), false, '0 disables it');
  });

  test('near the V8 heap limit writes get -OOM instead of crashing; reads and FLUSHALL recover it', async () => {
    const port = await freePort();
    const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, ['--max-old-space-size=64', cli, '--port', String(port), '--http-port', 'off', '--log-level', 'silent'], {
      stdio: 'ignore',
    });
    let exited: number | null = null;
    child.on('exit', (code) => (exited = code ?? -1));
    try {
      for (let i = 0; i < 100; i++) {
        const ok = await new Promise<boolean>((r) => {
          const s = net.connect(port, '127.0.0.1', () => (s.destroy(), r(true)));
          s.on('error', () => r(false));
        });
        if (ok) break;
        await sleep(50);
      }
      const c = new LineClient(port);
      await c.ready;
      let oom = '';
      for (let i = 0; i < 4000 && !oom; i++) {
        // A unique 64 KB value per key, so they can't share memory.
        const r = await c.send(cmd('SET', `k${i}`, String(i).padEnd(64 * 1024, 'x')));
        if (r.startsWith('-OOM')) oom = r;
        else assert.equal(r, '+OK\r\n', `SET k${i}`);
      }
      assert.equal(oom, "-OOM command not allowed when used memory > 'maxmemory'.\r\n");
      assert.equal(exited, null, 'the process is still alive');
      assert.match(await c.send(cmd('GET', 'k0')), /^\$65536\r\n0x/, 'reads still work');
      assert.equal(await c.send(cmd('DEL', 'k1')), ':1\r\n', 'deletes are always allowed');
      // Redis 7.0: inside MULTI even a read is refused (the queue grows), and EXEC is aborted.
      assert.equal(await c.send(cmd('MULTI')), '+OK\r\n');
      assert.match(await c.send(cmd('SET', 'tx', 'v')), /^-OOM/);
      assert.match(await c.send(cmd('GET', 'k0')), /^-OOM/);
      assert.equal(await c.send(cmd('EXEC')), '-EXECABORT Transaction discarded because of previous errors.\r\n');
      assert.equal(await c.send(cmd('FLUSHALL')), '+OK\r\n');
      let reopened = false;
      for (let i = 0; i < 60 && !reopened; i++) {
        reopened = (await c.send(cmd('SET', 'after', 'v'))) === '+OK\r\n';
        if (!reopened) await sleep(100);
      }
      assert.ok(reopened, 'writes are accepted again after FLUSHALL');
      c.close();
    } finally {
      child.kill();
    }
  });
});

/** Sends one command at a time and returns its (single-line or bulk) reply. */
class LineClient {
  #s: net.Socket;
  #buf = '';
  #waiter: ((s: string) => void) | null = null;
  ready: Promise<void>;
  constructor(port: number) {
    this.#s = net.connect(port, '127.0.0.1');
    this.ready = new Promise((r) => this.#s.once('connect', () => r()));
    this.#s.on('data', (c) => {
      this.#buf += c.toString('latin1');
      this.#check();
    });
  }
  #check(): void {
    if (!this.#waiter) return;
    const eol = this.#buf.indexOf('\r\n');
    if (eol < 0) return;
    let end = eol + 2;
    if (this.#buf[0] === '$' && this.#buf[1] !== '-') {
      end += Number(this.#buf.slice(1, eol)) + 2;
      if (this.#buf.length < end) return;
    } else if (this.#buf[0] === '*') {
      for (let n = Number(this.#buf.slice(1, eol)); n > 0; n--) {
        const next = this.#buf.indexOf('\r\n', end); // arrays of one-line replies only
        if (next < 0) return;
        end = next + 2;
      }
    }
    const reply = this.#buf.slice(0, end);
    this.#buf = this.#buf.slice(end);
    const w = this.#waiter;
    this.#waiter = null;
    w(reply);
  }
  send(payload: Buffer): Promise<string> {
    return new Promise((r) => {
      this.#waiter = r;
      this.#s.write(payload);
      this.#check();
    });
  }
  close(): void {
    this.#s.destroy();
  }
}

describe('HTTP and big integers', () => {
  test('integers JSON cannot carry exactly are refused with a 400, not silently rounded', async () => {
    const p = d.httpPort!;
    const bad = await post(p, '/command', '["SET","hbig",9007199254740993]');
    assert.equal(bad.status, 400);
    assert.match(bad.text, /send it as a string/);
    assert.equal((await post(p, '/command', '["GET","hbig"]')).text, '{"result":null}');
    assert.equal((await post(p, '/command', '["SET","hbig",9007199254740991]')).status, 200);
    assert.equal((await post(p, '/command', '["SET","hbig","9223372036854775807"]')).status, 200);
    assert.equal((await post(p, '/command', '["INCRBY","hbig","-1"]')).text, '{"result":9223372036854775806}');
    assert.equal((await post(p, '/keys/nested', '{"value":{"a":[1,{"b":12345678901234567890}]}}', 'PUT')).status, 400);
    assert.equal((await post(p, '/keys/nested', '{"value":{"a":[1.5,2,-3]}}', 'PUT')).status, 200);
  });
});

describe('large values', () => {
  test('LTRIM costs O(removed elements), and keeps the right ones', () => {
    const dq = new Deque<number>();
    for (let i = 0; i < 200_000; i++) dq.push(i);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) dq.keep(100, dq.length); // "LRANGE 0 99 + LTRIM 100 -1", batch by batch
    const ms = performance.now() - t0;
    assert.equal(dq.length, 100_000);
    assert.equal(dq.at(0), 100_000);
    assert.equal(dq.at(-1), 199_999);
    assert.ok(ms < 500, `1000 trims took ${ms.toFixed(0)} ms`);
    dq.keep(10, 20);
    assert.deepEqual(dq.toArray(), Array.from({ length: 10 }, (_, i) => 100_010 + i));
    for (let i = 0; i < 100; i++) dq.unshift(-i); // still a working ring buffer after shrinking
    assert.equal(dq.length, 110);
    assert.equal(dq.at(0), -99);
    assert.equal(dq.at(-1), 100_019);
  });

  test('APPEND + GETRANGE on a growing value is not quadratic and stays byte-exact', async () => {
    const store = Store.getInstance();
    const db = store.db(7);
    db.flushdb();
    const piece = 'abÿ\u0000'; // binary string: 4 bytes
    const t0 = performance.now();
    for (let i = 0; i < 50_000; i++) {
      db.append('log', piece);
      if (i % 100 === 0) assert.equal(db.getrange('log', -4, -1), piece);
    }
    const ms = performance.now() - t0;
    assert.equal(db.strlen('log'), 200_000);
    assert.equal(db.getrange('log', 4, 7), piece);
    assert.equal(db.get('log'), piece.repeat(50_000));
    assert.ok(ms < 3000, `50k appends took ${ms.toFixed(0)} ms`);
    db.set('log', 'reset');
    db.append('log', '!');
    assert.equal(db.get('log'), 'reset!');
    assert.equal(db.incrby('n', 1n), 1n);
    db.append('n', '5');
    assert.equal(db.incrby('n', 1n), 16n, 'an appended number is still a number');
    db.flushdb();
  });
});

describe('protocol and wording details', () => {
  test('RESP lengths follow string2ll: no leading zeros, no "-0"', () => {
    for (const bad of ['*01\r\n', '*1\r\n$04\r\nPING\r\n', '*-0\r\n']) {
      const p = new RespParser();
      p.push(Buffer.from(bad));
      assert.throws(() => p.next(), { message: /Protocol error/ }, JSON.stringify(bad));
    }
  });

  test('inline commands split on \\v and \\f only like sdssplitargs does', () => {
    const parse = (s: string): string[] | null => {
      const p = new RespParser();
      p.push(Buffer.from(s));
      return p.next() as string[] | null;
    };
    assert.deepEqual(parse('ECHO a\vb\r\n'), ['ECHO', 'a\vb']);
    assert.deepEqual(parse('\fECHO\vx\r\n'), ['ECHO\vx']);
    assert.deepEqual(parse('ECHO "a"\vb\r\n'), ['ECHO', 'a', 'b']);
  });

  test('RESP3 INFO and CLIENT INFO are verbatim strings with Redis 7 fields', async () => {
    const info = await resp(Buffer.concat([cmd('HELLO', '3'), cmd('INFO', 'server')]), (s) => s.includes('=') && s.endsWith('\r\n') && /redis_version/.test(s));
    assert.match(info, /=\d+\r\ntxt:# Server\r\n/);
    const ci = await resp(Buffer.concat([cmd('HELLO', '3'), cmd('CLIENT', 'INFO')]), (s) => /lib-ver=[^\n]*\n\r\n$/.test(s));
    for (const field of ['flags=N', 'sub=0', 'psub=0', 'multi=-1', 'user=default', 'redir=-1', 'resp=3', 'cmd=client|info']) {
      assert.ok(ci.includes(field), `${field} in ${ci}`);
    }
    assert.match(ci, /=\d+\r\ntxt:id=/);
  });

  test('SELECT/MOVE/SWAPDB reject values outside 32 bits like Redis', async () => {
    assert.equal(await resp(cmd('SELECT', '4294967296')), '-ERR value is out of range, value must between -2147483648 and 2147483647\r\n');
    assert.equal(await resp(cmd('SELECT', '2147483648')), '-ERR value is out of range, value must between -2147483648 and 2147483647\r\n');
    assert.equal(await resp(cmd('SWAPDB', '0', 'x')), '-ERR invalid second DB index\r\n');
  });

  test('CLIENT SETNAME with extra arguments is an arity error', async () => {
    assert.equal(await resp(cmd('CLIENT', 'SETNAME', 'a', 'b')), "-ERR wrong number of arguments for 'client|setname' command\r\n");
  });

  test('CONFIG GET echoes an exact name as given, a pattern returns canonical names', async () => {
    assert.equal(await resp(cmd('CONFIG', 'GET', 'DataBases'), (s) => s.split('\r\n').length > 5), '*2\r\n$9\r\nDataBases\r\n$2\r\n16\r\n');
    assert.equal(await resp(cmd('CONFIG', 'GET', 'DATA*'), (s) => s.split('\r\n').length > 5), '*2\r\n$9\r\ndatabases\r\n$2\r\n16\r\n');
  });

  test('an IPv6-looking Host is only accepted when it really is an IPv6 address', async () => {
    const get = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: d.httpPort!, path: '/keys', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await get('[::1]:6380'), 200);
    assert.equal(await get('evil.example:6380'), 403);
    assert.equal(await get('evil:example:6380'), 403);
  });
});
