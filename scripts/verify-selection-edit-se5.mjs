import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const rootDir = process.cwd();
const read = (relativePath) => fs.readFile(path.join(rootDir, relativePath), 'utf8');
const extendedSourcesBundle = path.join(rootDir, 'scripts', '.verify-selection-edit-se5-sources.cjs');
const librarySnapshotsBundle = path.join(rootDir, 'scripts', '.verify-selection-edit-se5-snapshots.cjs');

const [sources, coordinator, main, settings, types, expansionTypes, workspace] = await Promise.all([
  read('electron/knowledge/selectionEditSources/extendedSources.ts'),
  read('electron/knowledge/selectionEditCoordinator.ts'),
  read('electron/main.ts'),
  read('electron/knowledge/selectionExpansionSettings.ts'),
  read('electron/knowledge/selectionEditTypes.ts'),
  read('electron/knowledge/selectionExpansionTypes.ts'),
  read('src/components/assistant/SelectionExpansionWorkspace.tsx'),
]);

assert.match(sources, /searchLibraryNoteCandidates/, '同库来源必须先做候选定位。');
assert.match(sources, /tools\.readNoteRange/, '同库来源必须按行受限深读，不能把候选摘要当证据。');
assert.match(sources, /LibraryEvidenceLedger/, '同库深读必须绑定不可变快照证据账本。');
assert.match(sources, /retrieveKnowledgeBaseEvidence/, '资料库语义定位必须复用 knowledge_search 底层链路。');
assert.match(sources, /searchMaterialChunks/, '资料库字面量定位必须复用 grep_chunks 底层链路。');
assert.match(sources, /readMaterialParentWindow/, '资料库证据必须经过 list_knowledge_chunks 等价的父块深读。');
assert.match(sources, /window: 0/, '资料库深读必须保持单父块受限窗口。');
assert.match(sources, /readState: 'candidate'/, '候选和深读状态必须被分层记录。');
assert.match(sources, /detectSelectionSourceConflicts/, '来源表述差异必须以可见回执返回。');
assert.match(coordinator, /collectSelectionEditExtendedSources/, '统一协调器必须接入 SE-5 外部本地来源。');
assert.match(coordinator, /collectSelectionEditExtendedSources/, 'SE-5 本地来源仍必须通过统一外部来源协调器。');
assert.match(main, /createLibraryNoteSnapshotMap/, '主进程必须为同库读取创建冻结快照。');
assert.match(main, /getActiveMaterialsLibraryPath/, '资料库读取必须显式绑定当前已注册资料库。');
assert.match(settings, /localSourcesEnabled/, '扩展本地来源只能通过 local-sources/full 灰度公开。');
assert.match(types, /candidates: Array/, '统一回执必须保留候选，而不是伪装为证据。');
assert.match(types, /conflicts: Array/, '统一回执必须包含可见的冲突提示。');
assert.match(expansionTypes, /sourceKind: SelectionEditFactSourceKind/, '扩写兼容层必须保留真实来源类别。');
assert.match(workspace, /已深读原文/, '工作区必须将深读证据与候选分开展示。');
assert.match(workspace, /来源定位/, '工作区必须展示来源定位卡片。');
assert.match(workspace, /可能存在来源表述差异/, '工作区必须显示来源冲突。');

try {
  await Promise.all([fs.rm(extendedSourcesBundle, { force: true }), fs.rm(librarySnapshotsBundle, { force: true })]);
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditSources', 'extendedSources.ts')],
      outfile: extendedSourcesBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'better-sqlite3', 'sqlite-vec'],
      logLevel: 'silent',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryNoteSnapshot.ts')],
      outfile: librarySnapshotsBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
  ]);
  const { collectSelectionEditExtendedSources } = await import(`${pathToFileURL(extendedSourcesBundle).href}?v=${Date.now()}`);
  const { createLibraryNoteSnapshotMap } = await import(`${pathToFileURL(librarySnapshotsBundle).href}?v=${Date.now()}`);
  const libraryPath = path.join(rootDir, '.se5-fixture-library');
  const currentPath = path.join(libraryPath, 'current.md');
  const referencePath = path.join(libraryPath, 'reference.md');
  const currentMarkdown = '选区：恢复窗口。';
  const referenceMarkdown = '恢复窗口规定第一次自动重试前等待 7 秒。';
  const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  const snapshotMap = createLibraryNoteSnapshotMap({
    libraryPath,
    sessionId: 'session-se5-test',
    revision: 1,
    index: {
      notes: [
        { path: currentPath, title: '当前笔记', contentHash: hash(currentMarkdown), rawMarkdown: currentMarkdown, headings: [] },
        { path: referencePath, title: '参考笔记', contentHash: hash(referenceMarkdown), rawMarkdown: referenceMarkdown, headings: [] },
      ],
    },
  });
  const result = await collectSelectionEditExtendedSources({
    goals: [{ goalId: 'goal-1', kind: 'support', question: '恢复窗口的等待规则', queryTerms: ['恢复窗口'], required: true }],
    enabled: { noteLibrary: true, materialsLibrary: false, web: false },
    runtime: {
      noteLibrary: {
        snapshotMap,
        sessionId: 'session-se5-test',
        currentNotePath: currentPath,
        keywordSearch: () => [{
          path: referencePath,
          title: '参考笔记',
          score: 0.9,
          snippet: 'CANDIDATE-SUMMARY-MUST-NOT-BECOME-EVIDENCE',
        }],
      },
    },
    signal: new AbortController().signal,
    maxEvidenceCharacters: 1_000,
  });
  assert.equal(result.receipt.candidates.length, 1, '同库检索命中必须保留为单独候选回执。');
  assert.equal(result.receipt.candidates[0].readState, 'deep-read', '候选必须在受限原文读取后才标为已深读。');
  assert.equal(result.evidence.length, 1, '只应接纳实际深读到的一条同库原文。');
  assert.equal(result.evidence[0].content, referenceMarkdown, '证据正文必须来自原文行块。');
  assert.doesNotMatch(result.evidence[0].content, /CANDIDATE-SUMMARY/, '候选摘要绝不能进入证据正文。');
  assert.match(result.evidence[0].locator, /reference\.md .*L1-L1/, '深读证据必须保留原笔记与行定位。');
} finally {
  await Promise.all([fs.rm(extendedSourcesBundle, { force: true }), fs.rm(librarySnapshotsBundle, { force: true })]);
}

console.log('Selection edit SE-5 verification passed');
