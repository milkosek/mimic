// Cross-platform test runner. `node --test <dir>` behaves differently across
// Node 18/20/22 (and cmd.exe does not expand globs), so list the files ourselves.
//
//   node scripts/run-tests.mjs          -> unit + integration tests
//   node scripts/run-tests.mjs compat   -> tests that use real Redis clients (ioredis, node-redis, redis-cli)

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join('build-test', 'test');
const compat = process.argv[2] === 'compat';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => f.startsWith('compat.') === compat)
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`no test files found in ${dir}`);
  process.exit(1);
}

const { status } = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
