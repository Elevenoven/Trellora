import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-workspace-service');
const outFile = path.join(outDir, 'workspaceService.cjs');
const workspaceDir = path.join(outDir, 'workspace');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'workspaceService.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { validateSystemWorkspaceDirectory, validateWorkspaceDirectory } = await import(pathToFileURL(outFile).href);

const systemWorkspace = validateSystemWorkspaceDirectory(path.join(outDir, 'system-workspace'));
assert.equal(systemWorkspace.path, path.resolve(path.join(outDir, 'system-workspace')));
assert.equal(existsSync(systemWorkspace.systemDirectory), true);

const validated = validateWorkspaceDirectory(workspaceDir);
assert.equal(validated.path, path.resolve(workspaceDir));
assert.equal(validated.metaDirectory, path.join(path.resolve(workspaceDir), '.menghan-meta'));
assert.equal(existsSync(validated.metaDirectory), true);

const filePath = path.join(outDir, 'not-a-folder.md');
writeFileSync(filePath, '# file', 'utf8');
assert.throws(() => validateWorkspaceDirectory(filePath), /不是文件夹/);
assert.throws(() => validateWorkspaceDirectory(path.join(outDir, 'missing')), /不存在/);

console.log('Workspace service verification passed');
