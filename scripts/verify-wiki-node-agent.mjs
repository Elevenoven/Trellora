import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-wiki-node-agent');
const agentBundle = path.join(outDir, 'wiki-agent.cjs');
const dataSourceBundle = path.join(outDir, 'wiki-data-source.cjs');
const questionsBundle = path.join(outDir, 'wiki-questions.cjs');
const derivedBundle = path.join(outDir, 'wiki-derived.cjs');
const memoriesBundle = path.join(outDir, 'wiki-ai-memories.cjs');
const searchBundle = path.join(outDir, 'material-search.cjs');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const wikiAgentStubPlugin = {
  name: 'wiki-agent-stubs',
  setup(context) {
    const stub = (filter, name) => context.onResolve({ filter }, () => ({ path: name, namespace: 'wiki-agent-stub' }));
    stub(/materialsLibrary$/u, 'materials-library');
    stub(/pipeline\/materialChunkSearch$/u, 'material-chunk-search');
    stub(/knowledge\/rerankAdapters$/u, 'rerank-adapters');
    stub(/knowledge\/assistantTurn$/u, 'assistant-turn');
    stub(/knowledge\/assistantDocumentAttachmentParser$/u, 'assistant-document-attachment-parser');
    stub(/knowledge\/attachmentContextProvider$/u, 'attachment-context-provider');
    stub(/knowledge\/modelCallCoordinator$/u, 'model-call-coordinator');
    stub(/knowledge\/aiProvider$/u, 'ai-provider');
    stub(/knowledge\/reactAgent\/reactChatTransport$/u, 'react-chat-transport');
    stub(/knowledge\/knowledgeBaseRag$/u, 'knowledge-base-rag');
    stub(/wikiSplitProposal$/u, 'wiki-split-proposal');

    context.onLoad({ filter: /.*/u, namespace: 'wiki-agent-stub' }, (args) => {
      const contents = {
        'materials-library': `export const findMaterialsDocument = () => ({ name: 'P4 夹具.md', absolutePath: 'C:/wiki/P4.md' });`,
        'material-chunk-search': `export const readMaterialDocumentIndexStats = () => ({ parentChunks: 3 });`,
        'rerank-adapters': `export const resolveRerankRuntime = () => ({ enabled: false });`,
        'assistant-turn': `export const streamKnowledgeAnswer = async () => { throw new Error('测试必须注入 streamAnswer'); };`,
        'assistant-document-attachment-parser': `
          export const parseAssistantDocumentAttachments = async () => ({
            documentTextByAttachmentId: new Map(),
            documentImagesByAttachmentId: new Map(),
            dispose() {},
          });
          export const materializeAssistantDocumentImages = () => [];
          export const collectAiTransportImageHashes = () => new Set();
        `,
        'attachment-context-provider': `
          export class AttachmentContextProvider {
            listMetadata() { return []; }
            search() { return []; }
            readRange() { return undefined; }
            selectDocumentImages() { return []; }
          }
          export const renderAttachmentMetadata = () => '';
          export const renderAttachmentRange = () => '';
          export const renderDocumentImageTransportIndex = () => '';
        `,
        'model-call-coordinator': `export class ModelCallPreparationError extends Error { constructor(reason) { super(String(reason)); this.reason = reason; } }`,
        'ai-provider': `export const generateAiJson = async (input) => globalThis.__wikiGenerateAiJson(input);`,
        'react-chat-transport': `export const createReActChatTransport = () => undefined;`,
        'wiki-split-proposal': `export const generateWikiSplitProposal = async (input) => globalThis.__wikiSplitProposal?.(input) ?? [];`,
        'knowledge-base-rag': `
          export async function retrieveKnowledgeBaseEvidence(input) {
            globalThis.__wikiRetrievalInputs ??= [];
            globalThis.__wikiRetrievalInputs.push(input);
            const scripted = globalThis.__wikiRetrievalOutcomes?.shift();
            const crossSection = Array.isArray(input.sectionNodeIds)
              && input.sectionNodeIds.includes('heading-sibling')
              && !input.sectionNodeIds.includes('heading-current');
            const evidence = scripted === 'empty' ? [] : scripted?.evidence ?? [crossSection ? {
              documentId: 'doc-1', childChunkId: 'child-sibling', parentChunkId: 'parent-sibling', parentOrdinal: 8,
              text: '资源可用性见兄弟章节；兄弟章节中的跨章节证据。', sourceText: '资源可用性见兄弟章节；兄弟章节中的跨章节证据。', score: 0.9,
              hitChildren: 1, methods: ['semantic'],
              sectionContext: '章节路径：根节点 / 兄弟章节\\n章节：兄弟章节',
            } : {
              documentId: 'doc-1', childChunkId: 'child-1', parentChunkId: 'parent-1', parentOrdinal: 7,
              text: '子章节中的限定证据', sourceText: '子章节中的限定证据', score: 0.92,
              hitChildren: 1, methods: ['semantic'],
              sectionContext: '章节路径：根节点 / 当前章节 / 子章节\\n章节：子章节',
            }];
            const children = evidence.map((entry) => ({
              chunkId: entry.childChunkId,
              sectionContext: entry.sectionContext,
              sectionPath: [{ nodeId: crossSection ? 'heading-sibling' : 'heading-child' }],
            }));
            return {
              evidence,
              children,
              parentCandidateCount: evidence.length,
              rerank: { enabled: false, applied: false, gatedOut: 0, allGatedOut: false },
              used: '综合搜索', vectorIndexed: true, indexedChunks: 3,
              channelContribution: { vector: 1, fts: 1, graph: 0 },
            };
          }
          export function mergeKnowledgeBaseRetrievals(outcomes, topK) {
            const first = outcomes[0];
            return {
              ...first,
              evidence: outcomes.flatMap((item) => item.evidence).slice(0, topK),
              children: outcomes.flatMap((item) => item.children ?? []),
            };
          }
        `,
      }[args.path];
      return { contents, loader: 'js' };
    });
  },
};

const questionsStubPlugin = {
  name: 'wiki-questions-stubs',
  setup(context) {
    context.onResolve({ filter: /knowledge\/aiProvider$/u }, () => ({ path: 'ai-provider', namespace: 'wiki-questions-stub' }));
    context.onResolve({ filter: /knowledge\/structuredOutputContract$/u }, () => ({ path: 'structured-output', namespace: 'wiki-questions-stub' }));
    context.onLoad({ filter: /.*/u, namespace: 'wiki-questions-stub' }, (args) => ({
      loader: 'js',
      contents: args.path === 'ai-provider'
        ? `export const generateAiJson = (input) => globalThis.__wikiGenerateAiJson(input);`
        : `export const isStructuredOutputContractError = (error) => error?.reason === 'schema-validation';`,
    }));
  },
};

try {
  await Promise.all([
    build({
      stdin: {
        contents: [
          `export { runWikiNodeAgentTurn } from './electron/wiki/wikiNodeAgentTurn.ts';`,
          `export { WIKI_NODE_REACT_BUDGET, WIKI_NODE_SUMMARY_REACT_BUDGET } from './electron/wiki/wikiNodeBudget.ts';`,
          `export { buildWikiAgentQuestion, buildWikiNodeAgentSystemPrompt, buildWikiNodeFallbackSystemPrompt, buildWikiRuntimeContext } from './electron/wiki/wikiNodeAgentPrompt.ts';`,
          `export { buildWikiActionContract, resolveWikiSummaryPolicy } from './electron/wiki/wikiQuickActions.ts';`,
          `export { WIKI_MAX_RETRIEVAL_CYCLES, createWikiScopePolicy, createWikiScopeState, resolveWikiScopeDecision } from './electron/wiki/wikiScopePolicy.ts';`,
          `export { buildWikiFallbackQueries, createWikiScopedSearchTool } from './electron/wiki/wikiRetrievalCycle.ts';`,
          `export { assessWikiDirectEvidence } from './electron/wiki/wikiDirectEvidenceGate.ts';`,
          `export { rewriteWikiQuestion, selectWikiRewriteHistory, shouldRewriteWikiQuestion } from './electron/wiki/wikiQueryRewrite.ts';`,
          `export { wikiGrepNodeTool } from './electron/wiki/wikiTools/wikiGrepNodeTool.ts';`,
          `export { wikiReadNodeTool } from './electron/wiki/wikiTools/wikiReadNodeTool.ts';`,
          `export { wikiSearchDocumentTool } from './electron/wiki/wikiTools/wikiSearchDocumentTool.ts';`,
        ].join('\n'),
        resolveDir: rootDir,
        sourcefile: 'verify-wiki-agent-entry.ts',
      },
      outfile: agentBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [wikiAgentStubPlugin],
    }),
    build({
      entryPoints: [path.join(rootDir, 'src', 'wiki', 'wikiElectronAgentDataSource.ts')],
      outfile: dataSourceBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: { 'import.meta.env.VITE_WIKI_MOCK_SCENARIO': '""' },
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'wiki', 'wikiNodeQuestions.ts')],
      outfile: questionsBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [questionsStubPlugin],
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'wiki', 'wikiDerivedNodes.ts')],
      outfile: derivedBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'wiki', 'wikiAiMemories.ts')],
      outfile: memoriesBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    }),
    build({
      stdin: {
        contents: `export { filterCandidatesBySectionNodes } from './electron/pipeline/materialChunkSearch.ts';`,
        resolveDir: rootDir,
        sourcefile: 'verify-wiki-section-filter-entry.ts',
      },
      outfile: searchBundle,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
    }),
  ]);

  const agent = await import(pathToFileURL(agentBundle).href);
  const dataSourceModule = await import(pathToFileURL(dataSourceBundle).href);
  const questions = await import(pathToFileURL(questionsBundle).href);
  const derived = await import(pathToFileURL(derivedBundle).href);
  const memories = await import(pathToFileURL(memoriesBundle).href);
  const materialSearch = await import(pathToFileURL(searchBundle).href);

  verifyBudgetAndScopeFilter(agent, materialSearch);
  await verifyScopeAndRewrite(agent);
  await verifyGrepScope(agent);
  await verifyCrossSectionDeepRead(agent);
  await verifyReactAndFallback(agent);
  await verifyEventMapping(dataSourceModule);
  await verifyQuestions(questions);
  await verifyDerivedNodes(derived);
  await verifyAiMemories(memories);

  console.log('Wiki node agent verification passed (R3 scope results, live cycle progress, source navigation, completeness, fallback, and persistence contracts).');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

async function verifyScopeAndRewrite(agent) {
  const conversation = [
    { role: 'user', content: '第一次恢复用了多久？' },
    { role: 'assistant', content: '第一次退避是 7 秒。' },
  ];
  assert.deepEqual(
    agent.shouldRewriteWikiQuestion({ userText: '资源可用性是什么？', conversation: [], actionKind: 'free' }),
    { rewriting: false, reason: 'no-history', matchedSignals: [] },
    '首轮自足问题不应浪费一次改写模型调用。',
  );
  assert.equal(agent.shouldRewriteWikiQuestion({ userText: '那第二次呢？', conversation, actionKind: 'free' }).rewriting, true);
  assert.equal(agent.shouldRewriteWikiQuestion({ userText: '这里是啥？', conversation, actionKind: 'free' }).rewriting, false, '“这里”应锚定当前节点，不应被旧对话改写。');
  assert.equal(agent.shouldRewriteWikiQuestion({ userText: '只根据本节回答', conversation, actionKind: 'free' }).reason, 'explicit-node-lock');
  assert.equal(agent.shouldRewriteWikiQuestion({ userText: '总结本节', conversation, actionKind: 'summarize' }).reason, 'quick-action');
  assert.equal(agent.shouldRewriteWikiQuestion({ userText: '第二章讲了什么？', conversation: [], actionKind: 'free' }).reason, 'explicit-section-reference');

  const locked = agent.resolveWikiScopeDecision({ actionKind: 'free', userText: '只根据本节回答' });
  const defaultScope = agent.resolveWikiScopeDecision({ actionKind: 'free', userText: '资源可用性是什么？', suggestedMode: 'document-first' });
  const documentFirst = agent.resolveWikiScopeDecision({ actionKind: 'free', userText: '结合全文和第二章回答' });
  assert.equal(locked.mode, 'node-locked');
  assert.equal(defaultScope.mode, 'node-first', '改写模型不得把普通问题擅自扩大到全文。');
  assert.equal(documentFirst.mode, 'document-first');
  assert.equal(agent.resolveWikiScopeDecision({ actionKind: 'cross-links', userText: '查找关联' }).mode, 'document-first');

  const state = agent.createWikiScopeState({
    decision: defaultScope,
    documentId: 'doc-1',
    anchorNodeId: 'wiki:doc-1:current',
    subtreeHeadingIds: ['heading-current', 'heading-child'],
    anchorIsRoot: false,
  });
  const policy = agent.createWikiScopePolicy(state);
  const unsupportedDirect = agent.assessWikiDirectEvidence({
    question: '资源可用性是什么？',
    nodeMarkdown: '第一次恢复退避为 7 秒。',
    answer: '当前章节没有说明资源可用性 [0]。',
    actionKind: 'free',
  });
  assert.equal(unsupportedDirect.likelySupported, false);
  assert.equal(unsupportedDirect.acceptWithoutSearch, false);
  assert.equal(policy.evaluateFinalAnswer({ zeroCycleEvidenceSufficient: false }).accept, false, '无检索且直载内容不支持答案时必须继续检索。');
  const supportedDirect = agent.assessWikiDirectEvidence({
    question: '第一次恢复退避是多少秒？',
    nodeMarkdown: '第一次恢复退避为 7 秒。',
    answer: '第一次恢复退避为 7 秒 [0]。',
    actionKind: 'free',
  });
  assert.equal(supportedDirect.likelySupported, true);
  assert.equal(supportedDirect.acceptWithoutSearch, false, '事实性问题即使直载内容支持，也必须先完成一个证据工具周期。');
  const supportedLongChineseQuestion = agent.assessWikiDirectEvidence({
    question: '星桥处理文件时，原始文档会被修改吗？',
    nodeMarkdown: '星桥是本地资料处理平台。原始文件始终保持只读，不会回写用户文档。',
    answer: '不会。原始文档始终保持只读 [0]。',
    actionKind: 'free',
  });
  assert.equal(supportedLongChineseQuestion.likelySupported, true, '长中文问句中的四字核心词命中直载原文时不应被 bigram 分母误拒。');
  assert.equal(supportedLongChineseQuestion.acceptWithoutSearch, false);
  const supportedOverviewQuestion = agent.assessWikiDirectEvidence({
    question: '这个文章在讲什么',
    nodeMarkdown: '当前章节正文。第一次恢复退避是 7 秒，原始文件始终保持只读。',
    answer: '本章说明恢复退避与原始文件只读约束 [0]。',
    actionKind: 'free',
  });
  assert.equal(supportedOverviewQuestion.overviewRequest, true);
  assert.equal(supportedOverviewQuestion.likelySupported, true, '概括当前文章时，不能拿“文章在讲什么”这些元问题词去正文做字面匹配。');
  assert.equal(supportedOverviewQuestion.acceptWithoutSearch, false, '概括问题也必须进入 Agentic RAG 工具循环。');
  const emptyOverviewQuestion = agent.assessWikiDirectEvidence({
    question: '这个文章在讲什么',
    nodeMarkdown: '',
    answer: '这是一份无来源的概括 [0]。',
    actionKind: 'free',
  });
  assert.equal(emptyOverviewQuestion.likelySupported, false, '空节点不能仅凭概括意图绕过证据校验。');
  assert.equal(state.maxRetrievalCycles, 5);
  assert.equal(state.retrievalCycleCount, 0);
  assert.equal(state.documentSearchCount, 0);
  assert.equal(policy.documentSearchAvailable, true);
  const lockedPolicy = agent.createWikiScopePolicy(agent.createWikiScopeState({
    decision: locked,
    documentId: 'doc-1',
    anchorNodeId: 'wiki:doc-1:current',
    subtreeHeadingIds: ['heading-current'],
    anchorIsRoot: false,
  }));
  assert.equal(lockedPolicy.documentSearchAvailable, false);
  const rootPolicy = agent.createWikiScopePolicy(agent.createWikiScopeState({
    decision: documentFirst,
    documentId: 'doc-1',
    anchorNodeId: 'wiki:doc-1:root',
    subtreeHeadingIds: undefined,
    anchorIsRoot: true,
  }));
  assert.equal(rootPolicy.documentSearchAvailable, false, '根节点已覆盖全文，不应重复注册全文搜索工具。');

  policy.startModelDecision();
  const localFirst = policy.beginSearch({ toolName: 'wiki_node_search', range: 'subtree', args: { queries: ['资源可用性'] } });
  assert.equal(localFirst.allowed, true);
  assert.equal(localFirst.cycle, 1);
  const sameDecisionSecondSearch = policy.beginSearch({ toolName: 'wiki_grep_node', range: 'subtree', args: { pattern: 'availability' } });
  assert.equal(sameDecisionSecondSearch.blockReason, 'awaiting-evidence-assessment', '一次模型决策只能启动一个检索类动作。');
  policy.completeSearch({ range: 'subtree', ok: true, newEvidenceCount: 0 });
  policy.startModelDecision();
  const expanded = policy.beginSearch({ toolName: 'wiki_search_document', range: 'document', args: { queries: ['资源可用性'] } });
  assert.equal(expanded.allowed, true, '本章节零命中后应允许扩大到本文其他章节。');
  assert.equal(expanded.scopeEscalated, true);
  assert.equal(state.documentScopeEntered, true);
  policy.completeSearch({ range: 'document', ok: true, newEvidenceCount: 0 });
  policy.startModelDecision();
  assert.equal(
    policy.beginSearch({ toolName: 'wiki_node_search', range: 'subtree', args: { queries: ['缩回本节'] } }).blockReason,
    'scope-already-expanded',
    '范围扩大后不得再缩回本章节重启检索。',
  );

  const capState = agent.createWikiScopeState({
    decision: documentFirst,
    documentId: 'doc-1',
    anchorNodeId: 'wiki:doc-1:current',
    subtreeHeadingIds: ['heading-current'],
    anchorIsRoot: false,
  });
  const capPolicy = agent.createWikiScopePolicy(capState);
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    capPolicy.startModelDecision();
    const attempt = capPolicy.beginSearch({ toolName: 'wiki_search_document', range: 'document', args: { queries: [`查询 ${cycle}`] } });
    assert.equal(attempt.allowed, true);
    assert.equal(attempt.cycle, cycle);
    capPolicy.completeSearch({ range: 'document', ok: true, newEvidenceCount: 0 });
  }
  capPolicy.startModelDecision();
  const sixth = capPolicy.beginSearch({ toolName: 'wiki_search_document', range: 'document', args: { queries: ['查询 6'] } });
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.blockReason, 'cycle-limit', '第 6 次检索必须由 Wiki 周期门控硬拒绝。');
  assert.equal(capPolicy.evaluateFinalAnswer().stopReason, 'cycle-limit');

  assert.deepEqual(
    agent.buildWikiFallbackQueries({
      originalQuestion: '原问题',
      resolvedQuestion: '改写问题',
      subQuestions: ['改写问题', '子问题二', '子问题三', '子问题四', '子问题五', '子问题六'],
      explicitSectionTitles: [],
    }),
    ['改写问题', '子问题二', '子问题三', '子问题四', '子问题五'],
    '降级查询应去重且最多生成 5 条，不机械重复填充。',
  );

  globalThis.__wikiGenerateAiJson = async () => ({
    rewrite: '第二次恢复用了多久？',
    should_split: false,
    sub_questions: ['第二次恢复用了多久？'],
    scope_intent: 'document-first',
    explicit_section_titles: ['第四章'],
  });
  const rewritten = await agent.rewriteWikiQuestion({
    question: '那第二次呢？',
    history: agent.selectWikiRewriteHistory(conversation),
    actionKind: 'free',
    model: 'fixture',
    providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'fixture' },
    signal: new AbortController().signal,
  });
  assert.equal(rewritten.rewrite, '第二次恢复用了多久？');
  assert.equal(rewritten.scopeIntent, 'node-first', '模型输出 document-first 也不能扩大原问题范围。');
  assert.deepEqual(rewritten.explicitSectionTitles, [], '模型臆造的章节标题必须被丢弃。');

  globalThis.__wikiGenerateAiJson = async () => ({
    rewrite: '第二章讲了什么？',
    should_split: false,
    sub_questions: ['第二章讲了什么？'],
    scope_intent: 'node-first',
    explicit_section_titles: ['第二章', '不存在章节'],
  });
  const sectionRewrite = await agent.rewriteWikiQuestion({
    question: '第二章讲了什么？',
    history: [],
    actionKind: 'free',
    model: 'fixture',
    signal: new AbortController().signal,
  });
  assert.equal(sectionRewrite.scopeIntent, 'document-first');
  assert.deepEqual(sectionRewrite.explicitSectionTitles, ['第二章']);

  const wikiContext = agent.buildWikiRuntimeContext({
    documentName: '文档', nodeTitle: '当前章节', nodePath: '文档 › 当前章节', childTitles: [],
    nodeChars: 100, truncated: false,
    capabilities: { semanticSearch: true, keywordSearch: true, literalSearch: true, deepRead: true, documentSearch: true },
    scopeMode: 'node-first', scopeReason: 'default-node-first', now: new Date('2026-09-07T00:00:00.000Z'),
  });
  const prompt = agent.buildWikiAgentQuestion({
    userQuestion: '这里的资源可用性是啥？',
    resolvedQuestion: '当前章节中的资源可用性是什么？',
    wikiContext,
    nodeContent: '<node_content>证据</node_content>',
  });
  const orderedTags = ['<user_question>', '<resolved_question>', '<wiki_context', '<node_content>'];
  for (let index = 1; index < orderedTags.length; index += 1) {
    assert.ok(prompt.indexOf(orderedTags[index - 1]) < prompt.indexOf(orderedTags[index]), `提示块顺序错误：${orderedTags.join(' → ')}`);
  }
  assert.match(wikiContext, /max_retrieval_cycles="5"/u);
  const systemPrompt = agent.buildWikiNodeAgentSystemPrompt({
    documentName: '文档', nodeTitle: '当前章节', nodePath: '文档 › 当前章节', actionKind: 'free', scopeMode: 'node-first',
    capabilities: { semanticSearch: true, keywordSearch: true, literalSearch: true, deepRead: true, documentSearch: true },
  });
  assert.match(systemPrompt, /直接回答 <user_question>/u);
  assert.match(systemPrompt, /不要自我介绍/u);
  assert.match(systemPrompt, /不要附加“你还可以问”等建议问题/u);
  assert.match(systemPrompt, /必须先至少完成一次检索或深读工具调用/u, '事实性 Wiki 问答提示词必须要求首个证据工具周期。');
  assert.match(systemPrompt, /不得以 0 个工具周期直接终答/u);
}

function verifyBudgetAndScopeFilter(agent, materialSearch) {
  assert.deepEqual(
    {
      maxIterations: agent.WIKI_NODE_REACT_BUDGET.maxIterations,
      maxModelCalls: agent.WIKI_NODE_REACT_BUDGET.maxModelCalls,
      maxToolCalls: agent.WIKI_NODE_REACT_BUDGET.maxToolCalls,
      maxEmptyRetries: agent.WIKI_NODE_REACT_BUDGET.maxEmptyRetries,
      maxSingleObservationChars: agent.WIKI_NODE_REACT_BUDGET.maxSingleObservationChars,
      maxTotalObservationTokens: agent.WIKI_NODE_REACT_BUDGET.maxTotalObservationTokens,
    },
    { maxIterations: 10, maxModelCalls: 12, maxToolCalls: 12, maxEmptyRetries: 1, maxSingleObservationChars: 8_000, maxTotalObservationTokens: 20_000 },
  );
  assert.deepEqual(
    {
      maxIterations: agent.WIKI_NODE_SUMMARY_REACT_BUDGET.maxIterations,
      maxModelCalls: agent.WIKI_NODE_SUMMARY_REACT_BUDGET.maxModelCalls,
      maxToolCalls: agent.WIKI_NODE_SUMMARY_REACT_BUDGET.maxToolCalls,
      maxTotalObservationTokens: agent.WIKI_NODE_SUMMARY_REACT_BUDGET.maxTotalObservationTokens,
    },
    { maxIterations: 12, maxModelCalls: 14, maxToolCalls: 14, maxTotalObservationTokens: 32_000 },
    '长章节总结必须使用独立的覆盖阅读预算。',
  );
  const shortSummary = agent.resolveWikiSummaryPolicy(2_000);
  const longSummary = agent.resolveWikiSummaryPolicy(12_000);
  const veryLongSummary = agent.resolveWikiSummaryPolicy(80_000);
  assert.deepEqual(
    { min: shortSummary.targetMinChars, max: shortSummary.targetMaxChars, hardMax: shortSummary.hardMaxChars, expanded: shortSummary.requiresExpandedReading },
    { min: 300, max: 600, hardMax: 800, expanded: false },
  );
  assert.deepEqual(
    { min: longSummary.targetMinChars, max: longSummary.targetMaxChars, hardMax: longSummary.hardMaxChars, expanded: longSummary.requiresExpandedReading },
    { min: 1_000, max: 1_600, hardMax: 1_800, expanded: true },
  );
  assert.equal(veryLongSummary.hardMaxChars, 2_000, '万字章节总结的可见正文必须受 2,000 字上限约束。');
  const longSummaryContract = agent.buildWikiActionContract('summarize', { summaryPolicy: longSummary });
  assert.match(longSummaryContract, /不限制要点条数/u, '总结不应再固定为五条要点。');
  assert.match(longSummaryContract, /按 char_offset 分页深读/u, '长章节总结必须要求分页覆盖阅读。');
  assert.doesNotMatch(longSummaryContract, /至多 5 条/u, '总结契约不得保留旧的五条上限。');
  assert.match(
    agent.buildWikiNodeFallbackSystemPrompt({ documentName: '文档', nodeTitle: '章节', nodePath: '文档 › 章节', actionKind: 'cross-links' }),
    /跨章节检索能力当前不可用/u,
  );

  const rows = [
    { id: 'self', sectionPathJson: JSON.stringify([{ nodeId: 'heading-current' }]) },
    { id: 'child', sectionPathJson: JSON.stringify([{ nodeId: 'heading-current' }, { nodeId: 'heading-child' }]) },
    { id: 'sibling', sectionPathJson: JSON.stringify([{ nodeId: 'heading-sibling' }]) },
    { id: 'malformed', sectionPathJson: '{bad json' },
  ];
  assert.deepEqual(
    materialSearch.filterCandidatesBySectionNodes(rows, ['heading-current', 'heading-child']).map((row) => row.id),
    ['self', 'child'],
    '章节作用域过滤必须按 sectionPath 末位 nodeId 排除兄弟节点与坏数据',
  );
  assert.deepEqual(
    materialSearch.filterCandidatesBySectionNodes(rows, undefined).map((row) => row.id),
    ['self', 'child', 'sibling', 'malformed'],
    '只有 undefined 才表示根节点的整篇文档作用域，不应额外过滤候选',
  );
  assert.deepEqual(
    materialSearch.filterCandidatesBySectionNodes(rows, []).map((row) => row.id),
    [],
    '空章节集合必须 fail closed，不能意外放宽为全文候选',
  );
  assert.deepEqual(
    materialSearch.filterCandidatesBySectionNodes(rows, ['heading-sibling']).map((row) => row.id),
    ['sibling'],
    '其他章节候选只有在调用方明确给出对应 headingId 时才可进入结果',
  );
  const searchSource = fs.readFileSync(path.join(rootDir, 'electron', 'pipeline', 'materialChunkSearch.ts'), 'utf8');
  assert.match(searchSource, /const lexical = filterCandidatesBySectionNodes\(rawLexical,[\s\S]*?const vector = filterCandidatesBySectionNodes\(rawVector,[\s\S]*?mergeCandidates\(lexical,/u, '词法与向量候选必须在融合前分别过滤');
}

async function verifyGrepScope(agent) {
  const session = createSessionLedger();
  const context = {
    libraryPath: 'C:/wiki',
    documentId: 'doc-1',
    documentName: 'P4 夹具.md',
    nodeId: 'wiki:doc-1:current',
    sectionNodeIds: ['heading-current', 'heading-child'],
    outlineNodes: createOutline().nodes,
    session,
    signal: new AbortController().signal,
    prepareQueryContext: async () => ({ targetPath: 'C:/wiki' }),
    rerank: { enabled: false },
  };
  const matched = await agent.wikiGrepNodeTool.execute({ pattern: 'P4-ONLY' }, context);
  assert.equal(matched.ok, true);
  assert.equal(matched.referenceCount, 1, 'grep 只能登记当前章节子树中的一条命中');
  assert.doesNotMatch(matched.observation, /兄弟章节中的 P4-ONLY/u);
  assert.match(session.ledgerEntries()[0].sectionContext, /当前章节 \/ 子章节/u, 'grep 引用必须保留真实子章节路径');
  const rejected = await agent.wikiGrepNodeTool.execute({ pattern: 'P4-ONLY', node_id: 'wiki:doc-1:sibling' }, context);
  assert.equal(rejected.ok, false, 'grep 必须拒绝越过当前章节子树');
}

async function verifyCrossSectionDeepRead(agent) {
  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = [];
  const decision = agent.resolveWikiScopeDecision({ actionKind: 'free', userText: '资源可用性是什么？' });
  const scopeState = agent.createWikiScopeState({
    decision,
    documentId: 'doc-1',
    anchorNodeId: 'wiki:doc-1:current',
    subtreeHeadingIds: ['heading-current', 'heading-child'],
    anchorIsRoot: false,
  });
  const scopePolicy = agent.createWikiScopePolicy(scopeState);
  scopePolicy.startModelDecision();
  assert.equal(scopePolicy.beginSearch({ toolName: 'wiki_node_search', range: 'subtree', args: { queries: ['资源可用性'] } }).allowed, true);
  scopePolicy.completeSearch({ range: 'subtree', ok: true, newEvidenceCount: 0 });

  const context = {
    libraryPath: 'C:/wiki',
    documentId: 'doc-1',
    documentName: 'P4 夹具.md',
    nodeId: 'wiki:doc-1:current',
    sectionNodeIds: ['heading-current', 'heading-child'],
    outlineNodes: createOutline().nodes,
    scopeState,
    scopePolicy,
    session: createSessionLedger(),
    signal: new AbortController().signal,
    prepareQueryContext: async () => ({ targetPath: 'C:/wiki', queryTerms: ['资源可用性'] }),
    rerank: { enabled: false },
  };
  scopePolicy.startModelDecision();
  const crossTool = agent.createWikiScopedSearchTool(agent.wikiSearchDocumentTool, 'document');
  const cross = await crossTool.execute({ queries: ['资源可用性'] }, context);
  assert.equal(cross.ok, true);
  assert.match(cross.observation, /source_node_id="wiki:doc-1:sibling"/u, '跨章节结果必须返回可深读的真实 Wiki node_id。');
  assert.equal(scopeState.authorizedDocumentNodeIds.has('wiki:doc-1:sibling'), true);
  assert.match(context.session.ledgerEntries()[0].sectionContext, /兄弟章节/u, '跨章节证据台账必须保存真实章节路径。');

  const readSibling = await agent.wikiReadNodeTool.execute({ node_id: 'wiki:doc-1:sibling' }, context);
  assert.equal(readSibling.ok, true, '跨章节命中的同文档节点应获得本轮深读授权。');
  assert.match(readSibling.observation, /兄弟章节中的 P4-ONLY/u);
  const readUnrelated = await agent.wikiReadNodeTool.execute({ node_id: 'wiki:doc-1:root' }, context);
  assert.equal(readUnrelated.ok, false, '未由跨章节检索命中的外部节点仍须拒绝深读。');
}

async function verifyReactAndFallback(agent) {
  globalThis.__wikiRetrievalInputs = [];
  const eventLog = [];
  const traces = [];
  const transportCalls = [];
  const transport = {
    capability: 'native-tools',
    chat: async (_config, request) => {
      transportCalls.push(request);
      if (transportCalls.length === 1) {
        request.onDelta?.('先定位证据');
        request.onToolCallStart?.();
        return { content: '先定位证据', toolCalls: [{ id: 'tool-1', name: 'wiki_node_search', arguments: { queries: ['限定证据是什么'] } }] };
      }
      request.onDelta?.('限定结论来自子章节 [1]。');
      return { content: '限定结论来自子章节 [1]。', toolCalls: [], usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } };
    },
  };
  const images = [{ dataUrl: 'data:image/png;base64,ZmFrZQ==', mimeType: 'image/png', name: 'wiki.png' }];
  const react = await agent.runWikiNodeAgentTurn(createAgentInput({ transport, eventLog, traces, images }));
  assert.equal(react.degraded, undefined);
  assert.equal(react.result.answer, '限定结论来自子章节 [1]。');
  assert.deepEqual(react.result.knowledgeBaseCitations[0].nodePath, ['根节点', '当前章节', '子章节']);
  assert.equal(react.result.knowledgeBaseCitations[0].nodeId, 'wiki:doc-1:child', '引用必须投影到真实来源节点。');
  assert.equal(react.result.completeness, 'complete');
  assert.ok(react.result.modelEvents?.some((entry) => entry.state === 'completed' && entry.output?.text.includes('wiki_node_search')), 'Wiki ReAct 终态必须保留每轮模型工具决策输出。');
  assert.ok(eventLog.some((entry) => entry.type === 'model' && entry.event.state === 'completed'), 'Wiki ReAct 必须实时下发已脱敏的模型轮次事件。');
  assert.ok(react.result.toolEvents?.some((entry) => entry.round === 1), 'Wiki 工具事件必须带上产生该调用的模型轮次，供 UI 将决策输出与工具步骤配对。');
  assert.deepEqual(
    {
      initialScope: react.result.wikiScopeResult.initialScope,
      finalScope: react.result.wikiScopeResult.finalScope,
      cycles: react.result.wikiScopeResult.retrievalCyclesUsed,
      usedOtherSections: react.result.wikiScopeResult.usedOtherSections,
      stopReason: react.result.wikiScopeResult.stopReason,
    },
    { initialScope: 'subtree', finalScope: 'subtree', cycles: 1, usedOtherSections: false, stopReason: 'evidence-sufficient' },
  );
  assert.ok(react.metrics.rounds <= agent.WIKI_NODE_REACT_BUDGET.maxIterations);
  assert.ok(react.metrics.modelCalls <= agent.WIKI_NODE_REACT_BUDGET.maxModelCalls);
  assert.ok(react.metrics.toolCalls <= agent.WIKI_NODE_REACT_BUDGET.maxToolCalls);
  assert.ok(transportCalls[0].tools.some((tool) => tool.name === 'wiki_grep_node'), 'P4 必须注册 wiki_grep_node');
  assert.equal(transportCalls[0].maxOutputTokens, 1_400, '短章节总结也必须显式传递与长度策略匹配的输出容量。');
  assert.deepEqual(transportCalls[0].messages.find((message) => message.role === 'user' && message.images)?.images, images, 'Wiki ReAct 当前 user 消息必须保留图片上下文');
  assert.ok(!eventLog.some((entry) => entry.type === 'delta' && entry.text.includes('先定位证据')), '工具调用前的候选文本必须留在内存，不能先显示再撤回。');
  assert.deepEqual(globalThis.__wikiRetrievalInputs[0].documentIds, ['doc-1']);
  assert.deepEqual(globalThis.__wikiRetrievalInputs[0].sectionNodeIds.sort(), ['heading-child', 'heading-current']);

  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = ['empty'];
  const cyclingCalls = [];
  const cyclingEvents = [];
  const cycling = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: cyclingEvents,
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '资源可用性是什么？' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        cyclingCalls.push(request);
        if (cyclingCalls.length === 1) {
          return { content: '', toolCalls: [{ id: 'cycle-local', name: 'wiki_node_search', arguments: { queries: ['资源可用性'] } }] };
        }
        if (cyclingCalls.length === 2) {
          request.onDelta?.('当前章节没有找到，先结束。');
          return { content: '当前章节没有找到，先结束。', toolCalls: [] };
        }
        if (cyclingCalls.length === 3) {
          return { content: '', toolCalls: [{ id: 'cycle-document', name: 'wiki_search_document', arguments: { queries: ['资源可用性在其他章节的说明'] } }] };
        }
        request.onDelta?.('资源可用性见兄弟章节 [1]。');
        return { content: '资源可用性见兄弟章节 [1]。', toolCalls: [] };
      },
    },
  }));
  assert.equal(cycling.degraded, undefined);
  assert.equal(cycling.metrics.retrievalCycles, 2, '本章节零命中后应继续一个跨章节检索周期。');
  assert.equal(cycling.metrics.finalScope, 'document');
  assert.equal(cycling.metrics.scopeStopReason, 'evidence-sufficient');
  assert.equal(globalThis.__wikiRetrievalInputs.length, 2);
  assert.deepEqual(globalThis.__wikiRetrievalInputs[1].sectionNodeIds.sort(), ['heading-sibling', 'root']);
  assert.deepEqual(cycling.result.knowledgeBaseCitations[0].nodePath, ['根节点', '兄弟章节']);
  assert.equal(cycling.result.knowledgeBaseCitations[0].nodeId, 'wiki:doc-1:sibling');
  assert.equal(cycling.result.wikiScopeResult.initialScope, 'subtree');
  assert.equal(cycling.result.wikiScopeResult.finalScope, 'document');
  assert.equal(cycling.result.wikiScopeResult.usedOtherSections, true);
  assert.equal(cycling.result.wikiScopeResult.escalationReason, 'local-no-hit');
  assert.ok(cycling.result.wikiScopeResult.searchedSections.some((section) => section.nodeId === 'wiki:doc-1:sibling'));
  assert.ok(cyclingEvents.some((entry) => entry.type === 'tool'
    && entry.event.wikiScopeProgress?.currentCycle === 2
    && entry.event.wikiScopeProgress.activeRange === 'document'), '公开工具事件必须携带第 2/5 周期与文档范围。');
  assert.ok(!cyclingEvents.some((entry) => entry.type === 'delta' && entry.text.includes('当前章节没有找到')), '零命中后的过早终答不应先显示再收回。');

  globalThis.__wikiRetrievalInputs = [];
  const uncitedCalls = [];
  const uncitedEvents = [];
  const uncited = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: uncitedEvents,
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '限定证据是什么？' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        uncitedCalls.push(request);
        if (uncitedCalls.length === 1) {
          return { content: '', toolCalls: [{ id: 'uncited-search', name: 'wiki_node_search', arguments: { queries: ['限定证据'] } }] };
        }
        request.onDelta?.('限定结论来自子章节。');
        return { content: '限定结论来自子章节。', toolCalls: [] };
      },
    },
  }));
  assert.equal(uncitedCalls.length, 2, '已有对题证据时，缺失引用号不应触发连续终答重试。');
  assert.match(uncited.result.answer, /\[1\]/u, '缺失的真实台账引用应由终态守卫确定性补全。');
  assert.equal(uncited.result.knowledgeBaseCitations.length, 1);
  assert.ok(!uncitedEvents.some((entry) => entry.type === 'delta' && entry.text === '限定结论来自子章节。'), '需修复引用的候选终答不应提前投影到 UI。');

  const directCalls = [];
  const directEvents = [];
  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = [{ evidence: [{
    documentId: 'doc-1', childChunkId: 'child-direct', parentChunkId: 'parent-direct', parentOrdinal: 9,
    text: '星桥处理文件时，原始文件始终保持只读，不会回写用户文档。',
    sourceText: '星桥处理文件时，原始文件始终保持只读，不会回写用户文档。',
    score: 0.96, hitChildren: 1, methods: ['semantic'],
    sectionContext: '章节路径：根节点 / 当前章节\n章节：当前章节',
  }] }];
  const direct = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: directEvents,
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '星桥处理文件时，原始文档会被修改吗？' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        directCalls.push(request);
        if (directCalls.length === 1) {
          return { content: '', toolCalls: [{ id: 'direct-search', name: 'wiki_node_search', arguments: { queries: ['星桥 原始文件 只读'] } }] };
        }
        request.onDelta?.('不会。原始文档始终保持只读 [0]。');
        return { content: '不会。原始文档始终保持只读 [0]。', toolCalls: [] };
      },
    },
  }));
  assert.equal(directCalls.length, 2, '事实性问题必须先由 ReAct 调用证据工具，再进入终答轮。');
  assert.equal(direct.metrics.retrievalCycles, 1);
  assert.equal(direct.result.answer, '不会。原始文档始终保持只读 [0]。 [1]', '终答必须同时保留直载引用并补上工具证据引用。');
  assert.equal(direct.result.knowledgeBaseCitations.length, 2);
  assert.ok(!directEvents.some((entry) => entry.type === 'delta-reset'), '已通过证据门的单次回答不应重置后再生成。');

  const overviewCalls = [];
  const overviewEvents = [];
  const overview = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: overviewEvents,
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '这个文章在讲什么' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        overviewCalls.push(request);
        if (overviewCalls.length === 1) {
          return { content: '', toolCalls: [{ id: 'overview-search', name: 'wiki_node_search', arguments: { queries: ['当前章节主题与核心内容'] } }] };
        }
        request.onDelta?.('本章说明恢复退避与原始文件只读约束。');
        return { content: '本章说明恢复退避与原始文件只读约束。', toolCalls: [] };
      },
    },
  }));
  assert.equal(overviewCalls.length, 2, '截图中的概括问法必须先执行一次 ReAct 检索，再输出终答。');
  assert.equal(overview.metrics.retrievalCycles, 1);
  assert.equal(overview.metrics.scopeStopReason, 'evidence-sufficient');
  assert.equal(overview.result.answer, '本章说明恢复退避与原始文件只读约束。 [0][1]', '缺少的直载与工具证据引用应在本地补齐，不得重新访问模型。');
  assert.equal(overview.result.knowledgeBaseCitations.length, 2);
  assert.doesNotMatch(overview.result.answer, /没有找到能够支持这个问题的内容/u);
  assert.ok(!overviewEvents.some((entry) => entry.type === 'delta-reset'), '本地补引用不应产生一次可见的重新生成。');

  const ignoredNudgeCalls = [];
  const ignoredNudge = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: [],
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '当前章节完全不存在的海鸥策略是什么？' },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        ignoredNudgeCalls.push(request);
        request.onDelta?.('这是一份没有证据的候选回答。');
        return { content: '这是一份没有证据的候选回答。', toolCalls: [] };
      },
    },
  }));
  assert.equal(ignoredNudgeCalls.length, 2, '模型忽略检索提示时，同一检索周期最多只允许一次终答纠正。');
  assert.match(ignoredNudge.result.answer, /未完成事实性 Wiki 问答所需的章节检索或深读/u);
  assert.equal(ignoredNudge.metrics.scopeStopReason, 'no-new-query');

  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = Array(5).fill('empty');
  let cappedCall = 0;
  const capped = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: [],
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '结合全文说明资源可用性' },
    transport: {
      capability: 'native-tools',
      chat: async () => {
        cappedCall += 1;
        if (cappedCall <= 6) {
          return {
            content: '',
            toolCalls: [{ id: `cap-${cappedCall}`, name: 'wiki_search_document', arguments: { queries: [`全文查询 ${cappedCall}`] } }],
          };
        }
        return { content: '受控检索已到上限，本文没有找到足够证据。', toolCalls: [] };
      },
    },
  }));
  assert.equal(globalThis.__wikiRetrievalInputs.length, 5, '第 6 次工具请求不得穿透到真实检索层。');
  assert.equal(capped.metrics.retrievalCycles, 5);
  assert.equal(capped.metrics.scopeStopReason, 'cycle-limit');
  assert.equal(capped.metrics.maxRetrievalCycles, 5);
  assert.equal(capped.result.completeness, 'not-found');
  assert.equal(capped.result.wikiScopeResult.stopReason, 'cycle-limit');
  assert.equal(capped.result.wikiScopeResult.retrievalCyclesUsed, 5);

  const followupCalls = [];
  const followupEvents = [];
  const followupTraces = [];
  const followup = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: followupEvents,
    traces: followupTraces,
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: {
      userText: '那第二次呢？',
      conversation: [
        { role: 'user', content: '第一次恢复用了多久？' },
        { role: 'assistant', content: '第一次退避是 7 秒。' },
      ],
    },
    rewriteQuestion: async () => ({
      rewrite: '第二次恢复用了多久？',
      shouldSplit: false,
      subQuestions: ['第二次恢复用了多久？'],
      scopeIntent: 'node-first',
      explicitSectionTitles: [],
      model: 'fixture',
      elapsedMs: 1,
    }),
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        followupCalls.push(request);
        request.onDelta?.('第二次恢复使用 31 秒退避 [0]。');
        return { content: '第二次恢复使用 31 秒退避 [0]。', toolCalls: [] };
      },
    },
  }));
  assert.equal(followup.degraded, undefined);
  const currentUserPrompt = followupCalls[0].messages.filter((message) => message.role === 'user').at(-1).content;
  const promptTags = ['<user_question>', '<resolved_question>', '<wiki_context', '<node_content'];
  for (let index = 1; index < promptTags.length; index += 1) {
    assert.ok(currentUserPrompt.indexOf(promptTags[index - 1]) < currentUserPrompt.indexOf(promptTags[index]), '真实 ReAct 入口必须保持问题优先顺序。');
  }
  assert.match(currentUserPrompt, /<user_question>\n那第二次呢？\n<\/user_question>/u);
  assert.match(currentUserPrompt, /<resolved_question>\n第二次恢复用了多久？\n<\/resolved_question>/u);
  assert.ok(followupCalls[0].tools.some((tool) => tool.name === 'wiki_search_document'), 'node-first 自由问答应注册受控的同文档搜索工具。');
  assert.ok(followupEvents.some((entry) => entry.type === 'tool' && entry.event.tool === 'rewrite_question' && entry.event.state === 'completed'));
  assert.ok(followupTraces.some((entry) => entry.stage === 'routing' && entry.action === 'wiki-scope-decision' && entry.output.mode === 'node-first'));

  const failedRewriteEvents = [];
  let failedRewritePrompt = '';
  const failedRewrite = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: failedRewriteEvents,
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '那第二次呢？', conversation: [{ role: 'user', content: '第一次呢？' }] },
    rewriteQuestion: async () => { throw new Error('scripted rewrite failure'); },
    transport: {
      capability: 'native-tools',
      chat: async (_config, request) => {
        if (!failedRewritePrompt) failedRewritePrompt = request.messages.filter((message) => message.role === 'user').at(-1).content;
        return { content: '已基于原问题继续回答 [0]。', toolCalls: [] };
      },
    },
  }));
  assert.equal(failedRewrite.degraded, undefined, '改写失败不能让整轮 Wiki 问答降级或失败。');
  assert.match(failedRewritePrompt, /<resolved_question>\n那第二次呢？\n<\/resolved_question>/u);
  assert.ok(failedRewriteEvents.some((entry) => entry.type === 'tool' && entry.event.tool === 'rewrite_question' && entry.event.state === 'rejected'));

  globalThis.__wikiRetrievalInputs = [];
  const fallbackEvents = [];
  let fallbackPrompt = '';
  let fallbackImages;
  let fallbackOutputTokenCap;
  const fallback = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: fallbackEvents,
    traces: [],
    images,
    streamAnswer: async (input) => {
      fallbackPrompt = input.userPrompt;
      fallbackImages = input.images;
      fallbackOutputTokenCap = input.maxOutputTokens;
      input.onDelta('降级回答仍使用限定证据 [1]。');
      return { answer: '降级回答仍使用限定证据 [1]。', contextUsage: estimatedUsage() };
    },
  }));
  assert.equal(fallback.degraded, true);
  assert.match(fallback.result.answer, /^> 检索能力受限/u);
  assert.equal(fallback.metrics.toolCalls, 1);
  assert.equal(globalThis.__wikiRetrievalInputs.length, 1, '降级流水线只能执行一次节点检索');
  assert.match(fallbackPrompt, /<fallback_search_results>[\s\S]*子章节中的限定证据/u);
  assert.ok(fallbackPrompt.startsWith('<user_question>'), '降级提示也必须让用户问题位于第一语义块。');
  assert.deepEqual(fallbackImages, images, 'Wiki 降级回答也必须保留图片上下文');
  assert.equal(fallbackOutputTokenCap, 1_400, '降级总结必须复用同一长度策略的输出容量。');
  assert.equal(fallback.result.wikiDraft.markdown, fallback.result.answer, '降级回答仍需产出快捷动作草稿');
  assert.equal(fallback.result.wikiScopeResult.stopReason, 'evidence-sufficient');
  assert.equal(fallback.result.completeness, 'complete', '降级本身不应覆盖范围与证据足够时的 complete。');
  assert.ok(fallbackEvents.some((entry) => entry.type === 'delta' && entry.text.startsWith('> 检索能力受限')));

  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = ['empty'];
  let expandedFallbackPrompt = '';
  const expandedFallback = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: [],
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: { userText: '资源可用性是什么？' },
    streamAnswer: async (input) => {
      expandedFallbackPrompt = input.userPrompt;
      input.onDelta('降级链路从其他章节找到了证据 [1]。');
      return { answer: '降级链路从其他章节找到了证据 [1]。', contextUsage: estimatedUsage() };
    },
  }));
  assert.equal(expandedFallback.degraded, true);
  assert.equal(expandedFallback.metrics.retrievalCycles, 2, '降级链路本节零命中后也应扩大范围继续查找。');
  assert.equal(expandedFallback.metrics.finalScope, 'document');
  assert.deepEqual(globalThis.__wikiRetrievalInputs[1].sectionNodeIds.sort(), ['heading-sibling', 'root']);
  assert.match(expandedFallbackPrompt, /兄弟章节中的跨章节证据/u);
  assert.match(expandedFallback.result.answer, /已执行 2\/5 次受控检索/u);

  globalThis.__wikiRetrievalInputs = [];
  globalThis.__wikiRetrievalOutcomes = Array(5).fill('empty');
  const cappedFallback = await agent.runWikiNodeAgentTurn(createAgentInput({
    eventLog: [],
    traces: [],
    wikiTargetOverrides: { actionKind: 'free' },
    requestOverrides: {
      userText: '那这个呢？',
      conversation: [{ role: 'user', content: '请分析资源可用性。' }],
    },
    rewriteQuestion: async () => ({
      rewrite: '资源可用性的完整说明是什么？',
      shouldSplit: true,
      subQuestions: ['条件是什么？', '限制是什么？', '如何恢复？', '如何检查？', '例外是什么？', '还有什么？'],
      scopeIntent: 'node-first',
      explicitSectionTitles: [],
      model: 'fixture',
      elapsedMs: 1,
    }),
    streamAnswer: async (input) => {
      input.onDelta('五次受控检索后仍未找到证据。');
      return { answer: '五次受控检索后仍未找到证据。', contextUsage: estimatedUsage() };
    },
  }));
  assert.equal(globalThis.__wikiRetrievalInputs.length, 5, '降级链路也必须在第 5 个真实检索周期后停止。');
  assert.equal(cappedFallback.metrics.retrievalCycles, 5);
  assert.equal(cappedFallback.metrics.scopeStopReason, 'cycle-limit');

  globalThis.__wikiRetrievalInputs = [];
  const errored = await agent.runWikiNodeAgentTurn(createAgentInput({
    transport: { capability: 'native-tools', chat: async () => { throw new Error('scripted react failure'); } },
    eventLog: [],
    traces: [],
    streamAnswer: async (input) => {
      input.onDelta('异常回退完成 [1]。');
      return { answer: '异常回退完成 [1]。', contextUsage: estimatedUsage() };
    },
  }));
  assert.equal(errored.degraded, true);
  assert.match(errored.metrics.stopDetail, /agent-error: scripted react failure/u);
  assert.equal(globalThis.__wikiRetrievalInputs.length, 1, 'ReAct 异常后仍应复用受控回退检索并在首个充分命中后停止');
}

async function verifyEventMapping(dataSourceModule) {
  const listeners = new Set();
  let startedRequest;
  const savedMemories = [];
  const fixtureFinalAnswer = `${'这是经过证据门确认、按统一缓冲节奏展示的最终回答。'.repeat(8)} [1]`;
  globalThis.window = {
    electronAPI: {
      onAssistantTurnEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async startAssistantTurn(request) {
        startedRequest = request;
        const send = (event) => listeners.forEach((listener) => listener({ requestId: request.requestId, ...event }));
        const toolStarted = {
          tool: 'knowledge_agent_search', state: 'started', message: '正在检索', round: 1,
          wikiScopeProgress: {
            phase: 'searching', scopeMode: 'node-first', activeRange: 'subtree', currentCycle: 1,
            maxRetrievalCycles: 5, documentScopeEntered: false, localSearchCount: 1, documentSearchCount: 0,
          },
        };
        const toolCompleted = {
          tool: 'knowledge_agent_search', state: 'completed', message: '已检索到 1 条证据', round: 1,
          outputSummary: '新增引用 1 条', elapsedMs: 48,
          wikiScopeProgress: {
            phase: 'completed', scopeMode: 'node-first', activeRange: 'subtree', currentCycle: 1,
            maxRetrievalCycles: 5, documentScopeEntered: false, localSearchCount: 1, documentSearchCount: 0,
            newEvidenceCount: 1,
          },
        };
        const modelStarted = {
          callId: 'react-native-model-1', round: 1, callKind: 'decide', state: 'started',
          input: { text: '[user]\\n问题', originalCharacters: 9, truncated: false },
        };
        const modelCompleted = {
          ...modelStarted,
          state: 'completed',
          output: { text: `[工具调用]
wiki_node_search`, originalCharacters: 26, truncated: false },
          elapsedMs: 31,
        };
        send({ type: 'started', intent: 'ask', scopeLabel: 'Wiki 节点问答' });
        send({ type: 'model', event: modelStarted });
        send({ type: 'model', event: modelCompleted });
        send({ type: 'delta', text: '临时文本' });
        send({ type: 'delta-reset' });
        send({ type: 'tool', event: toolStarted });
        send({ type: 'tool', event: toolCompleted });
        send({ type: 'delta', text: '这是经过证据门确认' });
        send({
          type: 'complete',
          result: {
            type: 'answer', answer: fixtureFinalAnswer, provider: 'ollama', model: 'fixture', sourceNotes: [],
            knowledgeBaseCitations: [{ reference: 1, documentName: 'P4.md', parentOrdinal: 7, content: '证据', nodePath: ['根节点', '子章节'], nodeId: 'wiki:doc-1:child' }],
            retrievalMode: 'hybrid', completeness: 'complete', toolEvents: [toolStarted, toolCompleted], modelEvents: [modelStarted, modelCompleted], executionElapsedMs: 96,
            wikiScopeResult: {
              scopeMode: 'node-first', initialScope: 'subtree', finalScope: 'document', retrievalCyclesUsed: 2,
              maxRetrievalCycles: 5, localSearchCount: 1, documentSearchCount: 1, usedOtherSections: true,
              searchedSections: [{ nodePath: ['根节点', '子章节'], nodeId: 'wiki:doc-1:child' }],
              stopReason: 'evidence-sufficient', escalationReason: 'local-no-hit',
            },
            wikiDraft: { title: '当前章节', markdown: fixtureFinalAnswer, proposedChildren: [] },
          },
        });
      },
      async cancelAssistantTurn() {},
      async listWikiAiMemories(_libraryPath, documentId) {
        return { ok: true, memories: savedMemories.filter((memory) => memory.documentId === documentId).map(({ documentId: _documentId, ...memory }) => memory) };
      },
      async upsertWikiAiMemory(_libraryPath, request) {
        const existing = request.memoryId
          ? savedMemories.find((memory) => memory.documentId === request.documentId && memory.id === request.memoryId)
          : savedMemories.find((memory) => memory.documentId === request.documentId && memory.nodeId === request.nodeId);
        const memory = existing
          ? { ...existing, conversation: request.conversation, updatedAt: '2026-09-07T00:00:01.000Z' }
          : {
            id: 'wiki-memory-fixture',
            documentId: request.documentId,
            nodeId: request.nodeId,
            title: '当前章节',
            pinned: false,
            conversation: request.conversation,
            createdAt: '2026-09-07T00:00:00.000Z',
            updatedAt: '2026-09-07T00:00:00.000Z',
          };
        if (existing) Object.assign(existing, memory);
        else savedMemories.push(memory);
        const { documentId: _documentId, ...view } = memory;
        return { ok: true, memory: view };
      },
      async createWikiAiMemory(_libraryPath, request) {
        const memory = {
          id: 'wiki-memory-new-fixture',
          documentId: request.documentId,
          nodeId: request.nodeId,
          title: '当前章节 · 新对话',
          pinned: false,
          conversation: [],
          createdAt: '2026-09-07T00:00:02.000Z',
          updatedAt: '2026-09-07T00:00:02.000Z',
        };
        savedMemories.push(memory);
        const { documentId: _documentId, ...view } = memory;
        return { ok: true, memory: view };
      },
      async setWikiAiMemoryPinned(_libraryPath, request) {
        const memory = savedMemories.find((candidate) => candidate.documentId === request.documentId && candidate.id === request.memoryId);
        if (!memory) return { ok: false, error: { code: 'WIKI_MEMORY_NOT_FOUND', message: '记忆不存在' } };
        memory.pinned = request.pinned;
        memory.updatedAt = '2026-09-07T00:00:04.000Z';
        const { documentId: _documentId, ...view } = memory;
        return { ok: true, memory: view };
      },
      async renameWikiAiMemory() { throw new Error('fixture does not rename'); },
      async deleteWikiAiMemory() { throw new Error('fixture does not delete'); },
    },
  };
  const source = new dataSourceModule.ElectronWikiDataSource('C:/wiki');
  const events = [];
  const attachments = [{ kind: 'image', attachmentId: 'image-wiki-fixture', name: 'wiki.png', mimeType: 'image/png', sizeBytes: 4, dataUrl: 'data:image/png;base64,ZmFrZQ==' }];
  for await (const event of source.analyzeNode(
    'doc-1',
    'wiki:doc-1:current',
    '问题',
    'summarize',
    attachments,
    { modelProfileId: 'reasoning-profile', thinkingMode: 'advanced' },
  )) events.push(event);
  const finalMessage = [...events].reverse().find((event) => event.type === 'message-added' && event.message.role === 'assistant' && !event.message.streaming);
  assert.equal(finalMessage.message.content, fixtureFinalAnswer);
  const streamedAnswerSnapshots = events.filter((event) => (
    event.type === 'message-added'
    && event.message.role === 'assistant'
    && event.message.streaming
    && event.message.content.length > 0
  ));
  assert.ok(streamedAnswerSnapshots.length >= 3, '整段终答也必须按问答区的共享帧策略拆成多个可见增量。');
  assert.ok(streamedAnswerSnapshots[0].message.content.length < fixtureFinalAnswer.length, '首帧不能直接覆盖为完整终答。');
  assert.ok(streamedAnswerSnapshots.every((event) => fixtureFinalAnswer.startsWith(event.message.content)), '流式帧必须始终是终答的有序前缀。');
  assert.ok(streamedAnswerSnapshots.every((event, index) => index === 0 || event.message.content.length >= streamedAnswerSnapshots[index - 1].message.content.length), '流式帧内容长度只能单调增长。');
  assert.deepEqual(finalMessage.message.citations[0].nodePath, ['根节点', '子章节']);
  assert.equal(finalMessage.message.citations[0].nodeId, 'wiki:doc-1:child');
  assert.equal(finalMessage.message.retrieval.usedOtherSections, true);
  assert.equal(finalMessage.message.retrieval.currentCycle, 2);
  assert.equal(finalMessage.message.toolEvents.length, 2, 'Wiki 终态消息必须保留完整工具步骤。');
  assert.equal(finalMessage.message.modelEvents.at(-1).output.text, '[工具调用]\nwiki_node_search', 'Wiki 终态消息必须保留模型本轮输出。');
  assert.equal(finalMessage.message.executionElapsedMs, 96, 'Wiki 终态消息必须保留工具过程总耗时。');
  assert.ok(events.some((event) => event.type === 'retrieval-updated' && event.retrieval.phase === 'searching' && event.retrieval.currentCycle === 1));
  assert.ok(events.some((event) => event.type === 'message-added' && event.message.streaming && event.message.content === ''), 'delta-reset 必须清空流式消息');
  assert.ok(events.findIndex((event) => event.type === 'draft-ready') < events.findIndex((event) => event.type === 'operation-finished'), 'draft-ready 必须先于完成事件');
  assert.deepEqual(startedRequest.attachments, attachments, 'Wiki 数据源必须把附件送入真实 AssistantTurn 请求');
  assert.equal(startedRequest.modelProfileId, 'reasoning-profile', 'Wiki 节点请求必须透传本轮模型选择。');
  assert.equal(startedRequest.thinkingMode, 'advanced', 'Wiki 节点请求必须透传本轮思考强度。');
  assert.deepEqual(savedMemories[0].conversation.map((message) => message.content), ['问题', fixtureFinalAnswer], '完成节点问答后必须把受限会话记忆写入本地持久化桥接。');
  const newConversation = await source.createAiMemory('doc-1', 'wiki:doc-1:current');
  assert.deepEqual(newConversation.conversation, [], '新建对话必须切换到一条空白记忆。');
  const pinnedConversation = await source.setAiMemoryPinned('doc-1', newConversation.id, true);
  assert.equal(pinnedConversation.pinned, true, 'Electron 数据源必须把置顶状态写回当前 Wiki 记忆。');
  for await (const _event of source.analyzeNode('doc-1', 'wiki:doc-1:current', '新问题')) {
    // 消费完整事件流，确保记忆写入承诺已完成。
  }
  assert.deepEqual(startedRequest.conversation, [], '新建对话后的下一次请求不能携带旧对话上下文。');
  const savedNewConversation = savedMemories.find((memory) => memory.id === newConversation.id);
  assert.deepEqual(savedNewConversation.conversation.map((message) => message.content), ['新问题', fixtureFinalAnswer], '新建对话后的问答必须更新新记忆，而非覆盖旧记忆。');
  const userMessage = events.find((event) => event.type === 'message-added' && event.message.role === 'user');
  assert.deepEqual(userMessage.message.attachments, attachments, 'Wiki 用户消息必须保留附件供界面回显');
  delete globalThis.window;
}

async function verifyQuestions(questions) {
  let capturedInput;
  globalThis.__wikiGenerateAiJson = async (input) => {
    capturedInput = input;
    return { questions: ['本节结论是什么？', '如何执行本节步骤？', '本节结论是什么？', 42] };
  };
  const strict = await questions.generateWikiNodeQuestions(questionInput());
  assert.deepEqual(strict, ['本节结论是什么？', '如何执行本节步骤？']);
  assert.equal(capturedInput.timeoutMs, 8_000);
  assert.equal(capturedInput.maxOutputTokens, 256);
  assert.equal(capturedInput.callKind, 'wiki-node-questions');
  assert.equal(capturedInput.jsonSchema.strict, true);

  let rawSeen = '';
  globalThis.__wikiGenerateAiJson = async (input) => {
    input.onRawResponse('模型前缀 {"suggestions":["宽松问题一？","宽松问题二？"]}');
    throw { reason: 'schema-validation' };
  };
  const lenient = await questions.generateWikiNodeQuestions({ ...questionInput(), onRawOutput: (raw) => { rawSeen = raw; } });
  assert.deepEqual(lenient, ['宽松问题一？', '宽松问题二？']);
  assert.match(rawSeen, /suggestions/u, 'schema-validation 回退必须保留 rawOutput 落痕');

  globalThis.__wikiGenerateAiJson = async () => { throw new Error('请求超时'); };
  const libraryPath = path.join(outDir, 'question-library');
  fs.mkdirSync(libraryPath, { recursive: true });
  const degraded = await questions.resolveWikiNodeQuestions({
    libraryPath, documentId: 'doc-1', nodeId: 'wiki:doc-1:current', contentHash: 'hash-1',
    nodeTitle: '当前章节', nodePath: '根节点 › 当前章节', childTitles: ['子章节'], nodeMarkdown: '正文',
    model: 'fixture', providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'fixture' }, refresh: true,
  });
  assert.deepEqual(degraded, { questions: [], degraded: true, fromCache: false }, '超时必须静默降级为空问题集且不伪装缓存命中');
}

async function verifyDerivedNodes(derived) {
  const libraryPath = path.join(outDir, 'derived-library');
  fs.mkdirSync(libraryPath, { recursive: true });
  const outline = createOutline();
  const [first, second] = await Promise.all([
    derived.addWikiDerivedNode({ libraryPath, outline, request: { documentId: 'doc-1', parentId: 'wiki:doc-1:current', title: '派生一', markdown: '一' } }),
    derived.addWikiDerivedNode({ libraryPath, outline, request: { documentId: 'doc-1', parentId: 'wiki:doc-1:current', title: '派生二', markdown: '二' } }),
  ]);
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(first.node.order, second.node.order, '并发新增必须通过每文档写队列分配不同顺序');
  let merged = derived.mergeWikiDerivedNodes(libraryPath, outline);
  const nested = await derived.addWikiDerivedNode({
    libraryPath,
    outline: merged,
    request: { documentId: 'doc-1', parentId: first.node.id, title: '派生后代', markdown: '后代' },
  });
  assert.equal(nested.ok, true);
  merged = derived.mergeWikiDerivedNodes(libraryPath, outline);
  const protectedRename = await derived.renameWikiDerivedNode({
    libraryPath,
    outline: merged,
    request: { documentId: 'doc-1', nodeId: 'wiki:doc-1:current', title: '禁止修改' },
  });
  assert.equal(protectedRename.ok, false);
  assert.equal(protectedRename.error.code, 'WIKI_DERIVED_SOURCE_PROTECTED');
  const removed = await derived.deleteWikiDerivedNode({
    libraryPath,
    outline: merged,
    request: { documentId: 'doc-1', nodeId: first.node.id },
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(new Set(removed.deletedNodeIds), new Set([first.node.id, nested.node.id]), '删除派生节点必须级联后代');
  assert.equal(derived.readWikiDerivedNodes(libraryPath, 'doc-1', 'stale-hash').length, 0, 'contentHash 变化必须使派生节点整文件失效');
}

async function verifyAiMemories(memories) {
  const libraryPath = path.join(outDir, 'ai-memory-library');
  fs.mkdirSync(libraryPath, { recursive: true });
  const outline = createOutline();
  const first = await memories.upsertWikiAiMemory({
    libraryPath,
    outline,
    request: {
      documentId: 'doc-1',
      nodeId: 'wiki:doc-1:current',
      conversation: [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }],
    },
    now: new Date('2026-09-07T00:00:00.000Z'),
  });
  assert.equal(first.ok, true);
  const second = await memories.upsertWikiAiMemory({
    libraryPath,
    outline,
    request: {
      documentId: 'doc-1',
      nodeId: 'wiki:doc-1:current',
      conversation: [{ role: 'user', content: '第二问' }, { role: 'assistant', content: '第二答' }],
    },
    now: new Date('2026-09-07T00:00:01.000Z'),
  });
  assert.equal(second.ok, true);
  assert.equal(second.memory.id, first.memory.id, '同一章节的后续问答必须更新已有记忆，而不是产生重复条目。');
  const fresh = await memories.createWikiAiMemory({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', nodeId: 'wiki:doc-1:current' },
    now: new Date('2026-09-07T00:00:02.000Z'),
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.memory.pinned, false, '新建 Wiki AI 记忆默认不置顶。');
  assert.deepEqual(fresh.memory.conversation, [], '新建对话必须先保存一条空白记忆。');
  const continuedFresh = await memories.upsertWikiAiMemory({
    libraryPath,
    outline,
    request: {
      documentId: 'doc-1',
      nodeId: 'wiki:doc-1:current',
      memoryId: fresh.memory.id,
      conversation: [{ role: 'user', content: '新对话的问题' }, { role: 'assistant', content: '新对话的回答' }],
    },
    now: new Date('2026-09-07T00:00:03.000Z'),
  });
  assert.equal(continuedFresh.ok, true);
  assert.equal(continuedFresh.memory.id, fresh.memory.id, '新建后后续问答必须只更新当前新对话。');
  const renamed = await memories.renameWikiAiMemory({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', memoryId: first.memory.id, title: '已重命名记忆' },
    now: new Date('2026-09-07T00:00:04.000Z'),
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.memory.title, '已重命名记忆');
  const pinned = await memories.setWikiAiMemoryPinned({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', memoryId: first.memory.id, pinned: true },
    now: new Date('2026-09-07T00:00:05.000Z'),
  });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.memory.pinned, true, '置顶状态必须写入 Wiki AI 记忆元数据。');
  const newerUnpinned = await memories.upsertWikiAiMemory({
    libraryPath,
    outline,
    request: {
      documentId: 'doc-1',
      nodeId: 'wiki:doc-1:current',
      memoryId: fresh.memory.id,
      conversation: [{ role: 'user', content: '更新的问题' }, { role: 'assistant', content: '更新的回答' }],
    },
    now: new Date('2026-09-07T00:00:06.000Z'),
  });
  assert.equal(newerUnpinned.ok, true);
  const ordered = memories.listWikiAiMemories(libraryPath, outline);
  assert.equal(ordered.length, 2, '同一章节可以保留多份独立对话。');
  assert.equal(ordered[0].id, first.memory.id, '已置顶记忆必须排在更新时间更晚的普通记忆之前。');
  const unpinned = await memories.setWikiAiMemoryPinned({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', memoryId: first.memory.id, pinned: false },
    now: new Date('2026-09-07T00:00:07.000Z'),
  });
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.memory.pinned, false, '取消置顶必须持久化。');
  const removed = await memories.deleteWikiAiMemory({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', memoryId: first.memory.id },
  });
  assert.equal(removed.ok, true);
  assert.equal(memories.listWikiAiMemories(libraryPath, outline).length, 1, '删除只清除指定记忆。');
  const removedFresh = await memories.deleteWikiAiMemory({
    libraryPath,
    outline,
    request: { documentId: 'doc-1', memoryId: fresh.memory.id },
  });
  assert.equal(removedFresh.ok, true);
  assert.equal(memories.listWikiAiMemories(libraryPath, outline).length, 0);
  const legacyMemoryPath = path.join(libraryPath, '.menghan-meta', 'wiki', 'doc-1.ai-memories.json');
  fs.writeFileSync(legacyMemoryPath, JSON.stringify({
    schemaVersion: 1,
    documentId: 'doc-1',
    contentHash: outline.contentHash,
    memories: [{
      id: 'legacy-memory-without-pinned',
      nodeId: 'wiki:doc-1:current',
      title: '旧版记忆',
      conversation: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }), 'utf8');
  assert.equal(memories.readWikiAiMemories(libraryPath, 'doc-1', outline.contentHash)[0]?.pinned, false, '旧版记忆缺少 pinned 字段时必须兼容为未置顶。');
  assert.equal(memories.readWikiAiMemories(libraryPath, 'doc-1', 'stale-hash').length, 0, '内容哈希变化必须使 Wiki AI 记忆失效。');
}

function createAgentInput({
  transport,
  streamAnswer,
  rewriteQuestion,
  eventLog = [],
  traces = [],
  images,
  requestOverrides = {},
  wikiTargetOverrides = {},
}) {
  const wikiTarget = {
    libraryPath: 'C:/wiki',
    documentId: 'doc-1',
    nodeId: 'wiki:doc-1:current',
    actionKind: 'summarize',
    ...wikiTargetOverrides,
  };
  return {
    event: {},
    request: {
      requestId: `wiki_verify_${Math.random().toString(36).slice(2, 12)}`,
      intent: 'ask',
      scope: 'wiki-node',
      userText: '限定证据是什么？',
      conversation: [],
      ...requestOverrides,
      wikiTarget,
    },
    controller: new AbortController(),
    wikiTarget,
    outline: createOutline(),
    model: 'fixture',
    provider: 'ollama',
    providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'fixture' },
    contextWindowTokens: 32_000,
    modelCallCoordinator: {
      prepare: () => ({ ready: true, call: { ticket: { id: 'ticket-1', callKind: 'direct' }, plan: { maxOutputTokens: 2_000, rawPromptTokens: 100, predictedPromptTokens: 100, calibrationMultiplier: 1 } } }),
    },
    onDetailedTrace: (entry) => traces.push(entry),
    store: {},
    emitTurnEvent: (entry) => eventLog.push(entry),
    prepareMaterialSearchContext: async (_libraryPath, query) => ({ targetPath: 'C:/wiki', queryTerms: [query] }),
    ...(images ? { images } : {}),
    ...(transport ? { transport } : {}),
    ...(streamAnswer ? { streamAnswer } : {}),
    ...(rewriteQuestion ? { rewriteQuestion } : {}),
  };
}

function createOutline() {
  return {
    documentId: 'doc-1',
    title: '根节点',
    description: 'P4 fixture',
    updatedAt: '2026-09-06T00:00:00.000Z',
    contentHash: 'hash-1',
    orderRevisions: {},
    nodes: [
      { id: 'wiki:doc-1:root', parentId: null, title: '根节点', order: 0, depth: 0, markdown: '', sourceHeadingId: 'root', sourceLineNo: 1, kind: 'source' },
      { id: 'wiki:doc-1:current', parentId: 'wiki:doc-1:root', title: '当前章节', order: 1, depth: 1, markdown: '当前章节正文。第一次恢复退避是 7 秒，第二次恢复退避是 31 秒。星桥是本地资料处理平台。原始文件始终保持只读，不会回写用户文档。', sourceHeadingId: 'heading-current', sourceLineNo: 2, kind: 'source' },
      { id: 'wiki:doc-1:child', parentId: 'wiki:doc-1:current', title: '子章节', order: 1, depth: 2, markdown: '子章节中的 P4-ONLY 限定证据。', sourceHeadingId: 'heading-child', sourceLineNo: 3, kind: 'source' },
      { id: 'wiki:doc-1:sibling', parentId: 'wiki:doc-1:root', title: '兄弟章节', order: 2, depth: 1, markdown: '兄弟章节中的 P4-ONLY 不得命中。', sourceHeadingId: 'heading-sibling', sourceLineNo: 4, kind: 'source' },
    ],
  };
}

function questionInput() {
  return {
    nodeTitle: '当前章节',
    nodePath: '根节点 › 当前章节',
    childTitles: ['子章节'],
    nodeMarkdown: '当前章节正文。',
    model: 'fixture',
    providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'fixture' },
    signal: new AbortController().signal,
  };
}

function estimatedUsage() {
  return { inputTokens: 10, outputTokens: 6, totalTokens: 16, contextWindowTokens: 32_000, estimated: true, source: 'estimate' };
}

function createSessionLedger() {
  const entries = [];
  const references = new Map();
  return {
    registerEvidence(record) {
      const key = `${record.documentId}|${record.parentChunkId}`;
      const existing = references.get(key);
      if (existing) return { reference: existing, alreadySeen: true };
      const reference = `[${entries.length + 1}]`;
      references.set(key, reference);
      entries.push({ reference, ...record });
      return { reference, alreadySeen: false };
    },
    ledgerEntries: () => entries,
    seenEvidenceKeys: () => new Set(references.keys()),
  };
}
