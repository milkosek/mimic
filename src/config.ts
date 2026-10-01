// SPDX-License-Identifier: Apache-2.0
//
// Configuration: defaults < environment (MIMIC_*) < command-line flags.
// The same order applies to the password and the password file.

import { readFileSync } from 'node:fs';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface MimicConfig {
  /** RESP (Redis protocol) listener. */
  host: string;
  port: number;
  /** HTTP/JSON listener; null port = disabled. */
  httpHost: string;
  httpPort: number | null;
  /** Shared secret: RESP `AUTH <password>` and HTTP `Authorization: Bearer <password>`. */
  password?: string;
  maxClients: number;
  /** Number of databases (SELECT 0..N-1). */
  databases: number;
  idleTimeoutSec: number;
  maxBulkBytes: number;
  /** Max unparsed input buffered per RESP client (Redis: client-query-buffer-limit). */
  maxQueryBufferBytes: number;
  httpBodyLimitBytes: number;
  /** Browser origins allowed to call the HTTP API (none by default). */
  httpAllowedOrigins: string[];
  /** Extra Host header names the HTTP API accepts when no password is set. */
  httpAllowedHosts: string[];
  cleanupIntervalMs: number;
  cleanupSampleSize: number;
  cleanupTimeBudgetMs: number;
  /** Refuse memory-growing writes (-OOM) above this % of the V8 heap limit; 0 = off. */
  maxMemoryPercent: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

interface OptionDef {
  key: keyof MimicConfig | 'passwordFile';
  flag: string;
  env: string;
  kind: 'string' | 'int' | 'port' | 'optionalPort' | 'level' | 'list';
  help: string;
}

export const OPTIONS: OptionDef[] = [
  { key: 'host', flag: 'host', env: 'MIMIC_HOST', kind: 'string', help: 'RESP bind address (default 127.0.0.1)' },
  { key: 'port', flag: 'port', env: 'MIMIC_PORT', kind: 'port', help: 'RESP port (default 6379)' },
  { key: 'httpHost', flag: 'http-host', env: 'MIMIC_HTTP_HOST', kind: 'string', help: 'HTTP bind address (default: same as --host)' },
  { key: 'httpPort', flag: 'http-port', env: 'MIMIC_HTTP_PORT', kind: 'optionalPort', help: 'HTTP port, or "off" (default 6380)' },
  { key: 'password', flag: 'password', env: 'MIMIC_PASSWORD', kind: 'string', help: 'require AUTH / Bearer token (prefer the env var or --password-file)' },
  { key: 'passwordFile', flag: 'password-file', env: 'MIMIC_PASSWORD_FILE', kind: 'string', help: 'read the password from a file' },
  { key: 'maxClients', flag: 'max-clients', env: 'MIMIC_MAX_CLIENTS', kind: 'int', help: 'max concurrent RESP clients (default 10000)' },
  { key: 'databases', flag: 'databases', env: 'MIMIC_DATABASES', kind: 'int', help: 'number of databases for SELECT (default 16)' },
  { key: 'idleTimeoutSec', flag: 'idle-timeout', env: 'MIMIC_IDLE_TIMEOUT', kind: 'int', help: 'close idle RESP clients after N seconds, 0 = never (default 0)' },
  { key: 'maxBulkBytes', flag: 'max-bulk-bytes', env: 'MIMIC_MAX_BULK_BYTES', kind: 'int', help: 'max size of one value over RESP (default 67108864 = 64 MB)' },
  { key: 'maxQueryBufferBytes', flag: 'max-query-buffer', env: 'MIMIC_MAX_QUERY_BUFFER', kind: 'int', help: 'max unparsed input per RESP client (default 1073741824 = 1 GB)' },
  { key: 'httpBodyLimitBytes', flag: 'http-body-limit', env: 'MIMIC_HTTP_BODY_LIMIT', kind: 'int', help: 'max HTTP request body (default 1048576 = 1 MB)' },
  { key: 'httpAllowedOrigins', flag: 'http-allowed-origins', env: 'MIMIC_HTTP_ALLOWED_ORIGINS', kind: 'list', help: 'comma-separated browser origins allowed to use the HTTP API (default: none)' },
  { key: 'httpAllowedHosts', flag: 'http-allowed-hosts', env: 'MIMIC_HTTP_ALLOWED_HOSTS', kind: 'list', help: 'extra Host names accepted without a password (IPs and localhost always are)' },
  { key: 'cleanupIntervalMs', flag: 'cleanup-interval', env: 'MIMIC_CLEANUP_INTERVAL_MS', kind: 'int', help: 'active expiry interval in ms (default 100)' },
  { key: 'cleanupSampleSize', flag: 'cleanup-sample-size', env: 'MIMIC_CLEANUP_SAMPLE_SIZE', kind: 'int', help: 'keys checked per expiry batch (default 20)' },
  { key: 'cleanupTimeBudgetMs', flag: 'cleanup-time-budget', env: 'MIMIC_CLEANUP_TIME_BUDGET_MS', kind: 'int', help: 'max ms per expiry cycle (default 5)' },
  { key: 'maxMemoryPercent', flag: 'max-memory-percent', env: 'MIMIC_MAX_MEMORY_PERCENT', kind: 'int', help: 'refuse growing writes with -OOM above this % of the V8 heap limit, 0 = off (default 80)' },
  { key: 'logLevel', flag: 'log-level', env: 'MIMIC_LOG_LEVEL', kind: 'level', help: 'silent|error|warn|info|debug (default info)' },
];

const LEVELS: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

function convert(def: OptionDef, raw: string, source: string): unknown {
  const bad = (why: string): never => {
    throw new ConfigError(`invalid value for ${source}: "${raw}" (${why})`);
  };
  switch (def.kind) {
    case 'string':
      return raw;
    case 'int': {
      if (!/^\d+$/.test(raw)) bad('expected a non-negative integer');
      return Number(raw);
    }
    case 'port':
    case 'optionalPort': {
      if (def.kind === 'optionalPort' && /^(off|false|no|disabled?)$/i.test(raw)) return null;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n > 65535) bad('expected a port number 0-65535');
      return n;
    }
    case 'level':
      if (!LEVELS.includes(raw as LogLevel)) bad(`expected one of ${LEVELS.join(', ')}`);
      return raw;
    case 'list':
      return raw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
  }
}

const PASSWORD_KEYS = new Set(['password', 'passwordFile']);

/**
 * The password comes from the highest-priority source that sets one
 * (flags > environment). Within a source, a password and a password file
 * are mutually exclusive. An empty password - including an empty file or an
 * env var that is set but empty - is an error: silently starting without
 * authentication is never what a failed provisioning step wants.
 */
function resolvePassword(sources: [string, Record<string, unknown>][]): string | undefined {
  for (const [where, values] of sources) {
    const password = values['password'] as string | undefined;
    const file = values['passwordFile'] as string | undefined;
    if (password !== undefined && file !== undefined) {
      throw new ConfigError(`both a password and a password file are set in the ${where}; use one of them`);
    }
    if (password !== undefined) {
      if (password === '') throw new ConfigError(`the password set in the ${where} is empty`);
      return password;
    }
    if (file !== undefined) {
      if (file === '') throw new ConfigError(`the password file path set in the ${where} is empty`);
      let content: string;
      try {
        content = readFileSync(file, 'utf8').trim();
      } catch (err) {
        throw new ConfigError(`cannot read password file ${file}: ${(err as Error).message}`);
      }
      if (content === '') throw new ConfigError(`password file ${file} is empty`);
      return content;
    }
  }
  return undefined;
}

export interface ParsedArgs {
  config: MimicConfig;
  help: boolean;
  version: boolean;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const envValues: Record<string, unknown> = {};
  const flagValues: Record<string, unknown> = {};

  for (const def of OPTIONS) {
    const raw = env[def.env];
    if (raw === undefined) continue;
    // An empty env var means "unset", except for the password: set-but-empty is an error there.
    if (raw === '' && !PASSWORD_KEYS.has(def.key)) continue;
    envValues[def.key] = convert(def, raw, def.env);
  }

  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    const def = m && OPTIONS.find((o) => o.flag === m[1]);
    if (!m || !def) throw new ConfigError(`unknown option: ${arg} (see --help)`);
    const raw = m[2] ?? argv[++i];
    if (raw === undefined) throw new ConfigError(`missing value for --${def.flag}`);
    flagValues[def.key] = convert(def, raw, `--${def.flag}`);
  }

  const values: Record<string, unknown> = { ...envValues, ...flagValues };
  const password = resolvePassword([
    ['command-line flags', flagValues],
    ['environment', envValues],
  ]);

  const host = (values['host'] as string | undefined) ?? '127.0.0.1';
  const config: MimicConfig = {
    host,
    port: (values['port'] as number | undefined) ?? 6379,
    httpHost: (values['httpHost'] as string | undefined) ?? host,
    httpPort: values['httpPort'] === undefined ? 6380 : (values['httpPort'] as number | null),
    maxClients: (values['maxClients'] as number | undefined) ?? 10_000,
    databases: (values['databases'] as number | undefined) ?? 16,
    idleTimeoutSec: (values['idleTimeoutSec'] as number | undefined) ?? 0,
    maxBulkBytes: (values['maxBulkBytes'] as number | undefined) ?? 64 * 1024 * 1024,
    maxQueryBufferBytes: (values['maxQueryBufferBytes'] as number | undefined) ?? 1024 * 1024 * 1024,
    httpBodyLimitBytes: (values['httpBodyLimitBytes'] as number | undefined) ?? 1024 * 1024,
    httpAllowedOrigins: (values['httpAllowedOrigins'] as string[] | undefined) ?? [],
    httpAllowedHosts: (values['httpAllowedHosts'] as string[] | undefined) ?? [],
    cleanupIntervalMs: Math.max((values['cleanupIntervalMs'] as number | undefined) ?? 100, 1),
    cleanupSampleSize: Math.max((values['cleanupSampleSize'] as number | undefined) ?? 20, 1),
    cleanupTimeBudgetMs: (values['cleanupTimeBudgetMs'] as number | undefined) ?? 5,
    maxMemoryPercent: Math.min((values['maxMemoryPercent'] as number | undefined) ?? 80, 100),
    logLevel: (values['logLevel'] as LogLevel | undefined) ?? 'info',
  };
  if (config.databases < 1) throw new ConfigError('databases must be at least 1');
  if (password !== undefined) config.password = password;
  return { config, help, version };
}

export function helpText(): string {
  const width = Math.max(...OPTIONS.map((o) => o.flag.length)) + 4;
  const lines = OPTIONS.map((o) => `  --${o.flag.padEnd(width)}${o.env.padEnd(30)}${o.help}`);
  return [
    'MIMIC Is Merely an In-memory Cache - a Redis-compatible cache server',
    '',
    'Usage: mimic [options]',
    '',
    `  ${'flag'.padEnd(width + 2)}${'environment variable'.padEnd(30)}description`,
    ...lines,
    '  -h, --help',
    '  -v, --version',
    '',
  ].join('\n');
}
