# MIMIC

**MIMIC Is Merely an In-memory Cache.** MIMIC is a small, Redis-compatible, in-memory cache server written in pure Node.js. It's a recursive acronym in the GNU / WINE tradition, and a nod to all good TTRPG adventures. It is not what it looks like it is.

Redis is great, but you can't always install it. **IBM i (PASE)** is the classic example: Node.js runs there, but Redis doesn't. MIMIC fills that gap. It speaks the Redis protocol, so existing Redis clients just connect to it, and it needs nothing beyond Node.js 18 or newer.

**IMPORTANT NOTE** MIMIC does **NOT** replace Redis and is a far cry of functionality behind the actual Redis. It is merely a substitute for simple use cases where Redis itself can't be installed.

- **Drop-in for caching.** Standard Redis clients connect unchanged, over RESP2 or RESP3. Tested with redis-cli, ioredis, node-redis and redis-py.
- **Checked against real Redis.** The test suite sends the same commands to MIMIC and to `redis-server` 7.0 and requires byte-identical replies. That covers more than 500 hand-picked cases, including errors and edge cases, plus a seeded random stream of 4,000 commands over RESP2 and again over RESP3, and 1,500 random glob patterns.
- **Zero runtime dependencies.** One `node dist/cli.js` process. No native modules, nothing to compile on the target machine.
- **TTL expiry works like Redis.** Expired keys are removed when you read them (lazy expiry) and by a background cycle with a time budget (active expiry).
- **A real `SCAN`.** It uses a stateless cursor with Redis' guarantee: every key that exists for the whole scan is returned.
- **`MULTI`/`EXEC` and `WATCH`** for atomic updates and optimistic locking, and **16 databases** (`SELECT`, `MOVE`, `SWAPDB`).
- **An HTTP/JSON API as well**, for callers that have no Redis client, such as RPG or SQL on IBM i (through the `QSYS2.HTTP_*` functions), shell scripts or health checks.
- **Memory only, on purpose.** Redis writes snapshots to disk by default. MIMIC never persists anything: a restart gives you an empty cache. It really is *merely* an in-memory cache.

> Status: pre-release (0.2.0). It isn't on npm yet; it will be published as `mimicache` (the name `mimic` is taken). See [Install](#install).

---

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [Running on IBM i](#running-on-ibm-i)
- [Connecting from your code](#connecting-from-your-code)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Supported commands](#supported-commands)
- [Differences from Redis](#differences-from-redis)
- [How it works](#how-it-works)
- [Embedding as a library](#embedding-as-a-library)
- [Development](#development)
- [Security](#security)
- [Roadmap](#roadmap)
- [License](#license)

## Quick start

```bash
git clone <this repository> mimic && cd mimic
npm install
npm run build
npm start          # RESP on 127.0.0.1:6379, HTTP on 127.0.0.1:6380
```

```bash
redis-cli SET greeting "hello" EX 60
redis-cli GET greeting
redis-cli TTL greeting
curl -s localhost:6380/command -H 'content-type: application/json' -d '["GET","greeting"]'   # {"result":"hello"}
```

## Install

Until the package is on npm, build from source (see Quick start) and copy the folder wherever you need it. The build output in `dist/` is plain JavaScript, so you can build on your PC and copy `dist/`, `package.json` and `LICENSE` to the server. Nothing else is needed at runtime.

TypeScript is pinned to 6.x on purpose. TypeScript 7's native compiler ships per-platform binaries and may not install on IBM i, while 6.x is plain JavaScript that runs anywhere Node runs, so `npm run build` works on IBM i too. The code also compiles cleanly with TypeScript 7.

## Running on IBM i

1. **Install Node.js** (open-source RPMs, via ACS or `yum`). Pick a supported LTS release:

   ```sh
   yum install nodejs20        # or a newer LTS if your system offers it
   ```

2. **Put MIMIC in the IFS**, e.g. `/home/MYUSER/mimic` (clone and build it there, or copy a build from your PC).

3. **Start it.** The simplest way is with [Service Commander](https://github.com/ThePrez/ServiceCommander-IBMi). Copy [`examples/ibmi/mimic.yaml`](examples/ibmi/mimic.yaml) to `~/.sc/services/`, adjust `dir`, and then:

   ```sh
   sc start mimic
   sc check mimic
   ```

   Or submit it yourself. Node needs a multithread-capable job:

   ```
   SBMJOB CMD(QSH CMD('/QOpenSys/pkgs/bin/node /home/MYUSER/mimic/dist/cli.js')) +
          JOB(MIMIC) JOBQ(QSYSNOMAX) ALWMLTTHD(*YES)
   ```

   (If QSH complains about threads, add `ADDENVVAR ENVVAR(QIBM_MULTI_THREADED) VALUE('Y')` first.)

4. **Use it** from Node.js, Python or PHP with their usual Redis clients. From RPG, COBOL or SQL, use the HTTP API with the QSYS2 HTTP functions; see [`examples/ibmi/http-functions.sql`](examples/ibmi/http-functions.sql).

Tips:

- Keep the default `127.0.0.1` bind if only jobs on the same partition use the cache. If other LPARs or PCs need it, set `MIMIC_HOST=0.0.0.0` **and** a password.
- Several applications can share one MIMIC without key clashes by each using its own database: `db: 2` in the client, `SELECT 2`, or `?db=2` over HTTP.
- Log lines go to stdout/stderr with ISO timestamps. Service Commander keeps them in its log file.
- `SIGTERM` or `SIGINT` (for example `sc stop`) shuts down cleanly.

## Connecting from your code

Anything that speaks Redis works. Some examples:

**Node.js (ioredis)**

```js
import { Redis } from 'ioredis';
const cache = new Redis({ host: '127.0.0.1', port: 6379 /*, password: '...' */ });
await cache.set('customer:1001', JSON.stringify(customer), 'EX', 300);
const hit = await cache.get('customer:1001');
```

**Node.js (node-redis)**

```js
import { createClient } from 'redis';
const cache = await createClient({ url: 'redis://127.0.0.1:6379' }).connect();
await cache.set('customer:1001', JSON.stringify(customer), { EX: 300 });
```

**Python (redis-py)**

```python
import redis
cache = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)
cache.set("customer:1001", payload, ex=300)
```

**PHP (Predis, pure PHP, no extension needed)**

```php
$cache = new Predis\Client(['host' => '127.0.0.1', 'port' => 6379]);
$cache->set('customer:1001', $payload, 'EX', 300);
```

**Plain TCP** (telnet, `nc`): MIMIC also accepts inline commands such as `SET k v`.

## Configuration

Every option can be set as an environment variable or a command-line flag. Flags win, and that includes the password: `--password-file` beats `MIMIC_PASSWORD`.

An empty password is a startup error, whether it comes from `--password=`, an `MIMIC_PASSWORD` that is set but empty, or an empty password file. Giving both a password and a password file at the same level is also an error. A failed provisioning step should stop the server, not quietly run it without authentication.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--host` | `MIMIC_HOST` | `127.0.0.1` | RESP bind address |
| `--port` | `MIMIC_PORT` | `6379` | RESP port |
| `--http-host` | `MIMIC_HTTP_HOST` | same as host | HTTP bind address |
| `--http-port` | `MIMIC_HTTP_PORT` | `6380` | HTTP port, `off` to disable |
| `--password` | `MIMIC_PASSWORD` | unset | Requires `AUTH` (RESP) and `Authorization: Bearer` (HTTP) |
| `--password-file` | `MIMIC_PASSWORD_FILE` | unset | Read the password from a file |
| `--max-clients` | `MIMIC_MAX_CLIENTS` | `10000` | Max concurrent RESP connections |
| `--databases` | `MIMIC_DATABASES` | `16` | Number of databases (`SELECT 0` … `N-1`) |
| `--idle-timeout` | `MIMIC_IDLE_TIMEOUT` | `0` | Close idle RESP clients after N seconds (0 = never) |
| `--max-bulk-bytes` | `MIMIC_MAX_BULK_BYTES` | 64 MB | Largest single value accepted over RESP |
| `--max-query-buffer` | `MIMIC_MAX_QUERY_BUFFER` | 1 GB | Max input a RESP client can make MIMIC hold (unparsed data, a command still arriving and queued `MULTI` commands). Redis: `client-query-buffer-limit` |
| `--http-body-limit` | `MIMIC_HTTP_BODY_LIMIT` | 1 MB | Largest HTTP request body (larger gets a 413) |
| `--http-allowed-origins` | `MIMIC_HTTP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the HTTP API |
| `--http-allowed-hosts` | `MIMIC_HTTP_ALLOWED_HOSTS` | none | Extra `Host` names the HTTP API accepts when no password is set |
| `--cleanup-interval` | `MIMIC_CLEANUP_INTERVAL_MS` | `100` | How often active expiry runs, in ms |
| `--cleanup-sample-size` | `MIMIC_CLEANUP_SAMPLE_SIZE` | `20` | Keys checked per expiry batch |
| `--cleanup-time-budget` | `MIMIC_CLEANUP_TIME_BUDGET_MS` | `5` | Max ms per expiry cycle |
| `--log-level` | `MIMIC_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug` |

`mimic --help` prints the same list.

## HTTP API

The HTTP API sends and receives JSON. JSON strings are UTF-8 text, and MIMIC stores them as their UTF-8 bytes, exactly as a Redis client would.

- **Request bodies must be sent with `Content-Type: application/json`.** Anything else gets a 415. This blocks web pages from writing to the cache; see [Security](#security).
- **Every route except `/health` accepts `?db=N`** to choose the database (default 0).
- **Integer replies are always JSON numbers,** written with full 64-bit precision (for example `{"result":9223372036854775807}`). Plain `JSON.parse` in JavaScript rounds values above 2^53, so use a BigInt-aware parser if you work with counters that large. In requests, send big numbers as strings: `["INCRBY","k","9007199254740993"]`.

| Route | Body | Result |
|---|---|---|
| `GET /health` | | `{"status":"ok"}` (no auth) |
| `GET /info` | | Store and server statistics |
| `POST /command` | `["SET","k","v","EX",60]` or `{"command":"SET","args":["k","v"]}` | `{"result": ...}`; errors are 400 `{"error": ...}` |
| `POST /pipeline` | `[["INCR","a"],["GET","a"]]` | `{"results":[{"result":1},{"result":"1"}]}`. The batch runs without interruption, so it is atomic. |
| `GET /keys?pattern=user:*` | | `{"keys":[...]}` (KEYS, O(N)) |
| `GET /keys?cursor=0&pattern=user:*&count=100` | | `{"cursor":"…","keys":[...]}` (SCAN) |
| `GET /keys/:key` | | `{"key","type","value","ttlMs"}`, or 404. The key is taken from the raw path (URL-decoded), so keys containing `/`, `..` or `\` work too. |
| `PUT /keys/:key` | `{"value":…, "ttl":60 \| "px":500, "nx":true \| "xx":true}` | 200, or 409 if the NX/XX condition fails. Non-string values are stored as JSON text. |
| `DELETE /keys/:key` | | `{"deleted":0\|1}` |

## Supported commands

**Strings:** `SET` (`EX` `PX` `EXAT` `PXAT` `KEEPTTL` `NX` `XX` `GET`), `SETNX`, `SETEX`, `PSETEX`, `GET`, `GETDEL`, `GETEX`, `GETSET`, `GETRANGE`, `MGET`, `MSET`, `MSETNX`, `INCR`, `INCRBY`, `DECR`, `DECRBY`, `APPEND`, `STRLEN`

**Keys and TTL:** `DEL`, `UNLINK`, `EXISTS`, `TOUCH`, `TYPE`, `KEYS`, `SCAN` (`MATCH` `COUNT` `TYPE`), `RENAME`, `RENAMENX`, `EXPIRE`, `PEXPIRE`, `EXPIREAT`, `PEXPIREAT` (all with `NX` `XX` `GT` `LT`), `TTL`, `PTTL`, `EXPIRETIME`, `PEXPIRETIME`, `PERSIST`

**Hashes:** `HSET`, `HMSET`, `HSETNX`, `HGET`, `HMGET`, `HDEL`, `HGETALL`, `HEXISTS`, `HLEN`, `HKEYS`, `HVALS`, `HINCRBY`

**Lists:** `LPUSH`, `RPUSH`, `LPOP`, `RPOP` (with count), `LRANGE`, `LINDEX`, `LTRIM`, `LLEN`

**Transactions:** `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH`

**Databases:** `SELECT`, `MOVE`, `SWAPDB`, `DBSIZE`, `FLUSHDB`, `FLUSHALL`

**Connection and server:** `PING`, `ECHO`, `AUTH`, `HELLO` (2 and 3), `CLIENT` (`ID` `GETNAME` `SETNAME` `SETINFO` `INFO` `LIST`), `QUIT`, `RESET`, `INFO`, `TIME`, `COMMAND` (`COUNT` `INFO` `LIST` `DOCS`), `CONFIG GET`

Anything else gets the standard `ERR unknown command` reply, so client libraries fail clearly instead of hanging.

## Differences from Redis

For the commands MIMIC implements, replies and error messages match Redis 7.0 byte for byte. That includes the order in which arguments are checked, so the same bad command produces the same error. The compatibility suite checks this against a real `redis-server` (see [Development](#development)). Newer Redis releases have changed a few details; MIMIC follows 7.0, the version it reports to clients.

What is different:

- **No persistence, replication or cluster.** MIMIC is a cache, and a restart empties it.
- **No eviction yet.** Memory grows until keys expire or are deleted. Set TTLs on cached data.
- **Not implemented yet:** sets, sorted sets, streams, pub/sub, blocking commands (`BLPOP`…), Lua scripting, `CONFIG SET`, ACL users (a single password only). They get the standard `ERR unknown command` reply.
- **RESP3:** replies use maps and `_` nulls. There are no push messages, because there's no pub/sub.
- **`SCAN` cursors** walk a 32-bit space; larger cursors are accepted and reduced to their low 32 bits.
- **Expire times beyond 2^53 ms** (around the year 287,000) are capped. Redis would store them exactly.
- **Over the query-buffer limit,** MIMIC sends an error before closing the connection; Redis just closes it.
- **Malformed frames:** MIMIC is a little stricter than Redis. For example, a bulk string not followed by CRLF is a protocol error, where Redis skips two bytes. Well-formed clients never notice.
- **Glob ranges with bytes ≥ 0x80** (such as `[a-\xff]`) compare bytes as unsigned. Redis on x86 compares them as signed `char`, so results can differ for such ranges; Redis on ARM agrees with MIMIC.
- **`INFO`** reports `redis_version:7.0.0` so client feature detection works, plus `mimic_version`. `avg_ttl` is always 0.

## How it works

**Expiry.** Each key's deadline is stored in a separate map (Redis does the same).

- *Lazy:* every read checks the deadline, and an expired key is deleted on the spot, so clients never see stale data.
- *Active:* every `cleanup-interval` ms, MIMIC checks `cleanup-sample-size` keys that have a TTL. If more than 25% of them had expired, it checks another batch, but it never spends more than `cleanup-time-budget` ms per cycle. A saved cursor lets each cycle continue where the last one stopped.

`INFO stats` shows lazy and active expirations separately.

**SCAN.** Keys live in a `Map` for O(1) lookups. A second, power-of-two bucket table exists only for SCAN. The cursor walks the buckets in *reverse-binary* order, which is Redis' `dictScan` trick. Because of that ordering, a full scan still returns every key that existed for its whole duration, even if the table doubled or halved between calls. As in Redis, a key can occasionally be returned twice.

When the bucket table needs to grow or shrink, it is rehashed *incrementally*, as Redis does it. A second table is allocated, and a few buckets move over with every write, plus 1 ms per background tick. No single command pays for rehashing millions of keys; during a rehash, SCAN walks both tables.

On very large keyspaces, two V8 behaviours still cause occasional pauses: the JavaScript `Map` copies itself when it doubles in size (about 170 ms at 2M keys), and the garbage collector runs a full mark-compact (a similar order of magnitude on a heap of that size). Sharding the `Map` would spread the first out, but it costs a hash on every lookup, so MIMIC doesn't.

**WATCH.** The data layer reports every real modification: a write, a delete, an expiry or a TTL change. It does not report no-ops such as a `SETNX` that fails. This is Redis' `signalModifiedKey`. WATCH listens to those reports, so it sees changes made over RESP, over HTTP, by expiry or by code that embeds MIMIC. A watched key that expires before `EXEC` aborts the transaction, as in Redis 6.0.9 and later.

**Atomicity.** Node.js runs one piece of JavaScript at a time, and MIMIC never awaits inside a command. So every command, every `MULTI`/`EXEC` block and every HTTP `/pipeline` runs without interruption.

**Binary safety.** Keys and values are stored as byte strings, one char per byte, which makes them compact in V8. Anything a Redis client can send round-trips exactly, and `STRLEN` counts bytes.

## Embedding as a library

```ts
import { Store, startDaemon, loadConfig } from 'mimicache';

// Use the store directly in-process (it's a singleton, and it is database 0)...
const store = Store.getInstance().start();
store.set('k', 'v', { ex: 60 });
store.db(3).set('other', 'v'); // ...the other databases are store.db(1..15)

// ...or run the servers inside your own app.
const { config } = loadConfig([], process.env);
const daemon = await startDaemon({ ...config, port: 6379, httpPort: null });
```

## Development

```bash
npm install
npm run build          # tsc -> dist/
npm test               # unit + integration tests (node:test)
npm run test:compat    # ioredis, node-redis, redis-cli, and a byte-for-byte comparison with redis-server
npm run typecheck
```

`npm run test:compat` includes `test/compat.redis-diff.test.ts`. It starts a real `redis-server` on a random port (the test is skipped if `redis-server` isn't installed) and sends both servers the same commands: hand-picked cases, plus a seeded random stream over RESP2 and RESP3. Every reply must match exactly. To replay a random run, set `FUZZ_SEED=<number>`.

The compatibility tests use the current ioredis and node-redis releases, which need Node 20 or newer. The server itself, and the regular tests, run on Node 18 and newer.

```
src/
  store.ts        Store singleton (databases, timer) and Database (data, TTL, lazy + active expiry)
  keyspace.ts     Map + incrementally rehashed bucket table for SCAN
  deque.ts        ring buffer for lists
  commands.ts     command table (arity, flags, key specs) and dispatcher
  resp/           RESP parser, encoder, TCP server (auth, transactions, WATCH)
  http/           HTTP/JSON API
  config.ts       env vars + CLI flags
  daemon.ts       wires everything together; cli.ts is the `mimic` binary
```

## Security

- By default MIMIC binds to `127.0.0.1` and requires no password. If it listens on anything else without a password, it logs a warning.
- **Web pages can't use your cache.** A page open in a browser on the same machine could otherwise reach `localhost`. MIMIC blocks that in three ways:
  - **HTTP API:** request bodies must be `application/json`, which browsers can't send cross-origin without a CORS preflight, and MIMIC never grants one. Requests carrying an `Origin` header are refused (403) unless the origin is listed in `--http-allowed-origins`.
  - **Browser GETs:** a cross-site request marked `Sec-Fetch-Site` is refused, including an `<img src="http://127.0.0.1:6380/keys">` tag. Very old browsers that don't send that header (Safari before 16.4) can still make MIMIC run a `GET` route. They can't read the result, and patterns can't hang the server, but if such browsers on the same machine might visit untrusted sites, set a password.
  - **DNS rebinding:** without a password, the `Host` header must be an IP address, `localhost` or a name in `--http-allowed-hosts`.
  - **RESP port:** as in Redis, a `POST` or `Host:` line closes the connection silently, before any command in that request runs.
- **Before `AUTH`, clients get Redis' small limits:** at most 10 arguments, and 16 KB per argument. After AUTH the normal limits apply. Each client's input is also capped by `--max-query-buffer`.
- A client dropping its connection at any point, even while being turned away at `--max-clients`, can't crash the server. Connections MIMIC closes are fully released, even if the other side never closes its end. A slow reader still gets everything that was sent before the close.
- **Replies are streamed with backpressure.** A pipeline whose replies add up to more than V8's maximum string length (about 512 MB) is sent in 64 KB pieces. While a client isn't reading, MIMIC stops running its commands.
- **`KEYS`/`SCAN` patterns can't hang the server.** Matching is a port of Redis' `stringmatchlen()`, including the CVE-2022-36021 protections, and uses no regular expressions. Oversized numeric arguments are rejected before any big-number parsing.
- Passwords are compared in constant time. Prefer `MIMIC_PASSWORD_FILE` over `--password`, because command lines are visible to other users. An empty password, from any source, stops startup.
- There is no TLS. If traffic crosses a network you don't trust, tunnel it (for example with SSH), or keep MIMIC on the same host as its clients.

## Roadmap

- `maxmemory` with LRU/LFU eviction
- Sets and sorted sets, `HSCAN`
- Pub/Sub and keyspace notifications
- Prometheus `/metrics`

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

MIMIC is an independent implementation of the Redis protocol and contains no Redis source code. Redis is a registered trademark of Redis Ltd. Any rights therein are reserved to Redis Ltd. MIMIC is not affiliated with, sponsored by or endorsed by Redis Ltd.
