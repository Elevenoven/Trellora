import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-selection-edit-agent-runtime');
const bundlePath = path.join(outDir, 'selection-edit-agent-runtime.cjs');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const stubs = {
  name: 'selection-edit-agent-runtime-stubs',
  setup(context) {
    const resolve = (filter, name) => context.onResolve({ filter }, () => ({ path: name, namespace: 'selection-edit-agent-runtime-stub' }));
    resolve(/materialsLibrary$/u, 'materials-library');
    resolve(/pipeline\/materialChunkSearch$/u, 'material-chunk-search');
    resolve(/knowledgeBaseRag$/u, 'knowledge-base-rag');
    resolve(/websearch\/webFetchClient$/u, 'web-fetch-client');
    resolve(/aiProvider$/u, 'ai-provider');
    resolve(/reactAgent\/reactChatTransport$/u, 'react-chat-transport');
    context.onLoad({ filter: /.*/u, namespace: 'selection-edit-agent-runtime-stub' }, (args) => ({
      loader: 'js',
      contents: {
        'materials-library': `
          export const findMaterialsDocument = (_path, id) => id === 'doc-1'
            ? { id: 'doc-1', name: '恢复策略.md', contentHash: 'h'.repeat(64), vectorState: 'indexed' }
            : undefined;
          export const listMaterialsDocuments = () => [{ id: 'doc-1', name: '恢复策略.md', contentHash: 'h'.repeat(64), vectorState: 'indexed' }];
        `,
        'material-chunk-search': `
          export const searchMaterialChunks = async () => ({ results: [{
            documentId: 'doc-1', ordinal: 3, text: '恢复窗口候选摘要。', score: 0.81,
            citation: { parent: { ordinal: 3, text: '恢复窗口候选摘要。' } },
          }] });
          export const readMaterialParentWindow = () => [{ ordinal: 3, text: '恢复窗口规定第一次自动重试前等待 7 秒。' }];
        `,
        'knowledge-base-rag': `
          export const retrieveKnowledgeBaseEvidence = async () => ({ evidence: [{
            documentId: 'doc-1', parentOrdinal: 3, text: '恢复窗口候选摘要。', score: 0.92,
          }] });
        `,
        'web-fetch-client': `
          export const parsePublicWebUrl = (value) => new URL(value);
          export const fetchWebPage = async ({ url }) => ({
            empty: false,
            title: '发布策略公告',
            text: '发布策略规定出现异常后先完成受控回滚，再重新验证恢复窗口与重试条件。'.repeat(8),
            url,
          });
        `,
        'ai-provider': `export const getAiProviderConfig = () => ({ kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'test', model: 'test' });`,
        'react-chat-transport': `export const createReActChatTransport = () => undefined;`,
      }[args.path],
    }));
  },
};

try {
  await build({
    stdin: {
      contents: [
        `export { runSelectionEditAgentRuntime, resolveSelectionEditAgentBudget } from './electron/knowledge/selectionEditAgentRuntime.ts';`,
        `export { resolveSelectionEditResearchMode } from './electron/knowledge/selectionEditResearchMode.ts';`,
        `export { createCurrentNoteSnapshot } from './electron/knowledge/currentNoteSnapshot.ts';`,
        `export { createLibraryNoteSnapshotMap } from './electron/knowledge/libraryNoteSnapshot.ts';`,
      ].join('\n'),
      resolveDir: rootDir,
      sourcefile: 'verify-selection-edit-agent-runtime-entry.ts',
    },
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [stubs],
  });
  const runtime = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  let checks = 0;
  const equal = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks += 1;
  };
  const ok = (condition, label) => {
    assert.ok(condition, label);
    checks += 1;
  };
  const config = { kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'test', model: 'test' };
  const materialRuntime = {
    libraryPath: 'C:/materials',
    prepareQueryContext: async (query) => ({ targetPath: 'C:/materials', queryTerms: [query] }),
  };
  const makeRequest = (allowedSources, selectedText = '恢复窗口。', action = 'expand') => ({
    requestId: 'selection-agent-runtime-0001',
    action,
    sourceSnapshotId: 'snapshot-1',
    contextScope: 'extended',
    allowedSources: { currentNote: true, noteLibrary: false, materialsLibrary: false, web: false, personalization: false, ...allowedSources },
    outputPreference: action === 'expand' || action === 'explain' ? 'insert-below' : 'replace',
    snapshot: {
      editorSessionId: 'editor-1', libraryId: 'library-1', currentPath: 'C:/notes/test.md', docRevision: 1,
      noteContentHash: 'n'.repeat(64), from: 0, to: selectedText.length, selectedText, selectedTextHash: 's'.repeat(64),
      markdownFragment: selectedText, sliceJson: null, canonicalSliceJson: 'null', selectionStructureSignature: 'paragraph',
      documentStructureSignature: 'document', lineFrom: 1, lineTo: 1, headingPath: [], blockKinds: ['paragraph'],
      rect: { left: 0, top: 0, right: 1, bottom: 1 },
    },
  });
  const goals = [{ goalId: 'goal-1', kind: 'definition', question: '恢复窗口的定义与等待条件', queryTerms: ['恢复窗口'], required: true }];
  const makeTransport = (responses) => {
    const calls = [];
    return {
      calls,
      transport: {
        capability: 'native-tools',
        chat: async (_config, request) => {
          calls.push({
            tools: request.tools.map((tool) => tool.name),
            messages: request.messages.map((message) => ({ role: message.role, content: message.content, toolName: message.toolName })),
          });
          const response = responses.shift();
          if (!response) throw new Error('脚本化 Agent 响应耗尽');
          return response;
        },
      },
    };
  };
  const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  const makeIndexedNote = (notePath, title, markdown) => ({
    path: notePath,
    title,
    kind: 'markdown',
    extension: '.md',
    rawMarkdown: markdown,
    contentMarkdown: markdown,
    frontmatter: {},
    tags: [],
    headings: [],
    outgoingLinks: [],
    plainText: markdown,
    contentHash: hash(markdown),
    mtimeMs: 1,
  });

  const materialScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'search-1', name: 'knowledge_search', arguments: { query: '恢复窗口' } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
    { content: '', toolCalls: [{ id: 'read-1', name: 'list_knowledge_chunks', arguments: { document_id: 'doc-1', ordinal: 3 } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
  ]);
  const materialEvidenceEvents = [];
  const material = await runtime.runSelectionEditAgentRuntime({
    request: makeRequest({ materialsLibrary: true }),
    goals,
    preloadedEvidence: [],
    extendedSources: { materialsLibrary: materialRuntime },
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: materialScripted.transport,
    providerConfig: config,
    model: 'test',
    onEvidence: (item) => materialEvidenceEvents.push(item),
  });
  equal(material.kind, 'completed', '原生工具调用就绪时启动资料库研究 Agent');
  if (material.kind !== 'completed') throw new Error('资料库 Agent 未返回完成结果。');
  equal(material.text, '恢复窗口规定第一次自动重试前等待 7 秒。', '终答只投影 final_answer 正文');
  equal(material.evidence.length, 1, '候选检索本身不生成证据，深读后才生成一条证据');
  equal(material.evidence[0]?.sourceKind, 'materials', '资料深读登记为 materials 证据');
  equal(material.evidence[0]?.readVerified, true, '资料证据必须标记为已读核验');
  equal(material.receipt.candidates[0]?.readState, 'deep-read', '候选在 list_knowledge_chunks 成功后升级为 deep-read');
  equal(materialEvidenceEvents.length, 1, '只在深读完成时发布证据事件');
  ok(materialScripted.calls[2]?.messages.at(-1)?.content.includes('新增句子缺少已验证原文支持'), '候选阶段直接终答会被 onBeforeFinalAnswer 拒绝一次并要求深读');
  ok(materialScripted.calls[0]?.tools.includes('knowledge_search') && materialScripted.calls[0]?.tools.includes('list_knowledge_chunks'), '资料库研究只注册受限资料工具');
  ok(!materialScripted.calls[0]?.tools.includes('search_memory') && !materialScripted.calls[0]?.tools.includes('read_current_note_range'), 'RA-2 不注册记忆或当前笔记工具');

  const webScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'web-search-1', name: 'web_search', arguments: { query: '发布策略' } }] },
    { content: '', toolCalls: [{ id: 'web-fetch-1', name: 'web_fetch', arguments: { url: 'https://example.test/policy' } }] },
    { content: '<final_answer>发布策略要求异常后先受控回滚，再验证恢复窗口与重试条件。</final_answer>', toolCalls: [] },
  ]);
  const web = await runtime.runSelectionEditAgentRuntime({
    request: makeRequest({ web: true }, '请解释发布策略。'),
    goals: [{ goalId: 'goal-1', kind: 'support', question: '发布策略的受控回滚条件', queryTerms: ['发布策略'], required: true }],
    preloadedEvidence: [],
    extendedSources: {
      web: {
        adapter: { id: 'test-web', search: async () => [{ title: '发布策略公告', url: 'https://example.test/policy', snippet: '摘要不能直接作为证据。', source: 'test-web' }] },
        runtimeConfig: {},
        maxResults: 3,
      },
    },
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: webScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(web.kind, 'completed', '已授权且已就绪的网页运行时可注册网页工具');
  if (web.kind !== 'completed') throw new Error('网页 Agent 未返回完成结果。');
  equal(web.evidence.length, 1, 'web_search 摘要不生成证据，web_fetch 成功后才生成证据');
  equal(web.evidence[0]?.pageVerified, true, '网页证据必须全文核验后标记 pageVerified');
  equal(web.receipt.candidates[0]?.readState, 'deep-read', '网页候选在 web_fetch 成功后升级为 deep-read');
  ok(webScripted.calls[0]?.tools.includes('web_search') && webScripted.calls[0]?.tools.includes('web_fetch'), '网页工具仅在运行时明确注入时注册');

  const blockedWebScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'web-search-1', name: 'web_search', arguments: { query: '发布策略' } }] },
    { content: '', toolCalls: [{ id: 'web-fetch-1', name: 'web_fetch', arguments: { url: 'https://evil.example/other' } }] },
    { content: '<final_answer>发布策略。</final_answer>', toolCalls: [] },
  ]);
  const blockedWeb = await runtime.runSelectionEditAgentRuntime({
    request: makeRequest({ web: true }, '发布策略。', 'polish'),
    goals: [{ goalId: 'goal-1', kind: 'support', question: '发布策略的受控回滚条件', queryTerms: ['发布策略'], required: true }],
    preloadedEvidence: [],
    extendedSources: {
      web: {
        adapter: { id: 'test-web', search: async () => [{ title: '发布策略公告', url: 'https://example.test/policy', snippet: '摘要不能直接作为证据。', source: 'test-web' }] },
        runtimeConfig: {},
        maxResults: 3,
      },
    },
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: blockedWebScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(blockedWeb.kind, 'completed', '白名单拒绝后，非增补动作仍能保守结束');
  if (blockedWeb.kind !== 'completed') throw new Error('网页白名单测试未返回完成结果。');
  equal(blockedWeb.evidence.length, 0, '非本轮搜索 URL 不能产生网页证据');
  ok(blockedWebScripted.calls[2]?.messages.some((message) => message.role === 'tool' && message.content.includes('不在本轮 web_search 候选白名单')), 'web_fetch 必须拒绝本轮搜索结果外的 URL');

  const currentMarkdown = '请说明恢复窗口。\n\n恢复窗口规定第一次自动重试前等待 7 秒。';
  const currentSnapshot = runtime.createCurrentNoteSnapshot({
    libraryPath: 'C:/selection-agent-notes',
    notePath: 'C:/selection-agent-notes/current.md',
    title: '当前笔记',
    contentHash: hash(currentMarkdown),
    markdown: currentMarkdown,
    headings: [],
    revision: 1,
  });
  const selectedCurrentBlock = currentSnapshot.blocks.find((block) => block.text === '请说明恢复窗口。');
  const currentEvidenceBlock = currentSnapshot.blocks.find((block) => block.text.includes('第一次自动重试前等待 7 秒'));
  ok(Boolean(selectedCurrentBlock && currentEvidenceBlock), '当前笔记夹具应生成选区与可深读证据块');
  const currentRequest = makeRequest({ currentNote: true }, '请说明恢复窗口。');
  currentRequest.contextScope = 'current-note';
  currentRequest.snapshot.lineFrom = selectedCurrentBlock.lineFrom;
  currentRequest.snapshot.lineTo = selectedCurrentBlock.lineTo;
  const currentScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'current-search', name: 'search_note', arguments: { terms: ['恢复窗口'] } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
    { content: '', toolCalls: [{ id: 'current-read', name: 'read_note_range', arguments: { line_from: currentEvidenceBlock.lineFrom, line_to: currentEvidenceBlock.lineTo } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
  ]);
  const current = await runtime.runSelectionEditAgentRuntime({
    request: currentRequest,
    goals,
    preloadedEvidence: [],
    currentNoteSnapshot: currentSnapshot,
    extendedSources: {},
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: currentScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(current.kind, 'completed', '大当前笔记可通过受限 map/search/read Agent 启动');
  if (current.kind !== 'completed') throw new Error('当前笔记 Agent 未返回完成结果。');
  equal(current.evidence.length, 1, '当前笔记搜索候选不能直接成为证据，范围深读后才登记');
  equal(current.evidence[0]?.sourceKind, 'current-note', '当前笔记范围深读登记为 current-note 证据');
  ok(currentScripted.calls[0]?.tools.includes('get_note_map') && currentScripted.calls[0]?.tools.includes('search_note') && currentScripted.calls[0]?.tools.includes('read_note_range'), '非严格小笔记只注册当前笔记 map/search/read 工具');
  ok(!currentScripted.calls[0]?.tools.includes('read_library_note_range') && !currentScripted.calls[0]?.tools.includes('list_knowledge_chunks'), '仅当前笔记授权时不扩大到同库或资料工具');

  const selectedBlockScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'current-search', name: 'search_note', arguments: { terms: ['恢复窗口'] } }] },
    { content: '', toolCalls: [{ id: 'current-read-selected', name: 'read_note_range', arguments: { line_from: selectedCurrentBlock.lineFrom, line_to: selectedCurrentBlock.lineTo } }] },
    { content: '<final_answer>请说明恢复窗口。</final_answer>', toolCalls: [] },
  ]);
  const selectedBlock = await runtime.runSelectionEditAgentRuntime({
    request: { ...currentRequest, action: 'polish', outputPreference: 'replace' },
    goals,
    preloadedEvidence: [],
    currentNoteSnapshot: currentSnapshot,
    extendedSources: {},
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: selectedBlockScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(selectedBlock.kind, 'completed', '读取选区被拒绝后，非增补动作仍能保守结束');
  if (selectedBlock.kind !== 'completed') throw new Error('选区拦截测试未返回完成结果。');
  equal(selectedBlock.evidence.length, 0, '待编辑选区不能被循环当作外部新增证据');
  ok(selectedBlockScripted.calls[2]?.messages.some((message) => message.role === 'tool' && message.content.includes('待编辑选区属于编辑目标')), '当前笔记工具必须拒绝深读待编辑选区');

  const strictPreloadedCurrent = await runtime.runSelectionEditAgentRuntime({
    request: currentRequest,
    goals,
    preloadedEvidence: [{
      evidenceId: 'strict-current-note-evidence', sourceKind: 'current-note', title: '当前笔记', locator: '当前笔记 / L1-L3',
      content: currentMarkdown, sourceContentHash: currentSnapshot.contentHash, textHash: hash(currentMarkdown), goalIds: ['goal-1'], readVerified: true, pageVerified: true,
    }],
    currentNoteSnapshot: currentSnapshot,
    currentNoteFullyPreloaded: true,
    extendedSources: {},
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: currentScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(strictPreloadedCurrent, { kind: 'unavailable', reason: '没有已授权且已就绪的当前笔记、同库笔记、资料库或网页研究来源。' }, '严格小笔记已预加载全文时不再注册重复当前笔记读取工具');

  const libraryCurrent = makeIndexedNote('C:/selection-agent-notes/current.md', '当前笔记', currentMarkdown);
  const libraryMarkdown = '恢复策略说明。\n\n恢复窗口规定第一次自动重试前等待 7 秒。';
  const libraryReference = makeIndexedNote('C:/selection-agent-notes/recovery.md', '恢复策略', libraryMarkdown);
  const librarySessionId = 'selection-agent-library-001';
  const snapshotMap = runtime.createLibraryNoteSnapshotMap({
    libraryPath: 'C:/selection-agent-notes',
    index: {
      libraryPath: 'C:/selection-agent-notes',
      fileTree: [],
      notes: [libraryCurrent, libraryReference],
      notesByPath: { [libraryCurrent.path]: libraryCurrent, [libraryReference.path]: libraryReference },
    },
    sessionId: librarySessionId,
    revision: 1,
    indexState: 'latest',
  });
  const libraryDescriptor = snapshotMap.notes.find((note) => note.title === '恢复策略');
  const libraryRecord = snapshotMap.records.get(libraryDescriptor.noteId);
  const libraryEvidenceBlock = libraryRecord.localSnapshot.blocks.find((block) => block.text.includes('第一次自动重试前等待 7 秒'));
  ok(Boolean(libraryDescriptor && libraryRecord && libraryEvidenceBlock), '同库笔记夹具应生成稳定候选与可深读原文块');
  const libraryRequest = makeRequest({ currentNote: false, noteLibrary: true }, '请说明恢复窗口。');
  const libraryScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'library-search', name: 'search_note_library', arguments: { query: '恢复窗口' } }] },
    { content: '', toolCalls: [{ id: 'library-block-search', name: 'search_library_note_blocks', arguments: { note_id: libraryDescriptor.noteId, terms: ['恢复窗口'] } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
    { content: '', toolCalls: [{ id: 'library-read', name: 'read_library_note_range', arguments: { note_id: libraryDescriptor.noteId, line_from: libraryEvidenceBlock.lineFrom, line_to: libraryEvidenceBlock.lineTo } }] },
    { content: '<final_answer>恢复窗口规定第一次自动重试前等待 7 秒。</final_answer>', toolCalls: [] },
  ]);
  const noteLibrary = await runtime.runSelectionEditAgentRuntime({
    request: libraryRequest,
    goals,
    preloadedEvidence: [],
    extendedSources: {
      noteLibrary: {
        snapshotMap,
        sessionId: librarySessionId,
        currentNotePath: libraryCurrent.path,
        keywordSearch: () => [{ path: libraryRecord.localSnapshot.notePath, title: libraryReference.title, score: 0.91, snippet: '恢复窗口候选摘要。' }],
        isSnapshotCurrent: () => true,
      },
    },
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: libraryScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(noteLibrary.kind, 'completed', '同库笔记可通过候选笔记、候选块和具体行范围深读启动');
  if (noteLibrary.kind !== 'completed') throw new Error('同库笔记 Agent 未返回完成结果。');
  equal(noteLibrary.evidence.length, 1, '同库笔记候选必须在具体行范围深读后才成为证据');
  equal(noteLibrary.evidence[0]?.sourceKind, 'note-library', '同库范围深读登记为 note-library 证据');
  ok(libraryScripted.calls[0]?.tools.includes('search_note_library') && libraryScripted.calls[0]?.tools.includes('search_library_note_blocks') && libraryScripted.calls[0]?.tools.includes('read_library_note_range'), '同库工具仅以候选到具体行范围深读的只读链路注册');

  let librarySnapshotCurrent = true;
  const staleLibraryScripted = makeTransport([
    { content: '', toolCalls: [{ id: 'library-search', name: 'search_note_library', arguments: { query: '恢复窗口' } }] },
    { content: '', toolCalls: [{ id: 'library-map', name: 'get_library_note_map', arguments: { note_id: libraryDescriptor.noteId } }] },
    { content: '<final_answer>请说明恢复窗口。</final_answer>', toolCalls: [] },
  ]);
  const staleChat = staleLibraryScripted.transport.chat;
  staleLibraryScripted.transport.chat = async (...args) => {
    const response = await staleChat(...args);
    if (staleLibraryScripted.calls.length === 1) librarySnapshotCurrent = false;
    return response;
  };
  const staleLibrary = await runtime.runSelectionEditAgentRuntime({
    request: { ...libraryRequest, action: 'polish', outputPreference: 'replace' },
    goals,
    preloadedEvidence: [],
    extendedSources: {
      noteLibrary: {
        snapshotMap,
        sessionId: librarySessionId,
        currentNotePath: libraryCurrent.path,
        keywordSearch: () => [{ path: libraryRecord.localSnapshot.notePath, title: libraryReference.title, score: 0.91, snippet: '恢复窗口候选摘要。' }],
        isSnapshotCurrent: () => librarySnapshotCurrent,
      },
    },
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    transport: staleLibraryScripted.transport,
    providerConfig: config,
    model: 'test',
  });
  equal(staleLibrary.kind, 'completed', '同库快照失效后，非增补动作仍可保守结束');
  if (staleLibrary.kind !== 'completed') throw new Error('同库快照失效测试未返回完成结果。');
  equal(staleLibrary.evidence.length, 0, '同库索引变化后旧候选不能继续产生证据');
  ok(staleLibraryScripted.calls[2]?.messages.some((message) => message.role === 'tool' && message.content.includes('同库笔记索引已变化')), '同库候选在索引变化后必须被工具层拦截');

  const unavailable = await runtime.runSelectionEditAgentRuntime({
    request: makeRequest({ web: true }), goals, preloadedEvidence: [], extendedSources: {},
    signal: new AbortController().signal, isSnapshotCurrent: () => true,
    transport: materialScripted.transport, providerConfig: config, model: 'test',
  });
  equal(unavailable, { kind: 'unavailable', reason: '没有已授权且已就绪的当前笔记、同库笔记、资料库或网页研究来源。' }, '来源未就绪时不注册网页工具并回退直接编辑');

  const unavailableTransport = await runtime.runSelectionEditAgentRuntime({
    request: makeRequest({ materialsLibrary: true }), goals, preloadedEvidence: [], extendedSources: { materialsLibrary: materialRuntime },
    signal: new AbortController().signal, isSnapshotCurrent: () => true,
    providerConfig: config, model: 'test',
  });
  equal(unavailableTransport, { kind: 'unavailable', reason: '当前模型不支持原生工具调用，已保留直接编辑路径。' }, '无原生工具调用传输时明确回退直接编辑');

  equal(runtime.resolveSelectionEditAgentBudget('fast'), { maxIterations: 2, maxModelCalls: 3, maxToolCalls: 4 }, 'fast 使用收紧的 ReAct 预算');
  equal(runtime.resolveSelectionEditAgentBudget('balanced'), { maxIterations: 4, maxModelCalls: 6, maxToolCalls: 8 }, 'balanced 使用收紧的 ReAct 预算');
  equal(runtime.resolveSelectionEditAgentBudget('deep'), { maxIterations: 5, maxModelCalls: 8, maxToolCalls: 10 }, 'deep 使用收紧的 ReAct 预算');

  equal(runtime.resolveSelectionEditResearchMode(undefined, 'production'), 'direct', '生产环境未显式选择时固定 direct');
  equal(runtime.resolveSelectionEditResearchMode('shadow', 'production'), 'direct', '生产环境拒绝额外收费的 shadow 双跑');
  equal(runtime.resolveSelectionEditResearchMode('shadow', 'test'), 'shadow', '测试环境显式选择时允许 shadow');
  equal(runtime.resolveSelectionEditResearchMode('react', 'production'), 'react', '显式 react 可用于受控发布验证，但默认不切换');
  console.log(`selection-edit-agent-runtime 验证通过：${checks} 项断言（候选/深读分层、网页核验、终答修复、工具白名单与预算）。`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
