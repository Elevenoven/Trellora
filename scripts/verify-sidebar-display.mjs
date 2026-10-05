import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-sidebar-display');
const outFile = path.join(outDir, 'sidebarDisplay.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'sidebarDisplay.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

const { getSidebarDisplayName } = await import(pathToFileURL(outFile).href);

const importedMarkdown = {
  path: 'D:/notes/imported-alias.md',
  name: 'imported-alias.md',
  isDirectory: false,
  kind: 'markdown',
  extension: '.md',
  title: '或者使用别名',
};

assert.equal(getSidebarDisplayName(importedMarkdown), 'imported-alias');

console.log('Sidebar display verification passed');
