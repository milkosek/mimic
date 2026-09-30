#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { ConfigError, helpText, loadConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { createLogger } from './logger.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`mimic: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }
  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  const { config } = parsed;
  const log = createLogger(config.logLevel);
  const daemon = await startDaemon(config, log);

  log.info(`MIMIC ${VERSION} (node ${process.version}, ${process.platform}/${process.arch}, pid ${process.pid})`);
  log.info(`RESP listening on ${config.host}:${daemon.respPort}`);
  if (daemon.httpPort !== null) log.info(`HTTP listening on ${config.httpHost}:${daemon.httpPort}`);
  if (!config.password) log.info('no password set - clients do not need to AUTH');

  let stopping = false;
  const shutdown = (reason: string, code = 0): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${reason} - shutting down`);
    setTimeout(() => process.exit(code || 1), 5000).unref(); // force exit if something hangs
    daemon.close().then(
      () => process.exit(code),
      () => process.exit(1),
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', err);
    shutdown('uncaught exception', 1);
  });
}

main().catch((err: NodeJS.ErrnoException) => {
  const hint = err.code === 'EADDRINUSE' ? ' (is another cache or Redis already running on that port?)' : '';
  console.error(`mimic: failed to start: ${err.message}${hint}`);
  process.exit(1);
});
