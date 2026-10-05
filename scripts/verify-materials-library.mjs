import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const materialsViewSource = readFileSync(path.join(rootDir, 'src', 'components', 'MaterialsView.tsx'), 'utf8');
const outDir = path.join(rootDir, '.package-staging', 'verify-materials-library');
const outFile = path.join(outDir, 'materialsLibrary.cjs');
const workspaceDir = path.join(outDir, 'workspace');
const sourceDir = path.join(outDir, 'sources');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });

await build({
  stdin: {
    contents: `
      export * from './electron/materialsLibrary';
      export { listRegisteredLibraries, registerAndActivateLibrary } from './electron/libraryRegistry';
      export { createLibraryDirectory } from './electron/libraryCreation';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  activateMaterialsLibrary,
  createLibraryDirectory,
  createMaterialsLibraryDirectory,
  ensureMaterialsMeta,
  ensureMaterialsRoot,
  importMaterialsDocuments,
  listMaterialsDocuments,
  listMaterialsLibraries,
  listRegisteredLibraries,
  materialsManifestPath,
  registerAndActivateLibrary,
  registerMaterialsLibrary,
  removeMaterialsLibrary,
  readMaterialsDocumentBytes,
  renameMaterialsDocument,
  renameMaterialsLibrary,
  summarizeMaterialsLibraries,
  upgradeRegisteredLibraryToMaterials,
} = await import(pathToFileURL(outFile).href);

function createMockStore() {
  const data = new Map();
  return {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    delete: (key) => { data.delete(key); },
  };
}

const store = createMockStore();

// 1. Dedicated knowledge-base root inside the workspace + "name-timestamp" library folder with documents/
const root = ensureMaterialsRoot(workspaceDir);
assert.equal(existsSync(root), true, 'workspace should contain the dedicated knowledge-base root');

const created = createMaterialsLibraryDirectory(root, 'paper-archive', new Date(2026, 7, 18, 9, 30, 0));
assert.equal(created.alias, 'paper-archive');
assert.match(path.basename(created.path), /^paper-archive-20260818-093000$/);
assert.equal(path.dirname(created.path), root, 'library folder must live under the knowledge-base root');
assert.equal(existsSync(path.join(created.path, 'documents')), true, 'documents directory must exist');

ensureMaterialsMeta(created.path);
assert.equal(existsSync(materialsManifestPath(created.path)), true, 'manifest should exist after creation');

registerMaterialsLibrary(store, created.path, created.alias, 'created', 'archive');
let summaries = summarizeMaterialsLibraries(store);
assert.equal(summaries.length, 1);
assert.equal(summaries[0].isActive, true);
assert.equal(summaries[0].origin, 'created');
assert.equal(summaries[0].icon, 'archive');
assert.equal(summaries[0].documentCount, 0);
assert.equal(summaries[0].vectorState, '\u672a\u542f\u7528'); // 未启用

// 2. Upload documents: copied into <library>/documents, registered with content hash
const markdownSource = path.join(sourceDir, 'survey.md');
const pdfSource = path.join(sourceDir, 'paper.pdf');
writeFileSync(markdownSource, '# Survey\nmaterial for future vectorization.', 'utf8');
writeFileSync(pdfSource, Buffer.from('%PDF-1.4 fake pdf body'));

let documents = importMaterialsDocuments(created.path, [markdownSource, pdfSource]);
assert.equal(documents.length, 2, 'two documents should be registered');
const markdownDocument = documents.find((entry) => entry.name === 'survey.md');
const pdfDocument = documents.find((entry) => entry.name === 'paper.pdf');
assert.ok(markdownDocument);
assert.ok(pdfDocument);
assert.equal(markdownDocument.vectorState, 'pending');
assert.match(markdownDocument.contentHash, /^[0-9a-f]{64}$/);
assert.equal(markdownDocument.relativePath, 'documents/survey.md');
assert.equal(existsSync(path.join(created.path, 'documents', 'survey.md')), true, 'document should be copied into documents/');
assert.deepEqual(
  [...readMaterialsDocumentBytes(created.path, pdfDocument.id)],
  [...Buffer.from('%PDF-1.4 fake pdf body')],
  'binary preview reads the registered PDF bytes through the guarded document path',
);
assert.equal(readMaterialsDocumentBytes(created.path, markdownDocument.id), null, 'text documents stay on the text IPC path');

summaries = summarizeMaterialsLibraries(store);
assert.equal(summaries[0].documentCount, 2);
assert.equal(summaries[0].vectorState, '\u5f85\u7d22\u5f15'); // 待索引
assert.ok(summaries[0].totalSizeBytes > 0);

// 3. Unsupported file types are rejected
const exeSource = path.join(sourceDir, 'tool.exe');
writeFileSync(exeSource, 'binary');
assert.throws(() => importMaterialsDocuments(created.path, [exeSource]), /\u4e0d\u652f\u6301\u7684\u6587\u4ef6\u7c7b\u578b/); // 不支持的文件类型

// 4. Re-sync keeps entries unique and hashes stable
const resynced = listMaterialsDocuments(created.path);
assert.equal(resynced.length, 2);
assert.equal(
  resynced.find((entry) => entry.name === 'survey.md').contentHash,
  markdownDocument.contentHash,
);

// 5. Deleting a file on disk removes its manifest entry on next sync
// (unlinkSync: rmSync on a single file under a non-ASCII directory is unreliable on Windows)
unlinkSync(path.join(created.path, 'documents', 'paper.pdf'));
documents = listMaterialsDocuments(created.path);
assert.equal(documents.length, 1);
assert.equal(documents[0].name, 'survey.md');

// 5b. Rename keeps id / hash, extension preserved when omitted, unsupported target rejected
const beforeRename = documents[0];
const renamed = renameMaterialsDocument(created.path, beforeRename.id, 'survey-final');
assert.equal(renamed.length, 1);
assert.equal(renamed[0].name, 'survey-final.md');
assert.equal(renamed[0].relativePath, 'documents/survey-final.md');
assert.equal(renamed[0].id, beforeRename.id, 'rename must keep the document id');
assert.equal(renamed[0].contentHash, beforeRename.contentHash, 'rename must not change content hash');
assert.throws(() => renameMaterialsDocument(created.path, renamed[0].id, 'tool.exe'), /\u4e0d\u652f\u6301/); // 不支持
documents = listMaterialsDocuments(created.path);
assert.equal(documents[0].name, 'survey-final.md');

// 6. Rename + activation guard
renameMaterialsLibrary(store, created.path, 'research-archive');
summaries = summarizeMaterialsLibraries(store);
assert.equal(summaries[0].alias, 'research-archive');
assert.throws(() => activateMaterialsLibrary(store, path.join(workspaceDir, 'missing')), /\u5c1a\u672a\u6ce8\u518c/); // 尚未注册

// 7. Upgrade a note library: copies documents into a new library folder, note library stays registered
const noteLibrary = createLibraryDirectory({ name: 'reading-notes', workspacePath: workspaceDir, now: new Date(2026, 7, 18, 10, 0, 0) });
registerAndActivateLibrary(store, noteLibrary.path, new Date(), noteLibrary.alias);
writeFileSync(path.join(noteLibrary.path, 'chapter-one.md'), '# Chapter One', 'utf8');
writeFileSync(path.join(noteLibrary.path, 'memo.txt'), 'memo content', 'utf8');
mkdirSync(path.join(noteLibrary.path, 'notes'), { recursive: true });
writeFileSync(path.join(noteLibrary.path, 'notes', 'inner.md'), '# Inner', 'utf8');

const upgraded = upgradeRegisteredLibraryToMaterials(store, noteLibrary.path, workspaceDir, 'book');
assert.equal(upgraded.origin, 'upgraded');
assert.equal(upgraded.icon, 'book');
assert.ok(upgraded.upgradedAt);
assert.notEqual(upgraded.path, noteLibrary.path, 'upgrade must create a fresh library folder');
assert.equal(path.dirname(upgraded.path), root, 'upgraded library must live under the knowledge-base root');
assert.equal(listRegisteredLibraries(store).some((library) => library.path === noteLibrary.path), true, 'note library must stay registered');
assert.equal(existsSync(path.join(noteLibrary.path, 'chapter-one.md')), true, 'original notes must remain on disk');

summaries = summarizeMaterialsLibraries(store);
assert.equal(summaries.length, 2);
const upgradedSummary = summaries.find((entry) => entry.path === upgraded.path);
assert.ok(upgradedSummary);
assert.equal(upgradedSummary.origin, 'upgraded');
assert.equal(upgradedSummary.documentCount, 3, 'notes (incl. nested) should be copied as documents');
assert.equal(upgradedSummary.isActive, true, 'upgraded library should become the active materials library');

const upgradedDocuments = listMaterialsDocuments(upgraded.path);
assert.ok(upgradedDocuments.find((entry) => entry.relativePath === 'documents/notes/inner.md'), 'relative structure should be preserved');

// 8. Removing a registration never deletes files on disk
const remaining = removeMaterialsLibrary(store, created.path);
assert.equal(remaining.length, 1);
assert.equal(existsSync(path.join(created.path, 'documents', 'survey-final.md')), true, 'removing registration must not delete files');
assert.equal(listMaterialsLibraries(store)[0].path, upgraded.path);

// 9. Manifest keeps the fields required by the future sqlite-vec pipeline
const manifest = JSON.parse(readFileSync(materialsManifestPath(upgraded.path), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.ok(manifest.libraryId, 'manifest should keep a stable libraryId as the vector collection id');
for (const entry of manifest.documents) {
  assert.ok(entry.id && entry.contentHash && entry.vectorState, 'each document should keep id / contentHash / vectorState');
}

assert.match(
  materialsViewSource,
  /previousDocumentIds\s*=\s*new Set\(documents\.map\([\s\S]*?firstImportedDocument\s*=\s*nextDocuments\.find\([\s\S]*?setSelectedDocumentId\(firstImportedDocument\.id\)/,
  'materials upload must select a document whose id was not present before the import',
);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-materials-library: all assertions passed (workspace root, documents dir, copy-upgrade, manifest hashing, vector-ready fields)');
