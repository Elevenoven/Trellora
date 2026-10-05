import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const staging = path.resolve('.package-staging'); await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'save-benchmark-'));
const results = []; let coordinator;
try {
  await build({ entryPoints: ['electron/knowledge/indexCoordinator.ts', 'electron/knowledge/noteIndexWorker.ts', 'electron/knowledge/noteLexicalIndex.ts', 'electron/noteSaveService.ts'], entryNames: '[name]', outdir: temporary, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], logLevel: 'silent' });
  const require = createRequire(import.meta.url), { KnowledgeIndexCoordinator } = require(path.join(temporary, 'indexCoordinator.js'));
  const { createNoteLexicalIndex } = require(path.join(temporary, 'noteLexicalIndex.js')), { NoteSaveService } = require(path.join(temporary, 'noteSaveService.js'));
  for (const size of (process.argv.includes('--profile-watcher') ? [5_000] : [100, 1_000, 5_000])) {
    const library = path.join(temporary, `library-${size}`); await fs.mkdir(library);
    for (let batch = 0; batch < size; batch += 100) await Promise.all(Array.from({ length: Math.min(100, size - batch) }, (_, index) => {
      const number = batch + index; return fs.writeFile(path.join(library, `凭证-${number}.md`), `# 财务凭证 ${number}\n\n` + '企业采购凭证与回款记录逐项核对。'.repeat(75) + '\n#财务 [[凭证-1]]');
    }));
    coordinator = new KnowledgeIndexCoordinator(); await coordinator.initialize(library, createNoteLexicalIndex(), () => {});
    const phaseTimes = {};
    const service = new NoteSaveService({ timing: (phase, duration) => { (phaseTimes[phase] ??= []).push(duration); }, getLibraryPath: () => library, backupRetention: () => 20, committed: async (_library, file) => coordinator.update([{ kind: 'change', path: file }]) });
    const snapshot = await service.open(1, path.join(library, '凭证-0.md')); let version = snapshot.version;
    for (let warm = 0; warm < 3; warm++) {
      const result = await service.save(1, { editSessionId: snapshot.editSessionId, requestId: `warm-${warm}`, editRevision: warm + 1, expectedDiskHash: version.diskHash, content: `${snapshot.content}\n预热 ${warm}` }); version = result.version; await coordinator.drain();
    }
    await delay(2_000);
    for (const phase of Object.keys(phaseTimes)) phaseTimes[phase] = [];
    if (process.argv.includes('--profile-watcher')) { await coordinator.watcher.close(); coordinator.watcher = undefined; await delay(1_000); }
    const metrics = { ...coordinator.metrics }, commits = [], indexes = [], loops = []; let maximumDelay = 0, tick = performance.now();
    const timer = setInterval(() => { const now = performance.now(), elapsed = Math.max(0, now - tick - 5); loops.push(elapsed); maximumDelay = Math.max(maximumDelay, elapsed); tick = now; }, 5);
    for (let sample = 0; sample < 30; sample++) {
      const start = performance.now();
      const result = await service.save(1, { editSessionId: snapshot.editSessionId, requestId: `sample-${sample}`, editRevision: sample + 4, expectedDiskHash: version.diskHash, content: `${snapshot.content}\n热保存 ${sample} #验收 [[凭证-2]]` });
      const committed = performance.now(); assert.ok(['committed', 'unchanged'].includes(result.status)); version = result.version;
      await coordinator.drain(); commits.push(committed - start); indexes.push(performance.now() - committed); await delay(5);
    }
    clearInterval(timer);
    const row = { phasesP95Ms: Object.fromEntries(Object.entries(phaseTimes).map(([phase, times]) => [phase, p95(times)])), watcherSuspendedForProbe: process.argv.includes('--profile-watcher'), notes: size, samples: 30, commitP50Ms: percentile(commits, .5), commitP95Ms: p95(commits), indexP50Ms: percentile(indexes, .5), indexP95Ms: p95(indexes), totalP50Ms: percentile(commits.map((value, index) => value + indexes[index]), .5), totalP95Ms: p95(commits.map((value, index) => value + indexes[index])), eventLoopDelayP50Ms: percentile(loops, .5), eventLoopDelayP95Ms: p95(loops), maximumEventLoopDelayMs: rounded(maximumDelay), fullScansDuringSaves: coordinator.metrics.fullScans - metrics.fullScans, searchResetsDuringSaves: coordinator.metrics.searchResets - metrics.searchResets, parsesDuringSaves: coordinator.metrics.parses - metrics.parses };
    results.push(row); console.log(JSON.stringify(row));
    assert.equal(row.fullScansDuringSaves, 0); assert.equal(row.searchResetsDuringSaves, 0); assert.equal(row.parsesDuringSaves, 30);
    if (size === 5_000) {
      const prefix = '# 大笔记\n\n', phrase = '合同编号 HT202609300001；采购与付款凭证已经核对。\n';
      let large = prefix + phrase.repeat(Math.floor((1_048_576 - Buffer.byteLength(prefix)) / Buffer.byteLength(phrase)));
      large += 'x'.repeat(1_048_576 - Buffer.byteLength(large));
      const file = path.join(library, '大笔记.md'); await fs.writeFile(file, large); await coordinator.update([{ kind: 'add', path: file }]);
      const big = await service.open(1, file), start = performance.now();
      const result = await service.save(1, { editSessionId: big.editSessionId, requestId: 'large', editRevision: 1, expectedDiskHash: big.version.diskHash, content: `${large}\n末尾索引验收` });
      const commit = performance.now(); await coordinator.drain();
      const row = { kind: 'large-note', byteLength: Buffer.byteLength(large), commitMs: rounded(commit - start), indexMs: rounded(performance.now() - commit), status: result.status }; results.push(row); console.log(JSON.stringify(row));
    }
    await service.drain(); await coordinator.shutdown(); coordinator = undefined;
  }
  const report = path.resolve(process.argv.includes('--profile-watcher') ? 'docs/verification/note-save-watcher-probe.json' : 'docs/verification/note-save-benchmark.json'); await fs.mkdir(path.dirname(report), { recursive: true });
  await fs.writeFile(report, JSON.stringify({ date: new Date().toISOString(), runtime: process.versions,
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), fixtureVolume: path.parse(temporary).root,
      antivirus: 'Host settings unchanged; realtime scanning was not disabled.', measurement: 'Electron Node runtime, main-process service and projections; excludes renderer/IPC latency.' }, results }, null, 2));
  for (const row of results.filter(row => row.samples && !process.argv.includes('--profile-watcher'))) { assert.ok(row.commitP95Ms <= 200, JSON.stringify(row)); assert.ok(row.indexP95Ms <= 500, JSON.stringify(row)); assert.ok(row.eventLoopDelayP95Ms <= 50, JSON.stringify(row)); }
} finally { await coordinator?.shutdown(); assert.equal(path.dirname(temporary), staging); await fs.rm(temporary, { recursive: true, force: true }); }
function rounded(value) { return Math.round(value * 100) / 100; }
function percentile(values, p) { return rounded([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0); }
function p95(values) { return percentile(values, .95); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
