import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import * as esbuild from 'esbuild';

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const stagingDirectory = path.join(
  projectRoot,
  '.package-staging',
  'verify-assistant-cancellation-race',
);

async function bundleModule(entryPoint, outputFile) {
  await esbuild.build({
    entryPoints: [path.join(projectRoot, entryPoint)],
    outfile: outputFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
  });
}

await rm(stagingDirectory, { recursive: true, force: true });

const snapshotModulePath = path.join(stagingDirectory, 'current-note-snapshot.cjs');
const lifecycleModulePath = path.join(stagingDirectory, 'assistant-turn-lifecycle.cjs');

await Promise.all([
  bundleModule('electron/knowledge/currentNoteSnapshot.ts', snapshotModulePath),
  bundleModule('src/utils/assistantTurnLifecycle.ts', lifecycleModulePath),
]);

const { createCurrentNoteSnapshot, matchesCurrentNoteSnapshot } = require(snapshotModulePath);
const { markAssistantTurnCancelled } = require(lifecycleModulePath);

const markdown = '# 当前笔记\n\n正在测试取消竞态。';
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:\\Notes',
  notePath: 'C:\\Notes\\current.md',
  title: '当前笔记',
  markdown,
  contentHash,
  headings: [],
});

assert.equal(
  matchesCurrentNoteSnapshot(snapshot, {
    path: 'C:\\Notes\\current.md',
    contentHash,
  }),
  true,
  'An unrelated library revision must not stale an unchanged current note.',
);
assert.equal(
  matchesCurrentNoteSnapshot(snapshot, {
    path: 'C:\\Notes\\current.md',
    contentHash: 'changed-content-hash',
  }),
  false,
  'A changed current note must stale the captured snapshot.',
);
assert.equal(
  matchesCurrentNoteSnapshot(snapshot, {
    path: 'C:\\Notes\\another.md',
    contentHash,
  }),
  false,
  'Another note with the same content must not satisfy the captured snapshot.',
);
assert.equal(matchesCurrentNoteSnapshot(snapshot, undefined), false);

const originalMessages = [
  {
    id: 'request-active',
    state: 'pending',
    content: '已经生成的部分回答',
    statusMessage: '正在执行当前笔记问答...',
  },
  {
    id: 'request-complete',
    state: 'complete',
    statusMessage: undefined,
  },
  {
    id: 'request-other',
    state: 'streaming',
    statusMessage: '正在生成...',
  },
];
const settledMessages = markAssistantTurnCancelled(originalMessages, 'request-active');

assert.equal(originalMessages[0].state, 'pending', 'The helper must not mutate React state.');
assert.equal(settledMessages[0].state, 'cancelled');
assert.equal(settledMessages[0].content, '已经生成的部分回答', 'Stopping must preserve the visible answer prefix.');
assert.equal(settledMessages[0].statusMessage, undefined);
assert.equal(settledMessages[1], originalMessages[1]);
assert.equal(settledMessages[2], originalMessages[2]);

const knowledgePanelSource = await readFile(
  path.join(projectRoot, 'src/components/KnowledgePanel.tsx'),
  'utf8',
);
assert.match(knowledgePanelSource, /const cancelAndSettleActiveTurn = useCallback/);
assert.match(
  knowledgePanelSource,
  /title="停止生成"[^>]+onClick=\{cancelAndSettleActiveTurn\}/,
  'The explicit stop button must freeze the visible turn before late main-process events arrive.',
);
assert.match(knowledgePanelSource, /已停止生成；已输出内容已保留。/);
assert.match(
  knowledgePanelSource,
  /turn\.status === 'cancelled' \? 'cancelled' as const : 'error' as const/,
  'Restored cancelled turns must keep the stopped state instead of looking like failures.',
);
assert.match(
  knowledgePanelSource,
  /previousNotePathRef\.current[\s\S]{0,700}cancelAndSettleActiveTurn\(\)/,
  'Switching notes must settle the visible turn before the async cancel event returns.',
);

const revisionEffectStart = knowledgePanelSource.indexOf(
  'const previous = previousRevisionRef.current;',
);
const revisionEffectEnd = knowledgePanelSource.indexOf(
  '}, [props.assistantContextRevision]);',
  revisionEffectStart,
);
assert.ok(revisionEffectStart >= 0 && revisionEffectEnd > revisionEffectStart);
const revisionEffect = knowledgePanelSource.slice(revisionEffectStart, revisionEffectEnd);
assert.doesNotMatch(
  revisionEffect,
  /cancelActiveTurn|cancelAndSettleActiveTurn|activeRequestIdRef|setActiveRequestId/,
  'A library-wide revision must not cancel an active current-note turn in the renderer.',
);

const mainSource = await readFile(path.join(projectRoot, 'electron/main.ts'), 'utf8');
assert.match(
  mainSource,
  /libraryRevision === snapshotRevision[\s\S]{0,260}matchesCurrentNoteSnapshot/,
  'The main process must revalidate the current note identity after a library revision.',
);
assert.ok(
  (mainSource.match(/isSnapshotCurrent: isResolvedContextCurrent/g) ?? []).length >= 3,
  'Planner, agent, and direct-answer paths must share the current-note freshness check.',
);

console.log('Assistant cancellation-race verification passed.');
