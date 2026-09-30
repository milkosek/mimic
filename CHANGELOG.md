# Changelog

## 0.2.0 (unreleased)

- Rewritten in TypeScript (strict). It compiles to plain ES2022 JavaScript and runs on Node.js 18 or newer with zero runtime dependencies.
- **Redis protocol (RESP) over TCP.** redis-cli, ioredis, node-redis, redis-py and other standard clients work without changes.
  - RESP2 by default, RESP3 after `HELLO 3`.
  - Pipelining, backpressure, inline commands (telnet/nc).
  - `AUTH`, `HELLO`, `CLIENT`, `SELECT 0`, `QUIT`, `RESET`.
- `MULTI` / `EXEC` / `DISCARD`, and optimistic locking with `WATCH` / `UNWATCH`.
- **Proper `SCAN`.** It uses a stateless reverse-binary cursor over a bucket table, like Redis' `dictScan`. A full scan returns every key that exists for the whole scan, even while the table grows or shrinks. `MATCH`, `COUNT` and `TYPE` are supported.
- Binary-safe keys and values; `STRLEN` and `APPEND` count bytes.
- Exact signed 64-bit `INCR` family, with overflow detection.
- Lists are stored in a ring buffer, so `LPUSH`/`LPOP` are O(1).
- New commands:
  - Strings: `GETEX`, `GETRANGE`, `MSETNX`
  - TTL: `EXPIRE` with `NX`/`XX`/`GT`/`LT`, `EXPIRETIME`, `PEXPIRETIME`
  - Keys: `RENAMENX`, `TOUCH`
  - Hashes: `HMSET`, `HMGET`, `HSETNX`
  - Lists: `LINDEX`, `LTRIM`
  - Server: `TIME`, `CONFIG GET`, `COMMAND COUNT/INFO/LIST/DOCS`
- The HTTP API is kept alongside RESP (it can be turned off). `GET /keys` now accepts a `cursor` for SCAN.
- Configuration through `MIMIC_*` environment variables or command-line flags, plus `--password-file`.

## 0.1.0

- First draft: an HTTP/JSON API, a singleton store, and lazy plus active TTL expiry.
