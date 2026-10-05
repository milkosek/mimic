// SPDX-License-Identifier: Apache-2.0
//
// HTTP/JSON API. Handy where no Redis client exists - e.g. RPG or SQL on
// IBM i via the QSYS2.HTTP_* functions, shell scripts, health checks.
//
//   Every route except /health accepts ?db=N (database number, default 0).
//
//   GET    /health                                liveness probe (no auth)
//   GET    /info                                  store + server stats
//   POST   /command     ["SET","k","v","EX",60]   or {"command":"SET","args":[...]}
//   POST   /pipeline    [["INCR","a"],["GET","a"]]
//   GET    /keys?pattern=user:*                   KEYS (O(N))
//   GET    /keys?cursor=0&pattern=user:*&count=100  SCAN (use this on big keyspaces)
//   GET    /keys/:key                             {key,type,value,ttlMs}
//   PUT    /keys/:key   {"value":..., "ttl":60 | "px":500, "nx":true | "xx":true}
//   DELETE /keys/:key                             {deleted: 0|1}
//
// JSON strings are UTF-8 text; they are stored as their UTF-8 bytes, exactly
// what a Redis client would store for the same text. Integer replies are
// always JSON numbers, written with full 64-bit precision.
//
// Browser protection (the API has no password by default on localhost):
//   * request bodies must be Content-Type: application/json - browsers cannot
//     send that cross-origin without a CORS preflight, which is never granted;
//   * requests carrying an Origin header are refused unless allow-listed;
//   * without a password, the Host header must be an IP address, "localhost"
//     or an allow-listed name, which defeats DNS rebinding.
//
// Network protection, shared with the RESP server: protected mode (no
// password -> loopback clients only), per-address blocking after repeated
// wrong tokens, optional HTTPS, and tight timeouts and connection limits.

import http from 'node:http';
import https from 'node:https';
import { isIPv6 } from 'node:net';
import type tls from 'node:tls';
import { AuthGuard, isLoopback, PasswordCheck } from '../auth.js';
import { fromText, toText } from '../bytes.js';
import { execute, type InfoSections } from '../commands.js';
import { describeCommand, describeReply } from '../debuglog.js';
import { MapReply, NullArray, ReplyError, SimpleString, VerbatimString, type Reply } from '../reply.js';
import type { Logger } from '../resp/server.js';
import type { Database, Store } from '../store.js';

export interface HttpServerOptions {
  /** Require "Authorization: Bearer <token>" on every route except /health. Plain, or "sha256:<hex>". */
  authToken?: string;
  /** Without a token, refuse clients that aren't on a loopback address (default true). */
  protectedMode?: boolean;
  /** Failed-login tracking, shared with the RESP server. */
  authGuard?: AuthGuard;
  /** Commands that behave as if they didn't exist (upper case). */
  disabledCommands?: ReadonlySet<string>;
  /** Serve HTTPS with these TLS settings. */
  tls?: tls.TlsOptions;
  /** Concurrent connections accepted (default 1000). */
  maxConnections?: number;
  bodyLimitBytes?: number;
  /** Origins (e.g. "https://intranet.example") allowed to call the API from a browser. */
  allowedOrigins?: string[];
  /** Extra Host names accepted when no password is set (IP addresses and localhost always are). */
  allowedHosts?: string[];
  logger?: Logger;
  extraInfo?: () => InfoSections;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

/** JSON.stringify, except that bigints are written as plain (exact) JSON numbers. */
function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof SimpleString)) {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function send(res: http.ServerResponse, status: number, body: unknown, extraHeaders: http.OutgoingHttpHeaders = {}): void {
  const payload = stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff', // never let a browser treat a reply as HTML or script
    'cache-control': 'no-store', // cached data must not end up in proxies or browser caches
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering, discard the rest of the body and answer 413
        // (destroying the socket here would turn the reply into a reset).
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, `payload too large (limit ${limit} bytes)`));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (size > limit) return;
      if (size === 0) return resolve(undefined);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
        return;
      }
      const problem = checkJson(parsed);
      if (problem === 'deep') {
        reject(new HttpError(400, `JSON is nested too deeply (more than ${MAX_JSON_DEPTH} levels)`));
        return;
      }
      const unsafe = problem;
      if (unsafe !== undefined) {
        reject(
          new HttpError(
            400,
            `the number ${unsafe} is too large to be read exactly from JSON (above 2^53); send it as a string, e.g. "${unsafe}" (Db2: VARCHAR instead of BIGINT)`,
          ),
        );
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

const MAX_JSON_DEPTH = 64;

/**
 * Two checks on a parsed body:
 *   * nesting deeper than MAX_JSON_DEPTH is refused ('deep'): turning such a
 *     value back into text (non-string arguments are stored as JSON) would
 *     overflow the stack;
 *   * JSON.parse silently rounds integers beyond 2^53 (1234567890123456789 ->
 *     1234567890123456800), so such a number can't be stored as sent: return
 *     it, so the request can be refused instead of corrupting the value. (The
 *     original digits are gone by now; the message shows the rounded value.)
 */
function checkJson(root: unknown): number | 'deep' | undefined {
  const stack: [unknown, number][] = [[root, 0]]; // iterative: no recursion on hostile input
  let unsafe: number | undefined;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v === 'number') {
      if (unsafe === undefined && Number.isInteger(v) && !Number.isSafeInteger(v)) unsafe = v;
    } else if (v !== null && typeof v === 'object') {
      if (depth >= MAX_JSON_DEPTH) return 'deep';
      for (const item of Array.isArray(v) ? v : Object.values(v)) stack.push([item, depth + 1]);
    }
  }
  return unsafe;
}

/** JSON value -> command argument (binary string). */
function toArg(v: unknown): string {
  if (typeof v === 'string') return fromText(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v === null || v === undefined) throw new HttpError(400, 'arguments must not be null');
  return fromText(JSON.stringify(v));
}

/** Reply -> JSON (binary strings decoded as UTF-8 text). */
function toJson(r: Reply): Json {
  if (r === null || typeof r === 'number') return r;
  if (typeof r === 'string') return toText(r);
  if (typeof r === 'bigint') return Number.isSafeInteger(Number(r)) ? Number(r) : r; // stays a JSON number
  if (r instanceof SimpleString) return r.value;
  if (r instanceof NullArray) return null;
  if (r instanceof VerbatimString) return toText(r.value);
  if (r instanceof Error) return { error: r.message };
  if (r instanceof MapReply) return Object.fromEntries(r.entries.map(([k, v]) => [String(toJson(k)), toJson(v)]));
  return r.map(toJson);
}

function parseCommand(body: unknown): string[] {
  let argv: unknown[];
  if (Array.isArray(body)) argv = body;
  else if (body && typeof body === 'object' && 'command' in body) {
    const { command, args = [] } = body as { command: unknown; args?: unknown };
    if (!Array.isArray(args)) throw new HttpError(400, "'args' must be an array");
    argv = [command, ...args];
  } else {
    throw new HttpError(400, 'expected ["CMD", ...args] or {"command": "CMD", "args": [...]}');
  }
  if (typeof argv[0] !== 'string' || argv[0] === '') throw new HttpError(400, 'command name must be a non-empty string');
  return argv.map(toArg);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Hostname part of a Host header ("[::1]:6380" -> "::1", "Example.:80" -> "example"). */
function hostName(header: string): string {
  let h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  return h.endsWith('.') ? h.slice(0, -1) : h; // "localhost." is "localhost"
}

const isJson = (contentType: string | undefined): boolean =>
  !!contentType && /^application\/json\s*(;|$)/i.test(contentType.trim());

export function createHttpServer(store: Store, opts: HttpServerOptions = {}): http.Server | https.Server {
  const limit = opts.bodyLimitBytes ?? 1024 * 1024;
  const token = opts.authToken ? new PasswordCheck(opts.authToken) : undefined; // only a hash is kept
  const protectedMode = (opts.protectedMode ?? true) && !token;
  const guard = opts.authGuard ?? new AuthGuard({ maxFailures: 10, warn: (m) => opts.logger?.warn(m) });
  const disabled = opts.disabledCommands;
  const isDisabled = (name: string): boolean => disabled?.has(name) ?? false;
  let lastDeniedWarning = 0;
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.trim().toLowerCase().replace(/\/$/, '')));
  const allowedHosts = new Set((opts.allowedHosts ?? []).map(hostName)); // so "cache.example.:6380" works too

  function checkBrowserSafety(req: http.IncomingMessage): void {
    const origin = req.headers.origin;
    const originAllowed = origin !== undefined && allowedOrigins.has(origin.toLowerCase());
    if (origin !== undefined && !originAllowed) {
      throw new HttpError(403, `cross-origin requests are not allowed (Origin: ${origin})`);
    }
    // Browsers mark every request a page makes, including no-cors GETs such as
    // <img src="http://127.0.0.1:6380/keys">, which carry no Origin header.
    // Server-side callers (curl, QSYS2.HTTP_*, ioredis...) never send this.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !originAllowed) {
      throw new HttpError(403, `cross-site browser requests are not allowed (Sec-Fetch-Site: ${site})`);
    }
    if (!token) {
      const name = hostName(req.headers.host ?? '');
      const ok = name === '' || name === 'localhost' || name.endsWith('.localhost') || IPV4.test(name) || isIPv6(name) || allowedHosts.has(name);
      if (!ok) {
        throw new HttpError(403, `Host "${req.headers.host}" is not allowed without a password; set a password or add it to --http-allowed-hosts`);
      }
    }
  }

  /** Read a JSON body, insisting on Content-Type: application/json. */
  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    if (!isJson(req.headers['content-type'])) {
      req.resume();
      throw new HttpError(415, 'request body must be sent with Content-Type: application/json');
    }
    return readJson(req, limit);
  }
  const serverInfo = (): InfoSections => opts.extraInfo?.() ?? {};

  // Command errors are client errors (like a Redis error reply), not 500s.
  function run(db: Database, argv: string[]): { result: Json } | { error: string } {
    try {
      const reply = execute({ store, db, serverInfo, ...(disabled ? { disabled } : {}) }, argv);
      opts.logger?.debug?.(`[http] db${db.index}: ${describeCommand(argv)} -> ${describeReply(reply)}`);
      return { result: toJson(reply) };
    } catch (err) {
      if (err instanceof ReplyError) {
        opts.logger?.debug?.(`[http] db${db.index}: ${describeCommand(argv)} -> ${describeReply(err)}`);
        return { error: err.message };
      }
      throw err;
    }
  }

  function authorised(req: http.IncomingMessage): boolean {
    if (!token) return true;
    const header = req.headers.authorization;
    if (header === undefined) return false; // no attempt made: not counted as a failure
    // Only the Bearer scheme. Node hands header values over as latin1, i.e.
    // one char per byte - the same form as AUTH arguments on the RESP port.
    const m = /^Bearer[ \t]+(.+)$/is.exec(header.trim());
    if (m && token.matches(m[1]!)) return true;
    guard.recordFailure(req.socket.remoteAddress, 'HTTP token');
    return false;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';

    const address = req.socket.remoteAddress;
    if (protectedMode && !isLoopback(address)) {
      if (Date.now() - lastDeniedWarning > 60_000) {
        lastDeniedWarning = Date.now();
        opts.logger?.warn(`[http] protected mode: refused a request from ${address} (no password is set; see --protected-mode)`);
      }
      throw new HttpError(403, 'protected mode: no password is set, so only requests from this machine are accepted');
    }
    if (guard.isBlocked(address)) {
      return send(res, 429, { error: 'too many failed authentication attempts from this address; try again later' }, { 'retry-after': String(guard.retryAfterSec(address)) });
    }
    if (method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok' });
    checkBrowserSafety(req);
    if (!authorised(req)) throw new HttpError(401, 'unauthorised');

    // ?db=N selects the database (like SELECT), default 0.
    const dbParam = url.searchParams.get('db') ?? '0';
    if (!/^\d+$/.test(dbParam) || Number(dbParam) >= store.databases) {
      throw new HttpError(400, `db must be a number from 0 to ${store.databases - 1}`);
    }
    const db = store.db(Number(dbParam));

    if (method === 'GET' && pathname === '/info') {
      if (isDisabled('INFO')) throw new HttpError(403, 'INFO is disabled on this server');
      return send(res, 200, { ...store.info(), server: serverInfo() });
    }

    if (method === 'POST' && pathname === '/command') {
      const out = run(db, parseCommand(await readBody(req)));
      return send(res, 'error' in out ? 400 : 200, out);
    }

    if (method === 'POST' && pathname === '/pipeline') {
      const body = await readBody(req);
      if (!Array.isArray(body)) throw new HttpError(400, 'pipeline body must be an array of commands');
      const results = body.map((cmd) => {
        try {
          return run(db, parseCommand(cmd));
        } catch (err) {
          if (err instanceof HttpError) return { error: err.message };
          opts.logger?.error('[http] pipeline command failed', err);
          return { error: 'internal error' }; // never internal details
        }
      });
      return send(res, 200, { results });
    }

    if (method === 'GET' && pathname === '/keys') {
      const pattern = url.searchParams.get('pattern') ?? '*';
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) {
        const out = run(db, ['KEYS', fromText(pattern)]); // through the command table, so --disable-commands applies
        return 'error' in out ? send(res, 400, out) : send(res, 200, { keys: out.result });
      }
      const argv = ['SCAN', cursor, 'MATCH', fromText(pattern), 'COUNT', url.searchParams.get('count') ?? '100'];
      const out = run(db, argv);
      if ('error' in out) return send(res, 400, out);
      const [next, keys] = out.result as [string, string[]];
      return send(res, 200, { cursor: next, keys });
    }

    // Take the key from the raw request path: URL parsing would resolve "..",
    // "." and "\\" segments and make such keys unreachable.
    const rawPath = (req.url ?? '/').split('?', 1)[0]!;
    const match = /^\/keys\/(.+)$/s.exec(rawPath);
    if (match) {
      const key = fromText(decodeURIComponent(match[1]!));
      if (method === 'GET') {
        if (isDisabled('GET')) throw new HttpError(403, 'GET is disabled on this server');
        const entry = db.inspect(key);
        if (!entry) return send(res, 404, { error: 'not found', key: toText(key) });
        let value: Json;
        if (entry.type === 'hash') {
          value = Object.fromEntries((entry.value as [string, string][]).map(([f, v]) => [toText(f), toText(v)]));
        } else if (entry.type === 'list') {
          value = (entry.value as string[]).map(toText);
        } else {
          value = toText(entry.value as string);
        }
        return send(res, 200, { key: toText(key), type: entry.type, value, ttlMs: entry.ttlMs });
      }
      if (method === 'PUT') {
        const parsed = await readBody(req);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('value' in parsed)) {
          throw new HttpError(400, 'body must be a JSON object like {"value": ...}');
        }
        const body = parsed as Record<string, unknown>;
        const argv = ['SET', key, toArg(body['value'])];
        if (body['ttl'] !== undefined) argv.push('EX', toArg(body['ttl']));
        if (body['px'] !== undefined) argv.push('PX', toArg(body['px']));
        if (body['nx']) argv.push('NX');
        if (body['xx']) argv.push('XX');
        const out = run(db, argv);
        if ('error' in out) return send(res, 400, out);
        if (out.result === null) return send(res, 409, { error: 'condition not met (NX/XX)', key: toText(key) });
        return send(res, 200, { ok: true, key: toText(key), ttlMs: db.pttl(key) });
      }
      if (method === 'DELETE') {
        const out = run(db, ['DEL', key]);
        return 'error' in out ? send(res, 400, out) : send(res, 200, { deleted: out.result });
      }
    }

    throw new HttpError(404, `no route for ${method} ${pathname}`);
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (opts.logger?.debug) {
      const debug = opts.logger.debug;
      const t0 = performance.now();
      res.on('finish', () => debug(`[http] ${req.method} ${req.url} ${res.statusCode} (${(performance.now() - t0).toFixed(1)} ms)`));
    }
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof URIError) return send(res, 400, { error: 'malformed URL encoding' });
      opts.logger?.error('[http] unhandled error', err);
      send(res, 500, { error: 'internal error' });
    });
  };
  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
  // Slow or idle clients can't hold connections for long, and there is a cap on how many.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = opts.maxConnections ?? 1000;
  return server;
}
