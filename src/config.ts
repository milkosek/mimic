// SPDX-License-Identifier: Apache-2.0
//
// Configuration: defaults < environment (MIMIC_*) < command-line flags.

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
  idleTimeoutSec: number;
  maxBulkBytes: number;
  httpBodyLimitBytes: number;
  cleanupIntervalMs: number;
  cleanupSampleSize: number;
  cleanupTimeBudgetMs: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

interface OptionDef {
  key: keyof MimicConfig | 'passwordFile';
  flag: string;
  env: string;
  kind: 'string' | 'int' | 'port' | 'optionalPort' | 'level';
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
  { key: 'idleTimeoutSec', flag: 'idle-timeout', env: 'MIMIC_IDLE_TIMEOUT', kind: 'int', help: 'close idle RESP clients after N seconds, 0 = never (default 0)' },
  { key: 'maxBulkBytes', flag: 'max-bulk-bytes', env: 'MIMIC_MAX_BULK_BYTES', kind: 'int', help: 'max size of one value over RESP (default 67108864 = 64 MB)' },
  { key: 'httpBodyLimitBytes', flag: 'http-body-limit', env: 'MIMIC_HTTP_BODY_LIMIT', kind: 'int', help: 'max HTTP request body (default 1048576 = 1 MB)' },
  { key: 'cleanupIntervalMs', flag: 'cleanup-interval', env: 'MIMIC_CLEANUP_INTERVAL_MS', kind: 'int', help: 'active expiry interval in ms (default 100)' },
  { key: 'cleanupSampleSize', flag: 'cleanup-sample-size', env: 'MIMIC_CLEANUP_SAMPLE_SIZE', kind: 'int', help: 'keys checked per expiry batch (default 20)' },
  { key: 'cleanupTimeBudgetMs', flag: 'cleanup-time-budget', env: 'MIMIC_CLEANUP_TIME_BUDGET_MS', kind: 'int', help: 'max ms per expiry cycle (default 5)' },
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
  }
}

export interface ParsedArgs {
  config: MimicConfig;
  help: boolean;
  version: boolean;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const values: Record<string, unknown> = {};

  for (const def of OPTIONS) {
    const raw = env[def.env];
    if (raw !== undefined && raw !== '') values[def.key] = convert(def, raw, def.env);
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
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    const def = m && OPTIONS.find((o) => o.flag === m[1]);
    if (!m || !def) throw new ConfigError(`unknown option: ${arg} (see --help)`);
    const raw = m[2] ?? argv[++i];
    if (raw === undefined) throw new ConfigError(`missing value for --${def.flag}`);
    values[def.key] = convert(def, raw, `--${def.flag}`);
  }

  const passwordFile = values['passwordFile'] as string | undefined;
  if (passwordFile && values['password'] === undefined) {
    try {
      values['password'] = readFileSync(passwordFile, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`cannot read password file ${passwordFile}: ${(err as Error).message}`);
    }
  }

  const host = (values['host'] as string | undefined) ?? '127.0.0.1';
  const config: MimicConfig = {
    host,
    port: (values['port'] as number | undefined) ?? 6379,
    httpHost: (values['httpHost'] as string | undefined) ?? host,
    httpPort: values['httpPort'] === undefined ? 6380 : (values['httpPort'] as number | null),
    maxClients: (values['maxClients'] as number | undefined) ?? 10_000,
    idleTimeoutSec: (values['idleTimeoutSec'] as number | undefined) ?? 0,
    maxBulkBytes: (values['maxBulkBytes'] as number | undefined) ?? 64 * 1024 * 1024,
    httpBodyLimitBytes: (values['httpBodyLimitBytes'] as number | undefined) ?? 1024 * 1024,
    cleanupIntervalMs: Math.max((values['cleanupIntervalMs'] as number | undefined) ?? 100, 1),
    cleanupSampleSize: Math.max((values['cleanupSampleSize'] as number | undefined) ?? 20, 1),
    cleanupTimeBudgetMs: (values['cleanupTimeBudgetMs'] as number | undefined) ?? 5,
    logLevel: (values['logLevel'] as LogLevel | undefined) ?? 'info',
  };
  const password = values['password'] as string | undefined;
  if (password) config.password = password;
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
