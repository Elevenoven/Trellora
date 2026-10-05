import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-adaptive-scope');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-section-diversity');
const indexFile = path.join(outDir, 'lexical-index.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const toolsFile = path.join(outDir, 'tools.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')], outfile: indexFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteTools.ts')], outfile: toolsFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const markdown = await fs.readFile(path.join(fixtureDir, 'ner-multi-section.md'), 'utf8');
const headings = collectHeadings(markdown);
const { CurrentNoteLexicalIndex, groupCurrentNoteSearchHitsByHeading, rerankCurrentNoteSearchHits } = await import(pathToFileURL(indexFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { searchCurrentNote } = await import(pathToFileURL(toolsFile).href);
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/current-note-adaptive-scope.md',
  title: 'NER 多章节范围夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings,
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const index = new CurrentNoteLexicalIndex(snapshot);

const focusedDefinition = searchCurrentNote(index, ['NER 是什么？'], 20, {
  mode: 'focused',
  targetTopic: 'NER',
  targetAspects: ['定义'],
});
assert.equal(focusedDefinition[0]?.relevanceRank, 1);
assert.ok(focusedDefinition.slice(0, 2).some((hit) => hit.headingPath.at(-1) === 'NER 定义'), '定义 Hit@2 不得下降。');
assert.ok(focusedDefinition.every((hit) => hit.headingId === undefined || typeof hit.headingId === 'string'));

const focusedClassification = searchCurrentNote(index, ['NER', '模型', '分类'], 20, {
  mode: 'focused',
  targetTopic: 'NER',
  targetAspects: ['模型分类'],
});
assert.ok(focusedClassification.slice(0, 2).every((hit) => hit.headingPath.at(-1) === 'NER 模型分类'), 'focused 分类前 2 应优先同一相关章节。');
assert.equal(focusedClassification.slice(0, 3).filter((hit) => hit.headingPath.at(-1) === 'NER 模型分类').length, 2, 'focused 分类前 3 不得丢失两个分类证据块。');

const topicWide = searchCurrentNote(index, ['NER'], 20, {
  mode: 'topic-wide',
  targetTopic: 'NER',
  targetAspects: [],
});
const firstSixHeadingIds = topicWide.slice(0, 6).map((hit) => hit.headingId ?? '__preamble__');
assert.equal(new Set(firstSixHeadingIds).size, firstSixHeadingIds.length, 'topic-wide 前 6 应优先覆盖不同章节。');
assert.ok(new Set(topicWide.slice(0, 6).map((hit) => hit.headingPath.at(-1))).size >= 4);
assert.equal(topicWide[0]?.relevanceRank, 1, '第一阶段 relevanceRank 必须保持稳定原始排名。');

const grouped = groupCurrentNoteSearchHitsByHeading(topicWide);
assert.ok([...grouped.values()].every((group) => group.length > 0));

const synthetic = [
  { hitId: 'h2', blockId: 'block-b', headingPath: ['B'], headingId: 'heading-b', lineFrom: 20, lineTo: 20, snippet: '相同分数', matchedTerms: [], matchTypes: [], matchTrace: [], score: 1, relevanceRank: 1 },
  { hitId: 'h1', blockId: 'block-a', headingPath: ['A'], headingId: 'heading-a', lineFrom: 10, lineTo: 10, snippet: '相同分数', matchedTerms: [], matchTypes: [], matchTrace: [], score: 1, relevanceRank: 1 },
];
assert.deepEqual(rerankCurrentNoteSearchHits(synthetic, 'focused').map((hit) => hit.blockId), ['block-a', 'block-b'], '同分必须按行号和 blockId 稳定排序。');
const relatednessProbe = [
  { ...synthetic[0], blockId: 'block-unrelated', headingId: 'heading-unrelated', headingPath: ['部署'], snippet: '部署说明', relevanceRank: 1 },
  { ...synthetic[1], blockId: 'block-related', headingId: 'heading-related', headingPath: ['NER 定义'], snippet: 'NER 定义', relevanceRank: 2 },
];
assert.equal(rerankCurrentNoteSearchHits(relatednessProbe, { mode: 'topic-wide', targetTopic: 'NER', targetAspects: [] })[0].blockId, 'block-related', '明显不相关章节不能仅凭多样性奖励抢位。');
assert.deepEqual(searchCurrentNote(index, ['NER'], 6), searchCurrentNote(index, ['NER'], 6), '旧数组 API 必须可重复。');

console.log('Current-note section diversity verification passed');

function collectHeadings(markdownText) {
  const lines = markdownText.split(/\r?\n/u);
  const headingsOut = [];
  for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(lines[indexLine]);
    if (!match) continue;
    headingsOut.push({ id: `fixture-heading-${String(headingsOut.length + 1).padStart(4, '0')}`, level: match[1].length, text: match[2].trim(), line: indexLine + 1 });
  }
  return headingsOut;
}
