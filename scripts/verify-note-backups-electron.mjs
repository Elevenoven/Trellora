import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'note-backups-electron-'));
const library = path.join(temporary, 'library'), userData = path.join(temporary, 'user-data'), bundle = path.join(temporary, 'dist-electron');
const note = path.join(library, '备份恢复验收.md');
const legacyBackupDirectory = path.join(library, '.menghan-backups', '备份恢复验收');
const backupDirectory = path.join(library, '.menghan-backups', '.v2', '备份恢复验收.md');
const otherDirectory = path.join(library, '.menghan-backups', '其他笔记');
const original = '# 当前正文\n\n恢复前保留的完整版本。\n';
const backupIds = Array.from({ length: 20 }, (_, index) => `202601${String(index + 1).padStart(2, '0')}-120000`);
let session;
try {
  await Promise.all([library, userData, bundle, legacyBackupDirectory, otherDirectory].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(note, original);
  await fs.writeFile(path.join(library, '其他笔记.md'), '其他笔记原文');
  for (const id of backupIds) {
    await fs.writeFile(path.join(legacyBackupDirectory, `${id}.md`), `# 历史 ${id}\n`);
    await fs.writeFile(path.join(otherDirectory, `${id}.md`), `其他笔记历史 ${id}`);
  }
  await fs.writeFile(path.join(legacyBackupDirectory, '用户手工归档.md'), '不属于自动备份的用户文件');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: library, activeLibraryPath: library, libraries: [{ path: library, alias: '备份验收', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }], workspacePath: path.join(temporary, 'workspace'), appPreferences: { defaultEditorMode: 'wysiwyg', autosaveDelayMs: 200, backupRetention: 100 } }));
  await Promise.all([
    ...[['electron/main.ts', 'main.js', ['electron', 'better-sqlite3']], ['electron/preload.ts', 'preload.js', ['electron']], ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js', []], ['electron/externalWebPreload.ts', 'externalWebPreload.js', ['electron']], ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js', []]].map(([entry, name, external]) => build({ entryPoints: [entry], bundle: true, platform: 'node', external, outfile: path.join(bundle, name), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist'), '--logLevel', 'error']),
  ]);
  console.log('Electron backup acceptance bundle built.');
  session = await launchNoteTest({ mainEntry: path.join(bundle, 'main.js'), userData });
  await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent.includes('备份恢复验收'))"), 'backup fixture');
  await session.evaluate("[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent.includes('备份恢复验收')).click()");
  await waitFor(async () => JSON.stringify(await options()) === JSON.stringify(backupIds.slice(-3).reverse()), 'latest three dropdown entries');
  assert.equal(await fs.readFile(note, 'utf8'), original);
  assert.equal((await fs.readdir(backupDirectory)).length, 4);
  assert.equal((await fs.readdir(otherDirectory)).length, 20);
  assert.equal(await fs.readFile(path.join(backupDirectory, '用户手工归档.md'), 'utf8'), '不属于自动备份的用户文件');
  for (const id of backupIds.slice(0, -3)) await assert.rejects(fs.stat(path.join(backupDirectory, `${id}.md`)), { code: 'ENOENT' });

  // 点击真实 React 恢复入口，只在隔离测试窗口自动同意覆盖确认。
  await session.evaluate('window.confirm = () => true');
  const oldestRetained = backupIds.at(-3);
  await restore(oldestRetained);
  await waitFor(async () => (await fs.readFile(note, 'utf8')) === `# 历史 ${oldestRetained}\n`, 'restored disk content');
  await waitFor(async () => (await options())[0]?.startsWith('2026') && !(await options()).includes(oldestRetained), 'refreshed rolling dropdown');
  const restoreEntries = await options();
  assert.equal(restoreEntries.length, 3);
  assert.equal(await fs.readFile(path.join(backupDirectory, `${restoreEntries[0]}.md`), 'utf8'), original);
  await restore(restoreEntries[0]);
  await waitFor(async () => (await fs.readFile(note, 'utf8')) === original, 'undo restore');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean'"), 'restore saved state');
  assert.equal((await options()).length, 3);
  assert.equal((await fs.readdir(backupDirectory)).length, 4);
  assert.equal((await fs.readdir(otherDirectory)).length, 20);
  assert.equal(await fs.readFile(path.join(library, '其他笔记.md'), 'utf8'), '其他笔记原文');
  for (const id of backupIds) assert.equal(await fs.readFile(path.join(otherDirectory, `${id}.md`), 'utf8'), `其他笔记历史 ${id}`);
  console.log('Electron backups verified: legacy 100-backup preference still keeps latest three, dropdown order matches disk, older files removed, unrelated files preserved, UI restore and undo both succeed.');
} catch (error) {
  console.error(error, session?.diagnostics());
  throw error;
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function options() {
  return session.evaluate("[...document.querySelectorAll('.editor-mode-bar select.mode-select option')].map(option => option.value).filter(Boolean)");
}
async function restore(id) {
  await session.evaluate(`(() => { const select = document.querySelector('.editor-mode-bar select.mode-select'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
