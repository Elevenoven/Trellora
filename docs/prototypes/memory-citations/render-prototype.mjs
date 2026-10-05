import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../../..');
const images = path.join(directory, 'images');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-memory-citation-prototype-'));
const chrome = process.env.TRELLORA_PROTOTYPE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = pathToFileURL(path.join(directory, 'index.html')).href;
await fs.mkdir(images, { recursive: true });
await build({
  stdin: { contents: `import {getColorScheme,LIGHT_COLOR_SCHEME_IDS} from './shared/lightColorSchemes';window.prototypeColors=Object.fromEntries(['light','dark'].map(theme=>[theme,Object.fromEntries(LIGHT_COLOR_SCHEME_IDS.map(id=>[id,getColorScheme(theme,id)]))]));`, resolveDir: repository },
  bundle: true, format: 'iife', minify: true, outfile: path.join(directory, 'theme-tokens.js'), logLevel: 'silent',
});

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let browser, socket, requestId = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function poll(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Prototype browser did not become ready');
}
async function navigate(query, width = 1280, height = 760) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}?${query}` });
  await poll(() => evaluate('Boolean(window.memoryCitationPrototype?.ready)'));
  await evaluate('document.fonts.ready');
}
async function capture(name) {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(path.join(images, name), Buffer.from(screenshot.data, 'base64'));
}
async function click(selector) {
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
try {
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${temporary}`, base], { windowsHide: true, stdio: 'ignore' });
  let target;
  await poll(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); return Boolean(target?.webSocketDebuggerUrl); }
    catch { return false; }
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    if (reply.method === 'Runtime.exceptionThrown') errors.push(reply.params.exceptionDetails.text);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id); clearTimeout(task.timer);
    reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await navigate('theme=dark&palette=gray');
  await capture('01-dark.png');
  assert.equal(await evaluate('document.querySelector("#memory-source-1").hidden'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#source-pill")).borderRadius'), '999px');
  await click('#citation');
  assert.equal(await evaluate('document.querySelector("#memory-source-1").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#source-pill").getAttribute("aria-expanded")'), 'true');
  assert.equal(await evaluate('document.querySelector("#memory-source-1").classList.contains("highlight")'), true);
  await capture('02-citation-click.png');
  await click('#source-pill');
  assert.equal(await evaluate('document.querySelector("#memory-source-1").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#source-pill").getAttribute("aria-expanded")'), 'false');
  await click('#source-pill');
  assert.equal(await evaluate('document.querySelector("#memory-source-1").hidden'), false);
  await click('#open-original');
  assert.equal(await evaluate('document.querySelector("#original-dialog").open'), true);
  await capture('03-original-dialog.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate('document.querySelector("#original-dialog").open'), false);
  await click('#missing');
  assert.equal(await evaluate('document.querySelector("#open-original").hidden'), true);
  assert.match(await evaluate('document.querySelector("#source-caption").textContent'), /原始对话已删除/u);
  await capture('04-source-deleted.png');
  await navigate('theme=light&palette=gray');
  await capture('05-light.png');
  const checks = [];
  for (const theme of ['dark', 'light']) {
    for (const palette of ['gray', 'green', 'blue', 'orange', 'pink']) {
      for (const width of [1280, 760, 390]) {
        await navigate(`theme=${theme}&palette=${palette}`, width);
        const overflow = await evaluate('document.documentElement.scrollWidth>innerWidth');
        assert.equal(overflow, false, `${theme} ${palette} ${width}: horizontal overflow`);
        checks.push({ theme, palette, width, overflow });
      }
    }
  }
  await capture('06-compact.png');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ scope: 'Standalone prototype with example data; production citation flow is not implemented here', checks, interactions: ['Knowledge-base capsule shape is reused', 'Source details are collapsed initially', 'Inline citation and source capsule toggle the same source panel', 'Expanded capsule state matches source panel visibility', 'Original conversation opens a modal', 'Escape closes the modal', 'Deleted original hides navigation and preserves the memory snapshot'], runtimeErrors: errors }, null, 2) + '\n');
  console.log('Rendered 6 screenshots; citation/source/deletion interactions and 30 theme/viewport combinations passed.');
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, 'exit'); browser.kill();
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 4000))]);
  }
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closed')); }
  const resolvedTemporary = path.resolve(temporary);
  const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolvedTemporary.startsWith(resolvedTempRoot) || !path.basename(resolvedTemporary).startsWith('trellora-memory-citation-prototype-')) throw new Error('Temporary path outside prototype cleanup boundary');
  await fs.rm(resolvedTemporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
