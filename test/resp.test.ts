import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import type { Daemon } from '../src/daemon.js';
import { cmd, rawExchange, startTestDaemon } from './helpers.js';

let d: Daemon;
before(async () => {
  d = await startTestDaemon({ httpPort: null });
});
after(() => d.close());

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test('pipelined commands get replies in order', async () => {
  const payload = Buffer.concat([cmd('SET', 'p', '1'), cmd('INCR', 'p'), cmd('GET', 'p'), cmd('PING')]);
  const reply = await rawExchange(d.respPort!, payload, (s) => s.endsWith('+PONG\r\n'));
  assert.equal(reply, '+OK\r\n:2\r\n$1\r\n2\r\n+PONG\r\n');
});

test('inline commands work (telnet / nc) and QUIT closes the connection', async () => {
  const reply = await rawExchange(d.respPort!, 'SET greeting "hello world"\r\nGET greeting\r\nQUIT\r\nPING\r\n');
  assert.equal(reply, '+OK\r\n$11\r\nhello world\r\n+OK\r\n');
});

test('binary values round-trip byte for byte', async () => {
  const bin = Buffer.from([0, 255, 13, 10, 128, 7]);
  const reply = await rawExchange(d.respPort!, Buffer.concat([cmd('SET', 'bin', bin), cmd('GET', 'bin')]), (s) =>
    s.length >= 5 + 4 + 6 + 2,
  );
  assert.deepEqual(Buffer.from(reply, 'latin1'), Buffer.concat([Buffer.from('+OK\r\n$6\r\n'), bin, Buffer.from('\r\n')]));
});

test('a protocol error is reported and the connection is closed', async () => {
  const reply = await rawExchange(d.respPort!, '*2\r\n+bad\r\n');
  assert.match(reply, /^-ERR Protocol error: expected '\$', got '\+'\r\n$/);
});

test('many pipelined commands with backpressure', async () => {
  const n = 20000;
  const payload = Buffer.concat(Array.from({ length: n }, (_, i) => cmd('SET', `bulk:${i}`, 'x'.repeat(100))));
  const reply = await rawExchange(d.respPort!, payload, (s) => count(s, /\+OK\r\n/g) >= n);
  assert.equal(count(reply, /\+OK\r\n/g), n);
});

test('password protection: NOAUTH, WRONGPASS, AUTH, HELLO AUTH', async () => {
  const secure = await startTestDaemon({ httpPort: null, password: 's3cret' });
  // The singleton store is shared by both daemons in this process; that is fine for this test.
  try {
    const port = secure.respPort!;
    assert.match(await rawExchange(port, cmd('GET', 'x'), (s) => s.includes('\r\n')), /^-NOAUTH Authentication required/);
    assert.match(await rawExchange(port, cmd('AUTH', 'nope'), (s) => s.includes('\r\n')), /^-WRONGPASS/);
    assert.equal(await rawExchange(port, Buffer.concat([cmd('AUTH', 's3cret'), cmd('PING')]), (s) => s.endsWith('PONG\r\n')), '+OK\r\n+PONG\r\n');
    assert.equal(await rawExchange(port, Buffer.concat([cmd('AUTH', 'default', 's3cret'), cmd('PING')]), (s) => s.endsWith('PONG\r\n')), '+OK\r\n+PONG\r\n');
    const hello = await rawExchange(port, Buffer.concat([cmd('HELLO', '2', 'AUTH', 'default', 's3cret'), cmd('PING')]), (s) => s.endsWith('PONG\r\n'));
    assert.match(hello, /^\*14\r\n\$6\r\nserver\r\n/);
    assert.match(await rawExchange(port, cmd('HELLO', '4'), (s) => s.includes('\r\n')), /^-NOPROTO/);
  } finally {
    await secure.close();
  }
});

test('HELLO 3 switches the connection to RESP3 (maps and _ nulls)', async () => {
  await rawExchange(d.respPort!, cmd('HSET', 'r3', 'f', 'v'), (s) => s.includes('\r\n'));
  const reply = await rawExchange(
    d.respPort!,
    Buffer.concat([cmd('HELLO', '3'), cmd('GET', 'missing'), cmd('HGETALL', 'r3'), cmd('PING')]),
    (s) => s.endsWith('+PONG\r\n'),
  );
  assert.match(reply, /^%7\r\n\$6\r\nserver\r\n/);
  assert.ok(reply.endsWith('_\r\n%1\r\n$1\r\nf\r\n$1\r\nv\r\n+PONG\r\n'), JSON.stringify(reply));
});

test('CLIENT SETNAME / GETNAME / ID / LIST', async () => {
  const reply = await rawExchange(
    d.respPort!,
    Buffer.concat([cmd('CLIENT', 'SETNAME', 'worker-1'), cmd('CLIENT', 'GETNAME'), cmd('CLIENT', 'LIST')]),
    (s) => s.includes('lib-ver'),
  );
  assert.match(reply, /^\+OK\r\n\$8\r\nworker-1\r\n\$\d+\r\nid=\d+ .*name=worker-1/);
});

test('idle clients are closed when idleTimeoutSec is set', async () => {
  const idle = await startTestDaemon({ httpPort: null, idleTimeoutSec: 1 });
  try {
    const closedAfter = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      const s = net.connect(idle.respPort!, '127.0.0.1');
      s.on('close', () => resolve(Date.now() - t0));
    });
    assert.ok(closedAfter >= 900 && closedAfter < 3000, `closed after ${closedAfter} ms`);
  } finally {
    await idle.close();
  }
});

test('MULTI / EXEC / DISCARD', async () => {
  const reply = await rawExchange(
    d.respPort!,
    Buffer.concat([cmd('MULTI'), cmd('SET', 'tx', '1'), cmd('INCR', 'tx'), cmd('INCR', 'nope', 'extra'), cmd('EXEC'), cmd('PING')]),
    (s) => s.endsWith('+PONG\r\n'),
  );
  assert.equal(
    reply,
    "+OK\r\n+QUEUED\r\n+QUEUED\r\n-ERR wrong number of arguments for 'incr' command\r\n-EXECABORT Transaction discarded because of previous errors.\r\n+PONG\r\n",
  );
  const ok = await rawExchange(
    d.respPort!,
    Buffer.concat([cmd('MULTI'), cmd('SET', 'tx', '1'), cmd('INCR', 'tx'), cmd('HGET', 'tx', 'f'), cmd('EXEC')]),
    (s) => s.includes('WRONGTYPE'),
  );
  assert.equal(ok, '+OK\r\n+QUEUED\r\n+QUEUED\r\n+QUEUED\r\n*3\r\n+OK\r\n:2\r\n-WRONGTYPE Operation against a key holding the wrong kind of value\r\n');
  const discarded = await rawExchange(d.respPort!, Buffer.concat([cmd('MULTI'), cmd('SET', 'tx', '99'), cmd('DISCARD'), cmd('GET', 'tx')]), (s) => s.endsWith('2\r\n'));
  assert.equal(discarded, '+OK\r\n+QUEUED\r\n+OK\r\n$1\r\n2\r\n');
});

test('WATCH aborts EXEC when another client modifies the key', async () => {
  const a = net.connect(d.respPort!, '127.0.0.1');
  let data = '';
  a.on('data', (c) => (data += c.toString('latin1')));
  const waitFor = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(data); i++) await new Promise((r) => setTimeout(r, 10));
  };
  a.write(cmd('WATCH', 'balance'));
  await waitFor(/^\+OK\r\n$/);
  await rawExchange(d.respPort!, cmd('SET', 'balance', '100'), (s) => s.includes('\r\n')); // other client
  a.write(Buffer.concat([cmd('MULTI'), cmd('SET', 'balance', '0'), cmd('EXEC')]));
  await waitFor(/\*-1\r\n$/);
  assert.equal(data, '+OK\r\n+OK\r\n+QUEUED\r\n*-1\r\n');
  // Without interference the transaction goes through.
  data = '';
  a.write(Buffer.concat([cmd('WATCH', 'balance'), cmd('MULTI'), cmd('SET', 'balance', '0'), cmd('EXEC')]));
  await waitFor(/\*1\r\n\+OK\r\n$/);
  assert.equal(data, '+OK\r\n+OK\r\n+QUEUED\r\n*1\r\n+OK\r\n');
  a.destroy();
});
