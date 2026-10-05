const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const coordinatorBundlePath = path.join(rootDir, '.material-live-coordinator.cjs');
const adapterBundlePath = path.join(rootDir, '.material-live-adapters.cjs');

(async () => {
  try {
    const argv = process.argv.slice(2);
    // Electron --run-as-node keeps the script path in argv; plain node does not.
    if (argv[0] && !argv[0].startsWith('-') && argv[0].toLowerCase().endsWith('.cjs')) argv.shift();
    await main(argv);
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
})();

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.libraryPath || process.env.MENGHAN_LIVE_ACCEPT !== 'true') {
    console.log('LIVE_ACCEPTANCE_SKIPPED: 真实 API 会发送资料库文本；请设置 MENGHAN_LIVE_ACCEPT=true 和 --library / MENGHAN_MATERIAL_LIBRARY 后显式执行。');
    process.exitCode = 2;
    return;
  }

  try {
    await buildBundles();
    const coordinator = require(coordinatorBundlePath);
    const adapters = require(adapterBundlePath);
    const databasePath = path.join(path.resolve(options.libraryPath), '.menghan-meta', 'index.db');
    assert.ok(fs.existsSync(databasePath), `资料库索引不存在：${databasePath}`);
    const database = new Database(databasePath);
    sqliteVec.load(database);
    coordinator.ensureMaterialChunkSearchSchema(database);
    coordinator.ensureMaterialEmbeddingProfileSchema(database);
    coordinator.ensureMaterialVectorCoordinatorSchema(database);
    const status = coordinator.readMaterialEmbeddingProfileFromDatabase(database);
    database.close();
    assert.equal(status.state, 'LOCKED', '真实验收要求资料库已有 LOCKED profile');
    const profile = status.profile;
    const adapter = createLiveAdapter(adapters, profile);
    const probe = await adapter.probe(profile, new AbortController().signal);
    assert.equal(probe.vectorDimension, profile.vectorDimension, `真实 API 探测维度 ${probe.vectorDimension} 与 profile ${profile.vectorDimension} 不一致`);
    if (probe.responseModel) assert.equal(probe.responseModel, profile.responseModel ?? profile.requestedModel, '真实 API 返回模型与 profile 不一致');

    const result = options.pending
      ? await coordinator.synchronizeMaterialVectors({
        libraryPath: path.resolve(options.libraryPath),
        profile,
        adapter,
        documentIds: options.documentIds,
        timeoutMs: 120_000,
      })
      : null;
    const after = readProjectionSummary(databasePath, profile, coordinator);
    console.log(JSON.stringify({
      mode: options.pending ? 'probe-and-pending-vectors' : 'probe-only',
      sourceId: profile.sourceId,
      requestedModel: profile.requestedModel,
      profileHash: profile.profileHash,
      vectorDimension: profile.vectorDimension,
      probeDimension: probe.vectorDimension,
      ...(result ? { jobState: result.state, completedItems: result.completedItems, failedItems: result.failedItems, retryCount: result.retryCount } : {}),
      projection: after,
      nextRunForKeyRotation: '更换同一 sourceId 的 API Key 后，用同一命令再次执行；profileHash 应保持不变，已完成 chunk 不应重复请求。',
    }, null, 2));
  } finally {
    removeQuietly(coordinatorBundlePath);
    removeQuietly(adapterBundlePath);
  }
}

async function buildBundles() {
  const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['better-sqlite3', 'sqlite-vec'] };
  await Promise.all([
    build({ ...options, entryPoints: [path.join(rootDir, 'electron/pipeline/materialVectorCoordinator.ts')], outfile: coordinatorBundlePath }),
    build({ ...options, entryPoints: [path.join(rootDir, 'electron/pipeline/materialEmbeddingAdapters.ts')], outfile: adapterBundlePath }),
  ]);
}

function createLiveAdapter(adapters, profile) {
  const endpoint = (process.env.MENGHAN_MATERIAL_EMBEDDING_ENDPOINT || profile.endpointIdentity).trim();
  assert.equal(normalizeEndpoint(endpoint), profile.endpointIdentity, '环境变量 endpoint 与 LOCKED profile 不一致，拒绝发送资料库文本。');
  if (profile.transportKind === 'ollama') return adapters.createMaterialEmbeddingAdapter({ kind: 'ollama', endpoint });
  assert.equal(process.env.MENGHAN_REMOTE_CONTENT_CONSENT, 'true', '远程真实验收必须设置 MENGHAN_REMOTE_CONTENT_CONSENT=true。');
  const apiKey = process.env.MENGHAN_MATERIAL_EMBEDDING_API_KEY?.trim();
  assert.ok(apiKey, '远程真实验收必须通过 MENGHAN_MATERIAL_EMBEDDING_API_KEY 提供临时 API Key。');
  return adapters.createMaterialEmbeddingAdapter({ kind: 'remote', endpoint, apiKey });
}

function readProjectionSummary(databasePath, profile, coordinator) {
  const database = new Database(databasePath);
  sqliteVec.load(database);
  try {
    const vectors = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${coordinator.getActiveMaterialVectorTable(database)}`).get().count) || 0;
    const state = database.prepare("SELECT COUNT(*) AS count FROM material_chunk_embedding_state WHERE state = 'SUCCEEDED' AND profile_hash = ?").get(profile.profileHash).count;
    const vectorProfileHash = database.prepare("SELECT value FROM material_chunk_vector_meta WHERE key = 'embedding_profile_hash'").get()?.value ?? '';
    return { vectors, succeededStates: Number(state) || 0, vectorProfileHash, profileHashMatches: vectorProfileHash === profile.profileHash };
  } finally {
    database.close();
  }
}

function normalizeEndpoint(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

function parseArgs(argv) {
  const options = { libraryPath: process.env.MENGHAN_MATERIAL_LIBRARY?.trim(), pending: false, documentIds: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--library') options.libraryPath = argv[++index];
    else if (argument === '--pending') options.pending = true;
    else if (argument === '--documents') options.documentIds = String(argv[++index]).split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--help' || argument === '-h') {
      console.log('用法：verify-material-live-acceptance.cjs --library <path> [--pending] [--documents doc-1,doc-2]');
      process.exit(0);
    } else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function removeQuietly(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch { /* 仅清理临时 bundle，不影响验收结果。 */ }
}

module.exports = { normalizeEndpoint };
