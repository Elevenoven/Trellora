import { installFixtureNoteSave } from './cdp-note-save.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { releasePaths } from './release-paths.mjs';

const rootDir = process.cwd();
const defaultAppDirectory = releasePaths(rootDir).unpacked;
const requestedExecutable = process.argv[2];
const executableName = requestedExecutable
  ? path.basename(requestedExecutable)
  : readdirSync(defaultAppDirectory).find((name) => name.toLowerCase().endsWith('.exe'));
assert.ok(executableName, 'Packaged executable was not found. Build the package first.');

const testRoot = path.join(rootDir, '.package-staging', 'verify-packaged-workspace');
const workspaceDir = path.join(testRoot, 'workspace');
const userDataDir = path.join(testRoot, 'user-data');
const executablePath = requestedExecutable ? path.resolve(requestedExecutable) : path.join(defaultAppDirectory, executableName);
const appDirectory = path.dirname(executablePath);
assert.equal(existsSync(executablePath), true, `Packaged executable does not exist: ${executablePath}`);

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
mkdirSync(path.join(workspaceDir, 'Projects', 'Sub'), { recursive: true });
writeFileSync(path.join(workspaceDir, 'Existing.md'), '# Existing\n\nExisting content with [[Malformed]].\n\n## Section A\n\n### Detail A\n\n## Section B', 'utf8');
writeFileSync(path.join(workspaceDir, 'Malformed.md'), '---\ntitle: [broken\n---\n\n# Resilient', 'utf8');
writeFileSync(path.join(workspaceDir, 'Projects', 'Sub', 'Deep.md'), '# Deep\n\nNested content.', 'utf8');
writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ libraryPath: workspaceDir, workspacePath: path.join(testRoot, 'system-workspace') }), 'utf8');

const ollamaServer = createServer(async (request, response) => {
  if (request.url === '/api/tags') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'test-embedding' }, { name: 'test-generation' }] }));
    return;
  }
  if (request.url === '/api/generate' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const prompt = String(payload.prompt ?? '');
    const generated = prompt.includes('Trellora的知识分析助手')
      ? { summary: '本地优先知识管理摘要。'.repeat(40), keyPoints: Array.from({ length: 8 }, (_, index) => `关键观点 ${index + 1}：保持本地数据安全并提供稳定的知识发现体验。`), tagCandidates: [{ name: '本地优先', confidence: 'high', evidence: '笔记内容明确说明本地优先。' }, { name: '知识管理', confidence: 'medium', evidence: '笔记标题和正文均讨论知识管理。' }] }
      : { summary: '本地优先知识管理摘要。'.repeat(40), keyPoints: Array.from({ length: 8 }, (_, index) => `关键观点 ${index + 1}：保持本地数据安全并提供稳定的知识发现体验。`), suggestedTags: ['本地优先', '知识管理'] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ response: JSON.stringify(generated) }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
ollamaServer.unref();
const ollamaAddress = ollamaServer.address();
assert.ok(ollamaAddress && typeof ollamaAddress === 'object');
const ollamaEndpoint = `http://127.0.0.1:${ollamaAddress.port}`;

let resizedPanelWidth = 0;
let resizedSidebarWidth = 0;
  const firstRun = await launchAndConnect(9333);
  try {
    const initialFiles = await firstRun.evaluate('window.electronAPI.listFiles()');
    assert.deepEqual(flattenNames(initialFiles).sort(), ['Deep.md', 'Existing.md', 'Malformed.md']);
    await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"笔记\"]'))"));
    await firstRun.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
    const projectsPath = path.join(workspaceDir, 'Projects');
  const subPath = path.join(projectsPath, 'Sub');
  const initialUiState = await firstRun.evaluate('window.electronAPI.getLibraryUiState()');
  assert.deepEqual(new Set(initialUiState.collapsedFolderPaths), new Set([projectsPath, subPath]));
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.knowledge-panel'))"));
  const emptyKnowledgeText = await firstRun.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  assert.match(emptyKnowledgeText, /笔记信息/);
  assert.match(emptyKnowledgeText, /AI 助手/);
  assert.match(emptyKnowledgeText, /知识库概览/);
  assert.match(emptyKnowledgeText, /近期索引状态/);
  assert.equal(await firstRun.evaluate(`[...document.querySelectorAll('.knowledge-tabs button')].find((node) => node.textContent?.includes('AI 助手'))?.disabled`), false);
  await firstRun.evaluate(`(() => {
    const separator = document.querySelector('.sidebar-resizer');
    separator?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: separator.getBoundingClientRect().right }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: separator.getBoundingClientRect().right + 120 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
  })()`);
  await waitForCondition(async () => (await firstRun.evaluate('window.electronAPI.getAppPreferences()')).leftSidebarWidth >= 340);
  resizedSidebarWidth = (await firstRun.evaluate('window.electronAPI.getAppPreferences()')).leftSidebarWidth;
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"设置\"]'))"));
  await firstRun.evaluate("document.querySelector('.app-nav-item[aria-label=\"设置\"]')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.settings-panel'))"));
  const settingsNavText = await firstRun.evaluate("document.querySelector('.settings-nav')?.innerText ?? ''");
  for (const label of ['通用', '笔记库与备份', '编辑器', 'AI 与搜索', '关于与诊断']) assert.match(settingsNavText, new RegExp(label));
  await firstRun.evaluate(`(() => {
    const setSelect = (title, value) => {
      const field = [...document.querySelectorAll('.settings-field')].find((node) => node.querySelector('strong')?.textContent === title);
      const select = field?.querySelector('select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, value);
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSelect('主题', 'dark');
    setSelect('界面密度', 'compact');
    setSelect('启动行为', 'last-note');
    [...document.querySelectorAll('.settings-save-bar button')].find((node) => node.textContent?.includes('保存更改'))?.click();
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.density === 'compact'"));
  await firstRun.evaluate(`(() => {
    const field = [...document.querySelectorAll('.settings-field')].find((node) => node.querySelector('strong')?.textContent === '主题');
    const select = field?.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'light');
    select?.dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('.settings-save-bar button')].find((node) => node.textContent?.includes('保存更改'))?.click();
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("document.documentElement.dataset.theme === 'light'"));
  assert.equal(await firstRun.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()"), '#ffffff');
  await firstRun.evaluate(`(() => {
    const field = [...document.querySelectorAll('.settings-field')].find((node) => node.querySelector('strong')?.textContent === '主题');
    const select = field?.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'dark');
    select?.dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('.settings-save-bar button')].find((node) => node.textContent?.includes('保存更改'))?.click();
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("document.documentElement.dataset.theme === 'dark'"));
  await firstRun.evaluate(`[...document.querySelectorAll('.settings-nav button')].find((node) => node.textContent?.includes('AI 与搜索'))?.click()`);
  const aiSettingsText = await firstRun.evaluate("document.querySelector('.settings-content')?.innerText ?? ''");
  assert.match(aiSettingsText, /笔记内容不会离开此设备/);
  assert.doesNotMatch(aiSettingsText, /重建语义索引|语义索引|Qdrant|Score/i);
  assert.equal(await firstRun.evaluate("Boolean(document.querySelector('.settings-content input[type=password]'))"), false);
  await firstRun.evaluate('window.resizeTo(620, 760)');
  await waitForCondition(async () => await firstRun.evaluate('window.innerWidth <= 680'));
  assert.equal(await firstRun.evaluate(`(() => {
    const panel = document.querySelector('.settings-panel');
    if (!panel) return false;
    return Math.abs(panel.getBoundingClientRect().width - window.innerWidth) < 2;
  })()`), true);
  await firstRun.evaluate('window.resizeTo(1200, 800)');
  await firstRun.evaluate(`document.querySelector('[aria-label="关闭设置"]')?.click()`);

  const longTitle = '这是一个用于验证窄窗口布局与超长中文标题路径不会遮挡关键操作的笔记标题'.repeat(2);
  const longPath = await firstRun.evaluate(`window.electronAPI.createFile(${JSON.stringify(longTitle)}, null)`);
  await waitForCondition(async () => await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].some((node) => node.textContent?.includes(${JSON.stringify(longTitle.slice(0, 18))}))`));
  await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes(${JSON.stringify(longTitle.slice(0, 18))}))?.click()`);
  await waitForCondition(async () => await firstRun.evaluate(`document.querySelector('.knowledge-note-title')?.textContent?.includes(${JSON.stringify(longTitle.slice(0, 18))})`));
  assert.equal(await firstRun.evaluate(`(() => {
    const panel = document.querySelector('.knowledge-panel');
    const title = document.querySelector('.knowledge-note-title');
    const notePath = document.querySelector('.knowledge-note-path');
    const collapseButton = document.querySelector('.knowledge-panel-header .knowledge-icon-button');
    if (!panel || !title || !notePath || !collapseButton) return false;
    const panelRect = panel.getBoundingClientRect();
    return title.getBoundingClientRect().right <= panelRect.right + 1
      && notePath.getBoundingClientRect().right <= panelRect.right + 1
      && collapseButton.getBoundingClientRect().right <= panelRect.right + 1;
  })()`), true);
  await firstRun.evaluate(`window.electronAPI.deleteEntry(${JSON.stringify(longPath)})`);
  await waitForCondition(async () => !(await firstRun.evaluate('window.electronAPI.listFiles()')).some((node) => node.path === longPath));
  await firstRun.evaluate('window.dispatchEvent(new Event("focus"))');
  await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Existing'))?.click()`);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelector('.knowledge-note-title')?.textContent?.includes('Existing')"));

  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:nth-child(2)')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 4"));
  const outlineOffsets = await firstRun.evaluate("[...document.querySelectorAll('.outline-row')].map((node) => node.querySelector('.outline-link')?.getBoundingClientRect().left ?? 0)");
  assert.ok(outlineOffsets[1] > outlineOffsets[0]);
  assert.ok(outlineOffsets[2] > outlineOffsets[1]);
  assert.equal(outlineOffsets[3], outlineOffsets[1]);
  assert.equal(await firstRun.evaluate("document.querySelector('.outline-row')?.getAttribute('aria-expanded')"), 'true');
  await firstRun.evaluate("document.querySelector('.outline-row .outline-toggle')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 1"));
  assert.equal(await firstRun.evaluate("document.querySelector('.outline-row')?.getAttribute('aria-expanded')"), 'false');
  await firstRun.evaluate("document.querySelector('.outline-row .outline-toggle')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 4"));
  await firstRun.evaluate(`(() => {
    const row = [...document.querySelectorAll('.outline-row')].find((node) => node.querySelector('.outline-link')?.textContent?.trim() === 'Section A');
    row?.querySelector('.outline-toggle')?.click();
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 3"));
  assert.equal(await firstRun.evaluate(`[...document.querySelectorAll('.outline-link')].some((node) => node.textContent?.trim() === 'Detail A')`), false);
  assert.equal(await firstRun.evaluate(`[...document.querySelectorAll('.outline-link')].some((node) => node.textContent?.trim() === 'Section B')`), true);

  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:first-child')?.click()");
  await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Malformed'))?.click()`);
  const malformedPath = path.join(workspaceDir, 'Malformed.md');
  await waitForCondition(async () => await firstRun.evaluate(`document.querySelector('.editor-container')?.getAttribute('data-current-path') === ${JSON.stringify(malformedPath)}`));
  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:nth-child(2)')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 2"));
  assert.equal(await firstRun.evaluate("document.querySelectorAll('.outline-toggle').length"), 0);
  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:first-child')?.click()");
  await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Existing'))?.click()`);
  await waitForCondition(async () => await firstRun.evaluate(`document.querySelector('.editor-container')?.getAttribute('data-current-path') === ${JSON.stringify(path.join(workspaceDir, 'Existing.md'))}`));
  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:nth-child(2)')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 3"));
  await firstRun.evaluate(`(() => {
    const row = [...document.querySelectorAll('.outline-row')].find((node) => node.querySelector('.outline-link')?.textContent?.trim() === 'Section A');
    row?.querySelector('.outline-toggle')?.click();
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 4"));
  await firstRun.evaluate("document.querySelector('[aria-label=\"全部收起目录\"]')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 1"));
  await firstRun.evaluate("document.querySelector('[aria-label=\"全部展开目录\"]')?.click()");
  await waitForCondition(async () => await firstRun.evaluate("document.querySelectorAll('.outline-row').length === 4"));
  await firstRun.evaluate(`[...document.querySelectorAll('.outline-link')].find((node) => node.textContent?.trim() === 'Section B')?.click()`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(CSS.highlights?.has('menghan-search-target') || document.querySelector('.search-target-flash'))"));
  await firstRun.evaluate("document.querySelector('.sidebar-tabs button:first-child')?.click()");

  await firstRun.evaluate(`window.electronAPI.saveAiProviderConfig(${JSON.stringify({ kind: 'openai-compatible', endpoint: `${ollamaEndpoint}/v1`, model: 'remote-test', apiKey: 'secret-not-echoed', remoteContentConsent: true })})`);
  const safeRemoteConfig = await firstRun.evaluate('window.electronAPI.getAiProviderConfig()');
  assert.equal('apiKey' in safeRemoteConfig, false);
  assert.equal(safeRemoteConfig.hasApiKey, true);
  await firstRun.evaluate(`window.electronAPI.saveAiProviderConfig(${JSON.stringify({ kind: 'ollama', endpoint: ollamaEndpoint, model: 'test-generation' })})`);
  await waitForCondition(async () => await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].some((node) => node.textContent?.includes('Projects'))`));
  assert.equal(await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Projects'))?.getAttribute('aria-expanded')`), 'false');
  await firstRun.evaluate(`(() => {
    const row = [...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Projects'));
    row?.focus();
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await waitForCondition(async () => await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Projects'))?.getAttribute('aria-expanded') === 'true'`));
  await firstRun.evaluate(`document.querySelector('[title="目录树选项"]')?.click()`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.tree-menu'))"));
  const treeMenuText = await firstRun.evaluate("document.querySelector('.tree-menu')?.innerText ?? ''");
  assert.match(treeMenuText, /全部展开/);
  assert.match(treeMenuText, /全部收起/);
  assert.match(treeMenuText, /仅展开当前笔记路径/);
  await firstRun.evaluate(`[...document.querySelectorAll('.tree-menu button')].find((node) => node.textContent?.includes('全部收起'))?.click()`);
  await waitForCondition(async () => await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Projects'))?.getAttribute('aria-expanded') === 'false'`));
  await firstRun.evaluate(`window.electronAPI.saveLibraryUiState({ collapsedFolderPaths: ${JSON.stringify([projectsPath, subPath])} })`);
  const renamedProjectsPath = await firstRun.evaluate(`window.electronAPI.renameEntry(${JSON.stringify(projectsPath)}, 'Work')`);
  assert.equal(renamedProjectsPath, path.join(workspaceDir, 'Work'));
  assert.deepEqual(new Set((await firstRun.evaluate('window.electronAPI.getLibraryUiState()')).collapsedFolderPaths), new Set([renamedProjectsPath, path.join(renamedProjectsPath, 'Sub')]));
  const existingPath = path.join(workspaceDir, 'Existing.md');
  assert.equal(await firstRun.evaluate('typeof window.electronAPI.getRelatedNotes'), 'undefined');
  assert.deepEqual(await firstRun.evaluate('window.electronAPI.getFavoriteNotes()'), []);
  assert.deepEqual(await firstRun.evaluate(`window.electronAPI.setFavoriteNote(${JSON.stringify(existingPath)}, true)`), [existingPath]);
  const renamedExistingPath = await firstRun.evaluate(`window.electronAPI.renameEntry(${JSON.stringify(existingPath)}, 'Renamed Existing')`);
  assert.equal(path.basename(renamedExistingPath), 'Renamed Existing.md');
  assert.deepEqual(await firstRun.evaluate('window.electronAPI.getFavoriteNotes()'), [renamedExistingPath]);

  const fallbackSearch = await firstRun.evaluate(`(async () => {
    const startedAt = performance.now();
    const outcome = await window.electronAPI.searchNotesUnified('Existing');
    return { elapsed: performance.now() - startedAt, outcome };
  })()`);
  assert.ok(fallbackSearch.elapsed < 1000, `Keyword fallback took ${fallbackSearch.elapsed}ms`);
  assert.equal(fallbackSearch.outcome.results[0].path, renamedExistingPath);
  assert.equal(fallbackSearch.outcome.mode, 'keyword');
  assert.equal(fallbackSearch.outcome.used, '关键词搜索');

  await firstRun.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.search-dialog'))"));
  await firstRun.evaluate(`(() => {
    const input = document.querySelector('.search-header input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'Existing');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.search-result'))"));
  await firstRun.evaluate(`(() => {
    const input = document.querySelector('.search-header input');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  })()`);
  const searchDialogText = await firstRun.evaluate("document.querySelector('.search-dialog')?.innerText ?? ''");
  assert.match(searchDialogText, /关键词搜索可用/);
  assert.match(searchDialogText, /关键词匹配/);
  assert.doesNotMatch(searchDialogText, /Qdrant|Score|Semantic|Search notes|Build index|Close|综合搜索|语义搜索/i);
  await firstRun.evaluate("document.querySelector('.search-header input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await waitForCondition(async () => !(await firstRun.evaluate("Boolean(document.querySelector('.search-dialog'))")));

  await firstRun.evaluate('globalThis.__menghanLibraryChanges = []; globalThis.__menghanUnsubscribe = window.electronAPI.onLibraryChanged((payload) => globalThis.__menghanLibraryChanges.push(payload))');
  const externalPath = path.join(workspaceDir, 'External.md');
  writeFileSync(externalPath, '# External\n\nCreated outside the app.', 'utf8');
  await waitForCondition(async () => (await firstRun.evaluate('globalThis.__menghanLibraryChanges.length')) > 0);
  const watcherPayload = await firstRun.evaluate('globalThis.__menghanLibraryChanges.at(-1)');
  assert.equal(flattenNames(watcherPayload.files).includes('External.md'), true);
  assert.equal(watcherPayload.changes.some((change) => change.kind === 'add' && change.path === externalPath), true);
  await firstRun.evaluate(`window.electronAPI.saveLibraryUiState({ collapsedFolderPaths: ${JSON.stringify([renamedProjectsPath, path.join(renamedProjectsPath, 'Sub')])} })`);

  const createdPath = await firstRun.evaluate("window.electronAPI.createFile('Packaged Flow', null)");
  assert.equal(path.basename(createdPath), 'Packaged Flow.md');
  assert.match(await firstRun.evaluate(`window.electronAPI.readFile(${JSON.stringify(createdPath)})`), /Start writing here/);
  const blankLineFixture = '# Packaged Flow\n\nStart writing here\n\n\nPreserve this gap.\n';
  assert.equal(await firstRun.evaluate(`globalThis.__saveNoteFixture(${JSON.stringify(createdPath)}, ${JSON.stringify(blankLineFixture)})`), true);

  await waitForCondition(async () => await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].some((node) => node.textContent?.includes('Packaged Flow'))`));
  await firstRun.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('Packaged Flow'))?.click()`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.ProseMirror'))"));
  const insertAtEditorEnd = async (text) => firstRun.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand('insertText', false, ${JSON.stringify(text)});
  })()`);
  assert.equal(await insertAtEditorEnd('X'), true);
  assert.equal(await insertAtEditorEnd('A'), true);
  assert.equal(await insertAtEditorEnd('B'), true);
  await firstRun.evaluate(`document.querySelector('.ProseMirror')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelector('.ProseMirror')?.textContent?.endsWith('XA')"));
  const blankLineAfterUndo = '# Packaged Flow\n\nStart writing here\n\n\nPreserve this gap.XA\n';
  await waitForCondition(async () => (await firstRun.evaluate(`window.electronAPI.readFile(${JSON.stringify(createdPath)})`)) === blankLineAfterUndo);
  assert.equal(readFileSync(createdPath, 'utf8'), blankLineAfterUndo);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelector('.knowledge-note-title')?.textContent?.includes('Packaged Flow')"));
  const noteInfoText = await firstRun.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  for (const label of ['概览', '智能建议']) assert.match(noteInfoText, new RegExp(label));
  assert.doesNotMatch(noteInfoText, /属性/);
  assert.doesNotMatch(noteInfoText, /连接|引用|被引用|相关|关联地图/);
  await firstRun.evaluate(`[...document.querySelectorAll('.knowledge-tabs button')].find((node) => node.textContent?.includes('AI 助手'))?.click()`);
  const aiPanelText = await firstRun.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  for (const label of ['知识问答', '制定学习路径', '整理建议']) assert.match(aiPanelText, new RegExp(label));
  assert.doesNotMatch(aiPanelText, /生成摘要与标签建议|提取实体与关系/);
  assert.match(aiPanelText, /不会自动修改 Markdown/);
  assert.equal(await firstRun.evaluate(`(() => {
    const scroll = document.querySelector('.knowledge-panel-scroll');
    const header = document.querySelector('.knowledge-panel-header');
    if (!scroll || !header) return false;
    scroll.scrollTop = scroll.scrollHeight;
    const panelTop = document.querySelector('.knowledge-panel')?.getBoundingClientRect().top ?? 0;
    return Math.abs(header.getBoundingClientRect().top - panelTop) < 2
      && [...document.querySelectorAll('.knowledge-tabs button')].some((node) => node.textContent?.includes('AI 助手'));
  })()`), true);
  await firstRun.evaluate(`(() => {
    const separator = document.querySelector('.knowledge-panel-resizer');
    separator?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: separator.getBoundingClientRect().left }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: separator.getBoundingClientRect().left - 150 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
  })()`);
  await waitForCondition(async () => (await firstRun.evaluate('window.electronAPI.getAppPreferences()')).rightPanelWidth >= 400);
  resizedPanelWidth = (await firstRun.evaluate('window.electronAPI.getAppPreferences()')).rightPanelWidth;
  await firstRun.evaluate('window.resizeTo(620, 760)');
  await waitForCondition(async () => await firstRun.evaluate('window.innerWidth <= 620'));
  await waitForCondition(async () => await firstRun.evaluate(`(() => {
    const sidebarWidth = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? Infinity;
    const panelWidth = document.querySelector('.knowledge-panel')?.getBoundingClientRect().width ?? Infinity;
    return sidebarWidth <= 210 && panelWidth <= window.innerWidth * 0.43;
  })()`));
  assert.equal(await firstRun.evaluate(`(() => {
    const panel = document.querySelector('.knowledge-panel');
    const editor = document.querySelector('.editor-pane');
    if (!panel || !editor) return false;
    return panel.getBoundingClientRect().width <= window.innerWidth * 0.43
      && editor.getBoundingClientRect().width > 120;
  })()`), true);
  await firstRun.evaluate('window.resizeTo(1200, 800)');
  await waitForCondition(async () => await firstRun.evaluate(`Math.abs((document.querySelector('.knowledge-panel')?.getBoundingClientRect().width ?? 0) - ${resizedPanelWidth}) < 2`));
  await firstRun.evaluate(`[...document.querySelectorAll('.knowledge-tabs button')].find((node) => node.textContent?.includes('笔记信息'))?.click()`);
  await firstRun.evaluate(`[...document.querySelectorAll('.knowledge-section')].find((node) => node.querySelector('h4')?.textContent?.includes('概览'))?.querySelector('button')?.click()`);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.note-overview-toggle'))"));
  assert.match(await firstRun.evaluate("document.querySelector('.note-overview-toggle')?.textContent ?? ''"), /8 个关键要点.*展开/);
  await firstRun.evaluate("document.querySelector('.note-overview-toggle')?.click()");
  assert.match(await firstRun.evaluate("document.querySelector('.note-overview-toggle')?.textContent ?? ''"), /8 个关键要点.*收起/);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.note-tag-suggestion'))"));
  assert.match(await firstRun.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''"), /笔记内容明确说明本地优先/);
  const analysisBeforeEdit = await firstRun.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(createdPath)})`);
  assert.equal(analysisBeforeEdit?.isStale, undefined);
  assert.equal(await firstRun.evaluate(`globalThis.__saveNoteFixture(${JSON.stringify(createdPath)}, '# Packaged Flow\\n\\nStart writing here\\n\\nContent changed after analysis.')`), true);
  const analysisAfterEdit = await firstRun.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(createdPath)})`);
  assert.equal(analysisAfterEdit?.isStale, true);
  await waitForCondition(async () => await firstRun.evaluate("document.querySelector('.knowledge-panel')?.innerText.includes('笔记内容已更新')"));
  await waitForCondition(async () => await firstRun.evaluate("document.querySelector('.ProseMirror')?.textContent?.includes('Content changed after analysis.')"));
  await firstRun.evaluate(`[...document.querySelectorAll('.knowledge-tabs button')].find((node) => node.textContent?.includes('笔记信息'))?.click()`);
  assert.equal(await firstRun.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand('insertText', false, '/h2');
  })()`), true);
  await waitForCondition(async () => await firstRun.evaluate("Boolean(document.querySelector('.slash-command-menu'))"));
  assert.equal(await firstRun.evaluate("document.querySelector('.slash-command-item strong')?.textContent"), '二级标题');
  await firstRun.evaluate("document.querySelector('.slash-command-item')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))");
  await waitForCondition(async () => (await firstRun.evaluate(`window.electronAPI.readFile(${JSON.stringify(createdPath)})`)).includes('## Content changed after extraction.'));

  const savedText = '# Packaged Flow\n\nSaved through packaged IPC.';
  assert.equal(await firstRun.evaluate(`globalThis.__saveNoteFixture(${JSON.stringify(createdPath)}, ${JSON.stringify(savedText)})`), true);
  assert.equal(readFileSync(createdPath, 'utf8'), savedText);
  assert.deepEqual(flattenNames(await firstRun.evaluate('window.electronAPI.listFiles()')).sort(), ['Deep.md', 'External.md', 'Malformed.md', 'Packaged Flow.md', 'Renamed Existing.md']);

  const renamedFlowPath = await firstRun.evaluate(`window.electronAPI.renameEntry(${JSON.stringify(createdPath)}, 'Renamed Flow')`);
  await firstRun.evaluate(`window.electronAPI.saveAppPreferences({ lastOpenedNote: ${JSON.stringify(path.join(workspaceDir, 'Renamed Flow.md'))} })`);
  const savedKeywordOutcome = await firstRun.evaluate(`window.electronAPI.searchNotesUnified('Saved through packaged IPC')`);
  assert.equal(savedKeywordOutcome.results[0].path, renamedFlowPath);
  assert.equal(await firstRun.evaluate('typeof window.electronAPI.rebuildSemanticIndex'), 'undefined');
  console.log('Packaged first-run flow passed');
} finally {
  await firstRun.close();
}

const secondRun = await launchAndConnect(9334);
try {
  const reloadedFiles = await secondRun.evaluate('window.electronAPI.listFiles()');
  assert.deepEqual(flattenNames(reloadedFiles).sort(), ['Deep.md', 'External.md', 'Malformed.md', 'Renamed Existing.md', 'Renamed Flow.md']);
  assert.deepEqual(await secondRun.evaluate('window.electronAPI.getFavoriteNotes()'), [path.join(workspaceDir, 'Renamed Existing.md')]);
  const persistedPath = path.join(workspaceDir, 'Renamed Flow.md');
  assert.match(await secondRun.evaluate(`window.electronAPI.readFile(${JSON.stringify(persistedPath)})`), /Saved through packaged IPC/);
  assert.deepEqual(new Set((await secondRun.evaluate('window.electronAPI.getLibraryUiState()')).collapsedFolderPaths), new Set([path.join(workspaceDir, 'Work'), path.join(workspaceDir, 'Work', 'Sub')]));
  const persistedPreferences = await secondRun.evaluate('window.electronAPI.getAppPreferences()');
  assert.equal(persistedPreferences.theme, 'dark');
  assert.equal(persistedPreferences.density, 'compact');
  assert.equal(persistedPreferences.startupBehavior, 'last-note');
  assert.equal(persistedPreferences.rightPanelWidth, resizedPanelWidth);
  assert.equal(persistedPreferences.leftSidebarWidth, resizedSidebarWidth);
  assert.equal(await secondRun.evaluate("document.documentElement.dataset.theme"), 'dark');
  await waitForCondition(async () => await secondRun.evaluate("document.querySelector('.knowledge-note-path')?.textContent?.includes('Renamed Flow.md')"));
  console.log('Packaged restart-recovery flow passed');
} finally {
  await secondRun.close();
}

ollamaServer.close();
for (const markdownPath of collectMarkdownFiles(workspaceDir)) {
  const markdown = readFileSync(markdownPath, 'utf8');
  assert.doesNotMatch(markdown, /collapsedFolderPaths|knowledgeMap\s*:/, `System state leaked into ${markdownPath}`);
}
console.log('Packaged workspace verification passed: UI state, keyword search, load, external indexing, create, save, and restart recovery');

function flattenNames(nodes) {
  return nodes.flatMap((node) => node.isDirectory ? flattenNames(node.children ?? []) : [node.name]);
}

function collectMarkdownFiles(directoryPath) {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.menghan-meta' || entry.name === '.menghan-backups') return [];
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [entryPath] : [];
  });
}

async function launchAndConnect(port) {
  const child = spawn(executablePath, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
  ], {
    cwd: appDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const page = await waitForPage(port, child);
    const connection = await connectToCdp(page.webSocketDebuggerUrl);
    await waitForCondition(async () => {
      try {
        return await connection.evaluate("typeof window.electronAPI?.listFiles === 'function'");
      } catch {
        return false;
      }
    });
    await installFixtureNoteSave(connection);
    return {
      evaluate: connection.evaluate,
      close: async () => {
        connection.close();
        await terminateProcessTree(child.pid);
        await waitForExit(child, 8000);
      },
    };
  } catch (error) {
    await terminateProcessTree(child.pid);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
}

async function waitForPage(port, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === 'page' && entry.url?.startsWith('file:'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the packaged app renderer.');
}

async function waitForCondition(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for a packaged renderer condition.');
}

async function connectToCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed.'));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return {
    evaluate: async (expression) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const response = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (response.exceptionDetails) {
            throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
          }
          return response.result.value;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Execution context was destroyed|Cannot find context/i.test(message) || attempt === 19) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error('Renderer evaluation did not become available.');
    },
    close: () => {
      socket.close();
    },
  };
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null) child.kill();
}

async function terminateProcessTree(processId) {
  if (!processId) return;
  if (process.platform !== 'win32') {
    try { process.kill(processId, 'SIGTERM'); } catch { /* Process already exited. */ }
    return;
  }
  await new Promise((resolve) => {
    const taskkill = spawn('taskkill', ['/PID', String(processId), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.once('exit', resolve);
    taskkill.once('error', resolve);
  });
}
