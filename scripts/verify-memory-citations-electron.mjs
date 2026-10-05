import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'memory-citations-electron-'));
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const screenshots = path.resolve('output/verification/memory-citations');
const sourceText = '请你记住我不是Java程序员了，我现在是python程序员';
const question = '我现在的职业是什么';
let session, usedReference;
const modelRequests = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  response.setHeader('Content-Type', 'application/json');
  if (request.url.endsWith('/api/tags') || request.url.endsWith('/api/ps')) return response.end(JSON.stringify({ models: [{ name: 'memory-citation-fixture' }] }));
  if (request.url.endsWith('/api/show')) return response.end(JSON.stringify({ model_info: { 'test.context_length': 32768 } }));
  if (request.url.endsWith('/api/generate') || request.url.endsWith('/api/chat')) {
    const prompt = `${body.system || ''}\n${body.prompt || ''}\n${JSON.stringify(body.messages || [])}`;
    const reference = /\[记忆(\d+)\][^\n]*我不是Java程序员了/u.exec(prompt)?.[1];
    if (body.stream && reference && prompt.includes(question)) usedReference = Number(reference);
    modelRequests.push({ stream: Boolean(body.stream), reference: reference ? Number(reference) : null });
    const answer = body.stream ? usedReference && prompt.includes(question)
      ? `你现在的职业是 **Python 程序员**。[记忆${usedReference}]\n\n你之前说过：“我不是Java程序员了，我现在是python程序员。”\n\n\`\`\`text\n[记忆${usedReference}] 是代码示例，不是引用。\n\`\`\``
      : '收到。长期记忆保存状态请查看应用回执。'
      : JSON.stringify(body.format?.properties?.rewrite_query ? { rewrite_query: question, intent: 'chitchat', image_description: '' } : { suggestions: [] });
    if (body.stream) response.setHeader('Content-Type', 'application/x-ndjson');
    return response.end(JSON.stringify({ response: answer, message: { role: 'assistant', content: answer }, done: true, prompt_eval_count: 60, eval_count: 80 }) + '\n');
  }
  response.statusCode = 404; response.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const call = expression => session.evaluate(expression);
async function screenshot(name) {
  await waitFor(() => call("!document.getElementById('startup-splash')"), 'startup overlay removed');
  await call("document.fonts.ready");
  await call("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
  await call("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const image = await session.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(screenshots, name), Buffer.from(image.data, 'base64'));
}
async function openAssistant() {
  await waitFor(() => call("Boolean(document.querySelector('.app-nav-item[aria-label=\"助手\"]')) && !document.getElementById('startup-splash')"), 'ready application');
  await click('.app-nav-item[aria-label="助手"]');
  await waitFor(() => call("Boolean([...document.querySelectorAll('textarea[aria-label=\"向 AI 助手输入问题\"]')].find(n=>n.getBoundingClientRect().width && !n.disabled))"), 'assistant composer');
}
async function click(selector) {
  const point = await call(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function restoreAnswer() {
  await click('button[aria-label="打开历史记忆"]');
  await waitFor(() => call("Boolean([...document.querySelectorAll('.qa-memory-session')].find(n=>n.textContent.includes('我现在的职业是什么')))"), 'saved answer session');
  await call("[...document.querySelectorAll('.qa-memory-session')].find(n=>n.textContent.includes('我现在的职业是什么')).click()");
  await waitFor(() => call("Boolean(document.querySelector('a[data-memory-reference]'))"), 'restored inline citation');
  await click('a[data-memory-reference]');
  await waitFor(() => call("Boolean(document.querySelector('.assistant-memory-citation-detail'))"), 'restored snapshot');
}
async function openSource() {
  await click('.assistant-memory-citation-footer button');
  await waitFor(() => call("Boolean(document.querySelector('.assistant-memory-source-quote') || document.querySelector('.assistant-memory-source-modal')?.textContent.includes('原始对话已删除'))"), 'source modal');
}
async function closeModal() {
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(() => call("!document.querySelector('.assistant-memory-source-modal [role=dialog]')"), 'closed source modal');
}

try {
  for (const directory of [userData, path.dirname(mainEntry), screenshots]) await fs.mkdir(directory, { recursive: true });
  const provider = { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'memory-citation-fixture', contextWindowTokens: 32768 };
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: path.join(temporary, 'workspace'), onboarding: { version: 1, status: 'skipped' }, aiModelSettings: { defaultProfileId: 'model_memory_citation_fixture', profiles: [{ id: 'model_memory_citation_fixture', label: 'Memory citation fixture', config: provider }] }, appPreferences: { theme: 'dark', lightColorScheme: 'gray', language: 'zh-CN', assistantWebSearchDefault: 'off' } }));
  await Promise.all([
    ...[['main', ['electron', 'better-sqlite3']], ['preload', ['electron']], ['externalWebPreload', ['electron']], ['knowledge/noteIndexWorker', []], ['pipeline/mammothWorker', []], ['workspaceMigrationWorker', ['better-sqlite3']]].map(([entry, external]) => build({ entryPoints: [`electron/${entry}.ts`], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), bundle: true, platform: 'node', external, logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData, navigationLabel: '助手' });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await call("(async()=>{const state=await window.electronAPI.getOnboardingState();if(['pending','active'].includes(state.status))await window.electronAPI.updateOnboardingState({action:'defer',expectedRevision:state.revision});await window.electronAPI.saveLongTermMemoryWorkspaceConfig({enabled:true,writeMode:'explicit_only'});await window.electronAPI.createLongTermMemoryItem({kind:'profile',content:'我是Java程序员',topic:'职业'});await window.electronAPI.createLongTermMemoryItem({kind:'profile',content:'我是Python程序员',topic:'职业'});window.__memoryCitationEvents=[];window.electronAPI.onAssistantTurnEvent(e=>window.__memoryCitationEvents.push(e));})()");
  const sourceRequest = { requestId: `assistant_memory_citation_source_${Date.now()}`, intent: 'ask', scope: 'chat', userText: sourceText, conversation: [], modelProfileId: 'model_memory_citation_fixture', thinkingMode: 'simple', webSearch: 'off' };
  await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(sourceRequest)})`);
  await waitFor(() => call(`window.__memoryCitationEvents.some(e=>e.requestId===${JSON.stringify(sourceRequest.requestId)}&&(e.type==='complete'||e.type==='error'))`), 'source turn');
  const sourceResult = await call(`window.__memoryCitationEvents.find(e=>e.requestId===${JSON.stringify(sourceRequest.requestId)}&&(e.type==='complete'||e.type==='error'))`);
  assert.equal(sourceResult.type, 'complete', sourceResult.message);
  const explicit = await call(`(async()=>{const page=await window.electronAPI.listLongTermMemoryItems({statuses:['active']});return page.items.find(item=>item.sourceMessageId===${JSON.stringify(sourceRequest.requestId)})})()`);
  assert.ok(explicit, 'explicit source memory is active');
  await openAssistant();
  await call("[...document.querySelectorAll('textarea[aria-label=\"向 AI 助手输入问题\"]')].find(n=>n.getBoundingClientRect().width).focus()");
  await session.send('Input.insertText', { text: question });
  await call("[...document.querySelectorAll('button[aria-label=\"发送\"]')].find(n=>n.getBoundingClientRect().width).click()");
  await waitFor(() => call("Boolean(document.querySelector('.assistant-memory-citations button[data-memory=true]'))"), 'memory capsule');
  await waitFor(() => call("Boolean(document.querySelector('.assistant-message.complete a[data-memory-reference]'))"), 'registered inline memory reference');
  assert.ok(usedReference > 0);
  const event = await call("window.__memoryCitationEvents.filter(e=>e.type==='memory-used').at(-1)");
  const registered = event.items.find(item => item.itemId === explicit.id);
  assert.equal(registered.reference, usedReference);
  const answerTurnId = event.requestId;
  const saved = await call(`window.electronAPI.getLongTermMemoryUsedForTurn(${JSON.stringify(answerTurnId)})`);
  assert.ok(saved.some(item => item.itemId === explicit.id && item.reference === usedReference));
  assert.equal(await call("document.querySelector('.assistant-memory-citation-detail') === null"), true);
  assert.equal(await call("getComputedStyle(document.querySelector('.assistant-memory-citations button')).borderRadius"), '999px');
  assert.equal(await call("document.querySelectorAll('.assistant-memory-citations button[data-memory=true]').length"), 1);
  assert.equal(await call("document.querySelectorAll('.assistant-markdown-content pre a[data-memory-reference]').length"), 0);
  await screenshot('01-dark-capsule.png');
  await click('a[data-memory-reference]');
  await waitFor(() => call("Boolean(document.querySelector('.assistant-memory-citation-detail'))"), 'expanded memory snapshot');
  assert.match(await call("document.querySelector('.assistant-memory-citation-detail pre').textContent"), /我不是Java程序员了/u);
  await screenshot('02-dark-expanded.png');
  await click('.assistant-memory-citations button[data-memory=true]');
  await waitFor(() => call("!document.querySelector('.assistant-memory-citation-detail')"), 'collapsed source');
  await click('.assistant-memory-citations button[data-memory=true]');
  await waitFor(() => call("Boolean(document.querySelector('.assistant-memory-citation-detail'))"), 'capsule opens source');
  await openSource();
  assert.equal(await call("document.querySelector('.assistant-memory-source-quote').textContent"), sourceText);
  await screenshot('03-original-conversation.png');
  await closeModal();
  await call(`window.electronAPI.deleteLongTermMemoryItem(${JSON.stringify(explicit.id)})`);
  assert.equal((await call(`window.electronAPI.getLongTermMemoryCitationSource(${JSON.stringify(answerTurnId)},${JSON.stringify(explicit.id)})`)).status, 'available');
  await call(`window.electronAPI.deleteQaMemorySession(${JSON.stringify(sourceResult.result.qaSessionId)})`);
  await openSource();
  assert.ok(await call("document.querySelector('.assistant-memory-source-modal').textContent.includes('原始对话已删除或不可用')"));
  await screenshot('04-source-deleted.png');
  await closeModal();
  await session.closeWindow(); await session.exited; await session.dispose();
  session = await launchNoteTest({ mainEntry, userData, navigationLabel: '助手' });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await restoreAnswer();
  assert.match(await call("document.querySelector('.assistant-memory-citation-detail pre').textContent"), /我不是Java程序员了/u);
  const restored = await call(`window.electronAPI.getLongTermMemoryUsedForTurn(${JSON.stringify(answerTurnId)})`);
  assert.deepEqual(restored, saved);
  await screenshot('05-restarted-history.png');
  await call("window.electronAPI.saveAppPreferences({theme:'light',lightColorScheme:'gray'})");
  await session.send('Page.reload', { ignoreCache: true });
  await waitFor(() => call("document.documentElement?.dataset.theme==='light'"), 'light theme');
  await openAssistant();
  await restoreAnswer();
  await screenshot('06-light-expanded.png');
  await session.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 860, deviceScaleFactor: 1, mobile: false });
  assert.equal(await call("(()=>{const p=document.querySelector('.assistant-memory-citations');return p.scrollWidth>p.clientWidth})()"), false);
  await screenshot('07-compact.png');
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/memory-citations-electron.json'), JSON.stringify({ scope: 'Isolated real Electron/main/preload/React and SQLite; model responses use a local fixture', originalUserDataModified: false, registeredReference: usedReference, snapshotCount: saved.length, checks: ['Prompt numbering matches emitted and stored snapshots', 'Inline capsule and source capsule toggle the same panel', 'Code markers remain code', 'Original source shown through the restricted production IPC', 'Memory deletion preserves the source', 'Source conversation deletion preserves the answer snapshot', 'Full Electron restart restores references and provenance', 'Dark/light and compact viewport'], modelRequests, screenshots }, null, 2) + '\n');
  console.log('Memory citation Electron UI, source IPC, deletion, restart and theme acceptance passed.');
} finally {
  await session?.dispose();
  await new Promise(resolve => server.close(resolve));
  if (!path.resolve(temporary).startsWith(staging + path.sep)) throw new Error('Test cleanup outside staging');
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
