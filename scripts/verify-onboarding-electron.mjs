import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'onboarding-'));
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron/main.js');
const output = path.resolve('output/verification/onboarding');
const checks = [], requests = [];
let session, catalogDelay = 0, catalogFailure = false, generationMode = 'success';
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, model: body.model, stream: body.stream });
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url.endsWith('/api/tags') || req.url.endsWith('/models')) {
    await delay(catalogDelay);
    if (catalogFailure) { res.statusCode = 404; return json({ error: 'Catalog unavailable' }); }
    return json({ models: [{ name: 'onboarding-model' }], data: [{ id: 'onboarding-model' }] });
  }
  if (req.url.endsWith('/api/ps')) return json({ models: [] });
  if (req.url.endsWith('/api/show')) return json({ model_info: { 'model.context_length': 32768 } });
  if (req.url.endsWith('/api/generate')) {
    if (generationMode === 'error') { res.statusCode = 401; return json({ error: 'Intentional test rejection' }); }
    const answer = '1. 记录会议目标与参与人。\n2. 按议题整理讨论结论。\n3. 列出负责人、截止日期与待办。';
    if (!body.stream) return json({ response: answer });
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({ response: answer.slice(0, 8), done: false }) + '\n');
    if (generationMode === 'slow') await delay(1500);
    if (!res.destroyed) res.end(JSON.stringify({ response: answer.slice(8), done: true, prompt_eval_count: 60, eval_count: 40 }) + '\n');
    return;
  }
  res.statusCode = 404; json({ error: 'Unknown fixture endpoint' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

try {
  for (const directory of [userData, path.dirname(mainEntry), output]) await fs.mkdir(directory, { recursive: true });
  await writeConfig({ workspacePath: path.join(temporary, 'workspace'), appPreferences: { theme: 'light', language: 'zh-CN' } });
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent', plugins: [{ name: 'isolated-window-control', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]main\.ts$/ }, async args => ({ loader: 'ts', contents: (await fs.readFile(args.path, 'utf8'))
        .replace('// Global Error Handler for startup', 'app.disableHardwareAcceleration();\n// Global Error Handler for startup')
        .replace("preload: path.join(__dirname, 'preload.js'),", "preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false,")
        + "\nipcMain.handle('onboarding-test:resize', (_event, size) => { mainWindow?.setBounds({ width: size.width, height: size.height }); mainWindow?.webContents.setZoomFactor(size.zoom || 1); });\nipcMain.handle('onboarding-test:capture', async () => (await mainWindow!.webContents.capturePage()).toPNG().toString('base64'));" }));
    } }] }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), logLevel: 'silent', plugins: entry === 'preload' ? [{ name: 'isolated-test-controls', setup(bundler) {
      bundler.onLoad({ filter: /electron[\\/]preload\.ts$/ }, async args => ({ loader: 'ts', contents: await fs.readFile(args.path, 'utf8') + "\ncontextBridge.exposeInMainWorld('onboardingTest', { resize: size => ipcRenderer.invoke('onboarding-test:resize', size), capture: () => ipcRenderer.invoke('onboarding-test:capture') });" }));
    } }] : [] })),
    process.argv.includes('--reuse-renderer') ? fs.cp(path.resolve('dist'), path.join(temporary, 'dist'), { recursive: true })
      : command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launch();
  await visible('[data-testid="first-run-guide"]');
  assert.equal((await state()).status, 'pending');
  assert.equal(await session.evaluate('document.querySelectorAll(".onboarding-menu-card").length'), 7);
  assert.equal(requests.length, 0, 'opening the guide does not call the provider');
  await click('[data-onboarding-anchor="menu-sources"]');
  assert.equal(await session.evaluate('document.querySelector(".onboarding-menu-detail strong").textContent'), '资料');
  await screenshot('01-menus-light.png');
  await resize(1024, 768, 1); await screenshot('02-menus-1024.png'); await assertLayout();
  await button('我了解了，配置 AI'); await visible('[data-testid="onboarding-ai-task"]');
  await visible('input[aria-label="Ollama 地址"]');
  assert.equal(await enabled('下一步，去提问'), false);
  await screenshot('03-ai-empty.png');
  await button('先跳过，查看提问方式'); await visible('[data-testid="onboarding-question-task"]');
  await button('填入示例问题');
  assert.ok((await draft()).includes('会议纪要'));
  assert.equal(await session.evaluate('document.querySelector("[aria-label=发送]").disabled'), true);
  assert.equal((await state()).progress.question, 'pending');
  await screenshot('04-question-preview.png');
  await button('稍后继续'); assert.equal((await state()).status, 'deferred');
  await session.dispose(); session = await launch(); await resize(1024, 768, 1);
  assert.equal((await state()).currentStep, 'question');
  await button('继续引导'); await button('返回配置 AI');
  await fill('input[aria-label="Ollama 地址"]', endpoint);
  await session.evaluate(`document.querySelector(${JSON.stringify('input[aria-label="生成模型"]')}).closest('.settings-field-control').querySelector('input[type=checkbox]').click()`);
  await fill('input[aria-label="生成模型"]', 'onboarding-model');
  catalogDelay = 800; await button('测试连接'); await delay(100);
  await fill('input[aria-label="生成模型"]', 'edited-model'); await delay(950); catalogDelay = 0;
  assert.equal((await state()).connection.state, 'missing', 'late test cannot validate unsaved draft');
  assert.equal(await enabled('下一步，去提问'), false);
  await fill('input[aria-label="生成模型"]', 'onboarding-model');
  await button('测试连接'); await waitFor(() => enabled('保存模型设置'), 'test completed');
  await button('保存模型设置'); await waitFor(async () => (await state()).connection.state === 'tested', 'tested config saved');
  await waitFor(() => enabled('下一步，去提问'), 'next enabled');
  await screenshot('05-ai-tested.png'); await assertLayout();
  await fill('input[aria-label="生成模型"]', 'edited-model');
  await waitFor(async () => (await state()).connection.state === 'saved-unverified', 'editing invalidates proof');
  await fill('input[aria-label="生成模型"]', 'onboarding-model');
  await button('测试连接'); await waitFor(() => enabled('保存模型设置'), 'retest completed'); await button('保存模型设置');
  await waitFor(() => enabled('下一步，去提问'), 'same config remains ready');
  await button('下一步，去提问'); await visible('[data-testid="onboarding-question-task"]');
  await button('新建练习对话'); await waitFor(async () => Boolean((await state()).practiceSessionId), 'practice bound');
  await fill('textarea[aria-label="向 AI 助手输入问题"]', '我的待发送草稿');
  await button('填入示例问题'); await visible('[role=dialog]'); await button('保留我的草稿');
  assert.equal(await draft(), '我的待发送草稿');
  await button('填入示例问题'); await button('替换为示例');
  generationMode = 'error'; await button('发送');
  await waitFor(() => session.evaluate('document.querySelector(".onboarding-task").textContent.includes("本轮未完成")'), 'generation error feedback');
  assert.equal((await state()).progress.question, 'pending');
  await screenshot('06-question-error.png');
  generationMode = 'slow'; await button('填入示例问题'); await button('发送'); await visible('[aria-label="停止生成"]'); await button('停止生成');
  assert.equal((await state()).progress.question, 'pending');
  await button('填入示例问题'); await button('发送'); await visible('[aria-label="停止生成"]');
  await button('稍后继续');
  await waitFor(async () => (await state()).progress.question === 'done', 'paused successful answer persisted');
  assert.equal((await state()).status, 'deferred');
  const practiceId = (await state()).practiceSessionId;
  const detail = await session.evaluate(`window.electronAPI.getQaMemorySession(${JSON.stringify(practiceId)})`);
  assert.ok(detail.turns.some(turn => turn.status === 'complete' && turn.assistantText?.trim()));
  await button('继续引导'); await waitFor(() => enabled('完成引导'), 'finish enabled');
  await screenshot('07-question-success.png'); await assertLayout();
  await button('完成引导'); await visible('[data-testid="onboarding-completion"]');
  assert.equal((await state()).status, 'completed');
  await screenshot('08-completed.png'); await button('继续提问');
  await fill('textarea[aria-label="向 AI 助手输入问题"]', '我想继续当前对话');
  await click('[data-onboarding-anchor="menu-settings"]'); await button('首次使用引导'); await button('重新查看引导');
  await button('我了解了，配置 AI'); await button('下一步，去提问'); await button('新建练习对话');
  await visible('[role=dialog]'); await button('保留当前对话');
  assert.equal(await draft(), '我想继续当前对话', 'keeping current conversation preserves its unsent draft');
  assert.equal((await state()).practiceSessionId, practiceId);
  const finalRevision = (await state()).revision;
  await session.dispose(); session = await launch();
  assert.equal(await session.evaluate('Boolean(document.querySelector(".onboarding-bar"))'), false);
  assert.equal((await state()).revision, finalRevision);
  await click('[data-onboarding-anchor="menu-settings"]'); await visible('.settings-page');
  await button('首次使用引导'); await button('重新查看引导');
  await visible('[data-testid="first-run-guide"]');
  assert.equal((await state()).status, 'completed');
  assert.equal((await state()).revision, finalRevision);
  await button('我了解了，配置 AI'); await button('下一步，去提问');
  assert.equal((await state()).practiceSessionId, practiceId, 'review does not create a session');
  await button('关闭引导');
  checks.push('fresh menus, stable anchors, no automatic calls; skip preview; pause/restart/resume; stale test invalidation; test/save proof; draft collision; error and cancel; paused successful persistence; finish, restart and review');

  // Existing models work without a catalog test or an extra practice-session click.
  await session.dispose(); session = null;
  const originalConfig = await readConfig();
  await writeConfig({ ...originalConfig, workspacePath: path.join(temporary, 'saved-model-workspace'), onboarding: { version: 1, status: 'pending' },
    aiModelSettings: { ...originalConfig.aiModelSettings, profiles: originalConfig.aiModelSettings.profiles.map(profile => ({ ...profile, label: '已有本地模型' })) } });
  const generationCount = requests.filter(request => request.url.endsWith('/api/generate')).length;
  session = await launch(); await visible('[data-testid="first-run-guide"]'); await button('我了解了，配置 AI');
  await waitFor(() => enabled('使用已有模型，直接提问'), 'saved model can continue without retest');
  assert.equal((await state()).connection.state, 'saved-unverified');
  await button('使用已有模型，直接提问'); await visible('[data-testid="onboarding-question-task"]');
  await fill('textarea[aria-label="向 AI 助手输入问题"]', '使用已有模型直接整理会议纪要。');
  assert.equal(await enabled('发送'), true);
  assert.equal(requests.filter(request => request.url.endsWith('/api/generate')).length, generationCount, 'entering with a saved model does not generate an answer');
  assert.equal((await state()).practiceSessionId, undefined, 'an empty practice session is created only on Send');
  await screenshot('12-existing-model-ready.png');
  await button('发送');
  await waitFor(async () => (await state()).progress.question === 'done', 'saved model direct-send result persisted');
  const directProof = await state();
  const directDetail = await session.evaluate(`window.electronAPI.getQaMemorySession(${JSON.stringify(directProof.practiceSessionId)})`);
  assert.equal(directDetail.turns[0].userText, '使用已有模型直接整理会议纪要。', 'session binding preserves the entered question');
  assert.equal((await state()).progress.ai, 'done'); await button('完成引导');
  await session.dispose(); session = null;
  const skipped = await readConfig();
  skipped.workspacePath = path.join(temporary, 'skipped-saved-model-workspace');
  skipped.onboarding = { ...skipped.onboarding, status: 'active', currentStep: 'question', progress: { menus: 'done', ai: 'skipped', question: 'pending' } };
  delete skipped.onboarding.practiceSessionId; delete skipped.onboarding.successfulRequestId; delete skipped.onboarding.completedAt;
  await writeConfig(skipped); session = await launch(); await visible('[data-testid="onboarding-question-task"]');
  assert.equal((await state()).connection.state, 'saved-unverified');
  assert.equal(await session.evaluate('document.querySelector(".onboarding-task").textContent.includes("还未配置 AI")'), false);
  await button('填入示例问题'); await waitFor(() => enabled('发送'), 'saved model sends even when setup was skipped before restart');
  const beforeDoubleSend = requests.filter(request => request.url.endsWith('/api/generate')).length;
  generationMode = 'slow';
  await session.evaluate('const send = document.querySelector("[aria-label=发送]"); send.click(); send.click();');
  await waitFor(async () => (await state()).progress.question === 'done', 'skipped saved model answer persisted');
  generationMode = 'success';
  assert.equal(requests.filter(request => request.url.endsWith('/api/generate')).length, beforeDoubleSend + 1, 'double-click creates one practice request');
  const skippedProof = await state();
  const skippedDetail = await session.evaluate(`window.electronAPI.getQaMemorySession(${JSON.stringify(skippedProof.practiceSessionId)})`);
  assert.equal(skippedDetail.turns.length, 1); assert.equal(skippedDetail.turns[0].status, 'complete');
  await screenshot('13-existing-model-skipped-success.png'); await button('完成引导');
  await session.dispose(); session = null; await writeConfig(originalConfig);
  checks.push('saved model directly enters Q&A without retesting; Send lazily binds an empty session and preserves the question; skipped setup survives restart with Send enabled; double-click submits one request; real QA persistence completes both steps');

  // Exercise a remote saved profile with an unavailable catalog through real IPC and form controls.
  const historyOnly = await readConfig(); delete historyOnly.onboarding;
  historyOnly.aiModelSettings = { defaultProfileId: 'model_legacy_default', profiles: [{ id: 'model_legacy_default', label: '空白默认连接', config: { kind: 'ollama', model: '', endpoint: 'http://127.0.0.1:11434' } }] };
  delete historyOnly.aiProfileSecrets; delete historyOnly.aiProvider; delete historyOnly.aiProviderSecret;
  await writeConfig(historyOnly); session = await launch();
  assert.equal((await state()).status, 'dismissed', 'QA history alone counts as prior use');
  await session.dispose(); session = null;
  const saved = await readConfig();
  saved.onboarding = { version: 1, status: 'pending' };
  saved.aiModelSettings = { defaultProfileId: 'model_remote_fixture', profiles: [{ id: 'model_remote_fixture', label: '目录不可用的网关', config: { kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint: endpoint + '/v1', model: 'onboarding-model', remoteContentConsent: true } }] };
  delete saved.aiProfileSecrets; saved.appPreferences = { ...saved.appPreferences, theme: 'dark', language: 'en-US' };
  await writeConfig(saved); session = await launch('Assistant');
  await visible('[data-testid="first-run-guide"]'); await resize(1200, 800, 1.25); await screenshot('09-menus-en-dark-125.png'); await assertLayout();
  await button('Got it, set up AI'); await visible('input[aria-label="API Key"]');
  await fill('input[aria-label="API Key"]', 'LOCAL_TEST_KEY'); catalogFailure = true;
  await button('Test connection'); await waitFor(() => enabled('Save model settings'), 'failed test settled'); await button('Save model settings');
  await waitFor(async () => (await state()).connection.state === 'failed', 'failed catalog saved');
  assert.equal(await enabled('Next, ask a question'), false);
  assert.equal(await enabled('Settings saved, try a question'), true);
  await screenshot('10-ai-en-dark-catalog-failure.png'); await assertLayout();
  await button('Settings saved, try a question'); assert.equal((await state()).progress.ai, 'pending');
  await button('Continue later');
  checks.push('English/dark at actual Electron zoom 125%; failed catalog saves and offers explicit question bypass without claiming tested');

  await session.dispose(); session = null;
  for (const legacyStatus of ['completed', 'skipped']) {
    const config = await readConfig(); config.onboarding = { version: 1, status: legacyStatus, sampleImported: true };
    await writeConfig(config); session = await launch('Assistant');
    await waitFor(async () => Boolean(await state()), 'migrated state');
    assert.equal((await state()).status, 'dismissed'); assert.equal((await state()).sampleImported, true);
    assert.equal(await session.evaluate('Boolean(document.querySelector(".onboarding-bar"))'), false);
    await session.dispose(); session = null;
  }
  const existing = await readConfig(); delete existing.onboarding;
  existing.workspacePath = path.join(temporary, 'empty-workspace');
  existing.aiModelSettings = historyOnly.aiModelSettings; delete existing.aiProfileSecrets; delete existing.aiProvider; delete existing.aiProviderSecret;
  existing.libraries = [{ path: path.join(temporary, 'missing-library'), alias: '已有库', addedAt: new Date().toISOString() }];
  await writeConfig(existing); session = await launch('Assistant'); assert.equal((await state()).status, 'dismissed');
  // Sample import remains explicit and preserves previously edited files.
  const sampleLibrary = await session.evaluate(`window.electronAPI.createLibrary('sample-library', ${JSON.stringify(temporary)})`);
  assert.ok(sampleLibrary.startsWith(temporary + path.sep));
  assert.equal((await session.evaluate('window.electronAPI.importOnboardingSample()')).length, 2);
  const samplePath = path.join(sampleLibrary, '欢迎使用 Trellora.md'); await fs.writeFile(samplePath, '# 我编辑后的示例');
  assert.equal((await session.evaluate('window.electronAPI.importOnboardingSample()')).length, 0);
  assert.equal(await fs.readFile(samplePath, 'utf8'), '# 我编辑后的示例');
  checks.push('legacy completed/skipped preserve sample flag and do not force guide; missing registered library counts as prior usage');
  if (process.argv.includes('--real')) {
    await session.dispose(); session = null;
    const sourcePath = process.env.TRELLORA_ONBOARDING_CONFIG_PATH || path.join(process.env.APPDATA, 'Electron/config.json');
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const profile = source.aiModelSettings?.profiles.find(item => item.id === source.aiModelSettings.defaultProfileId && item.config.model && source.aiProfileSecrets?.[item.id]);
    assert.ok(profile, 'a configured default remote model is required for real-model acceptance');
    await fs.copyFile(path.join(path.dirname(sourcePath), 'Local State'), path.join(userData, 'Local State'));
    await writeConfig({ workspacePath: path.join(temporary, 'real-workspace'), onboarding: { version: 1, status: 'pending' },
      aiModelSettings: { defaultProfileId: profile.id, profiles: [profile] }, aiProfileSecrets: { [profile.id]: source.aiProfileSecrets[profile.id] },
      appPreferences: { theme: 'light', language: 'zh-CN' } });
    session = await launch(); await visible('[data-testid="first-run-guide"]');
    await button('我了解了，配置 AI'); await button('使用已有模型，直接提问');
    assert.equal((await state()).connection.state, 'saved-unverified');
    assert.equal((await state()).practiceSessionId, undefined);
    await button('填入示例问题');
    const startedAt = Date.now(); await button('发送');
    await waitFor(async () => (await state()).progress.question === 'done', 'real model answer and normal persistence', 120000);
    const proof = await state();
    const detail = await session.evaluate(`window.electronAPI.getQaMemorySession(${JSON.stringify(proof.practiceSessionId)})`);
    const turn = detail.turns.find(turn => turn.status === 'complete' && turn.assistantText?.trim());
    assert.ok(turn); await screenshot('11-real-model-answer.png'); await button('完成引导');
    assert.equal((await state()).status, 'completed');
    await fs.writeFile(path.resolve('docs/verification/onboarding-real-model.json'), JSON.stringify({ verifiedAt: new Date().toISOString(),
      method: 'real Electron/main/preload/React, saved encrypted default model, direct sample-question send without retest/save or separate practice creation, isolated workspace',
      provider: profile.config.provider, model: profile.config.model, elapsedMs: Date.now() - startedAt,
      status: 'completed', answerCharacters: turn.assistantText.length, persistedTurnStatus: turn.status, selectedProfileMatches: proof.selectedProfileId === profile.id,
      originalUserDataModified: false, keysOrAnswersIncluded: false, screenshot: path.join(output, '11-real-model-answer.png') }, null, 2));
    checks.push('real saved remote model directly generated an answer without retest/save or separate practice creation; normal QA persistence completed the guide');
  }
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/onboarding-electron.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), method: 'real Electron/main/preload/React; local controlled provider; not remote model acceptance', checks, requests, screenshots: output, viewportAndZoom: ['1200x800 @100%', '1024x768 @100%', '1200x800 @125%'] }, null, 2));
  console.log(`Onboarding Electron: ${checks.length} groups passed`);
} catch (error) {
  if (session) { await screenshot('failure.png').catch(() => {}); console.error(await session.evaluate('document.body.innerText.slice(0, 1800)').catch(() => 'UI unavailable')); }
  throw error;
} finally {
  await session?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(temporary), staging); assert.ok(path.basename(temporary).startsWith('onboarding-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
async function readConfig() { return JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8')); }
async function writeConfig(value) { await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify(value)); }
function launch(navigationLabel = '助手') { return launchNoteTest({ mainEntry, userData, navigationLabel }); }
function state() { return session.evaluate('window.electronAPI.getOnboardingState()'); }
function draft() { return session.evaluate(`document.querySelector(${JSON.stringify('textarea[aria-label="向 AI 助手输入问题"]')}).value`); }
async function visible(selector) { await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.getClientRects().length))`), selector); }
async function click(selector) { await visible(selector); await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
function enabled(label) { return session.evaluate(`Boolean([...document.querySelectorAll('button')].findLast(n => n.getClientRects().length && (n.textContent.trim() === ${JSON.stringify(label)} || n.getAttribute('aria-label') === ${JSON.stringify(label)}) && !n.disabled))`); }
async function button(label) {
  await waitFor(() => enabled(label), label);
  await session.evaluate(`[...document.querySelectorAll('button')].findLast(n => n.getClientRects().length && (n.textContent.trim() === ${JSON.stringify(label)} || n.getAttribute('aria-label') === ${JSON.stringify(label)})).click()`);
}
async function fill(selector, text) {
  await visible(selector); await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await session.send('Input.insertText', { text });
}
async function screenshot(name) { await delay(300); const buffer = Buffer.from(await session.evaluate('window.onboardingTest.capture()'), 'base64'); assert.ok(buffer.length > 20000, `Blank or incomplete screenshot: ${name}`); await fs.writeFile(path.join(output, name), buffer); }
async function resize(width, height, zoom) { await session.evaluate(`window.onboardingTest.resize(${JSON.stringify({ width, height, zoom })})`); await delay(300); }
async function assertLayout() {
  const result = await session.evaluate(`(() => { const buttons = [...document.querySelectorAll('.onboarding-bar button, .onboarding-task button, .onboarding-menu-footer button')].filter(n => n.getClientRects().length); return { overflow: document.documentElement.scrollWidth > innerWidth, buttonsClipped: buttons.filter(n => { const r=n.getBoundingClientRect(); const p=n.closest('.onboarding-task,.onboarding-menus'); return r.left < 0 || r.right > innerWidth+1 || (!p && (r.top<0 || r.bottom>innerHeight+1)); }).length }; })()`);
  assert.equal(result.overflow, false); assert.equal(result.buttonsClipped, 0);
}
