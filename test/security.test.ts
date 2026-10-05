// Security hardening: protected mode, login protection, TLS, hashed
// passwords, disabled commands, configuration checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { AuthGuard, hashPassword, isLoopback, PasswordCheck } from '../src/auth.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { startDaemon } from '../src/daemon.js';
import { cmd, rawExchange, sleep, startTestDaemon } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/tls/', import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name);
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** An address of this machine that isn't loopback, to act as a "remote" client. */
const externalIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const needsExternal = externalIp ? false : 'no non-loopback network interface';

/** Send `payload` from `host` and collect what comes back until the server closes or `until` matches. */
function exchangeFrom(host: string, port: number, payload: Buffer | string, until?: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    let data = '';
    const timer = setTimeout(() => (s.destroy(), resolve(`${data}<timeout>`)), 5000);
    s.on('data', (c) => {
      data += c.toString('latin1');
      if (until?.(data)) (clearTimeout(timer), s.destroy(), resolve(data));
    });
    s.on('close', () => (clearTimeout(timer), resolve(data)));
    s.on('error', reject);
    s.on('connect', () => s.write(payload));
  });
}

function httpFrom(host: string, port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('configuration checks', () => {
  const load = (argv: string[], env: NodeJS.ProcessEnv = {}) => loadConfig(argv, env);

  test('numeric options are range-checked instead of misbehaving', () => {
    for (const bad of [
      ['--idle-timeout', '3000000'],
      ['--cleanup-time-budget', '0'],
      ['--cleanup-interval', '0'],
      ['--max-memory-percent', '101'],
      ['--max-clients', '0'],
      ['--databases', '0'],
      ['--max-query-buffer', '1000'],
      ['--max-bulk-bytes', '600000000'],
      ['--auth-timeout', '9999999'],
    ]) {
      assert.throws(() => load(bad), ConfigError, bad.join(' '));
    }
    assert.equal(load(['--idle-timeout', '300']).config.idleTimeoutSec, 300);
  });

  test('safe defaults: HTTP stays on loopback even when RESP is exposed; protected mode on', () => {
    const { config } = load(['--host', '0.0.0.0']);
    assert.equal(config.httpHost, '127.0.0.1');
    assert.equal(config.protectedMode, true);
    assert.equal(config.authTimeoutSec, 10);
    assert.equal(config.authMaxFailures, 10);
    assert.equal(load(['--protected-mode', 'no']).config.protectedMode, false);
    assert.throws(() => load(['--protected-mode', 'maybe']), ConfigError);
    assert.deepEqual(load(['--disable-commands', 'flushall, keys']).config.disableCommands, ['FLUSHALL', 'KEYS']);
  });

  test('TLS options must be complete and consistent', () => {
    assert.throws(() => load(['--port', 'off']), /no way to connect/);
    assert.throws(() => load(['--tls-port', '6390']), /needs --tls-cert-file/);
    assert.throws(() => load(['--tls-cert-file', 'a.crt', '--tls-key-file', 'a.key']), /neither --tls-port nor --http-tls/);
    assert.throws(() => load(['--tls-port', '6390', '--tls-pfx-file', 'a.p12', '--tls-cert-file', 'a.crt']), /either/);
    assert.throws(() => load(['--tls-port', '6390', '--tls-pfx-file', 'a.p12', '--tls-auth-clients', 'yes']), /needs --tls-ca-cert-file/);
    assert.throws(() => load(['--tls-port', '6379', '--tls-pfx-file', 'a.p12']), /must differ/);
    const ok = load(['--tls-port', '6390', '--tls-pfx-file', 'a.p12', '--tls-ca-cert-file', 'ca.crt']).config;
    assert.equal(ok.tlsAuthClients, 'yes', 'with a CA, client certificates are required by default');
    assert.equal(load(['--tls-port', '6390', '--tls-pfx-file', 'a.p12']).config.tlsAuthClients, 'no');
  });

  test('risky password setups produce warnings', () => {
    assert.match(load(['--password', 'short']).warnings.join('\n'), /process list[\s\S]*shorter than 16/);
    assert.equal(load([], { MIMIC_PASSWORD: hashPassword('x') }).warnings.length, 0, 'a hash is not "short"');
    if (process.platform !== 'win32') {
      const dir = mkdtempSync(join(tmpdir(), 'mimic-pw-'));
      const file = join(dir, 'pw');
      writeFileSync(file, 'a-long-enough-password-123\n');
      chmodSync(file, 0o644);
      assert.match(load(['--password-file', file]).warnings.join('\n'), /other users/);
      chmodSync(file, 0o600);
      assert.deepEqual(load(['--password-file', file]).warnings, []);
    }
  });
});

describe('passwords and login protection', () => {
  test('PasswordCheck keeps only a hash and accepts plain or sha256: configuration', () => {
    const plain = new PasswordCheck('s3cret-password');
    const hashed = new PasswordCheck(hashPassword('s3cret-password'));
    assert.equal(plain.hashed, false);
    assert.equal(hashed.hashed, true);
    for (const c of [plain, hashed]) {
      assert.equal(c.matches('s3cret-password'), true);
      assert.equal(c.matches('s3cret-passwordX'), false);
      assert.equal(c.matches(''), false);
    }
    assert.match(hashPassword('x'), /^sha256:[0-9a-f]{64}$/);
  });

  test('isLoopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
    for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '1.127.0.0', '', undefined, '::']) assert.equal(isLoopback(a), false, String(a));
  });

  test('AuthGuard blocks a remote address after too many failures, never loopback', () => {
    const warnings: string[] = [];
    const g = new AuthGuard({ maxFailures: 3, windowMs: 10_000, blockMs: 200, warn: (m) => warnings.push(m) });
    assert.equal(g.recordFailure('10.0.0.5', 'test'), false);
    assert.equal(g.recordFailure('10.0.0.5', 'test'), false);
    assert.equal(g.recordFailure('10.0.0.5', 'test'), true);
    assert.equal(g.isBlocked('10.0.0.5'), true);
    assert.equal(g.isBlocked('10.0.0.6'), false);
    for (let i = 0; i < 10; i++) g.recordFailure('127.0.0.1', 'test');
    assert.equal(g.isBlocked('127.0.0.1'), false);
    assert.equal(warnings.filter((w) => w.includes('failed authentication from 10.0.0.5')).length, 1, 'one warning per address per window');
    assert.ok(warnings.some((w) => w.includes('10.0.0.5 blocked')));
    // Many addresses can't grow the table without bound.
    for (let i = 0; i < 20_000; i++) g.recordFailure(`10.1.${i >> 8}.${i & 255}`, 'test');
  });

  test('a password given as sha256:<hex> works, and the CLI can produce one', async () => {
    const out = spawnSync(process.execPath, [CLI, '--hash-password'], { input: 'correct horse battery staple\n', encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const hash = out.stdout.trim();
    assert.equal(hash, hashPassword('correct horse battery staple'));
    const d = await startTestDaemon({ password: hash, httpPort: null });
    try {
      const ok = await rawExchange(d.respPort!, Buffer.concat([cmd('AUTH', 'correct horse battery staple'), cmd('PING')]), (s) => s.includes('PONG') || s.startsWith('-'));
      assert.equal(ok, '+OK\r\n+PONG\r\n');
      const bad = await rawExchange(d.respPort!, cmd('AUTH', hash), (s) => s.includes('\r\n'));
      assert.match(bad, /^-WRONGPASS/, 'the hash itself is not the password');
    } finally {
      await d.close();
    }
  });

  // Polish letters (2-byte UTF-8), plus a mix of 2-, 3- and 4-byte characters (umlauts, CJK, emoji).
  for (const [pw, almost] of [
    ['zażółć-gęślą-jaźń', 'zazolc-gesla-jazn'],
    ['pässwörd-日本-🔑', 'passwort-日本-🔒'],
  ]) {
    test(`a non-ASCII password works over RESP and HTTP (compared as UTF-8 bytes): ${pw}`, async () => {
      const d = await startTestDaemon({ password: pw });
      try {
        const ok = await rawExchange(d.respPort!, Buffer.concat([cmd('AUTH', pw), cmd('PING')]), (s) => s.includes('PONG') || s.startsWith('-'));
        assert.equal(ok, '+OK\r\n+PONG\r\n');
        assert.match(await rawExchange(d.respPort!, cmd('AUTH', almost), (s) => s.includes('\r\n')), /^-WRONGPASS/);
        // Raw request: the header carries the UTF-8 bytes, as curl and other clients send them.
        const call = async (token: string): Promise<number> => {
          const body = '["PING"]';
          const head = `POST /command HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\nAuthorization: Bearer `;
          const res = await rawExchange(d.httpPort!, Buffer.concat([Buffer.from(head), Buffer.from(token, 'utf8'), Buffer.from(`\r\n\r\n${body}`)]));
          return Number(res.slice(9, 12));
        };
        assert.equal(await call(pw), 200);
        assert.equal(await call(almost), 401);
        // The same password given as its hash.
        assert.equal(new PasswordCheck(hashPassword(pw)).matches(Buffer.from(pw, 'utf8').toString('latin1')), true);
      } finally {
        await d.close();
      }
    });
  }

  test('connections that never authenticate are closed after --auth-timeout', async () => {
    const d = await startTestDaemon({ password: 'a-long-test-password', authTimeoutSec: 1, httpPort: null });
    try {
      const t0 = Date.now();
      const idle = await rawExchange(d.respPort!, '');
      assert.equal(idle, '');
      const took = Date.now() - t0;
      assert.ok(took >= 900 && took < 3000, `closed after ${took} ms`);
      // An authenticated client stays connected.
      const s = net.connect(d.respPort!, '127.0.0.1');
      s.on('error', () => {});
      s.write(cmd('AUTH', 'a-long-test-password'));
      await sleep(1500);
      assert.equal(s.destroyed, false);
      s.destroy();
    } finally {
      await d.close();
    }
  });

  test('an unauthenticated client that never reads is cut off after 256 KB', async () => {
    const d = await startTestDaemon({ password: 'a-long-test-password', httpPort: null });
    try {
      const s = net.connect(d.respPort!, '127.0.0.1');
      s.on('error', () => {});
      s.pause();
      await new Promise((r) => s.once('connect', r));
      const chunk = Buffer.from('PING\r\n'.repeat(10_000));
      for (let i = 0; i < 400 && !s.destroyed; i++) s.write(chunk); // 24 MB of PINGs, never reading the NOAUTHs
      let closed = false;
      for (let i = 0; i < 100 && !closed; i++) {
        await sleep(50);
        closed = d.resp.stats.connectedClients === 0;
      }
      s.destroy();
      assert.ok(closed);
    } finally {
      await d.close();
    }
  });

  test('wrong passwords from a remote address get it blocked, over RESP and HTTP alike', { skip: needsExternal }, async () => {
    const d = await startTestDaemon({ host: '0.0.0.0', httpHost: '0.0.0.0', password: 'a-long-test-password', authMaxFailures: 3 });
    try {
      const ip = externalIp!;
      const tries = Buffer.concat([cmd('AUTH', 'wrong1'), cmd('AUTH', 'wrong2'), cmd('AUTH', 'wrong3'), cmd('PING')]);
      const first = await exchangeFrom(ip, d.respPort!, tries);
      assert.equal((first.match(/-WRONGPASS/g) ?? []).length, 3, first);
      assert.ok(!first.includes('NOAUTH'), 'the connection is closed after the failure that triggers the block');
      const again = await exchangeFrom(ip, d.respPort!, cmd('AUTH', 'a-long-test-password'));
      assert.match(again, /^-ERR too many failed authentication attempts/);
      const viaHttp = await httpFrom(ip, d.httpPort!, '/info', { authorization: 'Bearer a-long-test-password' });
      assert.equal(viaHttp.status, 429);
      assert.ok(viaHttp.headers['retry-after']);
      // Loopback is never blocked.
      const local = await rawExchange(d.respPort!, Buffer.concat([cmd('AUTH', 'a-long-test-password'), cmd('PING')]), (s) => s.includes('PONG'));
      assert.equal(local, '+OK\r\n+PONG\r\n');
    } finally {
      await d.close();
    }
  });

  test('the HTTP token must use the Bearer scheme', async () => {
    const d = await startTestDaemon({ password: 'a-long-test-password' });
    try {
      assert.equal((await httpFrom('127.0.0.1', d.httpPort!, '/info', { authorization: 'a-long-test-password' })).status, 401);
      assert.equal((await httpFrom('127.0.0.1', d.httpPort!, '/info', { authorization: 'Basic a-long-test-password' })).status, 401);
      const ok = await httpFrom('127.0.0.1', d.httpPort!, '/info', { authorization: 'Bearer a-long-test-password' });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers['x-content-type-options'], 'nosniff');
      assert.equal(ok.headers['cache-control'], 'no-store');
    } finally {
      await d.close();
    }
  });
});

describe('protected mode', () => {
  test('without a password, remote clients are refused on RESP and HTTP; local ones are not', { skip: needsExternal }, async () => {
    const d = await startTestDaemon({ host: '0.0.0.0', httpHost: '0.0.0.0' });
    try {
      const remote = await exchangeFrom(externalIp!, d.respPort!, cmd('PING'));
      assert.match(remote, /^-DENIED MIMIC is running in protected mode/);
      assert.equal((await httpFrom(externalIp!, d.httpPort!, '/health')).status, 403);
      assert.equal(await rawExchange(d.respPort!, cmd('PING'), (s) => s.includes('\r\n')), '+PONG\r\n');
    } finally {
      await d.close();
    }
  });

  test('with a password, or with --protected-mode no, remote clients may connect', { skip: needsExternal }, async () => {
    const withPw = await startTestDaemon({ host: '0.0.0.0', password: 'a-long-test-password', httpPort: null });
    const off = await startTestDaemon({ host: '0.0.0.0', protectedMode: false, httpPort: null });
    try {
      assert.match(await exchangeFrom(externalIp!, withPw.respPort!, cmd('PING'), (s) => s.includes('\r\n')), /^-NOAUTH/);
      assert.equal(await exchangeFrom(externalIp!, off.respPort!, cmd('PING'), (s) => s.includes('\r\n')), '+PONG\r\n');
    } finally {
      await withPw.close();
      await off.close();
    }
  });
});

describe('disabled commands', () => {
  test('--disable-commands makes commands unknown everywhere', async () => {
    const d = await startTestDaemon({ disableCommands: ['FLUSHALL', 'KEYS'] });
    try {
      const reply = await rawExchange(
        d.respPort!,
        Buffer.concat([cmd('FLUSHALL'), cmd('COMMAND', 'INFO', 'flushall', 'get'), cmd('MULTI'), cmd('KEYS', '*'), cmd('EXEC')]),
        (s) => s.includes('EXECABORT'),
      );
      assert.match(reply, /^-ERR unknown command 'FLUSHALL'/);
      assert.match(reply, /\*2\r\n\$-1\r\n\*6\r\n\$3\r\nget/, 'COMMAND INFO hides it');
      assert.match(reply, /-ERR unknown command 'KEYS'[\s\S]*-EXECABORT/);
      const http = await httpFrom('127.0.0.1', d.httpPort!, '/command', {}, '["FLUSHALL"]');
      assert.equal(http.status, 400);
      assert.match(http.text, /unknown command/);
      assert.equal((await httpFrom('127.0.0.1', d.httpPort!, '/keys?pattern=*')).status, 400);
    } finally {
      await d.close();
    }
  });

  test('unknown names and essential commands are rejected at startup', async () => {
    const { config } = loadConfig([], {});
    await assert.rejects(startDaemon({ ...config, port: 0, httpPort: null, disableCommands: ['FLUSHAL'] }), /unknown command FLUSHAL/);
    await assert.rejects(startDaemon({ ...config, port: 0, httpPort: null, disableCommands: ['AUTH'] }), /can't be disabled/);
  });
});

describe('TLS', () => {
  const ca = readFileSync(fixture('ca.crt'));

  function tlsExchange(port: number, payload: Buffer, opts: tls.ConnectionOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ port, host: '127.0.0.1', ca, servername: 'localhost', ...opts }, () => s.write(payload));
      let data = '';
      s.on('data', (c) => {
        data += c.toString('latin1');
        if (data.endsWith('\r\n')) s.end();
      });
      s.on('close', () => resolve(data));
      s.on('error', reject);
    });
  }

  test('RESP over TLS with PEM files; plain RESP can be turned off', async () => {
    const d = await startTestDaemon({ port: null, tlsPort: 0, tlsCertFile: fixture('server.crt'), tlsKeyFile: fixture('server.key'), httpPort: null });
    try {
      assert.equal(d.respPort, null);
      assert.equal(await tlsExchange(d.respTlsPort!, cmd('PING')), '+PONG\r\n');
      // Plain text on the TLS port is a failed handshake, not a crash.
      const plain = await rawExchange(d.respTlsPort!, cmd('PING'));
      assert.ok(!plain.includes('PONG'));
      assert.equal(await tlsExchange(d.respTlsPort!, cmd('PING')), '+PONG\r\n', 'still serving');
    } finally {
      await d.close();
    }
  });

  test('a PKCS#12 file with a passphrase file (as exported from IBM i DCM) works, and so does HTTPS', async () => {
    const d = await startTestDaemon({ tlsPort: 0, tlsPfxFile: fixture('server.p12'), tlsKeyPassFile: fixture('pfx-pass.txt'), httpTls: true });
    try {
      assert.equal(await tlsExchange(d.respTlsPort!, cmd('PING')), '+PONG\r\n');
      const status = await new Promise<number>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port: d.httpPort!, path: '/health', ca, servername: 'localhost' }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
      assert.equal(status, 200);
    } finally {
      await d.close();
    }
  });

  test('client certificates can be required', async () => {
    const d = await startTestDaemon({
      tlsPort: 0,
      tlsCertFile: fixture('server.crt'),
      tlsKeyFile: fixture('server.key'),
      tlsCaCertFile: fixture('ca.crt'),
      tlsAuthClients: 'yes',
      httpPort: null,
    });
    try {
      const withCert = await tlsExchange(d.respTlsPort!, cmd('PING'), { cert: readFileSync(fixture('client.crt')), key: readFileSync(fixture('client.key')) });
      assert.equal(withCert, '+PONG\r\n');
      const without = await tlsExchange(d.respTlsPort!, cmd('PING')).catch((e: Error) => `error: ${e.message}`);
      assert.ok(!without.includes('PONG'), without);
    } finally {
      await d.close();
    }
  });

  test('a wrong passphrase or a bad certificate stops startup with a clear message', async () => {
    const { config } = loadConfig([], {});
    const dir = mkdtempSync(join(tmpdir(), 'mimic-tls-'));
    writeFileSync(join(dir, 'pass'), 'wrong');
    await assert.rejects(
      startDaemon({ ...config, port: 0, httpPort: null, tlsPort: 0, tlsPfxFile: fixture('server.p12'), tlsKeyPassFile: join(dir, 'pass') }),
      (e: Error) => e instanceof ConfigError && /could not be loaded/.test(e.message),
    );
    await assert.rejects(
      startDaemon({ ...config, port: 0, httpPort: null, tlsPort: 0, tlsCertFile: fixture('nope.crt'), tlsKeyFile: fixture('server.key') }),
      /cannot read TLS certificate file/,
    );
  });
});

describe('sweep findings', () => {
  test('CONFIG GET with Object.prototype names, deep JSON, and CLIENT SETINFO with newlines are all handled', async () => {
    const d = await startTestDaemon();
    try {
      const reply = await rawExchange(
        d.respPort!,
        Buffer.concat([cmd('CONFIG', 'GET', 'constructor'), cmd('CONFIG', 'GET', '__proto__'), cmd('CLIENT', 'SETINFO', 'LIB-NAME', 'x\nid=999 name=admin'), cmd('PING')]),
        (s) => s.includes('PONG'),
      );
      assert.equal(reply, "*0\r\n*0\r\n-ERR lib-name cannot contain spaces, newlines or special characters.\r\n+PONG\r\n");
      const deep = `["ECHO",${'['.repeat(100_000)}${']'.repeat(100_000)}]`;
      const http = await httpFrom('127.0.0.1', d.httpPort!, '/command', {}, deep);
      assert.equal(http.status, 400);
      assert.match(http.text, /nested too deeply/);
    } finally {
      await d.close();
    }
  });
});
