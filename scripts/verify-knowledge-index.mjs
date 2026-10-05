import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-index');
const outFile = path.join(outDir, 'knowledge-index.cjs');
const libraryDir = path.join(outDir, 'library');
const notePath = path.join(libraryDir, 'Knowledge.md');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'metaDatabase.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3'],
});

const astOutFile = path.join(outDir, 'markdown-ast.cjs');
await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'markdownAst.ts')],
  outfile: astOutFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { extractMarkdownKnowledgeFacts } = await import(pathToFileURL(astOutFile).href);
const { getAiInsight, saveAiInsight, synchronizeKnowledgeIndex } = await import(pathToFileURL(outFile).href);

const markdown = `---
title: Knowledge Root
tags:
  - architecture
---

# 总览

正文 #知识管理，引用 [[目标笔记|显示名称]]。

\`\`\`ts
const ignored = '#not-a-tag';
\`\`\`
`;
const originalMarkdown = markdown;
writeFileSync(notePath, markdown, 'utf8');
const facts = extractMarkdownKnowledgeFacts(markdown);

assert.equal(facts.frontmatter.title, 'Knowledge Root');
assert.deepEqual(facts.tags, ['知识管理', 'architecture']);
assert.deepEqual(facts.headings.map((heading) => [heading.level, heading.text]), [[1, '总览']]);
assert.deepEqual(facts.outgoingLinks, [{ target: '目标笔记', alias: '显示名称' }]);
assert.ok(!facts.tags.includes('not-a-tag'));

const note = {
  path: notePath,
  relativePath: 'Knowledge.md',
  title: 'Knowledge Root',
  kind: 'markdown',
  extension: '.md',
  mtimeMs: 1,
  facts,
};
const firstSync = synchronizeKnowledgeIndex(libraryDir, [note]);
assert.deepEqual(firstSync, { indexed: 1, skipped: 0, removed: 0 });

const databasePath = path.join(libraryDir, '.menghan-meta', 'index.db');
assert.ok(existsSync(databasePath));
const database = new Database(databasePath, { readonly: true });
assert.deepEqual(database.prepare('SELECT title, content_hash FROM notes').get(), {
  title: 'Knowledge Root',
  content_hash: facts.contentHash,
});
assert.deepEqual(database.prepare('SELECT tag FROM note_tags ORDER BY tag').all(), [
  { tag: 'architecture' },
  { tag: '知识管理' },
]);
assert.deepEqual(database.prepare('SELECT target, alias FROM note_links').all(), [
  { target: '目标笔记', alias: '显示名称' },
]);
database.close();

const secondSync = synchronizeKnowledgeIndex(libraryDir, [note]);
assert.deepEqual(secondSync, { indexed: 0, skipped: 1, removed: 0 });
const savedInsight = saveAiInsight(libraryDir, {
  notePath,
  contentHash: facts.contentHash,
  provider: 'ollama',
  model: 'test-model',
  summary: '这是独立保存的 AI 摘要。',
  keyPoints: ['不修改笔记内容'],
  suggestedTags: ['建议标签'],
});
assert.equal(savedInsight.model, 'test-model');
assert.deepEqual(getAiInsight(libraryDir, notePath, facts.contentHash), savedInsight);
assert.deepEqual(synchronizeKnowledgeIndex(libraryDir, []), { indexed: 0, skipped: 0, removed: 1 });
assert.equal(getAiInsight(libraryDir, notePath, facts.contentHash), null);
assert.equal(originalMarkdown, markdown);
assert.equal(readFileSync(notePath, 'utf8'), originalMarkdown);

console.log('Knowledge AST and SQLite index verification passed');
process.exit(0);
