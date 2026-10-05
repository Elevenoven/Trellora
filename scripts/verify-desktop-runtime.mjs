import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { releasePaths } from './release-paths.mjs';
import { command, launchNoteTest, waitFor } from './electron-note-test-session.mjs';
const executablePath = process.argv[2] === '--packaged' ? path.join(releasePaths().output, releasePaths().artifactName) : process.argv[2] ? path.resolve(process.argv[2]) : undefined;

const root = mkdtempSync(path.join(os.tmpdir(), 'trellora-desktop-runtime-'));
const userData = path.join(root, 'user-data');
const libraryPath = path.join(root, '中文笔记库');
const workspacePath = path.join(root, '独立工作区');
for (const directory of [userData, libraryPath, workspacePath]) mkdirSync(directory);
writeFileSync(path.join(libraryPath, '测试.md'), '# 保持原文\n\n仅在隔离目录验证。');
writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ libraryPath, workspacePath, aiProvider: { kind: 'ollama', model: 'isolated-model', endpoint: 'http://127.0.0.1:1' }, onboarding: { version: 1, status: 'pending', sampleImported: false } }));
let session;
try {
  session = await launchNoteTest({ mainEntry: path.resolve('dist-electron/main.js'), userData, executablePath });
  console.log('runtime instance:', executablePath ?? 'development bundle', 'launcher PID', session.child.pid, 'window PID', session.windowPid);
  const first = await session.evaluate('window.electronAPI.getAppDiagnostics()');
  assert.equal(first.workspacePath, workspacePath);
  assert.equal(first.userDataPath, userData);
  assert.ok(first.logsPath.startsWith(userData + path.sep));
  assert.ok(first.recentEvents.some(event => event.code === 'STARTUP_READY'));
  await session.minimizeWindow();
  await waitFor(() => session.evaluate('document.hidden'), 'existing window minimized');
  const duplicateEnvironment = { ...process.env, NODE_ENV: 'production' }; delete duplicateEnvironment.ELECTRON_RUN_AS_NODE;
  const second = spawn(executablePath ?? path.resolve('node_modules/electron/dist/electron.exe'), [...(executablePath ? [] : [path.resolve('dist-electron/main.js')]), `--user-data-dir=${userData}`], { windowsHide: true, stdio: ['ignore','ignore','pipe'], env: duplicateEnvironment });
  let duplicateError = ''; second.stderr.on('data', chunk => { duplicateError += chunk; });
  try { await waitFor(() => second.exitCode !== null, 'duplicate application exit'); assert.equal(second.exitCode, 0, duplicateError); await waitFor(() => session.evaluate('!document.hidden && document.hasFocus()'), 'existing window restored and focused'); }
  finally { if (second.exitCode === null) second.kill(); }
  assert.equal((await session.evaluate('window.electronAPI.getAppDiagnostics()')).recentEvents.filter(event => event.code === 'STARTUP_READY').length, first.recentEvents.filter(event => event.code === 'STARTUP_READY').length);
  const capabilities = await session.evaluate('window.electronAPI.getUserCapabilities()');
  assert.equal(capabilities.capabilities.find(item => item.id === 'generation').state, 'unverified');
  const failedProbe = await session.evaluate("window.electronAPI.probeUserCapability({requestId:'runtime-generation',capability:'generation'})");
  assert.equal(failedProbe.capabilities.find(item => item.id === 'generation').state, 'unreachable');
  const workerProbe = await session.evaluate("window.electronAPI.probeUserCapability({requestId:'runtime-worker',capability:'documentWorker'})");
  assert.equal(workerProbe.capabilities.find(item => item.id === 'documentWorker').state, 'available', JSON.stringify(workerProbe));
  assert.equal((await session.evaluate('window.electronAPI.importOnboardingSample()')).length, 2);
  const sample = path.join(libraryPath, '欢迎使用 Trellora.md');
  writeFileSync(sample, '# 用户已经修改的示例');
  assert.equal((await session.evaluate('window.electronAPI.importOnboardingSample()')).length, 0);
  assert.equal(readFileSync(sample, 'utf8'), '# 用户已经修改的示例');
  await session.evaluate("window.electronAPI.saveOnboardingState('skipped')");
  const backup = await session.evaluate(`window.electronAPI.startWorkspaceBackup({targetDirectory:${JSON.stringify(path.join(root, 'backups'))}})`);
  assert.equal(backup.phase, 'completed', backup.message);
  assert.ok(backup.outputPath.endsWith('.zip'));
  const restoreParent = path.join(root, 'restore-parent'); mkdirSync(restoreParent);
  const previewTask = session.evaluate('window.electronAPI.previewWorkspaceRestore()');
  void previewTask.catch(() => undefined);
  // Both real dialogs are controlled only within this test's browser PID.
  await command('python', ['scripts/select-test-dialog.py', String(session.windowPid), '选择完整备份', backup.outputPath]);
  await command('python', ['scripts/select-test-dialog.py', String(session.windowPid), '选择恢复父目录：将创建独立的新目录', restoreParent]);
  const preview = await previewTask; assert.ok(preview.operationId);
  const restored = await session.evaluate(`window.electronAPI.startWorkspaceRestore(${JSON.stringify(preview.operationId)},false)`);
  assert.equal(restored.phase, 'completed', restored.message);
  const libraries = await session.evaluate('window.electronAPI.listLibraries()'); assert.ok(libraries.some(item => item.path.startsWith(restored.targetDirectory))); assert.ok(libraries.some(item => item.path === libraryPath));
  await session.evaluate(`window.electronAPI.openRestoredWorkspace(${JSON.stringify(restored.workspacePath)})`);
  assert.equal(await session.evaluate('window.electronAPI.getWorkspacePath()'), restored.workspacePath);
  assert.ok((await session.evaluate('window.electronAPI.getRestorePausedRoots()')).includes(restored.workspacePath));
  const hints = await session.evaluate('window.electronAPI.getRestoredConnectionHints()'); assert.ok(Array.isArray(hints.aiModelSettings.profiles)); assert.doesNotMatch(JSON.stringify(hints), /apiKey|hasKey/);
  assert.equal(readFileSync(path.join(libraryPath, '测试.md'), 'utf8'), '# 保持原文\n\n仅在隔离目录验证。');
  await session.closeWindow();
  await waitFor(() => session.child.exitCode !== null, 'normal application exit');
  await session.dispose(); session = undefined;
  session = await launchNoteTest({ mainEntry: path.resolve('dist-electron/main.js'), userData, executablePath });
  const reopened = await session.evaluate('window.electronAPI.getAppDiagnostics()');
  assert.ok(reopened.recentEvents.filter(event => event.code === 'STARTUP_BEGIN').length >= 2);
  assert.equal((await session.evaluate('window.electronAPI.getOnboardingState()')).status, 'skipped');
  assert.equal(readFileSync(path.join(libraryPath, '测试.md'), 'utf8'), '# 保持原文\n\n仅在隔离目录验证。');
  await session.closeWindow();
  await waitFor(() => session.child.exitCode !== null, 'reopened application exit');
  const digest = createHash('sha256'); if (executablePath) for await (const chunk of createReadStream(executablePath)) digest.update(chunk);
  writeFileSync(path.resolve(`docs/verification/desktop-runtime-${executablePath ? 'portable' : 'electron'}.json`), JSON.stringify({ measuredAt: new Date().toISOString(), executablePath: executablePath ?? 'development bundle', artifactSha256: executablePath ? digest.digest('hex') : undefined, isolatedUserData: true, isolatedWorkspaceAndLibraries: true, applicationPathExcludesPython: Boolean(executablePath), passed: ['duplicate launch restores and focuses the existing window', 'one STARTUP_READY per instance', 'actual Worker hello/shutdown after duplicate launch', 'persistent safe diagnostics', 'unreachable configured model', 'idempotent samples preserve user changes', 'native backup and restore file/directory selection', 'full backup', 'main-process restore into a new directory', 'restored and original libraries both registered', 'restored workspace switch and persistent processing pause', 'safe connection hints exclude keys', 'onboarding skip persists', 'normal close and cold reopening', 'original note content preserved'] }, null, 2));
  console.log('desktop runtime: '+(executablePath??'development bundle')+' isolated main/preload, duplicate launch, Worker lifecycle, native backup/restore, registration, workspace switch, originals, persisted skip and normal reopening passed');
} catch (error) { console.error('runtime verification failed:', error, session?.diagnostics()); throw error; }
finally {
  await session?.dispose();
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'trellora-desktop-runtime-')));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
