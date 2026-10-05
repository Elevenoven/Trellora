import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runMarkdownArtifactParse, type TextStageProgress } from './textStage';
import { createParseImageSink, rewriteMarkdownFileImageReferences } from './parseImages';
import { PipelineStageError } from './stageErrors';

const DEFAULT_MINERU_ENDPOINT = 'https://mineru.net/api/v4';
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 30 * 60 * 1_000;

export interface MineruParseOptions {
  inputPath: string;
  outputDir: string;
  documentId: string;
  expectedContentHash?: string;
  endpoint: string;
  apiKey: string;
  signal: AbortSignal;
  onProgress?: (progress: TextStageProgress) => void;
}

interface MineruResult {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
  err_code?: number | string;
  extract_progress?: { extracted_pages?: number; total_pages?: number };
}

/**
 * Main-process-only MinerU adapter. The key is accepted only as an argument
 * from Electron safeStorage and is never written to disk, logs, or artifacts.
 */
export async function runMineruPdfParse(options: MineruParseOptions): Promise<{ counts: Record<string, number> }> {
  if (!options.apiKey.trim()) throw new PipelineStageError('MINERU_KEY_REQUIRED', '尚未配置 MinerU API Key。', false);
  if (!fs.existsSync(options.inputPath) || !fs.statSync(options.inputPath).isFile()) {
    throw new PipelineStageError('SOURCE_NOT_FOUND', 'PDF 原始文档不存在或不可读。', false);
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const zipPath = path.join(options.outputDir, `.mineru-result-${process.pid}-${Date.now()}.zip`);
  const markdownPath = path.join(options.outputDir, `.mineru-full-${process.pid}-${Date.now()}.md`);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const uploadSnapshot = path.join(options.outputDir, '.authorized-source.pdf');

  try {
    // Upload immutable bytes validated against the main-process authorization.
    // A changed source must fail before any remote request, including URL submission.
    let uploadOptions = options;
    if (options.expectedContentHash) {
      await fs.promises.copyFile(options.inputPath, uploadSnapshot, fs.constants.COPYFILE_EXCL);
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(uploadSnapshot)) { options.signal.throwIfAborted(); hash.update(chunk); }
      if (hash.digest('hex') !== options.expectedContentHash) throw new PipelineStageError('CLOUD_SOURCE_CHANGED', '文件内容已变化，请重新确认此次 PDF 上传。', false);
      uploadOptions = { ...options, inputPath: uploadSnapshot };
    }
    const batchId = await requestUploadUrl(endpoint, options);
    await uploadFile(batchId.uploadUrl, uploadOptions);
    const result = await pollResult(endpoint, batchId.batchId, options);
    if (!result.full_zip_url) throw new PipelineStageError('MINERU_OUTPUT_MISSING', 'MinerU 已完成，但没有返回结果压缩包。', true);
    await downloadToFile(result.full_zip_url, zipPath, options);
    const entries = await listZipEntries(zipPath);
    const fullMdEntry = entries.find((entry) => path.basename(entry.name).toLowerCase() === 'full.md');
    if (!fullMdEntry) throw new PipelineStageError('MINERU_OUTPUT_MISSING', 'MinerU 结果包中没有找到 full.md。', true);
    await extractZipEntryToFile(zipPath, fullMdEntry, markdownPath);
    // 结果包内的 images/ 一并落盘到阶段输出目录，避免 document.md 留下悬空引用。
    const sink = createParseImageSink(options.outputDir);
    for (const entry of entries.filter(isZipImageEntry)) {
      const source = extractZipEntrySource(zipPath, entry);
      try {
        await sink.adoptStream(source, {
          kind: 'mineru-zip',
          ref: `images/${path.basename(entry.name)}`,
        });
      } finally {
        // 超限提前返回时迭代器只会销毁解压流；zip 在临时目录内，源流 fd 不关会阻断目录原子改名。
        source.destroy();
      }
    }
    await rewriteMarkdownFileImageReferences(markdownPath, sink.rewriteMap());
    const parsed = await runMarkdownArtifactParse({
      inputPath: markdownPath,
      outputDir: options.outputDir,
      engine: 'mineru',
      sourceName: path.basename(options.inputPath),
      signal: options.signal,
      onProgress: options.onProgress,
      extraCounts: { images: sink.savedCount(), imagesSkipped: sink.skippedCount() },
    });
    sink.writeManifest(options.outputDir);
    return parsed;
  } finally {
    for (const filePath of [zipPath, markdownPath, uploadSnapshot]) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* 临时远程结果不影响成功缓存 */ }
    }
  }
}

async function requestUploadUrl(endpoint: string, options: MineruParseOptions): Promise<{ batchId: string; uploadUrl: string }> {
  const response = await requestJson(`${endpoint}/file-urls/batch`, options.apiKey, {
    files: [{ name: path.basename(options.inputPath), data_id: options.documentId }],
    model_version: 'vlm',
    language: 'ch',
    enable_table: true,
    enable_formula: true,
    is_ocr: false,
  }, options.signal);
  const data = asRecord(response.data);
  const urls = Array.isArray(data?.file_urls) ? data.file_urls : [];
  const batchId = typeof data?.batch_id === 'string' ? data.batch_id : '';
  const uploadUrl = typeof urls[0] === 'string' ? urls[0] : '';
  if (!batchId || !uploadUrl) throw new PipelineStageError('MINERU_SUBMIT_INVALID', 'MinerU 返回的上传任务信息不完整。', true);
  return { batchId, uploadUrl };
}

async function uploadFile(uploadUrl: string, options: MineruParseOptions): Promise<void> {
  const stream = fs.createReadStream(options.inputPath);
  try {
    const response = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }, options.signal, 120_000);
    if (!response.ok) throw classifyHttpError(response.status, 'MinerU 文件上传失败。');
  } catch (error) {
    stream.destroy();
    throw error instanceof PipelineStageError ? error : new PipelineStageError('MINERU_UPLOAD_FAILED', `MinerU 文件上传失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function pollResult(endpoint: string, batchId: string, options: MineruParseOptions): Promise<MineruResult> {
  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    const response = await requestJson(`${endpoint}/extract-results/batch/${encodeURIComponent(batchId)}`, options.apiKey, undefined, options.signal);
    const data = asRecord(response.data);
    const raw = data?.extract_result;
    const result = Array.isArray(raw) ? (raw[0] as MineruResult | undefined) : raw as MineruResult | undefined;
    if (!result || typeof result !== 'object') throw new PipelineStageError('MINERU_RESULT_INVALID', 'MinerU 返回的任务状态无法识别。', true);
    const state = String(result.state ?? '');
    const progress = asRecord(result.extract_progress);
    const completed = typeof progress?.extracted_pages === 'number' ? progress.extracted_pages : 0;
    const total = typeof progress?.total_pages === 'number' ? progress.total_pages : undefined;
    options.onProgress?.({ completed, ...(total !== undefined ? { total } : {}), message: state === 'done' ? 'MinerU 解析完成，正在下载本地缓存。' : `MinerU 解析中：${state || '排队中'}。` });
    if (state === 'done') return result;
    if (state === 'failed') {
      const code = result.err_code === undefined ? 'MINERU_PARSE_FAILED' : `MINERU_${String(result.err_code)}`;
      throw new PipelineStageError(code, `MinerU 解析失败：${result.err_msg || '远端未提供原因。'}`, isRetryableMineruCode(result.err_code));
    }
    await delay(POLL_INTERVAL_MS, options.signal);
  }
  throw new PipelineStageError('MINERU_TIMEOUT', 'MinerU 解析超过 30 分钟仍未完成，可稍后重试。', true);
}

async function downloadToFile(url: string, filePath: string, options: MineruParseOptions): Promise<void> {
  const response = await fetchWithTimeout(url, {}, options.signal, 120_000);
  if (!response.ok || !response.body) throw classifyHttpError(response.status, 'MinerU 结果下载失败。');
  try {
    await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>), fs.createWriteStream(filePath));
  } catch (error) {
    throw error instanceof PipelineStageError ? error : new PipelineStageError('MINERU_DOWNLOAD_FAILED', `MinerU 结果下载失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function requestJson(url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, signal, 30_000);
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw classifyHttpError(response.status, 'MinerU 请求失败。');
  const parsed = asRecord(payload);
  if (!parsed || parsed.code !== 0) {
    const code = typeof parsed?.code === 'string' || typeof parsed?.code === 'number' ? String(parsed.code) : 'MINERU_API_ERROR';
    const message = typeof parsed?.msg === 'string' ? parsed.msg : 'MinerU 返回了错误响应。';
    throw new PipelineStageError(`MINERU_${code}`, `MinerU 请求失败：${message}`, isRetryableMineruCode(parsed?.code));
  }
  return parsed;
}

async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal.aborted) throw new PipelineStageError('STAGE_CANCELLED', '解析任务已取消。', true);
    if (controller.signal.aborted) throw new PipelineStageError('MINERU_NETWORK_TIMEOUT', 'MinerU 请求超时，可重试。', true);
    throw new PipelineStageError('MINERU_NETWORK_ERROR', `MinerU 网络请求失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

interface ZipEntryMeta {
  name: string;
  compression: number;
  compressedSize: number;
  dataStart: number;
}

function isZipImageEntry(entry: ZipEntryMeta): boolean {
  return !entry.name.endsWith('/') && /(?:^|\/)images\/[^/]+$/u.test(entry.name);
}

async function listZipEntries(zipPath: string): Promise<ZipEntryMeta[]> {
  const stat = await fs.promises.stat(zipPath);
  const tailSize = Math.min(stat.size, 22 + 65_535);
  const tail = Buffer.alloc(tailSize);
  const handle = await fs.promises.open(zipPath, 'r');
  try {
    await handle.read(tail, 0, tail.length, stat.size - tail.length);
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocd = tail.lastIndexOf(eocdSignature);
    if (eocd < 0) throw new PipelineStageError('MINERU_ZIP_INVALID', 'MinerU 返回的结果包无效。', true);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new PipelineStageError('MINERU_ZIP_UNSUPPORTED', 'MinerU 结果包使用了暂不支持的 Zip64 格式。', false);
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, central.length, centralOffset);
    const entries: ZipEntryMeta[] = [];
    let position = 0;
    while (position + 46 <= central.length) {
      if (central.readUInt32LE(position) !== 0x02014b50) break;
      const compression = central.readUInt16LE(position + 10);
      const compressedSize = central.readUInt32LE(position + 20);
      const fileNameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const localOffset = central.readUInt32LE(position + 42);
      const name = central.subarray(position + 46, position + 46 + fileNameLength).toString('utf8');
      if (compression !== 0 && compression !== 8) throw new PipelineStageError('MINERU_ZIP_COMPRESSION_UNSUPPORTED', 'MinerU 结果包使用了暂不支持的压缩格式。', false);
      const localHeader = Buffer.alloc(30);
      await handle.read(localHeader, 0, localHeader.length, localOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new PipelineStageError('MINERU_ZIP_INVALID', 'MinerU 结果包的文件条目无效。', true);
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      entries.push({
        name,
        compression,
        compressedSize,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
      });
      position += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function extractZipEntrySource(zipPath: string, entry: ZipEntryMeta): Readable {
  if (entry.compressedSize === 0) return Readable.from([]);
  const source = fs.createReadStream(zipPath, { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 });
  return entry.compression === 8 ? source.pipe(createInflateRaw()) : source;
}

async function extractZipEntryToFile(zipPath: string, entry: ZipEntryMeta, outputPath: string): Promise<void> {
  await pipeline(extractZipEntrySource(zipPath, entry), fs.createWriteStream(outputPath));
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim() || DEFAULT_MINERU_ENDPOINT;
  return trimmed.replace(/\/+$/u, '').endsWith('/api/v4') ? trimmed.replace(/\/+$/u, '') : `${trimmed.replace(/\/+$/u, '')}/api/v4`;
}

function classifyHttpError(status: number, message: string): PipelineStageError {
  if (status === 401 || status === 403) return new PipelineStageError('MINERU_UNAUTHORIZED', 'MinerU API Key 无效或已过期，请在解析设置中更新。', false);
  return new PipelineStageError(`MINERU_HTTP_${status}`, message, status === 408 || status === 429 || status >= 500);
}

function isRetryableMineruCode(value: unknown): boolean {
  const code = String(value ?? '');
  return ['-10001', '-60001', '-60007', '-60008', '-60009', '-60010', '-60020', '-60021', '-60022'].includes(code);
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PipelineStageError('STAGE_CANCELLED', '解析任务已取消。', true);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new PipelineStageError('STAGE_CANCELLED', '解析任务已取消。', true)); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
