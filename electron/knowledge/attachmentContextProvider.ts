import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantAttachment, AssistantImageMimeType } from './assistantTurnTypes';
import type { AssistantParsedDocumentImage } from './assistantDocumentAttachmentParser';
import {
  assistantDocumentExtensions,
  assistantTextExtensions,
  maxAssistantAttachmentBytes,
  maxAssistantAttachmentTotalBytes,
  maxAssistantDocumentBytes,
} from './assistantTurnTypes';

const MAX_RANGE_LINES = 80;
const MAX_RANGE_CHARS = 4_000;
const MAX_SEARCH_RESULTS = 6;

/**
 * 主进程内部的附件记录（多模态开发方案 §6.3）。
 * - image：仅登记 dataUrl，不落盘、不分行、不可搜索；Transport 层通过 listImageAttachments 取用。
 * - document：由文档解析器提供本轮纯文本，按行参与 search / readRange。
 * - text：直接读文件、按行切分，走现有 search / readRange 逻辑。
 */
interface AttachmentRecord {
  kind: 'image' | 'document' | 'text';
  attachmentId: string;
  /** 图片附件为 `image://<attachmentId>` 伪路径；文档/文本为真实解析后的绝对路径。 */
  path: string;
  name: string;
  /** 图片附件为空字符串（无扩展名语义）。 */
  extension: string;
  mimeType: string;
  sizeBytes: number;
  /** 图片/文档占位附件为空字符串（不参与内容哈希）。 */
  sha256: string;
  /** 图片/文档占位附件为空数组（不可搜索）。 */
  lines: string[];
  /** 仅图片附件存在，Transport 层通过 listImageAttachments 读取。 */
  dataUrl?: string;
  /** 仅 document 存在；图片文件仍由 ParseSession 负责生命周期。 */
  documentImages?: readonly AssistantParsedDocumentImage[];
}

export interface AssistantImageAttachmentMetadata {
  kind: 'image';
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  searchable: false;
}

export interface AssistantSearchableAttachmentMetadata {
  kind: 'document' | 'text';
  attachmentId: string;
  name: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  lineCount: number;
  /** 文档解析成功或文本附件读取成功时为 true。 */
  searchable: boolean;
  availableRange: { lineFrom: 1; lineTo: number };
}

export type AssistantAttachmentMetadata =
  | AssistantImageAttachmentMetadata
  | AssistantSearchableAttachmentMetadata;

export interface AssistantAttachmentSearchHit {
  attachmentId: string;
  lineFrom: number;
  lineTo: number;
  score: number;
  reason: 'query-match' | 'explicit-leading-range';
}

export interface AssistantAttachmentRangeRead {
  attachmentId: string;
  name: string;
  lineFrom: number;
  lineTo: number;
  sha256: string;
  text: string;
  truncated: boolean;
  imageIds: string[];
}

/** 图片附件在 Transport 层的传输视图（多模态开发方案 §6.4）。 */
export interface AssistantImageAttachmentPayload {
  attachmentId: string;
  name: string;
  mimeType: AssistantImageMimeType;
  sizeBytes: number;
  dataUrl: string;
}

/** Main-process-only, bounded attachment search and range reader. */
export class AttachmentContextProvider {
  private readonly records: AttachmentRecord[];

  constructor(attachments: readonly AssistantAttachment[], options: {
    documentTextByAttachmentId?: ReadonlyMap<string, string>;
    documentImagesByAttachmentId?: ReadonlyMap<string, readonly AssistantParsedDocumentImage[]>;
  } = {}) {
    let textTotalBytes = 0;
    this.records = attachments.map((attachment) => {
      if (attachment.kind === 'image') {
        return {
          kind: 'image' as const,
          attachmentId: attachment.attachmentId,
          path: `image://${attachment.attachmentId}`,
          name: attachment.name,
          extension: '',
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: '',
          lines: [],
          dataUrl: attachment.dataUrl,
        };
      }
      const attachmentPath = path.resolve(attachment.path);
      const extension = path.extname(attachmentPath).toLowerCase();
      const isDocument = attachment.kind === 'document';
      const allowedExtensions = isDocument ? assistantDocumentExtensions : assistantTextExtensions;
      if (!allowedExtensions.has(extension)) throw new Error(`不支持作为 AI 上下文的附件类型：${extension || '未知类型'}。`);
      const stat = fs.statSync(attachmentPath);
      if (!stat.isFile()) throw new Error(`AI 附件不是文件：${attachment.name}。`);
      const perFileLimit = isDocument ? maxAssistantDocumentBytes : maxAssistantAttachmentBytes;
      if (stat.size > perFileLimit) throw new Error(`AI 附件“${attachment.name}”不能超过 ${Math.floor(perFileLimit / 1_000_000)} MB。`);
      if (isDocument) {
        const content = options.documentTextByAttachmentId?.get(attachment.attachmentId)?.replace(/\r\n?/gu, '\n').trim() ?? '';
        return {
          kind: 'document' as const,
          attachmentId: attachment.attachmentId,
          path: attachmentPath,
          name: path.basename(attachmentPath),
          extension,
          mimeType: attachment.mimeType,
          sizeBytes: stat.size,
          sha256: content ? hash(content) : '',
          lines: content ? content.split('\n') : [],
          documentImages: options.documentImagesByAttachmentId?.get(attachment.attachmentId) ?? [],
        };
      }
      textTotalBytes += stat.size;
      if (textTotalBytes > maxAssistantAttachmentTotalBytes) throw new Error('AI 文本附件总大小不能超过 5 MB。');
      const content = fs.readFileSync(attachmentPath, 'utf8').replace(/\r\n?/gu, '\n');
      const sha256 = hash(content);
      return {
        kind: 'text' as const,
        attachmentId: attachment.attachmentId,
        path: attachmentPath,
        name: path.basename(attachmentPath),
        extension,
        mimeType: resolveMimeType(extension),
        sizeBytes: stat.size,
        sha256,
        lines: content.split('\n'),
      };
    });
  }

  listMetadata(): AssistantAttachmentMetadata[] {
    return this.records.map((record) => {
      if (record.kind === 'image') {
        return {
          kind: 'image',
          attachmentId: record.attachmentId,
          name: record.name,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          searchable: false,
        };
      }
      return {
        kind: record.kind,
        attachmentId: record.attachmentId,
        name: record.name,
        extension: record.extension,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        lineCount: record.lines.length,
        searchable: record.lines.length > 0,
        availableRange: { lineFrom: 1, lineTo: Math.max(record.lines.length, 1) },
      };
    });
  }

  /** 供 Transport 层取用（多模态开发方案 §6.4）：返回本轮所有图片附件的 dataUrl 与元信息。 */
  listImageAttachments(): AssistantImageAttachmentPayload[] {
    return this.records
      .filter((record): record is AttachmentRecord & { kind: 'image'; dataUrl: string } => record.kind === 'image' && typeof record.dataUrl === 'string')
      .map((record) => ({
        attachmentId: record.attachmentId,
        name: record.name,
        mimeType: record.mimeType as AssistantImageMimeType,
        sizeBytes: record.sizeBytes,
        dataUrl: record.dataUrl,
      }));
  }

  /** 按 attachmentId 取单张图片的 dataUrl（Transport 层可选用）。 */
  readImageDataUrl(attachmentId: string): string | undefined {
    const record = this.records.find((candidate) => candidate.attachmentId === attachmentId && candidate.kind === 'image');
    return record?.dataUrl;
  }

  search(query: string, maximumResults = MAX_SEARCH_RESULTS): AssistantAttachmentSearchHit[] {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 20) throw new Error('附件搜索结果上限无效。');
    const terms = extractQueryTerms(query);
    const searchableRecords = this.records.filter((record) => record.lines.length > 0);
    const hits: AssistantAttachmentSearchHit[] = [];
    for (const record of searchableRecords) {
      const scoredLines = record.lines
        .map((line, index) => ({ index, score: scoreLine(line, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
      const selected: Array<{ from: number; to: number }> = [];
      for (const entry of scoredLines) {
        const from = Math.max(1, entry.index + 1 - 12);
        const to = Math.min(record.lines.length, entry.index + 1 + 20);
        if (selected.some((range) => from <= range.to && to >= range.from)) continue;
        selected.push({ from, to });
        hits.push({ attachmentId: record.attachmentId, lineFrom: from, lineTo: to, score: entry.score, reason: 'query-match' });
        if (selected.length >= 2) break;
      }
    }
    const ranked = hits.sort((left, right) => right.score - left.score || left.attachmentId.localeCompare(right.attachmentId));
    if (ranked.length) return ranked.slice(0, maximumResults);
    if (!isExplicitAttachmentReadRequest(query)) return [];
    return searchableRecords.slice(0, maximumResults).map((record) => ({
      attachmentId: record.attachmentId,
      lineFrom: 1,
      lineTo: Math.min(record.lines.length, MAX_RANGE_LINES),
      score: 1,
      reason: 'explicit-leading-range' as const,
    }));
  }

  readRange(input: { attachmentId: string; lineFrom: number; lineTo: number }): AssistantAttachmentRangeRead {
    const record = this.records.find((candidate) => candidate.attachmentId === input.attachmentId);
    if (!record) throw new Error('附件范围读取标识无效。');
    if (record.kind === 'image') throw new Error('图片附件不支持范围读取。');
    if (!record.lines.length) throw new Error('该附件当前不可搜索（尚未解析）。');
    if (!Number.isSafeInteger(input.lineFrom) || !Number.isSafeInteger(input.lineTo)
      || input.lineFrom < 1 || input.lineTo < input.lineFrom || input.lineTo > record.lines.length) {
      throw new Error('附件范围读取行号无效。');
    }
    const boundedTo = Math.min(input.lineTo, input.lineFrom + MAX_RANGE_LINES - 1);
    const raw = record.lines.slice(input.lineFrom - 1, boundedTo).join('\n');
    const text = raw.slice(0, MAX_RANGE_CHARS);
    const imageIds = (record.documentImages ?? [])
      .filter((image) => image.lineNumbers.some((lineNumber) => lineNumber >= input.lineFrom && lineNumber <= boundedTo)
        && text.includes(image.placeholder))
      .map((image) => image.imageId);
    return {
      attachmentId: record.attachmentId,
      name: record.name,
      lineFrom: input.lineFrom,
      lineTo: boundedTo,
      sha256: record.sha256,
      text,
      truncated: boundedTo < input.lineTo || text.length < raw.length,
      imageIds,
    };
  }

  /**
   * 选择和本轮命中范围直接相交或邻近的文档图片；若用户明确要求看图但范围中没有
   * 图片，则按文档顺序补首图。仅返回元数据，文件读取仍由解析器在 dispose 前完成。
   */
  selectDocumentImages(
    reads: readonly AssistantAttachmentRangeRead[],
    query: string,
    maximumResults = 4,
  ): AssistantParsedDocumentImage[] {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 0 || maximumResults > 20) throw new Error('文档图片结果上限无效。');
    if (maximumResults === 0) return [];
    const readsByAttachment = new Map<string, AssistantAttachmentRangeRead[]>();
    for (const read of reads) {
      const values = readsByAttachment.get(read.attachmentId) ?? [];
      values.push(read);
      readsByAttachment.set(read.attachmentId, values);
    }
    const visualRequest = isExplicitDocumentVisualRequest(query);
    const proximityCandidates = this.records.flatMap((record) => {
      if (record.kind !== 'document' || !record.documentImages?.length) return [];
      const ranges = readsByAttachment.get(record.attachmentId) ?? [];
      return record.documentImages.flatMap((image) => {
        let score = 0;
        for (const range of ranges) {
          if (range.imageIds.includes(image.imageId)) score = Math.max(score, 10_000);
          const distance = Math.min(...image.lineNumbers.map((lineNumber) => lineDistance(lineNumber, range.lineFrom, range.lineTo)));
          if (distance <= 12) score = Math.max(score, 1_000 - distance);
        }
        return score > 0 ? [{ image, score, firstLine: image.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER }] : [];
      });
    });
    // 明确看图时，即使已读取的文本范围没有覆盖图片占位符，也应按文档顺序补图。
    // 这既覆盖“图片在文档后半段”，也覆盖自然问法没有产生文本关键词命中的情况。
    const candidates = proximityCandidates.length || !visualRequest
      ? proximityCandidates
      : this.records.flatMap((record) => record.kind === 'document'
        ? (record.documentImages ?? []).map((image) => ({
          image,
          score: 10,
          firstLine: image.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER,
        }))
        : []);
    const seenHashes = new Set<string>();
    const output: AssistantParsedDocumentImage[] = [];
    for (const candidate of candidates.sort((left, right) => right.score - left.score
      || left.firstLine - right.firstLine
      || left.image.imageId.localeCompare(right.image.imageId))) {
      if (seenHashes.has(candidate.image.sha256)) continue;
      seenHashes.add(candidate.image.sha256);
      output.push(candidate.image);
      if (output.length >= maximumResults) break;
    }
    return output;
  }

  resolveLocalPath(attachmentId: string): string {
    const record = this.records.find((candidate) => candidate.attachmentId === attachmentId);
    if (!record) throw new Error('附件标识无效。');
    return record.path;
  }
}

export function renderAttachmentMetadata(metadata: AssistantAttachmentMetadata): string {
  if (metadata.kind === 'image') {
    return [
    '[附件元数据 · 图片]',
      `attachmentId=${metadata.attachmentId}`,
      `name=${metadata.name}`,
      `type=${metadata.mimeType}`,
      `bytes=${metadata.sizeBytes}`,
      'searchable=false',
      'delivery=multimodal-image',
    ].join('\n');
  }
  const lines = [
    '[附件元数据 · 正文未展开]',
    `attachmentId=${metadata.attachmentId}`,
    `name=${metadata.name}`,
    `type=${metadata.mimeType}`,
    `bytes=${metadata.sizeBytes}`,
    `searchable=${metadata.searchable}`,
  ];
  if (metadata.sha256) lines.push(`sha256=${metadata.sha256}`);
  if (metadata.searchable) lines.push(`availableRange=L${metadata.availableRange.lineFrom}-L${metadata.availableRange.lineTo}`);
  else lines.push('note=该附件类型在当前版本尚未接入解析流水线，正文暂不可用。');
  return lines.join('\n');
}

export function renderAttachmentRange(read: AssistantAttachmentRangeRead): string {
  const lines = [
    '[附件范围读取]',
    `attachmentId=${read.attachmentId}`,
    `range=L${read.lineFrom}-L${read.lineTo}`,
    `sha256=${read.sha256}`,
    read.text,
  ];
  if (read.imageIds.length) lines.splice(4, 0, `documentImageIds=${read.imageIds.join(',')}`);
  return lines.join('\n');
}

/** 将 VLM 图片顺序与正文中的稳定占位符绑定，避免模型把图和章节错配。 */
export function renderDocumentImageTransportIndex(
  images: readonly AssistantParsedDocumentImage[],
  explicitImageCount = 0,
): string {
  return [
    '[文档图片视觉输入索引]',
    ...images.map((image, index) => `视觉输入第 ${explicitImageCount + index + 1} 张=${image.placeholder}；来源附件=${image.attachmentId}`),
    '请把视觉输入与正文中的同名占位符结合理解；解析器生成的图注与周边文本只作为辅助，图片内容以视觉输入为准。',
  ].join('\n');
}

function extractQueryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase('zh-Hans-CN').replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
  const output = new Set<string>();
  for (const segment of normalized.split(/\s+/u).filter(Boolean)) {
    if (segment.length <= 16) output.add(segment);
    if (/\p{Script=Han}/u.test(segment) && segment.length > 4) {
      for (let index = 0; index < segment.length - 1; index += 1) output.add(segment.slice(index, index + 2));
    }
  }
  return [...output].filter((term) => term.length >= 2).slice(0, 48);
}

function scoreLine(line: string, terms: readonly string[]): number {
  const normalized = line.toLocaleLowerCase('zh-Hans-CN');
  return terms.reduce((score, term) => score + (normalized.includes(term) ? Math.min(8, term.length) : 0), 0);
}

function isExplicitAttachmentReadRequest(query: string): boolean {
  return /(附件|文件|文档|PDF|DOCX|Word|图|图片|图表|流程图|示意图|截图|插图|照片)/iu.test(query)
    && hasInspectionIntent(query);
}

function isExplicitDocumentVisualRequest(query: string): boolean {
  return /(图|图片|图表|流程图|示意图|截图|插图|照片|视觉|PDF)/iu.test(query)
    && hasInspectionIntent(query);
}

function hasInspectionIntent(query: string): boolean {
  return /(总结|概括|阅读|读取|分析|内容|说明|看|识别|解释|描述|提取|判断|理解|含义|意思|作用|用途|主题|是什么|是啥|什么|啥|有何|有哪些|有什么|有啥|哪(?:个|些|张|幅)|如何|怎么|怎样|为何|为什么|吗|呢|[?？])/iu.test(query);
}

function lineDistance(lineNumber: number, from: number, to: number): number {
  if (lineNumber < from) return from - lineNumber;
  if (lineNumber > to) return lineNumber - to;
  return 0;
}

function resolveMimeType(extension: string): string {
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.csv') return 'text/csv';
  if (extension === '.json') return 'application/json';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.html' || extension === '.htm') return 'text/html';
  return 'text/plain';
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
