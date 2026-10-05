import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'external-contract-'));
const require = createRequire(import.meta.url);
try {
  await build({ entryPoints: ['electron/documents/documentSessionService.ts', 'electron/documents/textCodec.ts', 'src/utils/documentSaveController.ts'], outdir: temporary, outbase: '.', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { DocumentSessionService } = require(path.join(temporary, 'electron/documents/documentSessionService.js'));
  const { decodeDocument, encodeDocument } = require(path.join(temporary, 'electron/documents/textCodec.js'));
  const { DocumentSaveController } = require(path.join(temporary, 'src/utils/documentSaveController.js'));
  const library = path.join(temporary, 'library'), originals = path.join(temporary, 'originals'), privateRoot = path.join(temporary, 'private');
  for (const dir of [library, originals, privateRoot]) await fs.mkdir(dir);
  let copies = 0;
  const options = { recoveryRoot: privateRoot, libraries: () => [library], protectedRoots: () => [privateRoot], joinLibrary: async (root, name, content, publishResources) => {
    const target = path.join(root, `${copies + 1}-${name}`), publication = await publishResources?.(target); await fs.writeFile(target, publication?.content ?? content, 'utf8'); copies++; return { path: target, content: publication?.content ?? content, indexState: 'degraded' };
  } };
  const service = new DocumentSessionService(options);
  const open = async (name, bytes, encoding) => { const file = path.join(originals, name); await fs.writeFile(file, bytes); const pending = await service.enqueue(1, file); const result = await service.openRequest(1, pending.requestId, encoding); assert.equal(result.status, 'opened'); await service.finishRequest(1, pending.requestId); return result.snapshot; };
  const request = (s, revision, content, id = crypto.randomUUID(), formatOverride) => ({ documentSessionId: s.documentSessionId, draftRevision: revision, content, requestId: id, expectedDiskHash: s.diskVersion.diskHash, formatOverride });
  for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
    for (const bom of ['none', encoding]) {
      const content = bom === 'none' ? 'English\ufeff\n\n' : '\ufeffEnglish\n\n';
      const format = { encoding, bom, lineEnding: 'lf' }, bytes = encodeDocument(content, format).bytes;
      assert.deepEqual(decodeDocument(bytes, encoding), { content, format });
    }
  }
  for (const [text, lineEnding] of [['', 'none'], ['尾行', 'none'], ['正文\n\n', 'lf'], ['正文\r\r', 'cr'], ['正文\r\n\r\n', 'crlf']]) {
    const decoded = decodeDocument(Buffer.from(text)); assert.equal(decoded.format.lineEnding, lineEnding);
    assert.deepEqual(encodeDocument(decoded.content, decoded.format).bytes, Buffer.from(text));
  }
  for (const encoding of ['utf8', 'utf16le', 'utf16be', 'gbk', 'gb18030']) {
    const format = { encoding, bom: encoding.startsWith('utf') ? encoding : 'none', lineEnding: 'crlf' };
    const original = encodeDocument('采购验收\n回款核对\n', format).bytes;
    const s = await open(`${encoding}.txt`, original, encoding);
    assert.equal(s.content, '采购验收\n回款核对\n'); assert.deepEqual(s.format, format);
    const unchanged = await service.save(1, request(s, 0, s.content)); assert.equal(unchanged.status, 'unchanged'); assert.deepEqual(await fs.readFile(s.displayPath), original);
    const content = `${s.content}确认完成\n`; await service.updateDraft(1, request(s, 1, content));
    const req = request(s, 1, content); const result = await service.save(1, req); assert.equal(result.status, 'committed'); assert.deepEqual(decodeDocument(await fs.readFile(s.displayPath), encoding), { content, format });
    assert.deepEqual(await service.save(1, req), result, 'same request retries the original receipt');
    assert.throws(() => service.save(2, req), /会话/);
    await service.close(1, { documentSessionId: s.documentSessionId, draftRevision: 1, reason: 'saved' });
  }
  const ambiguous = path.join(originals, '无BOM.txt'); await fs.writeFile(ambiguous, encodeDocument('English\n中文', { encoding: 'utf16le', bom: 'none', lineEnding: 'lf' }).bytes);
  const ambiguousRequest = await service.enqueue(1, ambiguous); assert.equal((await service.openRequest(1, ambiguousRequest.requestId)).status, 'encoding-required');
  assert.equal((await service.openRequest(1, ambiguousRequest.requestId, 'utf16le')).status, 'opened');
  for (const encoding of ['utf16le', 'utf16be']) {
    const bytes = encodeDocument('ASCII only\n', { encoding, bom: 'none', lineEnding: 'lf' }).bytes;
    assert.throws(() => decodeDocument(bytes), /编码/); assert.equal(decodeDocument(bytes, encoding).content, 'ASCII only\n');
  }
  const mixed = await open('mixed.md', Buffer.from('# 采购\r\n正文\n尾行\r'));
  assert.equal((await service.save(1, request(mixed, 0, mixed.content))).status, 'unchanged');
  await service.updateDraft(1, request(mixed, 1, mixed.content + '补充'));
  const rejected = await service.save(1, request(mixed, 1, mixed.content + '补充')); assert.equal(rejected.code, 'DOCUMENT_ENCODING_REQUIRED');
  assert.equal((await service.save(1, request(mixed, 1, mixed.content + '补充', crypto.randomUUID(), { lineEnding: 'lf' }))).status, 'committed');
  const gbk = await open('loss.txt', encodeDocument('中文', { encoding: 'gbk', bom: 'none', lineEnding: 'none' }).bytes, 'gbk');
  await service.updateDraft(1, request(gbk, 1, '中文😀')); assert.equal((await service.save(1, request(gbk, 1, '中文😀'))).code, 'DOCUMENT_ENCODING_LOSS');
  const utfTarget = path.join(originals, 'unicode.txt'); const utfSave = await service.saveAs(1, request(gbk, 1, '中文😀', crypto.randomUUID(), { encoding: 'utf8', bom: 'none' }), utfTarget, null);
  assert.equal(utfSave.status, 'committed'); assert.equal(await fs.readFile(utfTarget, 'utf8'), '中文😀');
  const conflict = await open('conflict.md', '# 最初'); await service.updateDraft(1, request(conflict, 1, '# 我的草稿')); await fs.writeFile(conflict.displayPath, '# 别人的正文');
  assert.equal((await service.save(1, request(conflict, 1, '# 我的草稿'))).status, 'conflict'); assert.equal(await fs.readFile(conflict.displayPath, 'utf8'), '# 别人的正文');
  await fs.unlink(conflict.displayPath); assert.equal((await service.save(1, request(conflict, 1, '# 我的草稿'))).code, 'DOCUMENT_MISSING'); await assert.rejects(fs.access(conflict.displayPath));
  const records = await service.recovery.list(); const record = records.find(r => r.recoveryId === conflict.documentSessionId); assert.ok(record);
  const restoredService = new DocumentSessionService(options), restored = await restoredService.restore(8, record.recoveryId); assert.equal(restored.content, '# 我的草稿');
  assert.equal((await restoredService.save(8, request(restored, restored.draftRevision, restored.content))).code, 'DOCUMENT_MISSING');
  await restoredService.close(8, { documentSessionId: restored.documentSessionId, draftRevision: restored.draftRevision, reason: 'discard' });
  assert.throws(() => restoredService.updateDraft(8, request(restored, restored.draftRevision + 1, '# 迟到的草稿'))); assert.equal((await restoredService.recovery.list()).some(r => r.recoveryId === restored.documentSessionId), false);
  const route = path.join(library, '库内.md'); await fs.writeFile(route, '# 库内'); const routed = await service.enqueue(1, route); assert.equal((await service.openRequest(1, routed.requestId)).status, 'library');
  const protectedFile = path.join(privateRoot, 'private.md'); await fs.writeFile(protectedFile, 'private'); await assert.rejects(service.enqueue(1, protectedFile), /应用数据/);
  const plain = await open('join.md', '# 客户\n\n无本地资源'); await service.updateDraft(1, request(plain, 1, '# 当前草稿'));
  const joinReq = { documentSessionId: plain.documentSessionId, draftRevision: 1, requestId: 'join-once', libraryPath: library };
  const joined = await service.join(1, joinReq); assert.equal(joined.indexState, 'degraded'); assert.deepEqual(await service.join(1, joinReq), joined); assert.equal(copies, 1); assert.equal(await fs.readFile(plain.displayPath, 'utf8'), plain.content);
  await service.close(1, { documentSessionId: plain.documentSessionId, draftRevision: 1, reason: 'transferred', transferToken: joined.transferToken });
  const late = await open('late-transfer.md', '# 原稿'), lateJoin = await service.join(1, { documentSessionId: late.documentSessionId, draftRevision: 0, requestId: 'late-join', libraryPath: library });
  await service.updateDraft(1, request(late, 1, '# 较新的草稿'));
  await assert.rejects(service.close(1, { documentSessionId: late.documentSessionId, draftRevision: 1, reason: 'transferred', transferToken: lateJoin.transferToken }), /版本/);
  assert.equal((await service.recovery.list()).some(record => record.recoveryId === late.documentSessionId), true);
  await service.close(1, { documentSessionId: late.documentSessionId, draftRevision: 1, reason: 'discard' });
  const referenced = await open('图片.md', '![凭证](attachments/a.png)'); assert.equal(referenced.capabilities.canUseWysiwyg, false);
  const beforeRejectedJoin = copies; await assert.rejects(service.join(1, { ...joinReq, documentSessionId: referenced.documentSessionId, draftRevision: 0, requestId: 'resource' }), /本地/); assert.equal(copies, beforeRejectedJoin);
  await assert.rejects(service.targetHash(1, referenced.documentSessionId, path.join(library, 'copy.md')), /加入笔记库/);
  const wrongDir = await service.saveAs(1, request(referenced, 0, referenced.content), path.join(temporary, 'other.md'), null); assert.equal(wrongDir.code, 'DOCUMENT_RESOURCE_MISSING');
  const readonly = await open('只读.txt', '保留'); await fs.chmod(readonly.displayPath, 0o444);
  try { await service.updateDraft(1, request(readonly, 1, '修改')); assert.equal((await service.save(1, request(readonly, 1, '修改'))).status, 'failed'); assert.equal(await fs.readFile(readonly.displayPath, 'utf8'), '保留'); } finally { await fs.chmod(readonly.displayPath, 0o666); }
  if (process.platform === 'win32') {
    const locked = await open('occupied.txt', 'held original'); await service.updateDraft(1, request(locked, 1, 'pending draft'));
    const code = `import ctypes,sys\nk=ctypes.windll.kernel32\nk.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p]; k.CreateFileW.restype=ctypes.c_void_p\nh=k.CreateFileW(${JSON.stringify(locked.displayPath)},0x80000000,1,None,3,0,None)\nassert h and h!=ctypes.c_void_p(-1).value\nprint('READY',flush=True)\nsys.stdin.read()\nk.CloseHandle.argtypes=[ctypes.c_void_p]; k.CloseHandle(h)`;
    const holder = spawn('python', ['-c', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => holder.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Windows file lock timeout')), 10_000); holder.stdout.once('data', () => { clearTimeout(timeout); resolve(); }); holder.once('error', error => { clearTimeout(timeout); reject(error); }); });
      assert.equal((await service.save(1, request(locked, 1, 'pending draft'))).status, 'failed'); assert.equal(await fs.readFile(locked.displayPath, 'utf8'), 'held original');
    } finally { holder.stdin.end(); await exited; }
    assert.equal((await service.save(1, request(locked, 1, 'pending draft'))).status, 'committed');
  }
  const retry = await open('retry.txt', 'before'); await service.updateDraft(1, request(retry, 1, 'after'));
  const nativeRename = fs.rename; let denied = false;
  fs.rename = async (from, to) => { if (to === retry.displayPath && !denied) { denied = true; const error = new Error('busy'); error.code = 'EPERM'; throw error; } return nativeRename(from, to); };
  try { assert.equal((await service.save(1, request(retry, 1, 'after'))).status, 'committed'); } finally { fs.rename = nativeRename; }
  assert.equal((await fs.readdir(originals)).some(name => name.startsWith('.trellora-')), false);
  assert.equal((await fs.readdir(originals)).some(name => name.startsWith('.menghan-')), false);
  const controllerSnapshot = await open('controller.txt', 'original'); let release, calls = 0;
  const transport = { updateDraft: req => service.updateDraft(1, req), saveAs: async () => null, save: async req => { calls++; if (calls === 1) { const result = await service.save(1, req); await new Promise(resolve => { release = () => resolve(); }); return result; } return service.save(1, req); } };
  const controller = new DocumentSaveController(transport, () => undefined); controller.open(controllerSnapshot); controller.edit('first'); await controller.synchronize(); assert.equal(await fs.readFile(controllerSnapshot.displayPath, 'utf8'), 'original', 'recovery synchronization never saves originals');
  const saving = controller.save(); while (!release) await new Promise(resolve => setTimeout(resolve, 5)); controller.edit('second'); release(); assert.equal(await saving, true); assert.equal(controller.dirty, true); assert.equal(controller.content, 'second'); assert.equal(await fs.readFile(controllerSnapshot.displayPath, 'utf8'), 'first');
  assert.equal(await controller.save(), true); assert.equal(controller.dirty, false); assert.equal(await fs.readFile(controllerSnapshot.displayPath, 'utf8'), 'second');
  controller.edit('取消另存保留的草稿'); assert.equal(await controller.save('saveAs'), false); assert.equal(controller.dirty, true); assert.equal(controller.snapshot.displayPath, controllerSnapshot.displayPath); assert.equal(await fs.readFile(controllerSnapshot.displayPath, 'utf8'), 'second');
  assert.equal(await controller.save(), true);
  await service.close(1, { documentSessionId: controllerSnapshot.documentSessionId, draftRevision: controller.revision, reason: 'saved' }); controller.reset();
  const uncertainSnapshot = await open('uncertain.txt', 'start'); let loseResponse = true;
  const uncertain = new DocumentSaveController({ updateDraft: req => service.updateDraft(1, req), saveAs: async () => null, save: async req => { const result = await service.save(1, req); if (loseResponse) { loseResponse = false; throw new Error('lost IPC response after commit'); } return result; } }, () => undefined);
  uncertain.open(uncertainSnapshot); uncertain.edit('committed once'); assert.equal(await uncertain.save(), false); assert.equal(uncertain.uncertain, true);
  uncertain.edit('newer draft'); assert.equal(await uncertain.save(), true); assert.equal(uncertain.dirty, true); assert.equal(await fs.readFile(uncertainSnapshot.displayPath, 'utf8'), 'committed once');
  assert.equal(await uncertain.save(), true); assert.equal(await fs.readFile(uncertainSnapshot.displayPath, 'utf8'), 'newer draft');
  await service.close(1, { documentSessionId: uncertainSnapshot.documentSessionId, draftRevision: uncertain.revision, reason: 'saved' }); uncertain.reset();
  const queueSnapshot = await open('versions.txt', 'v0'); let version = queueSnapshot;
  for (let i = 1; i <= 5; i++) { await service.updateDraft(1, request(version, i, `v${i}`)); const result = await service.save(1, request(version, i, `v${i}`)); assert.equal(result.status, 'committed'); version = result.snapshot; }
  const versionDirs = await fs.readdir(path.join(privateRoot, 'versions')); const backupCounts = await Promise.all(versionDirs.map(dir => fs.readdir(path.join(privateRoot, 'versions', dir)))); assert.ok(backupCounts.every(entries => entries.length <= 3));
  const targetExisting = path.join(originals, 'existing.txt'); await fs.writeFile(targetExisting, 'original target'); const expectedTarget = await service.targetHash(1, version.documentSessionId, targetExisting); await fs.writeFile(targetExisting, 'external target change');
  assert.equal((await service.saveAs(1, request(version, 5, 'v5'), targetExisting, expectedTarget)).status, 'conflict'); assert.equal(await fs.readFile(targetExisting, 'utf8'), 'external target change');
  const expired = await service.enqueue(1, version.displayPath); service.finishRequest(1, expired.requestId); await assert.rejects(service.openRequest(1, expired.requestId), /失效/);
  const junction = path.join(originals, 'alias'); await fs.symlink(library, junction, 'junction'); const aliasRequest = await service.enqueue(1, path.join(junction, '库内.md')); assert.equal((await service.openRequest(1, aliasRequest.requestId)).status, 'library');
  // 私有缓存故障不能阻止用户保存；版本/冲突错误仍必须拒绝提交。
  const degradedSnapshot = await open('cache-unavailable.txt', 'original with cache');
  const degraded = new DocumentSaveController({ updateDraft: req => service.updateDraft(1, req), save: req => service.save(1, req), saveAs: req => service.saveAs(1, req, path.join(originals, 'cache-copy.txt'), null) }, () => undefined);
  const recoveryWrite = service.recovery.write.bind(service.recovery), recoveryBackup = service.recovery.backup.bind(service.recovery);
  const denyCache = async () => { const error = new Error('Recovery storage unavailable'); error.code = 'ENOSPC'; throw error; };
  service.recovery.write = denyCache; service.recovery.backup = denyCache;
  try {
    degraded.open(degradedSnapshot); degraded.edit('saved despite failed recovery'); await degraded.synchronize();
    assert.match(degraded.recoveryMessage, /恢复缓存/); assert.equal(await fs.readFile(degradedSnapshot.displayPath, 'utf8'), 'original with cache');
    assert.equal(await degraded.save(), true); assert.equal(degraded.dirty, false); assert.equal(await fs.readFile(degradedSnapshot.displayPath, 'utf8'), 'saved despite failed recovery');
    assert.match(degraded.recoveryMessage, /历史副本/);
    degraded.edit('save-as draft'); assert.equal(await degraded.save('saveAs'), true); assert.equal(await fs.readFile(path.join(originals, 'cache-copy.txt'), 'utf8'), 'save-as draft');
    assert.equal(await fs.readFile(degradedSnapshot.displayPath, 'utf8'), 'saved despite failed recovery');
    const overwriteTarget = path.join(originals, 'cache-overwrite.txt'); await fs.writeFile(overwriteTarget, 'old overwrite target');
    const overwriteHash = await service.targetHash(1, degradedSnapshot.documentSessionId, overwriteTarget);
    degraded.edit('overwrite without recovery backup'); await degraded.synchronize();
    const overwritten = await service.saveAs(1, request(degraded.snapshot, degraded.revision, degraded.content), overwriteTarget, overwriteHash);
    assert.equal(overwritten.status, 'committed'); assert.match(overwritten.recoveryMessage, /历史副本/);
    assert.equal(await fs.readFile(overwriteTarget, 'utf8'), 'overwrite without recovery backup');
    assert.equal(await fs.readFile(path.join(originals, 'cache-copy.txt'), 'utf8'), 'save-as draft');
    assert.equal((await service.close(1, { documentSessionId: degradedSnapshot.documentSessionId, draftRevision: degraded.revision, reason: 'saved' })).closed, true);
    degraded.reset();
    const discarded = await open('cache-discard.txt', 'untouched original'); await service.updateDraft(1, request(discarded, 1, 'unsaved'));
    await assert.rejects(service.close(1, { documentSessionId: discarded.documentSessionId, draftRevision: 1, reason: 'saved' }), /尚未保存/);
    await assert.rejects(service.updateDraft(1, request(discarded, 1, 'different same-revision content')), /同一草稿版本/);
    assert.equal((await service.close(1, { documentSessionId: discarded.documentSessionId, draftRevision: 1, reason: 'discard' })).closed, true);
    assert.equal(await fs.readFile(discarded.displayPath, 'utf8'), 'untouched original');
    await assert.rejects(async () => service.updateDraft(1, request(discarded, 2, 'late draft')), /失效/);
    const cacheConflict = await open('cache-conflict.txt', 'original'); await service.updateDraft(1, request(cacheConflict, 1, 'my draft'));
    await fs.writeFile(cacheConflict.displayPath, 'other application edit');
    assert.equal((await service.save(1, request(cacheConflict, 1, 'my draft'))).status, 'conflict');
    assert.equal(await fs.readFile(cacheConflict.displayPath, 'utf8'), 'other application edit');
    await service.close(1, { documentSessionId: cacheConflict.documentSessionId, draftRevision: 1, reason: 'discard' });
  } finally { service.recovery.write = recoveryWrite; service.recovery.backup = recoveryBackup; degraded.reset(); }
  // 无法写终态且无法删除时，返回明确提示，当前进程禁止旧恢复记录再次出现。
  const stuck = await open('cache-cleanup.txt', 'original'); await service.updateDraft(1, request(stuck, 1, 'stale recovery'));
  const nativeRemove = fs.rm; service.recovery.write = denyCache;
  fs.rm = async (target, options) => { if (target === path.join(privateRoot, `${stuck.documentSessionId}.json`)) return denyCache(); return nativeRemove(target, options); };
  try {
    const closed = await service.close(1, { documentSessionId: stuck.documentSessionId, draftRevision: 1, reason: 'discard' });
    assert.equal(closed.closed, true); assert.match(closed.recoveryMessage, /旧恢复缓存未能清理/);
    assert.equal((await service.recovery.list()).some(record => record.recoveryId === stuck.documentSessionId), false);
  } finally { service.recovery.write = recoveryWrite; fs.rm = nativeRemove; }
  const recoveredCache = await open('cache-recovered.txt', 'original');
  const healthy = new DocumentSaveController({ updateDraft: req => service.updateDraft(1, req), save: req => service.save(1, req), saveAs: async () => null }, () => undefined);
  healthy.open(recoveredCache); healthy.edit('recover cache'); service.recovery.write = denyCache;
  await healthy.synchronize(); assert.ok(healthy.recoveryMessage); service.recovery.write = recoveryWrite;
  await healthy.synchronize(); assert.equal(healthy.recoveryMessage, undefined); healthy.reset();
  await service.drain(); console.log('External document contracts passed: encoding, conflicts, recovery, queue, routing, transfer, manual saves.');
} finally { assert.equal(path.dirname(temporary), staging); await fs.rm(temporary, { recursive: true, force: true }); }
