import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.stage1-chunking-config');
const bundlePath = path.join(outDir, 'pipeline.cjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export {
        DEFAULT_RECOMMENDED_CHUNKING_CONFIG,
        chunkingConfigHash,
        chunkingConfigPath,
        pipelineChunkingV2Enabled,
        readLibraryChunkingConfig,
        saveLibraryChunkingConfig,
      } from './electron/pipeline/chunkingConfig';
      export {
        commitChunksStage,
        commitTreeStage,
        chunksStageKey,
        invalidateStageAndDownstream,
        prepareParseLayout,
        readPipelineManifest,
        isStageCacheValid,
        treeStageKey,
      } from './electron/pipeline/artifactStore';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const api = await import(pathToFileURL(bundlePath).href);
const { DEFAULT_RECOMMENDED_CHUNKING_CONFIG: defaults } = api;

const libraryA = path.join(outDir, 'library-a');
const libraryB = path.join(outDir, 'library-b');
for (const library of [libraryA, libraryB]) mkdirSync(path.join(library, 'documents'), { recursive: true });

assert.equal(api.readLibraryChunkingConfig(libraryA).mode, 'recommended');
assert.deepEqual(api.readLibraryChunkingConfig(libraryA).parentStrategies, ['STRUCTURE', 'RECURSIVE']);
assert.equal(existsSync(api.chunkingConfigPath(libraryA)), false, '读取默认配置不应隐式写文件');

const savedA = api.saveLibraryChunkingConfig(libraryA, {
  mode: 'custom',
  parentStrategies: ['STRUCTURE', 'RECURSIVE'],
  childStrategies: ['SEMANTIC', 'RECURSIVE'],
  semanticMaxChars: 640,
});
const savedB = api.saveLibraryChunkingConfig(libraryB, {
  mode: 'custom',
  parentStrategies: ['FIXED', 'RECURSIVE'],
  childStrategies: ['FIXED'],
  childFixedTargetChars: 512,
});
assert.equal(api.readLibraryChunkingConfig(libraryA).semanticMaxChars, 640);
assert.equal(api.readLibraryChunkingConfig(libraryB).childFixedTargetChars, 512);
assert.notEqual(api.chunkingConfigHash(savedA), api.chunkingConfigHash(savedB));

assert.throws(() => api.saveLibraryChunkingConfig(libraryA, { parentMaxChars: Number.NaN }), /有限数字/);
assert.throws(() => api.saveLibraryChunkingConfig(libraryA, { parentStrategies: ['NOT_A_STRATEGY'] }), /未知/);
assert.throws(() => api.saveLibraryChunkingConfig(libraryA, { mode: 'custom', childStrategies: [] }), /至少选择/);

const legacyLibrary = path.join(outDir, 'legacy-library');
mkdirSync(path.join(legacyLibrary, 'documents'), { recursive: true });
const legacyStore = { get: (key) => key === 'pipelineStructure' ? { strategy: 'fixed', targetChars: 500, overlapChars: 80, minChars: 120, maxChars: 900 } : undefined };
const migrated = api.readLibraryChunkingConfig(legacyLibrary, legacyStore);
assert.equal(migrated.mode, 'custom');
assert.deepEqual(migrated.parentStrategies, ['FIXED', 'RECURSIVE']);
assert.deepEqual(migrated.childStrategies, ['FIXED', 'RECURSIVE']);
assert.equal(migrated.parentMinChars, 500);
assert.equal(migrated.childFixedMinChars, 120);
const migratedText = readFileSync(api.chunkingConfigPath(legacyLibrary), 'utf8');
assert.deepEqual(api.readLibraryChunkingConfig(legacyLibrary, { get: () => ({ strategy: 'heading', targetChars: 100, maxChars: 200 }) }), migrated);
assert.equal(readFileSync(api.chunkingConfigPath(legacyLibrary), 'utf8'), migratedText, '迁移完成后不应重复改写');

const failedLibrary = path.join(outDir, 'write-failure');
mkdirSync(path.join(failedLibrary, 'documents'), { recursive: true });
mkdirSync(path.join(failedLibrary, '.menghan-meta'), { recursive: true });
writeFileSync(path.join(failedLibrary, '.menghan-meta', 'config'), 'occupied', 'utf8');
assert.throws(() => api.saveLibraryChunkingConfig(failedLibrary, { mode: 'recommended' }), /写入失败/);

const sourcePath = path.join(libraryA, 'documents', 'sample.md');
writeFileSync(sourcePath, '# sample\n', 'utf8');
const document = {
  id: 'stage1-doc',
  name: 'sample.md',
  relativePath: 'documents/sample.md',
  absolutePath: sourcePath,
  extension: '.md',
  sizeBytes: 9,
  addedAt: new Date().toISOString(),
  contentHash: 'a'.repeat(64),
  vectorState: 'pending',
};

process.env.MENGHAN_PIPELINE_CHUNKING_V2 = '1';
const layout = api.prepareParseLayout(libraryA, document, '', 'ambiguity-v1', 'legacy-structure', 'keywords-v1', api.chunkingConfigHash(savedA));
for (const [directory, files] of [
  [layout.treeDirectory, ['structure.jsonl', 'structure.json', 'tree-report.json']],
  [layout.chunksDirectory, ['parents.jsonl', 'children.jsonl', 'chunks.jsonl', 'chunk-plan.json', 'chunks-report.json']],
]) {
  const temp = path.join(layout.documentRoot, `.tmp-${path.basename(directory)}`);
  mkdirSync(temp, { recursive: true });
  for (const fileName of files) writeFileSync(path.join(temp, fileName), fileName.endsWith('report.json') ? JSON.stringify({ counts: { items: 1 } }) : fileName.endsWith('.json') ? '{}' : '{}\n', 'utf8');
  if (directory === layout.treeDirectory) await api.commitTreeStage(layout, temp);
  else await api.commitChunksStage(layout, temp);
}
assert.equal(await api.isStageCacheValid(layout, 'tree'), true);
assert.equal(await api.isStageCacheValid(layout, 'chunks'), true);

const changedLayout = api.prepareParseLayout(libraryA, document, '', 'ambiguity-v1', 'legacy-structure', 'keywords-v1', api.chunkingConfigHash({ ...savedA, semanticMaxChars: 641 }));
assert.equal(await api.isStageCacheValid(changedLayout, 'tree'), true);
assert.equal(await api.isStageCacheValid(changedLayout, 'chunks'), false);
api.invalidateStageAndDownstream(changedLayout, 'chunks');
const invalidated = api.readPipelineManifest(changedLayout);
assert.equal(invalidated.stages.tree.status, 'SUCCEEDED');
assert.equal(invalidated.stages.chunks.status, 'IDLE');
assert.equal(invalidated.stages.keywords, undefined);

delete process.env.MENGHAN_PIPELINE_CHUNKING_V2;
assert.equal(api.pipelineChunkingV2Enabled(), true, '开发默认应启用 v2 父子切块');
process.env.MENGHAN_PIPELINE_CHUNKING_V2 = '0';
const legacyKeyA = api.prepareParseLayout(libraryA, document, '', 'ambiguity-v1', 'legacy-structure', 'keywords-v1', 'v2-a');
const legacyKeyB = api.prepareParseLayout(libraryA, document, '', 'ambiguity-v1', 'legacy-structure', 'keywords-v1', 'v2-b');
assert.equal(api.pipelineChunkingV2Enabled(), false);
assert.equal(api.chunksStageKey(legacyKeyA), api.chunksStageKey(legacyKeyB), '开关关闭时 legacy chunks 不应读取 v2 配置');
delete process.env.MENGHAN_PIPELINE_CHUNKING_V2;

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-chunking-config: defaults, per-library isolation, migration, atomic failure boundary, stage-key invalidation, tree reuse, and legacy flag gate passed');
