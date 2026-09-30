// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

/** Package version, read from package.json next to dist/. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Redis version reported to clients. Clients use it for feature detection only. */
export const REDIS_COMPAT_VERSION = '7.0.0';

export const NAME = 'mimic';
