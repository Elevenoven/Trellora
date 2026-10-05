import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `qa-memory-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const legacyDirectory = path.join(workspaceDir, '.menghan-meta');
const legacyDatabasePath = path.join(legacyDirectory, 'qa-memory.db');
const compiledRoot = path.join(stagingRoot, 'compiled');
const databaseBundle = path.join(compiledRoot, 'electron', 'knowledge', 'qaMemoryDatabase.js');
const repositoryBundle = path.join(compiledRoot, 'electron', 'knowledge', 'qaMemoryRepository.js');
let owner;
let legacyDatabase;
let verificationPassed = false;

try {
  mkdirSync(legacyDirectory, { recursive: true });
  createLegacyV1Database(legacyDatabasePath);
  transpileTestModules([
    'electron/knowledge/assistantSessionScope.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/qaMemoryTypes.ts',
    'electron/knowledge/structuredOutputContract.ts',
    'electron/knowledge/qaConversationCheckpoint.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/qaCanonicalHistory.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/conversationArchiveContract.ts',
    'electron/knowledge/qaMemoryRepository.ts',
  ]);

  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const { QaMemoryDatabase, getQaMemoryDatabasePath, QA_MEMORY_SCHEMA_VERSION } = databaseModule;
  const { QaMemoryRepository } = repositoryModule;

  owner = new QaMemoryDatabase();
  const repository = new QaMemoryRepository(owner, workspaceDir);
  const databasePath = getQaMemoryDatabasePath(workspaceDir);
  assert.equal(databasePath, path.join(workspaceDir, 'ConversationMemory', 'qa-memory.db'));

  const firstPage = repository.listSessions({ pageSize: 50 });
  assert.equal(firstPage.items.length, 2, '开放问答和资料库问答历史必须出现在同一全局列表');
  assert.deepEqual(new Set(firstPage.items.map((session) => session.scope)), new Set(['chat', 'knowledge-base']));
  assert.equal(existsSync(databasePath), true, '新数据库必须创建在工作区 ConversationMemory 目录');
  assert.equal(existsSync(legacyDatabasePath), true, '旧数据库应保留为可回退备份');

  const sharedSessionId = 'assistant-session-11111111-1111-4111-8111-111111111111';
  const restored = repository.getSession(sharedSessionId);
  assert.equal(restored.turns.length, 1, '旧会话轮次必须完整迁移');
  assert.equal(restored.turns[0].assistantText, '旧开放问答回答');

  assert.throws(
    () => repository.ensureSession(sharedSessionId, 'knowledge-base', { libraryPath: 'E:\\Notes-Project\\Library-B' }),
    (error) => error?.code === 'QA_SESSION_MODE_MISMATCH',
    '有内容的开放式会话必须拒绝知识库轮次',
  );
  const knowledgeSessionId = 'assistant-session-22222222-2222-4222-8222-222222222222';
  repository.ensureSession(knowledgeSessionId, 'knowledge-base', { libraryPath: 'E:\\Notes-Project\\Library-B' });
  repository.startTurn(knowledgeSessionId, {
    turnId: 'qa-memory-knowledge-turn-1',
    userText: '请根据资料库回答。',
    scopeLabel: '本次使用：资料库 B',
  });
  repository.finalizeTurn(knowledgeSessionId, 'qa-memory-knowledge-turn-1', answerResult('这是独立的知识库回答。'));
  assert.equal(repository.getSession(sharedSessionId).turns.length, 1);
  assert.deepEqual(repository.getSession(knowledgeSessionId).turns.map((turn) => turn.scopeLabel), ['本次使用：资料库 B']);

  const emptySession = repository.createSession('chat');
  const adoptedEmptySession = repository.ensureSession(emptySession.sessionId, 'knowledge-base', { libraryPath: 'E:\\Notes-Project\\Library-C' });
  assert.equal(adoptedEmptySession.scope, 'knowledge-base', '空白新会话应允许直接切换问答模式');
  assert.equal(adoptedEmptySession.libraryPath, 'E:\\Notes-Project\\Library-C');

  const database = owner.getDatabase(workspaceDir);
  assert.equal(database.pragma('user_version', { simple: true }), QA_MEMORY_SCHEMA_VERSION);
  assert.equal(
    Object.hasOwn(JSON.parse(database.prepare(`SELECT result_json FROM qa_turns WHERE turn_id = 'qa-memory-legacy-turn-1'`).get().result_json), 'answer'),
    false,
    '升级后的旧轮次不得继续在 result_json 复制 assistant 原文',
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_qa_sessions_global_order'").get().count, 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  verifyRendererSeparatesSessionModes();
  verificationPassed = true;
  console.log('Mode-separated Q&A memory verification passed');
} finally {
  legacyDatabase?.close();
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

// Electron --runAsNode can enter Chromium platform teardown on managed
// Windows hosts; exit after resources are closed so a passing verifier remains
// a passing process.
if (verificationPassed) process.exit(0);

function createLegacyV1Database(databasePath) {
  legacyDatabase = new Database(databasePath);
  legacyDatabase.pragma('foreign_keys = ON');
  legacyDatabase.pragma('journal_mode = WAL');
  legacyDatabase.exec(`
    CREATE TABLE qa_sessions (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('chat', 'knowledge-base')),
      title TEXT NOT NULL,
      library_path TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
      last_turn_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_turn_seq >= 0),
      summarized_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_seq >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE qa_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
      turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
      user_text TEXT NOT NULL,
      assistant_text TEXT,
      scope_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'not-found', 'cancelled', 'error', 'interrupted')),
      user_tokens INTEGER NOT NULL DEFAULT 0,
      assistant_tokens INTEGER NOT NULL DEFAULT 0,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (session_id, turn_seq)
    );
    CREATE TABLE qa_summaries (
      batch_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
      turn_from INTEGER NOT NULL CHECK (turn_from > 0),
      turn_to INTEGER NOT NULL CHECK (turn_to >= turn_from),
      summary_text TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      compressor TEXT NOT NULL CHECK (compressor IN ('llm', 'fallback')),
      status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, turn_from)
    );
    CREATE INDEX idx_qa_sessions_order
      ON qa_sessions(scope, is_pinned DESC, updated_at DESC, session_id DESC);
    CREATE INDEX idx_qa_turns_session_seq ON qa_turns(session_id, turn_seq ASC);
    CREATE INDEX idx_qa_summaries_session_order ON qa_summaries(session_id, turn_from ASC);
    PRAGMA user_version = 1;
  `);
  const now = new Date().toISOString();
  const chatSessionId = 'assistant-session-11111111-1111-4111-8111-111111111111';
  const librarySessionId = 'assistant-session-22222222-2222-4222-8222-222222222222';
  legacyDatabase.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)
  `).run(chatSessionId, 'chat', '旧开放问答', null, 1, now, now);
  legacyDatabase.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)
  `).run(librarySessionId, 'knowledge-base', '旧资料库问答', 'E:\\Notes-Project\\Library-A', 0, now, now);
  legacyDatabase.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, user_text, assistant_text, scope_label,
      status, user_tokens, assistant_tokens, result_json, created_at, finished_at
    ) VALUES (?, ?, 1, ?, ?, ?, 'complete', 4, 6, ?, ?, ?)
  `).run(
    'qa-memory-legacy-turn-1',
    chatSessionId,
    '旧开放问答问题',
    '旧开放问答回答',
    '本次使用：无',
    JSON.stringify(answerResult('旧开放问答回答')),
    now,
    now,
  );
  // Keep the legacy writer open so the migration must include committed WAL
  // pages instead of relying on a close-time checkpoint.
}

function verifyRendererSeparatesSessionModes() {
  const workspaceSource = readFileSync(path.join(rootDir, 'src/components/AssistantWorkspaceView.tsx'), 'utf8');
  const panelSource = readFileSync(path.join(rootDir, 'src/components/KnowledgePanel.tsx'), 'utf8');
  const preloadSource = readFileSync(path.join(rootDir, 'electron/preload.ts'), 'utf8');
  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  assert.doesNotMatch(workspaceSource, /key=\{selectedLibrary/u, '数据源变化不得通过 React key 重建问答组件');
  assert.doesNotMatch(workspaceSource, /listQaMemorySessions\([^)]*qaScope/u, '历史列表不得按数据源过滤');
  assert.match(workspaceSource, /useState<string \| null>\(null\)/u, '首次进入问答页必须默认开放式问答');
  assert.match(workspaceSource, /createQaMemorySession\(sessionScope, selectedLibrary\?\.path\)/u);
  assert.match(workspaceSource, /开启新的问答会话？/u);
  assert.match(workspaceSource, /switchesMode && conversationHasContent/u, '只有已有内容的会话跨模式时才提示新建');
  assert.match(panelSource, /onConversationActivityChange\?\.\(messages\.length > 0\)/u);
  assert.doesNotMatch(panelSource, /切换数据源沿用同一会话/u);
  assert.match(preloadSource, /qa-memory:create-session', scope, libraryPath/u);
  assert.match(mainSource, /scope !== 'chat' && scope !== 'knowledge-base'/u);
}

function answerResult(answer) {
  return {
    type: 'answer',
    answer,
    provider: 'test',
    model: 'test-model',
    sourceNotes: [],
    retrievalMode: 'semantic',
    interactionRoute: 'react',
    completeness: 'complete',
    cacheUsage: { providerReported: false },
  };
}

function transpileTestModules(relativePaths) {
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const outputPath = path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
      fileName: sourcePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });
    writeFileSync(outputPath, output.outputText, 'utf8');
  }
}
