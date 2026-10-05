import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchNoteTest, waitFor, delay } from './electron-note-test-session.mjs';

const executablePath = path.resolve(process.argv[2] ?? 'output/verification/memory-release-package/Trellora-1.0.0-portable-x64.exe');
await fs.access(executablePath);
const require = createRequire(import.meta.url);
const asar = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))('@electron/asar');
const archive = path.join(path.dirname(executablePath), 'win-unpacked/resources/app.asar');
for (const entry of ['main.js', 'preload.js', 'workspaceMigrationWorker.js']) {
  const current = await fs.readFile(path.resolve('dist-electron', entry));
  assert.equal(asar.extractFile(archive, `dist-electron/${entry}`).equals(current), true, `package ${entry} must match the current build`);
}
const rendererHtml = await fs.readFile(path.resolve('dist/index.html'));
assert.equal(asar.extractFile(archive, 'dist/index.html').equals(rendererHtml), true);
for (const entry of [...rendererHtml.toString().matchAll(/(?:src|href)="\.\/assets\/(index-[^"]+\.(?:js|css))"/gu)].map(match => match[1])) {
  assert.equal(asar.extractFile(archive, path.join('dist', 'assets', entry)).equals(await fs.readFile(path.resolve('dist/assets', entry))), true, `package renderer ${entry} must match the current build`);
}
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'memory-portable-'));
const userData = path.join(temporary, 'user-data'), workspace = path.join(temporary, 'workspace');
const screenshots = path.resolve('output/verification/memory');
const originalMode = process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE;
let session, extractions = 0;
const prompts = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url.endsWith('/api/tags')) return reply({ models: [{ name: 'memory-fixture' }] });
  if (req.url.endsWith('/api/show')) return reply({ model_info: { 'model.context_length': 32768 } });
  if (req.url.endsWith('/api/ps')) return reply({ models: [] });
  if (!req.url.endsWith('/api/generate')) { res.statusCode = 404; return reply({ error: 'unknown fixture endpoint' }); }
  if (body.stream) {
    prompts.push(body.prompt); res.setHeader('content-type', 'application/x-ndjson');
    return res.end(JSON.stringify({ response: '已了解你的回答偏好。', done: true }) + '\n');
  }
  let value = { suggestions: [] };
  if (body.format?.properties?.decisions) {
    extractions++;
    const transcript = body.prompt.split('<new_user_messages>').at(-1).split('</new_user_messages>')[0];
    const id = transcript.match(/^\[([^\]]+)\]/mu)?.[1]; assert.ok(id);
    value = { schemaVersion: 2, topics: ['企业授信'], decisions: [{ operation: 'add', targetItemId: null, relation: 'independent', evidenceQuote: transcript.match(/^\[[^\]]+\] (.*)$/mu)?.[1] ?? '', kind: 'preference', content: '用户偏好简体中文企业授信案例', topic: null, importance: 3, inferred: true, sourceMessageId: id, expiresAt: null }] };
  } else if (body.format?.properties?.merge) value = { merge: true, statement: '偏好深色且紧凑的界面布局', topic: '界面偏好', importance: 4 };
  else if (body.format?.properties?.normalizedKey) value = { normalizedKey: null };
  reply({ response: JSON.stringify(value), done: true, done_reason: 'stop' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [];
const snapshot = () => {
  const result = spawnSync('python', ['-c', `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
print(json.dumps({'version':c.execute('PRAGMA user_version').fetchone()[0], 'integrity':c.execute('PRAGMA quick_check').fetchone()[0], 'foreignKeys':[list(r) for r in c.execute('PRAGMA foreign_key_check')], 'receipts':[dict(r) for r in c.execute('SELECT turn_id,memory_generation,outcome FROM memory_extraction_turn_receipts')], 'jobs':[dict(r) for r in c.execute('SELECT status,attempts FROM memory_extraction_jobs')], 'subjects':[dict(r) for r in c.execute('SELECT memory_generation FROM memory_subjects')]}))
c.close()`, path.join(workspace, 'ConversationMemory/qa-memory.db')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
};
try {
  await fs.mkdir(userData, { recursive: true }); await fs.mkdir(screenshots, { recursive: true });
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace,
    onboarding: { version: 1, status: 'skipped' }, aiModelSettings: { defaultProfileId: 'model_memory_fixture', profiles: [{ id: 'model_memory_fixture', label: 'Memory fixture', config: { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'memory-fixture', contextWindowTokens: 32768 } }] }, appPreferences: { theme: 'light', language: 'zh-CN' } }));
  const launch = async mode => {
    if (mode) process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE = mode; else delete process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE;
    session = await launchNoteTest({ executablePath, userData }); await session.minimizeWindow();
  };
  const call = expression => session.evaluate(expression);
  const overview = () => call('window.electronAPI.getLongTermMemoryOverview()');
  const close = async () => { await session.closeWindow(); await session.exited; await session.dispose(); session = null; };
  await launch();
  assert.equal((await overview()).extractionRuntime.routes.every(route => !route.readEnabled && !route.eligible), true);
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({ enabled:true, writeMode:'auto', extractDelaySeconds:5 })");
  assert.equal((await overview()).extractionRuntime.routes.every(route => route.readEnabled && route.eligible), true);
  await close();
  checks.push('production release enables all four memory routes without projection overrides; initial user switch remains off');
  await launch('observe');
  assert.equal((await overview()).extractionRuntime.routes.every(route => route.reason === 'route_disabled'), true);
  assert.equal((await overview()).extractionRuntime.routes.every(route => !route.readEnabled), true);
  assert.equal(extractions, 0); await close();
  checks.push('internal observe rollback disables all four read/extraction routes');
  await launch();
  await call('window.__memoryEvents=[];window.electronAPI.onAssistantTurnEvent(e=>window.__memoryEvents.push(e))');
  const chat = async userText => {
    const request = { requestId: `assistant_memory_portable_${Date.now()}`, intent: 'ask', scope: 'chat', userText, conversation: [], modelProfileId: 'model_memory_fixture', thinkingMode: 'simple', webSearch: 'off' };
    await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(request)})`);
    await waitFor(() => call(`window.__memoryEvents.some(e=>e.requestId===${JSON.stringify(request.requestId)} && ['complete','error'].includes(e.type))`), 'packaged answer');
    const result = await call(`window.__memoryEvents.find(e=>e.requestId===${JSON.stringify(request.requestId)} && ['complete','error'].includes(e.type))`);
    assert.equal(result.type, 'complete', result.message);
    return call(`window.__memoryEvents.filter(e=>e.requestId===${JSON.stringify(request.requestId)})`);
  };
  await chat('我是一名企业授信分析师，希望今后的回答使用简体中文和企业授信案例。请简短确认。');
  await waitFor(async () => (await overview()).extractionRuntime.modelState === 'ready', 'packaged automatic extraction');
  let items = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})");
  assert.equal(items.items.length, 1); assert.equal(items.items[0].status, 'pending');
  await call("window.electronAPI.createLongTermMemoryItem({kind:'preference',content:'偏好深色紧凑界面',expiresAt:'2027-10-01T00:00:00Z'})");
  await call("window.electronAPI.createLongTermMemoryItem({kind:'preference',content:'喜欢深色紧凑布局',expiresAt:'2027-10-01T00:00:00Z'})");
  const consolidated = await call('window.electronAPI.consolidateLongTermMemory()'); assert.equal(consolidated.mergedClusters, 0, JSON.stringify(consolidated));
  assert.equal(consolidated.previews.length, 1);
  await call(`window.electronAPI.approveLongTermMemoryConsolidation(${JSON.stringify(consolidated.previews[0].id)},${JSON.stringify(consolidated.previews[0].fingerprint)})`);
  items = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})");
  assert.ok(items.items.some(item => item.expiresAt === '2027-10-01T00:00:00.000Z'));
  await call(`document.querySelector('.app-nav-item[aria-label="设置"]').click()`);
  await waitFor(() => call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化'))"), 'packaged settings');
  await call("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化').click()");
  await waitFor(() => call("Boolean(document.querySelector('[data-testid=memory-extraction-runtime]'))"), 'packaged runtime status');
  const settingsRuntimeText = await call("document.querySelector('[data-testid=memory-extraction-runtime]').innerText");
  assert.match(settingsRuntimeText, /自动提炼已生效/u);
  assert.equal(await call("document.querySelector('[data-testid=memory-effective-status]').innerText"), '已生效');
  const firstIds = items.items.map(item => item.id).sort(); await close();
  let stored = snapshot(); assert.equal(stored.version, 11); assert.equal(stored.receipts.length, 1);
  checks.push('packaged main/preload/native SQLite extraction and consolidation preserve pending status and finite expiry');
  await launch(); await delay(6000);
  items = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})"); assert.deepEqual(items.items.map(item => item.id).sort(), firstIds); assert.equal(extractions, 1);
  assert.equal((await overview()).extractionRuntime.modelState, 'unknown');
  await call('window.__memoryEvents=[];window.electronAPI.onAssistantTurnEvent(e=>window.__memoryEvents.push(e))');
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({writeMode:'explicit_only'})");
  await chat('请简短介绍企业授信。'); assert.ok(!prompts.at(-1).includes('用户偏好简体中文企业授信案例'));
  await delay(6000); assert.equal(extractions, 1);
  const retainedIds = items.items.map(item => item.id).sort();
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({enabled:false})");
  const disabled = await chat('请你记住我是一个厨师');
  assert.equal(disabled.find(event => event.type === 'memory-saved')?.receipt.status, 'disabled');
  assert.equal(prompts.at(-1).includes('<user_memory>'), false);
  assert.deepEqual((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})")).items.map(item => item.id).sort(), retainedIds);
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({enabled:true})");
  const saved = await chat('请你记住我是一个厨师');
  assert.equal(saved.find(event => event.type === 'memory-saved')?.receipt.status, 'saved');
  await chat('我是什么职业？'); assert.ok(prompts.at(-1).includes('我是一个厨师'));
  await delay(6000); assert.equal(extractions, 1);
  checks.push('portable master switch disables reads and explicit saves while retaining data; exact Chinese request saves with a durable receipt and is read in the next independent chat');
  const clear = await call('window.electronAPI.clearLongTermMemory()'); assert.equal(clear.memoryGeneration, 1);
  await delay(6000); assert.equal((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})")).items.length, 0);
  await close(); stored = snapshot(); assert.equal(stored.receipts.length, 0); assert.equal(stored.subjects[0].memory_generation, 1);
  assert.equal(stored.integrity, 'ok'); assert.deepEqual(stored.foreignKeys, []);
  checks.push('full portable restart keeps receipts and item identity; pending never enters prompt; explicit_only does not extract; clear does not replay old sources');
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/memory-release-packaged.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), executablePath,
    sha256: createHash('sha256').update(await fs.readFile(executablePath)).digest('hex'), method: 'production portable/main/preload/React; local HTTP model fixture; no injected handlers; isolated profile; application PATH limited to Windows directories',
    checks, databaseIntegrity: stored.integrity, schemaVersion: stored.version, cleanWindowsVm: false, originalUserDataModified: false,
    settingsRuntimeText, rendererMatchesCurrentBuild: true,
    screenshotStatus: 'production CDP screenshot timed out on this machine; visual verification uses the isolated Electron source build with matching renderer assets' }, null, 2));
  console.log(`Memory portable acceptance passed (${checks.length} groups)`);
} finally {
  await session?.dispose();
  if (originalMode === undefined) delete process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE; else process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE = originalMode;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging); assert.ok(path.basename(temporary).startsWith('memory-portable-'));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
