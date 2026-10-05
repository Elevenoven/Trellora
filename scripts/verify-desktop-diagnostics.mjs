import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(path.join(os.tmpdir(), 'trellora-diagnostics-'));
try {
  const outfile = path.join(root, 'modules.cjs');
  await build({ stdin: { contents: "export { AppLogger, safeServiceEndpoint } from './electron/appLogger'; export { DataRootLocks } from './electron/dataRootLocks';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile });
  const { AppLogger, safeServiceEndpoint, DataRootLocks } = createRequire(import.meta.url)(outfile);
  const logger = new AppLogger(() => path.join(root, 'logs'), 350, 3);
  for (let index = 0; index < 30; index++) logger.record('error', 'startup', 'WORKER_MISSING', 'secret=BODY_SENTINEL');
  const logs = readdirSync(path.join(root, 'logs'));
  assert.equal(logs.length, 3);
  for (const file of logs) assert.doesNotMatch(readFileSync(path.join(root, 'logs', file), 'utf8'), /BODY_SENTINEL|secret=/);
  assert.equal(new AppLogger(() => path.join(root, 'logs')).recent().at(-1).code, 'WORKER_MISSING');
  assert.equal(safeServiceEndpoint('https://user:SECRET@example.com/v1?key=SECRET#SECRET'), 'https://example.com/v1');
  const inaccessible = new AppLogger(() => path.join(root, 'logs/application.ndjson'));
  inaccessible.record('error', 'startup', 'LOG_WRITE_FAILED');
  assert.equal(inaccessible.degraded, true);
  const data = path.join(root, 'workspace'); mkdirSync(data);
  const locks = new DataRootLocks(); locks.acquire([data]);
  const collision = spawnSync(process.execPath, ['-e', `const {DataRootLocks}=require(process.argv[1]);try{new DataRootLocks().acquire([process.argv[2]]);process.exit(1)}catch{process.exit(0)}`, outfile, path.join(data, 'nested-library')], { windowsHide: true, timeout: 10_000 });
  assert.equal(collision.status, 0, 'different process must reject an overlapping root');
  locks.releaseAll();
  const next = new DataRootLocks(); next.acquire([data]); next.releaseAll();
  const crash = spawnSync(process.execPath, ['-e', `const {DataRootLocks}=require(process.argv[1]);new DataRootLocks().acquire([process.argv[2]]);process.exit(0)`, outfile, data], { windowsHide: true, timeout: 10_000 });
  assert.equal(crash.status, 0);
  const recovered = new DataRootLocks(); recovered.acquire([data]); recovered.releaseAll();
  console.log('desktop diagnostics: bounded private logs, cold restart, failures, cross-process overlap and crashed-owner recovery passed');
} finally { assert.ok(root.startsWith(path.join(os.tmpdir(), 'trellora-diagnostics-'))); rmSync(root, { recursive: true, force: true }); }
