import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokenCount } from '../knowledge/tokenEstimator';
import { atomicWriteJson } from './pathLayout';
import type { LibraryGraphEnhancementConfig } from './types';

/**
 * 社区摘要生成（GraphRAG 方案 §3.3）：库级图装配提交后由 Electron 侧批量小调用
 * 自底向上生成结构化摘要。LLM 调用经注入的 callSummary 发起（Worker 永不持钥），
 * strict JSON 失败走宽松回退，失败社区记痕跳过（best-effort，不阻塞图装配）。
 */

export const COMMUNITY_SUMMARY_SCHEMA_VERSION = 'community-summary-v1';
export const COMMUNITY_SUMMARIES_FILE_NAME = 'community-summaries.jsonl';
export const COMMUNITY_SUMMARY_REPORT_FILE_NAME = 'community-summary-report.json';
/** 批量小调用并发上限（方案 §3.3：并发 ≤3）。 */
export const SUMMARY_CALL_CONCURRENCY = 3;
const SUMMARY_KEY_POINTS_LIMIT = 6;
const SUMMARY_ENTITIES_LIMIT = 12;
const SUMMARY_TEXT_LIMIT = 1200;
const FAILURE_RAW_OUTPUT_LIMIT = 400;

export interface CommunitySummaryRecord {
  communityId: string;
  level: number;
  summary: string;
  keyPoints: string[];
  entities: string[];
  /** 摘要文本的估算 token 数（高层替换与全局检索装窗用）。 */
  tokens: number;
  /** 成员集合指纹（方案 §4.7 增量继承键）；旧产物可能缺失。 */
  memberFingerprint?: string;
  /** 重建时从旧图继承（成员未变的社区零调用复用）。 */
  inherited?: boolean;
}

export interface CommunitySummaryFailure {
  communityId: string;
  reason: string;
  rawOutput?: string;
}

export interface CommunitySummaryReport {
  schemaVersion: string;
  summaryKey: string;
  graphKey: string;
  promptVersion: string;
  fingerprint: string;
  budgetTokens: number;
  counts: { communities: number; summarized: number; inherited: number; levels: number };
  failures: CommunitySummaryFailure[];
  durationMs: number;
  generatedAt: string;
}

export interface GenerateCommunitySummariesInput {
  /** 已提交的 `.menghan-meta/graph/<graphKey>` 目录。 */
  graphDirectory: string;
  graphKey: string;
  config: LibraryGraphEnhancementConfig;
  /** 模型指纹（模型/endpoint/consent 任一变化即失效，方案 §3.1 缓存键口径）。 */
  fingerprint: string;
  /** 注入的 LLM 调用：输入装配好的社区上下文文本，返回模型原始输出。 */
  callSummary: (text: string) => Promise<string>;
  /** 重建时从旧图继承的摘要（成员指纹命中的社区）；已继承社区不再调用。 */
  preloaded?: CommunitySummaryRecord[];
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export interface GenerateCommunitySummariesResult {
  summaries: CommunitySummaryRecord[];
  report: CommunitySummaryReport;
}

/** summaryKey = hash(graphKey + 摘要 prompt 版本 + 模型指纹 + 预算)；leidenConfig 变化经 graphKey 传导。 */
export function computeCommunitySummaryKey(input: { graphKey: string; promptVersion: string; fingerprint: string; budgetTokens: number }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    graphKey: input.graphKey,
    promptVersion: input.promptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.budgetTokens,
  })).digest('hex');
}

export function communitySummaryArtifactsExist(graphDirectory: string): boolean {
  return fs.existsSync(path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME))
    && fs.existsSync(path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME));
}

/** 成员集合指纹 = sha256(sorted memberKeys + level)：图重建后成员未变的社区可沿用旧摘要（方案 §4.7）。 */
export function computeCommunityMemberFingerprint(memberKeys: readonly string[], level: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    level,
    memberKeys: [...new Set(memberKeys)].sort(),
  })).digest('hex');
}

export interface SummaryCommunityManifest {
  communityId: string;
  level: number;
  memberKeys: string[];
}

/**
 * 增量继承：新社区的成员指纹精确命中旧记录 → 沿用（保留原 summary/tokens，标记 inherited，
 * communityId 重映射为新社区）；未命中进待生成清单（由调用方交给 generateCommunitySummaries）。
 * 旧记录缺指纹（存量产物）或空摘要不参与继承；一条旧记录最多被一个新社区继承。
 */
export function inheritReusableSummaries(input: {
  oldRecords: CommunitySummaryRecord[];
  newCommunities: SummaryCommunityManifest[];
}): { preloaded: CommunitySummaryRecord[]; pending: SummaryCommunityManifest[] } {
  const byFingerprint = new Map<string, CommunitySummaryRecord>();
  for (const record of input.oldRecords) {
    if (record.memberFingerprint && record.summary.trim()) byFingerprint.set(record.memberFingerprint, record);
  }
  const preloaded: CommunitySummaryRecord[] = [];
  const pending: SummaryCommunityManifest[] = [];
  for (const community of input.newCommunities) {
    const fingerprint = computeCommunityMemberFingerprint(community.memberKeys, community.level);
    const reusable = byFingerprint.get(fingerprint);
    if (reusable) {
      byFingerprint.delete(fingerprint);
      preloaded.push({ ...reusable, communityId: community.communityId, level: community.level, memberFingerprint: fingerprint, inherited: true });
    } else {
      pending.push(community);
    }
  }
  return { preloaded, pending };
}

export function readCommunitySummaryReport(graphDirectory: string): CommunitySummaryReport | null {
  const reportPath = path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME);
  if (!fs.existsSync(reportPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as CommunitySummaryReport;
  } catch {
    return null;
  }
}

/** 缓存命中判定：summaryKey 一致且产物齐全。 */
export function isCommunitySummaryCurrent(graphDirectory: string, expectedSummaryKey: string): boolean {
  if (!communitySummaryArtifactsExist(graphDirectory)) return false;
  const report = readCommunitySummaryReport(graphDirectory);
  return Boolean(report && report.summaryKey === expectedSummaryKey);
}

export function readCommunitySummaryRecords(graphDirectory: string): CommunitySummaryRecord[] {
  const summariesPath = path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME);
  if (!fs.existsSync(summariesPath)) return [];
  const records: CommunitySummaryRecord[] = [];
  for (const line of fs.readFileSync(summariesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.communityId !== 'string' || typeof value.summary !== 'string') continue;
      records.push({
        communityId: value.communityId,
        level: typeof value.level === 'number' ? value.level : 0,
        summary: value.summary,
        keyPoints: toStringArray(value.keyPoints).slice(0, SUMMARY_KEY_POINTS_LIMIT),
        entities: toStringArray(value.entities).slice(0, SUMMARY_ENTITIES_LIMIT),
        tokens: typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? Math.max(0, Math.floor(value.tokens)) : estimateTokenCount(value.summary),
        ...(typeof value.memberFingerprint === 'string' && value.memberFingerprint ? { memberFingerprint: value.memberFingerprint } : {}),
        ...(value.inherited === true ? { inherited: true } : {}),
      });
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * 自底向上生成全部社区摘要并落产物。叶级按边（两端 degree 和降序）装预算上下文；
 * 高层先装子社区明细，超预算时按 token 降序用子社区摘要替换（论文 §3.1.5）。
 */
export async function generateCommunitySummaries(input: GenerateCommunitySummariesInput): Promise<GenerateCommunitySummariesResult> {
  const startedAt = Date.now();
  const graph = readGraphArtifactsForSummary(input.graphDirectory);
  const communities = readCommunitiesForSummary(input.graphDirectory);
  const summaryKey = computeCommunitySummaryKey({
    graphKey: input.graphKey,
    promptVersion: input.config.summaryPromptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.config.summaryBudgetTokens,
  });

  const failures: CommunitySummaryFailure[] = [];
  const summaries = new Map<string, CommunitySummaryRecord>();
  // 继承的摘要先入表：后续层级装配照常引用，不再为其发起调用。
  for (const record of input.preloaded ?? []) {
    if (record.summary.trim()) summaries.set(record.communityId, record);
  }
  const levels = communities.length > 0 ? Math.max(...communities.map((community) => community.level)) : 0;
  const childrenByParent = groupChildren(communities);

  // 自底向上：最细层（叶）先行，逐层向 level 0 汇总。
  for (let level = levels; level >= 0; level -= 1) {
    const layer = communities
      .filter((community) => community.level === level && !summaries.has(community.communityId))
      .sort((first, second) => first.communityId.localeCompare(second.communityId));
    if (layer.length === 0) continue;
    const texts = layer.map((community) => ({
      community,
      text: level === levels
        ? assembleLeafContext(community, graph)
        : assembleUpperLevelContext(community, childrenByParent.get(community.communityId) ?? [], summaries, graph),
    }));
    const generated = await runSummaryCalls(texts, input);
    for (const item of generated) {
      if (item.record) {
        summaries.set(item.community.communityId, item.record);
      } else {
        failures.push({
          communityId: item.community.communityId,
          reason: item.reason,
          ...(item.rawOutput !== undefined ? { rawOutput: item.rawOutput.slice(0, FAILURE_RAW_OUTPUT_LIMIT) } : {}),
        });
      }
    }
  }

  const records = [...summaries.values()].sort((first, second) => first.communityId.localeCompare(second.communityId));
  const report: CommunitySummaryReport = {
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    summaryKey,
    graphKey: input.graphKey,
    promptVersion: input.config.summaryPromptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.config.summaryBudgetTokens,
    counts: {
      communities: communities.length,
      summarized: records.length,
      inherited: records.filter((record) => record.inherited === true).length,
      levels: communities.length > 0 ? levels + 1 : 0,
    },
    failures,
    durationMs: Math.max(0, Date.now() - startedAt),
    generatedAt: new Date().toISOString(),
  };
  writeSummaryArtifacts(input.graphDirectory, records, report);
  return { summaries: records, report };
}

// ---------------------------------------------------------------------------
// 上下文装配
// ---------------------------------------------------------------------------

interface SummaryGraphNode {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
}

interface SummaryGraphEdge {
  sourceKey: string;
  targetKey: string;
  weight: number;
  kinds: string[];
  description: string;
}

interface SummaryCommunity {
  communityId: string;
  level: number;
  parentId: string;
  memberKeys: string[];
}

/** 叶级上下文：社区内边按 (source.degree+target.degree) 降序装入预算（方案 §3.3）。 */
function assembleLeafContext(community: SummaryCommunity, graph: { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] }): string {
  const members = new Set(community.memberKeys);
  const inner = graph.edges
    .filter((edge) => members.has(edge.sourceKey) && members.has(edge.targetKey))
    .map((edge) => ({ edge, rank: degreeOf(graph, edge.sourceKey) + degreeOf(graph, edge.targetKey) }))
    .sort((first, second) => second.rank - first.rank || first.edge.sourceKey.localeCompare(second.edge.sourceKey));
  const budgetLines: string[] = [];
  let tokens = 0;
  for (const { edge } of inner) {
    const line = describeEdge(edge, graph);
    const lineTokens = estimateTokenCount(line);
    if (budgetLines.length > 0 && tokens + lineTokens > 32_000) break;
    budgetLines.push(line);
    tokens += lineTokens;
  }
  // 无内部边的孤立成员社区：退化为成员描述清单，保证每层都有摘要素材。
  if (budgetLines.length === 0) {
    for (const key of community.memberKeys) {
      const node = graph.nodes.get(key);
      if (!node) continue;
      budgetLines.push(`实体「${node.mention}」（${node.type}）：${node.description || '无描述'}`);
    }
  }
  return budgetLines.join('\n');
}

/** 高层上下文：子社区明细装预算；超预算时按 token 降序用子社区摘要替换（论文 §3.1.5）。 */
function assembleUpperLevelContext(
  community: SummaryCommunity,
  children: SummaryCommunity[],
  summaries: Map<string, CommunitySummaryRecord>,
  graph: { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] },
): string {
  const items = children
    .map((child) => ({
      child,
      detail: assembleLeafContext(child, graph),
      summary: summaries.get(child.communityId),
    }))
    .sort((first, second) => first.child.communityId.localeCompare(second.child.communityId));
  const budgetTokens = 32_000;
  const useSummary = new Set<string>();
  let total = 0;
  const entryTokens = items.map((item) => ({
    item,
    detailTokens: estimateTokenCount(item.detail),
    summaryTokens: item.summary ? item.summary.tokens : Number.POSITIVE_INFINITY,
  }));
  for (const entry of entryTokens) total += entry.detailTokens;
  // 超预算：按明细 token 降序，把最大的明细替换为子社区摘要，直至装下。
  const overflow = [...entryTokens].sort((first, second) => second.detailTokens - first.detailTokens);
  for (const entry of overflow) {
    if (total <= budgetTokens) break;
    if (!entry.item.summary || entry.summaryTokens >= entry.detailTokens) continue;
    total = total - entry.detailTokens + entry.summaryTokens;
    useSummary.add(entry.item.child.communityId);
  }
  return items.map((item) => {
    const body = useSummary.has(item.child.communityId) && item.summary ? `子社区摘要：${item.summary.summary}` : item.detail;
    return `【子社区 ${item.child.communityId}】\n${body}`;
  }).join('\n\n');
}

function describeEdge(edge: SummaryGraphEdge, graph: { nodes: Map<string, SummaryGraphNode> }): string {
  const source = graph.nodes.get(edge.sourceKey);
  const target = graph.nodes.get(edge.targetKey);
  const sourceText = source ? `「${source.mention}」（${source.type}）${source.description ? `：${source.description}` : ''}` : edge.sourceKey;
  const targetText = target ? `「${target.mention}」（${target.type}）${target.description ? `：${target.description}` : ''}` : edge.targetKey;
  const kinds = edge.kinds.length > 0 ? edge.kinds.join('/') : '关联';
  return `${sourceText} —[${kinds}，权重 ${edge.weight}]→ ${targetText}${edge.description ? `；${edge.description}` : ''}`;
}

function degreeOf(graph: { nodes: Map<string, SummaryGraphNode> }, key: string): number {
  return graph.nodes.get(key)?.degree ?? 0;
}

// ---------------------------------------------------------------------------
// LLM 调用与解析（限并发 ≤3；宽松回退 + 失败记痕）
// ---------------------------------------------------------------------------

async function runSummaryCalls(
  items: Array<{ community: SummaryCommunity; text: string }>,
  input: GenerateCommunitySummariesInput,
): Promise<Array<{ community: SummaryCommunity; record?: CommunitySummaryRecord; reason?: string; rawOutput?: string }>> {
  const results: Array<{ community: SummaryCommunity; record?: CommunitySummaryRecord; reason?: string; rawOutput?: string }> = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  const runOne = async (): Promise<void> => {
    while (cursor < items.length) {
      if (input.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item.text.trim()) {
        results[index] = { community: item.community, reason: '社区无可用上下文（空成员）。' };
        completed += 1;
        input.onProgress?.(completed, items.length);
        continue;
      }
      let rawOutput: string | undefined;
      try {
        rawOutput = await input.callSummary(item.text);
        const parsed = parseSummaryOutput(rawOutput);
        if (!parsed) {
          results[index] = { community: item.community, reason: '摘要输出无法解析为约定结构。', rawOutput };
        } else {
          const summaryText = parsed.summary.slice(0, SUMMARY_TEXT_LIMIT);
          results[index] = {
            community: item.community,
            record: {
              communityId: item.community.communityId,
              level: item.community.level,
              summary: summaryText,
              keyPoints: parsed.keyPoints,
              entities: parsed.entities,
              tokens: estimateTokenCount(summaryText),
              memberFingerprint: computeCommunityMemberFingerprint(item.community.memberKeys, item.community.level),
            },
          };
        }
      } catch (error) {
        if (input.signal?.aborted) return;
        results[index] = { community: item.community, reason: error instanceof Error ? error.message : String(error), ...(rawOutput !== undefined ? { rawOutput } : {}) };
      }
      completed += 1;
      input.onProgress?.(completed, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SUMMARY_CALL_CONCURRENCY, items.length) }, () => runOne()));
  if (input.signal?.aborted) throw new Error('STAGE_CANCELLED');
  return results;
}

/** strict JSON 优先；失败时宽松回退：剥代码围栏、截取首个花括号块（轻量 JSON 小调用开发模式）。 */
export function parseSummaryOutput(raw: string): { summary: string; keyPoints: string[]; entities: string[] } | null {
  const candidates: string[] = [raw];
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/u, '').trim();
  if (fenced !== raw) candidates.push(fenced);
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(raw.slice(braceStart, braceEnd + 1));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) continue;
    return {
      summary,
      keyPoints: toStringArray(record.key_points ?? record.keyPoints).slice(0, SUMMARY_KEY_POINTS_LIMIT),
      entities: toStringArray(record.entities).slice(0, SUMMARY_ENTITIES_LIMIT),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 产物读写
// ---------------------------------------------------------------------------

function writeSummaryArtifacts(graphDirectory: string, records: CommunitySummaryRecord[], report: CommunitySummaryReport): void {
  const summariesPath = path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME);
  const tempPath = `${summariesPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${records.map((record) => JSON.stringify(record)).join('\n')}${records.length > 0 ? '\n' : ''}`, 'utf8');
  fs.renameSync(tempPath, summariesPath);
  atomicWriteJson(path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME), report);
}

function readGraphArtifactsForSummary(graphDirectory: string): { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] } {
  const nodes = new Map<string, SummaryGraphNode>();
  const edges: SummaryGraphEdge[] = [];
  const graphPath = path.join(graphDirectory, 'graph.jsonl');
  if (!fs.existsSync(graphPath)) return { nodes, edges };
  for (const line of fs.readFileSync(graphPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.kind === 'node' && typeof value.canonicalKey === 'string') {
      nodes.set(value.canonicalKey, {
        canonicalKey: value.canonicalKey,
        mention: typeof value.mention === 'string' && value.mention ? value.mention : value.canonicalKey,
        type: typeof value.type === 'string' ? value.type : 'concept',
        description: typeof value.description === 'string' ? value.description : '',
        degree: typeof value.degree === 'number' ? value.degree : 0,
      });
    } else if (value.kind === 'edge' && typeof value.sourceKey === 'string' && typeof value.targetKey === 'string') {
      edges.push({
        sourceKey: value.sourceKey,
        targetKey: value.targetKey,
        weight: typeof value.weight === 'number' ? value.weight : 1,
        kinds: toStringArray(value.kinds),
        description: typeof value.description === 'string' ? value.description : '',
      });
    }
  }
  return { nodes, edges };
}

function readCommunitiesForSummary(graphDirectory: string): SummaryCommunity[] {
  const communities: SummaryCommunity[] = [];
  const communitiesPath = path.join(graphDirectory, 'communities.jsonl');
  if (!fs.existsSync(communitiesPath)) return communities;
  for (const line of fs.readFileSync(communitiesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof value.communityId !== 'string') continue;
    communities.push({
      communityId: value.communityId,
      level: typeof value.level === 'number' ? value.level : 0,
      parentId: typeof value.parentId === 'string' ? value.parentId : '',
      memberKeys: toStringArray(value.memberKeys),
    });
  }
  return communities;
}

function groupChildren(communities: SummaryCommunity[]): Map<string, SummaryCommunity[]> {
  const children = new Map<string, SummaryCommunity[]>();
  for (const community of communities) {
    if (!community.parentId) continue;
    const list = children.get(community.parentId) ?? [];
    list.push(community);
    children.set(community.parentId, list);
  }
  return children;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
