import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const staging = path.resolve('.package-staging');
fs.mkdirSync(staging, { recursive: true });
const temporary = fs.mkdtempSync(path.join(staging, 'note-backups-'));
const require = createRequire(import.meta.url);
try {
  await build({ entryPoints: ['electron/noteBackups.ts', 'electron/noteSaveService.ts', 'electron/textFile.ts'], outdir: temporary, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createNoteBackup, listNoteBackups, pruneNoteBackups, readNoteBackup } = require(path.join(temporary, 'noteBackups.js'));
  const { NoteSaveService } = require(path.join(temporary, 'noteSaveService.js'));
  const { decodeTextBuffer } = require(path.join(temporary, 'textFile.js'));

  function fixture(name, content = '当前完整正文', legacy = false) {
    const library = path.join(temporary, name);
    fs.mkdirSync(library);
    const note = path.join(library, '合同.md');
    fs.writeFileSync(note, content);
    const directory = legacy ? path.join(library, '.menghan-backups', '合同') : path.join(library, '.menghan-backups', '.v2', '合同.md');
    fs.mkdirSync(directory, { recursive: true });
    return { library, note, directory };
  }
  function seed(directory, count = 6) {
    const names = [];
    for (let index = 1; index <= count; index++) {
      const name = `202601${String(index).padStart(2, '0')}-120000.md`;
      fs.writeFileSync(path.join(directory, name), `历史正文 ${index}`);
      names.push(name);
    }
    return names;
  }
  const namesAt = directory => fs.readdirSync(directory).sort();
  const request = (snapshot, id, content) => ({ editSessionId: snapshot.editSessionId, requestId: id, editRevision: 1, expectedDiskHash: snapshot.version.diskHash, content });
  const serviceFor = library => new NoteSaveService({ getLibraryPath: () => library, backupRetention: () => 100, committed: async () => {} });

  // 清理只影响目标笔记的标准备份；原文、其他笔记、未知文件和子目录逐字保留。
  const first = fixture('边界');
  const standard = seed(first.directory);
  for (const name of ['手工归档.md', '20260230-120000.md', '20260101-996000.md', '20260101-120000-0.md', '.trellora-backup-left.tmp']) fs.writeFileSync(path.join(first.directory, name), `保留 ${name}`);
  const child = path.join(first.directory, '20251231-120000.md'); fs.mkdirSync(child); fs.writeFileSync(path.join(child, '用户文件.md'), '子目录不可删除');
  const other = path.join(first.library, '.menghan-backups', '另一篇'); fs.mkdirSync(other); const otherNames = seed(other);
  const originalNote = fs.readFileSync(first.note);
  const retained = pruneNoteBackups(first.note, first.library);
  assert.deepEqual(retained.map(entry => path.basename(entry.path)), standard.slice(-3).reverse());
  for (const name of standard.slice(0, 3)) assert.equal(fs.existsSync(path.join(first.directory, name)), false);
  for (const entry of retained) assert.equal(readNoteBackup(first.note, first.library, entry.id).toString(), `历史正文 ${Number(entry.id.slice(6, 8))}`);
  assert.deepEqual(fs.readFileSync(first.note), originalNote);
  assert.deepEqual(namesAt(other), otherNames);
  for (const name of ['手工归档.md', '20260230-120000.md', '20260101-996000.md', '20260101-120000-0.md', '.trellora-backup-left.tmp']) assert.equal(fs.readFileSync(path.join(first.directory, name), 'utf8'), `保留 ${name}`);
  assert.equal(fs.readFileSync(path.join(child, '用户文件.md'), 'utf8'), '子目录不可删除');
  assert.throws(() => pruneNoteBackups(path.join(temporary, '外部.md'), first.library));
  assert.throws(() => readNoteBackup(first.note, first.library, '../../另一篇/20260101-120000'));

  // 同秒序号按数字排序；复制文件导致的 mtime 变化不改变历史时间顺序。
  const sameSecond = fixture('同秒排序');
  for (let sequence = 0; sequence <= 12; sequence++) {
    const file = path.join(sameSecond.directory, `20260101-120000${sequence ? `-${sequence}` : ''}.md`);
    fs.writeFileSync(file, `同秒版本 ${sequence}`);
    fs.utimesSync(file, new Date(), new Date(2026, 0, 20 - sequence));
  }
  assert.deepEqual(pruneNoteBackups(sameSecond.note, sameSecond.library).map(entry => entry.id), ['20260101-120000-12', '20260101-120000-11', '20260101-120000-10']);
  assert.equal(namesAt(sameSecond.directory).length, 3);

  const sliding = fixture('滑动窗口');
  for (let index = 1; index <= 8; index++) {
    await createNoteBackup(sliding.note, sliding.library, Buffer.from(`完整版本 ${index}`), new Date(2026, 1, index, 12), 0);
    fs.writeFileSync(sliding.note, `正文提交 ${index}`);
    const entries = pruneNoteBackups(sliding.note, sliding.library);
    assert.equal(entries.length, Math.min(index, 3));
    assert.equal(namesAt(sliding.directory).length, Math.min(index, 3));
    assert.equal(fs.readFileSync(entries[0].path, 'utf8'), `完整版本 ${index}`);
  }

  // 新备份写入/同步/发布失败时，三份旧备份和当前原文均不变。
  const creationFailure = fixture('新备份失败'); seed(creationFailure.directory, 3);
  const beforeCreation = namesAt(creationFailure.directory), open = fs.promises.open, link = fs.promises.link;
  for (const phase of ['write', 'sync', 'publish']) {
    try {
      fs.promises.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).includes('.trellora-backup-')) {
          if (phase === 'write') handle.writeFile = async () => { throw Object.assign(new Error('模拟备份写入失败'), { code: 'EIO' }); };
          if (phase === 'sync') handle.sync = async () => { throw Object.assign(new Error('模拟备份同步失败'), { code: 'EIO' }); };
        }
        return handle;
      };
      if (phase === 'publish') fs.promises.link = async () => { throw Object.assign(new Error('模拟备份发布失败'), { code: 'EACCES' }); };
      await assert.rejects(createNoteBackup(creationFailure.note, creationFailure.library, Buffer.from('不得损坏旧版本'), new Date(), 0));
    } finally { fs.promises.open = open; fs.promises.link = link; }
    assert.deepEqual(namesAt(creationFailure.directory), beforeCreation);
    assert.equal(fs.readFileSync(creationFailure.note, 'utf8'), '当前完整正文');
  }

  const replacementFailure = fixture('正文提交失败'); const beforeReplace = seed(replacementFailure.directory, 3);
  const replacementService = serviceFor(replacementFailure.library), replaceSnapshot = await replacementService.open(1, replacementFailure.note);
  const rename = fs.promises.rename;
  try {
    fs.promises.rename = async () => { throw Object.assign(new Error('模拟正文替换失败'), { code: 'EACCES' }); };
    assert.equal((await replacementService.save(1, request(replaceSnapshot, '失败提交', '新正文'))).status, 'failed');
  } finally { fs.promises.rename = rename; }
  assert.equal(fs.readFileSync(replacementFailure.note, 'utf8'), '当前完整正文');
  for (const name of beforeReplace) assert.equal(fs.existsSync(path.join(replacementFailure.directory, name)), true);
  assert.equal(namesAt(replacementFailure.directory).length, 4);
  assert.equal((await replacementService.save(1, request(replaceSnapshot, '重试提交', '新正文'))).status, 'committed');
  assert.equal(namesAt(replacementFailure.directory).length, 3);

  // 保留项不可读时停止清理；共享旧目录、硬链接、junction 都不能导致误删。
  const unreadable = fixture('保留项不可读'); const unreadableNames = seed(unreadable.directory);
  const read = fs.readFileSync;
  try {
    fs.readFileSync = (...args) => { if (args[0] === path.join(unreadable.directory, unreadableNames.at(-1))) throw Object.assign(new Error('不可读'), { code: 'EACCES' }); return read(...args); };
    assert.throws(() => pruneNoteBackups(unreadable.note, unreadable.library), /不可读/);
  } finally { fs.readFileSync = read; }
  assert.deepEqual(namesAt(unreadable.directory), unreadableNames);
  const ambiguous = fixture('扩展名冲突', '当前完整正文', true); const ambiguousNames = seed(ambiguous.directory); fs.writeFileSync(path.join(ambiguous.library, '合同.txt'), '另一篇原文');
  assert.equal(pruneNoteBackups(ambiguous.note, ambiguous.library).length, 0);
  for (const name of ambiguousNames) assert.equal(fs.existsSync(path.join(ambiguous.directory, name)), true);
  assert.equal(fs.readFileSync(path.join(ambiguous.library, '合同.txt'), 'utf8'), '另一篇原文');
  const hardLink = path.join(first.directory, '20251230-120000.md'); await fs.promises.link(first.note, hardLink);
  pruneNoteBackups(first.note, first.library);
  assert.equal(fs.existsSync(hardLink), true); assert.deepEqual(fs.readFileSync(first.note), originalNote);
  for (const scope of ['库外链接', '库内链接']) {
    const linked = fixture(scope);
    fs.rmdirSync(linked.directory);
    const target = scope === '库外链接' ? other : path.join(linked.library, '另一个备份目录');
    if (scope === '库内链接') { fs.mkdirSync(target); seed(target); }
    const originals = namesAt(target);
    fs.symlinkSync(target, linked.directory, 'junction');
    assert.throws(() => pruneNoteBackups(linked.note, linked.library), /备份目录/);
    await assert.rejects(createNoteBackup(linked.note, linked.library, Buffer.from('拒绝链接'), new Date(), 0), /备份目录/);
    assert.deepEqual(namesAt(target), originals);
  }

  // 恢复最旧的保留项先读字节，再备份当前正文；随后可用这份备份撤销恢复。
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('恢复前中文正文', 'utf16le')]);
  const recovery = fixture('恢复往返', utf16); seed(recovery.directory, 3);
  const recoveryService = serviceFor(recovery.library), recoverySnapshot = await recoveryService.open(1, recovery.note);
  const oldId = listNoteBackups(recovery.note, recovery.library).at(-1).id;
  const recoveryRequest = request(recoverySnapshot, '恢复历史', '');
  const restored = await recoveryService.save(1, recoveryRequest, () => decodeTextBuffer(readNoteBackup(recovery.note, recovery.library, oldId)), `restore:${oldId}`, true);
  assert.equal(restored.status, 'committed'); assert.equal(fs.readFileSync(recovery.note, 'utf8'), '历史正文 1');
  const recoveryEntries = await recoveryService.listBackups(recovery.note);
  assert.equal(recoveryEntries.length, 3); assert.deepEqual(fs.readFileSync(recoveryEntries[0].path), utf16);
  assert.equal(fs.existsSync(path.join(recovery.directory, `${oldId}.md`)), false, '选中项只有读取和正文恢复成功后才可能滑出窗口');
  assert.deepEqual(await recoveryService.save(1, recoveryRequest, () => { throw new Error('重试不应再次执行恢复'); }, `restore:${oldId}`, true), restored);
  const undoId = recoveryEntries[0].id, undoSnapshot = await recoveryService.open(1, recovery.note);
  assert.equal((await recoveryService.save(1, request(undoSnapshot, '撤销恢复', ''), () => decodeTextBuffer(readNoteBackup(recovery.note, recovery.library, undoId)), `restore:${undoId}`, true)).status, 'committed');
  assert.equal(fs.readFileSync(recovery.note, 'utf8'), '恢复前中文正文');
  assert.equal(namesAt(recovery.directory).length, 3);

  // 清单请求等待同文件保存完成，不能清理进行中的备份。
  const concurrent = fixture('保存和清单并发'); seed(concurrent.directory, 3);
  const concurrentService = serviceFor(concurrent.library), concurrentSnapshot = await concurrentService.open(1, concurrent.note);
  let releaseWrite, startedWrite;
  const started = new Promise(resolve => { startedWrite = resolve; });
  try {
    fs.promises.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('.trellora-backup-')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => { startedWrite(); await new Promise(resolve => { releaseWrite = resolve; }); return write(...values); };
      }
      return handle;
    };
    const saving = concurrentService.save(1, request(concurrentSnapshot, '并发保存', '并发后的完整正文'));
    await started;
    let listed = false;
    const listing = concurrentService.listBackups(concurrent.note).then(entries => { listed = true; return entries; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(listed, false);
    releaseWrite(); assert.equal((await saving).status, 'committed'); assert.equal((await listing).length, 3);
    assert.equal(fs.readFileSync(concurrent.note, 'utf8'), '并发后的完整正文');
  } finally { fs.promises.open = open; releaseWrite?.(); }
  await Promise.all([replacementService.drain(), recoveryService.drain(), concurrentService.drain()]);
  console.log('Note backups verified: latest-three sliding window, numeric ties, scope/unknown-file preservation, backup and commit failures, unreadable retained files, ambiguous ownership, hard links/junctions, UTF-16 restore/undo, idempotency and serialized listing.');
} finally {
  assert.equal(path.dirname(temporary), staging);
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
