import { generateAiJson } from '../knowledge/aiProvider';
import type { AiProviderConfig } from '../knowledge/aiTypes';
import { isStructuredOutputContractError } from '../knowledge/structuredOutputContract';

/**
 * 「拆分为子节点」结构化小调用（方案 §5）：终答产出后，基于节点正文与助手拆分建议
 * 提炼出可独立成节的子节点清单 `{title, summary}`。概述将作为派生节点 markdown。
 *
 * 与 `followUpSuggestions.ts` 同构：strict schema 校验失败回退宽松解析，取消原样上抛，
 * 其余失败抛 `WikiSplitProposalError` 由调用方静默吞掉（draft 仍产出但 proposedChildren=[]）。
 */

export const WIKI_SPLIT_MAX_OUTPUT_TOKENS = 1_600;
export const WIKI_SPLIT_TIMEOUT_MS = 12_000;
/** 子节点数量上限（方案 §5）。 */
export const WIKI_SPLIT_MAX_COUNT = 5;
/** 子节点标题字符上限。 */
export const WIKI_SPLIT_TITLE_MAX_CHARS = 20;
/** 子节点概述字符上限。 */
export const WIKI_SPLIT_SUMMARY_MAX_CHARS = 400;
/** 终答头部注入字符数。 */
const WIKI_SPLIT_ANSWER_HEAD_CHARS = 800;
/** 节点正文头部注入字符数。 */
const WIKI_SPLIT_NODE_HEAD_CHARS = 4_000;

export interface WikiSplitChild {
  title: string;
  summary: string;
}

const WIKI_SPLIT_SYSTEM_PROMPT = `你是 Trellora Wiki 的章节拆分助手。
用户已针对某个章节请求「拆分为子节点」，助手已给出拆分建议正文。
请基于该章节正文与助手的拆分建议，提炼出可独立成节的子节点清单。

规则：
1. 子节点数量 2~5 个；若章节内容不足以拆分，返回空数组。
2. 每个子节点标题不超过 20 字，简洁、可独立理解，不得照抄章节标题原文。
3. 每个子节点概述不超过 400 字，说明该子节点应包含的内容，必须源自本章节，不得引入章节外推测。
4. 子节点之间不得重叠或重复。
5. 只返回合法 JSON，不要输出额外解释。

章节路径：
<node_path>

章节标题：
<node_title>

章节正文（头部截断）：
<node_content>

助手拆分建议正文（头部截断）：
<answer>`;

const WIKI_SPLIT_JSON_SCHEMA = {
  name: 'wiki_split_proposal',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      children: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['title', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['children'],
    additionalProperties: false,
  },
} as const;

export function buildWikiSplitProposalPrompt(input: {
  nodeTitle: string;
  nodePath: string;
  nodeMarkdown: string;
  answer: string;
}): string {
  return WIKI_SPLIT_SYSTEM_PROMPT
    .replace('<node_path>', input.nodePath || input.nodeTitle)
    .replace('<node_title>', input.nodeTitle)
    .replace('<node_content>', input.nodeMarkdown.slice(0, WIKI_SPLIT_NODE_HEAD_CHARS))
    .replace('<answer>', input.answer.slice(0, WIKI_SPLIT_ANSWER_HEAD_CHARS));
}

/** 宽松提取：接受 {children:[...]} / 顶层数组，跳过非法项，标题去重，永不抛错。 */
function extractChildren(value: unknown, nodeTitle: string): WikiSplitChild[] {
  let items: unknown[] | undefined;
  if (Array.isArray(value)) items = value;
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.children)) items = record.children;
  }
  if (!items) return [];
  const normalizedTitle = nodeTitle.trim();
  const result: WikiSplitChild[] = [];
  const seenTitles = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
    if (!rawTitle || rawTitle === normalizedTitle || seenTitles.has(rawTitle)) continue;
    const title = rawTitle.slice(0, WIKI_SPLIT_TITLE_MAX_CHARS);
    const summary = typeof record.summary === 'string'
      ? record.summary.trim().slice(0, WIKI_SPLIT_SUMMARY_MAX_CHARS)
      : '';
    seenTitles.add(title);
    result.push({ title, summary });
    if (result.length >= WIKI_SPLIT_MAX_COUNT) break;
  }
  return result;
}

/** Schema 校验失败时的回退解析：优先对象切片，其次整体文本。 */
function parseLenientJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidates: string[] = [];
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 尝试下一个候选。
    }
  }
  throw new WikiSplitProposalError('invalid-split', '拆分子节点原始输出不是合法 JSON。');
}

export class WikiSplitProposalError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'WikiSplitProposalError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * 拆分子节点提案生成服务：校验截断后返回 ≤5 个 `{title, summary}`；
 * 取消（AbortSignal）原样上抛，其余失败抛 `WikiSplitProposalError` 由调用方静默处理。
 */
export async function generateWikiSplitProposal(input: {
  nodeTitle: string;
  nodePath: string;
  nodeMarkdown: string;
  answer: string;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
  /** 成功路径回传模型原始输出，供调用方落痕诊断。 */
  onRawOutput?: (raw: string) => void;
}): Promise<WikiSplitChild[]> {
  let rawOutput: string | undefined;
  let value: unknown;
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: buildWikiSplitProposalPrompt({
        nodeTitle: input.nodeTitle,
        nodePath: input.nodePath,
        nodeMarkdown: input.nodeMarkdown,
        answer: input.answer,
      }),
      maxOutputTokens: WIKI_SPLIT_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: WIKI_SPLIT_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'wiki-split-proposal',
      jsonSchema: WIKI_SPLIT_JSON_SCHEMA,
      onRawResponse: (text) => { rawOutput = text; },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    // Schema 校验失败属最佳努力场景：回退宽松解析原始输出，其余失败照常上抛。
    if (isStructuredOutputContractError(error) && error.reason === 'schema-validation' && rawOutput !== undefined) {
      value = parseLenientJson(rawOutput);
    } else {
      throw new WikiSplitProposalError('split-call-failed', error instanceof Error ? error.message : String(error), rawOutput);
    }
  }
  if (rawOutput !== undefined) input.onRawOutput?.(rawOutput);
  return extractChildren(value, input.nodeTitle);
}
