import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-library-ui-state');
const libraryDir = path.join(outDir, 'library');
const serviceOutFile = path.join(outDir, 'libraryUiState.cjs');
const utilityOutFile = path.join(outDir, 'fileTreeState.cjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(libraryDir, 'Projects', 'Sub'), { recursive: true });
mkdirSync(path.join(libraryDir, 'Archive'), { recursive: true });
writeFileSync(path.join(libraryDir, 'Projects', 'Sub', 'Deep.md'), '# Deep\n', 'utf8');

await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'libraryUiState.ts')],
    outfile: serviceOutFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'src', 'utils', 'fileTreeState.ts')],
    outfile: utilityOutFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
]);

const service = await import(pathToFileURL(serviceOutFile).href);
const treeState = await import(pathToFileURL(utilityOutFile).href);
const projectsPath = path.join(libraryDir, 'Projects');
const subPath = path.join(projectsPath, 'Sub');
const archivePath = path.join(libraryDir, 'Archive');
const deepPath = path.join(subPath, 'Deep.md');

const initial = service.getLibraryUiState(libraryDir);
assert.deepEqual(new Set(initial.collapsedFolderPaths), new Set([projectsPath, subPath, archivePath]));

assert.throws(
  () => service.saveLibraryUiState(libraryDir, { collapsedFolderPaths: [path.dirname(libraryDir)] }),
  /位于当前笔记库内/,
);

const saved = service.saveLibraryUiState(libraryDir, {
  collapsedFolderPaths: [projectsPath, subPath],
  knowledgeMap: { nodeKinds: ['note', 'tag'], edgeKinds: ['references'], hideIsolated: true },
});
assert.deepEqual(saved.collapsedFolderPaths, [projectsPath, subPath].sort((a, b) => a.localeCompare(b)));
assert.throws(
  () => service.saveLibraryUiState(libraryDir, { knowledgeMap: { nodeKinds: ['unknown'], edgeKinds: [], hideIsolated: true } }),
  /知识地图状态格式无效/,
);

const statePath = path.join(libraryDir, '.menghan-meta', 'ui-state.json');
assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).schemaVersion, 1);

const workPath = path.join(libraryDir, 'Work');
renameSync(projectsPath, workPath);
service.migrateLibraryUiStatePath(libraryDir, projectsPath, workPath);
const migrated = service.getLibraryUiState(libraryDir);
assert.deepEqual(new Set(migrated.collapsedFolderPaths), new Set([workPath, path.join(workPath, 'Sub')]));
assert.equal(migrated.knowledgeMap.hideIsolated, true);

rmSync(workPath, { recursive: true, force: true });
const pruned = service.pruneLibraryUiState(libraryDir);
assert.deepEqual(pruned.collapsedFolderPaths, []);

writeFileSync(statePath, '{broken json', 'utf8');
const recovered = service.getLibraryUiState(libraryDir);
assert.deepEqual(recovered.collapsedFolderPaths, [archivePath]);

const files = [{
  path: archivePath,
  name: 'Archive',
  isDirectory: true,
  kind: 'directory',
  children: [{
    path: path.join(archivePath, 'Nested'),
    name: 'Nested',
    isDirectory: true,
    kind: 'directory',
    children: [{ path: path.join(archivePath, 'Nested', 'Deep.md'), name: 'Deep.md', isDirectory: false, kind: 'markdown' }],
  }],
}];
assert.deepEqual(treeState.collectDirectoryPaths(files), [archivePath, path.join(archivePath, 'Nested')]);
assert.deepEqual(treeState.collapseExceptCurrentPath(files, path.join(archivePath, 'Nested', 'Deep.md')), []);
assert.deepEqual(treeState.reconcileCollapsedFolderPaths(files, [archivePath, 'missing']), [archivePath]);

console.log('Library UI state verification passed');
