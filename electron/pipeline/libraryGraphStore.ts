import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryLeidenConfig } from './types';
import { PipelineStageError } from './stageErrors';

/** Worker 侧图装配协议/产物 schema 版本，参与 graphKey 计算（方案 §3.2）。
 * graph-v3：LLM strength 改为均值聚合，并持久化 PMI 与独立支持计数。 */
export const WORKER_GRAPH_SCHEMA_VERSION = 'graph-v3';

/** 与 Python `graph_leiden.DEFAULT_LEIDEN_CONFIG` 保持一致；改任一侧必须同步。 */
export const DEFAULT_LIBRARY_LEIDEN_CONFIG: LibraryLeidenConfig = {
  resolution: 1.0,
  maxDepth: 4,
  minSplitSize: 3,
  seed: 42,
};

export interface LibraryGraphReport {
  schemaVersion: number;
  stage: string;
  graphKey: string;
  stageKey: string;
  engine: string;
  leidenConfig: LibraryLeidenConfig;
  counts: { nodes: number; edges: number; communities: number; levels: number; chunkEdges: number };
  communitiesByLevel: Record<string, number>;
  modularityLevel0: number | null;
  sourceDocuments: string[];
  /** 权重公式配置：完整保留用于审计与离线调参。 */
  weightConfig: Record<string, unknown>;
  /** 权重公式版本；旧 report 缺省为空串。 */
  weightVersion: string;
  durationMs: number;
  generatedAt: string;
}

/** 归一化 Leiden 配置，边界与 Python `normalize_leiden_config` 完全一致。 */
export function normalizeLibraryLeidenConfig(candidate?: unknown): LibraryLeidenConfig {
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {};
  const resolutionCandidate = source.resolution;
  const resolution = typeof resolutionCandidate === 'number' && Number.isFinite(resolutionCandidate)
    && resolutionCandidate >= 0.1 && resolutionCandidate <= 10.0
    ? resolutionCandidate
    : DEFAULT_LIBRARY_LEIDEN_CONFIG.resolution;
  return {
    resolution,
    maxDepth: boundedInteger(source.maxDepth, DEFAULT_LIBRARY_LEIDEN_CONFIG.maxDepth, 1, 8),
    minSplitSize: boundedInteger(source.minSplitSize, DEFAULT_LIBRARY_LEIDEN_CONFIG.minSplitSize, 2, 100),
    seed: Number.isInteger(source.seed) ? (source.seed as number) : DEFAULT_LIBRARY_LEIDEN_CONFIG.seed,
  };
}

/**
 * graphKey = hash(全部 entities stageKey 集合 + leidenConfig 版本 + workerGraphSchemaVersion)（方案 §3.2）。
 * 同一输入集合与配置必然得到同一 graphKey，作为库级图缓存命中的判据。
 */
export function computeLibraryGraphKey(input: { entitiesStageKeys: readonly string[]; leidenConfig?: unknown; aliasArbitrationEnabled?: boolean }): string {
  const stageKeys = [...new Set(input.entitiesStageKeys.filter((key) => typeof key === 'string' && key.trim()))].sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: WORKER_GRAPH_SCHEMA_VERSION,
    entitiesStageKeys: stageKeys,
    leidenConfig: normalizeLibraryLeidenConfig(input.leidenConfig),
    aliasArbitrationEnabled: input.aliasArbitrationEnabled === true,
  })).digest('hex');
}

export function libraryGraphRoot(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'graph');
}

export function libraryGraphDirectory(libraryPath: string, graphKey: string): string {
  assertGraphKey(graphKey);
  return path.join(libraryGraphRoot(libraryPath), graphKey);
}

/** Worker 写入用临时目录；提交前不存在正式目录，失败可安全清理。 */
export function createLibraryGraphStagingDirectory(libraryPath: string, graphKey: string, jobId: string): string {
  assertGraphKey(graphKey);
  const root = libraryGraphRoot(libraryPath);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, `.staging-${graphKey}-${safeJobId(jobId)}`);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: false });
  return staging;
}

/**
 * 原子提交：校验产物齐全后把临时目录改名为 `.menghan-meta/graph/<graphKey>`，
 * 并清理其他 graphKey 的旧目录（缓存键变化后旧图不再有效）。
 */
export function commitLibraryGraph(libraryPath: string, graphKey: string, stagingDirectory: string): string {
  assertGraphKey(graphKey);
  for (const fileName of ['graph.jsonl', 'communities.jsonl', 'chunk_edges.jsonl', 'graph-report.json']) {
    const filePath = path.join(stagingDirectory, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new PipelineStageError('GRAPH_COMMIT_FAILED', `图谱产物缺失，无法提交：${fileName}`, true);
    }
  }
  const report = readLibraryGraphReportFromDirectory(stagingDirectory);
  if (!report || report.graphKey !== graphKey) {
    throw new PipelineStageError('GRAPH_COMMIT_FAILED', 'graph-report.json 的 graphKey 与目标不一致，拒绝提交。', true);
  }
  const destination = libraryGraphDirectory(libraryPath, graphKey);
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  try {
    fs.renameSync(stagingDirectory, destination);
  } catch (error) {
    throw new PipelineStageError('GRAPH_COMMIT_FAILED', `图谱产物提交失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
  pruneLibraryGraphRoot(libraryPath, graphKey);
  return destination;
}

/** 读取已提交图目录的 graph-report.json；目录或报告缺失返回 null。 */
export function readLibraryGraphReport(libraryPath: string, graphKey: string): LibraryGraphReport | null {
  try {
    return readLibraryGraphReportFromDirectory(libraryGraphDirectory(libraryPath, graphKey));
  } catch {
    return null;
  }
}

export function readLibraryGraphReportFromDirectory(directory: string): LibraryGraphReport | null {
  const reportPath = path.join(directory, 'graph-report.json');
  if (!fs.existsSync(reportPath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.graphKey !== 'string' || typeof candidate.engine !== 'string') return null;
  const counts = candidate.counts as Record<string, unknown> | undefined;
  if (!counts || typeof counts !== 'object') return null;
  const weightConfig = candidate.weightConfig && typeof candidate.weightConfig === 'object' && !Array.isArray(candidate.weightConfig)
    ? { ...(candidate.weightConfig as Record<string, unknown>) }
    : {};
  return {
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0,
    stage: typeof candidate.stage === 'string' ? candidate.stage : 'graph',
    graphKey: candidate.graphKey,
    stageKey: typeof candidate.stageKey === 'string' ? candidate.stageKey : '',
    engine: candidate.engine,
    leidenConfig: normalizeLibraryLeidenConfig(candidate.leidenConfig),
    counts: {
      nodes: toCount(counts.nodes),
      edges: toCount(counts.edges),
      communities: toCount(counts.communities),
      levels: toCount(counts.levels),
      chunkEdges: toCount(counts.chunkEdges),
    },
    communitiesByLevel: candidate.communitiesByLevel && typeof candidate.communitiesByLevel === 'object' && !Array.isArray(candidate.communitiesByLevel)
      ? Object.fromEntries(Object.entries(candidate.communitiesByLevel as Record<string, unknown>).map(([level, count]) => [level, toCount(count)]))
      : {},
    modularityLevel0: typeof candidate.modularityLevel0 === 'number' ? candidate.modularityLevel0 : null,
    sourceDocuments: Array.isArray(candidate.sourceDocuments) ? candidate.sourceDocuments.filter((item): item is string => typeof item === 'string') : [],
    weightConfig,
    weightVersion: String(weightConfig.version ?? ''),
    durationMs: toCount(candidate.durationMs),
    generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : '',
  };
}

/** 只保留 keepGraphKey 对应的正式目录；清理旧图与残留 staging 目录。 */
function pruneLibraryGraphRoot(libraryPath: string, keepGraphKey: string): void {
  const root = libraryGraphRoot(libraryPath);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keepGraphKey) continue;
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function assertGraphKey(graphKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(graphKey)) {
    throw new PipelineStageError('GRAPH_COMMIT_FAILED', 'graphKey 无效，必须是 64 位十六进制哈希。', false);
  }
}

function safeJobId(jobId: string): string {
  const value = jobId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return value || 'job';
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
