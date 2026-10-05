import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { fork } from 'node:child_process';

const root = process.cwd();
const staging = path.join(root, '.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'note-save-'));
try {
  const entry = path.join(temporary, 'service.cjs');
  await build({ entryPoints: ['electron/noteSaveService.ts', 'electron/atomicTextWrite.ts'], outdir: temporary, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  await fs.rename(path.join(temporary, 'noteSaveService.js'), entry);
  const require = createRequire(import.meta.url);
  const { NoteSaveService } = require(entry);
  const { atomicTextWrite } = require(path.join(temporary, 'atomicTextWrite.js'));
  const library = path.join(temporary, 'library');
  await fs.mkdir(library);
  const file = path.join(library, '财务核对.md');
  await fs.writeFile(file, '# 原始内容');
  const service = new NoteSaveService({ getLibraryPath: () => library, backupRetention: () => 20, committed: async () => { throw new Error('模拟索引失败'); } });
  let snapshot = await service.open(1, file);
  const request = { editSessionId: snapshot.editSessionId, requestId: 'one', editRevision: 1, expectedDiskHash: snapshot.version.diskHash, content: '# 保存完成' };
  const result = await service.save(1, request);
  assert.equal(result.status, 'committed');
  assert.equal(await fs.readFile(file, 'utf8'), '# 保存完成');
  assert.deepEqual(await service.save(1, request), result);
  assert.equal((await service.save(1, { ...request, content: '同ID不同正文' })).code, 'NOTE_REQUEST_MISMATCH');
  assert.equal((await service.save(2, request)).code, 'NOTE_SESSION_INVALID');
  const backups = await fs.readdir(path.join(library, '.menghan-backups', '.v2', '财务核对.md'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(library, '.menghan-backups', '.v2', '财务核对.md', backups[0]), 'utf8'), '# 原始内容');
  const states = [];
  const unchangedService = new NoteSaveService({ getLibraryPath: () => library, backupRetention: () => 20, committed: async () => { throw new Error('已有索引故障'); }, state: (_sender, state) => states.push(state) });
  const equalSnapshot = await unchangedService.open(1, file);
  const equalResult = await unchangedService.save(1, { ...request, editSessionId: equalSnapshot.editSessionId, requestId: 'unchanged', expectedDiskHash: equalSnapshot.version.diskHash, content: equalSnapshot.content });
  assert.equal(equalResult.status, 'unchanged'); assert.equal(equalResult.indexState, 'pending');
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(states.at(-1).indexState, 'degraded');
  let releaseProjection, drained = false;
  const drainingService = new NoteSaveService({ getLibraryPath: () => library, backupRetention: () => 20, committed: () => new Promise(resolve => { releaseProjection = resolve; }) });
  const drainSnapshot = await drainingService.open(1, file);
  await drainingService.save(1, { ...request, editSessionId: drainSnapshot.editSessionId, requestId: 'drain-background-read', expectedDiskHash: drainSnapshot.version.diskHash, content: drainSnapshot.content });
  const drainTask = drainingService.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(drained, false, 'normal close must wait for projection work before it reaches the coordinator queue');
  releaseProjection(); await drainTask; assert.equal(drained, true);

  snapshot = await service.open(1, file);
  const stat = await fs.stat(file);
  await fs.writeFile(file, '# 外部修改');
  await fs.utimes(file, stat.atime, stat.mtime);
  const conflict = await service.save(1, { ...request, editSessionId: snapshot.editSessionId, requestId: 'conflict', expectedDiskHash: snapshot.version.diskHash });
  assert.equal(conflict.status, 'conflict');
  assert.equal(await fs.readFile(file, 'utf8'), '# 外部修改');

  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('# 中文备份', 'utf16le')]);
  const encoded = path.join(library, '编码.md');
  await fs.writeFile(encoded, utf16);
  snapshot = await service.open(1, encoded);
  assert.equal(snapshot.content, '# 中文备份');
  await service.save(1, { ...request, editSessionId: snapshot.editSessionId, requestId: 'utf16', expectedDiskHash: snapshot.version.diskHash });
  const encodedBackups = await fs.readdir(path.join(library, '.menghan-backups', '.v2', '编码.md'));
  assert.deepEqual(await fs.readFile(path.join(library, '.menghan-backups', '.v2', '编码.md', encodedBackups[0])), utf16);

  await assert.rejects(atomicTextWrite(file, '不可提交', async () => { throw new Error('模拟提交前失败'); }), /模拟提交前失败/);
  assert.equal(await fs.readFile(file, 'utf8'), '# 外部修改');
  assert.equal((await fs.readdir(library)).some((name) => name.startsWith('.trellora-save-')), false);
  snapshot = await service.open(1, file);
  await fs.unlink(file);
  assert.equal((await service.save(1, { ...request, editSessionId: snapshot.editSessionId, requestId: 'missing', expectedDiskHash: snapshot.version.diskHash })).code, 'NOTE_MISSING');

  const failureFile = path.join(library, '失败备份.md'); await fs.writeFile(failureFile, '备份失败前的完整正文');
  await fs.writeFile(path.join(library, '.menghan-backups', '失败备份'), '阻止创建备份目录');
  snapshot = await service.open(1, failureFile);
  assert.equal((await service.save(1, { ...request, editSessionId: snapshot.editSessionId, requestId: 'backup-failed', expectedDiskHash: snapshot.version.diskHash })).status, 'failed');
  assert.equal(await fs.readFile(failureFile, 'utf8'), '备份失败前的完整正文');
  const originalOpen = fs.open, originalRename = fs.rename;
  for (const phase of ['open', 'sync', 'replace']) {
    try {
      fs.open = async (...args) => {
        if (phase === 'open' && String(args[0]).includes('.trellora-save-')) throw Object.assign(new Error('模拟临时写失败'), { code: 'EACCES' });
        const handle = await originalOpen(...args);
        if (phase === 'sync' && String(args[0]).includes('.trellora-save-')) handle.sync = async () => { throw Object.assign(new Error('模拟同步失败'), { code: 'EIO' }); };
        return handle;
      };
      if (phase === 'replace') fs.rename = async () => { throw Object.assign(new Error('模拟替换锁定'), { code: 'EACCES' }); };
      await assert.rejects(atomicTextWrite(failureFile, '不得截断旧正文', async () => {}));
    } finally { fs.open = originalOpen; fs.rename = originalRename; }
    assert.equal(await fs.readFile(failureFile, 'utf8'), '备份失败前的完整正文');
    assert.equal((await fs.readdir(library)).some(name => name.startsWith('.trellora-save-')), false);
  }
  const queuedFile = path.join(library, '并发.md'); await fs.writeFile(queuedFile, '起始版本');
  const firstSession = await service.open(1, queuedFile), secondSession = await service.open(1, queuedFile);
  const save = (editSession, id, content) => service.save(1, { ...request, editSessionId: editSession.editSessionId, requestId: id, expectedDiskHash: editSession.version.diskHash, content });
  const simultaneous = await Promise.all([save(firstSession, 'queue-one', '第一个提交'), save(secondSession, 'queue-two', '不得覆盖第一个')]);
  assert.deepEqual(simultaneous.map(result => result.status), ['committed', 'conflict']);
  const movingSession = await service.open(1, queuedFile), newPath = path.join(library, '移动后.md');
  let releaseMove;
  const moving = service.structure(library, async () => { await new Promise(resolve => { releaseMove = resolve; }); await fs.rename(queuedFile, newPath); });
  await new Promise(resolve => setTimeout(resolve, 0));
  const behindMove = save(movingSession, 'behind-move', '不应重建旧路径'); releaseMove(); await moving;
  assert.equal((await behindMove).code, 'NOTE_MISSING'); assert.equal(await fs.readFile(newPath, 'utf8'), '第一个提交');
  await assert.rejects(fs.stat(queuedFile), { code: 'ENOENT' });

  const crashFile = path.join(library, '中断.md'), crashScript = path.join(temporary, 'crash.cjs');
  await fs.writeFile(crashScript, `const { atomicTextWrite } = require(${JSON.stringify(path.join(temporary, 'atomicTextWrite.js'))}); (async () => { await atomicTextWrite(process.argv[2], '新完整版本'.repeat(20_000), async () => { if (process.argv[3] === 'before') { process.send('ready'); await new Promise(() => {}); } }); process.send('ready'); setInterval(() => {}, 1000); })().catch(error => { console.error(error); process.exit(1); });`);
  for (const phase of ['before', 'after']) {
    await fs.writeFile(crashFile, '旧完整版本'.repeat(20_000));
    const child = fork(crashScript, [crashFile, phase], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Crash probe exited early ${code}`))); });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    assert.equal(await fs.readFile(crashFile, 'utf8'), (phase === 'before' ? '旧完整版本' : '新完整版本').repeat(20_000));
  }
  await service.drain();
  console.log('Note save verified: byte conflicts, ownership, retry identity, byte backups, backup/open/sync/rename failures, file queues, structural barriers, pre/post-replace process interruption and committed/index failure separation.');
} finally {
  // temporary is generated beneath the explicitly verified staging root.
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true });
}
