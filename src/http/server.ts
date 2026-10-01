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

import http from 'node:http';
import { fromText, toText } from '../bytes.js';
import { execute, type InfoSections } from '../commands.js';
import { MapReply, NullArray, ReplyError, SimpleString, type Reply } from '../reply.js';
import type { Logger } from '../resp/server.js';
import type { Database, Store } from '../store.js';
import { safeEqual } from '../util.js';

export interface HttpServerOptions {
  /** Require "Authorization: Bearer <token>" on every route except /health. */
  authToken?: string;
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

export function createHttpServer(store: Store, opts: HttpServerOptions = {}): http.Server {
  const limit = opts.bodyLimitBytes ?? 1024 * 1024;
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
    if (!opts.authToken) {
      const name = hostName(req.headers.host ?? '');
      const ok = name === '' || name === 'localhost' || name.endsWith('.localhost') || IPV4.test(name) || name.includes(':') || allowedHosts.has(name);
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
      return { result: toJson(execute({ store, db, serverInfo }, argv)) };
    } catch (err) {
      if (err instanceof ReplyError) return { error: err.message };
      throw err;
    }
  }

  function authorised(req: http.IncomingMessage): boolean {
    if (!opts.authToken) return true;
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    return safeEqual(fromText(token), fromText(opts.authToken));
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';

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
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });
      return send(res, 200, { results });
    }

    if (method === 'GET' && pathname === '/keys') {
      const pattern = url.searchParams.get('pattern') ?? '*';
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) return send(res, 200, { keys: toJson(db.keys(fromText(pattern))) });
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
      if (method === 'DELETE') return send(res, 200, { deleted: db.del([key]) });
    }

    throw new HttpError(404, `no route for ${method} ${pathname}`);
  }

  return http.createServer((req, res) => {
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
  });
}
