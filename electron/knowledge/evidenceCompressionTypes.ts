import { createHash } from 'node:crypto';

export const EVIDENCE_COMPRESSION_POLICY_VERSION = 'stage4-v1';
export const EVIDENCE_COMPRESSION_TARGET_REDUCTION_RATIO = 0.35;
export const EVIDENCE_COMPRESSION_MIN_REDUCTION_RATIO = 0.30;
export const EVIDENCE_COMPRESSION_MAX_REDUCTION_RATIO = 0.40;

export interface EvidenceCompressionSourceEvidence {
  evidenceId: string;
  snapshotId: string;
  contentHash: string;
  textHash: string;
  text: string;
  headingPath: string[];
  lineFrom?: number;
  lineTo?: number;
  goalIds: string[];
  firstSeenSeq: number;
  bestScore?: number;
  protected?: boolean;
  /** Original evidence IDs represented by a derived compression unit. */
  representedEvidenceIds?: string[];
}

export interface EvidenceCompressionConflictBinding {
  topic: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

export interface EvidenceCompressionBatch {
  batchId: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  /** Internal source-unit IDs; absent for first-round raw evidence batches. */
  sourceUnitIds?: string[];
  sourceTokenCount: number;
  primaryGoalId: string;
  headingPath: string[];
  targetReductionRatio: number;
  estimatedCompressedTokens: number;
  estimatedNetSavingsTokens: number;
  artifactFramingTokens: number;
}

export interface EvidenceCompressionSegment {
  segmentId: string;
  sourceEvidenceIds: string[];
  text: string;
  preservedTopics: string[];
}

export interface EvidenceCompressionPreservedConflict {
  topic: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

export interface EvidenceCompressionArtifact {
  artifactId: string;
  batchId: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  sourceTokenCount: number;
  compressedTokenCount: number;
  reductionRatio: number;
  compressedSegments: EvidenceCompressionSegment[];
  preservedConflicts: EvidenceCompressionPreservedConflict[];
  modelProfileId: string;
  compressionPolicyVersion: string;
  createdAt: string;
}

export interface EvidenceCompressionCacheStateVector {
  libraryId: string;
  noteId: string;
  sessionId: string;
  turnId: string;
  planId: string;
  planVersion: number;
  questionHash: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  sourceTextHashes: Record<string, string>;
  compressionPolicyVersion: string;
  targetReductionRatio: number;
  modelProfileId: string;
  tokenizerFingerprint: string;
}

export interface EvidenceCompressionCacheEntry {
  key: string;
  stateVector: EvidenceCompressionCacheStateVector;
  artifact: EvidenceCompressionArtifact;
}

export const DEFAULT_EVIDENCE_COMPRESSION_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['batchId', 'sourceEvidenceIds', 'compressedSegments', 'preservedConflicts'],
  properties: {
    batchId: { type: 'string' },
    sourceEvidenceIds: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    compressedSegments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segmentId', 'sourceEvidenceIds', 'text', 'preservedTopics'],
        properties: {
          segmentId: { type: 'string' },
          sourceEvidenceIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          text: { type: 'string', minLength: 1 },
          preservedTopics: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    preservedConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'supportsEvidenceIds', 'contradictsEvidenceIds'],
        properties: {
          topic: { type: 'string' },
          supportsEvidenceIds: {
            type: 'array',
            items: { type: 'string' },
          },
          contradictsEvidenceIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
});

export function createEvidenceCompressionCacheKey(state: EvidenceCompressionCacheStateVector): string {
  const canonical = {
    libraryId: state.libraryId,
    noteId: state.noteId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    planId: state.planId,
    planVersion: state.planVersion,
    questionHash: state.questionHash,
    snapshotId: state.snapshotId,
    contentHash: state.contentHash,
    sourceEvidenceIds: [...new Set(state.sourceEvidenceIds)].sort(),
    sourceTextHashes: Object.fromEntries(Object.entries(state.sourceTextHashes).sort(([first], [second]) => first.localeCompare(second))),
    compressionPolicyVersion: state.compressionPolicyVersion,
    targetReductionRatio: state.targetReductionRatio,
    modelProfileId: state.modelProfileId,
    tokenizerFingerprint: state.tokenizerFingerprint,
  };
  return `evidence-compression-cache-${createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
}
