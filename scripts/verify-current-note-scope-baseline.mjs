import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-adaptive-scope');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-scope-baseline');

const outputs = {
  lexicalIndex: path.join(outDir, 'lexical-index.cjs'),
  snapshot: path.join(outDir, 'snapshot.cjs'),
  capsule: path.join(outDir, 'capsule.cjs'),
  tools: path.join(outDir, 'tools.cjs'),
  summary: path.join(outDir, 'summary.cjs'),
};

await Promise.all(Object.entries({
  lexicalIndex: 'electron/knowledge/currentNoteLexicalIndex.ts',
  snapshot: 'electron/knowledge/currentNoteSnapshot.ts',
  capsule: 'electron/knowledge/currentNoteCapsule.ts',
  tools: 'electron/knowledge/currentNoteTools.ts',
  summary: 'electron/knowledge/noteSummaryOrchestrator.ts',
}).map(([name, entryPoint]) => build({
  entryPoints: [path.join(rootDir, entryPoint)],
  outfile: outputs[name],
  bundle: true,
  platform: 'node',
  format: 'cjs',
})));

const [fixtureMarkdown, rawCases] = await Promise.all([
  fs.readFile(path.join(fixtureDir, 'ner-multi-section.md'), 'utf8'),
  fs.readFile(path.join(fixtureDir, 'cases.json'), 'utf8'),
]);
const casesFile = parseCases(JSON.parse(rawCases));
const headings = collectHeadings(fixtureMarkdown);
assert.ok(headings.length > 120, '夹具必须让 Capsule 目录发生截断。');
assert.throws(() => collectHeadings('没有标题的正文'), /至少需要一个 Markdown 标题/u, '异常夹具必须被拒绝。');

const { CurrentNoteLexicalIndex } = await import(pathToFileURL(outputs.lexicalIndex).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(outputs.snapshot).href);
const { createNoteCapsule } = await import(pathToFileURL(outputs.capsule).href);
const { readCurrentNoteRange, searchCurrentNote } = await import(pathToFileURL(outputs.tools).href);
const { classifyCurrentNoteSummaryIntent } = await import(pathToFileURL(outputs.summary).href);

const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/current-note-adaptive-scope.md',
  title: 'NER 多章节范围夹具',
  contentHash: createHash('sha256').update(fixtureMarkdown, 'utf8').digest('hex'),
  markdown: fixtureMarkdown,
  headings,
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const capsule = createNoteCapsule(snapshot);
assert.equal(capsule.structuralStats.headingsTruncated, 1, '夹具必须覆盖 120 标题后的目录截断边界。');
const index = new CurrentNoteLexicalIndex(snapshot);

const reports = casesFile.cases.map((testCase) => probeCase({
  testCase,
  index,
  snapshot,
  capsule,
  readHitLimit: casesFile.baselineReadHitLimit,
  classifyCurrentNoteSummaryIntent,
  searchCurrentNote,
  readCurrentNoteRange,
}));

for (const report of reports) {
  if (report.id === 'S11') {
    assert.equal(report.capsuleTruncated, true);
    assert.ok(report.currentTop20.some((hit) => hit.headingTitle === '120 个标题后的 NER 章节'));
  }
  if (report.id === 'S12') {
    assert.deepEqual(new Set(report.currentTop20.filter((hit) => /^重复说明/u.test(hit.headingTitle)).map((hit) => hit.headingTitle)), new Set(['重复说明甲', '重复说明乙']));
  }
}

console.log(JSON.stringify({
  verifier: 'current-note-adaptive-scope-baseline',
  fixture: casesFile.fixture,
  snapshotId: snapshot.snapshotId,
  headingCount: snapshot.headings.length,
  capsule: {
    headingsIncluded: capsule.structuralStats.headingsIncluded,
    headingsTruncated: capsule.structuralStats.headingsTruncated,
  },
  reports,
}, null, 2));
console.log('Current-note adaptive scope baseline verification passed');

function probeCase(input) {
  const { testCase, index, snapshot, capsule, readHitLimit, classifyCurrentNoteSummaryIntent, searchCurrentNote, readCurrentNoteRange } = input;
  if (testCase.kind === 'summary-route') {
    const actualSummaryMode = classifyCurrentNoteSummaryIntent(testCase.question);
    assert.equal(actualSummaryMode, testCase.expectedSummaryMode, `${testCase.id} 必须继续进入现有 structured-summary 路由。`);
    return {
      id: testCase.id,
      kind: testCase.kind,
      question: testCase.question,
      route: 'structured-summary',
      summaryMode: actualSummaryMode,
      currentTop20: [],
      distinctHeadingIds: 0,
      readCharacters: 0,
      publicToolCalls: 0,
      baselineProbeCompleteness: 'not-run',
      baselineComparison: 'matches-route',
    };
  }

  const run = () => searchCurrentNote(index, testCase.searchTerms, 20);
  const hits = run();
  const repeatedHits = run();
  assert.deepEqual(stableHitProjection(hits), stableHitProjection(repeatedHits), `${testCase.id} 的 Top-20 必须可重复。`);

  const currentTop20 = hits.map((hit, indexPosition) => ({
    rank: indexPosition + 1,
    blockId: hit.blockId,
    headingId: resolveHeadingId(snapshot, hit),
    headingTitle: hit.headingPath.at(-1) ?? '(前言)',
    headingPath: hit.headingPath,
    lineFrom: hit.lineFrom,
    lineTo: hit.lineTo,
    characters: hit.snippet.length,
    score: hit.score,
    matchTypes: hit.matchTypes,
  }));
  const readResults = hits.slice(0, readHitLimit).map((hit) => readCurrentNoteRange(snapshot, {
    lineFrom: hit.lineFrom,
    lineTo: hit.lineTo,
  }));
  const expectedHeadings = new Set(testCase.expectedHeadings);
  const expectedTop2Hit = hits.slice(0, 2).some((hit) => expectedHeadings.has(hit.headingPath.at(-1) ?? ''));
  const expectedTop20Headings = new Set(currentTop20
    .filter((hit) => expectedHeadings.has(hit.headingTitle))
    .map((hit) => hit.headingTitle));
  const baselineProbeCompleteness = resolveProbeCompleteness(testCase, expectedTop2Hit, hits.length);

  return {
    id: testCase.id,
    kind: testCase.kind,
    question: testCase.question,
    route: 'lexical-baseline-probe',
    capsuleTruncated: capsule.structuralStats.headingsTruncated === 1,
    currentTop20,
    top2ExpectedHeadingHit: expectedTop2Hit,
    expectedHeadingHitsInTop20: [...expectedTop20Headings].sort(),
    distinctHeadingIds: new Set(currentTop20.map((hit) => hit.headingId)).size,
    readCharacters: readResults.reduce((total, result) => total + result.text.length, 0),
    publicToolCalls: 1 + 1 + readResults.length,
    baselineProbeCompleteness,
    expectedProbeCompleteness: testCase.expectedProbeCompleteness,
    baselineComparison: baselineProbeCompleteness === testCase.expectedProbeCompleteness ? 'matches' : 'baseline-gap',
  };
}

function resolveProbeCompleteness(testCase, expectedTop2Hit, hitCount) {
  if (hitCount === 0) return 'not-found';
  if (testCase.kind === 'coverage-baseline' || testCase.kind === 'duplicate-baseline') return 'partial';
  return expectedTop2Hit ? 'complete' : 'partial';
}

function stableHitProjection(hits) {
  return hits.map((hit) => [hit.blockId, hit.lineFrom, hit.lineTo, hit.score, hit.headingPath]);
}

function resolveHeadingId(snapshot, hit) {
  const match = snapshot.headings.find((heading) => heading.lineFrom <= hit.lineFrom
    && heading.lineTo >= hit.lineTo
    && heading.path.length === hit.headingPath.length
    && heading.path.every((part, index) => part === hit.headingPath[index]));
  return match?.headingId ?? '__preamble__';
}

function collectHeadings(markdown) {
  const headings = markdown.split(/\r\n|\r|\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!match) return [];
    return [{ id: `fixture-heading-${String(index + 1).padStart(4, '0')}`, level: match[1].length, text: match[2], line: index + 1 }];
  });
  if (!headings.length) throw new Error('夹具至少需要一个 Markdown 标题。');
  return headings;
}

function parseCases(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'cases.json 必须是对象。');
  assert.equal(value.schemaVersion, 1, 'cases.json schemaVersion 无效。');
  assert.equal(value.fixture, 'ner-multi-section.md', 'cases.json fixture 无效。');
  assert.equal(value.baselineReadHitLimit, 2, '阶段 0 必须固定模拟当前 Top-2 读取。');
  assert.ok(Array.isArray(value.cases) && value.cases.length >= 8, 'cases.json 场景数量不足。');
  for (const testCase of value.cases) {
    assert.ok(typeof testCase.id === 'string' && /^S\d{2}$/u.test(testCase.id), '场景 id 无效。');
    assert.ok(typeof testCase.question === 'string' && testCase.question.trim(), `${testCase.id} 缺少问题。`);
    assert.ok(Array.isArray(testCase.searchTerms), `${testCase.id} searchTerms 无效。`);
    assert.ok(Array.isArray(testCase.expectedHeadings), `${testCase.id} expectedHeadings 无效。`);
  }
  return value;
}
