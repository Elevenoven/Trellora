import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

// 只启动隔离实例；缓存 IO、配置保存与回收站故障均限制在本次临时语料中。
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'user-operation-regressions-'));
const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-user-operation-regressions-'));
const userData = path.join(fixtures, 'user-data'), notes = path.join(fixtures, 'notes');
const mainEntry = path.join(temporary, 'dist-electron/main.js'), controls = path.join(fixtures, 'controls.json');
const output = path.resolve('output/verification/user-operation-fixes');
const checks = []; let session;
let flags = {};
async function configure(patch) { flags = { ...flags, ...patch }; await fs.writeFile(controls, JSON.stringify(flags)); }
const record = message => { checks.push(message); console.log(message); };

try {
  for (const directory of [userData, notes, path.dirname(mainEntry), output]) await fs.mkdir(directory, { recursive: true });
  const note = path.join(notes, '删除失败保留.md'), external = path.join(fixtures, '独立文件.txt'), copy = path.join(fixtures, '另存副本.txt'), imported = path.join(fixtures, '导入资料.md');
  await fs.writeFile(note, '# 保留原笔记\n\n文件占用时不得丢失正文。');
  await fs.writeFile(external, '独立原件'); await fs.writeFile(imported, '# 导入资料\n\n虚构企业的项目验收记录。');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: path.join(fixtures, 'workspace'), libraryPath: notes, activeLibraryPath: notes, libraries: [{ path: notes, alias: '回归笔记', addedAt: new Date().toISOString() }], onboarding: { version: 1, status: 'skipped' }, appPreferences: { language: 'zh-CN', defaultEditorMode: 'source' } }));
  await configure({ open: external, save: copy });
  const harness = path.join(temporary, 'harness.ts');
  await fs.writeFile(harness, `import { app, dialog, ipcMain, shell } from 'electron'; import fs from 'node:fs'; import path from 'node:path';
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(controls)}, 'utf8'));
const nativeHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = ((channel: string, listener: any) => nativeHandle(channel, async (event: any, ...args: any[]) => {
  if (channel === 'save-library-pipeline-llm' && read().denyBinding) throw new Error('EACCES: 模型绑定文件暂不可写');
  if (channel === 'import-materials-documents' && read().holdImport) {
    fs.writeFileSync(${JSON.stringify(path.join(fixtures, 'import-started'))}, args[0]);
    while (read().holdImport) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const result = await listener(event, ...args);
  if (channel === 'save-library-pipeline-llm' && args[1]?.model === 'delayed-model' && read().holdBindingReceipt) {
    fs.writeFileSync(${JSON.stringify(path.join(fixtures, 'binding-saved'))}, args[1].model);
    while (read().holdBindingReceipt) await new Promise(resolve => setTimeout(resolve, 30));
  }
  return result;
})) as any;
const nativeOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = (async (file: any, ...args: any[]) => {
  if (read().denyCache && String(file).startsWith(path.join(${JSON.stringify(userData)}, 'external-documents') + path.sep)) throw Object.assign(new Error('Recovery cache read-only'), { code: 'EACCES' });
  return nativeOpen(file, ...args as [any]);
}) as any;
const nativeTrash = shell.trashItem.bind(shell);
shell.trashItem = (async (file: string) => { if (read().denyDelete && file === ${JSON.stringify(note)}) throw new Error('EPERM: 回归笔记被其他程序占用'); return nativeTrash(file); }) as any;
dialog.showOpenDialog = (async () => ({ canceled: !read().open, filePaths: read().open ? [read().open] : [] })) as any;
dialog.showSaveDialog = (async () => ({ canceled: !read().save, filePath: read().save })) as any;
dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any;
require(${JSON.stringify(path.resolve('electron/main.ts').replaceAll('\\', '/'))});
`);
  await Promise.all([
    build({ entryPoints: [harness], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    ...[['electron/preload.ts', 'preload.js'], ['electron/externalWebPreload.ts', 'externalWebPreload.js'], ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js'], ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js']].map(([input, name]) => build({ entryPoints: [input], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: path.join(path.dirname(mainEntry), name), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await session.evaluate("window.__alerts=[]; window.__rejections=[]; window.alert=text=>window.__alerts.push(text); window.confirm=()=>true; window.addEventListener('unhandledrejection', event=>window.__rejections.push(String(event.reason)))");

  await configure({ denyDelete: true });
  await clickSelector(`.file-tree-row[data-path=${JSON.stringify(note)}]`);
  await waitFor(() => session.evaluate("document.querySelector('.knowledge-note-path')?.textContent.includes('删除失败保留')"), 'note opened');
  await session.evaluate(`document.querySelector(${JSON.stringify(`.file-tree-row[data-path=${JSON.stringify(note)}]`)})?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:180}))`);
  await clickText('删除笔记', '[role="menuitem"]');
  await waitFor(() => session.evaluate("window.__alerts.some(text=>text.includes('删除失败') && text.includes('占用'))"), 'delete error feedback');
  assert.match(await fs.readFile(note, 'utf8'), /保留原笔记/); assert.deepEqual(await session.evaluate('window.__rejections'), []);
  record('笔记删除失败显示原因、原内容保留且没有未处理异常');

  const libraryA = await session.evaluate("window.electronAPI.createMaterialsLibrary('回归资料A')"), libraryB = await session.evaluate("window.electronAPI.createMaterialsLibrary('回归资料B')");
  await session.evaluate(`window.electronAPI.saveLibraryPipelineLlm(${JSON.stringify(libraryA)}, {schemaVersion:1,source:'ollama',model:'original-model'})`);
  await clickSelector('.app-nav-item[aria-label="资料"]');
  await chooseLibrary('回归资料A');
  await configure({ open: imported });
  await clickSelector('.materials-list-pane [aria-label="导入文档"]');
  await waitFor(() => session.evaluate("document.querySelector('.materials-list-pane')?.innerText.includes('导入资料')"), 'first material imported');
  await configure({ denyBinding: true });
  await clickSelector('[aria-label="回归资料A 操作"]');
  await clickText('切块与流水线', '[role="menuitem"]');
  await clickSelector('[aria-label="资料库模型设置"]');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('input[aria-label=\"语言模型\"]') || Array.from(document.querySelectorAll('input')).find(input=>input.value==='original-model'))"), 'model binding loaded');
  await session.evaluate("(Array.from(document.querySelectorAll('input')).find(input=>input.value==='original-model')).focus()");
  await shortcut('a'); await session.send('Input.insertText', { text: 'retry-model' });
  await waitFor(() => session.evaluate("document.body.innerText.includes('模型绑定文件暂不可写')"), 'model save failure');
  assert.equal(await session.evaluate("document.body.innerText.includes('已绑定：ollama · retry-model')"), false);
  assert.equal((await session.evaluate(`window.electronAPI.getLibraryPipelineLlm(${JSON.stringify(libraryA)})`)).model, 'original-model');
  await configure({ denyBinding: false }); await clickText('重试保存', 'button');
  await waitFor(async () => (await session.evaluate(`window.electronAPI.getLibraryPipelineLlm(${JSON.stringify(libraryA)})`)).model === 'retry-model', 'same binding retry saved');
  await waitFor(() => session.evaluate("document.body.innerText.includes('已绑定：') && !document.body.innerText.includes('绑定尚未保存')"), 'binding receipt reflected');
  record('模型绑定失败不显示已保存，同一配置可重试并取得真实落盘回执');
  // 保存回执延迟期间改回原值，仍需重新提交，不能错误复用之前的保存标记。
  await configure({ holdBindingReceipt: true });
  await editModel('retry-model', 'delayed-model');
  await waitFor(async () => { try { await fs.stat(path.join(fixtures, 'binding-saved')); return true; } catch { return false; } }, 'old binding saved, receipt pending');
  await editModel('delayed-model', 'retry-model');
  await waitFor(async () => (await session.evaluate(`window.electronAPI.getLibraryPipelineLlm(${JSON.stringify(libraryA)})`)).model === 'retry-model', 'reverted binding persisted');
  await configure({ holdBindingReceipt: false });
  await waitFor(() => session.evaluate("document.body.innerText.includes('已绑定：ollama · retry-model')"), 'delayed binding receipt ignored');
  record('模型保存回执延迟时改回原值，实际配置与最后一次输入保持一致');
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await clickSelector('[aria-label="返回文档列表"]');
  const second = path.join(fixtures, '第二份资料.md'); await fs.writeFile(second, '# 第二份资料\n\n导入期间切换知识库。');
  await configure({ open: second, holdImport: true }); await clickSelector('.materials-list-pane [aria-label="导入文档"]');
  await waitFor(async () => { try { await fs.stat(path.join(fixtures, 'import-started')); return true; } catch { return false; } }, 'import held');
  await chooseLibrary('回归资料B'); await configure({ holdImport: false });
  await waitFor(async () => (await session.evaluate(`window.electronAPI.listMaterialsDocuments(${JSON.stringify(libraryA)})`)).some(document => document.name.includes('第二份资料')), 'A import complete');
  await delay(500);
  assert.equal(await session.evaluate("document.querySelector('.materials-rail-item.active')?.innerText"), '回归资料B');
  assert.equal(await session.evaluate("document.querySelector('.materials-list-pane')?.innerText.includes('第二份资料')"), false);
  await chooseLibrary('回归资料A'); await waitFor(() => session.evaluate("document.querySelector('.materials-list-pane')?.innerText.includes('第二份资料')"), 'import visible when returning to A');
  record('A 库导入完成后保留 B 库选择，回到 A 可查看真实导入结果');

  await configure({ open: external, denyCache: true }); await shortcut('o');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.external-document .cm-content'))"), 'external opened');
  await editExternal('缓存故障下手动保存');
  await waitFor(() => session.evaluate("document.querySelector('.external-document')?.innerText.includes('恢复缓存暂不可用')"), 'cache warning');
  assert.equal(await fs.readFile(external, 'utf8'), '独立原件');
  await shortcut('s'); await waitFor(async () => await fs.readFile(external, 'utf8') === '缓存故障下手动保存', 'explicit save without cache');
  await editExternal('缓存故障下另存副本'); await shortcut('s', true);
  await waitFor(async () => { try { return await fs.readFile(copy, 'utf8') === '缓存故障下另存副本'; } catch { return false; } }, 'save as without cache');
  assert.equal(await fs.readFile(external, 'utf8'), '缓存故障下手动保存');
  await editExternal('关闭时放弃的草稿'); await session.closeWindow(); await clickSelector('[data-document-choice="discard"]'); await session.exited;
  assert.equal(await fs.readFile(copy, 'utf8'), '缓存故障下另存副本');
  record('真实 IPC 缓存写入失败仍可保存、另存及选择放弃后关闭，原件与副本内容准确');
  await fs.writeFile(path.join(output, 'electron.json'), JSON.stringify({ checks, injected: ['cache EACCES', 'model binding save EACCES', 'delayed material import', 'recycle EPERM'], packaged: false, cleanMachine: false }, null, 2));
} catch (error) {
  console.error(error, session?.diagnostics());
  if (session) console.error(await session.evaluate("JSON.stringify({alerts:window.__alerts,rejections:window.__rejections,body:document.body.innerText.slice(0,5000)})").catch(() => 'Window closed'));
  throw error;
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging); assert.equal(path.dirname(fixtures), path.resolve(os.tmpdir()));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await fs.rm(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function clickSelector(selector) { await waitFor(() => session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector); await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function clickText(text, selector) { await waitFor(() => session.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(element=>element.textContent.trim()===${JSON.stringify(text)})`), text); await session.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element=>element.textContent.trim()===${JSON.stringify(text)}).click()`); }
async function chooseLibrary(name) { await clickText(name, '.materials-rail-item'); await waitFor(() => session.evaluate(`document.querySelector('.materials-rail-item.active')?.innerText===${JSON.stringify(name)}`), name); }
async function shortcut(key, shift = false) { const code = key.toUpperCase().charCodeAt(0); for (const type of ['rawKeyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', { type, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers: 2 + (shift ? 8 : 0) }); }
async function editModel(previous, value) { await session.evaluate(`Array.from(document.querySelectorAll('input')).find(input=>input.value===${JSON.stringify(previous)}).focus()`); await shortcut('a'); await session.send('Input.insertText', { text: value }); }
async function editExternal(text) { await waitFor(() => session.evaluate("document.querySelector('.external-document .cm-content')?.isContentEditable && !document.querySelector('[role=dialog]')"), 'external editor ready'); await session.evaluate("document.querySelector('.external-document .cm-content').focus()"); await shortcut('a'); await session.send('Input.insertText', { text }); await waitFor(() => session.evaluate("document.querySelector('.external-save-notice')?.dataset.status==='dirty'"), 'external draft'); }
