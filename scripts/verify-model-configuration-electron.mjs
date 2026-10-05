import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'model-configuration-electron-'));
const userData = path.join(temporary, 'user-data');
const libraryPath = path.join(temporary, '采购制度库');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const output = path.resolve('output/verification/model-configuration');
const checks = [];
let session, catalogFailure = false, restartRequestSeen = false;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('content-type', 'application/json');
  const json = value => res.end(JSON.stringify(value));
  if (req.url.endsWith('/models')) { res.statusCode = catalogFailure ? 401 : 200; return json(catalogFailure ? { error: 'fixture unavailable' } : { data: [{ id: 'model-a' }, { id: 'model-b' }] }); }
  if (req.url.endsWith('/embeddings')) {
    if (body.model === 'model-restart' && JSON.stringify(body.input).includes('采购付款')) { restartRequestSeen = true; await delay(2000); }
    return json({ model: body.model, data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ index, embedding: body.model === 'model-b' ? [0, 0.6, 0.8] : [0.6, 0.8] })) });
  }
  if (req.url.endsWith('/api/tags')) return json({ models: [{ name: 'chat-a' }, { name: 'model-a' }] });
  if (req.url.endsWith('/api/ps')) return json({ models: [] });
  if (req.url.endsWith('/api/show')) return json({ model_info: { 'model.context_length': 32768 } });
  if (req.url.endsWith('/api/generate')) return json({ response: 'fixture', done: true });
  res.statusCode = 404; json({ error: 'fixture unknown endpoint' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const originalEndpoint = endpoint + '/original/v1', draftEndpoint = endpoint + '/draft/v1';

try {
  await Promise.all([userData, libraryPath, path.dirname(mainEntry), output].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    workspacePath: path.join(temporary, 'workspace'), appPreferences: { theme: 'light', language: 'zh-CN' },
    materialsLibraries: [{ path: libraryPath, alias: '采购制度库', origin: 'created' }],
    aiModelSettings: { defaultProfileId: 'model_fixture_0001', profiles: [{ id: 'model_fixture_0001', label: '本地验证', config: { kind: 'ollama', endpoint, model: 'chat-a' } }] },
    modelHub: { version: 1, ollamaEndpoint: endpoint, slots: { generation: { source: 'ollama', model: 'chat-a' }, embedding: { source: 'custom', model: 'model-a' }, rerank: { source: 'none', model: '' } } },
    modelProviders: { custom: { endpoint: originalEndpoint, models: ['model-a'] } },
  }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent', plugins: [{ name: 'fixture-window', setup(builder) {
      builder.onLoad({ filter: /electron[\\/]main\.ts$/ }, async args => ({ loader: 'ts', contents: (await fs.readFile(args.path, 'utf8'))
        .replace('// Global Error Handler for startup', 'app.disableHardwareAcceleration();\n// Global Error Handler for startup')
        .replace("preload: path.join(__dirname, 'preload.js'),", "preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false,")
        + `\nimport FixtureDatabase from 'better-sqlite3';
          import { ensureMaterialChunkSearchSchema as fixtureSchema, replaceMaterialChunkProjection as fixtureProjection } from './pipeline/materialChunkSearch';
          import { synchronizeMaterialVectors as fixtureVectors } from './pipeline/materialVectorCoordinator';
          ipcMain.handle('model-config-test:capture', async () => (await mainWindow!.webContents.capturePage()).toPNG().toString('base64'));
          ipcMain.handle('model-config-test:idle', () => !pipelineOrchestrator?.maintenanceBusy);
          ipcMain.handle('model-config-test:credentials', () => {
            const encrypted = store.get('modelProviderSecrets')?.custom;
            try { return { encryptionAvailable: safeStorage.isEncryptionAvailable(), secretPresent: Boolean(encrypted), decrypts: encrypted ? Boolean(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) : false }; }
            catch (error) { return { encryptionAvailable: safeStorage.isEncryptionAvailable(), secretPresent: Boolean(encrypted), error: error.message }; }
          });
          ipcMain.handle('model-config-test:seed', async (_event, libraryPath) => {
            const target = requireRegisteredMaterialsLibrary(libraryPath);
            fs.writeFileSync(path.join(target, '付款审批制度.md'), '采购付款超过五万元须由财务负责人审批。');
            const document = importMaterialsDocuments(target, [path.join(target, '付款审批制度.md')])[0];
            const database = new FixtureDatabase(path.join(target, '.menghan-meta/index.db'));
            fixtureSchema(database); database.exec('CREATE TABLE IF NOT EXISTS chunk_keywords(document_id TEXT,chunk_id TEXT,surface_term TEXT,normalized_term TEXT,score REAL,kind TEXT,rank INTEGER);');
            fixtureProjection(database, { documentId: document.id, sourceContentHash: document.contentHash, stageKey: 'fixture-keywords', keywords: [], chunks: [{ documentId: document.id, chunkId: 'fixture-approval', parentChunkId: null, ordinal: 1, text: '采购付款超过五万元须由财务负责人审批。', sourceText: '采购付款超过五万元须由财务负责人审批。', sectionPath: [], sectionContext: '', sourceRefs: [{ line: 1 }], contentHash: 'fixture-chunk', searchTokens: ['采购', '付款', '审批'] }] }); database.close();
            const profile = readMaterialEmbeddingProfile(target).profile!;
            await fixtureVectors({ libraryPath: target, profile, adapter: resolveLockedMaterialEmbeddingAdapter(profile)! });
          });` }));
    } }] }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), logLevel: 'silent', plugins: entry === 'preload' ? [{ name: 'fixture-capture', setup(builder) {
      builder.onLoad({ filter: /electron[\\/]preload\.ts$/ }, async args => ({ loader: 'ts', contents: await fs.readFile(args.path, 'utf8') + "\ncontextBridge.exposeInMainWorld('modelConfigTest', { capture: () => ipcRenderer.invoke('model-config-test:capture'), seed: library => ipcRenderer.invoke('model-config-test:seed', library), idle: () => ipcRenderer.invoke('model-config-test:idle'), credentials: () => ipcRenderer.invoke('model-config-test:credentials') });" }));
    } }] : [] })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  console.log('model configuration runtime: isolated build ready');
  session = await launchNoteTest({ mainEntry, userData, navigationLabel: '设置' });
  await invoke('saveModelConfiguration', { kind: 'hub', provider: { id: 'custom', patch: { endpoint: originalEndpoint, apiKey: 'fixture-original-key' } } });
  const candidate = { schemaVersion: 1, sourceId: 'custom', transportKind: 'openai-compatible', endpointIdentity: originalEndpoint, requestedModel: 'model-a', vectorType: 'float32', distanceMetric: 'cosine', encodingFormat: 'float', truncateInputs: false, documentInputVersion: 'material-chunk-text-v1', queryInputVersion: 'material-query-text-v1' };
  const locked = await invoke('lockMaterialEmbeddingProfile', libraryPath, candidate);
  const before = await snapshot();
  assert.equal((await invoke('fetchModelProviderModels', 'custom', { endpoint: draftEndpoint, apiKey: 'fixture-draft-key' })).result.available, true);
  assert.deepEqual(await snapshot(), before);
  catalogFailure = true; assert.equal((await invoke('fetchModelProviderModels', 'custom', { endpoint: draftEndpoint, apiKey: 'fixture-draft-key' })).result.available, false); catalogFailure = false;
  assert.deepEqual(await snapshot(), before); checks.push('real IPC draft catalog success and failure never save connection, key or slot');
  await session.send('Page.reload');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"设置\"]'))"), 'reloaded renderer');
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"设置\"]').click()");
  await button('模型配置');
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('.settings-profile-row')].find(n=>n.textContent.includes('Embedding')))"), 'embedding connection row');
  await session.evaluate("[...document.querySelectorAll('.settings-profile-row')].find(n=>n.textContent.includes('Embedding')).querySelector('button').click()");
  await fill('[aria-label="Embedding API 地址"]', draftEndpoint);
  await fill('[aria-label="Embedding API Key"]', 'fixture-draft-key');
  await button('获取目录');
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('button')].find(n=>n.getClientRects().length && n.textContent.trim()==='获取目录' && !n.getAttribute('data-loading')))"), 'catalog request complete');
  assert.deepEqual(await snapshot(), before);
  await button('保存配置');
  await waitFor(() => session.evaluate("document.querySelector('[role=dialog]')?.textContent.includes('采购制度库')"), 'connection impact modal');
  assert.deepEqual(await snapshot(), before);
  await delay(250); const image = Buffer.from(await session.evaluate('window.modelConfigTest.capture()'), 'base64');
  assert.ok(image.length > 15000); await fs.writeFile(path.join(output, 'connection-impact.png'), image);
  await button('返回修改');
  await waitFor(() => session.evaluate("!document.querySelector('[role=dialog]')"), 'cancel impact modal');
  assert.deepEqual(await snapshot(), before); checks.push('React settings shows affected library and cancel preserves the full configuration');
  await button('保存配置'); await button('继续保存');
  await waitFor(async () => (await snapshot()).providers.custom.endpoint === draftEndpoint, 'confirmed connection commit');
  assert.equal((await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash, locked.profileHash);
  await invoke('saveModelConfiguration', { kind: 'hub', provider: { id: 'custom', patch: { endpoint: originalEndpoint } } });
  await session.evaluate(`window.modelConfigTest.seed(${JSON.stringify(libraryPath)})`);
  await session.send('Page.reload');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"资料\"]'))"), 'materials navigation');
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"资料\"]').click()");
  await button('采购制度库');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[aria-label=\"采购制度库 操作\"]'))"), 'materials library');
  await session.evaluate("document.querySelector('[aria-label=\"采购制度库 操作\"]').click()");
  await button('切块与流水线'); await button('管理索引代际');
  await fill('[aria-label="新代际模型名称"]', 'model-b');
  await button('测试新模型'); await button('构建新代际');
  await waitFor(async () => (await invoke('listMaterialVectorGenerations', libraryPath)).some(row => row.state === 'READY'), 'new generation validated');
  assert.equal((await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash, locked.profileHash);
  await button('切换到此代际'); await button('返回修改');
  assert.equal((await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash, locked.profileHash);
  await button('切换到此代际'); await button('确认切换');
  await waitFor(async () => (await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.requestedModel === 'model-b', 'generation activation');
  await waitFor(() => session.evaluate("[...document.querySelectorAll('[data-generation-id]')].some(n=>n.textContent.includes('当前使用') && n.textContent.includes('model-b'))"), 'active generation UI');
  await delay(300); await fs.writeFile(path.join(output, 'vector-generations.png'), Buffer.from(await session.evaluate('window.modelConfigTest.capture()'), 'base64'));
  const guarded = await invoke('saveModelConfiguration', { kind: 'hub', provider: { id: 'custom', patch: { endpoint: draftEndpoint } } });
  assert.equal(guarded.status, 'confirmation-required'); assert.equal(guarded.impacts[0].model, 'model-b');
  await waitFor(() => session.evaluate('window.modelConfigTest.idle()'), 'pipeline idle before rollback');
  await button('回滚到此代际'); await button('确认切换');
  await waitFor(async () => (await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash === locked.profileHash, 'original generation rollback');
  checks.push('React migration UI probes, rebuilds and validates a new dimension; cancelled activation preserves the old profile; activation and rollback update the real binding; connection guard reads the active generation');
  // 首次建立的 Chromium 安全存储先正常退出落盘，再验收已初始化应用的突然中断。
  await session.closeWindow(); await session.exited; await session.dispose();
  session = await launchNoteTest({ mainEntry, userData, navigationLabel: '设置' });
  assert.equal((await session.evaluate('window.modelConfigTest.credentials()')).decrypts, true, '正常退出后凭据必须可解密');
  await waitFor(() => session.evaluate('window.modelConfigTest.idle()'), 'pipeline idle before restart test');
  const interrupted = await invoke('createMaterialVectorGeneration', libraryPath, { ...candidate, requestedModel: 'model-restart' });
  await waitFor(() => restartRequestSeen, 'real in-flight embedding request');
  await session.dispose(); session = await launchNoteTest({ mainEntry, userData, navigationLabel: '设置' });
  assert.equal((await invoke('listMaterialVectorGenerations', libraryPath)).find(row => row.id === interrupted.id).state, 'INTERRUPTED');
  assert.equal((await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash, locked.profileHash);
  await invoke('resumeMaterialVectorGeneration', libraryPath, interrupted.id);
  await waitFor(async () => {
    const row = (await invoke('listMaterialVectorGenerations', libraryPath)).find(row => row.id === interrupted.id);
    if (row.state === 'FAILED') throw new Error(`Restarted generation failed: ${row.error}`);
    return row.state === 'READY';
  }, 'generation resumed after process restart');
  checks.push('real Electron process terminates during an HTTP embedding request; restart preserves the active profile, marks the build interrupted and resumes it to READY');
  checks.push('explicit confirmation commits the connection and keeps the locked profile');
  console.log('model configuration runtime: draft catalog and confirmation UI passed');
  await invoke('saveModelConfiguration', { kind: 'hub', provider: { id: 'custom', patch: { endpoint: originalEndpoint } } });
  const beforeProfileSave = await snapshot();
  const profiles = { defaultProfileId: 'model_fixture_0001', profiles: [{ id: 'model_fixture_0001', label: '兼容网关验证', config: { kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint: draftEndpoint, model: 'chat-a', apiKey: 'fixture-draft-key', remoteContentConsent: true } }] };
  const pending = await invoke('saveModelConfiguration', { kind: 'profiles', settings: profiles });
  assert.equal(pending.status, 'confirmation-required'); assert.equal(pending.impacts[0].libraryName, '采购制度库'); assert.deepEqual(await snapshot(), beforeProfileSave);
  await assert.rejects(() => invoke('saveAiModelSettings', profiles), /确认后保存/); assert.deepEqual(await snapshot(), beforeProfileSave);
  await assert.rejects(() => invoke('saveModelProvider', 'custom', { endpoint: draftEndpoint }), /确认后保存/); assert.deepEqual(await snapshot(), beforeProfileSave);
  const legacyConfig = profiles.profiles[0].config;
  await assert.rejects(() => invoke('saveAiProviderConfig', legacyConfig), /确认后保存/); assert.deepEqual(await snapshot(), beforeProfileSave);
  const profileSaved = await invoke('saveModelConfiguration', { kind: 'profiles', settings: profiles }, pending.confirmationToken);
  assert.equal(profileSaved.status, 'saved'); assert.equal((await snapshot()).settings.profiles[0].config.endpoint, draftEndpoint);
  assert.equal((await snapshot()).providers.custom.endpoint, draftEndpoint);
  checks.push('language-model synchronization and legacy save IPCs enforce the same confirmation; confirmed profiles commit together');
  assert.equal((await invoke('getMaterialEmbeddingProfile', libraryPath)).profile.profileHash, locked.profileHash);
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/model-configuration.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), method: 'isolated real Electron/main/preload/React with local fixture HTTP and real safeStorage; not live provider acceptance', checks, originalUserDataModified: false, screenshot: path.join(output, 'connection-impact.png') }, null, 2));
  await fs.rm(path.join(output, 'runtime-failure.png'), { force: true });
  console.log(`verify-model-configuration-electron: ${checks.length} runtime checks passed`);
} catch (error) {
  if (session) {
    await fs.writeFile(path.join(output, 'runtime-failure.png'), Buffer.from(await session.evaluate('window.modelConfigTest.capture()'), 'base64'));
    console.error(await session.evaluate("JSON.stringify({buttons:[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(n=>n.textContent.trim()),inputs:[...document.querySelectorAll('input')].filter(n=>n.getClientRects().length).map(n=>n.getAttribute('aria-label')),alerts:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent)})"));
    console.error(await invoke('listMaterialVectorGenerations', libraryPath));
    console.error('restart credential diagnostics', await session.evaluate('window.modelConfigTest.credentials()'));
  }
  throw error;
} finally {
  await session?.dispose();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging);
  assert.ok(path.basename(temporary).startsWith('model-configuration-electron-'));
  await fs.rm(temporary, { recursive: true, force: true });
}

async function invoke(method, ...args) { return session.evaluate(`window.electronAPI[${JSON.stringify(method)}](...${JSON.stringify(args)})`); }
async function snapshot() { const config = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8')); return { providers: config.modelProviders, secrets: config.modelProviderSecrets, hub: config.modelHub, settings: config.aiModelSettings, profileSecrets: config.aiProfileSecrets, legacy: config.aiProvider, legacySecret: config.aiProviderSecret }; }
async function button(label) { await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('button')].findLast(n=>n.getClientRects().length && n.textContent.trim()===${JSON.stringify(label)} && !n.disabled && !n.getAttribute('data-loading')))`), label); await session.evaluate(`[...document.querySelectorAll('button')].findLast(n=>n.getClientRects().length && n.textContent.trim()===${JSON.stringify(label)}).click()`); }
async function fill(selector, text) { await waitFor(() => session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), selector); await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await session.send('Input.insertText', { text }); }
