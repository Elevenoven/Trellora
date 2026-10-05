import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../materialsLibrary';
import { resolveParsingRoute } from './routes';
import { pipelineChunkingV2Enabled } from './chunkingConfig';
import type { ParsingRoute } from './types';

export interface PipelineLayout {
  libraryPath: string;
  documentId: string;
  document: MaterialsDocument;
  documentRoot: string;
  pipelineFingerprint: string;
  route: ParsingRoute;
  engine: string;
  manifestPath: string;
  parseDirectory: string;
  linesDirectory: string;
  signalsDirectory: string;
  ambiguityDirectory: string;
  treeDirectory: string;
  chunksDirectory: string;
  keywordsDirectory: string;
  vectorsDirectory: string;
  entitiesDirectory: string;
  checkpointDirectory: string;
  ambiguityConfigHash: string;
  structureConfigHash: string;
  chunkingConfigHash: string;
  chunkingV2Enabled: boolean;
  keywordConfigHash: string;
  vectorProfileHash: string;
  entitiesConfigHash: string;
}

export function pipelineRoot(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'pipeline');
}

export function createPipelineLayout(libraryPath: string, document: MaterialsDocument, mineruEndpoint = '', ambiguityConfigHash = 'disabled', structureConfigHash = 'default', keywordConfigHash = 'default', chunkingConfigHash = 'disabled', chunkingV2Enabled = pipelineChunkingV2Enabled(), vectorProfileHash = 'UNBOUND', entitiesConfigHash = 'disabled'): PipelineLayout {
  const root = pipelineRoot(libraryPath);
  const route = resolveParsingRoute(document.extension);
  const engine = route === 'direct'
    ? 'direct-p4'
    : route === 'mineru'
      ? 'mineru-v4-p4'
      : route === 'mammoth'
        ? 'mammoth-1.12.1-p1'
        : 'unsupported-v1';
  const fingerprint = hashValue({
    documentId: document.id,
    extension: document.extension,
    route,
    engine,
    // Endpoint changes invalidate only the MinerU parse cache. The secret is
    // intentionally excluded so changing a key does not create duplicate
    // copies of the same local artifact.
    ...(route === 'mineru' ? { mineruEndpoint: mineruEndpoint || 'https://mineru.net/api/v4' } : {}),
    protocolVersion: 1,
    schemaVersion: 1,
  });
  const documentRoot = path.join(root, safeSegment(document.id), safeSegment(document.contentHash), fingerprint);
  return {
    libraryPath: path.resolve(libraryPath),
    documentId: document.id,
    document,
    documentRoot,
    pipelineFingerprint: fingerprint,
    route,
    engine,
    manifestPath: path.join(documentRoot, 'pipeline-manifest.json'),
    parseDirectory: path.join(documentRoot, '01-parse'),
    linesDirectory: path.join(documentRoot, '02-lines'),
    signalsDirectory: path.join(documentRoot, '03-signals'),
    ambiguityDirectory: path.join(documentRoot, '04-ambiguity'),
    treeDirectory: path.join(documentRoot, '05-tree'),
    chunksDirectory: path.join(documentRoot, '06-chunks'),
    keywordsDirectory: path.join(documentRoot, '07-keywords'),
    vectorsDirectory: path.join(documentRoot, '08-vectors'),
    entitiesDirectory: path.join(documentRoot, '09-entities'),
    checkpointDirectory: path.join(documentRoot, 'checkpoints'),
    ambiguityConfigHash,
    structureConfigHash,
    chunkingConfigHash,
    chunkingV2Enabled,
    keywordConfigHash,
    vectorProfileHash,
    entitiesConfigHash,
  };
}

export function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('流水线路径片段无效。');
  return value;
}

export function ensurePipelineLayout(layout: PipelineLayout): void {
  fs.mkdirSync(layout.documentRoot, { recursive: true });
  const sourceDirectory = path.join(layout.documentRoot, '00-source');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  atomicWriteJson(path.join(sourceDirectory, 'source.json'), {
    schemaVersion: 1,
    documentId: layout.document.id,
    documentName: layout.document.name,
    sourceRelativePath: layout.document.relativePath,
    sourceContentHash: layout.document.contentHash,
    sourceSizeBytes: layout.document.sizeBytes,
    route: layout.route,
    engine: layout.engine,
    updatedAt: new Date().toISOString(),
  });
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}
