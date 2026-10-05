import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { launchNoteTest, waitFor, replaceEditorText } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging'); fs.mkdirSync(staging, { recursive: true });
const bundles = fs.mkdtempSync(path.join(staging, 'migration-electron-'));
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'trellora-migration-electron-'));
const executable = path.resolve('node_modules/electron/dist/electron.exe');
const evidence = [];
const regressions = process.argv.includes('--regressions');
const evidenceDirectory = regressions ? 'workspace-migration-regressions' : 'workspace-migration';
// These isolated UI tests also drive occluded windows; keep modal transition frames running.
const testWindowSetup = regressions ? "const {app} = require('electron'); app.commandLine.appendSwitch('disable-backgrounding-occluded-windows'); app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));" : '';
const mainEntry = path.resolve('dist-electron/main.js');
const recoveryLauncher = regressions ? path.join(bundles, 'recovery-launch.cjs') : mainEntry;
if (regressions) fs.writeFileSync(recoveryLauncher, `${testWindowSetup} require(${JSON.stringify(mainEntry)});`);
let session;
const interruptFixture = (point, fixture) => new Promise((resolve, reject) => {
  const child = spawn(executable, [path.join(bundles, 'test.cjs'), `kill-${point}`, fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', killed = false;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture timeout: ${output}`)); }, 30_000);
  child.stdout.on('data', value => { output += value; if (output.includes('KILL_POINT') && !killed) { killed = true; child.kill('SIGKILL'); } });
  child.stderr.on('data', value => { output += value; }); child.once('error', reject);
  child.once('exit', () => { clearTimeout(timer); killed ? resolve() : reject(new Error(`Fixture did not reach interruption: ${output}`)); });
});
const click = text => session.evaluate(`(() => { const button = [...document.querySelectorAll('[data-workspace-migration-dialog] button')].find(button => button.textContent === ${JSON.stringify(text)}); if (!button) throw new Error('Migration button missing'); button.click(); })()`);
const seedFixture = fixture => new Promise((resolve, reject) => {
  const child = spawn(executable, [path.join(bundles, 'test.cjs'), 'seed', fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; }); child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Fixture failed: ${output}`)));
});

try {
  await Promise.all([
    build({ entryPoints: ['scripts/fixtures/workspace-migration-harness.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: path.join(bundles, 'test.cjs') }),
    build({ entryPoints: ['electron/workspaceMigrationWorker.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: path.join(bundles, 'workspaceMigrationWorker.js') }),
  ]);
  // The native directory picker is stubbed only in this isolated launcher; main/preload/React are production builds.
  const normal = path.join(fixtures, 'normal'), source = path.join(normal, '原工作区'), target = path.join(normal, '新工作区');
  await seedFixture(normal);
  const configFile = path.join(normal, 'profile', 'config.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.appPreferences.defaultEditorMode = 'source'; config.appPreferences.autosaveDelayMs = 5000; fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(path.join(source, '项目笔记', '_attachments', '大附件.bin'), Buffer.alloc(64 * 1024 * 1024, 35));
  const launcher = path.join(bundles, 'normal-launch.cjs');
  const faultInjection = regressions ? `const {ipcMain} = require('electron'); const register = ipcMain.handle.bind(ipcMain); const faults = {'get-workspace-path':1, 'notes:open':1}; ipcMain.handle = (channel, handler) => register(channel, (...args) => { if (faults[channel] && JSON.parse(require('node:fs').readFileSync(${JSON.stringify(configFile)}, 'utf8')).workspacePath === ${JSON.stringify(target)}) { faults[channel]--; throw new Error('Injected renderer refresh failure: ' + channel); } return handler(...args); });` : '';
  fs.writeFileSync(launcher, `${testWindowSetup} const {dialog} = require('electron'); dialog.showOpenDialog = async (_window, options) => { if (!options.title.includes('选择新的数据存储位置')) throw new Error('Unexpected directory picker'); return {canceled:false,filePaths:[${JSON.stringify(target)}]}; }; ${faultInjection} require(${JSON.stringify(mainEntry)});`);
  session = await launchNoteTest({ mainEntry: launcher, userData: path.join(normal, 'profile') });
  if (regressions) {
    await session.evaluate("document.querySelector('.app-nav-item[aria-label=Wiki]').click()");
    await waitFor(() => session.evaluate(`document.querySelector('.wiki-toolbar input[type=hidden]')?.value === ${JSON.stringify(path.join(source, 'knowledge-base', '项目资料'))}`), 'cached Wiki at source');
    await session.evaluate("document.querySelector('.app-nav-item[aria-label=地图]').click()");
    await waitFor(() => session.evaluate(`document.querySelector('select[aria-label=选择资料库]')?.value === ${JSON.stringify(path.join(source, 'knowledge-base', '项目资料'))}`), 'cached graph at source');
  }
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=资料]').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('.materials-rail-item')].find(button => button.textContent.includes('项目资料')))"), 'materials library');
  await session.evaluate("[...document.querySelectorAll('.materials-rail-item')].find(button => button.textContent.includes('项目资料')).click()");
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=助手]').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[aria-label=打开历史记忆]'))"), 'assistant workspace');
  await session.evaluate("document.querySelector('[aria-label=打开历史记忆]').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('.qa-memory-session')].find(button => button.textContent.includes('项目历史')))"), 'assistant history');
  await session.evaluate("[...document.querySelectorAll('.qa-memory-session')].find(button => button.textContent.includes('项目历史')).click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.qa-workspace')?.textContent.includes('整理验收记录。'))"), 'restored assistant session');
  await session.evaluate("document.querySelector('.qa-workspace textarea').focus()");
  await session.send('Input.insertText', { text: '这条未发送的问题在迁移后保留。' });
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=笔记]').click()");
  const note = path.join(source, '项目笔记', '项目计划.md');
  await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[data-path]')].find(node => node.dataset.path === ${JSON.stringify(note)}))`), 'source note tree');
  await session.evaluate(`[...document.querySelectorAll('[data-path]')].find(node => node.dataset.path === ${JSON.stringify(note)}).click()`);
  const edited = '# 华辰验收记录\n\n迁移前尚未自动保存的最新草稿。';
  await replaceEditorText(session, edited);
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=设置]').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('button')].find(button => button.textContent === '工作区与备份'))"), 'workspace settings navigation');
  await session.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '工作区与备份').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('button')].find(button => button.textContent === '更改存储位置…'))"), 'workspace settings');
  await session.evaluate("window.__migrationTrace = []; window.electronAPI.onWorkspaceMigrationStatus(status => window.__migrationTrace.push({phase:status.phase,progress:status.progress})); [...document.querySelectorAll('button')].find(button => button.textContent === '更改存储位置…').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('[data-workspace-migration-dialog] button')].find(button => button.textContent === '开始迁移'))"), 'migration preview');
  await waitFor(() => session.evaluate("Number(getComputedStyle(document.querySelector('[role=dialog]')).opacity) === 1"), 'preview animation');
  assert.equal(await session.evaluate("document.querySelector('.app-shell').inert"), true);
  if (regressions) {
    await session.evaluate("window.__workspaceChanges = 0; window.addEventListener('workspace-data-changed', () => window.__workspaceChanges++);");
    await click('取消');
    await waitFor(() => session.evaluate("!document.querySelector('[data-workspace-migration-dialog]') && !document.querySelector('.app-shell').inert"), 'preview cancelled');
    assert.equal(await session.evaluate('window.__workspaceChanges'), 0, 'Cancelling a preview must not reset cached pages');
    await session.evaluate("document.querySelector('.app-nav-item[aria-label=助手]').click()");
    assert.equal(await session.evaluate("document.querySelector('.qa-workspace')?.textContent.includes('整理验收记录。')"), true);
    assert.equal(await session.evaluate("document.querySelector('.qa-workspace textarea').value"), '这条未发送的问题在迁移后保留。');
    await session.evaluate("document.querySelector('.app-nav-item[aria-label=设置]').click()");
    await session.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '更改存储位置…').click()");
    await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('[data-workspace-migration-dialog] button')].find(button => button.textContent === '开始迁移'))"), 'second preview after cancellation');
  }
  await click('开始迁移');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[data-testid=workspace-migration-progress]'))"), 'visible progress');
  const progressImage = await session.send('Page.captureScreenshot', { format: 'png' });
  const progressPath = path.resolve('output/verification', evidenceDirectory, 'progress.png'); fs.mkdirSync(path.dirname(progressPath), { recursive: true }); fs.writeFileSync(progressPath, Buffer.from(progressImage.data, 'base64'));
  if (regressions) {
    for (const failure of ['get-workspace-path', 'notes:open']) {
      await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[data-workspace-migration-dialog] button')].find(button => button.textContent === '重试加载') && !document.querySelector('[data-workspace-migration-dialog][aria-busy=true]'))`), `retry offered after ${failure} failure`);
      assert.equal(await session.evaluate("document.querySelector('.app-shell').inert"), true, 'Failed refresh keeps the application locked until recovery completes');
      await click('重试加载');
    }
  }
  await waitFor(() => session.evaluate("window.__migrationTrace.some(status => status.phase === 'completed') && !document.querySelector('[data-workspace-migration-dialog]') && !document.querySelector('.app-shell').inert"), 'normal migration and automatic unlock', 60_000);
  if (regressions) {
    const relocatedMaterials = path.join(target, 'knowledge-base', '项目资料');
    assert.equal(await session.evaluate("document.querySelector('.wiki-toolbar input[type=hidden]').value"), relocatedMaterials);
    assert.equal(await session.evaluate("document.querySelector('select[aria-label=选择资料库]').value"), relocatedMaterials);
    evidence.push({ mode: 'renderer-regressions', previewCancellationRetainsConversationAndComposer: true, previewCancellationDoesNotNotifyDataChange: true, cachedWikiRelocated: true, cachedGraphRelocated: true, consecutiveRefreshFailures: ['get-workspace-path', 'notes:open'], retryRestoresOpenNote: true });
  }
  assert.equal(fs.readFileSync(path.join(target, '项目笔记', '项目计划.md'), 'utf8'), edited);
  assert.equal(fs.readFileSync(note, 'utf8'), edited);
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=资料]').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('.materials-rail-item.active')].find(button => button.textContent.includes('项目资料')))"), 'relocated selected materials library');
  assert.equal(await session.evaluate('window.electronAPI.listMaterialsLibraries().then(libraries => libraries[0].path)'), path.join(target, 'knowledge-base', '项目资料'));
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=助手]').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.qa-workspace')?.textContent.includes('整理验收记录。'))"), 'preserved active assistant session');
  assert.equal(await session.evaluate("document.querySelector('.qa-workspace textarea').value"), '这条未发送的问题在迁移后保留。');
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=笔记]').click()");
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=笔记]').click()");
  await waitFor(() => session.evaluate(`document.querySelector('.cm-content')?.textContent.includes('迁移前尚未自动保存的最新草稿。') && Boolean([...document.querySelectorAll('[data-path]')].find(node => node.dataset.path === ${JSON.stringify(path.join(target, '项目笔记', '项目计划.md'))}))`), 'relocated open note');
  await replaceEditorText(session, '# 迁移后继续编辑\n\n只保存到新位置。');
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
  await waitFor(() => fs.readFileSync(path.join(target, '项目笔记', '项目计划.md'), 'utf8').includes('只保存到新位置。'), 'continued editing at target');
  assert.equal(fs.readFileSync(note, 'utf8'), edited);
  evidence.push({ mode: 'normal', nativeDirectoryPicker: 'isolated stub', settingsEntry: true, visibleProgress: true, latestDraftSaved: true, relocatedOpenNote: true, selectedMaterialsLibraryRetained: true, activeConversationRetained: true, unsentQuestionRetained: true, subsequentSaveAtTarget: true, originalRetained: true, automaticUnlock: true });
  console.log('Real Electron normal migration: settings entry, latest draft, progress, relocated open note and subsequent target-only save passed.');
  await session.dispose(); session = undefined;
  for (const point of ['prepare', 'copy', 'commit']) {
    const fixture = path.join(fixtures, point), source = path.join(fixture, '原工作区'), target = path.join(fixture, '新工作区');
    await interruptFixture(point, fixture);
    session = await launchNoteTest({ mainEntry: recoveryLauncher, userData: path.join(fixture, 'profile') });
    await waitFor(() => session.evaluate("Boolean(document.querySelector('[data-workspace-migration-dialog][data-phase=interrupted]') && document.querySelector('.app-shell')?.inert)"), 'recovery modal and application lock');
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await session.evaluate("Boolean(document.querySelector('[data-workspace-migration-dialog]'))"), true);
    const deniedBefore = await session.evaluate("window.electronAPI.createFile('不应创建').then(() => false, () => true)");
    assert.equal(deniedBefore, true, 'Main process must reject writes until recovery is resolved');
    await session.evaluate(`window.__migrationTrace = []; window.__migrationDenied = []; window.electronAPI.onWorkspaceMigrationStatus(status => {
      window.__migrationTrace.push({ phase: status.phase, progress: status.progress, locked: document.querySelector('.app-shell')?.inert });
      if (status.phase === 'copying') window.__migrationDenied.push(window.electronAPI.createFile('迁移期间不应创建').then(() => false, () => true));
    });`);
    if (point === 'copy') {
      await waitFor(() => session.evaluate("Number(getComputedStyle(document.querySelector('[role=dialog]')).opacity) === 1"), 'modal animation');
      const screenshot = await session.send('Page.captureScreenshot', { format: 'png' });
      const screenshotPath = path.resolve('output/verification', evidenceDirectory, 'recovery.png');
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true }); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    }
    await click('继续迁移');
    await waitFor(() => session.evaluate("window.__migrationTrace.some(status => status.phase === 'completed')"), 'migration backend completion', 60_000);
    await waitFor(() => session.evaluate("!document.querySelector('[data-workspace-migration-dialog]') && !document.querySelector('.app-shell')?.inert"), 'automatic unlock after data refresh');
    const trace = await session.evaluate('window.__migrationTrace');
    assert.ok(trace.filter(status => status.phase !== 'completed').every(status => status.locked));
    assert.equal(trace.at(-1).progress, 100);
    if (point === 'copy') { const denied = await session.evaluate('Promise.all(window.__migrationDenied)'); assert.ok(denied.length > 0); assert.ok(denied.every(Boolean)); }
    const result = await session.evaluate(`(async () => ({
      workspace: await window.electronAPI.getWorkspacePath(), library: await window.electronAPI.getLibraryPath(),
      libraries: await window.electronAPI.listLibraries(), detail: await window.electronAPI.getQaMemorySession('assistant-session-12345678-1234-1234-1234-123456789012'),
      memory: await window.electronAPI.listLongTermMemoryItems(), pending: (await window.electronAPI.getWorkspaceMigrationState()).pending,
      created: await window.electronAPI.createFile('迁移后新笔记')
    }))()`);
    assert.equal(result.workspace, target); assert.equal(result.library, path.join(target, '项目笔记'));
    assert.equal(result.libraries.length, 2); assert.ok(result.libraries.some(item => item.path === path.join(fixture, '外部资料')));
    assert.ok(JSON.stringify(result.detail).includes('整理验收记录。')); assert.ok(JSON.stringify(result.memory).includes('项目讨论优先使用中文。'));
    assert.equal(result.pending, null); assert.equal(result.created, path.join(target, '项目笔记', '迁移后新笔记.md'));
    assert.ok(fs.existsSync(path.join(source, '项目笔记', '项目计划.md')));
    assert.ok(!fs.existsSync(path.join(source, '项目笔记', '迁移后新笔记.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'profile', 'config.json'))).modelSecret, 'CREDENTIAL_MUST_STAY_IN_PROFILE');
    evidence.push({ interruption: point, phases: [...new Set(trace.map(status => status.phase))], progress: trace.at(-1).progress, recoveryModal: true, escapeBlocked: true, mainWriteLock: true, automaticUnlock: true, history: true, memory: true, externalLibrary: true, newWritesAtTarget: true, originalRetained: true });
    console.log(`Real Electron ${point} recovery: locked modal, IPC write rejection, automatic unlock, history, memory and new note writes passed.`);
    await session.dispose(); session = undefined;
  }
  const abandoned = path.join(fixtures, 'abandon-commit'); await interruptFixture('commit', abandoned);
  session = await launchNoteTest({ mainEntry: recoveryLauncher, userData: path.join(abandoned, 'profile') });
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[data-workspace-migration-dialog][data-phase=interrupted]'))"), 'committed recovery decision');
  await click('继续使用原位置');
  await waitFor(() => session.evaluate("!document.querySelector('[data-workspace-migration-dialog]') && !document.querySelector('.app-shell').inert"), 'rollback and unlock');
  const original = path.join(abandoned, '原工作区');
  assert.equal(await session.evaluate('window.electronAPI.getWorkspacePath()'), original);
  assert.equal(await session.evaluate("window.electronAPI.createFile('返回原位置后的笔记')"), path.join(original, '项目笔记', '返回原位置后的笔记.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(original, '.menghan-meta', '.trellora-use.lock', 'owner.json'))).pid, session.child.pid, 'Rollback must own the original data roots after restart');
  assert.ok(fs.existsSync(path.join(abandoned, '新工作区', '.trellora-migration.json')));
  evidence.push({ interruption: 'commit', decision: 'use original', originalLeaseReclaimed: true, originalConfigurationRestored: true, writesAtOriginal: true, publishedTargetRetained: true, automaticUnlock: true });
  console.log('Real Electron committed recovery rollback: original roots leased, original associations restored and published copy retained.');
  await session.dispose(); session = undefined;
  const report = path.resolve(`docs/verification/workspace-migration${regressions ? '-regressions' : ''}-electron.json`);
  fs.writeFileSync(report, `${JSON.stringify({ generatedAt: new Date().toISOString(), environment: 'Windows Electron development binary with production renderer and isolated profiles', cases: evidence }, null, 2)}\n`);
} catch (error) {
  if (session) console.error('Migration UI failure:', await session.evaluate("({dialog:document.querySelector('[data-workspace-migration-dialog]')?.textContent, settingsVisible:document.querySelector('.workspace-settings-page')?.checkVisibility(), buttons:[...document.querySelectorAll('button')].filter(button=>button.textContent==='更改存储位置…').map(button=>({disabled:button.disabled,visible:button.checkVisibility()})), inert:document.querySelector('.app-shell')?.inert, visibility:document.visibilityState, tail:document.body.innerText.slice(-2000), portals:[...document.querySelectorAll('[data-portal]')].map(node=>node.innerHTML.slice(-1000))})").catch(() => 'Renderer unavailable'), await session.evaluate('window.electronAPI.getWorkspaceMigrationState()').catch(() => null), session.diagnostics().slice(-3000));
  throw error;
} finally {
  await session?.dispose();
  assert.ok(bundles.startsWith(staging + path.sep + 'migration-electron-')); fs.rmSync(bundles, { recursive: true, force: true });
  assert.ok(fixtures.startsWith(path.join(os.tmpdir(), 'trellora-migration-electron-'))); await fs.promises.rm(fixtures, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
