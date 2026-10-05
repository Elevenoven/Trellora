import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-write-${process.pid}-${Date.now()}`);
const storageWorkspace = path.join(stagingRoot, 'storage-workspace');
const logicalWorkspace = path.join(stagingRoot, 'logical-workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(logicalWorkspace, { recursive: true });
  transpileTestModules([
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryExplicitSaveService.ts',
  ]);
  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { detectExplicitMemoryStatement, isMostlyRedacted } = await load('electron/knowledge/memory/memoryText.ts');
  const { MemoryWriteError, MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { saveCompletedExplicitMemory, recoverCompletedExplicitMemories } = await load('electron/knowledge/memory/memoryExplicitSaveService.ts');

  owner = new QaMemoryDatabase();
  const database = owner.getDatabase(storageWorkspace);
  const resolver = new MemoryScopeResolver({
    getActiveWorkspacePath: () => logicalWorkspace,
    listRegisteredWorkspacePaths: () => [logicalWorkspace],
    getPrincipalId: () => 'principal-memory-write',
  });
  const scope = resolver.resolveActive().scope;
  const service = new MemoryWriteService(owner, storageWorkspace);
  service.updateWorkspaceConfig(scope, { enabled: true, maxItems: 50 });

  assert.equal(detectExplicitMemoryStatement('请记住：我偏好中文回答'), '我偏好中文回答');
  assert.equal(detectExplicitMemoryStatement('remember that, answer in Chinese'), 'answer in Chinese');
  assert.equal(detectExplicitMemoryStatement('记住'), undefined);
  for (const phrase of ['请你记住我是一个厨师', '请记住我是一个厨师', '帮我记住：我是一个厨师', '请你帮我记住我是一个厨师']) {
    assert.equal(detectExplicitMemoryStatement(phrase), '我是一个厨师');
  }
  assert.equal(detectExplicitMemoryStatement('记住，我还是厨师'), '我还是厨师');
  for (const phrase of ['你先记住，我还是个Python程序员呢', '请你先记住：我还是个Python程序员呢', '请先记住我还是个Python程序员呢']) {
    assert.equal(detectExplicitMemoryStatement(phrase), '我还是个Python程序员呢');
  }
  assert.equal(isMostlyRedacted('我还是厨师'), false, '未脱敏的短句不能被视为敏感内容');
  assert.equal(isMostlyRedacted('中文'), false);
  assert.equal(isMostlyRedacted('【已隐藏】我还是厨师'), true, '真正脱敏后的剩余内容仍须至少 6 rune');
  assert.equal(isMostlyRedacted('【已隐藏】我是一个厨师'), false);
  for (const phrase of ['不要记住我是一个厨师', '如果我说请你记住我是一个厨师', '他说“请记住我是一个厨师”', '请你记住：',
    '你先不要记住我是Python程序员', '如果你先记住我是Python程序员会怎么样', '他说“你先记住我是Python程序员”', '你先记住：', '你先记住，我']) {
    assert.equal(detectExplicitMemoryStatement(phrase), undefined);
  }
  // A completed canonical turn is the journal: save and receipt are atomic and restart-safe.
  const journal = (id, generation = 0, workspaceId = scope.workspaceId) => {
    const timestamp = new Date().toISOString();
    database.prepare(`INSERT OR IGNORE INTO qa_sessions (session_id,scope,title,created_at,updated_at)
      VALUES ('explicit-journal','chat','保存回执',?,?)`).run(timestamp, timestamp);
    database.prepare(`INSERT INTO qa_turns (turn_id,session_id,turn_seq,request_id,attempt_no,user_text,assistant_text,status,created_at,result_json,result_metadata_json)
      VALUES (?,'explicit-journal',?,?,1,'请你记住我是一个厨师','已了解','complete',?,'{}',?)`).run(id,
        database.prepare('SELECT COUNT(*) AS n FROM qa_turns').get().n + 1, id, timestamp, JSON.stringify({
          memoryScope: { workspaceId, principalId: scope.principalId }, memoryExtractionGeneration: generation,
          memoryExplicitSaveEnabled: true, memoryExplicitSavePending: true,
        }));
  };
  journal('journal-save');
  recoverCompletedExplicitMemories(owner, storageWorkspace, scope);
  const receipt = JSON.parse(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id = 'journal-save'").get().result_json).memorySave;
  assert.equal(receipt.status, 'saved');
  const savedOnce = saveCompletedExplicitMemory(owner, storageWorkspace, scope,
    { sessionId: 'explicit-journal', messageId: 'journal-save', userText: '请你记住我是一个厨师' });
  assert.deepEqual(savedOnce, receipt);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE id = ?').get(receipt.itemId).n, 1);
  journal('journal-short');
  database.prepare("UPDATE qa_turns SET user_text='记住，我还是厨师' WHERE turn_id='journal-short'").run();
  const shortReceipt = saveCompletedExplicitMemory(owner, storageWorkspace, scope,
    { sessionId: 'explicit-journal', messageId: 'journal-short', userText: '记住，我还是厨师' });
  assert.equal(shortReceipt.status, 'saved');
  assert.equal(database.prepare('SELECT content FROM memory_items WHERE id = ?').get(shortReceipt.itemId).content, '我还是厨师');
  assert.deepEqual(JSON.parse(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id='journal-short'").get().result_json).memorySave, shortReceipt);
  journal('journal-python');
  database.prepare("UPDATE qa_turns SET user_text='你先记住，我还是个Python程序员呢' WHERE turn_id='journal-python'").run();
  const pythonReceipt = saveCompletedExplicitMemory(owner, storageWorkspace, scope,
    { sessionId: 'explicit-journal', messageId: 'journal-python', userText: '你先记住，我还是个Python程序员呢' });
  assert.equal(pythonReceipt.status, 'saved');
  assert.equal(database.prepare('SELECT content FROM memory_items WHERE id = ?').get(pythonReceipt.itemId).content, '我还是个Python程序员呢');
  assert.deepEqual(JSON.parse(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id='journal-python'").get().result_json).memorySave, pythonReceipt);
  const shortService = new MemoryWriteService(owner, path.join(stagingRoot, 'short-workspace'));
  shortService.updateWorkspaceConfig(scope, { enabled: true });
  for (const content of ['中文', '我是厨师', 'I cook']) {
    const result = shortService.writeExplicit(scope, content, { sessionId: 'short-explicit', messageId: content });
    assert.equal(result.item.content, content); assert.equal(result.redacted, false);
  }
  assert.equal(shortService.createManual(scope, { kind: 'preference', content: '简洁' }).item.content, '简洁');
  assert.equal(shortService.write(scope, { kind: 'preference', content: '英文', origin: 'extracted', operation: 'add', inferred: false, memoryGeneration: 0 }).item.status, 'pending');
  journal('journal-disabled'); service.updateWorkspaceConfig(scope, { enabled: false });
  recoverCompletedExplicitMemories(owner, storageWorkspace, scope);
  assert.equal(JSON.parse(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id = 'journal-disabled'").get().result_json).memorySave.status, 'disabled');
  service.updateWorkspaceConfig(scope, { enabled: true });
  journal('journal-stale', 99); recoverCompletedExplicitMemories(owner, storageWorkspace, scope);
  assert.equal(JSON.parse(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id = 'journal-stale'").get().result_json).memorySave.code, 'STALE_MEMORY_SOURCE');
  journal('journal-other-owner', 0, 'different-workspace');
  saveCompletedExplicitMemory(owner, storageWorkspace, scope,
    { sessionId: 'explicit-journal', messageId: 'journal-other-owner', userText: '请你记住我是一个厨师' });
  assert.equal(database.prepare("SELECT result_json FROM qa_turns WHERE turn_id = 'journal-other-owner'").get().result_json, '{}');
  journal('journal-rollback');
  database.prepare("UPDATE qa_turns SET user_text='请你记住我是一名产品经理' WHERE turn_id='journal-rollback'").run();
  database.exec(`CREATE TEMP TRIGGER fail_explicit_receipt BEFORE UPDATE OF result_json ON qa_turns
    WHEN NEW.turn_id = 'journal-rollback' AND json_extract(NEW.result_json,'$.memorySave.status') = 'saved'
    BEGIN SELECT RAISE(ABORT, 'receipt fixture failure'); END;`);
  assert.equal(saveCompletedExplicitMemory(owner, storageWorkspace, scope,
    { sessionId: 'explicit-journal', messageId: 'journal-rollback', userText: '请你记住我是一名产品经理' }).status, 'failed');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE content='我是一名产品经理'").get().n, 0);
  database.exec('DROP TRIGGER fail_explicit_receipt');

  const explicit = service.writeExplicit(scope, '我偏好中文回答', { sessionId: 'session-a', messageId: 'message-a' });
  assert.equal(explicit.action, 'created');
  assert.equal(explicit.item.kind, 'fact');
  assert.equal(explicit.item.origin, 'explicit');
  assert.equal(explicit.item.status, 'active');
  assert.equal(explicit.item.importance, 4);
  const duplicate = service.writeExplicit(scope, '我偏好中文回答', { sessionId: 'session-a', messageId: 'message-a' });
  assert.equal(duplicate.action, 'unchanged', '完全相同的 live 内容不得更新时间或重复写入');
  assert.equal(duplicate.item.id, explicit.item.id);

  const original = service.createManual(scope, { kind: 'profile', topic: '生产数据库', content: '生产数据库使用 MySQL', importance: 5 });
  const corrected = service.createManual(scope, { kind: 'profile', topic: '生产数据库', content: '生产数据库使用 PostgreSQL', importance: 5 });
  assert.equal(corrected.action, 'created');
  assert.equal(corrected.replacedItemId, undefined);
  assert.equal(database.prepare('SELECT status, superseded_by FROM memory_items WHERE id = ?').get(original.item.id).status, 'active');
  assert.equal(database.prepare('SELECT superseded_by FROM memory_items WHERE id = ?').get(original.item.id).superseded_by, null);

  const pending = service.write(scope, { kind: 'task', content: '下周跟进续贷客户', origin: 'extracted', operation: 'add', sourceMessageId: 'source-pending', memoryGeneration: 0 });
  assert.equal(pending.item.status, 'pending');
  const confirmed = service.confirm(scope, pending.item.id);
  assert.equal(confirmed.status, 'active');
  assert.throws(() => service.confirm(scope, pending.item.id), (error) => error instanceof MemoryWriteError && error.code === 'MEMORY_CONFIRM_REQUIRES_PENDING');
  const rejected = service.write(scope, { kind: 'task', content: '明天联系张三', origin: 'extracted', operation: 'add', sourceMessageId: 'source-reject', memoryGeneration: 0 });
  assert.equal(service.reject(scope, rejected.item.id).status, 'archived');
  assert.throws(
    () => service.write(scope, { kind: 'task', content: '明天联系张三', origin: 'extracted', operation: 'add', sourceMessageId: 'source-reject', memoryGeneration: 0 }),
    (error) => error instanceof MemoryWriteError && error.code === 'MEMORY_PREVIOUSLY_FORGOTTEN',
  );

  const redacted = service.createManual(scope, { kind: 'fact', content: '测试环境令牌 token: sk-abcdefghijklmnopqrstuvwxyz1234567890，部署负责人是李四' });
  assert.equal(redacted.redacted, true);
  assert.match(redacted.item.content, /【已隐藏】/u);
  assert.throws(
    () => service.createManual(scope, { kind: 'fact', content: 'token: sk-abcdefghijklmnopqrstuvwxyz1234567890' }),
    (error) => error instanceof MemoryWriteError && error.code === 'MEMORY_SENSITIVE_CONTENT',
  );

  const deleted = service.createManual(scope, { kind: 'interest', content: '我喜欢深度阅读技术文档' });
  service.delete(scope, deleted.item.id);
  assert.throws(
    () => service.createManual(scope, { kind: 'interest', content: '我喜欢深度阅读技术文档' }),
    (error) => error instanceof MemoryWriteError && error.code === 'MEMORY_PREVIOUSLY_FORGOTTEN',
    '删除形成的墓碑不得被同一内容复活',
  );

  const removableWhileDisabled = service.createManual(scope, { kind: 'fact', content: '关闭开关后仍可遗忘已有记忆' });
  service.updateWorkspaceConfig(scope, { enabled: false });
  assert.throws(
    () => service.createManual(scope, { kind: 'fact', content: '关闭后不得新建长期记忆' }),
    (error) => error instanceof MemoryWriteError && error.code === 'MEMORY_DISABLED',
  );
  service.delete(scope, removableWhileDisabled.item.id);
  service.updateWorkspaceConfig(scope, { enabled: true });

  const editable = service.createManual(scope, { kind: 'preference', topic: '回复风格', content: '回答保持简洁', importance: 3 });
  const edited = service.updateManual(scope, editable.item.id, { content: '回答保持简洁并给出必要来源', importance: 99 });
  assert.equal(edited.origin, 'manual');
  assert.equal(edited.importance, 5);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_item_embeddings WHERE item_id = ?').get(editable.item.id).count, 0);

  service.updateWorkspaceConfig(scope, { maxItems: 1 });
  const high = service.createManual(scope, { kind: 'fact', topic: '容量高', content: '高重要度条目', importance: 5 });
  const low = service.createManual(scope, { kind: 'fact', topic: '容量低', content: '低重要度条目', importance: 1 });
  assert.equal(high.item.status, 'active');
  assert.ok(low.archivedItemIds.length >= 1, '超过 active 容量必须归档较低优先级条目');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE status = 'active'").get().count, 1);

  const page = service.list(scope, { limit: 2 });
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(service.list(scope, { limit: 2, cursor: page.nextCursor }).items.length >= 1, true);
  const exported = service.export(scope);
  assert.equal(exported.contractVersion, 'weknora-memory-contract-v1');
  assert.ok(exported.items.length >= 1);
  const cleared = service.clear(scope);
  assert.ok(cleared.deletedItems >= 1);
  assert.ok(cleared.retainedTombstones <= 500);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_items WHERE workspace_id = ? AND principal_id = ?').get(scope.workspaceId, scope.principalId).count, 0);
  assert.equal(database.prepare('SELECT item_count, block_text FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?').get(scope.workspaceId, scope.principalId).item_count, 0);
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  verifyProductionWiring();
  console.log('WeKnora M3 central memory write verification passed');
} finally {
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);

}

function load(relativePath) {
  return import(pathToFileURL(modulePath(relativePath)).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}

function verifyProductionWiring() {
  const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  assert.match(mainSource, /new MemoryScopeResolver\(/u, 'M3 必须在主进程派生可信长期记忆 scope');
  assert.match(mainSource, /function completeTurnPostProcess/u, 'M3 必须有统一的完成后处理入口');
  assert.equal((mainSource.match(/completeTurnPostProcess\(\{/gu) ?? []).length, 5, '四条问答链路必须共用完成后显式写入处理');
  for (const channel of [
    'memory:get-overview', 'memory:save-workspace-config', 'memory:list-items',
    'memory:create-item', 'memory:update-item', 'memory:delete-item',
    'memory:confirm-item', 'memory:reject-item', 'memory:clear', 'memory:export',
  ]) {
    assert.match(mainSource, new RegExp(`(?:ipcMain\\.handle|registerAppHandler)\\('${channel}'`, 'u'), `缺少管理 IPC：${channel}`);
  }
  const preloadSource = readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
  assert.match(preloadSource, /createLongTermMemoryItem/u, 'preload 必须公开受限的长期记忆管理能力');
}
