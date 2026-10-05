import fs from 'node:fs';
import path from 'node:path';
import type { AssistantPublicModelText } from './assistantTurnTypes';

export const assistantDetailedTraceStages = [
  'turn',
  'routing',
  'rewrite',
  'context-tool',
  'planner',
  'model',
  'validation',
  'react-tool',
  'plan-commit',
  'fallback',
  'follow-up',
  'result',
] as const;

export type AssistantDetailedTraceStage = typeof assistantDetailedTraceStages[number];
export type AssistantDetailedTraceStatus = 'started' | 'completed' | 'rejected';

export interface AssistantDetailedTraceEntry {
  stage: AssistantDetailedTraceStage;
  action: string;
  status: AssistantDetailedTraceStatus;
  callKind?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  error?: unknown;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
}

export type AssistantDetailedTraceSink = (entry: AssistantDetailedTraceEntry) => void;

/** 渲染进程调试视图用的落盘记录投影（已经过脱敏）。 */
export interface AssistantDetailedTraceRecordView {
  timestamp: string;
  sequence: number;
  requestId: string;
  stage: string;
  action: string;
  status: string;
  callKind?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  error?: unknown;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
}

interface AssistantDetailedTraceRecord extends AssistantDetailedTraceEntry {
  timestamp: string;
  sequence: number;
  requestId: string;
}

const SECRET_KEY_PATTERN = /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token)$/iu;
const BINARY_PAYLOAD_KEY_PATTERN = /^(?:data[-_]?url|base64)$/iu;
const AUTHORIZATION_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/giu;
const INLINE_SECRET_PATTERN = /((?:api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)\s*[:=]\s*["']?)[^\s,"'}]+/giu;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]+/gu;
const HIDDEN_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/giu;
const HIDDEN_JSON_STRING_PATTERN = /("(?:analysis|reasoning|chain[_-]?of[_-]?thought|thoughts?)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;

export const ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS = 32_000;
export const ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS = 24_000;

/**
 * A turn-scoped JSONL writer. Logging is best effort: a filesystem failure is
 * reported to stderr but never changes the assistant result.
 */
export class AssistantDetailedTrace {
  readonly filePath: string;
  readonly requestId: string;

  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(logDirectory: string, requestId: string, startedAt = new Date()) {
    this.requestId = requestId;
    const directory = path.join(logDirectory, 'assistant-detailed');
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = startedAt.toISOString().replace(/[:.]/gu, '-');
    const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128) || 'unknown-request';
    this.filePath = path.join(directory, `assistant-turn-${timestamp}-${safeRequestId}.jsonl`);
  }

  record(entry: AssistantDetailedTraceEntry): void {
    const record: AssistantDetailedTraceRecord = {
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
      requestId: this.requestId,
      ...entry,
    };
    const line = `${JSON.stringify(redactDetailedTraceValue(record))}\n`;
    this.pending = this.pending
      .then(() => fs.promises.appendFile(this.filePath, line, 'utf8'))
      .catch((error) => {
        console.warn(`[assistant-detailed-trace] 无法写入 ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

export function toDetailedTraceError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: redactDetailedTraceText(error.message),
      ...(error.stack ? { stack: redactDetailedTraceText(error.stack) } : {}),
    };
  }
  return { name: 'UnknownError', message: redactDetailedTraceText(String(error)) };
}

export function redactDetailedTraceText(value: string): string {
  return value
    .replace(AUTHORIZATION_PATTERN, '$1[REDACTED]')
    .replace(INLINE_SECRET_PATTERN, '$1[REDACTED]');
}

export function createAssistantPublicModelText(value: string, maxCharacters: number): AssistantPublicModelText {
  const originalCharacters = value.length;
  const redacted = redactDetailedTraceText(value)
    .replace(WINDOWS_PATH_PATTERN, '[本地路径已省略]')
    .replace(HIDDEN_THINK_BLOCK_PATTERN, '<think>[隐藏思考已省略]</think>')
    .replace(HIDDEN_JSON_STRING_PATTERN, '$1"[隐藏思考已省略]"');
  if (redacted.length <= maxCharacters) return { text: redacted, originalCharacters, truncated: false };

  const markerBudget = 96;
  const retainedCharacters = Math.max(2, maxCharacters - markerBudget);
  const headCharacters = Math.ceil(retainedCharacters * 0.625);
  const tailCharacters = retainedCharacters - headCharacters;
  const omittedCharacters = redacted.length - headCharacters - tailCharacters;
  return {
    text: `${redacted.slice(0, headCharacters)}\n\n… 已省略中间 ${omittedCharacters.toLocaleString('zh-CN')} 个字符 …\n\n${redacted.slice(-tailCharacters)}`,
    originalCharacters,
    truncated: true,
  };
}

export function redactDetailedTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactDetailedTraceText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return toDetailedTraceError(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDetailedTraceValue(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : BINARY_PAYLOAD_KEY_PATTERN.test(key)
        ? '[BINARY_DATA_REDACTED]'
        : redactDetailedTraceValue(item, seen),
  ]));
}
