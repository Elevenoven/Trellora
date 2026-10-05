import type { EditorPreferences } from '../shared/editorPreferences';
import type { DocumentEncoding, DocumentOpenRequest, DocumentOpenResult, DocumentDraftRequest, DocumentDraftResult, DocumentSaveRequest, DocumentSaveResult, DocumentCloseRequest, DocumentCloseResult, DocumentJoinRequest, DocumentJoinResult, DocumentRecovery, DocumentRecent, DocumentSnapshot } from '../shared/documentSession';
import type { SelectionTransformAction, SelectionTransformRequest, SelectionTransformResult } from '../electron/knowledge/selectionTransformTypes';
import type { NoteEditSnapshot, SaveNoteRequest, SaveNoteResult, NoteMutationRequest, NoteCloseRequest, NoteCloseResponse, NoteSaveState, NoteIndexChanged } from '../shared/noteSave';
import type { NoteExportRequest } from '../shared/noteExport';
import type { CreateAssistantNoteRequest, CreateAssistantNoteResult } from '../shared/assistantNote';
import type { StartupAppearance } from '../shared/startupAppearance';
import type { WorkspaceMigrationPreview, WorkspaceMigrationState, WorkspaceMigrationStatus } from '../shared/workspaceMigration';
import type { CapabilityProbeRequest, CapabilityRequest, CapabilitySnapshot } from '../shared/userCapabilities';
import type { OnboardingState, OnboardingUpdate, OnboardingPracticeBinding } from '../shared/onboarding';
import type { ModelConfigurationChange, ModelConfigurationSaveResult, ModelProviderCatalogDraft } from '../shared/modelConfiguration';
import type { ModelHub, ModelHubPatch } from '../shared/modelHubTypes';
import type { MaterialVectorGeneration } from '../shared/materialVectorGenerations';
export type { ModelSlotId, ModelSlot, ProviderConnection, ModelHub, ModelHubPatch } from '../shared/modelHubTypes';
import type { BackupConfiguration, BackupStatus, RestorePreview, RestoreStatus, RestoredConnectionHints } from '../shared/workspaceBackup';
import type { ReleaseCheckResult } from '../shared/releaseCheck';
import type { SelectionEditRunRequest, SelectionEditRunResult } from '../electron/knowledge/selectionEditIpc';
import type { SelectionExpansionCapabilities, SelectionExpansionEvent, SelectionExpansionEvidence, SelectionExpansionPlan, SelectionExpansionRequest, SelectionExpansionResult, SelectionExpansionSettings, SelectionExpansionSettingsPatch, SelectionExpansionSourcePreparation } from '../electron/knowledge/selectionExpansionTypes';
import type { SelectionEditAction, SelectionEditContextScope } from '../electron/knowledge/selectionEditTypes';
import type { AgentStopReason, AssistantAnswerDepth, AssistantAttachment, AssistantCitationValidation, AssistantContextSource, AssistantContextSourceKind, AssistantEvidenceCitation, AssistantEvidenceContextStats, AssistantIntent, AssistantKnowledgeBaseCitation, AssistantPlanGoalStatus, AssistantPlanStatus, AssistantPublicModelEvent, AssistantPublicModelText, AssistantScope, AssistantThinkingMode, AssistantTurnEvent, AssistantTurnRequest, AssistantTurnResult, AssistantWebCitation, AssistantWikiScopeProgress, AssistantWikiScopeResult, CurrentNoteAgentStats, CurrentNoteCacheUsage, CurrentNoteContextMode, CurrentNotePublicPlanEvent, CurrentNotePublicPlanGoal, CurrentNotePublicSearchCoverage, CurrentNotePublicSearchScope, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, CurrentNoteSummaryCoverage, CurrentNoteToolStats, EvidencePromptManifest, LibrarySectionNavigationCandidate, LibrarySectionNavigationObservation } from '../electron/knowledge/assistantTurnTypes';
import type { AssistantMemoryMode, AssistantMemorySettings, AssistantSessionDetail, AssistantSessionSummary } from '../electron/knowledge/assistantMemoryTypes';
import type { QaMemoryPage, QaSessionDetail, QaSessionScope, QaSessionSummary, QaStoredTurn, QaSummaryBlock } from '../electron/knowledge/qaMemoryTypes';
import type { ManualMemoryInput, MemoryExtractionRuntimeStatus, MemoryClearResult, MemoryConsolidationResult, MemoryDocumentAffinity, MemoryImportResult, MemoryItemListQuery, MemoryItemPage, MemoryItemPatch, MemoryItemRecord, MemorySubjectRecord, MemoryTopicRecord, MemoryUsedSnapshot, MemoryWriteResult, WorkspaceMemoryConfig, MemoryProposalReview, MemoryProposalContext, MemoryTurnStatus } from '../electron/knowledge/memory/memoryTypes';
import type { MemoryCitationSource } from '../shared/memoryCitations';
import type { MemoryPage, MemoryPageQuery, MemoryItemPageQuery, MemoryItemCounts } from '../electron/knowledge/memory/memoryTypes';
import type { MemoryCutoverReport } from '../electron/knowledge/memory/memoryCutover';
import type { AssistantDetailedTraceRecordView } from '../electron/knowledge/assistantDetailedTrace';
import type { ContextProjectionDiagnostics } from '../electron/knowledge/contextRuntimeTypes';
import type { WebSearchConfig, WebSearchProviderConfigField, WebSearchProviderId, WebSearchProviderRequirement } from '../electron/websearch/webSearchTypes';
import type { NoteAnalysis, NoteAnalysisRunDetail, NoteAnalysisProgress } from '../electron/knowledge/noteAnalysisTypes';
export type { NoteAnalysis, NoteAnalysisTagCandidate, NoteAnalysisRunDetail, NoteAnalysisProgress, NoteAnalysisBatchResult, NoteAnalysisSourceSpan, NoteAnalysisRunState, NoteAnalysisLengthHandling } from '../electron/knowledge/noteAnalysisTypes';

export type { SelectionTransformAction, SelectionTransformRequest, SelectionTransformResult };
export type { SelectionEditRunRequest, SelectionEditRunResult };
export type { SelectionExpansionCapabilities, SelectionExpansionEvent, SelectionExpansionEvidence, SelectionExpansionPlan, SelectionExpansionRequest, SelectionExpansionResult, SelectionExpansionSettings, SelectionExpansionSettingsPatch, SelectionExpansionSourcePreparation };
export type { SelectionEditAction, SelectionEditContextScope };
export type { AgentStopReason, AssistantAnswerDepth, AssistantAttachment, AssistantCitationValidation, AssistantContextSource, AssistantContextSourceKind, AssistantEvidenceCitation, AssistantEvidenceContextStats, AssistantIntent, AssistantKnowledgeBaseCitation, AssistantPlanGoalStatus, AssistantPlanStatus, AssistantPublicModelEvent, AssistantPublicModelText, AssistantScope, AssistantThinkingMode, AssistantTurnEvent, AssistantTurnRequest, AssistantTurnResult, AssistantWebCitation, AssistantWikiScopeProgress, AssistantWikiScopeResult, CurrentNoteAgentStats, CurrentNoteCacheUsage, CurrentNoteContextMode, CurrentNotePublicPlanEvent, CurrentNotePublicPlanGoal, CurrentNotePublicSearchCoverage, CurrentNotePublicSearchScope, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, CurrentNoteSummaryCoverage, CurrentNoteToolStats, EvidencePromptManifest, LibrarySectionNavigationCandidate, LibrarySectionNavigationObservation };
export type { AssistantMemoryMode, AssistantMemorySettings, AssistantSessionDetail, AssistantSessionSummary };
export type { QaMemoryPage, QaSessionDetail, QaSessionScope, QaSessionSummary, QaStoredTurn, QaSummaryBlock };
export type { ManualMemoryInput, MemoryExtractionRuntimeStatus, MemoryClearResult, MemoryConsolidationResult, MemoryDocumentAffinity, MemoryImportResult, MemoryItemListQuery, MemoryItemPage, MemoryItemPatch, MemoryItemRecord, MemorySubjectRecord, MemoryTopicRecord, MemoryUsedSnapshot, MemoryWriteResult, WorkspaceMemoryConfig };
export type { MemoryCutoverReport };
export type { AssistantDetailedTraceRecordView };
export type { ContextProjectionDiagnostics };
export type { WebSearchConfig, WebSearchProviderConfigField, WebSearchProviderId, WebSearchProviderRequirement };

/** 设置页可见的联网搜索厂商卡片信息；不含运行时密钥。 */
export interface WebSearchProviderView {
    id: WebSearchProviderId;
    label: string;
    description: string;
    requirements: WebSearchProviderRequirement;
    docsUrl?: string;
    configFields?: WebSearchProviderConfigField[];
}

export interface WebSearchConfigView {
    config: WebSearchConfig;
    providers: WebSearchProviderView[];
}

export interface HeadingEntry {
    id: string;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
    line: number;
    index: number;
}

export interface WikiLinkEntry {
    target: string;
    alias?: string;
}

export interface BacklinkEntry {
    sourcePath: string;
    sourceTitle: string;
    snippet: string;
}

export interface TagSummary {
    tag: string;
    count: number;
}

export type SaveEditorImageRequest = {
    notePath: string;
    bytes: Uint8Array;
    sourcePath?: never;
} | {
    notePath: string;
    sourcePath: string;
    bytes?: never;
};

export interface SavedEditorImage {
    markdownPath: string;
    absolutePath: string;
    fileName: string;
}

export interface BackupEntry {
    id: string;
    createdAt: string;
    path: string;
}

export interface OllamaModel {
    name: string;
    size?: number;
    modifiedAt?: string;
    contextWindowTokens?: number;
    contextWindowSource?: 'provider' | 'ollama';
    maxOutputTokens?: number;
    reasoning?: boolean;
}

export interface AiProviderStatus {
    available: boolean;
    endpoint: string;
    models: OllamaModel[];
    message?: string;
}

export type AiProviderKind = 'ollama' | 'openai-compatible';
export type AiRemoteProviderId = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'moonshot' | 'qwen' | 'zhipu' | 'siliconflow' | 'openrouter' | 'custom';
export type AiGenerationApi = 'ollama-chat' | 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generate-content';
export interface AiProviderConfig {
    kind: AiProviderKind;
    provider?: AiRemoteProviderId;
    api?: AiGenerationApi;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    contextWindowTokens?: number;
    contextWindowTokensSource?: 'user';
    embeddingModel?: string;
    availableModels?: OllamaModel[];
    hasApiKey?: boolean;
    remoteContentConsent?: boolean;
}

  export interface AiModelProfile {
    id: string;
    label: string;
    config: AiProviderConfig;
  }

  export interface AiModelProfileView {
    id: string;
    label: string;
    config: Omit<AiProviderConfig, 'apiKey'> & { hasApiKey: boolean };
  }

export interface AiModelSettings {
    schemaVersion: 1;
    defaultProfileId: string;
    profiles: AiModelProfileView[];
}

export interface AiModelSettingsInput {
    defaultProfileId: string;
    profiles: AiModelProfile[];
}

export type AiSkillGenerationStyle = 'factual' | 'balanced' | 'creative';

export interface AiSkill {
    id: string;
    name: string;
    description: string;
    instruction: string;
    generationStyle: AiSkillGenerationStyle;
    enabled: boolean;
    system: boolean;
}

export interface AiExtensionsSettings {
    schemaVersion: 1;
    skills: AiSkill[];
    directorySkillOverrides?: Record<string, DirectorySkillOverride>;
}

export interface DirectorySkillOverride {
    enabled: boolean;
    importedAt?: string;
}

export type AiSkillImportKind = 'folder' | 'zip' | 'markdown';

export interface SkillImportResult {
    ok: boolean;
    skillName?: string;
    resourceFileCount?: number;
    error?: string;
}

export interface SkillFormCreateInput {
    name: string;
    description: string;
    instruction: string;
}

export interface SkillDocumentUpdateResult {
    ok: boolean;
    error?: string;
}

export interface SkillExportResult {
    ok: boolean;
    canceled?: boolean;
    error?: string;
}

export interface DirectorySkillOverviewEntry {
    name: string;
    description: string;
    instruction: string;
    resourceFileCount: number;
    enabled: boolean;
    system: boolean;
    importedAt?: string;
}

export interface DirectorySkillIssue {
    directory: string;
    reason: string;
}

export interface AiSkillsOverview {
    directorySkills: DirectorySkillOverviewEntry[];
    skipped: DirectorySkillIssue[];
    nameConflicts: DirectorySkillIssue[];
}

  export interface AssistantAiOptions {
    defaultProfileId: string;
    profiles: Array<{ id: string; label: string; kind: AiProviderKind; provider?: AiRemoteProviderId; model?: string; contextWindowTokens?: number }>;
    skills: Array<{ id: string; name: string; description: string; enabled: boolean; system: boolean }>;
  }

export type ParsingEngine = 'mammoth' | 'mineru';
export interface ParsingConfig {
    engine: ParsingEngine;
    mineruEndpoint: string;
    cloudParsingConsent: boolean;
    hasMineruKey: boolean;
}

export interface PipelineAmbiguityConfig {
    enabled: boolean;
    minConfidence: number;
    maxConfidence: number;
    maxCandidatesPerBatch: number;
    maxInputCharacters: number;
    timeoutMs: number;
    maxOutputTokens: number;
    promptVersion: string;
}
export interface PipelineStructureConfig {
    strategy: 'heading' | 'fixed';
    targetChars: number;
    overlapChars: number;
    minChars: number;
    maxChars: number;
}
export type ChunkingMode = 'recommended' | 'custom';
export type ChunkStrategyCode = 'STRUCTURE' | 'RECURSIVE' | 'SEMANTIC' | 'LLM' | 'PAGE' | 'REGEX' | 'FIXED';
export type ParentStrategyCode = 'STRUCTURE' | 'RECURSIVE' | 'PAGE' | 'REGEX' | 'FIXED';
export type ChildStrategyCode = ChunkStrategyCode;
export interface LibraryChunkingConfig {
    schemaVersion: 2;
    mode: ChunkingMode;
    parentStrategies: ParentStrategyCode[];
    childStrategies: ChildStrategyCode[];
    parentMinChars: number;
    parentTargetChars: number;
    parentMaxChars: number;
    parentOverlapChars: number;
    childRecursiveMaxChars: number;
    childRecursiveOverlapChars: number;
    semanticMaxChars: number;
    semanticMinChars: number;
    semanticSimilarityThreshold: number;
    llmEnabled: boolean;
    llmMaxChars: number;
    llmTimeoutMs: number;
    llmMaxOutputTokens: number;
    llmPromptVersion: string;
    recommendLlmWhenLowQuality: boolean;
    pageMinMetadataCoverage: number;
    regexPattern: string;
    regexFlags: Array<'i' | 'm'>;
    regexBoundary: 'before' | 'after';
    regexKeepDelimiter: boolean;
    childFixedTargetChars: number;
    childFixedMinChars: number;
    childFixedMaxChars: number;
    childFixedOverlapChars: number;
    migration?: { source: 'pipelineStructure-v1'; migratedAt: string };
}
export interface LibraryLeidenConfig {
    resolution: number;
    maxDepth: number;
    minSplitSize: number;
    seed: number;
}
export interface LibraryGraphEnhancementConfig {
    schemaVersion: 1;
    enabled: boolean;
    maxChars: number;
    maxEntitiesPerChunk: number;
    maxRelationsPerChunk: number;
    promptVersion: string;
    llmTimeoutMs: number;
    llmMaxOutputTokens: number;
    leidenConfig: LibraryLeidenConfig;
    summaryPromptVersion: string;
    summaryBudgetTokens: number;
    globalSearchLevel: number;
}
export interface LibraryGraphProjectionStatus {
    graphKey: string;
    engine: string;
    levels: number;
    entityCount: number;
    relationCount: number;
    communityCount: number;
    summaryCoverage: number;
    summaryGeneratedAt: string;
    vectorCoverage: number;
    vectorGeneratedAt: string;
    importedAt: string;
}
export interface LibraryGraphCommunityRow {
    communityId: string;
    level: number;
    parentId: string | null;
    memberCount: number;
    memberKeys: string[];
    summary: string;
    tokens: number;
}
export interface LibraryGraphVisualizationEntity {
    canonicalKey: string;
    mention: string;
    type: string;
    description: string;
    degree: number;
    communityId: string;
    docIds: string[];
}
export interface LibraryGraphVisualizationEdge {
    sourceKey: string;
    targetKey: string;
    weight: number;
    kinds: string[];
}
export interface LibraryGraphVisualizationCommunity {
    communityId: string;
    level: number;
    parentId: string | null;
    memberCount: number;
    memberKeys: string[];
    summary: string;
    tokens: number;
}
export interface LibraryGraphVisualizationCommunityEdge {
    sourceCommunityId: string;
    targetCommunityId: string;
    weight: number;
    edgeCount: number;
}
export interface LibraryGraphVisualizationPayload {
    status: LibraryGraphProjectionStatus;
    entities: LibraryGraphVisualizationEntity[];
    edges: LibraryGraphVisualizationEdge[];
    communities: LibraryGraphVisualizationCommunity[];
    communityEdges: LibraryGraphVisualizationCommunityEdge[];
    truncated: boolean;
}
export interface LibraryPipelineLlmBinding {
    schemaVersion: 1;
    source: string;
    model: string;
}
export interface KeywordExtractionConfig {
    schemaVersion: 1;
    enabled: boolean;
    algorithm: 'hybrid-statistical';
    tokenizer: 'jieba';
    hmm: false;
    minScore: number;
    minKeywords: number;
    maxKeywords: number;
    maxCandidatesPerChunk: number;
    ngramMin: 1;
    ngramMax: number;
    textRank: { windowSize: number; damping: number; maxIterations: number; tolerance: number };
    weights: { tfidf: number; textRank: number; position: number; sentenceSpread: number; sectionMatch: number; termQuality: number };
    boilerplateDfRatio: number;
    allowOverlapFallback: boolean;
}
export interface PipelineKeywordResources {
    config: KeywordExtractionConfig;
    dictionaryTerms: string[];
    stopwords: string[];
    dictionaryHash: string;
    stopwordHash: string;
    validationError?: { code: 'KEYWORDS_CONFIG_INVALID' | 'KEYWORDS_RESOURCE_LIMIT'; message: string; retryable: false };
}

export type MaterialEmbeddingTransportKind = 'ollama' | 'openai-compatible';
export type MaterialEmbeddingProfileState = 'UNBOUND' | 'LOCKED' | 'LEGACY_UNBOUND';
export interface MaterialEmbeddingCandidate {
    schemaVersion: 1;
    sourceId: string;
    transportKind: MaterialEmbeddingTransportKind;
    endpointIdentity: string;
    requestedModel: string;
    requestedDimensions?: number;
    vectorType: 'float32';
    distanceMetric: 'cosine';
    encodingFormat: 'float';
    truncateInputs: boolean;
    documentInputVersion: string;
    queryInputVersion: string;
}
export interface MaterialEmbeddingProfile {
    schemaVersion: 1;
    profileHash: string;
    state: 'LOCKED';
    sourceId: string;
    transportKind: MaterialEmbeddingTransportKind;
    endpointIdentity: string;
    requestedModel: string;
    responseModel?: string;
    requestedDimensions?: number;
    vectorDimension: number;
    vectorType: 'float32';
    distanceMetric: 'cosine';
    encodingFormat: 'float';
    truncateInputs: boolean;
    documentInputVersion: string;
    queryInputVersion: string;
    lockedAt: string;
    appVersion: string;
}
export interface MaterialEmbeddingProfileTestResult {
    state: 'TESTED';
    candidate: MaterialEmbeddingCandidate;
    responseModel?: string;
    vectorDimension: number;
    profileHash: string;
}
export interface MaterialEmbeddingProfileStatus {
    state: MaterialEmbeddingProfileState;
    profile?: MaterialEmbeddingProfile;
    legacy?: {
        vectorTableExists: boolean;
        vectorRowCount: number;
        storedModel?: string;
        storedDimension?: number;
    };
}
export interface RemoteProviderModelsResult {
    available: boolean;
    models: string[];
    message: string;
}

export type AppTheme = 'system' | 'light' | 'dark';
export type InterfaceDensity = 'comfortable' | 'compact';
export type StartupBehavior = 'library' | 'last-note';
export type PreferredEditorMode = 'wysiwyg' | 'preview' | 'source';
export type PreviewPreference = 'rendered' | 'source';
export type ExternalLinkOpenMode = 'in-app' | 'system-default';
export type AssistantPlanMode = 'off' | 'shadow-plan' | 'current-note' | 'library-beta' | 'default';
export type AdaptiveContextMode = 'off' | 'observe' | 'enforce';
export type AssistantEvidenceProjectionMode = 'minimal' | 'all-retrieved';
export type EvidenceCompressionMode = 'off' | 'observe' | 'enforce';
export type AssistantContextRuntimeMode = 'off' | 'observe' | 'enforce';
export type AssistantContextRuntimeRouteMode = AssistantContextRuntimeMode | 'inherit';
export type MemoryProjectionMode = 'legacy' | 'observe' | 'canonical';
export type MemoryProjectionRouteMode = MemoryProjectionMode | 'inherit';
export interface AppPreferences extends EditorPreferences {
    schemaVersion: 1;
    theme: AppTheme;
    lightColorScheme: import('../shared/lightColorSchemes').LightColorScheme;
    density: InterfaceDensity;
    language: import('../shared/appLanguage').AppLanguage;
    startupBehavior: StartupBehavior;
    externalLinkOpenMode: ExternalLinkOpenMode;
    backupRetention: number;
    defaultEditorMode: PreferredEditorMode;
    autosaveDelayMs: number;
    previewPreference: PreviewPreference;
    assistantPlanMode: AssistantPlanMode;
    adaptiveContextMode: AdaptiveContextMode;
    /** Optional while older renderer startup defaults are migrated. */
    assistantEvidenceProjectionMode?: AssistantEvidenceProjectionMode;
    /** Optional while older renderer startup defaults are migrated. */
    evidenceCompressionMode?: EvidenceCompressionMode;
    assistantContextRuntimeMode?: AssistantContextRuntimeMode;
    assistantContextRuntimeChatMode?: AssistantContextRuntimeRouteMode;
    assistantContextRuntimeKnowledgeBaseMode?: AssistantContextRuntimeRouteMode;
    assistantContextRuntimeCurrentNoteDirectMode?: AssistantContextRuntimeRouteMode;
    assistantContextRuntimeCurrentNoteReactMode?: AssistantContextRuntimeRouteMode;
    assistantMemoryProjectionMode?: MemoryProjectionMode;
    assistantMemoryProjectionChatMode?: MemoryProjectionRouteMode;
    assistantMemoryProjectionKnowledgeBaseMode?: MemoryProjectionRouteMode;
    assistantMemoryProjectionCurrentNoteDirectMode?: MemoryProjectionRouteMode;
    assistantMemoryProjectionCurrentNoteReactMode?: MemoryProjectionRouteMode;
    leftSidebarWidth: number;
    rightPanelWidth: number;
    lastOpenedNote?: string;
}
export interface AppDiagnostics {
    logDegraded?: boolean;
    recentEvents?: Array<{ at: string; level: 'info' | 'warn' | 'error'; module: string; code: string; taskId?: string }>;
    generatedAt: string;
    appVersion: string;
    electronVersion: string;
    platform: string;
    architecture: string;
    userDataPath: string;
    logsPath: string;
    workspacePath: string;
    libraryConfigured: boolean;
    noteCount: number;
    aiProvider: { kind: AiProviderKind; endpoint?: string; model?: string; hasApiKey: boolean };
}

export interface AiInsight {
    notePath: string;
    contentHash: string;
    provider: AiProviderKind;
    model: string;
    generatedAt: string;
    summary: string;
    keyPoints: string[];
    suggestedTags: string[];
}

export interface AppliedTagsResult {
    markdown: string;
    tags: string[];
}

export type TagSuggestionConfidence = 'high' | 'medium' | 'low';

export interface AssistantAnswer {
    type: 'answer';
    answer: string;
    sources: string[];
    sourceNotes: AssistantSource[];
    retrievalMode: 'keyword' | 'none';
}

export interface AssistantSource {
    path: string;
    title: string;
    snippet: string;
    score: number;
    methods: Array<'keyword'>;
}

export interface LearningPlanStep {
    title: string;
    rationale: string;
    sourceTitles: string[];
}

export interface LearningPlan {
    goal: string;
    provider: AiProviderKind;
    model: string;
    generatedAt: string;
    steps: LearningPlanStep[];
}

export interface OrganizationSuggestionGroup {
    title: string;
    noteTitles: string[];
    rationale: string;
}

export interface OrganizationSuggestion {
    provider: AiProviderKind;
    model: string;
    generatedAt: string;
    groups: OrganizationSuggestionGroup[];
    nextActions: string[];
}

export type UnifiedSearchMode = 'keyword';
export interface UnifiedSearchResult {
    path: string;
    title: string;
    relativePath: string;
    snippet?: string;
    heading?: string;
    matchTypes: Array<'关键词'>;
    score: number;
    searchTerm?: string;
}
export interface UnifiedSearchOutcome {
    results: UnifiedSearchResult[];
    mode: UnifiedSearchMode;
    used: '关键词搜索';
    notice?: string;
}

export type FileKind = 'markdown' | 'text';

export interface FileNode {
    path: string;
    name: string;
    isDirectory: boolean;
    kind: 'directory' | FileKind;
    extension?: string;
    title?: string;
    children?: FileNode[];
}

export interface LibraryChange {
    kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
    path: string;
}

export interface LibraryChangePayload {
    files: FileNode[];
    changes: LibraryChange[];
}

export interface LibrarySummary {
    path: string;
    alias: string;
    addedAt: string;
    lastOpenedAt: string;
    exists: boolean;
    isActive: boolean;
    noteCount: number;
    attachmentCount: number;
}

export type MaterialsLibraryOrigin = 'created' | 'upgraded';
export type MaterialsVectorState = '未启用' | '待索引' | '已索引';

export interface MaterialsDocument {
    id: string;
    name: string;
    relativePath: string;
    absolutePath: string;
    extension: string;
    sizeBytes: number;
    addedAt: string;
    contentHash: string;
    vectorState: 'pending' | 'indexed';
}

export type MaterialChunkSearchMode = 'hybrid' | 'keyword' | 'semantic';
export interface MaterialChunkCitation {
    documentId: string;
    chunkId: string;
    parentChunkId: string | null;
    contentHash: string;
    text: string;
    sourceText: string;
    sectionContext: string;
    sourceRefs: unknown[];
    parent?: { chunkId: string; ordinal: number; text: string; sourceText: string; sourceRefs: unknown[] };
}
export interface MaterialChunkSearchResult {
    documentId: string;
    chunkId: string;
    parentChunkId: string | null;
    ordinal: number;
    text: string;
    sectionPath: unknown[];
    sectionContext: string;
    contentHash: string;
    score: number;
    bm25Score: number;
    keywordScore: number;
    vectorScore: number;
    matchTypes: Array<'原文' | '关键词' | '语义' | '图扩展'>;
    citation: MaterialChunkCitation;
}
export interface MaterialChunkSearchOutcome {
    results: MaterialChunkSearchResult[];
    mode: MaterialChunkSearchMode;
    used: '综合搜索' | '关键词搜索' | '语义搜索';
    indexedChunks: number;
    vectorIndexed: boolean;
    notice?: string;
}
export interface MaterialChunkVectorResult {
    indexed: number;
    skipped: number;
    dimension: number;
    embeddingModel: string;
    completedAt: string;
}

export interface MaterialsLibrarySummary {
    path: string;
    alias: string;
    icon: string;
    origin: MaterialsLibraryOrigin;
    addedAt: string;
    upgradedAt?: string;
    lastOpenedAt: string;
    exists: boolean;
    isActive: boolean;
    documentCount: number;
    totalSizeBytes: number;
    vectorState: MaterialsVectorState;
}

export interface WikiDocumentOutlineNode {
    id: string;
    parentId: string | null;
    title: string;
    order: number;
    depth: number;
    markdown: string;
    sourceHeadingId: string;
    sourceLineNo: number;
    kind?: 'source' | 'derived';
}

export interface WikiDocumentOutline {
    documentId: string;
    title: string;
    description: string;
    updatedAt: string;
    contentHash: string;
    orderRevisions: Record<string, string>;
    nodes: WikiDocumentOutlineNode[];
}

export type WikiSiblingOrderErrorCode = 'WIKI_ORDER_CONFLICT' | 'WIKI_ORDER_INVALID' | 'WIKI_ORDER_SAVE_FAILED' | 'WIKI_ORDER_SOURCE_STALE';
export interface WikiSiblingOrderRequest {
    documentId: string;
    parentId: string;
    orderedNodeIds: string[];
    expectedRevision: string;
}
export type WikiSiblingOrderResult =
    | { ok: true; documentId: string; parentId: string; orderedNodeIds: string[]; revision: string; updatedAt: string }
    | { ok: false; error: { code: WikiSiblingOrderErrorCode; message: string; diagnostic?: string } };

export type WikiDerivedErrorCode = 'WIKI_DERIVED_INVALID' | 'WIKI_DERIVED_PARENT_NOT_FOUND' | 'WIKI_DERIVED_SOURCE_PROTECTED' | 'WIKI_DERIVED_NODE_NOT_FOUND' | 'WIKI_DERIVED_LIMIT' | 'WIKI_DERIVED_SAVE_FAILED' | 'WIKI_DERIVED_SOURCE_STALE';
export interface WikiDerivedNodeView {
    id: string;
    parentId: string;
    title: string;
    order: number;
    depth: number;
    markdown: string;
    createdAt: string;
    updatedAt: string;
}
export type WikiDerivedNodeResult =
    | { ok: true; node: WikiDerivedNodeView }
    | { ok: false; error: { code: WikiDerivedErrorCode; message: string; diagnostic?: string } };
export type WikiDerivedDeleteResult =
    | { ok: true; deletedNodeIds: string[] }
    | { ok: false; error: { code: WikiDerivedErrorCode; message: string; diagnostic?: string } };
export interface WikiDerivedNodeRequest {
    documentId: string;
    parentId: string;
    title: string;
    markdown?: string;
}
export interface WikiDerivedRenameRequest {
    documentId: string;
    nodeId: string;
    title: string;
}
export interface WikiDerivedDeleteRequest {
    documentId: string;
    nodeId: string;
}

export type WikiAiMemoryErrorCode = 'WIKI_MEMORY_INVALID' | 'WIKI_MEMORY_NODE_NOT_FOUND' | 'WIKI_MEMORY_NOT_FOUND' | 'WIKI_MEMORY_LIMIT' | 'WIKI_MEMORY_SAVE_FAILED' | 'WIKI_MEMORY_SOURCE_STALE';
export interface WikiAiMemoryMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface WikiAiMemory {
    id: string;
    nodeId: string;
    title: string;
    pinned: boolean;
    conversation: WikiAiMemoryMessage[];
    createdAt: string;
    updatedAt: string;
}
export type WikiAiMemoryListResult =
    | { ok: true; memories: WikiAiMemory[] }
    | { ok: false; error: { code: WikiAiMemoryErrorCode; message: string; diagnostic?: string } };
export type WikiAiMemoryResult =
    | { ok: true; memory: WikiAiMemory }
    | { ok: false; error: { code: WikiAiMemoryErrorCode; message: string; diagnostic?: string } };
export type WikiAiMemoryDeleteResult =
    | { ok: true; deletedMemoryId: string }
    | { ok: false; error: { code: WikiAiMemoryErrorCode; message: string; diagnostic?: string } };
export interface WikiAiMemoryUpsertRequest {
    documentId: string;
    nodeId: string;
    memoryId?: string;
    conversation: WikiAiMemoryMessage[];
}
export interface WikiAiMemoryCreateRequest {
    documentId: string;
    nodeId: string;
}
export interface WikiAiMemoryRenameRequest {
    documentId: string;
    memoryId: string;
    title: string;
}
export interface WikiAiMemoryPinRequest {
    documentId: string;
    memoryId: string;
    pinned: boolean;
}
export interface WikiAiMemoryDeleteRequest {
    documentId: string;
    memoryId: string;
}

export type WikiQuestionsErrorCode = 'WIKI_QUESTIONS_INVALID' | 'WIKI_QUESTIONS_NODE_NOT_FOUND' | 'WIKI_QUESTIONS_MODEL_UNAVAILABLE' | 'WIKI_QUESTIONS_SOURCE_STALE';
export type WikiNodeQuestionsResult =
    | { ok: true; questions: string[]; degraded: boolean; fromCache: boolean }
    | { ok: false; error: { code: WikiQuestionsErrorCode; message: string; diagnostic?: string } };

export type PipelineRoute = 'direct' | 'mammoth' | 'mineru' | 'unsupported';
export type PipelineStageState = 'IDLE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED' | 'WAITING_CONFIG' | 'SKIPPED' | 'CANCELLED' | 'INTERRUPTED';
export interface PipelineError {
    code: string;
    message: string;
    diagnostic?: string;
    retryable: boolean;
}
export type PipelineFtsIndexState = 'PENDING' | 'CURRENT' | 'MISSING' | 'STALE' | 'FAILED';
export interface PipelineFtsIndexStatus {
    state: PipelineFtsIndexState;
    tokenizer: 'jieba-accurate-hmm-off';
    outputSchemaVersion: 3;
    expectedChunks: number;
    expectedKeywords: number;
    indexedChunks: number;
    ftsRows: number;
    indexedKeywords: number;
    indexedAt?: string;
    error?: PipelineError;
}
export interface PipelineDocumentStatus {
    libraryPath: string;
    documentId: string;
    documentName: string;
    extension: string;
    route: PipelineRoute;
    sourceContentHash: string;
      stage: 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities';
      state: PipelineStageState;
      artifactPath?: string;
      counts?: Record<string, number>;
      error?: PipelineError;
      stages?: Partial<Record<'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities', {
          stageKey: string;
          status: PipelineStageState;
          jobId?: string;
          artifactPath?: string;
          startedAt?: string;
          finishedAt?: string;
          updatedAt: string;
          counts?: Record<string, number>;
          outputs?: Record<string, { relativePath: string; sha256: string; bytes: number }>;
          error?: PipelineError;
      }>>;
      ftsIndex?: PipelineFtsIndexStatus;
      updatedAt: string;
}
export interface PipelineProgressEvent {
    libraryPath: string;
    documentId: string;
    jobId: string;
        stage: 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities';
    completed: number;
    total?: number;
    unit?: string;
    message: string;
}
export interface PipelineArtifactPreviewRow {
    lineNumber: number;
    text: string;
}
export interface PipelineArtifactPreview {
    documentId: string;
    stage: 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities';
    fileName: string;
    relativePath: string;
    bytes: number;
    sha256: string;
    offset: number;
    limit: number;
    lineCount: number;
    hasMore: boolean;
    rows: PipelineArtifactPreviewRow[];
}
export interface PipelineKeywordPreviewOccurrence {
    start: number;
    end: number;
    sentenceIndex: number;
}
export interface PipelineKeywordPreviewItem {
    term: string;
    normalizedTerm: string;
    kind: string;
    rank: number;
    score: number;
    occurrences: PipelineKeywordPreviewOccurrence[];
    features: Record<string, number | boolean>;
    forcedTop1: boolean;
}
export interface PipelineKeywordPreviewRow {
    chunkId: string;
    parentChunkId: string | null;
    ordinal: number;
    text: string;
    sourceLocations: string[];
    keywords: PipelineKeywordPreviewItem[];
    emptyReason: string | null;
}
export interface PipelineKeywordPreview {
    documentId: string;
    offset: number;
    limit: number;
    rowCount: number;
    hasMore: boolean;
    rows: PipelineKeywordPreviewRow[];
}

export interface LibraryUiState {
    schemaVersion: 1;
    collapsedFolderPaths: string[];
    pinnedEntryPaths: string[];
}

export interface MovePosition {
    type: 'inside' | 'before' | 'after';
    siblingPath?: string;
}

export interface ImportedTextFile {
    sourcePath: string;
    targetPath: string;
    name: string;
    kind: FileKind;
    extension: string;
}

export interface NoteMeta {
    path: string;
    title: string;
    kind: FileKind;
    extension: string;
    rawMarkdown: string;
    contentMarkdown: string;
    frontmatter: Record<string, unknown>;
    tags: string[];
    headings: HeadingEntry[];
    outgoingLinks: WikiLinkEntry[];
    backlinks: BacklinkEntry[];
    contentHash: string;
    mtimeMs: number;
}

declare global {
    interface ElectronAPI {
        readonly startupAppearance: StartupAppearance | null;
        waitForStartup: () => Promise<void>;
        ping: () => Promise<string>;
        selectDirectory: () => Promise<string | null>;
        selectWorkspace: () => Promise<string | null>;
        getWorkspacePath: () => Promise<string>;
        getWorkspaceMigrationState: () => Promise<WorkspaceMigrationState>;
        previewWorkspaceMigration: () => Promise<WorkspaceMigrationPreview | null>;
        startWorkspaceMigration: (id: string) => Promise<WorkspaceMigrationStatus>;
        cancelWorkspaceMigration: () => Promise<void>;
        abandonWorkspaceMigration: (id: string) => Promise<void>;
        openWorkspaceFolder: () => Promise<string>;
        openExistingWorkspace: () => Promise<string | null>;
        onWorkspaceMigrationStatus: (callback: (status: WorkspaceMigrationStatus) => void) => () => void;
        listLibraries: () => Promise<LibrarySummary[]>;
        addLibrary: () => Promise<string | null>;
        createLibrary: (name: string, parentDirectoryPath?: string | null) => Promise<string | null>;
        activateLibrary: (path: string) => Promise<string>;
        removeLibrary: (path: string) => Promise<LibrarySummary[]>;
        getLibraryPath: () => Promise<string | null>;
        listMaterialsLibraries: () => Promise<MaterialsLibrarySummary[]>;
        createMaterialsLibrary: (name: string, icon?: string | null, chunkingConfigDraft?: Partial<LibraryChunkingConfig>) => Promise<string | null>;
        openMaterialsLibrary: (path: string) => Promise<string>;
        renameMaterialsLibrary: (path: string, alias: string) => Promise<MaterialsLibrarySummary[]>;
        removeMaterialsLibrary: (path: string) => Promise<MaterialsLibrarySummary[]>;
        deleteMaterialsLibrary: (path: string) => Promise<MaterialsLibrarySummary[]>;
        upgradeLibraryToMaterials: (path: string, icon?: string | null, chunkingConfigDraft?: Partial<LibraryChunkingConfig>) => Promise<MaterialsLibrarySummary[]>;
        listMaterialsDocuments: (path: string) => Promise<MaterialsDocument[]>;
        getMaterialsPipelineStatus: (path: string) => Promise<PipelineDocumentStatus[]>;
        getWikiDocumentOutline: (path: string, documentId: string) => Promise<WikiDocumentOutline>;
        importWikiDocumentToNoteLibrary: (sourceLibraryPath: string, documentId: string, contentHash: string, targetLibraryPath: string) => Promise<string>;
        reorderWikiSiblingNodes: (path: string, request: WikiSiblingOrderRequest) => Promise<WikiSiblingOrderResult>;
        addWikiDerivedNode: (path: string, request: WikiDerivedNodeRequest) => Promise<WikiDerivedNodeResult>;
        renameWikiDerivedNode: (path: string, request: WikiDerivedRenameRequest) => Promise<WikiDerivedNodeResult>;
        deleteWikiDerivedNode: (path: string, request: WikiDerivedDeleteRequest) => Promise<WikiDerivedDeleteResult>;
        listWikiAiMemories: (path: string, documentId: string) => Promise<WikiAiMemoryListResult>;
        upsertWikiAiMemory: (path: string, request: WikiAiMemoryUpsertRequest) => Promise<WikiAiMemoryResult>;
        createWikiAiMemory: (path: string, request: WikiAiMemoryCreateRequest) => Promise<WikiAiMemoryResult>;
        setWikiAiMemoryPinned: (path: string, request: WikiAiMemoryPinRequest) => Promise<WikiAiMemoryResult>;
        renameWikiAiMemory: (path: string, request: WikiAiMemoryRenameRequest) => Promise<WikiAiMemoryResult>;
        deleteWikiAiMemory: (path: string, request: WikiAiMemoryDeleteRequest) => Promise<WikiAiMemoryDeleteResult>;
        getWikiNodeQuestions: (path: string, documentId: string, nodeId: string) => Promise<WikiNodeQuestionsResult>;
        refreshWikiNodeQuestions: (path: string, documentId: string, nodeId: string) => Promise<WikiNodeQuestionsResult>;
        getMaterialEmbeddingProfile: (path: string) => Promise<MaterialEmbeddingProfileStatus>;
        listMaterialVectorGenerations: (path: string) => Promise<MaterialVectorGeneration[]>;
        createMaterialVectorGeneration: (path: string, candidate: MaterialEmbeddingCandidate) => Promise<MaterialVectorGeneration>;
        resumeMaterialVectorGeneration: (path: string, id: string) => Promise<void>;
        cancelMaterialVectorGeneration: (path: string, id: string) => Promise<void>;
        activateMaterialVectorGeneration: (path: string, id: string) => Promise<MaterialVectorGeneration>;
        getLibraryPipelineLlm: (path: string) => Promise<LibraryPipelineLlmBinding>;
        saveLibraryPipelineLlm: (path: string, patch: Partial<LibraryPipelineLlmBinding>) => Promise<LibraryPipelineLlmBinding>;
        testMaterialEmbeddingProfile: (path: string, candidate: MaterialEmbeddingCandidate) => Promise<MaterialEmbeddingProfileTestResult>;
        lockMaterialEmbeddingProfile: (path: string, candidate: MaterialEmbeddingCandidate) => Promise<MaterialEmbeddingProfile>;
        getPipelineArtifactPreview: (path: string, documentId: string, stage: PipelineArtifactPreview['stage'], fileName: string, offset?: number, limit?: number, parentChunkId?: string) => Promise<PipelineArtifactPreview>;
        getPipelineKeywordPreview: (path: string, documentId: string, offset?: number, limit?: number) => Promise<PipelineKeywordPreview>;
        searchMaterialChunks: (path: string, query: string, mode?: MaterialChunkSearchMode, documentIds?: string[]) => Promise<MaterialChunkSearchOutcome>;
        startMaterialsPipeline: (path: string, documentId: string) => Promise<PipelineDocumentStatus>;
        cancelMaterialsPipeline: (path: string, documentId: string) => Promise<PipelineDocumentStatus>;
        retryMaterialsPipeline: (path: string, documentId: string) => Promise<PipelineDocumentStatus>;
        readMaterialsDocument: (path: string, documentId: string) => Promise<string | null>;
        readMaterialsDocumentBytes: (path: string, documentId: string) => Promise<Uint8Array | null>;
        renameMaterialsDocument: (path: string, documentId: string, newName: string) => Promise<MaterialsDocument[]>;
        importMaterialsDocuments: (path: string) => Promise<MaterialsDocument[]>;
        deleteMaterialsDocument: (path: string, documentId: string) => Promise<MaterialsDocument[]>;
        getAppPreferences: () => Promise<AppPreferences>;
        saveAppPreferences: (patch: Partial<Omit<AppPreferences, 'schemaVersion'>>) => Promise<AppPreferences>;
        getAppDiagnostics: () => Promise<AppDiagnostics>;
        getWorkspaceBackupStatus: () => Promise<BackupStatus>;
        checkLatestRelease: () => Promise<ReleaseCheckResult>;
        previewWorkspaceRestore: () => Promise<RestorePreview | null>;
        getPendingWorkspaceRestores: () => Promise<RestorePreview[]>;
        startWorkspaceRestore: (id: string, importPreferences: boolean) => Promise<RestoreStatus>;
        cancelWorkspaceRestore: () => Promise<void>;
        openRestoredWorkspace: (workspacePath: string) => Promise<string>;
        getRestorePausedRoots: () => Promise<string[]>;
        getRestoredConnectionHints: () => Promise<RestoredConnectionHints | null>;
        resumeRestoredTasks: () => Promise<boolean>;
        onWorkspaceRestoreStatus: (callback: (status: RestoreStatus) => void) => () => void;
        configureWorkspaceBackup: (config: Pick<BackupConfiguration, 'enabled' | 'targetDirectory' | 'externalLibraries'>) => Promise<BackupStatus>;
        startWorkspaceBackup: (request?: { targetDirectory?: string; externalLibraries?: string[] }) => Promise<BackupStatus>;
        cancelWorkspaceBackup: () => Promise<void>;
        chooseBackupTarget: () => Promise<string | null>;
        onWorkspaceBackupStatus: (callback: (status: BackupStatus) => void) => () => void;
        onMaintenancePrepare: (callback: (request: { requestId: string }) => void) => () => void;
        onMaintenanceChanged: (callback: (status: { phase: 'idle' | 'preparing' | 'capturing' }) => void) => () => void;
        respondMaintenance: (requestId: string, ok: boolean) => void;
        getOnboardingState: () => Promise<OnboardingState>;
        updateOnboardingState: (input: OnboardingUpdate) => Promise<OnboardingState>;
        selectOnboardingProfile: (profileId: string) => Promise<OnboardingState>;
        invalidateOnboardingConnection: (profileId: string) => Promise<OnboardingState>;
        bindOnboardingPractice: (input: OnboardingPracticeBinding) => Promise<OnboardingState>;
        onOnboardingStateChanged: (callback: (state: OnboardingState) => void) => () => void;
        saveOnboardingState: (status: 'skipped' | 'completed') => Promise<OnboardingState>;
        importOnboardingSample: () => Promise<string[]>;
        getUserCapabilities: (request?: CapabilityRequest) => Promise<CapabilitySnapshot>;
        probeUserCapability: (request: CapabilityProbeRequest) => Promise<CapabilitySnapshot>;
        cancelCapabilityProbe: (requestId: string) => Promise<void>;
        openLogsDirectory: () => Promise<boolean>;
        exportDiagnosticReport: () => Promise<boolean>;
        getLibraryUiState: () => Promise<LibraryUiState>;
        saveLibraryUiState: (patch: Partial<Omit<LibraryUiState, 'schemaVersion'>>) => Promise<LibraryUiState>;
        getAiStatus: () => Promise<AiProviderStatus>;
        getAiProviderConfig: () => Promise<AiProviderConfig>;
        getAiModelSettings: () => Promise<AiModelSettings>;
        saveAiModelSettings: (settings: AiModelSettingsInput) => Promise<AiModelSettings>;
        getAiExtensionsSettings: () => Promise<AiExtensionsSettings>;
        saveAiExtensionsSettings: (settings: AiExtensionsSettings) => Promise<AiExtensionsSettings>;
        getAiSkillsOverview: () => Promise<AiSkillsOverview>;
        importAiSkill: (mode: AiSkillImportKind) => Promise<SkillImportResult>;
        setAiSkillEnabled: (name: string, enabled: boolean) => Promise<{ ok: boolean }>;
        removeAiSkill: (name: string) => Promise<{ ok: boolean }>;
        revealAiSkill: (name: string) => Promise<{ ok: boolean }>;
        createAiSkillFromForm: (input: SkillFormCreateInput) => Promise<SkillImportResult>;
        updateAiSkillDocument: (name: string, description: string, instruction: string) => Promise<SkillDocumentUpdateResult>;
        exportAiSkill: (name: string) => Promise<SkillExportResult>;
        getAssistantAiOptions: (profileId?: string) => Promise<AssistantAiOptions>;
        getParsingConfig: () => Promise<ParsingConfig>;
        saveParsingConfig: (config: Partial<ParsingConfig> & { mineruApiKey?: string | null }) => Promise<ParsingConfig>;
        getWebSearchConfig: () => Promise<WebSearchConfigView>;
        saveWebSearchConfig: (config: Partial<WebSearchConfig> & { zhipuApiKey?: string | null; tavilyApiKey?: string | null; baiduApiKey?: string | null }) => Promise<WebSearchConfig>;
        testWebSearchProvider: (providerId: WebSearchProviderId) => Promise<{ ok: boolean; message: string }>;
        getPipelineAmbiguityConfig: () => Promise<PipelineAmbiguityConfig>;
        savePipelineAmbiguityConfig: (patch: Partial<PipelineAmbiguityConfig>) => Promise<PipelineAmbiguityConfig>;
        getPipelineStructureConfig: () => Promise<PipelineStructureConfig>;
        savePipelineStructureConfig: (patch: Partial<PipelineStructureConfig>) => Promise<PipelineStructureConfig>;
        getLibraryChunkingConfig: (path: string) => Promise<LibraryChunkingConfig>;
        saveLibraryChunkingConfig: (path: string, patch: Partial<LibraryChunkingConfig>) => Promise<LibraryChunkingConfig>;
        getLibraryGraphEnhancementConfig: (path: string) => Promise<LibraryGraphEnhancementConfig>;
        saveLibraryGraphEnhancementConfig: (path: string, patch: Partial<LibraryGraphEnhancementConfig>) => Promise<LibraryGraphEnhancementConfig>;
        getLibraryGraphStatus: (path: string) => Promise<LibraryGraphProjectionStatus | null>;
        getLibraryGraphCommunities: (path: string) => Promise<LibraryGraphCommunityRow[] | null>;
        getLibraryGraphVisualization: (path: string, options?: { nodeLimit?: number }) => Promise<LibraryGraphVisualizationPayload | null>;
        searchLibraryGraphEntities: (path: string, query: string) => Promise<LibraryGraphVisualizationEntity[]>;
        getPipelineKeywordResources: (path: string) => Promise<PipelineKeywordResources>;
        savePipelineKeywordConfig: (path: string, patch: Partial<KeywordExtractionConfig>) => Promise<KeywordExtractionConfig>;
        savePipelineKeywordDictionary: (path: string, content: string) => Promise<PipelineKeywordResources>;
        savePipelineKeywordStopwords: (path: string, content: string) => Promise<PipelineKeywordResources>;
        getModelHub: () => Promise<ModelHub>;
        saveModelProvider: (id: string, patch: { endpoint?: string; api?: Exclude<AiGenerationApi, 'ollama-chat'>; apiKey?: string | null; models?: string[] }) => Promise<ModelHub>;
        fetchModelProviderModels: (id: string, draft?: ModelProviderCatalogDraft) => Promise<{ result: RemoteProviderModelsResult; hub: ModelHub }>;
        saveModelConfiguration: (change: ModelConfigurationChange, confirmationToken?: string) => Promise<ModelConfigurationSaveResult>;
        saveModelHub: (patch: ModelHubPatch) => Promise<ModelHub>;
        testAiProviderConfig: (config: AiProviderConfig, context?: { profileId: string }) => Promise<AiProviderStatus>;
        fetchAiProviderModels: (config: AiProviderConfig, context?: { profileId: string }) => Promise<AiProviderStatus>;
        saveAiProviderConfig: (config: AiProviderConfig) => Promise<AiProviderConfig>;
        readClipboardContent: () => Promise<import('../shared/editorClipboard').EditorClipboardContent>;
        readClipboardText: () => Promise<string>;
        addSpellcheckerWord: (word: string) => Promise<boolean>;
        startSelectionTransform: (request: SelectionTransformRequest) => Promise<SelectionTransformResult>;
        cancelSelectionTransform: (requestId: string) => Promise<boolean>;
        startSelectionEdit: (request: SelectionEditRunRequest) => Promise<SelectionEditRunResult>;
        cancelSelectionEdit: (requestId: string) => Promise<boolean>;
        getSelectionExpansionCapabilities: () => Promise<SelectionExpansionCapabilities>;
        getSelectionExpansionSettings: () => Promise<SelectionExpansionSettings>;
        saveSelectionExpansionSettings: (patch: SelectionExpansionSettingsPatch) => Promise<SelectionExpansionSettings>;
        prepareSelectionExpansionSource: (currentPath: string) => Promise<SelectionExpansionSourcePreparation>;
        startSelectionExpansion: (request: SelectionExpansionRequest) => Promise<{ requestId: string; sessionId: string }>;
        cancelSelectionExpansion: (requestId: string) => Promise<boolean>;
        onSelectionExpansionEvent: (callback: (event: SelectionExpansionEvent) => void) => () => void;
        startAssistantTurn: (request: AssistantTurnRequest) => Promise<{ requestId: string }>;
        getAssistantContextDiagnostics: (turnId?: string) => Promise<ContextProjectionDiagnostics | null>;
        selectAssistantAttachments: (kind?: 'image' | 'file') => Promise<AssistantAttachment[]>;
        ingestAssistantDroppedFiles: (files: File[]) => Promise<AssistantAttachment[]>;
        cancelAssistantTurn: (requestId: string) => Promise<boolean>;
                createQaMemorySession: (scope?: QaSessionScope, libraryPath?: string) => Promise<QaSessionSummary>;
                getMemoryCutoverReport: () => Promise<MemoryCutoverReport>;
                listQaMemorySessions: (cursor?: number) => Promise<QaMemoryPage<QaSessionSummary>>;
                getQaMemorySession: (sessionId: string) => Promise<QaSessionDetail>;
                renameQaMemorySession: (sessionId: string, title: string) => Promise<QaSessionSummary>;
                setQaMemorySessionPinned: (sessionId: string, pinned: boolean) => Promise<QaSessionSummary>;
                deleteQaMemorySession: (sessionId: string) => Promise<boolean>;
                getLongTermMemoryOverview: () => Promise<{ workspaceConfig: WorkspaceMemoryConfig; subject: MemorySubjectRecord; availability: { enabled: boolean; reason?: string }; extractionRuntime: MemoryExtractionRuntimeStatus; itemCounts: MemoryItemCounts }>;
                saveLongTermMemoryWorkspaceConfig: (patch: Partial<WorkspaceMemoryConfig>) => Promise<WorkspaceMemoryConfig>;
                setLongTermMemoryPrincipalEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
                listLongTermMemoryItems: (query?: MemoryItemListQuery) => Promise<MemoryItemPage>;
                listLongTermMemoryItemPage: (query?: MemoryItemPageQuery) => Promise<MemoryPage<MemoryItemRecord>>;
                listLongTermMemoryTopicPage: (query?: MemoryPageQuery) => Promise<MemoryPage<MemoryTopicRecord>>;
                listLongTermMemoryDocumentPage: (query?: MemoryPageQuery) => Promise<MemoryPage<MemoryDocumentAffinity>>;
                listLongTermMemoryTopics: () => Promise<MemoryTopicRecord[]>;
                promoteLongTermMemoryTopic: (topicId: string) => Promise<MemoryTopicRecord>;
                deleteLongTermMemoryTopic: (topicId: string) => Promise<boolean>;
                listLongTermMemoryDocuments: () => Promise<MemoryDocumentAffinity[]>;
                deleteLongTermMemoryDocument: (documentId: string) => Promise<boolean>;
                getLongTermMemoryUsedForTurn: (turnId: string) => Promise<MemoryUsedSnapshot[]>;
                getLongTermMemoryCitationSource: (turnId: string, itemId: string) => Promise<MemoryCitationSource>;
                createLongTermMemoryItem: (input: ManualMemoryInput) => Promise<MemoryWriteResult>;
                updateLongTermMemoryItem: (itemId: string, patch: MemoryItemPatch) => Promise<MemoryItemRecord>;
                deleteLongTermMemoryItem: (itemId: string) => Promise<boolean>;
                getLongTermMemoryTurnStatus: (turnIds: string[]) => Promise<MemoryTurnStatus[]>;
                getLongTermMemoryProposalContext: (itemId: string) => Promise<MemoryProposalContext>;
    approveLongTermMemoryConsolidation: (id: string, fingerprint: string) => Promise<MemoryItemRecord>;
    confirmLongTermMemoryItem: (itemId: string, review?: MemoryProposalReview) => Promise<MemoryItemRecord>;
                rejectLongTermMemoryItem: (itemId: string) => Promise<MemoryItemRecord>;
                clearLongTermMemory: () => Promise<MemoryClearResult>;
                exportLongTermMemory: () => Promise<{ canceled: boolean; exportedItems: number }>;
                importLongTermMemory: () => Promise<MemoryImportResult & { canceled: boolean }>;
                consolidateLongTermMemory: () => Promise<MemoryConsolidationResult>;
        getAssistantDetailedTrace: (requestId: string) => Promise<{ entries: AssistantDetailedTraceRecordView[]; filePath: string | null }>;
        getAssistantMemorySettings: () => Promise<AssistantMemorySettings>;
        setAssistantMemorySettings: (mode: AssistantMemoryMode) => Promise<AssistantMemorySettings>;
        createAssistantMemorySession: (notePath: string) => Promise<AssistantSessionSummary>;
        listAssistantMemorySessions: (notePath: string, page?: number) => Promise<{ items: AssistantSessionSummary[]; nextCursor?: number }>;
        getAssistantMemorySession: (notePath: string, sessionId: string, page?: number) => Promise<AssistantSessionDetail>;
        archiveAssistantMemorySession: (notePath: string, sessionId: string) => Promise<AssistantSessionSummary>;
        deleteAssistantMemorySession: (notePath: string, sessionId: string) => Promise<boolean>;
        clearAssistantMemoryNote: (notePath: string) => Promise<number>;
        exportAssistantMemorySession: (notePath: string, sessionId: string, format: 'markdown' | 'json') => Promise<boolean>;
        backupAssistantMemory: () => Promise<boolean>;
        validateAssistantCitation: (citation: AssistantEvidenceCitation) => Promise<AssistantCitationValidation>;
        getFavoriteNotes: () => Promise<string[]>;
        setFavoriteNote: (path: string, favorite: boolean) => Promise<string[]>;
        searchNotesUnified: (query: string) => Promise<UnifiedSearchOutcome>;
        getNoteAnalysis: (path: string) => Promise<NoteAnalysis | null>;
        generateNoteAnalysis: (path: string, model: string) => Promise<NoteAnalysis>;
        startNoteAnalysis: (path: string, model?: string) => Promise<{ runId: string; state: NoteAnalysisRunDetail['state'] }>;
        getLatestNoteAnalysisRun: (path: string) => Promise<NoteAnalysisRunDetail | null>;
        getNoteAnalysisRun: (runId: string) => Promise<NoteAnalysisRunDetail | null>;
        cancelNoteAnalysis: (runId: string) => Promise<boolean>;
        resumeNoteAnalysis: (runId: string) => Promise<NoteAnalysisRunDetail>;
        onNoteAnalysisProgress: (callback: (progress: NoteAnalysisProgress) => void) => () => void;
        getAiInsight: (path: string) => Promise<AiInsight | null>;
        generateAiInsight: (path: string, model: string) => Promise<AiInsight>;
        applyAiTags: (path: string, suggestedTags: string[]) => Promise<AppliedTagsResult>;
        askKnowledgeAssistant: (question: string, model: string) => Promise<AssistantAnswer>;
        generateLearningPlan: (goal: string, model: string) => Promise<LearningPlan>;
        generateOrganizationSuggestion: (model: string) => Promise<OrganizationSuggestion>;
        listFiles: () => Promise<FileNode[] | null>;
        readFile: (path: string) => Promise<string>;
        pickDocumentFile: () => Promise<DocumentOpenRequest | null>;
        listDocumentOpenRequests: () => Promise<DocumentOpenRequest[]>;
        takeDocumentOpenFailures: () => Promise<{ displayPath: string; message: string }[]>;
        dropDocumentFiles: (files: File[]) => Promise<void>;
        openDocumentRequest: (id: string, encoding?: DocumentEncoding) => Promise<DocumentOpenResult>;
        finishDocumentOpenRequest: (id: string) => Promise<void>;
        updateDocumentDraft: (request: DocumentDraftRequest) => Promise<DocumentDraftResult>;
        previewDocumentResources: (id: string) => Promise<import('../shared/documentSession').DocumentResourcePreview>;
        grantDocumentResourceRoot: (id: string) => Promise<boolean>;
        openDocumentLink: (id: string, href: string) => Promise<DocumentOpenRequest>;
        addDocumentImage: (id: string, input: { bytes?: Uint8Array; extension?: string; sourcePath?: string }) => Promise<SavedEditorImage>;
        runDocumentAi: (request: import('../shared/documentAi').DocumentAiRequest) => Promise<import('../shared/documentAi').DocumentAiResult>;
        applyDocumentAi: (request: import('../shared/documentAi').DocumentAiApplyRequest) => Promise<DocumentSnapshot>;
        cancelDocumentAi: (requestId: string) => Promise<void>;
        saveDocument: (request: DocumentSaveRequest) => Promise<DocumentSaveResult>;
        saveDocumentAs: (request: DocumentSaveRequest) => Promise<DocumentSaveResult | null>;
        refreshDocument: (id: string, revision: number, encoding?: DocumentEncoding, discard?: boolean) => Promise<DocumentSnapshot>;
        closeDocument: (request: DocumentCloseRequest) => Promise<DocumentCloseResult>;
        joinDocumentLibrary: (request: DocumentJoinRequest) => Promise<DocumentJoinResult>;
        listDocumentRecovery: () => Promise<DocumentRecovery[]>;
        restoreDocumentDraft: (id: string) => Promise<DocumentSnapshot>;
        listRecentDocuments: () => Promise<DocumentRecent[]>;
        openRecentDocument: (displayPath: string) => Promise<DocumentOpenRequest>;
        waitForNoteCloseDecision: (requestId: string) => void;
        onDocumentOpenRequested: (callback: () => void) => () => void;
        openNoteEditSession: (path: string) => Promise<NoteEditSnapshot>;
        refreshNoteEditSession: (id: string) => Promise<NoteEditSnapshot>;
        closeNoteEditSession: (id: string) => Promise<boolean>;
        saveNote: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
        createNoteFromAssistant: (request: CreateAssistantNoteRequest) => Promise<CreateAssistantNoteResult>;
        mutateNote: (request: NoteMutationRequest) => Promise<SaveNoteResult>;
        saveNoteCopy: (id: string, name: string, content: string) => Promise<NoteEditSnapshot>;
        retryNoteIndex: (id: string) => Promise<void>;
        awaitNoteIndex: (id: string, diskHash: string) => Promise<'current' | 'superseded' | 'missing'>;
        reconcileNotes: () => Promise<void>;
        respondNoteClose: (response: NoteCloseResponse) => void;
        onNoteCloseRequested: (callback: (request: NoteCloseRequest) => void) => () => void;
        onNoteSaveState: (callback: (state: NoteSaveState) => void) => () => void;
        onNoteIndexChanged: (callback: (delta: NoteIndexChanged) => void) => () => void;
        createFile: (fileName?: string, parentDirectoryPath?: string | null) => Promise<string | null>;
        renameFile: (oldPath: string, newName: string) => Promise<string | null>;
        renameEntry: (oldPath: string, newName: string) => Promise<string | null>;
        deleteFile: (filePath: string) => Promise<boolean>;
        deleteEntry: (entryPath: string) => Promise<boolean>;
        createFolder: (parentDirectoryPath: string | null, folderName: string) => Promise<string | null>;
        moveEntry: (sourcePath: string, targetDirectoryPath: string, position?: MovePosition) => Promise<string | null>;
        saveTreeOrder: (parentDirectoryPath: string, orderedChildPaths: string[]) => Promise<boolean>;
        importFiles: (targetDirectoryPath?: string | null) => Promise<ImportedTextFile[]>;
        searchNotes: (query: string) => Promise<any[]>;
        getNoteMeta: (path: string) => Promise<NoteMeta | null>;
        getBacklinks: (path: string) => Promise<BacklinkEntry[]>;
        getAllTags: () => Promise<TagSummary[]>;
        getFilesByTag: (tag: string) => Promise<FileNode[]>;
        resolveWikiLink: (target: string, fromPath?: string) => Promise<string | null>;
        createLinkedNote: (target: string, fromPath?: string) => Promise<string | null>;
        saveEditorImage: (request: SaveEditorImageRequest) => Promise<SavedEditorImage>;
        listBackups: (path: string) => Promise<BackupEntry[]>;
        restoreBackup: (path: string, backupId: string) => Promise<string | null>;
        readMarkdownExportImage: (source: string) => Promise<{ dataUrl: string; byteLength: number }>;
        exportHtml: (defaultName: string, html: string) => Promise<boolean>;
        exportNote: (request: NoteExportRequest) => Promise<boolean>;
        onLog: (callback: (msg: string) => void) => void;
        onLibraryChanged: (callback: (payload: LibraryChangePayload) => void) => () => void;
        onAssistantTurnEvent: (callback: (event: AssistantTurnEvent) => void) => () => void;
        onPipelineStatus: (callback: (status: PipelineDocumentStatus) => void) => () => void;
        onPipelineProgress: (callback: (progress: PipelineProgressEvent) => void) => () => void;
        onLibraryGraphUpdated: (callback: (libraryPath: string) => void) => () => void;
    }

    interface Window {
        electronAPI: ElectronAPI;
    }
}
