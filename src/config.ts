// SPDX-License-Identifier: Apache-2.0
//
// Configuration: defaults < environment (MIMIC_*) < command-line flags.
// The same order applies to the password and the password file.

import { readFileSync, statSync } from 'node:fs';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export type TlsAuthClients = 'yes' | 'no' | 'optional';

export interface MimicConfig {
  /** RESP (Redis protocol) listener; null port = plain RESP disabled (TLS only). */
  host: string;
  port: number | null;
  /** HTTP/JSON listener; null port = disabled. Binds to 127.0.0.1 unless set. */
  httpHost: string;
  httpPort: number | null;
  /**
   * Shared secret: RESP `AUTH <password>` and HTTP `Authorization: Bearer <password>`.
   * Plain text, or "sha256:<hex>" so the configuration holds only a hash.
   */
  password?: string;
  /** Without a password, accept connections from loopback addresses only (Redis' protected-mode). */
  protectedMode: boolean;
  /** Close connections that haven't authenticated after this many seconds (0 = never). */
  authTimeoutSec: number;
  /** Block an address for 60 s after this many failed logins within 60 s (0 = never). */
  authMaxFailures: number;
  /** Commands refused as if they didn't exist (upper case). */
  disableCommands: string[];
  /** TLS listener for RESP; null = no TLS. */
  tlsPort: number | null;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  /** File holding the passphrase of the key or PKCS#12 file. */
  tlsKeyPassFile?: string;
  /** PKCS#12 / PFX bundle (e.g. exported from IBM i DCM) instead of cert + key files. */
  tlsPfxFile?: string;
  /** CA certificate(s) used to verify client certificates. */
  tlsCaCertFile?: string;
  /** Require ('yes'), accept ('optional') or ignore ('no') client certificates. */
  tlsAuthClients: TlsAuthClients;
  /** Serve the HTTP API over HTTPS, with the same certificate. */
  httpTls: boolean;
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
  kind: 'string' | 'int' | 'port' | 'optionalPort' | 'level' | 'list' | 'bool' | 'enum';
  help: string;
  /** Allowed range for 'int' options. */
  min?: number;
  max?: number;
  /** Allowed values for 'enum' options. */
  choices?: string[];
}

const MAX_TIMER_SEC = Math.floor((2 ** 31 - 1) / 1000); // longest Node timer
const V8_MAX_STRING = 2 ** 29 - 24; // longest one-byte string V8 can create

export const OPTIONS: OptionDef[] = [
  { key: 'host', flag: 'host', env: 'MIMIC_HOST', kind: 'string', help: 'RESP bind address (default 127.0.0.1)' },
  { key: 'port', flag: 'port', env: 'MIMIC_PORT', kind: 'optionalPort', help: 'RESP port, or "off" to accept only TLS (default 6379)' },
  { key: 'httpHost', flag: 'http-host', env: 'MIMIC_HTTP_HOST', kind: 'string', help: 'HTTP bind address (default 127.0.0.1, whatever --host is)' },
  { key: 'httpPort', flag: 'http-port', env: 'MIMIC_HTTP_PORT', kind: 'optionalPort', help: 'HTTP port, or "off" (default 6380)' },
  { key: 'password', flag: 'password', env: 'MIMIC_PASSWORD', kind: 'string', help: 'require AUTH / Bearer token; plain or "sha256:<hex>" (prefer --password-file)' },
  { key: 'passwordFile', flag: 'password-file', env: 'MIMIC_PASSWORD_FILE', kind: 'string', help: 'read the password (or its sha256:<hex> hash) from a file' },
  { key: 'protectedMode', flag: 'protected-mode', env: 'MIMIC_PROTECTED_MODE', kind: 'bool', help: 'without a password, accept only local connections: yes|no (default yes)' },
  { key: 'authTimeoutSec', flag: 'auth-timeout', env: 'MIMIC_AUTH_TIMEOUT', kind: 'int', min: 0, max: MAX_TIMER_SEC, help: 'close connections not authenticated after N seconds, 0 = never (default 10)' },
  { key: 'authMaxFailures', flag: 'auth-max-failures', env: 'MIMIC_AUTH_MAX_FAILURES', kind: 'int', min: 0, max: 1_000_000, help: 'block an address for 60 s after N failed logins in 60 s, 0 = never (default 10)' },
  { key: 'disableCommands', flag: 'disable-commands', env: 'MIMIC_DISABLE_COMMANDS', kind: 'list', help: 'comma-separated commands to refuse, e.g. FLUSHALL,FLUSHDB,KEYS (default: none)' },
  { key: 'tlsPort', flag: 'tls-port', env: 'MIMIC_TLS_PORT', kind: 'optionalPort', help: 'RESP over TLS on this port (default off)' },
  { key: 'tlsCertFile', flag: 'tls-cert-file', env: 'MIMIC_TLS_CERT_FILE', kind: 'string', help: 'server certificate (PEM)' },
  { key: 'tlsKeyFile', flag: 'tls-key-file', env: 'MIMIC_TLS_KEY_FILE', kind: 'string', help: 'server private key (PEM)' },
  { key: 'tlsPfxFile', flag: 'tls-pfx-file', env: 'MIMIC_TLS_PFX_FILE', kind: 'string', help: 'certificate + key as PKCS#12 (.p12/.pfx, e.g. exported from DCM), instead of the two files above' },
  { key: 'tlsKeyPassFile', flag: 'tls-key-pass-file', env: 'MIMIC_TLS_KEY_PASS_FILE', kind: 'string', help: 'file holding the passphrase of the key or PKCS#12 file' },
  { key: 'tlsCaCertFile', flag: 'tls-ca-cert-file', env: 'MIMIC_TLS_CA_CERT_FILE', kind: 'string', help: 'CA certificate(s) for verifying client certificates (PEM)' },
  { key: 'tlsAuthClients', flag: 'tls-auth-clients', env: 'MIMIC_TLS_AUTH_CLIENTS', kind: 'enum', choices: ['yes', 'no', 'optional'], help: 'client certificates: yes|no|optional (default yes with --tls-ca-cert-file, else no)' },
  { key: 'httpTls', flag: 'http-tls', env: 'MIMIC_HTTP_TLS', kind: 'bool', help: 'serve the HTTP API over HTTPS with the TLS certificate: yes|no (default no)' },
  { key: 'maxClients', flag: 'max-clients', env: 'MIMIC_MAX_CLIENTS', kind: 'int', min: 1, max: 1_000_000, help: 'max concurrent RESP clients (default 10000)' },
  { key: 'databases', flag: 'databases', env: 'MIMIC_DATABASES', kind: 'int', min: 1, max: 65_536, help: 'number of databases for SELECT (default 16)' },
  { key: 'idleTimeoutSec', flag: 'idle-timeout', env: 'MIMIC_IDLE_TIMEOUT', kind: 'int', min: 0, max: MAX_TIMER_SEC, help: 'close idle RESP clients after N seconds, 0 = never (default 0)' },
  { key: 'maxBulkBytes', flag: 'max-bulk-bytes', env: 'MIMIC_MAX_BULK_BYTES', kind: 'int', min: 1, max: V8_MAX_STRING, help: 'max size of one value over RESP (default 67108864 = 64 MB)' },
  { key: 'maxQueryBufferBytes', flag: 'max-query-buffer', env: 'MIMIC_MAX_QUERY_BUFFER', kind: 'int', min: 1024 * 1024, max: Number.MAX_SAFE_INTEGER, help: 'max unparsed input per RESP client (default 1073741824 = 1 GB)' },
  { key: 'httpBodyLimitBytes', flag: 'http-body-limit', env: 'MIMIC_HTTP_BODY_LIMIT', kind: 'int', min: 1, max: V8_MAX_STRING, help: 'max HTTP request body (default 1048576 = 1 MB)' },
  { key: 'httpAllowedOrigins', flag: 'http-allowed-origins', env: 'MIMIC_HTTP_ALLOWED_ORIGINS', kind: 'list', help: 'comma-separated browser origins allowed to use the HTTP API (default: none)' },
  { key: 'httpAllowedHosts', flag: 'http-allowed-hosts', env: 'MIMIC_HTTP_ALLOWED_HOSTS', kind: 'list', help: 'extra Host names accepted without a password (IPs and localhost always are)' },
  { key: 'cleanupIntervalMs', flag: 'cleanup-interval', env: 'MIMIC_CLEANUP_INTERVAL_MS', kind: 'int', min: 1, max: 2 ** 31 - 1, help: 'active expiry interval in ms (default 100)' },
  { key: 'cleanupSampleSize', flag: 'cleanup-sample-size', env: 'MIMIC_CLEANUP_SAMPLE_SIZE', kind: 'int', min: 1, max: 1_000_000, help: 'keys checked per expiry batch (default 20)' },
  { key: 'cleanupTimeBudgetMs', flag: 'cleanup-time-budget', env: 'MIMIC_CLEANUP_TIME_BUDGET_MS', kind: 'int', min: 1, max: 10_000, help: 'max ms per expiry cycle (default 5)' },
  { key: 'maxMemoryPercent', flag: 'max-memory-percent', env: 'MIMIC_MAX_MEMORY_PERCENT', kind: 'int', min: 0, max: 100, help: 'refuse growing writes with -OOM above this % of the V8 heap limit, 0 = off (default 80)' },
  { key: 'logLevel', flag: 'log-level', env: 'MIMIC_LOG_LEVEL', kind: 'level', help: 'silent|error|warn|info|debug (default info)' },
];

const TLS_FILE_KEYS = ['tlsCertFile', 'tlsKeyFile', 'tlsPfxFile', 'tlsKeyPassFile', 'tlsCaCertFile'] as const;

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
      const n = Number(raw);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        bad(`expected ${def.min ?? 0} to ${def.max}`);
      }
      return n;
    }
    case 'bool':
      if (/^(yes|true|on|1)$/i.test(raw)) return true;
      if (/^(no|false|off|0)$/i.test(raw)) return false;
      return bad('expected yes or no');
    case 'enum':
      if (!def.choices!.includes(raw.toLowerCase())) bad(`expected one of ${def.choices!.join(', ')}`);
      return raw.toLowerCase();
    case 'port':
    case 'optionalPort': {
      if (def.kind === 'optionalPort' && /^(off|false|no|disabled?)$/i.test(raw)) return null;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n > 65535) bad('expected a port number 0-65535');
      return n;
    }
    case 'level':
      if (!LEVELS.includes(raw.toLowerCase() as LogLevel)) bad(`expected one of ${LEVELS.join(', ')}`);
      return raw.toLowerCase();
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
function resolvePassword(sources: [string, Record<string, unknown>][], warnings: string[]): string | undefined {
  for (const [where, values] of sources) {
    const password = values['password'] as string | undefined;
    const file = values['passwordFile'] as string | undefined;
    if (password !== undefined && file !== undefined) {
      throw new ConfigError(`both a password and a password file are set in the ${where}; use one of them`);
    }
    if (password !== undefined) {
      if (password === '') throw new ConfigError(`the password set in the ${where} is empty`);
      if (where === 'command-line flags') {
        warnings.push('--password is visible to other users in the process list; prefer --password-file');
      }
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
      // On Unix-like systems (including IBM i PASE), others shouldn't be able to read it.
      if (process.platform !== 'win32') {
        try {
          if (statSync(file).mode & 0o077) {
            warnings.push(`password file ${file} can be read or written by other users; restrict it (chmod 600)`);
          }
        } catch {
          /* already read successfully; nothing more to check */
        }
      }
      return content;
    }
  }
  return undefined;
}

export interface ParsedArgs {
  config: MimicConfig;
  help: boolean;
  version: boolean;
  /** Read a password from stdin and print its sha256:<hex> form (--hash-password). */
  hashPassword: boolean;
  /** Configuration that works but is risky; the CLI logs these at startup. */
  warnings: string[];
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  // --help, --version and --hash-password don't start a server, so the rest of
  // the configuration (which may be incomplete in that shell) isn't checked.
  const help = argv.includes('-h') || argv.includes('--help');
  const version = argv.includes('-v') || argv.includes('--version');
  const hashPassword = argv.includes('--hash-password');
  if (help || version || hashPassword) {
    return { config: loadConfig([], {}).config, help, version, hashPassword, warnings: [] };
  }

  const envValues: Record<string, unknown> = {};
  const flagValues: Record<string, unknown> = {};

  for (const def of OPTIONS) {
    const raw = env[def.env];
    if (raw === undefined) continue;
    // An empty env var means "unset", except for the password: set-but-empty is an error there.
    if (raw === '' && !PASSWORD_KEYS.has(def.key)) continue;
    envValues[def.key] = convert(def, raw, def.env);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    const def = m && OPTIONS.find((o) => o.flag === m[1]);
    if (!m || !def) throw new ConfigError(`unknown option: ${arg} (see --help)`);
    const raw = m[2] ?? argv[++i];
    if (raw === undefined) throw new ConfigError(`missing value for --${def.flag}`);
    flagValues[def.key] = convert(def, raw, `--${def.flag}`);
  }

  const values: Record<string, unknown> = { ...envValues, ...flagValues };
  const warnings: string[] = [];
  const password = resolvePassword(
    [
      ['command-line flags', flagValues],
      ['environment', envValues],
    ],
    warnings,
  );

  const host = (values['host'] as string | undefined) ?? '127.0.0.1';
  const tlsCaCertFile = values['tlsCaCertFile'] as string | undefined;
  const config: MimicConfig = {
    host,
    port: values['port'] === undefined ? 6379 : (values['port'] as number | null),
    httpHost: (values['httpHost'] as string | undefined) ?? '127.0.0.1',
    httpPort: values['httpPort'] === undefined ? 6380 : (values['httpPort'] as number | null),
    protectedMode: (values['protectedMode'] as boolean | undefined) ?? true,
    authTimeoutSec: (values['authTimeoutSec'] as number | undefined) ?? 10,
    authMaxFailures: (values['authMaxFailures'] as number | undefined) ?? 10,
    disableCommands: ((values['disableCommands'] as string[] | undefined) ?? []).map((c) => c.toUpperCase()),
    tlsPort: (values['tlsPort'] as number | null | undefined) ?? null,
    tlsAuthClients: (values['tlsAuthClients'] as TlsAuthClients | undefined) ?? (tlsCaCertFile ? 'yes' : 'no'),
    httpTls: (values['httpTls'] as boolean | undefined) ?? false,
    maxClients: (values['maxClients'] as number | undefined) ?? 10_000,
    databases: (values['databases'] as number | undefined) ?? 16,
    idleTimeoutSec: (values['idleTimeoutSec'] as number | undefined) ?? 0,
    maxBulkBytes: (values['maxBulkBytes'] as number | undefined) ?? 64 * 1024 * 1024,
    maxQueryBufferBytes: (values['maxQueryBufferBytes'] as number | undefined) ?? 1024 * 1024 * 1024,
    httpBodyLimitBytes: (values['httpBodyLimitBytes'] as number | undefined) ?? 1024 * 1024,
    httpAllowedOrigins: (values['httpAllowedOrigins'] as string[] | undefined) ?? [],
    httpAllowedHosts: (values['httpAllowedHosts'] as string[] | undefined) ?? [],
    cleanupIntervalMs: (values['cleanupIntervalMs'] as number | undefined) ?? 100,
    cleanupSampleSize: (values['cleanupSampleSize'] as number | undefined) ?? 20,
    cleanupTimeBudgetMs: (values['cleanupTimeBudgetMs'] as number | undefined) ?? 5,
    maxMemoryPercent: (values['maxMemoryPercent'] as number | undefined) ?? 80,
    logLevel: (values['logLevel'] as LogLevel | undefined) ?? 'info',
  };
  for (const key of TLS_FILE_KEYS) {
    const v = values[key] as string | undefined;
    if (v !== undefined) config[key] = v;
  }
  if (password !== undefined) {
    config.password = password;
    if (!/^sha256:[0-9a-f]{64}$/i.test(password) && password.length < 16) {
      warnings.push('the password is shorter than 16 characters; use a long random one (see SECURITY.md)');
    }
  }
  validateTls(config);
  if (config.port === null && config.tlsPort === null) {
    throw new ConfigError('--port is off and no --tls-port is set: there would be no way to connect');
  }
  // (Port 0 means "any free port" for both, so it may repeat.)
  if (config.port !== null && config.port !== 0 && config.port === config.tlsPort) throw new ConfigError('--port and --tls-port must differ');
  if (!config.password && !config.protectedMode && !isLoopbackHost(config.host)) {
    warnings.push('protected mode is off and there is no password: anyone who can reach this port can read and change the cache');
  }
  return { config, help, version, hashPassword, warnings };
}

const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.');

function validateTls(c: MimicConfig): void {
  const pem = c.tlsCertFile !== undefined || c.tlsKeyFile !== undefined;
  const any = pem || c.tlsPfxFile !== undefined || c.tlsCaCertFile !== undefined || c.tlsKeyPassFile !== undefined;
  const needed = c.tlsPort !== null || c.httpTls;
  if (!needed) {
    if (any) throw new ConfigError('TLS files are set but neither --tls-port nor --http-tls is; set one of them or remove the TLS options');
    return;
  }
  if (pem && c.tlsPfxFile !== undefined) throw new ConfigError('use either --tls-cert-file/--tls-key-file or --tls-pfx-file, not both');
  if (c.tlsPfxFile === undefined && (c.tlsCertFile === undefined || c.tlsKeyFile === undefined)) {
    throw new ConfigError('TLS needs --tls-cert-file and --tls-key-file, or --tls-pfx-file');
  }
  if (c.tlsAuthClients !== 'no' && c.tlsCaCertFile === undefined) {
    throw new ConfigError(`--tls-auth-clients ${c.tlsAuthClients} needs --tls-ca-cert-file to verify client certificates`);
  }
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
    '  --hash-password                    read a password from standard input and print its sha256:<hex> form',
    '  -h, --help',
    '  -v, --version',
    '',
  ].join('\n');
}
