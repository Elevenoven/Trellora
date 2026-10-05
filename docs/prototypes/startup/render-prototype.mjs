import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Render the independent prototype without starting Electron or reading user data.
const directory = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.env.TRELLORA_PROTOTYPE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ffmpeg = process.env.TRELLORA_PROTOTYPE_FFMPEG || 'D:/FFmpeg/bin/ffmpeg.exe';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-startup-prototype-'));
const images = path.join(directory, 'images');
await fs.mkdir(images, { recursive: true });
const frames = path.join(temporary, 'frames');
await fs.mkdir(frames);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = pathToFileURL(path.join(directory, 'index.html')).href;
let browser, socket, counter = 0;
const pending = new Map();
const issues = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}

async function poll(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Browser page did not become ready');
}

async function navigate(query, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}?${query}` });
  await poll(() => evaluate('Boolean(window.startupPrototype)'));
  await evaluate('document.fonts.ready');
  await evaluate('window.startupPrototype.freeze()');
}

async function capture(destination) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(destination, Buffer.from(result.data, 'base64'));
}

try {
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(temporary, 'profile')}`, `${base}?view=board`], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let target;
  await poll(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); return Boolean(target?.webSocketDebuggerUrl); }
    catch { return false; }
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    if (reply.method === 'Runtime.exceptionThrown') issues.push(reply.params.exceptionDetails.text);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id); clearTimeout(task.timer);
    reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result);
  });
  await send('Runtime.enable');
  await send('Page.enable');

  await navigate('view=board', 1440, 1120);
  const boardHeight = await evaluate('document.documentElement.scrollHeight');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: boardHeight, deviceScaleFactor: 1, mobile: false });
  await capture(path.join(images, 'startup-overview.png'));

  for (const theme of ['green', 'blue', 'orange', 'gray', 'pink', 'dark']) {
    await navigate(`view=focus&theme=${theme}`, 660, 410);
    await capture(path.join(images, `startup-${theme}.png`));
  }

  // Check theme controls and both ends of the illustrated animation in Chrome.
  await navigate('', 1440, 1120);
  await evaluate('document.querySelector("[data-palette=pink]").click(); window.startupPrototype.freeze()');
  assert.equal(await evaluate('window.startupPrototype.getState().selected'), 'pink');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("primary")).backgroundColor'), 'rgb(252, 247, 249)');
  await evaluate('window.startupPrototype.play()');
  await poll(() => evaluate('window.startupPrototype.getState().exiting'));
  await evaluate('new Promise(resolve => setTimeout(resolve, 420))');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#primary .workspace")).opacity'), '1');

  for (const width of [375, 768, 1440]) {
    await navigate('view=board', width, 1120);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `Horizontal overflow at ${width}`);
  }
  assert.deepEqual(issues, []);

  // Pause CSS animations at deterministic times to export a looping motion study.
  await navigate('view=focus&theme=green', 660, 410);
  for (let index = 0; index < 56; index++) {
    const time = index * 50;
    await evaluate(`(() => {
      window.startupPrototype.freeze();
      const el = document.getElementById('primary');
      el.classList.add('animated');
      if (${time} >= 950) el.classList.add('exiting');
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = ['splash-out', 'workspace-in'].includes(animation.animationName) ? ${Math.max(0, time - 950)} : ${time};
      }
    })()`);
    await capture(path.join(frames, `${String(index).padStart(3, '0')}.png`));
  }
  const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '20', '-i', path.join(frames, '%03d.png'), '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0', path.join(images, 'startup-motion.gif')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let encodingErrors = '';
  encoder.stderr.on('data', data => { encodingErrors += data; });
  const [encoderCode] = await once(encoder, 'exit');
  assert.equal(encoderCode, 0, encodingErrors);
  console.log(JSON.stringify({ rendered: ['startup-overview.png', 'startup-{green,blue,orange,gray,pink,dark}.png', 'startup-motion.gif'], checked: ['theme switching', 'transition to the illustrative workspace', '375/768/1440px overflow', 'no browser exceptions'], output: images, boundary: 'standalone visual prototype only' }, null, 2));
} finally {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closing')); }
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await Promise.race([once(browser, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('trellora-startup-prototype-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
