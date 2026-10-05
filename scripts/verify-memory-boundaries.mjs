import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-boundaries-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const libraryDir = path.join(stagingRoot, 'library');
const outputs = {
  qaDatabase: path.join(stagingRoot, 'qa-memory-database.cjs'),
  qaRepository: path.join(stagingRoot, 'qa-memory-repository.cjs'),
  assistantDatabase: path.join(stagingRoot, 'assistant-memory-database.cjs'),
  assistantRepository: path.join(stagingRoot, 'assistant-memory-repository.cjs'),
  snapshot: path.join(stagingRoot, 'current-note-snapshot.cjs'),
};

assertTemporaryPath(stagingRoot);
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(libraryDir, { recursive: true });

let qaOwner;
let assistantOwner;
let verificationPassed = false;
try {
  await Promise.all([
    bundle('electron/knowledge/qaMemoryDatabase.ts', outputs.qaDatabase),
    bundle('electron/knowledge/qaMemoryRepository.ts', outputs.qaRepository),
    bundle('electron/knowledge/assistantMemoryDatabase.ts', outputs.assistantDatabase),
    bundle('electron/knowledge/assistantMemoryRepository.ts', outputs.assistantRepository),
    bundle('electron/knowledge/currentNoteSnapshot.ts', outputs.snapshot),
  ]);

  const { QaMemoryDatabase, getQaMemoryDatabasePath } = await load(outputs.qaDatabase);
  const { QaMemoryRepository } = await load(outputs.qaRepository);
  const { AssistantMemoryDatabase, getAssistantMemoryDatabasePath } = await load(outputs.assistantDatabase);
  const { AssistantMemoryRepository } = await load(outputs.assistantRepository);
  const { createCurrentNoteSnapshot } = await load(outputs.snapshot);

  const qaDatabasePath = getQaMemoryDatabasePath(workspaceDir);
  const assistantDatabasePath = getAssistantMemoryDatabasePath(libraryDir);
  const legacyDatabasePath = path.join(workspaceDir, 'ConversationMemory', 'conversation-memory.db');
  assert.notEqual(path.resolve(qaDatabasePath), path.resolve(assistantDatabasePath));

  qaOwner = new QaMemoryDatabase();
  const qaRepository = new QaMemoryRepository(qaOwner, workspaceDir);
  const chatSessionId = 'assistant-session-00000000-0000-4000-8000-000000000001';
  qaRepository.ensureSession(chatSessionId, 'chat', { title: '开放式问答基线' });
  qaRepository.startTurn(chatSessionId, {
    turnId: 'qa-boundary-turn-00000001',
    userText: '先进行普通聊天。',
    scopeLabel: '本次使用：无',
  });
  qaRepository.finalizeTurn(chatSessionId, 'qa-boundary-turn-00000001', answerResult('普通聊天回答。'));
  assert.throws(
    () => qaRepository.ensureSession(chatSessionId, 'knowledge-base', { libraryPath: libraryDir }),
    (error) => error?.code === 'QA_SESSION_MODE_MISMATCH',
  );
  const knowledgeSessionId = 'assistant-session-00000000-0000-4000-8000-000000000002';
  qaRepository.ensureSession(knowledgeSessionId, 'knowledge-base', { title: '知识库问答基线', libraryPath: libraryDir });
  qaRepository.startTurn(knowledgeSessionId, {
    turnId: 'qa-boundary-turn-00000002',
    userText: '在独立会话中使用资料库。',
    scopeLabel: '本次使用：Phase 0 资料库',
  });
  qaRepository.finalizeTurn(knowledgeSessionId, 'qa-boundary-turn-00000002', answerResult('资料库回答。'));

  assert.deepEqual(qaRepository.getSession(chatSessionId).turns.map((turn) => turn.scopeLabel), ['本次使用：无']);
  assert.deepEqual(qaRepository.getSession(knowledgeSessionId).turns.map((turn) => turn.scopeLabel), ['本次使用：Phase 0 资料库']);
  assert.equal(existsSync(qaDatabasePath), true);
  assert.equal(existsSync(assistantDatabasePath), false, 'QA 写入不得隐式创建当前笔记 assistant-memory.db');
  assert.equal(existsSync(legacyDatabasePath), false, '新 QA 会话不得写入遗留 conversation-memory.db');

  const qaDatabase = qaOwner.getDatabase(workspaceDir);
  const qaCountsBeforeAssistantWrite = {
    sessions: countRows(qaDatabase, 'qa_sessions'),
    turns: countRows(qaDatabase, 'qa_turns'),
  };
  assert.deepEqual(qaCountsBeforeAssistantWrite, { sessions: 2, turns: 2 });

  const markdown = '# 记忆边界\n\n当前笔记记忆只写入资料库作用域数据库。\n';
  const snapshot = createCurrentNoteSnapshot({
    libraryPath: libraryDir,
    notePath: path.join(libraryDir, 'memory-boundary.md'),
    title: '记忆边界',
    contentHash: sha256(markdown),
    markdown,
    headings: [{ id: 'boundary', level: 1, text: '记忆边界', line: 1 }],
    revision: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
  });
  assistantOwner = new AssistantMemoryDatabase();
  const assistantRepository = new AssistantMemoryRepository(assistantOwner, libraryDir);
  assistantRepository.createSession({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    title: '当前笔记会话',
  });
  assert.equal(existsSync(assistantDatabasePath), true);
  assert.deepEqual({
    sessions: countRows(qaDatabase, 'qa_sessions'),
    turns: countRows(qaDatabase, 'qa_turns'),
  }, qaCountsBeforeAssistantWrite, '当前笔记记忆写入不得改变 qa-memory.db');

  const assistantDatabase = assistantOwner.getDatabase(libraryDir);
  const qaTables = tableNames(qaDatabase);
  const assistantTables = tableNames(assistantDatabase);
  assert.ok(qaTables.has('qa_sessions') && qaTables.has('qa_turns') && qaTables.has('qa_summaries'));
  assert.equal(
    [...qaTables].some((name) => name.startsWith('assistant_') && name !== 'assistant_used_memories'),
    false,
    'qa-memory.db 不得包含 current-note legacy 业务表；统一 used-memory 台账除外',
  );
  assert.ok(assistantTables.has('assistant_sessions') && assistantTables.has('assistant_turns'));
  assert.equal([...assistantTables].some((name) => name.startsWith('qa_')), false, 'assistant-memory.db 不得包含 QA 业务表');
  assert.deepEqual(qaDatabase.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(assistantDatabase.prepare('PRAGMA foreign_key_check').all(), []);

  verifyRendererUsesQaMemoryOnly();
  verificationPassed = true;
  console.log('Memory boundaries Phase 0 verification passed');
} finally {
  assistantOwner?.closeAll();
  qaOwner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function bundle(relativePath, outfile) {
  return build({
    entryPoints: [path.join(rootDir, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}

function answerResult(answer) {
  return {
    type: 'answer',
    answer,
    provider: 'test',
    model: 'phase-0-model',
    sourceNotes: [],
    retrievalMode: 'none',
    interactionRoute: 'chat',
    completeness: 'complete',
    cacheUsage: { providerReported: false },
  };
}

function countRows(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function tableNames(database) {
  return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function verifyRendererUsesQaMemoryOnly() {
  const rendererFiles = collectSourceFiles(path.join(rootDir, 'src'))
    .filter((filePath) => !filePath.endsWith(`${path.sep}electron.d.ts`));
  const legacySymbols = [
    'createAssistantWorkspaceSession',
    'listAssistantWorkspaceSessions',
    'getAssistantWorkspaceSession',
    'renameAssistantWorkspaceSession',
    'setAssistantWorkspaceSessionPinned',
    'deleteAssistantWorkspaceSession',
    'assistant-workspace-memory:',
  ];
  for (const filePath of rendererFiles) {
    const source = readFileSync(filePath, 'utf8');
    for (const symbol of legacySymbols) {
      assert.equal(source.includes(symbol), false, `Renderer 仍引用遗留工作区记忆：${path.relative(rootDir, filePath)} -> ${symbol}`);
    }
  }
  const workspaceView = readFileSync(path.join(rootDir, 'src', 'components', 'AssistantWorkspaceView.tsx'), 'utf8');
  for (const symbol of ['createQaMemorySession', 'listQaMemorySessions', 'getQaMemorySession', 'renameQaMemorySession', 'setQaMemorySessionPinned', 'deleteQaMemorySession']) {
    assert.match(workspaceView, new RegExp(symbol, 'u'), `独立问答 Renderer 必须使用 ${symbol}`);
  }
}

function collectSourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectSourceFiles(resolved));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) result.push(resolved);
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertTemporaryPath(target) {
  const stagingBase = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(stagingBase)) throw new Error(`临时目录越界：${target}`);
}
