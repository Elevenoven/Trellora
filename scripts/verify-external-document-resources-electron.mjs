import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor, delay } from './electron-note-test-session.mjs';

const real = process.argv.includes('--real'), staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'external-resource-electron-'));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-resource-electron-'));
const userData = path.join(fixture, 'user-data'), original = path.join(fixture, 'original'), library = path.join(fixture, 'library'), destination = path.join(fixture, 'destination');
const mainEntry = path.join(temporary, 'dist-electron/main.js'), selections = path.join(temporary, 'selections.json'), evidence = path.resolve('docs/verification/external-documents');
const checks = [], prompts = []; let session, sourceConfig, sourceHash, selectedModel;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : {}; res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'document-fixture' }] }));
  if (req.url.endsWith('/api/ps')) return res.end(JSON.stringify({ models: [] }));
  if (req.url.endsWith('/api/show')) return res.end(JSON.stringify({ model_info: { 'model.context_length': 32768 } }));
  if (req.url.endsWith('/api/generate')) { prompts.push(input.prompt); return res.end(JSON.stringify({ response: '经审阅的企业对账说明', done: true })); }
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const directory of [userData, original, library, destination, path.dirname(mainEntry), evidence]) await fs.mkdir(directory, { recursive: true });
  let png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(original, '凭证 空格.png'), png);
  const source = path.join(original, '客户 对账.md'), text = '# 对账确认\n\n企业已核实对账金额。\n\n![凭证](<凭证 空格.png>)\n![引用][票]\n\n[票]: <凭证 空格.png> "对账凭证"\n\n<img src="凭证 空格.png">\n\n[下一份](下一份.txt)';
  await fs.writeFile(source, text); await fs.writeFile(path.join(original, '下一份.txt'), '下一份待确认文件');
  await fs.writeFile(path.join(library, '企业授信.md'), '# 企业授信\n\n显式补充资料 ONLY_EXPLICIT_LIBRARY');
  const profile = { id: 'model_document_fixture', label: 'Document fixture', config: { kind: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'document-fixture', contextWindowTokens: 32768, contextWindowTokensSource: 'user' } };
  const config = { workspacePath: path.join(fixture, 'workspace'), onboarding: { version: 1, status: 'skipped' }, aiModelSettings: { defaultProfileId: profile.id, profiles: [profile] }, appPreferences: { defaultEditorMode: 'source', theme: 'light', language: 'zh-CN' }, libraries: [{ path: library, alias: '企业验收库', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }], libraryPath: library, activeLibraryPath: library };
  if (real) {
    sourceConfig = process.env.TRELLORA_DOCUMENT_CONFIG_PATH || path.join(process.env.APPDATA, 'Electron/config.json');
    const bytes = await fs.readFile(sourceConfig); sourceHash = hash(bytes); const current = JSON.parse(bytes.toString());
    const selected = current.aiModelSettings?.profiles.find(item => item.id === current.aiModelSettings.defaultProfileId && item.config.model && current.aiProfileSecrets?.[item.id]);
    assert.ok(selected, 'real configured model is required'); selectedModel = selected.config.model;
    await fs.copyFile(path.join(path.dirname(sourceConfig), 'Local State'), path.join(userData, 'Local State'));
    config.aiModelSettings = { defaultProfileId: selected.id, profiles: [selected] }; config.aiProfileSecrets = { [selected.id]: current.aiProfileSecrets[selected.id] };
  }
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify(config)); await fs.writeFile(selections, JSON.stringify({ open: source }));
  const harness = path.join(temporary, 'harness.ts');
  await fs.writeFile(harness, `import ${JSON.stringify(path.resolve('electron/main.ts').replaceAll('\\', '/'))};
import { dialog } from 'electron'; import fs from 'node:fs';
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(selections)}, 'utf8'));
dialog.showOpenDialog = (async () => { const s = read(); return { canceled: !s.open, filePaths: s.open ? [s.open] : [] }; }) as any;
dialog.showSaveDialog = (async () => ({ canceled: !read().save, filePath: read().save })) as any;
dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any;`);
  await Promise.all([
    build({ entryPoints: [harness], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    ...['preload', 'externalWebPreload', 'knowledge/noteIndexWorker', 'pipeline/mammothWorker', 'workspaceMigrationWorker'].map(entry => build({ entryPoints: [`electron/${entry}.ts`], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: path.join(path.dirname(mainEntry), `${path.basename(entry)}.js`), logLevel: 'silent' })),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData }); await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // A visible, synthetic voucher makes protocol rendering reviewable in screenshots.
  const pngData=await session.evaluate("(() => {const c=document.createElement('canvas');c.width=480;c.height=110;const x=c.getContext('2d');x.fillStyle='#eef8f1';x.fillRect(0,0,480,110);x.strokeStyle='#aacdb9';x.strokeRect(1,1,478,108);x.fillStyle='#1c6652';x.font='20px sans-serif';x.fillText('企业对账凭证（验收样例）',16,35);x.font='15px sans-serif';x.fillText('编号 TEST-20261003   金额 ¥1,280.00',16,65);x.fillText('合成测试数据，无真实业务信息',16,90);return c.toDataURL('image/png').split(',')[1];})()");
  png=Buffer.from(pngData,'base64');await fs.writeFile(path.join(original,'凭证 空格.png'),png);
  await session.evaluate('window.__alerts=[]; window.alert=x=>window.__alerts.push(x); window.confirm=()=>true');
  await shortcut('o'); await external(source); await mode('预览');
  await waitFor(() => session.evaluate("document.querySelectorAll('.external-document img').length===3 && [...document.querySelectorAll('.external-document img')].every(x=>x.naturalWidth===480 && x.src.startsWith('trellora-resource:'))"), 'actual opaque protocol image loads');
  const oldUrl = await session.evaluate("document.querySelector('.external-document img').src");
  if (!real) await capture('resources-preview.png');
  record('real protocol displays inline, reference and HTML Chinese-space images without library assets');
  await session.evaluate("document.querySelector('[data-external-document-href]').click()"); await external(path.join(original, '下一份.txt'));
  assert.equal(await session.evaluate(`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=${JSON.stringify(oldUrl)};})`), true);
  await shortcut('o'); await external(source); record('Chinese local text link enters ordinary open flow; closed session image token is rejected');
  await mode('源码');
  await session.evaluate("document.querySelector('.external-document .cm-content').focus()");
  await shortcut('a');
  await session.evaluate(`(() => { const transfer=new DataTransfer(); transfer.items.add(new File([new Uint8Array(${JSON.stringify([...png])})], 'clipboard.png', {type:'image/png'})); document.querySelector('.external-document .cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true})); })()`);
  await waitFor(() => session.evaluate("document.querySelector('.external-document .cm-content').textContent.includes('trellora-draft:')"), 'private image paste');
  const dropPoint=await session.evaluate("(() => {const r=document.querySelector('.external-document .cm-content').getBoundingClientRect();return{x:r.x+80,y:r.y+20};})()");
  for(const type of ['dragEnter','dragOver','drop'])await session.send('Input.dispatchDragEvent',{type,...dropPoint,data:{items:[],files:[path.join(original,'凭证 空格.png')],dragOperationsMask:1}});
  await waitFor(()=>session.evaluate("(document.querySelector('.external-document .cm-content').textContent.match(/trellora-draft:/g)||[]).length===2"),'native image drop remains in private draft');
  assert.equal(await fs.readFile(source, 'utf8'), text); assert.equal((await fs.readdir(original)).some(name => name.endsWith('.assets')), false);
  await shortcut('s'); await waitFor(() => session.evaluate("document.querySelector('.external-save-notice').dataset.status==='clean'"), 'image saved');
  const savedText = await fs.readFile(source, 'utf8'); assert.match(decodeURIComponent(savedText), /客户 对账.assets/); assert.equal(savedText.includes('trellora-draft:'), false);
  await mode('预览'); await waitFor(() => session.evaluate("[...document.querySelectorAll('.external-document img')].some(x=>x.naturalWidth===480)"), 'published pasted image');
  record('actual source clipboard paste and native image drop remain private until manual save and render after publication');
  const target = path.join(destination, '另存 中文.md'); await fs.writeFile(selections, JSON.stringify({ save: target })); await shortcut('s', true); await external(target);
  assert.equal(await fs.readFile(source, 'utf8'), savedText); assert.ok((await fs.readdir(path.join(destination, '另存 中文.assets'))).length > 0);
  record('real save-as publishes copied image references and preserves original');
  const targetBeforeAi = await fs.readFile(target, 'utf8');
  await mode('源码'); await edit('企业已核实对账金额。'); await shortcut('a');
  await session.evaluate("document.querySelector('[aria-label=\"当前文档 AI\"]').click()");
  await aiClick('生成建议'); await waitFor(async () => { const error=await session.evaluate("document.querySelector('.external-ai-panel [role=alert]')?.textContent"); if(error)throw new Error(error); return session.evaluate("Boolean(document.querySelector('.external-ai-result')?.textContent)"); }, 'document AI result', 150_000);
  assert.equal(await fs.readFile(target, 'utf8'), targetBeforeAi);
  if (!real) { assert.equal(prompts.length, 1); assert.equal(prompts[0].includes('ONLY_EXPLICIT_LIBRARY'), false); }
  const answer = await session.evaluate("document.querySelector('.external-ai-result').textContent"); assert.ok(answer.trim());
  if (!real) await capture('document-ai.png');
  await aiClick('应用到选区'); await waitFor(() => session.evaluate(`!document.querySelector('.external-ai-result') && document.querySelector('.external-document .cm-content').textContent===${JSON.stringify(answer)}`), 'AI applied to draft'); await delay(200);
  assert.equal(await fs.readFile(target, 'utf8'), targetBeforeAi);
  record(real ? 'real configured model produces a reviewed selection rewrite; explicit apply changes draft only' : 'actual UI rewrite uses current selection only and explicit apply never saves original');
  await session.evaluate("document.querySelector('.external-document .cm-content').focus()"); await shortcut('a'); await aiClick('生成建议');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.external-ai-result'))"), 'second AI result', 150_000);
  await edit('用户继续输入的新正文'); await aiClick('应用到选区');
  await waitFor(() => session.evaluate("document.querySelector('.external-ai-panel [role=alert]')?.textContent.includes('已变化')"), 'stale AI rejected');
  assert.equal(await session.evaluate("document.querySelector('.external-document .cm-content').textContent"), '用户继续输入的新正文'); assert.ok(await session.evaluate("Boolean(document.querySelector('.external-ai-result'))"));
  record('actual continued typing rejects old AI writeback and preserves readable suggestion');
  if (!real) {
    await session.evaluate("document.querySelector('[aria-label=\"文档 AI 操作\"]').click()"); await waitFor(() => session.evaluate("[...document.querySelectorAll('[role=option]')].some(x=>x.textContent==='文档问答')"), 'AI action select');
    await session.evaluate("[...document.querySelectorAll('[role=option]')].find(x=>x.textContent==='文档问答').click()");
    await session.evaluate("(() => { const x=document.querySelector('[aria-label=\"文档问题\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(x,'企业授信需要什么资料？'); x.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await session.evaluate("document.querySelector('[aria-label=\"补充笔记库\"]').click()"); await waitFor(() => session.evaluate("[...document.querySelectorAll('[role=option]')].some(x=>x.textContent==='企业验收库')"), 'explicit library choice');
    await session.evaluate("[...document.querySelectorAll('[role=option]')].find(x=>x.textContent==='企业验收库').click()"); const count = prompts.length; await aiClick('生成建议');
    await waitFor(() => prompts.length > count, 'explicit library prompt'); assert.ok(prompts.at(-1).includes('ONLY_EXPLICIT_LIBRARY')); record('explicit supplementary library appears only after user selects it');
  }
  await edit(targetBeforeAi + '\n待加入笔记库的资源草稿');
  await session.evaluate("[...document.querySelectorAll('.external-document button')].find(x=>x.textContent==='加入笔记库').click()");
  await waitFor(()=>session.evaluate("Boolean(document.querySelector('[role=dialog] input'))"),'join library selector');
  await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent==='确定').click()");
  await waitFor(()=>session.evaluate("!document.querySelector('.external-document') && document.querySelector('.knowledge-note-path')?.textContent==='另存 中文.md'"),'resource document routed to original note editor');
  const joinedText=await fs.readFile(path.join(library,'另存 中文.md'),'utf8'); assert.ok(joinedText.includes('待加入笔记库的资源草稿')); assert.ok((await fs.readdir(path.join(library,'另存 中文.assets'))).length>0); assert.equal(await fs.readFile(target,'utf8'),targetBeforeAi);
  record('actual library transfer copies resource and current draft, opens original note editor and preserves external original');
  const {data}=await session.send('Page.captureScreenshot',{format:'png'}); await fs.writeFile(path.join(evidence, real ? 'ai-real.png' : 'resources-ai-ui.png'),Buffer.from(data,'base64'));
  await session.closeWindow(); await session.exited; await session.dispose(); session=undefined;
  if (real) assert.equal(hash(await fs.readFile(sourceConfig)), sourceHash);
  const sqliteFiles = []; const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const name=path.join(directory,entry.name);if(entry.isDirectory())await walk(name);else if(/\.db$/.test(entry.name))sqliteFiles.push(name);}}; await walk(path.join(fixture,'workspace'));
  await command('python', ['-c', `import sqlite3,json\nfor file in json.loads(${JSON.stringify(JSON.stringify(sqliteFiles))}):\n db=sqlite3.connect('file:'+file.replace('\\\\','/')+'?mode=ro',uri=True)\n for table in ['qa_turns','memory_extraction_jobs']:\n  if db.execute('SELECT name FROM sqlite_master WHERE name=?',(table,)).fetchone():\n   assert db.execute('SELECT count(*) FROM '+table).fetchone()[0]==0,table\n db.close()`]);
  record('no automatic conversation or memory extraction; original model configuration unchanged');
  await fs.writeFile(path.join(evidence, real ? 'ai-real.json' : 'resources-ai-electron.json'), JSON.stringify({date:new Date().toISOString(),realModel:real,model:selectedModel,electron:'31.7.7',checks,originalConfigUnchanged:real?true:undefined,developmentBundle:true,packaged:false},null,2));
} catch(error){ console.error(error,session?.diagnostics()); if(session)console.error(await session.evaluate('JSON.stringify({alerts:window.__alerts,body:document.body.innerText.slice(0,2500),images:[...document.querySelectorAll(".external-document img")].map(x=>({src:x.src,width:x.naturalWidth})),html:document.querySelector(".preview-content")?.innerHTML})').catch(String)); throw error; }
finally { await session?.dispose(); await new Promise(resolve=>server.close(resolve)); assert.equal(path.dirname(temporary),staging);await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:250});assert.equal(path.dirname(fixture),path.resolve(os.tmpdir()));await fs.rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:250}); }
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
function record(text){checks.push(text);console.log(`PASS ${text}`);}
async function capture(name){const {data}=await session.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name),Buffer.from(data,'base64'));}
async function shortcut(key,shift=false){await session.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code:`Key${key.toUpperCase()}`,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:2+(shift?8:0)});await session.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:`Key${key.toUpperCase()}`,windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:2});}
async function external(file){await waitFor(()=>session.evaluate(`document.querySelector('.external-document-name p:last-child')?.textContent===${JSON.stringify(file)} && !document.querySelector('.external-document').dataset.documentBusy`),`external ${file}`);}
async function mode(label){await session.evaluate(`[...document.querySelectorAll('.external-document .segmented-control button')].find(x=>x.textContent===${JSON.stringify(label)}).click()`);await delay(200);}
async function edit(text){await mode('源码');await session.evaluate("document.querySelector('.external-document .cm-content').focus()");await shortcut('a');await session.send('Input.insertText',{text});await waitFor(()=>session.evaluate("document.querySelector('.external-save-notice').dataset.status==='dirty'"),'dirty document');}
async function aiClick(label){await session.evaluate(`[...document.querySelectorAll('.external-ai-panel button')].find(x=>x.textContent===${JSON.stringify(label)}).click()`);}
