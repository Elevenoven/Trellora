/**
 * Canonical numeric and enum contract for the WeKnora-aligned memory domain.
 *
 * Keep every production memory default and threshold here. Route adapters and
 * services may derive values from this object, but must not redefine them.
 */
export const MEMORY_CONTRACT_VERSION = 'weknora-memory-contract-v1' as const;

export const MEMORY_KINDS = Object.freeze([
  'profile',
  'preference',
  'fact',
  'task',
  'interest',
] as const);

export const MEMORY_ORIGINS = Object.freeze([
  'explicit',
  'extracted',
  'manual',
] as const);

export const MEMORY_STATUSES = Object.freeze([
  'active',
  'pending',
  'superseded',
  'archived',
] as const);

export const MEMORY_WRITE_MODES = Object.freeze([
  'explicit_only',
  'auto',
] as const);

export const MEMORY_CONSTANTS = Object.freeze({
  runtime: Object.freeze({
    extractionRequestTimeoutMs: 60_000,
    topicRequestTimeoutMs: 30_000,
    extractionJobTimeoutMs: 300_000,
    consolidationClusterTimeoutMs: 60_000,
    consolidationTotalTimeoutMs: 120_000,
    stopWaitTimeoutMs: 3_000,
  }),
  workspaceConfig: Object.freeze({
    enabledByDefault: false,
    defaultWriteMode: 'explicit_only' as const,
    defaultExtractModelId: null,
    maxItems: Object.freeze({ default: 200, serviceMin: 1, serviceMax: 2_000, uiMin: 10, uiMax: 2_000 }),
    extractDelaySeconds: Object.freeze({ default: 90, min: 5, max: 3_600 }),
    extractMinIntervalSeconds: Object.freeze({ default: 300, max: 86_400 }),
    extractInstructionsMaxCodePoints: 1_000,
    interestThreshold: Object.freeze({ default: 3, min: 1, max: 20 }),
    retrievalConditioningByDefault: true,
    defaultEmbeddingModelId: null,
    vectorRecallByDefault: true,
  }),

  workingMemory: Object.freeze({
    defaultMaxContextTokens: 200_000,
    toolResultBudget: Object.freeze({ ratio: 0.20, minTokens: 8_192, maxTokens: 32_768 }),
    partialToolResultPreview: Object.freeze({ headRatio: 0.25, tailRatio: 0.75 }),
    summary: Object.freeze({
      triggerRatioExclusive: 0.50,
      targetRatio: 0.30,
      selectionRatioWithinTrigger: 0.60,
      reserveTokens: 500,
      maxAttempts: 3,
      timeoutSeconds: 60,
      temperature: 0.3,
      maxOutputTokens: 2_000,
      userOrAssistantMaxCodePoints: 2_000,
      toolCallOrResultMaxCodePoints: 1_000,
      deterministicFallbackMaxCodePointsPerMessage: 500,
    }),
    atomicPruneTriggerRatioExclusive: 0.80,
    fallbackTokenEstimate: Object.freeze({ perMessageOverheadTokens: 3, conversationTailTokens: 3 }),
  }),

  conversationHistory: Object.freeze({
    recentCompleteTurns: 5,
    overfetchMultiplier: 4,
    overfetchMinimumMessages: 50,
    search: Object.freeze({
      defaultLimit: 5,
      maxLimit: 8,
      internalPageExtra: 2,
      keywordCandidateMultiplier: 3,
      questionPreviewMaxCodePoints: 400,
      answerPreviewMaxCodePoints: 400,
      rrfK: 60,
      rankBase: 1,
    }),
    retainRetrievalHistoryByDefault: false,
  }),

  recall: Object.freeze({
    residentCandidateLimit: 60,
    residentBlockMaxCodePoints: 900,
    residentInterestLimit: 5,
    situationalCandidateLimit: 400,
    situationalItemLimit: 5,
    situationalBlockMaxCodePoints: 600,
    searchMemory: Object.freeze({ defaultLimit: 10, maxLimit: 20, outputMaxCodePoints: 2_000, candidateLimit: 400 }),
    retrievalConditioning: Object.freeze({ candidateLimit: 30, outputMaxCodePoints: 240, familiarDocumentLimit: 5 }),
  }),

  writeAndExtraction: Object.freeze({
    contentMaxCodePoints: 300,
    topicMaxCodePoints: 80,
    topicNormalizedKeyMaxCodePoints: 120,
    memoryNormalizedKeyMaxCodePoints: 200,
    importance: Object.freeze({ min: 1, max: 5, manualDefault: 3, explicit: 4 }),
    explicitStatementMinCodePoints: 2,
    pendingSessionLimit: 32,
    tombstoneRetentionLimit: 500,
    extractionPromptTombstoneLimit: 30,
    clearScanBatchSize: 500,
    extractedSourceRejectionWindowSeconds: 3_600,
    opaqueSecretMinCodePoints: 40,
    redactedContentMinCodePoints: 6,
    newUserMessageLimit: 40,
    truncationProbeExtraMessages: 1,
    segmentGapSeconds: 3_600,
    segmentLimit: 3,
    priorUserContextLimitPerSegment: 4,
    transcriptLineMaxCodePoints: 1_000,
    decisionLimitPerSegment: 8,
    existingCandidateLimit: 200,
    existingPromptLimit: 15,
    topicCandidateLimit: 40,
    topicPromptLimit: 12,
    topicAliasLimit: 12,
    initialModelOutputTokens: 1_200,
    truncatedRetryModelOutputTokens: 4_000,
    queueFailureRetryLimit: 2,
    inFlightLeaseExtraSeconds: 600,
    truncatedFollowUpSeconds: 15,
    modelTemperature: 0,
    modelThinking: false,
  }),

  lexicalVectorInterestAffinity: Object.freeze({
    unigramWeight: 1,
    cjkBigramWeight: 2,
    importanceScoreMultiplier: 0.01,
    lexicalMinimumScore: 0.15,
    queryEmbeddingTimeoutSeconds: 2,
    embeddingWriteTimeoutSeconds: 10,
    cosineMinimumScore: 0.50,
    vectorCandidateLimit: 400,
    memoryRrfK: 60,
    memoryRrfRankBase: 0,
    vectorPreFusionMaxItemsMultiplier: 2,
    embeddingBackfillBatchSize: 50,
    interestPromotionHits: 3,
    topicDiceMergeMinimum: 0.80,
    topicDiceMergeMinKeyCodePoints: 4,
    topicLabelBidirectionalAnchorMinimum: 0.30,
    topicLongKeyWarningCodePoints: 24,
    topicMergeModelOutputTokens: 800,
    documentAffinityMinimumHits: 2,
    documentAffinityCandidateLimit: 200,
    documentAffinitySaturationHits: 8,
    documentAffinityMaximumFactor: 1.15,
  }),

  consolidation: Object.freeze({
    automaticMinimumIntervalSeconds: 86_400,
    manualMinimumIntervalSeconds: 60,
    automaticMinimumItems: 6,
    automaticMaximumClusterSize: 3,
    manualMaximumClusterSize: 8,
    automaticJaccardThreshold: 0.55,
    manualJaccardThreshold: 0.30,
    automaticCosineThreshold: 0.86,
    manualCosineThreshold: 0.75,
    modelTemperature: 0,
    modelThinking: false,
    modelMaxOutputTokens: 600,
    mergedStatementMaxCodePoints: 60,
    staleTaskDays: 45,
    staleTaskImportance: 1,
  }),

  management: Object.freeze({
    listDefaultLimit: 50,
    listMaxLimit: 200,
    exportBatchSize: 500,
    exportMaximumItems: 20_000,
  }),
} as const);

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryWriteMode = (typeof MEMORY_WRITE_MODES)[number];
export type MemoryContractConstants = typeof MEMORY_CONSTANTS;
