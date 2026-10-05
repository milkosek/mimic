// SPDX-License-Identifier: Apache-2.0
//
// Wires config -> singleton store -> RESP server(s) (+ optional HTTP server).
//
// One RESP server object holds all client state; it can listen on the plain
// port, and a TLS listener hands its connections to the same object, so
// limits, WATCH and CLIENT LIST cover both.

import type http from 'node:http';
import type https from 'node:https';
import type net from 'node:net';
import tls from 'node:tls';
import { AuthGuard, PasswordCheck } from './auth.js';
import { checkDisabledCommands, type InfoSections } from './commands.js';
import { ConfigError, type MimicConfig } from './config.js';
import { createHttpServer } from './http/server.js';
import { createRespServer, type Logger, type RespServer } from './resp/server.js';
import { Store } from './store.js';
import { loadTlsOptions } from './tls.js';

export interface Daemon {
  store: Store;
  resp: RespServer;
  /** The TLS listener for RESP, if --tls-port is set. */
  respTls: tls.Server | null;
  http: http.Server | https.Server | null;
  /** Actual bound ports (useful with port 0); null = that listener is off. */
  respPort: number | null;
  respTlsPort: number | null;
  httpPort: number | null;
  close(): Promise<void>;
}

const NOOP_LOGGER: Logger = { info() {}, warn() {}, error() {} };

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.');

/** TLS settings, with certificate and passphrase problems reported as configuration errors. */
function tlsOptions(config: MimicConfig): tls.TlsOptions {
  const opts = loadTlsOptions(config);
  try {
    tls.createSecureContext(opts); // fail now, with a clear message, rather than on the first client
  } catch (err) {
    throw new ConfigError(`TLS certificate or key could not be loaded: ${(err as Error).message}`);
  }
  return opts;
}

export async function startDaemon(config: MimicConfig, logger: Logger = NOOP_LOGGER): Promise<Daemon> {
  const disabledError = checkDisabledCommands(config.disableCommands);
  if (disabledError) throw new ConfigError(disabledError);
  const disabledCommands = config.disableCommands.length > 0 ? new Set(config.disableCommands) : undefined;
  const tlsOpts = config.tlsPort !== null || config.httpTls ? tlsOptions(config) : undefined;
  // One guard for both servers: failures over RESP and HTTP add up per address.
  const authGuard = new AuthGuard({ maxFailures: config.authMaxFailures, warn: (m) => logger.warn(m) });

  const store = Store.getInstance({
    cleanupIntervalMs: config.cleanupIntervalMs,
    sampleSize: config.cleanupSampleSize,
    timeBudgetMs: config.cleanupTimeBudgetMs,
    databases: config.databases,
    maxMemoryPercent: config.maxMemoryPercent,
  });
  // Only stop the timer later if this daemon started it (embedding code may own it).
  const startedTimer = !store.running;
  store.start();
  const stopTimer = (): void => {
    if (startedTimer) store.stop();
  };

  let httpPort: number | null = null;
  let respTlsPort: number | null = null;
  const extraInfo = (): InfoSections => ({ Server: { http_port: httpPort ?? 0, tls_port: respTlsPort ?? 0 } });

  const resp = createRespServer(store, {
    ...(config.password ? { password: config.password } : {}),
    protectedMode: config.protectedMode,
    authTimeoutSec: config.authTimeoutSec,
    authGuard,
    ...(disabledCommands ? { disabledCommands } : {}),
    maxClients: config.maxClients,
    idleTimeoutSec: config.idleTimeoutSec,
    limits: { maxBulkLength: config.maxBulkBytes },
    maxQueryBufferBytes: config.maxQueryBufferBytes,
    logger,
    extraInfo,
  });

  let respTls: tls.Server | null = null;
  let httpServer: http.Server | https.Server | null = null;
  let respPort: number | null = null;
  const stopAll = (): void => {
    if (resp.listening) resp.close();
    if (respTls?.listening) respTls.close();
    if (httpServer?.listening) httpServer.close();
    resp.dispose();
    stopTimer();
  };
  try {
    if (config.port !== null) respPort = await listen(resp, config.port, config.host);
    if (config.tlsPort !== null) {
      respTls = tls.createServer(tlsOpts!, (socket) => resp.handleConnection(socket));
      // A failed handshake (wrong CA, no client certificate, plain text on the
      // TLS port...) is the client's problem, not an error of ours.
      respTls.on('tlsClientError', (err, socket) => {
        logger.debug?.(`[tls] handshake failed from ${socket.remoteAddress}: ${err.message}`);
        socket.destroy();
      });
      respTlsPort = await listen(respTls, config.tlsPort, config.host);
    }
    if (config.httpPort !== null) {
      httpServer = createHttpServer(store, {
        ...(config.password ? { authToken: config.password } : {}),
        protectedMode: config.protectedMode,
        authGuard,
        ...(disabledCommands ? { disabledCommands } : {}),
        ...(config.httpTls ? { tls: tlsOpts! } : {}),
        bodyLimitBytes: config.httpBodyLimitBytes,
        allowedOrigins: config.httpAllowedOrigins,
        allowedHosts: config.httpAllowedHosts,
        logger,
        extraInfo: () => ({ ...extraInfo(), Clients: { connected_clients: resp.stats.connectedClients } }),
      });
      httpPort = await listen(httpServer, config.httpPort, config.httpHost);
    }
  } catch (err) {
    stopAll();
    throw err;
  }

  const exposed = (!isLoopbackHost(config.host) && (respPort !== null || respTlsPort !== null)) || (httpServer !== null && !isLoopbackHost(config.httpHost));
  if (!config.password && exposed) {
    logger.warn(
      config.protectedMode
        ? 'listening on a network address without a password: protected mode only lets in clients on this machine. Set a password to accept others.'
        : 'listening on a network address without a password and with protected mode off: anyone who can reach this port can read and change the cache.',
    );
  }
  if (config.password && exposed && respPort !== null && !isLoopbackHost(config.host)) {
    logger.warn('plain (non-TLS) RESP is reachable from the network: the password and data travel unencrypted. Consider --tls-port and --port off.');
  }
  if (httpServer && !config.httpTls && config.password && !isLoopbackHost(config.httpHost)) {
    logger.warn('the HTTP API is reachable from the network without TLS: the token and data travel unencrypted. Consider --http-tls.');
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    logger.warn('running as uid 0 (root, or QSECOFR on IBM i): run MIMIC under its own unprivileged user profile instead.');
  }

  const close = async (): Promise<void> => {
    stopTimer();
    const closing: Promise<void>[] = [new Promise((r) => resp.close(() => r()))];
    if (respTls) {
      const t = respTls;
      closing.push(new Promise((r) => t.close(() => r())));
    }
    resp.disconnectAll();
    if (httpServer) {
      const h = httpServer;
      closing.push(new Promise((r) => h.close(() => r())));
      (h as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    await Promise.all(closing);
    resp.dispose(); // also when plain RESP never listened (TLS only)
  };

  return { store, resp, respTls, http: httpServer, respPort, respTlsPort, httpPort, close };
}

/** One line describing the security setup, for the startup log. */
export function securitySummary(config: MimicConfig, d: Daemon): string {
  const parts: string[] = [];
  if (config.password) parts.push(`password: yes${new PasswordCheck(config.password).hashed ? ' (given as a hash)' : ''}`);
  else parts.push(`password: none, protected mode ${config.protectedMode ? 'on (local clients only)' : 'OFF'}`);
  parts.push(d.respTlsPort !== null ? `TLS: port ${d.respTlsPort} (client certificates: ${config.tlsAuthClients})` : 'TLS: off');
  if (d.respPort === null) parts.push('plain RESP: off');
  if (d.httpPort !== null) parts.push(`HTTP: ${config.httpHost}:${d.httpPort}${config.httpTls ? ' (HTTPS)' : ''}`);
  if (config.password) parts.push(`login: ${config.authTimeoutSec ? `${config.authTimeoutSec} s to AUTH` : 'no time limit'}, ${config.authMaxFailures ? `block after ${config.authMaxFailures} failures/min` : 'no blocking'}`);
  if (config.disableCommands.length) parts.push(`disabled: ${config.disableCommands.join(',')}`);
  return parts.join(' | ');
}
