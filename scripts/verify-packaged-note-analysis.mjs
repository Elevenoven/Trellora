import { installFixtureNoteSave } from './cdp-note-save.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const rootDir = process.cwd();
const executablePath = path.resolve(process.argv[2] ?? '');
assert.ok(executablePath && existsSync(executablePath), 'Pass the portable EXE path to verify.');
const testRoot = path.join(rootDir, '.package-staging', 'verify-packaged-note-analysis');
const workspaceDir = path.join(testRoot, 'workspace');
const userDataDir = path.join(testRoot, 'user-data');
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
writeFileSync(path.join(workspaceDir, 'Existing.md'), '# Existing\n\nExisting content.', 'utf8');
writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ libraryPath: workspaceDir }), 'utf8');

const ollama = createServer(async (request, response) => {
  if (request.url === '/api/tags') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'test-generation' }] }));
    return;
  }
  if (request.url === '/api/generate' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');
    if (payload.stream === true) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ response: '这是本地' })}\n`);
      response.end(`${JSON.stringify({ response: '流式回答。', done: true })}\n`);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ response: JSON.stringify({
      summary: 'Trellora 是一款本地优先的知识管理系统。'.repeat(24),
      keyPoints: ['一次分析产出全部笔记派生信息。'],
      tagCandidates: [{ name: '本地优先', confidence: 'high', evidence: '正文明确说明“本地优先”。' }],
    }) }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
ollama.unref();
const address = ollama.address();
assert.ok(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}`;

const child = spawn(executablePath, [`--user-data-dir=${userDataDir}`, '--remote-debugging-port=9342'], {
  cwd: path.dirname(executablePath),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const page = await waitForPage(9342, child);
  const cdp = await connectToCdp(page.webSocketDebuggerUrl);
  await installFixtureNoteSave(cdp);
  await waitFor(async () => await cdp.evaluate("typeof window.electronAPI?.generateNoteAnalysis === 'function'"), 'unified analysis API');
  assert.deepEqual((await cdp.evaluate('window.electronAPI.listFiles()')).map((entry) => entry.name), ['Existing.md']);
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"笔记\"]'))"), 'notes navigation');
  await cdp.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.knowledge-panel'))"), 'notes panel');
  await cdp.evaluate(`window.electronAPI.saveAiProviderConfig(${JSON.stringify({ kind: 'ollama', endpoint, model: 'test-generation' })})`);

  const notePath = await cdp.evaluate("window.electronAPI.createFile('统一笔记分析', null)");
  assert.equal(await cdp.evaluate(`globalThis.__saveNoteFixture(${JSON.stringify(notePath)}, '# 统一笔记分析\\n\\nTrellora 是一款本地优先的知识管理系统。')`), true);
  await waitFor(async () => await cdp.evaluate(`[...document.querySelectorAll('.file-tree-row')].some((node) => node.textContent?.includes('统一笔记分析'))`), 'new note in tree');
  await cdp.evaluate(`[...document.querySelectorAll('.file-tree-row')].find((node) => node.textContent?.includes('统一笔记分析'))?.click()`);
  await waitFor(async () => await cdp.evaluate("document.querySelector('.knowledge-note-title')?.textContent?.includes('统一笔记分析')"), 'selected note metadata');

  const infoText = await cdp.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  for (const label of ['概览', '智能建议']) assert.match(infoText, new RegExp(label));
  assert.doesNotMatch(infoText, /属性/);
  assert.doesNotMatch(infoText, /连接|引用|被引用|相关|关联地图/);
  assert.equal(await cdp.evaluate('typeof window.electronAPI.getKnowledgeGraph'), 'undefined');
  await cdp.evaluate(`[...document.querySelectorAll('.knowledge-section')].find((node) => node.querySelector('h4')?.textContent?.includes('概览'))?.querySelector('button')?.click()`);
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.note-tag-suggestion'))"), 'unified analysis result');
  const analysisText = await cdp.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  assert.match(analysisText, /正文明确说明“本地优先”/);
  const fresh = await cdp.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(notePath)})`);
  assert.equal(fresh?.isStale, undefined);
  assert.equal(fresh?.tagCandidates?.[0]?.confidence, 'high');

  assert.equal(await cdp.evaluate(`globalThis.__saveNoteFixture(${JSON.stringify(notePath)}, '# 统一笔记分析\\n\\n正文内容已更新。')`), true);
  await waitFor(async () => (await cdp.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(notePath)})`))?.isStale === true, 'stale note analysis');
  await cdp.evaluate(`[...document.querySelectorAll('.knowledge-tabs button')].find((node) => node.textContent?.includes('AI 助手'))?.click()`);
  const assistantText = await cdp.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''");
  assert.doesNotMatch(assistantText, /摘要与标签|实体与关系/);
  assert.match(assistantText, /知识问答/);
  await waitFor(async () => await cdp.evaluate("document.querySelector('.assistant-composer-control')?.textContent !== '未配置模型'"), 'assistant model profile refresh');
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[aria-label="向 AI 助手输入问题"]');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('Assistant composer is unavailable.');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(input, '请用一句话回答这篇笔记的主题。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[aria-label="发送"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await waitFor(async () => /这是本地流式回答。/.test(await cdp.evaluate("document.querySelector('.assistant-message-list')?.innerText ?? ''")), 'streamed assistant answer');
  assert.equal(await cdp.evaluate(`window.electronAPI.readFile(${JSON.stringify(notePath)})`), '# 统一笔记分析\n\n正文内容已更新。');
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.ProseMirror p'))"), 'rich-text editor');
  await cdp.evaluate(`(() => {
    const paragraph = document.querySelector('.ProseMirror p');
    if (!(paragraph instanceof HTMLElement)) throw new Error('Editor paragraph is unavailable.');
    const rect = paragraph.getBoundingClientRect();
    paragraph.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: rect.left + 8, clientY: rect.top + 12, bubbles: true,
    }));
  })()`);
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.selection-context-menu'))"), 'editor context menu');
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"设置\"]'))"), 'settings navigation');
  await cdp.evaluate("document.querySelector('.app-nav-item[aria-label=\"设置\"]')?.click()");
  await waitFor(async () => await cdp.evaluate("Boolean(document.querySelector('.settings-mantine-modal-content'))"), 'settings modal');
  assert.equal(await cdp.evaluate("!document.querySelector('.selection-context-menu') && !document.querySelector('[data-drag-handle]')"), true);
  console.log('Packaged unified note analysis verification passed');
  cdp.close();
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
} finally {
  await terminateProcessTree(child.pid);
  await new Promise((resolve) => ollama.close(resolve));
}

async function waitForPage(port, process) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Packaged app exited with code ${process.exitCode}.`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((entry) => entry.type === 'page' && entry.url?.startsWith('file:'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(200);
  }
  throw new Error('Timed out waiting for packaged renderer.');
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function connectToCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    evaluate: async (expression) => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    },
    close: () => socket.close(),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateProcessTree(processId) {
  if (!processId) return;
  await new Promise((resolve) => {
    const taskkill = spawn('taskkill', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    taskkill.once('exit', resolve);
    taskkill.once('error', resolve);
  });
}
