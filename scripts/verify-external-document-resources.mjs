import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const bundle = await fs.mkdtemp(path.join(staging, 'external-resource-contract-')), fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-resource-contract-'));
const require = createRequire(import.meta.url), checks = [];
try {
  await build({ entryPoints: ['electron/documents/documentSessionService.ts', 'electron/documents/documentAiService.ts', 'shared/documentResourceManifest.ts'], outdir: bundle, outbase: '.', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { DocumentSessionService } = require(path.join(bundle, 'electron/documents/documentSessionService.js'));
  const { DocumentAiService } = require(path.join(bundle, 'electron/documents/documentAiService.js'));
  const { collectDocumentReferences } = require(path.join(bundle, 'shared/documentResourceManifest.js'));
  const original = path.join(fixture, 'original'), library = path.join(fixture, 'library'), privateRoot = path.join(fixture, 'private'), extra = path.join(fixture, 'extra'), destination = path.join(fixture, 'destination');
  for (const root of [original, library, privateRoot, extra, destination]) await fs.mkdir(root);
  await fs.mkdir(path.join(original, 'attachments')); const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZkSIAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(original, 'attachments/中文 空格.png'), image); await fs.writeFile(path.join(extra, '授权.png'), image); await fs.writeFile(path.join(original, '合同.txt'), '独立资料');
  let publications = 0;
  const options = { recoveryRoot: privateRoot, libraries: () => [library], protectedRoots: () => [privateRoot], joinLibrary: async (root, name, content, resources) => {
    const target = path.join(root, `${publications + 1}-${name}`), publication = await resources?.(target);
    try { await fs.writeFile(target, publication?.content ?? content, { flag: 'wx' }); publications++; return { path: target, content: publication?.content ?? content, indexState: 'degraded' }; } catch (error) { await publication?.rollback(); throw error; }
  } };
  const service = new DocumentSessionService(options);
  const text = '![行内](<attachments/中文 空格.png>)\n\n![引用][凭证]\n\n[凭证]: <attachments/中文 空格.png> "收款凭证"\n\n<img alt="HTML" src="attachments/中文 空格.png">\n\n[合同](合同.txt)\n\n`![代码](missing.png)`\n';
  const source = path.join(original, '客户.md'); await fs.writeFile(source, text); const pending = await service.enqueue(1, source), opened = await service.openRequest(1, pending.requestId); const snapshot = opened.snapshot, id = snapshot.documentSessionId;
  const manifest = collectDocumentReferences(text); assert.equal(manifest.references.length, 4); assert.equal(manifest.unsupported.length, 0);
  const preview = await service.previewResources(1, id); assert.equal(preview.issues.length, 0); assert.equal(Object.keys(preview.urls).length, 1);
  for (const url of Object.values(preview.urls)) assert.deepEqual(Buffer.from((await service.resources.read(url)).bytes), image);
  await assert.rejects(service.resources.read(Object.values(preview.urls)[0], 'POST')); checks.push('AST inline/reference/HTML images and quoted Chinese-space paths; GET-only opaque resource tokens');
  const update = (revision, content) => ({ documentSessionId: id, draftRevision: revision, content });
  await service.updateDraft(1, update(1, '![越界](../extra/授权.png)'));
  assert.equal((await service.previewResources(1, id)).issues.length, 1); service.grantResourceRoot(1, id, extra); assert.equal((await service.previewResources(1, id)).issues.length, 0);
  const alias = path.join(original, 'escape'); await fs.symlink(extra, alias, 'junction');
  const other = new DocumentSessionService(options), otherPending = await other.enqueue(2, source), otherSnapshot = (await other.openRequest(2, otherPending.requestId)).snapshot;
  await other.updateDraft(2, { documentSessionId: otherSnapshot.documentSessionId, draftRevision: 1, content: '![链接逃逸](escape/授权.png)' }); assert.equal((await other.previewResources(2, otherSnapshot.documentSessionId)).issues.length, 1);
  checks.push('parent escape and junction escape denied; explicit extra root is read-only and session-specific');
  await service.updateDraft(1, update(2, text)); const oldToken = Object.values((await service.previewResources(1, id)).urls)[0];
  const draft = await service.addDraftImage(1, id, { bytes: new Uint8Array(image), extension: '.png' }); await service.updateDraft(1, update(3, text + `\n![草稿](${draft.markdownPath})\n`));
  assert.equal((await fs.readdir(original)).includes('客户.assets'), false); assert.equal(await fs.readFile(source, 'utf8'), text);
  const record = (await service.recovery.list()).find(record => record.recoveryId === id); const cold = new DocumentSessionService(options), recovered = await cold.restore(8, record.recoveryId); assert.ok(Object.keys((await cold.previewResources(8, recovered.documentSessionId)).urls).some(href => href.startsWith('trellora-draft:')));
  const req = { ...update(3, text + `\n![草稿](${draft.markdownPath})\n`), requestId: 'save-assets', expectedDiskHash: snapshot.diskVersion.diskHash };
  const saved = await service.save(1, req); assert.equal(saved.status, 'committed'); assert.ok(saved.committedContent.includes('客户.assets/')); assert.equal(saved.committedContent.includes('trellora-draft:'), false); assert.equal((await fs.readdir(path.join(original, '客户.assets'))).length, 1);
  await assert.rejects(service.resources.read(oldToken)); checks.push('private image before save, cold recovery of draft assets, publication only on save, stale token revoked');
  const target = path.join(destination, '另存.md'), current = service.snapshot(1, id); const copied = await service.saveAs(1, { ...update(3, current.content), requestId: 'save-copy', expectedDiskHash: current.diskVersion.diskHash }, target, null); assert.equal(copied.status, 'committed');
  const migrated = collectDocumentReferences(copied.committedContent); for (const ref of migrated.references) assert.ok((await fs.stat(path.resolve(destination, decodeURIComponent(ref.href.split('#')[0])))).isFile());
  await service.updateDraft(1, update(3, req.content)); assert.equal(service.snapshot(1, id).content, copied.committedContent);
  assert.equal(copied.committedContent.includes('`![代码](missing.png)`'), true); assert.equal(copied.committedContent.includes('"收款凭证"'), true);
  const joined = await service.join(1, { documentSessionId: id, draftRevision: 3, requestId: 'join-assets', libraryPath: library }); assert.equal(joined.indexState, 'degraded'); assert.deepEqual(await service.join(1, { documentSessionId: id, draftRevision: 3, requestId: 'join-assets', libraryPath: library }), joined); assert.equal(publications, 1);
  for (const ref of collectDocumentReferences(await fs.readFile(joined.path, 'utf8')).references) assert.ok((await fs.stat(path.resolve(library, decodeURIComponent(ref.href)))).isFile()); checks.push('cross-directory save and library transfer copy all referenced resources without rewriting code or titles; idempotent degraded indexing');
  await service.close(1, { documentSessionId: id, draftRevision: 3, reason: 'transferred', transferToken: joined.transferToken }); await assert.rejects(service.resources.read(Object.values(preview.urls)[0]));
  const failurePath = path.join(original, '失败.md'); await fs.writeFile(failurePath, '原正文');
  const failedSession = (await service.openRequest(4, (await service.enqueue(4, failurePath)).requestId)).snapshot;
  const asset1 = await service.addDraftImage(4, failedSession.documentSessionId, { bytes: new Uint8Array(image), extension: '.png' });
  const asset2 = await service.addDraftImage(4, failedSession.documentSessionId, { bytes: new Uint8Array(image), extension: '.png' });
  const failedBody = `![一](${asset1.markdownPath})\n![二](${asset2.markdownPath})`;
  await service.updateDraft(4, { documentSessionId: failedSession.documentSessionId, draftRevision: 1, content: failedBody });
  const failureDir = path.join(original, '失败.assets'); await fs.mkdir(failureDir); await fs.writeFile(path.join(failureDir, '用户原资源.png'), image);
  const failRequest = { documentSessionId: failedSession.documentSessionId, draftRevision: 1, content: failedBody, expectedDiskHash: failedSession.diskVersion.diskHash };
  const originalOpen = fs.open, originalRename = fs.rename; let copies = 0;
  try { fs.open = async (file, ...args) => { if (path.dirname(String(file)) === failureDir && ++copies === 2) throw Object.assign(new Error('copy failure fixture'), { code: 'EIO' }); return originalOpen(file, ...args); }; assert.equal((await service.save(4, { ...failRequest, requestId: 'fail-copy' })).status, 'failed'); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await fs.readdir(failureDir), ['用户原资源.png']); assert.equal(await fs.readFile(failurePath, 'utf8'), '原正文');
  try { fs.rename = async (from, to) => { if (to === failurePath) throw Object.assign(new Error('body commit failure fixture'), { code: 'EIO' }); return originalRename(from, to); }; assert.equal((await service.save(4, { ...failRequest, requestId: 'fail-body' })).status, 'failed'); }
  finally { fs.rename = originalRename; }
  assert.deepEqual(await fs.readdir(failureDir), ['用户原资源.png']); assert.equal(await fs.readFile(failurePath, 'utf8'), '原正文'); assert.deepEqual(await fs.readFile(path.join(failureDir, '用户原资源.png')), image);
  checks.push('second resource copy and body replacement failures roll back only owned files; original document and user resource survive');
  for (const format of ['utf8', 'utf16le', 'utf16be']) {
    const raceTarget = path.join(destination, `回滚-${format}.md`);
    const publication = await service.resources.publish(failedSession.documentSessionId, failedBody, raceTarget, false);
    const bytes = Buffer.from(publication.content, format === 'utf8' ? 'utf8' : 'utf16le');
    await fs.writeFile(raceTarget, format === 'utf16be' ? bytes.swap16() : bytes);
    await publication.rollback();
    for (const ref of collectDocumentReferences(publication.content).references) assert.ok((await fs.stat(path.resolve(destination, decodeURIComponent(ref.href)))).isFile());
  }
  checks.push('rollback preserves resources already referenced by another writer in UTF-8 and UTF-16 LE/BE bodies');
  const aiPending = await service.enqueue(1, source), aiSnapshot = (await service.openRequest(1, aiPending.requestId)).snapshot, prompts = []; let release, delayed = false;
  const ai = new DocumentAiService({ snapshot: (sender, key) => service.snapshot(sender, key), updateDraft: (sender, request) => service.updateDraft(sender, request), runtime: () => ({ kind: 'ollama', model: 'controlled-model', contextWindowTokens: 8192 }), generate: async input => { prompts.push(input.prompt); if (delayed) await new Promise(resolve => { release = resolve; }); return '经过审阅的表达'; }, supplement: async root => { assert.equal(root, library); return '显式补充资料'; } });
  const request = { documentSessionId: aiSnapshot.documentSessionId, draftRevision: 0, requestId: 'ai-one', action: 'rewrite', selection: { from: 0, to: 2, text: aiSnapshot.content.slice(0, 2) } };
  const result = await ai.run(1, request); assert.equal(prompts[0].includes('显式补充资料'), false); const applyRequest = { receiptId: result.receiptId, documentSessionId: request.documentSessionId, draftRevision: request.draftRevision, selection: request.selection };
  await assert.rejects(ai.apply(1, { ...applyRequest, selection: undefined }), /已变化/);
  const applied = await ai.apply(1, applyRequest); assert.equal(applied.draftRevision, 1); assert.equal(await fs.readFile(source, 'utf8'), saved.committedContent); await assert.rejects(ai.apply(2, applyRequest));
  delayed = true; const late = ai.run(1, { ...request, draftRevision: 1, requestId: 'ai-late', selection: { from: 0, to: 2, text: applied.content.slice(0, 2) } }); while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await service.updateDraft(1, { documentSessionId: applied.documentSessionId, draftRevision: 2, content: applied.content + '\n继续输入' }); release(); const lateResult = await late; await assert.rejects(ai.apply(1, { ...applyRequest, receiptId: lateResult.receiptId, draftRevision: 1, selection: lateResult.selection }), /已变化/);
  delayed = false; const question = await ai.run(1, { documentSessionId: applied.documentSessionId, draftRevision: 2, requestId: 'ai-question', action: 'question', question: '文档内容是什么？', libraryPath: library }); assert.equal(question.scope, 'document'); assert.equal(prompts.at(-1).includes('显式补充资料'), true);
  const before = prompts.length; await service.updateDraft(1, { documentSessionId: applied.documentSessionId, draftRevision: 3, content: '超出预算'.repeat(20000) }); await assert.rejects(ai.run(1, { documentSessionId: applied.documentSessionId, draftRevision: 3, requestId: 'ai-budget', action: 'summary' }), /超过模型/); assert.equal(prompts.length, before);
  checks.push('AI freezes authorized draft, no implicit library context or original save, sender/version/selection guarded apply, late suggestion retained, whole-document budget enforced');
  await fs.mkdir(path.resolve('docs/verification/external-documents'), { recursive: true }); await fs.writeFile(path.resolve('docs/verification/external-documents/resources-ai-contract.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), checks, model: 'controlled callback', realModel: false }, null, 2)); console.log(`External resource/AI contracts passed (${checks.length} groups).`);
} finally { assert.equal(path.dirname(bundle), staging); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); await fs.rm(bundle, { recursive: true, force: true }); await fs.rm(fixture, { recursive: true, force: true }); }
