import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-file-tree');
const opsOutFile = path.join(outDir, 'libraryFileOps.cjs');
const indexOutFile = path.join(outDir, 'noteIndex.cjs');
const libraryDir = path.join(outDir, 'library');
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'libraryFileOps.ts')],
  outfile: opsOutFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

await build({
  entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')],
  outfile: indexOutFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  createFolderInLibrary,
  moveEntryInLibrary,
  renameEntryInLibrary,
  saveDirectoryOrder,
} = await import(pathToFileURL(opsOutFile).href);

const {
  buildNoteIndex,
} = await import(pathToFileURL(indexOutFile).href);

const projectsDir = createFolderInLibrary(libraryDir, null, 'Projects');
const archiveDir = createFolderInLibrary(libraryDir, null, 'Archive');
assert.equal(existsSync(projectsDir), true);
assert.equal(existsSync(archiveDir), true);

const alphaPath = path.join(libraryDir, 'Alpha.md');
const betaPath = path.join(libraryDir, 'Beta.md');
const dataPath = path.join(libraryDir, 'Data.json');
writeFileSync(alphaPath, '# Alpha\n', 'utf8');
writeFileSync(betaPath, '# Beta\n', 'utf8');
writeFileSync(dataPath, '{ "value": 1 }', 'utf8');

const reorderedBeta = await moveEntryInLibrary(libraryDir, betaPath, libraryDir, {
  type: 'after',
  siblingPath: dataPath,
});
assert.equal(reorderedBeta, betaPath);
assert.equal(existsSync(betaPath), true);
assert.deepEqual(buildNoteIndex(libraryDir).fileTree.map((node) => node.name), [
  'Projects',
  'Archive',
  'Alpha.md',
  'Data.json',
  'Beta.md',
]);

const movedAlpha = await moveEntryInLibrary(libraryDir, alphaPath, projectsDir, { type: 'inside' });
assert.equal(movedAlpha, path.join(projectsDir, 'Alpha.md'));
assert.equal(existsSync(movedAlpha), true);
assert.equal(existsSync(alphaPath), false);

const renamedProjects = await renameEntryInLibrary(libraryDir, projectsDir, 'Work');
assert.equal(renamedProjects, path.join(libraryDir, 'Work'));
assert.equal(existsSync(path.join(renamedProjects, 'Alpha.md')), true);

mkdirSync(path.join(renamedProjects, 'Sub'), { recursive: true });
await assert.rejects(
  () => moveEntryInLibrary(libraryDir, renamedProjects, path.join(renamedProjects, 'Sub'), { type: 'inside' }),
  /移动到自身内部/,
);

saveDirectoryOrder(libraryDir, libraryDir, [
  path.join(libraryDir, 'Beta.md'),
  renamedProjects,
  archiveDir,
  dataPath,
]);

const index = buildNoteIndex(libraryDir);
assert.deepEqual(index.fileTree.map((node) => node.name), ['Beta.md', 'Work', 'Archive', 'Data.json']);
assert.deepEqual(index.fileTree.map((node) => node.kind), ['markdown', 'directory', 'directory', 'text']);

const betaNode = index.fileTree.find((node) => node.name === 'Beta.md');
const dataNode = index.fileTree.find((node) => node.name === 'Data.json');
const workNode = index.fileTree.find((node) => node.name === 'Work');
assert.equal(betaNode.title, 'Beta');
assert.equal(dataNode.title, 'Data');
assert.equal(workNode.children.some((child) => child.name === 'Alpha.md'), true);

const orderFile = path.join(libraryDir, '.menghan-meta', 'tree-order.json');
assert.equal(JSON.parse(readFileSync(orderFile, 'utf8')).version, 1);

console.log('File tree verification passed');
