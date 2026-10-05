import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'note-delta-'));
let coordinator, db;
try {
  await build({ entryPoints: ['electron/knowledge/indexCoordinator.ts', 'electron/knowledge/noteIndexWorker.ts', 'electron/knowledge/noteIndexWorkerClient.ts', 'electron/knowledge/noteLexicalIndex.ts', 'electron/noteIndex.ts'], entryNames: '[name]', outdir: temporary, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], logLevel: 'silent' });
  const require = createRequire(import.meta.url);
  const { KnowledgeIndexCoordinator } = require(path.join(temporary, 'indexCoordinator.js'));
  const { createNoteLexicalIndex } = require(path.join(temporary, 'noteLexicalIndex.js'));
  const { NoteIndexWorkerClient } = require(path.join(temporary, 'noteIndexWorkerClient.js'));
  const { getAllTags, getBacklinks } = require(path.join(temporary, 'noteIndex.js'));
  const library = path.join(temporary, 'library'); await fs.mkdir(library);
  await Promise.all(Array.from({ length: 100 }, (_, n) => fs.writeFile(path.join(library, `财务${n}.md`), `# 财务${n}\n\n凭证核对记录 #财务\n[[财务1]]`)));
  const search = createNoteLexicalIndex(), events = [];
  coordinator = new KnowledgeIndexCoordinator();
  await coordinator.initialize(library, search, (_result, _changes, delta) => events.push(delta));
  const before = { ...coordinator.metrics }, unaffected = coordinator.current.notesByPath[path.join(library, '财务2.md')];
  const file = path.join(library, '财务0.md');
  await fs.writeFile(file, '# 更新的财务\n\n唯一检索内容 #验收\n[[财务3]]');
  await coordinator.update([{ kind: 'change', path: file }]);
  assert.equal(coordinator.metrics.fullScans, before.fullScans); assert.equal(coordinator.metrics.searchResets, before.searchResets);
  assert.equal(coordinator.metrics.parses - before.parses, 1); assert.equal(coordinator.current.notesByPath[path.join(library, '财务2.md')], unaffected);
  assert.ok(search.search('唯一检索内容').some(note => note.path === file));
  assert.ok(getAllTags(coordinator.current).some(tag => tag.tag === '验收'));
  assert.ok(getBacklinks(coordinator.current, path.join(library, '财务3.md')).some(link => link.sourcePath === file));
  await delay(600); assert.equal(coordinator.metrics.parses - before.parses, 1, 'watcher echo must not parse again');
  db = new Database(path.join(library, '.menghan-meta', 'index.db'));
  db.exec("CREATE TABLE material_fixture (payload TEXT); INSERT INTO material_fixture VALUES ('资料索引必须保留');");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 100);

  db.prepare('INSERT INTO favorite_notes (note_path, created_at) VALUES (?, ?)').run(file, '2026-09-30');
  db.prepare("INSERT INTO ai_artifacts (note_path, content_hash, artifact_type, provider, model, payload_json, generated_at) VALUES (?, ?, 'note_insight', 'ollama', 'fixture', '{}', '2026-09-30')").run(file, coordinator.current.notesByPath[file].contentHash);
  db.prepare("INSERT INTO note_analysis_runs(run_id,note_path,source_hash,state,run_json,input_json,created_at,updated_at) VALUES('move-fixture',?,?,'completed',?,'{}','2026-09-30','2026-09-30')")
    .run(file, coordinator.current.notesByPath[file].contentHash, JSON.stringify({ notePath: file }));
  db.prepare("INSERT INTO note_analysis_batches(run_id,batch_id,batch_index,result_json) VALUES('move-fixture','batch',0,'{}')").run();
  const moved = path.join(library, '迁移财务.md');
  await coordinator.mutate(async () => { await fs.rename(file, moved); return { value: moved, moves: [{ from: file, to: moved }], changes: [{ kind: 'unlink', path: file }, { kind: 'add', path: moved }] }; });
  assert.equal(db.prepare('SELECT note_path FROM favorite_notes').get().note_path, moved);
  assert.equal(db.prepare('SELECT note_path FROM ai_artifacts').get().note_path, moved);
  const movedRun = db.prepare('SELECT note_path,run_json FROM note_analysis_runs').get();
  assert.equal(movedRun.note_path, moved); assert.equal(JSON.parse(movedRun.run_json).notePath, moved);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_analysis_batches').get().n, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  await delay(600); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 100);
  const originalApply = coordinator.database.apply.bind(coordinator.database); let rejectMove = true;
  coordinator.database.apply = (...args) => { if (rejectMove) { rejectMove = false; throw new Error('模拟路径迁移事务失败'); } return originalApply(...args); };
  const rolledBackPath = path.join(library, '不应保留的移动.md');
  await assert.rejects(coordinator.mutate(async () => {
    await fs.rename(moved, rolledBackPath);
    return { value: rolledBackPath, moves: [{ from: moved, to: rolledBackPath }], changes: [{ kind: 'unlink', path: moved }, { kind: 'add', path: rolledBackPath }], rollback: () => fs.rename(rolledBackPath, moved) };
  }), /路径迁移事务失败/);
  assert.ok((await fs.stat(moved)).isFile()); await assert.rejects(fs.access(rolledBackPath));
  assert.equal(db.prepare('SELECT note_path FROM favorite_notes').get().note_path, moved);
  await delay(350); await coordinator.awaitCurrent();
  coordinator.database.apply = originalApply;

  // Projection failure after the file changed must leave retryable memory/search state.
  const replace = search.replace.bind(search); let fail = true;
  search.replace = (document) => { if (fail) { fail = false; throw new Error('模拟检索投影失败'); } replace(document); };
  await fs.writeFile(moved, '# 迁移财务\n\n重试恢复检索 #恢复');
  await assert.rejects(coordinator.update([{ kind: 'change', path: moved }]), /模拟检索投影失败/);
  assert.match(await fs.readFile(moved, 'utf8'), /重试恢复/);
  await waitFor(() => search.search('重试恢复检索').some(note => note.path === moved));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 100);

  const apply = coordinator.database.apply.bind(coordinator.database); let failDatabase = true;
  coordinator.database.apply = (...args) => { if (failDatabase) { failDatabase = false; throw Object.assign(new Error('模拟 SQLite 忙'), { code: 'SQLITE_BUSY' }); } return apply(...args); };
  await fs.writeFile(moved, '# 迁移财务\n\n数据库失败后恢复 #数据库');
  await assert.rejects(coordinator.update([{ kind: 'change', path: moved }]), /SQLite/);
  await waitFor(() => coordinator.current.notesByPath[moved].rawMarkdown.includes('数据库失败后恢复'));
  assert.equal(db.prepare('SELECT payload FROM material_fixture').get().payload, '资料索引必须保留');
  assert.equal((await fs.readdir(path.join(library, '.menghan-meta'))).some(name => name.includes('.recovery-')), false);
  const hash = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(moved)).digest('hex');
  assert.equal(await coordinator.awaitIndexedVersion(moved, hash), 'current');
  assert.equal(await coordinator.awaitIndexedVersion(moved, 'a'.repeat(64)), 'superseded');

  const directory = path.join(library, '新增目录'); await fs.mkdir(directory); const child = path.join(directory, '子笔记.md'); await fs.writeFile(child, '# 子笔记 #层级');
  await coordinator.update([{ kind: 'addDir', path: directory }]);
  assert.ok(coordinator.current.notesByPath[child]);
  assert.ok(coordinator.current.fileTree.find(node => node.path === directory)?.children.some(node => node.path === child));
  await fs.rm(directory, { recursive: true }); await coordinator.update([{ kind: 'unlinkDir', path: directory }]); assert.equal(coordinator.current.notesByPath[child], undefined);
  assert.equal(search.has(child), false); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 100);
  const external = path.join(library, '外部新增.md'); await fs.writeFile(external, '# 外部新增 #监听');
  await waitFor(() => Boolean(coordinator.current.notesByPath[external]));
  await fs.unlink(external); await waitFor(() => !coordinator.current.notesByPath[external]);
  assert.equal(coordinator.metrics.fullScans, before.fullScans); assert.equal(coordinator.metrics.searchResets, before.searchResets);
  assert.ok(events.some(delta => delta.source === 'external'));
  db.close(); db = undefined;
  await coordinator.shutdown();

  const raceLibrary = path.join(temporary, 'race-library'); await fs.mkdir(raceLibrary);
  const raceFile = path.join(raceLibrary, '慢解析.md'), deletedFile = path.join(raceLibrary, '删除.md'), addedFile = path.join(raceLibrary, '新建.md');
  await fs.writeFile(raceFile, '# 初始化 A'); await fs.writeFile(deletedFile, '# 删除');
  const parser = new NoteIndexWorkerClient(path.join(temporary, 'noteIndexWorker.js')); let mutateDuringScan = true, mutateDuringParse = true;
  const slowParser = {
    scan: async (library) => {
      const candidate = await parser.scan(library);
      if (mutateDuringScan) { mutateDuringScan = false; await fs.writeFile(raceFile, '# 初始化 B'); await fs.unlink(deletedFile); await fs.writeFile(addedFile, '# 新建 B'); await delay(750); }
      return candidate;
    },
    parse: async (file, content, mtime) => {
      const candidate = await parser.parse(file, content, mtime);
      if (mutateDuringParse && content.includes('慢结果 A')) { mutateDuringParse = false; await fs.writeFile(file, '# 更新 B'); }
      return candidate;
    }, close: () => parser.close(),
  };
  coordinator = new KnowledgeIndexCoordinator(() => {}, slowParser);
  await coordinator.initialize(raceLibrary, createNoteLexicalIndex(), () => {});
  assert.equal(coordinator.current.notesByPath[raceFile].title, '初始化 B');
  assert.equal(coordinator.current.notesByPath[deletedFile], undefined); assert.ok(coordinator.current.notesByPath[addedFile]);
  await fs.writeFile(raceFile, '# 慢结果 A'); await coordinator.update([{ kind: 'change', path: raceFile }]);
  assert.equal(coordinator.current.notesByPath[raceFile].title, '更新 B', 'stale parse candidates must never overwrite the newer disk version');
  await fs.unlink(raceFile); assert.equal(await coordinator.awaitIndexedVersion(raceFile, hash), 'missing');
  await coordinator.initialize(library, createNoteLexicalIndex(), () => {}); assert.equal(coordinator.current.libraryPath, library); assert.equal(coordinator.current.notes.length, 100);
  console.log('Incremental index verified: one-file work, watcher echo, search/SQLite retry, cardinality, FK-safe metadata move, unaffected material table, subtree/watch events, version waits, stale parse rejection, startup replay and library switching.');
} finally {
  db?.close();
  await coordinator?.shutdown();
  assert.equal(path.dirname(temporary), staging); await fs.rm(temporary, { recursive: true, force: true });
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(test) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (test()) return; await delay(50); } throw new Error('Timed out waiting for index convergence'); }
