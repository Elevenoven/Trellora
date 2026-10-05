import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { lockMaterialEmbeddingProfile, readMaterialEmbeddingProfileFromDatabase, testMaterialEmbeddingCandidate, type MaterialEmbeddingProbe } from './materialEmbeddingProfile';
import type { MaterialEmbeddingAdapter } from './materialEmbeddingAdapters';
import { ensureMaterialVectorCoordinatorSchema, recoverExpiredMaterialEmbeddingLeases, synchronizeMaterialVectors } from './materialVectorCoordinator';
import { searchMaterialChunks } from './materialChunkSearch';
import { ensureMaterialVectorGenerationSchema, generationProfile, generationVectorTable, generationView, getActiveMaterialVectorTable, readActiveGeneration, type GenerationRow } from './materialVectorGenerationStore';
import type { MaterialVectorGeneration } from '../../shared/materialVectorGenerations';

interface GenerationPorts {
  sourcesHash: (libraryPath: string, documents: Array<{ id: string; hash: string }>) => string;
  assertIdle: (libraryPath: string) => void;
  adapter: (profile: MaterialVectorGeneration['profile']) => MaterialEmbeddingAdapter | undefined;
  appVersion: string;
}
const sqliteVec = require('sqlite-vec') as { load: (database: Database.Database) => void };

/** 新模型仅在隔离快照内重嵌入；验证完成后用一个 SQLite 事务切换 active 指针。 */
export class MaterialVectorGenerationService {
  private readonly running = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  private readonly starting = new Set<string>();
  private readonly startControllers = new Set<AbortController>();
  private readonly startTasks = new Set<Promise<MaterialVectorGeneration>>();
  private stopping = false;
  constructor(private readonly ports: GenerationPorts) {}
  get busy() { return this.running.size > 0 || this.starting.size > 0; }

  list(libraryPath: string): MaterialVectorGeneration[] {
    const database = this.open(libraryPath);
    try {
      const rows = database.prepare('SELECT * FROM material_vector_generations ORDER BY created_at DESC').all() as GenerationRow[];
      for (const row of rows) if (row.state === 'BUILDING' && !this.running.has(this.key(libraryPath, row.id))) {
        row.state = 'INTERRUPTED';
        database.prepare("UPDATE material_vector_generations SET state='INTERRUPTED' WHERE id=?").run(row.id);
      }
      return rows.map(generationView);
    } finally { database.close(); }
  }

  /** 首次请求先探测并建立完整快照；返回后后台任务可取消，不改变当前检索空间。 */
  create(libraryPath: string, candidate: unknown, probe: MaterialEmbeddingProbe): Promise<MaterialVectorGeneration> {
    if (this.stopping) throw new Error('应用正在退出，不能开始新的索引构建。');
    this.ports.assertIdle(libraryPath);
    const libraryKey = path.resolve(libraryPath);
    if (this.busyFor(libraryPath) || this.starting.has(libraryKey)) throw new Error('这个资料库已有索引代际正在构建。');
    this.starting.add(libraryKey);
    const controller = new AbortController();
    this.startControllers.add(controller);
    const completion = this.createSnapshot(libraryPath, candidate, probe, controller.signal).finally(() => {
      this.starting.delete(libraryKey); this.startControllers.delete(controller);
    });
    this.startTasks.add(completion);
    void completion.then(() => this.startTasks.delete(completion), () => this.startTasks.delete(completion));
    return completion;
  }

  private async createSnapshot(libraryPath: string, candidate: unknown, probe: MaterialEmbeddingProbe, signal: AbortSignal): Promise<MaterialVectorGeneration> {
    let createdRoot: string | undefined;
    let registered = false;
    try {
      const tested = await testMaterialEmbeddingCandidate({ candidate, probe, signal });
      signal.throwIfAborted();
      this.ports.assertIdle(libraryPath);
      const id = crypto.randomUUID().replaceAll('-', '');
      const root = this.stagingRoot(libraryPath, id);
      createdRoot = root;
      fs.mkdirSync(path.join(root, '.menghan-meta'), { recursive: true });
      const source = this.open(libraryPath);
      try {
        if (!readMaterialEmbeddingProfileFromDatabase(source).profile) throw new Error('请先锁定资料库的初始向量模型。');
        if (!source.prepare("SELECT 1 FROM sqlite_master WHERE name='material_chunks'").get()) throw new Error('请先完成资料切块和关键词索引，再建立新代际。');
        ensureMaterialVectorCoordinatorSchema(source);
        const before = this.fingerprints(source, libraryPath);
        await source.backup(this.databasePath(root));
        signal.throwIfAborted();
        this.ports.assertIdle(libraryPath);
        if (this.fingerprints(source, libraryPath).projection !== before.projection) throw new Error('资料正在更新，请完成后重新创建索引代际。');
      } finally { source.close(); }
      const shadow = this.open(root);
      try {
        // 只清理新快照：原数据库的 profile、vec0 和词法投影始终保留。
        const tables = shadow.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING vec0%'").all() as Array<{ name: string }>;
        for (const table of tables) if (/^material_chunk_vectors(?:_g_[a-f0-9]{32})?$/u.test(table.name)) shadow.exec(`DROP TABLE ${table.name}`);
        shadow.exec('DROP TABLE material_vector_active_generation; DROP TABLE material_vector_generations; DELETE FROM material_embedding_profile; DELETE FROM material_chunk_vector_meta; DROP TABLE IF EXISTS material_chunk_embedding_state; DROP TABLE IF EXISTS material_embedding_jobs;');
      } finally { shadow.close(); }
      const profile = await lockMaterialEmbeddingProfile({ libraryPath: root, candidate: tested.candidate, probe: async () => tested, signal, appVersion: this.ports.appVersion });
      signal.throwIfAborted();
      const database = this.open(libraryPath), snapshot = this.open(root);
      try {
        const fingerprints = this.fingerprints(snapshot, libraryPath);
        const total = (snapshot.prepare('SELECT COUNT(*) AS count FROM material_chunks').get() as { count: number }).count;
        database.prepare(`INSERT INTO material_vector_generations (id,state,profile_json,vector_table,projection_hash,sources_hash,total,created_at)
          VALUES (?,'BUILDING',?,?,?,?,?,?)`).run(id, JSON.stringify(profile), generationVectorTable(id), fingerprints.projection, fingerprints.sources, total, new Date().toISOString());
        registered = true;
      } finally { database.close(); snapshot.close(); }
      this.run(libraryPath, id);
      return this.list(libraryPath).find(row => row.id === id)!;
    } finally {
      if (createdRoot && !registered) {
        const parent = path.join(getLibraryMetaDirectory(libraryPath), 'vector-generations');
        // 只移除本次分配的 UUID 目录；异常路径保留，不能覆盖原始创建错误。
        if (path.dirname(createdRoot) === parent && /^[a-f0-9]{32}$/u.test(path.basename(createdRoot))) fs.rmSync(createdRoot, { recursive: true, force: true });
      }
    }
  }

  resume(libraryPath: string, id: string): void {
    if (this.stopping) throw new Error('应用正在退出，不能继续索引构建。');
    const row = this.row(libraryPath, id);
    if (!['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(row.state)) throw new Error('只有失败、取消或中断的索引代际可以继续。');
    if (this.busyFor(libraryPath)) throw new Error('请先完成或取消当前构建。');
    const database = this.open(libraryPath);
    try { this.assertCurrent(database, libraryPath, row); } finally { database.close(); }
    const shadow = this.open(this.stagingRoot(libraryPath, id));
    try {
      recoverExpiredMaterialEmbeddingLeases(shadow, new Date(8_640_000_000_000_000));
      shadow.prepare("UPDATE material_chunk_embedding_state SET state='PENDING',attempt_count=0,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL WHERE state<>'SUCCEEDED'").run();
    } finally { shadow.close(); }
    this.update(libraryPath, id, 'BUILDING');
    this.run(libraryPath, id);
  }

  cancel(libraryPath: string, id: string): void { this.running.get(this.key(libraryPath, id))?.controller.abort(); }
  async wait(libraryPath: string, id: string): Promise<void> { await this.running.get(this.key(libraryPath, id))?.completion; }
  /** 连首次模型探测和 SQLite 快照也纳入退出等待，避免关闭窗口后继续注册构建。 */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.startControllers) controller.abort();
    for (const task of this.running.values()) task.controller.abort();
    await Promise.allSettled([...this.startTasks, ...[...this.running.values()].map(task => task.completion)]);
  }

  /** 激活/回滚共用同一门：来源及 chunk 指纹一致、全量读回合格、所有旧写入已结束。 */
  activate(libraryPath: string, id: string): MaterialVectorGeneration {
    this.ports.assertIdle(libraryPath);
    if (this.busyFor(libraryPath)) throw new Error('索引构建尚未结束，不能切换。');
    const database = this.open(libraryPath);
    let attached = false;
    try {
      const target = this.readRow(database, id);
      if (target.state === 'ACTIVE') return generationView(target);
      if (!['READY', 'RETIRED'].includes(target.state)) throw new Error('只有验收完成或已保留的索引代际可以切换。');
      this.assertCurrent(database, libraryPath, target);
      const adapter = this.ports.adapter(generationProfile(target));
      if (!adapter) throw new Error('目标代际的模型连接不可用，请恢复对应的地址与密钥。');
      if (target.state === 'READY') {
        database.prepare('ATTACH DATABASE ? AS generation_source').run(this.databasePath(this.stagingRoot(libraryPath, id))); attached = true;
      }
      database.transaction(() => {
        this.assertCurrent(database, libraryPath, target);
        const current = readMaterialEmbeddingProfileFromDatabase(database).profile!;
        const active = readActiveGeneration(database);
        const previousId = active?.id ?? 'original';
        const fingerprints = this.fingerprints(database, libraryPath);
        if (!active) database.prepare(`INSERT OR IGNORE INTO material_vector_generations
          (id,state,profile_json,vector_table,projection_hash,sources_hash,total,completed,created_at)
          VALUES ('original','ACTIVE',?,?,?,?,?,?,?)`).run(JSON.stringify(current), getActiveMaterialVectorTable(database), fingerprints.projection, fingerprints.sources, target.total, target.total, new Date().toISOString());
        const oldState = this.stateTable(previousId);
        database.exec(`DROP TABLE IF EXISTS ${oldState}; CREATE TABLE ${oldState} AS SELECT * FROM material_chunk_embedding_state;`);
        const previousTotal = (database.prepare('SELECT COUNT(*) AS count FROM material_chunks').get() as { count: number }).count;
        const previousCompleted = (database.prepare("SELECT COUNT(*) AS count FROM material_chunk_embedding_state WHERE state='SUCCEEDED' AND profile_hash=?").get(current.profileHash) as { count: number }).count;
        database.prepare('UPDATE material_vector_generations SET projection_hash=?, sources_hash=?,total=?,completed=? WHERE id=?').run(fingerprints.projection, fingerprints.sources, previousTotal, previousCompleted, previousId);
        const table = generationVectorTable(id), states = this.stateTable(id);
        if (target.state === 'READY') {
          database.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(embedding float[${generationProfile(target).vectorDimension}] distance_metric=cosine);
            INSERT INTO ${table}(rowid,embedding) SELECT rowid,embedding FROM generation_source.material_chunk_vectors;
            CREATE TABLE ${states} AS SELECT * FROM generation_source.material_chunk_embedding_state;
            INSERT OR IGNORE INTO material_embedding_jobs SELECT * FROM generation_source.material_embedding_jobs;`);
        }
        this.validate(database, target, table, states);
        database.exec(`DELETE FROM material_chunk_embedding_state; INSERT INTO material_chunk_embedding_state SELECT * FROM ${states};`);
        const profile = generationProfile(target);
        const meta = database.prepare('INSERT INTO material_chunk_vector_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        for (const [key, value] of Object.entries({ embedding_model: profile.requestedModel, vector_dimension: String(profile.vectorDimension), embedding_profile_hash: profile.profileHash })) meta.run(key, value);
        database.prepare("UPDATE material_vector_generations SET state='RETIRED' WHERE state='ACTIVE'").run();
        database.prepare("UPDATE material_vector_generations SET state='ACTIVE',error=NULL WHERE id=?").run(id);
        database.prepare('INSERT INTO material_vector_active_generation VALUES (1,?) ON CONFLICT(singleton_id) DO UPDATE SET generation_id=excluded.generation_id').run(id);
      }).immediate();
      return generationView(this.readRow(database, id));
    } finally { if (attached) database.exec('DETACH DATABASE generation_source'); database.close(); }
  }

  private run(libraryPath: string, id: string): void {
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      try {
        const row = this.row(libraryPath, id), profile = generationProfile(row);
        const adapter = this.ports.adapter(profile);
        if (!adapter) throw new Error('新模型连接不可用，请恢复后继续。');
        const root = this.stagingRoot(libraryPath, id);
        const report = await synchronizeMaterialVectors({ libraryPath: root, profile, adapter, signal: controller.signal,
          onProgress: progress => { const database = this.open(libraryPath); try { database.prepare('UPDATE material_vector_generations SET completed=? WHERE id=?').run(progress.completedItems, id); } finally { database.close(); } } });
        if (report.state === 'CANCELLED') { this.update(libraryPath, id, 'CANCELLED'); return; }
        if (report.state !== 'SUCCEEDED') throw new Error(report.errorMessage || '向量批处理未完成。');
        const shadow = this.open(root);
        let samples: Array<{ text: string; chunkId: string }>;
        try { this.validate(shadow, row, 'material_chunk_vectors', 'material_chunk_embedding_state'); samples = shadow.prepare('SELECT text,chunk_id AS chunkId FROM material_chunks ORDER BY id LIMIT 3').all() as Array<{ text: string; chunkId: string }>; } finally { shadow.close(); }
        for (const sample of samples) {
          if (controller.signal.aborted) { this.update(libraryPath, id, 'CANCELLED'); return; }
          const result = await searchMaterialChunks({ libraryPath: root, query: sample.text, mode: 'semantic', adapter: { ...adapter, embedBatch: input => adapter.embedBatch({ ...input, signal: controller.signal }) } });
          if (!result.vectorIndexed || !result.results.some(hit => hit.chunkId === sample.chunkId && hit.matchTypes.includes('语义')) || result.notice) throw new Error('新代际的语义检索读回验证失败。');
        }
        const database = this.open(libraryPath);
        try { this.assertCurrent(database, libraryPath, row); database.prepare("UPDATE material_vector_generations SET state='READY',completed=total,evaluated_queries=?,error=NULL WHERE id=?").run(samples.length, id); } finally { database.close(); }
      } catch (error) { this.update(libraryPath, id, controller.signal.aborted ? 'CANCELLED' : 'FAILED', error instanceof Error ? error.message : '索引代际构建失败。'); }
      finally { this.running.delete(this.key(libraryPath, id)); }
    });
    this.running.set(this.key(libraryPath, id), { controller, completion });
  }

  private fingerprints(database: Database.Database, libraryPath: string) {
    const chunks = database.prepare('SELECT * FROM material_chunks ORDER BY id').all();
    const documents = database.prepare('SELECT document_id AS id,source_content_hash AS hash FROM material_chunk_documents ORDER BY document_id').all() as Array<{ id: string; hash: string }>;
    return { projection: crypto.createHash('sha256').update(JSON.stringify({ chunks, documents })).digest('hex'), sources: this.ports.sourcesHash(libraryPath, documents) };
  }
  private assertCurrent(database: Database.Database, libraryPath: string, row: GenerationRow) {
    const actual = this.fingerprints(database, libraryPath);
    if (actual.projection !== row.projection_hash || actual.sources !== row.sources_hash) throw new Error('资料或切块已经变化，不能切换或续跑这个快照。请创建新的索引代际。');
  }
  private validate(database: Database.Database, row: GenerationRow, table: string, states: string) {
    const profile = generationProfile(row);
    const vectors = database.prepare(`SELECT rowid,embedding FROM ${table}`).all() as Array<{ rowid: number; embedding: Buffer }>;
    if (vectors.length !== row.total) throw new Error('新代际的向量数量与资料块不一致。');
    const invalid = database.prepare(`SELECT 1 FROM material_chunks c LEFT JOIN ${states} s ON s.chunk_rowid=c.id LEFT JOIN ${table} v ON v.rowid=c.id
      WHERE s.state IS NULL OR s.state<>'SUCCEEDED' OR s.profile_hash<>? OR s.chunk_content_hash<>c.content_hash OR v.rowid IS NULL LIMIT 1`).get(profile.profileHash);
    if (invalid) throw new Error('新代际的块身份、模型或批次状态校验失败。');
    for (const vector of vectors) {
      if (vector.embedding.byteLength !== profile.vectorDimension * 4) throw new Error('向量维度读回不一致。');
      for (let offset = 0; offset < vector.embedding.length; offset += 4) if (!Number.isFinite(vector.embedding.readFloatLE(offset))) throw new Error('向量包含非有限值。');
    }
  }
  private readRow(database: Database.Database, id: string): GenerationRow {
    generationVectorTable(id);
    const row = database.prepare('SELECT * FROM material_vector_generations WHERE id=?').get(id) as GenerationRow | undefined;
    if (!row) throw new Error('找不到这个索引代际。'); return row;
  }
  private row(libraryPath: string, id: string) { const database = this.open(libraryPath); try { return this.readRow(database, id); } finally { database.close(); } }
  private update(libraryPath: string, id: string, state: MaterialVectorGeneration['state'], error?: string) { const database = this.open(libraryPath); try { database.prepare('UPDATE material_vector_generations SET state=?,error=? WHERE id=?').run(state, error ?? null, id); } finally { database.close(); } }
  private open(libraryPath: string) { const database = new Database(this.databasePath(libraryPath)); sqliteVec.load(database); database.pragma('busy_timeout=5000'); ensureMaterialVectorGenerationSchema(database); return database; }
  private databasePath(libraryPath: string) { return path.join(getLibraryMetaDirectory(libraryPath), 'index.db'); }
  private stagingRoot(libraryPath: string, id: string) { if (id === 'original') throw new Error('初始代际没有构建目录。'); generationVectorTable(id); return path.join(getLibraryMetaDirectory(libraryPath), 'vector-generations', id); }
  private stateTable(id: string) { generationVectorTable(id); return `material_generation_state_${id}`; }
  private key(libraryPath: string, id: string) { return `${path.resolve(libraryPath)}:${id}`; }
  private busyFor(libraryPath: string) { return this.starting.has(path.resolve(libraryPath)) || [...this.running.keys()].some(key => key.startsWith(`${path.resolve(libraryPath)}:`)); }
}
