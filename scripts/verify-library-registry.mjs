import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-library-registry');
const sourceDir = path.join(outDir, 'source');
const firstLibrary = path.join(sourceDir, '第一本库');
const secondLibrary = path.join(sourceDir, '第二本库');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(firstLibrary, '项目'), { recursive: true });
mkdirSync(secondLibrary, { recursive: true });
const outFile = path.join(outDir, 'libraryRegistry.cjs');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'libraryRegistry.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  activateRegisteredLibrary,
  listRegisteredLibraries,
  registerAndActivateLibrary,
  removeRegisteredLibrary,
  summarizeRegisteredLibraries,
} = await import(pathToFileURL(outFile).href);

const values = new Map();
const store = {
  get: (key) => values.get(key),
  set: (key, value) => values.set(key, value),
  delete: (key) => values.delete(key),
};

registerAndActivateLibrary(store, firstLibrary, new Date('2026-08-18T01:00:00Z'));
registerAndActivateLibrary(store, secondLibrary, new Date('2026-08-18T02:00:00Z'));
activateRegisteredLibrary(store, firstLibrary, new Date('2026-08-18T03:00:00Z'));

assert.deepEqual(listRegisteredLibraries(store).map((library) => library.path), [path.resolve(firstLibrary), path.resolve(secondLibrary)]);
const summaries = summarizeRegisteredLibraries(store, firstLibrary, '可用');
assert.equal(summaries.find((library) => library.path === path.resolve(firstLibrary))?.isActive, true);
assert.equal(summaries.find((library) => library.path === path.resolve(firstLibrary))?.noteCount, 0);
assert.equal(summaries.find((library) => library.path === path.resolve(secondLibrary))?.exists, true);

removeRegisteredLibrary(store, secondLibrary);
assert.equal(listRegisteredLibraries(store).length, 1);
assert.throws(() => activateRegisteredLibrary(store, secondLibrary), /尚未注册/);

console.log('Library registry verification passed');
