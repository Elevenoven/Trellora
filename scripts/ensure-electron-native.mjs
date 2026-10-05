import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Do not rebuild a compatible DLL while a running desktop instance holds it open. */
function probe() {
  return spawnSync(path.resolve('node_modules/electron/dist/electron.exe'), ['scripts/verify-electron-sqlite.cjs'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}
let result = probe();
if (result.status !== 0) {
  const require = (await import('node:module')).createRequire(import.meta.url);
  const { rebuild } = await import('@electron/rebuild');
  const electronVersion = require('electron/package.json').version;
  await rebuild({ buildPath: process.cwd(), electronVersion, force: true, onlyModules: ['better-sqlite3'] });
  result = probe();
}
if (result.status !== 0) throw new Error(`Electron SQLite 不可用：${result.stderr || result.error?.message || result.status}`);
console.log('ensure-electron-native: real Electron SQLite query passed; compatible module retained');
