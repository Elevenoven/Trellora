import { installFixtureNoteSave } from './cdp-note-save.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { build } from 'esbuild';

const root = process.cwd();
const staging = path.join(root, '.package-staging');
fs.mkdirSync(staging, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(staging, 'note-batches-electron-'));
const userData = path.join(temporaryRoot, 'user-data');
const workspace = path.join(temporaryRoot, 'workspace');
const mainEntry = path.join(temporaryRoot, 'dist-electron', 'main.js');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const calls = [];
const modes = new Map();
let active = 0;
let maximum = 0;
let session;
const server = createServer(async (request, response) => {
  if (request.url === '/api/tags') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'note-batch-fixture' }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/generate') { response.writeHead(404); response.end(); return; }
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const prompt = payload.prompt ?? '';
  const title = /笔记标题：([^\r\n]+)/u.exec(prompt)?.[1];
  const index = Number(/批次：(\d+)\//u.exec(prompt)?.[1]);
  const retry = prompt.includes('最多4000字');
  calls.push({ title, index, retry, prompt });
  active += 1;
  maximum = Math.max(maximum, active);
  let released = false;
  const release = () => { if (!released) { released = true; active -= 1; } };
  response.once('close', release);
  const mode = modes.get(title);
  await delay(mode === 'slow' && index > 3 ? 1_500 : 60 * (4 - ((index - 1) % 3)));
  if (response.destroyed) return;
  if (mode === 'fail' && index === 2) { response.writeHead(503); response.end('模拟第二批网络故障'); release(); return; }
  const size = mode === 'structured' ? 4_500 : mode === 'single' ? 450 : index === 1 ? 1_400 : 450;
  const result = { summary: `第${index}批财务摘要：` + '凭证核对完成。'.repeat(Math.ceil(size / 7)), keyPoints: [`第${index}批核对结论`], tagCandidates: [{ name: '财务', confidence: 'high', evidence: '财务凭证已登记' }] };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ response: JSON.stringify(result), done: true }));
  release();
});

try {
  for (const directory of [userData, workspace, path.dirname(mainEntry)]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(workspace, '初始笔记.md'), '# 初始笔记\n\n用于确认笔记切换。');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: workspace, appPreferences: { theme: 'dark', defaultEditorMode: 'source' } }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry }),
    build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js') }),
    build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'preload.js') }),
    build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], bundle: true, platform: 'node', external: ['better-sqlite3'], outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js') }),
    process.argv.includes('--reuse-renderer')
      ? Promise.resolve(fs.cpSync(path.join(root, 'dist'), path.join(temporaryRoot, 'dist'), { recursive: true }))
      : command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporaryRoot, 'dist')]),
  ]);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  session = await launch();
  await session.evaluate(`window.electronAPI.saveAiProviderConfig(${JSON.stringify({ kind: 'ollama', endpoint, model: 'note-batch-fixture', contextWindowTokens: 200_000, contextWindowTokensSource: 'user' })})`);
  if (!process.argv.includes('--real-model-only')) {
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
  const raw = '财务凭证已登记。'.repeat(9_000) + '末尾覆盖验收：审计意见完整。';
  const firstPath = await createNote('全篇覆盖验收', raw);
  await openNote('全篇覆盖验收');
  await waitFor(async () => session.evaluate("[...document.querySelectorAll('.knowledge-section')].find(node => node.querySelector('h4')?.textContent?.includes('概览'))?.querySelector('button')?.disabled === false"), '可用的生成按钮');
  await session.evaluate("[...document.querySelectorAll('.knowledge-section')].find(node => node.querySelector('h4')?.textContent?.includes('概览'))?.querySelector('button')?.click()");
  let firstRun;
  try {
    await waitFor(async () => {
      firstRun = await latest(firstPath);
      if (['partial', 'failed', 'stale', 'cancelled'].includes(firstRun?.state)) throw new Error(`界面生成失败：${firstRun.error?.message ?? firstRun.state}`);
      return firstRun?.state === 'completed';
    }, '界面触发完整分析');
  } catch (error) {
    const ui = await session.evaluate("({ panel: document.querySelector('.knowledge-panel')?.innerText, save: document.querySelector('.note-save-notice')?.innerText, dialogs: window.__noteAnalysisTestAlerts, alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent), sections: [...document.querySelectorAll('.knowledge-section')].map(node => ({ heading: node.querySelector('h4')?.textContent, buttons: [...node.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled })) })) })");
    ui.diskLength = (await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(firstPath)})`)).length;
    throw new Error(`${error.message}\n${JSON.stringify({ run: firstRun, calls: calls.map(call => ({ title: call.title, index: call.index, retry: call.retry })), ui })}`);
  }
  await waitFor(async () => (await session.evaluate("document.querySelector('.note-analysis-progress')?.innerText ?? ''")).includes(`${firstRun.totalBatches}/${firstRun.totalBatches}`), '真实完成进度');
  await session.evaluate("[...document.querySelectorAll('.note-overview-toggle')].find(node => node.textContent?.includes('模型请求'))?.click()");
  await waitFor(async () => (await session.evaluate("document.querySelectorAll('.note-analysis-batch').length")) === firstRun.totalBatches, '全部批次列表');
  const sources = await session.evaluate("[...document.querySelectorAll('.note-analysis-batch-source')].map(node => node.textContent)");
  assert.deepEqual(sources, firstRun.batches.map(batch => batch.sourceLabel));
  assert.ok(calls.some(call => call.title === '全篇覆盖验收' && call.prompt.includes('末尾覆盖验收')));
  assert.equal(firstRun.batches[0].summaryCharacterCount, 750);
  assert.equal(firstRun.batches[0].generationAttempts, 2);
  assert.equal(maximum, 3);
  const firstAnalysis = await session.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(firstPath)})`);
  assert.ok(firstAnalysis.summary.length > 1_000);
  assert.equal(firstAnalysis.batches.length, firstRun.totalBatches);
  assert.equal(await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(firstPath)})`), raw);
  assert.doesNotMatch(await session.evaluate("document.querySelector('.knowledge-panel')?.innerText ?? ''"), /属性/);
  assert.ok(!JSON.stringify(firstRun).includes('apiKey'));
  assert.ok(!Object.hasOwn(firstRun, 'markdown'));
  await waitFor(async () => session.evaluate("[...document.querySelectorAll('button')].some(node => /应用 1 个标签/.test(node.textContent) && !node.disabled)"), '完成后可应用的标签建议');
  await session.evaluate("[...document.querySelectorAll('button')].find(node => /应用 1 个标签/.test(node.textContent))?.click()");
  try {
    await waitFor(async () => session.evaluate("[...document.querySelectorAll('button')].some(node => node.textContent === '确认应用')"), '标签确认对话框');
  } catch (error) {
    const dialog = await session.evaluate("({ dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => node.textContent), buttons: [...document.querySelectorAll('button')].filter(node => /应用|确认/.test(node.textContent)).map(node => ({ text: node.textContent, disabled: node.disabled, className: node.className })), alerts: window.__noteAnalysisTestAlerts, panels: document.querySelectorAll('.knowledge-panel').length, panel: document.querySelector('.knowledge-panel')?.innerText })");
    throw new Error(`${error.message}\n${JSON.stringify(dialog)}`);
  }
  await session.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent === '确认应用')?.click()");
  await waitFor(async () => (await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(firstPath)})`)).startsWith('---'), '确认标签写入');
  assert.equal((await session.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(firstPath)})`)).isStale, undefined, '只修改标签不得使概览过期');
  assert.equal((await latest(firstPath)).isStale, undefined);
  await waitFor(async () => (await session.evaluate("document.querySelectorAll('.note-tag-suggestion').length")) === 0, '已应用建议消失');
  console.log('NB-4 Electron: UI generation, full-text requests, real progress, ordered source/summary list and tag application passed.');

  modes.set('失败恢复验收', 'fail');
  const failurePath = await createNote('失败恢复验收', raw);
  await openNote('失败恢复验收');
  await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(failurePath)})`);
  let partial;
  await waitFor(async () => { partial = await latest(failurePath); return partial?.state === 'partial'; }, '失败批次保留');
  assert.equal(partial.completedBatches, 2);
  assert.ok(!calls.some(call => call.title === '失败恢复验收' && call.index > 3));
  assert.equal(await session.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(failurePath)})`), null);
  await session.close();
  session = await launch();
  await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
  await openNote('失败恢复验收');
  await waitFor(async () => session.evaluate("[...document.querySelectorAll('button')].some(node => node.textContent?.includes('恢复分析'))"), '重开后的恢复入口');
  modes.delete('失败恢复验收');
  await session.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent?.includes('恢复分析'))?.click()");
  await waitFor(async () => (await latest(failurePath))?.state === 'completed', '重启后补跑完成');
  assert.equal(calls.filter(call => call.title === '失败恢复验收' && call.index === 1).length, 2, '已成功第一批包括一次长度重试，不得重新生成');
  assert.equal(calls.filter(call => call.title === '失败恢复验收' && call.index === 3).length, 1);
  assert.equal((await session.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(firstPath)})`)).summary, firstAnalysis.summary, '冷启动后完整概览保留');
  console.log('NB-4/5 Electron: partial-task discovery by path, cold restart and UI recovery passed.');

  modes.set('取消恢复验收', 'slow');
  const cancelPath = await createNote('取消恢复验收', raw);
  await openNote('取消恢复验收');
  await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(cancelPath)})`);
  await waitFor(async () => (await latest(cancelPath))?.completedBatches === 3, '前三批保存');
  await waitFor(async () => session.evaluate("Boolean(document.querySelector('.note-analysis-progress button'))"), '取消入口');
  await session.evaluate("document.querySelector('.note-analysis-progress button')?.click()");
  await waitFor(async () => (await latest(cancelPath))?.state === 'cancelled', '取消状态');
  assert.equal((await latest(cancelPath)).completedBatches, 3);
  modes.delete('取消恢复验收');
  await waitFor(async () => session.evaluate("[...document.querySelectorAll('button')].some(node => node.textContent?.includes('恢复分析'))"), '取消后的恢复入口');
  await session.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent?.includes('恢复分析'))?.click()");
  await waitFor(async () => (await latest(cancelPath))?.state === 'completed', '取消后恢复完成');
  assert.equal(calls.filter(call => call.title === '取消恢复验收' && call.index === 3).length, 1);

  modes.set('结构摘要验收', 'structured');
  const structuredPath = await createNote('结构摘要验收', '---\ntitle: 结构摘要验收\n---\n\n# 第一章\n\n第一段财务凭证已登记。\n\n第二段交付结论。\n\n## 复核\n\n尾部复核依据。');
  await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(structuredPath)})`);
  let structured;
  await waitFor(async () => { structured = await latest(structuredPath); return structured?.state === 'completed'; }, '章节摘要超长例外');
  assert.ok(structured.batches.every(batch => batch.summaryCharacterCount > 4_000 && batch.lengthHandling === 'structured-over-limit-accepted'));
  await openNote('结构摘要验收');
  await waitFor(async () => (await session.evaluate("document.querySelector('.note-analysis-progress')?.innerText ?? ''")).includes(`${structured.totalBatches}/${structured.totalBatches}`), '切换笔记的对应进度');
  await session.evaluate("[...document.querySelectorAll('.note-overview-toggle')].find(node => node.textContent?.includes('模型请求'))?.click()");
  await waitFor(async () => (await session.evaluate("document.querySelectorAll('.note-analysis-batch').length")) === structured.totalBatches, '章节批次展示');
  assert.equal(structured.processingMode, 'full-document');
  assert.equal(structured.totalBatches, 1);
  assert.equal(structured.batches[0].sections.length, 2);
  assert.ok((await session.evaluate("document.querySelector('.note-analysis-batches')?.innerText ?? ''")).includes('全文来源与摘要'));
  assert.equal((await latest(firstPath)).runId, firstRun.runId, '切换笔记不能更改其他任务');
  console.log('NB-4/5 Electron: cancellation, successful-batch reuse, structured over-limit output and note switching passed.');

  modes.set('多标题清洗验收', 'single');
  const repeated = '应收账款凭证与设备验收单已核对。合同金额120000元，税率13%，审批完成后支付，保留金7%，整改期限32个工作日。'.repeat(2);
  const cleanedText = '---\r\ntitle: 多标题清洗验收\r\n---\r\n\r\n# 第一章\r\n\r\n' + repeated + '\t\r\n\r\n<!-- invisible-test-marker -->\r\n\r\n' + repeated + '\r\n\r\n' + Array.from({ length: 20 }, (_, index) => `## 章节${index + 1}\r\n\r\n采购批次HY-${index + 1}：${'财务核对与交付验收。'.repeat(30)}`).join('\r\n\r\n');
  const cleanedPath = await createNote('多标题清洗验收', cleanedText);
  await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(cleanedPath)})`);
  let cleanedRun;
  await waitFor(async () => { cleanedRun = await latest(cleanedPath); return cleanedRun?.state === 'completed'; }, '多标题全文清洗');
  assert.equal(cleanedRun.totalBatches, 1);
  assert.equal(cleanedRun.processingMode, 'full-document');
  assert.equal(cleanedRun.preparationStats.duplicateBlocks, 1);
  assert.equal(cleanedRun.batches[0].sections.length, 21);
  const cleanedCalls = calls.filter(call => call.title === '多标题清洗验收');
  assert.equal(cleanedCalls.length, 1);
  assert.equal(cleanedCalls[0].prompt.split(repeated).length - 1, 1);
  assert.ok(!cleanedCalls[0].prompt.includes('invisible-test-marker') && !cleanedCalls[0].prompt.includes('\r'));
  assert.equal(await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(cleanedPath)})`), cleanedText);
  await openNote('多标题清洗验收');
  await waitFor(async () => session.evaluate("Boolean(document.querySelector('.note-analysis-progress')?.innerText.includes('全文分析'))"), '全文模式界面');
  await session.evaluate("[...document.querySelectorAll('.note-overview-toggle')].find(node => node.textContent?.includes('模型请求'))?.click()");
  await waitFor(async () => session.evaluate("document.querySelectorAll('.note-analysis-batch').length === 1 && document.querySelector('.note-analysis-batches')?.innerText.includes('合并 1 个重复块')"), '清洗统计展示');
  console.log(`NB-6 Electron: ${cleanedText.length} characters, 21 sections, one clean model request, duplicate provenance and full-document UI passed.`);
  const sourceFixture = 'E:/Notes-Project/GraphRAG学习-20260819-171545/GRAPHRAG存储.md';
  if (fs.existsSync(sourceFixture)) {
    const original = fs.readFileSync(sourceFixture, 'utf8');
    const copyPath = await createNote('GraphRAG全文规划验收副本', original);
    const copyMeta = await session.evaluate(`window.electronAPI.getNoteMeta(${JSON.stringify(copyPath)})`);
    modes.set(copyMeta.title, 'single');
    const previousCalls = calls.length;
    const copyRun = await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(copyPath)})`);
    const copyPlan = await latest(copyPath);
    assert.equal(copyPlan.runId, copyRun.runId);
    assert.equal(copyPlan.processingMode, 'full-document');
    assert.equal(copyPlan.totalBatches, 1);
    let copyResult;
    await waitFor(async () => { copyResult = await latest(copyPath); return copyResult?.state === 'completed'; }, '实际GraphRAG笔记全文规划');
    assert.equal(calls.length - previousCalls, 1);
    assert.equal(copyResult.batches[0].overlapCharacterCount, 0);
    assert.ok(copyResult.batches[0].sections.length >= 30);
    assert.equal(fs.readFileSync(sourceFixture, 'utf8'), original);
    assert.equal(await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(copyPath)})`), original);
    console.log(`NB-6 GraphRAG fixture: ${original.length} UTF16 characters, ${copyResult.batches[0].sections.length} source sections, ${copyResult.batches[0].inputCharacterCount} cleaned input characters, one full-document mock request, original unchanged.`);
  }
  }
  if (process.argv.includes('--real-model') || process.argv.includes('--real-model-only')) {
    await session.close();
    session = undefined;
    const configured = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Electron', 'config.json'), 'utf8'));
    assert.equal(configured.modelHub?.remoteConsent, true, '真实模型验收使用已确认内容发送的配置');
    const isolated = { libraryPath: workspace, appPreferences: { theme: 'light', defaultEditorMode: 'source' } };
    for (const key of ['modelHub', 'modelProviders', 'modelProviderSecrets', 'aiProvider', 'aiProviderSecret', 'aiModelSettings', 'aiProfileSecrets']) if (configured[key] !== undefined) isolated[key] = configured[key];
    // 仅复制既有加密配置到隔离目录；不打印或解密后落盘，finally删除该副本。
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(isolated));
    // Windows safeStorage使用本profile的OSCrypt密钥，仍由同一Windows用户解密。
    const localState = path.join(process.env.APPDATA, 'Electron', 'Local State');
    if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(userData, 'Local State'));
    session = await launch();
    await session.evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
    const paragraph = '财务共享中心按合同台账复核设备验收、发票登记和银行回单。发票抬头、税号及开票金额必须与合同一致，发现差异先登记待核实事项，不直接覆盖原凭证。项目负责人逐项确认交付清单，财务人员在收到验收证明后登记应付账款，复核人员保留审批记录。';
    const realText = Array.from({ length: 90 }, (_, index) => `第${index + 1}项核对记录：沈阳恒岳机电有限公司2026年9月设备采购项目，交付批次HY-${String(index + 1).padStart(3, '0')}。${paragraph.repeat(3)}\n\n`).join('') + '最终合同结论：供应商完成整改后才能支付保留金，保留金为合同总价的7%；整改期限为32个工作日；逾期补偿上限为合同总价的9%。复核时必须保留这三个约束，不得沿用其他合同的比例和期限。';
    assert.ok(realText.length > 24_000);
    const realPath = await createNote('真实模型长笔记验收', realText);
    const started = await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(realPath)})`);
    let actual;
    await waitFor(async () => {
      actual = await latest(realPath);
      if (['partial', 'failed', 'stale', 'cancelled'].includes(actual?.state)) throw new Error(`真实模型未完成：${actual.error?.message ?? actual.state}`);
      return actual?.state === 'completed';
    }, '真实模型长笔记分析', 180_000);
    assert.equal(actual.runId, started.runId);
    assert.ok(actual.totalBatches >= 3);
    assert.equal(actual.completedBatches, actual.totalBatches);
    assert.ok(actual.batches.every(batch => batch.status === 'succeeded' && batch.summary && batch.inputCharacterCount <= 12_000));
    const tail = actual.batches.at(-1);
    assert.match(`${tail.summary}\n${tail.keyPoints.join('\n')}`, /32|7\s*%|9\s*%/u, '末尾合同约束必须被真实模型分析到');
    assert.equal(await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(realPath)})`), realText);
    const result = await session.evaluate(`window.electronAPI.getNoteAnalysis(${JSON.stringify(realPath)})`);
    assert.equal(result.batches.length, actual.totalBatches);
    await openNote('真实模型长笔记验收');
    await waitFor(async () => (await session.evaluate("document.querySelector('.note-analysis-progress')?.innerText ?? ''")).includes(`${actual.totalBatches}/${actual.totalBatches}`), '真实模型结果展示');
    console.log(`NB-5 real model: ${actual.model}, ${realText.length} characters, ${actual.totalBatches}/${actual.totalBatches} saved batches, tail contract evidence and light-theme UI passed.`);

    // 原始用户笔记只读，验收生成仅写入隔离资料库中的副本。
    const sourcePath = 'E:/Notes-Project/GraphRAG学习-20260819-171545/GRAPHRAG存储.md';
    if (fs.existsSync(sourcePath)) {
      const original = fs.readFileSync(sourcePath, 'utf8');
      const copyPath = await createNote('GraphRAG全文验收副本', original);
      const copyStarted = await session.evaluate(`window.electronAPI.startNoteAnalysis(${JSON.stringify(copyPath)})`);
      const copyPlan = await latest(copyPath);
      assert.equal(copyPlan.runId, copyStarted.runId);
      assert.equal(copyPlan.processingMode, 'full-document');
      assert.equal(copyPlan.totalBatches, 1);
      let copyResult;
      await waitFor(async () => {
        copyResult = await latest(copyPath);
        if (['partial', 'failed', 'stale', 'cancelled'].includes(copyResult?.state)) throw new Error(`GraphRAG全文验收失败：${copyResult.error?.message ?? copyResult.state}`);
        return copyResult?.state === 'completed';
      }, '真实GraphRAG笔记全文生成', 180_000);
      assert.equal(copyResult.batches[0].overlapCharacterCount, 0);
      assert.ok(copyResult.batches[0].sections.length >= 30);
      assert.match(copyResult.batches[0].summary, /GraphRAG|图谱|索引/iu);
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
      assert.equal(await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(copyPath)})`), original);
      console.log(`NB-6 real GraphRAG: ${original.length} UTF16 characters, ${copyResult.batches[0].sections.length} source sections, full-document mode, ${copyResult.batches[0].generationAttempts} model requests, source unchanged.`);
    }
  }
} catch (error) {
  console.error('Note analysis acceptance failed:', error);
  throw error;
} finally {
  await session?.close();
  await new Promise(resolve => server.close(resolve));
  // 加密模型配置副本单独清理，避免Windows短暂占用其他缓存影响凭据副本清理。
  for (const name of ['config.json', 'Local State']) {
    const copiedConfig = path.join(userData, name);
    if (fs.existsSync(copiedConfig)) fs.unlinkSync(copiedConfig);
  }
  const resolved = path.resolve(temporaryRoot);
  assert.ok(resolved.startsWith(path.resolve(staging) + path.sep));
  assert.ok(path.basename(resolved).startsWith('note-batches-electron-'));
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
  } catch (error) {
    if (!['EPERM', 'EBUSY'].includes(error.code)) throw error;
    // 保留真正的验收异常；Windows缓存占用单独报告，不能覆盖前面的检查结果。
    console.warn(`Windows temporary cleanup incomplete (${error.code}): ${resolved}. Model config copies removed.`);
  }
}

async function createNote(name, markdown) {
  const notePath = await session.evaluate(`window.electronAPI.createFile(${JSON.stringify(name)}, null)`);
  const saved = await session.evaluate(`(async () => {
    const snapshot = await window.electronAPI.openNoteEditSession(${JSON.stringify(notePath)});
    const result = await window.electronAPI.saveNote({ editSessionId: snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: 1, expectedDiskHash: snapshot.version.diskHash, content: ${JSON.stringify(markdown)} });
    await window.electronAPI.closeNoteEditSession(snapshot.editSessionId);
    return result;
  })()`);
  assert.ok(saved.status === 'committed' || saved.status === 'unchanged');
  await waitFor(async () => (await session.evaluate(`window.electronAPI.readFile(${JSON.stringify(notePath)})`)) === markdown, '已提交的测试笔记');
  await waitFor(async () => (await session.evaluate(`window.electronAPI.getNoteMeta(${JSON.stringify(notePath)})`))?.contentMarkdown.length > markdown.length / 2, '提交后的索引投影');
  return notePath;
}

async function openNote(name) {
  await waitFor(async () => session.evaluate(`[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent?.includes(${JSON.stringify(name)}))`), `笔记树:${name}`);
  await session.evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent?.includes(${JSON.stringify(name)}))?.click()`);
  await waitFor(async () => session.evaluate(`document.querySelector('.knowledge-note-title')?.textContent?.includes(${JSON.stringify(name)})`), `选择笔记:${name}`);
  await waitFor(async () => session.evaluate("Boolean(document.querySelector('.note-info-meta')) && !/\\b0 字/u.test(document.querySelector('.note-info-meta').innerText)"), '笔记内容加载完成');
}

async function latest(notePath) { return session.evaluate(`window.electronAPI.getLatestNoteAnalysisRun(${JSON.stringify(notePath)})`); }

async function launch() {
  const portServer = createTcpServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [mainEntry, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  child.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
  const close = async () => { await command('taskkill', ['/PID', String(child.pid), '/T', '/F'], true); await delay(100); };
  try {
    let page;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}\n${diagnostics}`);
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); return Boolean(page?.webSocketDebuggerUrl); } catch { return false; }
    }, 'Electron渲染进程');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return; pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); });
    const send = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await waitFor(async () => evaluate("typeof window.electronAPI?.startNoteAnalysis === 'function' && Boolean(document.querySelector('.app-nav-item[aria-label=\"笔记\"]'))"), '新preload与React界面');
    await evaluate("window.__noteAnalysisTestAlerts = []; window.alert = message => window.__noteAnalysisTestAlerts.push(String(message))");
    await evaluate("document.querySelector('.app-nav-item[aria-label=\"笔记\"]')?.click()");
    await waitFor(async () => evaluate("[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent?.includes('初始笔记'))"), '启动索引与笔记树就绪');
    await installFixtureNoteSave({ evaluate });
    return { evaluate, close: async () => { socket.close(); await close(); } };
  } catch (error) { await close(); throw new Error(`${error.message}\n${diagnostics}`); }
}

async function command(executable, args, ignoreExit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 || ignoreExit ? resolve() : reject(new Error(`${executable} exited ${code}:\n${output}`)));
  });
}

async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
