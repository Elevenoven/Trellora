import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceMigrationService } from '../../electron/workspaceMigrationService';
import { QaMemoryDatabase } from '../../electron/knowledge/qaMemoryDatabase';
import { MemoryWriteService } from '../../electron/knowledge/memory/memoryWriteService';
import { MemoryScopeResolver } from '../../electron/knowledge/memory/memoryScope';
import { mapRestoredPath } from '../../electron/backup/physicalRestore';
import { MaintenanceBarrier } from '../../electron/backup/maintenance';
import { DataRootLocks } from '../../electron/dataRootLocks';
import { KnowledgeProjectionDatabase } from '../../electron/knowledge/metaDatabase';
import { ensureMaterialsMeta } from '../../electron/materialsLibrary';

const [mode, root] = process.argv.slice(2);
const source = path.join(root, '原工作区'), target = path.join(root, '新工作区'), library = path.join(source, '项目笔记'), external = path.join(root, '外部资料');
const materials = path.join(source, 'knowledge-base', '项目资料');
const profile = path.join(root, 'profile'), configFile = path.join(profile, 'config.json');
const principalId = 'migration-user';
const sessionId = 'assistant-session-12345678-1234-1234-1234-123456789012';
const scope = (workspace: string) => new MemoryScopeResolver({ getActiveWorkspacePath: () => workspace, listRegisteredWorkspacePaths: () => [workspace], getPrincipalId: () => principalId }).resolveActive();
const writeConfig = (value: unknown) => { const temporary = `${configFile}.partial`; fs.writeFileSync(temporary, JSON.stringify(value)); const handle = fs.openSync(temporary, 'r+'); fs.fsyncSync(handle); fs.closeSync(handle); fs.renameSync(temporary, configFile); };
const newFixture = !fs.existsSync(configFile);
if (newFixture) {
  for (const directory of [profile, target, library, external, path.join(library, '_attachments'), path.join(library, '.menghan-backups'), path.join(source, 'AI-Skill'), path.join(source, '.menghan-workspace'), path.join(source, '空目录')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(library, '项目计划.md'), `# 华辰项目计划\n\n下周整理客户验收记录。\n\n![流程图](_attachments/流程图.bin)\n\n原文中的路径保持原样：${source}`);
  fs.writeFileSync(path.join(library, '_attachments', '流程图.bin'), Buffer.alloc(1024 * 1024, 42));
  fs.writeFileSync(path.join(library, '.menghan-backups', '历史.md'), '# 原笔记历史');
  fs.writeFileSync(path.join(source, 'AI-Skill', '手工技能.md'), '# 自定义技能\n保持中文企业文档格式。');
  fs.writeFileSync(path.join(external, '外部.md'), '# 外部资料保持原位置');
  fs.mkdirSync(path.join(materials, 'documents'), { recursive: true }); ensureMaterialsMeta(materials);
  const indexOwner = new KnowledgeProjectionDatabase(library); indexOwner.close();
  const metadata = path.join(library, '.menghan-meta', 'ui-state.json'); fs.writeFileSync(metadata, JSON.stringify({ schemaVersion: 1, collapsedFolderPaths: [path.join(library, '归档')], pinnedEntryPaths: [path.join(library, '项目计划.md')] }));
  fs.writeFileSync(path.join(library, '.menghan-meta', 'paths.jsonl'), `${JSON.stringify({ notePath: path.join(library, '项目计划.md'), text: '原文保持不变。' })}\n`);
  const owner = new QaMemoryDatabase(), database = owner.getDatabase(source), writer = new MemoryWriteService(owner, source);
  writer.updateWorkspaceConfig(scope(source).scope, { enabled: true });
  writer.createManual(scope(source).scope, { kind: 'preference', content: '项目讨论优先使用中文。' });
  database.prepare("INSERT INTO qa_sessions(session_id,scope,title,library_path,created_at,updated_at) VALUES (?,'chat','项目历史',?,datetime('now'),datetime('now'))").run(sessionId, library);
  database.prepare("INSERT INTO qa_turns(turn_id,session_id,turn_seq,request_id,user_text,assistant_text,status,created_at) VALUES ('migration-turn',?,1,'migration-request','下周做什么？','整理验收记录。','complete',datetime('now'))").run(sessionId);
  owner.closeAll();
  writeConfig({ workspacePath: source, libraryPath: library, activeLibraryPath: library, libraries: [{ path: library, alias: '项目笔记' }, { path: external, alias: '外部资料' }], materialsLibraries: [{ path: materials, alias: '项目资料', icon: 'file', origin: 'created' }], activeMaterialsLibraryPath: materials, appPreferences: { language: 'zh-CN', theme: 'light', lastOpenedNote: path.join(library, '项目计划.md') }, memoryPrincipalId: principalId, onboarding: { version: 1, status: 'completed' }, modelSecret: 'CREDENTIAL_MUST_STAY_IN_PROFILE', workspaceMigrationCommit: null });
}
if (mode === 'seed') process.exit(0);
let config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const publicConfig = () => Object.fromEntries(['workspacePath', 'libraries', 'materialsLibraries', 'activeMaterialsLibraryPath', 'libraryPath', 'activeLibraryPath', 'appPreferences', 'workspaceMigrationCommit'].map(key => [key, config[key] ?? null]));
let injectedActivation = false, copyingEvents = 0, cancellationTriggered = false;
const pauseForKill = () => { process.stdout.write('KILL_POINT\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
let barrier: MaintenanceBarrier;
barrier = new MaintenanceBarrier({ prepareRenderer: id => { if (mode === 'kill-prepare') pauseForKill(); queueMicrotask(() => barrier.acknowledge(1, id, true)); return 1; }, changed: () => {}, participants: () => [], drain: async () => {}, stopWatching: async () => {}, resumeWatching: async () => {}, extraBusy: () => false });
const leases = new DataRootLocks(); leases.acquire([config.workspacePath, external]);
let service: WorkspaceMigrationService;
service = new WorkspaceMigrationService({
  userDataPath: profile,
  context: () => ({ workspacePath: config.workspacePath, scope: scope(config.workspacePath).scope, libraries: [{ path: config.libraries[0].path, alias: '项目笔记', kind: 'note', internal: true }, { path: config.materialsLibraries[0].path, alias: '项目资料', kind: 'materials', internal: true }, { path: external, alias: '外部资料', kind: 'note', internal: false }] }),
  config: publicConfig, resolveTarget: scope, capture: (signal, action) => barrier.capture(signal, action),
  reserveTarget: value => leases.reserve([value]), releaseTarget: value => leases.releaseReservation(value),
  commit: async (id, context) => {
    if (mode === 'kill-publish') pauseForKill();
    leases.acquire([target]);
    config = { ...config, workspacePath: target, libraryPath: mapRestoredPath(config.libraryPath, context), activeLibraryPath: mapRestoredPath(config.activeLibraryPath, context), libraries: config.libraries.map((item: { path: string }) => ({ ...item, path: mapRestoredPath(item.path, context) })), appPreferences: { ...config.appPreferences, lastOpenedNote: mapRestoredPath(config.appPreferences.lastOpenedNote, context) }, workspaceMigrationCommit: id };
    config.materialsLibraries = config.materialsLibraries.map((item: { path: string }) => ({ ...item, path: mapRestoredPath(item.path, context) })); config.activeMaterialsLibraryPath = mapRestoredPath(config.activeMaterialsLibraryPath, context);
    writeConfig(config);
    if (mode === 'kill-commit') pauseForKill();
  },
  rollback: async previous => { config = { ...config, ...previous }; writeConfig(config); },
  activate: async () => { if (mode === 'activation-failure' && !injectedActivation) { injectedActivation = true; throw new Error('模拟启用失败'); } const owner = new QaMemoryDatabase(); owner.getDatabase(config.workspacePath); owner.closeAll(); },
  onStatus: value => {
    if (value.phase === 'copying') { copyingEvents++; if (value.completedFiles >= 1 && mode === 'kill-copy') pauseForKill(); }
    if (value.phase === 'mapping' && mode === 'kill-map') pauseForKill();
    if (value.phase === 'switching' && mode === 'kill-validated') pauseForKill();
    if (value.phase === 'copying' && value.completedFiles >= 1 && mode === 'cancel' && !cancellationTriggered) { cancellationTriggered = true; service.cancel(); }
    if (value.phase === 'mapping' && mode === 'cancel-worker' && !cancellationTriggered) { cancellationTriggered = true; service.cancel(); }
    if (value.phase === 'copying') void barrier.invoke('create-library', () => {}).then(() => { throw new Error('维护期间意外允许写入'); }).catch(() => undefined);
  },
});

void (async () => {
  try {
    assert.equal(config.modelSecret, 'CREDENTIAL_MUST_STAY_IN_PROFILE');
    await assert.rejects(service.preview(source));
    let preview = service.state().pending;
    if (mode === 'resume') { assert.ok(preview, '重启必须识别已开始但未完成的迁移'); assert.equal(service.state().status.phase, 'interrupted'); }
    if (mode === 'source-change' && preview) fs.writeFileSync(path.join(source, '中断后新增.md'), '# 中断后新增内容');
    if (mode === 'stale-worker-output' && preview) {
      const metadata = path.join(path.dirname(target), `.trellora-migration-${preview.operationId}`, '项目笔记', '.menghan-meta');
      fs.mkdirSync(metadata, { recursive: true }); fs.writeFileSync(path.join(metadata, 'paths.jsonl.restore-partial'), '{"unfinished":');
    }
    if (!preview) preview = await service.preview(target);
    const result = await service.start(preview.operationId);
    if (mode === 'cancel' || mode === 'cancel-worker') {
      assert.equal(result.phase, 'cancelled', result.message); assert.equal(config.workspacePath, source);
      await service.abandon(preview.operationId); assert.equal(service.recoveryPending, false);
      assert.equal(fs.existsSync(path.join(source, 'ConversationMemory', 'qa-memory.db')), true);
      console.log(`${mode}: original workspace retained and maintenance released`); return;
    }
    if (mode === 'activation-failure') {
      assert.equal(result.phase, 'failed'); assert.equal(config.workspacePath, source);
      const retried = await service.start(preview.operationId); assert.equal(retried.phase, 'completed', retried.message);
    } else assert.equal(result.phase, 'completed', result.message);
    assert.equal(config.workspacePath, target); assert.equal(config.libraries.length, 2); assert.equal(config.libraries[1].path, external);
    assert.equal(config.materialsLibraries[0].path, path.join(target, 'knowledge-base', '项目资料')); assert.equal(config.activeMaterialsLibraryPath, config.materialsLibraries[0].path);
    assert.equal(config.modelSecret, 'CREDENTIAL_MUST_STAY_IN_PROFILE');
    const newLibrary = path.join(target, '项目笔记');
    assert.deepEqual(fs.readFileSync(path.join(newLibrary, '项目计划.md')), fs.readFileSync(path.join(library, '项目计划.md')));
    assert.deepEqual(fs.readFileSync(path.join(newLibrary, '_attachments', '流程图.bin')), fs.readFileSync(path.join(library, '_attachments', '流程图.bin')));
    assert.ok(fs.existsSync(path.join(target, '空目录'))); assert.ok(fs.existsSync(path.join(target, 'AI-Skill', '手工技能.md')));
    assert.equal(config.appPreferences.lastOpenedNote, path.join(newLibrary, '项目计划.md'));
    const ui = JSON.parse(fs.readFileSync(path.join(newLibrary, '.menghan-meta', 'ui-state.json'), 'utf8')); assert.equal(ui.pinnedEntryPaths[0], path.join(newLibrary, '项目计划.md'));
    const paths = JSON.parse(fs.readFileSync(path.join(newLibrary, '.menghan-meta', 'paths.jsonl'), 'utf8')); assert.equal(paths.notePath, path.join(newLibrary, '项目计划.md')); assert.equal(paths.text, '原文保持不变。');
    assert.equal(fs.existsSync(path.join(newLibrary, '.menghan-meta', 'paths.jsonl.restore-partial')), false);
    const owner = new QaMemoryDatabase(), db = owner.getDatabase(target), reader = new MemoryWriteService(owner, target);
    assert.equal(reader.list(scope(target).scope).items.length, 1);
    assert.equal(db.prepare('SELECT library_path FROM qa_sessions').get().library_path, newLibrary);
    assert.equal(db.prepare('SELECT assistant_text FROM qa_turns').get().assistant_text, '整理验收记录。'); assert.deepEqual(db.pragma('foreign_key_check'), []); owner.closeAll();
    const old = new Database(path.join(source, 'ConversationMemory', 'qa-memory.db'), { readonly: true }); assert.equal(old.prepare('SELECT library_path FROM qa_sessions').get().library_path, library); old.close();
    if (mode === 'source-change') assert.ok(fs.existsSync(path.join(target, '中断后新增.md')));
    assert.equal(barrier.phase, 'idle'); assert.equal(service.recoveryPending, false);
    const journals = fs.readdirSync(path.join(profile, 'workspace-migrations')).map(id => fs.readFileSync(path.join(profile, 'workspace-migrations', id, 'journal.json'), 'utf8')).join('');
    assert.doesNotMatch(journals, /CREDENTIAL_MUST_STAY_IN_PROFILE/);
    console.log(`${mode}: files, real QA/memory schema, associations, external library, credentials, atomic activation and recovery passed (${copyingEvents} copy events)`);
  } finally { leases.releaseAll(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
