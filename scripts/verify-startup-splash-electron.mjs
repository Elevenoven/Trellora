import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const bundles = await fs.mkdtemp(path.join(staging, 'startup-splash-'));
const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-startup-splash-'));
const images = path.resolve('output/verification/startup-splash');
await fs.mkdir(images, { recursive: true });
const mainEntry = path.join(bundles, 'dist-electron/main.js');
const launcher = path.join(bundles, 'launch.cjs');
const evidence = [];
let session;

// Holds only the fixture's preload handshake, making real first-frame captures deterministic.
const preloadTest = {
  name: 'startup-fixture-handshake',
  setup(bundler) {
    bundler.onLoad({ filter: /electron[\\/]preload\.ts$/ }, async args => {
      let source = await fs.readFile(args.path, 'utf8');
      const handshake = "waitForStartup: () => ipcRenderer.invoke('startup:ready'),";
      assert.ok(source.includes(handshake));
      source = source.replace(handshake, "waitForStartup: () => ipcRenderer.invoke('startup:ready').then(() => startupGate),");
      for (const [flag, method, channel] of [['failAi', 'getAiModelSettings', 'get-ai-model-settings'], ['failPreferences', 'getAppPreferences', 'get-app-preferences'], ['failOnboarding', 'getOnboardingState', 'onboarding:get']]) {
        const target = `${method}: () => ipcRenderer.invoke('${channel}'),`;
        assert.ok(source.includes(target));
        source = source.replace(target, `${method}: () => startupFlags.${flag} ? Promise.reject(new Error('Fixture read failure')) : ipcRenderer.invoke('${channel}'),`);
      }
      const prefix = `const startupFlags = {failAi:false,failPreferences:false,failOnboarding:false}; let releaseStartup: (fail?:boolean)=>void; const startupGate=new Promise<void>((resolve,reject)=>{releaseStartup=(fail=false)=>fail?reject(new Error('Fixture startup failure')):resolve()});\n`;
      const suffix = `\ncontextBridge.exposeInMainWorld('startupTest',{id:Math.random(),release:(fail=false)=>releaseStartup(fail),configure:(flags:typeof startupFlags)=>Object.assign(startupFlags,flags),close:()=>ipcRenderer.invoke('startup-test:close')});`;
      return { loader: 'ts', contents: prefix + source + suffix };
    });
  },
};

async function launch(userData) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, NODE_ENV: 'production' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [launcher, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', socket;
  const pending = new Map();
  let id = 0;
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = once(child, 'exit');
  try {
    let target;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited: ${diagnostics}`);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); return Boolean(target?.webSocketDebuggerUrl); } catch { return false; }
    }, 'first Electron window');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    socket.addEventListener('message', event => {
      const reply = JSON.parse(event.data), task = pending.get(reply.id);
      if (!task) return;
      pending.delete(reply.id); clearTimeout(task.timer);
      reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await waitFor(() => evaluate('Boolean(window.startupTest && document.getElementById("startup-splash"))'), 'static startup frame');
    return { send, evaluate, child, dispose: async () => {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Fixture closed')); }
      socket.close();
      if (child.exitCode === null) await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], true);
      await exited;
    } };
  } catch (error) {
    socket?.close();
    if (child.exitCode === null) await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], true);
    await exited;
    throw new Error(`${error.message}\n${diagnostics}`);
  }
}

async function reload() {
  const previous = await session.evaluate('window.startupTest.id');
  await session.evaluate('setTimeout(() => window.location.reload(), 0)');
  await waitFor(() => session.evaluate(`window.startupTest?.id !== ${previous} && document.documentElement?.dataset.startupState === "loading" && !document.querySelector(".app-shell")`), 'reloaded startup frame');
}

async function screenshot(name) {
  await session.evaluate('document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 1000; })');
  await session.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const result = await session.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(images, name), Buffer.from(result.data, 'base64'));
}

try {
  await fs.cp(path.resolve('dist-electron'), path.join(bundles, 'dist-electron'), { recursive: true });
  await fs.writeFile(launcher, `const {app,ipcMain,BrowserWindow}=require('electron');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));ipcMain.handle('startup-test:close',event=>BrowserWindow.fromWebContents(event.sender).close());require(${JSON.stringify(mainEntry)});`);
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(bundles, 'dist-electron/preload.js'), plugins: [preloadTest], logLevel: 'silent' }),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(bundles, 'dist'), '--logLevel', 'error']),
  ]);
  const cases = [
    { id: 'green', theme: 'light', scheme: 'green', color: 'rgb(245, 248, 246)' },
    { id: 'blue', theme: 'light', scheme: 'blue', color: 'rgb(245, 248, 252)', lastNote: true },
    { id: 'orange', theme: 'light', scheme: 'orange', color: 'rgb(252, 248, 243)' },
    { id: 'gray', theme: 'light', scheme: 'gray', color: 'rgb(247, 248, 250)', flags: { failAi: true } },
    { id: 'pink', theme: 'light', scheme: 'pink', color: 'rgb(252, 247, 249)', flags: { failPreferences: true, failOnboarding: true } },
    { id: 'dark', theme: 'dark', scheme: 'pink', color: 'rgb(37, 27, 34)', language: 'en-US' },
    { id: 'reduced-motion', theme: 'light', scheme: 'blue', color: 'rgb(245, 248, 252)', reduced: true },
    { id: 'system', theme: 'system', scheme: 'green' },
    { id: 'close-during-startup', theme: 'light', scheme: 'green', color: 'rgb(245, 248, 246)', close: true },
  ];
  for (const testCase of cases) {
    const root = path.join(fixtures, testCase.id), userData = path.join(root, 'profile'), workspace = path.join(root, 'workspace'), library = path.join(workspace, '项目笔记');
    await fs.mkdir(userData, { recursive: true }); await fs.mkdir(library, { recursive: true });
    const notePath = path.join(library, '启动验收.md'), original = '# 启动验收\n\n这是原有笔记，启动动画不能修改正文。\n';
    await fs.writeFile(notePath, original);
    await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace, libraryPath: testCase.id === 'green' ? undefined : library, libraries: testCase.id === 'green' ? [] : [{ path: library, alias: '项目笔记', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }], appPreferences: { theme: testCase.theme, lightColorScheme: testCase.scheme, language: testCase.language ?? 'zh-CN', startupBehavior: testCase.lastNote ? 'last-note' : 'library', lastOpenedNote: testCase.lastNote ? notePath : undefined } }));
    session = await launch(userData);
    console.log(`startup splash: ${testCase.id} first HTML frame loaded`);
    await session.evaluate(`localStorage.setItem('trellora-theme-mode', '${testCase.theme === 'dark' ? 'light' : 'dark'}');localStorage.setItem('trellora-light-color-scheme','orange');`);
    if (testCase.reduced) await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await reload();
    const firstFrame = await session.evaluate(`(() => {const splash=document.getElementById('startup-splash');return {theme:document.documentElement.dataset.theme,scheme:document.documentElement.dataset.lightColorScheme,language:document.documentElement.lang,background:getComputedStyle(splash).backgroundColor,status:splash.querySelector('.startup-status').textContent,rootEmpty:!document.getElementById('root').hasChildNodes(),inert:document.getElementById('root').inert,animation:getComputedStyle(splash.querySelector('.startup-mark')).animationName,seed:window.electronAPI.startupAppearance};})()`);
    assert.equal(firstFrame.theme, firstFrame.seed.theme);
    assert.equal(firstFrame.scheme, testCase.scheme);
    assert.equal(firstFrame.rootEmpty, true);
    assert.equal(firstFrame.inert, true);
    if (testCase.color) assert.equal(firstFrame.background, testCase.color);
    if (testCase.language === 'en-US') assert.equal(firstFrame.status, 'Opening your workspace');
    if (testCase.reduced) assert.equal(firstFrame.animation, 'none');
    await screenshot(`${testCase.id}-startup.png`);

    if (testCase.close) {
      await session.evaluate('setTimeout(() => window.startupTest.close(), 0)');
      await waitFor(() => session.child.exitCode !== null, 'normal close before React mounts');
      evidence.push({ id: testCase.id, closedNormally: true });
      await session.dispose(); session = undefined;
      continue;
    }

    if (testCase.id === 'green') {
      await session.evaluate('window.startupTest.release(true)');
      await waitFor(() => session.evaluate('document.getElementById("startup-splash").dataset.phase === "error"'), 'failed handshake is recoverable');
      assert.equal(await session.evaluate('document.querySelector(".startup-retry").hidden'), false);
      await screenshot('startup-failure.png');
      const previous = await session.evaluate('window.startupTest.id');
      await session.evaluate('document.querySelector(".startup-retry").click()');
      await waitFor(() => session.evaluate(`window.startupTest?.id !== ${previous} && document.getElementById("startup-splash")?.dataset.phase === "loading"`), 'retry resets first frame');
    }

    if (testCase.flags) await session.evaluate(`window.startupTest.configure(${JSON.stringify(testCase.flags)})`);
    await session.evaluate('window.startupTest.release()');
    await waitFor(() => session.evaluate('document.documentElement.dataset.startupState === "complete" && !document.getElementById("startup-splash") && !document.getElementById("root").inert && Boolean(document.querySelector(".app-shell"))'), 'actual initialization releases startup overlay');
    if (testCase.id === 'green') assert.equal(await session.evaluate('Boolean(document.querySelector("[data-testid=first-run-guide]"))'), true);
    if (testCase.flags?.failOnboarding) assert.equal(await session.evaluate('Boolean(document.querySelector(".onboarding-state-error"))'), true);
    if (testCase.lastNote) {
      await session.evaluate('document.querySelector(".app-nav-item[aria-label=笔记]").click()');
      await waitFor(() => session.evaluate('document.querySelector(".tiptap")?.textContent.includes("启动动画不能修改正文")'), 'last note restored');
    }
    const stillAbsent = await session.evaluate(`(() => {const nav=document.querySelector('.app-nav-item');nav?.click();return !document.getElementById('startup-splash')})()`);
    assert.equal(stillAbsent, true, 'Menu changes do not replay startup');
    assert.equal(await fs.readFile(notePath, 'utf8'), original);
    evidence.push({ id: testCase.id, firstFrame, completed: true, originalNotePreserved: true });
    console.log(`startup splash: ${testCase.id} passed`);
    await session.dispose(); session = undefined;
  }
  await fs.writeFile(path.join(images, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), method: 'Real Electron with production main/React and a held fixture preload handshake; no model requests; not a portable clean-machine test', cases: evidence }, null, 2));
} finally {
  await session?.dispose();
  for (const [target, parent, prefix] of [[bundles, staging, 'startup-splash-'], [fixtures, os.tmpdir(), 'trellora-startup-splash-']]) {
    assert.equal(path.dirname(path.resolve(target)), path.resolve(parent)); assert.ok(path.basename(target).startsWith(prefix));
    await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
