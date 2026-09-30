// SPDX-License-Identifier: Apache-2.0
//
// HTTP/JSON API. Handy where no Redis client exists - e.g. RPG or SQL on
// IBM i via the QSYS2.HTTP_* functions, shell scripts, health checks.
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
// what a Redis client would store for the same text.

import http from 'node:http';
import { fromText, toText } from '../bytes.js';
import { execute, type InfoSections } from '../commands.js';
import { MapReply, ReplyError, SimpleString, type Reply } from '../reply.js';
import type { Logger } from '../resp/server.js';
import type { Store } from '../store.js';
import { safeEqual } from '../util.js';

export interface HttpServerOptions {
  /** Require "Authorization: Bearer <token>" on every route except /health. */
  authToken?: string;
  bodyLimitBytes?: number;
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

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
  if (typeof r === 'bigint') return Number.isSafeInteger(Number(r)) ? Number(r) : r.toString();
  if (r instanceof SimpleString) return r.value;
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

export function createHttpServer(store: Store, opts: HttpServerOptions = {}): http.Server {
  const limit = opts.bodyLimitBytes ?? 1024 * 1024;
  const serverInfo = (): InfoSections => opts.extraInfo?.() ?? {};

  // Command errors are client errors (like a Redis error reply), not 500s.
  function run(argv: string[]): { result: Json } | { error: string } {
    try {
      return { result: toJson(execute({ store, serverInfo }, argv)) };
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
    if (!authorised(req)) throw new HttpError(401, 'unauthorised');

    if (method === 'GET' && pathname === '/info') {
      return send(res, 200, { ...store.info(), server: serverInfo() });
    }

    if (method === 'POST' && pathname === '/command') {
      const out = run(parseCommand(await readJson(req, limit)));
      return send(res, 'error' in out ? 400 : 200, out);
    }

    if (method === 'POST' && pathname === '/pipeline') {
      const body = await readJson(req, limit);
      if (!Array.isArray(body)) throw new HttpError(400, 'pipeline body must be an array of commands');
      const results = body.map((cmd) => {
        try {
          return run(parseCommand(cmd));
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });
      return send(res, 200, { results });
    }

    if (method === 'GET' && pathname === '/keys') {
      const pattern = url.searchParams.get('pattern') ?? '*';
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) return send(res, 200, { keys: toJson(store.keys(fromText(pattern))) });
      const argv = ['SCAN', cursor, 'MATCH', fromText(pattern), 'COUNT', url.searchParams.get('count') ?? '100'];
      const out = run(argv);
      if ('error' in out) return send(res, 400, out);
      const [next, keys] = out.result as [string, string[]];
      return send(res, 200, { cursor: next, keys });
    }

    const match = /^\/keys\/(.+)$/.exec(pathname);
    if (match) {
      const key = fromText(decodeURIComponent(match[1]!));
      if (method === 'GET') {
        const entry = store.inspect(key);
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
        const body = ((await readJson(req, limit)) ?? {}) as Record<string, unknown>;
        if (!('value' in body)) throw new HttpError(400, "body must contain 'value'");
        const argv = ['SET', key, toArg(body['value'])];
        if (body['ttl'] !== undefined) argv.push('EX', toArg(body['ttl']));
        if (body['px'] !== undefined) argv.push('PX', toArg(body['px']));
        if (body['nx']) argv.push('NX');
        if (body['xx']) argv.push('XX');
        const out = run(argv);
        if ('error' in out) return send(res, 400, out);
        if (out.result === null) return send(res, 409, { error: 'condition not met (NX/XX)', key: toText(key) });
        return send(res, 200, { ok: true, key: toText(key), ttlMs: store.pttl(key) });
      }
      if (method === 'DELETE') return send(res, 200, { deleted: store.del([key]) });
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
