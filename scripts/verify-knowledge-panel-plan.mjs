import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-panel-plan');
const bundleFile = path.join(outDir, 'assistant-plan-presentation.cjs');
const panelBundleFile = path.join(outDir, 'knowledge-panel.mjs');
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'src', 'components', 'assistantPlanPresentation.ts')], outfile: bundleFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx')], outfile: panelBundleFile, bundle: true, platform: 'browser', format: 'esm' }),
]);

const { getAssistantPlanView, getAssistantSearchCoverageView, translatePlanGoalStatus, translatePlanStatus } = await import(pathToFileURL(bundleFile).href);
const panelSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
const stylesSource = fs.readFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const knowledgeAgentTurnSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentTurn.ts'), 'utf8');
const knowledgeSearchToolSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'knowledgeSearchTool.ts'), 'utf8');
const grepChunksToolSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'grepChunksTool.ts'), 'utf8');
const listKnowledgeChunksToolSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'listKnowledgeChunksTool.ts'), 'utf8');
const planStart = panelSource.indexOf('function AssistantPlanTrace');
const toolStart = panelSource.indexOf('function AssistantToolTrace');
assert.ok(planStart >= 0 && toolStart > planStart);
const planSource = panelSource.slice(planStart, toolStart);
const toolEnd = panelSource.indexOf('function groupAssistantToolEvents');
assert.ok(toolEnd > toolStart);
const toolSource = panelSource.slice(toolStart, toolEnd);
assert.match(panelSource, /<AssistantPlanTrace event=/u);
assert.match(panelSource, /event\.type === 'plan'/u);
assert.match(panelSource, /searchCoverage/u, '计划轨迹应复用真实 Coverage Ledger 摘要');
assert.match(mainSource, /useCurrentNotePlanner\s*&&\s*agentResult\.searchScope\s*&&\s*agentResult\.coverage/u, '只有 current-note/default 计划路径才能投影范围与覆盖');
assert.doesNotMatch(planSource, /queryTerms|reasoning|provider|currentPath|libraryPath|absolutePath/u, 'plan UI must not render hidden or sensitive fields');
const debugStart = panelSource.indexOf('function AssistantDebugRail');
const debugEnd = panelSource.indexOf('function DebugEmptyHint');
assert.ok(debugStart >= 0 && debugEnd > debugStart, '调试轨道应是独立的渲染区域');
const debugSource = panelSource.slice(debugStart, debugEnd);
const knowledgeBaseDebugStart = panelSource.indexOf('function KnowledgeBaseDebugRail');
const knowledgeBaseDebugEnd = panelSource.indexOf('function AssistantCitationList', knowledgeBaseDebugStart);
assert.ok(knowledgeBaseDebugStart >= 0 && knowledgeBaseDebugEnd > knowledgeBaseDebugStart, '知识库调试轨道应是独立的渲染区域');
const knowledgeBaseDebugSource = panelSource.slice(knowledgeBaseDebugStart, knowledgeBaseDebugEnd);
assert.match(panelSource, /<AssistantDebugRail/u);
assert.match(debugSource, /inputSummary/u);
assert.match(debugSource, /outputSummary/u);
assert.match(debugSource, /contentPreviews/u, '调试轨道应展示工具返回的有界原文片段');
assert.match(debugSource, /sectionNavigation/u, '调试轨道应单独展示章节导航状态');
assert.match(knowledgeBaseDebugSource, /entry\.publicResults/u, '知识库调试轨道应在每个工具下展示结构化返回结果');
assert.match(knowledgeBaseDebugSource, /entry\.contentPreviews/u, '知识库调试轨道应在每个工具下展示有界原文返回');
assert.match(knowledgeBaseDebugSource, /entry\.sectionNavigation/u, '知识库调试轨道应展示工具返回的章节导航状态');
for (const [name, source] of [
  ['knowledge_search', knowledgeSearchToolSource],
  ['grep_chunks', grepChunksToolSource],
  ['list_knowledge_chunks', listKnowledgeChunksToolSource],
]) {
  assert.match(source, /const publicResults: AssistantPublicToolResultView\[\]/u, `${name} 应建立公开工具返回投影`);
  assert.match(source, /excerpt: toBoundedPublicToolResultText/u, `${name} 应提供有界的真实正文返回`);
  assert.match(source, /publicResults,/u, `${name} 应把返回投影交给 ReAct 事件链`);
}
assert.match(knowledgeAgentTurnSource, /roundEvent\.publicResults\?\.length \? \{ publicResults: roundEvent\.publicResults \}/u, '知识库 Agent 应把工具返回投影发给渲染进程');
assert.match(panelSource, /推荐章节 \{observation\.candidates\.length\}/u, '推荐章节必须显示数量且不得标成证据');
assert.match(panelSource, /当前查询词无法区分章节，需要更具体主题/u, 'ambiguous 必须显示可操作提示');
assert.match(panelSource, /根据已读原文中的区分词继续定位/u, 'fallbackUsed 必须显示降级来源');
assert.match(panelSource, /score \{candidate\.score\.toFixed\(2\)\}/u, '推荐章节必须展示 score');
assert.match(panelSource, /matched terms/u, '推荐章节必须展示 matched terms');
assert.match(panelSource, /preview\.kind === 'candidate' \? `检索候选/u, '候选预览与已读原文必须使用不同标签');
assert.match(panelSource, /: '已读原文'/u, 'Ledger 原文必须明确标记为已读原文');
assert.match(debugSource, /plannerOutputJson/u, '调试轨道应直接展示 Planner 的已校验 JSON。');
assert.match(debugSource, /Planner Structured Output/u, '调试轨道应明确标识严格结构化输出。');
assert.match(debugSource, /assistant-debug-planner-json/u, 'Planner JSON 应使用专用等宽代码块展示。');
assert.match(debugSource, /searchPlan/u, '调试轨道应展示公开 SearchPlan 投影。');
assert.match(debugSource, /finalQueryTerms/u, '调试轨道应展示最后一次真实查询词。');
assert.match(panelSource, /event\.type === 'model'/u, '渲染进程必须接收每次 ReAct 模型调用事件。');
assert.match(panelSource, /<AssistantToolTrace[^>]+modelEvents=\{modelEvents\}/u, '主对话工具轨迹必须接收本轮模型输出');
assert.match(toolSource, /<AssistantToolOutputDetails/u, '每个工具项下必须渲染独立输出折叠区');
assert.match(toolSource, /<details className="assistant-tool-output"/u, '工具输出应使用原生可访问 disclosure');
assert.doesNotMatch(toolSource, /<details className="assistant-tool-output"[^>]+open=/u, '已产出的工具输出默认必须折叠');
assert.match(toolSource, /'AI 过程说明'/u, '工具轮模型自述必须明确标为过程说明，不能混同最终回答');
assert.match(toolSource, /pairAssistantModelOutputs/u, '模型输出必须按轮次或工具名关联到对应工具');
assert.match(debugSource, /ReAct 模型轮次/u);
assert.match(debugSource, /交给模型的输入/u);
assert.match(debugSource, /模型原始输出/u);
assert.match(debugSource, /groupAssistantModelEvents/u, '同一次模型调用的开始与结束事件必须配对展示。');
assert.match(debugSource, /entry\.input\.text/u);
assert.match(debugSource, /entry\.output\?\.text/u);
assert.match(panelSource, /AssistantSearchPlanSummary/u, '调试轨道应渲染 SearchPlan 与 QueryTerm 明细。');
assert.match(panelSource, /QueryTerm/u, 'SearchPlan 明细应明确标识 QueryTerm。');
assert.match(panelSource, /className="knowledge-panel-ai-view"/u, 'AI 助手外层必须参与右侧栏高度布局。');
assert.match(stylesSource, /\.knowledge-panel-ai-view\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;/su, 'AI 助手外层必须占满右侧栏剩余高度。');
assert.match(stylesSource, /\.knowledge-panel-ai-view:not\(\[hidden\]\)\s*\{[^}]*display:\s*flex;/su, '显示 AI 助手时必须恢复 flex 高度链。');
assert.match(stylesSource, /\.knowledge-panel \.assistant-message-list\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/su, '右侧栏的中间消息区域必须独立滚动。');
assert.match(stylesSource, /\.knowledge-panel \.assistant-conversation\s*\{[^}]*overflow:\s*hidden;/su, '右侧栏聊天外层不得连同输入框一起滚动。');
assert.match(stylesSource, /\.assistant-composer\s*\{[^}]*flex:\s*0\s+0\s+auto;/su, '输入框必须固定在聊天区域底部。');
assert.match(debugSource, /当前问题/u, '上下文区域应展示当前问题');
assert.match(debugSource, /rollingSummary/u);
assert.match(debugSource, /recentStoredTurns/u, '上下文区域应展示近期已保存对话');
assert.doesNotMatch(debugSource, /reasoning|absolutePath|providerRequest/u, '调试轨道不得渲染隐藏推理或敏感请求');

const planStatuses = {
  active: '进行中',
  completed: '已完成',
  partial: '部分完成',
  'not-found': '未找到',
  failed: '失败',
  cancelled: '已取消',
  stale: '笔记已变化',
  interrupted: '已中断',
};
for (const [status, label] of Object.entries(planStatuses)) assert.equal(translatePlanStatus(status), label);

const goalStatuses = {
  pending: '待核实',
  searching: '正在核实',
  partial: '部分完成',
  covered: '已完成',
  conflicted: '存在冲突',
  'not-found': '未找到',
};
for (const [status, label] of Object.entries(goalStatuses)) assert.equal(translatePlanGoalStatus(status), label);

const event = {
  phase: 'finished',
  status: 'partial',
  goals: [
    { label: '核实缓存策略', status: 'covered', evidenceCount: 2 },
    { label: '核实失败边界', status: 'partial', evidenceCount: 1 },
  ],
};
const view = getAssistantPlanView(event);
assert.deepEqual(view, {
  statusLabel: '部分完成',
  goals: [
    { label: '核实缓存策略', status: 'covered', evidenceCount: 2, statusLabel: '已完成', evidenceLabel: '已读取 2 条证据' },
    { label: '核实失败边界', status: 'partial', evidenceCount: 1, statusLabel: '部分完成', evidenceLabel: '已读取 1 条证据' },
  ],
});
assert.equal(Object.keys(view.goals[0]).includes('queryTerms'), false);
assert.equal(Object.keys(view.goals[0]).includes('reasoning'), false);

const runningView = getAssistantPlanView({
  phase: 'updated',
  status: 'active',
  goals: [{ label: '核实运行状态', status: 'searching', evidenceCount: 1 }],
});
assert.equal(runningView.goals[0].status, 'searching', '运行中的目标必须继续显示加载状态');
assert.equal(runningView.goals[0].statusLabel, '正在核实');

const settledView = getAssistantPlanView({
  phase: 'finished',
  status: 'partial',
  goals: [{ label: '核实运行状态', status: 'searching', evidenceCount: 1 }],
});
assert.equal(settledView.goals[0].status, 'partial', '计划结束后不得保留会触发加载动画的 searching 展示状态');
assert.equal(settledView.goals[0].statusLabel, '部分完成');
assert.equal(settledView.goals[0].evidenceLabel, '已读取 1 条证据');

const partialCoverageView = getAssistantSearchCoverageView(
  { mode: 'focused', coveragePolicy: 'sufficient' },
  {
    discoveredHeadingCount: 7,
    readHeadingCount: 3,
    status: 'partial',
    reason: '候选结果仍需继续核对。',
  },
  'partial',
  { stopReason: 'max-tool-calls' },
);
assert.deepEqual(partialCoverageView, {
  scopeLabel: '精确查找',
  coverageLabel: '已读取部分原文证据',
  locatedLabel: '已定位 7 个相关章节',
  readLabel: '已读取 3/7 个章节',
  partialReason: '本轮工具预算已用完，回答仅覆盖已读取部分。',
});
assert.doesNotMatch(JSON.stringify(partialCoverageView), /focused|sufficient|score|reasoning/u);

const occurrenceView = getAssistantSearchCoverageView(
  { mode: 'topic-wide', coveragePolicy: 'occurrence-complete' },
  {
    discoveredHeadingCount: 0,
    readHeadingCount: 4,
    status: 'insufficient',
    reason: '尚未读取当前笔记原文证据。',
  },
  'not-found',
);
assert.equal(occurrenceView?.scopeLabel, '主题综合查找');
assert.equal(occurrenceView?.coverageLabel, '等待原文证据');
assert.equal(occurrenceView?.locatedLabel, '已定位 4 个相关章节');
assert.equal(occurrenceView?.readLabel, '已读取 4/4 个章节');
assert.equal(getAssistantSearchCoverageView(undefined, undefined), undefined);

console.log('KnowledgePanel SearchPlan state rendering verification passed');
