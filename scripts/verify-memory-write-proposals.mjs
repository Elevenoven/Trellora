import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const root = process.cwd();
const temporary = path.resolve('.package-staging', `memory-proposals-${process.pid}-${Date.now()}`);
assert.ok(temporary.startsWith(path.resolve('.package-staging') + path.sep));
const compiled = path.join(temporary, 'compiled');
const storage = path.join(temporary, 'storage');
const logical = path.join(temporary, 'logical');
const checks = [];
let owner;
try {
  mkdirSync(logical, { recursive: true });
  transpileLocalModules(root, compiled, ['electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryScope.ts', 'electron/knowledge/memory/memoryExplicitSaveService.ts',
    'electron/knowledge/memory/memoryExtractionService.ts']);
  const load = relative => import(pathToFileURL(path.join(compiled, relative + '.js')).href);
  const { QaMemoryDatabase, getQaMemoryDatabasePath, migrateQaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService');
  const { memoryTargetFingerprint, memoryProposalFingerprint } = await load('electron/knowledge/memory/memoryWritePolicy');
  const { saveCompletedExplicitMemory } = await load('electron/knowledge/memory/memoryExplicitSaveService');
  const { detectExplicitMemoryStatement } = await load('electron/knowledge/memory/memoryText');
  const { MemoryExtractionService } = await load('electron/knowledge/memory/memoryExtractionService');
  owner = new QaMemoryDatabase();
  const resolver = new MemoryScopeResolver({ getActiveWorkspacePath: () => logical,
    listRegisteredWorkspacePaths: () => [logical], getPrincipalId: () => 'proposal-owner' });
  const scope = resolver.resolveActive().scope;
  const db = owner.getDatabase(storage);
  const writer = new MemoryWriteService(owner, storage);
  writer.updateWorkspaceConfig(scope, { enabled: true, writeMode: 'auto', maxItems: 200 });
  const item = id => writer.list(scope).items.find(row => row.id === id);
  const review = proposal => ({ expectedAction: proposal.proposalAction,
    expectedProposalFingerprint: memoryProposalFingerprint(proposal) });
  const target = content => writer.createManual(scope, { kind: 'profile', topic: content, content }).item;
  const propose = (old, content, operation = 'replace') => writer.write(scope, {
    kind: old.kind, topic: old.topic, content, origin: 'extracted', operation,
    targetItemId: old.id, expectedTargetFingerprint: memoryTargetFingerprint(old), memoryGeneration: 0,
    sourceMessageId: `source-${old.id}`, inferred: false,
  }).item;
  const rejects = (fn, code) => assert.throws(fn, error => error.code === code, code);

  const java = writer.createManual(scope, { kind: 'profile', topic: '身份', content: '我是程序员，主要 Java 开发、Agent 开发', importance: 5 }).item;
  const python = writer.write(scope, { kind: 'profile', topic: '身份', content: '我也从事 Python 开发',
    origin: 'extracted', operation: 'add', inferred: false, memoryGeneration: 0 }).item;
  assert.equal(item(java.id).status, 'active'); assert.equal(python.status, 'pending');
  assert.notEqual(java.normalizedKey, python.normalizedKey);
  assert.equal(writer.getSubject(scope).blockText.includes(python.content), false);
  assert.equal(writer.confirm(scope, python.id, review(python)).status, 'active');
  checks.push('even inferred=false additions await review, stay out of resident memory and preserve Java/Agent');

  const old = target('演示企业开发方向为 Java');
  db.prepare('INSERT INTO memory_item_embeddings VALUES (?,?,?,?,?,?,?,?)').run(old.id, scope.workspaceId, scope.principalId,
    'fixture-model', 1, Buffer.from(new Float32Array([1]).buffer), 'fixture-fingerprint', new Date().toISOString());
  const proposal = propose(old, '演示企业开发方向改为 Python');
  assert.equal(proposal.status, 'pending'); assert.equal(item(old.id).status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_item_embeddings WHERE item_id=?').get(old.id).n, 1);
  rejects(() => writer.confirm(scope, proposal.id), 'PROPOSAL_REVIEW_REQUIRED');
  db.exec(`CREATE TEMP TRIGGER fail_proposal_commit BEFORE UPDATE ON memory_items
    WHEN NEW.id='${proposal.id}' AND NEW.status='active' BEGIN SELECT RAISE(ABORT,'proposal failure fixture'); END;`);
  assert.throws(() => writer.confirm(scope, proposal.id, review(proposal)), /proposal failure fixture/u);
  assert.equal(item(old.id).status, 'active'); assert.equal(item(proposal.id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_item_embeddings WHERE item_id=?').get(old.id).n, 1);
  db.exec('DROP TRIGGER fail_proposal_commit');
  assert.equal(writer.confirm(scope, proposal.id, review(proposal)).status, 'active');
  assert.equal(item(old.id).status, 'superseded'); assert.equal(item(old.id).supersededBy, proposal.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_item_embeddings WHERE item_id=?').get(old.id).n, 0);
  checks.push('pending preserves active/embedding; confirmation and crash rollback are atomic');

  const editedTarget = target('演示项目使用框架甲');
  const stale = propose(editedTarget, '演示项目使用框架乙');
  writer.updateManual(scope, editedTarget.id, { content: '人工修改为框架丙', expectedFingerprint: editedTarget.targetFingerprint });
  rejects(() => writer.confirm(scope, stale.id, review(stale)), 'MEMORY_CONFIRM_REQUIRES_PENDING');
  assert.equal(item(editedTarget.id).content, '人工修改为框架丙');
  const changedProposalTarget = target('待审项目使用框架丁');
  const editable = propose(changedProposalTarget, '待审项目使用框架戊');
  const edited = writer.updateManual(scope, editable.id, { content: '经人工修改的新提案', expectedFingerprint: editable.proposalFingerprint });
  assert.equal(edited.status, 'pending'); assert.equal(item(changedProposalTarget.id).status, 'active');
  rejects(() => writer.confirm(scope, edited.id, review(editable)), 'PROPOSAL_CHANGED');
  checks.push('edits invalidate old reviews; proposal editing stays pending');

  const retiring = target('用户曾保存的一条可撤销事实');
  const retirement = propose(retiring, retiring.content, 'retire');
  rejects(() => writer.updateManual(scope, retirement.id, { content: '改成另一件事情' }), 'RETIRE_PROPOSAL_READ_ONLY');
  writer.reject(scope, retirement.id);
  assert.equal(item(retiring.id).status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones WHERE fingerprint=?').get(
    (await load('electron/knowledge/memory/memoryText')).memoryFingerprint(retiring.content)).n, 0);
  const retirement2 = propose(retiring, retiring.content, 'retire');
  assert.equal(writer.confirm(scope, retirement2.id, review(retirement2)).status, 'archived');
  assert.equal(item(retiring.id).status, 'superseded');
  assert.equal(writer.list(scope, { statuses: ['active'] }).items.some(row => row.id === retirement2.id), false);
  checks.push('retire is read-only; rejection preserves original; confirmation creates no active replacement');

  const deleted = target('即将删除的演示旧目标'); const linked = propose(deleted, '演示新目标提案');
  writer.delete(scope, deleted.id);
  assert.equal(item(linked.id).status, 'archived'); assert.equal(item(linked.id).replacesId, null);
  assert.equal(item(linked.id).replacesSnapshot.id, deleted.id);
  assert.equal(item(linked.id).reviewReason, 'TARGET_DELETED');
  const expiredTarget = target('临期的演示事实'); const expiring = propose(expiredTarget, '临期事实的新提案');
  db.prepare('UPDATE memory_items SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expiredTarget.id);
  rejects(() => writer.confirm(scope, expiring.id, review(expiring)), 'TARGET_EXPIRED');
  writer.maintainForConsolidation(scope);
  assert.equal(item(expiring.id).status, 'archived');
  assert.equal(item(expiring.id).reviewReason, 'TARGET_EXPIRED');
  checks.push('deleted target leaves audit snapshot; expired target cannot be replaced');

  const conflicted = target('一条不能随意换目标的旧事实'); const first = propose(conflicted, '第一份提案');
  rejects(() => propose(conflicted, '第二份不同提案'), 'MEMORY_WRITE_CONFLICT');
  assert.equal(propose(conflicted, '第一份提案').id, first.id);
  const foreignResolver = new MemoryScopeResolver({ getActiveWorkspacePath: () => logical,
    listRegisteredWorkspacePaths: () => [logical], getPrincipalId: () => 'other-owner' });
  const foreignScope = foreignResolver.resolveActive().scope;
  writer.updateWorkspaceConfig(foreignScope, { enabled: true });
  rejects(() => writer.write(foreignScope, { kind: conflicted.kind, content: '不能越界的提案', origin: 'extracted',
    operation: 'replace', targetItemId: conflicted.id, expectedTargetFingerprint: conflicted.targetFingerprint, memoryGeneration: 0 }), 'TARGET_CHANGED');
  assert.throws(() => db.prepare("UPDATE memory_items SET status='pending',proposal_action=NULL WHERE id=?").run(java.id), /MEMORY_PROPOSAL_SHAPE_INVALID/u);
  assert.throws(() => db.prepare('UPDATE memory_items SET principal_id=? WHERE id=?').run(foreignScope.principalId, first.id), /MEMORY_PROPOSAL_SCOPE_INVALID/u);
  checks.push('duplicate proposal is idempotent; competing and cross-owner targets fail; DB guards enforce shape');

  let sequence = 0;
  const journal = userText => {
    const now = new Date().toISOString(), id = `proposal-journal-${++sequence}`;
    db.prepare("INSERT OR IGNORE INTO qa_sessions(session_id,scope,title,created_at,updated_at) VALUES ('proposal-session','chat','提案验证',?,?)").run(now, now);
    db.prepare(`INSERT INTO qa_turns(turn_id,session_id,turn_seq,request_id,user_text,assistant_text,status,created_at,result_metadata_json)
      VALUES (?,'proposal-session',?,?,?,'测试回答','complete',?,?)`).run(id, sequence, id, userText, now, JSON.stringify({
        memoryScope: scope, memoryExtractionGeneration: 0, memoryExplicitSaveEnabled: true, memoryExplicitSavePending: true,
      }));
    return saveCompletedExplicitMemory(owner, storage, scope, { sessionId: 'proposal-session', messageId: id, userText });
  };
  const explicit = journal('你先记住，我还是个Python程序员呢'); assert.equal(explicit.status, 'saved');
  const unclear = journal('请记住：更正，我不再从事 Java 开发'); assert.equal(unclear.status, 'pending');
  assert.equal(item(java.id).status, 'active');
  const deduplicated = writer.write(scope, { kind: 'profile', content: '我还是个Python程序员呢', origin: 'extracted',
    operation: 'add', inferred: false, sourceMessageId: 'proposal-journal-1', memoryGeneration: 0 });
  assert.equal(deduplicated.item.id, explicit.itemId); assert.equal(deduplicated.item.origin, 'explicit');
  rejects(() => writer.write(scope, { content: '旧协议不能直接覆盖', origin: 'extracted', memoryGeneration: 0 }), 'MEMORY_PROTOCOL_UPGRADE_REQUIRED');
  for (const phrase of ['记住了吗？', '记住了吗', '你先不要记住我是厨师', '他说“请记住我是厨师”']) assert.equal(detectExplicitMemoryStatement(phrase), undefined);
  assert.equal(detectExplicitMemoryStatement('请记住我不做外包'), '我不做外包');
  checks.push('model-free explicit journal, ambiguous pending receipt, source-specific dedup and negative/question boundary');

  const extraction = new MemoryExtractionService(owner, storage, { automaticWriteReady: () => false, revalidateScope: () => undefined, isRouteEnabled: () => true,
    resolveModel: async () => { throw new Error('paused model must not run'); }, generateJson: async () => { throw new Error('paused model must not run'); } });
  extraction.start(); assert.equal(extraction.getRuntimeStatus(scope).pauseCode, 'MEMORY_PROTOCOL_UPGRADE_REQUIRED');
  assert.equal(extraction.getRuntimeStatus(scope).routes.every(row => !row.eligible && row.readEnabled), true);
  await extraction.stop();
  rejects(() => writer.mergeApproved(scope, [java.id, python.id], { kind: 'profile', content: '合并后的用户身份' }), 'USER_REVIEW_REQUIRED');
  assert.equal(writer.import(scope, { items: [item(retirement2.id), item(first.id)] }).skippedItems, 2);
  checks.push('stage capability pause preserves reads; background cannot merge user protection; import cannot activate proposals');

  const capacityStorage = path.join(temporary, 'capacity');
  const capacity = new MemoryWriteService(owner, capacityStorage); capacity.updateWorkspaceConfig(scope, { enabled: true, maxItems: 1 });
  const primary = capacity.createManual(scope, { kind: 'profile', content: '重要的演示开发身份', importance: 5 }).item;
  const waiting = capacity.write(scope, { operation: 'add', kind: 'task', content: '尚未确认的演示任务', origin: 'extracted', memoryGeneration: 0 }).item;
  assert.equal(capacity.list(scope).items.find(row => row.id === primary.id).status, 'active');
  assert.equal(waiting.status, 'pending');
  const low = capacity.createManual(scope, { kind: 'fact', content: '低优先级容量条目', importance: 1 });
  assert.equal(low.item.status, 'archived'); assert.ok(low.archivedItemIds.includes(low.item.id));
  const beforeClear = propose(target('清空前的测试事实'), '清空前的提案'); writer.clear(scope);
  rejects(() => writer.confirm(scope, beforeClear.id, review(beforeClear)), 'MEMORY_ITEM_NOT_FOUND');
  checks.push('pending does not evict active capacity; archived result is explicit; clear prevents old proposal activation');

  // A deployed v10 fixture retains real old columns and foreign keys, not a v11 version-number spoof.
  const legacyStorage = path.join(temporary, 'legacy'); const legacyWriter = new MemoryWriteService(owner, legacyStorage);
  legacyWriter.updateWorkspaceConfig(scope, { enabled: true });
  const legacyManual = legacyWriter.createManual(scope, { kind: 'profile', content: '旧库 Java 和 Agent 身份' }).item;
  const legacyPending = legacyWriter.write(scope, { operation: 'add', content: '旧库待确认事实', origin: 'extracted', memoryGeneration: 0 }).item;
  owner.closeAll();
  const legacyPath = getQaMemoryDatabasePath(legacyStorage); const legacyDb = new Database(legacyPath);
  legacyDb.pragma('foreign_keys = OFF');
  legacyDb.exec(`DROP TRIGGER memory_proposal_insert_guard; DROP TRIGGER memory_proposal_update_guard; DROP TRIGGER memory_proposal_target_delete;
    CREATE TABLE v10_items (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,principal_id TEXT NOT NULL,kind TEXT NOT NULL,
      content TEXT NOT NULL,topic TEXT NOT NULL,normalized_key TEXT NOT NULL,importance INTEGER NOT NULL,origin TEXT NOT NULL,status TEXT NOT NULL,
      source_session_id TEXT,source_message_id TEXT,valid_from TEXT NOT NULL,invalid_at TEXT,expires_at TEXT,superseded_by TEXT,
      last_used_at TEXT,use_count INTEGER NOT NULL,memory_generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(id,workspace_id,principal_id),FOREIGN KEY(workspace_id,principal_id) REFERENCES memory_subjects(workspace_id,principal_id),
      FOREIGN KEY(superseded_by) REFERENCES memory_items(id) ON DELETE SET NULL);
    INSERT INTO v10_items SELECT id,workspace_id,principal_id,kind,content,topic,normalized_key,importance,origin,status,
      source_session_id,source_message_id,valid_from,invalid_at,expires_at,superseded_by,last_used_at,use_count,memory_generation,created_at,updated_at FROM memory_items;
    DROP TABLE memory_items; ALTER TABLE v10_items RENAME TO memory_items;
    CREATE UNIQUE INDEX idx_memory_items_live_key ON memory_items(workspace_id,principal_id,kind,normalized_key) WHERE status IN ('active','pending');
    PRAGMA user_version=10;`);
  legacyDb.close();
  const reopened = owner.getDatabase(legacyStorage);
  assert.equal(reopened.pragma('user_version', { simple: true }), 11);
  assert.equal(legacyWriter.list(scope).items.find(row => row.id === legacyManual.id).content, legacyManual.content);
  assert.equal(legacyWriter.list(scope).items.find(row => row.id === legacyManual.id).writeProtection, 'legacy');
  assert.equal(legacyWriter.list(scope).items.find(row => row.id === legacyPending.id).proposalAction, 'add');
  assert.equal(legacyWriter.list(scope).items.find(row => row.id === legacyPending.id).replacesId, null);
  assert.ok(readdirSync(path.dirname(legacyPath)).some(name => name.includes('.pre-v11-')));
  migrateQaMemoryDatabase(reopened); migrateQaMemoryDatabase(reopened);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  reopened.exec('DROP TRIGGER memory_proposal_update_guard');
  assert.throws(() => migrateQaMemoryDatabase(reopened), /缺少约束/u);
  checks.push('real v10 columns upgrade with backup and preserved data; reopen is idempotent; missing v11 guard fails');

  const report = { verifiedAt: new Date().toISOString(), phase: 'WK-M3 supplement', schemaVersion: 11,
    method: 'isolated SQLite/native Electron Node; real central writer and durable journal; no user database changes', checks };
  mkdirSync(path.join(root, 'docs/verification'), { recursive: true });
  writeFileSync(path.join(root, 'docs/verification/memory-write-proposals-v11.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Memory proposal verification passed (${checks.length} groups)`);
} finally {
  owner?.closeAll();
  assert.ok(temporary.startsWith(path.resolve('.package-staging') + path.sep));
  rmSync(temporary, { recursive: true, force: true });
}
