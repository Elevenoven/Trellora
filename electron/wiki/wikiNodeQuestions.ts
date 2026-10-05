import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDirectory } from '../pathGuards';
import { atomicWriteJson, safeSegment } from '../pipeline/pathLayout';
import { getLibraryMetaDirectory } from '../treeOrder';
import { generateAiJson } from '../knowledge/aiProvider';
import type { AiProviderConfig } from '../knowledge/aiTypes';
import { isStructuredOutputContractError } from '../knowledge/structuredOutputContract';

/**
 * Wiki 节点建议问题（方案 §7）：站在读者角度为某个章节生成 3~4 个最可能想问的问题，
 * 加载到节点上作为可一键发送的芯片。
 *
 * 生成完整复用 `followUpSuggestions.ts` 模式：strict schema `{questions:string[]}`，
 * 校验失败回退宽松解析，取消原样上抛，其余失败抛 `WikiNodeQuestionsError` 由调用方静默吞掉。
 * 结果按文档 `contentHash` 缓存到 `.menghan-meta/wiki/<docId>.node-questions.json`，
 * 源文档变化整文件失效；单节点可强制刷新。只写元数据目录，绝不改用户原始文件。
 */

export const WIKI_QUESTIONS_MAX_OUTPUT_TOKENS = 256;
export const WIKI_QUESTIONS_TIMEOUT_MS = 8_000;
/** 建议问题数量上限（方案 §7.1）。 */
export const WIKI_QUESTIONS_MAX_COUNT = 4;
/** 单条建议问题字符上限。 */
export const WIKI_QUESTIONS_MAX_CHARS = 40;
/** 节点正文头部注入字符数。 */
const WIKI_QUESTIONS_NODE_HEAD_CHARS = 6_000;
const MAX_QUESTIONS_FILE_BYTES = 2 * 1024 * 1024;
/** 单文档缓存的节点建议问题条目上限；超出按 updatedAt 淘汰最旧。 */
const MAX_QUESTIONS_CACHED_NODES = 500;

interface WikiNodeQuestionsEntry {
  questions: string[];
  model: string;
  updatedAt: string;
}

interface WikiNodeQuestionsFile {
  schemaVersion: 1;
  documentId: string;
  contentHash: string;
  byNode: Record<string, WikiNodeQuestionsEntry>;
}

/** 回传渲染进程的建议问题结果（方案 §7.3）。 */
export interface WikiNodeQuestionsOutcome {
  questions: string[];
  /** 生成失败（含超时）为 true；UI 据此显示 degraded 态而非伪装成功。 */
  degraded: boolean;
  /** 命中缓存直接返回为 true。 */
  fromCache: boolean;
}

/** 建议问题 IPC 错误码（对齐 WikiDerivedErrorCode / WikiSiblingOrderErrorCode 风格）。 */
export type WikiQuestionsErrorCode =
  | 'WIKI_QUESTIONS_INVALID'
  | 'WIKI_QUESTIONS_NODE_NOT_FOUND'
  | 'WIKI_QUESTIONS_MODEL_UNAVAILABLE'
  | 'WIKI_QUESTIONS_SOURCE_STALE';

/**
 * 回传渲染进程的建议问题 IPC 结果（方案 §7.3）。
 * ok 分支携带问题清单与降级/缓存标记（生成为最佳努力，degraded 表示本次未拿到问题）；
 * 失败分支仅覆盖硬错误（库/节点/模型不可用、来源过期），UI 一律静默映射为 degraded。
 */
export type WikiNodeQuestionsResult =
  | { ok: true; questions: string[]; degraded: boolean; fromCache: boolean }
  | { ok: false; error: { code: WikiQuestionsErrorCode; message: string; diagnostic?: string } };

const WIKI_QUESTIONS_SYSTEM_PROMPT = `你是 Trellora Wiki 的章节阅读引导助手。
请站在读者角度，针对下面这个章节，生成 3~4 个读者最可能想问的问题，帮助读者快速切入本章节内容。

规则：
1. 自包含：每个问题不得依赖上下文指代（不用"它 / 这个 / 那个"），必须能独立被理解和回答。
2. 每个问题不超过 40 字，口语自然、可直接点击发送。
3. 不得重复或简单改写章节标题原文。
4. 问题必须能用本章节内容回答，不得指向章节之外或引入本章节未涉及的新主题。
5. 问题之间不得重复，应覆盖本章节的不同侧面。
6. 只返回合法 JSON，不要输出额外解释。

章节路径：
<node_path>

章节标题：
<node_title>

子章节标题清单：
<children>

章节正文（头部截断）：
<node_content>`;

const WIKI_QUESTIONS_JSON_SCHEMA = {
  name: 'wiki_node_questions',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['questions'],
    additionalProperties: false,
  },
} as const;

export function buildWikiNodeQuestionsPrompt(input: {
  nodeTitle: string;
  nodePath: string;
  childTitles: string[];
  nodeMarkdown: string;
}): string {
  const children = input.childTitles.length > 0 ? input.childTitles.join('、') : '（无）';
  const content = input.nodeMarkdown.slice(0, WIKI_QUESTIONS_NODE_HEAD_CHARS) || '（本章节没有独立正文，可能只是一个目录标题）';
  return WIKI_QUESTIONS_SYSTEM_PROMPT
    .replace('<node_path>', input.nodePath || input.nodeTitle)
    .replace('<node_title>', input.nodeTitle)
    .replace('<children>', children)
    .replace('<node_content>', content);
}

/** 宽松提取：接受 {questions:[...]} / {suggestions:[...]} / 顶层数组，跳过非字符串项，去重，永不抛错。 */
function extractQuestions(value: unknown, nodeTitle: string): string[] {
  let items: unknown[] | undefined;
  if (Array.isArray(value)) items = value;
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = Array.isArray(record.questions) ? record.questions : Array.isArray(record.suggestions) ? record.suggestions : undefined;
    if (candidate) items = candidate;
  }
  if (!items) return [];
  const normalizedTitle = nodeTitle.trim();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed === normalizedTitle || result.includes(trimmed)) continue;
    result.push(trimmed.slice(0, WIKI_QUESTIONS_MAX_CHARS));
    if (result.length >= WIKI_QUESTIONS_MAX_COUNT) break;
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
  throw new WikiNodeQuestionsError('invalid-questions', '节点建议问题原始输出不是合法 JSON。');
}

export class WikiNodeQuestionsError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'WikiNodeQuestionsError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * 建议问题生成服务：校验截断后返回 ≤4 条问题；
 * 取消（AbortSignal）原样上抛，其余失败抛 `WikiNodeQuestionsError` 由调用方静默处理。
 */
export async function generateWikiNodeQuestions(input: {
  nodeTitle: string;
  nodePath: string;
  childTitles: string[];
  nodeMarkdown: string;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
  /** 成功路径回传模型原始输出，供调用方落痕诊断。 */
  onRawOutput?: (raw: string) => void;
}): Promise<string[]> {
  let rawOutput: string | undefined;
  let value: unknown;
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: buildWikiNodeQuestionsPrompt({
        nodeTitle: input.nodeTitle,
        nodePath: input.nodePath,
        childTitles: input.childTitles,
        nodeMarkdown: input.nodeMarkdown,
      }),
      maxOutputTokens: WIKI_QUESTIONS_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: WIKI_QUESTIONS_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'wiki-node-questions',
      jsonSchema: WIKI_QUESTIONS_JSON_SCHEMA,
      onRawResponse: (text) => { rawOutput = text; },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    // Schema 校验失败属最佳努力场景：回退宽松解析原始输出，其余失败照常上抛。
    if (isStructuredOutputContractError(error) && error.reason === 'schema-validation' && rawOutput !== undefined) {
      value = parseLenientJson(rawOutput);
    } else {
      throw new WikiNodeQuestionsError('questions-call-failed', error instanceof Error ? error.message : String(error), rawOutput);
    }
  }
  if (rawOutput !== undefined) input.onRawOutput?.(rawOutput);
  return extractQuestions(value, input.nodeTitle);
}

/**
 * 建议问题解析入口（方案 §7.3）：命中缓存直接返回；未命中（或 refresh）同步生成并写回。
 * 生成为最佳努力：失败 / 超时返回 `{questions:[], degraded:true}` 且不写缓存（下次打开重试）。
 */
export async function resolveWikiNodeQuestions(input: {
  libraryPath: string;
  documentId: string;
  nodeId: string;
  contentHash: string;
  nodeTitle: string;
  nodePath: string;
  childTitles: string[];
  nodeMarkdown: string;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  refresh: boolean;
  onRawOutput?: (raw: string) => void;
}): Promise<WikiNodeQuestionsOutcome> {
  const { libraryPath, documentId, nodeId, contentHash, refresh } = input;
  if (!refresh) {
    const cached = readQuestionsFile(libraryPath, documentId, contentHash)?.byNode[nodeId];
    if (cached) return { questions: cached.questions, degraded: false, fromCache: true };
  }

  const controller = new AbortController();
  let questions: string[];
  try {
    questions = await generateWikiNodeQuestions({
      nodeTitle: input.nodeTitle,
      nodePath: input.nodePath,
      childTitles: input.childTitles,
      nodeMarkdown: input.nodeMarkdown,
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      signal: controller.signal,
      ...(input.onRawOutput ? { onRawOutput: input.onRawOutput } : {}),
    });
  } catch {
    return { questions: [], degraded: true, fromCache: false };
  }

  try {
    await enqueueQuestionsWrite(questionsFilePath(libraryPath, documentId), () => persistQuestions({
      libraryPath,
      documentId,
      contentHash,
      nodeId,
      questions,
      model: input.model,
    }));
  } catch {
    // 写入失败不影响本次返回；下次打开会重新生成。
  }
  return { questions, degraded: false, fromCache: false };
}

/** 读取并校验建议问题缓存文件；缺失、超限、版本 / 文档 / 内容哈希不匹配一律视为无缓存（整文件失效）。 */
function readQuestionsFile(libraryPath: string, documentId: string, contentHash: string): WikiNodeQuestionsFile | null {
  const filePath = questionsFilePath(libraryPath, documentId);
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_QUESTIONS_FILE_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WikiNodeQuestionsFile>;
    if (value.schemaVersion !== 1 || value.documentId !== documentId || value.contentHash !== contentHash) return null;
    if (!value.byNode || typeof value.byNode !== 'object' || Array.isArray(value.byNode)) return null;
    const byNode: Record<string, WikiNodeQuestionsEntry> = {};
    for (const [cachedNodeId, entry] of Object.entries(value.byNode)) {
      const normalized = normalizeQuestionsEntry(entry);
      if (normalized) byNode[cachedNodeId] = normalized;
    }
    return { schemaVersion: 1, documentId, contentHash, byNode };
  } catch {
    return null;
  }
}

function normalizeQuestionsEntry(value: unknown): WikiNodeQuestionsEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.questions)) return null;
  if (typeof record.model !== 'string' || typeof record.updatedAt !== 'string') return null;
  const questions = record.questions
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, WIKI_QUESTIONS_MAX_CHARS))
    .filter(Boolean)
    .slice(0, WIKI_QUESTIONS_MAX_COUNT);
  return { questions, model: record.model, updatedAt: record.updatedAt };
}

/** 读-改-写在写队列内串行执行，避免多节点并发生成时相互覆盖。 */
function persistQuestions(input: {
  libraryPath: string;
  documentId: string;
  contentHash: string;
  nodeId: string;
  questions: string[];
  model: string;
}): void {
  const { libraryPath, documentId, contentHash, nodeId, questions, model } = input;
  const existing = readQuestionsFile(libraryPath, documentId, contentHash);
  const byNode: Record<string, WikiNodeQuestionsEntry> = { ...(existing?.byNode ?? {}) };
  byNode[nodeId] = { questions, model, updatedAt: new Date().toISOString() };
  const nodeIds = Object.keys(byNode);
  if (nodeIds.length > MAX_QUESTIONS_CACHED_NODES) {
    const oldestFirst = nodeIds.sort((left, right) => (byNode[left].updatedAt < byNode[right].updatedAt ? -1 : 1));
    for (const staleId of oldestFirst.slice(0, nodeIds.length - MAX_QUESTIONS_CACHED_NODES)) delete byNode[staleId];
  }
  const filePath = questionsFilePath(libraryPath, documentId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJson(filePath, { schemaVersion: 1, documentId, contentHash, byNode } satisfies WikiNodeQuestionsFile);
}

function questionsFilePath(libraryPath: string, documentId: string): string {
  return assertInsideDirectory(
    path.join(getLibraryMetaDirectory(libraryPath), 'wiki', `${safeSegment(documentId)}.node-questions.json`),
    libraryPath,
    'Wiki 节点建议问题元数据路径无效。',
  );
}

const questionsWriteQueues = new Map<string, Promise<unknown>>();

async function enqueueQuestionsWrite<T>(queueKey: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = questionsWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  questionsWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (questionsWriteQueues.get(queueKey) === current) questionsWriteQueues.delete(queueKey);
  }
}
