import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMammothDocxParse } from '../pipeline/mammothStage';
import { runMineruPdfParse, type MineruParseOptions } from '../pipeline/mineruClient';
import { readParseImagesManifest, type ParseImageRecord } from '../pipeline/parseImages';
import type { MineruRuntimeConfig } from '../pipeline/types';
import type { AiTransportImage } from './aiGenerationTransport';
import type { AssistantAttachment, AssistantDocumentAttachment, AssistantImageMimeType } from './assistantTurnTypes';
import {
  assistantDocumentExtensions,
  maxAssistantDocumentBytes,
  maxAssistantImageBytes,
  maxAssistantImageTotalBytes,
} from './assistantTurnTypes';

const MAX_DOCUMENT_TEXT_CHARS = 500_000;
const MAX_PDF_PAGES = 500;
const TEMP_DIRECTORY_PREFIX = 'trellora-assistant-doc-';
export const maxAssistantDerivedDocumentImages = 4;

export interface AssistantParsedDocumentImage {
  imageId: string;
  attachmentId: string;
  placeholder: string;
  name: string;
  mimeType: AssistantImageMimeType;
  sizeBytes: number;
  sha256: string;
  absolutePath: string;
  lineNumbers: number[];
}

export interface AssistantMaterializedDocumentImage {
  source: AssistantParsedDocumentImage;
  transport: AiTransportImage;
}

export interface AssistantDocumentParseSession {
  documentTextByAttachmentId: ReadonlyMap<string, string>;
  documentImagesByAttachmentId: ReadonlyMap<string, readonly AssistantParsedDocumentImage[]>;
  dispose(): void;
}

export interface AssistantDocumentParseOptions {
  signal: AbortSignal;
  mammothWorkerScriptPath?: string;
  /** 仅主进程注入的 MinerU 运行时配置；明文密钥不得进入 IPC、日志或附件元数据。 */
  mineru?: MineruRuntimeConfig;
  /** 验证脚本可替换远端调用；生产缺省使用主进程 MinerU 客户端。 */
  mineruRunner?: (options: MineruParseOptions) => Promise<{ counts: Record<string, number> }>;
  /** 验证脚本可注入受控目录；生产缺省使用系统临时目录。 */
  tempRoot?: string;
  onProgress?: (message: string) => void;
}

interface ParsedDocumentOutcome {
  text: string;
  images: AssistantParsedDocumentImage[];
  ownedTempDirectory?: { directory: string; tempRoot: string };
}

/**
 * 将本轮 PDF / DOCX 附件解析为有界上下文。MinerU / Mammoth 提取的图片只在本轮
 * ParseSession 生命周期内保留，调用方须在读取所需图片后于 finally 中 dispose。
 */
export async function parseAssistantDocumentAttachments(
  attachments: readonly AssistantAttachment[],
  options: AssistantDocumentParseOptions,
): Promise<AssistantDocumentParseSession> {
  const documents = attachments.filter((attachment): attachment is AssistantDocumentAttachment => attachment.kind === 'document');
  const documentTextByAttachmentId = new Map<string, string>();
  const documentImagesByAttachmentId = new Map<string, readonly AssistantParsedDocumentImage[]>();
  const ownedTempDirectories: Array<{ directory: string; tempRoot: string }> = [];
  let disposed = false;

  try {
    for (const [index, attachment] of documents.entries()) {
      throwIfAborted(options.signal);
      validateDocumentAttachment(attachment);
      options.onProgress?.(`正在解析文档附件 ${index + 1}/${documents.length}：${attachment.name}`);
      const extension = path.extname(attachment.path).toLowerCase();
      const outcome = extension === '.pdf'
        ? await parsePdfAttachment(attachment, options)
        : await parseDocxAttachment(attachment, options);
      if (outcome.ownedTempDirectory) ownedTempDirectories.push(outcome.ownedTempDirectory);
      if (!outcome.text.trim()) {
        if (extension === '.pdf') throw new Error(`PDF“${attachment.name}”没有可读取的正文。`);
        throw new Error(`DOCX“${attachment.name}”没有可读取的正文。`);
      }
      documentTextByAttachmentId.set(attachment.attachmentId, outcome.text);
      documentImagesByAttachmentId.set(attachment.attachmentId, outcome.images);
    }
  } catch (error) {
    for (const owned of ownedTempDirectories) removeOwnedTempDirectory(owned.directory, owned.tempRoot);
    throw error;
  }

  return {
    documentTextByAttachmentId,
    documentImagesByAttachmentId,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owned of ownedTempDirectories) removeOwnedTempDirectory(owned.directory, owned.tempRoot);
    },
  };
}

/**
 * 把已选中的文档图片转成 VLM data URL。显式上传图片应先占用总预算，
 * 调用方通过 maxTotalBytes 传入剩余预算；越界、被替换或哈希不匹配的文件会跳过。
 */
export function materializeAssistantDocumentImages(
  images: readonly AssistantParsedDocumentImage[],
  options: { maxImages?: number; maxTotalBytes?: number; excludedSha256?: ReadonlySet<string> } = {},
): AssistantMaterializedDocumentImage[] {
  const maxImages = Math.max(0, Math.min(maxAssistantDerivedDocumentImages, options.maxImages ?? maxAssistantDerivedDocumentImages));
  const maxTotalBytes = Math.max(0, Math.min(maxAssistantImageTotalBytes, options.maxTotalBytes ?? maxAssistantImageTotalBytes));
  const output: AssistantMaterializedDocumentImage[] = [];
  const seenHashes = new Set(options.excludedSha256 ?? []);
  let totalBytes = 0;

  for (const image of images) {
    if (output.length >= maxImages) break;
    if (seenHashes.has(image.sha256) || image.sizeBytes <= 0 || image.sizeBytes > maxAssistantImageBytes) continue;
    if (totalBytes + image.sizeBytes > maxTotalBytes) continue;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(image.absolutePath);
    } catch {
      continue;
    }
    if (buffer.length !== image.sizeBytes || buffer.length > maxAssistantImageBytes) continue;
    if (createHash('sha256').update(buffer).digest('hex') !== image.sha256) continue;
    output.push({
      source: image,
      transport: {
        dataUrl: `data:${image.mimeType};base64,${buffer.toString('base64')}`,
        mimeType: image.mimeType,
        name: `${image.name} ${image.placeholder}`,
      },
    });
    seenHashes.add(image.sha256);
    totalBytes += buffer.length;
  }
  return output;
}

/** 计算显式上传图片的内容哈希，用于保证它们优先并与 PDF 派生图去重。 */
export function collectAiTransportImageHashes(images: readonly AiTransportImage[]): Set<string> {
  const hashes = new Set<string>();
  for (const image of images) {
    const match = /^data:[^;,]+;base64,(.+)$/su.exec(image.dataUrl);
    if (!match) continue;
    try {
      hashes.add(createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest('hex'));
    } catch {
      // 上游附件校验负责报告非法 dataUrl；这里只做尽力去重。
    }
  }
  return hashes;
}

async function parsePdfAttachment(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
): Promise<ParsedDocumentOutcome> {
  const mineru = options.mineru;
  if (mineru?.cloudParsingConsent && mineru.apiKey?.trim()) {
    options.onProgress?.(`正在使用 MinerU 解析 PDF“${attachment.name}”的正文与图片…`);
    return parsePdfWithMineru(attachment, options, mineru);
  }

  try {
    const localText = await parsePdfText(attachment.path, options.signal);
    if (localText.trim()) return { text: boundDocumentText(localText), images: [] };
  } catch (error) {
    throwIfAborted(options.signal);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF“${attachment.name}”本地文本提取失败：${detail}。可在“设置 > 文档解析”中配置并授权 MinerU 后重试。`);
  }
  throw new Error(`PDF“${attachment.name}”没有可读取的文本；扫描版或需要识别图表的 PDF 请在“设置 > 文档解析”中配置并授权 MinerU。`);
}

async function parsePdfText(filePath: string, signal: AbortSignal): Promise<string> {
  ensurePdfJsTextExtractionGlobals();
  const { getDocument, PDFWorker } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const worker = new PDFWorker();
  const loadingTask = getDocument({ data: bytes, worker, useWorkerFetch: false, useSystemFonts: true });
  const abort = () => loadingTask.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF 页数不能超过 ${MAX_PDF_PAGES} 页。`);
    const pages: string[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages && totalChars < MAX_DOCUMENT_TEXT_CHARS; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const value = item.str.trim();
        if (value) pageText += `${pageText && !pageText.endsWith('\n') ? ' ' : ''}${value}`;
        if (item.hasEOL && pageText && !pageText.endsWith('\n')) pageText += '\n';
      }
      const normalized = normalizeText(pageText);
      if (normalized) {
        const section = `# 第 ${pageNumber} 页\n${normalized}`;
        pages.push(section);
        totalChars += section.length + 2;
      }
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    signal.removeEventListener('abort', abort);
    await loadingTask.destroy().catch(() => undefined);
    worker.destroy();
  }
}

/** PDF.js legacy display 包初始化需要 DOMMatrix / Path2D；文本提取路径不会调用绘制方法。 */
function ensurePdfJsTextExtractionGlobals(): void {
  const globals = globalThis as unknown as { DOMMatrix?: unknown; Path2D?: unknown };
  if (typeof globals.DOMMatrix === 'undefined') globals.DOMMatrix = class AssistantPdfDomMatrix {};
  if (typeof globals.Path2D === 'undefined') globals.Path2D = class AssistantPdfPath2D {};
}

async function parseDocxAttachment(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
): Promise<ParsedDocumentOutcome> {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, TEMP_DIRECTORY_PREFIX));
  let keepTempDirectory = false;
  try {
    await runMammothDocxParse({
      inputPath: attachment.path,
      outputDir: tempDirectory,
      sourceName: attachment.name,
      signal: options.signal,
      ...(options.mammothWorkerScriptPath ? { workerScriptPath: options.mammothWorkerScriptPath } : {}),
    });
    throwIfAborted(options.signal);
    const markdown = normalizeText(fs.readFileSync(path.join(tempDirectory, 'document.md'), 'utf8'));
    const { text, images } = rewriteParsedDocumentImages(markdown, attachment, tempDirectory, 'DOCX');
    keepTempDirectory = images.length > 0;
    return {
      text,
      images,
      ...(keepTempDirectory ? { ownedTempDirectory: { directory: tempDirectory, tempRoot } } : {}),
    };
  } finally {
    if (!keepTempDirectory) removeOwnedTempDirectory(tempDirectory, tempRoot);
  }
}

async function parsePdfWithMineru(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
  mineru: MineruRuntimeConfig,
): Promise<ParsedDocumentOutcome> {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, TEMP_DIRECTORY_PREFIX));
  let keepTempDirectory = false;
  try {
    const runner = options.mineruRunner ?? runMineruPdfParse;
    await runner({
      inputPath: attachment.path,
      outputDir: tempDirectory,
      documentId: attachment.attachmentId,
      endpoint: mineru.endpoint,
      apiKey: mineru.apiKey ?? '',
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress.message),
    });
    throwIfAborted(options.signal);
    const markdown = normalizeText(fs.readFileSync(path.join(tempDirectory, 'document.md'), 'utf8'));
    const { text, images } = rewriteParsedDocumentImages(markdown, attachment, tempDirectory, 'PDF');
    keepTempDirectory = true;
    return {
      text,
      images,
      ownedTempDirectory: { directory: tempDirectory, tempRoot },
    };
  } finally {
    if (!keepTempDirectory) removeOwnedTempDirectory(tempDirectory, tempRoot);
  }
}

function rewriteParsedDocumentImages(
  markdown: string,
  attachment: AssistantDocumentAttachment,
  tempDirectory: string,
  documentKind: 'PDF' | 'DOCX',
): { text: string; images: AssistantParsedDocumentImage[] } {
  const manifest = readParseImagesManifest(tempDirectory);
  const recordsByReference = new Map<string, ParseImageRecord>();
  for (const record of manifest?.images ?? []) {
    recordsByReference.set(normalizeImageReference(record.relativePath), record);
    if (record.origin.ref) recordsByReference.set(normalizeImageReference(record.origin.ref), record);
  }
  const drafts = new Map<string, Omit<AssistantParsedDocumentImage, 'lineNumbers'>>();
  const rewritten = markdown.replace(
    /!\[([^\]]*)\]\(<([^>]*)>\)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+["'][^)]*["'])?\)/gu,
    (full, angleAlt: string | undefined, angleRef: string | undefined, plainAlt: string | undefined, plainRef: string | undefined) => {
      const ref = angleRef ?? plainRef ?? '';
      const record = recordsByReference.get(normalizeImageReference(ref));
      if (!record) return full;
      const mimeType = toAssistantImageMimeType(record.mime);
      const absolutePath = resolveOwnedParseImagePath(tempDirectory, record.relativePath);
      if (!mimeType || !absolutePath) return full;
      const imageId = `${attachment.attachmentId}:${record.sha256.slice(0, 16)}`;
      const placeholder = `[[${documentKind}_IMAGE:${imageId}]]`;
      if (!drafts.has(imageId)) {
        const alt = (angleAlt ?? plainAlt ?? '').trim();
        drafts.set(imageId, {
          imageId,
          attachmentId: attachment.attachmentId,
          placeholder,
          name: alt || `${attachment.name} · ${documentKind} 图片`,
          mimeType,
          sizeBytes: record.bytes,
          sha256: record.sha256,
          absolutePath,
        });
      }
      return placeholder;
    },
  );
  const text = boundDocumentText(rewritten);
  const lines = text.split('\n');
  const images = [...drafts.values()].flatMap((draft) => {
    const lineNumbers = lines.flatMap((line, index) => line.includes(draft.placeholder) ? [index + 1] : []);
    return lineNumbers.length ? [{ ...draft, lineNumbers }] : [];
  });
  return { text, images };
}

function normalizeImageReference(value: string): string {
  const withoutQuery = value.trim().replace(/\\/gu, '/').split(/[?#]/u, 1)[0] ?? '';
  try {
    return decodeURIComponent(withoutQuery).replace(/^\.\//u, '');
  } catch {
    return withoutQuery.replace(/^\.\//u, '');
  }
}

function resolveOwnedParseImagePath(tempDirectory: string, relativePath: string): string | undefined {
  const root = path.resolve(tempDirectory);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  try {
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function toAssistantImageMimeType(value: string): AssistantImageMimeType | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp') return value;
  return undefined;
}

function validateDocumentAttachment(attachment: AssistantDocumentAttachment): void {
  const resolvedPath = path.resolve(attachment.path);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!assistantDocumentExtensions.has(extension)) throw new Error(`不支持的文档附件类型：${extension || '未知'}。`);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`文档附件“${attachment.name}”不是文件。`);
  if (stat.size > maxAssistantDocumentBytes) throw new Error(`文档附件“${attachment.name}”不能超过 ${Math.floor(maxAssistantDocumentBytes / 1_000_000)} MB。`);
}

function boundDocumentText(value: string): string {
  const normalized = normalizeText(value);
  if (normalized.length <= MAX_DOCUMENT_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n\n[文档正文已按单轮上限截断]`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('文档附件解析已取消。', 'AbortError');
}

function removeOwnedTempDirectory(directory: string, tempRoot: string): void {
  const resolved = path.resolve(directory);
  const resolvedTempRoot = path.resolve(tempRoot);
  if (path.dirname(resolved) !== resolvedTempRoot || !path.basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}
