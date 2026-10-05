import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'model-configuration-unit-'));
let server;
try {
  const bundle = path.join(temporary, 'service.cjs');
  await build({ entryPoints: ['electron/knowledge/modelConfigurationService.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['better-sqlite3'], logLevel: 'silent', plugins: [{ name: 'fixture-safe-storage', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const safeStorage = { isEncryptionAvailable: () => !globalThis.__modelConfigEncryptionFail, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };` }));
  } }] });
  const { ModelConfigurationService, createModelConfigurationDraft, fetchModelProviderCatalog } = require(bundle);
  // 使用真实 modelHub 保存函数；只替换操作系统密钥加密，失败可在写入前注入。
  const hubBundle = path.join(temporary, 'hub.cjs');
  await build({ entryPoints: ['electron/knowledge/modelHub.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: hubBundle, logLevel: 'silent', plugins: [{ name: 'fixture-safe-storage', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const safeStorage = { isEncryptionAvailable: () => !globalThis.__modelConfigEncryptionFail, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };` }));
  } }] });
  const { saveModelHub, saveProviderConnection, readModelHub } = require(hubBundle);
  const oldEndpoint = 'https://gateway.example.com/v1';
  const nextEndpoint = 'https://next.example.com/v1';
  let data = {
    unrelated: { content: '保留用户设置' },
    modelHub: { version: 1, ollamaEndpoint: 'http://127.0.0.1:11434', slots: { generation: { source: 'ollama', model: 'chat-a' }, embedding: { source: 'custom', model: 'model-a' }, rerank: { source: 'none', model: '' } } },
    modelProviders: { custom: { endpoint: oldEndpoint, models: ['model-a'] } },
    modelProviderSecrets: { custom: Buffer.from('fixture-old-key').toString('base64') },
  };
  let commits = 0, failCommit = false, refreshes = 0;
  const store = {
    get store() { return data; },
    set store(value) { if (failCommit) throw new Error('fixture write failure'); data = structuredClone(value); commits++; },
    get: key => data[key], set: (key, value) => { data[key] = value; }, delete: key => { delete data[key]; },
  };
  const libraries = [{ path: path.join(temporary, '采购制度库'), alias: '采购制度库' }];
  const seed = async (library, sourceId = 'custom', endpoint = oldEndpoint) => {
    await fs.mkdir(path.join(library.path, '.menghan-meta'), { recursive: true });
    const db = new Database(path.join(library.path, '.menghan-meta/index.db'));
    db.exec("CREATE TABLE material_embedding_profile (singleton_id INTEGER PRIMARY KEY, state TEXT, profile_hash TEXT, source_id TEXT, endpoint_identity TEXT, requested_model TEXT); CREATE TABLE material_chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB);");
    db.prepare("INSERT INTO material_embedding_profile VALUES (1, 'LOCKED', 'fixture-profile', ?, ?, 'model-a')").run(sourceId, endpoint);
    db.prepare('INSERT INTO material_chunk_vectors VALUES (1, ?)').run(Buffer.from([1, 2, 3, 4])); db.close();
  };
  await seed(libraries[0]);
  const originalDb = await fs.readFile(path.join(libraries[0].path, '.menghan-meta/index.db'));
  const service = new ModelConfigurationService({ store, libraries: () => libraries, prepare(change, draft) {
    if (change.kind !== 'hub') throw new Error('fixture invalid action');
    if (change.provider) saveProviderConnection(draft, change.provider.id, change.provider.patch);
    if (change.hubPatch) saveModelHub(draft, change.hubPatch);
    return { hub: readModelHub(draft) };
  }, afterSave: () => { refreshes++; } });
  const original = structuredClone(data);
  const change = { kind: 'hub', provider: { id: 'custom', patch: { endpoint: nextEndpoint, apiKey: 'fixture-new-key' } }, hubPatch: { slots: { embedding: { source: 'custom', model: 'model-b' } } } };
  const pending = service.save(change);
  assert.equal(pending.status, 'confirmation-required'); assert.equal(pending.impacts[0].libraryName, '采购制度库');
  assert.deepEqual(data, original); assert.equal(commits, 0); assert.equal(refreshes, 0);
  assert.doesNotMatch(JSON.stringify(pending), /fixture-new-key|fixture-old-key/);
  assert.equal(service.save(change, 'forged-token').status, 'confirmation-required'); assert.deepEqual(data, original);
  libraries.push({ path: path.join(temporary, '应收管理库'), alias: '应收管理库' }); await seed(libraries[1]);
  const stale = service.save(change, pending.confirmationToken);
  assert.equal(stale.status, 'confirmation-required'); assert.equal(stale.impacts.length, 2); assert.deepEqual(data, original);
  const saved = service.save(change, stale.confirmationToken);
  assert.equal(saved.status, 'saved'); assert.equal(commits, 1); assert.equal(refreshes, 1);
  assert.equal(data.modelProviders.custom.endpoint, nextEndpoint); assert.equal(data.modelHub.slots.embedding.model, 'model-b');
  assert.equal(Buffer.from(data.modelProviderSecrets.custom, 'base64').toString(), 'fixture-new-key');
  assert.deepEqual(data.unrelated, original.unrelated);
  assert.deepEqual(await fs.readFile(path.join(libraries[0].path, '.menghan-meta/index.db')), originalDb, '端点确认不得修改 profile 或已有向量');
  const restored = service.save({ kind: 'hub', provider: { id: 'custom', patch: { endpoint: oldEndpoint } } });
  assert.equal(restored.status, 'saved', '恢复绑定地址不需要停用确认');
  assert.equal(service.save({ kind: 'hub', provider: { id: 'custom', patch: { endpoint: oldEndpoint + '/' } } }).status, 'saved', '等价地址不要求确认');
  assert.equal(service.save({ kind: 'hub', provider: { id: 'custom', patch: { apiKey: 'fixture-rotated-key' } } }).status, 'saved');
  assert.equal(service.save({ kind: 'hub', hubPatch: { slots: { embedding: { source: 'custom', model: 'model-c' } } } }).status, 'saved', '默认模型变化不影响已锁定资料库');
  const beforeFailure = structuredClone(data);
  globalThis.__modelConfigEncryptionFail = true;
  assert.throws(() => service.save(change), /系统安全存储不可用/); globalThis.__modelConfigEncryptionFail = false;
  assert.deepEqual(data, beforeFailure, '加密失败必须保留原连接及槽位');
  const diskPending = service.save(change); failCommit = true;
  assert.throws(() => service.save(change, diskPending.confirmationToken), /fixture write failure/); failCommit = false;
  assert.deepEqual(data, beforeFailure, '整体提交失败不得部分保存');
  libraries.push({ path: path.join(temporary, '本地规范库'), alias: '本地规范库' }); await seed(libraries[2], 'ollama', 'http://127.0.0.1:11434');
  assert.equal(service.save({ kind: 'hub', hubPatch: { ollamaEndpoint: 'http://127.0.0.1:11435' } }).status, 'confirmation-required');
  const missing = { path: path.join(temporary, '已离线资料库') }; libraries.push(missing);
  assert.throws(() => service.save(change), /当前不可访问/); libraries.pop();

  let failure = false, requests = 0;
  server = createServer((req, res) => { requests++; assert.equal(req.headers.authorization, 'Bearer fixture-draft-key'); res.setHeader('content-type', 'application/json'); res.statusCode = failure ? 401 : 200; res.end(JSON.stringify(failure ? { error: 'fixture unavailable' } : { data: [{ id: 'draft-model' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const draftEndpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const beforeCatalog = structuredClone(data);
  const catalog = await fetchModelProviderCatalog(store, 'custom', { endpoint: draftEndpoint, apiKey: 'fixture-draft-key' });
  assert.equal(catalog.result.available, true); assert.deepEqual(catalog.result.models, ['draft-model']); assert.deepEqual(data, beforeCatalog);
  failure = true; assert.equal((await fetchModelProviderCatalog(store, 'custom', { endpoint: draftEndpoint, apiKey: 'fixture-draft-key' })).result.available, false);
  assert.deepEqual(data, beforeCatalog);
  await assert.rejects(() => fetchModelProviderCatalog(store, 'custom', { endpoint: draftEndpoint }), /重新填写密钥/); assert.equal(requests, 2);
  assert.deepEqual(createModelConfigurationDraft(data).store, data);
  console.log('verify-model-configuration: confirmation/recheck, atomic save failures, key rotation/default isolation, read-only vector bindings, Ollama changes and draft catalog requests passed (fixture encryption and HTTP).');
} finally {
  delete globalThis.__modelConfigEncryptionFail;
  if (server) await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging);
  assert.ok(path.basename(temporary).startsWith('model-configuration-unit-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
