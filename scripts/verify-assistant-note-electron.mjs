import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'assistant-note-electron-'));
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron', 'main.js');
const libraries = [path.join(temporary, 'notes-a'), path.join(temporary, 'notes-b')];
const screenshots = path.resolve('output/verification/assistant-note');
const answer = '# 澄川科技会议纪要\n\n**负责人：林晓**\n\n| 部门 | 应收金额 |\n| --- | ---: |\n| 华北销售部 | 12800 |\n\n```ts\nconst amount = 12800;\n```\n\n$$\na^2+b^2=c^2\n$$\n\n- [ ] 复核项目金额\n\n```mermaid\ngraph LR\nA[项目资料] --> B[复核结果]\n```\n\n'
  + await fs.readFile(path.resolve('scripts/fixtures/markdown-rendering/ai-math-emphasis.md'), 'utf8');
let session;
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/tags' || request.url === '/api/ps') return response.end(JSON.stringify({ models: [{ name: 'note-fixture', context_length: 32768 }] }));
  if (request.url === '/api/show') return response.end(JSON.stringify({ model_info: { 'test.context_length': 32768 } }));
  if (request.url === '/api/generate' || request.url === '/api/chat') {
    if (body.stream) response.setHeader('Content-Type', 'application/x-ndjson');
    return response.end(JSON.stringify({ model: 'note-fixture', response: answer, message: { role: 'assistant', content: answer }, done: true, prompt_eval_count: 100, eval_count: 200 }) + '\n');
  }
  response.statusCode = 404; response.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

try {
  for (const directory of [userData, path.dirname(mainEntry), ...libraries, screenshots]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(libraries[0], '原有笔记.md'), '# 原有笔记\n');
  await fs.writeFile(path.join(libraries[1], '未命名[2].md'), '# 保留已有笔记\n');
  const provider = { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'note-fixture' };
  const now = new Date().toISOString();
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath: libraries[0], activeLibraryPath: libraries[0], workspacePath: path.join(temporary, 'workspace'),
    libraries: libraries.map((library, index) => ({ path: library, alias: index ? '项目笔记库' : '个人笔记库', addedAt: now, lastOpenedAt: now })),
    aiProviderConfig: provider,
    aiModelSettings: { schemaVersion: 1, defaultProfileId: 'model_note_fixture', profiles: [{ id: 'model_note_fixture', label: '笔记验收模型', config: provider }] },
    appPreferences: { theme: 'light', language: 'zh-CN', defaultEditorMode: 'wysiwyg' },
  }));
  await Promise.all([
    ...[['main', ['electron', 'better-sqlite3']], ['preload', ['electron']], ['externalWebPreload', ['electron']], ['knowledge/noteIndexWorker', []], ['pipeline/mammothWorker', []], ['workspaceMigrationWorker', ['better-sqlite3']]].map(([entry, external]) => build({ entryPoints: [`electron/${entry}.ts`], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), bundle: true, platform: 'node', external, logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await session.evaluate("(async () => { const state = await window.electronAPI.getOnboardingState(); if (['pending', 'active'].includes(state.status)) await window.electronAPI.updateOnboardingState({ action: 'defer', expectedRevision: state.revision }); })()");
  await session.evaluate('document.querySelector(\'.app-nav-item[aria-label="助手"]\').click()');
  await waitFor(() => session.evaluate('Boolean([...document.querySelectorAll(\'textarea[aria-label="向 AI 助手输入问题"]\')].find(n => n.getBoundingClientRect().width && !n.disabled))'), 'assistant composer');
  await session.evaluate('[...document.querySelectorAll(\'textarea[aria-label="向 AI 助手输入问题"]\')].find(n => n.getBoundingClientRect().width).focus()');
  await session.send('Input.insertText', { text: '请整理澄川科技的项目会议纪要。' });
  await session.evaluate('[...document.querySelectorAll(\'button[aria-label="发送"]\')].find(n => n.getBoundingClientRect().width).click()');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.assistant-message-save-button:not(:disabled)'))"), 'completed answer save action');
  assert.equal(await session.evaluate("document.querySelector('.assistant-message-save-button').previousElementSibling.classList.contains('assistant-message-copy-button')"), true, 'save is next to copy');

  await openDraft();
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.assistant-note-draft-preview h1') && document.querySelector('.assistant-note-draft-preview table') && document.querySelector('.assistant-note-draft-preview .katex') && document.querySelector('.assistant-note-draft-preview .mermaid-preview svg'))"), 'Markdown headings, table, formula and Mermaid preview');
  assert.equal(await session.evaluate("document.querySelector('.assistant-note-draft-preview pre code').textContent.trim()"), 'const amount = 12800;');
  await screenshot('01-edit-markdown.png');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 760, deviceScaleFactor: 1, mobile: false });
  assert.equal(await session.evaluate("document.querySelector('.assistant-save-note-modal .mantine-Modal-content').scrollWidth <= window.innerWidth"), true, 'narrow modal avoids horizontal overflow');
  await screenshot('03-edit-narrow.png');
  await session.send('Emulation.clearDeviceMetricsOverride');
  await button('取消');
  assert.deepEqual((await fs.readdir(libraries[0])).filter(name => name.endsWith('.md')), ['原有笔记.md'], 'cancel creates no note');
  await openDraft();
  await session.evaluate("document.querySelector('.assistant-save-note-modal .cm-content').focus()");
  for (const type of ['rawKeyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await session.send('Input.insertText', { text: '\n补充：林晓负责复核。\n' });
  await waitFor(() => session.evaluate("document.querySelector('.assistant-note-draft-preview').textContent.includes('补充：林晓负责复核。')"), 'draft edits update preview');
  await button('保存');
  assert.equal(await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(n => n.textContent === '保存笔记').disabled"), true, 'must explicitly select a library');
  await chooseTarget();
  await screenshot('02-choose-library.png');
  await button('返回编辑');
  assert.equal(await session.evaluate("document.querySelector('.assistant-note-draft-preview').textContent.includes('补充：林晓负责复核。')"), true, 'back preserves draft');
  await button('保存'); await chooseTarget(); await button('保存笔记');
  await waitFor(() => session.evaluate("document.querySelector('.assistant-saved-note-receipt')?.textContent.includes('未命名[3]')"), 'save success receipt');
  const savedPath = path.join(libraries[1], '未命名[3].md');
  assert.equal(await fs.readFile(savedPath, 'utf8'), `${answer.trimEnd()}\n补充：林晓负责复核。\n`, 'save preserves the displayed answer Markdown and edits exactly');
  assert.equal(await session.evaluate('window.electronAPI.getLibraryPath()'), libraries[0], 'save does not change the active library');
  assert.equal(await fs.readFile(path.join(libraries[1], '未命名[2].md'), 'utf8'), '# 保留已有笔记\n');
  await openDraft();
  await click('.assistant-save-note-modal input');
  await session.send('Input.insertText', { text: '项目复核' });
  await button('保存'); await chooseTarget(); await button('保存笔记');
  await waitFor(() => session.evaluate("document.querySelector('.assistant-saved-note-receipt')?.textContent.includes('项目复核')"), 'explicit title saved');
  assert.equal(await fs.readFile(path.join(libraries[1], '项目复核.md'), 'utf8'), answer.trimEnd());

  await fs.unlink(savedPath);
  await session.dispose(); session = null;
  session = await launchNoteTest({ mainEntry, userData });
  const request = { libraryPath: libraries[1], content: answer, title: '' };
  const afterRestart = await session.evaluate(`window.electronAPI.createNoteFromAssistant(${JSON.stringify(request)})`);
  assert.equal(afterRestart.title, '未命名[4]', 'restart and deletion do not reuse numbers');
  const concurrent = await session.evaluate(`Promise.all([window.electronAPI.createNoteFromAssistant(${JSON.stringify(request)}), window.electronAPI.createNoteFromAssistant(${JSON.stringify(request)})])`);
  assert.deepEqual(concurrent.map(note => note.title), ['未命名[5]', '未命名[6]']);
  const named = { ...request, title: '项目复核' };
  const names = await session.evaluate(`Promise.all([window.electronAPI.createNoteFromAssistant(${JSON.stringify(named)}), window.electronAPI.createNoteFromAssistant(${JSON.stringify(named)})])`);
  assert.deepEqual(names.map(note => note.title), ['项目复核[1]', '项目复核[2]']);
  await assert.rejects(session.evaluate(`window.electronAPI.createNoteFromAssistant(${JSON.stringify({ ...request, libraryPath: temporary })})`), /尚未注册/);
  await assert.rejects(session.evaluate(`window.electronAPI.createNoteFromAssistant(${JSON.stringify({ ...request, title: '../越界' })})`), /非法字符/);
  const active = await session.evaluate(`window.electronAPI.createNoteFromAssistant(${JSON.stringify({ libraryPath: libraries[0], content: answer, title: '当前库保存验收' })})`);
  await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(n => n.textContent.includes('当前库保存验收'))"), 'active-library tree refresh');
  assert.equal(await fs.readFile(active.path, 'utf8'), answer);
  await openSavedNote();
  await assertEditorMath();
  assert.equal(await fs.readFile(active.path, 'utf8'), answer, 'Opening a note must not rewrite the Markdown.');
  await session.evaluate("document.querySelector('.tiptap').editor.chain().focus('end').insertContent('追加 Markdown 保存验收。').run()");
  await waitFor(async () => (await fs.readFile(active.path, 'utf8')).includes('追加 Markdown 保存验收。'), 'unrelated text autosave');
  const roundTrip = await fs.readFile(active.path, 'utf8');
  assert.ok(roundTrip.includes('$$ Q = \\frac{1}{2m} \\sum_{i,j} \\left[ A_{ij} - \\frac{k_i k_j}{2m} \\right] \\delta(c_i, c_j) $$'));
  assert.ok(roundTrip.includes('\\(x^2 + y^2 = z^2\\)'));
  assert.ok(roundTrip.includes('**局部移动（Local Moving）**'));
  await click('.tiptap .formula-inline .formula-preview');
  await waitFor(() => session.evaluate("document.querySelector('.tiptap .formula-inline').dataset.editing === 'true' && document.querySelector('.tiptap').editor.isFocused"), 'inline formula source edit');
  assert.equal(await session.evaluate("document.querySelector('.tiptap').editor.state.selection.$from.parent.type.name"), 'inlineFormula');
  await session.send('Input.insertText', { text: 'R_' });
  await waitFor(() => session.evaluate("document.querySelector('.tiptap .formula-inline .formula-source').textContent === 'R_Q'"), 'inline formula source typing');
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await waitFor(() => session.evaluate("document.querySelector('.tiptap .formula-inline .formula-source').textContent === 'RQ'"), 'inline formula source deletion');
  await session.send('Input.insertText', { text: '_' });
  await click('.tiptap h1');
  await waitFor(async () => (await fs.readFile(active.path, 'utf8')).includes('$R_Q$'), 'edited inline TeX autosave');
  assert.equal(await session.evaluate("document.querySelector('.tiptap .formula-inline').dataset.editing"), 'false');
  await click('.tiptap .formula-block .formula-preview');
  await waitFor(() => session.evaluate("document.querySelector('.tiptap .formula-block').dataset.editing === 'true'"), 'display formula source edit');
  await session.send('Input.insertText', { text: 'z + ' });
  await click('.tiptap h1');
  await waitFor(async () => (await fs.readFile(active.path, 'utf8')).includes('$$\nz + a^2+b^2=c^2\n$$'), 'edited display TeX autosave');
  await session.evaluate("[...document.querySelectorAll('.tiptap h1')].at(-1).scrollIntoView({ block: 'start' })");
  await session.send('Page.bringToFront');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await screenshot('04-saved-note-math.png');
  await session.send('Emulation.clearDeviceMetricsOverride');
  await editorMode('预览');
  await waitFor(() => session.evaluate("document.querySelectorAll('.preview-content .katex').length === 14"), 'saved note formula preview');
  assert.equal(await session.evaluate("document.querySelectorAll('.preview-content .katex-error').length"), 0);
  assert.equal(await session.evaluate("document.querySelectorAll('.preview-content strong').length"), 6);
  await editorMode('编辑');
  await assertEditorMath();
  const beforeReopen = await fs.readFile(active.path, 'utf8');
  await session.dispose(); session = null;
  session = await launchNoteTest({ mainEntry, userData });
  await openSavedNote();
  await assertEditorMath();
  assert.equal(await session.evaluate("document.querySelector('.tiptap .formula-inline .formula-source').textContent"), 'R_Q');
  assert.equal(await session.evaluate("document.querySelector('.tiptap .formula-block .formula-source').textContent"), 'z + a^2+b^2=c^2');
  assert.equal(await fs.readFile(active.path, 'utf8'), beforeReopen, 'Restarting must keep formula edits and formatting intact.');
  console.log(`Electron assistant note verified: copy-adjacent action, Mantine draft/selection dialogs, Markdown preview, draft editing/cancel/back, explicit second-library choice, exact file content, persistent numbering, concurrent saves, collision/authorization guards and active-library refresh. Screenshots: ${screenshots}`);
} catch (error) {
  console.error(session?.diagnostics());
  console.error(await session?.evaluate("({ text: document.body.innerText.slice(-1800), active: document.activeElement?.outerHTML.slice(0, 200) })").catch(() => undefined));
  throw error;
} finally {
  await session?.dispose();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function click(selector) {
  const point = await session.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || n.disabled) throw new Error('Missing enabled control'); n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function openDraft() { await click('.assistant-message-save-button'); await waitFor(() => session.evaluate("Boolean(document.querySelector('.assistant-note-draft-preview'))"), 'draft modal'); }
async function button(label) {
  const selector = await session.evaluate(`(() => { const n = [...document.querySelectorAll('[role=dialog] button')].find(n => n.textContent === ${JSON.stringify(label)}); if (!n) throw new Error('Missing dialog action'); n.dataset.noteTestAction = 'target'; return '[data-note-test-action=target]'; })()`);
  await click(selector);
  await session.evaluate("document.querySelector('[data-note-test-action=target]')?.removeAttribute('data-note-test-action')");
}
async function chooseTarget() {
  await waitFor(() => session.evaluate("Boolean(document.querySelector('input[placeholder=\"选择笔记库\"]') && !document.querySelector('input[placeholder=\"选择笔记库\"]').disabled)"), 'library choices loaded');
  await click('input[placeholder="选择笔记库"]');
  await waitFor(() => session.evaluate("[...document.querySelectorAll('[role=option]')].some(n => n.textContent === '项目笔记库')"), 'target option');
  const selector = await session.evaluate("'#' + CSS.escape([...document.querySelectorAll('[role=option]')].find(n => n.textContent === '项目笔记库').id)");
  await click(selector);
}
async function screenshot(name) {
  const result = await session.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(screenshots, name), Buffer.from(result.data, 'base64'));
}

async function openSavedNote() {
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('.file-tree-row')].find(n => n.textContent.includes('当前库保存验收')))"), 'saved note tree');
  await session.evaluate("[...document.querySelectorAll('.file-tree-row')].find(n => n.textContent.includes('当前库保存验收')).click()");
  await waitFor(() => session.evaluate("document.querySelector('.tiptap')?.editor?.getText().includes('Leiden') && document.querySelector('.note-save-notice')?.dataset.status === 'clean'"), 'saved note editor');
}

async function assertEditorMath() {
  await waitFor(() => session.evaluate("document.querySelectorAll('.tiptap .formula-preview .katex').length === 14"), 'all saved formulas rendered in the editor');
  assert.equal(await session.evaluate("document.querySelectorAll('.tiptap .katex-error').length"), 0);
  assert.equal(await session.evaluate("[...document.querySelectorAll('.tiptap strong')].some(n => n.textContent.includes('Modularity'))"), true);
  assert.equal(await session.evaluate("document.querySelectorAll('.tiptap .formula-node[data-editing=false] > .formula-source').length"), 14);
}

async function editorMode(label) {
  await session.evaluate(`(() => { const button = [...document.querySelectorAll('.editor-mode-bar button')].find(n => n.textContent === ${JSON.stringify(label)}); if (!button) throw new Error('Missing editor mode'); button.click(); })()`);
}
