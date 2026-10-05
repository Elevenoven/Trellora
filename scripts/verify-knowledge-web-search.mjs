import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 打包被测模块（联网搜索设计方案 §11 验证；对齐现有验证脚本模式）。
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-web-search');
await build({
  entryPoints: [
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'webSearchTool.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'webFetchTool.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'knowledgeSessionState.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentPrompt.ts'),
    path.join(rootDir, 'electron', 'websearch', 'webSearchProviders.ts'),
  ],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { webSearchTool } = await import(pathToFileURL(path.join(outDir, 'knowledge', 'knowledgeTools', 'webSearchTool.js')).href);
const { webFetchTool } = await import(pathToFileURL(path.join(outDir, 'knowledge', 'knowledgeTools', 'webFetchTool.js')).href);
const { KnowledgeAgentSessionState } = await import(pathToFileURL(path.join(outDir, 'knowledge', 'knowledgeTools', 'knowledgeSessionState.js')).href);
const { buildKnowledgeAgentSystemPrompt, buildKnowledgeRuntimeContext } = await import(pathToFileURL(path.join(outDir, 'knowledge', 'knowledgeAgentPrompt.js')).href);
const { listWebSearchProviders, resolveWebSearchProvider, normalizeProviderExtras } = await import(pathToFileURL(path.join(outDir, 'websearch', 'webSearchProviders.js')).href);

let checks = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  checks += 1;
};
const budget = { maxSingleObservationChars: 12_000, maxTotalObservationTokens: 20_000 };

// ── 1. 会话状态：网页证据登记、去重、验证升级与限额 ───────────────────────
const session = new KnowledgeAgentSessionState(budget);
const chunk = session.registerEvidence({ documentId: 'doc-1', parentChunkId: 'p-1', ordinal: 2, text: '父块正文', sourceText: '父块正文' });
ok(chunk.reference === '[1]', '知识库块先占引用号 [1]');
const web1 = session.registerWebEvidence({ url: 'https://example.com/a', title: '网页甲', source: 'zhipu', sourceText: '摘要甲' });
ok(web1.reference === '[2]' && web1.alreadySeen === false, '网页证据接续共享引用号序列 [2]');
const web1Again = session.registerWebEvidence({ url: 'https://example.com/a', title: '网页甲', source: 'zhipu', sourceText: '摘要甲' });
ok(web1Again.reference === '[2]' && web1Again.alreadySeen === true, '重复 URL 复用引用号并标记已见过');
ok(session.isUrlSeen('https://example.com/a') && session.referenceOfUrl('https://example.com/a') === '[2]', 'seenUrls 可反查引用号');
ok(session.verifyWebEvidence('[2]', '已验证摘录') === true, 'web_fetch 成功后可升级验证状态');
const upgraded = session.ledgerEntries().find((entry) => entry.reference === '[2]');
ok(upgraded.pageVerified === true && upgraded.sourceText === '已验证摘录', '升级后 pageVerified=true 且证据文本替换为已验证摘录');
ok(session.ledgerEntries().find((entry) => entry.reference === '[1]').pageVerified === undefined, '知识库块条目不受网页验证字段影响');
ok(session.seenEvidenceKeys().length === 1 && session.seenEvidenceKeys()[0].parentChunkId === 'p-1', 'seenEvidenceKeys 过滤网页条目，只含知识库父块');
for (let index = 0; index < 3; index += 1) ok(session.consumeWebSearchCall(3), `第 ${index + 1} 次联网检索放行`);
ok(session.consumeWebSearchCall(3) === false, '第 4 次联网检索被限额拒绝');

// ── 2. web_search 工具：门控、登记与限额 ──────────────────────────────────
const mockResults = [
  { title: '氮化镓最新进展', url: 'https://example.com/gan', snippet: '摘要：氮化镓器件…', source: 'mock', publishedAt: '2026-08-01' },
  { title: '碳化硅综述', url: 'https://example.com/sic', snippet: '摘要：碳化硅器件…', source: 'mock' },
];
const mockAdapter = {
  id: 'zhipu',
  label: 'Mock',
  description: 'mock',
  requirements: 'none',
  search: async () => mockResults,
};
const searchSession = new KnowledgeAgentSessionState(budget);
const searchCtx = {
  libraryPath: '/tmp/library',
  libraryLabel: '测试库',
  session: searchSession,
  signal: new AbortController().signal,
  documentNameById: () => undefined,
  prepareQueryContext: async () => ({ targetPath: '/tmp/library' }),
  rerank: { enabled: false },
  webSearch: { adapter: mockAdapter, runtimeConfig: {}, maxResults: 6 },
};
const emptyQuery = await webSearchTool.execute({ query: '   ' }, searchCtx);
ok(emptyQuery.ok === false && emptyQuery.observation.includes('<tool_error>'), '空查询被拒绝并回结构化错误观察');
const noRuntime = await webSearchTool.execute({ query: '氮化镓进展' }, { ...searchCtx, webSearch: undefined });
ok(noRuntime.ok === false && noRuntime.observation.includes('联网搜索未启用'), '运行时缺失时拒绝执行');
const searchOutcome = await webSearchTool.execute({ query: '氮化镓最新进展' }, searchCtx);
ok(searchOutcome.ok === true, '联网搜索成功执行');
ok(searchOutcome.observation.includes('<web_search_results') && searchOutcome.observation.includes('page_verified="false"'), '观察文本为未验证的网页结果列表');
ok(searchOutcome.observation.includes('reference="[1]"') && searchOutcome.referenceCount === 2, '两条结果登记共享序列引用号');
ok(searchSession.isSearchableUrl('https://example.com/gan') && searchSession.isSearchableUrl('https://example.com/sic'), '搜索返回的 URL 进入 web_fetch 白名单');
const seenAgain = await webSearchTool.execute({ query: '换个角度再搜一次' }, searchCtx);
ok(seenAgain.observation.includes('已见过'), '重复 URL 命中 seenUrls 时观察中标注已见过');
await webSearchTool.execute({ query: '第三次搜索' }, searchCtx);
const overLimit = await webSearchTool.execute({ query: '第四次搜索' }, searchCtx);
ok(overLimit.ok === false && overLimit.observation.includes('次数已达上限'), '单轮循环内 web_search 超过 3 次被拒绝');
const failingCtx = { ...searchCtx, session: new KnowledgeAgentSessionState(budget), webSearch: { ...searchCtx.webSearch, adapter: { ...mockAdapter, search: async () => { throw new Error('网络超时'); } } } };
const failed = await webSearchTool.execute({ query: '断网场景' }, failingCtx);
ok(failed.ok === false && failed.observation.includes('联网搜索失败') && failed.observation.includes('网络超时'), 'Provider 失败回中文错误观察，循环不中断');

// ── 3. web_fetch 工具：白名单、验证升级、降级与限额 ──────────────────────
const originalFetch = globalThis.fetch;
const fetchSession = new KnowledgeAgentSessionState(budget);
fetchSession.registerWebEvidence({ url: 'https://example.com/gan', title: '氮化镓最新进展', source: 'mock', sourceText: '摘要：氮化镓器件…' });
const fetchCtx = { ...searchCtx, session: fetchSession, webSearch: { adapter: mockAdapter, runtimeConfig: {}, maxResults: 6 } };
const outsideWhitelist = await webFetchTool.execute({ url: 'https://evil.example.com/inject' }, fetchCtx);
ok(outsideWhitelist.ok === false && outsideWhitelist.observation.includes('URL 不是本次搜索结果'), '非搜索结果 URL 被白名单拒绝（防提示注入）');

globalThis.fetch = async () => new Response('<html><head><title>氮化镓器件全文</title></head><body><script>bad()</script><p>这是氮化镓器件的全文正文，长度足以通过空页判定：氮化镓作为宽禁带半导体材料，在高频功率器件与快充领域持续取得进展。</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const fetched = await webFetchTool.execute({ url: 'https://example.com/gan' }, fetchCtx);
ok(fetched.ok === true && fetched.observation.includes('page_verified="true"'), '抓取成功后观察标注已全文验证');
ok(!fetched.observation.includes('bad()'), '抓取正文已剥离 script 标签');
const verifiedEntry = fetchSession.ledgerEntries().find((entry) => entry.reference === '[1]');
ok(verifiedEntry.pageVerified === true, '台账中该引用升级为 pageVerified');

globalThis.fetch = async () => new Response('<html><head><title>空页</title></head><body><p>短</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
fetchSession.markSearchableUrl('https://example.com/empty');
const emptyPage = await webFetchTool.execute({ url: 'https://example.com/empty' }, fetchCtx);
ok(emptyPage.ok === false && emptyPage.observation.includes('页面内容未验证'), '正文抽取为空时披露未验证并保留摘要证据');

globalThis.fetch = async () => new Response('boom', { status: 403 });
fetchSession.markSearchableUrl('https://example.com/forbidden');
const forbidden = await webFetchTool.execute({ url: 'https://example.com/forbidden' }, fetchCtx);
ok(forbidden.ok === false && forbidden.observation.includes('HTTP 403'), 'HTTP 失败回结构化错误观察');
const overFetch = await webFetchTool.execute({ url: 'https://example.com/gan' }, fetchCtx);
ok(overFetch.ok === false && overFetch.observation.includes('次数已达上限'), '单轮循环内 web_fetch 超过 3 次被拒绝');
globalThis.fetch = originalFetch;

// ── 4. 适配器注册表与工厂前置校验 ─────────────────────────────────────────
const providers = listWebSearchProviders();
ok(providers.length === 5 && providers.map((adapter) => adapter.id).join(',') === 'zhipu,duckduckgo,searxng,tavily,baidu', '注册表含五个厂商且顺序稳定');
const zhipuNoKey = resolveWebSearchProvider({ provider: 'zhipu', config: {} });
ok(zhipuNoKey.error?.includes('API Key'), '智谱缺 Key 时返回中文可操作错误');
const zhipuWithKey = resolveWebSearchProvider({ provider: 'zhipu', config: { zhipu: { apiKey: 'sk-test' } } });
ok(zhipuWithKey.adapter?.id === 'zhipu' && !zhipuWithKey.error, '智谱配齐 Key 后解析成功');
const duckduckgo = resolveWebSearchProvider({ provider: 'duckduckgo', config: {} });
ok(duckduckgo.adapter?.id === 'duckduckgo' && !duckduckgo.error, 'DuckDuckGo 免配置直接可用');
const searxngNoUrl = resolveWebSearchProvider({ provider: 'searxng', config: {} });
ok(searxngNoUrl.error?.includes('实例地址'), 'SearXNG 缺实例地址时返回中文可操作错误');
const tavilyNoKey = resolveWebSearchProvider({ provider: 'tavily', config: {} });
ok(tavilyNoKey.error?.includes('API Key'), 'Tavily 缺 Key 时返回中文可操作错误');
const tavilyWithKey = resolveWebSearchProvider({ provider: 'tavily', config: { tavily: { apiKey: 'tvly-test' } } });
ok(tavilyWithKey.adapter?.id === 'tavily' && !tavilyWithKey.error, 'Tavily 配齐 Key 后解析成功');
const baiduNoKey = resolveWebSearchProvider({ provider: 'baidu', config: {} });
ok(baiduNoKey.error?.includes('API Key'), '百度缺 Key 时返回中文可操作错误');
const baiduWithKey = resolveWebSearchProvider({ provider: 'baidu', config: { baidu: { apiKey: 'bce-test' } } });
ok(baiduWithKey.adapter?.id === 'baidu' && !baiduWithKey.error, '百度配齐 Key 后解析成功');
const unknown = resolveWebSearchProvider({ provider: 'bing', config: {} });
ok(unknown.error?.includes('未知联网搜索厂商'), '未知厂商返回明确错误');

// ── 4b. 厂商元数据层：configFields 声明与 extras 归一化（对标 WeKnora ExtraConfig）──
const zhipuAdapter = providers.find((adapter) => adapter.id === 'zhipu');
ok(Boolean(zhipuAdapter?.docsUrl) && Array.isArray(zhipuAdapter?.configFields) && zhipuAdapter.configFields.length === 2, '智谱适配器声明 docsUrl 与两个非密动态配置字段');
const normalized = normalizeProviderExtras('zhipu', { search_engine: 'search_pro', content_size: 'bogus', unknown_key: 'x' });
ok(normalized.search_engine === 'search_pro' && normalized.content_size === 'medium' && !('unknown_key' in normalized), 'extras 校验：合法值保留、非法值回退默认、未知键丢弃');
ok(Object.keys(normalizeProviderExtras('duckduckgo', { anything: 'x' })).length === 0, '无 configFields 的厂商归一化后为空集');

// ── 5. 提示词与运行时上下文的能力分支 ─────────────────────────────────────
const offlinePrompt = buildKnowledgeAgentSystemPrompt({ libraryLabel: '测试库', capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true } });
ok(offlinePrompt.includes('本助手无联网检索能力') && !offlinePrompt.includes('web_search'), '未启用联网时提示词保持无联网分支');
const onlinePrompt = buildKnowledgeAgentSystemPrompt({ libraryLabel: '测试库', capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true, webSearch: true } });
ok(onlinePrompt.includes('知识库优先、联网兜底'), '启用联网时硬规则第 5 条切为联网兜底分支');
ok(onlinePrompt.includes('联网证据分级') && onlinePrompt.includes('未经全文验证'), '启用联网时追加加分级纪律');
ok(onlinePrompt.includes('- web_search：') && onlinePrompt.includes('- web_fetch：'), '工具选择指南追加联网工具');
const onlineRuntime = buildKnowledgeRuntimeContext({ libraryLabel: '测试库', documentCount: 3, indexedChunks: 40, capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true, webSearch: true }, webSearchProvider: 'zhipu', now: new Date('2026-08-28T00:00:00Z') });
ok(onlineRuntime.includes('capabilities="semantic_search,keyword_search,deep_read,web_search"'), 'runtime_context 能力面包含 web_search');
ok(onlineRuntime.includes('<web_search provider="zhipu" />'), 'runtime_context 输出当前厂商节点');
const offlineRuntime = buildKnowledgeRuntimeContext({ libraryLabel: '测试库', documentCount: 3, indexedChunks: 40, capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true }, now: new Date('2026-08-28T00:00:00Z') });
ok(!offlineRuntime.includes('web_search'), '未启用联网时 runtime_context 不输出联网能力与节点');

console.log(`knowledge-web-search 验证通过：${checks} 项断言（台账共享序列、白名单与限额、验证升级、适配器工厂门控、提示词能力分支）。`);
