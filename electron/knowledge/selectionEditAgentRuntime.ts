import { createHash } from 'node:crypto';
import { findMaterialsDocument, listMaterialsDocuments } from '../materialsLibrary';
import { readMaterialParentWindow, searchMaterialChunks } from '../pipeline/materialChunkSearch';
import { fetchWebPage, parsePublicWebUrl } from '../websearch/webFetchClient';
import { getAiProviderConfig } from './aiProvider';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { retrieveKnowledgeBaseEvidence } from './knowledgeBaseRag';
import { selectionEditProfiles } from './selectionEditProfiles';
import { type SelectionEditExtendedSourceRuntime } from './selectionEditSources/extendedSources';
import { SelectionEditEvidenceSession } from './selectionEditEvidenceSession';
import { createSelectionEditCurrentNoteTools } from './selectionEditTools/currentNoteTools';
import { createSelectionEditLibraryNoteTools } from './selectionEditTools/libraryNoteTools';
import {
  buildSelectionEditAgentQuestion,
  buildSelectionEditAgentSystemPrompt,
  normalizeSelectionEditAgentAnswer,
  selectionEditAgentTerminalPolicy,
  type SelectionEditAgentGoal,
} from './selectionEditAgentPrompt';
import { applySelectionEditQualityGate } from './selectionEditQuality';
import { validateSelectionEditOutput } from './selectionEditValidator';
import { createReActChatTransport, type ReActChatTransport } from './reactAgent/reactChatTransport';
import { runReActLoop } from './reactAgent/reactEngine';
import type { ReActBudget } from './reactAgent/reactEngineTypes';
import { ReActToolRegistry, type ReActTool, type ReActToolExecution } from './reactAgent/toolRegistry';
import type {
  SelectionContextReceipt,
  SelectionEditRequest,
  SelectionEditValidation,
  SelectionEvidenceItem,
} from './selectionEditTypes';
import type { AiProviderConfig } from './aiTypes';
import { isExpansionFullNoteEvidence } from './selectionExpansionContext';
import { runAdaptiveExpansionAgent } from './selectionExpansionAgent';
import type { SelectionEditPersonalization } from './selectionEditSources/personalizationSource';

const MAX_MATERIAL_QUERY_LENGTH = 120;
const MAX_MATERIAL_GREP_LENGTH = 80;
const MAX_MATERIAL_CANDIDATES = 4;
const MAX_MATERIAL_DEEP_READ_CHARS = 2_200;
const MAX_WEB_SEARCH_RESULTS = 3;
const MAX_WEB_PAGE_CHARS = 1_600;
const MIN_WEB_PAGE_CHARS = 160;
const MAX_SELECTION_AGENT_EVIDENCE_CHARS = 9_000;

export interface SelectionEditAgentRuntimeInput {
  request: SelectionEditRequest;
  goals: readonly SelectionEditAgentGoal[];
  /** Current-note deterministic reads remain preloaded in RA-2; RA-3 adds note tools. */
  preloadedEvidence: readonly SelectionEvidenceItem[];
  personalization?: SelectionEditPersonalization;
  /** Immutable main-process snapshot. It is exposed to tools only when strict full-note preload is unavailable. */
  currentNoteSnapshot?: CurrentNoteSnapshot;
  /** A strict-small-note preload already contains the full stable note; avoid duplicate Agent reads. */
  currentNoteFullyPreloaded?: boolean;
  extendedSources: SelectionEditExtendedSourceRuntime;
  signal: AbortSignal;
  isSnapshotCurrent: () => boolean;
  options?: {
    nearbyContext?: { before: string; after: string };
    targetCharacters?: number;
    style?: string;
    audience?: string;
    reasoningDepth?: 'fast' | 'balanced' | 'deep';
  };
  /** Tests may inject the real-protocol-compatible transport without using credentials. */
  transport?: ReActChatTransport;
  providerConfig?: AiProviderConfig;
  model?: string;
  onStatus?: (message: string) => void;
  onEvidence?: (item: SelectionEvidenceItem) => void;
  adaptiveExpansion?: boolean;
}

export type SelectionEditAgentRuntimeOutcome =
  | { kind: 'unavailable'; reason: string }
  | {
    kind: 'completed';
    text: string;
    evidence: SelectionEvidenceItem[];
    receipt: Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates' | 'conflicts'>;
    validation: SelectionEditValidation;
    rounds: number;
    modelCalls: number;
    toolCalls: number;
    repairAttempts: number;
  };

export interface SelectionEditResearchToolContext {
  adaptiveExpansion?: boolean;
  session: SelectionEditEvidenceSession;
  selectionLineFrom: number;
  selectionLineTo: number;
  currentNoteSnapshot?: CurrentNoteSnapshot;
  noteLibraryRuntime?: NonNullable<SelectionEditExtendedSourceRuntime['noteLibrary']>;
  materialRuntime?: NonNullable<SelectionEditExtendedSourceRuntime['materialsLibrary']>;
  webRuntime?: NonNullable<SelectionEditExtendedSourceRuntime['web']>;
  signal: AbortSignal;
  isSnapshotCurrent: () => boolean;
  goals: readonly SelectionEditAgentGoal[];
  onStatus?: (message: string) => void;
  onEvidence?: (item: SelectionEvidenceItem) => void;
}

/**
 * Bounded research runtime for selection editing. It shares the ReAct engine,
 * native tool protocol and cancellation behavior, but keeps a separate
 * evidence ledger so retrieval snippets can never become writeback evidence.
 */
export async function runSelectionEditAgentRuntime(input: SelectionEditAgentRuntimeInput): Promise<SelectionEditAgentRuntimeOutcome> {
  const providerConfig = input.providerConfig ?? getAiProviderConfig();
  const model = input.model?.trim() || providerConfig.model?.trim();
  if (!model) throw new Error('请先在“设置 → 模型连接”中选择生成模型。');
  const hasCurrentNote = input.request.allowedSources.currentNote
    && Boolean(input.currentNoteSnapshot)
    && !input.currentNoteFullyPreloaded;
  const hasNoteLibrary = input.request.allowedSources.noteLibrary && Boolean(input.extendedSources.noteLibrary);
  const hasMaterials = input.request.allowedSources.materialsLibrary && Boolean(input.extendedSources.materialsLibrary);
  const hasWeb = input.request.allowedSources.web && Boolean(input.extendedSources.web);
  if (!hasCurrentNote && !hasNoteLibrary && !hasMaterials && !hasWeb) {
    return { kind: 'unavailable', reason: '没有已授权且已就绪的当前笔记、同库笔记、资料库或网页研究来源。' };
  }
  const transport = input.transport ?? createReActChatTransport(providerConfig, model);
  if (!transport) return { kind: 'unavailable', reason: input.adaptiveExpansion ? '当前模型不支持原生工具调用，无法完成所需原文研究，请切换支持工具调用的模型。' : '当前模型不支持原生工具调用，已保留直接编辑路径。' };

  assertCurrent(input);
  const preloadedEvidenceCharacters = input.preloadedEvidence.filter((item) => !input.adaptiveExpansion || !isExpansionFullNoteEvidence(item)).reduce((total, item) => total + item.content.length, 0);
  const session = new SelectionEditEvidenceSession(Math.max(1, MAX_SELECTION_AGENT_EVIDENCE_CHARS - preloadedEvidenceCharacters));
  const context: SelectionEditResearchToolContext = {
    session,
    adaptiveExpansion: input.adaptiveExpansion,
    selectionLineFrom: input.request.snapshot.lineFrom,
    selectionLineTo: input.request.snapshot.lineTo,
    ...(hasCurrentNote ? { currentNoteSnapshot: input.currentNoteSnapshot } : {}),
    ...(hasNoteLibrary ? { noteLibraryRuntime: input.extendedSources.noteLibrary } : {}),
    ...(hasMaterials ? { materialRuntime: input.extendedSources.materialsLibrary } : {}),
    ...(hasWeb ? { webRuntime: input.extendedSources.web } : {}),
    signal: input.signal,
    isSnapshotCurrent: input.isSnapshotCurrent,
    goals: input.goals,
    ...(input.onStatus ? { onStatus: input.onStatus } : {}),
    ...(input.onEvidence ? { onEvidence: input.onEvidence } : {}),
  };
  const registry = createSelectionEditAgentTools(context);
  const systemPrompt = buildSelectionEditAgentSystemPrompt({ request: input.request, toolNames: registry.names() });
  const question = buildSelectionEditAgentQuestion({
    request: input.request,
    goals: input.goals,
    preloadedEvidence: input.preloadedEvidence,
    personalization: input.personalization,
    options: input.options,
  });
  let repairUsed = false;
  const validate = (candidateText: string): SelectionEditValidation => {
    const evidence = [...input.preloadedEvidence, ...session.evidenceItems()];
    return applySelectionEditQualityGate({
      action: input.request.action,
      selectedText: input.request.snapshot.selectedText,
      candidateText: normalizeSelectionEditAgentAnswer(candidateText, input.request.action),
      targetCharacters: input.options?.targetCharacters,
      requiredGoalIds: selectionEditProfiles[input.request.action].evidencePolicy === 'require-for-new-facts'
        ? input.goals.filter((goal) => goal.required).map((goal) => goal.goalId)
        : [],
      evidence,
      validation: validateSelectionEditOutput({
        action: input.request.action,
        selectedText: input.request.snapshot.selectedText,
        candidateText: normalizeSelectionEditAgentAnswer(candidateText, input.request.action),
        ...(input.request.action === 'expand' ? { selectedMarkdown: input.request.snapshot.markdownFragment } : {}),
        ...(input.request.targetLanguage ? { targetLanguage: input.request.targetLanguage } : {}),
        evidence,
        protectedAnchorKinds: selectionEditProfiles[input.request.action].protectedAnchorKinds,
      }),
    }).validation;
  };

  if (input.adaptiveExpansion) return runAdaptiveExpansionAgent({ input, providerConfig, model, transport, context, registry, systemPrompt, question, validate });

  input.onStatus?.('正在通过资料库研究工具定位候选并受限深读原文…');
  const loop = await runReActLoop<SelectionEditResearchToolContext>({
    systemPrompt,
    history: [],
    question,
    model,
    config: providerConfig,
    transport,
    registry,
    toolContext: context,
    budget: resolveSelectionEditAgentBudget(input.options?.reasoningDepth),
    signal: input.signal,
    temperature: input.request.action === 'proofread' ? 0 : 0.25,
    terminalPolicy: input.request.action === 'expand' ? {
      ...selectionEditAgentTerminalPolicy,
      synthesisInstruction: '证据收集到此为止。请仅根据已核验原文，直接输出 <final_answer> 包裹的扩写 Markdown 正文，保留选区的段落、标题、列表、引用、文字格式与代码围栏及语言。不要为整篇结果套围栏，不要输出引用号、证据 ID、解释或 JSON，不要再调用工具。',
    } : selectionEditAgentTerminalPolicy,
    onBeforeFinalAnswer: ({ answer }) => {
      assertCurrent(input);
      const validation = validate(answer);
      if (validation.passed || repairUsed) return { accept: true };
      repairUsed = true;
      return {
        accept: false,
        nudge: buildValidationNudge(validation),
        detail: { selectionEditRepair: true, issueCodes: (validation.issues ?? []).map((issue) => issue.code) },
      };
    },
  });
  assertCurrent(input);
  const text = normalizeSelectionEditAgentAnswer(loop.finalAnswer, input.request.action);
  const validation = validate(text);
  return {
    kind: 'completed',
    text,
    evidence: session.evidenceItems(),
    receipt: session.receipt(),
    validation,
    rounds: loop.rounds,
    modelCalls: loop.modelCalls,
    toolCalls: loop.toolCalls,
    repairAttempts: repairUsed ? 1 : 0,
  };
}

export function resolveSelectionEditAgentBudget(depth: 'fast' | 'balanced' | 'deep' | undefined): Partial<ReActBudget> {
  switch (depth) {
    case 'fast': return { maxIterations: 2, maxModelCalls: 3, maxToolCalls: 4 };
    case 'deep': return { maxIterations: 5, maxModelCalls: 8, maxToolCalls: 10 };
    default: return { maxIterations: 4, maxModelCalls: 6, maxToolCalls: 8 };
  }
}

function createSelectionEditAgentTools(context: SelectionEditResearchToolContext): ReActToolRegistry<SelectionEditResearchToolContext> {
  const registry = new ReActToolRegistry<SelectionEditResearchToolContext>();
  if (context.currentNoteSnapshot) {
    for (const tool of createSelectionEditCurrentNoteTools(context)) registry.register(tool);
  }
  if (context.noteLibraryRuntime) {
    for (const tool of createSelectionEditLibraryNoteTools(context)) registry.register(tool);
  }
  if (context.materialRuntime) {
    registry.register(createKnowledgeSearchTool());
    registry.register(createGrepChunksTool());
    registry.register(createListKnowledgeChunksTool());
    registry.register(createGetDocumentInfoTool());
  }
  if (context.webRuntime) {
    registry.register(createWebSearchTool());
    registry.register(createWebFetchTool());
  }
  return registry;
}

function createKnowledgeSearchTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'knowledge_search',
    description: '按语义在已授权资料库中定位候选父块。候选不是可写回证据；需要新增事实时，必须再调用 list_knowledge_chunks 深读来自本结果的 document_id 与 ordinal。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: MAX_MATERIAL_QUERY_LENGTH, description: '与编辑目标有关的一条语义化查询' } },
      required: ['query'],
    },
    execute: async (args, ctx) => {
      const query = readBoundedString(args.query, MAX_MATERIAL_QUERY_LENGTH);
      if (!query) return toolError('knowledge_search 需要非空的 query。', '资料库语义检索查询为空。');
      const runtime = ctx.materialRuntime;
      if (!runtime) return toolError('资料库研究未授权或未就绪。', '资料库研究未就绪。');
      assertToolCurrent(ctx);
      ctx.session.plan('materials', '先用 knowledge_search 或 grep_chunks 定位候选，再用 list_knowledge_chunks 深读原文。');
      ctx.onStatus?.(`正在在资料库中按语义定位「${truncate(query, 28)}」的候选…`);
      const prepared = await runtime.prepareQueryContext(query);
      const outcome = await retrieveKnowledgeBaseEvidence({
        libraryPath: prepared.targetPath,
        query,
        queryTerms: prepared.queryTerms,
        lexicalError: prepared.lexicalError,
        adapter: prepared.adapter,
        embeddingError: prepared.embeddingError,
        parentTopK: MAX_MATERIAL_CANDIDATES,
        allowExpansion: false,
        directLoadEnabled: false,
        allowGraphExpansion: false,
      });
      const lines = [`<selection_material_candidates method="knowledge_search" query="${escape(query)}">`];
      let count = 0;
      for (const entry of outcome.evidence) {
        const document = findMaterialsDocument(runtime.libraryPath, entry.documentId);
        if (!document) continue;
        ctx.session.recordMaterialCandidate({
          documentId: entry.documentId,
          ordinal: entry.parentOrdinal,
          title: document.name,
          sourceContentHash: document.contentHash,
          queryTerms: prepared.queryTerms?.length ? prepared.queryTerms : [query],
          retrievalMethod: 'knowledge_search',
          score: entry.score,
          goalIds: goalIdsForQuery(ctx.goals, query),
        });
        count += 1;
        lines.push(`  <candidate document_id="${escape(entry.documentId)}" ordinal="${entry.parentOrdinal}" title="${escape(document.name)}" score="${entry.score.toFixed(3)}">${escape(truncate(entry.text, 360))}</candidate>`);
      }
      lines.push('</selection_material_candidates>');
      lines.push(`<selection_research_note>${count > 0 ? '以上仅为候选定位；若要新增事实，必须用 list_knowledge_chunks 深读其中一条原文。' : '未找到候选；可更换查询或使用 grep_chunks 查找专名。'}</selection_research_note>`);
      return { ok: true, observation: lines.join('\n'), message: `资料库语义检索定位 ${count} 个候选。`, referenceCount: 0 };
    },
  };
}

function createGrepChunksTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'grep_chunks',
    description: '按字面量或关键词在已授权资料库中定位候选块。适合专有名词、编号、公式和原文措辞；候选不是证据，必须用 list_knowledge_chunks 深读。',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', maxLength: MAX_MATERIAL_GREP_LENGTH, description: '要精确定位的字面量或关键词组合' } },
      required: ['pattern'],
    },
    execute: async (args, ctx) => {
      const pattern = readBoundedString(args.pattern, MAX_MATERIAL_GREP_LENGTH);
      if (!pattern) return toolError('grep_chunks 需要非空的 pattern。', '资料库字面量检索为空。');
      const runtime = ctx.materialRuntime;
      if (!runtime) return toolError('资料库研究未授权或未就绪。', '资料库研究未就绪。');
      assertToolCurrent(ctx);
      ctx.session.plan('materials', '先用 knowledge_search 或 grep_chunks 定位候选，再用 list_knowledge_chunks 深读原文。');
      ctx.onStatus?.(`正在在资料库中定位字面量「${truncate(pattern, 28)}」…`);
      const prepared = await runtime.prepareQueryContext(pattern);
      const outcome = await searchMaterialChunks({
        libraryPath: prepared.targetPath,
        query: pattern,
        queryTerms: prepared.queryTerms,
        lexicalError: prepared.lexicalError,
        mode: 'keyword',
        limit: MAX_MATERIAL_CANDIDATES,
        adapter: prepared.adapter,
        embeddingError: prepared.embeddingError,
      });
      const lines = [`<selection_material_candidates method="grep_chunks" pattern="${escape(pattern)}">`];
      let count = 0;
      for (const entry of outcome.results) {
        const ordinal = entry.citation.parent?.ordinal ?? entry.ordinal;
        const document = findMaterialsDocument(runtime.libraryPath, entry.documentId);
        if (!document) continue;
        ctx.session.recordMaterialCandidate({
          documentId: entry.documentId,
          ordinal,
          title: document.name,
          sourceContentHash: document.contentHash,
          queryTerms: prepared.queryTerms?.length ? prepared.queryTerms : [pattern],
          retrievalMethod: 'grep_chunks',
          score: entry.score,
          goalIds: goalIdsForQuery(ctx.goals, pattern),
        });
        count += 1;
        lines.push(`  <candidate document_id="${escape(entry.documentId)}" ordinal="${ordinal}" title="${escape(document.name)}" score="${entry.score.toFixed(3)}">${escape(truncate(entry.citation.parent?.text ?? entry.text, 360))}</candidate>`);
      }
      lines.push('</selection_material_candidates>');
      lines.push(`<selection_research_note>${count > 0 ? '以上只用于定位；请使用 list_knowledge_chunks 深读实际原文后再增补事实。' : '未找到候选；可改用 knowledge_search 按含义检索。'}</selection_research_note>`);
      return { ok: true, observation: lines.join('\n'), message: `资料库字面量检索定位 ${count} 个候选。`, referenceCount: 0 };
    },
  };
}

function createListKnowledgeChunksTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'list_knowledge_chunks',
    description: '深读本轮资料检索已返回的一个父块原文。document_id 与 ordinal 必须来自此前候选；成功深读后才会成为可支撑新增事实的证据。',
    parameters: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '此前候选中的文档 id' },
        ordinal: { type: 'number', description: '此前候选中的父块序号' },
      },
      required: ['document_id', 'ordinal'],
    },
    execute: async (args, ctx) => {
      const documentId = readBoundedString(args.document_id, 160);
      const ordinal = typeof args.ordinal === 'number' && Number.isSafeInteger(args.ordinal) && args.ordinal >= 0 ? args.ordinal : Number.NaN;
      if (!documentId || Number.isNaN(ordinal)) return toolError('list_knowledge_chunks 需要有效的 document_id 与 ordinal。', '资料深读参数无效。');
      const runtime = ctx.materialRuntime;
      const candidate = ctx.session.materialCandidate(documentId, ordinal);
      if (!runtime || !candidate) return toolError('深读目标必须来自本轮 knowledge_search 或 grep_chunks 的候选。', '资料深读目标不在本轮候选中。');
      assertToolCurrent(ctx);
      const document = findMaterialsDocument(runtime.libraryPath, documentId);
      if (!document || document.contentHash !== candidate.sourceContentHash) {
        ctx.session.markCandidateSkipped(`materials:${documentId}:${ordinal}`, '资料文档在深读前已变化或不存在，需要重新检索。');
        return toolError('资料文档已变化或不存在，请重新检索后再深读。', '资料文档已变化。');
      }
      ctx.onStatus?.(`正在深读资料「${document.name}」父块 ${ordinal} 的原文…`);
      const record = readMaterialParentWindow({ libraryPath: runtime.libraryPath, documentId, ordinal, window: 0 })
        .find((item) => item.ordinal === ordinal);
      const verifiedDocument = findMaterialsDocument(runtime.libraryPath, documentId);
      if (!record?.text.trim() || !verifiedDocument || verifiedDocument.contentHash !== document.contentHash) {
        ctx.session.markCandidateSkipped(`materials:${documentId}:${ordinal}`, '资料原文在深读时不可用或内容已变化。');
        return toolError('资料原文不可用或已变化，请重新检索。', '资料深读未取到稳定原文。');
      }
      if (record.text.length > MAX_MATERIAL_DEEP_READ_CHARS) {
        ctx.session.markCandidateSkipped(`materials:${documentId}:${ordinal}`, `父块原文超过 ${MAX_MATERIAL_DEEP_READ_CHARS} 字符的单条深读上限。`);
        return toolError('该父块超过本轮单条深读上限，请缩小范围或换一条候选。', '资料父块超过深读上限。');
      }
      const registered = ctx.session.registerMaterialEvidence({
        documentId,
        ordinal,
        title: document.name,
        sourceContentHash: document.contentHash,
        content: record.text,
      });
      if (registered.added) ctx.onEvidence?.(registered.item);
      return {
        ok: true,
        observation: `<selection_verified_material document_id="${escape(documentId)}" ordinal="${ordinal}"><content>${escape(record.text)}</content></selection_verified_material>\n<selection_research_note>该父块已完成原文深读，可用于支撑新增事实；最终正文不要输出引用号或证据 ID。</selection_research_note>`,
        message: `已深读资料「${document.name}」父块 ${ordinal}。`,
        referenceCount: registered.added ? 1 : 0,
      };
    },
  };
}

function createGetDocumentInfoTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'get_document_info',
    description: '查看已授权资料库中某个文档的名称、索引状态与可深读父块数量；不返回正文，也不产生证据。',
    parameters: {
      type: 'object',
      properties: { document_id: { type: 'string', description: '可选：已知文档 id；省略时返回少量文档概览' } },
    },
    execute: async (args, ctx) => {
      const runtime = ctx.materialRuntime;
      if (!runtime) return toolError('资料库研究未授权或未就绪。', '资料库研究未就绪。');
      assertToolCurrent(ctx);
      const documentId = readBoundedString(args.document_id, 160);
      const documents = listMaterialsDocuments(runtime.libraryPath);
      if (documentId) {
        const document = documents.find((item) => item.id === documentId);
        if (!document) return toolError('资料文档不存在。', `资料文档不存在：${documentId}。`);
        return {
          ok: true,
          observation: `<selection_document_info document_id="${escape(document.id)}" name="${escape(document.name)}" vector_state="${document.vectorState}" />`,
          message: `已返回资料文档「${document.name}」信息。`,
        };
      }
      return {
        ok: true,
        observation: `<selection_document_overview>${documents.slice(0, 20).map((document) => `<document document_id="${escape(document.id)}" name="${escape(document.name)}" vector_state="${document.vectorState}" />`).join('')}</selection_document_overview>`,
        message: `已返回 ${Math.min(documents.length, 20)} 篇资料文档概览。`,
      };
    },
  };
}

function createWebSearchTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'web_search',
    description: '在已授权的联网服务中定位外部网页候选。摘要仅用于导航，不能支撑新增事实；需要事实时必须用 web_fetch 读取本轮结果的全文。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: MAX_MATERIAL_QUERY_LENGTH, description: '一条与编辑目标有关的完整搜索查询' } },
      required: ['query'],
    },
    execute: async (args, ctx) => {
      const query = readBoundedString(args.query, MAX_MATERIAL_QUERY_LENGTH);
      if (!query) return toolError('web_search 需要非空的 query。', '网页搜索查询为空。');
      const runtime = ctx.webRuntime;
      if (!runtime) return toolError('联网补充未授权或未就绪。', '联网补充未就绪。');
      assertToolCurrent(ctx);
      ctx.session.plan('web', '先执行受限 web_search，再只抓取本轮返回的公开 URL 全文核验。');
      ctx.onStatus?.(`正在联网定位「${truncate(query, 28)}」的候选网页…`);
      let results;
      try {
        results = await runtime.adapter.search({ query, maxResults: Math.min(MAX_WEB_SEARCH_RESULTS, runtime.maxResults), config: runtime.runtimeConfig, signal: ctx.signal });
      } catch (error) {
        return toolError(`网页搜索失败：${error instanceof Error ? error.message : String(error)}。`, '网页搜索失败。');
      }
      const lines = [`<selection_web_candidates query="${escape(query)}">`];
      let count = 0;
      for (const result of results.slice(0, MAX_WEB_SEARCH_RESULTS)) {
        let url: URL;
        try {
          url = parsePublicWebUrl(result.url);
        } catch {
          continue;
        }
        const normalizedUrl = url.toString();
        ctx.session.recordWebCandidate({
          url: normalizedUrl,
          title: result.title || url.hostname,
          source: result.source,
          queryTerms: [query],
          goalIds: goalIdsForQuery(ctx.goals, query),
        });
        count += 1;
        lines.push(`  <candidate url="${escape(normalizedUrl)}" title="${escape(result.title || url.hostname)}" page_verified="false">${escape(truncate(result.snippet || result.content || '', 360))}</candidate>`);
      }
      lines.push('</selection_web_candidates>');
      lines.push(`<selection_research_note>${count > 0 ? '网页摘要未经全文核验；若要新增外部事实，必须用 web_fetch 抓取其中一个 URL。' : '未返回可抓取的公开网页候选。'}</selection_research_note>`);
      return { ok: true, observation: lines.join('\n'), message: `联网搜索定位 ${count} 个网页候选。`, referenceCount: 0 };
    },
  };
}

function createWebFetchTool(): ReActTool<SelectionEditResearchToolContext> {
  return {
    name: 'web_fetch',
    description: '读取本轮 web_search 返回的一个公开 URL 的正文。URL 必须来自候选；成功全文核验后才会成为可支撑新增事实的网页证据。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 500, description: '此前 web_search 返回的公开 URL' } },
      required: ['url'],
    },
    execute: async (args, ctx) => {
      const rawUrl = readBoundedString(args.url, 500);
      if (!rawUrl) return toolError('web_fetch 需要非空的 url。', '网页抓取 URL 为空。');
      const runtime = ctx.webRuntime;
      if (!runtime) return toolError('联网补充未授权或未就绪。', '联网补充未就绪。');
      let url: URL;
      try {
        url = parsePublicWebUrl(rawUrl);
      } catch {
        return toolError('URL 必须是本轮 web_search 返回的公开 HTTP/HTTPS 地址。', '网页抓取 URL 无效。');
      }
      const normalizedUrl = url.toString();
      const candidate = ctx.session.webCandidate(normalizedUrl);
      if (!candidate) return toolError('URL 不在本轮 web_search 候选白名单中。', '网页抓取 URL 不在本轮候选中。');
      assertToolCurrent(ctx);
      ctx.onStatus?.(`正在全文核验网页「${truncate(candidate.title, 28)}」…`);
      try {
        const outcome = await fetchWebPage({ url: normalizedUrl, signal: ctx.signal });
        if (outcome.empty || !outcome.text.trim()) return toolError('网页正文为空，未完成全文核验。', '网页正文为空。');
        const content = outcome.text.slice(0, MAX_WEB_PAGE_CHARS);
        if (content.length < MIN_WEB_PAGE_CHARS) return toolError('网页正文不足以完成受限全文核验。', '网页正文过短。');
        const registered = ctx.session.registerWebEvidence({
          url: normalizedUrl,
          title: outcome.title?.trim() || candidate.title,
          verifiedContentHash: hashText(outcome.text),
          content,
        });
        if (registered.added) ctx.onEvidence?.(registered.item);
        return {
          ok: true,
          observation: `<selection_verified_web_page url="${escape(normalizedUrl)}" page_verified="true"><content>${escape(content)}</content></selection_verified_web_page>\n<selection_research_note>网页已完成全文核验，可用于支撑新增事实；最终正文不要输出 URL、引用号或证据 ID，除非编辑目标本身要求保留。</selection_research_note>`,
          message: `已全文核验网页「${candidate.title}」。`,
          referenceCount: registered.added ? 1 : 0,
        };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return toolError(`网页全文读取失败：${error instanceof Error ? error.message : String(error)}。`, '网页全文读取失败。');
      }
    },
  };
}

function buildValidationNudge(validation: SelectionEditValidation): string {
  const issues = (validation.issues ?? []).map((issue) => issue.code);
  if (issues.includes('EXPAND_NOT_LONGER') || issues.includes('TARGET_LENGTH_MISSED')) {
    return '现有建议没有达到扩写目标。请基于已深读或已全文核验的原文重新扩写，保留原文锚点；不要重复调用相同工具。';
  }
  if (issues.includes('UNSUPPORTED_ADDITION') || issues.includes('EVIDENCE_GOAL_UNCOVERED')) {
    return '新增句子缺少已验证原文支持。若存在新的合法查询路径，请检索并深读；否则删除无依据增补后输出保守版本。';
  }
  return `现有建议未通过选区写回校验（${issues.join('、') || '未知原因'}）。请修正后仅输出 <final_answer> 包裹的建议正文，不要重复调用相同工具。`;
}

function assertCurrent(input: Pick<SelectionEditAgentRuntimeInput, 'signal' | 'isSnapshotCurrent'>): void {
  if (input.signal.aborted) {
    const error = new Error('已取消 AI 编辑任务。');
    error.name = 'AbortError';
    throw error;
  }
  if (!input.isSnapshotCurrent()) throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
}

function assertToolCurrent(context: SelectionEditResearchToolContext): void {
  assertCurrent(context);
}

function toolError(observationMessage: string, message: string): ReActToolExecution {
  return { ok: false, observation: `<tool_error>${escape(observationMessage)}</tool_error>`, message };
}

function readBoundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function goalIdsForQuery(goals: readonly SelectionEditAgentGoal[], query: string): string[] {
  const normalized = query.toLocaleLowerCase('zh-CN');
  const matched = goals.filter((goal) => goal.queryTerms.some((term) => normalized.includes(term.toLocaleLowerCase('zh-CN')))).map((goal) => goal.goalId);
  return matched.length > 0 ? matched : goals.filter((goal) => goal.required).map((goal) => goal.goalId);
}

function escape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
