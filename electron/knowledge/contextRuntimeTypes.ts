import type { PromptCallKind } from './currentNoteContextBudget';
import type { AssistantModelRuntimeProfile } from '../../shared/effectiveContextWindow';

export type { AssistantModelRuntimeProfile } from '../../shared/effectiveContextWindow';

export const assistantContextRuntimeModes = ['off', 'observe', 'enforce'] as const;
export type AssistantContextRuntimeMode = typeof assistantContextRuntimeModes[number];

export const CONTEXT_RUNTIME_SCHEMA_VERSION = 1 as const;
export const CONTEXT_REQUEST_ENVELOPE_VERSION = 'context-envelope-v1';

export type ContextRoute = 'chat' | 'knowledge-base' | 'current-note';
export type ContextChannel = 'system' | 'user' | 'tool';

export type ContextZone =
  | 'stable-policy'
  | 'project-context'
  | 'user-profile'
  | 'long-term-memory'
  | 'agent-state'
  | 'conversation-summary'
  | 'conversation-hot'
  | 'conversation-recall'
  | 'note-capsule'
  | 'dynamic-evidence'
  | 'tool-observation'
  | 'current-request'
  | 'output-contract';

export type ContextTrust =
  | 'trusted-policy'
  | 'trusted-state'
  | 'untrusted-memory'
  | 'untrusted-evidence';

export type ContextCompressStrategy =
  | 'none'
  | 'dedupe'
  | 'reference'
  | 'truncate'
  | 'summary'
  | 'drop';

export type ContextAdmissionKind =
  | 'tool-catalog'
  | 'tool-definition'
  | 'skill-description'
  | 'skill-body'
  | 'attachment-metadata'
  | 'attachment-content';

export interface ContextMaterialAdmission {
  kind: ContextAdmissionKind;
  key: string;
  phase?: string;
  activeByDefault: boolean;
  activationReason: string;
}

export interface ContextMaterialLifecycle {
  sequence?: number;
  status?: 'active' | 'completed' | 'superseded' | 'stale' | 'error' | 'correction';
  rereadable?: boolean;
  activeDependency?: boolean;
}

export interface ContextMaterialSource {
  kind: string;
  id: string;
  version: string;
  contentHash?: string;
}

export interface ContextMaterialProvenance {
  sessionId?: string;
  turnSeqs?: number[];
  planId?: string;
  sourceIds?: string[];
  goalIds?: string[];
  requirementIds?: string[];
  evidenceIds?: string[];
  snapshotId?: string;
  contentHash?: string;
}

export interface ContextMaterialBase {
  id: string;
  zone: ContextZone;
  content: string;
  priority: number;
  protected: boolean;
  compressStrategy: ContextCompressStrategy;
  source: ContextMaterialSource;
  tokenBudget?: {
    absoluteMax?: number;
    ratio?: number;
  };
  /**
   * Optional pre-selection size used only by renderer-safe diagnostics. The
   * projected content remains the sole source of final token accounting.
   */
  diagnosticCandidateTokens?: number;
  /** Phase-1 admission metadata. It never grants filesystem or tool authority. */
  admission?: ContextMaterialAdmission;
  /** Optional deterministic cleanup hints for Tool/trace projections. */
  lifecycle?: ContextMaterialLifecycle;
  stalePolicy: 'keep' | 'invalidate' | 'refresh';
  overflowPolicy: 'fail' | 'compress' | 'drop';
  provenance?: ContextMaterialProvenance;
  cache: {
    stability: 'stable' | 'session' | 'turn';
    prefixEligible: boolean;
  };
  toolName?: string;
}

/**
 * The discriminated union makes illegal trust/channel combinations fail at
 * compile time. Runtime validation still protects deserialized inputs.
 */
export type ContextMaterial =
  | (ContextMaterialBase & { trust: 'trusted-policy'; channel: 'system' })
  | (ContextMaterialBase & { trust: 'trusted-state'; channel: 'system' | 'user' })
  | (ContextMaterialBase & { trust: 'untrusted-memory'; channel: 'user' })
  | (ContextMaterialBase & { trust: 'untrusted-evidence'; channel: 'user' | 'tool' });

export interface ContextEnvelopeScope {
  workspaceId: string;
  libraryId?: string;
  noteId?: string;
  sessionId?: string;
  turnId?: string;
}

export interface ContextEnvelope {
  schemaVersion: typeof CONTEXT_RUNTIME_SCHEMA_VERSION;
  route: ContextRoute;
  callKind: PromptCallKind;
  scope: ContextEnvelopeScope;
  windowProfile: AssistantModelRuntimeProfile;
  materials: ContextMaterial[];
  invariants: string[];
  stateVector: {
    snapshotId?: string;
    contentHash?: string;
    planId?: string;
    memoryVersion?: string;
  };
}

export interface ProjectedContextMaterial {
  id: string;
  zone: ContextZone;
  channel: ContextChannel;
  trust: ContextTrust;
  priority: number;
  protected: boolean;
  source: ContextMaterialSource;
  estimatedTokens: number;
  contentSha256: string;
  order: number;
}

export interface ContextOmission {
  materialId: string;
  reason: 'duplicate' | 'budget' | 'stale' | 'invalid' | 'policy';
  estimatedTokens: number;
  detail?: string;
}

export interface ContextProjectionStats {
  candidateMaterials: number;
  includedMaterials: number;
  omittedMaterials: number;
  systemMaterials: number;
  userMaterials: number;
  toolMaterials: number;
  systemTokens: number;
  userTokens: number;
  toolTokens: number;
  serializedTokens: number;
}

export interface ContextProjection {
  systemPrompt: string;
  userPrompt: string;
  toolMessages?: Array<{ name: string; content: string }>;
  serializedBudgetText: string;
  requestEnvelopeVersion: string;
  pressureLevel: 0 | 1 | 2 | 3 | 4 | 5;
  included: ProjectedContextMaterial[];
  omitted: ContextOmission[];
  stats: ContextProjectionStats;
  stablePrefixFingerprint: string;
}

export interface ContextRuntimeRoleDigest {
  chars: number;
  estimatedTokens: number;
  sha256: string;
}

export interface ContextRuntimePromptDigest {
  roleStructure: ContextChannel[];
  system: ContextRuntimeRoleDigest;
  user: ContextRuntimeRoleDigest;
  combined: ContextRuntimeRoleDigest;
}

export type ContextRuntimeSendPath = 'legacy-phase-1' | 'legacy-observe' | 'projection-enforce';

export interface ContextProjectionWindowDiagnostics {
  runtimeProfileId?: AssistantModelRuntimeProfile['runtimeProfileId'];
  physicalTokens?: number;
  physicalSource: AssistantModelRuntimeProfile['physicalSource'];
  productCapMode?: AssistantModelRuntimeProfile['productCapMode'];
  productCeilingTokens: number;
  userCapTokens?: number;
  effectiveTokens: number;
  autoCompactAtTokens: number;
  outputReserveTokens: number;
  safetyTokens: number;
  availablePromptTokens: number;
}

export interface ContextProjectionZoneDiagnostics {
  zone: ContextZone;
  candidateTokens: number;
  finalTokens: number;
  candidateMaterials: number;
  includedMaterials: number;
  omittedMaterials: number;
  channels: ContextChannel[];
  trusts: ContextTrust[];
  protectedMaterials: number;
  compressionActions: string[];
}

export interface ContextProjectionOmissionDiagnostics {
  materialId: string;
  zone: ContextZone;
  reason: ContextOmission['reason'];
  estimatedTokens: number;
}

export type QaResidualPressureLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface QaResidualMemoryDiagnostics {
  schemaVersion: 1;
  observationOnly: true;
  legacy: {
    M1: { tokens: number; materialCount: number };
    M2: { tokens: number; turnCount: number; turnSeqFrom?: number; turnSeqTo?: number };
  };
  budget: {
    W: number;
    O: number;
    G: number;
    N: number;
    C: number;
    M: number;
    H: number;
    UWindow: number;
    rawNonConversationTokens: number;
    rawConversationTokens: number;
    reentryTargetPromptTokens: number;
  };
  wouldOptimize: {
    required: boolean;
    pressureLevel: QaResidualPressureLevel;
    actions: Array<'cleanup-old-tool-output' | 'artifact-and-cold-reference'>;
  };
  wouldInclude: {
    allRawTurns: boolean;
    turnCount: number;
    turnSeqFrom?: number;
    turnSeqTo?: number;
    estimatedTokens: number;
  };
  wouldCompact: {
    candidate: boolean;
    conditionalOnOptimizationInsufficient: true;
    sourceTurnCount: number;
    sourceTokens: number;
    estimatedSummaryTargetTokens: number;
    compactThroughTurnSeq?: number;
    projectedUWindowAfter: number;
    reachesReentryTarget: boolean;
  };
}

export interface QaResidualMemoryEnforcementDiagnostics {
  schemaVersion: 1;
  observationOnly: false;
  state: 'stable' | 'optimized' | 'compacted' | 'pressure-degraded' | 'hard-veto' | 'circuit-open';
  initialPressureLevel: QaResidualPressureLevel;
  finalPressureLevel: QaResidualPressureLevel;
  budget: {
    W: number;
    O: number;
    G: number;
    N: number;
    C: number;
    M: number;
    H: number;
    UWindow: number;
    reentryTargetPromptTokens: number;
    reentryReserveTokens: number;
  };
  conversation: {
    checkpointVersion: number;
    checkpointTokens: number;
    coveredThroughSeq: number;
    rawTurnCount: number;
    rawTokens: number;
    rawTurnSeqFrom?: number;
    rawTurnSeqTo?: number;
    originalShortTermCapacity: number;
    allRawTurnsIncluded: true;
  };
  /** Phase 4: marginal, fully serialized token cost of admitted knowledge-base parent evidence. */
  evidence?: {
    actualTokens: number;
    materialCount: number;
    parentIdentityCount: number;
    references: number[];
    allProtected: true;
    contentPreserved: true;
    referencesPreserved: true;
    parentIdentityPreserved: true;
  };
  compaction: {
    triggered: boolean;
    attempts: number;
    modelCalls: number;
    memoryWrites: number;
    casConflicts: number;
    fallbackUsed: boolean;
    compactedFromSeq?: number;
    compactedThroughSeq?: number;
    sourceTokens?: number;
    outputTokens?: number;
    compressionRatio?: number;
    releasedTokens: number;
    errorCode?: string;
  };
}

export interface ContextProviderUsageDiagnostics {
  responseCompleted: boolean;
  reported: boolean;
  localRawInputTokens: number;
  localCalibratedInputTokens: number;
  calibrationMultiplierUsed: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  providerCachedInputTokens?: number;
  rawEstimateSignedErrorTokens?: number;
  rawEstimateAbsoluteErrorTokens?: number;
  rawEstimateRelativeError?: number;
  calibratedEstimateSignedErrorTokens?: number;
  calibratedEstimateAbsoluteErrorTokens?: number;
  calibratedEstimateRelativeError?: number;
}

export type DynamicMemoryS0CallKind =
  | 'chat-answer'
  | 'query-rewrite'
  | 'react-decide'
  | 'react-synthesize';

export type DynamicMemoryS0Route =
  | 'chat-direct'
  | 'knowledge-base-direct'
  | 'knowledge-base-react';

export interface ConversationCoverageMapDiagnostics {
  schemaVersion: 1;
  eligibleTurnCount: number;
  eligibleTurnSeqFrom?: number;
  eligibleTurnSeqTo?: number;
  summaryRanges: Array<{ turnFrom: number; turnTo: number }>;
  hotTurnSeqs: number[];
  uncoveredTurnSeqs: number[];
  multiplyCoveredTurnSeqs: number[];
  complete: boolean;
  currentProjection: {
    fixedHotTurnLimit: 6;
    queryRewriteAnswerHeadChars: 200;
    reactHistoryAnswerHeadChars: 1_500;
    storedAssistantTextLimitChars: 60_000;
    recallTokens: 0;
  };
  risks: string[];
}

export interface DynamicMemoryS0Diagnostics {
  schemaVersion: 1;
  observationOnly: true;
  route: DynamicMemoryS0Route;
  callKind: DynamicMemoryS0CallKind;
  recordedAt: string;
  budget: {
    W: number;
    O: number;
    G: number;
    P: number;
    RNext: number;
  };
  partitions: {
    F: number;
    T: number;
    A: number;
    E: number;
    M: number;
    total: number;
    totalWithRNext: number;
    remainingPromptTokens: number;
    partitionOverflowTokens: number;
  };
  providerPayload: {
    chars: number;
    bytes: number;
    estimatedTokens: number;
    sha256: string;
    messageCount: number;
    toolSchemaCount: number;
    toolSchemaChars: number;
    toolSchemaBytes: number;
    toolSchemaTokens: number;
    skillCount: number;
    skillTokens: number;
    attachmentCount: number;
    attachmentBytes: number;
    mediaTokenEstimateUnavailable: boolean;
    messageOnlyEstimatedTokens: number;
    payloadDeltaFromMessageOnlyTokens: number;
    uncountedToolSchemaTokens: number;
    providerInputTokens?: number;
    estimateSignedErrorTokens?: number;
    estimateAbsoluteErrorTokens?: number;
    estimateRelativeError?: number;
    responseCompleted: boolean;
  };
  coverage: ConversationCoverageMapDiagnostics;
  wiring: {
    prepare: string;
    contextEnvelope: { status: 'wired' | 'unwired'; entry: string };
    residualEnforcer: { status: 'wired' | 'conditional' | 'unwired'; entry: string };
    provider: string;
    finalize: string;
    pressureController: {
      relieveNonConversation: 'wired';
      projectAtLevel: 'source-only';
      projectToFit: 'source-only';
    };
    summaryRollups: 'stored-unwired';
    oldTurnLexicalRecall: 'source-only';
    databases: {
      qa: 'qa-memory.db';
      currentNote: 'assistant-memory.db';
      legacyWorkspace: 'conversation-memory.db';
    };
    currentNoteExcluded: true;
  };
  sideEffects: {
    providerRequestMutations: 0;
    semanticMemoryMutations: 0;
    diagnosticArtifactWrites: number;
    traceWritesAllowed: true;
  };
}

export interface ToolObservationS0Diagnostics {
  schemaVersion: 1;
  raw: { chars: number; bytes: number; estimatedTokens: number; sha256: string };
  providerVisible: { chars: number; bytes: number; estimatedTokens: number; sha256: string };
  truncated: boolean;
  artifactized: boolean;
  artifactId?: string;
  releasedChars: number;
  releasedBytes: number;
}

export type ContextProgressivePressureLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface ContextAdmissionDiagnostics {
  candidateMaterials: number;
  admittedMaterials: number;
  deferredMaterials: number;
  toolCatalogTokens: number;
  activeToolDefinitionTokens: number;
  skillDescriptionTokens: number;
  selectedSkillBodyTokens: number;
  attachmentMetadataTokens: number;
  attachmentContentTokens: number;
  activationReasons: string[];
}

export interface ContextPressureActionDiagnostics {
  level: ContextProgressivePressureLevel;
  kind: string;
  materialIds: string[];
  beforeTokens: number;
  afterTokens: number;
  releasedTokens: number;
  reason: string;
  artifactId?: string;
}

export interface ContextPressureEpisodeDiagnostics {
  pressureEpisodeId: string;
  materialFingerprint: string;
  initialLevel: ContextProgressivePressureLevel;
  finalLevel: ContextProgressivePressureLevel;
  initialUWindow: number;
  finalUWindow: number;
  minPressureGainTokens: number;
  stoppedReason:
    | 'below-p1'
    | 'below-p2'
    | 'below-p3'
    | 'p1-complete'
    | 'p2-complete'
    | 'p3-complete'
    | 'pressure-degraded'
    | 'hard-veto'
    | 'circuit-open'
    | 'ineffective-gain'
    | 'repeated-zero-gain';
  ineffectiveGain: boolean;
  actions: ContextPressureActionDiagnostics[];
  skippedZeroGainActions: string[];
}

/**
 * Renderer-safe context diagnostics. It intentionally excludes prompt text,
 * material content, API credentials and provider-cache-hit claims.
 */
export interface ContextProjectionDiagnostics {
  schemaVersion: 1;
  recordedAt: string;
  turnId?: string;
  route: ContextRoute;
  callKind: PromptCallKind;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  sendPath: ContextRuntimeSendPath;
  providerId: string;
  modelId: string;
  pressureLevel: ContextProjection['pressureLevel'];
  window: ContextProjectionWindowDiagnostics;
  tokens: {
    candidate: number;
    final: number;
    outputReserve: number;
    safety: number;
  };
  zones: ContextProjectionZoneDiagnostics[];
  omissions: ContextProjectionOmissionDiagnostics[];
  stablePrefix: {
    fingerprint?: string;
    cacheEligible: boolean;
    /** Always false: only a Provider usage response may report a real hit. */
    providerCacheHitClaimed: false;
  };
  residualMemory?: QaResidualMemoryDiagnostics;
  residualMemoryEnforcement?: QaResidualMemoryEnforcementDiagnostics;
  providerUsage?: ContextProviderUsageDiagnostics;
  dynamicMemoryS0?: DynamicMemoryS0Diagnostics;
  admission?: ContextAdmissionDiagnostics;
  pressureEpisode?: ContextPressureEpisodeDiagnostics;
  invariantViolations: string[];
}

export interface ContextRuntimeObservationReport {
  schemaVersion: 1;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  route: ContextRoute;
  callKind: PromptCallKind;
  requestEnvelopeVersion: string;
  legacy: ContextRuntimePromptDigest;
  projection?: ContextRuntimePromptDigest;
  differences: {
    systemPromptEqual: boolean;
    userPromptEqual: boolean;
    roleStructureEqual: boolean;
    serializedTokenDelta?: number;
  };
  invariantViolations: string[];
  stablePrefixFingerprint?: string;
  candidateMaterials: number;
  includedMaterials: number;
  modelCallsAdded: number;
  memoryWritesAdded: number;
  turnStateMutations: 0;
  sendPath: ContextRuntimeSendPath;
  diagnostics: ContextProjectionDiagnostics;
}

export interface ContextRuntimeObservationResult {
  report: ContextRuntimeObservationReport;
  projection?: ContextProjection;
}

export function normalizeAssistantContextRuntimeMode(value: unknown): AssistantContextRuntimeMode {
  return typeof value === 'string' && (assistantContextRuntimeModes as readonly string[]).includes(value)
    ? value as AssistantContextRuntimeMode
    : 'observe';
}
