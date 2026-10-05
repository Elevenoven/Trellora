import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';

const staging = path.resolve('.package-staging');
fs.mkdirSync(staging, { recursive: true });
const temporary = fs.mkdtempSync(path.join(staging, 'security-regressions-'));
const require = createRequire(import.meta.url);
const junctions = [];
const watchers = [];
let mermaidWorker;
try {
  await build({ entryPoints: ['shared/frontmatter.ts', 'electron/noteIndex.ts', 'electron/pathGuards.ts', 'electron/libraryFileOps.ts', 'electron/noteBackups.ts',
    'electron/importFiles.ts', 'electron/markdownExportImages.ts', 'electron/knowledge/noteAnalysisSource.ts', 'electron/knowledge/tagSuggestion.ts', 'electron/wiki/wikiNoteImport.ts'],
  outdir: temporary, outbase: '.', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const load = source => require(path.join(temporary, source.replace(/\.ts$/, '.js')));
  const frontmatter = load('shared/frontmatter.ts');
  const index = load('electron/noteIndex.ts');
  const guards = load('electron/pathGuards.ts');
  const operations = load('electron/libraryFileOps.ts');
  const backups = load('electron/noteBackups.ts');
  const imports = load('electron/importFiles.ts');
  const analysis = load('electron/knowledge/noteAnalysisSource.ts');
  const tags = load('electron/knowledge/tagSuggestion.ts');
  const wiki = load('electron/wiki/wikiNoteImport.ts');
  const remote = load('electron/markdownExportImages.ts');
  const library = name => { const directory = path.join(temporary, name); fs.mkdirSync(directory); return directory; };
  const write = (directory, name, body = '# 原文') => { const file = path.join(directory, name); fs.writeFileSync(file, body); return file; };

  // Former execution entry points must not write even an isolated marker file.
  const execution = library('execution');
  const marker = path.join(temporary, 'must-not-exist');
  const malicious = language => `---${language}\n({tags: [], checked: (require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), true)})\n---\n# 正文`;
  for (const language of ['javascript', 'js', 'JavaScript']) {
    const payload = malicious(language);
    assert.throws(() => frontmatter.parseNoteFrontmatter(payload), /不支持/);
    const note = write(execution, `${language}.md`, payload);
    assert.equal(index.parseNoteContent(note, payload, 1).contentMarkdown, payload);
    analysis.getNoteAnalysisSourceHash(payload);
    assert.throws(() => tags.applyConfirmedTags(payload, ['确认标签']), /不支持/);
  }
  index.buildNoteIndex(execution);
  const materials = library('materials'), parseDirectory = path.join(materials, 'parse');
  fs.mkdirSync(parseDirectory);
  write(parseDirectory, 'line-layout.jsonl', '');
  write(parseDirectory, 'document.md', '# 正常文档');
  const wikiInput = { sourceLibraryPath: materials, targetLibraryPath: execution, parseDirectory, documentId: 'document', contentHash: 'version', documentName: '正常文档.pdf' };
  await wiki.importWikiDocumentAsNote(wikiInput);
  write(parseDirectory, 'document.md', malicious('javascript'));
  await assert.rejects(wiki.importWikiDocumentAsNote({ ...wikiInput, documentId: 'malicious' }), /不支持/);
  assert.equal(fs.existsSync(marker), false);
  const body = '正文\r\n末尾没有换行';
  const tagged = tags.applyConfirmedTags(`---\ntags: [已有]\nreviewed: true\n---\n${body}`, ['新增']);
  assert.equal(frontmatter.parseNoteFrontmatter(tagged.markdown).content, body);
  assert.deepEqual(frontmatter.parseNoteFrontmatter(tagged.markdown).data.tags, ['已有', '新增']);
  assert.equal(frontmatter.parseNoteFrontmatter('---json\n{"title":"JSON"}\n---\n正文').data.title, 'JSON');
  assert.throws(() => frontmatter.parseFrontmatterMapping('a: &a {self: *a}'), /循环/);
  assert.throws(() => frontmatter.parseFrontmatterMapping(`a: ${'x'.repeat(65536)}`), /64 KB/);

  // Child junctions fail for reads, creation and imports; an explicitly selected root alias works.
  const boundary = library('boundary'), outside = library('outside');
  const external = write(outside, '外部.md');
  const junction = path.join(boundary, 'linked');
  fs.symlinkSync(outside, junction, 'junction'); junctions.push(junction);
  assert.throws(() => guards.assertInsideDirectory(path.join(junction, '外部.md'), boundary), /笔记库/);
  assert.throws(() => operations.createFolderInLibrary(boundary, junction, '不能创建'), /笔记库/);
  assert.throws(() => imports.importTextFilesToLibrary({ libraryPath: boundary, targetDirectoryPath: junction, sourcePaths: [external] }), /笔记库/);
  assert.deepEqual(fs.readdirSync(outside), ['外部.md']);
  const rootAlias = path.join(temporary, 'selected-root');
  fs.symlinkSync(outside, rootAlias, 'junction'); junctions.push(rootAlias);
  assert.equal(guards.assertInsideDirectory(path.join(rootAlias, '外部.md'), rootAlias), path.join(rootAlias, '外部.md'));
  const dotted = path.join(boundary, '..合法文件夹'); fs.mkdirSync(dotted);
  assert.equal(guards.assertInsideDirectory(dotted, boundary), dotted);

  // Full extensions own both histories and the five-minute backup interval.
  const ownership = library('ownership');
  const md = write(ownership, 'same.md'), txt = write(ownership, 'same.txt');
  const mdBackup = await backups.createNoteBackup(md, ownership, Buffer.from('Markdown历史'), new Date(2026, 8, 1, 12), 0);
  assert.equal(backups.listNoteBackups(txt, ownership).length, 0);
  assert.throws(() => backups.readNoteBackup(txt, ownership, mdBackup.id), /找不到/);
  const txtBackup = await backups.createNoteBackup(txt, ownership, Buffer.from('TXT历史'), new Date(2026, 8, 1, 12, 0, 1));
  assert(txtBackup);
  assert.equal(backups.readNoteBackup(txt, ownership, txtBackup.id).toString(), 'TXT历史');

  const legacy = library('legacy'), legacyMd = write(legacy, 'shared.md'), legacyTxt = write(legacy, 'shared.txt');
  const oldDirectory = path.join(legacy, '.menghan-backups', 'shared'); fs.mkdirSync(oldDirectory, { recursive: true });
  const oldBackup = write(oldDirectory, '20260101-120000.md', '归属未知');
  assert.equal(backups.listNoteBackups(legacyMd, legacy).length, 0);
  assert.equal(backups.listNoteBackups(legacyTxt, legacy).length, 0);
  fs.unlinkSync(legacyTxt);
  assert.equal(backups.listNoteBackups(legacyMd, legacy).length, 0, 'Ambiguity persists after a sibling is removed');
  assert.equal(fs.readFileSync(oldBackup, 'utf8'), '归属未知');
  const attributable = library('attributable'), attributedNote = write(attributable, '独立.md');
  const oldAttributed = path.join(attributable, '.menghan-backups', '独立'); fs.mkdirSync(oldAttributed, { recursive: true });
  write(oldAttributed, '20260101-120000.md', '旧格式历史');
  assert.equal(backups.listNoteBackups(attributedNote, attributable).length, 1);
  assert.equal(fs.existsSync(oldAttributed), false);

  // A note with no history must not inherit an orphan history at its destination.
  const noHistory = write(ownership, 'fresh.md'), deleted = write(ownership, 'deleted.md');
  const orphan = await backups.createNoteBackup(deleted, ownership, Buffer.from('已删除笔记历史'), new Date(), 0);
  fs.unlinkSync(deleted);
  await assert.rejects(() => operations.renameEntryInLibrary(ownership, noHistory, 'deleted'), /目标路径已有笔记历史/);
  const orphanLegacy = path.join(ownership, '.menghan-backups', 'deleted-legacy'); fs.mkdirSync(orphanLegacy, { recursive: true });
  write(orphanLegacy, '20260101-120000.md', '已删除旧格式历史');
  await assert.rejects(() => operations.renameEntryInLibrary(ownership, noHistory, 'deleted-legacy'), /目标路径已有笔记历史/);
  assert.equal(fs.readFileSync(orphan.path, 'utf8'), '已删除笔记历史');
  assert.equal(backups.listNoteBackups(noHistory, ownership).length, 0);
  assert(fs.existsSync(noHistory));

  // File and directory renames retain history; an order write failure restores both.
  if (process.platform === 'win32') watchers.push(fs.watch(ownership, { recursive: true }, () => {}));
  const moved = await operations.renameEntryInLibrary(ownership, md, 'renamed');
  assert.equal(backups.readNoteBackup(moved, ownership, mdBackup.id).toString(), 'Markdown历史');
  const folder = operations.createFolderInLibrary(ownership, null, 'folder');
  const nested = await operations.moveEntryInLibrary(ownership, moved, folder);
  await new Promise(resolve => setTimeout(resolve, 100));
  const renamedFolder = await operations.renameEntryInLibrary(ownership, folder, 'folder-renamed');
  const finalNote = path.join(renamedFolder, path.basename(nested));
  assert.equal(backups.listNoteBackups(finalNote, ownership).length, 1);
  const oldRename = fs.renameSync;
  let busyAttempts = 0;
  try {
    fs.renameSync = (...args) => {
      if (String(args[0]).includes(`${path.sep}.menghan-backups${path.sep}`)) {
        busyAttempts++;
        throw Object.assign(new Error('模拟备份持续被占用'), { code: 'EBUSY' });
      }
      return oldRename(...args);
    };
    await assert.rejects(() => operations.renameEntryInLibrary(ownership, finalNote, 'busy'), /模拟备份持续被占用/);
  } finally { fs.renameSync = oldRename; }
  assert.equal(busyAttempts, process.platform === 'win32' ? 6 : 1);
  assert(fs.existsSync(finalNote));
  assert.equal(backups.listNoteBackups(finalNote, ownership).length, 1);
  assert.equal(fs.existsSync(path.join(ownership, '.menghan-meta', 'note-path-move.json')), false);
  const oldWrite = fs.writeFileSync;
  let failOrder = true;
  try {
    fs.writeFileSync = (...args) => {
      if (String(args[0]).endsWith('tree-order.json') && failOrder) { failOrder = false; throw new Error('模拟排序写入失败'); }
      return oldWrite(...args);
    };
    await assert.rejects(() => operations.renameEntryInLibrary(ownership, finalNote, 'failed'), /模拟排序/);
  } finally { fs.writeFileSync = oldWrite; }
  assert(fs.existsSync(finalNote));
  assert.equal(backups.listNoteBackups(finalNote, ownership).length, 1);
  assert.equal(fs.existsSync(path.join(ownership, '.menghan-meta', 'note-path-move.json')), false);

  // Simulate a process stop after both renames but before metadata publication.
  const recovery = library('recovery'), before = write(recovery, 'before.md'), after = path.join(recovery, 'after.md');
  const beforeBackup = await backups.createNoteBackup(before, recovery, Buffer.from('中断前历史'), new Date(), 0);
  const backupMove = backups.prepareNoteBackupPathMove(recovery, before, after);
  fs.mkdirSync(path.join(recovery, '.menghan-meta'));
  write(path.join(recovery, '.menghan-meta'), 'note-path-move.json', JSON.stringify({ version: 1, source: before, target: after, backup: backupMove, order: { version: 1, directories: {} } }));
  fs.renameSync(before, after); await backups.moveNoteBackupDirectory(recovery, backupMove);
  await operations.recoverLibraryPathMove(recovery);
  assert(fs.existsSync(before) && !fs.existsSync(after));
  assert.equal(backups.readNoteBackup(before, recovery, beforeBackup.id).toString(), '中断前历史');

  // Invalid input and a second-file publish failure leave no files from this batch.
  const importLibrary = library('imports'), sourceLibrary = library('import-source');
  const valid = write(sourceLibrary, 'valid.md'), otherValid = write(sourceLibrary, 'other.txt'), invalid = write(sourceLibrary, 'invalid.exe');
  assert.throws(() => imports.importTextFilesToLibrary({ libraryPath: importLibrary, sourcePaths: [valid, invalid] }), /不支持/);
  assert.deepEqual(fs.readdirSync(importLibrary), []);
  const oldLink = fs.linkSync; let publishes = 0;
  try {
    fs.linkSync = (...args) => { if (++publishes === 2) throw new Error('模拟发布失败'); return oldLink(...args); };
    assert.throws(() => imports.importTextFilesToLibrary({ libraryPath: importLibrary, sourcePaths: [valid, otherValid] }), /模拟发布/);
  } finally { fs.linkSync = oldLink; }
  assert.deepEqual(fs.readdirSync(importLibrary), []);
  assert.equal(imports.importTextFilesToLibrary({ libraryPath: importLibrary, sourcePaths: [valid, otherValid] }).length, 2);

  // Streaming limits apply even without Content-Length, and redirects never reach file:.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=', 'base64');
  const image = await remote.readRemoteExportImage('https://example.test/a.png', 1024, async (_url, options) => {
    assert.equal(options.credentials, 'omit'); return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(image.byteLength, png.length);
  assert.equal(Buffer.from(image.dataUrl.split(',')[1], 'base64').compare(png), 0);
  await assert.rejects(remote.readRemoteExportImage('https://example.test/large.png', 8, async () => new Response(png)), /10 MB/);
  await assert.rejects(remote.readRemoteExportImage('https://example.test/error.png', 1024, async () => new Response('<html>error</html>')), /不是支持/);
  await assert.rejects(remote.readRemoteExportImage('https://example.test/redirect', 1024, async () => new Response(null, { status: 302, headers: { location: 'file:///C:/secret.png' } })), /HTTP\/HTTPS/);

  // Use the installed Mermaid parser in a killable worker, never a parser mock.
  assert.equal(require('mermaid/package.json').version, '11.16.1');
  const mermaidUrl = pathToFileURL(require.resolve('mermaid')).href;
  mermaidWorker = new Worker(`const {parentPort}=require('node:worker_threads');import(${JSON.stringify(mermaidUrl)}).then(async ({default:m})=>{m.initialize({startOnLoad:false});await m.parse('graph TD; A-->B');try{await m.parse(${JSON.stringify('xychart\n x-axis 1 --> 1\n line [1, 2]')});parentPort.postMessage('completed')}catch{parentPort.postMessage('rejected')}}).catch(e=>{throw e})`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mermaid regression parser timed out')), 10_000);
    mermaidWorker.once('message', () => { clearTimeout(timeout); resolve(); });
    mermaidWorker.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  await mermaidWorker.terminate(); mermaidWorker = undefined;
  console.log('Security regressions verified: data-only frontmatter, junction boundaries, per-extension histories, legacy quarantine, rename/folder/rollback/recovery, atomic import, bounded remote images and real Mermaid parser.');
} finally {
  for (const watcher of watchers) watcher.close();
  await mermaidWorker?.terminate();
  for (const junction of junctions) if (fs.existsSync(junction)) fs.unlinkSync(junction);
  assert.equal(path.dirname(temporary), staging);
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
