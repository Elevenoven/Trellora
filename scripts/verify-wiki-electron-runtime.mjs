import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

const rootDir = process.cwd();
const r4AiOnly = process.argv.includes('--r4-ai-only');
const electronPath = path.join(rootDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const mainEntryPath = path.join(rootDir, 'dist-electron', 'main.js');
const rendererEntryPath = path.join(rootDir, 'dist', 'index.html');
const testRoot = path.join(rootDir, '.package-staging', r4AiOnly ? 'verify-wiki-agent-electron-r4' : 'verify-wiki-electron-runtime');
const workspaceDir = path.join(testRoot, 'workspace');
const libraryDir = path.join(testRoot, 'knowledge-base', 'Wiki-L4');
const documentsDir = path.join(libraryDir, 'documents');
const userDataDir = path.join(testRoot, 'user-data');
const screenshotsDir = path.join(testRoot, 'screenshots');

assert.equal(existsSync(electronPath), true, `Electron runtime does not exist: ${electronPath}`);
assert.equal(existsSync(mainEntryPath), true, 'dist-electron/main.js is missing. Run the Electron bundle step first.');
assert.equal(existsSync(rendererEntryPath), true, 'dist/index.html is missing. Run the Vite build first.');

rmSync(testRoot, { recursive: true, force: true });
for (const directory of [workspaceDir, documentsDir, userDataDir, screenshotsDir]) mkdirSync(directory, { recursive: true });
writeFileSync(path.join(workspaceDir, 'Runtime.md'), '# Runtime\n\nWiki L4 Electron verification workspace.', 'utf8');
writeFileSync(path.join(documentsDir, 'Wiki-L4.md'), createWikiFixture(), 'utf8');

const timestamp = '2026-09-01T00:00:00.000Z';
writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
  libraryPath: workspaceDir,
  materialsLibraries: [{
    path: libraryDir,
    alias: 'Wiki L4 验收库',
    icon: 'file',
    origin: 'created',
    addedAt: timestamp,
    lastOpenedAt: timestamp,
  }],
  activeMaterialsLibraryPath: libraryDir,
  appPreferences: { theme: 'light' },
}, null, 2), 'utf8');

const fakeAi = await startFakeAiServer();
process.once('exit', () => fakeAi.server.close());
const firstRun = await launchAndConnect(await reservePort());
if (r4AiOnly) console.log('R4 Electron: first cold-start connected');
let documentId;
let persistedSiblingLabels;
try {
  const documents = await firstRun.evaluate(`window.electronAPI.listMaterialsDocuments(${JSON.stringify(libraryDir)})`);
  assert.equal(documents.length, 1);
  documentId = documents[0].id;

  await firstRun.evaluate(`window.electronAPI.startMaterialsPipeline(${JSON.stringify(libraryDir)}, ${JSON.stringify(documentId)})`);
  let pipelineResult;
  await waitForCondition(async () => {
    const statuses = await firstRun.evaluate(`window.electronAPI.getMaterialsPipelineStatus(${JSON.stringify(libraryDir)})`);
    pipelineResult = statuses.find((status) => status.documentId === documentId);
    return pipelineResult?.stages?.tree?.status === 'SUCCEEDED'
      || ['FAILED', 'FAILED_RETRYABLE'].includes(pipelineResult?.state);
  }, 90000, 'Timed out waiting for the Wiki structure tree stage.');
  assert.equal(pipelineResult.stages?.tree?.status, 'SUCCEEDED', `Tree stage did not succeed: ${JSON.stringify(pipelineResult.error ?? pipelineResult)}`);
  if (r4AiOnly) console.log('R4 Electron: Markdown pipeline tree ready');
  if (r4AiOnly) await configureR4Model(firstRun, fakeAi.endpoint);
  await openWikiDocument(firstRun);
  if (r4AiOnly) console.log('R4 Electron: Wiki document opened');

  if (r4AiOnly) {
    await verifyWikiAssistantRound(firstRun, documentId);
    console.log('R4 Electron: evidence trail and citation navigation passed');
    await verifyWikiAssistantCancellation(firstRun, fakeAi);
    console.log('R4 Electron: cancellation passed');
  } else {
    const nodeCount = await firstRun.evaluate("document.querySelectorAll('.wiki-map-node:not(.wiki-map-node-placeholder)').length");
    assert.ok(nodeCount >= 12, `Expected a deep Wiki fixture, received ${nodeCount} visible nodes.`);
    await verifyCollapse(firstRun, nodeCount);

    const lightColors = await verifyViewportMatrix(firstRun, 'light');
    await setThemeAndReload(firstRun, 'dark');
    await openWikiDocument(firstRun);
    const darkColors = await verifyViewportMatrix(firstRun, 'dark');
    assert.notEqual(darkColors.workspaceBackground, lightColors.workspaceBackground, 'Light and dark Wiki surfaces must differ.');

    await firstRun.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedMotion = await firstRun.evaluate(`(() => {
      const node = document.querySelector('.wiki-map-node:not(.root)');
      node?.focus();
      const style = node ? getComputedStyle(node) : null;
      return {
        active: document.activeElement === node,
        focusVisible: Boolean(node?.matches(':focus-visible')),
        transitionDuration: style?.transitionDuration ?? '',
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    })()`);
    assert.equal(reducedMotion.active, true, 'Wiki nodes must be keyboard-focusable.');
    assert.equal(reducedMotion.focusVisible, true, 'Focused Wiki nodes must expose focus-visible state.');
    assert.equal(reducedMotion.reduced, true);
    assert.match(reducedMotion.transitionDuration, /0\.00001s|0s/);

    await enterReorderMode(firstRun);
    const touchBefore = await siblingSnapshot(firstRun);
    assert.ok(touchBefore.length >= 2, 'The runtime fixture must expose reorderable siblings.');
    await dragSiblingWithTouch(firstRun, touchBefore[0], touchBefore[1]);
    await waitForCondition(async () => {
      const current = await siblingSnapshot(firstRun);
      return current[0]?.label === touchBefore[1].label && current[1]?.label === touchBefore[0].label;
    }, 12000, 'Touch reorder did not move the sibling node.');
    await firstRun.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitForCondition(async () => !(await firstRun.evaluate("Boolean(document.querySelector('.wiki-map-canvas.reorder-mode'))")), 6000, 'Escape did not cancel reorder mode.');
    assert.deepEqual((await siblingSnapshot(firstRun)).slice(0, 2).map((entry) => entry.label), touchBefore.slice(0, 2).map((entry) => entry.label));

    await enterReorderMode(firstRun);
    const keyboardBefore = await siblingSnapshot(firstRun);
    await firstRun.evaluate(`(() => {
      const label = ${JSON.stringify(keyboardBefore[1].label)};
      const node = [...document.querySelectorAll('.wiki-map-node')].find((candidate) => candidate.getAttribute('aria-label') === label);
      node?.focus();
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    })()`);
    await waitForCondition(async () => {
      const current = await siblingSnapshot(firstRun);
      return current[0]?.label === keyboardBefore[1].label && current[1]?.label === keyboardBefore[0].label;
    }, 8000, 'Alt+ArrowUp did not reorder siblings.');
    persistedSiblingLabels = (await siblingSnapshot(firstRun)).slice(0, 2).map((entry) => entry.label);
    await firstRun.evaluate(`[...document.querySelectorAll('.wiki-toolbar button')].find((button) => button.textContent?.trim() === '完成')?.click()`);
    await waitForCondition(async () => (await firstRun.evaluate("document.querySelector('.wiki-feedback')?.textContent ?? ''")).includes('章节顺序已保存'), 10000, 'Wiki sibling order was not saved.');
    assert.equal(findSiblingOrderFiles(libraryDir).length, 1, 'The local sibling-order overlay was not created.');
  }
} finally {
  await firstRun.close();
}

const secondRun = await launchAndConnect(await reservePort());
if (r4AiOnly) console.log('R4 Electron: second cold-start connected');
try {
  if (r4AiOnly) {
    const options = await secondRun.evaluate('window.electronAPI.getAssistantAiOptions()');
    console.log(`R4 Electron: restored model profiles=${options?.profiles?.length ?? 0}, default=${options?.defaultProfileId ?? 'none'}`);
    assert.equal(options?.defaultProfileId, 'model_r4fixture01', 'Cold restart did not restore the R4 model profile.');
    assert.ok(options?.profiles?.some((profile) => profile.id === 'model_r4fixture01'), 'Cold restart restored no usable R4 model profile.');
  }
  await openWikiDocument(secondRun);
  if (r4AiOnly) {
    await verifyWikiAssistantRecovery(secondRun, documentId, fakeAi);
    console.log('R4 Electron: persisted conversation recovery passed');
  } else {
    assert.deepEqual(
      (await siblingSnapshot(secondRun)).slice(0, 2).map((entry) => entry.label),
      persistedSiblingLabels,
      'A fresh Electron process must restore the persisted sibling order.',
    );
    assert.equal(await secondRun.evaluate("document.documentElement.dataset.theme"), 'dark');
  }
} finally {
  await secondRun.close();
  await fakeAi.close();
}

console.log(r4AiOnly
  ? `Wiki R4 Electron AI verification passed (${documentId}, evidence trail, citation navigation, cancellation, cold-restart conversation recovery)`
  : `Wiki Electron runtime verification passed (${documentId}, light/dark, 1440x900 + 1920x1080, touch, keyboard, reduced motion, restart recovery)`);
if (r4AiOnly) rmSync(testRoot, { recursive: true, force: true });

function createWikiFixture() {
  return `# Wiki L4 章节导图运行时验收

## 第一章 接入与准备

### 1.1 环境检查

第一次恢复退避为 7 秒，第二次恢复退避为 31 秒。租约在 47 秒后失效。

#### 1.1.1 安装检查

##### 1.1.1.1 深层配置

### 1.2 数据准备

## 第二章 排序交互

### 2.1 键盘调整

### 2.2 触屏拖拽

## 第三章 这是一个用于验证超长中文章节标题在固定宽度节点内不会遮挡状态徽标与折叠操作的标题

### 3.1 折叠分支

#### 3.1.1 子章节 A

#### 3.1.2 子章节 B

## 第四章 主题与视口

### 4.1 浅色主题

### 4.2 深色主题
`;
}

async function startFakeAiServer() {
  const requests = [];
  const state = { cancelledRequests: 0 };
  const server = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt = stringifyMessages(body.messages);
      requests.push({ stream: body.stream === true, prompt, toolNames: (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean) });

      if (body.stream === true) {
        const answer = prompt.includes('那第二次呢') ? '第二次恢复退避为 31 秒 [0]。' : '第一次恢复退避为 7 秒 [0]。';
        const send = () => sendOpenAiSse(response, answer);
        if (prompt.includes('请执行取消测试')) {
          const timer = setTimeout(send, 5_000);
          response.once('close', () => {
            clearTimeout(timer);
            if (!response.writableEnded) state.cancelledRequests += 1;
          });
        } else {
          send();
        }
        return;
      }

      const content = /scope_intent|问题改写与范围识别器/u.test(prompt)
        ? JSON.stringify({
          rewrite: '第二次恢复退避是多少秒？',
          should_split: false,
          sub_questions: ['第二次恢复退避是多少秒？'],
          scope_intent: 'node-first',
          explicit_section_titles: [],
        })
        : JSON.stringify({ questions: ['第一次恢复退避是多少秒？', '第二次恢复退避是多少秒？', '租约多久失效？'] });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }));
    } catch (error) {
      if (response.destroyed) return;
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    requests,
    state,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function stringifyMessages(messages) {
  return (messages ?? []).map((message) => {
    if (typeof message?.content === 'string') return message.content;
    return JSON.stringify(message?.content ?? '');
  }).join('\n');
}

function sendOpenAiSse(response, answer) {
  if (response.destroyed) return;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const midpoint = Math.max(1, Math.floor(answer.length / 2));
  for (const text of [answer.slice(0, midpoint), answer.slice(midpoint)]) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function configureR4Model(connection, endpoint) {
  const settings = {
    defaultProfileId: 'model_r4fixture01',
    profiles: [{
      id: 'model_r4fixture01',
      label: 'R4 本地验收模型',
      config: {
        kind: 'openai-compatible',
        provider: 'custom',
        api: 'openai-completions',
        endpoint,
        apiKey: 'r4-fixture-key',
        model: 'r4-fixture-model',
        remoteContentConsent: true,
      },
    }],
  };
  await connection.evaluate(`window.electronAPI.saveAiModelSettings(${JSON.stringify(settings)})`);
  await connection.send('Page.reload', { ignoreCache: true });
  await waitForCondition(async () => {
    try {
      const options = await connection.evaluate('window.electronAPI.getAssistantAiOptions()');
      return options?.defaultProfileId === 'model_r4fixture01';
    } catch {
      return false;
    }
  }, 15000, 'R4 local AI profile did not become available after reload.');
}

async function verifyWikiAssistantRound(connection, documentId) {
  await openAssistantForNode(connection, '环境检查');
  await submitWikiQuestion(connection, '第一次恢复退避是多少秒？');
  await waitForCondition(async () => (await connection.evaluate(`document.querySelector('.wiki-ai-message.assistant')?.textContent ?? ''`)).includes('7 秒'), 20000, 'Wiki AI did not render the direct answer.');
  const evidenceTrail = await connection.evaluate(`(() => {
    const trail = document.querySelector('.wiki-ai-message.assistant .wiki-evidence-trail');
    return {
      text: trail?.textContent ?? '',
      completeness: trail?.getAttribute('data-completeness') ?? '',
      citations: [...document.querySelectorAll('.wiki-ai-message.assistant .wiki-ai-citation-ref')].map((node) => node.textContent),
    };
  })()`);
  assert.match(evidenceTrail.text, /仅当前章节回答/u);
  assert.match(evidenceTrail.text, /周期\s*0\/5/u);
  assert.equal(evidenceTrail.completeness, 'complete');
  assert.deepEqual(evidenceTrail.citations, ['[0]']);

  await connection.evaluate(`document.querySelector('.wiki-ai-citation-toggle')?.click()`);
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-ai-citation-open'))"), 5000, 'Wiki citation did not expand.');
  await connection.evaluate(`document.querySelector('.wiki-ai-citation-open')?.click()`);
  await waitForCondition(async () => await connection.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === '文档'`), 5000, 'Wiki citation did not navigate to its source chapter.');

  const memory = await connection.evaluate(`window.electronAPI.listWikiAiMemories(${JSON.stringify(libraryDir)}, ${JSON.stringify(documentId)})`);
  assert.equal(memory.ok, true);
  assert.ok(memory.memories.some((entry) => entry.conversation.some((message) => message.content.includes('第一次恢复退避'))), 'Completed Wiki answer was not persisted to AI memory.');
}

async function verifyWikiAssistantCancellation(connection, fakeAi) {
  await openAssistantForNode(connection, '环境检查');
  await submitWikiQuestion(connection, '请执行取消测试');
  await waitForCondition(async () => await connection.evaluate(`[...document.querySelectorAll('.wiki-assistant-composer button')].some((button) => button.textContent?.trim() === '停止')`), 8000, 'Wiki AI stop control did not appear.');
  await connection.evaluate(`[...document.querySelectorAll('.wiki-assistant-composer button')].find((button) => button.textContent?.trim() === '停止')?.click()`);
  await waitForCondition(async () => !(await connection.evaluate(`Boolean(document.querySelector('.wiki-streaming-caret'))`)), 8000, 'Wiki AI cancellation did not stop streaming.');
  await waitForCondition(async () => fakeAi.state.cancelledRequests > 0, 8000, 'Cancellation did not abort the provider request.');
}

async function verifyWikiAssistantRecovery(connection, documentId, fakeAi) {
  await openAssistantForNode(connection, '环境检查');
  const requestCountBefore = fakeAi.requests.length;
  await submitWikiQuestion(connection, '那第二次呢？');
  await waitForCondition(async () => [...(await connection.evaluate(`[...document.querySelectorAll('.wiki-ai-message.assistant')].map((node) => node.textContent ?? '')`))].some((text) => text.includes('31 秒')), 20000, 'Wiki follow-up did not complete after restart.');
  const newRequests = fakeAi.requests.slice(requestCountBefore);
  const followUpCall = newRequests.find((entry) => entry.stream && entry.prompt.includes('那第二次呢'));
  assert.ok(followUpCall, 'Restarted Wiki process did not send the follow-up model request.');
  assert.match(followUpCall.prompt, /第一次恢复退避是多少秒/u, 'Restarted Wiki process did not restore the previous user turn.');
  assert.match(followUpCall.prompt, /第一次恢复退避为 7 秒/u, 'Restarted Wiki process did not restore the previous assistant turn.');

  const memory = await connection.evaluate(`window.electronAPI.listWikiAiMemories(${JSON.stringify(libraryDir)}, ${JSON.stringify(documentId)})`);
  assert.equal(memory.ok, true);
  const latest = memory.memories.find((entry) => entry.nodeId && entry.conversation.some((message) => message.content.includes('那第二次呢')));
  assert.ok(latest && latest.conversation.length >= 4, 'Wiki AI memory did not retain both turns after restart.');
}

async function openAssistantForNode(connection, nodeTitle) {
  await connection.evaluate(`(() => {
    const title = ${JSON.stringify(nodeTitle)};
    [...document.querySelectorAll('.wiki-map-node')]
      .find((node) => node.querySelector('.wiki-map-node-title')?.textContent?.includes(title))
      ?.click();
  })()`);
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-detail-pane'))"), 6000, `Wiki node ${nodeTitle} did not open.`);
  await connection.evaluate(`[...document.querySelectorAll('.wiki-detail-tabs [role="tab"]')].find((tab) => tab.textContent?.trim() === 'AI')?.click()`);
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-assistant-composer textarea'))"), 6000, 'Wiki AI composer did not render.');
  await waitForCondition(async () => await connection.evaluate(`document.querySelector('.wiki-assistant-model-control')?.textContent?.includes('R4 本地验收模型')`), 8000, 'Wiki AI composer did not select the restored R4 model profile.');
}

async function submitWikiQuestion(connection, question) {
  await connection.evaluate(`(() => {
    const textarea = document.querySelector('.wiki-assistant-composer textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(question)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  try {
    await waitForCondition(async () => await connection.evaluate(`[...document.querySelectorAll('.wiki-assistant-composer button')].some((button) => button.textContent?.trim() === '发送' && !button.disabled)`), 5000, 'Wiki AI send control did not become enabled.');
  } catch (error) {
    const diagnostics = await connection.evaluate(`(() => {
      const textarea = document.querySelector('.wiki-assistant-composer textarea');
      const send = [...document.querySelectorAll('.wiki-assistant-composer button')].find((button) => button.textContent?.trim() === '发送');
      const model = document.querySelector('.wiki-assistant-model-control');
      return {
        textareaValue: textarea?.value ?? null,
        textareaDisabled: textarea?.disabled ?? null,
        sendDisabled: send?.disabled ?? null,
        modelLabel: model?.textContent?.trim() ?? null,
        modelDisabled: model?.disabled ?? null,
        running: Boolean(document.querySelector('.wiki-streaming-caret')),
      };
    })()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  await connection.evaluate(`[...document.querySelectorAll('.wiki-assistant-composer button')].find((button) => button.textContent?.trim() === '发送')?.click()`);
}

async function openWikiDocument(connection) {
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.app-nav-item[aria-label=\"Wiki\"]'))"), 15000, 'Wiki navigation did not render.');
  await connection.evaluate("document.querySelector('.app-nav-item[aria-label=\"Wiki\"]')?.click()");
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-workspace'))"), 15000, 'Wiki workspace did not render.');
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-document-list-item[data-state=\"ready\"]'))"), 20000, 'Indexed Wiki document did not become ready.');
  await connection.evaluate("document.querySelector('.wiki-document-list-item[data-state=\"ready\"]')?.click()");
  await waitForCondition(async () => await connection.evaluate("document.querySelectorAll('.wiki-map-node:not(.wiki-map-node-placeholder)').length >= 2"), 15000, 'Wiki map nodes did not render.');
  await waitForCondition(async () => !(await connection.evaluate("Boolean(document.querySelector('.wiki-map-edge.settling'))")), 6000, 'Wiki edges did not settle.');
}

async function verifyCollapse(connection, initialNodeCount) {
  const collapsed = await connection.evaluate(`(() => {
    const button = document.querySelector('.wiki-map-node:not(.root) .wiki-map-node-collapse');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(collapsed, true, 'A collapsible non-root branch was not rendered.');
  await waitForCondition(async () => (await connection.evaluate("document.querySelectorAll('.wiki-map-node:not(.wiki-map-node-placeholder)').length")) < initialNodeCount, 8000, 'Collapsing a branch did not hide descendants.');
  await connection.evaluate("document.querySelector('.wiki-map-node [aria-label=\"展开分支\"]')?.click()");
  await waitForCondition(async () => (await connection.evaluate("document.querySelectorAll('.wiki-map-node:not(.wiki-map-node-placeholder)').length")) === initialNodeCount, 8000, 'Expanding a branch did not restore descendants.');
}

async function verifyViewportMatrix(connection, theme) {
  let colors;
  for (const [width, height] of [[1440, 900], [1920, 1080]]) {
    await connection.setWindowBounds(width, height);
    await waitForCondition(async () => await connection.evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`), 8000, `Renderer viewport did not reach ${width}x${height}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const geometry = await connection.evaluate(`(() => {
      const workspace = document.querySelector('.wiki-workspace');
      const canvas = document.querySelector('.wiki-map-canvas');
      const nodes = [...document.querySelectorAll('.wiki-map-node:not(.wiki-map-node-placeholder)')];
      const paths = [...document.querySelectorAll('.wiki-map-edge')];
      const longTitle = nodes.find((node) => node.textContent?.includes('超长中文章节标题'))?.querySelector('.wiki-map-node-title');
      const nodeRects = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      const overlaps = nodeRects.some((left, leftIndex) => nodeRects.some((right, rightIndex) => rightIndex > leftIndex
        && left.left < right.right - 1 && right.left < left.right - 1
        && left.top < right.bottom - 1 && right.top < left.bottom - 1));
      const titleStyle = longTitle ? getComputedStyle(longTitle) : null;
      const edgePaths = paths.map((edge) => edge.getAttribute('d') ?? '');
      const drawableEdges = paths.filter((edge) => (edge.getAttribute('d') ?? '').trim());
      return {
        theme: document.documentElement.dataset.theme,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        workspaceBackground: workspace ? getComputedStyle(workspace).backgroundColor : '',
        canvasVisible: Boolean(canvas && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0),
        pageOverflowX: [document.documentElement, document.body]
          .some((element) => element.scrollWidth > element.clientWidth + 1),
        pageOverflowY: [document.documentElement, document.body]
          .some((element) => element.scrollHeight > element.clientHeight + 1),
        overlaps,
        orthogonal: drawableEdges.length > 0 && drawableEdges.every((edge) => {
          const edgePath = edge.getAttribute('d') ?? '';
          const commands = edgePath.match(/[A-Za-z]/g) ?? [];
          return commands.length > 0 && commands.every((command) => command === 'M' || command === 'L');
        }),
        invalidEdgePath: edgePaths.find((edgePath) => {
          const commands = edgePath.match(/[A-Za-z]/g) ?? [];
          return commands.some((command) => command !== 'M' && command !== 'L');
        }) ?? '',
        edgeVisible: drawableEdges.length > 0 && Number.parseFloat(getComputedStyle(drawableEdges[0]).opacity || '1') > 0.1,
        depthColumns: new Set(nodeRects.map((rect) => Math.round(rect.left / 3) * 3)).size,
        longTitleClamped: Boolean(titleStyle
          && titleStyle.overflow === 'hidden'
          && titleStyle.getPropertyValue('-webkit-line-clamp') === '2'),
      };
    })()`);
    assert.equal(geometry.theme, theme);
    assert.equal(geometry.canvasVisible, true);
    assert.equal(geometry.pageOverflowX, false, `${width}x${height} Wiki workspace caused horizontal page overflow.`);
    assert.equal(geometry.pageOverflowY, false, `${width}x${height} Wiki workspace caused vertical page overflow.`);
    assert.equal(geometry.overlaps, false, `${width}x${height} Wiki nodes overlap.`);
    assert.equal(geometry.orthogonal, true, `${width}x${height} rendered a non-orthogonal edge path: ${geometry.invalidEdgePath}`);
    assert.equal(geometry.edgeVisible, true, `${width}x${height} Wiki edges are not visible.`);
    assert.ok(geometry.depthColumns >= 4, `${width}x${height} did not render the deep hierarchy.`);
    assert.equal(geometry.longTitleClamped, true);
    const screenshot = await connection.captureScreenshot();
    writeFileSync(path.join(screenshotsDir, `wiki-${width}x${height}-${theme}.png`), Buffer.from(screenshot, 'base64'));
    colors = geometry;
  }
  return colors;
}

async function setThemeAndReload(connection, theme) {
  await connection.evaluate(`window.electronAPI.saveAppPreferences({ theme: ${JSON.stringify(theme)} })`);
  await connection.send('Page.reload', { ignoreCache: true });
  await waitForCondition(async () => {
    try {
      return await connection.evaluate(`typeof window.electronAPI?.listFiles === 'function' && document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
    } catch {
      return false;
    }
  }, 15000, `Theme ${theme} did not apply after reload.`);
}

async function enterReorderMode(connection) {
  await connection.evaluate(`(() => {
    const control = [...document.querySelectorAll('.wiki-map-mode-controls *')].find((node) => node.textContent?.trim() === '调整顺序');
    control?.click();
  })()`);
  await waitForCondition(async () => await connection.evaluate("Boolean(document.querySelector('.wiki-map-canvas.reorder-mode'))"), 6000, 'Wiki reorder mode did not activate.');
}

async function siblingSnapshot(connection) {
  return connection.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.wiki-map-node:not(.root):not(.wiki-map-node-placeholder)')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { label: node.getAttribute('aria-label') ?? '', x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
    const groups = new Map();
    for (const node of nodes) {
      const key = Math.round(node.x / 3) * 3;
      const group = groups.get(key) ?? [];
      group.push(node);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .filter(([, group]) => group.length >= 2)
      .sort(([left], [right]) => left - right)[0]?.[1]
      .sort((left, right) => left.y - right.y) ?? [];
  })()`);
}

async function dragSiblingWithTouch(connection, source, target) {
  await connection.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const end = { x: start.x, y: target.y + target.height + 8 };
  await connection.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, radiusX: 2, radiusY: 2, force: 1, id: 1 }] });
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    await connection.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x, y: start.y + (end.y - start.y) * progress, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await connection.send('Emulation.setTouchEmulationEnabled', { enabled: false });
}

function findSiblingOrderFiles(libraryPath) {
  const wikiDirectory = path.join(libraryPath, '.menghan-meta', 'wiki');
  if (!existsSync(wikiDirectory)) return [];
  return readdirSync(wikiDirectory).filter((name) => name.endsWith('.sibling-order.json'));
}

async function launchAndConnect(port) {
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    mainEntryPath,
  ], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const page = await waitForPage(port, child);
    const connection = await connectToCdp(page.webSocketDebuggerUrl);
    await waitForCondition(async () => {
      try {
        return await connection.evaluate("typeof window.electronAPI?.listFiles === 'function'");
      } catch {
        return false;
      }
    }, 20000, 'Electron preload API did not become ready.');
    return {
      ...connection,
      close: async () => {
        try {
          await connection.send('Browser.close');
        } catch {
          // Renderer may already be closing; the bounded process cleanup below remains authoritative.
        }
        connection.closeSocket();
        await waitForExit(child, 8000);
        if (child.exitCode === null) await terminateProcessTree(child.pid);
      },
    };
  } catch (error) {
    await terminateProcessTree(child.pid);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForPage(port, child) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron app exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === 'page' && entry.url?.startsWith('file:'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the Electron renderer.');
}

async function waitForCondition(predicate, timeoutMs = 10000, message = 'Timed out waiting for a renderer condition.') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function connectToCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed.'));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        return response.result.value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Execution context was destroyed|Cannot find context/i.test(message) || attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('Renderer evaluation did not become available.');
  };
  return {
    send,
    evaluate,
    setWindowBounds: (width, height) => send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    }),
    captureScreenshot: async () => (await send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data,
    closeSocket: () => socket.close(),
  };
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function terminateProcessTree(processId) {
  if (!processId) return;
  if (process.platform !== 'win32') {
    try { process.kill(processId, 'SIGTERM'); } catch { /* Process already exited. */ }
    return;
  }
  await new Promise((resolve) => {
    const taskkill = spawn('taskkill', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    taskkill.once('exit', resolve);
    taskkill.once('error', resolve);
  });
}
