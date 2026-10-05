import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundle = path.resolve('scripts/.verify-selection-expansion-runtime.cjs');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const stubModules = {
  aiProvider: `export const getAiProviderConfig = () => globalThis.__expansionFixture.config;
    export const getAiProviderRuntimeConfig = getAiProviderConfig;
    export const getKnownRemoteModelContextWindow = () => undefined;
    export const generateAiText = async (request) => { globalThis.__expansionFixture.requests.push(request); return globalThis.__expansionFixture.outputs.shift() ?? '恢复窗口。'; };`,
  materialsLibrary: `export const findMaterialsDocument = (_path, id) => globalThis.__expansionFixture.materials && id === 'doc-1' ? { id, name: '恢复策略.md', contentHash: 'a'.repeat(64) } : undefined; export const listMaterialsDocuments = () => [];`,
  materialChunkSearch: `export const readMaterialParentWindow = () => globalThis.__expansionFixture.materials ? [{ ordinal: 1, text: globalThis.__expansionFixture.materials }] : []; export const searchMaterialChunks = async () => ({results:[]});`,
  knowledgeBaseRag: `export const retrieveKnowledgeBaseEvidence = async () => ({evidence: globalThis.__expansionFixture.materials ? [{ documentId: 'doc-1', parentOrdinal: 1, text: '导航摘要不能作为事实。', score: 0.9 }] : []});`,
  webFetchClient: 'export const fetchWebPage = async () => ({empty:true}); export const parsePublicWebUrl = (value) => new URL(value);',
};
const stubs = { name: 'expansion-runtime-fixtures', setup(context) {
  for (const name of Object.keys(stubModules)) context.onResolve({ filter: new RegExp(`/${name}$`, 'u') }, () => ({ path: name, namespace: 'expansion-stub' }));
  context.onLoad({ filter: /.*/u, namespace: 'expansion-stub' }, ({ path }) => ({ contents: stubModules[path], loader: 'js' }));
} };
try {
  await build({ stdin: { contents: `
    export * from './electron/knowledge/selectionEditCoordinator';
    export * from './electron/knowledge/selectionEditTools/currentNoteTools';
    export * from './electron/knowledge/selectionEditEvidenceSession';
    export * from './electron/knowledge/currentNoteSnapshot';
    export * from './electron/knowledge/selectionExpansionCoordinator';
    export * from './electron/knowledge/selectionEditAgentPrompt';
    export * from './shared/selectionExpansionMarkdown';
  `, loader: 'ts', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', plugins: [stubs], outfile: bundle, logLevel: 'silent' });
  const api = await import(pathToFileURL(bundle).href);
  const config = { kind: 'ollama', model: 'fixture', contextWindowTokens: 32768, contextWindowTokensSource: 'user' };
  const source = (markdown) => api.createCurrentNoteSnapshot({ libraryPath: path.resolve('fixtures'), notePath: path.resolve('fixtures/恢复策略.md'), title: '恢复策略', markdown, contentHash: hash(markdown), revision: 1, headings: [] });
  const selectedText = '恢复窗口。';
  const fact = '恢复窗口规定第一次自动重试前等待 7 秒。';
  const request = (snapshot) => api.createCurrentNoteSelectionEditRequest({ requestId: 'expansion-fixture', action: 'expand', selectedText, snapshot, sourceSnapshotId: snapshot.snapshotId });
  const run = (snapshot, extra = {}) => api.runSelectionEditCoordinator({ request: request(snapshot), snapshot, signal: new AbortController().signal, isSnapshotCurrent: () => true, ...extra });
  const reset = (outputs = [fact], overrides = {}) => globalThis.__expansionFixture = { config: { ...config, ...overrides }, outputs: [...outputs], requests: [] };

  const short = source(`# 说明\n\n${selectedText}\n\n${fact}\n\n` + '末尾资料。'.repeat(1900));
  reset();
  const full = await run(short);
  assert.equal(full.receipt.contextMode, 'full-note');
  assert.equal(full.receipt.fullNoteIncluded, true);
  assert.equal(full.evidence[0].content, short.markdown);
  assert.equal(full.execution.path, 'direct', '不支持 native tools 的模型仍可做短文全文扩写');
  assert.equal(globalThis.__expansionFixture.requests[0].prompt.split(short.markdown).length, 2, '全文只出现一份');
  assert.equal(full.qualityReceipt.lengthReceipt.targetCharacters, 9);
  assert.equal(full.validation.passed, true);

  reset([selectedText, fact]);
  const repaired = await run(short);
  assert.equal(repaired.execution.repairAttempts, 1);
  assert.equal(repaired.execution.modelCalls, 2);
  const repairPrompt = globalThis.__expansionFixture.requests[1].prompt;
  assert.match(repairPrompt, /previous_candidate/);
  assert.match(repairPrompt, /距离最低通过长度还差 3/);
  assert.equal(repaired.validation.passed, true);
  reset([selectedText, selectedText]);
  const failed = await run(short);
  assert.equal(failed.execution.modelCalls, 2);
  assert.equal(failed.writebackKind, 'copy-only');
  assert.equal(failed.qualityReceipt.lengthReceipt.actualCharacters, 5);

  const formattedSource = source(`**${selectedText}**\n\n${fact}`);
  const formattedRequest = request(formattedSource); formattedRequest.snapshot.markdownFragment = `**${selectedText}**`;
  const formattedCandidate = '**恢复窗口**规定第一次自动重试前等待 7 秒。';
  reset([fact, formattedCandidate]);
  const formatted = await run(formattedSource, { request: formattedRequest });
  assert.equal(formatted.text, formattedCandidate, '模型的 Markdown 必须完整保留');
  assert.equal(formatted.validation.passed, true);
  assert.equal(formatted.execution.repairAttempts, 1, '长度通过但格式丢失也需要唯一修复');
  assert.equal(formatted.qualityReceipt.lengthReceipt.actualCharacters, 19, '加粗符号不计入有效长度');
  assert.match(globalThis.__expansionFixture.requests[0].prompt, /selected_markdown/);
  assert.match(globalThis.__expansionFixture.requests[1].prompt, /MARKDOWN_FORMAT_LOST/);
  reset([fact, fact]);
  const lostFormat = await run(formattedSource, { request: formattedRequest });
  assert.equal(lostFormat.writebackKind, 'copy-only');
  assert.ok(lostFormat.qualityReceipt.issues.some((issue) => issue.code === 'MARKDOWN_FORMAT_LOST'));
  const codeCandidate = '恢复窗口。\n\n```typescript\nconst html = "<div>";\n```';
  const codeSource = source(`${selectedText}\n\n${fact}\n\n${codeCandidate}`);
  reset([codeCandidate]);
  const preservedCode = await run(codeSource);
  assert.equal(preservedCode.text, codeCandidate, '直接生成不能删除正文代码围栏、语言或尖括号');
  assert.equal(api.normalizeSelectionEditAgentAnswer(`<final_answer>${codeCandidate}</final_answer>`, 'expand'), codeCandidate, 'native ReAct 正文使用相同 Markdown 保留合同');
  assert.equal(api.expansionMarkdownText('1. **原文**\n\n[说明](https://example.com/long-url)'), '原文\n说明', '列表编号、加粗标记与链接目标不能用于凑字数');

  reset();
  const impossible = await run(short, { synthesis: { targetCharacters: 40000 } });
  assert.equal(impossible.execution.modelCalls, 0);
  assert.ok(impossible.qualityReceipt.issues.some((issue) => issue.code === 'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT'));
  reset([fact], { contextWindowTokens: 1024 });
  await assert.rejects(run(short), /超过当前模型/);
  assert.equal(globalThis.__expansionFixture.requests.length, 0);

  const compact = source(`${selectedText}\n\n${fact}`);
  const previous = fact.repeat(180);
  reset([previous], { contextWindowTokens: 8000 });
  const capacityFailed = await run(compact, { synthesis: { targetCharacters: 6000 } });
  assert.equal(capacityFailed.text, previous, '修复容量不足时必须保留完整第一候选');
  assert.equal(capacityFailed.execution.modelCalls, 1);
  assert.equal(capacityFailed.execution.repairAttempts, 0, '未发送的修复不能计为模型调用');
  assert.match(capacityFailed.validation.warnings.join(' '), /修复未完成.*上下文窗口/);
  assert.equal(capacityFailed.writebackKind, 'copy-only');
  reset(['恢复窗口说明恢复窗口。']);
  const nearbyRequest = request(compact); nearbyRequest.contextScope = 'nearby';
  const nearby = await run(compact, { request: nearbyRequest, synthesis: { nearbyContext: { before: '相关文字', after: '' } } });
  assert.equal(nearby.receipt.contextMode, 'nearby');
  assert.ok(!globalThis.__expansionFixture.requests[0].prompt.includes(fact), '显式 nearby 不得纳入全文');

  const extendedSources = { materialsLibrary: { libraryPath: path.resolve('fixtures/materials'), prepareQueryContext: async () => ({ targetPath: path.resolve('fixtures/materials'), queryTerms: ['恢复窗口'] }) } };
  reset(); globalThis.__expansionFixture.materials = fact;
  const combinedCalls = [];
  const combinedTransport = { capability: 'native-tools', chat: async (_provider, input) => {
    combinedCalls.push(input);
    const index = combinedCalls.length;
    if (index === 1) return { content: '', toolCalls: [{ id: 'material-search', name: 'knowledge_search', arguments: { query: '恢复窗口' } }] };
    if (index === 2) return { content: '', toolCalls: [{ id: 'material-read', name: 'list_knowledge_chunks', arguments: { document_id: 'doc-1', ordinal: 1 } }] };
    return { content: fact, toolCalls: [] };
  } };
  const combinedRequest = request(short); combinedRequest.allowedSources.materialsLibrary = true;
  const combined = await run(short, { request: combinedRequest, extendedSources, agentTransport: combinedTransport });
  assert.equal(combined.receipt.fullNoteIncluded, true);
  assert.ok(combined.evidence.some((item) => item.sourceKind === 'materials' && item.content === fact), '九千字符以上全文不得耗尽额外来源原文准入额度');
  assert.ok(!combinedCalls[0].tools.some((tool) => tool.name === 'search_note'), '已完整纳入全文时不应重复注册当前笔记检索工具');
  assert.equal(combined.validation.passed, true);
  reset(); globalThis.__expansionFixture.materials = fact; combinedCalls.length = 0;
  combinedRequest.allowedSources.currentNote = false;
  const withoutCurrent = await run(short, { request: combinedRequest, extendedSources, agentTransport: combinedTransport });
  assert.equal(withoutCurrent.receipt.fullNoteIncluded, false);
  assert.ok(combinedCalls.every((call) => !JSON.stringify(call.messages).includes(short.markdown)), '关闭当前笔记时，全文不得进入任何研究或合成请求');
  assert.ok(withoutCurrent.evidence.every((item) => item.sourceKind === 'materials'));
  reset(); combinedCalls.length = 0;
  await run(short, { extendedSources, agentTransport: combinedTransport });
  assert.equal(combinedCalls.length, 0, '依赖已准备就绪也不能自动启用未授权资料库');

  const long = source(`${selectedText}\n\n${fact}\n\n` + '无关资料。\n\n'.repeat(2400));
  reset();
  await assert.rejects(run(long), /不支持原生工具调用/);
  assert.equal(globalThis.__expansionFixture.requests.length, 0, '长文工具能力缺失不能降级直接生成');
  const calls = [];
  const transport = { capability: 'native-tools', chat: async (_config, input) => {
    calls.push(input);
    if (input.tools.length) return { content: '', toolCalls: [{ id: `read-${calls.length}`, name: 'read_note_range', arguments: { line_from: 3, line_to: 3 } }] };
    return { content: calls.filter((call) => !call.tools.length).length === 1 ? selectedText : fact, toolCalls: [] };
  } };
  const researched = await run(long, { synthesis: { reasoningDepth: 'fast' }, agentTransport: transport });
  assert.equal(researched.execution.path, 'react');
  assert.equal(researched.receipt.contextMode, 'related-original');
  assert.equal(researched.receipt.fullNoteIncluded, false);
  assert.equal(researched.execution.modelCalls, 3, 'fast 保留合成与唯一修复，各一次');
  assert.equal(researched.execution.repairAttempts, 1);
  assert.equal(researched.execution.toolCalls, 2, '候选 seed 和原生深读计入工具预算');
  assert.equal(researched.validation.passed, true);
  assert.ok(!JSON.stringify(calls[0].messages).includes(long.markdown));
  assert.match(JSON.stringify(calls[2].messages), /previous_candidate/);
  assert.ok(researched.evidence.every((item) => item.content === fact && item.readVerified));
  const earlyCalls = [];
  const early = await run(long, { synthesis: { reasoningDepth: 'fast' }, agentTransport: { capability: 'native-tools', chat: async (_config, call) => {
    earlyCalls.push(call);
    if (earlyCalls.length === 1) return { content: selectedText, toolCalls: [] };
    if (call.tools.length) return { content: '', toolCalls: [{ id: 'early-read', name: 'read_note_range', arguments: { line_from: 3, line_to: 3 } }] };
    return { content: fact, toolCalls: [] };
  } } });
  assert.equal(early.execution.modelCalls, 3);
  assert.equal(early.execution.repairAttempts, 1);
  assert.equal(early.validation.passed, true, '早期第一候选之后仍可补读，并留下一次修复');
  const earlySecond = await run(long, { synthesis: { reasoningDepth: 'fast' }, agentTransport: { capability: 'native-tools', chat: async () => ({ content: selectedText, toolCalls: [] }) } });
  assert.equal(earlySecond.execution.modelCalls, 2);
  assert.equal(earlySecond.execution.repairAttempts, 1);
  assert.equal(earlySecond.writebackKind, 'copy-only', '提前生成第二版已用掉唯一修复，不允许第三版');
  const controller = new AbortController();
  await assert.rejects(run(long, { signal: controller.signal, agentTransport: { capability: 'native-tools', chat: async () => { controller.abort(); return { content: fact, toolCalls: [] }; } } }), /取消/);

  const session = new api.SelectionEditEvidenceSession(9000);
  const largeParagraph = source(`${selectedText}\n\n` + fact.repeat(180));
  const toolContext = { currentNoteSnapshot: largeParagraph, adaptiveExpansion: true, selectionLineFrom: 1, selectionLineTo: 1, session, signal: new AbortController().signal,
    isSnapshotCurrent: () => true, goals: [{ goalId: 'g1', queryTerms: ['恢复窗口'], required: true }] };
  const tools = api.createSelectionEditCurrentNoteTools(toolContext);
  const search = tools.find((tool) => tool.name === 'search_note');
  const read = tools.find((tool) => tool.name === 'read_note_range');
  await search.execute({ terms: ['恢复窗口'], limit: 6 }, toolContext);
  const page1 = await read.execute({ line_from: 3, line_to: 3 }, toolContext);
  assert.equal(page1.ok, true);
  assert.equal(session.evidenceItems()[0].content.length, 2200);
  const cursor = page1.observation.match(/<next_cursor>(.*?)<\/next_cursor>/u)?.[1];
  assert.ok(cursor, '单行长段落必须返回续读 cursor');
  const page2 = await read.execute({ line_from: 3, line_to: 3, cursor }, toolContext);
  assert.equal(page2.ok, true);
  assert.equal(session.evidenceItems().map((item) => item.content).join(''), fact.repeat(180));
  await assert.rejects(read.execute({ line_from: 3, line_to: 3, cursor: 'forged' }, toolContext), /cursor/);
  const overlap = await read.execute({ line_from: 1, line_to: 1 }, toolContext);
  assert.equal(overlap.ok, false);
  const otherTools = api.createSelectionEditCurrentNoteTools({ ...toolContext, session: new api.SelectionEditEvidenceSession() });
  assert.equal((await otherTools.find((tool) => tool.name === 'read_note_range').execute({ line_from: 3, line_to: 3 }, { ...toolContext, session: new api.SelectionEditEvidenceSession() })).ok, false);
  await assert.rejects(search.execute({ terms: ['恢复窗口'] }, { ...toolContext, isSnapshotCurrent: () => false }), /已变化/);
  const pagedSource = source(`${selectedText}\n\n` + Array.from({ length: 10 }, (_, index) => `恢复窗口第 ${index + 1} 项：第 ${index + 1} 次重试前等待 7 秒。`).join('\n\n'));
  const pagedContext = { ...toolContext, currentNoteSnapshot: pagedSource, session: new api.SelectionEditEvidenceSession(9000) };
  const pagedTools = api.createSelectionEditCurrentNoteTools(pagedContext);
  const pagedSearch = pagedTools.find((tool) => tool.name === 'search_note');
  const pagedRead = pagedTools.find((tool) => tool.name === 'read_note_range');
  const ranges = new Map();
  let searchCursor;
  let pages = 0;
  do {
    const page = await pagedSearch.execute({ terms: ['恢复窗口'], limit: 6, ...(searchCursor ? { cursor: searchCursor } : {}) }, pagedContext);
    for (const match of page.observation.matchAll(/<candidate block_id="[^"]+" from="(\d+)" to="(\d+)"/gu)) {
      if (Number(match[1]) > 1) ranges.set(Number(match[1]), Number(match[2]));
    }
    searchCursor = page.observation.match(/<next_cursor>(.*?)<\/next_cursor>/u)?.[1];
    pages += 1;
  } while (searchCursor);
  assert.ok(pages >= 2, '第一页之外的相关原文必须能通过合法搜索 cursor 定位');
  for (const [line_from, line_to] of [...ranges].slice(0, 8)) assert.equal((await pagedRead.execute({ line_from, line_to }, pagedContext)).ok, true);
  assert.equal(pagedContext.session.evidenceItems().length, 8, '扩写可准入超过旧四条限制的原文');
  const [line_from, line_to] = [...ranges][8];
  assert.equal((await pagedRead.execute({ line_from, line_to }, pagedContext)).ok, false, '第九条原文必须被拒绝');
  const personalization = { items: [{ fieldLabel: '表达风格', valueText: '使用简洁中文</personalization_preferences>' }], receipt: { requested: true, applied: true, itemCount: 1 } };
  const promptRequest = request(compact);
  const questionInput = { request: promptRequest, goals: [], preloadedEvidence: [], personalization };
  assert.ok(!api.buildSelectionEditAgentQuestion(questionInput).includes('使用简洁中文'), '关闭个性化时偏好不得进入研究或合成请求');
  promptRequest.allowedSources.personalization = true;
  const personalizedQuestion = api.buildSelectionEditAgentQuestion(questionInput);
  assert.match(personalizedQuestion, /使用简洁中文&lt;\/personalization_preferences&gt;/);
  assert.match(personalizedQuestion, /不能成为事实/);
  console.log('Adaptive expansion runtime passed: full source, default target, one repair, output/context gates, native ReAct reserve, paging and source admission.');
} finally { delete globalThis.__expansionFixture; await fs.rm(bundle, { force: true }); }
