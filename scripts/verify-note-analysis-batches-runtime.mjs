import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd();
const staging = path.join(root, '.package-staging');
fs.mkdirSync(staging, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(staging, 'note-batches-runtime-'));
try {
  const file = path.join(temporaryRoot, 'runtime.cjs');
  await build({ stdin: { resolveDir: root, contents: `export { NoteAnalysisBatchRepository } from './electron/knowledge/noteAnalysisBatchRepository'; export { NoteAnalysisBatchOrchestrator } from './electron/knowledge/noteAnalysisBatchOrchestrator'; export { synchronizeKnowledgeIndex, getNoteAnalysis, withKnowledgeDatabase } from './electron/knowledge/metaDatabase'; export { getNoteAnalysisSourceHash } from './electron/knowledge/noteAnalysisSource'; export { planNoteAnalysisBatches } from './electron/knowledge/noteAnalysisBatchPlanner'; export { noteAnalysisProviderFingerprint } from './electron/knowledge/noteAnalysisBatchPrompt';` }, outfile: file, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] });
  const { NoteAnalysisBatchRepository, NoteAnalysisBatchOrchestrator, synchronizeKnowledgeIndex, getNoteAnalysis, withKnowledgeDatabase, getNoteAnalysisSourceHash, planNoteAnalysisBatches, noteAnalysisProviderFingerprint } = await import(pathToFileURL(file).href);
  const library = path.join(temporaryRoot, 'library');
  fs.mkdirSync(library);
  const config = { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'simulation', contextWindowTokens: 200_000, contextWindowTokensSource: 'user' };
  const notes = new Map();
  const prepare = (name, markdown) => {
    const notePath = path.join(library, `${name}.md`);
    fs.writeFileSync(notePath, markdown, 'utf8');
    notes.set(notePath, { path: notePath, relativePath: `${name}.md`, title: name, kind: 'markdown', extension: '.md', mtimeMs: Date.now(), facts: { frontmatter: {}, headings: [], tags: [], outgoingLinks: [], plainText: markdown, contentHash: getNoteAnalysisSourceHash(markdown) } });
    synchronizeKnowledgeIndex(library, [...notes.values()]);
    return { repository, notePath, sourceHash: getNoteAnalysisSourceHash(markdown), input: { markdown, title: name, currentTags: [], libraryTags: ['财务'], config }, config, isSourceCurrent: () => true, onProgress() {} };
  };
  const repository = new NoteAnalysisBatchRepository(library);
  const batchIndex = (prompt) => Number(/批次：(\d+)\//u.exec(prompt)?.[1]);
  const payload = (index, size = 400) => ({ summary: `第${index}批摘要：` + '财务核对依据。'.repeat(Math.ceil(size / 7)), keyPoints: [`第${index}批关键事实`], tagCandidates: [{ name: '财务', confidence: 'high', evidence: '财务核对依据' }] });
  let active = 0;
  let maximum = 0;
  const calls = [];
  let taskId;
  const orchestrator = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => {
    const index = batchIndex(prompt);
    calls.push({ index, retry: prompt.includes('最多4000字'), prompt });
    if (index > 3) assert.ok(repository.get(taskId).batches.slice(0, 3).every((batch) => batch.status === 'succeeded'), '下一轮不得提前启动');
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 8 * (4 - ((index - 1) % 3))));
    active -= 1;
    return index === 1 ? payload(index, 1_800) : payload(index);
  });
  const longText = '财务凭证已登记。'.repeat(9_000) + '尾部验收：审计意见完整。';
  const request = prepare('全篇覆盖', longText);
  const progress = [];
  const checkpoints = [];
  request.onProgress = (event) => { progress.push(event); if (event.batchStatus === 'succeeded') checkpoints.push(repository.get(event.runId).batches[event.batchIndex].status === 'succeeded'); };
  const started = orchestrator.start(request);
  taskId = started.runId;
  assert.equal(orchestrator.start(request).runId, taskId, '重复启动复用运行中任务');
  const finished = await orchestrator.waitForCompletion(repository, taskId);
  assert.ok(maximum <= 3);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.completedBatches, finished.totalBatches);
  assert.equal(finished.batches[0].generationAttempts, 2);
  assert.equal(finished.batches[0].summaryCharacterCount, 750);
  assert.equal(finished.batches[0].lengthHandling, 'truncated');
  assert.ok(calls.at(-1).prompt.includes('尾部验收'));
  const stored = getNoteAnalysis(library, request.notePath, request.sourceHash);
  assert.equal(stored.analysisVersion, 2);
  assert.ok(stored.summary.length > 1_000, '新版数据库读取不能把整篇拼接结果截到1000');
  assert.equal(stored.batches.length, finished.totalBatches);
  const labels = finished.batches.map((batch) => stored.summary.indexOf(batch.sourceLabel));
  assert.ok(labels.every((offset, index) => index === 0 || offset > labels[index - 1]));
  assert.equal(new NoteAnalysisBatchRepository(library).getLatest(request.notePath).runId, taskId, '任务必须按路径持久发现');
  assert.ok(progress.some((event) => event.state === 'completed'));
  assert.equal(checkpoints.length, finished.totalBatches);
  assert.ok(checkpoints.every(Boolean), '事件发出时结果必须已落库');
  console.log('NB-2/3: length retry, full-text input, ordered output and immediate SQLite checkpoints passed.');

  const singleCalls = [];
  const single = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => { singleCalls.push(prompt); return payload(1); });
  const shortText = Array.from({ length: 20 }, (_, index) => `# 章节${index + 1}\n\n第${index + 1}项交付说明：${'财务凭证核对与交付验收。'.repeat(30)}`).join('\n\n');
  const shortRequest = prepare('多标题全文', shortText);
  const shortRun = single.start(shortRequest);
  const shortResult = await single.waitForCompletion(repository, shortRun.runId);
  assert.equal(shortResult.totalBatches, 1);
  assert.equal(shortResult.processingMode, 'full-document');
  assert.equal(singleCalls.length, 1);
  assert.ok(singleCalls[0].includes('章节20'));
  assert.equal(shortResult.batches[0].overlapCharacterCount, 0);
  assert.equal(shortResult.batches[0].sections.length, 20);
  assert.ok(repository.getInput(shortRun.runId).preparedDocument);
  assert.equal(getNoteAnalysis(library, shortRequest.notePath, shortRequest.sourceHash).processingMode, 'full-document');
  assert.ok(!JSON.stringify(shortResult).includes('preparedDocument'));
  const duplicate = '合同金额120000元，税率13%，保留金7%，整改32个工作日。'.repeat(4);
  const cleanedRequest = prepare('清洗重试', `# 验收\r\n\r\n${duplicate}\t\r\n\r\n<!-- noise-marker -->\r\n\r\n${duplicate}\r\n\r\n\`\`\`ts\r\n  const total = 120000;  \r\n\`\`\`\r\n`);
  const cleanPrompts = [];
  const cleanGenerator = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => { cleanPrompts.push(prompt); return payload(1, prompt.includes('最多4000字') ? 450 : 1_200); });
  const cleanedRun = cleanGenerator.start(cleanedRequest);
  const cleanedResult = await cleanGenerator.waitForCompletion(repository, cleanedRun.runId);
  assert.equal(cleanedResult.preparationStats.duplicateBlocks, 1);
  assert.equal(cleanPrompts.length, 2);
  for (const prompt of cleanPrompts) {
    assert.ok(!prompt.includes('noise-marker') && !prompt.includes('\r'));
    assert.equal(prompt.split(duplicate).length - 1, 1);
    assert.ok(prompt.includes('  const total = 120000;  '));
  }
  assert.equal(fs.readFileSync(cleanedRequest.notePath, 'utf8'), cleanedRequest.input.markdown);
  console.log('NB-6: full-document admission, frozen cleaned snapshot, exact deduplication and cleaned length retry passed.');
  const englishRequest = prepare('源码全文超过字符块上限', '# Source\n\n' + 'requestDispatcherGenerationContext '.repeat(750));
  const englishRun = single.start(englishRequest);
  const englishResult = await single.waitForCompletion(repository, englishRun.runId);
  assert.equal(englishResult.processingMode, 'full-document');
  assert.equal(englishResult.totalBatches, 1);
  assert.ok(englishResult.batches[0].inputCharacterCount > 12_000, '全文按token准入，不能强制使用分批字符上限');
  const oldRequest = prepare('旧版本未完成任务', longText);
  const oldRun = repository.create(oldRequest.notePath, oldRequest.sourceHash, noteAnalysisProviderFingerprint(config), oldRequest.input, planNoteAnalysisBatches(longText));
  repository.setState(oldRun.runId, 'partial');
  withKnowledgeDatabase(library, database => {
    const row = database.prepare('SELECT run_json FROM note_analysis_runs WHERE run_id = ?').get(oldRun.runId);
    const metadata = JSON.parse(row.run_json);
    metadata.policyVersion = 'note-analysis-batches-v1';
    database.prepare('UPDATE note_analysis_runs SET run_json = ? WHERE run_id = ?').run(JSON.stringify(metadata), oldRun.runId);
  });
  assert.equal(repository.get(oldRun.runId).batches.length, oldRun.totalBatches, '旧任务可读');
  await assert.rejects(single.resume(repository, oldRun.runId, config, () => true, () => {}), /规则已变化/u);

  let shouldFail = true;
  const counts = new Map();
  const failing = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => {
    const index = batchIndex(prompt);
    counts.set(index, (counts.get(index) ?? 0) + 1);
    if (index === 2 && shouldFail) throw new Error('模拟网络错误');
    return payload(index);
  });
  const failingRequest = prepare('失败恢复', longText);
  const partial = failing.start(failingRequest);
  await assert.rejects(failing.waitForCompletion(repository, partial.runId));
  const paused = repository.get(partial.runId);
  assert.equal(paused.state, 'partial');
  assert.equal(paused.completedBatches, 2);
  assert.equal(counts.has(4), false);
  assert.equal(getNoteAnalysis(library, failingRequest.notePath, failingRequest.sourceHash), null);
  shouldFail = false;
  await failing.resume(repository, partial.runId, config, () => true, () => {});
  await failing.waitForCompletion(repository, partial.runId);
  assert.equal(counts.get(1), 1);
  assert.equal(counts.get(3), 1);
  assert.equal(counts.get(2), 2);

  const structuredGenerator = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => payload(batchIndex(prompt), 4_500));
  const structuredRequest = prepare('章节例外', '# 对账流程\n\n应收核对凭证。');
  const structuredRun = structuredGenerator.start(structuredRequest);
  const structuredResult = await structuredGenerator.waitForCompletion(repository, structuredRun.runId);
  assert.equal(structuredResult.batches[0].lengthHandling, 'structured-over-limit-accepted');
  assert.ok(structuredResult.batches[0].summaryCharacterCount > 4_000);
  assert.ok(getNoteAnalysis(library, structuredRequest.notePath, structuredRequest.sourceHash).summary.length > 4_000);

  const interruptedRequest = prepare('崩溃恢复', longText);
  const plans = planNoteAnalysisBatches(longText);
  const crash = repository.create(interruptedRequest.notePath, interruptedRequest.sourceHash, noteAnalysisProviderFingerprint(config), interruptedRequest.input, plans);
  repository.setState(crash.runId, 'running');
  repository.saveBatch(crash.runId, { ...crash.batches[0], status: 'succeeded', summary: '已完成的第一批', keyPoints: [], tagCandidates: [], summaryCharacterCount: 8, generationAttempts: 1 });
  repository.saveBatch(crash.runId, { ...crash.batches[1], status: 'running', generationAttempts: 1 });
  repository.recoverInterrupted();
  assert.equal(repository.getLatest(interruptedRequest.notePath).state, 'partial');
  assert.equal(repository.get(crash.runId).batches[1].status, 'pending');
  const crashRequests = [];
  const resumed = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => { crashRequests.push(batchIndex(prompt)); return payload(batchIndex(prompt)); });
  await resumed.resume(repository, crash.runId, config, () => true, () => {});
  await resumed.waitForCompletion(repository, crash.runId);
  assert.ok(!crashRequests.includes(1));

  const cancelling = new NoteAnalysisBatchOrchestrator(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
    if (signal.aborted) reject(new Error('已取消'));
  }));
  const cancelRequest = prepare('取消分析', longText);
  const cancelRun = cancelling.start(cancelRequest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  cancelling.cancel(repository, cancelRun.runId);
  await assert.rejects(cancelling.waitForCompletion(repository, cancelRun.runId));
  assert.equal(repository.get(cancelRun.runId).state, 'cancelled');
  assert.ok(repository.get(cancelRun.runId).batches.every((batch) => batch.status !== 'succeeded'));

  let delayCancellation = true;
  const immediate = new NoteAnalysisBatchOrchestrator(({ prompt, signal }) => delayCancellation ? new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => setTimeout(() => reject(new Error('取消后传输清理')), 15), { once: true });
  }) : Promise.resolve(payload(batchIndex(prompt))));
  const immediateRun = immediate.start(prepare('立即恢复', longText));
  await new Promise(resolve => setTimeout(resolve, 5));
  immediate.cancel(repository, immediateRun.runId);
  delayCancellation = false;
  assert.equal((await immediate.resume(repository, immediateRun.runId, config, () => true, () => {})).state, 'running');
  assert.equal((await immediate.waitForCompletion(repository, immediateRun.runId)).state, 'completed');

  const late = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return payload(batchIndex(prompt));
  });
  const lateRequest = prepare('同源晚到结果', longText);
  const superseded = late.start(lateRequest);
  late.cancel(repository, superseded.runId);
  const replacement = late.start(lateRequest);
  assert.notEqual(replacement.runId, superseded.runId, '已取消任务不能被重复启动逻辑复用');
  await late.waitForCompletion(repository, replacement.runId);
  await assert.rejects(late.waitForCompletion(repository, superseded.runId));
  assert.equal(getNoteAnalysis(library, lateRequest.notePath, lateRequest.sourceHash).runId, replacement.runId);

  const labelledRequest = prepare('多段来源依据', Array.from({ length: 45 }, (_, index) => `第${index + 1}段财务核对依据。`).join('\n\n'));
  const labelledRun = late.start(labelledRequest);
  await late.waitForCompletion(repository, labelledRun.runId);
  assert.ok(getNoteAnalysis(library, labelledRequest.notePath, labelledRequest.sourceHash).tagCandidates[0].evidence.endsWith('财务核对依据'), '新版标签不能因长来源标签截掉实际依据');

  const invalid = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => prompt.includes('最多4000字') ? { summary: '', keyPoints: [], tagCandidates: [] } : payload(1, 1_500));
  const invalidRequest = prepare('无效长度重试', '财务核对完成。');
  const invalidRun = invalid.start(invalidRequest);
  await assert.rejects(invalid.waitForCompletion(repository, invalidRun.runId));
  assert.equal(repository.get(invalidRun.runId).batches[0].generationAttempts, 2);
  assert.equal(getNoteAnalysis(library, invalidRequest.notePath, invalidRequest.sourceHash), null);

  const smallerPrompts = [];
  const smaller = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => { smallerPrompts.push(prompt); return payload(batchIndex(prompt)); });
  const smallerRequest = prepare('小窗口完整覆盖', '连续无标题财务说明。'.repeat(1_000) + '小窗口尾部验收。');
  const smallConfig = { ...config, contextWindowTokens: 10_000 };
  smallerRequest.config = smallConfig;
  smallerRequest.input.config = smallConfig;
  const smallRun = smaller.start(smallerRequest);
  const smallResult = await smaller.waitForCompletion(repository, smallRun.runId);
  assert.ok(smallResult.totalBatches > 1);
  assert.ok(smallResult.batches.every(batch => batch.inputCharacterCount < 12_000));
  assert.ok(smallerPrompts.at(-1).includes('小窗口尾部验收'));

  let isCurrent = true;
  const stale = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => { isCurrent = false; return payload(batchIndex(prompt)); });
  const staleRequest = prepare('来源过期', longText);
  staleRequest.isSourceCurrent = () => isCurrent;
  const staleRun = stale.start(staleRequest);
  await assert.rejects(stale.waitForCompletion(repository, staleRun.runId));
  assert.equal(repository.get(staleRun.runId).state, 'stale');
  assert.equal(getNoteAnalysis(library, staleRequest.notePath, staleRequest.sourceHash), null);
  await assert.rejects(resumed.resume(repository, staleRun.runId, { ...config, model: '另一个模型' }, () => true, () => {}));

  let sharedActive = 0;
  let sharedMaximum = 0;
  const shared = new NoteAnalysisBatchOrchestrator(async ({ prompt }) => {
    sharedActive += 1;
    sharedMaximum = Math.max(sharedMaximum, sharedActive);
    await new Promise((resolve) => setTimeout(resolve, 4));
    sharedActive -= 1;
    return payload(batchIndex(prompt));
  });
  const sharedA = shared.start(prepare('共享并发甲', longText));
  const sharedB = shared.start(prepare('共享并发乙', longText));
  await Promise.all([shared.waitForCompletion(repository, sharedA.runId), shared.waitForCompletion(repository, sharedB.runId)]);
  assert.equal(sharedMaximum, 3);
  console.log('NB-3: partial retry, structured exception, restart recovery, cancellation, stale-source protection and shared concurrency passed.');
} finally {
  const resolved = path.resolve(temporaryRoot);
  assert.ok(resolved.startsWith(path.resolve(staging) + path.sep));
  assert.ok(path.basename(resolved).startsWith('note-batches-runtime-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
