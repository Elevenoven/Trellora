import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'language-'));
const library = path.join(temporary, 'library');
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron', 'main.js');
const notePath = path.join(library, '设置.md');
const original = '# 设置\n\n中文笔记正文 English content。\n\n保存、语言、笔记等文字属于用户内容。\n';
const screenshots = path.resolve('output/verification/language');
let session;

try {
  for (const directory of [library, userData, path.dirname(mainEntry), screenshots]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(notePath, original);
  await fs.writeFile(path.join(library, '空白.md'), '');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath: library, activeLibraryPath: library,
    libraries: [{ path: library, alias: '中文笔记库', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }],
    workspacePath: path.join(temporary, 'workspace'),
    appPreferences: { language: 'zh-CN', defaultEditorMode: 'wysiwyg' },
  }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), logLevel: 'silent', plugins: entry === 'preload' ? [{ name: 'language-save-failure', setup(bundler) {
      // 只在临时测试 preload 中注入一次失败，验证生产 React 的完整回滚链路。
      bundler.onLoad({ filter: /electron[\\/]preload\.ts$/ }, async args => {
        const source = await fs.readFile(args.path, 'utf8');
        const method = "saveAppPreferences: (patch: unknown) => ipcRenderer.invoke('save-app-preferences', patch),";
        assert.ok(source.includes(method), 'preference IPC test seam');
        return { loader: 'ts', contents: 'let failNextLanguageSave = false;\n' + source.replace(method, "saveAppPreferences: (patch: unknown) => { if (failNextLanguageSave) { failNextLanguageSave = false; return Promise.reject(new Error('Test save failure')); } return ipcRenderer.invoke('save-app-preferences', patch); },") + "\ncontextBridge.exposeInMainWorld('languageTest', { failNextSave: () => { failNextLanguageSave = true; } });" };
      });
    } }] : [] })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);

  session = await launchNoteTest({ mainEntry, userData });
  await openNote();
  await session.evaluate('void (window.__languageEditor = document.querySelector(".tiptap").editor)');
  await openSettings('设置');
  await observeFeedback();
  await chooseLanguage('语言', 'English');
  await waitFor(() => session.evaluate('document.documentElement.lang === "en-US" && Boolean(document.querySelector("input[aria-label=Language]"))'), 'English applies immediately');
  await waitFor(() => session.evaluate('window.electronAPI.getAppPreferences().then(p => p.language === "en-US")'), 'English preference persisted');
  await waitFor(() => session.evaluate('window.__languageFeedbacks.some(text => text.includes("Language saved."))'), 'English save feedback');
  assert.equal(await session.evaluate('document.querySelector(".settings-page-header").innerText.includes("Settings")'), true);
  assert.deepEqual(await session.evaluate('[...document.querySelectorAll(".settings-mantine-tab")].map(n => n.textContent)'), ['General', 'Workspace & backups', 'Editor', 'Document parsing', 'Web search', 'Text expansion', 'Models', 'Assistant skills', 'Personalization', 'About & diagnostics']);
  await assertNotePreserved();
  await screenshot('settings-en.png');
  await click('[aria-label=Appearance] [role=radio]:nth-of-type(3)');
  await waitFor(() => session.evaluate('document.documentElement.dataset.theme === "dark"'), 'English dark appearance');
  await waitFor(() => session.evaluate('document.documentElement.dataset.themeTransition !== "true"'), 'dark appearance transition finished');
  await screenshot('settings-en-dark.png');
  await click('[aria-label=Appearance] [role=radio]:nth-of-type(2)');
  await waitFor(() => session.evaluate('document.documentElement.dataset.theme === "light"'), 'English light appearance');
  await waitFor(() => session.evaluate('document.documentElement.dataset.themeTransition !== "true"'), 'light appearance transition finished');
  await waitFor(() => session.evaluate('window.electronAPI.getAppPreferences().then(p => p.theme === "light")'), 'light appearance persisted');

  await session.evaluate('window.languageTest.failNextSave()');
  await chooseLanguage('Language', '简体中文');
  await waitFor(() => session.evaluate('document.documentElement.lang === "en-US" && document.querySelector("input[aria-label=Language]")?.value === "English" && Boolean(document.querySelector(".settings-error"))'), 'language rollback');
  assert.equal(await session.evaluate('window.electronAPI.getAppPreferences().then(p => p.language)'), 'en-US');
  await session.dispose();
  session = null;

  session = await launchNoteTest({ mainEntry, userData, navigationLabel: 'Notes' });
  assert.equal(await session.evaluate('document.documentElement.lang'), 'en-US');
  await openNote('空白');
  assert.equal(await session.evaluate('document.querySelector(".tiptap [data-placeholder]")?.dataset.placeholder'), 'Start writing…');
  await session.evaluate('void (window.__languageEditor = document.querySelector(".tiptap").editor)');
  await openSettings('Settings');
  await observeFeedback();
  await session.evaluate('[...document.querySelectorAll(".settings-mantine-tab")].find(n => n.textContent === "Editor").click()');
  await waitFor(() => session.evaluate('Boolean(document.querySelector("input[aria-label=\\"Default editor mode\\"]"))'), 'English editor settings');
  assert.equal(await session.evaluate('document.querySelector("input[aria-label=\\"Default editor mode\\"]").value'), 'Edit');
  await session.evaluate('[...document.querySelectorAll(".settings-mantine-tab")].find(n => n.textContent === "General").click()');
  await chooseLanguage('Language', '简体中文');
  await waitFor(() => session.evaluate('document.documentElement.lang === "zh-CN" && Boolean(document.querySelector("input[aria-label=语言]"))'), 'Chinese restored');
  await waitFor(() => session.evaluate('window.electronAPI.getAppPreferences().then(p => p.language === "zh-CN")'), 'Chinese preference persisted');
  await waitFor(() => session.evaluate('window.__languageFeedbacks.some(text => text.includes("语言设置已保存。"))'), 'Chinese save feedback');
  assert.equal(await session.evaluate('document.querySelector(".tiptap").editor === window.__languageEditor'), true);
  assert.equal(await session.evaluate('document.querySelector(".tiptap [data-placeholder]")?.dataset.placeholder'), '输入内容…');
  await screenshot('settings-zh.png');
  assert.equal(await fs.readFile(notePath, 'utf8'), original);
  console.log(`Electron language verified: both directions, immediate UI, settings labels, save-failure rollback, preference persistence, restart, preserved editor and original note. Screenshots: ${screenshots}`);
} catch (error) {
  console.error(error, session?.diagnostics());
  console.error(await session?.evaluate('({ lang: document.documentElement.lang, feedback: document.querySelector(".settings-feedback")?.textContent, seen: window.__languageFeedbacks, error: document.querySelector(".settings-error")?.textContent })').catch(() => undefined));
  throw error;
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function openNote(name = '设置') {
  await waitFor(() => session.evaluate(`[...document.querySelectorAll('.file-tree-row')].some(n => n.textContent.includes(${JSON.stringify(name)}))`), 'Chinese file name');
  await session.evaluate(`[...document.querySelectorAll('.file-tree-row')].find(n => n.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitFor(() => session.evaluate('Boolean(document.querySelector(".tiptap")?.editor)'), 'note editor');
}
async function openSettings(label) {
  await click(`.app-nav-item[aria-label=${JSON.stringify(label)}]`);
  await waitFor(() => session.evaluate('Boolean(document.querySelector(".settings-page"))'), 'settings');
}
async function chooseLanguage(label, option) {
  await click(`input[aria-label=${JSON.stringify(label)}]`);
  await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(n => n.textContent === ${JSON.stringify(option)}))`), 'language options');
  const selector = await session.evaluate(`(() => { const n = [...document.querySelectorAll('[role=option]')].find(n => n.textContent === ${JSON.stringify(option)}); return '#' + CSS.escape(n.id); })()`);
  await click(selector);
}
async function click(selector) {
  const point = await session.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('Missing control'); n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function assertNotePreserved() {
  assert.equal(await session.evaluate('document.querySelector(".tiptap").editor === window.__languageEditor'), true, 'language switch must preserve the editor instance');
  assert.equal(await session.evaluate('document.querySelector(".tiptap").textContent.includes("中文笔记正文 English content。")'), true);
  assert.equal(await session.evaluate('document.querySelector(".tiptap").textContent.includes("保存、语言、笔记等文字属于用户内容。")'), true);
}
async function screenshot(name) {
  const result = await session.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(screenshots, name), Buffer.from(result.data, 'base64'));
}
async function observeFeedback() {
  await session.evaluate(`(() => { window.__languageFeedbacks = []; new MutationObserver(() => { const node = document.querySelector('.settings-feedback'); if (node) window.__languageFeedbacks.push(node.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }); })()`);
}
