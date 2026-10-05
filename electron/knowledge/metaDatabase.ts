import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import type { AiInsight, AiInsightPayload } from './aiTypes';
import type { AiProviderKind } from './aiTypes';
import type { LearningPlan, OrganizationSuggestion } from './libraryAiTypes';
import type { NoteAnalysis, NoteAnalysisPayload, TagSuggestionConfidence } from './noteAnalysisTypes';
import type { IndexSyncResult, PersistedKnowledgeNote } from './types';

const sqliteVec = require('sqlite-vec') as { load(database: Database.Database): void };
const schemaVersion = 6;
const legacySemanticVectorTableName = 'semantic_chunk_vectors';

/** Delta writes query only affected paths. Shared material/memory tables are never rebuilt. */
export class KnowledgeProjectionDatabase {
  private readonly database: Database.Database;
  constructor(libraryPath: string) {
    const directory = getLibraryMetaDirectory(libraryPath);
    fs.mkdirSync(directory, { recursive: true });
    this.database = new Database(path.join(directory, 'index.db'));
    try {
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('foreign_keys = ON');
      migrate(this.database);
    } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }
  apply(notes: PersistedKnowledgeNote[], removed: string[], moves: Array<{ from: string; to: string }> = []): IndexSyncResult {
    const db = this.database;
    return db.transaction(() => {
      // Create the new parent before migrating references; deleting the old parent last avoids FK cascades.
      for (const move of moves) {
        db.prepare(`INSERT INTO notes (path, relative_path, title, kind, extension, content_hash, mtime_ms, indexed_at)
          SELECT ?, relative_path, title, kind, extension, content_hash, mtime_ms, indexed_at FROM notes WHERE path = ?`).run(move.to, move.from);
        for (const table of ['note_tags', 'note_headings', 'note_links', 'ai_artifacts', 'favorite_notes', 'note_analysis_runs']) {
          db.prepare(`UPDATE ${table} SET note_path = ? WHERE note_path = ?`).run(move.to, move.from);
        }
        // Analysis readers also use the serialized path; move it within the same transaction.
        db.prepare("UPDATE note_analysis_runs SET run_json = json_set(run_json, '$.notePath', ?) WHERE note_path = ?").run(move.to, move.to);
        db.prepare('DELETE FROM notes WHERE path = ?').run(move.from);
      }
      let indexed = 0, skipped = 0, deleted = 0;
      const find = db.prepare('SELECT content_hash, kind FROM notes WHERE path = ?');
      for (const note of notes) {
        const row = find.get(note.path) as { content_hash: string; kind: string } | undefined;
        if (row?.content_hash === note.facts.contentHash && row.kind === note.kind) {
          db.prepare('UPDATE notes SET relative_path = ?, title = ?, kind = ?, extension = ?, mtime_ms = ? WHERE path = ?').run(note.relativePath, note.title, note.kind, note.extension, note.mtimeMs, note.path);
          skipped++;
        } else { upsertKnowledgeNote(db, note); indexed++; }
      }
      for (const filePath of removed) deleted += db.prepare('DELETE FROM notes WHERE path = ?').run(filePath).changes;
      return { indexed, skipped, removed: deleted };
    })();
  }
}

function upsertKnowledgeNote(database: Database.Database, note: PersistedKnowledgeNote): void {
  database.prepare(`INSERT INTO notes (path, relative_path, title, kind, extension, content_hash, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET
    relative_path = excluded.relative_path, title = excluded.title, kind = excluded.kind, extension = excluded.extension,
    content_hash = excluded.content_hash, mtime_ms = excluded.mtime_ms, indexed_at = excluded.indexed_at`)
    .run(note.path, note.relativePath, note.title, note.kind, note.extension, note.facts.contentHash, note.mtimeMs);
  for (const table of ['note_tags', 'note_headings', 'note_links']) database.prepare(`DELETE FROM ${table} WHERE note_path = ?`).run(note.path);
  const tag = database.prepare('INSERT INTO note_tags (note_path, tag) VALUES (?, ?)');
  for (const value of note.facts.tags) tag.run(note.path, value);
  const heading = database.prepare('INSERT INTO note_headings (note_path, heading_id, heading_index, level, text, line) VALUES (?, ?, ?, ?, ?, ?)');
  for (const value of note.facts.headings) heading.run(note.path, value.id, value.index, value.level, value.text, value.line);
  const link = database.prepare('INSERT INTO note_links (note_path, target, alias) VALUES (?, ?, ?)');
  for (const value of note.facts.outgoingLinks) link.run(note.path, value.target, value.alias ?? null);
}

export function synchronizeKnowledgeIndex(libraryPath: string, notes: PersistedKnowledgeNote[]): IndexSyncResult {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const database = new Database(path.join(metaDirectory, 'index.db'));

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    migrate(database);
    return synchronize(database, notes);
  } finally {
    database.close();
  }
}

export function saveAiInsight(libraryPath: string, insight: Omit<AiInsight, 'generatedAt'>): AiInsight {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const database = new Database(path.join(metaDirectory, 'index.db'));
  const generatedAt = new Date().toISOString();

  try {
    database.pragma('foreign_keys = ON');
    migrate(database);
    database.prepare(`
      INSERT INTO ai_artifacts (note_path, content_hash, artifact_type, provider, model, payload_json, generated_at)
      VALUES (?, ?, 'note_insight', ?, ?, ?, ?)
      ON CONFLICT(note_path, content_hash, artifact_type, provider, model) DO UPDATE SET
        payload_json = excluded.payload_json,
        generated_at = excluded.generated_at
    `).run(
      insight.notePath,
      insight.contentHash,
      insight.provider,
      insight.model,
      JSON.stringify(toPayload(insight)),
      generatedAt,
    );
    return { ...insight, generatedAt };
  } finally {
    database.close();
  }
}

export function getAiInsight(libraryPath: string, notePath: string, contentHash: string): AiInsight | null {
  const databasePath = path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
  if (!fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true });

  try {
    const row = database.prepare(`
      SELECT provider, model, payload_json, generated_at
      FROM ai_artifacts
      WHERE note_path = ? AND content_hash = ? AND artifact_type = 'note_insight'
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(notePath, contentHash) as {
      provider: AiProviderKind;
      model: string;
      payload_json: string;
      generated_at: string;
    } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as AiInsightPayload;
    if (!isInsightPayload(payload)) return null;
    return {
      ...payload,
      notePath,
      contentHash,
      provider: row.provider,
      model: row.model,
      generatedAt: row.generated_at,
    };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function saveNoteAnalysis(libraryPath: string, analysis: Omit<NoteAnalysis, 'generatedAt'>): NoteAnalysis {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const database = new Database(path.join(metaDirectory, 'index.db'));
  const generatedAt = new Date().toISOString();
  try {
    database.pragma('foreign_keys = ON');
    migrate(database);
    return saveNoteAnalysisInDatabase(database, analysis, generatedAt);
  } finally {
    database.close();
  }
}

/** 批次仓库在最终提交事务内复用同一连接，避免完成状态与最终产物分离。 */
export function saveNoteAnalysisInDatabase(database: Database.Database, analysis: Omit<NoteAnalysis, 'generatedAt'>, generatedAt = new Date().toISOString()): NoteAnalysis {
  database.prepare(`
      INSERT INTO ai_artifacts (note_path, content_hash, artifact_type, provider, model, payload_json, generated_at)
      VALUES (?, ?, 'note_analysis', ?, ?, ?, ?)
      ON CONFLICT(note_path, content_hash, artifact_type, provider, model) DO UPDATE SET
        payload_json = excluded.payload_json,
        generated_at = excluded.generated_at
    `).run(
      analysis.notePath,
      analysis.sourceHash,
      analysis.provider,
      analysis.model,
      JSON.stringify(toNoteAnalysisPayload(analysis)),
      generatedAt,
    );
  return { ...analysis, generatedAt };
}

/** 概览任务复用笔记索引的迁移和短连接；调用方不得在回调内等待网络请求。 */
export function withKnowledgeDatabase<T>(libraryPath: string, operation: (database: Database.Database) => T): T {
  const directory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, 'index.db'));
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    migrate(database);
    return operation(database);
  } finally {
    database.close();
  }
}

export function getNoteAnalysis(libraryPath: string, notePath: string, sourceHash: string): NoteAnalysis | null {
  const databasePath = path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
  if (!fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare(`
      SELECT content_hash, provider, model, payload_json, generated_at
      FROM ai_artifacts
      WHERE note_path = ? AND artifact_type = 'note_analysis'
      ORDER BY CASE WHEN content_hash = ? THEN 0 ELSE 1 END, generated_at DESC
      LIMIT 1
    `).get(notePath, sourceHash) as ArtifactRow | undefined;
    return row ? parseNoteAnalysis(row, notePath, row.content_hash, row.content_hash !== sourceHash) : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function saveLearningPlan(libraryPath: string, plan: Omit<LearningPlan, 'generatedAt'>): LearningPlan {
  const generatedAt = saveLibraryAiArtifact(libraryPath, 'learning_plan', plan.provider, plan.model, plan.goal, { goal: plan.goal, steps: plan.steps });
  return { ...plan, generatedAt };
}

export function saveOrganizationSuggestion(
  libraryPath: string,
  suggestion: Omit<OrganizationSuggestion, 'generatedAt'>,
): OrganizationSuggestion {
  const generatedAt = saveLibraryAiArtifact(libraryPath, 'organization_suggestion', suggestion.provider, suggestion.model, 'library', suggestion);
  return { ...suggestion, generatedAt };
}

export function getFavoriteNotePaths(libraryPath: string): string[] {
  const databasePath = path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
  if (!fs.existsSync(databasePath)) return [];
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    migrate(database);
    return (database.prepare(`
      SELECT favorite.note_path
      FROM favorite_notes favorite
      JOIN notes ON notes.path = favorite.note_path
      ORDER BY favorite.created_at ASC
    `).all() as Array<{ note_path: string }>).map((row) => row.note_path);
  } finally {
    database.close();
  }
}

export function setFavoriteNote(libraryPath: string, notePath: string, favorite: boolean): string[] {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const database = new Database(path.join(metaDirectory, 'index.db'));
  try {
    database.pragma('foreign_keys = ON');
    migrate(database);
    if (favorite) {
      const note = database.prepare('SELECT path FROM notes WHERE path = ?').get(notePath);
      if (!note) throw new Error('只有已建立索引的笔记才能加入收藏。');
      database.prepare(`
        INSERT INTO favorite_notes (note_path, created_at) VALUES (?, ?)
        ON CONFLICT(note_path) DO NOTHING
      `).run(notePath, new Date().toISOString());
    } else {
      database.prepare('DELETE FROM favorite_notes WHERE note_path = ?').run(notePath);
    }
    return (database.prepare('SELECT note_path FROM favorite_notes ORDER BY created_at ASC').all() as Array<{ note_path: string }>)
      .map((row) => row.note_path);
  } finally {
    database.close();
  }
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      extension TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_tags (
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (note_path, tag)
    );
    CREATE TABLE IF NOT EXISTS note_headings (
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      heading_id TEXT NOT NULL,
      heading_index INTEGER NOT NULL,
      level INTEGER NOT NULL,
      text TEXT NOT NULL,
      line INTEGER NOT NULL,
      PRIMARY KEY (note_path, heading_index)
    );
    CREATE TABLE IF NOT EXISTS note_links (
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      target TEXT NOT NULL,
      alias TEXT,
      PRIMARY KEY (note_path, target, alias)
    );
    CREATE TABLE IF NOT EXISTS ai_artifacts (
      id INTEGER PRIMARY KEY,
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      UNIQUE(note_path, content_hash, artifact_type, provider, model)
    );
    CREATE TABLE IF NOT EXISTS library_ai_artifacts (
      artifact_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (artifact_type, provider, model, input_key)
    );
    CREATE TABLE IF NOT EXISTS favorite_notes (
      note_path TEXT PRIMARY KEY REFERENCES notes(path) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target);
    CREATE INDEX IF NOT EXISTS idx_ai_artifacts_note_hash ON ai_artifacts(note_path, content_hash);
    CREATE INDEX IF NOT EXISTS idx_library_ai_artifacts_type ON library_ai_artifacts(artifact_type, generated_at);
    CREATE INDEX IF NOT EXISTS idx_favorite_notes_created ON favorite_notes(created_at);
    CREATE TABLE IF NOT EXISTS note_analysis_runs (
      run_id TEXT PRIMARY KEY,
      note_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      run_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_analysis_current ON note_analysis_runs(note_path) WHERE is_current = 1;
    CREATE TABLE IF NOT EXISTS note_analysis_batches (
      run_id TEXT NOT NULL REFERENCES note_analysis_runs(run_id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY(run_id, batch_id),
      UNIQUE(run_id, batch_index)
    );
  `);

  // 普通笔记不再维护切块向量、语义索引或知识图谱；清理旧版本留下的派生数据。
  dropLegacySemanticVectorTable(database);
  database.exec(`
    DROP TABLE IF EXISTS semantic_chunks;
    DROP TABLE IF EXISTS semantic_index_meta;
    DROP TABLE IF EXISTS vector_index_entries;
    DROP TABLE IF EXISTS knowledge_graph_edges;
    DROP TABLE IF EXISTS knowledge_graph_nodes;
    DELETE FROM ai_artifacts WHERE artifact_type = 'knowledge_extraction';
  `);

  database.prepare(`
    INSERT INTO system_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(schemaVersion));
}

/**
 * vec0 虚拟表的 DROP 会先解析其模块，因此旧库即使只做删除也必须临时加载 sqlite-vec。
 * 扩展不可加载时保留这张已失效的旧表；它不会再被读取，也不能阻断普通笔记索引。
 */
function dropLegacySemanticVectorTable(database: Database.Database): void {
  const exists = database.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(legacySemanticVectorTableName);
  if (!exists) return;
  try {
    loadSqliteVecForLegacyCleanup(database);
    database.exec(`DROP TABLE IF EXISTS ${legacySemanticVectorTableName}`);
  } catch {
    // 缺少或无法加载扩展时降级为保留废弃表，避免影响笔记库扫描和关键词索引。
  }
}

function loadSqliteVecForLegacyCleanup(database: Database.Database): void {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const packagedExtensionPath = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')
    : '';
  if (packagedExtensionPath && fs.existsSync(packagedExtensionPath)) {
    database.loadExtension(packagedExtensionPath);
    return;
  }
  sqliteVec.load(database);
}

function toPayload(insight: Omit<AiInsight, 'generatedAt'>): AiInsightPayload {
  return {
    summary: insight.summary,
    keyPoints: insight.keyPoints,
    suggestedTags: insight.suggestedTags,
  };
}

interface ArtifactRow {
  content_hash: string;
  provider: AiProviderKind;
  model: string;
  payload_json: string;
  generated_at: string;
}

function toNoteAnalysisPayload(analysis: Omit<NoteAnalysis, 'generatedAt'>): NoteAnalysisPayload {
  return {
    summary: analysis.summary,
    keyPoints: analysis.keyPoints,
    tagCandidates: analysis.tagCandidates,
    ...(analysis.analysisVersion === 2 ? { analysisVersion: 2, runId: analysis.runId, totalBatches: analysis.totalBatches, completedBatches: analysis.completedBatches, batches: analysis.batches, processingMode: analysis.processingMode, preparationVersion: analysis.preparationVersion, preparationStats: analysis.preparationStats } : {}),
  };
}

function parseNoteAnalysis(row: ArtifactRow, notePath: string, sourceHash: string, isStale = false): NoteAnalysis | null {
  try {
    const payload = JSON.parse(row.payload_json) as Partial<NoteAnalysisPayload>;
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    if (!summary || !Array.isArray(payload.keyPoints) || !Array.isArray(payload.tagCandidates)) return null;
    const keyPoints = payload.keyPoints
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 8);
    const tagCandidates = payload.tagCandidates.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as { name?: unknown; confidence?: unknown; evidence?: unknown; sourceBatchIds?: unknown };
      const name = typeof candidate.name === 'string' ? candidate.name.trim().replace(/^#/, '').slice(0, 48) : '';
      const evidence = typeof candidate.evidence === 'string' ? (payload.analysisVersion === 2 ? candidate.evidence.trim() : candidate.evidence.trim().slice(0, 160)) : '';
      if (!name || !evidence) return [];
      const confidence: TagSuggestionConfidence = candidate.confidence === 'high' || candidate.confidence === 'low' ? candidate.confidence : 'medium';
      return [{ name, confidence, evidence, ...(Array.isArray(candidate.sourceBatchIds) ? { sourceBatchIds: candidate.sourceBatchIds.filter((id): id is string => typeof id === 'string') } : {}) }];
    }).slice(0, 5);
    return {
      notePath,
      sourceHash,
      provider: row.provider,
      model: row.model,
      generatedAt: row.generated_at,
      ...(isStale ? { isStale: true } : {}),
      summary: payload.analysisVersion === 2 ? summary : summary.slice(0, 1_000),
      keyPoints,
      tagCandidates,
      ...(payload.analysisVersion === 2 && Array.isArray(payload.batches) ? { analysisVersion: 2, runId: payload.runId, totalBatches: payload.totalBatches, completedBatches: payload.completedBatches, batches: payload.batches, processingMode: payload.processingMode, preparationVersion: payload.preparationVersion, preparationStats: payload.preparationStats } : {}),
    };
  } catch {
    return null;
  }
}

function isInsightPayload(value: unknown): value is AiInsightPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<AiInsightPayload>;
  return typeof payload.summary === 'string'
    && Array.isArray(payload.keyPoints)
    && Array.isArray(payload.suggestedTags);
}

function saveLibraryAiArtifact(
  libraryPath: string,
  artifactType: 'learning_plan' | 'organization_suggestion',
  provider: AiProviderKind,
  model: string,
  inputKey: string,
  payload: unknown,
): string {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const database = new Database(path.join(metaDirectory, 'index.db'));
  const generatedAt = new Date().toISOString();
  try {
    migrate(database);
    database.prepare(`
      INSERT INTO library_ai_artifacts (artifact_type, provider, model, input_key, payload_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_type, provider, model, input_key) DO UPDATE SET
        payload_json = excluded.payload_json, generated_at = excluded.generated_at
    `).run(artifactType, provider, model, inputKey, JSON.stringify(payload), generatedAt);
    return generatedAt;
  } finally {
    database.close();
  }
}

function synchronize(database: Database.Database, notes: PersistedKnowledgeNote[]): IndexSyncResult {
  return database.transaction(() => {
    const existingHashes = new Map<string, string>(
      (database.prepare('SELECT path, content_hash FROM notes').all() as Array<{ path: string; content_hash: string }>)
        .map((row) => [row.path, row.content_hash]),
    );
    const currentPaths = new Set(notes.map((note) => note.path));
    let indexed = 0;
    let skipped = 0;

    const upsert = database.transaction((note: PersistedKnowledgeNote) => {
      database.prepare(`
        INSERT INTO notes (path, relative_path, title, kind, extension, content_hash, mtime_ms, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(path) DO UPDATE SET
          relative_path = excluded.relative_path,
          title = excluded.title,
          kind = excluded.kind,
          extension = excluded.extension,
          content_hash = excluded.content_hash,
          mtime_ms = excluded.mtime_ms,
          indexed_at = excluded.indexed_at
      `).run(
        note.path,
        note.relativePath,
        note.title,
        note.kind,
        note.extension,
        note.facts.contentHash,
        note.mtimeMs,
      );
      database.prepare('DELETE FROM note_tags WHERE note_path = ?').run(note.path);
      database.prepare('DELETE FROM note_headings WHERE note_path = ?').run(note.path);
      database.prepare('DELETE FROM note_links WHERE note_path = ?').run(note.path);

      const insertTag = database.prepare('INSERT INTO note_tags (note_path, tag) VALUES (?, ?)');
      for (const tag of note.facts.tags) insertTag.run(note.path, tag);
      const insertHeading = database.prepare(`
        INSERT INTO note_headings (note_path, heading_id, heading_index, level, text, line)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const heading of note.facts.headings) {
        insertHeading.run(note.path, heading.id, heading.index, heading.level, heading.text, heading.line);
      }
      const insertLink = database.prepare('INSERT INTO note_links (note_path, target, alias) VALUES (?, ?, ?)');
      for (const link of note.facts.outgoingLinks) insertLink.run(note.path, link.target, link.alias ?? null);
    });

    for (const note of notes) {
      if (existingHashes.get(note.path) === note.facts.contentHash) {
        database.prepare('UPDATE notes SET relative_path = ?, title = ?, kind = ?, extension = ?, mtime_ms = ? WHERE path = ?').run(note.relativePath, note.title, note.kind, note.extension, note.mtimeMs, note.path);
        skipped++;
        continue;
      }
      upsert(note);
      indexed++;
    }

    const stalePaths = [...existingHashes.keys()].filter((storedPath) => !currentPaths.has(storedPath));
    const remove = database.prepare('DELETE FROM notes WHERE path = ?');
    for (const stalePath of stalePaths) remove.run(stalePath);

    return { indexed, skipped, removed: stalePaths.length };
  })();
}
