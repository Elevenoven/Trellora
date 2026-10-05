import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-lexical-match-policy');
const lexicalIndexFile = path.join(outDir, 'lexical-index.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const policyFile = path.join(outDir, 'policy.cjs');

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
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'lexicalMatchPolicy.ts')],
    outfile: policyFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
]);

const { CurrentNoteLexicalIndex } = await import(pathToFileURL(lexicalIndexFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { isNumericOrVersionLike, isTechnicalIdentifier, normalizeTechnicalTerm, resolveFuzzyRatio } = await import(pathToFileURL(policyFile).href);

assert.equal(normalizeTechnicalTerm('  ＳｐｒｉｎｇＢｏｏｔ  '), 'springboot');
assert.equal(isTechnicalIdentifier('Spingboot'), true);
assert.equal(isTechnicalIdentifier('RBG'), true);
assert.equal(isNumericOrVersionLike('1.2.3'), true);
assert.equal(isNumericOrVersionLike('2024-08-22'), true);
assert.equal(isNumericOrVersionLike('user-123'), true);
assert.equal(resolveFuzzyRatio('Spingboot'), 0.2);
assert.equal(resolveFuzzyRatio('Ner'), 0);
assert.equal(resolveFuzzyRatio('RBG'), 0);
assert.equal(resolveFuzzyRatio('1.2.3'), 0);
assert.equal(resolveFuzzyRatio('2024-08-22'), 0);
assert.equal(resolveFuzzyRatio('user-123'), 0);

const markdown = `# 词法匹配特征

## 标识符

NER（Named Entity Recognition）用于命名实体识别。

SpringBoot 服务的默认端口是 8080。

RAG 检索链路只接受明确写出的术语。

发布版本固定记录为 1.2.3。

## 中文词元

命名实体识别由本地词法索引按单字和双字词元召回。
`;
const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/lexical-policy.md',
  title: '词法匹配特征',
  contentHash,
  markdown,
  headings: [
    { id: 'root', level: 1, text: '词法匹配特征', line: 1 },
    { id: 'identifiers', level: 2, text: '标识符', line: 3 },
    { id: 'chinese', level: 2, text: '中文词元', line: 15 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const index = new CurrentNoteLexicalIndex(snapshot);

function hitContaining(query, text) {
  const hit = index.search(query, 20).find((candidate) => candidate.snippet.includes(text));
  assert.ok(hit, `${query} should hit a block containing ${text}`);
  return hit;
}

const nerHit = hitContaining('Ner', 'NER');
assert.ok(nerHit.matchedTerms.includes('ner'));
assert.ok(nerHit.matchTypes.includes('exact'));
assert.ok(nerHit.matchTypes.includes('keyword'));
assert.ok(nerHit.matchTypes.includes('identifier'));
assert.ok(!nerHit.matchTypes.includes('fuzzy'));
assert.deepEqual(nerHit.matchTrace.find((trace) => trace.queryTerm === 'ner'), {
  queryTerm: 'ner',
  matchedTerm: 'ner',
  matchType: 'exact',
  confidence: 1,
});

const spingbootHit = hitContaining('Spingboot', 'SpringBoot');
assert.ok(spingbootHit.matchTypes.includes('fuzzy'));
assert.ok(Array.isArray(spingbootHit.matchedTerms));
const spingbootTrace = spingbootHit.matchTrace.find((trace) => trace.matchType === 'fuzzy');
assert.ok(spingbootTrace);
assert.equal(spingbootTrace.matchedTerm, 'springboot');
assert.ok((spingbootTrace.editDistance ?? 0) >= 1);
assert.ok(spingbootHit.score < nerHit.score);

const sprignBootHit = hitContaining('SprignBoot', 'SpringBoot');
assert.ok(sprignBootHit.matchTypes.includes('fuzzy'));
assert.ok(Array.isArray(sprignBootHit.matchedTerms));

const springPrefixHit = hitContaining('Spring', 'SpringBoot');
assert.ok(springPrefixHit.matchTypes.includes('exact'));
assert.ok(springPrefixHit.matchTypes.includes('keyword'));
assert.ok(springPrefixHit.matchTypes.includes('identifier'));
assert.ok(!springPrefixHit.matchTypes.includes('fuzzy'));
assert.ok(springPrefixHit.matchTrace.some((trace) => trace.matchType === 'prefix' && trace.matchedTerm === 'springboot'));

const shortAcronymHits = index.search('RBG', 20);
assert.equal(shortAcronymHits.length, 0);

const versionHit = hitContaining('1.2.3', '1.2.3');
assert.ok(versionHit.matchTypes.includes('exact'));
assert.ok(versionHit.matchTypes.includes('keyword'));
assert.ok(!versionHit.matchTypes.includes('fuzzy'));
const otherVersionHits = index.search('1.2.4', 20);
assert.equal(otherVersionHits.length, 0);

const chineseHit = hitContaining('命名实体识别', '命名实体识别');
assert.ok(chineseHit.matchedTerms.includes('命名'));
assert.ok(chineseHit.matchedTerms.includes('实体'));
assert.ok(chineseHit.matchedTerms.includes('识别'));
assert.ok(chineseHit.matchTypes.includes('exact'));
assert.ok(chineseHit.matchTypes.includes('keyword'));
assert.ok(!chineseHit.matchTypes.includes('fuzzy'));

const definitionMarkdown = `# 定义检索

## NER 模型

NER 是 Named Entity Recognition，中文叫“命名实体识别”。命名实体识别是从文本中找出并分类实体的任务。

## LLM 抽取不是 NER

LLM 抽取不是传统 NER，而是直接输出结构化对象。

## SpringBoot 定义

SpringBoot 是用于构建 Java 服务的应用框架。

## SpringBoot 不属于数据库

SpringBoot 并非数据库。`;
const definitionSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/definition-ranking.md',
  title: '定义检索',
  contentHash: createHash('sha256').update(definitionMarkdown, 'utf8').digest('hex'),
  markdown: definitionMarkdown,
  headings: [
    { id: 'definition-root', level: 1, text: '定义检索', line: 1 },
    { id: 'ner-model', level: 2, text: 'NER 模型', line: 3 },
    { id: 'llm-not-ner', level: 2, text: 'LLM 抽取不是 NER', line: 7 },
    { id: 'springboot-definition', level: 2, text: 'SpringBoot 定义', line: 11 },
    { id: 'springboot-negative', level: 2, text: 'SpringBoot 不属于数据库', line: 15 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const definitionIndex = new CurrentNoteLexicalIndex(definitionSnapshot);

for (const query of ['NER是啥？', 'Ner是什么?', 'NER到底是啥？', 'What is NER?']) {
  const firstHit = definitionIndex.search(query, 8)[0];
  assert.ok(firstHit, `${query} should return a definition candidate`);
  assert.match(firstHit.snippet, /Named Entity Recognition/u);
}

const chineseDefinitionHit = definitionIndex.search('命名实体识别是什么？', 8)[0];
assert.ok(chineseDefinitionHit);
assert.match(chineseDefinitionHit.snippet, /命名实体识别是从文本/u);

const fuzzyDefinitionHit = definitionIndex.search('Spingboot是什么？', 8)[0];
assert.ok(fuzzyDefinitionHit);
assert.match(fuzzyDefinitionHit.snippet, /SpringBoot 是用于构建 Java 服务/u);
assert.ok(fuzzyDefinitionHit.matchTypes.includes('fuzzy'));

console.log('Lexical match policy verification passed');
