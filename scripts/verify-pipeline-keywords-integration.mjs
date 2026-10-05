import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.keyword-integration-verification');
const keywordConfigBundle = path.join(outDir, 'keywordConfig.cjs');
const artifactStoreBundle = path.join(outDir, 'artifactStore.cjs');
const libraryPath = path.join(outDir, 'library');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({ entryPoints: ['electron/pipeline/keywordConfig.ts'], outfile: keywordConfigBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
await build({ entryPoints: ['electron/pipeline/artifactStore.ts'], outfile: artifactStoreBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });

const keywordConfig = await import(pathToFileURL(keywordConfigBundle).href);
const artifactStore = await import(pathToFileURL(artifactStoreBundle).href);
const document = {
  id: 'doc-integration',
  name: '集成测试.pdf',
  extension: '.pdf',
  relativePath: '集成测试.pdf',
  absolutePath: path.join(libraryPath, '集成测试.pdf'),
  contentHash: 'integrationhash',
  sizeBytes: 12,
};

fs.mkdirSync(path.join(libraryPath, '.menghan-meta'), { recursive: true });
const initialResources = keywordConfig.readLibraryKeywordStageResources(libraryPath);
const initialLayout = artifactStore.prepareParseLayout(libraryPath, document, '', 'p4-disabled', 'p5-structure', keywordConfig.keywordStageConfigHash(initialResources));
assert.equal(path.basename(initialLayout.keywordsDirectory), '07-keywords');
assert.equal(artifactStore.stageDirectory(initialLayout, 'keywords'), initialLayout.keywordsDirectory);
assert.deepEqual(artifactStore.stageOutputNames(initialLayout, 'keywords'), ['keywords.jsonl', 'keyword-report.json']);

const initialChunksKey = artifactStore.chunksStageKey(initialLayout);
const initialKeywordsKey = artifactStore.keywordsStageKey(initialLayout);
keywordConfig.saveLibraryKeywordConfig(libraryPath, { maxKeywords: 5 });
const configChangedResources = keywordConfig.readLibraryKeywordStageResources(libraryPath);
const configChangedLayout = artifactStore.prepareParseLayout(libraryPath, document, '', 'p4-disabled', 'p5-structure', keywordConfig.keywordStageConfigHash(configChangedResources));
assert.equal(artifactStore.chunksStageKey(configChangedLayout), initialChunksKey);
assert.notEqual(artifactStore.keywordsStageKey(configChangedLayout), initialKeywordsKey);

keywordConfig.saveLibraryKeywordDictionary(libraryPath, '访问控制\n审计留痕\n');
keywordConfig.saveLibraryKeywordStopwords(libraryPath, '其中\n');
const resourceChanged = keywordConfig.readLibraryKeywordStageResources(libraryPath);
assert.deepEqual(resourceChanged.dictionaryTerms, ['访问控制', '审计留痕']);
assert.deepEqual(resourceChanged.stopwords, ['其中']);
assert.notEqual(resourceChanged.dictionaryHash, configChangedResources.dictionaryHash);
assert.throws(() => keywordConfig.saveLibraryKeywordDictionary(libraryPath, 'x\n'), /长度/);

const tempDirectory = artifactStore.createStageTempDirectory(configChangedLayout, 'keywords', 'integration-job');
fs.writeFileSync(path.join(tempDirectory, 'keywords.jsonl'), '{"chunkId":"chunk-1"}\n', 'utf8');
fs.writeFileSync(path.join(tempDirectory, 'keyword-report.json'), JSON.stringify({ counts: { chunks: 1, keywords: 1 } }), 'utf8');
const committed = await artifactStore.commitKeywordsStage(configChangedLayout, tempDirectory);
assert.equal(path.basename(committed.artifactPath), '07-keywords');
assert.equal(committed.counts.chunks, 1);
assert.equal(artifactStore.getKeywordsStage(configChangedLayout).status, 'SUCCEEDED');
assert.equal(await artifactStore.isStageCacheValid(configChangedLayout, 'keywords'), true);
assert.equal(await artifactStore.isStageCacheValid(initialLayout, 'keywords'), false);

fs.rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-keywords-integration: library resource validation, stage order paths, cache key isolation, keyword commit, and cache validation passed');
