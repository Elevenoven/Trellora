import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'editor-controls-'));
const library = path.join(temporary, 'library');
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron', 'main.js');
const notePath = path.join(library, '编辑器控件验收.md');
const original = '# 编辑器控件验收\n\n给选中文字添加链接，其他正文保留。\n\n[已有链接](https://example.com/old)\n\n```plaintext\nconst answer = 42;\n```\n\n末尾正文\n';
const editor = "document.querySelector('.tiptap').editor";
let session;

try {
    for (const directory of [library, userData, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(notePath, original);
    await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
        libraryPath: library, activeLibraryPath: library,
        libraries: [{ path: library, alias: '编辑器验收', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }],
        workspacePath: path.join(temporary, 'workspace'),
        appPreferences: { defaultEditorMode: 'wysiwyg', autosaveDelayMs: 200 },
    }));
    await Promise.all([
        build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
        build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'preload.js'), logLevel: 'silent' }),
        build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js'), logLevel: 'silent' }),
        build({ entryPoints: ['electron/externalWebPreload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'externalWebPreload.js'), logLevel: 'silent' }),
        build({ entryPoints: ['electron/pipeline/mammothWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'mammothWorker.js'), logLevel: 'silent' }),
        command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
    ]);
    session = await launchNoteTest({ mainEntry, userData });
    await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent.includes('编辑器控件验收'))"), 'fixture in file tree');
    await session.evaluate("[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent.includes('编辑器控件验收')).click()");
    await waitFor(() => session.evaluate("Boolean(document.querySelector('.tiptap')?.editor && document.querySelector('.note-save-notice')?.dataset.status === 'clean')"), 'editor ready');

    await selectText('选中文字');
    await click('.editor-wrapper button[aria-label="链接"]');
    await enterLink('example.com/new');
    await submitLink();
    assert.equal(await session.evaluate("document.querySelector('.tiptap a[href=\"https://example.com/new\"]').textContent"), '选中文字');
    assert.match(await saved(), /给\[选中文字\]\(https:\/\/example.com\/new\)添加链接，其他正文保留。/);

    // 实际右键和点击，验证弹窗获取焦点后仍能操作原选区。
    await selectText('选中文字');
    const selectedPoint = await session.evaluate(`(() => { const r = ${editor}.view.coordsAtPos(${editor}.state.selection.from + 1); return { x: r.left + 2, y: (r.top + r.bottom) / 2 }; })()`);
    await pointer(selectedPoint, 'right');
    await waitFor(() => session.evaluate("Boolean(document.querySelector('.selection-context-menu button[aria-label=\"链接\"]'))"), 'context link button');
    await click('.selection-context-menu button[aria-label="链接"]');
    await waitFor(() => session.evaluate("Boolean(document.querySelector('input[aria-label=\"链接地址\"]'))"), 'context link dialog');
    assert.equal(await session.evaluate("document.querySelector('input[aria-label=\"链接地址\"]').value"), 'https://example.com/new');
    await enterLink('https://example.com/context');
    await submitLink();
    assert.match(await saved(), /\[选中文字\]\(https:\/\/example.com\/context\)/);

    await selectText('已有链接', true);
    await click('.editor-wrapper button[aria-label="链接"]');
    await waitFor(() => session.evaluate("Boolean(document.querySelector('input[aria-label=\"链接地址\"]'))"), 'existing link dialog');
    assert.equal(await session.evaluate("document.querySelector('input[aria-label=\"链接地址\"]').value"), 'https://example.com/old');
    await enterLink('https://example.com/edited');
    await submitLink();
    assert.equal(await session.evaluate("document.querySelector('.tiptap a[href=\"https://example.com/edited\"]').textContent"), '已有链接');
    await selectText('已有链接', true);
    await click('.editor-wrapper button[aria-label="链接"]');
    await clickDialogButton('移除链接');
    assert.doesNotMatch(await saved(), /example.com\/edited/);
    assert.match(await saved(), /已有链接/);

    await selectText('其他正文');
    const beforeCancel = await saved();
    await click('.editor-wrapper button[aria-label="链接"]');
    await enterLink('javascript:alert(1)');
    await clickDialogButton('应用');
    await waitFor(() => session.evaluate("document.querySelector('[role=dialog]')?.textContent.includes('请输入有效')"), 'invalid scheme feedback');
    await key('Escape', 'Escape', 27);
    await waitFor(() => session.evaluate("!document.querySelector('input[aria-label=\"链接地址\"]')"), 'Escape closes dialog');
    assert.equal(await saved(), beforeCancel);

    await selectText('末尾正文', true);
    await click('.editor-wrapper button[aria-label="链接"]');
    await enterLink('https://example.com/inserted');
    await submitLink();
    assert.equal(await session.evaluate("document.querySelector('.tiptap a[href=\"https://example.com/inserted\"]').textContent"), 'https://example.com/inserted');

    await click('.code-block-codemirror .cm-content');
    await waitFor(() => session.evaluate("Boolean(document.querySelector('.code-language-popover'))"), 'language popover');
    const popoverValues = await languageOptions();
    await click('.toolbar-code-language-select input[aria-label="代码块语言"]');
    await waitFor(() => session.evaluate("document.querySelectorAll('.toolbar-code-language-dropdown [role=option]').length === 18"), 'toolbar language options');
    const toolbarValues = await session.evaluate("[...document.querySelectorAll('.toolbar-code-language-dropdown [role=option]')].map(option => option.getAttribute('value'))");
    assert.equal(toolbarValues.length, 18);
    assert.deepEqual(popoverValues, toolbarValues);
    assert.equal(await session.evaluate("document.querySelectorAll('.toolbar-code-language-dropdown [role=option] .code-language-option-icon').length"), 18);
    await key('Escape', 'Escape', 27);
    await click('.code-block-codemirror .cm-content');
    await click('#code-language-option-java');
    await assertLanguage('java', 'Java');
    // 搜索仅在输入时筛选；上下键及 Enter 能切换，Esc 取消不会隐式应用草稿。
    await click('.code-language-input');
    await key('a', 'KeyA', 65, 2);
    await session.send('Input.insertText', { text: 'py' });
    await waitFor(async () => JSON.stringify(await languageOptions()) === JSON.stringify(['python']), 'language search');
    await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
    await assertLanguage('python', 'Python');
    assert.deepEqual(await languageOptions(), toolbarValues);
    await click('.code-language-input');
    await key('a', 'KeyA', 65, 2);
    await session.send('Input.insertText', { text: 'rust' });
    await key('Escape', 'Escape', 27);
    assert.match(await saved(), /```python/);

    // 使用下拉栏修改后，代码块标题和语言弹窗同步显示新值。
    await click('.code-block-codemirror .cm-content');
    await click('.toolbar-code-language-select input[aria-label="代码块语言"]');
    await session.evaluate("document.querySelector('.toolbar-code-language-dropdown [role=option][value=rust]').scrollIntoView({ block: 'nearest' })");
    await click('.toolbar-code-language-dropdown [role=option][value=rust]');
    await assertLanguage('rust', 'Rust');
    assert.equal(await session.evaluate("document.querySelector('.toolbar-code-language-select .code-language-option-icon.is-rust')?.textContent.trim()"), '⚙');
    assert.match(await saved(), /```rust\nconst answer = 42;/);
    assert.match(await saved(), /其他正文保留/);
    console.log('Electron editor controls verified: toolbar/context links, retained selection, edit/remove/cancel, URL validation, caret insertion, complete language lists, search/keyboard navigation and synchronized language changes.');
} catch (error) {
    console.error(error, session?.diagnostics());
    console.error(await session?.evaluate("({ dialog: document.querySelector('[role=dialog]')?.innerText, selection:document.querySelector('.tiptap')?.editor?.state.selection.toJSON(), geometry:[...document.querySelectorAll('.editor-mode-bar,.editor-wrapper,.editor-viewport,.editor-container,.editor-pane,.main-pane,.workspace')].map(n=>({class:n.className,scroll:n.scrollTop,height:n.clientHeight,rect:n.getBoundingClientRect().toJSON()})) })").catch(() => undefined));
    throw error;
} finally {
    await session?.dispose();
    assert.equal(path.dirname(temporary), staging);
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function selectText(text, caret = false) {
    await session.evaluate(`(() => { const e = ${editor}; let from; e.state.doc.descendants((node, pos) => { if (from === undefined && node.isText && node.text.includes(${JSON.stringify(text)})) from = pos + node.text.indexOf(${JSON.stringify(text)}); }); if (from === undefined) throw new Error('Missing fixture text'); e.chain().focus().setTextSelection(${caret} ? from + 1 : {from, to: from + ${text.length}}).run(); })()`);
    await delay(60); // Tiptap restores DOM focus/selection on an animation frame.
}
async function pointer({ x, y }, button = 'left') {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}
async function click(selector) {
    await waitFor(() => session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), `visible ${selector}`);
    const point = await session.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    const hit = await session.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${point.x},${point.y});let n=node,parents=[];while(n&&parents.length<5){const r=n.getBoundingClientRect(),s=getComputedStyle(n);parents.push({tag:n.tagName,class:n.className,top:r.top,left:r.left,zoom:s.zoom,position:s.position,inline:n.getAttribute('style')});n=n.parentElement;}return {matches:node===hit||node.contains(hit),point:${JSON.stringify(point)},hit:hit?.outerHTML.slice(0,300),parents};})()`);
    assert.ok(hit.matches, `Click obstructed: ${selector}: ${JSON.stringify(hit)}`);
    await pointer(point);
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function enterLink(value) {
    await click('input[aria-label="链接地址"]');
    await key('a', 'KeyA', 65, 2);
    await session.send('Input.insertText', { text: value });
}
async function clickDialogButton(label) {
    await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}))`), `dialog button ${label}`);
    const point = await session.evaluate(`(() => { const node = [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}); const r = node.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    await pointer(point);
}
async function submitLink() {
    await clickDialogButton('应用');
    await waitFor(() => session.evaluate("!document.querySelector('input[aria-label=\"链接地址\"]')"), 'link submitted');
}
async function saved() {
    await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'clean'"), 'saved note');
    return fs.readFile(notePath, 'utf8');
}
async function languageOptions() {
    return session.evaluate("[...document.querySelectorAll('.code-language-option')].map(node => node.id.replace('code-language-option-', ''))");
}
async function assertLanguage(value, label) {
    await waitFor(() => session.evaluate(`document.querySelector('.toolbar-code-language-select input[aria-label="代码块语言"]')?.value === ${JSON.stringify(label)} && document.querySelector('.code-block-node-view-header')?.textContent === ${JSON.stringify(label)} && document.querySelector('.code-language-input')?.value === ${JSON.stringify(value)}`), `synchronized ${value}`);
}
