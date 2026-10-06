# Changelog

## 0.3.0 (first public release)

Everything since the 0.1.0 draft. The 0.2.x versions were internal milestones and were never published.

- Rewritten in TypeScript (strict). It compiles to plain ES2022 JavaScript and runs on Node.js 18 or newer with zero runtime dependencies.
- **Redis protocol (RESP) over TCP.** redis-cli, ioredis, node-redis, redis-py and other standard clients work without changes.
  - RESP2 by default, RESP3 after `HELLO 3`.
  - Pipelining, backpressure, inline commands (telnet/nc).
  - `AUTH`, `HELLO`, `CLIENT`, `QUIT`, `RESET`.
- **16 databases**, as in Redis: `SELECT`, `MOVE`, `SWAPDB`, `FLUSHDB` and `FLUSHALL`, with `--databases` to change the count. Over HTTP, use `?db=N`.
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
- **Verified against Redis 7.0.** A compatibility test compares raw replies with a real `redis-server` for more than 500 hand-picked commands. It also runs seeded random command streams over RESP2 and RESP3, and a seeded fuzz of glob patterns.

### Fixed during the pre-release review

Security and robustness:

- A client resetting its connection while being turned away at `--max-clients` crashed the server, and the whole cache was lost.
- Web pages could write to the cache through the browser:
  - HTTP now requires `Content-Type: application/json` and refuses foreign `Origin` headers. Without a password it also checks the `Host` header, which blocks DNS rebinding.
  - On the RESP port, a `POST` or `Host:` line now drops the connection before anything runs, as in Redis.
- Unauthenticated clients could make the server buffer unlimited data. They now get Redis' limits (10 arguments, 16 KB each), and each client's input is capped by `--max-query-buffer` (1 GB).
- An empty password, an empty password file, or a password env var that was set but empty silently disabled authentication. Each is now a startup error.
- WATCH didn't see writes made over HTTP, or by code embedding MIMIC. Change notifications now come from the data layer itself.
- WATCH was invalidated by writes that changed nothing, such as a failed `SETNX`. It wasn't invalidated by a watched key expiring. Both now behave as in Redis.

Correctness and performance:

- Valid commands arriving in the same TCP chunk as a malformed frame were thrown away.
- The parser re-read a whole frame on every new chunk, making many-argument commands quadratic. It is now linear.
- The SCAN bucket table was rehashed in one go. It is now incremental, like Redis.
- HTTP bodies over the limit got a connection reset instead of a 413.
- `--password-file` on the command line didn't win over `MIMIC_PASSWORD` from the environment.
- HTTP integer replies became strings above 2^53. They are now always JSON numbers, with full precision.
- Keys containing `..`, `/` or `\` couldn't be reached through `/keys/:key`.

Found by a second, adversarial review, each reproduced and then fixed:

- **A pipeline whose replies added up to more than about 512 MB crashed the process.** Replies are now written in 64 KB pieces with real backpressure: while a client isn't reading, MIMIC stops running its commands.
- **`KEYS`/`SCAN` patterns such as `*?*?*?…x` hung the server** through regex backtracking. A web page could trigger it with a plain GET. Matching is now a port of Redis' `stringmatchlen()` with its CVE-2022-36021 protections, and cross-site browser GETs are refused using `Sec-Fetch-Site`.
- A multi-megabyte integer argument stalled the event loop. It is now rejected before any big-number parsing.
- A small leftover after a large command kept the whole large buffer in memory.
- `FLUSHDB`, `FLUSHALL` and `SWAPDB` invalidated every watched key. Like Redis, they now invalidate only keys that existed.
- `PUT /keys/:key` with a bare JSON value returned 500 instead of 400.
- `EXEC` with arguments inside `MULTI` now aborts the transaction, as Redis does.
- Before AUTH, unknown-command and arity errors now come before `NOAUTH`, in Redis' order.
- Closed connections are fully released even if the peer never closes its side. The close waits while a slow reader is still receiving data.
- Other small fixes:
  - `CLIENT SETNAME` and `HELLO … SETNAME` reject control characters.
  - `AUTH`/`HELLO` with an unknown user is `WRONGPASS` even without a password.
  - `Host: localhost.` is accepted.
  - The store's change listener is released when startup fails.
  - The daemon only stops a store timer it started itself.

Redis compatibility (each case checked against `redis-server`):

- Integers are parsed like Redis' `string2ll`: `"007"`, `"+5"` and `"-0"` are rejected.
- Errors:
  - Messages starting with a capitalised word (for example "GT and LT …" or "MULTI calls can not be nested") were missing the `ERR` prefix.
  - The unknown-command error now has Redis' exact wording, including the trailing space.
  - `DECRBY` with the minimum 64-bit value reports "decrement would overflow".
  - A bad count for `LPOP`/`RPOP` reports "value is out of range, must be positive".
- Expire times:
  - Values are checked exactly as in Redis. Out-of-range values give "invalid expire time in '<command>' command", with the name of the command actually called.
  - Mixing expire options in `SET` or `GETEX` is a syntax error. Repeating the same one is allowed, and the last one wins; that is what Redis 7.0 does.
- Replies:
  - An `EXEC` aborted by WATCH, and `LPOP`/`RPOP` with a count on a missing key, now return a null array (`*-1`).
  - `GETRANGE` clamps a too-negative end index the way Redis does.
- Order of checks:
  - `LINDEX` checks the key's type before parsing the index.
  - `GETEX` looks up the key before validating the expire value.
- Inline commands follow Redis' tokeniser (`sdssplitargs`). Unbalanced quotes are a protocol error.
- `SCAN` cursors are parsed like `strtoul`, so `SCAN -1` is valid.
- Glob patterns follow `stringmatchlen()`, quirks included: an unterminated `[` is a class to the end of the pattern, `[]` matches nothing, and reversed ranges are swapped. A seeded fuzz compares random patterns with Redis' `KEYS`.
- The pre-AUTH limit checks follow Redis' order, and the multibulk limit is `INT_MAX` as in Redis; `--max-query-buffer` bounds memory.

Hard edge cases from the next review round, fixed where the fix was simpler than the problem:

- **A client that writes a whole pipeline before reading (redis-py, Jedis and other synchronous clients) could deadlock with the server.** MIMIC used to stop reading from a client whose replies were backing up. It now keeps reading and only stops *running* its commands, as Redis does, and a client that never reads is disconnected once its input passes `--max-query-buffer`, without a reply (like Redis).
- **Filling the V8 heap aborted the process, losing the whole cache.** There is now a memory guard that behaves like Redis' `maxmemory` with `noeviction`: above `--max-memory-percent` (default 80%) of the heap limit, commands that grow memory get `-OOM command not allowed when used memory > 'maxmemory'.`, and inside `MULTI` every queued command does, as in Redis 7.0. Reads, deletes and flushes keep working, and writes resume once memory is freed. The README explains how to size the heap with `--max-old-space-size`.
- **HTTP silently corrupted integers above 2^53** (JSON parsing rounds them). A request containing such a number is now refused with a 400 that says to send it as a string.
- **`LTRIM` rebuilt the whole list,** so the "read a batch, trim it off" queue pattern was O(n) per batch. It now costs O(removed elements), like Redis.
- **`APPEND` copied the whole value every time,** so building a value with many appends was quadratic. Values that grow past 4 KB through `APPEND` now use a growable buffer, and `GETRANGE`/`STRLEN` read it without copying.
- Smaller Redis differences, now matching byte for byte:
  - RESP lengths with leading zeros or `-0` (`*01`, `$04`, `*-0`) are protocol errors, as in Redis.
  - Inline commands treat `\v` and `\f` like Redis' `sdssplitargs`: they don't separate arguments, except after a closing quote.
  - In RESP3, `INFO`, `CLIENT INFO` and `CLIENT LIST` are verbatim strings (`=…txt:`). `CLIENT INFO` has the Redis 7 fields (`flags`, `sub`, `psub`, `multi`, `user`, `redir`, `resp`, and `cmd=client|info`).
  - `CLIENT SETNAME a b` and other `CLIENT` subcommands with the wrong argument count give the `'client|setname'` arity error.
  - `SELECT`, `MOVE` and `SWAPDB` reject indexes outside 32 bits with Redis' messages.
  - `CONFIG GET` echoes an exact parameter name as given (`CONFIG GET DATABASES`); patterns return canonical names.
  - The HTTP `Host` check accepted any name containing `:`; it now only skips IPv6 literals.
- `--log-level debug` was accepted but logged nothing extra. It now logs every RESP connection, every command (RESP and HTTP) with a short form of its reply, and each HTTP request's status and time. Values are truncated and passwords masked.
- New `ARCHITECTURE.md` (how the code fits together, with a reading guide) and `SECURITY.md` (how to report vulnerabilities, the security model, known limitations and a deployment checklist). The README has a new Background section on how the project came about.
- Credit for ported Redis code: `NOTICE` now lists the functions ported from Redis 7.0 (BSD 3-Clause), the Redis license is included in `licenses/`, and the ported files say so in their headers.
- Left as documented differences: expire times beyond 2^53 ms are capped, and multi-million-key heaps see occasional V8 pauses of a few hundred ms.

Security hardening before the first release (after an independent review of the whole code base):

- **TLS:** RESP over TLS (`--tls-port`) and HTTPS (`--http-tls`), TLS 1.2 or newer. Certificates as PEM files or one PKCS#12 file (as exported from IBM i Digital Certificate Manager), with a passphrase file. Client certificates can be required (`--tls-ca-cert-file`, `--tls-auth-clients`). Plain RESP can be turned off (`--port off`). Tested with ioredis, node-redis and `redis-cli --tls`.
- **Protected mode** (`--protected-mode`, on by default), as in Redis: without a password, only clients on this machine are accepted, on RESP and HTTP.
- **The HTTP API binds to `127.0.0.1` by default**, whatever `--host` is. *This changes behaviour:* if you relied on `--host 0.0.0.0` exposing HTTP too, add `--http-host`.
- **Login protection:**
  - failed logins are counted per address over RESP and HTTP together; after `--auth-max-failures` (10) within a minute the address is blocked for a minute, and it's logged. Loopback is never blocked;
  - connections must authenticate within `--auth-timeout` (10 s);
  - an unauthenticated client can't make MIMIC hold more than 256 KB of its input (it could hold up to `--max-query-buffer`, 1 GB, before);
  - only a SHA-256 hash of the password is kept, and the password can be configured as `sha256:<hex>`; `mimic --hash-password` makes one;
  - the HTTP token must use the `Bearer` scheme (a bare token was accepted);
  - passwords with non-ASCII characters (such as `zażółć`) were always rejected, because the configured password was compared as text and the client's as bytes; both are now compared as UTF-8 bytes;
  - warnings for short passwords, readable password files and `--password` on the command line.
- **`--disable-commands`**, e.g. `FLUSHALL,FLUSHDB,KEYS`: disabled commands behave as unknown over RESP and HTTP, in `MULTI` and in `COMMAND` output.
- **Fixed:**
  - `CONFIG GET constructor` / `__proto__` reached `Object.prototype` and caused an internal error;
  - `CLIENT SETINFO` accepted newlines, which could forge lines in `CLIENT LIST`. It now only accepts printable characters, like `SETNAME` and Redis 7.2;
  - debug logs could be forged with control characters in a command name;
  - `/pipeline` could return internal error messages;
  - deeply nested JSON gave a 500 (now a 400);
  - numeric options are range-checked (an `--idle-timeout` beyond Node's timer limit, or a 0 ms cleanup budget, were accepted).
- **Fixed in a final pre-release review:**
  - a blocked address could keep guessing on connections it had opened before the block; now every AUTH from a blocked address is refused without checking the password, and the connection is closed;
  - connections that never finished the TLS handshake didn't count towards `--max-clients`, lived for 2 minutes and kept shutdown waiting; the handshake now has 10 s, and shutdown closes them;
  - with `--tls-auth-clients optional`, a client certificate the CA didn't sign was accepted; it's now refused (no certificate at all is still fine);
  - `RESET` after the login timer had run left the client logged out with no timer; `RESET` now restarts it;
  - failed logins over IPv4 and IPv4-mapped IPv6 (`::ffff:…`) counted as different addresses;
  - the failed-login table could get slow when full of blocked addresses; it now has a hard cap;
  - `/health` answered 429 for a blocked address; health checks now always work;
  - a malformed request URL gave a 500 and an error log entry; it's now a 400;
  - the HTTP API's `INFO` and `CONFIG GET` showed different values from RESP (e.g. `timeout`, `proto-max-bulk-len`);
  - closing one of two daemons in the same process stopped the expiry timer for the other; the timer now runs until the last one closes, and differing store settings are reported;
  - debug logs could show a password from `HELLO … SETNAME AUTH AUTH user pass`;
  - small things: `--port 0 --tls-port 0` was rejected, `--log-level DEBUG` wasn't accepted, and `--hash-password`, `--help` and `--version` failed when the environment held incomplete server settings.
- **Also:**
  - HTTP replies carry `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`;
  - HTTP has header and request timeouts and a connection cap;
  - a `security:` summary line and risk warnings at startup, including when running as root/QSECOFR;
  - the README recommends a Node.js release that still gets security updates.

## 0.1.0

- First draft: an HTTP/JSON API, a singleton store, and lazy plus active TTL expiry.
