import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GraphEntityVectorNeighbor } from './graphVectorIndex';

export const ALIAS_ARBITRATION_SCHEMA_VERSION = 1;
/** 余弦相似度阈值：1 - cosine distance；低于该值不进入裁决（方案 §4.6 先召回后裁决）。 */
export const ARBITRATION_COSINE_THRESHOLD = 0.86;
/** 每个待判定实体的候选上限。 */
export const ARBITRATION_MAX_CANDIDATES = 5;
/** 低于该置信度的裁决不合并，写入 pending 清单。 */
export const ARBITRATION_MIN_CONFIDENCE = 70;

export const ALIAS_DECISIONS_FILE_NAME = 'alias-decisions.jsonl';
export const ALIAS_MAP_FILE_NAME = 'alias-map.json';
/** 裁决缓存放图根目录的普通文件：commitLibraryGraph 只清理目录，文件可跨图重建存活。 */
export const ALIAS_ARBITRATION_CACHE_FILE_NAME = 'alias-arbitration-cache.jsonl';

export interface AliasEntityProfile {
  mention: string;
  type: string;
  description: string;
}

export interface AliasCandidate extends AliasEntityProfile {
  candidateKey: string;
  similarity: number;
}

export interface AliasArbitrationGroup {
  sourceKey: string;
  source: AliasEntityProfile;
  candidates: AliasCandidate[];
}

export interface AliasDecision {
  candidateKey: string;
  merge: boolean;
  canonicalKey: string;
  confidence: number;
  reason: string;
}

export interface AliasDecisionRecord {
  schemaVersion: 1;
  cacheKey: string;
  graphKey: string;
  sourceKey: string;
  candidates: AliasCandidate[];
  decisions: AliasDecision[];
  status: 'merged' | 'pending' | 'failed';
  canonicalKey: string;
  reason: string;
  modelFingerprint: string;
  /** 从缓存复用的裁决（本次重建未再调用模型）。 */
  reused?: boolean;
  decidedAt: string;
}

export interface AliasArbitrateResult {
  records: AliasDecisionRecord[];
  aliasMap: Record<string, string>;
}

/** 候选过滤：排除自身、类型不同、相似度不足者；按相似度降序取上限内。 */
export function filterAliasCandidates(
  neighbors: GraphEntityVectorNeighbor[],
  input: { sourceKey: string; type: string },
): AliasCandidate[] {
  return neighbors
    .filter((neighbor) => neighbor.canonicalKey !== input.sourceKey && neighbor.type === input.type)
    .map((neighbor) => ({
      candidateKey: neighbor.canonicalKey,
      mention: neighbor.mention,
      type: neighbor.type,
      description: '',
      similarity: 1 - neighbor.distance,
    }))
    .filter((candidate) => candidate.similarity >= ARBITRATION_COSINE_THRESHOLD)
    .sort((first, second) => second.similarity - first.similarity)
    .slice(0, ARBITRATION_MAX_CANDIDATES);
}

export function computeAliasGroupFingerprint(group: AliasArbitrationGroup): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
    sourceKey: group.sourceKey,
    source: group.source,
    candidates: [...group.candidates].sort((first, second) => first.candidateKey.localeCompare(second.candidateKey)),
  })).digest('hex');
}

/** 缓存键 = sha256(候选组指纹 + 模型指纹)：已裁决组重建时不重复调用。 */
export function computeAliasGroupCacheKey(input: { groupFingerprint: string; modelFingerprint: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
    groupFingerprint: input.groupFingerprint,
    modelFingerprint: input.modelFingerprint,
  })).digest('hex');
}

/** 裁决请求文本：结构化 JSON，模型输出契约见 pipelineLlmCoordinator 的 graph-alias-arbitration prompt。 */
export function buildArbitrationPayload(group: AliasArbitrationGroup): string {
  return JSON.stringify({
    source: { key: group.sourceKey, ...group.source },
    candidates: group.candidates.map((candidate) => ({ key: candidate.candidateKey, mention: candidate.mention, type: candidate.type, description: candidate.description, similarity: Number(candidate.similarity.toFixed(4)) })),
  });
}

/** 强契约：只接受严格 JSON；结构或字段校验失败返回 null（该组记痕跳过，不做宽松回退，因影响落库）。 */
export function parseArbitrationOutput(rawOutput: string): AliasDecision[] | null {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decisions = (value as Record<string, unknown>).decisions;
  if (!Array.isArray(decisions)) return null;
  const parsed: AliasDecision[] = [];
  for (const item of decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.candidateKey !== 'string' || !candidate.candidateKey) return null;
    if (typeof candidate.merge !== 'boolean') return null;
    if (typeof candidate.canonicalKey !== 'string' || !candidate.canonicalKey) return null;
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 100) return null;
    parsed.push({
      candidateKey: candidate.candidateKey,
      merge: candidate.merge,
      canonicalKey: candidate.canonicalKey,
      confidence: Math.floor(candidate.confidence),
      reason: typeof candidate.reason === 'string' ? candidate.reason : '',
    });
  }
  return parsed;
}

/** 从裁决结果解析合并结论：canonicalKey 必须落在组内键上；低置信或无合并 → pending。 */
export function resolveAliasDecision(group: AliasArbitrationGroup, decisions: AliasDecision[]): { status: AliasDecisionRecord['status']; canonicalKey: string; reason: string } {
  const validKeys = new Set([group.sourceKey, ...group.candidates.map((candidate) => candidate.candidateKey)]);
  const merges = decisions
    .filter((decision) => decision.merge && decision.canonicalKey && validKeys.has(decision.canonicalKey)
      && (decision.canonicalKey === group.sourceKey || group.candidates.some((candidate) => candidate.candidateKey === decision.candidateKey)))
    .sort((first, second) => second.confidence - first.confidence);
  const best = merges[0];
  if (!best) return { status: 'pending', canonicalKey: '', reason: '裁决未给出有效合并决定' };
  if (best.confidence < ARBITRATION_MIN_CONFIDENCE) {
    return { status: 'pending', canonicalKey: '', reason: `置信度 ${best.confidence} 低于 ${ARBITRATION_MIN_CONFIDENCE}，待人工复核` };
  }
  return { status: 'merged', canonicalKey: best.canonicalKey, reason: best.reason };
}

export interface ArbitrateAliasGroupsInput {
  groups: AliasArbitrationGroup[];
  graphKey: string;
  modelFingerprint: string;
  callArbitrate: (text: string) => Promise<string>;
  /** 已有裁决缓存（cacheKey → record）；命中的组不再调用模型。 */
  existingCache?: Map<string, AliasDecisionRecord>;
  signal?: AbortSignal;
}

/** 逐组裁决：缓存命中复用；解析失败记痕跳过；低置信进 pending。串行调用，保证审计顺序确定。 */
export async function arbitrateAliasGroups(input: ArbitrateAliasGroupsInput): Promise<{ result: AliasArbitrateResult; newRecords: AliasDecisionRecord[] }> {
  const records: AliasDecisionRecord[] = [];
  const newRecords: AliasDecisionRecord[] = [];
  const aliasMap: Record<string, string> = {};
  for (const group of input.groups) {
    if (input.signal?.aborted) break;
    const cacheKey = computeAliasGroupCacheKey({ groupFingerprint: computeAliasGroupFingerprint(group), modelFingerprint: input.modelFingerprint });
    const cached = input.existingCache?.get(cacheKey);
    if (cached) {
      records.push({ ...cached, graphKey: input.graphKey, reused: true });
      if (cached.status === 'merged' && cached.canonicalKey && cached.canonicalKey !== group.sourceKey) {
        aliasMap[group.sourceKey] = cached.canonicalKey;
      }
      continue;
    }
    let rawOutput = '';
    try {
      rawOutput = await input.callArbitrate(buildArbitrationPayload(group));
    } catch {
      rawOutput = '';
    }
    const decisions = rawOutput ? parseArbitrationOutput(rawOutput) : null;
    const resolved = decisions ? resolveAliasDecision(group, decisions) : { status: 'failed' as const, canonicalKey: '', reason: '裁决输出不符合严格 JSON 契约，已跳过' };
    const record: AliasDecisionRecord = {
      schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
      cacheKey,
      graphKey: input.graphKey,
      sourceKey: group.sourceKey,
      candidates: group.candidates,
      decisions: decisions ?? [],
      status: resolved.status,
      canonicalKey: resolved.canonicalKey,
      reason: resolved.reason,
      modelFingerprint: input.modelFingerprint,
      decidedAt: new Date().toISOString(),
    };
    records.push(record);
    newRecords.push(record);
    if (record.status === 'merged' && record.canonicalKey && record.canonicalKey !== group.sourceKey) {
      aliasMap[group.sourceKey] = record.canonicalKey;
    }
  }
  return { result: { records, aliasMap }, newRecords };
}

/** 读取追加式裁决缓存；坏行跳过（缓存缺失只导致重复裁决，不影响正确性）。 */
export function readAliasArbitrationCache(cachePath: string): Map<string, AliasDecisionRecord> {
  const cache = new Map<string, AliasDecisionRecord>();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AliasDecisionRecord;
      if (record && typeof record.cacheKey === 'string' && record.cacheKey) cache.set(record.cacheKey, record);
    } catch {
      continue;
    }
  }
  return cache;
}

export function appendAliasArbitrationCache(cachePath: string, records: AliasDecisionRecord[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

/** 审计产物：裁决明细（含候选、理由、模型指纹）+ 本次生效的别名映射。 */
export function writeAliasArtifacts(directory: string, records: AliasDecisionRecord[], aliasMap: Record<string, string>): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ALIAS_DECISIONS_FILE_NAME), records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(directory, ALIAS_MAP_FILE_NAME), JSON.stringify(aliasMap, null, 2), 'utf8');
}

/** 读取各 entities 产物，按 canonicalKey 去重聚合（与 graph_stage 的首见语义对齐：保留首条 mention/type）。 */
export function loadEntitiesFromArtifactDirs(entries: ReadonlyArray<{ documentId: string; directory: string }>): Map<string, AliasEntityProfile> {
  const entities = new Map<string, AliasEntityProfile>();
  for (const entry of entries) {
    const entitiesPath = path.join(entry.directory, 'entities.jsonl');
    if (!fs.existsSync(entitiesPath)) continue;
    for (const line of fs.readFileSync(entitiesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const canonicalKey = typeof row.canonicalKey === 'string' ? row.canonicalKey.trim() : '';
      if (!canonicalKey || entities.has(canonicalKey)) continue;
      entities.set(canonicalKey, {
        mention: typeof row.mention === 'string' && row.mention ? row.mention : canonicalKey,
        type: typeof row.type === 'string' && row.type ? row.type : 'concept',
        description: typeof row.description === 'string' ? row.description : '',
      });
    }
  }
  return entities;
}

/**
 * Electron 侧预映射（Python 侧零改动）：把 aliasMap 应用到各文档的 entities/relations 产物，
 * 写入临时目录后把临时目录交给图阶段。映射后自环边直接丢弃，重复键交由 graph_stage 归并。
 */
export function applyAliasMapToEntitiesDirs(input: {
  entries: ReadonlyArray<{ documentId: string; directory: string }>;
  aliasMap: Record<string, string>;
  stagingRoot: string;
}): string[] {
  const resolveKey = (key: string): string => input.aliasMap[key] ?? key;
  const directories: string[] = [];
  for (const entry of input.entries) {
    const targetDirectory = path.join(input.stagingRoot, entry.documentId || `dir-${directories.length}`);
    fs.mkdirSync(targetDirectory, { recursive: true });
    const entityLines: string[] = [];
    for (const row of readJsonl(path.join(entry.directory, 'entities.jsonl'))) {
      const canonicalKey = typeof row.canonicalKey === 'string' ? row.canonicalKey : '';
      entityLines.push(JSON.stringify({ ...row, canonicalKey: resolveKey(canonicalKey) }));
    }
    fs.writeFileSync(path.join(targetDirectory, 'entities.jsonl'), entityLines.join('\n') + (entityLines.length ? '\n' : ''), 'utf8');
    const relationLines: string[] = [];
    for (const row of readJsonl(path.join(entry.directory, 'relations.jsonl'))) {
      const sourceKey = resolveKey(typeof row.sourceKey === 'string' ? row.sourceKey : '');
      const targetKey = resolveKey(typeof row.targetKey === 'string' ? row.targetKey : '');
      if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
      relationLines.push(JSON.stringify({ ...row, sourceKey, targetKey }));
    }
    fs.writeFileSync(path.join(targetDirectory, 'relations.jsonl'), relationLines.join('\n') + (relationLines.length ? '\n' : ''), 'utf8');
    const reportPath = path.join(entry.directory, 'extraction-report.json');
    if (fs.existsSync(reportPath)) fs.copyFileSync(reportPath, path.join(targetDirectory, 'extraction-report.json'));
    directories.push(targetDirectory);
  }
  return directories;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return rows;
}
