import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'library-plan-execute');
const stagingDir = path.join(rootDir, '.package-staging', 'verify-library-plan-execute');
const prebuiltDir = process.env.MENGHAN_LIBRARY_PLAN_PREBUILT_DIR ? path.resolve(process.env.MENGHAN_LIBRARY_PLAN_PREBUILT_DIR) : undefined;
const bundlePath = path.join(prebuiltDir ?? stagingDir, 'libraryPlanAgentGraph.cjs');
const noteIndexBundlePath = path.join(prebuiltDir ?? stagingDir, 'noteIndex.cjs');
if (!prebuiltDir) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });
const tempLibrary = path.join(stagingDir, 'library');
fs.cpSync(fixtureDir, tempLibrary, { recursive: true });

if (!prebuiltDir) {
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryPlanAgentGraph.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')],
    outfile: noteIndexBundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
}

const {
  createLibraryNoteSnapshotMap,
  replaceLibraryNoteSnapshotMap,
  createLibraryPlanCapsule,
  createLibraryPlanPrompt,
  runLibraryPlanAgent,
  createLibraryNoteTools,
  searchLibraryNoteCandidates,
} = await import(pathToFileURL(bundlePath).href);
const { buildNoteIndex } = await import(pathToFileURL(noteIndexBundlePath).href);

const libraryPath = tempLibrary;
const sessionId = 'session-library-a';
const firstIndex = buildNoteIndex(libraryPath);
const snapshotMap = createLibraryNoteSnapshotMap({ libraryPath, index: firstIndex, sessionId, revision: 1, indexState: 'latest' });
const records = [...snapshotMap.records.values()];
assert.equal(records.length, 2);
assert.equal(records[0].title, records[1].title, 'fixture must contain same-title notes');
assert.notEqual(records[0].noteId, records[1].noteId, 'same titles must have distinct opaque noteIds');
assert.equal(JSON.stringify(snapshotMap.notes).includes(libraryPath), false, 'public snapshot must not contain the library path');

const capsulePrompt = createLibraryPlanPrompt({
  capsule: createLibraryPlanCapsule(snapshotMap),
  question: `请核对 ${libraryPath} 中的同名标题`,
  conversation: [],
  signal: new AbortController().signal,
});
assert.equal(capsulePrompt.includes(libraryPath), false, 'planner prompt must not contain absolute paths');
assert.equal(capsulePrompt.includes('"noteId"'), true);

let keywordCalls = 0;
let semanticCalls = 0;
const candidateFor = (query) => {
  keywordCalls += 1;
  if (query.trim() === 'missing') return [];
  return firstIndex.notes.map((note, index) => ({ path: note.path, title: note.title, score: 2 - index * 0.1, snippet: `导航摘要-${index}`, terms: ['方案'] }));
};
const semanticFor = async (query) => {
  semanticCalls += 1;
  if (query.trim() === 'missing') return [];
  return firstIndex.notes.map((note, index) => ({ path: note.path, title: note.title, score: 0.8 - index * 0.05, snippet: `语义摘要-${index}` }));
};
const searchCallbacks = { keywordSearch: candidateFor, semanticSearch: semanticFor };

const basePlan = (goalId, { comparison = false, query = '方案' } = {}) => ({
  planId: `plan-${goalId}`,
  version: 1,
  originalQuestion: comparison ? '比较 Alpha 和 Beta 方案' : '核实方案',
  goals: [{
    goalId,
    question: comparison ? '分别核实 Alpha 和 Beta 方案' : '核实方案',
    evidenceKind: comparison ? 'comparison' : 'fact',
    requirements: comparison
      ? [
        { requirementId: 'req-alpha', label: 'Alpha 方案的原文依据', subject: 'Alpha', minEvidence: 1 },
        { requirementId: 'req-beta', label: 'Beta 方案的原文依据', subject: 'Beta', minEvidence: 1 },
      ]
      : [{ requirementId: 'req-fact', label: '方案的原文依据', minEvidence: 1 }],
    queryTerms: [{ term: query, source: 'planner' }],
    status: 'pending',
    evidenceBindings: [],
    conflictBindings: [],
  }],
  activeGoalId: goalId,
  status: 'active',
  revisionCount: 0,
  goalUpdateCount: 0,
  createdAt: '2026-08-22T08:00:00.000Z',
  updatedAt: '2026-08-22T08:00:00.000Z',
});

const tool = (goalId, name, argumentsValue, planPatch) => ({ type: 'tool', goalId, tool: name, arguments: argumentsValue, publicRationale: `核实 ${name}`, ...(planPatch ? { planPatch } : {}) });

const comparisonActions = (goalId) => {
  let step = 0;
  let noteIds = [];
  return {
    async decide({ prompt }) {
      if (step === 0) { step += 1; return tool(goalId, 'search_note_library', { limit: 8 }); }
      if (step === 1) { step += 1; noteIds = [...snapshotMap.records.keys()]; return tool(goalId, 'read_library_note_range', { noteId: noteIds[0], lineFrom: 5, lineTo: 5 }); }
      if (step === 2) { step += 1; return tool(goalId, 'read_library_note_range', { noteId: noteIds[1], lineFrom: 5, lineTo: 5 }); }
      const evidenceIds = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/g) ?? [])];
      const version = Number(prompt.match(/planVersion=(\d+)/)?.[1] ?? 0);
      step += 1;
      return {
        type: 'answer',
        answer: '两个方案分别有不同的原文依据。',
        citations: evidenceIds,
        completeness: 'complete',
        planPatch: {
          baseVersion: version,
          activeGoalId: null,
          goalUpdates: [{
            goalId,
            status: 'covered',
            evidenceBindings: [
              { requirementId: 'req-alpha', evidenceIds: [evidenceIds[0]] },
              { requirementId: 'req-beta', evidenceIds: [evidenceIds[1]] },
            ],
          }],
        },
      };
    },
    async synthesize() { throw new Error('comparison should answer atomically'); },
  };
};

const comparisonGoalId = 'goal-comparison';
const comparisonEvents = [];
const comparison = await runLibraryPlanAgent({
  snapshotMap,
  sessionId,
  question: '比较 Alpha 和 Beta 方案',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  signal: new AbortController().signal,
  planner: { plan: async () => basePlan(comparisonGoalId, { comparison: true }) },
  driver: comparisonActions(comparisonGoalId),
  search: searchCallbacks,
  searchMode: 'hybrid',
  isSnapshotCurrent: () => true,
  onToolEvent: (event) => comparisonEvents.push(event),
});
assert.equal(comparison.completeness, 'complete');
assert.equal(comparison.searchPlan.status, 'completed');
assert.equal(comparison.evidence.length, 2, 'both notes must contribute original evidence');
assert.equal(new Set(comparison.evidence.map((evidence) => evidence.notePath)).size, 2, 'same-title notes must not share evidence');
assert.equal(comparison.evidence.every((evidence) => evidence.libraryId === snapshotMap.libraryId && /^note-[a-f0-9]{24}$/.test(evidence.noteId)), true, 'cross-note evidence must expose scoped opaque IDs');
assert.equal(comparisonEvents.filter((event) => event.state === 'completed').filter((event) => event.tool === 'search_note_library').length, 1);
assert.equal(keywordCalls > 0, true, 'hybrid must preserve keyword search');
assert.equal(semanticCalls > 0, true, 'hybrid must preserve semantic search');

const candidateOnly = await searchLibraryNoteCandidates({ snapshotMap, sessionId, query: '方案', mode: 'hybrid', callbacks: searchCallbacks });
assert.equal(candidateOnly.results.length, 2);
assert.equal(candidateOnly.results.every((candidate) => candidate.noteId && !candidate.noteId.includes('.md')), true);
assert.equal(candidateOnly.results[0].snippet.startsWith('导航摘要-') || candidateOnly.results[0].snippet.startsWith('语义摘要-'), true);

const fallbackGoalId = 'goal-fallback';
let fallbackStep = 0;
const fallback = await runLibraryPlanAgent({
  snapshotMap,
  sessionId,
  question: '核实 missing 方案',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  signal: new AbortController().signal,
  planner: { plan: async () => basePlan(fallbackGoalId, { query: 'missing' }) },
  driver: {
    async decide({ prompt }) {
      if (fallbackStep++ === 0) return tool(fallbackGoalId, 'search_note_library', { limit: 8 });
      if (fallbackStep === 2) return tool(fallbackGoalId, 'search_note_library', { limit: 8 }, { baseVersion: 2, goalUpdates: [{ goalId: fallbackGoalId, status: 'searching', queryVariants: [{ term: 'Alpha', source: 'model-synonym' }] }] });
      if (fallbackStep === 3) return tool(fallbackGoalId, 'read_library_note_range', { noteId: records[0].noteId, lineFrom: 5, lineTo: 5 });
      const evidenceIds = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/g) ?? [])];
      const version = Number(prompt.match(/planVersion=(\d+)/)?.[1] ?? 0);
      return {
        type: 'answer', answer: '已通过受控查询变体读取 Alpha 原文。', citations: evidenceIds, completeness: 'partial',
        planPatch: { baseVersion: version, activeGoalId: null, goalUpdates: [{ goalId: fallbackGoalId, status: 'covered', evidenceBindings: [{ requirementId: 'req-fact', evidenceIds: [evidenceIds[0]] }] }] },
      };
    },
    async synthesize() { throw new Error('fallback fixture should answer after read'); },
  },
  search: searchCallbacks,
  searchMode: 'hybrid',
  isSnapshotCurrent: () => true,
});
assert.equal(fallback.searchPlan.goals[0].queryTerms.some((term) => term.term === 'alpha' && term.source === 'model-synonym'), true);
assert.equal(fallback.toolStats.calls >= 3, true, JSON.stringify({ stats: fallback.toolStats, plan: fallback.searchPlan }));

// Fuzzy candidate output is navigation only; no read means no Evidence Ledger entry.
let fuzzyStep = 0;
const fuzzy = await runLibraryPlanAgent({
  snapshotMap,
  sessionId,
  question: '核实 Ner',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  signal: new AbortController().signal,
  planner: { plan: async () => basePlan('goal-fuzzy', { query: 'Ner' }) },
  driver: {
    async decide() {
      fuzzyStep += 1;
      return fuzzyStep === 1 ? tool('goal-fuzzy', 'search_note_library', { limit: 8 }) : { type: 'answer', answer: '候选不足，不能据此下结论。', citations: [], completeness: 'not-found', planPatch: { baseVersion: 2, activeGoalId: null, goalUpdates: [{ goalId: 'goal-fuzzy', status: 'not-found', missingEvidence: '尚未读取原文' }] } };
    },
    async synthesize() { throw new Error('fuzzy fixture should answer'); },
  },
  search: { keywordSearch: () => firstIndex.notes.map((note) => ({ path: note.path, title: note.title, score: 0.4, matchTrace: [{ queryTerm: 'Ner', matchedTerm: 'NER', matchType: 'fuzzy', ratio: 0.8 }] })), semanticSearch: async () => [] },
  searchMode: 'keyword',
  isSnapshotCurrent: () => true,
});
assert.equal(fuzzy.evidence.length, 0, 'fuzzy candidate must not become evidence without a read');

// A content change invalidates old evidence before final citation generation.
const changedFile = path.join(tempLibrary, 'alpha', '同名标题.md');
fs.writeFileSync(changedFile, '# 同名标题\n\n## Alpha 方案\n\nAlpha 方案已修改为新的原文。\n', 'utf8');
const changedMap = createLibraryNoteSnapshotMap({ libraryPath, index: buildNoteIndex(libraryPath), sessionId, revision: 2, indexState: 'updating' });
const staleMap = createLibraryNoteSnapshotMap({ libraryPath, index: firstIndex, sessionId, revision: 1, indexState: 'latest' });
let staleStep = 0;
let staleDetected = false;
const stale = await runLibraryPlanAgent({
  snapshotMap: staleMap,
  sessionId,
  question: '核实 Alpha 方案',
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-model',
  signal: new AbortController().signal,
    planner: { plan: async () => basePlan('goal-stale', { query: '方案' }) },
    driver: {
      async decide({ prompt }) {
      const action = staleStep++ === 0
        ? tool('goal-stale', 'search_note_library', { limit: 8 })
        : tool('goal-stale', 'read_library_note_range', { noteId: records[0].noteId, lineFrom: 5, lineTo: 5 });
      return action;
    },
    async synthesize() { throw new Error('stale fixture must stop before synthesis'); },
  },
  search: searchCallbacks,
  searchMode: 'keyword',
  isSnapshotCurrent: () => !staleDetected,
  onToolEvent: (event) => {
    if (event.tool === 'read_library_note_range' && event.state === 'completed') {
      // The read completes against the old snapshot, then the map is refreshed.
      staleDetected = true;
      replaceLibraryNoteSnapshotMap(staleMap, changedMap);
    }
  },
});
assert.equal(stale.searchPlan.status, 'stale');
assert.equal(stale.evidence.length, 0, 'stale evidence must not be cited');

const otherLibraryPath = path.join(stagingDir, 'other-library');
fs.cpSync(fixtureDir, otherLibraryPath, { recursive: true });
const otherMap = createLibraryNoteSnapshotMap({ libraryPath: otherLibraryPath, index: buildNoteIndex(otherLibraryPath), sessionId, revision: 1 });
const scopedTools = createLibraryNoteTools(snapshotMap, sessionId);
assert.throws(() => scopedTools.getNoteMap([...otherMap.records.keys()][0]), /不属于当前笔记库快照/);
assert.throws(() => createLibraryNoteTools(snapshotMap, 'session-library-b').getNoteMap(records[0].noteId), /会话/);
await assert.rejects(() => runLibraryPlanAgent({ snapshotMap, sessionId: 'session-library-b', question: 'x', conversation: [], providerKind: 'ollama', model: 'fixture-model', signal: new AbortController().signal, planner: { plan: async () => basePlan('goal-scope') }, driver: comparisonActions('goal-scope'), search: searchCallbacks, searchMode: 'keyword', isSnapshotCurrent: () => true }), /会话/);

fs.rmSync(stagingDir, { recursive: true, force: true });
console.log('verify:library-plan-execute: dual-note snapshots, opaque noteId scope, hybrid candidates, original-evidence reads, query continuation, comparison coverage, stale invalidation, and session/library rejection passed');
