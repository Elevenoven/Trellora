import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-base-rag');
const bundlePath = path.join(outDir, 'knowledge-base-rag.cjs');
const promptBundlePath = path.join(outDir, 'assistant-turn.cjs');
const citationBundlePath = path.join(outDir, 'knowledge-base-citations.cjs');
const electronStubPlugin = {
  name: 'electron-stub',
  setup(context) {
    context.onResolve({ filter: /^electron$/u }, () => ({ path: 'electron', namespace: 'phase3-electron-stub' }));
    context.onLoad({ filter: /.*/u, namespace: 'phase3-electron-stub' }, () => ({
      contents: `
        export const safeStorage = {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.alloc(0),
          decryptString: () => '',
        };
        export const app = { getPath: () => '' };
      `,
      loader: 'js',
    }));
  },
};

await build({
  stdin: {
    contents: "export { KNOWLEDGE_BASE_RAG_PARENT_TOP_K, getDedicatedKnowledgeBaseRagSource, mergeKnowledgeBaseRetrievals } from './electron/knowledge/knowledgeBaseRag.ts';",
    resolveDir: rootDir,
    sourcefile: 'verify-knowledge-base-rag-entry.ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [electronStubPlugin],
});

const {
  KNOWLEDGE_BASE_RAG_PARENT_TOP_K,
  getDedicatedKnowledgeBaseRagSource,
  mergeKnowledgeBaseRetrievals,
} = await import(pathToFileURL(bundlePath).href);

await build({
  stdin: {
    contents: "export { createKnowledgeAnswerPrompt, projectKnowledgeAnswerSources } from './electron/knowledge/assistantTurn.ts';",
    resolveDir: rootDir,
    sourcefile: 'verify-knowledge-prompt-entry.ts',
  },
  outfile: promptBundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { createKnowledgeAnswerPrompt, projectKnowledgeAnswerSources } = await import(pathToFileURL(promptBundlePath).href);

await build({
  entryPoints: [path.join(rootDir, 'src', 'components', 'assistantKnowledgeBaseCitations.ts')],
  outfile: citationBundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { formatKnowledgeBaseCitationMarkdown, getReferencedKnowledgeBaseCitations } = await import(pathToFileURL(citationBundlePath).href);

assert.equal(KNOWLEDGE_BASE_RAG_PARENT_TOP_K, 5);
const baseRequest = {
  requestId: 'knowledge_rag_12345678',
  intent: 'ask',
  scope: 'library-search',
  userText: '访问控制有什么要求？',
  conversation: [],
  contextSources: [{ kind: 'knowledge-base', libraryPath: 'C:/knowledge-base', label: '项目资料' }],
};
assert.equal(getDedicatedKnowledgeBaseRagSource(baseRequest)?.libraryPath, 'C:/knowledge-base');
assert.equal(getDedicatedKnowledgeBaseRagSource({ ...baseRequest, attachments: [{ kind: 'text', attachmentId: 'text-fixture-rag-01', path: 'C:/a.md', name: 'a.md', sizeBytes: 1 }] }), undefined, '带附件的混合上下文不得误走纯资料库 RAG');
assert.equal(getDedicatedKnowledgeBaseRagSource({ ...baseRequest, contextSources: [{ kind: 'note-library', libraryPath: 'C:/notes' }] }), undefined, '笔记库问答不得误走资料库 RAG');

const merged = mergeKnowledgeBaseRetrievals([
  retrievalOutcome([
    parentEvidence('doc-1', 'parent-1', 0.8, 'parent evidence 1'),
    parentEvidence('doc-2', 'parent-2', 0.7, 'parent evidence 2'),
  ]),
  retrievalOutcome([
    parentEvidence('doc-1', 'parent-1', 0.95, 'parent evidence 1'),
    parentEvidence('doc-3', 'parent-3', 0.6, 'parent evidence 3'),
  ]),
], 2);
assert.deepEqual(merged.evidence.map((item) => item.parentChunkId), ['parent-1', 'parent-2'], '多路问题检索必须按父块去重并保留最高分，再裁成父块 Top-K');
assert.deepEqual(merged.evidence.map((item) => item.text), ['parent evidence 1', 'parent evidence 2'], '模型证据必须保持父块原文，不能降级成子块文本');

// 通道贡献与图扩展种子归因的多路合并（优化方案 P2-7）。
const channelMerged = mergeKnowledgeBaseRetrievals([
  retrievalOutcome([parentEvidence('doc-1', 'parent-1', 0.8, 'parent evidence 1')], {
    channelContribution: { vector: 3, fts: 2, graph: 1 },
    graphExpansion: {
      seedCount: 2,
      addedChildren: 1,
      contributions: [{ seedChunkId: 'c1', chunkId: 'c2', edgeWeight: 5, rrfScore: 0.01 }],
    },
  }),
  retrievalOutcome([parentEvidence('doc-1', 'parent-1', 0.7, 'parent evidence 1')], {
    channelContribution: { vector: 1, fts: 0, graph: 2 },
    graphExpansion: {
      seedCount: 1,
      addedChildren: 2,
      contributions: [{ seedChunkId: 'c3', chunkId: 'c4', edgeWeight: 2, rrfScore: 0.02 }],
    },
  }),
], 5);
assert.deepEqual(channelMerged.channelContribution, { vector: 4, fts: 2, graph: 3 }, '多路合并必须按通道汇总贡献度');
assert.equal(channelMerged.graphExpansion?.seedCount, 3, '图扩展种子数必须跨路求和');
assert.equal(channelMerged.graphExpansion?.addedChildren, 3, '图扩展补充数必须跨路求和');
assert.deepEqual(channelMerged.graphExpansion?.contributions.map((entry) => entry.chunkId), ['c2', 'c4'], '图通道种子归因必须跨路合并');

const promptSources = [
  { title: '项目说明.pdf · 父块 4', content: '第一条父块证据' },
  { title: '需求清单.md · 父块 9', content: '第二条父块证据' },
];
assert.deepEqual(
  projectKnowledgeAnswerSources(promptSources),
  promptSources.map((source, index) => ({ ...source, reference: index + 1 })),
  '引用编号必须只覆盖实际投影给模型的父块证据',
);
assert.match(
  createKnowledgeAnswerPrompt('问题', [], promptSources),
  /引用资料时在句末写资料编号，例如 \[3\]/,
  '模型提示必须要求使用可映射的资料编号，而不是文件标题',
);

const citations = [
  { reference: 3, documentName: '项目说明.pdf', parentOrdinal: 4, content: '父块三正文' },
  { reference: 5, documentName: '需求清单.md', parentOrdinal: 9, content: '父块五正文' },
];
const answerWithCitations = '职责包括需求澄清 [3] 和交付管理 [5]。`代码里的 [3] 不应变更`\n```txt\n围栏中的 [5] 不应变更\n```';
assert.equal(
  formatKnowledgeBaseCitationMarkdown(answerWithCitations, citations),
  '职责包括需求澄清 <a href="#knowledge-base-citation-3" aria-label="引用 3" title="查看引用 3">3</a> 和交付管理 <a href="#knowledge-base-citation-5" aria-label="引用 5" title="查看引用 5">5</a>。`代码里的 [3] 不应变更`\n```txt\n围栏中的 [5] 不应变更\n```',
  '正文中的有效引用必须变为紧凑且可访问的链接，代码内容保持原样',
);
assert.deepEqual(
  getReferencedKnowledgeBaseCitations(answerWithCitations, citations).map((citation) => citation.reference),
  [3, 5],
  '引用条必须只显示回答实际引用的父块，且保持出现顺序',
);

const mainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
assert.match(mainSource, /getDedicatedKnowledgeBaseRagSource\(request\)/, '单知识库请求必须在笔记库 Planner 前进入专用 RAG 分支');
assert.match(mainSource, /retrieveKnowledgeBaseEvidence\(\{[\s\S]*?parentTopK/u, '专用 RAG 必须通过混合子块召回、RRF 父块聚合和有界父块 Top-K');
assert.match(mainSource, /const rawParentEvidence = retrieval\.evidence/u, '回答生成的原始证据只能来自检索器输出的父块');
assert.match(mainSource, /const parentEvidence = visualResolution\.evidence/u, '生成前仅允许对父块做受控图片引用解析');
assert.match(mainSource, /images: visualResolution\.images/u, '命中父块中的持久化图片必须作为有界视觉输入交给模型');
assert.match(mainSource, /content: parent\.text/, '回答上下文必须使用父块文本');
assert.match(mainSource, /projectedPromptSources = promptAssembly\.projectedSources/u, '返回给界面的引用必须复用 ContextEnvelope 的父块投影');
assert.match(mainSource, /sourceId: `\$\{parentEvidence\[index\]\.documentId\}:\$\{parentEvidence\[index\]\.parentChunkId\}`/u, 'Dynamic Evidence 必须保留父块稳定身份');
assert.match(mainSource, /knowledgeBaseCitations:/, '专用 RAG 回答必须携带可展开的父块引用');
assert.match(mainSource, /const title = documentName;/u, '资料标题必须只保留真实文档名，不得拼接父块标签');
assert.doesNotMatch(mainSource, /const title = `\$\{documentName\} · 父块/u, '父块位置不得序列化进资料标题');
assert.match(mainSource, /reference: index \+ 1,[\s\S]*?documentId,[\s\S]*?parentOrdinal,/u, '来源元数据必须独立保留引用号、文档和父块位置');
assert.match(mainSource, /graphExpansion: result\.graphExpansion/u, '检索轨迹摘要必须携带图扩展遥测（优化方案 P2-7）');
assert.match(mainSource, /channelContribution: result\.channelContribution/u, '检索轨迹摘要必须携带通道贡献统计（优化方案 P2-7）');
assert.match(mainSource, /图通道扩展：从/, '图扩展必须向调试轨道发出“补了几条、来自哪些种子”的工具事件');

const searchToolSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'knowledgeSearchTool.ts'), 'utf8');
assert.match(searchToolSource, /graphExpansion\.addedChildren > 0/u, 'knowledge_search 的 retrieval_note 必须提示图通道补充情况');

const workspaceSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'AssistantWorkspaceView.tsx'), 'utf8');
assert.match(workspaceSource, /contextSourceOptions/, '独立问答页必须把已登记资料库作为可选数据源');
assert.match(workspaceSource, /selectedContextSourcePath/, '独立问答页必须把当前选择传给问答编辑器');
assert.match(workspaceSource, /workspaceMemory=\{workspaceMemory\}/, '普通聊天与知识库问答必须继续共享同一会话记忆');
assert.match(workspaceSource, /kind: 'knowledge-base'/, '选中资料库时仍必须进入专用知识库 RAG 上下文');

const panelSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
assert.match(panelSource, /<strong>无<\/strong>/, '数据源菜单必须提供不检索资料库的“无”选项');
assert.match(panelSource, /scope === 'chat'/, '选择“无”时必须构造普通 AI 问答范围');
assert.match(panelSource, /AssistantKnowledgeBaseAnswerContent/, '回答中的资料编号必须使用专用可点击渲染');
assert.match(panelSource, /AssistantKnowledgeBaseCitationList/, '资料编号必须在回答下方提供可展开的引用条');
assert.match(panelSource, /citation\.documentName/, '展开区域必须显示父块所属文件名');
assert.match(panelSource, /citation\.content/, '展开区域必须显示实际用于回答的父块内容');
assert.match(panelSource, /sourceNotesByReference/u, '调试轨道必须按真实引用号关联来源元数据');
assert.match(panelSource, /title: citation\.documentName/u, '调试轨道标题必须只显示文档名');
assert.match(panelSource, /parentOrdinal: citation\.parentOrdinal/u, '调试轨道必须独立保留父块定位');

const knowledgeAgentTurnSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentTurn.ts'), 'utf8');
assert.match(knowledgeAgentTurnSource, /reference: Number\(entry\.reference\.replace/u, 'ReAct 来源元数据必须携带真实引用号');
assert.match(knowledgeAgentTurnSource, /parentOrdinal: entry\.ordinal \?\? 0,[\s\S]*?title: documentName/u, 'ReAct 来源标题与父块位置必须分字段返回');
assert.doesNotMatch(knowledgeAgentTurnSource, /title: `\$\{documentName\} · 父块/u, 'ReAct 来源标题不得拼接父块标签');

console.log('verify-knowledge-base-rag: hybrid child retrieval, parent-only ContextEnvelope evidence, and expandable citation mapping passed');

function parentEvidence(documentId, parentChunkId, score, text) {
  return {
    documentId,
    childChunkId: `${parentChunkId}-child`,
    parentChunkId,
    parentOrdinal: 1,
    text,
    sourceText: text,
    score,
    hitChildren: 1,
    methods: ['semantic'],
  };
}

function retrievalOutcome(evidence, overrides = {}) {
  return {
    evidence,
    children: [],
    parentCandidateCount: evidence.length,
    rerank: { enabled: false, applied: false, gatedOut: 0, allGatedOut: false },
    used: '语义搜索',
    vectorIndexed: true,
    indexedChunks: 20,
    channelContribution: { vector: 0, fts: 0, graph: 0 },
    ...overrides,
  };
}
