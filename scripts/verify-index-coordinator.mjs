import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-index-coordinator');
const outFile = path.join(outDir, 'indexCoordinator.cjs');
const libraryDir = path.join(outDir, 'library');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });
writeFileSync(path.join(libraryDir, 'Existing.md'), '# Existing\n\n#stable', 'utf8');
const metaDir = path.join(libraryDir, '.menghan-meta');
mkdirSync(metaDir, { recursive: true });
const legacyDatabase = new Database(path.join(metaDir, 'index.db'));
sqliteVec.load(legacyDatabase);
legacyDatabase.exec(`
  CREATE VIRTUAL TABLE semantic_chunk_vectors USING vec0(embedding float[3]);
  CREATE TABLE semantic_chunks (id TEXT);
  CREATE TABLE semantic_index_meta (id TEXT);
  CREATE TABLE vector_index_entries (id TEXT);
  CREATE TABLE knowledge_graph_edges (id TEXT);
  CREATE TABLE knowledge_graph_nodes (id TEXT);
`);
legacyDatabase.close();

await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'indexCoordinator.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['better-sqlite3'],
});

await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteIndexWorker.ts')], outfile: path.join(outDir, 'noteIndexWorker.js'), bundle: true, platform: 'node', format: 'cjs' });
const { KnowledgeIndexCoordinator } = await import(pathToFileURL(outFile).href);
const documents = new Map();
const searchIndex = {
  removeAll: () => documents.clear(),
  add: (document) => documents.set(document.id, document),
  has: (id) => documents.has(id),
  replace: (document) => documents.set(document.id, document),
  discard: (id) => documents.delete(id),
};
const messages = [];
const coordinator = new KnowledgeIndexCoordinator((message) => messages.push(message));

const initial = coordinator.synchronize(libraryDir, searchIndex);
assert.equal(initial.noteIndex.notes.length, 1);
assert.equal(initial.database.indexed, 1);
assert.equal(documents.size, 1);
const cleanedDatabase = new Database(path.join(metaDir, 'index.db'), { readonly: true });
const obsoleteTables = cleanedDatabase.prepare(`
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN ('semantic_chunk_vectors', 'semantic_chunks', 'semantic_index_meta', 'vector_index_entries', 'knowledge_graph_edges', 'knowledge_graph_nodes')
`).all();
cleanedDatabase.close();
assert.deepEqual(obsoleteTables, []);

const unchanged = coordinator.synchronize(libraryDir, searchIndex);
assert.equal(unchanged.database.indexed, 0);
assert.equal(unchanged.database.skipped, 1);

const updates = [];
coordinator.startWatching(libraryDir, searchIndex, (result, changes) => updates.push({ result, changes }));
await delay(500);

const addedPath = path.join(libraryDir, 'Added.md');
writeFileSync(addedPath, '# Added\n\n[[Existing]]', 'utf8');
const afterAdd = await waitForUpdate(updates, (update) => update.result.noteIndex.notes.some((note) => note.path === addedPath));
assert.equal(afterAdd.changes.some((change) => change.kind === 'add' && change.path === addedPath), true);
assert.equal(afterAdd.result.database.indexed, 1);
assert.equal(documents.size, 2);

writeFileSync(addedPath, '# Added changed\n\n[[Existing]] #updated', 'utf8');
const afterChange = await waitForUpdate(updates, (update) => update.changes.some((change) => change.kind === 'change' && change.path === addedPath));
assert.equal(afterChange.result.noteIndex.notes.find((note) => note.path === addedPath)?.title, 'Added changed');

rmSync(addedPath);
const afterDelete = await waitForUpdate(updates, (update) => update.changes.some((change) => change.kind === 'unlink' && change.path === addedPath));
assert.equal(afterDelete.result.noteIndex.notes.some((note) => note.path === addedPath), false);
assert.equal(afterDelete.result.database.removed, 1);
assert.equal(documents.size, 1);

await coordinator.shutdown();
assert.equal(messages.some((message) => message.includes('SQLite index synchronized')), true);

console.log('Index coordinator verification passed: incremental add, change, delete, search, and SQLite synchronization');
process.exit(0);

async function waitForUpdate(updates, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const match = updates.find(predicate);
    if (match) return match;
    await delay(100);
  }
  throw new Error('Timed out waiting for an incremental index update.');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
