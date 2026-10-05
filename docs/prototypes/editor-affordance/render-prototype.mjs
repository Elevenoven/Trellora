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
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-editor-prototype-'));
const chrome = process.env.TRELLORA_PROTOTYPE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = pathToFileURL(path.join(directory, 'index.html')).href;
await fs.mkdir(images, { recursive: true });

// The prototype uses the actual application's palette definitions.
await build({
  stdin: { contents: `import {getColorScheme,LIGHT_COLOR_SCHEME_IDS} from './shared/lightColorSchemes'; window.prototypeColors=Object.fromEntries(['light','dark'].map(theme=>[theme,Object.fromEntries(LIGHT_COLOR_SCHEME_IDS.map(id=>[id,getColorScheme(theme,id)]))]));`, resolveDir: repository },
  bundle: true, format: 'iife', minify: true, outfile: path.join(directory, 'theme-tokens.js'), logLevel: 'silent',
});

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let browser, socket, id = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
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

async function navigate(query, width = 1540, height = 1060) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}?${query}` });
  await poll(() => evaluate('Boolean(window.editorPrototype)'));
  await evaluate('document.fonts.ready');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

async function capture(name) {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(path.join(images, name), Buffer.from(screenshot.data, 'base64'));
}

async function click(selector, dx = .5, dy = .5) {
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width*${dx},y:r.y+r.height*${dy}}})()`);
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
  await navigate('theme=dark&palette=gray&state=empty');
  await capture('01-dark-empty.png');
  await navigate('theme=dark&palette=gray&state=resume');
  await capture('02-dark-resume.png');
  await navigate('theme=dark&palette=gray&state=writing');
  await capture('03-dark-writing.png');
  await navigate('theme=light&palette=green&state=empty');
  await capture('04-light-empty.png');

  // Exercise real pointer events outside the text, then confirm selection restoration.
  await navigate('theme=dark&palette=gray&state=empty');
  await click('#paper', .8, .15);
  assert.equal(await evaluate('window.editorPrototype.getState().focused'), true, 'blank paper focuses empty editor');
  await send('Input.insertText', { text: '这里可以继续写。' });
  assert.equal(await evaluate('window.editorPrototype.getState().text.trim()'), '这里可以继续写。');
  await evaluate(`(()=>{const n=document.querySelector('#note-editor p').firstChild;const r=document.createRange();r.setStart(n,4);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
  await click('#theme');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await click('#paper', .9, .85);
  assert.equal(await evaluate('getSelection().anchorOffset'), 4, 'blank click restores last caret');
  await send('Input.insertText', { text: '插入' });
  assert.equal(await evaluate('window.editorPrototype.getState().text.trim()'), '这里可以插入继续写。');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".empty-help")).visibility'), 'hidden');

  const checks = [];
  for (const theme of ['dark', 'light']) {
    for (const palette of ['green','blue','orange','gray','pink']) {
      for (const width of [1540,1183,1024]) {
        await navigate(`theme=${theme}&palette=${palette}&state=empty`, width, 1060);
        const geometry = await evaluate(`(()=>{const r=document.querySelector('#note-editor').getBoundingClientRect();const p=document.querySelector('#paper').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,editorInside:r.left>=p.left&&r.right<=p.right&&r.top>=p.top&&r.bottom<=p.bottom,placeholderColor:getComputedStyle(document.querySelector('#note-editor'),'::before').color,paperColor:getComputedStyle(document.querySelector('#paper')).backgroundColor}})()`);
        assert.equal(geometry.overflow, false, `${theme} ${palette} ${width}: horizontal overflow`);
        assert.equal(geometry.editorInside, true, `${theme} ${palette} ${width}: editable line clipped`);
        checks.push({theme,palette,width,...geometry});
      }
    }
  }
  await navigate('theme=dark&palette=gray&state=empty',1183,1060);
  await capture('05-compact-empty.png');
  await navigate('theme=dark&palette=gray&state=empty');
  await click('#typewriter');
  assert.equal(await evaluate('document.querySelector("#paper").classList.contains("typewriter")'), false);
  assert.equal(await evaluate('document.querySelector("#note-editor").getBoundingClientRect().top-document.querySelector("#paper").getBoundingClientRect().top < 60'), true);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({scope:'Standalone Chrome prototype; production editor unchanged',checks,interaction:['Blank paper focuses editor','Typing removes placeholder','Blank paper restores previous caret without appending text','Focused helper is hidden','Typewriter toggle works'],runtimeErrors:errors},null,2)+'\n');
  console.log(`Rendered 5 images. Verified 30 theme/viewport combinations and blank-click caret restoration.`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, 'exit'); browser.kill();
    await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,4000))]);
  }
  for(const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closed')); }
  // Cleanup is restricted to the exact temporary directory created above.
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
