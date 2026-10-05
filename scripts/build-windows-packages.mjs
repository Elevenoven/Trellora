import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// NSIS LogicLib generates includes in TMP. A private writable directory avoids
// Windows system-temp virtualization losing those files during assisted builds.
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'windows-builder-'));
try {
  const cli = createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: process.cwd(), env: { ...process.env, TEMP: temporary, TMP: temporary }, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Windows package build exited ${code}`)));
  });
} finally {
  if (path.dirname(temporary) !== staging) throw new Error('Build temporary directory escaped staging');
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
