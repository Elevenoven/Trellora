import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const stagingDir = path.join(rootDir, '.package-staging', 'verify-current-note-search-materialization');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const entries = {
  graph: 'electron/knowledge/currentNoteAgentGraph.ts',
  snapshot: 'electron/knowledge/currentNoteSnapshot.ts',
  tools: 'electron/knowledge/currentNoteTools.ts',
  ledger: 'electron/knowledge/currentNoteEvidenceLedger.ts',
  coverage: 'electron/knowledge/currentNoteSearchCoverage.ts',
};
await Promise.all(Object.entries(entries).map(async ([name, entryPoint]) => {
  await build({
    entryPoints: [path.join(rootDir, entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(stagingDir, `${name}.cjs`),
    logLevel: 'silent',
  });
}));

const { collectStableSearchPlanQueryTerms, createStableSearchGoalTermBatch, createStableSearchPlanTermBatches } = await import(pathToFileURL(path.join(stagingDir, 'graph.cjs')).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(path.join(stagingDir, 'snapshot.cjs')).href);
const { createCurrentNoteTools, materializeCurrentNoteSearchHits } = await import(pathToFileURL(path.join(stagingDir, 'tools.cjs')).href);
const { CurrentNoteEvidenceLedger } = await import(pathToFileURL(path.join(stagingDir, 'ledger.cjs')).href);
const { CurrentNoteSearchCoverageLedger } = await import(pathToFileURL(path.join(stagingDir, 'coverage.cjs')).href);

const scenario = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'scenario.json'), 'utf8'));
const notePath = path.join(fixtureDir, 'notes', 'all-evidence-baseline.md');
const markdown = fs.readFileSync(notePath, 'utf8');
const contentHash = sha256(markdown);
const lines = markdown.split('\n');
const headings = lines.flatMap((line, index) => {
  const match = /^(#{1,6})\s+(.+)$/u.exec(line);
  return match ? [{ id: `fixture-heading-${index + 1}`, level: match[1].length, text: match[2], line: index + 1 }] : [];
});
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: '阶段 2 全量证据夹具',
  contentHash,
  markdown,
  headings,
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
});

const plan = {
  goals: scenario.plannerOutput.goals.map((goal) => ({
    ...goal,
    queryTerms: goal.queryTerms.map((term) => ({ term })),
  })),
};
const expectedTerms = [
  'EvidenceAnchor',
  '1.2.0',
  'ConflictSignal',
  '否定条件',
  'evidenceAnchor',
  'Beta',
  '2026-08-23',
  'Version-1.2.0',
];
assert.deepEqual(collectStableSearchPlanQueryTerms(plan), expectedTerms, 'Planner 词并集必须保序、仅 trim/空项/完全相同去重。');
assert.deepEqual(createStableSearchPlanTermBatches(plan, 3), [
  expectedTerms.slice(0, 3),
  expectedTerms.slice(3, 6),
  expectedTerms.slice(6),
], '超过单次上限时只能按原顺序机械分批。');
const unboundedGoal = {
  goals: [{
    goalId: 'goal-unbounded',
    queryTerms: Array.from({ length: 19 }, (_, index) => ({ term: `Term-${index + 1}` })),
  }],
};
assert.deepEqual(createStableSearchGoalTermBatch(unboundedGoal, 'goal-unbounded', 0), Array.from({ length: 8 }, (_, index) => `Term-${index + 1}`));
assert.deepEqual(createStableSearchGoalTermBatch(unboundedGoal, 'goal-unbounded', 8), Array.from({ length: 8 }, (_, index) => `Term-${index + 9}`));
assert.deepEqual(createStableSearchGoalTermBatch(unboundedGoal, 'goal-unbounded', 16), ['Term-17', 'Term-18', 'Term-19']);

const tools = createCurrentNoteTools(snapshot);
const firstHits = tools.searchNote(['EvidenceAnchor'], 20);
const conflictHits = tools.searchNote(['ConflictSignal'], 20);
assert.ok(firstHits.length > 1, '夹具必须产生多个搜索命中。');
const firstHit = firstHits.find((hit) => conflictHits.some((candidate) => candidate.blockId === hit.blockId));
const duplicateHit = firstHit ? conflictHits.find((hit) => hit.blockId === firstHit.blockId) : undefined;
assert.ok(duplicateHit, '不同查询必须能够命中同一规范源块。');

const ledger = new CurrentNoteEvidenceLedger(snapshot, Number.MAX_SAFE_INTEGER, {
  enforceRawEvidenceChars: false,
  maxSourceEvidenceRecords: snapshot.blocks.length + 20,
});
const originals = materializeCurrentNoteSearchHits(snapshot, [firstHit, duplicateHit]);
const firstPage = ledger.addBatch([makeSearchEvidence(firstHit, originals[0], 'goal-alpha', 'tool-1')]);
const duplicatePage = ledger.addBatch([makeSearchEvidence(duplicateHit, originals[1], 'goal-beta', 'tool-2')]);
assert.equal(firstPage.addedRecords.length, 1);
assert.equal(duplicatePage.addedRecords.length, 0, '完全相同规范键不得重复创建原文记录。');
const deduped = ledger.list();
assert.equal(deduped.length, 1);
assert.deepEqual(deduped[0].goalIds, ['goal-alpha', 'goal-beta']);
assert.deepEqual(deduped[0].searchHitIds, [firstHit.hitId, duplicateHit.hitId].sort());
assert.equal(deduped[0].admission, 'search-hit');
assert.equal(deduped[0].text, originals[0].text);
assert.equal(deduped[0].textHash, sha256(originals[0].text));

const secondHit = firstHits.find((hit) => hit.blockId !== firstHit.blockId);
assert.ok(secondHit);
const overlapLineFrom = Math.min(firstHit.lineFrom, secondHit.lineFrom);
const overlapLineTo = Math.max(firstHit.lineTo, secondHit.lineTo);
const overlapText = lines.slice(overlapLineFrom - 1, overlapLineTo).join('\n');
ledger.add({
  blockIds: [firstHit.blockId, secondHit.blockId],
  headingPath: firstHit.headingPath,
  lineFrom: overlapLineFrom,
  lineTo: overlapLineTo,
  text: overlapText,
  matchedTerms: [],
  supports: [],
  sourceToolCallId: 'tool-overlap',
  admission: 'explicit-read',
});
assert.equal(ledger.list().length, 2, '重叠但不完全相同的范围必须保留独立源证据身份。');

const coverage = new CurrentNoteSearchCoverageLedger(snapshot, {
  mode: 'focused',
  coveragePolicy: 'sufficient',
  targetTopic: '全量证据基线',
  targetAspects: [],
});
coverage.recordSearch('goal-alpha', [firstHit, duplicateHit], 20, {
  candidateExhausted: true,
  plannedQueryTerms: expectedTerms,
  executedQueryTerms: expectedTerms.slice(0, 4),
  materialized: deduped.map((record) => ({
    snapshotId: record.snapshotId,
    evidenceId: record.evidenceId,
    blockIds: record.blockIds,
    headingPath: record.headingPath,
    lineFrom: record.lineFrom,
    lineTo: record.lineTo,
    text: record.text,
  })),
});
const partialCoverageSummary = coverage.toModelSummary('goal-alpha');
assert.equal(partialCoverageSummary.searchedBlockCount, 1, 'Coverage 要区分搜索命中块数。');
assert.equal(partialCoverageSummary.materializedEvidenceCount, 1, 'Coverage 要记录已物化的规范证据数。');
assert.equal(partialCoverageSummary.candidateExhausted, false, '单个 QueryTerm 批次到底不等于整个目标已遍历。');
assert.equal(partialCoverageSummary.candidateTruncated, true);
assert.deepEqual(partialCoverageSummary.unexecutedQueryTerms, expectedTerms.slice(4));
assert.equal(coverage.hasUnexecutedPlannedTerms(), true, '未执行 Planner 词必须保留为 Coverage 诊断。');
assert.deepEqual(coverage.getQueryTermAudit('goal-alpha').plannedQueryTerms, expectedTerms);

coverage.recordSearch('goal-alpha', [], 20, {
  candidateExhausted: true,
  plannedQueryTerms: expectedTerms,
  executedQueryTerms: expectedTerms.slice(4),
});
const coverageSummary = coverage.toModelSummary('goal-alpha');
assert.equal(coverageSummary.candidateExhausted, true, '全部 QueryTerm 执行后才能标记整个目标到底。');
assert.equal(coverageSummary.candidateTruncated, false);
assert.deepEqual(coverageSummary.unexecutedQueryTerms, []);
assert.equal(coverage.hasUnexecutedPlannedTerms(), false);

const changedMarkdown = `${markdown}\n\n新增内容。`;
const changedSnapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: '阶段 2 全量证据夹具',
  contentHash: sha256(changedMarkdown),
  markdown: changedMarkdown,
  headings,
  revision: 2,
});
assert.notEqual(deduped[0].contentHash, changedSnapshot.contentHash, 'contentHash 变化后旧记录必须保持原快照身份。');

console.log(JSON.stringify({
  ok: true,
  stableTermCount: expectedTerms.length,
  stableBatchCount: createStableSearchPlanTermBatches(plan, 3).length,
  searchHitCount: firstHits.length,
  evidenceCountAfterCanonicalDedupe: deduped.length,
  evidenceCountAfterOverlap: ledger.list().length,
  materializedEvidenceCount: coverageSummary.materializedEvidenceCount,
  unexecutedQueryTermCount: coverageSummary.unexecutedQueryTerms.length,
}, null, 2));

function makeSearchEvidence(hit, original, goalId, toolCallId) {
  return {
    blockIds: [original.blockId],
    headingPath: original.headingPath,
    lineFrom: original.lineFrom,
    lineTo: original.lineTo,
    text: original.text,
    matchedTerms: [...hit.matchedTerms],
    supports: ['阶段 2 夹具'],
    sourceToolCallId: toolCallId,
    admission: 'search-hit',
    goalId,
    searchHitId: hit.hitId,
    bestScore: hit.score,
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
