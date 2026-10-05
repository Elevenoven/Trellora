import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Render only the standalone prototype in an isolated headless browser.
const directory = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.env.TRELLORA_PROTOTYPE_CHROME
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-first-use-prototype-'));
const output = path.join(directory, 'images');
await fs.mkdir(output, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
let browser, socket, diagnostics = '';
const pending = new Map();
let id = 0;
const results = [];

async function poll(check, label) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}. ${diagnostics.slice(-1500)}`);
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result.value;
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function screenshot(name) {
  await evaluate('document.fonts.ready');
  const image = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(output, name), Buffer.from(image.data, 'base64'));
}

try {
  browser = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${temporary}`,
    pathToFileURL(path.join(directory, 'index.html')).href,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout.on('data', chunk => { diagnostics += chunk; });
  browser.stderr.on('data', chunk => { diagnostics += chunk; });
  let target;
  await poll(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
        .find(item => item.type === 'page' && item.url.startsWith('file:'));
      return Boolean(target?.webSocketDebuggerUrl);
    } catch { return false; }
  }, 'Chrome page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data), task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    clearTimeout(task.timer);
    reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result);
  });
  await poll(() => evaluate('Boolean(window.prototype)'), 'prototype ready');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.querySelectorAll(".menu-item").length'), 7);
  await click('[data-menu="sources"]');
  assert.match(await evaluate('document.querySelector(".menu-detail").textContent'), /PDF、DOCX/);
  await click('[data-menu="assistant"]');
  await screenshot('01-menus.png');
  await click('[data-action="to-config"]');
  assert.equal(await evaluate('document.querySelector("[data-action=to-question]").disabled'), true);
  await screenshot('02-ai-config.png');
  await click('[data-action="fill"]');
  await evaluate('document.getElementById("test-result").value="failure"');
  await click('[data-action="test"]');
  assert.equal(await evaluate('window.prototype.getState().tested'), false);
  await screenshot('06-connection-failure.png');
  await click('[data-action="save"]');
  assert.equal(await evaluate('window.prototype.getState().saved'), true, 'A failed catalog test does not prevent saving valid settings');
  assert.equal(await evaluate('document.querySelector("[data-action=to-question]").disabled'), true);
  assert.match(await evaluate('document.querySelector(".model-card .error").textContent'), /连接检测失败/);
  await screenshot('09-saved-unverified.png');
  await click('[data-action="try-question"]');
  assert.equal(await evaluate('window.prototype.getState().scene'), 'question');
  assert.equal(await evaluate('window.prototype.getState().answer'), false, 'The manual verification path never sends automatically');
  await click('[data-action="to-config"]');
  await evaluate('document.getElementById("test-result").value="success"');
  await click('[data-action="test"]');
  assert.equal(await evaluate('window.prototype.getState().tested'), true);
  await click('[data-action="save"]');
  assert.equal(await evaluate('window.prototype.getState().saved'), true);
  await evaluate('document.getElementById("model").value="changed-model";document.getElementById("model").dispatchEvent(new Event("input",{bubbles:true}))');
  assert.equal(await evaluate('window.prototype.getState().tested'), false, 'Changing the model invalidates the old test');
  assert.equal(await evaluate('document.querySelector("[data-action=to-question]").disabled'), true);
  await click('[data-action="fill"]');
  await click('[data-action="test"]');
  await click('[data-action="save"]');
  await screenshot('02b-ai-config-ready.png');
  await click('[data-action="to-question"]');
  await click('[data-action="sample"]');
  assert.equal(await evaluate('window.prototype.getState().answer'), false, 'Choosing a sample never sends it');
  await screenshot('03-first-question.png');
  await click('[data-action="send"]');
  await poll(() => evaluate('window.prototype.getState().answer'), 'demo answer');
  await screenshot('04-first-answer.png');
  await click('[data-action="finish"]');
  assert.equal(await evaluate('window.prototype.getState().scene'), 'complete');
  await screenshot('05-complete.png');
  await click('[data-action="continue-chat"]');
  assert.equal(await evaluate('Boolean(document.querySelector(".pause,.guide-side,.guidebar"))'), false, 'Finished users continue in the preserved conversation');
  assert.equal(await evaluate('window.prototype.getState().answer'), true);
  await click('#reset');
  await click('[data-action="to-config"]');
  await click('[data-action="preview"]');
  assert.equal(await evaluate('window.prototype.getState().saved'), false);
  assert.equal(await evaluate('document.querySelector("[data-action=send]").disabled'), true, 'Without a model, the preview cannot send');
  await evaluate('window.prototype.setScene("question")');
  await click('[data-action="defer"]');
  await click('[data-action="confirm-defer"]');
  assert.equal(await evaluate('window.prototype.getState().deferred'), true);
  await click('[data-action="resume"]');
  assert.equal(await evaluate('window.prototype.getState().scene'), 'question');
  await evaluate('window.prototype.setScene("config")');
  await click('[data-action="defer"]');
  await click('[data-action="confirm-defer"]');
  assert.equal(await evaluate('Boolean(document.querySelector(".guide-side"))'), false, 'Pausing also hides configuration teaching');
  await evaluate('window.prototype.setScene("config")');
  await evaluate('window.prototype.setTheme("dark")');
  await screenshot('07-dark-config.png');
  results.push({ check: 'menu explanations, configuration success/failure, saved-but-unverified manual path, changed-model invalidation, no-model preview, sample draft, answer, finish with preserved conversation, defer/resume', passed: true });

  for (const viewport of [{ width: 1440, height: 960 }, { width: 1024, height: 768 }, { width: 900, height: 700 }, { width: 375, height: 900 }]) {
    await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      for (const scene of ['menus', 'config', 'question', 'complete']) {
        await evaluate(`window.prototype.setTheme(${JSON.stringify(theme)});window.prototype.setScene(${JSON.stringify(scene)})`);
        const fits = await evaluate(`(()=>{
          const app=document.getElementById('app'),tour=document.querySelector('.tour-card');
          const rect=tour?.getBoundingClientRect(),outer=app.getBoundingClientRect();
          return {horizontal:document.documentElement.scrollWidth<=innerWidth+1,
            tourFits:!rect||(rect.right<=outer.right+1&&rect.left>=outer.left-1&&rect.bottom<=outer.bottom+1)};
        })()`);
        assert.ok(fits.horizontal, `${viewport.width} ${theme} ${scene}: horizontal overflow`);
        assert.ok(fits.tourFits, `${viewport.width} ${theme} ${scene}: menu card clipped`);
        results.push({ viewport, theme, scene, ...fits });
      }
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.prototype.setTheme("light");window.prototype.setScene("config")');
  await screenshot('08-compact-config.png');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), method: 'Isolated headless Chrome CDP; static HTML prototype only; no application IPC or live model calls', results,
  }, null, 2));
  console.log(`Prototype verified: ${results.length} checks; images saved to ${output}`);
} finally {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closing')); }
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await Promise.race([once(browser, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  const resolvedTemporary = path.resolve(temporary);
  assert.equal(path.dirname(resolvedTemporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolvedTemporary).startsWith('trellora-first-use-prototype-'));
  await fs.rm(resolvedTemporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
