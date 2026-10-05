import { generateAiJson } from './aiProvider';
import type { AiProviderConfig } from './aiTypes';
import type { QaRecentTurn } from './qaMemoryTypes';
import type { AssistantTokenUsage } from './tokenEstimator';

/**
 * 知识库问答问题改写（设计 docs/Trellora-2.0-知识库问题改写设计.md）：
 * 改写门（纯规则排除）→ LLM 改写服务（指代消解/上下文补全/显式多问拆分）。
 * 改写只影响检索 query，不替换回答 prompt 中的用户原文。
 */

/** 指代/回指信号：substring 匹配，v1 不做分词。 */
const ANAPHORA_MARKERS = [
  '它们', '他们', '她们', '它', '他', '她', '其', '该',
  '上述', '上面', '以上', '刚才', '之前', '前面', '上一轮',
  '这个', '那个', '这部', '这篇', '这份',
];

/** 承接式开头信号：startsWith 匹配。 */
const FOLLOWUP_STARTERS = ['那么', '然后', '接着', '继续', '再', '还有', '另外', '如果', '要是', '那'];

/** 省略式追问信号：endsWith 匹配。 */
const ELLIPSIS_ENDINGS = ['呢？', '呢?', '呢'];

export const QUERY_REWRITE_MAX_OUTPUT_TOKENS = 1024;
export const QUERY_REWRITE_TIMEOUT_MS = 15_000;
const REWRITE_MAX_CHARS = 300;
const SUB_QUESTION_MAX_COUNT = 3;
const SUB_QUESTION_MAX_CHARS = 200;
const SHORT_FOLLOWUP_CHARS = 12;
const SELF_CONTAINED_MAX_CHARS = 120;
const HISTORY_TURN_COUNT = 3;
const HISTORY_ANSWER_HEAD_CHARS = 200;

export interface QueryRewriteGateDecision {
  rewriting: boolean;
  /** 排除原因：no-history / self-contained。 */
  reason?: string;
  /** 命中的放行信号，形如 anaphora:它 / followup:那么 / ellipsis:呢 / short-followup。 */
  matchedSignals: string[];
}

/**
 * 改写门（设计 §3）：E1 无历史直接排除 → 放行信号命中即改写 → 其余按自足排除。
 * 误判方向是「多改写」，安全方向。
 */
export function shouldRewriteQuestion(input: { userText: string; hasHistory: boolean }): QueryRewriteGateDecision {
  const text = input.userText.trim();
  if (!input.hasHistory) return { rewriting: false, reason: 'no-history', matchedSignals: [] };
  const signals: string[] = [];
  for (const marker of ANAPHORA_MARKERS) if (text.includes(marker)) signals.push(`anaphora:${marker}`);
  for (const starter of FOLLOWUP_STARTERS) if (text.startsWith(starter)) signals.push(`followup:${starter}`);
  for (const ending of ELLIPSIS_ENDINGS) if (text.endsWith(ending)) signals.push(`ellipsis:${ending}`);
  if (text.length < SHORT_FOLLOWUP_CHARS) signals.push('short-followup');
  if (signals.length > 0) return { rewriting: true, matchedSignals: signals };
  if (text.length <= SELF_CONTAINED_MAX_CHARS) return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
  return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
}

/** 供改写 prompt 的 <history> 使用：最近 3 个已完成轮次，回答截头部。 */
export function selectRewriteHistoryTurns(recentTurns: QaRecentTurn[]): QaRecentTurn[] {
  return recentTurns.slice(-HISTORY_TURN_COUNT).map((turn) => ({
    userText: turn.userText,
    answerHead: turn.answerHead.slice(0, HISTORY_ANSWER_HEAD_CHARS),
  }));
}

export class QueryRewriteError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'QueryRewriteError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

export type KnowledgeGraphIntent = 'global' | 'local' | 'none';

export interface QueryRewriteResult {
  rewrite: string;
  shouldSplit: boolean;
  subQuestions: string[];
  /** 图意图门控（GraphRAG 方案 §4.3）：整体性/趋势/跨主题 → global；具体实体/关系 → local；其余 none。 */
  graphIntent: KnowledgeGraphIntent;
  rawOutput?: string;
  model: string;
  elapsedMs: number;
  /** 防发散等程序化护栏触发标记。 */
  guardTriggered?: string;
}

export interface QueryRewriteProviderCallObservationEvent {
  request: {
    model: string;
    prompt: string;
    maxOutputTokens: number;
    contextWindowTokens?: number;
    structuredOutputSchema: typeof QUERY_REWRITE_JSON_SCHEMA;
  };
  usage?: AssistantTokenUsage;
  responseCompleted: boolean;
}

const QUERY_REWRITE_SYSTEM_PROMPT = `你是企业文档问答系统的问题改写助手。
请结合历史上下文和当前问题，输出一个 JSON：
{
  "rewrite": "改写后的独立问题",
  "should_split": true,
  "sub_questions": ["子问题1", "子问题2"],
  "graph_intent": "none"
}

改写规则：
1. 只做指代消解、上下文补全、口语转书面化，不要发散扩写。
2. 专有名词、时间范围、环境、角色、终端类型等限制条件必须保留。
3. 不得添加原文没有的条件、维度、假设，不得引入"方面/维度/角度"等枚举词。
4. 如果当前问题已经完整，就尽量少改。
5. 不要根据你自己的理解去提前规划章节、结构或检索模式。

拆分规则：
1. 默认 should_split=false，sub_questions 只保留 1 条，且必须与 rewrite 表达同一件事。
2. 只有当前问题原文里显式存在多个独立问题时，才允许 should_split=true。
3. 可拆分的典型情况只有：多个问号、分号、换行列举、编号列举、明确"分别"提问。
4. 抽象对比、笼统追问、承接式追问一律不要拆分；只做改写。
5. 不确定时必须不拆分。
6. 只返回合法 JSON，不要输出额外解释。

图意图判定（graph_intent，只能取 global / local / none）：
1. 整库概览、主题脉络、跨文档趋势与共性总结等整体性问题 → global。
2. 围绕具体实体（人/组织/项目/概念）的关系、关联脉络类问题 → local。
3. 其余（普通内容检索、字面量查找、闲聊等）→ none。
4. 不确定时给 none。

历史上下文：
<history>

当前问题：
<question>`;

const QUERY_REWRITE_JSON_SCHEMA = {
  name: 'query_rewrite',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rewrite: { type: 'string' },
      should_split: { type: 'boolean' },
      sub_questions: { type: 'array', items: { type: 'string' } },
      graph_intent: { type: 'string' },
    },
    required: ['rewrite', 'should_split', 'sub_questions', 'graph_intent'],
    additionalProperties: false,
  },
} as const;

export function buildQueryRewritePrompt(input: { question: string; history: QaRecentTurn[]; askerBackground?: string }): string {
  const historyText = input.history
    .map((turn) => `用户：${turn.userText}\n助手：${turn.answerHead}`)
    .join('\n\n');
  const prompt = QUERY_REWRITE_SYSTEM_PROMPT
    .replace('<history>', historyText)
    .replace('<question>', input.question);
  const background = input.askerBackground?.trim();
  return background ? `${background}\n\n${prompt}` : prompt;
}

function normalizeSubQuestions(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value.slice(0, SUB_QUESTION_MAX_COUNT)) {
    if (typeof item !== 'string') return undefined;
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed.slice(0, SUB_QUESTION_MAX_CHARS));
  }
  return result;
}

/**
 * LLM 改写服务（设计 §4）：失败记痕由调用方负责，本函数抛 QueryRewriteError；
 * 取消（AbortSignal）原样上抛，走既有取消路径。
 */
export async function rewriteKnowledgeQuestion(input: {
  question: string;
  history: QaRecentTurn[];
  /** 仅帮助指代消解与查询改写，不得作为检索过滤条件。 */
  askerBackground?: string;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
  /** Main-process-only S0 hook; it must not mutate the observed request. */
  onProviderCallObserved?: (event: QueryRewriteProviderCallObservationEvent) => void;
}): Promise<QueryRewriteResult> {
  const startedAt = Date.now();
  let rawOutput: string | undefined;
  let value: unknown;
  let usage: AssistantTokenUsage | undefined;
  const observationRequest: QueryRewriteProviderCallObservationEvent['request'] = {
    model: input.model,
    prompt: buildQueryRewritePrompt({
      question: input.question,
      history: input.history,
      ...(input.askerBackground ? { askerBackground: input.askerBackground } : {}),
    }),
    maxOutputTokens: QUERY_REWRITE_MAX_OUTPUT_TOKENS,
    ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
    structuredOutputSchema: QUERY_REWRITE_JSON_SCHEMA,
  };
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: observationRequest.prompt,
      maxOutputTokens: QUERY_REWRITE_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: QUERY_REWRITE_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'query-rewrite',
      jsonSchema: QUERY_REWRITE_JSON_SCHEMA,
      onUsage: (incoming) => { usage = incoming; },
      onRawResponse: (text) => { rawOutput = text; },
    });
    notifyProviderObservation(input.onProviderCallObserved, {
      request: observationRequest,
      usage,
      responseCompleted: true,
    });
  } catch (error) {
    notifyProviderObservation(input.onProviderCallObserved, {
      request: observationRequest,
      usage,
      responseCompleted: false,
    });
    if (input.signal.aborted) throw error;
    throw new QueryRewriteError('rewrite-call-failed', error instanceof Error ? error.message : String(error), rawOutput);
  }
  const record = value as Record<string, unknown>;
  const rewriteRaw = typeof record.rewrite === 'string' ? record.rewrite.trim() : '';
  if (!rewriteRaw) throw new QueryRewriteError('invalid-rewrite', '改写结果为空。', rawOutput);
  if (rewriteRaw.length > REWRITE_MAX_CHARS) throw new QueryRewriteError('invalid-rewrite', `改写结果超过 ${REWRITE_MAX_CHARS} 字符。`, rawOutput);

  // 防发散护栏（设计 §4.3 规则 2）：超长改写回退原文，不抛错。
  let rewrite = rewriteRaw;
  let guardTriggered: string | undefined;
  if (rewrite.length > input.question.trim().length * 2 + 40) {
    rewrite = input.question.trim();
    guardTriggered = 'anti-divergence';
  }

  let subQuestions = normalizeSubQuestions(record.sub_questions);
  if (subQuestions === undefined) throw new QueryRewriteError('invalid-sub-questions', '子问题格式无效。', rawOutput);
  subQuestions = [...new Set(subQuestions)];
  const shouldSplit = record.should_split === true && subQuestions.length >= 2;
  if (!shouldSplit) subQuestions = [rewrite];

  return {
    rewrite,
    shouldSplit,
    subQuestions,
    graphIntent: normalizeGraphIntent(record.graph_intent),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    model: input.model,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(guardTriggered ? { guardTriggered } : {}),
  };
}

function notifyProviderObservation(
  callback: ((event: QueryRewriteProviderCallObservationEvent) => void) | undefined,
  event: QueryRewriteProviderCallObservationEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // S0 diagnostics are isolated from query rewrite behavior.
  }
}

/** 图意图白名单归一化：非法/缺失值一律落 none（安全方向：不做图路由）。 */
export function normalizeGraphIntent(value: unknown): KnowledgeGraphIntent {
  if (value === 'global' || value === 'local') return value;
  return 'none';
}
