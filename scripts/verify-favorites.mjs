import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-favorites');
const outFile = path.join(outDir, 'metaDatabase.cjs');
const libraryDir = path.join(outDir, 'library');
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

const { getFavoriteNotePaths, setFavoriteNote, synchronizeKnowledgeIndex } = await import(pathToFileURL(outFile).href);
const firstPath = path.join(libraryDir, 'First.md');
const secondPath = path.join(libraryDir, 'Second.md');
const toNote = (notePath, index) => ({
  path: notePath,
  relativePath: path.basename(notePath),
  title: path.basename(notePath, '.md'),
  kind: 'markdown',
  extension: '.md',
  mtimeMs: index,
  facts: { frontmatter: {}, headings: [], tags: [], outgoingLinks: [], plainText: '', contentHash: `hash-${index}` },
});

synchronizeKnowledgeIndex(libraryDir, [toNote(firstPath, 1), toNote(secondPath, 2)]);
assert.deepEqual(getFavoriteNotePaths(libraryDir), []);
assert.deepEqual(setFavoriteNote(libraryDir, firstPath, true), [firstPath]);
assert.deepEqual(setFavoriteNote(libraryDir, secondPath, true), [firstPath, secondPath]);
assert.deepEqual(setFavoriteNote(libraryDir, firstPath, false), [secondPath]);

synchronizeKnowledgeIndex(libraryDir, [toNote(firstPath, 1)]);
assert.deepEqual(getFavoriteNotePaths(libraryDir), []);
assert.throws(() => setFavoriteNote(libraryDir, secondPath, true), /已建立索引/);

console.log('Favorites verification passed: add, remove, ordering, cascade cleanup, and indexed-note safety');
process.exit(0);
