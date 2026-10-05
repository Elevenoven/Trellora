import { estimateTokenCount } from './tokenEstimator';
import type { PromptSegment } from './planAwarePromptProjector';

export interface L1PromptCompactionResult {
  segments: PromptSegment[];
  level: 0 | 1;
  changed: boolean;
}

/** Deterministic L1 compaction. Protected segments are copied byte-for-byte. */
export function compactPromptSegmentsL1(segments: readonly PromptSegment[]): L1PromptCompactionResult {
  const folded = new Map<string, PromptSegment>();
  let changed = false;
  for (const segment of segments) {
    const normalized = normalizeSegment(segment);
    const key = `${normalized.zone}\u0000${normalized.text}`;
    const existing = folded.get(key);
    if (!existing) {
      folded.set(key, normalized);
      changed ||= normalized.text !== segment.text || normalized.estimatedTokens !== segment.estimatedTokens;
      continue;
    }
    changed = true;
    existing.sourceIds = merge(existing.sourceIds, normalized.sourceIds);
    existing.goalIds = merge(existing.goalIds, normalized.goalIds);
    existing.requirementIds = merge(existing.requirementIds, normalized.requirementIds);
    existing.evidenceIds = merge(existing.evidenceIds, normalized.evidenceIds);
  }
  return { segments: [...folded.values()], level: changed ? 1 : 0, changed };
}

function normalizeSegment(segment: PromptSegment): PromptSegment {
  if (segment.protected || segment.compressStrategy === 'none') return copySegment(segment);
  const limit = segment.zone === 'execution-trace' || segment.zone === 'tool-observation' ? 1_000 : 2_400;
  if (segment.text.length <= limit) return copySegment(segment);
  const head = Math.ceil(limit * 0.68);
  const tail = Math.floor(limit * 0.22);
  const text = `${segment.text.slice(0, head)}\n…（L1 确定性压缩，完整原文仍在 Ledger）…\n${segment.text.slice(-tail)}`;
  return { ...copySegment(segment), text, estimatedTokens: estimateTokenCount(text) };
}

function copySegment(segment: PromptSegment): PromptSegment {
  return {
    ...segment,
    ...(segment.sourceIds ? { sourceIds: [...segment.sourceIds] } : {}),
    ...(segment.goalIds ? { goalIds: [...segment.goalIds] } : {}),
    ...(segment.requirementIds ? { requirementIds: [...segment.requirementIds] } : {}),
    ...(segment.evidenceIds ? { evidenceIds: [...segment.evidenceIds] } : {}),
  };
}

function merge(first: string[] | undefined, second: string[] | undefined): string[] | undefined {
  const values = [...new Set([...(first ?? []), ...(second ?? [])])].sort();
  return values.length ? values : undefined;
}
