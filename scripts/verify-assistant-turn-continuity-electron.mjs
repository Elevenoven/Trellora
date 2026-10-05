import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

// 使用独立数据目录和本地 HTTP 模型，原生产 IPC、React 与 SQLite 均实际运行。
const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'assistant-continuity-'));
const userData = path.join(temporary, 'user-data');
const libraryPath = path.join(temporary, 'notes');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const checks = [], requests = [];
const composerExpression = `[...document.querySelectorAll('textarea[aria-label="向 AI 助手输入问题"]')].find(input=>input.getBoundingClientRect().width>0&&input.getBoundingClientRect().height>0)`;
let session, streamCount = 0, structuredAnswerCount = 0;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  const json = value => res.end(JSON.stringify(value));
  if (req.url === '/api/tags' || req.url === '/api/ps') return json({ models: [{ name: 'continuity-fixture', context_length: 32768 }] });
  if (req.url === '/api/show') return json({ model_info: { 'fixture.context_length': 32768 } });
  if (req.url === '/api/generate') {
    const prompt = body.prompt ?? '';
    requests.push({ prompt, stream: Boolean(body.stream) });
    if (body.stream) {
      const answer = `已完成答复 ${++streamCount}：澄川合同规定付款期限为30日。`;
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(JSON.stringify({ response: answer.slice(0, 5), done: false }) + '\n');
      if (prompt.includes('取消后新会话')) await delay(2400);
      if (!res.destroyed) res.end(JSON.stringify({ response: answer.slice(5), done: true, prompt_eval_count: 100, eval_count: 30 }) + '\n');
      return;
    }
    const value = body.format?.properties?.rewrite_query
      ? { rewrite_query: '澄川合同付款期限', intent: 'kb_only', image_description: '' }
      : body.format?.properties?.goals
        ? { goals: [{ goalId: 'payment', question: '澄川合同的付款期限是什么？', evidenceKind: 'fact', requirements: [{ requirementId: 'deadline', label: '付款期限', minEvidence: 1 }], queryTerms: ['澄川', '付款期限'] }] }
        : body.format?.properties?.suggestions
          ? { suggestions: [] }
          : { type: 'answer', answer: `已完成检索答复 ${++structuredAnswerCount}：澄川合同的付款期限为30日。`, citations: [], completeness: 'complete' };
    return json({ response: JSON.stringify(value), done: true });
  }
  res.statusCode = 404; json({ error: 'fixture endpoint unavailable' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

// 测试控制只增加读取探针和 preload 返回延迟，不替换生产问答或存储 handler。
const mainProbe = `
ipcMain.handle('assistant-continuity-test:snapshot', event => {
  assertInternalRenderer(event);
  const db = qaMemoryDatabase.getDatabase(getConfiguredWorkspacePath());
  return { turns: db.prepare('SELECT turn_id,session_id,user_text,status,result_metadata_json FROM qa_turns').all(),
    integrity: db.pragma('quick_check', { simple: true }), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() };
});`;
const preloadProbe = `
let continuityCreateDelay = 0;
async function continuityCreateSession(scope, libraryPath) {
  const wait = continuityCreateDelay;
  const session = await ipcRenderer.invoke('qa-memory:create-session', scope, libraryPath);
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  return session;
}
contextBridge.exposeInMainWorld('assistantContinuityTest', {
  snapshot: () => ipcRenderer.invoke('assistant-continuity-test:snapshot'),
  delaySession: value => { continuityCreateDelay = value; },
});`;
try {
  for (const directory of [userData, libraryPath, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
  const notePath = path.join(libraryPath, '澄川合同.md');
  const noteContent = '# 澄川合同\n\n澄川科技应在收到有效发票后30日内支付项目服务款。\n';
  await fs.writeFile(notePath, noteContent);
  const attachmentPath = path.join(temporary, '澄川付款约定.md');
  await fs.writeFile(attachmentPath, noteContent);
  const docxPath = path.join(temporary, '澄川项目合同.docx');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>澄川合同规定在收到有效发票后30日内支付项目服务款。</w:t></w:r></w:p></w:body></w:document>');
  const docxContent = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(docxPath, docxContent);
  const largeNotePath = path.join(libraryPath, '澄川项目手册.md');
  const largeNoteContent = '# 澄川项目手册\n\n' + Array.from({ length: 40 }, (_, index) => `第${index + 1}项：澄川合同付款期限为30日。`).join('\n');
  await fs.writeFile(largeNotePath, largeNoteContent);
  const provider = { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'continuity-fixture' };
  const now = new Date().toISOString();
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath, activeLibraryPath: libraryPath, workspacePath: path.join(temporary, 'workspace'),
    libraries: [{ path: libraryPath, alias: '连续问答验收', addedAt: now, lastOpenedAt: now }],
    aiProviderConfig: provider,
    aiModelSettings: { schemaVersion: 1, defaultProfileId: 'model_continuity_fixture', profiles: [{ id: 'model_continuity_fixture', label: '连续问答验收模型', config: provider }] },
    appPreferences: { theme: 'light', language: 'zh-CN' },
  }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], outfile: mainEntry, bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], logLevel: 'silent', plugins: [{ name: 'continuity-read-probe', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]main\.ts$/u }, async args => ({ loader: 'ts', contents: (await fs.readFile(args.path, 'utf8')).replace('// Global Error Handler for startup', 'app.disableHardwareAcceleration();\n// Global Error Handler for startup') + mainProbe }));
    } }] }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker', 'workspaceMigrationWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], logLevel: 'silent', plugins: entry === 'preload' ? [{ name: 'continuity-preload-delay', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]preload\.ts$/u }, async args => {
        const source = await fs.readFile(args.path, 'utf8');
        const replaced = source.replace("=> ipcRenderer.invoke('qa-memory:create-session', scope, libraryPath) as Promise<QaSessionSummary>", '=> continuityCreateSession(scope, libraryPath) as Promise<QaSessionSummary>');
        assert.notEqual(replaced, source, 'delayed fixture must wrap the actual session creation call');
        return { loader: 'ts', contents: replaced + preloadProbe };
      });
    } }] : [] })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  await launch();
  const chat = await call("window.electronAPI.createQaMemorySession('chat')");
  const attachments = await ingest([attachmentPath, docxPath]);
  const document = await complete({ sessionId: chat.sessionId, scope: 'chat', userText: '澄川合同的付款期限是多少？', attachments });
  assert.equal(document.qaSessionId, chat.sessionId);
  let detail = await call(`window.electronAPI.getQaMemorySession(${JSON.stringify(chat.sessionId)})`);
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.turns[0].assistantText, document.answer);
  const documentMetadata = JSON.parse((await snapshot()).turns.find(turn => turn.session_id === chat.sessionId).result_metadata_json);
  assert.equal(documentMetadata.route, 'chat');
  assert.equal(documentMetadata.attachments[0].name, '澄川付款约定.md');
  assert.ok(documentMetadata.attachments.some(attachment => attachment.kind === 'document' && attachment.name === '澄川项目合同.docx'));
  const beforeFollowup = requests.length;
  await complete({ sessionId: chat.sessionId, scope: 'chat', userText: '请继续解释刚才的付款约定。' });
  assert.ok(requests.slice(beforeFollowup).some(request => request.stream && request.prompt.includes(document.answer)));
  checks.push('real DOCX/text attachment answer and descriptors persist in the original chat; plain follow-up receives that answer');

  const noteSession = await call(`window.electronAPI.createAssistantMemorySession(${JSON.stringify(notePath)})`);
  const noteAnswer = await complete({ sessionId: noteSession.sessionId, scope: 'current-note', currentNotePath: notePath, userText: '澄川合同的付款期限是什么？请根据笔记回答。' });
  assert.equal(noteAnswer.contextMode, 'direct-full');
  const beforeNoteFollowup = requests.length;
  await complete({ sessionId: noteSession.sessionId, scope: 'current-note', currentNotePath: notePath, userText: '请继续解释前一轮的澄川合同付款结论。' });
  assert.ok(requests.slice(beforeNoteFollowup).some(request => request.stream && request.prompt.includes(noteAnswer.answer)));
  checks.push('current-note Direct follows the canonical completed history under the unchanged release observe default');
  const reactSession = await call(`window.electronAPI.createAssistantMemorySession(${JSON.stringify(largeNotePath)})`);
  const reactAnswer = await complete({ sessionId: reactSession.sessionId, scope: 'current-note', currentNotePath: largeNotePath, userText: '澄川项目手册中，合同付款期限是什么？' });
  assert.equal(reactAnswer.contextMode, 'react-search');
  const beforeReactFollowup = requests.length;
  await complete({ sessionId: reactSession.sessionId, scope: 'current-note', currentNotePath: largeNotePath, userText: '继续说明前一轮澄川项目手册的付款期限结论。' });
  assert.ok(requests.slice(beforeReactFollowup).some(request => request.prompt.includes(reactAnswer.answer)));
  checks.push('current-note ReAct planner/decision receives canonical completed history under the release observe default');

  await call(`document.querySelector('.app-nav-item[aria-label="助手"]').click()`);
  await waitFor(() => call("Boolean(document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]:not(:disabled)'))"), 'Q&A composer');
  await call('window.assistantContinuityTest.delaySession(500)');
  await enterDraft('同步发送锁验收');
  await call(`(() => { const input = ${composerExpression}; for (let n=0;n<2;n++) input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); })()`);
  await waitFor(async () => (await snapshot()).turns.some(turn => turn.user_text === '同步发送锁验收' && turn.status === 'complete'), 'single double-enter turn');
  assert.equal((await snapshot()).turns.filter(turn => turn.user_text === '同步发送锁验收').length, 1);
  checks.push('real React double Enter during delayed session creation produces exactly one canonical turn');

  await call(`document.querySelector('button[aria-label="新对话"]').click()`);
  await call('window.assistantContinuityTest.delaySession(1200)');
  await enterDraft('已取消的会话创建不得发送');
  await sendDraft();
  await waitFor(() => call("Boolean(document.querySelector('button[aria-label=\"停止生成\"]'))"), 'preparation is occupied');
  await call(`document.querySelector('button[aria-label="新对话"]').click()`);
  await call('window.assistantContinuityTest.delaySession(0)');
  await enterDraft('取消后新会话继续发送');
  await sendDraft();
  await waitFor(() => Promise.resolve(requests.some(request => request.stream && request.prompt.includes('取消后新会话'))), 'new conversation model request');
  await delay(1300);
  assert.equal(await call("Boolean(document.querySelector('button[aria-label=\"停止生成\"]'))"), true, 'the late old result must not release the new active request');
  await waitFor(async () => (await snapshot()).turns.some(turn => turn.user_text === '取消后新会话继续发送' && turn.status === 'complete'), 'new conversation completion');
  assert.equal((await snapshot()).turns.filter(turn => turn.user_text === '已取消的会话创建不得发送').length, 0);
  checks.push('new conversation invalidates delayed creation; its late result neither sends nor clears the newer request');

  await session.closeWindow();
  await waitFor(() => session.child.exitCode !== null, 'graceful Electron process exit', 15000);
  assert.equal(session.child.exitCode, 0);
  await session.dispose(); session = undefined;
  await launch();
  detail = await call(`window.electronAPI.getQaMemorySession(${JSON.stringify(chat.sessionId)})`);
  assert.equal(detail.turns.length, 2); assert.equal(detail.turns[0].assistantText, document.answer);
  const beforeRestartFollowup = requests.length;
  await complete({ sessionId: noteSession.sessionId, scope: 'current-note', currentNotePath: notePath, userText: '应用重启后，请继续澄川合同的付款讨论。' });
  assert.ok(requests.slice(beforeRestartFollowup).some(request => request.stream && request.prompt.includes(noteAnswer.answer)));
  const beforeReactRestartFollowup = requests.length;
  await complete({ sessionId: reactSession.sessionId, scope: 'current-note', currentNotePath: largeNotePath, userText: '重启后继续讨论澄川项目手册的付款约定。' });
  assert.ok(requests.slice(beforeReactRestartFollowup).some(request => request.prompt.includes(reactAnswer.answer)));
  const db = await snapshot(); assert.equal(db.integrity, 'ok'); assert.deepEqual(db.foreignKeys, []);
  assert.equal(await fs.readFile(notePath, 'utf8'), noteContent);
  assert.equal(await fs.readFile(attachmentPath, 'utf8'), noteContent);
  assert.deepEqual(await fs.readFile(docxPath), docxContent);
  assert.equal(await fs.readFile(largeNotePath, 'utf8'), largeNoteContent);
  checks.push('full Electron exit/restart restores attachment chat and current-note Direct/ReAct follow-up; original files and SQLite integrity remain intact');
  for (const check of checks) console.log(`PASS ${check}`);
  const evidence = { verifiedAt: new Date().toISOString(), method: 'real Electron/main/preload/React, isolated workspace, local controlled HTTP model, delayed preload session return, full process restart', checks, originalUserDataModified: false, containsSecretsOrAnswers: false };
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/assistant-turn-continuity.json'), JSON.stringify(evidence, null, 2));
} finally {
  if (session) await session.dispose();
  await new Promise(resolve => server.close(resolve));
  assert.ok(temporary.startsWith(staging + path.sep));
  await fs.rm(temporary, { recursive: true, force: true });
}

async function launch() {
  session = await launchNoteTest({ mainEntry, userData });
  await session.minimizeWindow();
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call("(async () => { const state = await window.electronAPI.getOnboardingState(); if (['pending','active'].includes(state.status)) await window.electronAPI.updateOnboardingState({ action:'defer',expectedRevision:state.revision }); })()");
  await call('window.__continuityEvents=[]; window.electronAPI.onAssistantTurnEvent(event=>window.__continuityEvents.push(event));');
}
function call(expression) { return session.evaluate(expression); }
function snapshot() { return call('window.assistantContinuityTest.snapshot()'); }
async function ingest(files) {
  await call("const attachmentInput=document.createElement('input'); attachmentInput.type='file'; attachmentInput.multiple=true; attachmentInput.id='continuity-file-input'; document.body.append(attachmentInput);");
  const { root } = await session.send('DOM.getDocument', {});
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#continuity-file-input' });
  await session.send('DOM.setFileInputFiles', { nodeId, files });
  return call("window.electronAPI.ingestAssistantDroppedFiles([...document.getElementById('continuity-file-input').files])");
}
async function complete(patch) {
  const request = { requestId: `assistant_continuity_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, intent: 'ask', conversation: [], modelProfileId: 'model_continuity_fixture', thinkingMode: 'simple', webSearch: 'off', ...patch };
  await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(request)})`);
  await waitFor(() => call(`window.__continuityEvents.some(event=>event.requestId===${JSON.stringify(request.requestId)}&&['complete','error','cancelled'].includes(event.type))`), request.requestId, 60000);
  const event = await call(`window.__continuityEvents.find(event=>event.requestId===${JSON.stringify(request.requestId)}&&['complete','error','cancelled'].includes(event.type))`);
  assert.equal(event.type, 'complete', event.message);
  return event.result;
}
async function enterDraft(text) {
  await waitFor(() => call(`Boolean((${composerExpression}) && !(${composerExpression}).disabled)`), 'available composer');
  await call(`(() => { const input=${composerExpression}; input.focus(); input.select(); })()`);
  await session.send('Input.insertText', { text });
  await waitFor(() => call(`(${composerExpression})?.value===${JSON.stringify(text)} && Boolean([...document.querySelectorAll('button[aria-label="发送"]')].find(button=>!button.disabled&&button.getBoundingClientRect().width>0))`), 'draft committed to React');
}
async function sendDraft() {
  await call(`[...document.querySelectorAll('button[aria-label="发送"]')].find(button=>!button.disabled&&button.getBoundingClientRect().width>0).click()`);
}
