import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';
import { buildNoteTestPackage } from './build-note-test-package.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'assistant-skills-'));
const library = path.join(temporary, 'library');
const userData = path.join(temporary, 'user-data');
const workspace = path.join(temporary, 'workspace');
const mainEntry = path.join(temporary, 'dist-electron', 'main.js');
const screenshots = path.resolve('output', 'assistant-skills-verification');
const captureScreenshots = process.argv.includes('--screenshots');
const providerRequests = [];
const model = 'skills-fixture';
let session;

// 只替换模型传输；菜单、IPC、设置、提示词装配和打包资源使用真实代码。
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/tags' || request.url === '/api/ps') {
    response.end(JSON.stringify({ models: [{ name: model, model, context_length: 32768 }] }));
  } else if (request.url === '/api/show') {
    response.end(JSON.stringify({ model_info: { 'test.context_length': 32768 } }));
  } else if (request.url === '/api/generate' || request.url === '/api/chat') {
    providerRequests.push(body);
    const answer = '技能验收完成。';
    const payload = { model, response: answer, message: { role: 'assistant', content: answer }, done: true, prompt_eval_count: 100, eval_count: 8 };
    if (body.stream) response.setHeader('Content-Type', 'application/x-ndjson');
    response.end(JSON.stringify(payload) + '\n');
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Unknown fixture endpoint' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  for (const directory of [library, userData, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
  if (captureScreenshots) await fs.mkdir(screenshots, { recursive: true });
  await fs.writeFile(path.join(library, '技能验收.md'), '# 技能验收\n\n本地技能集成验证资料。\n');
  const provider = { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model };
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath: library, activeLibraryPath: library,
    libraries: [{ path: library, alias: '技能验收库', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }],
    workspacePath: workspace,
    aiProviderConfig: provider,
    aiModelSettings: { schemaVersion: 1, defaultProfileId: 'model_skills_fixture', profiles: [{ id: 'model_skills_fixture', label: '技能验收模型', config: provider }] },
    aiExtensionsSettings: { schemaVersion: 1, skills: ['knowledge', 'learning', 'organize'].map((name) => ({ id: `skill_builtin_${name}`, enabled: true })) },
    appPreferences: { theme: 'dark', assistantContextRuntimeMode: 'enforce', assistantMemoryProjectionMode: 'canonical' },
  }));
  await Promise.all([
    ...[
      ['electron/main.ts', 'main.js', ['electron', 'better-sqlite3']],
      ['electron/preload.ts', 'preload.js', ['electron']],
      ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js', []],
      ['electron/externalWebPreload.ts', 'externalWebPreload.js', ['electron']],
      ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js', []],
    ].map(([entry, filename, external]) => build({ entryPoints: [entry], bundle: true, platform: 'node', external, outfile: path.join(path.dirname(mainEntry), filename), ...(captureScreenshots && filename === 'main.js' ? { banner: { js: "require('electron').app.disableHardwareAcceleration();" } } : {}), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged ? await buildNoteTestPackage(temporary) : undefined;
  if (packaged) {
    const resources = path.join(path.dirname(executablePath), 'resources', 'builtin-skills');
    assert.equal((await fs.readdir(resources)).length, 5);
    await fs.access(path.join(resources, 'generate-study-doc', 'templates', '学习文档模板.md'));
    await fs.access(path.join(resources, 'generate-experiment-report', 'templates', '实验报告模板.md'));
  }
  session = await launchNoteTest({ mainEntry, userData, executablePath });
  await session.send('Page.enable');
  await session.send('Page.bringToFront');
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await session.evaluate(`window.__skillElement = (selector) => [...document.querySelectorAll(selector)].find((node) => { const bounds = node.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; })`);
  let options = await session.evaluate('window.electronAPI.getAssistantAiOptions()');
  assert.equal(options.skills.length, 5);
  assert.ok(options.skills.every((skill) => skill.system));
  assert.deepEqual((await session.evaluate('window.electronAPI.getAiExtensionsSettings()')).skills, []);
  await fs.access(path.join(workspace, 'AI-Skill', 'generate-experiment-report', 'templates', '实验报告模板.md'));
  for (const [name, marker] of [['验收技能一', 'ACTUAL_SELECTED_SKILL_A'], ['验收技能二', 'UNSELECTED_SKILL_B']]) {
    const result = await session.evaluate(`window.electronAPI.createAiSkillFromForm(${JSON.stringify({ name, description: `使用${name}的规则回答。`, instruction: `必须遵守 ${marker}，输出简洁结论。` })})`);
    assert.equal(result.ok, true, result.error);
  }
  options = await session.evaluate('window.electronAPI.getAssistantAiOptions()');
  const selected = options.skills.find((skill) => skill.name === '验收技能一');
  assert.match(selected.id, /^[A-Za-z][A-Za-z0-9_-]{7,96}$/, '中文技能目录必须产生可提交的稳定标识');

  await session.evaluate(`document.querySelector('.app-nav-item[aria-label="设置"]').click()`);
  await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[role=tab]')].find((node) => node.textContent.includes('AI 助手技能')))`), 'settings tabs');
  await session.evaluate(`[...document.querySelectorAll('[role=tab]')].find((node) => node.textContent.includes('AI 助手技能')).click()`);
  await waitFor(() => session.evaluate(`document.querySelectorAll('.settings-skill-library-table tbody tr').length === 5`), 'first skill page');
  assert.doesNotMatch(await session.evaluate(`document.querySelector('.settings-skill-library').innerText`), /手动选择|按需调用|调用方式/);
  await session.evaluate(`[...document.querySelectorAll('.settings-skill-library .mantine-Pagination-control')].find((node) => node.textContent === '2').click()`);
  await waitFor(() => session.evaluate(`document.querySelectorAll('.settings-skill-library-table tbody tr').length === 2`), 'second skill page');
  await session.evaluate(`[...document.querySelectorAll('.settings-skill-library .mantine-Pagination-control')].find((node) => node.textContent === '1').click()`);
  for (const width of [1280, 900, 680]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await session.evaluate(`document.querySelector('.settings-skill-library').scrollIntoView({ block: 'start' })`);
    const layout = await session.evaluate(`(() => {
      const table = document.querySelector('.settings-skill-library-table');
      const bounds = table.getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
        buttons: [...table.querySelectorAll('button')].map((button) => { const r = button.getBoundingClientRect(); return { text: button.textContent, left: r.left, right: r.right, width: r.width }; }),
        left: bounds.left, right: bounds.right };
    })()`);
    assert.ok(layout.scrollWidth <= layout.width + 1, `窗口 ${width}px 不得横向溢出`);
    for (const button of layout.buttons) assert.ok(button.width > 0 && button.left >= layout.left - 1 && button.right <= layout.right + 1 && button.right <= width, `${width}px 下操作按钮不能被裁切: ${JSON.stringify(button)}`);
    if (captureScreenshots) {
      const screenshot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(path.join(screenshots, `skills-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
  }
  await session.send('Emulation.clearDeviceMetricsOverride');
  await session.evaluate(`document.querySelector('.app-nav-item[aria-label="助手"]').click()`);
  await waitFor(() => session.evaluate(`Boolean(window.__skillElement('.assistant-composer-plus:not(:disabled)'))`), 'assistant composer');
  await session.evaluate(`window.__skillElement('.assistant-composer-plus').click()`);
  await waitFor(() => session.evaluate(`document.querySelector('.assistant-composer-skill-list')?.getAttribute('aria-busy') === 'false'`), 'enabled skill refresh');
  assert.equal(await session.evaluate(`document.querySelectorAll('.assistant-composer-skill-list [role=menuitem]').length`), 5);
  await session.evaluate(`[...document.querySelectorAll('.assistant-composer-skill-pagination .mantine-Pagination-control')].find((node) => node.textContent === '2').click()`);
  await waitFor(() => session.evaluate(`document.querySelectorAll('.assistant-composer-skill-list [role=menuitem]').length === 2`), 'assistant skill page two');
  // 目录的排序受 Windows 区域设置影响；选中项可在任一页。
  if (!(await session.evaluate(`document.querySelector('.assistant-composer-skill-list').textContent.includes('验收技能一')`))) {
    await session.evaluate(`[...document.querySelectorAll('.assistant-composer-skill-pagination .mantine-Pagination-control')].find((node) => node.textContent === '1').click()`);
    await waitFor(() => session.evaluate(`document.querySelector('.assistant-composer-skill-list').textContent.includes('验收技能一')`), 'selected skill page');
  }
  await session.evaluate(`[...document.querySelectorAll('.assistant-composer-skill-list [role=menuitem]')].find((node) => node.textContent.includes('验收技能一')).click()`);
  await session.evaluate(`window.__skillElement('.assistant-composer-plus').click(); window.__skillElement('textarea[aria-label="向 AI 助手输入问题"]').focus()`);
  await session.send('Input.insertText', { text: '请按所选技能回答，说明结果。' });
  await session.evaluate(`window.__skillElement('button[aria-label="发送"]').click()`);
  await waitFor(() => providerRequests.length > 0, 'model received selected skill');
  await waitFor(() => session.evaluate(`!document.querySelector('button[aria-label="停止生成"]') && document.querySelector('.assistant-message-list').textContent.includes('技能验收完成')`), 'assistant finished');
  const outbound = JSON.stringify(providerRequests);
  assert.match(outbound, /ACTUAL_SELECTED_SKILL_A/);
  assert.doesNotMatch(outbound, /UNSELECTED_SKILL_B/);
  assert.doesNotMatch(outbound, /实验报告生成|学习文档生成|builtin-knowledge/);

  await session.evaluate(`window.electronAPI.setAiSkillEnabled('验收技能一', false)`);
  await session.evaluate(`window.__skillElement('.assistant-composer-plus').click()`);
  await waitFor(() => session.evaluate(`document.querySelector('.assistant-composer-skill-list')?.getAttribute('aria-busy') === 'false'`), 'refreshed disabled state');
  for (const page of ['1', '2']) {
    await session.evaluate(`[...document.querySelectorAll('.assistant-composer-skill-pagination .mantine-Pagination-control')].find((node) => node.textContent === '${page}').click()`);
    await waitFor(() => session.evaluate(`document.querySelector('.assistant-composer-skill-pagination .mantine-Pagination-control[data-active]')?.textContent === '${page}'`), 'disabled skill page');
    assert.doesNotMatch(await session.evaluate(`document.querySelector('.assistant-composer-skill-list').innerText`), /验收技能一/);
  }
  await session.evaluate(`window.__skillEvents = []; window.electronAPI.onAssistantTurnEvent((event) => window.__skillEvents.push(event))`);
  const requestCount = providerRequests.length;
  await session.evaluate(`window.electronAPI.startAssistantTurn(${JSON.stringify({ requestId: 'assistant_stale_skill', scope: 'chat', intent: 'ask', userText: '检查失效技能。', conversation: [], skillIds: [selected.id] })})`);
  await waitFor(() => session.evaluate(`window.__skillEvents.some((event) => event.requestId === 'assistant_stale_skill' && event.type === 'error')`), 'stale selection rejected');
  assert.equal(providerRequests.length, requestCount, '停用技能必须在调用模型前被拒绝');
  await session.dispose(); session = undefined;
  session = await launchNoteTest({ mainEntry, userData, executablePath });
  assert.ok(!(await session.evaluate('window.electronAPI.getAssistantAiOptions()')).skills.some((skill) => skill.id === selected.id), '启停状态重启后应保留');
  console.log(`Assistant skills ${packaged ? 'packaged' : 'Electron'} verified: five bundled skills/templates, legacy migration, Chinese IDs, pagination, responsive actions (1280/900/680), enabled-state refresh, real IPC/model payload selection, stale rejection and restart persistence.`);
} catch (error) {
  console.error(session?.diagnostics());
  console.error(JSON.stringify(await session?.evaluate(`({ text: document.body.innerText.slice(-3000), visibility: document.visibilityState, menu: document.querySelector('.assistant-composer-add-menu')?.outerHTML, events: window.__skillEvents, plus: [...document.querySelectorAll('.assistant-composer-plus')].map((node) => ({ parent: node.closest('.assistant-panel')?.className, rect: node.getBoundingClientRect().toJSON(), disabled: node.disabled, expanded: node.getAttribute('aria-expanded') })) })`).catch(() => undefined), null, 2));
  throw error;
} finally {
  await session?.dispose();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
