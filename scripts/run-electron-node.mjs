import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), process.argv.slice(2), {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, shell: false,
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
