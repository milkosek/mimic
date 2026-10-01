// SPDX-License-Identifier: Apache-2.0
//
// Wires config -> singleton store -> RESP server (+ optional HTTP server).

import type http from 'node:http';
import type net from 'node:net';
import type { InfoSections } from './commands.js';
import type { MimicConfig } from './config.js';
import { createHttpServer } from './http/server.js';
import { createRespServer, type Logger, type RespServer } from './resp/server.js';
import { Store } from './store.js';

export interface Daemon {
  store: Store;
  resp: RespServer;
  http: http.Server | null;
  /** Actual bound ports (useful with port 0). */
  respPort: number;
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

const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || host.startsWith('127.');

export async function startDaemon(config: MimicConfig, logger: Logger = NOOP_LOGGER): Promise<Daemon> {
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
  const extraInfo = (): InfoSections => ({ Server: { http_port: httpPort ?? 0 } });

  const resp = createRespServer(store, {
    ...(config.password ? { password: config.password } : {}),
    maxClients: config.maxClients,
    idleTimeoutSec: config.idleTimeoutSec,
    limits: { maxBulkLength: config.maxBulkBytes },
    maxQueryBufferBytes: config.maxQueryBufferBytes,
    logger,
    extraInfo,
  });

  let httpServer: http.Server | null = null;
  let respPort: number;
  try {
    respPort = await listen(resp, config.port, config.host);
  } catch (err) {
    resp.dispose(); // never listened, so 'close' won't fire to unsubscribe
    stopTimer();
    throw err;
  }
  try {
    if (config.httpPort !== null) {
      httpServer = createHttpServer(store, {
        ...(config.password ? { authToken: config.password } : {}),
        bodyLimitBytes: config.httpBodyLimitBytes,
        allowedOrigins: config.httpAllowedOrigins,
        allowedHosts: config.httpAllowedHosts,
        logger,
        extraInfo: () => ({ ...extraInfo(), Clients: { connected_clients: resp.stats.connectedClients } }),
      });
      httpPort = await listen(httpServer, config.httpPort, config.httpHost);
    }
  } catch (err) {
    resp.close();
    resp.dispose();
    stopTimer();
    throw err;
  }

  if (!config.password && (!isLoopback(config.host) || (httpServer && !isLoopback(config.httpHost)))) {
    logger.warn('listening on a non-loopback address without a password - anyone who can reach this port can read and write the cache. Set MIMIC_PASSWORD.');
  }

  const close = async (): Promise<void> => {
    stopTimer();
    const closing: Promise<void>[] = [new Promise((r) => resp.close(() => r()))];
    resp.disconnectAll();
    if (httpServer) {
      const h = httpServer;
      closing.push(new Promise((r) => h.close(() => r())));
      (h as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    await Promise.all(closing);
  };

  return { store, resp, http: httpServer, respPort, httpPort, close };
}
