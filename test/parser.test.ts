import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/resp/encoder.js';
import { ProtocolError, RespParser, splitArgs, UNAUTHENTICATED_LIMITS } from '../src/resp/parser.js';
import { OK, ReplyError, SimpleString } from '../src/reply.js';
import { cmd } from './helpers.js';

/** Push a chunk and collect every complete command. */
function feed(p: RespParser, chunk: Buffer): string[][] {
  p.push(chunk);
  const out: string[][] = [];
  for (let c = p.next(); c !== undefined; c = p.next()) out.push(c);
  return out;
}

test('parses pipelined commands in one chunk, one at a time', () => {
  const p = new RespParser();
  p.push(Buffer.concat([cmd('SET', 'a', '1'), cmd('GET', 'a'), cmd('PING')]));
  assert.deepEqual(p.next(), ['SET', 'a', '1']);
  assert.deepEqual(p.next(), ['GET', 'a']);
  assert.deepEqual(p.next(), ['PING']);
  assert.equal(p.next(), undefined);
  assert.equal(p.pending, 0);
});

test('handles frames split at every possible byte boundary', () => {
  const frame = Buffer.concat([cmd('SET', 'key', 'a\r\nvalue with CRLF'), cmd('GET', 'key')]);
  for (let cut = 1; cut < frame.length; cut++) {
    const p = new RespParser();
    const out = [...feed(p, frame.subarray(0, cut)), ...feed(p, frame.subarray(cut))];
    assert.deepEqual(out, [['SET', 'key', 'a\r\nvalue with CRLF'], ['GET', 'key']], `cut at ${cut}`);
  }
});

test('byte-by-byte feeding works', () => {
  const frame = cmd('HSET', 'h', 'f', 'v');
  const p = new RespParser();
  const out: string[][] = [];
  for (const byte of frame) out.push(...feed(p, Buffer.from([byte])));
  assert.deepEqual(out, [['HSET', 'h', 'f', 'v']]);
});

test('large values arriving in many chunks', () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const frame = cmd('SET', 'big', big);
  const p = new RespParser();
  const out: string[][] = [];
  for (let i = 0; i < frame.length; i += 65536) out.push(...feed(p, frame.subarray(i, i + 65536)));
  assert.equal(out.length, 1);
  assert.equal(out[0]![2]!.length, big.length);
});

test('commands with many arguments parse in linear time', () => {
  const timeFor = (n: number): number => {
    const parts = [`*${n + 2}\r\n$5\r\nRPUSH\r\n$1\r\nl\r\n`];
    for (let i = 0; i < n; i++) parts.push(`$${String(i).length + 1}\r\nv${i}\r\n`);
    const frame = Buffer.from(parts.join(''));
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const p = new RespParser();
      const t0 = performance.now();
      let got: string[][] = [];
      for (let i = 0; i < frame.length; i += 16384) got = got.concat(feed(p, frame.subarray(i, i + 16384)));
      best = Math.min(best, performance.now() - t0);
      assert.equal(got[0]!.length, n + 2);
    }
    return best;
  };
  timeFor(20_000); // warm up
  const t1 = timeFor(100_000);
  const t2 = timeFor(200_000);
  assert.ok(t2 < t1 * 3.5, `doubling the arguments should roughly double the time: ${t1.toFixed(1)} ms -> ${t2.toFixed(1)} ms`);
});

test('binary data is preserved byte for byte', () => {
  const bin = Buffer.from([0, 1, 2, 13, 10, 255, 254, 128]);
  const [[, value]] = feed(new RespParser(), cmd('ECHO', bin)) as [[string, string]];
  assert.deepEqual(Buffer.from(value, 'latin1'), bin);
});

test('inline commands follow sdssplitargs rules', () => {
  const p = new RespParser();
  const out = feed(p, Buffer.from('SET "hello world" \'it\\\'s\'\r\nGET "a\\x41\\n"\nPING\r\n\r\n   \r\n'));
  assert.deepEqual(out, [['SET', 'hello world', "it's"], ['GET', 'aA\n'], ['PING']]);
  assert.deepEqual(splitArgs('  a   b\tc  '), ['a', 'b', 'c']);
  assert.deepEqual(splitArgs('x"y z"'), ['xy z']);
  assert.deepEqual(splitArgs('""'), ['']);
  assert.equal(splitArgs('SET a "foo'), null);
  assert.equal(splitArgs('SET a "foo"bar'), null);
  assert.equal(splitArgs("SET a 'foo"), null);
  assert.throws(() => feed(new RespParser(), Buffer.from('SET a "foo\r\n')), /unbalanced quotes in request/);
});

test('valid commands before a malformed frame are returned first', () => {
  const p = new RespParser();
  p.push(Buffer.concat([cmd('SET', 'a', '1'), Buffer.from('*1\r\n+oops\r\n')]));
  assert.deepEqual(p.next(), ['SET', 'a', '1']);
  assert.throws(() => p.next(), /expected '\$', got '\+'/);
});

test('limits can be changed between commands (unauthenticated limits)', () => {
  const p = new RespParser(UNAUTHENTICATED_LIMITS);
  assert.throws(() => feed(p, Buffer.from('*11\r\n')), { message: 'Protocol error: unauthenticated multibulk length' });
  const q = new RespParser(UNAUTHENTICATED_LIMITS);
  assert.throws(() => feed(q, Buffer.from('*1\r\n$16385\r\n')), { message: 'Protocol error: unauthenticated bulk length' });
  const r = new RespParser(UNAUTHENTICATED_LIMITS);
  r.push(Buffer.concat([cmd('AUTH', 'pw'), cmd('SET', 'k', 'x'.repeat(20000))]));
  assert.deepEqual(r.next(), ['AUTH', 'pw']);
  r.limits = { ...r.limits, unauthenticated: false };
  assert.equal(r.next()![2]!.length, 20000);
});

test('limit checks happen in Redis order: absolute maximum first, then the pre-AUTH limit', () => {
  assert.throws(() => feed(new RespParser(UNAUTHENTICATED_LIMITS), Buffer.from('*3000000000\r\n')), { message: 'Protocol error: invalid multibulk length' });
  assert.throws(() => feed(new RespParser(UNAUTHENTICATED_LIMITS), Buffer.from('*1\r\n$600000000\r\n')), { message: 'Protocol error: invalid bulk length' });
});

test('a small leftover does not keep a large buffer alive', () => {
  const p = new RespParser();
  const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
  p.push(Buffer.concat([cmd('SET', 'k', big), Buffer.from('*2\r\n$3\r\nGET')]));
  assert.equal(p.next()![2]!.length, big.length);
  assert.equal(p.next(), undefined);
  assert.equal(p.pending, '$3\r\nGET'.length); // the *2 header is already part of the frame state
  // The partial frame still completes normally afterwards.
  p.push(Buffer.from('\r\n$1\r\nk\r\n'));
  assert.deepEqual(p.next(), ['GET', 'k']);
});

test('an inline line arriving byte by byte is not re-parsed per byte', () => {
  const line = `SET k ${'x'.repeat(60000)}\r\n`;
  const p = new RespParser();
  const t0 = performance.now();
  let got: string[] | undefined;
  for (let i = 0; i < line.length; i++) {
    p.push(Buffer.from(line[i]!));
    got = p.next() ?? got;
  }
  const ms = performance.now() - t0;
  assert.equal(got![2]!.length, 60000);
  assert.ok(ms < 150, `took ${ms.toFixed(0)} ms`);
});

test('protocol errors use Redis wording', () => {
  assert.throws(() => feed(new RespParser(), Buffer.from('*1\r\n+PING\r\n')), ProtocolError);
  assert.throws(() => feed(new RespParser(), Buffer.from('*abc\r\n')), { message: 'Protocol error: invalid multibulk length' });
  assert.throws(() => feed(new RespParser(), Buffer.from('*1\r\n$-5\r\n')), { message: 'Protocol error: invalid bulk length' });
  assert.throws(() => feed(new RespParser({ maxBulkLength: 10 }), Buffer.from('*1\r\n$11\r\n')), /invalid bulk length/);
  assert.throws(() => feed(new RespParser(), Buffer.from('*1\r\n$3\r\nabcXY')), /expected CRLF/);
  assert.throws(() => feed(new RespParser({ maxInlineLength: 100 }), Buffer.alloc(200, 0x61)), /too big inline request/);
});

test('encoder produces RESP2', () => {
  assert.equal(encode(OK), '+OK\r\n');
  assert.equal(encode('hi'), '$2\r\nhi\r\n');
  assert.equal(encode(''), '$0\r\n\r\n');
  assert.equal(encode(null), '$-1\r\n');
  assert.equal(encode(42), ':42\r\n');
  assert.equal(encode(9223372036854775807n), ':9223372036854775807\r\n');
  assert.equal(encode(['a', 1, null, [new SimpleString('x')]]), '*4\r\n$1\r\na\r\n:1\r\n$-1\r\n*1\r\n+x\r\n');
  assert.equal(encode(new ReplyError('bad\r\nthing')), '-ERR bad thing\r\n');
  assert.equal(encode(new ReplyError('Authentication required.', 'NOAUTH')), '-NOAUTH Authentication required.\r\n');
});
