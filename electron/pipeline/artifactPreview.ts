import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type { PipelineArtifactPreview, PipelineArtifactPreviewRow, PipelineStageId } from './types';

const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_OFFSET = 10_000_000;

export interface ArtifactPreviewReadOptions {
  documentId: string;
  stage: PipelineStageId;
  fileName: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  offset?: number;
  limit?: number;
  parentChunkId?: string;
}

export function normalizeArtifactPreviewWindow(offset: unknown, limit: unknown): { offset: number; limit: number } {
  const normalizedOffset = Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0;
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 40;
  return {
    offset: Math.max(0, Math.min(MAX_PREVIEW_OFFSET, normalizedOffset)),
    limit: Math.max(10, Math.min(MAX_PREVIEW_ROWS, normalizedLimit)),
  };
}

export function normalizeArtifactPreviewParentChunkId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^p-\d{6}$/.test(value)) {
    throw new Error('父块标识无效。');
  }
  return value;
}

/**
 * A manifest is the authority for previewable artifacts. Checking the hash
 * immediately before streaming prevents a same-size replacement from being
 * presented as a valid Parent/Child artifact.
 */
export async function assertArtifactPreviewIntegrity(filePath: string, expected: Pick<ArtifactPreviewReadOptions, 'bytes' | 'sha256'>): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('阶段产物文件不存在，可能需要重新处理该阶段。');
  }
  if (!stat.isFile()) throw new Error('阶段产物不是可预览的普通文件。');
  if (stat.size !== expected.bytes) throw new Error('阶段产物大小已变化，缓存校验未通过，请重新处理该阶段。');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error('阶段产物哈希已变化，缓存校验未通过，请重新处理该阶段。');
  }
}

export async function readArtifactPreview(filePath: string, options: ArtifactPreviewReadOptions): Promise<PipelineArtifactPreview> {
  await assertArtifactPreviewIntegrity(filePath, options);
  const window = normalizeArtifactPreviewWindow(options.offset, options.limit);
  const rows: PipelineArtifactPreviewRow[] = [];
  let sourceLineNumber = 0;
  let lineCount = 0;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      sourceLineNumber += 1;
      if (options.parentChunkId && !belongsToParentChunk(line, options.parentChunkId)) continue;
      lineCount += 1;
      if (lineCount > window.offset && rows.length < window.limit) {
        rows.push({ lineNumber: sourceLineNumber, text: line });
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return {
    documentId: options.documentId,
    stage: options.stage,
    fileName: options.fileName,
    relativePath: options.relativePath,
    bytes: options.bytes,
    sha256: options.sha256,
    offset: window.offset,
    limit: window.limit,
    lineCount,
    hasMore: window.offset + rows.length < lineCount,
    rows,
  };
}

function belongsToParentChunk(line: string, parentChunkId: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && (value as Record<string, unknown>).parentChunkId === parentChunkId;
  } catch {
    return false;
  }
}
