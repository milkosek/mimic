import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError, RespParser } from '../src/resp/parser.js';
import { encode } from '../src/resp/encoder.js';
import { OK, ReplyError, SimpleString } from '../src/reply.js';
import { cmd } from './helpers.js';

test('parses pipelined commands in one chunk', () => {
  const p = new RespParser();
  const out = p.push(Buffer.concat([cmd('SET', 'a', '1'), cmd('GET', 'a'), cmd('PING')]));
  assert.deepEqual(out, [['SET', 'a', '1'], ['GET', 'a'], ['PING']]);
  assert.equal(p.pending, 0);
});

test('handles frames split at every possible byte boundary', () => {
  const frame = Buffer.concat([cmd('SET', 'key', 'a\r\nvalue with CRLF'), cmd('GET', 'key')]);
  for (let cut = 1; cut < frame.length; cut++) {
    const p = new RespParser();
    const out = [...p.push(frame.subarray(0, cut)), ...p.push(frame.subarray(cut))];
    assert.deepEqual(out, [['SET', 'key', 'a\r\nvalue with CRLF'], ['GET', 'key']], `cut at ${cut}`);
  }
});

test('byte-by-byte feeding works', () => {
  const frame = cmd('HSET', 'h', 'f', 'v');
  const p = new RespParser();
  const out: string[][] = [];
  for (const byte of frame) out.push(...p.push(Buffer.from([byte])));
  assert.deepEqual(out, [['HSET', 'h', 'f', 'v']]);
});

test('large values arriving in many chunks', () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const frame = cmd('SET', 'big', big);
  const p = new RespParser();
  let out: string[][] = [];
  for (let i = 0; i < frame.length; i += 65536) out = out.concat(p.push(frame.subarray(i, i + 65536)));
  assert.equal(out.length, 1);
  assert.equal(out[0]![2]!.length, big.length);
});

test('binary data is preserved byte for byte', () => {
  const bin = Buffer.from([0, 1, 2, 13, 10, 255, 254, 128]);
  const [[, value]] = new RespParser().push(cmd('ECHO', bin)) as [[string, string]];
  assert.deepEqual(Buffer.from(value, 'latin1'), bin);
});

test('inline commands with quoting', () => {
  const p = new RespParser();
  const out = p.push(Buffer.from('SET "hello world" \'it\\\'s\'\r\nGET "a\\x41\\n"\nPING\r\n\r\n'));
  assert.deepEqual(out, [['SET', 'hello world', "it's"], ['GET', 'aA\n'], ['PING']]);
});

test('protocol errors', () => {
  assert.throws(() => new RespParser().push(Buffer.from('*1\r\n+PING\r\n')), ProtocolError);
  assert.throws(() => new RespParser().push(Buffer.from('*abc\r\n')), /invalid multibulk length/);
  assert.throws(() => new RespParser().push(Buffer.from('*1\r\n$-5\r\n')), /invalid bulk length/);
  assert.throws(() => new RespParser({ maxBulkLength: 10 }).push(Buffer.from('*1\r\n$11\r\n')), /invalid bulk length/);
  assert.throws(() => new RespParser().push(Buffer.from('*1\r\n$3\r\nabcXY')), /expected CRLF/);
  assert.throws(() => new RespParser({ maxInlineLength: 100 }).push(Buffer.alloc(200, 0x61)), /too big inline/);
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
