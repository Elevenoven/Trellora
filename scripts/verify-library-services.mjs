import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-library-services');
const outFile = path.join(outDir, 'libraryServices.cjs');
const libraryDir = path.join(outDir, 'library');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

await build({
  entryPoints: [path.join(rootDir, 'electron', 'libraryServices.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  ensureBackupBeforeSave,
  listBackupsForNote,
  saveEditorImageToLibrary,
} = await import(pathToFileURL(outFile).href);

const notePath = path.join(libraryDir, 'Note.md');
writeFileSync(notePath, 'version 1', 'utf8');

const firstBackup = ensureBackupBeforeSave(notePath, 'version 2', libraryDir, {
  now: new Date('2026-07-04T10:00:00Z'),
});
assert.ok(firstBackup?.path.endsWith('.md'));
assert.equal(readFileSync(firstBackup.path, 'utf8'), 'version 1');

const skippedBackup = ensureBackupBeforeSave(notePath, 'version 3', libraryDir, {
  now: new Date('2026-07-04T10:01:00Z'),
});
assert.equal(skippedBackup, null);

for (let i = 0; i < 25; i++) {
  writeFileSync(notePath, `version ${i + 10}`, 'utf8');
  ensureBackupBeforeSave(notePath, `version ${i + 11}`, libraryDir, {
    now: new Date(Date.UTC(2026, 6, 4, 11, i * 6, 0)),
    maxBackups: 20,
  });
}

const backups = listBackupsForNote(notePath, libraryDir);
assert.equal(backups.length, 3);
assert.ok(backups.every((backup) => existsSync(backup.path)));

await build({ entryPoints: [path.join(rootDir, 'electron', 'noteSaveService.ts')], outfile: path.join(outDir, 'noteSaveService.cjs'), bundle: true, platform: 'node', format: 'cjs' });
const { NoteSaveService } = await import(pathToFileURL(path.join(outDir, 'noteSaveService.cjs')).href);
const saveService = new NoteSaveService({ getLibraryPath: () => libraryDir, backupRetention: () => 20, committed: async () => {} });
const snapshot = await saveService.open(1, notePath);
const restored = readFileSync(backups.at(-1).path, 'utf8');
const restoredResult = await saveService.save(1, { editSessionId: snapshot.editSessionId, requestId: 'restore', editRevision: 1, expectedDiskHash: snapshot.version.diskHash, content: '' }, () => restored, 'restore-fixture');
assert.equal(restoredResult.status, 'committed');
assert.equal(readFileSync(notePath, 'utf8'), restored);

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const rootImage = saveEditorImageToLibrary(
  libraryDir,
  notePath,
  pngBytes,
  new Date(2026, 7, 26, 17, 23, 21, 595),
);
assert.equal(rootImage.markdownPath, `image/${rootImage.fileName}`);
assert.match(rootImage.fileName, /^image-20260826-172321-595\.png$/);
assert.equal(readFileSync(rootImage.absolutePath).equals(pngBytes), true);

const nestedDirectory = path.join(libraryDir, 'docs');
mkdirSync(nestedDirectory, { recursive: true });
const nestedNotePath = path.join(nestedDirectory, 'Design.md');
writeFileSync(nestedNotePath, '# Design\n', 'utf8');
const nestedImage = saveEditorImageToLibrary(
  libraryDir,
  nestedNotePath,
  pngBytes,
  new Date(2026, 7, 26, 17, 23, 21, 595),
);
assert.equal(nestedImage.markdownPath, `../image/${nestedImage.fileName}`);
assert.match(nestedImage.fileName, /^image-20260826-172321-595-1\.png$/);

assert.throws(
  () => saveEditorImageToLibrary(libraryDir, notePath, Buffer.from([1, 2, 3])),
  /只支持 PNG、JPEG、GIF 或 WebP 图片/,
);

console.log('Library services verification passed');
