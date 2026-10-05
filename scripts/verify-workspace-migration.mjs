import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const staging = path.resolve('.package-staging'); fs.mkdirSync(staging, { recursive: true });
const root = fs.mkdtempSync(path.join(staging, 'workspace-migration-'));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellora-workspace-migration-'));
const executable = path.resolve('node_modules/electron/dist/electron.exe');
const bundle = path.join(root, 'test.cjs');
const launch = (mode, fixture, kill = false) => new Promise((resolve, reject) => {
  const child = spawn(executable, [bundle, mode, fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', killed = false;
  const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} timed out: ${output}`)); }, 60000);
  child.stdout.on('data', value => { output += value; if (kill && output.includes('KILL_POINT') && !killed) { killed = true; child.kill('SIGKILL'); } });
  child.stderr.on('data', value => { output += value; }); child.once('error', reject);
  child.once('exit', code => { clearTimeout(timeout); killed || code === 0 ? resolve(output) : reject(new Error(`${mode} failed (${code}): ${output}`)); });
});
try {
  await Promise.all([
    build({ entryPoints: ['scripts/fixtures/workspace-migration-harness.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: bundle }),
    build({ entryPoints: ['electron/workspaceMigrationWorker.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: path.join(root, 'workspaceMigrationWorker.js') }),
  ]);
  for (const mode of ['normal', 'cancel', 'cancel-worker', 'activation-failure']) console.log((await launch(mode, path.join(fixtureRoot, mode))).trim());
  for (const point of ['prepare', 'copy', 'map', 'validated', 'publish', 'commit']) {
    const fixture = path.join(fixtureRoot, `kill-${point}`); await launch(`kill-${point}`, fixture, true);
    console.log((await launch('resume', fixture)).trim()); console.log(`Forced process termination at ${point}: recovery passed`);
  }
  const changed = path.join(fixtureRoot, 'source-change'); await launch('kill-copy', changed, true); console.log((await launch('source-change', changed)).trim());
  const stale = path.join(fixtureRoot, 'stale-worker-output'); await launch('kill-map', stale, true); console.log((await launch('stale-worker-output', stale)).trim());
  console.log('Workspace migration verification passed: cancellation including worker termination, six crash boundaries including preparation, source edits, real memory reads, paths, original data and secrets.');
} finally {
  assert.ok(root.startsWith(staging + path.sep + 'workspace-migration-')); fs.rmSync(root, { recursive: true, force: true });
  assert.ok(fixtureRoot.startsWith(path.join(os.tmpdir(), 'trellora-workspace-migration-'))); fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
