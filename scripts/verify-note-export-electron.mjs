import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'note-export-electron-'));
const library = path.join(temporary, 'library'), userData = path.join(temporary, 'user-data'), bundle = path.join(temporary, 'dist-electron'), outputs = path.join(temporary, 'exports');
const source = path.join(library, '笔记导出验收.md');
const control = path.join(temporary, 'dialog-control.json'), dialogLog = path.join(temporary, 'dialog-last.json');
const markdown = `---\ntitle: 笔记导出验收\ntags: [导出, 验证]\n---\n\n# 笔记导出验收\n\n中文文字应该可以搜索和复制。\n\n## 公式\n\n行内公式 $x^2+y^2$ 与独立公式：\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n## 图片\n\n![本地图片验收](image/fixture.png)\n\n## 表格\n\n| 合同编号 | 中文客户名称 | 含税金额 | 长文本边界 |\n| --- | --- | --- | --- |\n| HT-2026-001 | 沈阳示例科技有限公司 | 113,000.00 元 | ${'LONG_TABLE_CONTENT_'.repeat(8)}TABLE_COLUMN_END |\n\n## Mermaid 流程图\n\n\`\`\`mermaid\nflowchart LR\n  A[Markdown 笔记] --> B[HTML 排版]\n  B --> C[本地 PDF 导出]\n\`\`\`\n\n## 长代码\n\n\`\`\`java\n${Array.from({ length: 55 }, (_, index) => `String item${index} = "${index === 54 ? 'LAST_CODE_LINE' : '中文业务说明'}";`).join('\n')}\n// ${'LONG_CODE_CONTENT_'.repeat(12)}LONG_CODE_END\n\`\`\`\n\n${Array.from({ length: 12 }, (_, index) => `## 第 ${index + 1} 节\n\n${'这段中文用于检查多页导出、分页和完整正文。'.repeat(6)}\n`).join('\n')}\n全文结束标记：DOCUMENT_END。\n`;
let session, requests = 0, server;
try {
  await Promise.all([library, userData, bundle, outputs, path.join(library, 'image')].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(source, markdown);
  await fs.copyFile('build/icon.png', path.join(library, 'image', 'fixture.png'));
  await fs.writeFile(control, '{}');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ libraryPath: library, activeLibraryPath: library, libraries: [{ path: library, alias: '导出验收', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }], workspacePath: path.join(temporary, 'workspace'), appPreferences: { theme: 'dark', defaultEditorMode: 'source', autosaveDelayMs: 10000 } }));
  await Promise.all([
    ...[['electron/main.ts', 'application.js', ['electron', 'better-sqlite3']], ['electron/preload.ts', 'preload.js', ['electron']], ['electron/knowledge/noteIndexWorker.ts', 'noteIndexWorker.js', []], ['electron/externalWebPreload.ts', 'externalWebPreload.js', ['electron']], ['electron/pipeline/mammothWorker.ts', 'mammothWorker.js', []]].map(([entry, name, external]) => build({ entryPoints: [entry], bundle: true, platform: 'node', external, outfile: path.join(bundle, name), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist'), '--logLevel', 'error']),
  ]);
  // 只替换隔离窗口的系统保存对话框；渲染、IPC、PDF 打印和文件保存均运行真实代码。
  await fs.writeFile(path.join(bundle, 'main.js'), `const fs = require('node:fs'); const path = require('node:path'); const electron = require('electron');
electron.dialog.showSaveDialog = async (_parent, options) => {
 const settings = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
 const format = options.filters[0].extensions[0];
 fs.writeFileSync(${JSON.stringify(dialogLog)}, JSON.stringify({ options, windows: electron.BrowserWindow.getAllWindows().length }));
 return { canceled: Boolean(settings.cancel), filePath: settings.target || path.join(${JSON.stringify(outputs)}, 'export.' + format) };
};
require('./application.js');`);
  console.log('Electron export acceptance bundle built.');
  session = await launchNoteTest({ mainEntry: path.join(bundle, 'main.js'), userData });
  await waitFor(() => session.evaluate("[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent.includes('笔记导出验收'))"), 'export fixture');
  await session.evaluate("[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent.includes('笔记导出验收')).click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.editor-export-select') && document.querySelector('.cm-content')?.isContentEditable)"), 'export menu and editor');
  assert.deepEqual(await session.evaluate("[...document.querySelectorAll('.editor-export-select option')].map(option => option.value).filter(Boolean)"), ['md', 'html', 'pdf']);
  await session.evaluate('window.__exportAlerts = []; window.alert = message => window.__exportAlerts.push(String(message));');

  for (const format of ['md', 'html', 'pdf']) {
    await selectExport(format);
    await waitFor(async () => { try { return (await fs.stat(path.join(outputs, `export.${format}`))).size > 0; } catch { return false; } }, `${format} export`, 60000);
    await ready();
    const savedDialog = JSON.parse(await fs.readFile(dialogLog, 'utf8'));
    assert.equal(savedDialog.options.filters[0].extensions[0], format);
    assert.equal(savedDialog.windows, 1, 'PDF 打印窗口必须在完成后关闭');
  }
  assert.deepEqual(await fs.readFile(path.join(outputs, 'export.md')), Buffer.from(markdown));
  const html = await fs.readFile(path.join(outputs, 'export.html'), 'utf8');
  assert.match(html, /class="katex"/); assert.match(html, /data:image\/png;base64,/); assert.match(html, /<svg/); assert.match(html, /class="hljs-/);
  assert.match(html, /data-theme="dark"/); assert.doesNotMatch(html, /menghan-image:\/\//);
  const pdf = await fs.readFile(path.join(outputs, 'export.pdf')); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(await fs.readFile(source), Buffer.from(markdown));
  assert.deepEqual(await session.evaluate('window.__exportAlerts'), []);

  // 取消不修改已有副本；选择当前原文件会得到明确错误，原笔记字节不变。
  await fs.writeFile(control, '{"cancel":true}'); await selectExport('md'); await ready();
  assert.deepEqual(await fs.readFile(path.join(outputs, 'export.md')), Buffer.from(markdown));
  await fs.writeFile(control, JSON.stringify({ target: source })); await selectExport('md');
  await waitFor(() => session.evaluate("window.__exportAlerts.some(message => message.includes('原笔记'))"), 'original-file refusal'); await ready();
  assert.deepEqual(await fs.readFile(source), Buffer.from(markdown));

  // 打印窗口不访问笔记里的外部资源；缺失图片停止导出并保留旧副本。
  const remotePng = await fs.readFile(path.join(library, 'image', 'fixture.png'));
  server = createServer((request, response) => {
    requests++;
    if (request.url === '/redirect') { response.writeHead(302, { location: '/image.png' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'image/png' }); response.end(remotePng); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/image.png`;
  const failedTarget = path.join(outputs, 'missing-image.pdf'); await fs.writeFile(failedTarget, '旧 PDF 副本');
  await fs.writeFile(control, JSON.stringify({ target: failedTarget }));
  const refused = await session.evaluate(`window.electronAPI.exportNote({format:'pdf', defaultName:'缺失图片', sourcePath:${JSON.stringify(source)}, content:${JSON.stringify(`<!doctype html><html><head></head><body><script>fetch('${url}')</script><img src="${url}"></body></html>`)} }).then(() => '', error => error.message)`);
  assert.match(refused, /图片无法加载/); assert.equal(requests, 0); assert.equal(await fs.readFile(failedTarget, 'utf8'), '旧 PDF 副本');
  const remoteImage = await session.evaluate(`window.electronAPI.readMarkdownExportImage(${JSON.stringify(url.replace('/image.png', '/redirect'))})`);
  assert.equal(remoteImage.byteLength, remotePng.length);
  assert.deepEqual(Buffer.from(remoteImage.dataUrl.split(',')[1], 'base64'), remotePng);
  assert.equal(requests, 2, 'Remote download follows a bounded HTTP redirect');
  const remoteTarget = path.join(outputs, 'remote-image.pdf');
  await fs.writeFile(control, JSON.stringify({ target: remoteTarget }));
  await session.evaluate(`window.electronAPI.exportNote({format:'pdf', defaultName:'网络图片', sourcePath:${JSON.stringify(source)}, content:${JSON.stringify('<!doctype html><html><head></head><body><img src="' + remoteImage.dataUrl + '"></body></html>')} })`);
  assert.equal((await fs.readFile(remoteTarget)).subarray(0, 5).toString(), '%PDF-');
  assert.equal(requests, 2, 'Printing uses only the embedded image');
  await fs.writeFile(control, '{"cancel":true}'); await selectExport('md'); await ready();
  assert.equal(JSON.parse(await fs.readFile(dialogLog, 'utf8')).windows, 1, '失败的 PDF 打印窗口也必须关闭');

  // MD 导出采用当前未保存草稿，保留 frontmatter；不要求先覆盖磁盘原文。
  await fs.writeFile(control, JSON.stringify({ target: path.join(outputs, 'draft.md') }));
  await session.evaluate("document.querySelector('.cm-content').focus()");
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await session.send('Input.insertText', { text: '\n当前未保存草稿 DRAFT_EXPORT_END\n' });
  await waitFor(() => session.evaluate("document.querySelector('.note-save-notice')?.dataset.status === 'dirty'"), 'draft input');
  await selectExport('md');
  await waitFor(async () => { try { return (await fs.readFile(path.join(outputs, 'draft.md'), 'utf8')).includes('DRAFT_EXPORT_END'); } catch { return false; } }, 'draft export');
  await ready();
  assert.match(await fs.readFile(path.join(outputs, 'draft.md'), 'utf8'), /^---\ntitle: 笔记导出验收/);
  assert.deepEqual(await fs.readFile(source), Buffer.from(markdown));

  if (process.env.TRELLORA_NOTE_EXPORT_ARTIFACT_DIR) {
    const artifacts = path.resolve(process.env.TRELLORA_NOTE_EXPORT_ARTIFACT_DIR); await fs.mkdir(artifacts, { recursive: true });
    for (const format of ['md', 'html', 'pdf']) await fs.copyFile(path.join(outputs, `export.${format}`), path.join(artifacts, `note-export-sample.${format}`));
    const screenshot = await session.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(artifacts, 'export-menu.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(`Verification artifacts: ${artifacts}`);
  }
  console.log('Electron note exports verified: real MD/HTML/PDF menu and IPC, exact Markdown/frontmatter, embedded local images/fonts/math/Mermaid/highlights, cancel/original protection, network isolation, failed-image preservation, draft snapshot and hidden-window cleanup.');
} catch (error) {
  console.error(error, session?.diagnostics());
  console.error(await session?.evaluate('window.__exportAlerts').catch(() => undefined));
  throw error;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function selectExport(format) {
  await session.evaluate(`(() => { const select = document.querySelector('.editor-export-select'); select.value = ${JSON.stringify(format)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
async function ready() {
  await waitFor(() => session.evaluate("!document.querySelector('.editor-export-select').disabled"), 'export complete', 60000);
}
