import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeCommand, describeReply } from '../src/debuglog.js';
import { MapReply, NULL_ARRAY, OK, ReplyError } from '../src/reply.js';
import { fromText } from '../src/bytes.js';
import { cmd, rawExchange, startTestDaemon } from './helpers.js';

test('debug descriptions: readable, truncated, passwords masked', () => {
  assert.equal(describeCommand(['set', 'k', fromText('zażółć')]), 'SET "k" "zażółć"');
  assert.equal(describeCommand(['AUTH', 'user', 'secret']), 'AUTH "(redacted)" "(redacted)"');
  assert.equal(describeCommand(['HELLO', '3', 'AUTH', 'default', 'pw']), 'HELLO "3" "AUTH" "default" "(redacted)"');
  assert.match(describeCommand(['SET', 'k', 'x'.repeat(1000)]), /^SET "k" "x{48}…"\(1000 bytes\)$/);
  assert.equal(describeCommand(['GET', '\xff\x00']), 'GET "ÿ\\u0000"');
  assert.equal(describeReply(OK), 'OK');
  assert.equal(describeReply(null), '(nil)');
  assert.equal(describeReply(NULL_ARRAY), '(nil)');
  assert.equal(describeReply(5n), '(integer) 5');
  assert.equal(describeReply(new ReplyError('boom')), '(error) ERR boom');
  assert.equal(describeReply(['a', ['b']]), '["a", (array of 1)]');
  assert.equal(describeReply(new MapReply([['f', 'v']])), '{"f": "v"}');
});

test('--log-level debug logs connections and every command with its reply', async () => {
  const lines: string[] = [];
  const logger = { info() {}, warn() {}, error() {}, debug: (m: string) => lines.push(m) };
  const d = await startTestDaemon({}, logger);
  try {
    await rawExchange(d.respPort, cmd('SET', 'dbg', 'v'), (s) => s.includes('\r\n'));
    await fetch(`http://127.0.0.1:${d.httpPort}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '["GET","dbg"]' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(lines.some((l) => /^\[resp\] client \d+ connected from /.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^\[resp\] client \d+ db0: SET "dbg" "v" -> OK$/.test(l)), lines.join('\n'));
    assert.ok(lines.includes('[http] db0: GET "dbg" -> "v"'), lines.join('\n'));
    assert.ok(lines.some((l) => /^\[http\] POST \/command 200 \(/.test(l)), lines.join('\n'));
  } finally {
    await d.close();
  }
});
