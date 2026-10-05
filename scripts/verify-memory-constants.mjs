import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `verify-memory-constants-${process.pid}-${Date.now()}`);
const outputs = {
  constants: path.join(stagingRoot, 'memoryConstants.cjs'),
  legacy: path.join(stagingRoot, 'memoryLegacyContract.cjs'),
};

assertTemporaryPath(stagingRoot);
try {
  await Promise.all([
    bundle('electron/knowledge/memory/memoryConstants.ts', outputs.constants),
    bundle('electron/knowledge/memory/memoryLegacyContract.ts', outputs.legacy),
  ]);

  const { MEMORY_CONSTANTS: c, MEMORY_CONTRACT_VERSION, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_STATUSES, MEMORY_WRITE_MODES } = await load(outputs.constants);
  const { LEGACY_MEMORY_FLAGS, LEGACY_MEMORY_SHADOW_BASELINE, MEMORY_ROUTES } = await load(outputs.legacy);

  assert.equal(MEMORY_CONTRACT_VERSION, 'weknora-memory-contract-v1');
  assert.deepEqual(MEMORY_KINDS, ['profile', 'preference', 'fact', 'task', 'interest']);
  assert.deepEqual(MEMORY_ORIGINS, ['explicit', 'extracted', 'manual']);
  assert.deepEqual(MEMORY_STATUSES, ['active', 'pending', 'superseded', 'archived']);
  assert.deepEqual(MEMORY_WRITE_MODES, ['explicit_only', 'auto']);

  assert.deepEqual(c.workspaceConfig, {
    enabledByDefault: false,
    defaultWriteMode: 'explicit_only',
    defaultExtractModelId: null,
    maxItems: { default: 200, serviceMin: 1, serviceMax: 2_000, uiMin: 10, uiMax: 2_000 },
    extractDelaySeconds: { default: 90, min: 5, max: 3_600 },
    extractMinIntervalSeconds: { default: 300, max: 86_400 },
    extractInstructionsMaxCodePoints: 1_000,
    interestThreshold: { default: 3, min: 1, max: 20 },
    retrievalConditioningByDefault: true,
    defaultEmbeddingModelId: null,
    vectorRecallByDefault: true,
  });

  assert.equal(c.workingMemory.defaultMaxContextTokens, 200_000);
  assert.deepEqual(c.workingMemory.toolResultBudget, { ratio: 0.20, minTokens: 8_192, maxTokens: 32_768 });
  assert.deepEqual(c.workingMemory.partialToolResultPreview, { headRatio: 0.25, tailRatio: 0.75 });
  assert.deepEqual(c.workingMemory.summary, {
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
  });
  assert.equal(c.workingMemory.atomicPruneTriggerRatioExclusive, 0.80);
  assert.deepEqual(c.workingMemory.fallbackTokenEstimate, { perMessageOverheadTokens: 3, conversationTailTokens: 3 });

  assert.deepEqual(c.conversationHistory, {
    recentCompleteTurns: 5,
    overfetchMultiplier: 4,
    overfetchMinimumMessages: 50,
    search: {
      defaultLimit: 5,
      maxLimit: 8,
      internalPageExtra: 2,
      keywordCandidateMultiplier: 3,
      questionPreviewMaxCodePoints: 400,
      answerPreviewMaxCodePoints: 400,
      rrfK: 60,
      rankBase: 1,
    },
    retainRetrievalHistoryByDefault: false,
  });

  assert.deepEqual(c.recall, {
    residentCandidateLimit: 60,
    residentBlockMaxCodePoints: 900,
    residentInterestLimit: 5,
    situationalCandidateLimit: 400,
    situationalItemLimit: 5,
    situationalBlockMaxCodePoints: 600,
    searchMemory: { defaultLimit: 10, maxLimit: 20, outputMaxCodePoints: 2_000, candidateLimit: 400 },
    retrievalConditioning: { candidateLimit: 30, outputMaxCodePoints: 240, familiarDocumentLimit: 5 },
  });

  assert.deepEqual(c.writeAndExtraction, {
    contentMaxCodePoints: 300,
    topicMaxCodePoints: 80,
    topicNormalizedKeyMaxCodePoints: 120,
    memoryNormalizedKeyMaxCodePoints: 200,
    importance: { min: 1, max: 5, manualDefault: 3, explicit: 4 },
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
  });

  assert.deepEqual(c.lexicalVectorInterestAffinity, {
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
  });

  assert.deepEqual(c.consolidation, {
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
  });
  assert.deepEqual(c.management, { listDefaultLimit: 50, listMaxLimit: 200, exportBatchSize: 500, exportMaximumItems: 20_000 });

  assert.deepEqual(MEMORY_ROUTES, ['chat', 'knowledge-base', 'current-note-direct', 'current-note-react']);
  assert.deepEqual(LEGACY_MEMORY_FLAGS, {
    qaSummaryProjection: true,
    qaConversationCheckpointProjection: true,
    currentNoteRollingSummaryProjection: true,
    currentNoteDirectHistoryProjection: true,
    userProfileProjection: true,
  });
  assert.deepEqual(Object.keys(LEGACY_MEMORY_SHADOW_BASELINE), MEMORY_ROUTES);

  console.log('WeKnora memory constants verification passed');
} finally {
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function bundle(relativePath, outfile) {
  return build({
    entryPoints: [path.join(rootDir, relativePath)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}

