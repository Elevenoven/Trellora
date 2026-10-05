import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_ARTIFACT_DIRECTORY_NAME = 'context-artifacts';
export const CONTEXT_ARTIFACT_MEMORY_DIRECTORY_NAME = 'ConversationMemory';
export const DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES = 1_048_576;
export const DEFAULT_CONTEXT_ARTIFACT_MAX_TURN_BYTES = 8_388_608;

export interface ContextArtifactRecord {
  schemaVersion: typeof CONTEXT_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  sessionId: string;
  turnId: string;
  sourceTool: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
  content: string;
}

export interface WriteContextArtifactInput {
  sessionId: string;
  turnId: string;
  materialId: string;
  sourceTool: string;
  content: string;
  mimeType?: string;
}

export interface ReadContextArtifactInput {
  sessionId: string;
  turnId: string;
  artifactId: string;
}

export interface ContextArtifactStoreOptions {
  maxArtifactBytes?: number;
  maxTurnBytes?: number;
  now?: () => Date;
}

/**
 * Stores redacted tool observations outside prompts. Directory components are
 * hashes, never caller-controlled identifiers, and every read revalidates the
 * stored byte count and digest before returning content.
 */
export class ContextArtifactStore {
  private readonly rootDirectory: string;
  private readonly maxArtifactBytes: number;
  private readonly maxTurnBytes: number;
  private readonly now: () => Date;

  constructor(workspacePath: string, options: ContextArtifactStoreOptions = {}) {
    this.rootDirectory = path.resolve(
      workspacePath,
      CONTEXT_ARTIFACT_MEMORY_DIRECTORY_NAME,
      CONTEXT_ARTIFACT_DIRECTORY_NAME,
    );
    this.maxArtifactBytes = normalizePositiveInteger(
      options.maxArtifactBytes ?? DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES,
      '单个上下文 Artifact 大小上限',
    );
    this.maxTurnBytes = normalizePositiveInteger(
      options.maxTurnBytes ?? DEFAULT_CONTEXT_ARTIFACT_MAX_TURN_BYTES,
      '单轮上下文 Artifact 大小上限',
    );
    this.now = options.now ?? (() => new Date());
  }

  write(input: WriteContextArtifactInput): ContextArtifactRecord {
    assertArtifactIdentity(input.sessionId, 'sessionId');
    assertArtifactIdentity(input.turnId, 'turnId');
    assertArtifactIdentity(input.materialId, 'materialId');
    if (!input.sourceTool.trim()) throw new Error('上下文 Artifact 缺少来源 Tool。');

    const content = redactToolObservation(input.content);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > this.maxArtifactBytes) {
      throw new Error(`Tool Observation 超过单个 Artifact 上限（${this.maxArtifactBytes} bytes）。`);
    }
    const sha256 = sha256Text(content);
    const artifactId = `context-artifact-${sha256Text(JSON.stringify({
      sessionId: input.sessionId,
      turnId: input.turnId,
      materialId: input.materialId,
      sourceTool: input.sourceTool,
      sha256,
    }))}`;
    const filePath = this.resolveArtifactPath(input.sessionId, input.turnId, artifactId);
    if (fs.existsSync(filePath)) return this.read({ ...input, artifactId });

    const turnDirectory = path.dirname(filePath);
    fs.mkdirSync(turnDirectory, { recursive: true });
    const usedBytes = this.calculateTurnBytes(turnDirectory);
    if (usedBytes + byteLength > this.maxTurnBytes) {
      throw new Error(`本轮 Tool Observation Artifact 总量超过上限（${this.maxTurnBytes} bytes）。`);
    }

    const record: ContextArtifactRecord = {
      schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
      artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceTool: input.sourceTool.trim(),
      mimeType: input.mimeType?.trim() || 'text/plain; charset=utf-8',
      sha256,
      byteLength,
      createdAt: this.now().toISOString(),
      content,
    };
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
      validateArtifactRecord(JSON.parse(fs.readFileSync(temporaryPath, 'utf8')) as unknown, record);
      fs.renameSync(temporaryPath, filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return record;
  }

  read(input: ReadContextArtifactInput): ContextArtifactRecord {
    assertArtifactIdentity(input.sessionId, 'sessionId');
    assertArtifactIdentity(input.turnId, 'turnId');
    if (!/^context-artifact-[a-f0-9]{64}$/u.test(input.artifactId)) throw new Error('上下文 Artifact 标识无效。');
    const filePath = this.resolveArtifactPath(input.sessionId, input.turnId, input.artifactId);
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const expected = {
      artifactId: input.artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    };
    return validateArtifactRecord(value, expected);
  }

  deleteSession(sessionId: string): void {
    assertArtifactIdentity(sessionId, 'sessionId');
    const sessionDirectory = this.resolveInsideRoot(hashPathComponent(sessionId));
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
  }

  private resolveArtifactPath(sessionId: string, turnId: string, artifactId: string): string {
    return this.resolveInsideRoot(
      hashPathComponent(sessionId),
      hashPathComponent(turnId),
      `${artifactId}.json`,
    );
  }

  private resolveInsideRoot(...segments: string[]): string {
    const resolved = path.resolve(this.rootDirectory, ...segments);
    const relative = path.relative(this.rootDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('上下文 Artifact 路径越界。');
    return resolved;
  }

  private calculateTurnBytes(turnDirectory: string): number {
    if (!fs.existsSync(turnDirectory)) return 0;
    return fs.readdirSync(turnDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .reduce((total, entry) => total + fs.statSync(path.join(turnDirectory, entry.name)).size, 0);
  }
}

export function redactToolObservation(value: string): string {
  return value
    .replace(/(^|\n)(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, '$1$2: [REDACTED]')
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\r\n]+)/giu, '$1[REDACTED]');
}

function validateArtifactRecord(
  value: unknown,
  expected: Pick<ContextArtifactRecord, 'artifactId' | 'sessionId' | 'turnId'>,
): ContextArtifactRecord {
  if (!value || typeof value !== 'object') throw new Error('上下文 Artifact 内容无效。');
  const record = value as Partial<ContextArtifactRecord>;
  if (record.schemaVersion !== CONTEXT_ARTIFACT_SCHEMA_VERSION
    || record.artifactId !== expected.artifactId
    || record.sessionId !== expected.sessionId
    || record.turnId !== expected.turnId
    || typeof record.sourceTool !== 'string'
    || typeof record.mimeType !== 'string'
    || typeof record.sha256 !== 'string'
    || typeof record.byteLength !== 'number'
    || typeof record.createdAt !== 'string'
    || typeof record.content !== 'string') {
    throw new Error('上下文 Artifact 元数据校验失败。');
  }
  const actualBytes = Buffer.byteLength(record.content, 'utf8');
  const actualHash = sha256Text(record.content);
  if (actualBytes !== record.byteLength || actualHash !== record.sha256) {
    throw new Error('上下文 Artifact 完整性校验失败。');
  }
  return record as ContextArtifactRecord;
}

function assertArtifactIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 240) throw new Error(`上下文 Artifact ${label} 无效。`);
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}

function hashPathComponent(value: string): string {
  return sha256Text(value);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
