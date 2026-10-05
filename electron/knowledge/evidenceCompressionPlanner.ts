import { createHash } from 'node:crypto';
import { estimateTokenCount } from './tokenEstimator';
import {
  EVIDENCE_COMPRESSION_POLICY_VERSION,
  EVIDENCE_COMPRESSION_TARGET_REDUCTION_RATIO,
  type EvidenceCompressionBatch,
  type EvidenceCompressionSourceEvidence,
} from './evidenceCompressionTypes';

export interface EvidenceCompressionPlannerInput {
  snapshotId: string;
  contentHash: string;
  evidence: readonly EvidenceCompressionSourceEvidence[];
  overflowTokens: number;
  artifactFramingTokens?: number;
  maxSourceTokensPerBatch?: number;
  targetReductionRatio?: number;
  protectedEvidenceIds?: readonly string[];
  compressionPolicyVersion?: string;
}

interface BatchCandidate {
  sourceEvidence: EvidenceCompressionSourceEvidence[];
  sourceEvidenceIds: string[];
  sourceUnitIds: string[];
  sourceTokenCount: number;
  estimatedNetSavingsTokens: number;
  bestScore: number;
  primaryGoalId: string;
  headingPath: string[];
  groupKey: string;
}

/**
 * Plans only the independent compression batches. It does not call a model,
 * mutate the Ledger, or decide whether an Artifact is semantically correct.
 */
export function planEvidenceCompressionBatches(input: EvidenceCompressionPlannerInput): EvidenceCompressionBatch[] {
  assertPlannerInput(input);
  if (input.overflowTokens === 0) return [];

  const targetReductionRatio = input.targetReductionRatio ?? EVIDENCE_COMPRESSION_TARGET_REDUCTION_RATIO;
  const artifactFramingTokens = input.artifactFramingTokens ?? 0;
  const maxSourceTokensPerBatch = input.maxSourceTokensPerBatch ?? Number.MAX_SAFE_INTEGER;
  const protectedIds = new Set(input.protectedEvidenceIds ?? []);
  const evidence = input.evidence.filter((record) => !getRepresentedIds(record).some((evidenceId) => protectedIds.has(evidenceId)));
  const groups = new Map<string, EvidenceCompressionSourceEvidence[]>();
  for (const record of evidence) {
    const primaryGoalId = record.goalIds[0] ?? 'unassigned';
    const headingKey = record.headingPath.join('\u001f') || 'root';
    const groupKey = `${primaryGoalId}\u0000${headingKey}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), record]);
  }

  const candidates: BatchCandidate[] = [];
  for (const [groupKey, records] of groups) {
    const ordered = records.sort(compareEvidence);
    let current: EvidenceCompressionSourceEvidence[] = [];
    let currentTokens = 0;
    const flush = () => {
      if (!current.length) return;
      const primaryGoalId = current[0].goalIds[0] ?? 'unassigned';
      const headingPath = [...current[0].headingPath];
      const estimatedNetSavingsTokens = Math.max(0, Math.floor(currentTokens * targetReductionRatio) - artifactFramingTokens);
      candidates.push({
        sourceEvidence: current,
        sourceEvidenceIds: [...new Set(current.flatMap(getRepresentedIds))].sort(),
        sourceUnitIds: current.map((record) => record.evidenceId),
        sourceTokenCount: currentTokens,
        estimatedNetSavingsTokens,
        bestScore: Math.min(...current.map((record) => record.bestScore ?? Number.POSITIVE_INFINITY)),
        primaryGoalId,
        headingPath,
        groupKey,
      });
      current = [];
      currentTokens = 0;
    };
    for (const record of ordered) {
      const recordTokens = estimateTokenCount(record.text);
      if (current.length && currentTokens + recordTokens > maxSourceTokensPerBatch) flush();
      current.push(record);
      currentTokens += recordTokens;
    }
    flush();
  }

  candidates.sort((first, second) =>
    first.bestScore - second.bestScore
    || second.estimatedNetSavingsTokens - first.estimatedNetSavingsTokens
    || first.sourceEvidenceIds.join(',').localeCompare(second.sourceEvidenceIds.join(','))
    || first.primaryGoalId.localeCompare(second.primaryGoalId)
    || first.groupKey.localeCompare(second.groupKey));

  const requiredSavings = Math.ceil(input.overflowTokens * 1.05);
  let selectedSavings = 0;
  const selected: EvidenceCompressionBatch[] = [];
  for (const candidate of candidates) {
    if (selectedSavings >= requiredSavings && selected.length > 0) break;
    const sourceEvidenceIds = candidate.sourceEvidenceIds;
    const batchId = createBatchId(input, sourceEvidenceIds, candidate.groupKey, targetReductionRatio);
    selected.push({
      batchId,
      snapshotId: input.snapshotId,
      contentHash: input.contentHash,
      sourceEvidenceIds,
      sourceUnitIds: candidate.sourceUnitIds,
      sourceTokenCount: candidate.sourceTokenCount,
      primaryGoalId: candidate.primaryGoalId,
      headingPath: candidate.headingPath,
      targetReductionRatio,
      estimatedCompressedTokens: Math.ceil(candidate.sourceTokenCount * (1 - targetReductionRatio)),
      estimatedNetSavingsTokens: candidate.estimatedNetSavingsTokens,
      artifactFramingTokens,
    });
    selectedSavings += candidate.estimatedNetSavingsTokens;
  }
  return selected;
}

function getRepresentedIds(record: EvidenceCompressionSourceEvidence): string[] {
  return [...new Set(record.representedEvidenceIds?.length ? record.representedEvidenceIds : [record.evidenceId])];
}

function assertPlannerInput(input: EvidenceCompressionPlannerInput): void {
  if (!input.snapshotId.trim() || !input.contentHash.trim()) throw new Error('压缩批次必须绑定当前 Snapshot 和 contentHash。');
  if (!Number.isSafeInteger(input.overflowTokens) || input.overflowTokens < 0) throw new Error('overflowTokens 必须是非负整数。');
  const target = input.targetReductionRatio ?? EVIDENCE_COMPRESSION_TARGET_REDUCTION_RATIO;
  if (target < 0.30 || target > 0.40) throw new Error('压缩目标必须位于 30%～40% 区间。');
  const maxSourceTokens = input.maxSourceTokensPerBatch ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxSourceTokens) || maxSourceTokens < 1) throw new Error('压缩批次输入上限无效。');
  const seen = new Set<string>();
  for (const record of input.evidence) {
    if (seen.has(record.evidenceId)) throw new Error(`压缩输入存在重复 evidenceId：${record.evidenceId}`);
    seen.add(record.evidenceId);
    if (record.snapshotId !== input.snapshotId || record.contentHash !== input.contentHash) throw new Error('压缩输入包含跨 Snapshot 或 contentHash 的证据。');
    if (!record.text.trim()) throw new Error('压缩输入证据正文不能为空。');
  }
}

function compareEvidence(first: EvidenceCompressionSourceEvidence, second: EvidenceCompressionSourceEvidence): number {
  return (first.firstSeenSeq - second.firstSeenSeq)
    || (first.lineFrom ?? Number.MAX_SAFE_INTEGER) - (second.lineFrom ?? Number.MAX_SAFE_INTEGER)
    || (first.lineTo ?? Number.MAX_SAFE_INTEGER) - (second.lineTo ?? Number.MAX_SAFE_INTEGER)
    || first.evidenceId.localeCompare(second.evidenceId);
}

function createBatchId(
  input: EvidenceCompressionPlannerInput,
  sourceEvidenceIds: readonly string[],
  groupKey: string,
  targetReductionRatio: number,
): string {
  const policy = input.compressionPolicyVersion ?? EVIDENCE_COMPRESSION_POLICY_VERSION;
  const value = `${input.snapshotId}\u0000${input.contentHash}\u0000${policy}\u0000${targetReductionRatio}\u0000${groupKey}\u0000${sourceEvidenceIds.join(',')}`;
  return `compression-batch-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}
