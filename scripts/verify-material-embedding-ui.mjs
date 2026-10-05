import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const tempDir = mkdtempSync(path.join(root, '.embedding-ui-test-'));
const output = path.join(tempDir, 'materials-pipeline.js');

try {
  await build({
    entryPoints: [path.join(root, 'src', 'components', 'MaterialsPipelineView.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: output,
    external: ['react', 'react-dom', '@mantine/core', 'lucide-react'],
    logLevel: 'silent',
  });

  const view = readFileSync(path.join(root, 'src', 'components', 'MaterialsPipelineView.tsx'), 'utf8');
  const settings = readFileSync(path.join(root, 'src', 'components', 'SettingsPanel.tsx'), 'utf8');
  const preload = readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
  const main = readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
  const types = readFileSync(path.join(root, 'src', 'electron.d.ts'), 'utf8');

  assert.match(view, /testMaterialEmbeddingProfile/);
  assert.match(view, /lockMaterialEmbeddingProfile/);
  assert.match(view, /已测试/);
  assert.match(view, /确认并锁定/);
  assert.match(view, /LOCKED · 已锁定/);
  assert.match(view, /08-vectors\/未生成/);
  assert.match(view, /id: 'vectors'/);
  assert.match(view, /stage\.id === 'vectors' && stage\.status === 'pending'/);
  assert.match(view, /运行向量化/);
  assert.match(view, /progressStage\?\.status === 'RUNNING' && progressStage\.jobId === previous\.jobId/);
  assert.match(view, /selectedPipelineStatus\.stages\?\.\[pipelineProgress\.stage\]\?\.status === 'RUNNING'/);
  assert.match(view, /selectedPipelineStatus\.stages\[pipelineProgress\.stage\]\?\.jobId === pipelineProgress\.jobId/);
  assert.match(view, /\{visiblePipelineProgress \? \(/);
  assert.doesNotMatch(view, /\{pipelineProgress && selectedDocument && pipelineProgress\.documentId === selectedDocument\.id \? \(/);
  assert.doesNotMatch(view, /id: 'index'/);
  assert.doesNotMatch(view, /data=\{\['bge-m3', 'm3e-base', 'nomic-embed-text'\]\}/);
  assert.match(settings, /全局“嵌入”槽位只是新资料库的默认候选/);
  assert.doesNotMatch(preload, /rebuildMaterialChunkVectors/);
  assert.doesNotMatch(main, /ipcMain\.handle\('rebuild-material-chunk-vectors'/);
  assert.match(types, /keywords' \| 'vectors'/);
  assert.doesNotMatch(types, /rebuildMaterialChunkVectors:/);

  console.log('verify-material-embedding-ui: browser bundle, test-before-lock flow, read-only LOCKED card, real vectors stage, terminal progress cleanup, global-default guidance, and legacy renderer override removal passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
