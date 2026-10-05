import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-library-creation');
const outFile = path.join(outDir, 'libraryCreation.cjs');
const workspaceDir = path.join(outDir, 'workspace');
const customParentDir = path.join(outDir, 'custom-parent');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(customParentDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'libraryCreation.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { createLibraryDirectory } = await import(pathToFileURL(outFile).href);
const createdInWorkspace = createLibraryDirectory({
  name: '阅读计划',
  workspacePath: workspaceDir,
  now: new Date(2026, 7, 18, 14, 5, 6),
});
assert.equal(createdInWorkspace.alias, '阅读计划');
assert.equal(path.dirname(createdInWorkspace.path), path.resolve(workspaceDir));
assert.match(path.basename(createdInWorkspace.path), /^阅读计划-20260818-140506$/);
assert.equal(existsSync(createdInWorkspace.path), true);

const createdAtCustomParent = createLibraryDirectory({
  name: '项目资料',
  workspacePath: workspaceDir,
  parentDirectoryPath: customParentDir,
});
assert.equal(path.dirname(createdAtCustomParent.path), path.resolve(customParentDir));
assert.equal(path.basename(createdAtCustomParent.path), '项目资料');
assert.equal(existsSync(createdAtCustomParent.path), true);

const duplicateAtCustomParent = createLibraryDirectory({
  name: '项目资料',
  workspacePath: workspaceDir,
  parentDirectoryPath: customParentDir,
});
assert.equal(path.basename(duplicateAtCustomParent.path), '项目资料 1');

console.log('Library creation verification passed');
