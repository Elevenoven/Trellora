import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
export async function launchNoteTest({ mainEntry, userData, executablePath, navigationLabel = '笔记', args = [] }) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, NODE_ENV: 'production' }; delete env.ELECTRON_RUN_AS_NODE;
  if (executablePath) { env.PATH = `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`; delete env.PYTHONPATH; delete env.PYTHONHOME; }
  const child = spawn(executablePath ?? path.resolve('node_modules/electron/dist/electron.exe'), [...(executablePath ? [] : [mainEntry]), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, ...args], { cwd: executablePath ? path.dirname(executablePath) : process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', socket;
  child.stdout.on('data', chunk => { diagnostics += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let page;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${diagnostics}`);
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(page => page.type === 'page' && page.url.startsWith('file:')); return page?.webSocketDebuggerUrl; } catch { return false; }
    }, 'Electron page');
    socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const pending = new Map(); let id = 0;
    socket.addEventListener('message', event => { const reply = JSON.parse(event.data), task = pending.get(reply.id); if (!task) return; pending.delete(reply.id); clearTimeout(task.timer); reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result); });
    socket.addEventListener('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP closed')); } pending.clear(); });
    const send = (method, params) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout ${method}`)); }, 30_000); pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params })); });
    const evaluate = async expression => {
      try { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
      catch (error) { throw new Error(`${error.message}: ${expression.slice(0, 180)}`); }
    };
    const navigationSelector = `.app-nav-item[aria-label=${JSON.stringify(navigationLabel)}]`;
    await waitFor(() => evaluate(`Boolean(window.electronAPI?.saveNote && document.querySelector(${JSON.stringify(navigationSelector)})) && !document.getElementById('startup-splash')`), 'preload and React startup');
    await evaluate(`document.querySelector(${JSON.stringify(navigationSelector)})?.click()`);
    // A portable launcher owns a child browser process; close the actual window PID.
    let windowPid = child.pid;
    if (executablePath && path.basename(executablePath).includes('portable')) {
      const browserUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      const browser = new WebSocket(browserUrl);
      try {
        await new Promise((resolve, reject) => { browser.addEventListener('open', resolve, { once: true }); browser.addEventListener('error', reject, { once: true }); });
        const info = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Browser PID timeout')), 10_000); browser.addEventListener('message', event => { const reply = JSON.parse(event.data); if (reply.id === 1) { clearTimeout(timer); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result); } }); browser.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })); });
        windowPid = Number(info.processInfo.find(process => process.type === 'browser').id);
      } finally { browser.close(); }
    }
    const windowCommand = (action) => {
      const script = `import ctypes\nu = ctypes.windll.user32\nu.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]\nu.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]\nu.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar), ctypes.c_int]\nwindows = []\ndef visit(hwnd, _):\n p = ctypes.c_ulong(); u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))\n name = ctypes.create_unicode_buffer(256); u.GetClassNameW(hwnd, name, 256)\n if p.value == ${windowPid} and name.value == 'Chrome_WidgetWin_1': windows.append(hwnd)\n return True\ncallback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(visit)\nu.EnumWindows(callback, 0)\nassert windows, 'Test window not found'\nassert u.PostMessageW(windows[0], 0x10, None, None), 'Close message failed'`;
      return command('python', ['-c', script.slice(0, script.indexOf("assert u.PostMessageW")) + action]);
    };
    const closeWindow = () => windowCommand("assert u.PostMessageW(windows[0], 0x10, None, None), 'Close message failed'");
    const minimizeWindow = () => windowCommand('u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]\nu.ShowWindow(windows[0], 6)');
    return { evaluate, send, child, windowPid, exited, closeWindow, minimizeWindow, diagnostics: () => diagnostics, dispose: async () => { socket.close(); if (child.exitCode === null) await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], true); await exited; } };
  } catch (error) { socket?.close(); if (child.exitCode === null) await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], true); throw new Error(`${error.message}\n${diagnostics}`); }
}
export function command(executable, args, ignoreExit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject);
    child.once('exit', code => code === 0 || ignoreExit ? resolve() : reject(new Error(`${executable} exited ${code}: ${output}`)));
  });
}
export async function waitFor(predicate, label, timeout = 30_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await delay(50); } throw new Error(`Timed out waiting for ${label}`); }
export function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
export async function replaceEditorText(session, text) {
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.cm-content')?.isContentEditable && !document.querySelector('.simple-modal'))"), 'editable document');
  await session.evaluate("document.querySelector('.cm-content').focus()");
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.insertText', { text });
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'dirty'"), 'input accepted as a new draft');
}
