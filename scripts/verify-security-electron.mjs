import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command } from './electron-note-test-session.mjs';
import { buildNoteTestPackage } from './build-note-test-package.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'security-electron-'));
const library = path.join(temporary, 'library'), outside = path.join(temporary, 'outside');
const userData = path.join(temporary, 'user-data'), bundle = path.join(temporary, 'dist-electron');
const marker = path.join(temporary, 'must-not-execute'), junction = path.join(library, 'linked');
let session;
try {
  for (const directory of [library, outside, userData, bundle]) await fs.mkdir(directory);
  const md = path.join(library, 'same.md'), txt = path.join(library, 'same.txt');
  await fs.writeFile(md, '# Markdown 原文'); await fs.writeFile(txt, 'TXT 原文');
  await fs.writeFile(path.join(library, 'unsafe.md'), `---javascript\n({checked:(require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'),true)})\n---\n# 恶意头部`);
  const external = path.join(outside, 'external.md'); await fs.writeFile(external, '库外原文');
  await fs.symlink(outside, junction, 'junction');
  const valid = path.join(temporary, 'valid.md'), invalid = path.join(temporary, 'invalid.exe');
  await fs.writeFile(valid, '# 导入文件'); await fs.writeFile(invalid, 'unsupported');
  const before = path.join(library, 'before.md'), after = path.join(library, 'after.md');
  const backupFrom = path.join(library, '.menghan-backups', '.v2', 'before.md'), backupTo = path.join(library, '.menghan-backups', '.v2', 'after.md');
  await fs.mkdir(backupTo, { recursive: true });
  await fs.writeFile(after, '# 中断时的笔记'); await fs.writeFile(path.join(backupTo, '20260101-120000.md'), '中断前历史');
  await fs.mkdir(path.join(library, '.menghan-meta'));
  await fs.writeFile(path.join(library, '.menghan-meta', 'note-path-move.json'), JSON.stringify({ version: 1, source: before, target: after,
    backup: { from: backupFrom, to: backupTo }, order: { version: 1, directories: {} } }));
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: library, activeLibraryPath: library,
    libraries: [{ path: library, alias: '安全验收', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }],
    workspacePath: path.join(temporary, 'workspace'), appPreferences: { defaultEditorMode: 'source' } }));
  await Promise.all([
    ...[['electron/main.ts', 'application.js', ['electron', 'better-sqlite3']], ['electron/preload.ts', 'preload.js', ['electron']],
      ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js', []], ['electron/externalWebPreload.ts', 'externalWebPreload.js', ['electron']],
      ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js', []]].map(([entry, name, external]) => build({ entryPoints: [entry], bundle: true, platform: 'node', external,
      outfile: path.join(bundle, name), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist'), '--logLevel', 'error']),
  ]);
  await fs.writeFile(path.join(bundle, 'main.js'), `require('electron').dialog.showOpenDialog = async () => ({canceled:false,filePaths:${JSON.stringify([valid, invalid])}});require('./application.js');`);
  const executablePath = process.argv.includes('--packaged') ? await buildNoteTestPackage(temporary) : undefined;
  session = await launchNoteTest({ mainEntry: path.join(bundle, 'main.js'), userData, executablePath });
  await assert.rejects(fs.access(marker));
  assert.equal(await fs.readFile(before, 'utf8'), '# 中断时的笔记'); await assert.rejects(fs.access(after));
  assert.equal(await fs.readFile(path.join(backupFrom, '20260101-120000.md'), 'utf8'), '中断前历史');
  const invoke = (method, ...args) => session.evaluate(`window.electronAPI[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  await assert.rejects(invoke('readFile', path.join(junction, 'external.md')), /笔记库/);
  await assert.rejects(invoke('createFolder', junction, '不能创建'), /笔记库/);
  await assert.rejects(invoke('importFiles'), /不支持的文本文件/);
  await assert.rejects(fs.access(path.join(library, 'valid.md')));
  assert.deepEqual(await fs.readdir(outside), ['external.md']);

  for (const [file, content] of [[md, '# Markdown 新版本'], [txt, 'TXT 新版本']]) {
    const snapshot = await invoke('openNoteEditSession', file);
    const result = await invoke('saveNote', { editSessionId: snapshot.editSessionId, requestId: `save-${path.extname(file)}`, editRevision: 1,
      expectedDiskHash: snapshot.version.diskHash, content });
    assert.equal(result.status, 'committed');
    assert.equal(await invoke('awaitNoteIndex', snapshot.editSessionId, result.version.diskHash), 'current');
    await invoke('closeNoteEditSession', snapshot.editSessionId);
  }
  const mdHistory = await invoke('listBackups', md), txtHistory = await invoke('listBackups', txt);
  assert.equal(mdHistory.length, 1); assert.equal(txtHistory.length, 1);
  assert.equal(await fs.readFile(mdHistory[0].path, 'utf8'), '# Markdown 原文');
  assert.equal(await fs.readFile(txtHistory[0].path, 'utf8'), 'TXT 原文');
  const renamed = await invoke('renameEntry', md, 'renamed');
  assert.equal((await invoke('listBackups', renamed)).length, 1);
  const folder = await invoke('createFolder', null, 'folder');
  const moved = await invoke('moveEntry', renamed, folder);
  assert.equal((await invoke('listBackups', moved)).length, 1);
  const renamedFolder = await invoke('renameEntry', folder, 'renamed-folder');
  const finalHistory = await invoke('listBackups', path.join(renamedFolder, path.basename(moved)));
  assert.equal(finalHistory.length, 1);
  assert.equal(await fs.readFile(finalHistory[0].path, 'utf8'), '# Markdown 原文');
  await assert.rejects(fs.access(marker));
  console.log(`Electron security verified (${executablePath ? 'Windows ASAR package' : 'development bundle'}): no frontmatter execution, rejected junction IPC, all-or-nothing import, independent MD/TXT backups, file/folder history migration and startup recovery.`);
} catch (error) {
  console.error(error, session?.diagnostics()); throw error;
} finally {
  await session?.dispose();
  try { await fs.unlink(junction); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
