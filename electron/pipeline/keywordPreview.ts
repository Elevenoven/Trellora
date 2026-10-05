import fs from 'node:fs';
import readline from 'node:readline';
import type {
  PipelineKeywordPreview,
  PipelineKeywordPreviewItem,
  PipelineKeywordPreviewOccurrence,
  PipelineKeywordPreviewRow,
} from './types';

const MAX_PREVIEW_ROWS = 30;
const MAX_PREVIEW_OFFSET = 10_000_000;

interface JsonRecord {
  [key: string]: unknown;
}

interface KeywordRecord {
  chunkId: string;
  parentChunkId: string | null;
  keywords: PipelineKeywordPreviewItem[];
  emptyReason: string | null;
}

interface ChunkRecord {
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceLocations: string[];
}

export interface KeywordPreviewReadOptions {
  documentId: string;
  keywordsPath: string;
  chunksPath: string;
  offset?: number;
  limit?: number;
}

export function normalizeKeywordPreviewWindow(offset: unknown, limit: unknown): { offset: number; limit: number } {
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  const normalizedOffset = Number.isFinite(parsedOffset) ? Math.floor(parsedOffset) : 0;
  const normalizedLimit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 20;
  return {
    offset: Math.max(0, Math.min(MAX_PREVIEW_OFFSET, normalizedOffset)),
    limit: Math.max(10, Math.min(MAX_PREVIEW_ROWS, normalizedLimit)),
  };
}

export async function readKeywordPreview(options: KeywordPreviewReadOptions): Promise<PipelineKeywordPreview> {
  const window = normalizeKeywordPreviewWindow(options.offset, options.limit);
  const selected = new Map<string, KeywordRecord>();
  const orderedChunkIds: string[] = [];
  let rowCount = 0;

  await forEachJsonLine(options.keywordsPath, (value, lineNumber) => {
    const record = parseKeywordRecord(value, options.documentId, lineNumber);
    if (rowCount >= window.offset && orderedChunkIds.length < window.limit) {
      orderedChunkIds.push(record.chunkId);
      selected.set(record.chunkId, record);
    }
    rowCount += 1;
  });

  const chunks = new Map<string, ChunkRecord>();
  if (selected.size > 0) {
    await forEachJsonLine(options.chunksPath, (value, lineNumber) => {
      const record = parseChunkRecord(value, options.documentId, lineNumber);
      if (selected.has(record.chunkId)) chunks.set(record.chunkId, record);
    });
  }

  const rows: PipelineKeywordPreviewRow[] = orderedChunkIds.map((chunkId) => {
    const keywordRecord = selected.get(chunkId);
    const chunk = chunks.get(chunkId);
    if (!keywordRecord || !chunk) {
      throw new Error('KEYWORDS_PREVIEW_SOURCE_MISSING');
    }
    return {
      chunkId: chunk.chunkId,
      parentChunkId: keywordRecord.parentChunkId,
      ordinal: chunk.ordinal,
      text: chunk.text,
      sourceLocations: chunk.sourceLocations,
      keywords: keywordRecord.keywords,
      emptyReason: keywordRecord.emptyReason,
    };
  });

  return {
    documentId: options.documentId,
    offset: window.offset,
    limit: window.limit,
    rowCount,
    hasMore: window.offset + rows.length < rowCount,
    rows,
  };
}

async function forEachJsonLine(filePath: string, callback: (value: JsonRecord, lineNumber: number) => void): Promise<void> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
      }
      if (!isRecord(value)) throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
      callback(value, lineNumber);
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function parseKeywordRecord(value: JsonRecord, documentId: string, lineNumber: number): KeywordRecord {
  if (value.documentId !== documentId || typeof value.chunkId !== 'string' || !value.chunkId.trim()) {
    throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  }
  const parentChunkId = value.parentChunkId == null ? null : readText(value.parentChunkId, lineNumber);
  if (!Array.isArray(value.keywords)) throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  return {
    chunkId: value.chunkId,
    parentChunkId,
    keywords: value.keywords.map((item, index) => parseKeywordItem(item, lineNumber, index)),
    emptyReason: value.emptyReason == null ? null : readText(value.emptyReason, lineNumber),
  };
}

function parseKeywordItem(value: unknown, lineNumber: number, index: number): PipelineKeywordPreviewItem {
  if (!isRecord(value) || typeof value.term !== 'string' || typeof value.normalizedTerm !== 'string') {
    throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}:${index}`);
  }
  const score = readFiniteNumber(value.score, lineNumber);
  const rank = readInteger(value.rank, lineNumber);
  const occurrences = Array.isArray(value.occurrences)
    ? value.occurrences.map((item) => parseOccurrence(item, lineNumber))
    : [];
  const features: Record<string, number | boolean> = {};
  if (isRecord(value.features)) {
    for (const [key, feature] of Object.entries(value.features)) {
      if (typeof feature === 'boolean') features[key] = feature;
      else if (typeof feature === 'number' && Number.isFinite(feature)) features[key] = feature;
    }
  }
  return {
    term: value.term,
    normalizedTerm: value.normalizedTerm,
    kind: typeof value.kind === 'string' ? value.kind : 'term',
    rank,
    score,
    occurrences,
    features,
    forcedTop1: value.forcedTop1 === true,
  };
}

function parseOccurrence(value: unknown, lineNumber: number): PipelineKeywordPreviewOccurrence {
  if (!isRecord(value)) throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  return {
    start: readInteger(value.start, lineNumber),
    end: readInteger(value.end, lineNumber),
    sentenceIndex: readInteger(value.sentenceIndex ?? 0, lineNumber),
  };
}

function parseChunkRecord(value: JsonRecord, documentId: string, lineNumber: number): ChunkRecord {
  if (value.documentId !== documentId || typeof value.chunkId !== 'string' || typeof value.text !== 'string') {
    throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  }
  return {
    chunkId: value.chunkId,
    parentChunkId: value.parentChunkId == null ? null : readText(value.parentChunkId, lineNumber),
    ordinal: readInteger(value.ordinal, lineNumber),
    text: value.text,
    sourceLocations: summarizeSourceLocations(value.sourceRefs),
  };
}

function summarizeSourceLocations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const locations = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const page = firstFiniteNumber(item.page, item.pageNumber);
    const line = firstFiniteNumber(item.lineNo, item.line, item.firstLineNo);
    if (page !== null) locations.add(`第${page}页`);
    if (line !== null) locations.add(`第${line}行`);
  }
  return [...locations].slice(0, 4);
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  }
  return null;
}

function readFiniteNumber(value: unknown, lineNumber: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  return value;
}

function readInteger(value: unknown, lineNumber: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  return value;
}

function readText(value: unknown, lineNumber: number): string {
  if (typeof value !== 'string') throw new Error(`KEYWORDS_PREVIEW_INVALID:${lineNumber}`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
