import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../materialsLibrary';
import { atomicWriteJson, createPipelineLayout, ensurePipelineLayout, pipelineRoot, safeSegment, type PipelineLayout } from './pathLayout';
import { readParseImagesManifest } from './parseImages';
import type { PipelineError, PipelineManifest, PipelineStageId, PipelineStageManifest, PipelineStageState } from './types';
import { isMaterialVectorProjectionCurrent } from './materialVectorCoordinator';

const unifiedParseOutputs = ['document.md', 'line-layout.jsonl', 'blocks.jsonl', 'parse-report.json', 'images-manifest.json'] as const;
const linesOutputs = ['lines.jsonl', 'lines-report.json'] as const;
const signalsOutputs = ['signals.jsonl', 'signal-report.json'] as const;
const ambiguityOutputs = ['ambiguity.jsonl', 'ambiguity-report.json'] as const;
const treeOutputs = ['structure.jsonl', 'structure.json', 'tree-report.json'] as const;
const legacyChunksOutputs = ['chunks.jsonl', 'chunks-report.json'] as const;
const v2ChunksOutputs = ['parents.jsonl', 'children.jsonl', 'chunks.jsonl', 'chunk-plan.json', 'chunks-report.json'] as const;
const keywordsOutputs = ['keywords.jsonl', 'keyword-report.json'] as const;
const vectorsOutputs = ['vector-report.json'] as const;
const entitiesOutputs = ['entities.jsonl', 'relations.jsonl', 'extraction-report.json'] as const;
const signalRuleVersion = 'p3-rules-7';
const stageOrder: readonly PipelineStageId[] = ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'];

export interface StageCommitResult {
  artifactPath: string;
  outputs: PipelineStageManifest['outputs'];
  counts: Record<string, number>;
}

export function prepareParseLayout(libraryPath: string, document: MaterialsDocument, mineruEndpoint = '', ambiguityConfigHash = 'disabled', structureConfigHash = 'default', keywordConfigHash = 'default', chunkingConfigHash = 'disabled', chunkingV2Enabled?: boolean, vectorProfileHash = 'UNBOUND', entitiesConfigHash = 'disabled'): PipelineLayout {
  const layout = createPipelineLayout(libraryPath, document, mineruEndpoint, ambiguityConfigHash, structureConfigHash, keywordConfigHash, chunkingConfigHash, chunkingV2Enabled, vectorProfileHash, entitiesConfigHash);
  ensurePipelineLayout(layout);
  return layout;
}

export function parseOutputNames(_layout: PipelineLayout): readonly string[] {
  return unifiedParseOutputs;
}

export function stageOutputNames(layout: PipelineLayout, stage: PipelineStageId): readonly string[] {
  if (stage === 'parse') return parseOutputNames(layout);
  if (stage === 'lines') return linesOutputs;
  if (stage === 'signals') return signalsOutputs;
  if (stage === 'ambiguity') return ambiguityOutputs;
  if (stage === 'tree') return treeOutputs;
  if (stage === 'chunks') return layout.chunkingV2Enabled ? v2ChunksOutputs : legacyChunksOutputs;
  if (stage === 'keywords') return keywordsOutputs;
  if (stage === 'entities') return entitiesOutputs;
  return vectorsOutputs;
}

/** 仅允许预览该阶段已声明的正式产物，禁止把 manifest 或临时文件作为资料内容读取。 */
export function isStageOutputAllowed(layout: PipelineLayout, stage: PipelineStageId, fileName: unknown): fileName is string {
  return typeof fileName === 'string' && stageOutputNames(layout, stage).includes(fileName);
}

export function stageDirectory(layout: PipelineLayout, stage: PipelineStageId): string {
  if (stage === 'parse') return layout.parseDirectory;
  if (stage === 'lines') return layout.linesDirectory;
  if (stage === 'signals') return layout.signalsDirectory;
  if (stage === 'ambiguity') return layout.ambiguityDirectory;
  if (stage === 'tree') return layout.treeDirectory;
  if (stage === 'chunks') return layout.chunksDirectory;
  if (stage === 'keywords') return layout.keywordsDirectory;
  if (stage === 'entities') return layout.entitiesDirectory;
  return layout.vectorsDirectory;
}

export function readPipelineManifest(layout: PipelineLayout): PipelineManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8')) as Partial<PipelineManifest>;
    if (!value || typeof value !== 'object' || !value.stages || typeof value.stages !== 'object') return null;
    return value as PipelineManifest;
  } catch {
    return null;
  }
}

export function writePipelineManifest(layout: PipelineLayout, manifest: PipelineManifest): void {
  atomicWriteJson(layout.manifestPath, manifest);
}

export function createOrReadManifest(layout: PipelineLayout): PipelineManifest {
  const existing = readPipelineManifest(layout);
  if (existing) return existing;
  const manifest: PipelineManifest = {
    schemaVersion: 1,
    documentId: layout.document.id,
    documentName: layout.document.name,
    sourceContentHash: layout.document.contentHash,
    sourceRelativePath: layout.document.relativePath,
    route: layout.route,
    engine: layout.engine,
    protocolVersion: 1,
    pipelineFingerprint: layout.pipelineFingerprint,
    updatedAt: new Date().toISOString(),
    stages: {},
  };
  writePipelineManifest(layout, manifest);
  return manifest;
}

export function getStage(layout: PipelineLayout, stage: PipelineStageId): PipelineStageManifest | undefined {
  return readPipelineManifest(layout)?.stages[stage];
}

export function getParseStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'parse');
}

export function getLinesStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'lines');
}

export function getSignalsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'signals');
}

export function getAmbiguityStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'ambiguity');
}

export function getTreeStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'tree');
}

export function getChunksStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'chunks');
}

export function getKeywordsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'keywords');
}

export function getVectorsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'vectors');
}

export function getEntitiesStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'entities');
}

export async function isParseCacheValid(layout: PipelineLayout): Promise<boolean> {
  return isStageCacheValid(layout, 'parse');
}

export async function isStageCacheValid(layout: PipelineLayout, stage: PipelineStageId): Promise<boolean> {
  const manifestStage = getStage(layout, stage);
  if (!manifestStage || manifestStage.status !== 'SUCCEEDED' || manifestStage.stageKey !== stageKey(layout, stage)) return false;
  if (!manifestStage.outputs) return false;
  for (const fileName of stageOutputNames(layout, stage)) {
    const output = manifestStage.outputs[fileName];
    if (!output) return false;
    const target = path.join(stageDirectory(layout, stage), fileName);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== output.bytes) return false;
      if ((await hashFile(target)).sha256 !== output.sha256) return false;
    } catch {
      return false;
    }
  }
  if (stage === 'parse' && !(await areParseImagesValid(layout))) return false;
  return true;
}

const parseImageNamePattern = /^images\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u;

/** 图片不在固定产物清单里，单独按 images-manifest.json 逐张校验；库内来源还需比对源图快照。 */
async function areParseImagesValid(layout: PipelineLayout): Promise<boolean> {
  const stageDir = stageDirectory(layout, 'parse');
  const manifest = readParseImagesManifest(stageDir);
  if (!manifest) return false;
  for (const record of manifest.images) {
    if (!parseImageNamePattern.test(record.relativePath)) return false;
    const target = path.join(stageDir, record.relativePath);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== record.bytes) return false;
      if ((await hashFile(target)).sha256 !== record.sha256) return false;
    } catch {
      return false;
    }
    const origin = record.origin;
    if (origin && origin.kind === 'library-copy' && origin.sourceRelativePath) {
      try {
        const sourceStat = fs.statSync(path.join(layout.libraryPath, origin.sourceRelativePath));
        if (sourceStat.size !== origin.sourceSizeBytes || Math.floor(sourceStat.mtimeMs) !== origin.sourceMtimeMs) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

/** 只比较 manifest 的阶段键，供同步状态读取识别“旧 SUCCEEDED”。 */
export function isStageManifestCurrent(layout: PipelineLayout, stage: PipelineStageId): boolean {
  const manifestStage = getStage(layout, stage);
  return Boolean(manifestStage && manifestStage.status === 'SUCCEEDED' && manifestStage.stageKey === stageKey(layout, stage));
}

export function parseStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'parse');
}

export function linesStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'lines');
}

export function signalsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'signals');
}

export function ambiguityStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'ambiguity');
}

export function treeStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'tree');
}

export function chunksStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'chunks');
}

export function keywordsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'keywords');
}

export function vectorsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'vectors');
}

export function entitiesStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'entities');
}

/** 文件缓存有效还不够；vectors 必须同时与锁定 profile 和 SQLite 投影事实一致。 */
export function isVectorProjectionCurrent(layout: PipelineLayout): boolean {
  const stage = getVectorsStage(layout);
  if (!stage || stage.status !== 'SUCCEEDED' || stage.stageKey !== vectorsStageKey(layout)) return false;
  const reportPath = path.join(layout.vectorsDirectory, 'vector-report.json');
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      documentId?: string;
      stageKey?: string;
      profileHash?: string;
      dimension?: number;
      distanceMetric?: string;
      counts?: { chunks?: number };
    };
    if (report.documentId !== layout.document.id
      || report.stageKey !== vectorsStageKey(layout)
      || report.profileHash !== layout.vectorProfileHash
      || report.distanceMetric !== 'cosine'
      || !Number.isInteger(report.dimension) || Number(report.dimension) <= 0) return false;
    const expectedChunks = Number(report.counts?.chunks);
    if (!Number.isInteger(expectedChunks) || expectedChunks < 0) return false;
    return isMaterialVectorProjectionCurrent({
      libraryPath: layout.libraryPath,
      documentId: layout.documentId,
      profileHash: layout.vectorProfileHash,
      expectedChunks,
    });
  } catch {
    return false;
  }
}

function stageKey(layout: PipelineLayout, stage: PipelineStageId): string {
  const inputArtifactHash = stage === 'parse'
    ? layout.document.contentHash
    : stage === 'lines' ? parseStageKey(layout)
      : stage === 'signals' ? linesStageKey(layout)
        : stage === 'ambiguity' ? signalsStageKey(layout)
          : stage === 'tree' ? ambiguityStageKey(layout)
            : stage === 'chunks' ? treeStageKey(layout)
              : stage === 'keywords' ? chunksStageKey(layout)
                : stage === 'entities' ? chunksStageKey(layout) : keywordsStageKey(layout);
  const configHash = stage === 'signals'
    ? `${layout.pipelineFingerprint}:${signalRuleVersion}`
    : stage === 'ambiguity' ? layout.ambiguityConfigHash : stage === 'chunks' ? (layout.chunkingV2Enabled ? layout.chunkingConfigHash : layout.structureConfigHash) : stage === 'keywords' ? layout.keywordConfigHash : stage === 'entities' ? layout.entitiesConfigHash : layout.pipelineFingerprint;
  const vectorProfileHash = stage === 'vectors' ? layout.vectorProfileHash : undefined;
  return crypto.createHash('sha256').update(JSON.stringify({
    sourceContentHash: layout.document.contentHash,
    stage,
    inputArtifactHash,
    configHash,
    ...(vectorProfileHash ? { vectorProfileHash } : {}),
    engineVersion: stage === 'parse'
      ? layout.engine
      : stage === 'ambiguity'
        ? 'electron-ambiguity-p4'
        : stage === 'chunks' ? (layout.chunkingV2Enabled ? 'worker-chunks-v3' : 'worker-chunks-p5')
          : stage === 'entities' ? 'worker-entities-v2'
            : stage === 'tree' || stage === 'keywords' ? `worker-${stage}-p5`
            : stage === 'vectors' ? 'electron-vectors-p1' : stage === 'lines' ? 'worker-lines-p4' : `worker-${stage}-p3`,
    protocolVersion: 1,
    schemaVersion: 1,
  })).digest('hex');
}

/**
 * 将指定阶段及其所有下游标记为待重跑，同时保留旧正式目录，等待新阶段
 * 原子提交后再由现有 orphan 清理策略处理。上游（例如 tree）不受影响。
 */
export function invalidateStageAndDownstream(layout: PipelineLayout, fromStage: PipelineStageId): PipelineManifest {
  const manifest = createOrReadManifest(layout);
  const startIndex = stageOrder.indexOf(fromStage);
  if (startIndex < 0) throw new Error(`未知流水线阶段：${fromStage}`);
  const now = new Date().toISOString();
  for (const stage of stageOrder.slice(startIndex)) {
    const current = manifest.stages[stage];
    if (!current && stage !== fromStage) continue;
    manifest.stages[stage] = {
      stageKey: stageKey(layout, stage),
      status: 'IDLE',
      updatedAt: now,
    };
  }
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return manifest;
}

export function markParseState(layout: PipelineLayout, status: PipelineStageState, error?: PipelineError, jobId?: string): PipelineStageManifest {
  return markStageState(layout, 'parse', status, error, jobId);
}

export function markStageState(layout: PipelineLayout, stage: PipelineStageId, status: PipelineStageState, error?: PipelineError, jobId?: string): PipelineStageManifest {
  const manifest = createOrReadManifest(layout);
  const now = new Date().toISOString();
  const current = manifest.stages[stage];
  const next: PipelineStageManifest = {
    stageKey: stageKey(layout, stage),
    status,
    artifactPath: current?.artifactPath,
    startedAt: status === 'RUNNING' ? now : current?.startedAt,
    finishedAt: status === 'SUCCEEDED' ? now : current?.finishedAt,
    updatedAt: now,
    counts: current?.counts,
    outputs: current?.outputs,
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
  };
  manifest.stages[stage] = next;
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return next;
}

export function createParseTempDirectory(layout: PipelineLayout, jobId: string): string {
  return createStageTempDirectory(layout, 'parse', jobId);
}

export function createStageTempDirectory(layout: PipelineLayout, stage: PipelineStageId, jobId: string): string {
  const existing = findStageTempDirectory(layout, stage);
  if (existing) return existing;
  const directory = path.join(layout.documentRoot, `.${stageDirectoryName(stage)}.tmp-${jobId}`);
  fs.mkdirSync(directory, { recursive: false });
  return directory;
}

export function findStageTempDirectory(layout: PipelineLayout, stage: PipelineStageId): string | null {
  if (!fs.existsSync(layout.documentRoot)) return null;
  const prefix = `.${stageDirectoryName(stage)}.tmp-`;
  const candidates = fs.readdirSync(layout.documentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(layout.documentRoot, entry.name))
    .sort()
    .reverse();
  return candidates[0] ?? null;
}

export async function commitParseStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'parse', tempDirectory);
}

export async function commitLinesStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'lines', tempDirectory);
}

export async function commitSignalsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'signals', tempDirectory);
}

export async function commitAmbiguityStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'ambiguity', tempDirectory);
}

export async function commitTreeStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'tree', tempDirectory);
}

export async function commitChunksStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'chunks', tempDirectory);
}

export async function commitKeywordsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'keywords', tempDirectory);
}

export async function commitVectorsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'vectors', tempDirectory);
}

export async function commitEntitiesStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'entities', tempDirectory);
}

export async function commitStage(layout: PipelineLayout, stage: PipelineStageId, tempDirectory: string): Promise<StageCommitResult> {
  const outputs: NonNullable<PipelineStageManifest['outputs']> = {};
  for (const fileName of stageOutputNames(layout, stage)) {
    const filePath = path.join(tempDirectory, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`阶段产物缺失：${fileName}`);
    outputs[fileName] = { relativePath: fileName, ...(await hashFile(filePath)) };
  }
  const reportName = stage === 'parse'
    ? 'parse-report.json'
    : stage === 'lines' ? 'lines-report.json' : stage === 'signals' ? 'signal-report.json' : stage === 'ambiguity' ? 'ambiguity-report.json' : stage === 'tree' ? 'tree-report.json' : stage === 'chunks' ? 'chunks-report.json' : stage === 'entities' ? 'extraction-report.json' : 'keyword-report.json';
  const resolvedReportName = stage === 'vectors' ? 'vector-report.json' : reportName;
  const report = JSON.parse(fs.readFileSync(path.join(tempDirectory, resolvedReportName), 'utf8')) as { counts?: Record<string, number> };
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  atomicWriteJson(path.join(tempDirectory, 'stage-manifest.json'), {
    schemaVersion: 1,
    stage,
    stageKey: stageKey(layout, stage),
    outputs,
    counts,
    validatedAt: new Date().toISOString(),
  });

  const targetDirectory = stageDirectory(layout, stage);
  if (fs.existsSync(targetDirectory)) {
    const orphaned = path.join(layout.documentRoot, `.${stageDirectoryName(stage)}.orphaned-${Date.now()}`);
    await renameDirectoryWithRetry(targetDirectory, orphaned);
  }
  await moveDirectoryIntoPlace(tempDirectory, targetDirectory);
  fs.mkdirSync(layout.checkpointDirectory, { recursive: true });
  atomicWriteJson(path.join(layout.checkpointDirectory, `stage-${stage}.json`), {
    schemaVersion: 1,
    stage,
    stageKey: stageKey(layout, stage),
    status: 'SUCCEEDED',
    counts,
    updatedAt: new Date().toISOString(),
  });

  const manifest = createOrReadManifest(layout);
  const now = new Date().toISOString();
  manifest.stages[stage] = {
    stageKey: stageKey(layout, stage),
    status: 'SUCCEEDED',
    artifactPath: path.relative(layout.libraryPath, targetDirectory).replace(/\\/g, '/'),
    startedAt: manifest.stages[stage]?.startedAt,
    finishedAt: now,
    updatedAt: now,
    counts,
    outputs,
  };
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return { artifactPath: targetDirectory, outputs, counts };
}

export function cleanupParseTempDirectory(tempDirectory: string): void {
  cleanupStageTempDirectory(tempDirectory);
}

export function cleanupStageTempDirectory(tempDirectory: string): void {
  if (fs.existsSync(tempDirectory)) fs.rmSync(tempDirectory, { recursive: true, force: true });
}

/** 删除文档对应的全部流水线缓存，包括不同源 hash、配置指纹和临时目录。 */
export function removePipelineArtifacts(libraryPath: string, documentId: string): void {
  const root = pipelineRoot(libraryPath);
  const documentRoot = path.join(root, safeSegment(documentId));
  const relativePath = path.relative(root, documentRoot);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('流水线产物路径越界。');
  }
  if (fs.existsSync(documentRoot)) fs.rmSync(documentRoot, { recursive: true, force: true });
}

export function recoverRunningStages(libraryPath: string): void {
  const root = pipelineRoot(libraryPath);
  if (!fs.existsSync(root)) return;
  for (const documentEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!documentEntry.isDirectory()) continue;
    const documentRoot = path.join(root, documentEntry.name);
    for (const hashEntry of fs.readdirSync(documentRoot, { withFileTypes: true })) {
      if (!hashEntry.isDirectory()) continue;
      const hashRoot = path.join(documentRoot, hashEntry.name);
      for (const fingerprintEntry of fs.readdirSync(hashRoot, { withFileTypes: true })) {
        if (!fingerprintEntry.isDirectory()) continue;
        const manifestPath = path.join(hashRoot, fingerprintEntry.name, 'pipeline-manifest.json');
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PipelineManifest;
          let changed = false;
          const now = new Date().toISOString();
          for (const stage of ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'] as const) {
            if (manifest.stages?.[stage]?.status !== 'RUNNING') continue;
            const current = manifest.stages[stage]!;
            manifest.stages[stage] = {
              ...current,
              status: 'INTERRUPTED',
              updatedAt: now,
              error: { code: 'WORKER_INTERRUPTED', message: '应用上次退出时阶段尚未完成，可从 checkpoint 继续。', retryable: true },
            };
            changed = true;
          }
          if (changed) {
            manifest.updatedAt = now;
            atomicWriteJson(manifestPath, manifest);
          }
        } catch {
          // 破损的缓存不覆盖其他成功缓存，下一次处理会重新创建当前指纹。
        }
      }
    }
  }
}

function stageDirectoryName(stage: PipelineStageId): string {
  if (stage === 'parse') return '01-parse';
  if (stage === 'lines') return '02-lines';
  if (stage === 'signals') return '03-signals';
  if (stage === 'ambiguity') return '04-ambiguity';
  if (stage === 'tree') return '05-tree';
  if (stage === 'chunks') return '06-chunks';
  if (stage === 'keywords') return '07-keywords';
  if (stage === 'entities') return '09-entities';
  return '08-vectors';
}

const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

/**
 * 目录原子改名带指数退避重试，吸收 Windows 上瞬态句柄锁。
 * happy path 首次 renameSync 即成功返回，重试仅在命中瞬态锁时触发。
 */
async function renameDirectoryWithRetry(from: string, to: string, attempts = 6, baseDelayMs = 20, maxDelayMs = 150): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts - 1 || !code || !RENAME_RETRYABLE_CODES.has(code)) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * 把阶段临时目录提交为正式目录。首选整目录原子改名；但 Windows 上杀毒/索引器
 * 在写入图片后会对新建目录树发起实时扫描，以目录句柄锁住 temp 本体，使整目录
 * 改名持续 EPERM（实测可超 27s），但其子项（文件与子目录）仍可改名。此时降级
 * 为逐项搬运到正式目录，避免提交因外部扫描而失败；阶段在 manifest 标记 SUCCEEDED
 * 前不被视为有效，故搬运中途的部分可见是安全的。
 */
async function moveDirectoryIntoPlace(from: string, to: string): Promise<void> {
  try {
    await renameDirectoryWithRetry(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !RENAME_RETRYABLE_CODES.has(code)) throw error;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    await renameDirectoryWithRetry(path.join(from, entry), path.join(to, entry));
  }
  fs.rmSync(from, { recursive: true, force: true });
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    bytes += Buffer.byteLength(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}
