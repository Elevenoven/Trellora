import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'save-controller-'));
try {
  await build({ entryPoints: ['src/utils/noteSaveController.ts', 'electron/noteCloseCoordinator.ts'], entryNames: '[name]', outdir: temporary, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const require = createRequire(import.meta.url);
  const { NoteSaveController } = require(path.join(temporary, 'noteSaveController.js'));
  const { NoteCloseCoordinator } = require(path.join(temporary, 'noteCloseCoordinator.js'));
  const snapshot = () => ({ editSessionId: 'session', libraryPath: 'library', path: 'note.md', content: 'original', version: { diskHash: 'a'.repeat(64), byteLength: 8, mtimeMs: 1 } });
  const success = (request, hash = 'b') => ({ status: 'committed', requestId: request.requestId, editRevision: request.editRevision, version: { diskHash: hash.repeat(64), byteLength: request.content.length, mtimeMs: 2 }, indexState: 'pending' });
  const requests = [], resolvers = [];
  const controller = new NoteSaveController((request) => { requests.push(request); return new Promise((resolve) => resolvers.push(resolve)); }, () => {});
  controller.open(snapshot()); controller.edit('A', 60_000);
  const flush = controller.flush();
  assert.equal(controller.flush(), flush, 'flush waits for the same in-flight request');
  controller.edit('B', 60_000); assert.equal(requests[0].content, 'A');
  resolvers.shift()({ status: 'failed', requestId: requests[0].requestId, code: 'LOCKED', message: '锁定', retryable: true });
  assert.equal(await flush, false); assert.equal(controller.content, 'B'); assert.equal(controller.dirty, true);
  controller.acknowledgeIndex('current', 0); assert.equal(controller.message, '锁定', 'an old index acknowledgement must not clear the newer save error');
  const retry = controller.flush(); assert.equal(requests[1].content, 'B'); resolvers.shift()(success(requests[1]));
  assert.equal(await retry, true); assert.equal(controller.dirty, false);
  controller.open({ ...snapshot(), version: controller.snapshot.version });
  controller.edit('C', 60_000); const next = controller.flush(); assert.equal(requests[2].editRevision, 3, 'refresh of the same session retains its monotonic revision');
  controller.edit('D', 60_000); resolvers.shift()(success(requests[2], 'c'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests[3].content, 'D'); assert.equal(requests[3].expectedDiskHash, 'c'.repeat(64)); resolvers.shift()(success(requests[3], 'd')); assert.equal(await next, true);

  const identity = []; let failTransport = true;
  const transport = new NoteSaveController(async (request) => { identity.push(request); if (failTransport) { failTransport = false; throw new Error('回执丢失'); } return success(request); }, () => {});
  transport.open(snapshot()); transport.edit('lost response', 60_000); assert.equal(await transport.flush(), false);
  transport.edit('latest draft', 60_000); assert.equal(await transport.flush(), true);
  assert.deepEqual(identity[1], identity[0]); assert.equal(identity[2].content, 'latest draft');
  await transport.mutate(async () => { assert.equal(transport.blocked, true); transport.edit('must not enter', 60_000); assert.equal(transport.content, 'latest draft'); });
  assert.equal(transport.blocked, false);
  const mutations = []; let mutationLost = true;
  await transport.mutate(async () => {
    assert.equal(await transport.commitMutation(async base => {
      mutations.push(base);
      if (mutationLost) { mutationLost = false; throw new Error('标签写入回执丢失'); }
      return { ...success({ ...base, content: 'tagged body' }), content: 'tagged body' };
    }), false);
  });
  transport.edit('newer draft after uncertain mutation', 60_000);
  assert.equal(await transport.flush(), true);
  assert.deepEqual(mutations[0], mutations[1]); assert.equal(transport.content, 'newer draft after uncertain mutation');
  transport.conflict('外部修改'); transport.edit('retained conflict draft', 60_000); assert.equal(await transport.flush(), false); assert.equal(transport.content, 'retained conflict draft');

  let finishDrain, closed = 0, failures = 0, closeId;
  const closer = new NoteCloseCoordinator(() => new Promise(resolve => { finishDrain = resolve; }), () => { failures++; });
  const closing = closer.request(1, id => { closeId = id; }, () => { closed++; });
  closer.respond(2, { requestId: closeId, ok: true }); assert.equal(closed, 0);
  closer.respond(1, { requestId: closeId, ok: true }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closer.allowed, false); finishDrain(); await closing; assert.equal(closed, 1);
  const rejected = new NoteCloseCoordinator(async () => {}, () => { failures++; });
  const rejection = rejected.request(1, id => rejected.respond(1, { requestId: id, ok: false }), () => { closed++; });
  await rejection; assert.equal(rejected.allowed, false); assert.equal(failures, 1); assert.equal(closed, 1);
  const drainFailure = new NoteCloseCoordinator(async () => { throw new Error('未完成的磁盘写入'); }, () => { failures++; });
  await drainFailure.request(1, id => drainFailure.respond(1, { requestId: id, ok: true }), () => { closed++; });
  assert.equal(drainFailure.allowed, false); assert.equal(failures, 2); assert.equal(closed, 1);
  const timedOut = new NoteCloseCoordinator(async () => {}, () => { failures++; });
  await timedOut.request(1, () => {}, () => { closed++; });
  assert.equal(timedOut.allowed, false); assert.equal(failures, 3); assert.equal(closed, 1);
  controller.reset(); transport.reset();
  console.log('Save controller verified: A/B drafts, in-flight flush, monotonic revisions, uncertain-response identity including mutations, mutation freeze, conflicts and close handshake.');
} finally {
  if (!temporary.startsWith(`${staging}${path.sep}`)) throw new Error('Invalid test cleanup path');
  await fs.rm(temporary, { recursive: true, force: true });
}
