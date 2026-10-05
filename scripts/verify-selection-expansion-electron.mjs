import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const root = process.cwd();
await fs.mkdir(path.resolve('.package-staging'), { recursive: true });
const temporary = await fs.mkdtemp(path.resolve('.package-staging/expansion-electron-'));
const workspace = path.join(temporary, 'notes');
const userData = path.join(temporary, 'user-data');
await fs.mkdir(workspace); await fs.mkdir(userData);
const selected = '恢复窗口。';
const fact = '恢复窗口规定第一次自动重试前等待 7 秒。';
const shortMarkdown = `# 恢复策略\n\n${selected}\n\n${fact}\n\n# 重复段落\n\n**${selected}**\n`;
const longMarkdown = `${selected}\n\n${fact}\n\n` + '档案资料。\n\n'.repeat(2400);
const formattedSelection = '这份文档形成四层数据：\n\n1. **原始文档**与 Parent/Child Chunk；\n2. Chunk 向量和关键词索引；\n3. 实体、关系、Evidence、社区；\n4. 跨文档 Canonical Entity、Relation Group 等派生索引。';
const formattedResult = '这份文档形成四层数据，各层对应不同的存储与检索目标：\n\n1. **原始文档**与 Parent/Child Chunk：保存原文，父块提供上下文，子块用于定位相关内容；\n2. **Chunk 向量和关键词索引**：向量支持语义查询，关键词索引支持字面量定位；\n3. **实体、关系、Evidence、社区**：保存实体关系并关联支撑它们的原文依据；\n4. **跨文档 Canonical Entity、Relation Group 等派生索引**：归并跨文档的规范实体和关系，形成可追溯的派生索引。';
const formattedMarkdown = `保留前文。\n\n${formattedSelection}\n\n## 保留后文\n\n\`\`\`typescript\nconst untouched = 1;\n\`\`\`\n\n## 相关说明\n\n${formattedResult}\n`;
await fs.writeFile(path.join(workspace, '短文.md'), shortMarkdown);
await fs.writeFile(path.join(workspace, '长文.md'), longMarkdown);
await fs.writeFile(path.join(workspace, '格式.md'), formattedMarkdown);
await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: workspace }));
const requests = [];
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push({ payload, authenticated: request.headers.authorization === 'Bearer local-verification-key' });
  const message = payload.tools?.length && !payload.messages.some((message) => message.role === 'tool') ? { role: 'assistant', content: null, tool_calls: [{ id: `read-${requests.length}`, type: 'function', function: { name: 'read_note_range', arguments: JSON.stringify({ line_from: 3, line_to: 3 }) } }] }
    : { role: 'assistant', content: body.includes('四层数据') ? formattedResult : body.includes('**恢复窗口。**') ? `**${fact}**` : fact };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'fixture', choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const portServer = createServer(); await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port; await new Promise((resolve) => portServer.close(resolve));
const env = { ...process.env, NODE_ENV: 'production', MENGHAN_SELECTION_EDIT_MODE: 'unified', MENGHAN_SELECTION_EXPANSION_CONTEXT_MODE: 'adaptive', MENGHAN_SELECTION_EXPANSION_MODE: 'current-note' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [path.resolve('dist-electron/main.js'), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (data) => stderr += data.toString());
let connection;
try {
  const page = await poll(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr.slice(-1000)}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((page) => page.type === 'page' && page.url.startsWith('file:')); } catch { return undefined; }
  });
  connection = await connect(page.webSocketDebuggerUrl);
  const evaluate = connection.evaluate;
  await poll(() => evaluate(`Boolean(window.electronAPI)`));
  console.log('Electron expansion: IPC ready, files:', await evaluate('window.electronAPI.listFiles()'));
  await evaluate(`window.electronAPI.saveAiProviderConfig(${JSON.stringify({ kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint, apiKey: 'local-verification-key', remoteContentConsent: true, model: 'fixture-model', contextWindowTokens: 32768, contextWindowTokensSource: 'user' })})`);
  await poll(() => evaluate(`Boolean(document.querySelector('.app-nav-item[aria-label="笔记"]'))`));
  await evaluate(`document.querySelector('.app-nav-item[aria-label="笔记"]')?.click()`);
  await poll(() => evaluate(`[...document.querySelectorAll('.file-tree-row')].some(node=>node.querySelector('.tree-label')?.title==='短文.md')`));
  await evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node=>node.querySelector('.tree-label')?.title==='短文.md')?.click()`);
  await poll(() => evaluate(`document.querySelector('.tiptap')?.textContent.includes('重复段落')`));
  console.log('Electron expansion: opened fixture note.');
  await selectRepeatedOccurrence(evaluate);
  await evaluate(`[...document.querySelectorAll('.selection-context-menu button')].find(node=>node.textContent.includes('扩写优化'))?.click()`);
  await poll(() => evaluate(`Boolean(document.querySelector('.selection-expansion-workspace'))`));
  console.log('Electron expansion: opened workspace.');
  await evaluate(`(()=>{[...document.querySelectorAll('.selection-expansion-workspace button')].find(node=>/开始扩写/.test(node.textContent))?.click();document.querySelector('[aria-label="关闭选区扩写"]')?.click();})()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(requests.length, 0, '准备阶段关闭后不得继续发送模型请求');
  await selectRepeatedOccurrence(evaluate);
  await evaluate(`[...document.querySelectorAll('.selection-context-menu button')].find(node=>node.textContent.includes('扩写优化'))?.click()`);
  await poll(() => evaluate(`Boolean(document.querySelector('.selection-expansion-workspace'))`));
  await evaluate(`[...document.querySelectorAll('.selection-expansion-workspace button')].find(node=>/开始扩写/.test(node.textContent))?.click()`);
  await poll(() => evaluate(`document.querySelector('.selection-expansion-workspace')?.textContent.includes('已完整纳入')`));
  const workspaceText = await evaluate(`document.querySelector('.selection-expansion-workspace').textContent`);
  console.log('Electron expansion: workspace generation completed.');
  assert.match(workspaceText, /目标 9.*最低通过 8.*实际 19/u);
  assert.equal(await fs.readFile(path.join(workspace, '短文.md'), 'utf8'), shortMarkdown, '生成建议不能自动写回');
  await evaluate(`(()=>{ const viewport=document.querySelector('.selection-expansion-workspace-body .mantine-ScrollArea-viewport');if(viewport)viewport.scrollTop=viewport.scrollHeight; })()`);
  const screenshot = await connection.send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(path.resolve('docs/verification'), { recursive: true });
  await fs.writeFile(path.resolve('docs/verification/selection-expansion-workspace.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.querySelector('[aria-label="关闭选区扩写"]')?.click()`);
  await selectRepeatedOccurrence(evaluate);
  await evaluate(`[...document.querySelectorAll('.selection-context-menu button')].find(node=>node.textContent.includes('AI 编辑'))?.click()`);
  await poll(() => evaluate(`[...document.querySelectorAll('button')].some(node=>node.querySelector('p')?.textContent==='扩写')`));
  await evaluate(`[...document.querySelectorAll('button')].find(node=>node.querySelector('p')?.textContent==='扩写')?.click()`);
  await poll(() => evaluate(`[...document.querySelectorAll('button[aria-pressed="true"]')].some(node=>node.querySelector('p')?.textContent==='扩写')`));
  await evaluate(`[...document.querySelectorAll('button')].find(node=>/生成建议/.test(node.textContent))?.click()`);
  await poll(() => evaluate(`document.body.textContent.includes('当前笔记全文') && document.body.textContent.includes('实际 19')`));
  assert.equal(requests.length, 2, '两个短文扩写入口都只需直接合成一次');
  assert.ok(requests.every((request) => request.authenticated));
  await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='替换选区')?.click()`);
  await poll(() => evaluate(`document.querySelector('.tiptap')?.textContent.split(${JSON.stringify(fact)}).length===3`));
  const paragraphs = await evaluate(`[...document.querySelectorAll('.tiptap p')].map(node=>node.textContent)`);
  assert.equal(paragraphs[0], selected, '替换重复段落时不能修改第一次出现处');
  assert.equal(paragraphs.at(-1), fact, '只替换选中的第二处');
  assert.equal(await evaluate(`document.querySelector('.tiptap p:last-child strong')?.textContent`), fact, '替换后的 Markdown 加粗必须保留');
  const longPath = path.join(workspace, '长文.md');
  const longResult = await evaluate(`(async()=>{
    const source = await window.electronAPI.prepareSelectionExpansionSource(${JSON.stringify(longPath)});
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    return window.electronAPI.startSelectionEdit({ requestId:'electron-long-verify', action:'expand', currentPath:source.currentPath, selectedText:${JSON.stringify(selected)}, contextScope:'auto', expectedContentHash:source.contentHash,
      selectionLocator:{editorSessionId:'ipc-fixture',docRevision:1,from:1,to:6,textOffset:0,documentTextHash:await hash(${JSON.stringify(longMarkdown.replace(/\s/gu, ''))}),selectedTextHash:await hash(${JSON.stringify(selected)}),canonicalSliceJson:'null',markdownFragment:${JSON.stringify(selected)},selectionStructureSignature:'fixture',documentStructureSignature:'fixture',blockKinds:['paragraph'],rect:{left:0,top:0,right:1,bottom:1}}
    });
  })()`);
  assert.equal(longResult.execution.path, 'react');
  assert.equal(longResult.contextReceipt.contextMode, 'related-original');
  assert.equal(longResult.validation.passed, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.authenticated), '原生 ReAct 也必须使用主进程密钥');
  await evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node=>node.querySelector('.tree-label')?.title==='格式.md')?.click()`);
  await poll(() => evaluate(`document.querySelector('.tiptap')?.textContent.includes('这份文档形成四层数据')`));
  await evaluate(`(()=>{const editor=document.querySelector('.tiptap');editor.focus();const first=[...editor.querySelectorAll('p')].find(node=>node.textContent==='这份文档形成四层数据：');const last=editor.querySelector('ol li:last-child p');first.scrollIntoView({block:'center'});const firstWalker=document.createTreeWalker(first,NodeFilter.SHOW_TEXT);const lastWalker=document.createTreeWalker(last,NodeFilter.SHOW_TEXT);const start=firstWalker.nextNode();let end;while(lastWalker.nextNode())end=lastWalker.currentNode;const range=document.createRange();range.setStart(start,0);range.setEnd(end,end.textContent.length);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await evaluate(`(()=>{const range=window.getSelection().getRangeAt(0);const rect=range.getClientRects()[0];range.startContainer.parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:2}));})()`);
  await poll(() => evaluate(`Boolean(document.querySelector('.selection-context-menu'))`));
  await evaluate(`[...document.querySelectorAll('.selection-context-menu button')].find(node=>node.textContent.includes('扩写优化'))?.click()`);
  await poll(() => evaluate(`Boolean(document.querySelector('.selection-expansion-workspace'))`));
  await evaluate(`[...document.querySelectorAll('.selection-expansion-workspace button')].find(node=>/开始扩写/.test(node.textContent))?.click()`);
  await poll(() => evaluate(`document.querySelector('.selection-expansion-workspace .assistant-markdown-content ol')?.children.length===4 && document.querySelector('.selection-expansion-workspace')?.textContent.includes('可写回')`));
  assert.equal(await fs.readFile(path.join(workspace, '格式.md'), 'utf8'), formattedMarkdown, '格式建议生成后仍不自动修改笔记');
  await evaluate(`(()=>{ const viewport=document.querySelector('.selection-expansion-workspace-body .mantine-ScrollArea-viewport');if(viewport)viewport.scrollTop=viewport.scrollHeight; })()`);
  const formattedScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.resolve('docs/verification/selection-expansion-markdown.png'), Buffer.from(formattedScreenshot.data, 'base64'));
  await evaluate(`[...document.querySelectorAll('.selection-expansion-workspace button')].find(node=>node.textContent.trim()==='替换选区')?.click()`);
  await poll(() => evaluate(`document.querySelector('.tiptap p')?.textContent==='保留前文。' && document.querySelector('.tiptap ol li p strong')?.textContent==='原始文档' && document.querySelector('.tiptap')?.textContent.includes('各层对应不同的存储与检索目标')`));
  assert.equal(await evaluate(`document.querySelector('.tiptap ol').children.length`), 4);
  assert.equal(await evaluate(`document.querySelector('.tiptap .code-block-node-view .cm-content')?.textContent.trim()`), 'const untouched = 1;', '选区后的代码不变');
  assert.ok(await evaluate(`[...document.querySelectorAll('.tiptap h2')].some(node=>node.textContent==='保留后文')`));
  await evaluate(`document.querySelector('[aria-label="关闭选区扩写"]')?.click()`);
  await evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node=>node.querySelector('.tree-label')?.title==='短文.md')?.click()`);
  await poll(() => evaluate(`document.querySelector('.tiptap')?.textContent.includes('重复段落')`));
  const savedFormatted = await fs.readFile(path.join(workspace, '格式.md'), 'utf8');
  assert.match(savedFormatted, /1\.[ \t]+\*\*原始文档\*\*/);
  assert.match(savedFormatted, /```typescript\nconst untouched = 1;/);
  assert.equal(requests.length, 5);
  await fs.writeFile(path.resolve('docs/verification/selection-expansion-electron.json'), JSON.stringify({ generatedAt: new Date().toISOString(), boundary: 'Electron dev runtime, production renderer build, local provider fixture', assertions: ['actual repeated bold selection', 'cancel during preparation', 'workspace expansion and receipt', 'quick expansion and same target', 'no automatic writeback', 'replace second occurrence only', 'native long-note IPC and authenticated tool transport', 'formatted four-item list preview and replacement', 'Markdown persisted with bold and list markers', 'following heading and code unchanged'], longExecution: longResult.execution, requestCount: requests.length }, null, 2));
  console.log('Electron expansion passed: both real UI entrypoints, repeated marked selection, guarded writeback and authenticated long-note ReAct IPC.');
} catch (error) {
  console.error(error.message);
  if (connection) console.error((await connection.evaluate('document.body.innerText').catch(() => '')).slice(-1800));
  console.error(`Provider requests: ${requests.length}; Electron errors: ${stderr.slice(-1000)}`);
  throw error;
} finally {
  connection?.close();
  if (child.exitCode === null) await new Promise((resolve) => { const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.once('exit', resolve); });
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await new Promise((resolve) => server.close(resolve));
  assert.ok(temporary.startsWith(path.resolve('.package-staging') + path.sep));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function poll(read) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for Electron expansion state.');
}
async function selectRepeatedOccurrence(evaluate) {
  await evaluate(`(()=>{ document.querySelector('.tiptap').focus();const target=[...document.querySelectorAll('.tiptap p')].filter(node=>node.textContent===${JSON.stringify(selected)}).at(-1);target.scrollIntoView({block:'center'});const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);const node=walker.nextNode();const range=document.createRange();range.setStart(node,0);range.setEnd(node,node.textContent.length);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange')); })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await evaluate(`(()=>{ const target=[...document.querySelectorAll('.tiptap p')].filter(node=>node.textContent===${JSON.stringify(selected)}).at(-1);const rect=window.getSelection().getRangeAt(0).getBoundingClientRect();target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:2})); })()`);
  await poll(() => evaluate(`Boolean(document.querySelector('.selection-context-menu'))`));
}
async function connect(url) {
  const socket = new WebSocket(url); let id = 0; const pending = new Map();
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => { const result = JSON.parse(data); const handler = pending.get(result.id); if (!handler) return; pending.delete(result.id); result.error ? handler.reject(new Error(result.error.message)) : handler.resolve(result.result); });
  const send = (method, params) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  return { send, close: () => socket.close(), evaluate: async expression => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/u.test(error.message) || attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } };
}
