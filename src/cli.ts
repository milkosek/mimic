#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { hashPassword } from './auth.js';
import { ConfigError, helpText, loadConfig } from './config.js';
import { securitySummary, startDaemon } from './daemon.js';
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
  if (parsed.hashPassword) {
    // Reads the password from standard input, so it never appears in the
    // process list or the shell history: echo -n ... | mimic --hash-password
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (password === '') {
      console.error('mimic: no password on standard input');
      process.exit(2);
    }
    console.log(hashPassword(password));
    return;
  }

  const { config } = parsed;
  const log = createLogger(config.logLevel);
  for (const w of parsed.warnings) log.warn(w);
  let daemon;
  try {
    daemon = await startDaemon(config, log);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`mimic: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  log.info(`MIMIC ${VERSION} (node ${process.version}, ${process.platform}/${process.arch}, pid ${process.pid})`);
  if (daemon.respPort !== null) log.info(`RESP listening on ${config.host}:${daemon.respPort}`);
  if (daemon.respTlsPort !== null) log.info(`RESP (TLS) listening on ${config.host}:${daemon.respTlsPort}`);
  if (daemon.httpPort !== null) log.info(`HTTP${config.httpTls ? 'S' : ''} listening on ${config.httpHost}:${daemon.httpPort}`);
  log.info(`security: ${securitySummary(config, daemon)}`);
  log.debug?.('debug logging is on: every connection and command is logged, with values (truncated) - mind sensitive data');

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
