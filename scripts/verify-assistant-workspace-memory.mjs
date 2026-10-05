import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `assistant-workspace-memory-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const emptyWorkspaceDir = path.join(stagingRoot, 'empty-workspace');
const libraryDir = path.join(stagingRoot, 'materials-library');
const compiledRoot = path.join(stagingRoot, 'compiled');
const databaseBundle = path.join(compiledRoot, 'electron', 'knowledge', 'assistantWorkspaceMemoryDatabase.js');
const repositoryBundle = path.join(compiledRoot, 'electron', 'knowledge', 'assistantWorkspaceMemoryRepository.js');
const identityBundle = path.join(compiledRoot, 'electron', 'knowledge', 'assistantLibraryIdentity.js');
let owner;
let verificationPassed = false;

try {
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(emptyWorkspaceDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });
  transpileTestModules([
    'electron/knowledge/assistantLibraryIdentity.ts',
    'electron/knowledge/assistantSessionScope.ts',
    'electron/knowledge/assistantWorkspaceMemoryTypes.ts',
    'electron/knowledge/assistantWorkspaceMemoryDatabase.ts',
    'electron/knowledge/assistantWorkspaceMemoryRepository.ts',
  ]);
  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const identityModule = await import(pathToFileURL(identityBundle).href);
  const {
    AssistantWorkspaceMemoryDatabase,
    getAssistantWorkspaceMemoryDatabasePath,
    migrateAssistantWorkspaceMemoryDatabase,
  } = databaseModule;
  const { AssistantWorkspaceMemoryReadOnlyError, AssistantWorkspaceMemoryRepository } = repositoryModule;
  const { createAssistantLibraryId } = identityModule;

  const databasePath = getAssistantWorkspaceMemoryDatabasePath(workspaceDir);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const seed = new Database(databasePath);
  seed.pragma('foreign_keys = ON');
  migrateAssistantWorkspaceMemoryDatabase(seed);
  const libraryId = createAssistantLibraryId(libraryDir);
  const now = '2026-08-26T08:00:00.000Z';
  seed.prepare(`
    INSERT INTO conversation_memory_libraries (library_id, library_path, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(libraryId, path.resolve(libraryDir), now, now);
  const sessionId = 'assistant-session-11111111-1111-4111-8111-111111111111';
  seed.prepare(`
    INSERT INTO assistant_workspace_sessions (
      session_id, library_id, title, is_pinned, last_turn_seq, created_at, updated_at
    ) VALUES (?, ?, '旧资料库会话', 1, 1, ?, ?)
  `).run(sessionId, libraryId, now, now);
  seed.prepare(`
    INSERT INTO assistant_workspace_turns (
      turn_id, session_id, turn_seq, user_text, assistant_text, scope_label,
      status, result_json, created_at, finished_at
    ) VALUES ('legacy-turn-1', ?, 1, '旧问题', '旧回答', '本次使用：旧资料库',
      'complete', '{}', ?, ?)
  `).run(sessionId, now, now);
  seed.close();
  const sourceHashBefore = fileHash(databasePath);

  owner = new AssistantWorkspaceMemoryDatabase();
  const repository = new AssistantWorkspaceMemoryRepository(owner, workspaceDir, libraryDir);
  const page = repository.listSessions();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].sessionId, sessionId);
  const detail = repository.getSession(sessionId);
  assert.equal(detail.turns[0].assistantText, '旧回答');
  assert.equal(detail.turns[0].status, 'complete');

  const writeActions = [
    () => repository.createSession(),
    () => repository.renameSession(sessionId, '不可写'),
    () => repository.setPinned(sessionId, false),
    () => repository.deleteSession(sessionId),
    () => repository.startTurn(sessionId, { turnId: 'blocked', userText: 'blocked', scopeLabel: 'blocked' }),
    () => repository.recoverInterruptedTurns(),
  ];
  for (const action of writeActions) {
    assert.throws(action, (error) => error instanceof AssistantWorkspaceMemoryReadOnlyError && error.code === 'ASSISTANT_WORKSPACE_MEMORY_READ_ONLY');
  }
  owner.closeAll();
  owner = undefined;
  assert.equal(fileHash(databasePath), sourceHashBefore, '只读兼容接口不得改变旧数据库');

  const emptyOwner = new AssistantWorkspaceMemoryDatabase();
  const emptyRepository = new AssistantWorkspaceMemoryRepository(emptyOwner, emptyWorkspaceDir, libraryDir);
  assert.deepEqual(emptyRepository.listSessions(), { items: [] });
  assert.equal(existsSync(getAssistantWorkspaceMemoryDatabasePath(emptyWorkspaceDir)), false, '只读兼容不得创建空旧库');
  emptyOwner.closeAll();

  verificationPassed = true;
  console.log('Assistant workspace memory read-only compatibility verification passed');
} finally {
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function fileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
