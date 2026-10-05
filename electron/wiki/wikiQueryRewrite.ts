import { generateAiJson } from '../knowledge/aiProvider';
import type { AiProviderConfig } from '../knowledge/aiTypes';
import type { AssistantConversationMessage } from '../knowledge/assistantTurnTypes';
import type { WikiActionKind } from './wikiQuickActions';
import {
  hasExplicitWikiDocumentScope,
  hasExplicitWikiNodeLock,
  resolveWikiScopeDecision,
  type WikiScopeMode,
} from './wikiScopePolicy';

export const WIKI_QUERY_REWRITE_MAX_OUTPUT_TOKENS = 1024;
export const WIKI_QUERY_REWRITE_TIMEOUT_MS = 15_000;

const REWRITE_MAX_CHARS = 300;
const SUB_QUESTION_MAX_COUNT = 3;
const SUB_QUESTION_MAX_CHARS = 200;
const EXPLICIT_SECTION_MAX_COUNT = 8;
const EXPLICIT_SECTION_MAX_CHARS = 60;
const HISTORY_MESSAGE_COUNT = 6;
const HISTORY_MESSAGE_MAX_CHARS = 500;
const SHORT_FOLLOWUP_CHARS = 12;

const ANAPHORA_MARKERS = [
  '它们', '他们', '她们', '它', '他', '她', '其', '该',
  '上述', '上面', '以上', '刚才', '之前', '前面', '上一轮',
  '这个', '那个', '这点', '那点', '这些', '那些',
];
const FOLLOWUP_STARTERS = ['那么', '然后', '接着', '继续', '再', '还有', '另外', '如果', '要是', '那'];
const ELLIPSIS_ENDINGS = ['呢？', '呢?', '呢'];
const SECTION_REFERENCE_PATTERN = /第[零〇一二三四五六七八九十百千万两\d]+(?:章|节|部分)/gu;

export type WikiQueryRewriteGateReason =
  | 'quick-action'
  | 'explicit-node-lock'
  | 'explicit-section-reference'
  | 'no-history'
  | 'follow-up'
  | 'self-contained';

export interface WikiQueryRewriteGateDecision {
  rewriting: boolean;
  reason: WikiQueryRewriteGateReason;
  matchedSignals: string[];
}

export interface WikiRewriteHistoryMessage {
  role: AssistantConversationMessage['role'];
  content: string;
}

export interface WikiQueryRewriteResult {
  rewrite: string;
  shouldSplit: boolean;
  subQuestions: string[];
  scopeIntent: WikiScopeMode;
  explicitSectionTitles: string[];
  rawOutput?: string;
  model: string;
  elapsedMs: number;
  guardTriggered?: string;
}

export class WikiQueryRewriteError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'WikiQueryRewriteError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * 快捷动作已有稳定意图，不额外花一次模型调用；自由问答只在需要消解上下文，
 * 或用户显式点名全文/章节时改写。"这里"保留为当前节点锚点，不视作历史指代。
 */
export function shouldRewriteWikiQuestion(input: {
  userText: string;
  conversation: AssistantConversationMessage[];
  actionKind: WikiActionKind;
}): WikiQueryRewriteGateDecision {
  if (input.actionKind !== 'free') {
    return { rewriting: false, reason: 'quick-action', matchedSignals: [] };
  }

  const text = input.userText.trim();
  if (hasExplicitWikiNodeLock(text)) {
    return { rewriting: false, reason: 'explicit-node-lock', matchedSignals: [] };
  }
  const explicitSections = extractExplicitWikiSectionReferences(text);
  if (hasExplicitWikiDocumentScope(text) || explicitSections.length > 0) {
    return {
      rewriting: true,
      reason: 'explicit-section-reference',
      matchedSignals: explicitSections.map((title) => `section:${title}`),
    };
  }
  if (input.conversation.length === 0) {
    return { rewriting: false, reason: 'no-history', matchedSignals: [] };
  }

  const matchedSignals: string[] = [];
  for (const marker of ANAPHORA_MARKERS) if (text.includes(marker)) matchedSignals.push(`anaphora:${marker}`);
  for (const starter of FOLLOWUP_STARTERS) if (text.startsWith(starter)) matchedSignals.push(`followup:${starter}`);
  for (const ending of ELLIPSIS_ENDINGS) if (text.endsWith(ending)) matchedSignals.push(`ellipsis:${ending}`);
  const anchoredToCurrentNode = /这里|本节|本章|当前章节|当前节点/u.test(text);
  if (text.length < SHORT_FOLLOWUP_CHARS && !anchoredToCurrentNode) matchedSignals.push('short-followup');
  if (matchedSignals.length > 0) {
    return { rewriting: true, reason: 'follow-up', matchedSignals };
  }
  return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
}

export function selectWikiRewriteHistory(
  conversation: AssistantConversationMessage[],
): WikiRewriteHistoryMessage[] {
  return conversation.slice(-HISTORY_MESSAGE_COUNT).map((message) => ({
    role: message.role,
    content: message.content.slice(0, HISTORY_MESSAGE_MAX_CHARS),
  }));
}

const WIKI_QUERY_REWRITE_PROMPT = `你是 Trellora Wiki 的问题改写与范围识别器。
请结合最近对话和当前问题，只返回以下 JSON：
{
  "rewrite": "可独立检索的问题",
  "should_split": false,
  "sub_questions": ["子问题"],
  "scope_intent": "node-first",
  "explicit_section_titles": []
}

规则：
1. 只做指代消解、上下文补全和轻量口语规范化，不得扩写用户意图。
2. 保留专有名词、编号、时间、角色、环境以及“只看本节/结合全文”等范围限制。
3. 只有原问题明确包含多个独立问题时才允许拆分，最多 3 个；否则 should_split=false。
4. scope_intent 只能是 node-locked、node-first、document-first。只看当前章节为 node-locked；明确全文、其他章节或点名章节为 document-first；其余为 node-first。
5. explicit_section_titles 只列出当前问题原文明确点名的章节标题或“第 X 章/节”，不得猜测目录。
6. 不回答问题，不生成章节概览、建议问题或检索计划。

<history>
{{history}}
</history>
<question>
{{question}}
</question>`;

const WIKI_QUERY_REWRITE_JSON_SCHEMA = {
  name: 'wiki_query_rewrite',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rewrite: { type: 'string' },
      should_split: { type: 'boolean' },
      sub_questions: { type: 'array', items: { type: 'string' } },
      scope_intent: { type: 'string', enum: ['node-locked', 'node-first', 'document-first'] },
      explicit_section_titles: { type: 'array', items: { type: 'string' } },
    },
    required: ['rewrite', 'should_split', 'sub_questions', 'scope_intent', 'explicit_section_titles'],
    additionalProperties: false,
  },
} as const;

export function buildWikiQueryRewritePrompt(input: {
  question: string;
  history: WikiRewriteHistoryMessage[];
}): string {
  const history = input.history
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${escapeXmlText(message.content)}`)
    .join('\n');
  return WIKI_QUERY_REWRITE_PROMPT
    .replace('{{history}}', history || '（无）')
    .replace('{{question}}', escapeXmlText(input.question));
}

export async function rewriteWikiQuestion(input: {
  question: string;
  history: WikiRewriteHistoryMessage[];
  actionKind: WikiActionKind;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
}): Promise<WikiQueryRewriteResult> {
  const startedAt = Date.now();
  let rawOutput: string | undefined;
  let value: unknown;
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: buildWikiQueryRewritePrompt({ question: input.question, history: input.history }),
      maxOutputTokens: WIKI_QUERY_REWRITE_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: WIKI_QUERY_REWRITE_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'query-rewrite',
      jsonSchema: WIKI_QUERY_REWRITE_JSON_SCHEMA,
      onRawResponse: (text) => { rawOutput = text; },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new WikiQueryRewriteError(
      'rewrite-call-failed',
      error instanceof Error ? error.message : String(error),
      rawOutput,
    );
  }

  if (!value || typeof value !== 'object') {
    throw new WikiQueryRewriteError('invalid-rewrite', 'Wiki 问题改写结果不是对象。', rawOutput);
  }
  const record = value as Record<string, unknown>;
  const rewriteRaw = typeof record.rewrite === 'string' ? record.rewrite.trim() : '';
  if (!rewriteRaw || rewriteRaw.length > REWRITE_MAX_CHARS) {
    throw new WikiQueryRewriteError('invalid-rewrite', 'Wiki 问题改写结果为空或过长。', rawOutput);
  }

  const originalQuestion = input.question.trim();
  let rewrite = rewriteRaw;
  let guardTriggered: string | undefined;
  if (rewrite.length > originalQuestion.length * 2 + 40) {
    rewrite = originalQuestion;
    guardTriggered = 'anti-divergence';
  }

  const normalizedSubQuestions = normalizeStringList(
    record.sub_questions,
    SUB_QUESTION_MAX_COUNT,
    SUB_QUESTION_MAX_CHARS,
  );
  if (normalizedSubQuestions === undefined) {
    throw new WikiQueryRewriteError('invalid-sub-questions', 'Wiki 子问题格式无效。', rawOutput);
  }
  const shouldSplit = record.should_split === true && normalizedSubQuestions.length >= 2;
  const subQuestions = shouldSplit ? normalizedSubQuestions : [rewrite];

  const suggestedScope = normalizeSuggestedScope(record.scope_intent);
  const scopeDecision = resolveWikiScopeDecision({
    actionKind: input.actionKind,
    userText: originalQuestion,
    suggestedMode: suggestedScope,
  });
  const explicitSectionTitles = normalizeExplicitSectionTitles(
    record.explicit_section_titles,
    originalQuestion,
  );

  return {
    rewrite,
    shouldSplit,
    subQuestions,
    scopeIntent: scopeDecision.mode,
    explicitSectionTitles,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    model: input.model,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(guardTriggered ? { guardTriggered } : {}),
  };
}

export function extractExplicitWikiSectionReferences(question: string): string[] {
  return [...new Set(question.match(SECTION_REFERENCE_PATTERN) ?? [])];
}

function normalizeSuggestedScope(value: unknown): WikiScopeMode | undefined {
  return value === 'node-locked' || value === 'node-first' || value === 'document-first'
    ? value
    : undefined;
}

function normalizeStringList(value: unknown, maxCount: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value.slice(0, maxCount)) {
    if (typeof item !== 'string') return undefined;
    const normalized = item.trim().slice(0, maxChars);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeExplicitSectionTitles(value: unknown, originalQuestion: string): string[] {
  const fromModel = normalizeStringList(value, EXPLICIT_SECTION_MAX_COUNT, EXPLICIT_SECTION_MAX_CHARS) ?? [];
  const literalModelTitles = fromModel.filter((title) => originalQuestion.includes(title));
  return [...new Set([
    ...extractExplicitWikiSectionReferences(originalQuestion),
    ...literalModelTitles,
  ])].slice(0, EXPLICIT_SECTION_MAX_COUNT);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
