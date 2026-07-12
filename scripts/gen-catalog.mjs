#!/usr/bin/env node
/**
 * Compatibility wrapper for the original generator command.
 *
 * The canonical implementation is python/catalog_publisher.py. Keeping this
 * wrapper prevents old demo notes from silently invoking the former
 * McMaster-only generator and overwriting the multi-merchant contract.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pythonRoot = resolve('python');
const catalogArgs = process.argv.slice(2).map((arg) => resolve(arg));
const result = spawnSync(
  'direnv',
  ['exec', '.', 'uv', 'run', 'python', 'catalog_publisher.py', ...catalogArgs],
  { cwd: pythonRoot, stdio: 'inherit' },
);

if (result.error) {
  console.error(`catalog publisher failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
