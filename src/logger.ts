// SPDX-License-Identifier: Apache-2.0

import type { LogLevel } from './config.js';
import type { Logger } from './resp/server.js';

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Timestamped line logger (stdout/stderr) - friendly to job logs and log files. */
export function createLogger(level: LogLevel = 'info'): Logger & { debug(msg: string): void } {
  const on = (l: LogLevel): boolean => RANK[level] >= RANK[l];
  const line = (l: string, msg: string): string => `${new Date().toISOString()} [${l}] ${msg}`;
  return {
    debug: (msg) => on('debug') && console.log(line('debug', msg)),
    info: (msg) => on('info') && console.log(line('info', msg)),
    warn: (msg) => on('warn') && console.warn(line('warn', msg)),
    error: (msg, err) => {
      if (!on('error')) return;
      console.error(line('error', msg));
      if (err) console.error(err);
    },
  } as Logger & { debug(msg: string): void };
}
