import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay, replaceEditorText } from './electron-note-test-session.mjs';
import { buildNoteTestPackage } from './build-note-test-package.mjs';
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'save-electron-'));
const library = path.join(temporary, 'library'), userData = path.join(temporary, 'user-data'), mainEntry = path.join(temporary, 'dist-electron/main.js');
const secondLibrary = path.join(temporary, 'second-library');
let session;
try {
  for (const directory of [library, secondLibrary, userData, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
  const initial = path.join(library, '保存验收.md'); await fs.writeFile(initial, '# 保存验收\n\n原始文本');
  await fs.writeFile(path.join(library, '另一篇.md'), '# 另一篇\n\n用于验证切换。');
  await fs.writeFile(path.join(secondLibrary, '第二库.md'), '# 第二库\n\n切库验收');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: library, activeLibraryPath: library,
    libraries: [library, secondLibrary].map((path, index) => ({ path, alias: `验收库${index + 1}`, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() })),
    workspacePath: path.join(temporary, 'workspace'), appPreferences: { defaultEditorMode: 'source', autosaveDelayMs: 5_000 } }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'preload.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/externalWebPreload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'externalWebPreload.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/pipeline/mammothWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'mammothWorker.js'), logLevel: 'silent' }),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  const executablePath = process.argv.includes('--packaged') ? await buildNoteTestPackage(temporary) : undefined;
  const launchOptions = { mainEntry, userData, executablePath };
  session = await launchNoteTest(launchOptions);
  await open('保存验收');
  await replaceEditorText(session, '# 保存验收\n\n切换前草稿');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'dirty'"), 'dirty draft');
  await open('另一篇'); assert.match(await fs.readFile(initial, 'utf8'), /切换前草稿/);
  await open('保存验收');
  await replaceEditorText(session, '# 保存验收\n\n添加标签前尚未保存的草稿');
  await session.evaluate("document.querySelector('.note-add-tag-toggle').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.note-tag-editor input'))"), 'tag input');
  await session.evaluate("document.querySelector('.note-tag-editor input').focus()");
  await session.send('Input.insertText', { text: '可靠保存验收' });
  await session.evaluate("document.querySelector('.note-tag-editor button[type=submit]').click()");
  await waitFor(async () => { const text = await fs.readFile(initial, 'utf8'); return text.includes('添加标签前尚未保存的草稿') && text.includes('可靠保存验收'); }, 'tag mutation preserves pending draft');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean' && document.querySelector('.cm-content')?.innerText.includes('可靠保存验收')"), 'tag mutation adopted');
  await replaceEditorText(session, '# 保存验收\n\n恢复备份前的待保存草稿');
  await waitFor(() => session.evaluate("document.querySelector('.mode-select')?.options.length > 1"), 'backup option');
  await session.evaluate("window.confirm = () => true; const select = document.querySelector('.mode-select'); select.value = select.options[1].value; select.dispatchEvent(new Event('change', { bubbles: true }))");
  await waitFor(async () => (await fs.readFile(initial, 'utf8')).includes('原始文本'), 'restore through versioned queue');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean' && document.querySelector('.cm-content')?.innerText.includes('原始文本')"), 'restored body adopted');
  await replaceEditorText(session, '# 保存验收\n\n切库前尚未保存的草稿');
  await switchLibrary('验收库2'); await open('第二库');
  assert.match(await fs.readFile(initial, 'utf8'), /切库前尚未保存的草稿/);
  await switchLibrary('验收库1'); await open('保存验收');
  await fs.writeFile(initial, '# 保存验收\n\n外部干净修改');
  await waitFor(() => session.evaluate("document.querySelector('.cm-content')?.innerText.includes('外部干净修改')"), 'clean external refresh');
  await replaceEditorText(session, '# 保存验收\n\n外部变化后的新草稿');
  await open('另一篇'); assert.match(await fs.readFile(initial, 'utf8'), /外部变化后的新草稿/);
  await open('保存验收'); await replaceEditorText(session, '# 保存验收\n\n发生冲突的草稿');
  await fs.writeFile(initial, '# 保存验收\n\n外部独立版本');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'conflict'"), 'external conflict');
  await session.closeWindow(); await delay(350);
  assert.equal(session.child.exitCode, null, 'conflict must prevent normal close');
  assert.match(await session.evaluate("document.querySelector('.cm-content').innerText"), /发生冲突的草稿/);
  assert.match(await fs.readFile(initial, 'utf8'), /外部独立版本/);

  await session.evaluate("[...document.querySelectorAll('.note-save-details button')].find(button => button.textContent === '另存为新笔记').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.simple-modal input'))"), 'save-copy dialog');
  await session.evaluate("document.querySelector('.simple-modal .primary-button').click()");
  const copy = path.join(library, '草稿副本.md'); await waitFor(async () => { try { return (await fs.readFile(copy, 'utf8')).includes('发生冲突的草稿'); } catch { return false; } }, 'draft copy');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean'"), 'copy adopted');
  assert.match(await fs.readFile(initial, 'utf8'), /外部独立版本/);
  await open('保存验收'); await replaceEditorText(session, '# 保存验收\n\n外部删除后仍保留的草稿');
  await fs.unlink(initial);
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'conflict'"), 'external deletion keeps draft');
  assert.match(await session.evaluate("document.querySelector('.cm-content').innerText"), /外部删除后仍保留的草稿/);
  await assert.rejects(fs.access(initial));
  await session.evaluate("[...document.querySelectorAll('.note-save-details button')].find(button => button.textContent === '另存为新笔记').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.simple-modal input'))"), 'deleted draft copy dialog');
  await session.evaluate("document.querySelector('.simple-modal input').focus()");
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.insertText', { text: '删除后保留' });
  await session.evaluate("document.querySelector('.simple-modal .primary-button').click()");
  await waitFor(async () => { try { return (await fs.readFile(path.join(library, '删除后保留.md'), 'utf8')).includes('外部删除后仍保留的草稿'); } catch { return false; } }, 'deleted draft saved to a new path');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean'"), 'deleted copy adopted');
  await assert.rejects(fs.access(initial)); await open('草稿副本');
  const prefix = '# 长笔记运行时\n\n发布包长笔记检索标记\n\n', phrase = '采购合同与回款凭证已经逐项核对。\n';
  let large = prefix + phrase.repeat(Math.floor((1_048_576 - Buffer.byteLength(prefix)) / Buffer.byteLength(phrase)));
  large += 'x'.repeat(1_048_576 - Buffer.byteLength(large));
  const largePath = path.join(library, '长笔记运行时.md'); await fs.writeFile(largePath, large);
  await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent.includes('长笔记运行时'))"), 'packaged worker indexes 1 MiB external note');
  const largeSnapshot = await session.evaluate(`window.electronAPI.openNoteEditSession(${JSON.stringify(largePath)})`);
  const largeResult = await session.evaluate(`window.electronAPI.saveNote(${JSON.stringify({ editSessionId: largeSnapshot.editSessionId, requestId: 'large-runtime', editRevision: 1, expectedDiskHash: largeSnapshot.version.diskHash, content: `${large}\n长笔记热保存验收` })})`);
  assert.equal(largeResult.status, 'committed');
  assert.equal(await session.evaluate(`window.electronAPI.awaitNoteIndex(${JSON.stringify(largeSnapshot.editSessionId)}, ${JSON.stringify(largeResult.version.diskHash)})`), 'current');
  await session.evaluate(`window.electronAPI.closeNoteEditSession(${JSON.stringify(largeSnapshot.editSessionId)})`);
  await replaceEditorText(session, '# 草稿副本\n\n立即关闭也要保存');
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'dirty'"), 'pending close draft');
  await session.closeWindow();
  await Promise.race([session.exited, delay(15_000).then(() => { throw new Error('Normal close did not finish'); })]);
  assert.match(await fs.readFile(copy, 'utf8'), /立即关闭也要保存/);
  assert.equal((await fs.stat(largePath)).size, Buffer.byteLength(`${large}\n长笔记热保存验收`));
  assert.equal(session.child.exitCode, 0);
  await session.dispose(); session = await launchNoteTest(launchOptions); await open('草稿副本');
  assert.match(await session.evaluate("document.querySelector('.cm-content').innerText"), /立即关闭也要保存/);
  const results = await session.evaluate("window.electronAPI.searchNotes('立即关闭也要保存')"); assert.ok(results.some(note => note.path === copy));
  const longResults = await session.evaluate("window.electronAPI.searchNotes('长笔记热保存验收')"); assert.ok(longResults.some(note => note.path === largePath));
  await open('长笔记运行时'); assert.match(await session.evaluate("document.querySelector('.cm-content').innerText"), /发布包长笔记检索标记/);
  await session.closeWindow(); await session.exited;
  const report = { date: new Date().toISOString(), kind: executablePath ? 'win-unpacked ASAR' : 'Electron development bundle', pythonInAppPath: executablePath ? false : 'host default',
    passed: ['real CodeMirror input', 'note and library switch flush', 'versioned tags', 'versioned backup restoration', 'clean external refresh', 'dirty conflict retention', 'external deletion retains draft without recreating old path', 'blocked close', 'save-copy UI', 'immediate normal close', '1 MiB worker indexing and version wait', 'cold restart and search', '1 MiB source editor load', 'worker exit'] };
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve(process.env.TRELLORA_NOTE_SAVE_REPORT || `docs/verification/note-save-${executablePath ? 'packaged' : 'electron'}.json`), JSON.stringify(report, null, 2));
  console.log(`${report.kind} verified: ${report.passed.join(', ')}.`);
} catch (error) { console.error(error, session?.diagnostics()); throw error; }
finally { await session?.dispose(); assert.equal(path.dirname(temporary), staging); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
async function open(title) {
  await waitFor(() => session.evaluate(`[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent?.includes(${JSON.stringify(title)}))`), `tree ${title}`);
  await session.evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent?.includes(${JSON.stringify(title)}))?.click()`);
  await waitFor(() => session.evaluate(`Boolean(document.querySelector('.cm-content')?.isContentEditable && document.querySelector('.knowledge-note-path')?.textContent?.trim() === ${JSON.stringify(`${title}.md`)} && document.querySelector('.note-save-notice')?.dataset.status === 'clean' && !document.querySelector('.simple-modal'))`), `open ${title}`);
}
async function switchLibrary(alias) {
  await session.evaluate("document.querySelector('.library-switcher').click()");
  await waitFor(() => session.evaluate(`[...document.querySelectorAll('[role=menuitem]')].some(node => node.textContent.includes(${JSON.stringify(alias)}))`), `library menu ${alias}`);
  await session.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(node => node.textContent.includes(${JSON.stringify(alias)})).click()`);
  await waitFor(() => session.evaluate(`document.querySelector('.library-switcher')?.textContent.includes(${JSON.stringify(alias)})`), `switch ${alias}`);
}
