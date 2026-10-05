import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const notePath = path.join(fixtureDir, 'notes', 'all-evidence-baseline.md');
const stagingDir = path.join(rootDir, '.package-staging', 'verify-current-note-evidence-identity');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

await Promise.all([
  bundle('electron/knowledge/currentNoteAgentGraph.ts', 'graph.cjs'),
  bundle('electron/knowledge/currentNoteSnapshot.ts', 'snapshot.cjs'),
  bundle('electron/knowledge/currentNoteEvidenceLedger.ts', 'ledger.cjs'),
  bundle('electron/knowledge/searchPlanDriver.ts', 'plan-driver.cjs'),
  bundle('electron/knowledge/noteConversationMemory.ts', 'memory.cjs'),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(path.join(stagingDir, 'graph.cjs')).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(path.join(stagingDir, 'snapshot.cjs')).href);
const { CurrentNoteEvidenceLedger } = await import(pathToFileURL(path.join(stagingDir, 'ledger.cjs')).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(path.join(stagingDir, 'plan-driver.cjs')).href);
const { NoteConversationMemory, createMemoryEntry } = await import(pathToFileURL(path.join(stagingDir, 'memory.cjs')).href);

const markdown = fs.readFileSync(notePath, 'utf8');
const lines = markdown.split('\n');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: '阶段 2 Agent 夹具',
  contentHash: sha256(markdown),
  markdown,
  headings: lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/u.exec(line);
    return match ? [{ id: `heading-${index + 1}`, level: match[1].length, text: match[2], line: index + 1 }] : [];
  }),
  revision: 1,
});

const plannerOutput = {
  goals: [{
    goalId: 'goal-materialized',
    question: '核对全量证据。',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'requirement-materialized', label: '至少一条当前快照原文。', minEvidence: 1 }],
    queryTerms: ['EvidenceAnchor', 'ConflictSignal'],
  }],
};
const planner = createCurrentNotePlanDriver({
  async generateJson() {
    return plannerOutput;
  },
});
let decisions = 0;
const toolEvents = [];
const driver = {
  async decide() {
    decisions += 1;
    if (decisions === 1) return { type: 'tool', goalId: 'goal-materialized', tool: 'search_note', arguments: { terms: ['temporary-model-term'] }, publicRationale: '执行计划词搜索。' };
    return { type: 'answer', answer: '夹具答案保持受控。', citations: [], completeness: 'partial' };
  },
  async synthesize({ prompt }) {
    const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
    return { type: 'answer', answer: '夹具答案保持受控。', citations: evidenceId ? [evidenceId] : [], completeness: 'partial' };
  },
};
const result = await runCurrentNoteAgent({
  snapshot,
  question: '请核对当前笔记的全量证据。',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver,
  planner,
  planMode: 'current-note',
  assistantEvidenceProjectionMode: 'all-retrieved',
  evidenceCompressionMode: 'observe',
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'stage2-fixture-session',
  isSnapshotCurrent: () => true,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxDecisionRounds: 3, maxModelCalls: 6 },
  onToolEvent: (event) => toolEvents.push(event),
});

const searchEvents = toolEvents.filter((event) => event.tool === 'search_note');
assert.equal(searchEvents.filter((event) => event.state === 'started').length, 1, '自动物化不能增加 search_note 之外的工具调用。');
assert.equal(toolEvents.some((event) => event.tool === 'read_note_range'), false, 'all-retrieved 命中后不应再要求模型逐条 read。');
assert.ok(result.evidence.length > 0, `成功搜索命中必须进入当前快照证据目录：${JSON.stringify({ decisions, toolEvents, evidence: result.evidence, stats: result.toolStats })}`);
const serializedEvents = JSON.stringify(toolEvents);
assert.equal(serializedEvents.includes(markdown), false, '公开工具事件不得输出完整原文。');
assert.equal(serializedEvents.includes(notePath), false, '公开工具事件不得输出路径。');
assert.equal(serializedEvents.includes('provider'), false, '公开工具事件不得输出 Provider 请求体字段。');
for (const citation of result.evidence) {
  const source = lines.slice(citation.lineFrom - 1, citation.lineTo).join('\n');
  assert.equal(citation.quoteHash, sha256(source), 'citation 必须回到当前 Snapshot 的精确原文哈希。');
}

const oldModeEvents = [];
let oldModeDecisions = 0;
const oldModeResult = await runCurrentNoteAgent({
  snapshot,
  question: '请核对当前笔记的全量证据。',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: {
    async decide({ prompt }) {
      oldModeDecisions += 1;
      if (oldModeDecisions === 1) return { type: 'tool', tool: 'search_note', arguments: { terms: ['EvidenceAnchor'] }, publicRationale: '旧模式只定位候选。' };
      if (oldModeDecisions === 2) {
        const block = snapshot.blocks.find((candidate) => candidate.text.includes('EvidenceAnchor'));
        return { type: 'tool', tool: 'read_note_range', arguments: { lineFrom: block.lineFrom, lineTo: block.lineTo }, publicRationale: '旧模式显式读取原文。' };
      }
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return { type: 'answer', answer: '旧行为夹具。', citations: evidenceId ? [evidenceId] : [], completeness: 'partial' };
    },
    async synthesize() { return { type: 'answer', answer: '旧行为夹具。', citations: [], completeness: 'not-found' }; },
  },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'stage2-fixture-old-mode',
  isSnapshotCurrent: () => true,
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
  onToolEvent: (event) => oldModeEvents.push(event),
});
assert.ok(oldModeResult.evidence.length > 0, '关闭 all-retrieved 后仍应由显式 read 进入证据目录。');
assert.ok(oldModeEvents.some((event) => event.tool === 'search_note'), '旧模式仍应保留搜索导航。');
assert.ok(oldModeEvents.some((event) => event.tool === 'read_note_range'), '旧模式必须保留显式原文读取。');

const memoryLedger = new CurrentNoteEvidenceLedger(snapshot, 24_000);
const memoryBlock = snapshot.blocks.find((candidate) => candidate.text.includes('EvidenceAnchor'));
const memoryRecord = memoryLedger.add({
  blockIds: [memoryBlock.blockId],
  headingPath: memoryBlock.headingPath,
  lineFrom: memoryBlock.lineFrom,
  lineTo: memoryBlock.lineTo,
  text: memoryBlock.text,
  matchedTerms: [],
  supports: ['跨上下文验证'],
  sourceToolCallId: 'memory-source',
  admission: 'explicit-read',
}).record;
const scopedMemory = new NoteConversationMemory();
scopedMemory.remember('stage2-memory-scope', createMemoryEntry({
  snapshot,
  question: 'EvidenceAnchor',
  evidence: [memoryRecord],
  answer: '记忆夹具答案。',
  completeness: 'complete',
}));
const memoryReuse = await runCurrentNoteAgent({
  snapshot,
  question: 'EvidenceAnchor',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: {
    async decide() { throw new Error('同一 session 命中记忆后不应重新 decide。'); },
    async synthesize() { return { type: 'answer', answer: '记忆夹具答案。', citations: [memoryRecord.evidenceId], completeness: 'complete' }; },
  },
  memory: scopedMemory,
  memoryScopeKey: 'stage2-memory-scope',
  isSnapshotCurrent: () => true,
});
assert.equal(memoryReuse.contextMode, 'memory-reuse', '同一 session、note、library 且 contentHash 一致时才允许 memory-reuse。');

const otherSnapshot = createCurrentNoteSnapshot({
  libraryPath: path.join(fixtureDir, 'other-library'),
  notePath: path.join(fixtureDir, 'other-library', 'other-note.md'),
  title: '另一资料库夹具',
  contentHash: sha256(markdown),
  markdown,
  headings: snapshot.headings.map((heading) => ({ id: heading.headingId, level: heading.level, text: heading.text, line: heading.lineFrom })),
  revision: 1,
});
const crossLibrary = await runCurrentNoteAgent({
  snapshot: otherSnapshot,
  question: 'EvidenceAnchor',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: {
    async decide() { return { type: 'answer', answer: '跨资料库不得复用。', citations: [], completeness: 'not-found' }; },
    async synthesize() { return { type: 'answer', answer: '跨资料库不得复用。', citations: [], completeness: 'not-found' }; },
  },
  memory: scopedMemory,
  memoryScopeKey: 'stage2-memory-scope',
  isSnapshotCurrent: () => true,
});
assert.equal(crossLibrary.contextMode, 'react-search', '不同 library/note 的快照不得串用 memory evidence。');
assert.equal(crossLibrary.evidence.length, 0);

console.log(JSON.stringify({
  ok: true,
  materializedEvidenceCount: result.evidence.length,
  searchStartedCount: searchEvents.filter((event) => event.state === 'started').length,
  oldModeEvidenceCount: oldModeResult.evidence.length,
  memoryReuseRoute: memoryReuse.contextMode,
  crossLibraryRoute: crossLibrary.contextMode,
}, null, 2));


async function bundle(entryPoint, fileName) {
  await build({
    entryPoints: [path.join(rootDir, entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(stagingDir, fileName),
    logLevel: 'silent',
  });
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
