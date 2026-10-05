import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'external-electron-'));
const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-external-documents-'));
const userData = path.join(fixtures, 'user-data'), originals = path.join(fixtures, 'originals'), library = path.join(fixtures, 'library'), library2 = path.join(fixtures, 'library2');
const emptyLibrary = path.join(fixtures, 'empty-library');
const mainEntry = path.join(temporary, 'dist-electron/main.js'), selections = path.join(temporary, 'selections.json');
const evidence = path.resolve('docs/verification/external-documents');
let session;
const passed = []; const nativePicker = process.argv.includes('--native-picker');
try {
  for (const dir of [userData, originals, library, library2, emptyLibrary, path.dirname(mainEntry), evidence]) await fs.mkdir(dir, { recursive: true });
  const source = path.join(originals, '中文 空格.md'), txt = path.join(originals, '客户.txt'), references = path.join(originals, '资源.md');
  await fs.writeFile(source, Buffer.from('\ufeff# 外部文档\r\n\r\n初始正文\r\n'));
  await fs.writeFile(txt, '独立纯文本\r\n第二行\r\n');
  await fs.writeFile(references, '![本地凭证](attachments/same.png)\n[本地链接](./其他.md)\n\n<img src="data:image/png;base64,iVBORw0KGgo=" srcset="menghan-image://local/same.png 2x" style="background:url(menghan-image://local/same.png)">\n<svg><image href="menghan-image://local/same.png" /></svg>\n\n```mermaid\nflowchart LR\nA@{ img: "menghan-image://local/same.png" }\n```');
  await fs.mkdir(path.join(library, 'attachments')); await fs.writeFile(path.join(library, 'attachments/same.png'), 'never load');
  await fs.writeFile(path.join(library, '库内.md'), '# 库内\n\n原笔记');
  await fs.writeFile(path.join(library, '中文 空格.md'), '# 已有同名笔记');
  await fs.writeFile(path.join(library2, '第二库.md'), '# 第二库');
  const config = { workspacePath: path.join(fixtures, 'workspace'), appPreferences: { defaultEditorMode: 'source', autosaveDelayMs: 1000 } };
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify(config));
  await fs.writeFile(selections, JSON.stringify(nativePicker ? { native: true } : { open: source }));
  const harness = path.join(temporary, 'harness.ts');
  await fs.writeFile(harness, `import ${JSON.stringify(path.resolve('electron/main.ts').replaceAll('\\', '/'))};
import { dialog } from 'electron'; import fs from 'node:fs';
const nativeOpen = dialog.showOpenDialog.bind(dialog);
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(selections)}, 'utf8'));
dialog.showOpenDialog = (async (...args: any[]) => { const s = read(); if(s.native) return nativeOpen(...args as [any, any]); const selected = Array.isArray(s.opens) ? s.opens.shift() : s.open; if(Array.isArray(s.opens)) fs.writeFileSync(${JSON.stringify(selections)}, JSON.stringify(s)); return { canceled: !selected, filePaths: selected ? [selected] : [] }; }) as any;
dialog.showSaveDialog = (async () => { const s = read(); return { canceled: !s.save, filePath: s.save }; }) as any;
dialog.showMessageBox = (async () => { const s = read(); if (s.changeBeforeConfirm) fs.writeFileSync(s.save, s.changeBeforeConfirm); return { response: s.cancelOverwrite ? 1 : 0, checkboxChecked: false }; }) as any;
`);
  await Promise.all([
    build({ entryPoints: [harness], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    ...[['electron/preload.ts', 'preload.js'], ['electron/externalWebPreload.ts', 'externalWebPreload.js'], ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js'], ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js'], ['electron/workspaceMigrationWorker.ts', 'workspaceMigrationWorker.js']].map(([input, output]) => build({ entryPoints: [input], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: path.join(path.dirname(mainEntry), output), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  const launch = async () => { session = await launchNoteTest({ mainEntry, userData }); await session.send("Emulation.setFocusEmulationEnabled", { enabled: true }); await session.evaluate("window.__documentAlerts=[]; window.alert=text=>window.__documentAlerts.push(text); window.confirm=()=>true"); };
  await launch();
  // 使用 --native-picker 时验证真实 Windows 选择器；日常回归注入选择器返回值。
  await shortcut('o');
  if (nativePicker) { await chooseNativeFile(session.windowPid, source); console.log('Native dialog input posted'); }
  await external(source); assert.deepEqual(await session.evaluate('window.electronAPI.listLibraries()'), []);
  record(`${nativePicker ? 'native Windows picker' : 'picker selection fixture'}, Chinese/space path, no registered library`);
  const originalBytes = await fs.readFile(source);
  await mode('预览'); await mode('编辑'); await mode('源码'); await shortcut('s');
  await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='clean'"), 'unchanged save');
  assert.deepEqual(await fs.readFile(source), originalBytes); record('unchanged Markdown mode switches preserve exact BOM/CRLF bytes');
  await edit('# 外部文档\n\n我的修改\n'); await delay(1300); assert.deepEqual(await fs.readFile(source), originalBytes);
  const backupDirectory = path.join(fixtures, 'backups'); await fs.mkdir(backupDirectory);
  await session.evaluate(`window.electronAPI.startWorkspaceBackup(${JSON.stringify({ targetDirectory: backupDirectory, externalLibraries: [] })})`);
  await waitFor(async () => { const status = await session.evaluate('window.electronAPI.getWorkspaceBackupStatus()'); if (status.phase === 'failed') throw new Error(status.message); return status.phase === 'completed'; }, 'maintenance snapshot completion');
  assert.deepEqual(await fs.readFile(source), originalBytes); assert.ok((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(record => record.displayPath === source));
  record('real backup maintenance persists recovery only and preserves external original bytes');
  const backupStatus = await session.evaluate('window.electronAPI.getWorkspaceBackupStatus()'); assert.ok(backupStatus.outputPath);
  const restoreParent = path.join(fixtures, 'restored'); await fs.mkdir(restoreParent); await fs.writeFile(selections, JSON.stringify({ opens: [backupStatus.outputPath, restoreParent] }));
  const restore = await session.evaluate('window.electronAPI.previewWorkspaceRestore()'); assert.ok(restore?.operationId);
  const restoreResult = await session.evaluate(`window.electronAPI.startWorkspaceRestore(${JSON.stringify(restore.operationId)}, false)`); assert.equal(restoreResult.phase, 'completed', JSON.stringify(restoreResult));
  assert.deepEqual(await fs.readFile(source), originalBytes); assert.match(await session.evaluate("document.querySelector('.external-document .cm-content').textContent"), /我的修改/);
  assert.ok((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(record => record.displayPath === source)); record('real physical workspace restore coexists with external draft and preserves original bytes');
  const migratedWorkspace = path.join(fixtures, 'migrated-workspace'); await fs.mkdir(migratedWorkspace); await fs.writeFile(selections, JSON.stringify({ open: migratedWorkspace }));
  const migration = await session.evaluate('window.electronAPI.previewWorkspaceMigration()'); assert.ok(migration?.operationId);
  const migrationResult = await session.evaluate(`window.electronAPI.startWorkspaceMigration(${JSON.stringify(migration.operationId)})`); assert.equal(migrationResult.phase, 'completed', JSON.stringify(migrationResult));
  assert.deepEqual(await fs.readFile(source), originalBytes); assert.match(await session.evaluate("document.querySelector('.external-document .cm-content').textContent"), /我的修改/);
  assert.ok((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(record => record.displayPath === source)); record('real workspace migration worker preserves external draft and original bytes');
  await session.closeWindow(); await waitFor(() => session.evaluate("Boolean(document.querySelector('[data-document-choice=cancel]'))"), 'close decision');
  await delay(10_500); assert.equal(session.child.exitCode, null);
  await choice('cancel'); await external(source); assert.equal(session.child.exitCode, null);
  await shortcut('s'); await saved(); assert.equal(await fs.readFile(source, 'utf8'), '\ufeff# 外部文档\r\n\r\n我的修改\r\n');
  record('manual save, private recovery, close choice waits beyond ten seconds, cancel retains draft');
  await edit('# 留在当前文档'); await open(txt); await choice('cancel'); await external(source);
  await open(txt); await choice('discard'); await external(txt); assert.equal((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(record => record.displayPath === source), false);
  assert.equal(await session.evaluate("document.querySelector('.external-document .segmented-control button').disabled"), true);
  await edit('纯文本修改\n保留换行\n'); await shortcut('s'); await saved(); assert.equal(await fs.readFile(txt, 'utf8'), '纯文本修改\r\n保留换行\r\n');
  record('switch cancel/discard, TXT capabilities, CRLF manual save');
  await edit('冲突草稿'); await fs.writeFile(txt, '其他程序的版本'); await shortcut('s');
  await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='conflict'"), 'conflict notice'); assert.equal(await fs.readFile(txt, 'utf8'), '其他程序的版本');
  await fs.unlink(txt); await shortcut('s'); await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.textContent.includes('删除')"), 'missing notice'); await assert.rejects(fs.access(txt));
  const copy = path.join(originals, '另存.txt'); await fs.writeFile(selections, JSON.stringify({ save: copy })); await shortcut('s', true); await external(copy); await saved(); assert.equal(await fs.readFile(copy, 'utf8'), '冲突草稿'); await assert.rejects(fs.access(txt));
  record('external modification/deletion, no recreation, save-as changes active session');
  await edit('目标变化后的草稿'); const target = path.join(originals, '已有.txt'); await fs.writeFile(target, '旧目标');
  await fs.writeFile(selections, JSON.stringify({ save: target, changeBeforeConfirm: '确认期间的外部版本' })); await shortcut('s', true);
  await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='conflict'"), 'overwrite version check'); assert.equal(await fs.readFile(target, 'utf8'), '确认期间的外部版本'); await external(copy);
  record('overwrite confirmation race preserves newer target and current draft');
  await session.dispose(); session = undefined; await launch();
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"打开文件\"]').click()"); await menu('恢复独立文件草稿'); await confirmSelect(); await external(copy);
  assert.match(await session.evaluate("document.querySelector('.external-document .cm-content').textContent"), /目标变化后的草稿/); assert.equal(await fs.readFile(copy, 'utf8'), '冲突草稿');
  record('forced process termination and cold restart recovery never overwrite original');
  await session.send('Page.reload', {});
  await waitFor(() => session.evaluate("Boolean(window.electronAPI?.listDocumentRecovery && document.querySelector('.app-nav-item[aria-label=\"打开文件\"]')) && !document.getElementById('startup-splash')"), 'renderer reloaded');
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"打开文件\"]').click()"); await menu('恢复独立文件草稿'); await confirmSelect(); await external(copy);
  assert.match(await session.evaluate("document.querySelector('.external-document .cm-content').textContent"), /目标变化后的草稿/);
  record('renderer reload releases old main sessions and restores persisted draft');
  await open(references); await choice('discard'); await external(references); await mode('预览');
  assert.equal(await session.evaluate("document.querySelectorAll('.external-document img[src*=\"menghan-image\"]').length"), 0);
  assert.equal(await session.evaluate("document.querySelectorAll('.external-document .external-resource-placeholder').length"), 1);
  assert.equal(await session.evaluate("[...document.querySelectorAll('.external-document button')].find(b=>b.textContent==='加入笔记库').disabled"), false);
  record('unauthorized local reference preview placeholders, no library asset requests');
  await session.closeWindow(); await session.exited; await session.dispose(); session = undefined;
  const persisted = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ ...persisted, libraryPath: emptyLibrary, activeLibraryPath: emptyLibrary, libraries: [library, library2, emptyLibrary].map((p, i) => ({ path: p, alias: `验收库${i + 1}`, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() })) }));
  await launch(); await open(source); await external(source); await edit('# 待入库草稿\n\n客户对账确认');
  await click('加入笔记库'); await confirmSelect();
  await waitFor(() => session.evaluate("!document.querySelector('.external-document') && document.querySelector('.knowledge-note-path')?.textContent.includes('中文 空格 1.md')"), 'joined note routed to library');
  assert.equal(await fs.readFile(path.join(library, '中文 空格 1.md'), 'utf8'), '# 待入库草稿\n\n客户对账确认'); assert.equal(await fs.readFile(path.join(library, '中文 空格.md'), 'utf8'), '# 已有同名笔记'); assert.equal(await fs.readFile(source, 'utf8'), '\ufeff# 外部文档\r\n\r\n我的修改\r\n');
  assert.equal((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(r => r.displayPath === source), false);
  record('join current draft through original note editor/index; original unchanged; transfer terminal recovery');
  await open(references); await external(references); await mode('预览');
  assert.equal(await session.evaluate("document.querySelectorAll('.external-document img[src*=\"menghan-image\"]').length"), 0);
  assert.equal(await session.evaluate("document.querySelectorAll('.external-document .external-resource-placeholder').length"), 1);
  assert.equal(await session.evaluate("document.querySelectorAll('.external-document [srcset], .external-document [style*=\"menghan-image\"], .external-document svg image[href], .external-document .mermaid-diagram').length"), 0);
  const rejectedImage = await session.evaluate(`window.electronAPI.saveEditorImage({notePath:${JSON.stringify(path.join(library, '库内.md'))},bytes:new Uint8Array([1,2,3])}).then(()=>false,e=>e.message.includes('独立文件'))`); assert.equal(rejectedImage, true);
  record('active library same-name attachment isolation and main-process image write rejection');
  await open(path.join(library2, '第二库.md'));
  await waitFor(() => session.evaluate("document.querySelector('.knowledge-note-path')?.textContent==='第二库.md' && !document.querySelector('.external-document')"), 'nonactive registered library routes to notes');
  record('registered library source switches to existing note chain');
  await session.evaluate("document.querySelector('[aria-label=\"收起侧栏\"]')?.click()");
  await open(source); await external(source); await edit('# 最后的草稿');
  const beforeClose = await fs.readFile(source); await session.closeWindow(); await choice('discard'); await session.exited; await session.dispose(); session = undefined;
  assert.deepEqual(await fs.readFile(source), beforeClose); await launch(); assert.equal((await session.evaluate('window.electronAPI.listDocumentRecovery()')).some(r => r.displayPath === source), false);
  record('normal close discard leaves original bytes intact and prevents recovery revival');
  await open(source); await external(source);
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"打开文件\"]').click()"); await menu('最近文件'); await confirmSelect(); await external(source);
  await screenshot('zh-CN-source.png'); await mode('预览'); await screenshot('zh-CN-preview.png');
  assert.equal((await fs.readdir(originals)).some(name => name.startsWith('.menghan-') || name.startsWith('.trellora-')), false);
  const report = { date: new Date().toISOString(), electron: '31.7.7', kind: 'real Electron development bundle', nativePicker, nativePickerEvidence: 'native-picker.json', injected: ['subsequent picker selections', 'overwrite confirmation target change'], passed, packaged: false, cleanMachine: false };
  await fs.writeFile(path.join(evidence, 'electron.json'), JSON.stringify(report, null, 2)); console.log(`External Electron passed: ${passed.join('; ')}.`);
} catch (error) { console.error(error, session?.diagnostics()); if(session) { console.error(await session.evaluate("JSON.stringify({alerts:window.__documentAlerts,body:document.body.innerText?.slice(0,3500)})").catch(e=>String(e))); await screenshot('failure.png').catch(()=>undefined); } throw error; }
finally { await session?.dispose(); assert.equal(path.dirname(temporary), staging); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); assert.equal(path.dirname(fixtures), path.resolve(os.tmpdir())); await fs.rm(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
async function shortcut(key, shift = false) { await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 + (shift ? 8 : 0) }); await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 }); }
async function external(file) { await waitFor(() => session.evaluate(`document.querySelector('.external-document-name p:last-child')?.textContent===${JSON.stringify(file)} && !document.querySelector('[role=dialog]') && document.querySelector('.external-document .cm-content')?.isContentEditable`), `external ${file}`); }
async function saved() { await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='clean' && !document.querySelector('.external-document')?.dataset.documentBusy"), 'saved'); }
async function open(file) { await fs.writeFile(selections, JSON.stringify({ open: file })); await shortcut('o'); }
async function choice(value) { await waitFor(() => session.evaluate(`Boolean(document.querySelector('[data-document-choice=${value}]'))`), `decision ${value}`); await session.evaluate(`document.querySelector('[data-document-choice=${value}]').click()`); }
async function click(label) { await session.evaluate(`[...document.querySelectorAll('.external-document button')].find(b=>b.textContent===${JSON.stringify(label)})?.click()`); }
async function mode(label) { await session.evaluate(`[...document.querySelectorAll('.external-document .segmented-control button')].find(b=>b.textContent===${JSON.stringify(label)})?.click()`); await delay(150); }
async function menu(label) { await waitFor(() => session.evaluate(`[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent===${JSON.stringify(label)})`), label); await session.evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent===${JSON.stringify(label)}).click()`); }
async function confirmSelect() { await waitFor(() => session.evaluate("Boolean(document.querySelector('[role=dialog] input'))"), 'selection dialog'); await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='确定').click()"); }
async function edit(text) { await waitFor(() => session.evaluate("document.querySelector('.external-document .cm-content')?.isContentEditable"), "external editor ready"); await session.evaluate("document.querySelector('.external-document .cm-content').focus()"); await shortcut('a'); await session.send('Input.insertText', { text }); await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='dirty'"), 'external dirty draft'); }
async function screenshot(name) { const { data } = await session.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, name), Buffer.from(data, 'base64')); }
async function chooseNativeFile(pid, file) {
  const script = `import ctypes\nu=ctypes.windll.user32\nu.GetWindowThreadProcessId.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]\nu.GetClassNameW.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_int]\nu.GetDlgItem.argtypes=[ctypes.c_void_p,ctypes.c_int]; u.GetDlgItem.restype=ctypes.c_void_p\nu.SendMessageW.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_void_p,ctypes.c_void_p]; u.SendMessageW.restype=ctypes.c_void_p\ndialogs=[]\ndef visit(hwnd,_):\n p=ctypes.c_ulong(); u.GetWindowThreadProcessId(hwnd,ctypes.byref(p)); name=ctypes.create_unicode_buffer(256); u.GetClassNameW(hwnd,name,256)\n if p.value==${pid} and name.value=='#32770': dialogs.append(hwnd)\n return True\ncb=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)(visit); u.EnumWindows(cb,0)\nassert dialogs,'native dialog not ready'\nh=dialogs[-1]; filename=None\nif not filename:\n edits=[]\n def child(hwnd,_):\n  name=ctypes.create_unicode_buffer(256); u.GetClassNameW(hwnd,name,256)\n  if name.value=='Edit' and u.GetDlgCtrlID(ctypes.c_void_p(hwnd))==1148: edits.append(hwnd)\n  return True\n childcb=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)(child); u.EnumChildWindows(ctypes.c_void_p(h),childcb,0); filename=edits[-1] if edits else None\nassert filename,'filename field missing'\nvalue=ctypes.create_unicode_buffer(${JSON.stringify(file)})\nu.SendMessageW(filename,0xC,0,ctypes.cast(value,ctypes.c_void_p)); u.SendMessageW(filename,0xB1,len(value.value),len(value.value)); u.SendMessageW(filename,0x102,32,0); u.SendMessageW(filename,0x102,8,0); u.SendMessageW(h,0x111,(0x300<<16)|1148,filename)\nimport time; time.sleep(0.4)\ncheck=ctypes.create_unicode_buffer(4096); u.SendMessageW(filename,0xD,4096,ctypes.cast(check,ctypes.c_void_p)); assert check.value==value.value, repr(check.value)\nbutton=u.GetDlgItem(h,1); assert button,'open button missing'\nu.PostMessageW.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_void_p,ctypes.c_void_p]; u.PostMessageW(button,0xF5,0,0)\n`;
  await waitFor(async () => { try { await command('python', ['-c', script]); return true; } catch { return false; } }, 'native Windows picker input');
}

function record(message) { passed.push(message); console.log(`PASS ${message}`); }
