import type { ContextCompressStrategy, ContextMaterial, ContextZone } from './contextRuntimeTypes';
import type { PromptCompressionStrategy, PromptSegment, PromptZone } from './planAwarePromptProjector';

const zoneMap: Record<PromptZone, ContextZone> = {
  policy: 'stable-policy',
  'note-capsule': 'note-capsule',
  'conversation-hot': 'conversation-hot',
  'conversation-summary': 'conversation-summary',
  question: 'current-request',
  'search-plan': 'agent-state',
  coverage: 'agent-state',
  evidence: 'dynamic-evidence',
  'execution-trace': 'tool-observation',
  'tool-observation': 'tool-observation',
  'output-contract': 'output-contract',
};

const compressionMap: Record<PromptCompressionStrategy, ContextCompressStrategy> = {
  none: 'none',
  dedupe: 'dedupe',
  summarize: 'summary',
  'demote-to-reference': 'reference',
  drop: 'drop',
};

/**
 * Compatibility is deliberately one-way. PromptSegment remains authoritative
 * for the current-note route until its Phase 4 cutover.
 */
export function adaptPromptSegmentsToContextMaterials(segments: readonly PromptSegment[]): ContextMaterial[] {
  const ids = new Set<string>();
  return segments.map((segment) => {
    if (ids.has(segment.id)) throw new Error(`PromptSegment id 重复：${segment.id}`);
    ids.add(segment.id);
    if (!segment.text.trim()) throw new Error(`PromptSegment ${segment.id} 内容不能为空。`);
    const common = {
      id: `prompt-segment:${segment.id}`,
      zone: zoneMap[segment.zone],
      content: segment.text,
      priority: segment.priority,
      protected: segment.protected,
      compressStrategy: compressionMap[segment.compressStrategy],
      source: {
        kind: 'prompt-segment',
        id: segment.id,
        version: 'prompt-segment-adapter-v1',
        ...(segment.contentHash ? { contentHash: segment.contentHash } : {}),
      },
      stalePolicy: segment.snapshotId || segment.contentHash ? 'invalidate' as const : 'keep' as const,
      overflowPolicy: segment.protected ? 'fail' as const : 'compress' as const,
      provenance: {
        ...(segment.sourceIds?.length ? { sourceIds: [...segment.sourceIds] } : {}),
        ...(segment.goalIds?.length ? { goalIds: [...segment.goalIds] } : {}),
        ...(segment.requirementIds?.length ? { requirementIds: [...segment.requirementIds] } : {}),
        ...(segment.evidenceIds?.length ? { evidenceIds: [...segment.evidenceIds] } : {}),
        ...(segment.snapshotId ? { snapshotId: segment.snapshotId } : {}),
        ...(segment.contentHash ? { contentHash: segment.contentHash } : {}),
      },
    };

    if (segment.zone === 'policy' || segment.zone === 'output-contract') {
      return {
        ...common,
        channel: 'system',
        trust: 'trusted-policy',
        cache: { stability: 'stable', prefixEligible: true },
      };
    }
    if (segment.zone === 'search-plan' || segment.zone === 'coverage' || segment.zone === 'note-capsule') {
      return {
        ...common,
        channel: 'user',
        trust: 'trusted-state',
        cache: { stability: segment.zone === 'note-capsule' ? 'session' : 'turn', prefixEligible: false },
      };
    }
    if (segment.zone === 'conversation-hot' || segment.zone === 'conversation-summary' || segment.zone === 'question') {
      return {
        ...common,
        channel: 'user',
        trust: 'untrusted-memory',
        cache: { stability: segment.zone === 'conversation-summary' ? 'session' : 'turn', prefixEligible: false },
      };
    }
    return {
      ...common,
      channel: 'user',
      trust: 'untrusted-evidence',
      cache: { stability: 'turn', prefixEligible: false },
    };
  });
}
