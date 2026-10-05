import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'editor-preferences-'));
const library = path.join(temporary, 'library'), userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const notePath = path.join(library, '编辑器偏好验收.md');
const original = '# 编辑器偏好验收\n\n选中文字用于操作。\n\n' + Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 段正文用于验证滚动。`).join('\n\n');
const e = "document.querySelector('.tiptap').editor";
let session;
const checks = [];
// Fault injection belongs to this isolated bundle, never to the production IPC surface.
const faultPlugin = { name: 'editor-test-faults', setup(builder) {
  builder.onLoad({ filter: /electron[\\/]main\.ts$/ }, async args => {
    const source = await fs.readFile(args.path, 'utf8');
    const marker = 'ipcMain.handle(channel, (event, ...args) => {';
    assert.ok(source.includes(marker), 'IPC registration boundary');
    return { contents: source.replace(marker, `ipcMain.handle(channel, async (event, ...args) => {
      const state = (globalThis as any).__editorTestState ??= { counts: {}, effects: {}, releases: {} };
      state.counts[channel] = (state.counts[channel] ?? 0) + 1;
      const effect = state.effects[channel]; delete state.effects[channel];
      if (effect?.hold) await new Promise(resolve => { state.releases[channel] = resolve; });
      if (effect?.fail) throw new Error('验收模拟保存失败');`), loader: 'ts', resolveDir: path.dirname(args.path) };
  });
} };
try {
  for (const directory of [library, userData, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(notePath, original);
  await fs.writeFile(path.join(library, '第二篇.md'), '# 第二篇\n\n另一篇笔记。');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: library, activeLibraryPath: library,
    libraries: [{ path: library, alias: '验收库', addedAt: new Date().toISOString() }], workspacePath: path.join(temporary, 'workspace'),
    appPreferences: { defaultEditorMode: 'wysiwyg', autosaveDelayMs: 250, defaultEditorZoom: 1.25 } }));
  await Promise.all([
    build({ stdin: { contents: "import './electron/main.ts'; import {clipboard,ipcMain,nativeImage} from 'electron'; ipcMain.handle('verify:clipboard',(_,data)=>clipboard.write({...data,...(data.image?{image:nativeImage.createFromBitmap(Buffer.alloc(16,255),{width:2,height:2})}:{})}));ipcMain.handle('verify:effect',(_,channel,effect)=>{globalThis.__editorTestState.effects[channel]=effect;});ipcMain.handle('verify:release',(_,channel)=>{globalThis.__editorTestState.releases[channel]?.();delete globalThis.__editorTestState.releases[channel];});ipcMain.handle('verify:counts',()=>globalThis.__editorTestState.counts);", resolveDir: process.cwd() }, plugins: [faultPlugin], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    build({ stdin: { contents: "import './electron/preload.ts'; import {contextBridge,ipcRenderer} from 'electron'; contextBridge.exposeInMainWorld('editorTest',{clipboard:data=>ipcRenderer.invoke('verify:clipboard',data),effect:(channel,effect)=>ipcRenderer.invoke('verify:effect',channel,effect),release:channel=>ipcRenderer.invoke('verify:release',channel),counts:()=>ipcRenderer.invoke('verify:counts')});", resolveDir: process.cwd() }, bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'preload.js'), logLevel: 'silent' }),
    ...['knowledge/noteIndexWorker', 'externalWebPreload', 'pipeline/mammothWorker'].map(name => build({ entryPoints: [`electron/${name}.ts`], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), `${path.basename(name)}.js`), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  console.log('Fixture built; launching Electron');
  session = await launchNoteTest({ mainEntry, userData }); await installCoordinates();
  await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(n=>n.textContent.includes('编辑器偏好验收'))"), 'note tree');
  await session.evaluate("[...document.querySelectorAll('.file-tree-row')].find(n=>n.textContent.includes('编辑器偏好验收')).click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.tiptap')?.editor?.isEditable)"), 'editable rich text');
  assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '125%');
  await session.evaluate(`window.originalEditor=${e}; window.originalDoc=${e}.state.doc; true`);
  await settings();
  await session.evaluate("[...document.querySelectorAll('button')].find(n=>n.getClientRects().length && n.textContent.trim()==='编辑器').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('input[aria-label=\"正文字号\"]'))"), 'new settings');
  for (const [label, value] of [['正文字号', '20'], ['行距', '2'], ['段落间距', '24']]) {
    await click(`input[aria-label="${label}"]`); await delay(60); await key('a', 'KeyA', 65, 2);
    await session.send('Input.insertText', { text: value }); await key('Tab', 'Tab', 9);
  }
  await waitFor(() => session.evaluate("window.electronAPI.getAppPreferences().then(p=>p.editorFontSizePx===20 && p.editorLineHeight===2 && p.editorParagraphSpacingPx===24)"), 'typography persisted');
  await notes();
  assert.equal(await session.evaluate(`${e}===window.originalEditor && ${e}.state.doc===window.originalDoc`), true);
  assert.equal(await session.evaluate("getComputedStyle(document.querySelector('.tiptap')).fontSize"), '20px');
  assert.equal(await session.evaluate("getComputedStyle(document.querySelector('.tiptap p')).marginBottom"), '24px');
  assert.equal(await fs.readFile(notePath, 'utf8'), original);
  checks.push('Settings UI, persistence, typography, stable editor/doc and untouched disk');
  console.log(checks.at(-1));

  await settings(); await clickText('button', '编辑器');
  await session.evaluate("window.editorTest.effect('save-app-preferences',{hold:true,fail:true})");
  const preferencesCount = await ipcCount('save-app-preferences');
  await choose('默认缩放比例', '150%'); await waitForCount('save-app-preferences', preferencesCount);
  await click('input[aria-label="正文字号"]'); await key('a', 'KeyA', 65, 2);
  await session.send('Input.insertText', { text: '21' }); await key('Tab', 'Tab', 9);
  await session.evaluate("window.editorTest.release('save-app-preferences')");
  await waitFor(() => session.evaluate("window.electronAPI.getAppPreferences().then(p=>p.defaultEditorZoom===1.25 && p.editorFontSizePx===21)"), 'queued success after save failure');
  assert.equal(await session.evaluate("document.querySelector('input[aria-label=\"默认缩放比例\"]').value"), '125%');
  assert.equal(await session.evaluate("document.body.innerText.includes('验收模拟保存失败')"), true);
  await notes(); assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '125%');
  await setPreferences({editorFontSizePx:20});
  checks.push('Failed default-zoom save rolls back while the next queued font save succeeds'); console.log(checks.at(-1));

  await selectText('选中文字');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.selection-floating-toolbar'))"), 'floating selection');
  await click('.selection-floating-toolbar button[aria-label="粗体"]');
  assert.equal(await session.evaluate("document.querySelector('.tiptap strong')?.textContent"), '选中文字');
  await selectText('选中文字');
  const selectedRange = await session.evaluate(`${e}.state.selection.toJSON()`);
  await key('Tab','Tab',9);
  assert.equal(await session.evaluate("document.activeElement?.getAttribute('aria-label')"),'粗体');
  await key('Tab','Tab',9,8);
  assert.equal(await session.evaluate(`${e}.isFocused`),true,'Shift+Tab returns to the editor');
  await key('Tab','Tab',9); await key('Tab','Tab',9);
  assert.equal(await session.evaluate("document.activeElement?.getAttribute('aria-label')"),'斜体');
  await key('Enter','Enter',13);
  await waitFor(()=>session.evaluate(`${e}.isActive('italic')`),'keyboard toolbar activation');
  assert.deepEqual(await session.evaluate(`${e}.state.selection.toJSON()`),selectedRange);
  await key('Tab','Tab',9); await key('Escape','Escape',27); await delay(60);
  assert.equal(await session.evaluate(`${e}.isFocused`),true,'Escape from the toolbar returns focus to the editor');
  const aiCount = await ipcCount('selection-edit:start');
  await selectText('选中文字',true);
  await selectText('选中文字'); await click('.selection-floating-toolbar button[aria-label="AI 编辑"]');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('button[aria-label=\"关闭 AI 编辑\"]'))"), 'explicit AI launcher');
  assert.equal(await session.evaluate("document.body.innerText.includes('原文已变化。本次重新生成')"), false, 'A new floating-toolbar session must clear stale state from earlier edits');
  assert.equal(await ipcCount('selection-edit:start'), aiCount, 'Opening the AI launcher must not invoke a model');
  await key('Escape', 'Escape', 27);
  await setPreferences({ editorSelectionToolbarEnabled: false, editorMarkdownAutoConvert: false });
  await selectText('选中文字'); await delay(150);
  assert.equal(await session.evaluate("Boolean(document.querySelector('.selection-floating-toolbar'))"), false);
  await appendParagraph();
  await key('#', 'Digit3', 51); await key(' ', 'Space', 32);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.type.name`), 'paragraph');
  await setPreferences({ editorMarkdownAutoConvert: true });
  await appendParagraph();
  await key('#', 'Digit3', 51); await key(' ', 'Space', 32);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.type.name`), 'heading');
  checks.push('Selection toolbar formatting/toggle and live Markdown rules'); console.log(checks.at(-1));

  await appendParagraph();
  await session.evaluate("window.editorTest.clipboard({text:'**字面文字**',html:'<p><strong>字面文字</strong></p>'})");
  await key('v', 'KeyV', 86, 10); await delay(150);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.textContent`), '**字面文字**');
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.firstChild.marks.length`), 0);
  await appendParagraph();
  await key('v', 'KeyV', 86, 2); await delay(150);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.firstChild.marks[0].type.name`), 'bold');
  checks.push('Native rich clipboard and forced literal plain paste'); console.log(checks.at(-1));

  for (const mode of ['preserve-format', 'plain-text']) {
    await setPreferences({ editorPasteMode: mode }); await appendParagraph();
    await session.evaluate(`${e}.commands.insertContent('待粘贴')`); await selectText('待粘贴');
    await session.evaluate("window.editorTest.clipboard({text:'**右键文字**',html:'<p><strong>右键文字</strong></p>'})");
    const point = await session.evaluate(`(()=>{const r=window.physicalRect(${e}.view.coordsAtPos(${e}.state.selection.from+1),${e}.view.dom);return {x:r.left+2,y:(r.top+r.bottom)/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 });
    await waitFor(() => session.evaluate("Boolean(document.querySelector('.selection-context-menu'))"), 'paste menu');
    await clickText('.selection-context-menu button', '粘贴'); await delay(100);
    assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.textContent`), mode === 'plain-text' ? '**右键文字**' : '右键文字');
    assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.firstChild.marks.some(m=>m.type.name==='bold')`), mode === 'preserve-format');
  }
  await appendParagraph(); await key('v', 'KeyV', 86, 2); await delay(100);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.textContent`), '**右键文字**');
  await session.evaluate('window.editorTest.clipboard({image:true})');
  assert.equal(await session.evaluate('window.electronAPI.readClipboardContent().then(c=>c.text==="" && c.imagePng?.length>0)'), true);
  const beforeImages = await session.evaluate("document.querySelectorAll('.tiptap img').length");
  await key('v', 'KeyV', 86, 10); await delay(150);
  assert.equal(await session.evaluate("document.querySelectorAll('.tiptap img').length"), beforeImages);
  await key('v', 'KeyV', 86, 2);
  await waitFor(() => session.evaluate(`document.querySelectorAll('.tiptap img').length===${beforeImages + 1}`), 'native image attachment');
  assert.match(await saved(), /!\[.*\]\(.*image.*\.png\)/);
  checks.push('Context and keyboard paste parity; native image attachment and force-plain image exclusion'); console.log(checks.at(-1));

  const beforeDelayedPaste = await saved();
  await session.evaluate("window.editorTest.effect('save-editor-image',{hold:true})");
  const imageCount = await ipcCount('save-editor-image');
  await key('v', 'KeyV', 86, 2); await waitForCount('save-editor-image', imageCount);
  await openNote('第二篇'); const secondNote = await fs.readFile(path.join(library, '第二篇.md'), 'utf8');
  await session.evaluate("window.editorTest.release('save-editor-image')"); await delay(200);
  assert.equal(await fs.readFile(notePath, 'utf8'), beforeDelayedPaste);
  assert.equal(await fs.readFile(path.join(library, '第二篇.md'), 'utf8'), secondNote);
  assert.equal(await session.evaluate("document.querySelectorAll('.tiptap img').length"), 0);
  await openNote('编辑器偏好验收');
  await session.evaluate("window.editorTest.effect('save-editor-image',{hold:true})");
  const selectionImageCount = await ipcCount('save-editor-image');
  await selectText('第 10 段正文', true); await key('v', 'KeyV', 86, 2); await waitForCount('save-editor-image', selectionImageCount);
  await selectText('第 20 段正文', true);
  await session.evaluate("window.editorTest.release('save-editor-image')"); await delay(200);
  assert.equal(await saved(), beforeDelayedPaste);
  checks.push('Delayed image paste rejects changed notes and changed selections'); console.log(checks.at(-1));

  await setPreferences({editorSelectionToolbarEnabled:true});
  await click('.editor-writing-toggle[aria-pressed="false"]');
  await waitFor(() => session.evaluate("document.querySelector('.app-shell').classList.contains('note-focus-active')"), 'focus mode');
  assert.equal(await session.evaluate("document.querySelector('.sidebar').getClientRects().length"), 0);
  assert.equal(await session.evaluate("document.querySelector('.knowledge-panel').inert"), true);
  await settings();
  assert.equal(await session.evaluate("Boolean(document.querySelector('input[aria-label=\"专注模式\"]')?.checked)"), true, 'Cached settings must reflect toolbar mode changes');
  await clickText('button','通用'); await notes(); await settings();
  assert.equal(await session.evaluate("Boolean(document.querySelector('input[aria-label=\"专注模式\"]')?.getClientRects().length)"), true, 'The focus settings entry must reopen the editor section');
  await notes();
  await selectText('第 35 段正文');
  await waitFor(()=>session.evaluate("Boolean(document.querySelector('.selection-floating-toolbar'))"),'focused selection toolbar');
  await key('Escape','Escape',27); await delay(80);
  assert.equal(await session.evaluate("document.querySelector('.app-shell').classList.contains('note-focus-active')"),true);
  assert.equal(await session.evaluate("Boolean(document.querySelector('.selection-floating-toolbar'))"),false);
  await key('Escape', 'Escape', 27);
  await waitFor(() => session.evaluate("!document.querySelector('.app-shell').classList.contains('note-focus-active')"), 'focus exit');
  assert.ok(await session.evaluate("document.querySelector('.sidebar').getClientRects().length"));
  await setPreferences({ editorTypewriterModeEnabled: true,editorSelectionToolbarEnabled:false });
  await selectText('第 35 段正文', true);
  await key('ArrowRight', 'ArrowRight', 39); await delay(200);
  const delta = await session.evaluate(`(()=>{const r=window.physicalRect(${e}.view.coordsAtPos(${e}.state.selection.head),${e}.view.dom),v=document.querySelector('.editor-viewport').getBoundingClientRect();return Math.abs((r.top+r.bottom)/2-(v.top+v.height/2));})()`);
  assert.ok(delta <= 12, `Typewriter center delta ${delta}`);
  const viewportPoint = await session.evaluate("(()=>{const r=document.querySelector('.editor-viewport').getBoundingClientRect();return {x:r.left+40,y:r.top+60};})()");
  await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...viewportPoint, deltaY: 400, deltaX: 0 });
  await delay(150); const scroll = await session.evaluate("document.querySelector('.editor-viewport').scrollTop");
  await delay(1100); assert.equal(await session.evaluate("document.querySelector('.editor-viewport').scrollTop"), scroll);
  checks.push('Focus hide/inert/restore and caret following/manual scroll priority'); console.log(checks.at(-1));

  await setPreferences({ editorContentWidth: 'wide', editorTypewriterModeEnabled: false });
  const savedBeforeLayout = await saved();
  await clickText('.segmented-control button', '预览'); await delay(100);
  assert.equal(await session.evaluate("getComputedStyle(document.querySelector('.preview-content')).fontSize"), '20px');
  assert.equal(await session.evaluate("getComputedStyle(document.querySelector('.preview-content p')).marginBottom"), '24px');
  await clickText('.segmented-control button', '源码'); await waitFor(() => session.evaluate("Boolean(document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view)"), 'source view');
  const source = "document.querySelector('.source-editor .cm-content').cmTile.root.view";
  assert.equal(await session.evaluate("getComputedStyle(document.querySelector('.source-editor .cm-editor')).fontSize"), '20px');
  await setPreferences({ editorTypewriterModeEnabled: true });
  await session.evaluate(`(()=>{const v=${source};v.dispatch({selection:{anchor:v.state.doc.line(50).from+1}});v.focus();})()`); await delay(100);
  await key('ArrowRight', 'ArrowRight', 39); await delay(150);
  const sourceDelta = await session.evaluate(`(()=>{const v=${source},c=window.physicalRect(v.coordsAtPos(v.state.selection.main.head),v.contentDOM),r=window.physicalRect(v.scrollDOM.getBoundingClientRect(),v.scrollDOM);return Math.abs((c.top+c.bottom)/2-(r.top+r.height/2));})()`);
  assert.ok(sourceDelta <= 12, `Source typewriter delta ${sourceDelta}`);
  await click('.editor-writing-toggle[aria-pressed="false"]'); await delay(100);
  await key('f', 'KeyF', 70, 2); await waitFor(() => session.evaluate("Boolean(document.querySelector('.source-editor .cm-search'))"), 'source search');
  await key('Escape', 'Escape', 27); await delay(100);
  assert.equal(await session.evaluate("Boolean(document.querySelector('.source-editor .cm-search'))"), false);
  assert.equal(await session.evaluate("document.querySelector('.app-shell').classList.contains('note-focus-active')"), true);
  await key('Escape', 'Escape', 27); await delay(100);
  assert.equal(await session.evaluate("document.querySelector('.app-shell').classList.contains('note-focus-active')"), false);
  assert.equal(await saved(), savedBeforeLayout);
  checks.push('Preview/source typography, source caret following and search-first Escape with unchanged disk'); console.log(checks.at(-1));

  await setPreferences({ editorTypewriterModeEnabled: false }); await settings();
  await clickText('button', '编辑器'); await choose('默认缩放比例', '100%'); await notes();
  assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '100%');
  await settings(); await clickText('button', '编辑器'); await choose('默认缩放比例', '125%'); await notes();
  await click('.editor-zoom-trigger');
  for (let i = 0; i < 5; i++) await click('.editor-zoom-step[aria-label="放大"]');
  assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '150%');
  await openNote('第二篇'); assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '150%');
  await openNote('编辑器偏好验收'); await click('.editor-zoom-trigger'); await click('.editor-zoom-reset');
  assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '125%');
  await click('.editor-zoom-trigger'); for (let i = 0; i < 5; i++) await click('.editor-zoom-step[aria-label="放大"]');
  await session.dispose(); session = await launchNoteTest({ mainEntry, userData }); await installCoordinates(); await openNote('编辑器偏好验收');
  assert.equal(await session.evaluate("document.querySelector('.editor-zoom-trigger span').textContent"), '125%');
  checks.push('Default zoom GUI save, temporary zoom across notes, reset and real process restart'); console.log(checks.at(-1));

  const matrix = [];
  for (const [width, height] of [[1024, 768], [1440, 900]]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const zoom of [0.75, 1, 1.5]) {
      for (const focus of [false, true]) {
        await setPreferences({defaultEditorZoom:zoom,editorFocusModeEnabled:focus,editorContentWidth:'full',editorTypewriterModeEnabled:false});
        for (const mode of ['编辑', '预览', '源码']) {
          await clickText('.segmented-control button', mode); await delay(80);
          const geometry = await session.evaluate("(()=>{const menu=document.querySelector('.note-document-surface>.editor-mode-bar').getBoundingClientRect(),bottom=document.querySelector('.note-document-surface').getBoundingClientRect().bottom;return {noOverflow:document.documentElement.scrollWidth<=innerWidth,toolbarVisible:menu.top>=0&&menu.bottom<bottom};})()");
          assert.ok(geometry.noOverflow && geometry.toolbarVisible, `${width}x${height}, ${zoom}, ${focus}, ${mode}: ${JSON.stringify(geometry)}`);
          matrix.push({width,height,zoom,focus,mode});
        }
      }
    }
  }
  checks.push('1024x768 and 1440x900 at 75/100/150%, three modes and both sidebar layouts'); console.log(checks.at(-1));
  await setPreferences({defaultEditorZoom:1.25,editorFocusModeEnabled:false}); await clickText('.segmented-control button','编辑');

  const evidence = path.resolve('output/verification/editor-preferences'); await fs.mkdir(evidence, { recursive: true });
  for (const [theme, language] of [['light', 'zh-CN'], ['dark', 'zh-CN'], ['dark', 'en-US'], ['light', 'en-US']]) {
    await setPreferences({ theme, language, editorFocusModeEnabled: true, editorTypewriterModeEnabled: true });
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }); await delay(150);
    assert.equal(await session.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    const capture = await session.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(evidence, `writing-${theme}-${language}.png`), Buffer.from(capture.data, 'base64'));
    await settings(); await clickText('button', language === 'zh-CN' ? '编辑器' : 'Editor'); await delay(100);
    assert.equal(await session.evaluate(`Boolean(document.querySelector('input[aria-label="${language === 'zh-CN' ? '正文字号' : 'Body font size'}"]'))`), true);
    assert.equal(await session.evaluate(`document.querySelector('input[aria-label="${language === 'zh-CN' ? '默认缩放比例' : 'Default zoom'}"]').value`), '125%');
    for (const label of language === 'zh-CN' ? ['专注模式','打字机模式'] : ['Focus mode','Typewriter mode']) assert.equal(await session.evaluate(`document.querySelector('input[aria-label=${JSON.stringify(label)}]').checked`), true);
    const settingsCapture = await session.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(evidence, `settings-${theme}-${language}.png`), Buffer.from(settingsCapture.data, 'base64'));
    await session.evaluate("document.querySelector('input[aria-label=\"'+(document.documentElement.lang==='en-US'?'Typewriter mode':'打字机模式')+'\"]').closest('.settings-field-card').scrollIntoView({block:'end'})"); await delay(80);
    const bottomCapture = await session.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(evidence, `settings-bottom-${theme}-${language}.png`), Buffer.from(bottomCapture.data, 'base64'));
    await notes();
  }
  checks.push('1024x768 light/dark Chinese/English settings and writing modes');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ checks, layoutMatrix:matrix, typewriterDelta: delta, sourceTypewriterDelta: sourceDelta, passed: true }, null, 2));
  console.log('Electron editor preferences verified', checks);
} catch (error) {
  console.error(error.message, session?.diagnostics().slice(-1500));
  if (session) console.error(await session.evaluate("({body:document.body.innerText.slice(-300), zoomInput:document.querySelector('input[aria-label=\"默认缩放比例\"]')?.value, caret:document.querySelector('.tiptap')?.editor?.state.selection.$head.parent.type.name, focused:document.querySelector('.tiptap')?.editor?.isFocused, selection:document.querySelector('.tiptap')?.editor?.state.selection.toJSON(), storage:document.querySelector('.tiptap')?.editor?.storage.editorPreferences})").catch(() => undefined));
  throw error;
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await session.send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...(key === 'Enter' ? {text:'\r',unmodifiedText:'\r'} : {}), key, code, windowsVirtualKeyCode, modifiers });
  if (key.length === 1 && !modifiers) await session.send('Input.dispatchKeyEvent', { type: 'char', text: key, key, code, windowsVirtualKeyCode });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function click(selector) {
  await session.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');if(n.getBoundingClientRect().top<0||n.getBoundingClientRect().bottom>innerHeight)n.scrollIntoView({block:'nearest'});})()`); await delay(40);
  const point = await session.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=window.physicalRect(n.getBoundingClientRect(),n),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!n.contains(hit))throw Error('Obstructed '+${JSON.stringify(selector)}+' by '+hit?.outerHTML.slice(0,250));return{x,y};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function settings() { await session.evaluate("(()=>{const button=document.querySelector('.app-shell.note-focus-active .editor-writing-toggle:not([aria-pressed])');if(button)button.click();else [...document.querySelectorAll('.app-nav-item')].find(n=>['设置','Settings'].includes(n.getAttribute('aria-label'))).click();})()"); await waitFor(() => session.evaluate("[...document.querySelectorAll('.app-nav-item')].some(n=>['设置','Settings'].includes(n.getAttribute('aria-label'))&&n.getAttribute('aria-current')==='page')"), 'settings'); }
async function notes() { await session.evaluate("[...document.querySelectorAll('.app-nav-item')].find(n=>['笔记','Notes'].includes(n.getAttribute('aria-label'))).click()"); await waitFor(() => session.evaluate("Boolean(document.querySelector('.notes-main-view')?.getClientRects().length)"), 'notes'); }
async function setPreferences(patch) { await session.evaluate(`window.electronAPI.saveAppPreferences(${JSON.stringify(patch)})`); await settings(); await delay(80); await notes(); await delay(80); }
async function selectText(text, caret = false) {
  await session.evaluate(`(()=>{const e=${e};let from;e.state.doc.descendants((n,p)=>{if(from===undefined&&n.isText&&n.text.includes(${JSON.stringify(text)}))from=p+n.text.indexOf(${JSON.stringify(text)});});if(from===undefined)throw Error('Missing text');e.chain().focus().setTextSelection(${caret} ? from+1 : {from,to:from+${text.length}}).scrollIntoView().run();})()`);
  await delay(60);
}

async function appendParagraph() {
  await session.evaluate(`(()=>{const e=${e},p=e.state.doc.content.size;e.commands.insertContentAt(p,{type:'paragraph'});e.commands.setTextSelection(p+1);e.commands.focus(p+1);})()`);
  await delay(50);
  assert.equal(await session.evaluate(`${e}.state.selection.$head.parent.textContent`), '');
}
async function saved() { await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status==='clean'"), 'saved'); return fs.readFile(notePath, 'utf8'); }
async function clickText(selector, text) {
  await session.evaluate(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'&&n.textContent.trim().startsWith(${JSON.stringify(text)}));if(!n)throw Error('Missing '+${JSON.stringify(text)});window.testClickTarget=n;const r=n.getBoundingClientRect();if(${JSON.stringify(selector)}==='[role=option]'||r.top<0||r.bottom>innerHeight)n.scrollIntoView({block:'nearest'});})()`); await delay(40);
  const point = await session.evaluate(`(()=>{const n=window.testClickTarget,r=window.physicalRect(n.getBoundingClientRect(),n),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!n.contains(hit))throw Error('Obstructed '+${JSON.stringify(text)}+' by '+hit?.outerHTML.slice(0,250));return{x,y};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function choose(label, value) { await click(`input[aria-label="${label}"]`); await clickText('[role=option]', value); await delay(150); }
async function openNote(title) { await waitFor(() => session.evaluate(`[...document.querySelectorAll('.file-tree-row')].some(n=>n.textContent.includes(${JSON.stringify(title)}))`), 'note tree'); await session.evaluate(`[...document.querySelectorAll('.file-tree-row')].find(n=>n.textContent.includes(${JSON.stringify(title)})).click()`); await waitFor(() => session.evaluate(`Boolean(document.querySelector('.file-tree-row.selected')?.textContent.includes(${JSON.stringify(title)}) && document.querySelector('.note-save-notice')?.dataset.status==='clean')`), 'opened note'); await delay(80); }

async function installCoordinates() { await session.evaluate(`window.physicalRect=(r,n)=>{const p=n.closest('.editor-container,.source-editor-zoom'),z=Number(p?.style.zoom)||1,s=p?.offsetWidth?p.getBoundingClientRect().width/p.offsetWidth:1,f=z/(s||1);return {left:r.left*f,right:r.right*f,top:r.top*f,bottom:r.bottom*f,width:(r.right-r.left)*f,height:(r.bottom-r.top)*f};};true`); }
async function ipcCount(channel) { return session.evaluate(`window.editorTest.counts().then(c=>c[${JSON.stringify(channel)}]??0)`); }
async function waitForCount(channel, previous) { return waitFor(async () => await ipcCount(channel) > previous, channel); }
