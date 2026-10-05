import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const read = (filePath) => readFileSync(path.join(rootDir, filePath), 'utf8');

const searchModal = read('src/components/SearchModal.tsx');
assert.match(searchModal, /scrollIntoView\(\{ block: 'nearest' \}\)/);
assert.match(searchModal, /关键词搜索可用/);
assert.doesNotMatch(searchModal, /role="tablist"|Ctrl\+←→|语义搜索|综合搜索/);

const knowledgePanel = read('src/components/KnowledgePanel.tsx');
assert.match(knowledgePanel, /window\.addEventListener\('resize', handleWindowResize\)/);
assert.match(knowledgePanel, /minimumWorkspaceWidth/);
assert.match(knowledgePanel, /constrainPanelWidth/);
assert.match(knowledgePanel, /preferredWidthRef/);

const preload = read('electron/preload.ts');
const electronTypes = read('src/electron.d.ts');
const agentRuntime = read('electron/knowledge/agentRuntime.ts');
for (const exposedSurface of [preload, electronTypes]) {
  assert.doesNotMatch(exposedSurface, /getQdrantStatus|synchronizeSemanticIndex|searchSemantically|getSemanticIndexStatus|rebuildSemanticIndex|cancelSemanticIndex|getKnowledgeGraph|getRelatedNotes/);
}
assert.doesNotMatch(agentRuntime, /\.\/semanticSearch|Extract entities and relations|semanticSearch/);

const userFacingSources = [
  'electron/importFiles.ts',
  'electron/workspaceService.ts',
  'electron/pathGuards.ts',
  'electron/libraryUiState.ts',
  'electron/libraryFileOps.ts',
  'electron/libraryServices.ts',
  'electron/knowledge/ollamaClient.ts',
  'electron/knowledge/aiProvider.ts',
  'electron/knowledge/agentGraph.ts',
  'electron/noteIndex.ts',
  'electron/treeOrder.ts',
  'electron/main.ts',
].map(read).join('\n');
for (const staleMessage of [
  'Import source does not exist',
  'Unsupported text file',
  'No valid note library is selected',
  'Invalid AI provider configuration',
  'OS secure storage is unavailable',
  'Prompt must not be empty',
  'Model did not return any content',
]) {
  assert.doesNotMatch(userFacingSources, new RegExp(staleMessage));
}

console.log('PRD closeout verification passed: keyword search, responsive right panel, removed connection APIs, and Chinese errors');
