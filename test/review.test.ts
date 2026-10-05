// Regression tests for the issues found in the pre-0.2.0 review.
// Each test is named after the finding it covers.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import type { Daemon } from '../src/daemon.js';
import { cmd, rawExchange, sleep, startTestDaemon } from './helpers.js';

/** Raw HTTP request (no URL normalisation, full control over headers). */
function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = { 'content-type': 'application/json' };
const firstLine = (s: string): boolean => s.includes('\r\n');

let d: Daemon;
before(async () => {
  d = await startTestDaemon();
});
after(() => d.close());

const resp = (payload: string | Buffer, until: (s: string) => boolean = firstLine) => rawExchange(d.respPort!, payload, until);
const httpCmd = (argv: unknown[]) => rawHttp(d.httpPort!, 'POST', '/command', json, JSON.stringify(argv));

describe('release blockers', () => {
  test('1. a client reset while being rejected (maxclients) does not crash the server', async () => {
    const small = await startTestDaemon({ httpPort: null, maxClients: 1 });
    try {
      const holder = net.connect(small.respPort!, '127.0.0.1');
      await new Promise((r) => holder.once('connect', r));
      await sleep(20);
      for (let i = 0; i < 50; i++) {
        const s = net.connect(small.respPort!, '127.0.0.1');
        s.on('error', () => {});
        s.once('connect', () => s.resetAndDestroy());
      }
      await sleep(200);
      holder.write(cmd('PING'));
      const pong = await new Promise<string>((r) => holder.once('data', (b) => r(b.toString())));
      assert.equal(pong, '+PONG\r\n');
      holder.destroy();
    } finally {
      await small.close();
    }
  });

  test('2a. a browser "simple request" (text/plain, foreign Origin) cannot write over HTTP', async () => {
    const res = await rawHttp(d.httpPort!, 'POST', '/command', { 'content-type': 'text/plain', origin: 'https://evil.example' }, '["SET","csrf","1"]');
    assert.ok(res.status === 403 || res.status === 415, `status ${res.status}`);
    const plain = await rawHttp(d.httpPort!, 'POST', '/command', { 'content-type': 'text/plain' }, '["SET","csrf","1"]');
    assert.equal(plain.status, 415);
    const origin = await rawHttp(d.httpPort!, 'POST', '/command', { ...json, origin: 'https://evil.example' }, '["SET","csrf","1"]');
    assert.equal(origin.status, 403);
    assert.equal(JSON.parse((await httpCmd(['EXISTS', 'csrf'])).text).result, 0);
  });

  test('2a. DNS rebinding: a foreign Host header is refused when no password is set', async () => {
    const res = await rawHttp(d.httpPort!, 'GET', '/keys', { host: 'attacker.example:6380' });
    assert.equal(res.status, 403);
    assert.equal((await rawHttp(d.httpPort!, 'GET', '/keys', { host: 'localhost:6380' })).status, 200);
    assert.equal((await rawHttp(d.httpPort!, 'GET', '/keys', { host: '127.0.0.1' })).status, 200);
  });

  test('2b. an HTTP request sent to the RESP port is dropped before any command runs', async () => {
    const body = 'SET pwned yes\r\n';
    const req = `POST / HTTP/1.1\r\nHost: 127.0.0.1:6379\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const reply = await resp(req, () => false);
    assert.doesNotMatch(reply, /\+OK/);
    assert.equal(await resp(cmd('EXISTS', 'pwned')), ':0\r\n');
    // Same for a GET request line followed by a Host header.
    await resp('GET / HTTP/1.1\r\nHost: x\r\nSET pwned yes\r\n', () => false);
    assert.equal(await resp(cmd('EXISTS', 'pwned')), ':0\r\n');
  });

  test('3. WATCH notices writes made over HTTP', async () => {
    const a = net.connect(d.respPort!, '127.0.0.1');
    let data = '';
    a.on('data', (c) => (data += c.toString('latin1')));
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(data); i++) await sleep(5);
    };
    a.write(cmd('WATCH', 'acct'));
    await waitFor(/^\+OK\r\n$/);
    await httpCmd(['SET', 'acct', 'from-http']);
    a.write(Buffer.concat([cmd('MULTI'), cmd('SET', 'acct', 'from-resp'), cmd('EXEC')]));
    await waitFor(/QUEUED\r\n.+\r\n$/s);
    assert.equal(data, '+OK\r\n+OK\r\n+QUEUED\r\n*-1\r\n');
    assert.equal(JSON.parse((await httpCmd(['GET', 'acct'])).text).result, 'from-http');
    a.destroy();
  });

  test('4. unauthenticated clients get Redis-like small limits', async () => {
    const secure = await startTestDaemon({ httpPort: null, password: 'pw' });
    try {
      const r1 = await rawExchange(secure.respPort!, '*11\r\n', firstLine);
      assert.equal(r1, '-ERR Protocol error: unauthenticated multibulk length\r\n');
      const r2 = await rawExchange(secure.respPort!, '*1\r\n$16385\r\n', firstLine);
      assert.equal(r2, '-ERR Protocol error: unauthenticated bulk length\r\n');
      // Once authenticated, the normal limits apply - even within the same pipeline.
      const big = 'x'.repeat(100_000);
      const ok = await rawExchange(secure.respPort!, Buffer.concat([cmd('AUTH', 'pw'), cmd('SET', 'big', big), cmd('STRLEN', 'big')]), (s) =>
        s.endsWith(':100000\r\n'),
      );
      assert.equal(ok, '+OK\r\n+OK\r\n:100000\r\n');
    } finally {
      await secure.close();
    }
  });

  test('4. the per-client query buffer is capped', async () => {
    const capped = await startTestDaemon({ httpPort: null, maxQueryBufferBytes: 1024 * 1024 });
    try {
      // A frame that announces 1000 args of 10 KB each and keeps sending: > 1 MB buffered.
      const header = '*1000\r\n';
      const arg = `$10000\r\n${'a'.repeat(10000)}\r\n`;
      const reply = await rawExchange(capped.respPort!, header + arg.repeat(200), () => false);
      assert.match(reply, /^-ERR Protocol error: client query buffer exceeds limit/);
    } finally {
      await capped.close();
    }
  });

  test('5. an empty password file is a startup error, not "no auth"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimic-'));
    const file = join(dir, 'pw');
    writeFileSync(file, '  \n');
    assert.throws(() => loadConfig(['--password-file', file], {}), ConfigError);
    assert.throws(() => loadConfig([], { MIMIC_PASSWORD_FILE: file }), ConfigError);
    assert.throws(() => loadConfig(['--password='], {}), ConfigError);
  });
});

describe('smaller bugs', () => {
  test('valid commands before a malformed frame still run', async () => {
    const reply = await resp(Buffer.concat([cmd('SET', 'before-bad', '1'), Buffer.from('*1\r\n+oops\r\n')]), () => false);
    assert.equal(reply, "+OK\r\n-ERR Protocol error: expected '$', got '+'\r\n");
    assert.equal(await resp(cmd('GET', 'before-bad')), '$1\r\n1\r\n');
  });

  test('oversized HTTP bodies get a 413, not a reset', async () => {
    const tiny = await startTestDaemon({ httpBodyLimitBytes: 1024 });
    try {
      const res = await rawHttp(tiny.httpPort!, 'POST', '/command', json, JSON.stringify(['SET', 'k', 'x'.repeat(5000)]));
      assert.equal(res.status, 413);
    } finally {
      await tiny.close();
    }
  });

  test('flags win over environment variables, also for --password-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimic-'));
    const file = join(dir, 'pw');
    writeFileSync(file, 'from-file\n');
    assert.equal(loadConfig(['--password-file', file], { MIMIC_PASSWORD: 'from-env' }).config.password, 'from-file');
    assert.equal(loadConfig(['--password', 'from-flag'], { MIMIC_PASSWORD_FILE: file }).config.password, 'from-flag');
    assert.equal(loadConfig([], { MIMIC_PASSWORD_FILE: file }).config.password, 'from-file');
    assert.throws(() => loadConfig(['--password', 'a', '--password-file', file], {}), ConfigError);
  });

  test('integer replies are always JSON numbers over HTTP, even beyond 2^53', async () => {
    await httpCmd(['SET', 'bigint', '9007199254740992']);
    const res = await httpCmd(['INCR', 'bigint']);
    assert.equal(res.text, '{"result":9007199254740993}');
    assert.equal((await httpCmd(['INCR', 'small'])).text, '{"result":1}');
  });

  test('keys with "..", "/" or "\\" are reachable through /keys/:key', async () => {
    for (const key of ['a/../b', 'dir/file', 'back\\slash', './x']) {
      await httpCmd(['SET', key, 'v']);
      const res = await rawHttp(d.httpPort!, 'GET', `/keys/${key}`, {});
      assert.equal(res.status, 200, `${key}: ${res.text}`);
      assert.equal(JSON.parse(res.text).key, key);
    }
  });

  test('writes that change nothing do not invalidate WATCH', async () => {
    await resp(cmd('SET', 'w1', 'v'));
    const a = net.connect(d.respPort!, '127.0.0.1');
    let data = '';
    a.on('data', (c) => (data += c.toString('latin1')));
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(data); i++) await sleep(5);
    };
    a.write(cmd('WATCH', 'w1', 'w-missing'));
    await waitFor(/^\+OK\r\n$/);
    await resp(cmd('SETNX', 'w1', 'other')); // fails: key exists
    await resp(cmd('EXPIRE', 'w-missing', '10')); // no such key
    await resp(cmd('DEL', 'w-missing')); // nothing deleted
    a.write(Buffer.concat([cmd('MULTI'), cmd('SET', 'w1', 'mine'), cmd('EXEC')]));
    await waitFor(/QUEUED\r\n.+\r\n$/s);
    assert.equal(data, '+OK\r\n+OK\r\n+QUEUED\r\n*1\r\n+OK\r\n');
    a.destroy();
  });

  test('a watched key that expires before EXEC aborts the transaction (Redis >= 6.0.9)', async () => {
    await resp(cmd('SET', 'w-exp', 'v', 'PX', '40'));
    const a = net.connect(d.respPort!, '127.0.0.1');
    let data = '';
    a.on('data', (c) => (data += c.toString('latin1')));
    a.write(cmd('WATCH', 'w-exp'));
    await sleep(80);
    a.write(Buffer.concat([cmd('MULTI'), cmd('SET', 'w-exp', 'new'), cmd('EXEC')]));
    for (let i = 0; i < 200 && !/QUEUED\r\n.+\r\n$/s.test(data); i++) await sleep(5);
    assert.equal(data, '+OK\r\n+OK\r\n+QUEUED\r\n*-1\r\n');
    a.destroy();
  });
});

describe('Redis behaviour', () => {
  const one = (...argv: string[]) => resp(cmd(...argv));

  test('integers with leading zeros or "+" are rejected like Redis string2ll', async () => {
    await one('SET', 'z', '007');
    assert.equal(await one('INCR', 'z'), '-ERR value is not an integer or out of range\r\n');
    assert.equal(await one('INCRBY', 'n0', '+5'), '-ERR value is not an integer or out of range\r\n');
    assert.equal(await one('INCRBY', 'n0', '-0'), '-ERR value is not an integer or out of range\r\n');
    assert.equal(await one('INCRBY', 'n0', '0'), ':0\r\n');
  });

  test('EXPIRE GT LT reports the GT/LT message', async () => {
    await one('SET', 'e', 'v');
    assert.equal(await one('EXPIRE', 'e', '1', 'GT', 'LT'), '-ERR GT and LT options at the same time are not compatible\r\n');
    assert.equal(await one('EXPIRE', 'e', '1', 'NX', 'GT'), '-ERR NX and XX, GT or LT options at the same time are not compatible\r\n');
  });

  test('huge expire values are "invalid expire time", with the right command name', async () => {
    assert.equal(await one('SET', 'k', 'v', 'EX', '99999999999999999'), "-ERR invalid expire time in 'set' command\r\n");
    await one('SET', 'k', 'v');
    assert.equal(await one('EXPIRE', 'k', '9223372036854775807'), "-ERR invalid expire time in 'expire' command\r\n");
    assert.equal(await one('SETEX', 'k', '0', 'v'), "-ERR invalid expire time in 'setex' command\r\n");
    assert.equal(await one('PSETEX', 'k', '-1', 'v'), "-ERR invalid expire time in 'psetex' command\r\n");
    assert.equal(await one('GETEX', 'k', 'EX', '0'), "-ERR invalid expire time in 'getex' command\r\n");
  });

  test('conflicting expire options are a syntax error; repeating the same one is allowed (Redis 7.0)', async () => {
    assert.equal(await one('SET', 'k', 'v', 'EX', '1', 'EX', '200'), '+OK\r\n'); // verified against redis-server 7.0.15
    assert.equal(await one('TTL', 'k'), ':200\r\n');
    assert.equal(await one('SET', 'k', 'v', 'EX', '1', 'PX', '2'), '-ERR syntax error\r\n');
    assert.equal(await one('GETEX', 'k', 'EX', '1', 'PERSIST'), '-ERR syntax error\r\n');
  });

  test('inline commands with unbalanced quotes are a protocol error', async () => {
    assert.equal(await resp('SET a "foo\r\n', () => false), '-ERR Protocol error: unbalanced quotes in request\r\n');
    assert.equal(await resp('SET a "foo"bar\r\n', () => false), '-ERR Protocol error: unbalanced quotes in request\r\n');
  });
});

describe('second review round', () => {
  test('a pipeline whose replies exceed 512 MB streams out instead of crashing', async () => {
    const value = 'v'.repeat(1024 * 1024);
    assert.equal(await resp(cmd('SET', 'big1m', value)), '+OK\r\n');
    const n = 560; // 560 MB of replies: more than V8's maximum string length
    const total = await new Promise<number>((resolve, reject) => {
      const s = net.connect(d.respPort!, '127.0.0.1');
      let bytes = 0;
      const expected = n * (value.length + 12) + 7; // "$1048576\r\n" + value + "\r\n", then "+PONG\r\n"
      s.on('data', (c) => {
        bytes += c.length;
        if (bytes >= expected) {
          s.destroy();
          resolve(bytes);
        }
      });
      s.on('error', reject);
      s.on('close', () => resolve(bytes));
      s.write(Buffer.concat([...Array.from({ length: n }, () => cmd('GET', 'big1m')), cmd('PING')]));
    });
    assert.equal(total, n * (1024 * 1024 + 12) + 7);
    assert.equal(await resp(cmd('PING')), '+PONG\r\n', 'server still alive');
    await resp(cmd('DEL', 'big1m'));
  });

  test('pathological glob patterns return quickly (no regex backtracking)', async () => {
    await resp(cmd('SET', 'k'.repeat(37), 'v'));
    const t0 = performance.now();
    await resp(cmd('KEYS', '*?*?*?*?*?*?*?*?*?*?*?*?x'), (s) => s.includes('\r\n'));
    const t1 = performance.now();
    const res = await rawHttp(d.httpPort!, 'GET', '/keys?pattern=*?*?*?*?*?*?*?*?*?*?*?*?*?*?x', {});
    assert.equal(res.status, 200);
    assert.ok(t1 - t0 < 200 && performance.now() - t1 < 200, 'pattern matching must not hang');
  });

  test('a multi-megabyte integer argument is rejected without stalling', async () => {
    const t0 = performance.now();
    const reply = await resp(cmd('INCRBY', 'n', '9'.repeat(4 * 1024 * 1024)));
    assert.equal(reply, '-ERR value is not an integer or out of range\r\n');
    assert.ok(performance.now() - t0 < 500, `took ${(performance.now() - t0).toFixed(0)} ms`);
  });

  test('FLUSHDB only invalidates WATCH for keys that existed', async () => {
    const watchThenFlush = async (setup: Buffer[]): Promise<string> => {
      const a = net.connect(d.respPort!, '127.0.0.1');
      let data = '';
      a.on('data', (c) => (data += c.toString('latin1')));
      a.write(Buffer.concat([cmd('SELECT', '5'), ...setup, cmd('WATCH', 'wf')]));
      for (let i = 0; i < 200 && (data.match(/\r\n/g) ?? []).length < setup.length + 2; i++) await sleep(5);
      data = '';
      await resp(Buffer.concat([cmd('SELECT', '5'), cmd('FLUSHDB')]), (s) => (s.match(/\r\n/g) ?? []).length >= 2);
      a.write(Buffer.concat([cmd('MULTI'), cmd('PING'), cmd('EXEC')]));
      for (let i = 0; i < 200 && !/QUEUED\r\n.+\r\n$/s.test(data); i++) await sleep(5);
      a.destroy();
      return data.slice(data.indexOf('QUEUED') + 8);
    };
    assert.equal(await watchThenFlush([]), '*1\r\n+PONG\r\n');
    assert.equal(await watchThenFlush([cmd('SET', 'wf', '1')]), '*-1\r\n');
  });

  test('PUT with a body that is not a JSON object is a 400', async () => {
    for (const body of ['"x"', '5', 'null', '[1]', '{}']) {
      const res = await rawHttp(d.httpPort!, 'PUT', '/keys/p', json, body);
      assert.equal(res.status, 400, body);
    }
  });

  test('EXEC with arguments inside MULTI aborts the transaction', async () => {
    assert.equal(
      await resp(Buffer.concat([cmd('MULTI'), cmd('EXEC', 'x'), cmd('EXEC')]), (s) => s.endsWith('MULTI\r\n')),
      "+OK\r\n-EXECABORT Transaction discarded because of: wrong number of arguments for 'exec' command\r\n-ERR EXEC without MULTI\r\n",
    );
  });

  test('before AUTH, unknown-command and arity errors come first (Redis order)', async () => {
    const secure = await startTestDaemon({ httpPort: null, password: 'pw' });
    try {
      const reply = await rawExchange(secure.respPort!, Buffer.concat([cmd('FOOBAR'), cmd('GET'), cmd('GET', 'k')]), (s) => s.includes('NOAUTH'));
      assert.equal(
        reply,
        "-ERR unknown command 'FOOBAR', with args beginning with: \r\n-ERR wrong number of arguments for 'get' command\r\n-NOAUTH Authentication required.\r\n",
      );
    } finally {
      await secure.close();
    }
  });

  test('a closed connection is fully torn down even if the peer never closes its side', async () => {
    await sleep(50);
    const before = d.resp.stats.connectedClients;
    const peers: net.Socket[] = [];
    for (const payload of [cmd('QUIT'), Buffer.from('*1\r\n+bad\r\n')]) {
      const peer = net.connect({ port: d.respPort!, host: '127.0.0.1', allowHalfOpen: true }); // never closes its side
      peer.on('error', () => {});
      peer.on('connect', () => peer.write(payload));
      peers.push(peer);
    }
    let now = -1;
    for (let i = 0; i < 100; i++) {
      await sleep(10);
      now = d.resp.stats.connectedClients;
      if (now <= before) break;
    }
    assert.equal(now, before, 'the server must drop both connections itself');
    for (const p of peers) p.destroy();
  });

  test('client names and HELLO usernames are validated like Redis', async () => {
    assert.equal(await resp(cmd('CLIENT', 'SETNAME', 'a\x01b')), '-ERR Client names cannot contain spaces, newlines or special characters.\r\n');
    assert.equal(await resp(cmd('CLIENT', 'SETNAME', 'a~b')), '+OK\r\n');
    assert.match(await resp(cmd('HELLO', '2', 'AUTH', 'bob', 'x')), /^-WRONGPASS/);
    assert.match(await resp(cmd('AUTH', 'bob', 'x')), /^-WRONGPASS/);
    assert.equal(await resp(cmd('AUTH', 'default', 'x')), '+OK\r\n');
  });

  test('browser requests: cross-site GETs are refused, trailing-dot hosts accepted', async () => {
    assert.equal((await rawHttp(d.httpPort!, 'GET', '/keys', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await rawHttp(d.httpPort!, 'GET', '/keys', { 'sec-fetch-site': 'none' })).status, 200);
    assert.equal((await rawHttp(d.httpPort!, 'GET', '/keys', { host: 'localhost.:6380' })).status, 200);
  });
});

describe('third review round', () => {
  test('a slow reader still gets a large reply sent before QUIT; a stalled one is cut off', async () => {
    const { Store } = await import('../src/store.js');
    const { createRespServer } = await import('../src/resp/server.js');
    const srv = createRespServer(Store.getInstance(), { closeGraceMs: 1000 });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const value = 'q'.repeat(8 * 1024 * 1024);
      await rawExchange(port, cmd('SET', 'slow', value), (s) => s.includes('\r\n'));
      const expected = `$${value.length}\r\n`.length + value.length + 2 + '+OK\r\n'.length;

      // Slow reader: takes well over the 1 s grace period, but keeps reading.
      const got = await new Promise<number>((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        let bytes = 0;
        s.on('data', (c) => {
          bytes += c.length;
          s.pause();
          setTimeout(() => s.resume(), 15);
        });
        s.on('close', () => resolve(bytes));
        s.on('error', () => {});
        s.write(Buffer.concat([cmd('GET', 'slow'), cmd('QUIT')]));
      });
      assert.equal(got, expected, 'the whole reply plus +OK must arrive before the close');

      // Stalled reader: never reads after the first chunk; the server must give up.
      // (A paused client won't notice the close itself, so watch the server's count.)
      const stalled = net.connect(port, '127.0.0.1');
      stalled.on('error', () => {});
      stalled.once('data', () => stalled.pause());
      stalled.write(Buffer.concat([cmd('GET', 'slow'), cmd('QUIT')]));
      const t0 = Date.now();
      await sleep(100);
      let closedAfter = -1;
      for (let i = 0; i < 80; i++) {
        if (srv.stats.connectedClients === 0) {
          closedAfter = Date.now() - t0;
          break;
        }
        await sleep(50);
      }
      stalled.destroy();
      assert.ok(closedAfter >= 0 && closedAfter < 4000, `stalled peer released after ${closedAfter} ms`);
    } finally {
      srv.disconnectAll();
      await new Promise((r) => srv.close(r));
    }
  });
});
