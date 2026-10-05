import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-assistant-memory-${process.pid}-${Date.now()}`);
const outFile = process.env.ASSISTANT_MEMORY_REPOSITORY_BUNDLE || path.join(outDir, 'assistantMemory.cjs');
const databaseOutFile = process.env.ASSISTANT_MEMORY_DATABASE_BUNDLE || path.join(outDir, 'assistantMemoryDatabase.cjs');
const snapshotOutFile = process.env.ASSISTANT_MEMORY_SNAPSHOT_BUNDLE || path.join(outDir, 'snapshot.cjs');
const libraryDir = path.join(outDir, 'library');
mkdirSync(libraryDir, { recursive: true });

if (!process.env.ASSISTANT_MEMORY_REPOSITORY_BUNDLE || !process.env.ASSISTANT_MEMORY_DATABASE_BUNDLE) {
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryRepository.ts')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3'],
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryDatabase.ts')],
      outfile: databaseOutFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3'],
    }),
  ]);
}

const memoryModule = await import(pathToFileURL(outFile).href);
const databaseModule = await import(pathToFileURL(databaseOutFile).href);
const snapshotModule = process.env.ASSISTANT_MEMORY_SNAPSHOT_BUNDLE
  ? await import(pathToFileURL(snapshotOutFile).href)
  : await import(pathToFileURL(path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')).href).catch(async () => {
    await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotOutFile, bundle: true, platform: 'node', format: 'cjs' });
    return import(pathToFileURL(snapshotOutFile).href);
  });
const { AssistantMemoryRepository } = memoryModule;
const { AssistantMemoryDatabase } = databaseModule;
const { createCurrentNoteSnapshot } = snapshotModule;

const markdown = '# 项目约束\n\nP4 必须使用独立 SQLite 会话库，不能复用 index.db。\n\n## 隔离\n\n会话 A 与会话 B 不得共享问题、回答或证据。\n';
const snapshot = createCurrentNoteSnapshot({
  libraryPath: libraryDir,
  notePath: path.join(libraryDir, '架构.md'),
  title: '架构',
  contentHash: sha256(markdown),
  markdown,
  headings: [
    { id: '项目约束', level: 1, text: '项目约束', line: 1, index: 0 },
    { id: '隔离', level: 2, text: '隔离', line: 5, index: 1 },
  ],
  revision: 1,
});

const owner = new AssistantMemoryDatabase();
const repository = new AssistantMemoryRepository(owner, libraryDir);
assert.deepEqual(repository.getSettings().mode, 'persistent');
assert.equal(repository.setSettings('persistent').mode, 'persistent');

const sessionA = repository.createSession({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, title: '会话 A' });
const sessionB = repository.createSession({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, title: '会话 B' });
assert.equal(repository.listSessions({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash }).items.length, 2);
const scopeA = repository.resolveScope({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, sessionId: sessionA.sessionId });
const scopeB = repository.resolveScope({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, sessionId: sessionB.sessionId });
const scopedA = repository.withScope(scopeA);
const scopedB = repository.withScope(scopeB);
const pendingA = await scopedA.startTurn({ userText: '为什么不能复用索引库？', route: 'current-note-react', contextMode: 'react-search', providerFingerprint: 'test|model', model: 'model' });
const citation = createCitation(snapshot, 3, 3);
const storedToolEvents = [
  { tool: 'search_note', state: 'started', message: '定位相关原文。', inputSummary: '关键词：独立 SQLite' },
  {
    tool: 'search_note',
    state: 'completed',
    message: '已定位到 1 个候选片段。',
    outputSummary: '已定位到 1 个候选片段。',
    contentPreviews: [{ kind: 'candidate', headingPath: ['项目约束'], lineFrom: 1, lineTo: 3, text: 'P4 必须使用独立 SQLite 会话库。', truncated: false }],
    elapsedMs: 12,
  },
  { tool: 'read_library_note_section', state: 'started', message: '读取推荐章节原文。', inputSummary: '章节标识：隔离' },
  {
    tool: 'read_library_note_section',
    state: 'completed',
    message: '已读取章节原文。',
    outputSummary: '原文已经写入 Evidence Ledger。',
    contentPreviews: [{ kind: 'evidence', headingPath: ['项目约束', '隔离'], lineFrom: 5, lineTo: 7, text: '会话 A 与会话 B 不得共享问题、回答或证据。', truncated: false }],
    sectionNavigation: {
      queryTermCount: 2,
      evaluatedSectionCount: 8,
      ambiguous: false,
      fallbackUsed: true,
      candidates: [{ headingPath: ['项目约束', '恢复'], lineFrom: 9, lineTo: 12, score: 86.41, matchedTerms: ['会话', '恢复'] }],
    },
    elapsedMs: 18,
  },
];
await scopedA.finalizeTurn(pendingA.turnId, snapshot, {
  answer: '因为索引库可重建，用户会话不能被静默清理。',
  completeness: 'complete',
  stopReason: 'answered',
  contextMode: 'react-search',
  usage: { inputTokens: 42, toolEvents: storedToolEvents, executionElapsedMs: 1_520 },
  evidence: [citation],
});
const storedTurnA = repository.getSession(scopeA).turns.items[0];
assert.deepEqual(storedTurnA.toolEvents, storedToolEvents, '公开工具轨迹必须随会话恢复');
assert.equal(storedTurnA.executionElapsedMs, 1_520);
assert.equal(scopedA.loadContext(snapshot).entries.length, 1);
assert.equal(scopedB.loadContext(snapshot).entries.length, 0, '不同会话不得读取 A 的证据或回答');

const database = owner.getDatabase(libraryDir);
assert.throws(() => database.prepare('INSERT INTO assistant_turn_evidence (session_id, turn_id, evidence_id) VALUES (?, ?, ?)').run(scopeB.sessionId, 'missing-turn', citation.evidenceId), /FOREIGN KEY constraint failed/);
assert.equal(database.prepare("SELECT instr(group_concat(sql, ' '), 'rawMarkdown') AS leaked FROM sqlite_master WHERE type = 'table'").get().leaked, 0);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assistant_evidence_refs WHERE preview LIKE ?').get('%独立 SQLite 会话库%').count, 1);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assistant_evidence_refs WHERE preview LIKE ?').get('%会话 A 与会话 B 不得共享问题、回答或证据%').count, 0, '数据库不得保存完整原文');

const pendingB = await scopedB.startTurn({ userText: '未完成的轮次', route: 'current-note-react', contextMode: 'react-search', providerFingerprint: 'test|model', model: 'model' });
assert.ok(pendingB.turnSeq === 1);
owner.closeAll();
const reopenedOwner = new AssistantMemoryDatabase();
const reopenedRepository = new AssistantMemoryRepository(reopenedOwner, libraryDir);
assert.equal(reopenedRepository.recoverInterruptedTurns(), 1, '崩溃遗留 pending 轮次必须被中断，而不是重放');
const reopenedScopeA = reopenedRepository.resolveScope({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, sessionId: sessionA.sessionId });
assert.equal(reopenedRepository.withScope(reopenedScopeA).loadContext(snapshot).entries.length, 1, '明确选中的会话必须可跨重启恢复');
const reopenedScopeB = reopenedRepository.resolveScope({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash, sessionId: sessionB.sessionId });
assert.equal(reopenedRepository.getSession(reopenedScopeB).turns.items[0].status, 'interrupted');

const changedMarkdown = `${markdown}\n新增内容。\n`;
const changedSnapshot = createCurrentNoteSnapshot({
  libraryPath: libraryDir,
  notePath: path.join(libraryDir, '架构.md'),
  title: '架构',
  contentHash: sha256(changedMarkdown),
  markdown: changedMarkdown,
  headings: [
    { id: '项目约束', level: 1, text: '项目约束', line: 1, index: 0 },
    { id: '隔离', level: 2, text: '隔离', line: 5, index: 1 },
  ],
  revision: 2,
});
assert.equal(reopenedRepository.withScope(reopenedScopeA).loadContext(changedSnapshot).entries.length, 0, 'contentHash 变化后旧证据不得补水');
assert.equal(reopenedOwner.getDatabase(libraryDir).prepare("SELECT COUNT(*) AS count FROM assistant_evidence_refs WHERE state = 'stale'").get().count, 1);

const exportJson = reopenedRepository.exportSession(reopenedScopeA, 'json');
assert.equal(exportJson.format, 'json');
assert.match(exportJson.content, /会话 A/);
const backupPath = path.join(outDir, 'assistant-memory-backup.db');
await reopenedRepository.backup(backupPath);
assert.ok(existsSync(backupPath));
const backup = new Database(backupPath, { readonly: true });
assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
backup.close();

const indexPath = path.join(libraryDir, '.menghan-meta', 'index.db');
mkdirSync(path.dirname(indexPath), { recursive: true });
const index = new Database(indexPath);
index.exec('CREATE TABLE IF NOT EXISTS disposable_index (id INTEGER PRIMARY KEY)');
index.close();
writeFileSync(indexPath, 'recreated index', 'utf8');
assert.ok(existsSync(path.join(libraryDir, '.menghan-meta', 'assistant-memory.db')), 'index.db 重建不得影响独立会话库');

reopenedRepository.deleteSession(reopenedScopeA);
assert.equal(reopenedRepository.listSessions({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: changedSnapshot.contentHash }).items.some((item) => item.sessionId === sessionA.sessionId), false);
assert.equal(reopenedRepository.listSessions({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: changedSnapshot.contentHash }).items.some((item) => item.sessionId === sessionB.sessionId), true, '删除 A 不得影响 B');
reopenedOwner.closeAll();

const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const preloadSource = readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
assert.match(mainSource, /assistant-memory:create-session/);
assert.match(mainSource, /assistant-memory:list-sessions/);
assert.match(mainSource, /assistant-memory:export-session/);
assert.match(mainSource, /assistantMemoryDatabase\.closeAll\(\)/);
assert.match(mainSource, /memoryScopeKey = .*sessionId.*contentHash/);
assert.match(mainSource, /route: 'current-note-direct'/);
assert.match(preloadSource, /createAssistantMemorySession/);
assert.match(preloadSource, /backupAssistantMemory/);

console.log('Assistant-memory P4 verification passed');

// Electron --runAsNode can enter Chromium platform teardown on managed Windows
// hosts; all database resources are closed above, so terminate a passing verifier.
process.exit(0);

function createCitation(currentSnapshot, lineFrom, lineTo) {
  const text = currentSnapshot.markdown.split(/\r?\n/u).slice(lineFrom - 1, lineTo).join('\n');
  return {
    evidenceId: `evidence-${sha256(`${currentSnapshot.snapshotId}\u0000${lineFrom}\u0000${lineTo}`).slice(0, 24)}`,
    notePath: currentSnapshot.notePath,
    contentHash: currentSnapshot.contentHash,
    headingPath: ['项目约束'],
    lineFrom,
    lineTo,
    quoteHash: sha256(text),
    preview: text.slice(0, 240),
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
