import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../materialsLibrary';
import { pipelineRoot, safeSegment } from '../pipeline/pathLayout';
import { readParseImagesManifest, type ParseImageRecord } from '../pipeline/parseImages';
import type { PipelineManifest } from '../pipeline/types';
import type { AiTransportImage } from './aiGenerationTransport';
import { maxAssistantImageBytes, maxAssistantImageTotalBytes, type AssistantImageMimeType } from './assistantTurnTypes';

const MAX_KNOWLEDGE_BASE_IMAGES = 4;
const storedImageReferencePattern = /!\[([^\]]*)\]\(<([^>]*)>\)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+["'][^)]*["'])?\)/gu;
const ownedParseImagePattern = /^images\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u;

export interface KnowledgeBaseVisualEvidence {
  documentId: string;
  text: string;
  sourceText?: string;
}

export interface KnowledgeBaseVisualMapping {
  imageIndex: number;
  placeholder: string;
  documentId: string;
  documentName: string;
  sha256: string;
}

export interface KnowledgeBaseVisualResolution<T extends KnowledgeBaseVisualEvidence> {
  evidence: T[];
  /** 仅包含本次新加入视觉上下文的图片；已在本轮显式上传的同图不会重复传输。 */
  images: AiTransportImage[];
  /** 覆盖本批证据引用到的全部已选图片，用于把占位符绑定到真实视觉输入序号。 */
  mappings: KnowledgeBaseVisualMapping[];
}

interface ParseImageSnapshot {
  parseDirectory: string;
  recordsByReference: Map<string, ParseImageRecord>;
}

interface SelectedImage {
  imageIndex: number;
}

/**
 * 将长期资料库证据里的 `images/<sha>.<ext>` 引用安全物化为本轮 VLM 图片。
 * 解析产物仍由资料库流水线持久化；本类只读当前 contentHash 下已成功的 parse 阶段，
 * 不写数据库、不把绝对路径放入提示词，也不会越过单图/总量/张数预算。
 */
export class KnowledgeBaseImageResolver {
  private readonly libraryPath: string;
  private readonly documentsById: Map<string, MaterialsDocument>;
  private readonly snapshots = new Map<string, ParseImageSnapshot | null>();
  private readonly selectedBySha = new Map<string, SelectedImage>();
  private readonly maxNewImages: number;
  private readonly maxTotalBytes: number;
  private readonly initialImageCount: number;
  private totalBytes = 0;
  private newImageCount = 0;

  constructor(libraryPath: string, options: {
    documents: readonly MaterialsDocument[];
    initialImages?: readonly AiTransportImage[];
    maxNewImages?: number;
    maxTotalBytes?: number;
  }) {
    this.libraryPath = path.resolve(libraryPath);
    this.documentsById = new Map(options.documents.map((document) => [document.id, document]));
    this.maxNewImages = Math.max(0, Math.min(MAX_KNOWLEDGE_BASE_IMAGES, options.maxNewImages ?? MAX_KNOWLEDGE_BASE_IMAGES));
    this.maxTotalBytes = Math.max(0, Math.min(maxAssistantImageTotalBytes, options.maxTotalBytes ?? maxAssistantImageTotalBytes));
    const initialImages = options.initialImages ?? [];
    this.initialImageCount = initialImages.length;
    for (const [index, image] of initialImages.entries()) {
      const decoded = decodeDataUrl(image.dataUrl);
      if (!decoded) continue;
      this.totalBytes += decoded.length;
      const sha256 = createHash('sha256').update(decoded).digest('hex');
      if (!this.selectedBySha.has(sha256)) this.selectedBySha.set(sha256, { imageIndex: index + 1 });
    }
  }

  resolve<T extends KnowledgeBaseVisualEvidence>(evidence: readonly T[]): KnowledgeBaseVisualResolution<T> {
    const freshImages: AiTransportImage[] = [];
    const mappingsByKey = new Map<string, KnowledgeBaseVisualMapping>();
    const resolvedEvidence = evidence.map((entry) => {
      const document = this.documentsById.get(entry.documentId);
      const snapshot = document ? this.getSnapshot(document) : null;
      if (!document || !snapshot || !entry.text.includes('![')) return { ...entry };
      const text = entry.text.replace(
        storedImageReferencePattern,
        (whole, angleAlt: string | undefined, angleRef: string | undefined, plainAlt: string | undefined, plainRef: string | undefined) => {
          const reference = normalizeImageReference(angleRef ?? plainRef ?? '');
          const record = snapshot.recordsByReference.get(reference);
          if (!record) return whole;
          const loaded = this.loadImage(snapshot.parseDirectory, record);
          if (!loaded) return whole;
          let selected = this.selectedBySha.get(record.sha256);
          if (!selected) {
            if (this.newImageCount >= this.maxNewImages || this.totalBytes + loaded.buffer.length > this.maxTotalBytes) return whole;
            const placeholder = knowledgeBaseImagePlaceholder(document.id, record.sha256);
            const transport: AiTransportImage = {
              dataUrl: `data:${loaded.mimeType};base64,${loaded.buffer.toString('base64')}`,
              mimeType: loaded.mimeType,
              name: `${document.name} ${placeholder}`,
            };
            selected = { imageIndex: this.initialImageCount + this.newImageCount + 1 };
            this.selectedBySha.set(record.sha256, selected);
            this.newImageCount += 1;
            this.totalBytes += loaded.buffer.length;
            freshImages.push(transport);
          }
          const placeholder = knowledgeBaseImagePlaceholder(document.id, record.sha256);
          const mapping: KnowledgeBaseVisualMapping = {
            imageIndex: selected.imageIndex,
            placeholder,
            documentId: document.id,
            documentName: document.name,
            sha256: record.sha256,
          };
          mappingsByKey.set(`${mapping.imageIndex}:${mapping.placeholder}`, mapping);
          const alt = (angleAlt ?? plainAlt ?? '').trim();
          return alt ? `${placeholder}（原图说明：${alt}）` : placeholder;
        },
      );
      return { ...entry, text };
    });

    return {
      evidence: resolvedEvidence,
      images: freshImages,
      mappings: [...mappingsByKey.values()].sort((left, right) => left.imageIndex - right.imageIndex || left.placeholder.localeCompare(right.placeholder)),
    };
  }

  private getSnapshot(document: MaterialsDocument): ParseImageSnapshot | null {
    if (this.snapshots.has(document.id)) return this.snapshots.get(document.id) ?? null;
    const snapshot = readCurrentParseImageSnapshot(this.libraryPath, document);
    this.snapshots.set(document.id, snapshot);
    return snapshot;
  }

  private loadImage(parseDirectory: string, record: ParseImageRecord): { buffer: Buffer; mimeType: AssistantImageMimeType } | undefined {
    const normalizedPath = normalizeImageReference(record.relativePath);
    if (!ownedParseImagePattern.test(normalizedPath) || normalizedPath !== record.relativePath.replace(/\\/gu, '/')) return undefined;
    if (!/^[a-f0-9]{64}$/u.test(record.sha256) || record.bytes <= 0 || record.bytes > maxAssistantImageBytes) return undefined;
    const mimeType = toAssistantImageMimeType(record.mime);
    if (!mimeType) return undefined;
    const root = path.resolve(parseDirectory);
    const candidate = path.resolve(root, normalizedPath);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    let buffer: Buffer;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size !== record.bytes || stat.size > maxAssistantImageBytes) return undefined;
      buffer = fs.readFileSync(candidate);
    } catch {
      return undefined;
    }
    if (buffer.length !== record.bytes || createHash('sha256').update(buffer).digest('hex') !== record.sha256) return undefined;
    return { buffer, mimeType };
  }
}

export function renderKnowledgeBaseImageTransportIndex(mappings: readonly KnowledgeBaseVisualMapping[]): string {
  if (mappings.length === 0) return '';
  return [
    '[知识库图片视觉输入索引]',
    ...mappings.map((mapping) => `视觉输入第 ${mapping.imageIndex} 张=${mapping.placeholder}；来源文档=${mapping.documentName}`),
    '请把视觉输入与证据中的同名占位符结合理解；图注和周边文字只作辅助，图片内容以视觉输入为准。',
  ].join('\n');
}

function readCurrentParseImageSnapshot(libraryPath: string, document: MaterialsDocument): ParseImageSnapshot | null {
  let documentRoot: string;
  try {
    documentRoot = path.join(pipelineRoot(libraryPath), safeSegment(document.id), safeSegment(document.contentHash));
  } catch {
    return null;
  }
  const root = path.resolve(documentRoot);
  let fingerprints: fs.Dirent[];
  try {
    fingerprints = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = fingerprints.flatMap((entry) => {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) return [];
    const fingerprintRoot = path.resolve(root, entry.name);
    const relative = path.relative(root, fingerprintRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    let manifest: PipelineManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(fingerprintRoot, 'pipeline-manifest.json'), 'utf8')) as PipelineManifest;
    } catch {
      return [];
    }
    if (manifest.documentId !== document.id
      || manifest.sourceContentHash !== document.contentHash
      || manifest.pipelineFingerprint !== entry.name
      || manifest.stages?.parse?.status !== 'SUCCEEDED') return [];
    return [{ fingerprintRoot, updatedAt: Date.parse(manifest.updatedAt) || 0 }];
  }).sort((left, right) => right.updatedAt - left.updatedAt);

  for (const candidate of candidates) {
    const parseDirectory = path.join(candidate.fingerprintRoot, '01-parse');
    const manifest = readParseImagesManifest(parseDirectory);
    if (!manifest?.images.length) continue;
    const recordsByReference = new Map<string, ParseImageRecord>();
    for (const record of manifest.images) {
      if (!record || typeof record.relativePath !== 'string' || typeof record.sha256 !== 'string'
        || typeof record.bytes !== 'number' || typeof record.mime !== 'string') continue;
      recordsByReference.set(normalizeImageReference(record.relativePath), record);
      if (record.origin && typeof record.origin.ref === 'string') recordsByReference.set(normalizeImageReference(record.origin.ref), record);
    }
    if (recordsByReference.size > 0) return { parseDirectory, recordsByReference };
  }
  return null;
}

function knowledgeBaseImagePlaceholder(documentId: string, sha256: string): string {
  return `[[KNOWLEDGE_IMAGE:${documentId}:${sha256.slice(0, 16)}]]`;
}

function normalizeImageReference(value: string): string {
  const withoutQuery = value.trim().replace(/\\/gu, '/').split(/[?#]/u, 1)[0] ?? '';
  try {
    return decodeURIComponent(withoutQuery).replace(/^\.\//u, '');
  } catch {
    return withoutQuery.replace(/^\.\//u, '');
  }
}

function toAssistantImageMimeType(value: string): AssistantImageMimeType | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp') return value;
  return undefined;
}

function decodeDataUrl(value: string): Buffer | undefined {
  const match = /^data:[^;,]+;base64,(.+)$/su.exec(value);
  if (!match) return undefined;
  try {
    return Buffer.from(match[1]!, 'base64');
  } catch {
    return undefined;
  }
}
