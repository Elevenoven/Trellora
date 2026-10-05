import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'memory-electron-'));
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const shortStatement = process.argv.includes('--short-statement');
const pythonStatement = process.argv.includes('--python-statement');
const proposals = process.argv.includes('--proposals');
const pagination = process.argv.includes('--pagination');
const output = path.resolve('output/verification/memory', pagination ? 'pagination' : pythonStatement ? 'python-statement' : shortStatement ? 'short-statement' : '.');
const real = process.argv.includes('--real');
const routes = process.argv.includes('--routes');
const release = process.argv.includes('--release');
const onlyRoute = process.argv.find(arg => arg.startsWith('--only-route='))?.split('=')[1];
let expectedReceipts = 1;
let embeddingEvidence;
const checks = [], requests = [];
let session;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url.endsWith('/api/tags')) return json({ models: [{ name: 'memory-fixture' }] });
  if (req.url.endsWith('/api/ps')) return json({ models: [] });
  if (req.url.endsWith('/api/show')) return json({ model_info: { 'model.context_length': 32768 } });
  if (req.url.endsWith('/api/generate')) {
    requests.push({ stream: Boolean(body.stream), tokens: body.options?.num_predict, schema: Boolean(body.format),
      memoryPrompt: body.prompt?.includes('<user_memory>') ?? false, memoryOccupation: body.prompt?.includes('我是一个厨师') ?? false,
      systemOccupation: body.system?.includes('我是一个厨师') ?? false });
    if (body.stream) {
      res.setHeader('content-type', 'application/x-ndjson');
      const response = body.prompt?.includes('我现在不是Java程序员了')
        ? '收到。已更新您的身份背景：您是 Python 程序员。' : '已了解你的回答偏好。';
      res.end(JSON.stringify({ response, done: true, prompt_eval_count: 30, eval_count: 10 }) + '\n'); return;
    }
    let value;
    if (body.format?.properties?.decisions) {
      const transcript = body.prompt.split('<new_user_messages>').at(-1).split('</new_user_messages>')[0];
      const ids = [...transcript.matchAll(/^\[([^\]]+)\]/gmu)].map(match => match[1]);
      value = { schemaVersion: 2, topics: ['企业授信'], decisions: [{ operation: 'add', targetItemId: null, relation: 'independent', evidenceQuote: transcript.match(/^\[[^\]]+\] (.*)$/mu)?.[1] ?? '', kind: 'preference', content: '用户偏好简体中文企业授信案例', topic: '回答案例', importance: 3, inferred: true, sourceMessageId: ids[0], expiresAt: null }] };
      if (transcript.includes('可能我也在做Python开发')) value = { schemaVersion: 2, topics: [], decisions: [{ ...value.decisions[0],
        kind: 'profile', topic: '身份', content: '用户可能也从事 Python 开发', relation: 'uncertain', inferred: true }] };
      if (transcript.includes('我现在不是Java程序员了')) value = {};
    } else if (body.format?.properties?.merge) value = { merge: true, statement: '偏好深色且紧凑的界面布局', topic: '界面偏好', importance: 4 };
    else if (body.format?.properties?.normalizedKey) value = { normalizedKey: null };
    else if (body.format?.properties?.rewrite_query) value = { rewrite_query: '企业授信案例', intent: 'chitchat', image_description: '' };
    else value = { suggestions: [] };
    return json({ response: JSON.stringify(value), done: true, done_reason: 'stop' });
  }
  res.statusCode = 404; json({ error: 'fixture endpoint unavailable' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
let originalConfigHash;
let sourcePath;
let profile;
const mainControls = `
${release ? '' : "process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE = 'observe';"}
import MemoryTestDatabase from 'better-sqlite3';
import { replaceMaterialChunkProjection as memoryTestProjection } from '../../electron/pipeline/materialChunkSearch';
ipcMain.handle('memory-test:control', async (event, input) => {
  assertInternalRenderer(event);
  const database = qaMemoryDatabase.getDatabase(getConfiguredWorkspacePath());
  if (input.action === 'pagination-seed') {
    const { scope } = resolveActiveLongTermMemoryScope(), writer = getMemoryWriteService();
    writer.updateWorkspaceConfig(scope, { enabled: true, writeMode: 'explicit_only', maxItems: 1000 });
    for (let index = 0; index < 10; index++) writer.write(scope, { operation: 'add', kind: 'profile',
      content: '待确认的企业项目开发偏好第' + index + '项', origin: 'extracted', inferred: true, memoryGeneration: 0 });
    for (let index = 0; index < 31; index++) writer.createManual(scope, { kind: index % 2 ? 'fact' : 'profile',
      content: '企业授信系统第' + index + '个模块的开发与接口交付经验', topic: '企业开发' });
    for (let index = 0; index < 2; index++) {
      const item = writer.createManual(scope, { kind: 'task', content: '已结束的旧系统迁移事项第' + index + '项' }).item;
      database.prepare("UPDATE memory_items SET status='archived',invalid_at=? WHERE id=?").run(new Date().toISOString(), item.id);
    }
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 26; index++) database.prepare(
      "INSERT INTO memory_topic_stats (id,workspace_id,principal_id,normalized_key,topic,hits,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,2,?,?,?,?)"
    ).run('pagination-topic-' + index, scope.workspaceId, scope.principalId, '企业开发主题' + index, '企业开发主题' + index, timestamp, timestamp, timestamp, timestamp);
    for (let index = 0; index < 24; index++) database.prepare(
      "INSERT INTO memory_doc_affinities (id,workspace_id,principal_id,document_id,title,hits,first_used_at,last_used_at) VALUES (?,?,?,?,?,2,?,?)"
    ).run('pagination-affinity-' + index, scope.workspaceId, scope.principalId, 'pagination-document-' + index, '企业开发设计说明第' + index + '版', timestamp, timestamp);
    return writer.getItemCounts(scope);
  }
  if (input.action === 'projection') { process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE = input.mode; return true; }
  if (input.action === 'force') { const timestamp = new Date().toISOString(); database.prepare("UPDATE memory_extraction_jobs SET due_at=? WHERE status IN ('queued','retry')").run(timestamp); database.prepare('UPDATE memory_extraction_pending_sources SET due_at=?').run(timestamp); getMemoryExtractionService().start(); return true; }
  if (input.action === 'material') {
    const target = requireRegisteredMaterialsLibrary(input.libraryPath);
    const doc = importMaterialsDocuments(target, [input.sourcePath])[0];
    const db = new MemoryTestDatabase(path.join(target, '.menghan-meta/index.db'));
    try {
      const text = '企业授信审批必须核验现金流和还款能力，并按企业真实经营情况进行风险审查。';
      const common = { documentId: doc.id, ordinal: 0, text, sourceText: text, sectionPath: ['企业授信'], sectionContext: '企业授信', sourceRefs: [], contentHash: doc.contentHash };
      memoryTestProjection(db, { documentId: doc.id, sourceContentHash: doc.contentHash, stageKey: 'memory-route-fixture',
        chunks: [{ ...common, chunkId: 'memory-credit-child', parentChunkId: 'memory-credit-parent', searchTokens: ['企业', '授信', '企业授信', '审批', '现金流', '还款', '能力', '风险'] }],
        parents: [{ ...common, parentChunkId: 'memory-credit-parent' }], keywords: [] });
    } finally { db.close(); }
    return doc.id;
  }
  if (input.action === 'turn') { const { scope } = resolveActiveLongTermMemoryScope(); const repo = getQaMemoryOrchestrator().repository;
    const session = repo.createSession('chat'); repo.startTurn(session.sessionId, { turnId: input.id, userText: '请采用简体中文企业授信案例', scopeLabel: '', route: input.route });
    repo.finalizeTurn(session.sessionId, input.id, { type: 'answer', answer: '来源链路验收', completeness: 'complete', sources: [] }, { archiveScope: scope, route: input.route });
    completeTurnPostProcess({ sessionId: session.sessionId, messageId: input.id, userText: '请采用简体中文企业授信案例', memoryProjectionMode: resolveAssistantMemoryProjectionMode(input.route) }); return true;
  }
  if (input.action === 'snapshot') return { turns: database.prepare('SELECT turn_id,status,result_json,result_metadata_json FROM qa_turns').all(),
    receipts: database.prepare('SELECT turn_id,outcome,memory_generation FROM memory_extraction_turn_receipts').all(),
    jobs: database.prepare('SELECT status,attempts,last_error FROM memory_extraction_jobs').all(),
    integrity: database.pragma('quick_check', { simple: true }), foreignKeys: database.prepare('PRAGMA foreign_key_check').all(), cutover: getMemoryCutoverReport() };
  if (input.action === 'legacy-active') {
    const { scope } = resolveActiveLongTermMemoryScope(), writer = getMemoryWriteService();
    // Reproduce an active extracted row saved before the candidate-confirmation policy, in this isolated fixture only.
    const item = writer.createManual(scope, { kind: 'profile', content: '旧版已生效的自动提炼身份：我是Python程序员' }).item;
    database.prepare("UPDATE memory_items SET origin='extracted',write_protection='none' WHERE id=?").run(item.id);
    return item.id;
  }
  if (input.action === 'proposal') {
    const { scope } = resolveActiveLongTermMemoryScope(), writer = getMemoryWriteService();
    const target = writer.list(scope, { statuses: ['active'] }).items.find(item => item.id === input.targetId);
    return writer.write(scope, { kind: target.kind, content: input.operation === 'retire' ? target.content : input.content,
      topic: target.topic, origin: 'extracted', operation: input.operation, targetItemId: target.id,
      expectedTargetFingerprint: target.targetFingerprint, memoryGeneration: writer.getSubject(scope).memoryGeneration }).item;
  }
  if (input.action === 'begin-explicit') {
    const repo = getQaMemoryOrchestrator().repository, session = repo.createSession('chat');
    repo.startTurn(session.sessionId, { turnId: input.id, userText: '请记住我偏好紧凑授信报表', scopeLabel: '', route: 'chat' });
    return session.sessionId;
  }
  if (input.action === 'finish-explicit') {
    const { scope } = resolveActiveLongTermMemoryScope();
    getQaMemoryOrchestrator().repository.finalizeTurn(input.sessionId, input.id, { type: 'answer', answer: '完成', completeness: 'complete', sources: [] }, { archiveScope: scope });
    completeTurnPostProcess({ sessionId: input.sessionId, messageId: input.id, userText: '请记住我偏好紧凑授信报表', memoryProjectionMode: 'canonical' });
    return true;
  }
  if (input.action === 'capture') {
    // 最小化窗口需先请求一帧，再等待界面绘制，截图不能复用切换前的旧画面。
    await mainWindow.webContents.capturePage(undefined, { stayHidden: true });
    await new Promise(resolve => setTimeout(resolve, 350));
    return (await mainWindow.webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64');
  }
  if (input.action === 'vector') {
    const { scope } = resolveActiveLongTermMemoryScope(), runtime = resolveMemoryEmbeddingRuntime();
    if (!runtime) return { configured: false };
    getMemoryWriteService().updateWorkspaceConfig(scope, { embeddingModelId: runtime.modelId, vectorRecall: true });
    getMemoryWriteService().createManual(scope, { kind: 'fact', content: '授信复核需要评估借款企业持续经营所产生的现金流', topic: '风险复核' });
    await getMemoryRecallService().backfill(scope);
    const result = await getMemoryRecallService().search(scope, '如何判断贷款客户的还款能力');
    return { configured: true, model: runtime.modelId, vectorUsed: result.vectorUsed,
      vectors: database.prepare('SELECT COUNT(*) AS n, MAX(dimensions) AS dimensions FROM memory_item_embeddings').get(), count: result.items.length };
  }
  throw new Error('Unknown isolated memory acceptance control');
});`;
try {
  await fs.mkdir(userData, { recursive: true }); await fs.mkdir(output, { recursive: true });
  profile = { id: 'model_memory_fixture', label: 'Memory fixture', config: { kind: 'ollama', endpoint, model: 'memory-fixture', contextWindowTokens: 32768 } };
  const config = { workspacePath: path.join(temporary, 'workspace'), onboarding: { version: 1, status: 'skipped' },
    aiModelSettings: { defaultProfileId: profile.id, profiles: [profile] }, appPreferences: { theme: 'dark', language: 'zh-CN' } };
  if (real) {
    sourcePath = process.env.TRELLORA_MEMORY_CONFIG_PATH || path.join(process.env.APPDATA, 'Electron/config.json');
    const bytes = await fs.readFile(sourcePath); originalConfigHash = createHash('sha256').update(bytes).digest('hex');
    const source = JSON.parse(bytes.toString());
    profile = source.aiModelSettings?.profiles.find(item => item.id === source.aiModelSettings.defaultProfileId && item.config.model && source.aiProfileSecrets?.[item.id]);
    assert.ok(profile, 'configured remote default model is required');
    await fs.copyFile(path.join(path.dirname(sourcePath), 'Local State'), path.join(userData, 'Local State'));
    config.aiModelSettings = { defaultProfileId: profile.id, profiles: [profile] };
    config.aiProfileSecrets = { [profile.id]: source.aiProfileSecrets[profile.id] };
    config.modelHub = source.modelHub;
    config.modelProviders = source.modelProviders;
    config.modelProviderSecrets = source.modelProviderSecrets;
  }
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify(config));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent', plugins: [{ name: 'isolated-memory-controls', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]main\.ts$/u }, async args => ({ loader: 'ts', contents: (await fs.readFile(args.path, 'utf8'))
        .replace('// Global Error Handler for startup', 'app.disableHardwareAcceleration();\n// Global Error Handler for startup').replace("preload: path.join(__dirname, 'preload.js'),", "preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false,") + mainControls.replace('../../electron/pipeline/materialChunkSearch', './pipeline/materialChunkSearch') }));
    } }] }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker', 'workspaceMigrationWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), logLevel: 'silent', plugins: entry === 'preload' ? [{ name: 'memory-test-preload', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]preload\.ts$/u }, async args => {
        let source = await fs.readFile(args.path, 'utf8');
        if (pagination) {
          for (const channel of ['memory:list-item-page', 'memory:list-topic-page', 'memory:list-document-page']) {
            source = source.replace(`ipcRenderer.invoke('${channel}', query)`, `inspectMemoryPage('${channel}', query)`);
          }
          source += `\nconst inspectedMemoryPages: unknown[] = []; let delayNextItemPage = false;
async function inspectMemoryPage(channel: string, query?: MemoryPageQuery) {
  const delayed = delayNextItemPage && channel === 'memory:list-item-page' && query?.page === 2;
  if (delayed) delayNextItemPage = false;
  const result = await ipcRenderer.invoke(channel, query);
  inspectedMemoryPages.push({channel, query, length: result.items.length, total: result.total, page: result.page});
  if (delayed) await new Promise(resolve => setTimeout(resolve, 800));
  return result;
}
contextBridge.exposeInMainWorld('memoryPaginationTest', { requests: () => inspectedMemoryPages, slowNext: () => { delayNextItemPage = true; } });`;
        }
        return { loader: 'ts', contents: source + "\ncontextBridge.exposeInMainWorld('memoryTest', input => ipcRenderer.invoke('memory-test:control', input));" };
      });
    } }] : [] })),
    build({ entryPoints: ['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(path.dirname(mainEntry), 'pdf.worker.mjs'), logLevel: 'silent' }),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData }); await session.minimizeWindow();
  const call = expression => session.evaluate(expression);
  const control = input => call(`window.memoryTest(${JSON.stringify(input)})`);
  const overview = () => call('window.electronAPI.getLongTermMemoryOverview()');
  let state = await overview(); assert.equal(state.extractionRuntime.routes.every(route => !route.eligible), true);
  assert.equal(state.extractionRuntime.routes.every(route => !route.readEnabled), true);
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({ enabled: true, writeMode: 'auto', extractDelaySeconds: 5 })");
  state = await overview();
  assert.equal(state.extractionRuntime.routes.filter(route => route.eligible).length, release ? 4 : 0);
  assert.equal(state.extractionRuntime.modelState, 'unknown');
  await call(`document.querySelector('.app-nav-item[aria-label="设置"]').click()`);
  await waitFor(() => call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化'))"), 'personalization settings');
  await call("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化').click()");
  await waitFor(() => call("Boolean(document.querySelector('[data-testid=memory-extraction-runtime]'))"), 'runtime status');
  assert.match(await call("document.querySelector('[data-testid=memory-extraction-runtime]').innerText"), release ? /自动提炼已开启/u : /自动提炼尚未生效/u);
  if (!pagination) await fs.writeFile(path.join(output, real ? 'real-status-before.png' : 'observe-status.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  checks.push(release ? 'release defaults enable the expected routes without environment overrides' : 'explicit observe rollback keeps routes disabled');
  if (!real && !release) {
    await control({ action: 'turn', route: 'current-note-direct', id: 'observe-turn' });
  }
  if (!release) await control({ action: 'projection', mode: 'canonical' });
  await call('window.__memoryEvents = []; window.electronAPI.onAssistantTurnEvent(e => window.__memoryEvents.push(e))');
  // Test the user's exact sentence in explicit-only mode, so automatic extraction cannot mask a failed explicit save.
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({ writeMode: 'explicit_only' })");
  const explicitChat = async (userText, patch = {}) => {
    const request = { requestId: `assistant_explicit_${Date.now()}`, intent: 'ask', scope: 'chat', userText,
      conversation: [], modelProfileId: profile.id, thinkingMode: 'simple', webSearch: 'off', ...patch };
    await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(request)})`);
    await waitFor(() => call(`window.__memoryEvents.some(e=>e.requestId===${JSON.stringify(request.requestId)} && ['complete','error'].includes(e.type))`), 'explicit-only chat', real ? 120000 : 30000);
    const events = await call(`window.__memoryEvents.filter(e=>e.requestId===${JSON.stringify(request.requestId)})`);
    const settled = events.find(event => ['complete', 'error'].includes(event.type));
    assert.equal(settled.type, 'complete', settled.message);
    return events;
  };
  if (pagination) {
    await verifyPaginationInterface({ call, control, overview });
  } else if (shortStatement || pythonStatement) {
    await verifyShortStatement({ call, control, overview, explicitChat });
    if (proposals) await verifyProposalInterface({ call, control, overview, explicitChat });
  } else {
  let explicitEvents = await explicitChat('请你记住我是一个厨师');
  assert.equal(explicitEvents.find(event => event.type === 'memory-saved')?.receipt.status, 'saved');
  let explicitItems = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})");
  assert.ok(explicitItems.items.some(item => item.content === '我是一个厨师' && item.origin === 'explicit'));
  if (!real) {
    await call("document.querySelector('.app-nav-item[aria-label=\"助手\"]').click()");
    await waitFor(() => call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]')?.disabled === false"), 'assistant composer ready');
    await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').focus()");
    await session.send('Input.insertText', { text: '请记住我偏好简洁回答' });
    assert.equal(await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').value"), '请记住我偏好简洁回答');
    await waitFor(() => call("document.querySelector('button[aria-label=\"发送\"]')?.disabled === false"), 'send enabled');
    await call("document.querySelector('button[aria-label=\"发送\"]').click()");
    await waitFor(() => call("document.querySelector('[data-testid=memory-save-receipt]')?.innerText.includes('已保存到长期记忆')"), 'durable receipt in the conversation');
    await fs.writeFile(path.join(output, 'memory-save-receipt.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
    await call("document.querySelector('.app-nav-item[aria-label=\"设置\"]').click()");
    await waitFor(() => call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化'))"), 'settings after save');
    await call("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化').click()");
    await waitFor(() => call("Boolean(document.querySelector('input[aria-label=\"启用长期记忆\"]'))"), 'memory settings after save');
    explicitItems = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})");
    checks.push('normal composer/send button shows the main-process durable save receipt in the conversation');
  }
  const recalledEvents = await explicitChat('我是什么职业？');
  if (!real) assert.equal(requests.filter(request => request.stream).at(-1).memoryOccupation, true);
  else assert.match(recalledEvents.find(event => event.type === 'complete').result.answer, /厨师/u);
  if (!real) {
    const documentPath = path.join(temporary, '记忆附件.pdf');
    const documentBytes = createMinimalPdf('Cash flow and repayment capacity are required for credit review.');
    await fs.writeFile(documentPath, documentBytes);
    const events = await explicitChat('请记住我偏好紧凑界面', { attachments: [{ kind: 'document', attachmentId: 'memory-chat-document', path: documentPath, name: '记忆附件.pdf', mimeType: 'application/pdf', sizeBytes: documentBytes.length }] });
    assert.equal(events.find(event => event.type === 'memory-saved')?.receipt.status, 'saved');
    assert.equal(requests.filter(request => request.stream).at(-1).memoryOccupation, true);
    assert.equal(requests.filter(request => request.stream).at(-1).systemOccupation, false);
    assert.ok(events.some(event => event.type === 'memory-used' && event.items.some(item => item.contentSnapshot === '我是一个厨师')));
    explicitItems = await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})");
    checks.push('chat with a real PDF attachment projects active memory into the model user message and records use/save receipts');
  }
  const activeScope = await overview();
  await call("document.querySelector('input[aria-label=\"启用长期记忆\"]').click()");
  await waitFor(async () => !(await overview()).workspaceConfig.enabled, 'memory off button');
  assert.equal((await overview()).extractionRuntime.routes.every(route => !route.readEnabled && !route.eligible), true);
  assert.equal(await call("document.querySelector('[data-testid=memory-effective-status]').innerText"), '已关闭');
  await fs.writeFile(path.join(output, 'memory-button-off.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  explicitEvents = await explicitChat('请你记住我喜欢川菜');
  assert.equal(explicitEvents.find(event => event.type === 'memory-saved')?.receipt.status, 'disabled');
  assert.equal((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.length, explicitItems.items.length);
  if (!real) {
    assert.equal(requests.filter(request => request.stream).at(-1).memoryPrompt, false);
    assert.equal(requests.filter(request => request.stream).at(-1).memoryOccupation, false);
  }
  await call("document.querySelector('input[aria-label=\"启用长期记忆\"]').click()");
  await waitFor(async () => (await overview()).workspaceConfig.enabled, 'memory on button');
  assert.equal((await overview()).subject.memoryGeneration, activeScope.subject.memoryGeneration);
  assert.equal((await overview()).extractionRuntime.routes.find(route => route.route === 'chat').readEnabled, true);
  if (!real) {
    await call('window.electronAPI.setLongTermMemoryPrincipalEnabled(false)');
    await waitFor(() => call("document.querySelector('input[aria-label=\"启用长期记忆\"]')?.checked === false"), 'subject disabled reflected in the total switch');
    await call("document.querySelector('input[aria-label=\"启用长期记忆\"]').click()");
    await waitFor(async () => (await overview()).subject.enabled && (await overview()).extractionRuntime.routes.find(route => route.route === 'chat').readEnabled, 'total switch restores disabled principal');
  }
  await fs.writeFile(path.join(output, 'memory-button-on.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  checks.push('exact Chinese explicit request commits a receipt in explicit_only; real settings button stops reads and writes, retains items and generation, then restores reads');
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({ writeMode: 'auto' })");
  const request = { requestId: `assistant_memory_acceptance_${Date.now()}`, intent: 'ask', scope: 'chat', userText: '我是一名企业授信分析师。今后的回答请优先使用简体中文，并用企业授信案例解释。请简短确认。', conversation: [], modelProfileId: profile.id, thinkingMode: 'simple', webSearch: 'off' };
  await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(request)})`);
  await waitFor(() => call(`window.__memoryEvents.some(e=>e.requestId===${JSON.stringify(request.requestId)} && (e.type==='complete' || e.type==='error'))`), 'normal chat answer', real ? 120000 : 30000);
  const finalEvent = await call(`window.__memoryEvents.find(e=>e.requestId===${JSON.stringify(request.requestId)} && (e.type==='complete' || e.type==='error'))`);
  assert.equal(finalEvent.type, 'complete', finalEvent.message);
  if (routes) {
    const materials = await call("window.electronAPI.createMaterialsLibrary('记忆入口验收')");
    const sourcePath = path.join(temporary, '企业授信验收.md');
    await fs.writeFile(sourcePath, '# 企业授信\n企业授信审批必须核验现金流和还款能力，并按企业真实经营情况进行风险审查。');
    await control({ action: 'material', libraryPath: materials, sourcePath });
    await call("window.electronAPI.saveAppPreferences({ assistantKnowledgeAgentMode: 'off' })");
    const complete = async (patch, expectedRoute) => {
      const routed = { ...request, ...patch, requestId: `assistant_memory_${expectedRoute}_${Date.now()}` };
      await call(`window.electronAPI.startAssistantTurn(${JSON.stringify(routed)})`);
      await waitFor(() => call(`window.__memoryEvents.some(e=>e.requestId===${JSON.stringify(routed.requestId)} && (e.type==='complete' || e.type==='error'))`), expectedRoute, 120000);
      const event = await call(`window.__memoryEvents.find(e=>e.requestId===${JSON.stringify(routed.requestId)} && (e.type==='complete' || e.type==='error'))`);
      assert.equal(event.type, 'complete', event.message);
      const snapshot = await control({ action: 'snapshot' });
      const turn = snapshot.turns.find(turn => turn.turn_id === routed.requestId);
      assert.ok(turn, `${expectedRoute} must persist a canonical turn`);
      const metadata = JSON.parse(turn.result_metadata_json);
      assert.equal(metadata.route, expectedRoute); assert.equal(turn.status, 'complete', JSON.stringify({ route: expectedRoute, completeness: event.result.completeness, agentStats: event.result.agentStats, retrievalWarning: event.result.retrievalWarning, searchCoverage: event.result.searchCoverage })); assert.equal(metadata.memoryExtractionEligible, true);
      expectedReceipts++;
    };
    if (!onlyRoute || onlyRoute === 'knowledge-base') await complete({ scope: 'library-search', userText: '企业授信审批要求是什么？我偏好简体中文，并希望以后用企业授信案例解释。请根据资料简短回答。', contextSources: [{ kind: 'knowledge-base', libraryPath: materials, label: '记忆入口验收' }] }, 'knowledge-base');
    await call("window.electronAPI.createLibrary('记忆笔记验收')");
    const createNote = async (name, content) => {
      const notePath = await call(`window.electronAPI.createFile(${JSON.stringify(name)})`);
      const edit = await call(`window.electronAPI.openNoteEditSession(${JSON.stringify(notePath)})`);
      const saved = await call(`window.electronAPI.saveNote(${JSON.stringify({ editSessionId: edit.editSessionId, requestId: `save_${Date.now()}`, editRevision: 1, expectedDiskHash: edit.version.diskHash, content })})`);
      assert.ok(['committed', 'unchanged'].includes(saved.status), JSON.stringify(saved));
      await call(`window.electronAPI.awaitNoteIndex(${JSON.stringify(edit.editSessionId)},${JSON.stringify(saved.version.diskHash)})`);
      return notePath;
    };
    const noteQuestion = '企业授信审批要求是什么？我偏好简体中文，并希望以后用企业授信案例解释。请只根据笔记简短回答。';
    const directPath = await createNote('企业授信短文.md', '# 企业授信\n企业授信审批必须核验现金流和还款能力。');
    if (!onlyRoute || onlyRoute === 'current-note-direct') await complete({ scope: 'current-note', currentNotePath: directPath, userText: noteQuestion }, 'current-note-direct');
    const reactPath = await createNote('企业授信长文.md', '# 企业授信\n' + Array.from({ length: 55 }, (_, index) => `\n## 审核要点 ${index + 1}\n企业授信审批必须核验现金流和还款能力，并按企业真实经营情况进行风险审查。`).join('\n'));
    await call("window.electronAPI.saveAppPreferences({ assistantPlanMode: 'off' })");
    if (!onlyRoute || onlyRoute === 'current-note-react') await complete({ scope: 'current-note', currentNotePath: reactPath, userText: '请读取当前笔记“审核要点 1”章节，只说明该章节写明的企业授信审批要求。我偏好简体中文企业授信案例。' }, 'current-note-react');
    checks.push(`${onlyRoute ? `chat and ${onlyRoute}` : 'all four routes'} complete through real assistant IPC; owner/generation/eligibility verified`);
  } else if (!real && !onlyRoute) {
    for (const route of ['knowledge-base', 'current-note-direct', 'current-note-react']) { await control({ action: 'turn', route, id: `canonical-${route}` }); expectedReceipts++; }
  }
  await control({ action: 'force' });
  await waitFor(async () => {
    const snapshot = await control({ action: 'snapshot' });
    assert.equal(snapshot.jobs.some(job => job.status === 'failed'), false, JSON.stringify(snapshot.jobs));
    const runtime = (await overview()).extractionRuntime;
    // Acceptance advances due clocks only while idle; production minimum-interval behavior is tested separately.
    if (runtime.runningJobs === 0 && runtime.queuedJobs > 0) await control({ action: 'force' });
    return runtime.runningJobs === 0 && runtime.queuedJobs === 0 && runtime.pendingSources === 0
      && snapshot.receipts.length === expectedReceipts;
  }, 'automatic extraction', real ? 120000 : 30000);
  const snapshot = await control({ action: 'snapshot' });
  assert.equal(snapshot.integrity, 'ok'); assert.deepEqual(snapshot.foreignKeys, []);
  assert.deepEqual(snapshot.cutover.hardViolations, { scopeLeaks: 0, duplicateCanonicalContent: 0, orphanCanonicalToolResults: 0, doubleProjection: 0 });
  if (real && release && routes && !onlyRoute) {
    assert.equal(snapshot.cutover.defaultMode, 'canonical');
    assert.deepEqual([...new Set(snapshot.cutover.observations.filter(observation => observation.activeReader === 'canonical').map(observation => observation.route))].sort(), ['chat', 'current-note-direct', 'current-note-react', 'knowledge-base']);
    checks.push('real four-route cutover observations report zero scope leaks, duplicate content, orphan tool results and double projection');
  }
  assert.equal(snapshot.jobs.some(job => job.status === 'failed'), false, JSON.stringify(snapshot.jobs));
  assert.equal(snapshot.receipts.some(receipt => receipt.turn_id === 'observe-turn'), false);
  assert.equal(snapshot.receipts.length, expectedReceipts);
  const processed = snapshot.turns.filter(turn => snapshot.receipts.some(receipt => receipt.turn_id === turn.turn_id));
  for (const turn of processed) {
    const metadata = JSON.parse(turn.result_metadata_json); assert.equal(metadata.memoryExtractionGeneration, 0); assert.equal(metadata.memoryExtractionEligible, true); assert.ok(metadata.memoryScope.principalId);
  }
  const items = await call("window.electronAPI.listLongTermMemoryItems({ statuses: ['active','pending'] })");
  assert.ok(items.items.length > 0, 'model should extract the explicit stable occupation/preference');
  assert.equal((await overview()).extractionRuntime.modelState, 'ready');
  if (!real) {
    assert.ok(items.items.some(item => item.status === 'pending'));
    checks.push('actual chat IPC completion plus four-route canonical persistence fixtures produce four once-only receipts; observe source stays excluded');
    await call("window.electronAPI.createLongTermMemoryItem({ kind: 'preference', content: '偏好深色紧凑界面', expiresAt: '2027-10-01T00:00:00Z' })");
    await call("window.electronAPI.createLongTermMemoryItem({ kind: 'preference', content: '喜欢深色紧凑布局', expiresAt: '2027-10-01T00:00:00Z' })");
    const consolidated = await call('window.electronAPI.consolidateLongTermMemory()'); assert.equal(consolidated.mergedClusters, 0); assert.equal(consolidated.previews.length, 1);
    await call(`window.electronAPI.approveLongTermMemoryConsolidation(${JSON.stringify(consolidated.previews[0].id)},${JSON.stringify(consolidated.previews[0].fingerprint)})`);
    const merged = await call("window.electronAPI.listLongTermMemoryItems({ statuses: ['active'] })");
    assert.ok(merged.items.some(item => item.expiresAt === '2027-10-01T00:00:00.000Z' && item.content === '偏好深色且紧凑的界面布局'));
    checks.push('real IPC/manual consolidation HTTP response preserves finite expiry');
  } else {
    if (release && !onlyRoute) {
      const vector = await control({ action: 'vector' });
      assert.equal(vector.configured, true, 'configured embedding provider is required for final release acceptance');
      assert.equal(vector.vectorUsed, true, JSON.stringify(vector));
      assert.ok(vector.vectors.n > 0 && vector.vectors.dimensions > 0, JSON.stringify(vector));
      embeddingEvidence = vector;
      checks.push('saved embedding provider backfills real vectors and performs semantic long-term-memory retrieval');
    }
    await call("window.electronAPI.createLongTermMemoryItem({ kind: 'task', content: '2027年十月前完成企业授信风险复核', expiresAt: '2027-10-01T00:00:00Z' })");
    await call("window.electronAPI.createLongTermMemoryItem({ kind: 'task', content: '2027年十月前结束企业授信风险复核', expiresAt: '2027-10-01T00:00:00Z' })");
    const consolidated = await call('window.electronAPI.consolidateLongTermMemory()');
    assert.equal(consolidated.skipReason, 'review_required', JSON.stringify(consolidated));
    for (const preview of consolidated.previews) await call(`window.electronAPI.approveLongTermMemoryConsolidation(${JSON.stringify(preview.id)},${JSON.stringify(preview.fingerprint)})`);
    assert.ok(consolidated.candidateClusters >= 1, JSON.stringify(consolidated));
    const finalItems = await call("window.electronAPI.listLongTermMemoryItems({ statuses: ['active'] })");
    const tasks = finalItems.items.filter(item => item.kind === 'task'); assert.ok(tasks.length > 0);
    assert.ok(tasks.every(item => item.expiresAt === '2027-10-01T00:00:00.000Z'));
    checks.push(`real provider consolidation produced ${consolidated.previews.length} manual previews; user approval committed each exact snapshot and preserved finite expiry`);
    assert.equal(createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex'), originalConfigHash);
    checks.push('saved encrypted remote model completed normal chat and automatic extraction in isolated storage; original config unchanged');
  }
  await delay(5100);
  await fs.writeFile(path.join(output, real ? 'real-status-after.png' : 'canonical-status.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  const runtimeText = await call("document.querySelector('[data-testid=memory-extraction-runtime]').innerText"); assert.match(runtimeText, /自动提炼已生效/u);
  if (!real) {
    const sessionId = await control({ action: 'begin-explicit', id: 'clear-pending-explicit' });
    await call('window.electronAPI.clearLongTermMemory()');
    await control({ action: 'finish-explicit', sessionId, id: 'clear-pending-explicit' });
    await delay(100); await control({ action: 'force' }); await delay(100);
    assert.equal((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})")).items.length, 0);
    checks.push('clear while a canonical explicit request is pending prevents both explicit and automatic resurrection');
  }
  const persistedIds = (await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})")).items.map(item => item.id).sort();
  await session.closeWindow(); await session.exited; await session.dispose(); session = null;
  if (real) {
    session = await launchNoteTest({ mainEntry, userData }); await session.minimizeWindow(); await delay(5100);
    const restored = await control({ action: 'snapshot' });
    assert.deepEqual(restored.receipts, snapshot.receipts); assert.equal(restored.integrity, 'ok'); assert.deepEqual(restored.foreignKeys, []);
    assert.deepEqual((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active','pending']})")).items.map(item => item.id).sort(), persistedIds);
    assert.equal((await overview()).extractionRuntime.modelState, 'unknown');
    checks.push(`complete Electron exit/restart restores ${expectedReceipts} receipts and item identity without replay; provider proof resets to unknown`);
    await session.closeWindow(); await session.exited; await session.dispose(); session = null;
  }
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve(`docs/verification/memory-${release ? 'release-' : ''}${onlyRoute ? onlyRoute + '-' : ''}${real ? 'real-model' : 'electron'}.json`), JSON.stringify({ verifiedAt: new Date().toISOString(),
    method: real ? `real Electron/main/preload/React and saved remote model; ${onlyRoute ?? (routes ? 'four assistant IPC routes' : 'normal chat IPC')}; ${release ? 'release defaults without projection overrides' : 'internal canonical override'}; isolated workspace` : 'real Electron/main/preload/React with local controlled HTTP provider; four-route persistence authority fixtures and normal chat IPC',
    checks, provider: profile.config.provider ?? profile.config.kind, model: profile.config.model, receiptCount: snapshot.receipts.length,
    itemCount: items.items.length, databaseIntegrity: snapshot.integrity, originalUserDataModified: false, containsSecretsOrAnswers: false,
    cutover: { defaultMode: snapshot.cutover.defaultMode, observationCount: snapshot.cutover.observationCount, hardViolations: snapshot.cutover.hardViolations },
    ...(embeddingEvidence ? { embedding: embeddingEvidence } : {}),
    ...(real ? {} : { requests }), screenshots: output }, null, 2));
  console.log(`Memory ${real ? 'real-model' : 'Electron'} acceptance passed (${checks.length} groups)`);
  }
} finally {
  await session?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging); assert.ok(path.basename(temporary).startsWith('memory-electron-'));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Exercises bounded management reads through real main/preload IPC and Mantine controls. */
async function verifyPaginationInterface({ call, control, overview }) {
  assert.deepEqual(await control({ action: 'pagination-seed' }), { active: 31, pending: 10, all: 43 });
  const footer = '[data-testid=memory-pagination]';
  const ready = (total, page) => waitFor(() => call(`
    document.querySelector('${footer}')?.innerText.includes('共 ${total} 条，每页 10 条') &&
    document.querySelector('${footer} button[data-active]')?.getAttribute('aria-label') === '第 ${page} 页' &&
    document.querySelector('button[aria-label="刷新记忆"]')?.disabled === false
  `), `memory page ${page}, total ${total}`).catch(async error => {
    console.error(JSON.stringify(await call(`({footer:document.querySelector('${footer}')?.innerText,
      active:document.querySelector('${footer} button[data-active]')?.getAttribute('aria-label'),
      tabs:[...document.querySelectorAll('[role=tab]')].map(n=>({text:n.textContent,selected:n.getAttribute('aria-selected')})),
      recent:window.memoryPaginationTest.requests().slice(-3)})`)));
    throw error;
  });
  const clickPage = label => call(`document.querySelector('${footer} button[aria-label=${JSON.stringify(label)}]').click()`);
  const clickTab = label => call(`[...document.querySelectorAll('[role=tab]')].find(n => n.textContent.trim().replace(/[0-9]+$/u, '') === ${JSON.stringify(label)}).click()`);
  const rowIds = () => call("[...document.querySelectorAll('[data-memory-item-id]')].map(n => n.dataset.memoryItemId)");
  const pageRequests = () => call('window.memoryPaginationTest.requests()');
  const filter = async label => {
    await call(`document.querySelector('input[aria-label="按类型筛选记忆"]').click()`);
    await waitFor(() => call(`[...document.querySelectorAll('[role=option]')].some(n => n.textContent.trim() === ${JSON.stringify(label)})`), `filter option ${label}`);
    await call(`[...document.querySelectorAll('[role=option]')].find(n => n.textContent.trim() === ${JSON.stringify(label)}).click()`);
  };
  await call(`document.querySelector('button[aria-label="刷新记忆"]').click()`);
  await ready(41, 1);
  const firstIds = await rowIds(); assert.equal(firstIds.length, 10);
  assert.match(await call("[...document.querySelectorAll('[role=tab]')].find(n => n.textContent.trim().startsWith('待确认')).textContent"), /10/u);
  const firstRecords = await call(`window.electronAPI.listLongTermMemoryItemPage({page:1,pageSize:10,statuses:['active','pending']})`);
  assert.ok(firstRecords.items.every(item => item.status === 'active'), 'global pending badge must not come from current page');
  checks.push('first page contains only 10 rows; global pending badge remains 10 with no pending rows on this page');

  let start = (await pageRequests()).length;
  await clickPage('下一页'); await ready(41, 2);
  const secondIds = await rowIds(); assert.equal(secondIds.length, 10);
  assert.ok(secondIds.every(id => !firstIds.includes(id)));
  assert.ok((await pageRequests()).slice(start).every(request => request.channel === 'memory:list-item-page'));
  await call("window.electronAPI.createLongTermMemoryItem({kind:'fact',content:'企业授信报表支持可追溯的审批版本查询'})");
  await call(`document.querySelector('button[aria-label="刷新记忆"]').click()`);
  await ready(42, 2);
  assert.equal((await overview()).itemCounts.active, 32);
  checks.push('actual next-page control has no overlapping rows; manual refresh observes new data and preserves page 2');

  await clickPage('第 3 页'); await ready(42, 3);
  await filter('画像'); await ready(26, 1);
  assert.equal((await rowIds()).length, 10);
  await filter('全部类型'); await ready(42, 1);
  await clickTab('待确认'); await ready(10, 1);
  assert.equal((await rowIds()).length, 10);
  await clickTab('全部'); await ready(44, 1);
  checks.push('type filter resets to page 1 with filtered SQL totals; pending and all tabs show their own counts including archived records');

  start = (await pageRequests()).length;
  await clickTab('主题'); await ready(26, 1);
  assert.equal(await call(`document.querySelectorAll('button[aria-label="删除主题"]').length`), 10);
  await clickPage('最后一页'); await ready(26, 3);
  assert.equal(await call(`document.querySelectorAll('button[aria-label="删除主题"]').length`), 6);
  assert.ok((await pageRequests()).slice(start).every(request => request.channel === 'memory:list-topic-page'));
  start = (await pageRequests()).length;
  await clickTab('文档'); await ready(24, 1);
  await clickPage('最后一页'); await ready(24, 3);
  assert.equal(await call(`document.querySelectorAll('button[aria-label="删除文档记录"]').length`), 4);
  assert.ok((await pageRequests()).slice(start).every(request => request.channel === 'memory:list-document-page'));
  checks.push('topic and document pages load only the selected tab; last pages contain 6 of 26 topics and 4 of 24 documents');

  await clickTab('记忆'); await ready(42, 1);
  start = (await pageRequests()).length;
  await call('window.memoryPaginationTest.slowNext()');
  await clickPage('第 2 页');
  await waitFor(async () => (await pageRequests()).slice(start).some(request => request.channel === 'memory:list-item-page' && request.query.page === 2), 'delayed page 2 response');
  await clickTab('主题'); await ready(26, 1);
  await delay(950);
  await ready(26, 1);
  assert.equal((await rowIds()).length, 0);
  assert.equal(await call(`document.querySelectorAll('button[aria-label="删除主题"]').length`), 10);
  checks.push('an actual IPC page response delayed by the isolated preload cannot overwrite a newer topic tab');

  await clickTab('记忆'); await ready(42, 1);
  await clickPage('最后一页'); await ready(42, 5);
  assert.equal((await rowIds()).length, 2);
  await call(`document.querySelector('button[aria-label="删除记忆"]').click()`);
  await ready(41, 5); assert.equal((await rowIds()).length, 1);
  await call(`document.querySelector('button[aria-label="删除记忆"]').click()`);
  await ready(40, 4); assert.equal((await rowIds()).length, 10);
  checks.push('deleting both records on the last page through row buttons automatically clamps page 5 to page 4');

  const observations = await pageRequests();
  assert.ok(observations.every(request => request.query.pageSize === 10 && request.length <= 10));
  const snapshot = await control({ action: 'snapshot' });
  assert.equal(snapshot.integrity, 'ok'); assert.deepEqual(snapshot.foreignKeys, []);
  assert.equal(snapshot.jobs.length, 0);
  await call(`[...document.querySelectorAll('button')].find(n => n.textContent.trim() === '清空').scrollIntoView({block:'end'})`);
  const screenshot = path.join(output, 'memory-pagination-dark.png');
  await fs.writeFile(screenshot, Buffer.from(await control({ action: 'capture' }), 'base64'));
  await fs.writeFile(path.resolve('docs/verification/memory-pagination-electron.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), method: 'fresh real Electron/main/preload/React; isolated SQLite workspace; actual Mantine controls',
    checks, pageSize: 10, pageRequests: observations, maximumResponseItems: Math.max(...observations.map(request => request.length)),
    databaseIntegrity: snapshot.integrity, originalUserDataModified: false, screenshot,
  }, null, 2));
  console.log(`Memory pagination Electron acceptance passed (${checks.length} groups)`);
}

/** Replays the reported explicit sentence through the actual composer, journal and restart. */
async function verifyShortStatement({ call, control, overview, explicitChat }) {
  const userText = pythonStatement ? '你先记住，我还是个Python程序员呢' : '记住，我还是厨师';
  const statement = pythonStatement ? '我还是个Python程序员呢' : '我还是厨师';
  const evidenceName = pythonStatement ? 'python-statement' : 'short-statement';
  await call("window.electronAPI.createLongTermMemoryItem({ kind: 'profile', content: '我是程序员，我工作主要 Java 开发，Agent 开发', topic: '身份' })");
  await call("document.querySelector('.app-nav-item[aria-label=\"助手\"]').click()");
  await waitFor(() => call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]')?.disabled === false"), 'short sentence composer ready');
  await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').focus()");
  await session.send('Input.insertText', { text: userText });
  assert.equal(await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').value"), userText);
  await waitFor(() => call("document.querySelector('button[aria-label=\"发送\"]')?.disabled === false"), 'short sentence send enabled');
  await call("document.querySelector('button[aria-label=\"发送\"]').click()");
  await waitFor(() => call("document.querySelector('[data-testid=memory-save-receipt]')?.innerText.includes('已保存到长期记忆')"), 'short sentence saved receipt', real ? 120000 : 30000);
  const saved = await call("window.__memoryEvents.find(e=>e.type==='memory-saved')");
  assert.equal(saved.receipt.status, 'saved');
  const items = (await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items;
  assert.ok(items.some(item => item.id === saved.receipt.itemId && item.content === statement && item.origin === 'explicit'));
  assert.ok(items.some(item => item.content.includes('Java')));
  let snapshot = await control({ action: 'snapshot' });
  assert.deepEqual(JSON.parse(snapshot.turns.find(turn => turn.turn_id === saved.requestId).result_json).memorySave, saved.receipt);
  assert.equal(snapshot.receipts.length, 0, 'automatic extraction must not mask the explicit save');
  await fs.writeFile(path.join(output, `${real ? 'real-' : ''}${evidenceName}-saved.png`), Buffer.from(await control({ action: 'capture' }), 'base64'));
  checks.push(`exact ${evidenceName} saves through the real composer/send button; UI, item and durable turn receipt agree; existing Java profile remains`);

  const assertRecall = async () => {
    const events = await explicitChat('我是什么职业？');
    assert.ok(events.some(event => event.type === 'memory-used' && event.items.some(item => item.contentSnapshot === statement)));
    if (real) assert.match(events.find(event => event.type === 'complete').result.answer, pythonStatement ? /Python/iu : /厨师/u);
  };
  await assertRecall();
  checks.push('an independent conversation recalls the explicit occupation from long-term storage');
  const twoRunes = await explicitChat('记住，中文');
  assert.equal(twoRunes.find(event => event.type === 'memory-saved')?.receipt.status, 'saved');
  assert.ok((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.some(item => item.content === '中文' && item.origin === 'explicit'));
  checks.push('two-rune explicit statements still satisfy the canonical minimum');
  const beforeSensitive = (await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.map(item => item.id).sort();
  const sensitive = await explicitChat('请记住密码是short-memory-fixture');
  const rejected = sensitive.find(event => event.type === 'memory-saved');
  assert.deepEqual(rejected.receipt, { status: 'failed', code: 'MEMORY_SENSITIVE_CONTENT' });
  snapshot = await control({ action: 'snapshot' });
  assert.deepEqual(JSON.parse(snapshot.turns.find(turn => turn.turn_id === rejected.requestId).result_json).memorySave, rejected.receipt);
  assert.deepEqual((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.map(item => item.id).sort(), beforeSensitive);
  checks.push('a genuinely sensitive statement still fails without writing an item; the failure receipt remains truthful');

  await call("document.querySelector('.app-nav-item[aria-label=\"设置\"]').click()");
  await waitFor(() => call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化'))"), 'short statement settings');
  await call("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化').click()");
  await waitFor(() => call("Boolean(document.querySelector('input[aria-label=\"启用长期记忆\"]'))"), 'short statement toggle');
  const generation = (await overview()).subject.memoryGeneration;
  await call("document.querySelector('input[aria-label=\"启用长期记忆\"]').click()");
  await waitFor(async () => !(await overview()).workspaceConfig.enabled, 'short statement memory off');
  const disabled = await explicitChat('记住，粤语');
  assert.equal(disabled.find(event => event.type === 'memory-saved')?.receipt.status, 'disabled');
  assert.deepEqual((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.map(item => item.id).sort(), beforeSensitive);
  await call("document.querySelector('input[aria-label=\"启用长期记忆\"]').click()");
  await waitFor(async () => (await overview()).extractionRuntime.routes.find(route => route.route === 'chat').readEnabled, 'short statement memory on');
  assert.equal((await overview()).subject.memoryGeneration, generation);
  checks.push('the actual off/on button still gates short-statement writes and retains all items and generation');

  await session.closeWindow(); await session.exited; await session.dispose(); session = null;
  session = await launchNoteTest({ mainEntry, userData }); await session.minimizeWindow();
  await call('window.__memoryEvents = []; window.electronAPI.onAssistantTurnEvent(e => window.__memoryEvents.push(e))');
  const restored = await control({ action: 'snapshot' });
  assert.equal(restored.integrity, 'ok'); assert.deepEqual(restored.foreignKeys, []);
  assert.deepEqual(JSON.parse(restored.turns.find(turn => turn.turn_id === saved.requestId).result_json).memorySave, saved.receipt);
  assert.deepEqual(JSON.parse(restored.turns.find(turn => turn.turn_id === rejected.requestId).result_json).memorySave, rejected.receipt);
  assert.deepEqual((await call("window.electronAPI.listLongTermMemoryItems({statuses:['active']})")).items.map(item => item.id).sort(), beforeSensitive);
  await assertRecall();
  assert.equal((await control({ action: 'snapshot' })).receipts.length, 0);
  checks.push('full Electron exit/restart retains both save/failure receipts and item identity; the next independent answer recalls the saved occupation');
  if (real) assert.equal(createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex'), originalConfigHash);
  await fs.writeFile(path.resolve(`docs/verification/memory-${evidenceName}-${real ? 'real-model' : 'electron'}.json`), JSON.stringify({
    verifiedAt: new Date().toISOString(), method: 'actual Electron/main/preload/React composer, explicit_only mode, isolated profile and full restart',
    checks, provider: profile.config.provider ?? profile.config.kind, model: profile.config.model,
    statementCodePoints: Array.from(statement).length, savedStatus: saved.receipt.status, sensitiveFailureCode: rejected.receipt.code,
    databaseIntegrity: restored.integrity, originalUserDataModified: false, containsSecretsOrAnswers: false,
    screenshot: path.join(output, `${real ? 'real-' : ''}${evidenceName}-saved.png`),
  }, null, 2));
  console.log(`${evidenceName} ${real ? 'real-model' : 'Electron'} acceptance passed (${checks.length} groups)`);
}

async function verifyProposalInterface({ call, control, overview, explicitChat }) {
  const uiChecks = [];
  const items = () => call('window.electronAPI.listLongTermMemoryItems({limit:200})').then(page => page.items);
  const getItem = async id => (await items()).find(item => item.id === id);
  const clickText = text => call(`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}).click()`);
  const settings = async () => {
    await call("document.querySelector('.app-nav-item[aria-label=\"设置\"]').click()");
    await waitFor(() => call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='个性化'))"), 'proposal settings');
    await clickText('个性化');
    await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-extraction-runtime]"))'), 'proposal settings loaded');
  };
  const open = async id => {
    await settings();
    await call("[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes('待确认')).click()");
    await waitFor(() => call(`Boolean(document.querySelector('[data-memory-item-id="${id}"] button[aria-label="确认记忆"]'))`), 'pending row');
    await call(`document.querySelector('[data-memory-item-id="${id}"] button[aria-label="确认记忆"]').click()`);
    await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-proposal-review]"))'), 'review dialog');
  };
  let old = (await items()).find(item => item.kind === 'profile' && item.content.includes('Java'));
  const events = await explicitChat('请记住：更正，我现在只做 Python 和 Agent 开发');
  const receipt = events.find(event => event.type === 'memory-saved').receipt;
  assert.equal(receipt.status, 'pending'); assert.equal((await getItem(old.id)).status, 'active');
  await open(receipt.itemId);
  assert.match(await call('document.querySelector("[data-testid=memory-proposal-review]").innerText'), /来源原话.*请记住.*Python/su);
  await call("document.querySelector('[data-testid=memory-proposal-review] input').click()");
  await waitFor(() => call("Boolean([...document.querySelectorAll('[role=option]')].find(n=>n.textContent.includes('Java')))"), 'displayed target option');
  await call("[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.includes('Java')).click()");
  assert.match(await call('document.querySelector("[data-testid=memory-proposal-review]").innerText'), /Java.*Python/su);
  await fs.writeFile(path.join(output, 'proposal-replace-review.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  await call('document.querySelector("[data-testid=memory-review-confirm]").click()');
  await waitFor(async () => (await getItem(receipt.itemId)).status === 'active', 'reviewed replacement');
  assert.equal((await getItem(old.id)).status, 'superseded');
  uiChecks.push('ambiguous explicit save is pending; real dialog shows original source and chosen cross-kind target; reviewed replacement is atomic');

  old = (await call("window.electronAPI.createLongTermMemoryItem({kind:'profile',content:'用于撤销审查的 Java 开发身份',topic:'审查身份'})")).item;
  const retiring = await control({ action: 'proposal', operation: 'retire', targetId: old.id });
  await open(retiring.id);
  assert.match(await call('document.querySelector("[data-testid=memory-proposal-review]").innerText'), /确认后撤销/u);
  assert.equal(await call("Boolean([...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='编辑新正文'))"), false);
  await fs.writeFile(path.join(output, 'proposal-retire-review.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  await clickText('拒绝提案');
  await waitFor(async () => (await getItem(retiring.id)).status === 'archived', 'retire rejection');
  assert.equal((await getItem(old.id)).status, 'active');
  const retiringAgain = await control({ action: 'proposal', operation: 'retire', targetId: old.id });
  await open(retiringAgain.id); await clickText('确认撤销');
  await waitFor(async () => (await getItem(old.id)).status === 'superseded', 'retire confirmation');
  assert.equal((await getItem(retiringAgain.id)).status, 'archived');
  uiChecks.push('retire dialog is read-only; rejection preserves old active, confirmation retires without creating an active fact');

  old = (await call("window.electronAPI.createLongTermMemoryItem({kind:'profile',content:'等待审查的旧开发身份'})")).item;
  const replacement = await control({ action: 'proposal', operation: 'replace', targetId: old.id, content: '等待审查的新 Python 开发身份' });
  await open(replacement.id);
  await call(`window.electronAPI.updateLongTermMemoryItem(${JSON.stringify(old.id)}, {content:'人工编辑后的完整开发身份'})`);
  await call('document.querySelector("[data-testid=memory-review-confirm]").click()');
  await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-proposal-review] [role=alert]"))'), 'stale confirmation error');
  assert.equal((await getItem(old.id)).status, 'active'); assert.equal((await getItem(replacement.id)).status, 'archived');
  await call("document.querySelector('[role=dialog] .mantine-Modal-close').click()");
  uiChecks.push('an open stale review cannot replace an item edited in the meantime; real dialog displays main-process rejection');

  const legacyActiveId = await control({ action: 'legacy-active' });
  await settings();
  await call("[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes('记忆')).click()");
  await waitFor(() => call(`Boolean(document.querySelector('[data-memory-item-id="${legacyActiveId}"]'))`), 'legacy active extracted row');
  const legacyRow = await call(`document.querySelector('[data-memory-item-id="${legacyActiveId}"]').innerText`);
  assert.match(legacyRow, /有效.*自动提炼/su); assert.doesNotMatch(legacyRow, /整理需确认/u);
  assert.equal(await call(`Boolean(document.querySelector('[data-memory-item-id="${legacyActiveId}"] button[aria-label="确认记忆"]'))`), false);
  await call("[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes('待确认')).click()");
  await waitFor(() => call("document.body.textContent.includes('没有待确认记忆') && document.body.textContent.includes('已有的有效记忆无需再次确认。要合并记忆')"), 'empty pending tab explains active memories and merge entry');
  await call("[...document.querySelectorAll('p')].find(n=>n.textContent==='没有待确认记忆').scrollIntoView({block:'center'})");
  await fs.writeFile(path.join(output, 'memory-empty-pending-explained.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  assert.equal((await getItem(legacyActiveId)).status, 'active');
  uiChecks.push('legacy active extracted memory is labelled active without a fictitious pending action; empty pending tab explains the consolidation entry');

  await call("window.electronAPI.createLongTermMemoryItem({kind:'preference',content:'偏好深色紧凑界面',expiresAt:'2027-10-01'})");
  await call("window.electronAPI.createLongTermMemoryItem({kind:'preference',content:'喜欢深色紧凑布局',expiresAt:'2027-10-01'})");
  await settings(); await clickText('整理');
  await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-merge-preview]"))'), 'protected merge preview', real ? 120000 : 30000);
  // Hidden-window captures must wait for the real modal animation to finish before visual acceptance.
  await waitFor(async () => {
    await control({ action: 'capture' });
    return call("getComputedStyle(document.querySelector('[data-testid=memory-merge-preview]').closest('[role=dialog]')).opacity==='1'");
  }, 'fully visible merge review dialog');
  const before = (await items()).filter(item => item.status === 'active').length;
  assert.match(await call('document.querySelector("[data-testid=memory-merge-preview]").innerText'), /用户保护/u);
  await fs.writeFile(path.join(output, 'memory-protected-merge-preview.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  const previewText = await call('document.querySelector("[data-testid=memory-merge-preview]").innerText');
  await call("document.querySelector('button[aria-label=\"关闭合并方案\"]').click()");
  await waitFor(() => call('!document.querySelector("[data-testid=memory-merge-preview]")'), 'closed merge dialog');
  assert.match(await call('document.querySelector("[data-testid=memory-consolidation-action]").innerText'), /审查合并方案（1）/u);
  assert.equal((await items()).filter(item => item.status === 'active').length, before);
  await fs.writeFile(path.join(output, 'memory-merge-review-entry.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  const requestCount = requests.length;
  await call('document.querySelector("[data-testid=memory-consolidation-action]").click()');
  await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-merge-preview]"))'), 'reopened merge preview');
  assert.equal(await call('document.querySelector("[data-testid=memory-merge-preview]").innerText'), previewText);
  assert.equal(requests.length, requestCount);
  await clickText('确认合并');
  await waitFor(async () => (await items()).filter(item => item.status === 'active').length < before, 'user-approved protected merge');
  await waitFor(() => call('document.querySelector("[data-testid=memory-consolidation-action]").textContent.trim()==="整理"'), 'merge entry cleared after confirmation');
  uiChecks.push('manual consolidation can be closed and reopened from a visible review button without a new model call or cooldown; originals remain active until confirmation');
  await call("window.electronAPI.saveLongTermMemoryWorkspaceConfig({writeMode:'auto'})");
  await call("document.querySelector('.app-nav-item[aria-label=\"助手\"]').click()");
  await waitFor(() => call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]')?.disabled===false"), 'per-turn state composer');
  await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').focus()");
  await session.send('Input.insertText', { text: '可能我也在做Python开发，请简短回应。' });
  await call("document.querySelector('button[aria-label=\"发送\"]').click()");
  await waitFor(() => call("[...document.querySelectorAll('[data-testid=memory-extraction-status]')].some(n=>n.textContent.includes('等待自动提炼'))"), 'per-turn waiting label');
  await control({ action: 'force' });
  await waitFor(() => call("[...document.querySelectorAll('[data-testid=memory-extraction-status]')].some(n=>n.textContent.includes('有记忆待确认'))"), 'per-turn pending label');
  await call("[...document.querySelectorAll('[data-testid=memory-extraction-status] button')].find(n=>n.textContent==='审查记忆').click()");
  await waitFor(() => call('Boolean(document.querySelector("[data-testid=memory-proposal-review]"))'), 'conversation jump to matching proposal');
  assert.match(await call('document.querySelector("[data-testid=memory-proposal-review]").innerText'), /可能我也在做Python开发/u);
  await fs.writeFile(path.join(output, 'memory-turn-pending-review.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  await clickText('拒绝提案');
  await call("document.querySelector('.app-nav-item[aria-label=\"助手\"]').click()");
  await waitFor(() => call("[...document.querySelectorAll('[data-testid=memory-extraction-status]')].some(n=>n.textContent.includes('保存项已归档'))"), 'rejected proposal reflects current archived state');
  uiChecks.push('actual composer shows waiting then pending; review jumps to the exact source, and rejection updates the card to current archived state');
  const beforeFailure = (await items()).map(({ id, content, status }) => ({ id, content, status }));
  await call("document.querySelector('textarea[aria-label=\"向 AI 助手输入问题\"]').focus()");
  await session.send('Input.insertText', { text: '我现在不是Java程序员了，我现在是Python程序员。请简短回应。' });
  await call("document.querySelector('button[aria-label=\"发送\"]').click()");
  await waitFor(() => call("[...document.querySelectorAll('.assistant-markdown-content')].some(n=>n.textContent.includes('长期记忆的保存状态以应用回执为准'))"), 'model acknowledgement uses application receipt');
  assert.equal(await call("[...document.querySelectorAll('.assistant-markdown-content')].some(n=>n.textContent.includes('已更新您的身份背景'))"), false);
  await control({ action: 'force' });
  await waitFor(() => call("[...document.querySelectorAll('[data-testid=memory-extraction-status]')].some(n=>n.textContent.includes('模型输出格式或证据校验未通过'))"), 'actual structured-output failure label');
  assert.deepEqual((await items()).map(({ id, content, status }) => ({ id, content, status })).sort((a,b)=>a.id.localeCompare(b.id)), beforeFailure.sort((a,b)=>a.id.localeCompare(b.id)));
  await fs.writeFile(path.join(output, 'memory-failed-receipt.png'), Buffer.from(await control({ action: 'capture' }), 'base64'));
  uiChecks.push('failed correction shows real format/evidence reason, normalizes premature profile acknowledgement and preserves original memory rows');
  assert.equal((await overview()).extractionRuntime.pauseCode, undefined);
  const snapshot = await control({ action: 'snapshot' }); assert.equal(snapshot.integrity, 'ok'); assert.deepEqual(snapshot.foreignKeys, []);
  await fs.writeFile(path.resolve('docs/verification/memory-proposal-ui.json'), JSON.stringify({ verifiedAt: new Date().toISOString(),
    method: 'actual Electron main/preload/React dialogs and buttons; isolated database; controlled proposal fixtures; model-reviewed manual consolidation',
    checks: uiChecks, originalUserDataModified: false, databaseIntegrity: snapshot.integrity, screenshots: output }, null, 2));
  console.log(`Memory proposal UI acceptance passed (${uiChecks.length} groups)`);
}

function createMinimalPdf(text) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
