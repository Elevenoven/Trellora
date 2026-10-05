import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'library-section-bm25');
const outDir = path.join(rootDir, '.package-staging', 'verify-library-section-bm25-baseline');
const lexicalIndexFile = path.join(outDir, 'currentNoteLexicalIndex.cjs');
const snapshotFile = path.join(outDir, 'currentNoteSnapshot.cjs');
const searchPlanFile = path.join(outDir, 'searchPlanValidation.cjs');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')],
    outfile: lexicalIndexFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')],
    outfile: snapshotFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanValidation.ts')],
    outfile: searchPlanFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
]);

const { CurrentNoteLexicalIndex } = await import(pathToFileURL(lexicalIndexFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createSearchPlan } = await import(pathToFileURL(searchPlanFile).href);

const [sameHeadingsMarkdown, nestedSectionsMarkdown, manyQueryTermsMarkdown] = await Promise.all([
  fs.readFile(path.join(fixtureDir, 'agent-same-headings.md'), 'utf8'),
  fs.readFile(path.join(fixtureDir, 'nested-sections.md'), 'utf8'),
  fs.readFile(path.join(fixtureDir, 'many-query-terms.md'), 'utf8'),
]);

const sameHeadingsSnapshot = createFixtureSnapshot('agent-same-headings', sameHeadingsMarkdown, createCurrentNoteSnapshot);
assert.equal(sameHeadingsSnapshot.headings.length, 8, '同名标题夹具必须恰好包含 8 个章节。');
assert.equal(sameHeadingsSnapshot.headings.every((heading) => heading.text === 'Agent'), true, '8 个章节标题必须全部为 Agent。');

const sameHeadingsIndex = new CurrentNoteLexicalIndex(sameHeadingsSnapshot);
const agentOnlyHits = sameHeadingsIndex.search('Agent', 20);
assert.equal(agentOnlyHits.length, 16, 'Agent 查询必须复现 8 个标题块和 8 个正文块命中。');
assert.deepEqual(
  agentOnlyHits.slice(0, 8).map((hit) => hit.headingId),
  sameHeadingsSnapshot.headings.map((heading) => heading.headingId),
  '前 8 个同分标题块当前会按 lineFrom 和 blockId 排成文档顺序。',
);
assert.equal(agentOnlyHits.slice(0, 8).every((hit) => hit.snippet === '# Agent'), true, '前 8 名必须全部是同名标题块。');
assert.equal(new Set(agentOnlyHits.slice(0, 8).map((hit) => hit.score)).size, 1, '8 个同名标题块必须稳定同分。');
assert.equal(new Set(agentOnlyHits.slice(8).map((hit) => hit.score)).size, 1, '8 个正文块必须稳定同分。');
assert.equal(isAscending(agentOnlyHits.slice(0, 8).map((hit) => hit.lineFrom)), true, '同分标题块的行号必须升序。');
assert.equal(isAscending(agentOnlyHits.slice(8).map((hit) => hit.lineFrom)), true, '同分正文块的行号必须升序。');

const stableAgentOnlyProjection = projectHits(agentOnlyHits);
for (let run = 0; run < 20; run += 1) {
  assert.deepEqual(projectHits(sameHeadingsIndex.search('Agent', 20)), stableAgentOnlyProjection, `Agent 基线第 ${run + 1} 次重复结果发生漂移。`);
}

const agentMemoryHits = sameHeadingsIndex.search('Agent Memory', 20);
assert.equal(agentMemoryHits[0]?.headingId, sameHeadingsSnapshot.headings[0]?.headingId, 'Agent + Memory 应把 Memory 正文章节排到首位。');
assert.deepEqual(agentMemoryHits[0]?.matchedTerms, ['agent', 'memory']);

const nestedSnapshot = createFixtureSnapshot('nested-sections', nestedSectionsMarkdown, createCurrentNoteSnapshot);
const parentHeading = nestedSnapshot.headings.find((heading) => heading.level === 1);
const childHeadings = nestedSnapshot.headings.filter((heading) => heading.level === 2);
assert.ok(parentHeading, '嵌套夹具必须包含父章节。');
assert.equal(childHeadings.length, 3, '嵌套夹具必须包含 3 个子章节。');
assert.equal(parentHeading.lineTo, nestedSnapshot.lineCount, '当前父章节范围会覆盖全部子章节。');
assert.equal(childHeadings.every((heading) => parentHeading.lineFrom < heading.lineFrom && parentHeading.lineTo >= heading.lineTo), true);

const nestedIndex = new CurrentNoteLexicalIndex(nestedSnapshot);
const nestedMemoryHits = nestedIndex.search('Memory', 20);
const nestedHitHeadingIds = nestedMemoryHits.map((hit) => hit.headingId).filter(Boolean);
const distinctNestedHeadingIds = new Set(nestedHitHeadingIds);
assert.ok(nestedMemoryHits.length > distinctNestedHeadingIds.size, '当前块命中必须复现一个章节返回多个正文块。');
assert.equal(
  [...distinctNestedHeadingIds].every((headingId) => nestedSnapshot.headings.some((heading) => heading.headingId === headingId)),
  true,
  '块命中必须仍能映射回当前章节。',
);
assert.ok(
  nestedSnapshot.blocks.some((block) => block.headingPath.length === 1)
    && nestedSnapshot.blocks.some((block) => block.headingPath.length === 2),
  '夹具必须同时包含父章节直接正文和子章节直接正文。',
);

const queryTerms = [...manyQueryTermsMarkdown.matchAll(/^- (term-\d{2})$/gmu)].map((match) => match[1]);
assert.equal(queryTerms.length, 40, 'QueryTerm 夹具必须恰好包含 40 个查询词。');
assert.equal(new Set(queryTerms).size, 40, 'QueryTerm 夹具不得包含重复项。');
const searchPlan = createSearchPlan({
  originalQuestion: '验证 SearchPlan 是否保存全部 QueryTerm',
  goals: [{
    goalId: 'goal-many-query-terms',
    question: '保留全部 40 个 QueryTerm',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'requirement-many-query-terms', label: 'QueryTerm 完整性', minEvidence: 1 }],
    queryTerms,
  }],
}, {
  planId: 'plan-library-section-bm25-baseline',
  now: '2026-08-27T00:00:00.000Z',
});
assert.equal(searchPlan.goals[0]?.queryTerms.length, 40, 'SearchPlan 必须保存全部 40 个 QueryTerm。');
assert.deepEqual(searchPlan.goals[0]?.queryTerms.map((entry) => entry.term), queryTerms);

const report = {
  schemaVersion: 'library-section-bm25-baseline-v1',
  mode: 'current-production-block-search',
  fixtures: [
    'agent-same-headings.md',
    'nested-sections.md',
    'many-query-terms.md',
  ],
  sameHeadings: {
    sectionCount: sameHeadingsSnapshot.headings.length,
    agentOnly: {
      hitCount: agentOnlyHits.length,
      distinctScores: [...new Set(agentOnlyHits.map((hit) => hit.score))],
      firstThreeHeadingIds: agentOnlyHits.slice(0, 3).map((hit) => hit.headingId),
      firstThreeLineFrom: agentOnlyHits.slice(0, 3).map((hit) => hit.lineFrom),
      topEightKinds: agentOnlyHits.slice(0, 8).map((hit) => hit.snippet === '# Agent' ? 'heading' : 'body'),
      stableRuns: 20,
      reproducedIssue: 'eight-heading-blocks-tie-ahead-of-body-blocks-and-earlier-lines-win',
    },
    agentAndMemory: {
      firstHeadingId: agentMemoryHits[0]?.headingId,
      firstLineFrom: agentMemoryHits[0]?.lineFrom,
      matchedTerms: agentMemoryHits[0]?.matchedTerms,
    },
  },
  nestedSections: {
    headingCount: nestedSnapshot.headings.length,
    blockHitCount: nestedMemoryHits.length,
    distinctHitHeadingCount: distinctNestedHeadingIds.size,
    parentRange: [parentHeading.lineFrom, parentHeading.lineTo],
    childRanges: childHeadings.map((heading) => [heading.lineFrom, heading.lineTo]),
    reproducedIssue: 'block-hits-are-not-section-documents-and-parent-range-includes-child-content',
  },
  queryTerms: {
    fixtureCount: queryTerms.length,
    storedCount: searchPlan.goals[0]?.queryTerms.length,
    mechanicalBatchSize: 8,
    mechanicalBatchCount: Math.ceil(queryTerms.length / 8),
  },
};

console.log(JSON.stringify(report, null, 2));
console.log('Library section BM25 baseline verification passed');

function createFixtureSnapshot(name, markdown, createSnapshot) {
  return createSnapshot({
    libraryPath: outDir,
    notePath: path.join(outDir, `${name}.md`),
    title: name,
    contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    markdown,
    headings: collectHeadings(markdown, name),
    revision: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
  });
}

function collectHeadings(markdown, idPrefix) {
  return markdown.split(/\r\n|\r|\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (!match) return [];
    return [{
      id: `${idPrefix}-heading-${String(index + 1).padStart(4, '0')}`,
      level: match[1].length,
      text: match[2].trim(),
      line: index + 1,
    }];
  });
}

function projectHits(hits) {
  return hits.map((hit) => [hit.blockId, hit.headingId, hit.lineFrom, hit.lineTo, hit.score, hit.matchedTerms]);
}

function isAscending(values) {
  return values.every((value, index) => index === 0 || values[index - 1] <= value);
}
