import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-note-lexical-index');
const outFile = path.join(outDir, 'noteLexicalIndex.cjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteLexicalIndex.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  createNoteLexicalIndex,
  searchNoteLexically,
  tokenizeNoteSearchText,
  toNoteSearchDocument,
} = await import(pathToFileURL(outFile).href);

assert.deepEqual(tokenizeNoteSearchText('关键词检索'), [
  '关', '键', '词', '检', '索',
  '关键', '键词', '词检', '检索',
]);
assert.deepEqual(tokenizeNoteSearchText('ＲＡＧ检索 node.js v1.2.3'), [
  'rag', '检', '索', '检索', 'node.js', 'node', 'js', 'v1.2.3', 'v1',
]);

const notes = [
  {
    path: 'A.md',
    title: '连续短语示例',
    plainText: '正文介绍关键词检索。',
    tags: ['GraphRAG'],
  },
  {
    path: 'B.md',
    title: '零散字符示例',
    plainText: '关 键 词 检 索分别出现，但不是连续短语。',
    tags: [],
  },
  {
    path: 'C.md',
    title: '接口兼容性',
    plainText: '接口版本是 v1.2.3，使用 node.js。',
    tags: ['ＡＰＩ'],
  },
  {
    path: 'D.md',
    title: '标题优先词',
    plainText: '正文没有重复目标词。',
    tags: [],
  },
  {
    path: 'E.md',
    title: '正文匹配示例',
    plainText: '标题优先词出现在正文。',
    tags: [],
  },
];

const currentLibraryIndex = createNoteLexicalIndex();
for (const note of notes) currentLibraryIndex.add(toNoteSearchDocument(note));
const crossLibraryIndex = createNoteLexicalIndex();
crossLibraryIndex.addAll(notes.map(toNoteSearchDocument));

const projectResults = (index, query) => searchNoteLexically(index, query).map((result) => ({
  path: result.path,
  score: result.score,
}));
const paths = (index, query) => projectResults(index, query).map((result) => result.path);
for (const query of ['关键词检索', 'GraphRAG', 'API', 'ＡＰＩ', 'node.js', 'v1.2.3', '标题优先词']) {
  assert.deepEqual(
    projectResults(currentLibraryIndex, query),
    projectResults(crossLibraryIndex, query),
    `${query} must have identical current/cross-library ordering`,
  );
}

assert.equal(paths(currentLibraryIndex, 'GraphRAG')[0], 'A.md', 'tag-only terms must be searchable');
assert.equal(paths(currentLibraryIndex, 'API')[0], 'C.md', 'NFKC must normalize full-width tags');
assert.equal(paths(currentLibraryIndex, '关键词检索')[0], 'A.md', 'contiguous body bigrams must outrank scattered characters');
assert.equal(paths(currentLibraryIndex, '标题优先词')[0], 'D.md', 'title matches must keep the shared title boost');
assert.equal(paths(currentLibraryIndex, 'v1.2.4').includes('C.md'), false, 'a different version must not fuzzy-match v1.2.3');

console.log('Note lexical index verification passed: shared configuration, NFKC, CJK bigrams, tags, title boost, and version guard');
