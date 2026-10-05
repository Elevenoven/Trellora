import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'library-section-bm25');
const outDir = path.join(rootDir, '.package-staging', 'verify-library-section-bm25');
const rankerFile = path.join(outDir, 'librarySectionRanker.cjs');
const snapshotFile = path.join(outDir, 'currentNoteSnapshot.cjs');
const toolsFile = path.join(outDir, 'libraryNoteTools.cjs');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'librarySectionRanker.ts')], outfile: rankerFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryNoteTools.ts')], outfile: toolsFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const {
  LibrarySectionRanker,
  normalizeLibrarySectionQueryTerms,
  projectLibrarySectionSearchDocuments,
} = await import(pathToFileURL(rankerFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createLibraryNoteTools } = await import(pathToFileURL(toolsFile).href);

const [sameHeadingsMarkdown, nestedSectionsMarkdown, manyQueryTermsMarkdown] = await Promise.all([
  fs.readFile(path.join(fixtureDir, 'agent-same-headings.md'), 'utf8'),
  fs.readFile(path.join(fixtureDir, 'nested-sections.md'), 'utf8'),
  fs.readFile(path.join(fixtureDir, 'many-query-terms.md'), 'utf8'),
]);

const sameHeadingsSnapshot = createFixtureSnapshot('agent-same-headings', sameHeadingsMarkdown, createCurrentNoteSnapshot);
const sameHeadingsDocuments = projectLibrarySectionSearchDocuments({ noteId: 'note-agent-same-headings', snapshot: sameHeadingsSnapshot });
assert.equal(sameHeadingsDocuments.length, 8, '8 个有直接正文的 Agent 章节都必须成为章节文档。');
assert.equal(sameHeadingsDocuments.every((document) => document.directBlockIds.length === 1), true, '标题块不得进入章节直接正文。');
assert.equal(new Set(sameHeadingsDocuments.flatMap((document) => document.directBlockIds)).size, 8, '每个正文块只能归属一个最深章节。');

const ranker = new LibrarySectionRanker({ noteId: 'note-agent-same-headings', snapshot: sameHeadingsSnapshot });
const agentOnly = ranker.rankRelatedSections(queryTerms('Agent'));
assert.equal(agentOnly.evaluatedSectionCount, 8);
assert.equal(agentOnly.processedQueryTermCount, 1);
assert.deepEqual(agentOnly.suppressedHeadingTerms, ['Agent']);
assert.equal(agentOnly.ambiguous, true, '只有高频标题 Agent 时必须明确 ambiguous。');
assert.equal(agentOnly.reason, 'all-query-terms-non-discriminative');
assert.deepEqual(agentOnly.topSections, [], '只有 Agent 时不得按较早行号补出伪 Top 3。');

const agentMemory = ranker.rankRelatedSections(queryTerms('Agent', 'Memory'));
assert.equal(agentMemory.ambiguous, false);
assert.equal(agentMemory.topSections[0]?.headingId, sameHeadingsSnapshot.headings[0]?.headingId, 'Memory 正文章节必须进入 Top 3。');
assert.equal(agentMemory.topSections[0]?.score, 75);
assert.deepEqual(agentMemory.topSections[0]?.scoreBreakdown, {
  bodyBm25: 1,
  headingBm25: 0,
  queryCoverage: 0.5,
  exactBodyOrIdentifier: 1,
});
assert.deepEqual(agentMemory.topSections[0]?.matchedQueryTerms, ['Memory']);
assert.deepEqual(agentMemory.topSections[0]?.suppressedHeadingTerms, ['Agent']);
assert.ok((agentMemory.topSections[0]?.preview.length ?? 0) <= 240);

const normalizedDuplicates = normalizeLibrarySectionQueryTerms([
  { term: ' Memory ', source: 'planner' },
  { term: 'Ｍｅｍｏｒｙ', source: 'note-map' },
]);
assert.deepEqual(normalizedDuplicates, [{ term: 'Memory', normalizedTerm: 'memory', source: 'planner' }], 'NFKC 后重复 QueryTerm 必须保留首个来源。');

const manyQueryTerms = [...manyQueryTermsMarkdown.matchAll(/^- (term-\d{2})$/gmu)]
  .map((match) => ({ term: match[1], source: 'planner' }));
const tailTermMarkdown = '# First\n\n没有查询词的普通正文。\n\n# Last\n\n只有最后一批的 term-40 出现在这里。\n';
const tailTermSnapshot = createFixtureSnapshot('tail-query-term', tailTermMarkdown, createCurrentNoteSnapshot);
const manyTermsResult = new LibrarySectionRanker({ noteId: 'note-tail-query-term', snapshot: tailTermSnapshot })
  .rankRelatedSections(manyQueryTerms);
assert.equal(manyTermsResult.processedQueryTermCount, 40, '40 个 QueryTerm 必须全部处理。');
assert.equal(manyTermsResult.queryTermBatchCount, 5, '8 个一批只能形成 5 个机械批次，不得截断。');
assert.equal(manyTermsResult.topSections[0]?.headingId, tailTermSnapshot.headings[1]?.headingId, '最后一批的 term-40 必须影响最终 Top 3。');

const headingChannelMarkdown = '# Memory\n\n正文只说明通用概念。\n\n# Tools\n\n正文只说明执行能力。\n\n# Planning\n\n正文只说明目标拆分。\n\n# Security\n\n正文只说明访问限制。\n';
const headingChannelSnapshot = createFixtureSnapshot('heading-channel', headingChannelMarkdown, createCurrentNoteSnapshot);
const headingChannelResult = new LibrarySectionRanker({ noteId: 'note-heading-channel', snapshot: headingChannelSnapshot })
  .rankRelatedSections(queryTerms('Memory'));
assert.equal(headingChannelResult.topSections[0]?.headingId, headingChannelSnapshot.headings[0]?.headingId);
assert.deepEqual(headingChannelResult.topSections[0]?.scoreBreakdown, {
  bodyBm25: 0,
  headingBm25: 1,
  queryCoverage: 1,
  exactBodyOrIdentifier: 0,
});
assert.equal(headingChannelResult.topSections[0]?.score, 35, '非高频标题命中必须走独立 heading BM25 通道。');

const nestedSnapshot = createFixtureSnapshot('nested-sections', nestedSectionsMarkdown, createCurrentNoteSnapshot);
const nestedDocuments = projectLibrarySectionSearchDocuments({ noteId: 'note-nested-sections', snapshot: nestedSnapshot });
assert.equal(nestedDocuments.length, 4, '父章节和 3 个子章节必须分别形成章节文档。');
const parentDocument = nestedDocuments.find((document) => document.level === 1);
assert.ok(parentDocument);
assert.equal(parentDocument.directBlockIds.length, 1, '父章节只允许保留自己的直接正文块。');
assert.equal(parentDocument.directBodyText.includes('子章节'), false, '父章节不得重复聚合子章节正文。');
assert.equal(nestedDocuments.flatMap((document) => document.directBlockIds).length, 6);
assert.equal(new Set(nestedDocuments.flatMap((document) => document.directBlockIds)).size, 6, '父子章节正文块不得重复归属。');

const emptyContainerMarkdown = '# Container\n\n## Agent\n\nMemory 是唯一直接正文。\n';
const emptyContainerSnapshot = createFixtureSnapshot('empty-container', emptyContainerMarkdown, createCurrentNoteSnapshot);
const emptyContainerDocuments = projectLibrarySectionSearchDocuments({ noteId: 'note-empty-container', snapshot: emptyContainerSnapshot });
assert.equal(emptyContainerDocuments.length, 1, '没有直接正文的容器章节不得进入内容章节排名。');
assert.equal(emptyContainerDocuments[0]?.level, 2);
const noContentSnapshot = createFixtureSnapshot('no-content', '# Container\n', createCurrentNoteSnapshot);
const noContentResult = new LibrarySectionRanker({ noteId: 'note-no-content', snapshot: noContentSnapshot })
  .rankRelatedSections(queryTerms('Container'));
assert.equal(noContentResult.noteId, 'note-no-content');
assert.equal(noContentResult.snapshotId, noContentSnapshot.snapshotId);
assert.equal(noContentResult.contentHash, noContentSnapshot.contentHash);
assert.equal(noContentResult.evaluatedSectionCount, 0);

const deterministicQuery = queryTerms('Agent', 'Memory', 'Tools', 'Security');
const deterministicFirst = ranker.rankRelatedSections(deterministicQuery);
assert.equal(deterministicFirst.topSections.length, 3);
assert.deepEqual(
  new Set(deterministicFirst.topSections.map((candidate) => candidate.headingId)),
  new Set([sameHeadingsSnapshot.headings[0].headingId, sameHeadingsSnapshot.headings[1].headingId, sameHeadingsSnapshot.headings[5].headingId]),
);
const deterministicProjection = projectRankResult(deterministicFirst);
for (let run = 0; run < 100; run += 1) {
  assert.deepEqual(projectRankResult(ranker.rankRelatedSections(deterministicQuery)), deterministicProjection, `第 ${run + 1} 次章节 Top 3 发生漂移。`);
}

const snapshotMap = createSnapshotMap('note-agent-same-headings', sameHeadingsSnapshot);
const tools = createLibraryNoteTools(snapshotMap, snapshotMap.sessionId);
const cachedFirst = tools.rankRelatedSections('note-agent-same-headings', queryTerms('Agent', 'Memory'));
const cachedSecond = tools.rankRelatedSections('note-agent-same-headings', queryTerms('Agent', 'Memory'));
assert.equal(cachedFirst, cachedSecond, '相同 snapshotId + queryTermFingerprint 必须复用缓存结果。');
assert.equal(Object.isFrozen(cachedFirst), true, '缓存结果必须只读，避免调用方污染后续命中。');
const differentSource = tools.rankRelatedSections('note-agent-same-headings', [
  { term: 'Agent', source: 'planner' },
  { term: 'Memory', source: 'note-map' },
]);
assert.notEqual(cachedFirst, differentSource, '不同 QueryTerm 来源必须生成不同指纹，保留审计语义。');

console.log(JSON.stringify({
  verifier: 'library-section-bm25-v1',
  agentOnly: {
    evaluatedSectionCount: agentOnly.evaluatedSectionCount,
    processedQueryTermCount: agentOnly.processedQueryTermCount,
    suppressedHeadingTerms: agentOnly.suppressedHeadingTerms,
    ambiguous: agentOnly.ambiguous,
    top3: agentOnly.topSections.map((candidate) => candidate.headingId),
  },
  agentAndMemory: {
    top3: agentMemory.topSections.map((candidate) => ({
      headingId: candidate.headingId,
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      matchedQueryTerms: candidate.matchedQueryTerms,
    })),
  },
  manyQueryTerms: {
    processedQueryTermCount: manyTermsResult.processedQueryTermCount,
    queryTermBatchCount: manyTermsResult.queryTermBatchCount,
    tailTermTopHeadingId: manyTermsResult.topSections[0]?.headingId,
  },
  headingChannel: {
    topHeadingId: headingChannelResult.topSections[0]?.headingId,
    score: headingChannelResult.topSections[0]?.score,
    scoreBreakdown: headingChannelResult.topSections[0]?.scoreBreakdown,
  },
  nestedSections: {
    projectedSectionCount: nestedDocuments.length,
    uniqueDirectBlockCount: new Set(nestedDocuments.flatMap((document) => document.directBlockIds)).size,
    parentDirectBlockCount: parentDocument.directBlockIds.length,
  },
  deterministicRuns: 100,
  cacheIdentityReused: cachedFirst === cachedSecond,
}, null, 2));
console.log('Library section BM25 verification passed');

function queryTerms(...terms) {
  return terms.map((term) => ({ term, source: 'planner' }));
}

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

function createSnapshotMap(noteId, snapshot) {
  const descriptor = {
    schemaVersion: 1,
    libraryId: snapshot.libraryId,
    noteId,
    snapshotId: snapshot.snapshotId,
    title: snapshot.title,
    contentHash: snapshot.contentHash,
    revision: snapshot.revision,
    lineCount: snapshot.lineCount,
    headings: snapshot.headings.map((heading) => ({
      headingId: heading.headingId,
      path: [...heading.path],
      lineFrom: heading.lineFrom,
      lineTo: heading.lineTo,
    })),
    topTerms: [],
  };
  return {
    libraryId: snapshot.libraryId,
    sessionId: 'session-library-section-ranker',
    revision: snapshot.revision,
    indexState: 'latest',
    notes: [descriptor],
    records: new Map([[noteId, { ...descriptor, localSnapshot: snapshot }]]),
  };
}

function projectRankResult(result) {
  return {
    ambiguous: result.ambiguous,
    topSections: result.topSections.map((candidate) => ({
      headingId: candidate.headingId,
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      matchedQueryTerms: candidate.matchedQueryTerms,
    })),
  };
}
