import {
  createEvidenceCompressionCacheKey,
  type EvidenceCompressionArtifact,
  type EvidenceCompressionCacheEntry,
  type EvidenceCompressionCacheStateVector,
} from './evidenceCompressionTypes';

/**
 * An in-memory derived-data cache. The state vector deliberately includes the
 * session and turn, so a cache hit can never cross those isolation boundaries.
 */
export class EvidenceCompressionCache {
  private readonly entries = new Map<string, EvidenceCompressionCacheEntry>();

  get(stateVector: EvidenceCompressionCacheStateVector): EvidenceCompressionArtifact | undefined {
    const key = createEvidenceCompressionCacheKey(stateVector);
    const entry = this.entries.get(key);
    return entry ? copyArtifact(entry.artifact) : undefined;
  }

  set(stateVector: EvidenceCompressionCacheStateVector, artifact: EvidenceCompressionArtifact): string {
    assertArtifactMatchesState(stateVector, artifact);
    const key = createEvidenceCompressionCacheKey(stateVector);
    this.entries.set(key, { key, stateVector: copyStateVector(stateVector), artifact: copyArtifact(artifact) });
    return key;
  }

  delete(stateVector: EvidenceCompressionCacheStateVector): boolean {
    return this.entries.delete(createEvidenceCompressionCacheKey(stateVector));
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function assertArtifactMatchesState(stateVector: EvidenceCompressionCacheStateVector, artifact: EvidenceCompressionArtifact): void {
  const expectedIds = new Set(stateVector.sourceEvidenceIds);
  const actualIds = new Set(artifact.sourceEvidenceIds);
  if (artifact.snapshotId !== stateVector.snapshotId) throw new Error('压缩缓存 Artifact 的 snapshotId 不匹配。');
  if (artifact.contentHash !== stateVector.contentHash) throw new Error('压缩缓存 Artifact 的 contentHash 不匹配。');
  if (artifact.modelProfileId !== stateVector.modelProfileId) throw new Error('压缩缓存 Artifact 的 modelProfileId 不匹配。');
  if (artifact.compressionPolicyVersion !== stateVector.compressionPolicyVersion) throw new Error('压缩缓存 Artifact 的策略版本不匹配。');
  if (expectedIds.size !== actualIds.size || [...expectedIds].some((evidenceId) => !actualIds.has(evidenceId))) {
    throw new Error('压缩缓存 Artifact 的 sourceEvidenceIds 不匹配。');
  }
}

function copyStateVector(stateVector: EvidenceCompressionCacheStateVector): EvidenceCompressionCacheStateVector {
  return {
    ...stateVector,
    sourceEvidenceIds: [...stateVector.sourceEvidenceIds],
    sourceTextHashes: { ...stateVector.sourceTextHashes },
  };
}

function copyArtifact(artifact: EvidenceCompressionArtifact): EvidenceCompressionArtifact {
  return {
    ...artifact,
    sourceEvidenceIds: [...artifact.sourceEvidenceIds],
    compressedSegments: artifact.compressedSegments.map((segment) => ({
      ...segment,
      sourceEvidenceIds: [...segment.sourceEvidenceIds],
      preservedTopics: [...segment.preservedTopics],
    })),
    preservedConflicts: artifact.preservedConflicts.map((conflict) => ({
      ...conflict,
      supportsEvidenceIds: [...conflict.supportsEvidenceIds],
      contradictsEvidenceIds: [...conflict.contradictsEvidenceIds],
    })),
  };
}
