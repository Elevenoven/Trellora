import type { AiProviderConfig } from '../aiTypes';
import type { AiTransportImage } from '../aiGenerationTransport';
import type { AssistantTokenUsage } from '../tokenEstimator';
import type { AssistantModelInputCompression, AssistantPublicToolResultView, AssistantThinkingMode } from '../assistantTurnTypes';
import type { ObservationBudgetTracker } from './toolResultBudget';
import type { ReActToolRegistry } from './toolRegistry';
import type { ReActChatMessage, ReActChatRequest, ReActChatTransport, ReActToolCall } from './reactChatTransport';

/**
 * ReAct 引擎预算参数。取值对齐 DEFAULT_CURRENT_NOTE_AGENT_BUDGET 的
 * 工程经验（方案 §3.2），并可由调用方覆盖。
 */
export interface ReActBudget {
  /** Think→Act→Observe 最大轮数；简单问题 1–2 轮即终答。 */
  maxIterations: number;
  /** 模型调用次数上限（含空回答重试），经 ModelCallCoordinator 计费。 */
  maxModelCalls: number;
  /** 工具调用总次数上限，含重复调用计数（重复签名仍会被拒绝）。 */
  maxToolCalls: number;
  /** 模型返回空内容（无文本、无工具调用）时的重试上限。 */
  maxEmptyRetries: number;
  /** 连续输出相同文本的熔断轮数，对齐 WeKnora maxRepeatedResponseRounds。 */
  maxRepeatedContentRounds: number;
  /** 旧单条观察上限；WK-M7 起只用于灰度诊断。 */
  maxSingleObservationChars: number;
  /** 旧全轮观察预算；WK-M7 起只用于灰度诊断，不再拒绝工具。 */
  maxTotalObservationTokens: number;
  /** 轮内固化触发比例（相对 contextWindowTokens，对齐 WeKnora 0.5）；<=0 表示关闭。 */
  contextConsolidationThreshold: number;
  /** 固化摘要输出 maxTokens；严格固定为 2,000。 */
  contextConsolidationMaxTokens: number;
  /** 触发阈值到压缩目标的比例：0.5 × 0.6 = 窗口 30%。 */
  contextConsolidationTargetRatio: number;
  /** 为新 Memory Summary 预留的 token。 */
  contextConsolidationSummaryReserveTokens: number;
  /** 单次固化最多尝试的独立维护调用次数。 */
  contextConsolidationMaxAttempts: number;
  /** 每次摘要维护调用超时。 */
  contextConsolidationTimeoutMs: number;
  /** 普通 user/assistant 摘要候选的 Unicode code point 上限。 */
  contextConsolidationMessageCodePoints: number;
  /** assistant tool-call/tool result 摘要候选的 Unicode code point 上限。 */
  contextConsolidationToolCodePoints: number;
  /** 摘要失败后的每条消息原文归档 Unicode code point 上限。 */
  contextConsolidationFallbackCodePoints: number;
  /** 摘要后仍超出该比例时，从最旧原子消息组开始裁剪。 */
  contextAtomicTrimThreshold: number;
}

export const DEFAULT_REACT_BUDGET: ReActBudget = {
  maxIterations: 6,
  maxModelCalls: 8,
  maxToolCalls: 10,
  maxEmptyRetries: 1,
  maxRepeatedContentRounds: 2,
  maxSingleObservationChars: 12_000,
  // 沿用"知识库场景固定预留 20,000 token 动态轨迹"的既有预算规则。
  maxTotalObservationTokens: 20_000,
  contextConsolidationThreshold: 0.5,
  contextConsolidationMaxTokens: 2_000,
  contextConsolidationTargetRatio: 0.6,
  contextConsolidationSummaryReserveTokens: 500,
  contextConsolidationMaxAttempts: 3,
  contextConsolidationTimeoutMs: 60_000,
  contextConsolidationMessageCodePoints: 2_000,
  contextConsolidationToolCodePoints: 1_000,
  contextConsolidationFallbackCodePoints: 500,
  contextAtomicTrimThreshold: 0.8,
};

/**
 * ReAct 循环进入终态时的领域文案与回答投影规则。
 *
 * 知识库问答使用 DEFAULT_REACT_TERMINAL_POLICY；后续研究型编辑可只覆盖
 * 自己的终态语言与投影方式，而不复制 Think→Act→Observe 主循环。
 */
export type ReActFinalAnswerNormalization = 'extract-final-answer-tag' | 'trim';

export interface ReActTerminalPolicy {
  /** 预算耗尽后发起无工具合成时追加的指令。 */
  synthesisInstruction: string;
  /** 无文本、无工具调用时的有限重试提示。 */
  emptyRetryNudge: string;
  /** 工具调用次数达到上限后写回观察和下一轮上下文的提示。 */
  toolCallLimitReply: string;
  /** Provider 输入因物理上下文上限被拒绝时的终态回答。 */
  contextHardLimitReply: string;
  /** 终答正文的投影方式；知识库默认只展示 <final_answer> 包裹的正文。 */
  finalAnswerNormalization: ReActFinalAnswerNormalization;
}

/**
 * 知识库问答的现有终态语义基线。所有字段必须逐字符兼容，避免任务化
 * 策略改变既有 Provider 输入、兜底文案或最终答案投影。
 */
export const DEFAULT_REACT_TERMINAL_POLICY: ReActTerminalPolicy = {
  synthesisInstruction: '证据收集到此为止。请仅基于上方工具返回的证据，直接给出带引用号 [n] 的最终回答；证据不足的部分如实说明。不要再调用任何工具。',
  emptyRetryNudge: '请直接给出基于证据的最终回答，不要再输出空内容。',
  toolCallLimitReply: '工具调用次数已达上限，请基于已有证据直接作答。',
  contextHardLimitReply: '当前请求的必要上下文仍超过模型可接收上限，请缩小问题范围、减少附件或切换到更大上下文窗口的模型后重试。',
  finalAnswerNormalization: 'extract-final-answer-tag',
};

/**
 * P2 影子对比专用模型调用门上限：影子链路使用独立预算门，
 * 略高于引擎预算以留出兜底合成的余量。
 */
export const KNOWLEDGE_SHADOW_MODEL_CALL_BUDGET = 10;

/** 终答产出方式：自然终答 / 预算与熔断兜底合成。用户取消会直接抛出 AbortError。 */
export type ReActStopReason = 'natural' | 'budget-synthesized';

/** 终答引用台账条目；由 knowledgeSessionState 分配引用号。 */
export interface ReActCitationLedgerEntry {
  reference: string;
  /** 证据种类；缺省视为 'chunk'（存量条目兼容）。 */
  kind?: 'chunk' | 'web';
  // —— 知识库父块证据（kind 缺省/'chunk'）——
  documentId?: string;
  chunkId?: string;
  parentChunkId?: string;
  ordinal?: number;
  /** 原文保全用文本；assistantCitationGuard 校验取 sourceText。 */
  sourceText?: string;
  sectionContext?: string;
  score?: number;
  // —— 网页证据（kind='web'，联网搜索设计方案 §7.1）——
  url?: string;
  title?: string;
  /** 产出该证据的搜索厂商适配器 id。 */
  source?: string;
  /** web_search 摘要级证据为 false；web_fetch 全文核对成功后升级 true。 */
  pageVerified?: boolean;
}

/** 每执行一个工具后对外发布的轻量事件，用于 toolEvents / 详细轨迹。 */
export interface ReActRoundEvent {
  round: number;
  tool: string;
  state: 'started' | 'completed' | 'failed' | 'rejected';
  message: string;
  referenceCount?: number;
  /** 工具返回结果的结构化投影；仅 completed/failed 携带。 */
  publicResults?: AssistantPublicToolResultView[];
  elapsedMs?: number;
}

/** Renderer-safe projection is built by the caller; the engine only exposes the real round boundary. */
export interface ReActModelRoundEvent {
  round: number;
  callKind: 'decide';
  state: 'started' | 'completed' | 'rejected';
  messages: readonly ReActChatMessage[];
  /** Counts-only receipt for reductions applied to this exact provider input. */
  inputCompression?: AssistantModelInputCompression;
  response?: {
    content: string;
    toolCalls: ReActToolCall[];
  };
  errorCode?: string;
  elapsedMs?: number;
}

/** Main-process-only S0 hook. The callback must not mutate the request. */
export interface ReActProviderCallObservationEvent {
  callKind: 'react-decide' | 'react-synthesize';
  round?: number;
  request: ReActChatRequest;
  responseCompleted: boolean;
  usage?: AssistantTokenUsage;
}

/**
 * 调用方可在模型准备自然终答时实施领域门控。accept=false 时，引擎会收回
 * 已流式文本，并把 nudge 作为新的 user 消息送入下一轮决策。
 */
export interface ReActFinalAnswerGateDecision {
  accept: boolean;
  nudge?: string;
  detail?: Record<string, unknown>;
}

export interface ReActEngineInput<TContext = unknown> {
  systemPrompt: string;
  /** M1/M2 装配后的会话历史（不含本轮用户问题）。 */
  history: ReActChatMessage[];
  /** 本轮用户问题（含 <runtime_context> 注入）。 */
  question: string;
  /** 本轮用户问题携带的 VLM 图片；仅附着到当前 user 消息，不进入历史持久化。 */
  images?: AiTransportImage[];
  model: string;
  config: AiProviderConfig;
  transport: ReActChatTransport;
  registry: ReActToolRegistry<TContext>;
  toolContext: TContext;
  /** 观察预算执行器；缺省时引擎按 budget 自建（与工具侧台账分离）。 */
  observationTracker?: ObservationBudgetTracker;
  budget?: Partial<ReActBudget>;
  /**
   * 仅覆盖终态任务语义；不传时严格使用知识库默认策略。
   * 主循环、工具集、预算和引用台账不由该策略改变。
   */
  terminalPolicy?: Partial<ReActTerminalPolicy>;
  /** 模型上下文窗口（token）；提供时启用轮内固化，缺省不触发。 */
  contextWindowTokens?: number;
  signal: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  /** 用户为本轮选择的思考强度；维护型上下文压缩不继承该配置。 */
  thinkingMode?: AssistantThinkingMode;
  /** 每次业务模型调用前的计费与物理窗口准备；维护摘要不会进入该预算。 */
  onModelCall?: (context: {
    callIndex: number;
    estimatedPromptChars: number;
    estimatedPromptTokens: number;
    serializedPromptText: string;
  }) => { ready: boolean; reason?: string; maxPromptTokens?: number };
  /** 每次 ReAct 决策模型调用的公开轮次边界；不包含隐藏思考。 */
  onModelRound?: (event: ReActModelRoundEvent) => void;
  /** Observes the exact logical request handed to ReActChatTransport. */
  onProviderCallObserved?: (event: ReActProviderCallObservationEvent) => void;
  /** 领域终答门控；知识库默认不提供，Wiki 用它阻止“零命中后立即结束”。 */
  onBeforeFinalAnswer?: (context: {
    round: number;
    answer: string;
    toolCalls: number;
    citations: ReActCitationLedgerEntry[];
  }) => ReActFinalAnswerGateDecision;
  onRound?: (event: ReActRoundEvent) => void;
  /** 详细轨迹回调；接 emitAssistantTurnEvent/onDetailedTrace。 */
  onTrace?: (entry: { stage: 'react'; action: string; status: 'started' | 'completed' | 'failed'; detail?: Record<string, unknown> }) => void;
  /** 终答引用台账投影；由 knowledgeSessionState 提供。 */
  collectCitations?: () => ReActCitationLedgerEntry[];
  /** 答案增量投影（UI 流式）：模型输出文本且未进入工具调用时引擎逐块转发。 */
  onAnswerDelta?: (text: string) => void;
  /** 深度思考（reasoning）增量投影；提供商未返回思考内容时不会触发。 */
  onThinkingDelta?: (text: string) => void;
  /** 已流式文本但模型转去工具调用 / 轮次被取消：调用方清空已流式答案内容。 */
  onAnswerReset?: () => void;
}

export interface ReActResult {
  finalAnswer: string;
  /** Current-turn assistant tool-call and tool-result messages only. */
  agentMessages: ReActChatMessage[];
  /** Explicit provider reasoning_content belonging to the final response. */
  finalReasoningContent?: string;
  stopReason: ReActStopReason;
  /** 实际执行的 Think 轮数。 */
  rounds: number;
  modelCalls: number;
  /** 独立维护通道中的摘要尝试次数，不计入 modelCalls。 */
  maintenanceModelCalls: number;
  toolCalls: number;
  /** 轮内固化执行次数（P2）；0 表示未触发。 */
  consolidations: number;
  citations: ReActCitationLedgerEntry[];
  usage?: AssistantTokenUsage;
  /** 最后一次模型调用（Think/兜底合成）服务商上报用量；服务商不上报时缺省。 */
  lastUsage?: AssistantTokenUsage;
  /** 最后一次模型调用 prompt 的本地 token 估算；服务商不上报用量时的回退基准。 */
  lastPromptTokens?: number;
  /** 触发熔断/兜底时的人类可读原因，用于轨迹与日志。 */
  stopDetail?: string;
  /** 终答已流式投影到 UI 的字符数（0 = 未流式）；调用方据此补发未流式后缀。 */
  streamedAnswerChars: number;
}
