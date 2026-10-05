import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-note-index');
const outFile = path.join(outDir, 'noteIndex.cjs');
const libraryDir = path.join(outDir, 'library');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(libraryDir, 'nested'), { recursive: true });

writeFileSync(path.join(libraryDir, 'A.md'), `---
title: Alpha Note
tags:
  - project
  - idea
created: 2026-07-04
---

# Alpha Heading

正文 #inlineTag 和链接 [[B]]，还有 [[Missing|缺失页面]]。

## Alpha Child

### Alpha Leaf
`, 'utf8');

writeFileSync(path.join(libraryDir, 'B.md'), `# B Page

Backlink target.
`, 'utf8');

writeFileSync(path.join(libraryDir, 'C.md'), `# C Page

References [[B|B alias]] and #project.
`, 'utf8');

writeFileSync(path.join(libraryDir, 'Duplicate.md'), '# Root duplicate\n', 'utf8');
writeFileSync(path.join(libraryDir, 'nested', 'FromNested.md'), '[[Duplicate]]\n', 'utf8');
writeFileSync(path.join(libraryDir, 'nested', 'Duplicate.md'), '# Nested duplicate\n', 'utf8');
writeFileSync(path.join(libraryDir, 'Related.markdown'), '# Related Markdown\n', 'utf8');
writeFileSync(path.join(libraryDir, 'Malformed.md'), `---
title: [broken
tags: [unfinished
---

# Still Loadable

The original Markdown must remain available.
`, 'utf8');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  buildNoteIndex,
  getAllTags,
  getBacklinks,
  getNoteMeta,
  resolveWikiLink,
} = await import(pathToFileURL(outFile).href);

const index = buildNoteIndex(libraryDir);
const aPath = path.join(libraryDir, 'A.md');
const bPath = path.join(libraryDir, 'B.md');
const cPath = path.join(libraryDir, 'C.md');
const nestedFromPath = path.join(libraryDir, 'nested', 'FromNested.md');
const nestedDuplicatePath = path.join(libraryDir, 'nested', 'Duplicate.md');
const relatedMarkdownPath = path.join(libraryDir, 'Related.markdown');
const malformedPath = path.join(libraryDir, 'Malformed.md');

const aMeta = getNoteMeta(index, aPath);
assert.equal(aMeta.title, 'Alpha Note');
assert.deepEqual(aMeta.tags.sort(), ['idea', 'inlineTag', 'project'].sort());
assert.equal(aMeta.frontmatter.created, '2026-07-04');
assert.deepEqual(aMeta.headings.map((heading) => [heading.level, heading.text]), [
  [1, 'Alpha Heading'],
  [2, 'Alpha Child'],
  [3, 'Alpha Leaf'],
]);
assert.deepEqual(aMeta.outgoingLinks, [
  { target: 'B' },
  { target: 'Missing', alias: '缺失页面' },
]);

const bBacklinks = getBacklinks(index, bPath);
assert.deepEqual(
  bBacklinks.map((entry) => [entry.sourcePath, entry.sourceTitle]).sort(),
  [
    [aPath, 'Alpha Note'],
    [cPath, 'C Page'],
  ].sort(),
);
assert.ok(bBacklinks.every((entry) => entry.snippet.includes('[[B')));

const tags = getAllTags(index);
assert.deepEqual(tags.find((tag) => tag.tag === 'project'), { tag: 'project', count: 2 });
assert.deepEqual(tags.find((tag) => tag.tag === 'idea'), { tag: 'idea', count: 1 });
assert.deepEqual(tags.find((tag) => tag.tag === 'inlineTag'), { tag: 'inlineTag', count: 1 });

assert.equal(resolveWikiLink(index, 'B', aPath), bPath);
assert.equal(resolveWikiLink(index, 'Duplicate', nestedFromPath), nestedDuplicatePath);
assert.equal(resolveWikiLink(index, '../Related.markdown', nestedFromPath), relatedMarkdownPath);
assert.equal(resolveWikiLink(index, '../../outside.md', nestedFromPath), null,
  'Relative Markdown navigation must not resolve outside the indexed library.');
assert.equal(resolveWikiLink(index, 'Missing', aPath), null);

const malformedMeta = getNoteMeta(index, malformedPath);
assert.equal(malformedMeta.title, 'Still Loadable');
assert.equal(malformedMeta.rawMarkdown.includes('title: [broken'), true);
assert.equal(malformedMeta.contentMarkdown, malformedMeta.rawMarkdown);

console.log('Note index verification passed');
