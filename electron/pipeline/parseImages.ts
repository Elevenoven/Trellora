import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PARSE_IMAGES_DIRECTORY_NAME = 'images';
export const PARSE_IMAGES_MANIFEST_NAME = 'images-manifest.json';

const MAX_SINGLE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024;

export type ParseImageOriginKind = 'mineru-zip' | 'docx-embedded' | 'library-copy';

export interface ParseImageOrigin {
  kind: ParseImageOriginKind;
  /** 图片在源产物中的引用或条目名，用于 markdown 引用改写与排查。 */
  ref: string;
  /** library-copy 来源相对资料库的路径，供缓存校验比对源图是否变化。 */
  sourceRelativePath?: string;
  sourceSizeBytes?: number;
  sourceMtimeMs?: number;
}

export interface ParseImageRecord {
  name: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  mime: string;
  origin: ParseImageOrigin;
}

export type ParseImageSkipReason = 'remote-url' | 'outside-library' | 'unsupported-type' | 'too-large' | 'unreadable';

export interface ParseImageSkippedRecord {
  ref: string;
  reason: ParseImageSkipReason;
}

export interface ParseImagesManifest {
  schemaVersion: 1;
  stage: 'parse';
  images: ParseImageRecord[];
  skipped: ParseImageSkippedRecord[];
  generatedAt: string;
}

export interface ParseImageSink {
  /** 保存内存中的图片字节，返回可写入 markdown 的相对引用；不满足约束时返回 null 并记入 skipped。 */
  saveBuffer(buffer: Buffer, mimeHint: string | undefined, origin: ParseImageOrigin): string | null;
  adoptFile(absolutePath: string, origin: ParseImageOrigin): string | null;
  adoptStream(source: AsyncIterable<Buffer | string>, origin: ParseImageOrigin): Promise<string | null>;
  /** 由路由侧显式记录无法采纳的引用（远程 URL、库外路径、源文件不可读等）。 */
  recordSkip(ref: string, reason: ParseImageSkipReason): void;
  rewriteMap(): ReadonlyMap<string, string>;
  savedCount(): number;
  skippedCount(): number;
  manifest(): ParseImagesManifest;
  writeManifest(outputDir: string): void;
}

interface DetectedImageType {
  extension: '.png' | '.jpg' | '.gif' | '.webp';
  mime: string;
}

/**
 * 解析阶段统一图片汇：所有路由（MinerU zip、DOCX 内嵌、资料库内被引用文件）
 * 都把图片以内容寻址名 `<sha256>.<ext>` 写入阶段输出目录的 images/ 子目录，
 * 并生成 images-manifest.json，保证产物自包含、渲染与分析只在工作区内解析。
 */
export function createParseImageSink(outputDir: string): ParseImageSink {
  const imagesDirectory = path.join(outputDir, PARSE_IMAGES_DIRECTORY_NAME);
  const records: ParseImageRecord[] = [];
  const recordsBySha = new Map<string, ParseImageRecord>();
  const skipped: ParseImageSkippedRecord[] = [];
  const rewrites = new Map<string, string>();
  let totalBytes = 0;

  function skip(ref: string, reason: ParseImageSkipReason): void {
    skipped.push({ ref, reason });
  }

  function saveBuffer(buffer: Buffer, mimeHint: string | undefined, origin: ParseImageOrigin): string | null {
    if (buffer.length === 0 || buffer.length > MAX_SINGLE_IMAGE_BYTES) {
      skip(origin.ref, 'too-large');
      return null;
    }
    if (totalBytes + buffer.length > MAX_TOTAL_IMAGE_BYTES) {
      skip(origin.ref, 'too-large');
      return null;
    }
    const detected = detectImageType(buffer) ?? detectImageTypeByMimeHint(mimeHint);
    if (!detected) {
      skip(origin.ref, 'unsupported-type');
      return null;
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    let record = recordsBySha.get(sha256);
    if (!record) {
      const name = `${sha256}${detected.extension}`;
      record = {
        name,
        relativePath: `${PARSE_IMAGES_DIRECTORY_NAME}/${name}`,
        sha256,
        bytes: buffer.length,
        mime: detected.mime,
        origin,
      };
      fs.mkdirSync(imagesDirectory, { recursive: true });
      fs.writeFileSync(path.join(imagesDirectory, name), buffer);
      recordsBySha.set(sha256, record);
      records.push(record);
      totalBytes += buffer.length;
    }
    if (origin.ref) rewrites.set(origin.ref, record.relativePath);
    return record.relativePath;
  }

  return {
    saveBuffer,
    adoptFile(absolutePath, origin) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      if (!stat.isFile() || stat.size > MAX_SINGLE_IMAGE_BYTES) {
        skip(origin.ref, stat.isFile() ? 'too-large' : 'unreadable');
        return null;
      }
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(absolutePath);
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      return saveBuffer(buffer, undefined, origin);
    },
    async adoptStream(source, origin) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          bytes += buffer.length;
          if (bytes > MAX_SINGLE_IMAGE_BYTES) {
            skip(origin.ref, 'too-large');
            return null;
          }
          chunks.push(buffer);
        }
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      return saveBuffer(Buffer.concat(chunks), undefined, origin);
    },
    recordSkip: skip,
    rewriteMap: () => rewrites,
    savedCount: () => records.length,
    skippedCount: () => skipped.length,
    manifest: () => ({
      schemaVersion: 1,
      stage: 'parse',
      images: [...records],
      skipped: [...skipped],
      generatedAt: new Date().toISOString(),
    }),
    writeManifest(targetDir) {
      const manifestPath = path.join(targetDir, PARSE_IMAGES_MANIFEST_NAME);
      const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        schemaVersion: 1,
        stage: 'parse',
        images: records,
        skipped,
        generatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      fs.renameSync(temporaryPath, manifestPath);
    },
  };
}

export function readParseImagesManifest(directory: string): ParseImagesManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, PARSE_IMAGES_MANIFEST_NAME), 'utf8')) as Partial<ParseImagesManifest>;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.images) || !Array.isArray(value.skipped)) return null;
    return value as ParseImagesManifest;
  } catch {
    return null;
  }
}

const markdownImagePattern = /!\[[^\]]*\]\(<([^>]*)>\)|!\[[^\]]*\]\(([^)\s]*)(?:\s+["'][^)]*["'])?\)/gu;

export function collectMarkdownImageReferences(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(markdownImagePattern)) {
    const ref = decodeMarkdownUrl(match[1] ?? match[2] ?? '');
    if (ref) refs.push(ref);
  }
  return refs;
}

export function rewriteMarkdownImageReferences(text: string, rewrite: ReadonlyMap<string, string>): string {
  if (rewrite.size === 0 || !text.includes('![')) return text;
  return text.replace(markdownImagePattern, (whole, angled: string | undefined, plain: string | undefined) => {
    const ref = decodeMarkdownUrl(angled ?? plain ?? '');
    const next = rewrite.get(ref);
    if (!next) return whole;
    const original = angled !== undefined ? `<${angled}>` : (plain ?? '');
    return whole.replace(original, next);
  });
}

/** 将 markdown 文件中的图片引用按映射改写（流式逐行，避免大文件整体入内存）。 */
export async function rewriteMarkdownFileImageReferences(filePath: string, rewrite: ReadonlyMap<string, string>): Promise<void> {
  if (rewrite.size === 0) return;
  const temporaryPath = `${filePath}.imgtmp-${process.pid}-${Date.now()}`;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const output = fs.createWriteStream(temporaryPath, { encoding: 'utf8' });
  try {
    let pending = '';
    for await (const chunk of input) {
      pending += String(chunk);
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        output.write(`${rewriteMarkdownImageReferences(line, rewrite)}\n`);
        newlineIndex = pending.indexOf('\n');
      }
    }
    if (pending.length > 0) output.write(rewriteMarkdownImageReferences(pending, rewrite));
    await new Promise<void>((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
      output.end();
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* 保留原文件 */ }
    throw error;
  }
}

/**
 * direct 路由的 markdown 源文档可能相对引用资料库内图片；解析前统一采纳进
 * 阶段输出目录，使产物自包含。库外路径与远程 URL 不下载、不复制，记入 skipped。
 */
export function planDirectMarkdownImages(params: {
  sourcePath: string;
  libraryPath: string;
  sink: ParseImageSink;
}): void {
  const markdownExtensions = new Set(['.md', '.markdown']);
  if (!markdownExtensions.has(path.extname(params.sourcePath).toLowerCase())) return;
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(params.sourcePath, 'utf8');
  } catch {
    return;
  }
  const sourceDirectory = path.dirname(params.sourcePath);
  const libraryPath = path.resolve(params.libraryPath);
  for (const line of sourceText.split(/\r?\n/u)) {
    for (const ref of collectMarkdownImageReferences(line)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(ref)) {
        params.sink.recordSkip(ref, 'remote-url');
        continue;
      }
      const absolutePath = path.resolve(sourceDirectory, ref.replace(/[\\/]+$/u, ''));
      const relativeToLibrary = path.relative(libraryPath, absolutePath);
      if (relativeToLibrary.startsWith('..') || path.isAbsolute(relativeToLibrary)) {
        params.sink.recordSkip(ref, 'outside-library');
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        params.sink.recordSkip(ref, 'unreadable');
        continue;
      }
      params.sink.adoptFile(absolutePath, {
        kind: 'library-copy',
        ref,
        sourceRelativePath: relativeToLibrary.replace(/\\/gu, '/'),
        sourceSizeBytes: stat.size,
        sourceMtimeMs: Math.floor(stat.mtimeMs),
      });
    }
  }
}

function decodeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function detectImageType(buffer: Buffer): DetectedImageType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { extension: '.gif', mime: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mime: 'image/webp' };
  }
  return null;
}

function detectImageTypeByMimeHint(mimeHint: string | undefined): DetectedImageType | null {
  switch ((mimeHint ?? '').split(';')[0].trim().toLowerCase()) {
    case 'image/png': return { extension: '.png', mime: 'image/png' };
    case 'image/jpeg': return { extension: '.jpg', mime: 'image/jpeg' };
    case 'image/gif': return { extension: '.gif', mime: 'image/gif' };
    case 'image/webp': return { extension: '.webp', mime: 'image/webp' };
    default: return null;
  }
}
