import { app, BrowserWindow, clipboard, ipcMain, dialog, IpcMainInvokeEvent, nativeTheme, safeStorage, shell, protocol } from 'electron';
import type { IpcMainEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { APP_INFO } from '../shared/appInfo';
import { normalizeMemorySaveClaims } from '../shared/memorySaveClaims';
import type { MemoryUsedSnapshot } from './knowledge/memory/memoryTypes';
import { STARTUP_APPEARANCE_ARGUMENT, type StartupAppearance } from '../shared/startupAppearance';
import { desktopEnglish } from '../shared/desktopTranslations';
import { workspaceMigrationEnglish } from '../shared/workspaceMigrationEnglish';
import { AppLogger, safeServiceEndpoint } from './appLogger';
import { UserCapabilities } from './userCapabilities';
import { CloudAuthorization } from './pipeline/cloudAuthorization';
import { PythonWorkerClient } from './pipeline/pythonWorkerClient';
import type { CapabilityProbeRequest, CapabilityRequest, CapabilitySnapshot } from '../shared/userCapabilities';
import { ONBOARDING_SAMPLES, type OnboardingState, type OnboardingUpdate, type OnboardingPracticeBinding } from '../shared/onboarding';
import { OnboardingService } from './onboarding/onboardingService';
import { MaintenanceBarrier } from './backup/maintenance';
import { WorkspaceBackupService } from './backup/workspaceBackupService';
import { WorkspaceRestoreService } from './backup/workspaceRestoreService';
import { WorkspaceMigrationService } from './workspaceMigrationService';
import { mapRestoredPath, type PhysicalRestoreContext } from './backup/physicalRestore';
import { ReleaseChecker } from './releaseCheck';
import { clearRestorePause, isRestorePaused } from './backup/restorePause';
import { safeBackupSettings } from './backup/snapshot';
import type { BackupConfiguration } from '../shared/workspaceBackup';
import { DataRootLocks } from './dataRootLocks';
import { NoteSaveService } from './noteSaveService';
import { DocumentSessionService } from './documents/documentSessionService';
import { OpenRequestRouter } from './documents/openRequestRouter';
import { DOCUMENT_RESOURCE_SCHEME } from './documents/documentResourceService';
import { DocumentAiService } from './documents/documentAiService';
import { generateAiText } from './knowledge/aiProvider';
import type { DocumentAiRequest, DocumentAiApplyRequest } from '../shared/documentAi';
import type { DocumentEncoding, DocumentDraftRequest, DocumentSaveRequest, DocumentSaveResult, DocumentCloseRequest, DocumentJoinRequest } from '../shared/documentSession';
import { readNoteBackup } from './noteBackups';
import { exportNoteFile } from './noteExport';
import { readRemoteExportImage } from './markdownExportImages';
import { requestExportImage } from './exportImageRequest';
import type { NoteExportRequest } from '../shared/noteExport';
import { NoteCloseCoordinator } from './noteCloseCoordinator';
import type { NoteMutationRequest, SaveNoteRequest, NoteCloseResponse } from '../shared/noteSave';
import type { CreateAssistantNoteRequest } from '../shared/assistantNote';
import { createAssistantNote } from './assistantNote';
import { decodeTextBuffer } from './textFile';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildNoteIndex,
  getAllTags,
  getBacklinks,
  getFilesByTag,
  getNoteMeta,
  resolveWikiLink,
  type IndexedNote,
  type NoteIndex,
} from './noteIndex';
import {
  MAX_EDITOR_IMAGE_BYTES,
  saveEditorImageToLibrary,
} from './libraryServices';
import { importTextFilesToLibrary } from './importFiles';
import {
  createFolderInLibrary,
  moveEntryInLibrary,
  renameEntryInLibrary,
  recoverLibraryPathMove,
  restoreEntryPath,
  saveDirectoryOrder,
  type MovePosition,
} from './libraryFileOps';
import { createLibraryDirectory } from './libraryCreation';
import { assertInsideDirectory, getUniquePath, sanitizeEntryName } from './pathGuards';
import { readTextFile } from './textFile';
import { loadTreeOrder } from './treeOrder';
import {
  readEditorImageDataUrl,
  registerEditorImageProtocol,
  registerEditorImageProtocolScheme,
} from './editorImageProtocol';
import { getAiInsight, getFavoriteNotePaths, getNoteAnalysis, saveAiInsight, saveLearningPlan, saveOrganizationSuggestion, setFavoriteNote } from './knowledge/metaDatabase';
import { configureAiProvider, fetchAiProviderModels, generateAiJsonWithOptions, getAiProviderConfig, getAiProviderStatus, getAiProviderStatusForConfig, getRemoteModelContextWindow, resolveAiStructuredOutputCapabilities, testAiProviderConnection, type AiJsonGenerationOptions, type AiProviderConfig } from './knowledge/aiProvider';
import type { AiExtensionsSettings, AiGenerationApi, AiModelProfile, AiModelSettings, AiModelSettingsInput, AiProviderKind, AssistantAiOptions, DirectorySkillOverride, SkillImportResult } from './knowledge/aiTypes';
import { createModelSettingsFromLegacy, defaultExtensionsSettings, normalizeProviderConfig, redactModelSettings, validateExtensionsSettings, validateModelSettingsInput } from './knowledge/aiSettings';
import { syncAiSkillsToWorkspace } from './knowledge/aiSkillWorkspace';
import { loadDirectorySkills, type DirectorySkillEntry } from './knowledge/skillDirectoryLoader';
import { ensureBundledSkills } from './knowledge/bundledSkills';
import { loadAssistantSkills, resolveAssistantSkillSelection } from './knowledge/assistantSkills';
import { buildAiSkillsOverview, createDirectorySkillFromForm, exportDirectorySkillToZip, importAiSkillSource, removeDirectoryRecursively, updateDirectorySkillDocument } from './knowledge/skillImportService';
import {
  AttachmentContextProvider,
  renderDocumentImageTransportIndex,
  renderAttachmentMetadata,
  renderAttachmentRange,
  type AssistantSearchableAttachmentMetadata,
} from './knowledge/attachmentContextProvider';
import { collectAiTransportImageHashes, materializeAssistantDocumentImages, parseAssistantDocumentAttachments } from './knowledge/assistantDocumentAttachmentParser';
import { runSelectionTransform, validateSelectionTransformRequest } from './knowledge/selectionTransform';
import {
  createCurrentNoteSelectionEditRequest,
  createLegacyLocalSelectionEditRequest,
  runSelectionEditCoordinator,
} from './knowledge/selectionEditCoordinator';
import { resolveSelectionEditRuntimeMode, validateSelectionEditRunRequest } from './knowledge/selectionEditIpc';
import { runSelectionExpansionCoordinator, validateSelectionExpansionRequest } from './knowledge/selectionExpansionCoordinator';
import { resolveSelectionExpansionMode } from './knowledge/selectionExpansionContext';
import {
  readSelectionExpansionSettings,
  resolveSelectionExpansionCapabilities,
  saveSelectionExpansionSettings,
} from './knowledge/selectionExpansionSettings';
import { createAssistantChatPromptMessages, createAssistantProjectContext, createKnowledgeAnswerPromptMessages, createQaContextRuntimeAssembly, streamKnowledgeAnswer } from './knowledge/assistantTurn';
import type { AiTransportImage } from './knowledge/aiGenerationTransport';
import { resolveAssistantAnswerTemperature } from './knowledge/assistantGenerationPolicy';
import {
  assistantDocumentExtensions,
  assistantImageExtensions,
  assistantTextExtensions,
  maxAssistantAttachmentBytes,
  maxAssistantAttachmentCount,
  maxAssistantDocumentBytes,
  maxAssistantImageBytes,
  maxAssistantImageTotalBytes,
  resolveImageMimeTypeFromExtension,
  type AssistantAttachment,
  type AssistantCitationValidation,
  type AssistantPublicModelEvent,
  type AssistantTurnEvent,
  type AssistantTurnRequest,
  type AssistantTurnResult,
  type CurrentNotePublicPlanEvent,
  type CurrentNotePublicSearchCoverage,
  type CurrentNotePublicSearchScope,
  type CurrentNotePublicToolEvent,
  type QaQueryRewriteRecord,
  validateAssistantEvidenceCitation,
  validateAssistantTurnRequest,
} from './knowledge/assistantTurnTypes';
import { getDedicatedKnowledgeBaseRagSource, KNOWLEDGE_BASE_RAG_PARENT_TOP_K, mergeKnowledgeBaseRetrievals, retrieveKnowledgeBaseEvidence, type KnowledgeBaseRetrievalOutcome } from './knowledge/knowledgeBaseRag';
import { KnowledgeBaseImageResolver, renderKnowledgeBaseImageTransportIndex } from './knowledge/knowledgeBaseImageResolver';
import { buildQueryRewritePrompt, QueryRewriteError, rewriteKnowledgeQuestion, selectRewriteHistoryTurns, shouldRewriteQuestion, type QueryRewriteProviderCallObservationEvent } from './knowledge/queryRewrite';
import { observeDynamicMemoryS0Call } from './knowledge/dynamicMemoryS0Observe';
import { buildFollowUpSuggestionsPrompt, FollowUpSuggestionsError, generateFollowUpSuggestions, selectFollowUpHistory } from './knowledge/followUpSuggestions';
import { QaMemoryDatabase } from './knowledge/qaMemoryDatabase';
import { QaMemoryRepository } from './knowledge/qaMemoryRepository';
import { QaMemoryOrchestrator } from './knowledge/qaMemoryOrchestrator';
import type { QaSessionScope } from './knowledge/qaMemoryTypes';
import { QaLegacyMemoryMigrationService } from './knowledge/qaLegacyMemoryMigration';
import { projectQaRecentTurnsToConversation, selectQaRecentCompleteConversation } from './knowledge/qaCanonicalHistory';
import { ensureLocalMemoryPrincipalId, MemoryScopeResolver } from './knowledge/memory/memoryScope';
import { detectExplicitMemoryStatement } from './knowledge/memory/memoryText';
import { MemoryExtractionService, reviewConsolidationWithModel, type MemoryExtractionModelResolution } from './knowledge/memory/memoryExtractionService';
import { MemoryTurnStatusService } from './knowledge/memory/memoryTurnStatusService';
import { MEMORY_CONSTANTS } from './knowledge/memory/memoryConstants';
import { MemoryRecallService, type MemoryEmbeddingRuntime, type MemoryRecallResult, type MemoryUsedItem } from './knowledge/memory/memoryRecallService';
import { createLongTermMemoryContextMaterial } from './knowledge/memory/memoryPrompt';
import { MemoryWriteService } from './knowledge/memory/memoryWriteService';
import { recoverCompletedExplicitMemories, saveCompletedExplicitMemory } from './knowledge/memory/memoryExplicitSaveService';
import { ConversationSearchService } from './knowledge/memory/conversationSearchService';
import { MemoryConditioningService } from './knowledge/memory/memoryConditioningService';
import { calculateDocumentAffinityFactor, MemoryAffinityService } from './knowledge/memory/memoryAffinityService';
import { MemoryConsolidationService } from './knowledge/memory/memoryConsolidationService';
import { MemoryMigrationService } from './knowledge/memory/memoryMigrationService';
import { MemoryTopicService } from './knowledge/memory/memoryTopicService';
import { getMemoryCutoverReport, isCanonicalMemoryProjection, normalizeMemoryProjectionMode, recordMemoryCutoverObservation, type MemoryProjectionMode } from './knowledge/memory/memoryCutover';
import type { SearchConversationsToolRuntime } from './knowledge/knowledgeTools/searchConversationsTool';
import type { ManualMemoryInput, MemoryDocumentCitation, MemoryExtractionJobRecord, MemoryItemListQuery, MemoryItemPageQuery, MemoryPageQuery, MemoryItemPatch, WorkspaceMemoryConfig } from './knowledge/memory/memoryTypes';
import type { MemoryProposalReview } from './knowledge/memory/memoryTypes';
import type { QaMemoryZoneTokens, QaRecentTurn, QaResidualMemoryObservationInput } from './knowledge/qaMemoryTypes';
import { UserProfileRepository } from './knowledge/userProfileRepository';
import type { ContextMemoryResult } from './knowledge/contextMemoryTypes';
import { resolveRerankRuntime } from './knowledge/rerankAdapters';
import { DEFAULT_CURRENT_NOTE_AGENT_BUDGET, runCurrentNoteAgent } from './knowledge/currentNoteAgentGraph';
import { runLibraryPlanAgent } from './knowledge/libraryPlanAgentGraph';
import { createCurrentNotePrompt } from './knowledge/currentNotePrompt';
import { createCurrentNoteSnapshotFromIndexedNote, matchesCurrentNoteSnapshot } from './knowledge/currentNoteSnapshot';
import { createLibraryPlanDriver } from './knowledge/libraryPlanDriver';
import { createLibraryNoteSnapshotMap } from './knowledge/libraryNoteSnapshot';
import { validateAssistantCitationAgainstSnapshot } from './knowledge/assistantCitationGuard';
import { NoteConversationMemory } from './knowledge/noteConversationMemory';
import { createCurrentNotePlanDriver, shouldUseCurrentNotePlanner } from './knowledge/searchPlanDriver';
import type { SearchPlan } from './knowledge/searchPlanTypes';
import { createStructuredActionDriver } from './knowledge/structuredActionDriver';
import { createLibraryStructuredActionDriver } from './knowledge/libraryStructuredActionDriver';
import { createAssistantIntentClassifier, type AssistantQueryUnderstanding } from './knowledge/assistantIntentClassifier';
import { ModelCallBudgetGate } from './knowledge/modelCallBudget';
import { ModelCallCoordinator, ModelCallPreparationError } from './knowledge/modelCallCoordinator';
import { getOllamaModelContextWindow } from './knowledge/ollamaClient';
import { serializeContextRoleMessagesForBudget } from './knowledge/contextRenderer';
import { CONTEXT_REQUEST_ENVELOPE_VERSION, normalizeAssistantContextRuntimeMode, type AssistantContextRuntimeMode, type ContextMaterial, type ContextProjectionDiagnostics, type ContextRuntimeObservationReport, type ContextRuntimeObservationResult } from './knowledge/contextRuntimeTypes';
import { getContextProjectionDiagnostics, observeContextRuntime } from './knowledge/contextRuntimeObserve';
import { shouldRunShadowPlanner, shouldShadowKnowledgeAgent, shouldUseKnowledgeAgent, shouldUseLibraryPlanner } from './knowledge/assistantMode';
import { runShadowPlan } from './knowledge/assistantShadowPlan';
import { runKnowledgeAgentTurn, runKnowledgeShadowComparison } from './knowledge/knowledgeAgentTurn';
import { runWikiNodeAgentTurn } from './wiki/wikiNodeAgentTurn';
import { WIKI_QUICK_ACTIONS } from './wiki/wikiQuickActions';
import {
  addWikiDerivedNode,
  deleteWikiDerivedNode,
  mergeWikiDerivedNodes,
  renameWikiDerivedNode,
  type WikiDerivedDeleteRequest,
  type WikiDerivedDeleteResult,
  type WikiDerivedNodeRequest,
  type WikiDerivedNodeResult,
  type WikiDerivedRenameRequest,
} from './wiki/wikiDerivedNodes';
import {
  createWikiAiMemory,
  deleteWikiAiMemory,
  listWikiAiMemories,
  renameWikiAiMemory,
  setWikiAiMemoryPinned,
  upsertWikiAiMemory,
  type WikiAiMemoryDeleteRequest,
  type WikiAiMemoryDeleteResult,
  type WikiAiMemoryCreateRequest,
  type WikiAiMemoryListResult,
  type WikiAiMemoryPinRequest,
  type WikiAiMemoryRenameRequest,
  type WikiAiMemoryResult,
  type WikiAiMemoryUpsertRequest,
} from './wiki/wikiAiMemories';
import { resolveWikiNodeQuestions, type WikiNodeQuestionsResult } from './wiki/wikiNodeQuestions';
import { collectWikiChildNodes, findWikiNode, formatWikiNodePath, getWikiNodeBreadcrumb } from './wiki/wikiNodeScope';
import { runChatWebSearchFallbackTurn, runChatWebSearchReactTurn } from './knowledge/chatWebAgentTurn';
import { createReActChatTransport } from './knowledge/reactAgent/reactChatTransport';
import { createFallbackCurrentNoteSearchScope, type CurrentNoteSearchScope } from './knowledge/currentNoteSearchScope';
import type { CurrentNoteSearchCoverageSummary } from './knowledge/currentNoteSearchCoverage';
import { ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS, ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS, AssistantDetailedTrace, createAssistantPublicModelText, toDetailedTraceError, type AssistantDetailedTraceSink } from './knowledge/assistantDetailedTrace';
import { isStructuredOutputContractError } from './knowledge/structuredOutputContract';
import { resolveEffectiveContextWindow, type EffectiveContextWindow } from '../shared/effectiveContextWindow';
import { AssistantMemoryDatabase } from './knowledge/assistantMemoryDatabase';
import { AssistantMemoryRepository } from './knowledge/assistantMemoryRepository';
import { NoteDerivedDigestRepository } from './knowledge/noteDerivedDigestRepository';
import { classifyCurrentNoteSummaryIntent, createNoteSummaryDriver, runCurrentNoteSummary } from './knowledge/noteSummaryOrchestrator';
import { AssistantSessionScopeRegistry, createAssistantSessionId } from './knowledge/assistantSessionScope';
import type { AssistantMemoryMode, AssistantMemoryTurnFinalize, AssistantSearchPlanPersistenceState, AssistantSessionScope } from './knowledge/assistantMemoryTypes';
import { getAppPreferences, saveAppPreferences, type AppPreferencesPatch } from './appPreferences';
import { getColorScheme } from '../shared/lightColorSchemes';
import { runLocalKnowledgeAgent } from './knowledge/agentRuntime';
import { applyConfirmedTags } from './knowledge/tagSuggestion';
import { getNoteAnalysisSourceHash } from './knowledge/noteAnalysisSource';
import { NoteAnalysisBatchRepository } from './knowledge/noteAnalysisBatchRepository';
import { NoteAnalysisBatchOrchestrator } from './knowledge/noteAnalysisBatchOrchestrator';
import { noteAnalysisProviderFingerprint, type NoteAnalysisRunInput } from './knowledge/noteAnalysisBatchPrompt';
import type { NoteAnalysisRunDetail } from './knowledge/noteAnalysisTypes';
import { validateSystemWorkspaceDirectory, validateWorkspaceDirectory } from './workspaceService';
import { KnowledgeIndexCoordinator } from './knowledge/indexCoordinator';
import { createKeywordSearchOutcome, type KeywordSearchOutcome, type SearchCandidate } from './knowledge/keywordSearch';
import { buildLexicalMatchTrace, lexicalMatchPriority, rejectsNumericVersionMismatch, type LexicalMatchTrace } from './knowledge/lexicalMatchPolicy';
import { createNoteLexicalIndex, searchNoteLexically, toNoteSearchDocument, type NoteLexicalIndex } from './knowledge/noteLexicalIndex';
import { tokenizeCurrentNoteText } from './knowledge/currentNoteStructure';
import { getLibraryUiState, migrateLibraryUiStatePath, pruneLibraryUiState, saveLibraryUiState, type LibraryUiStatePatch } from './libraryUiState';
import { activateRegisteredLibrary, listRegisteredLibraries, registerAndActivateLibrary, removeRegisteredLibrary, summarizeRegisteredLibraries } from './libraryRegistry';
import {
  activateMaterialsLibrary,
  createMaterialsLibraryDirectory,
  ensureMaterialsMeta,
  ensureMaterialsRoot,
  findMaterialsDocument,
  getActiveMaterialsLibraryPath,
  importMaterialsDocuments,
  listMaterialsDocuments,
  listMaterialsLibraries,
  materialsDocumentExtensions,
  registerMaterialsLibrary,
  removeMaterialsLibrary,
  readMaterialsDocumentBytes,
  renameMaterialsLibrary,
  readMaterialsDocumentText,
  renameMaterialsDocument,
  summarizeMaterialsLibraries,
  upgradeRegisteredLibraryToMaterials,
} from './materialsLibrary';
import { readMineruApiKey, readParsingConfig, saveParsingConfig } from './parsingConfig';
import { readWebSearchConfig, readWebSearchRuntimeConfig, saveWebSearchConfig, type WebSearchConfigPatch } from './websearch/webSearchConfig';
import { listWebSearchProviders, resolveWebSearchProvider } from './websearch/webSearchProviders';
import type { WebSearchProviderId } from './websearch/webSearchTypes';
import { webSearchProviderIds } from './websearch/webSearchTypes';
import {
  ensureModelHubMigrated,
  readModelHub,
  resolveEmbeddingSource,
  resolveGenerationConfig,
  resolveProviderCredentials,
  saveModelHub,
  saveProviderConnection,
  type ModelHubPatch,
} from './knowledge/modelHub';
import { embedRemoteBatch } from './knowledge/remoteModelClient';
import { fetchModelProviderCatalog, ModelConfigurationService, type ModelConfigurationStore } from './knowledge/modelConfigurationService';
import type { ModelConfigurationChange, ModelConfigurationSaveResult, ModelProviderCatalogDraft } from '../shared/modelConfiguration';
import { embedOllamaBatch, getDefaultOllamaEndpoint } from './knowledge/ollamaClient';
import type { UnifiedSearchOutcome } from './knowledge/searchTypes';
import { PipelineOrchestrator } from './pipeline/pipelineOrchestrator';
import { assertArtifactPreviewIntegrity, normalizeArtifactPreviewParentChunkId, readArtifactPreview } from './pipeline/artifactPreview';
import { readKeywordPreview } from './pipeline/keywordPreview';
import { importWikiDocumentAsNote } from './wiki/wikiNoteImport';
import { removeKeywordIndexEntries } from './pipeline/keywordIndex';
import { searchMaterialChunks, type MaterialChunkSearchMode } from './pipeline/materialChunkSearch';
import {
  applyWikiSiblingOrderOverrides,
  readWikiDocumentOutline,
  reorderWikiSiblingNodes,
  type WikiDocumentOutline,
  type WikiSiblingOrderRequest,
  type WikiSiblingOrderResult,
} from './wikiOutline';
import { lockMaterialEmbeddingProfile, readMaterialEmbeddingProfile, testMaterialEmbeddingCandidate } from './pipeline/materialEmbeddingProfile';
import { MaterialVectorGenerationService } from './pipeline/materialVectorGenerationService';
import { createMaterialEmbeddingAdapter as createProfileEmbeddingAdapter } from './pipeline/materialEmbeddingAdapters';
import { MaterialEmbeddingProfileError, normalizeEndpointIdentity, normalizeMaterialEmbeddingCandidate, type MaterialEmbeddingCandidate, type MaterialEmbeddingProfile } from './pipeline/materialEmbeddingTypes';
import { isStageManifestCurrent, isStageOutputAllowed, readPipelineManifest, stageDirectory, stageOutputNames } from './pipeline/artifactStore';
import { readPipelineAmbiguityConfig, savePipelineAmbiguityConfig } from './pipeline/ambiguityConfig';
import { readLibraryKeywordStageResources, saveLibraryKeywordConfig, saveLibraryKeywordDictionary, saveLibraryKeywordStopwords, type KeywordExtractionConfig } from './pipeline/keywordConfig';
import { readPipelineStructureConfig, savePipelineStructureConfig } from './pipeline/structureConfig';
import { readLibraryChunkingConfig, saveLibraryChunkingConfig } from './pipeline/chunkingConfig';
import { readLibraryGraphEnhancementConfig, saveLibraryGraphEnhancementConfig } from './pipeline/graphEnhancementConfig';
import { readGraphCommunities, readGraphProjectionStatus, readGraphVisualizationPayload, searchGraphVisualizationEntities, type GraphCommunityProjectionRow, type GraphProjectionStatus, type GraphVisualizationEntityNode, type GraphVisualizationPayload } from './pipeline/graphProjection';
import { readLibraryPipelineLlmBinding, resolveLibraryPipelineLlmConfig, saveLibraryPipelineLlmBinding, type LibraryPipelineLlmBinding } from './pipeline/libraryPipelineLlmConfig';
import type { LibraryChunkingConfig, LibraryGraphEnhancementConfig, MineruRuntimeConfig, PipelineAmbiguityConfig, PipelineArtifactPreview, PipelineDocumentStatus, PipelineKeywordPreview, PipelineStageId, PipelineStructureConfig } from './pipeline/types';

// CJS Imports (Downgraded electron-store to 8.1.0 to support this)
const Store = require('electron-store');

registerEditorImageProtocolScheme();
protocol.registerSchemesAsPrivileged([{ scheme: DOCUMENT_RESOURCE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);


let store: any;
let onboardingService: OnboardingService | undefined;
let miniSearch: NoteLexicalIndex | null = null;
let mainWindow: BrowserWindow | null = null;
const externalWebContentsIds = new Set<number>();
let noteIndex: NoteIndex | null = null;
const noteAnalysisRepositories = new Map<string, NoteAnalysisBatchRepository>();
const noteAnalysisOrchestrator = new NoteAnalysisBatchOrchestrator((request) => generateAiJsonWithOptions(request));
/**
 * SE-7 keeps one cancellation registry for the unified route and both
 * compatibility routes. The old channels stay available during observation,
 * but can never own a separate task lifecycle.
 */
const selectionEditTasks = new Map<string, AbortController>();
const selectionTransformTasks = selectionEditTasks;
const selectionExpansionTasks = selectionEditTasks;
const selectionExpansionTaskEmitters = new Map<string, (event: import('./knowledge/selectionExpansionTypes').SelectionExpansionEventPayload) => void>();
const assistantTurnTasks = new Map<string, AbortController>();
const assistantTurnOutputBuffers = new Map<string, string>();
const currentNoteConversationMemory = new NoteConversationMemory();
const assistantMemoryDatabase = new AssistantMemoryDatabase();
const qaMemoryDatabase = new QaMemoryDatabase();
const qaLegacyMemoryMigrationService = new QaLegacyMemoryMigrationService(qaMemoryDatabase);
const qaMemoryOrchestrators = new Map<string, QaMemoryOrchestrator>();
const memoryExtractionServices = new Map<string, MemoryExtractionService>();
const memoryRecallServices = new Map<string, MemoryRecallService>();
const conversationSearchServices = new Map<string, ConversationSearchService>();
const memoryConsolidationServices = new Map<string, MemoryConsolidationService>();
const qaLegacyMemoryMigrationAttemptedWorkspaces = new Set<string>();
const assistantSessionScopeRegistry = new AssistantSessionScopeRegistry();
const indexCoordinator = new KnowledgeIndexCoordinator((message) => logToWindow(`[KNOWLEDGE] ${message}`));
const noteSaveService = new NoteSaveService({
  getLibraryPath: getCurrentLibraryPath,
  committed: async (library, filePath, diskHash) => {
    if (library !== getCurrentLibraryPath()) throw new Error('笔记库已切换。');
    if (await indexCoordinator.awaitIndexedVersion(filePath, diskHash) !== 'current') throw new Error('保存后的磁盘版本已变化。');
  },
  state: (sender, state) => { if (mainWindow?.webContents.id === sender) mainWindow.webContents.send('notes:save-state', state); },
});
let documentSessionService: DocumentSessionService | undefined;
let documentAiService: DocumentAiService | undefined;
const documentOpenRouter = new OpenRequestRouter({
  entryPath: !app.isPackaged ? process.argv[1] : undefined,
  enqueue: file => { if (!mainWindow || mainWindow.isDestroyed()) throw new Error('文件打开窗口尚未就绪。'); return getDocumentSessionService().enqueue(mainWindow.webContents.id, file); },
  changed: () => mainWindow?.webContents.send('documents:open-requested'),
});
function getDocumentAiService(): DocumentAiService {
  return documentAiService ??= new DocumentAiService({ snapshot: (sender, id) => getDocumentSessionService().snapshot(sender, id), updateDraft: (sender, request) => getDocumentSessionService().updateDraft(sender, request), runtime: () => { const config = resolveAssistantProfile(undefined).config; return { ...config, contextWindowTokens: resolveConfiguredAssistantContextWindow(config).tokens }; }, generate: generateAiText,
    supplement: async (rawLibrary, question) => {
      const library = requireRegisteredNoteLibrary(rawLibrary); const { index, outcome } = searchNoteLibraryForAssistant(library, question);
      return outcome.results.slice(0, 4).map(match => `${path.basename(match.path)}\n${index.notesByPath[match.path]?.rawMarkdown.slice(0, 3000) ?? ''}`).join('\n\n');
    },
  });
}
const noteCloseCoordinator = new NoteCloseCoordinator(async () => { await startupInitialization; await noteSaveService.drain(); await documentSessionService?.drain(); await indexCoordinator.shutdown(); }, (message) => mainWindow?.webContents.send('notes:save-state', { indexState: 'degraded', message }));

/** 独立文件只占用文件级数据锁；库内副本继续经原结构队列和增量索引提交。 */
function getDocumentSessionService(): DocumentSessionService {
  if (!documentSessionService) documentSessionService = new DocumentSessionService({
    recoveryRoot: path.join(app.getPath('userData'), 'external-documents'),
    libraries: () => listRegisteredLibraries(store).map(library => library.path),
    protectedRoots: () => [app.getPath('userData'), ...listMaterialsLibraries(store).map(library => library.path)],
    claimPath: filePath => dataRootLocks.acquire([filePath], false),
    onReleased: id => documentAiService?.release(id),
    joinLibrary: async (rawLibrary, fileName, content, publishResources) => {
      const library = requireRegisteredNoteLibrary(rawLibrary);
      dataRootLocks.acquire([library]);
      let committedContent = content;
      const publish = async () => {
        const temporary = assertInsideDirectory(path.join(library, `.trellora-import-${randomUUID()}.tmp`), library);
        const handle = await fs.promises.open(temporary, 'wx');
        try {
          await handle.close();
          for (;;) {
            const target = assertInsideDirectory(getUniquePath(library, sanitizeEntryName(fileName)), library);
            const publication = await publishResources?.(target);
            try { committedContent = publication?.content ?? content; await fs.promises.writeFile(temporary, committedContent, 'utf8'); const synced = await fs.promises.open(temporary, 'r+'); try { await synced.sync(); } finally { await synced.close(); } await fs.promises.link(temporary, target); return target; }
            catch (error) { await publication?.rollback(); if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          }
        } finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); }
      };
      return noteSaveService.structure(library, async () => {
        const active = getCurrentLibraryPath() === library;
        const filePath = active ? await indexCoordinator.mutate(async () => { const value = await publish(); return { value, changes: [{ kind: 'add' as const, path: value }] }; }) : await publish();
        let indexState: 'pending' | 'current' | 'degraded' = 'pending';
        if (active) {
          try { indexState = await indexCoordinator.awaitIndexedVersion(filePath, createHash('sha256').update(Buffer.from(committedContent, 'utf8')).digest('hex')) === 'current' ? 'current' : 'degraded'; }
          catch { indexState = 'degraded'; }
        }
        return { path: filePath, indexState, content: committedContent };
      });
    },
  });
  return documentSessionService;
}
let libraryRevision = 0;
let pipelineOrchestrator: PipelineOrchestrator | null = null;
let workspaceBackupService: WorkspaceBackupService | undefined;
let workspaceRestoreService: WorkspaceRestoreService | undefined;
let workspaceMigrationService: WorkspaceMigrationService | undefined;
let dailySnapshotTimer: ReturnType<typeof setInterval> | undefined;
app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
const appLogger = new AppLogger(() => app.getPath('logs'));
const userCapabilities = new UserCapabilities();
const cloudAuthorization = new CloudAuthorization();
const capabilityProbes = new Map<string, AbortController>();
const dataRootLocks = new DataRootLocks();
const maintenanceBarrier = new MaintenanceBarrier({
  prepareRenderer: requestId => { if (!mainWindow) throw new Error('请打开应用窗口后再备份。'); mainWindow.webContents.send('maintenance:prepare', { requestId }); return mainWindow.webContents.id; },
  changed: phase => mainWindow?.webContents.send('maintenance:changed', { phase }),
  participants: () => [...memoryExtractionServices.values(), ...memoryConsolidationServices.values(), ...conversationSearchServices.values(), ...(pipelineOrchestrator ? [pipelineOrchestrator] : [])],
  drain: async () => { await noteSaveService.drain(); await documentSessionService?.drain(); },
  stopWatching: () => indexCoordinator.stopWatching(),
  resumeWatching: async () => { try { await initializeLibraryIndex(); } catch { appLogger.record('warn', 'backup', 'INDEX_RESUME_FAILED'); } },
  extraBusy: () => Boolean(vectorGenerationService?.busy) || noteAnalysisOrchestrator.maintenanceBusy || assistantTurnTasks.size > 0 || selectionTransformTasks.size > 0 || selectionExpansionTasks.size > 0,
  allowResume: () => !workspaceMigrationService?.recoveryPending,
});
function registerAppHandler(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    const flushing = maintenanceBarrier.phase === 'preparing' && ['notes:save', 'notes:mutate', 'documents:update-draft'].includes(channel);
    if (workspaceMigrationService?.busy && !channel.startsWith('workspace-migration:') && !flushing) throw new Error('正在迁移数据，请等待迁移结束。');
    if (workspaceMigrationService?.recoveryPending && !workspaceMigrationService.busy
      && !channel.startsWith('workspace-migration:') && !migrationRecoveryReadChannels.has(channel)) {
      throw new Error('请先继续迁移或选择继续使用原位置。');
    }
    return maintenanceBarrier.invoke(channel, () => handler(event, ...args));
  });
}
const migrationRecoveryReadChannels = new Set(['ping', 'get-app-preferences', 'get-workspace-path', 'get-library-path', 'list-libraries', 'list-materials-libraries', 'onboarding:get', 'get-ai-provider-config', 'get-ai-model-settings', 'get-model-hub', 'get-assistant-ai-options', 'get-ai-extensions-settings', 'get-parsing-config', 'get-ai-status', 'selection-expansion:get-settings', 'selection-expansion:get-capabilities']);

const getWindowIconPath = () => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build/icon.ico');
};

type ExternalWebNavigationAction = 'back' | 'forward' | 'reload' | 'close';

function isExternalWebUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isExternalSystemUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'mailto:' || url.protocol === 'tel:';
  } catch {
    return false;
  }
}

function isExternalWebNavigationAction(value: unknown): value is ExternalWebNavigationAction {
  return value === 'back' || value === 'forward' || value === 'reload' || value === 'close';
}

function emitExternalWebNavigationState(webContents: Electron.WebContents): void {
  if (webContents.isDestroyed()) return;
  webContents.send('external-web-navigation-state', {
    canGoBack: webContents.canGoBack(),
    canGoForward: webContents.canGoForward(),
  });
}

function isExternalWebNavigationAborted(error: unknown): boolean {
  return getErrorMessage(error).includes('ERR_ABORTED (-3)');
}

/**
 * External pages must never run the application preload: it exposes trusted
 * local-file IPC for the Notes renderer. Keep web browsing in a separate,
 * sandboxed window with only the navigation controls supplied by its preload.
 */
function openExternalWebWindow(rawUrl: string): void {
  if (!isExternalWebUrl(rawUrl)) return;

  const externalWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    parent: mainWindow ?? undefined,
    icon: getWindowIconPath(),
    title: '网页查看',
    webPreferences: {
      preload: path.join(__dirname, 'externalWebPreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  externalWindow.setMenuBarVisibility(false);
  const webContents = externalWindow.webContents;
  externalWebContentsIds.add(webContents.id);

  // A target="_blank" page cannot create an unguarded Electron window.
  webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url);
    return { action: 'deny' };
  });

  const updateNavigationState = () => emitExternalWebNavigationState(webContents);
  webContents.on('did-navigate', updateNavigationState);
  webContents.on('did-navigate-in-page', updateNavigationState);
  webContents.on('did-finish-load', updateNavigationState);
  webContents.on('did-stop-loading', updateNavigationState);
  externalWindow.on('closed', () => externalWebContentsIds.delete(webContents.id));

  void externalWindow.loadURL(rawUrl).catch((error: Error) => {
    // Search engines may replace the initial URL while it is loading. Electron
    // reports that superseded navigation as ERR_ABORTED even though the window
    // continues to load the replacement page.
    if (isExternalWebNavigationAborted(error)) return;
    if (!externalWindow.isDestroyed()) {
      dialog.showErrorBox('网页打开失败', `无法打开链接：\n${error.message}`);
      externalWindow.close();
    }
  });
}

function openExternalWebUrl(rawUrl: string): void {
  if (!isExternalWebUrl(rawUrl)) return;
  if (getAppPreferences(store).externalLinkOpenMode === 'system-default') {
    void shell.openExternal(rawUrl).catch((error: Error) => {
      dialog.showErrorBox('默认浏览器打开失败', `无法在电脑默认浏览器中打开链接：\n${error.message}`);
    });
    return;
  }
  openExternalWebWindow(rawUrl);
}

function openAllowedExternalUrl(rawUrl: string): void {
  if (isExternalWebUrl(rawUrl)) {
    openExternalWebUrl(rawUrl);
    return;
  }
  if (!isExternalSystemUrl(rawUrl)) return;

  void shell.openExternal(rawUrl).catch((error: Error) => {
    dialog.showErrorBox('系统应用打开失败', `无法打开链接：\n${error.message}`);
  });
}

function configureMainWindowExternalNavigation(window: BrowserWindow): void {
  const webContents = window.webContents;

  // Markdown links without target="_blank" otherwise replace the whole Notes UI.
  webContents.on('will-navigate', (event, url) => {
    if (!isExternalWebUrl(url) && !isExternalSystemUrl(url)) return;
    event.preventDefault();
    openAllowedExternalUrl(url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url);
    return { action: 'deny' };
  });
}

function handleExternalWebNavigation(event: IpcMainEvent, action: unknown): void {
  if (!externalWebContentsIds.has(event.sender.id)) return;
  if (!isExternalWebNavigationAction(action)) return;

  const externalWindow = BrowserWindow.fromWebContents(event.sender);
  if (!externalWindow || externalWindow.isDestroyed()) return;

  if (action === 'back' && event.sender.canGoBack()) event.sender.goBack();
  if (action === 'forward' && event.sender.canGoForward()) event.sender.goForward();
  if (action === 'reload') event.sender.reload();
  if (action === 'close') externalWindow.close();
  emitExternalWebNavigationState(event.sender);
}

function logToWindow(...args: any[]) {
  appLogger.record(args.some(arg => arg instanceof Error) ? 'error' : 'info', 'main', 'MAIN_EVENT');
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  if (mainWindow) {
    mainWindow.webContents.send('main-log', message);
  }
  console.log(...args);
}

function assertInternalRenderer(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame.url;
  const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== 'production';
  const expectedUrl = isDevelopment
    ? 'http://localhost:5173/'
    : new URL(`file:///${path.resolve(__dirname, '../dist/index.html').replace(/\\/g, '/')}`).href;
  if (!senderUrl.startsWith(expectedUrl)) throw new Error('不允许来自外部页面的 AI 编辑请求。');
}

function selectionTaskKey(event: IpcMainInvokeEvent, requestId: string): string {
  return `${event.sender.id}:${requestId}`;
}

function emitSelectionExpansionEvent(event: IpcMainInvokeEvent, payload: import('./knowledge/selectionExpansionTypes').SelectionExpansionEvent): void {
  if (!event.sender.isDestroyed()) event.sender.send('selection-expansion-event', payload);
}

function isSelectionExpansionStaleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /当前笔记内容已变化|选区已不在当前保存的笔记|选区已失效/u.test(message);
}

function cancelSelectionExpansionTasksForSender(event: IpcMainInvokeEvent, exceptKey?: string): void {
  const prefix = `${event.sender.id}:`;
  for (const [key, controller] of selectionExpansionTasks) {
    if (key !== exceptKey && key.startsWith(prefix)) {
      controller.abort();
      selectionExpansionTasks.delete(key);
      selectionExpansionTaskEmitters.get(key)?.({ type: 'cancelled' });
      selectionExpansionTaskEmitters.delete(key);
    }
  }
}

function cancelSelectionTransformTasksForSender(event: IpcMainInvokeEvent): void {
  const prefix = `${event.sender.id}:`;
  for (const [key, controller] of selectionTransformTasks) {
    if (key.startsWith(prefix)) {
      controller.abort();
      selectionTransformTasks.delete(key);
    }
  }
}

function resolveSelectionEditCurrentNoteSource(request: {
  currentPath?: string;
  contextScope?: string;
  selectedText: string;
  selectionLocator?: import('../shared/selectionLocatorTypes').SelectionLocatorCapture;
  expectedContentHash?: string;
}): { snapshot: ReturnType<typeof getCurrentNoteSnapshotForAssistantMemory>; isSnapshotCurrent: () => boolean } | undefined {
  if (!request.currentPath || request.contextScope === 'nearby') return undefined;
  const libraryPath = requireCurrentLibraryPath();
  const safePath = assertInsideDirectory(request.currentPath, libraryPath);
  const snapshot = getCurrentNoteSnapshotForAssistantMemory(libraryPath, safePath);
  if (request.expectedContentHash && request.expectedContentHash !== snapshot.contentHash) throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  const currentNoteText = snapshot.blocks.map((block) => block.text).join('\n');
  if (request.selectionLocator || currentNoteText.includes(request.selectedText)) {
    return {
      snapshot,
      isSnapshotCurrent: () => getCurrentLibraryPath() === libraryPath
        && Boolean(noteIndex?.notes.some((note) => matchesCurrentNoteSnapshot(snapshot, note))),
    };
  }
  if (request.contextScope === 'current-note') {
    throw new Error('选区尚未保存到当前笔记，无法读取可核验的上下文。请保存后重试。');
  }
  return undefined;
}

function cancelSelectionEditTask(event: IpcMainInvokeEvent, requestId: unknown): boolean {
  if (typeof requestId !== 'string' || requestId.length > 128) return false;
  const key = selectionTaskKey(event, requestId);
  const controller = selectionTransformTasks.get(key);
  if (!controller) return false;
  controller.abort();
  selectionTransformTasks.delete(key);
  return true;
}

function emitAssistantTurnEvent(event: IpcMainInvokeEvent, payload: AssistantTurnEvent): void {
  if (payload.type === 'complete' && payload.result.type === 'answer') {
    payload = { ...payload, result: { ...payload.result, answer: normalizeMemorySaveClaims(payload.result.answer) } };
  }
  const key = selectionTaskKey(event, payload.requestId);
  if (payload.type === 'started') assistantTurnOutputBuffers.set(key, '');
  if (payload.type === 'delta') {
    assistantTurnOutputBuffers.set(key, `${assistantTurnOutputBuffers.get(key) ?? ''}${payload.text}`);
  }
  if (payload.type === 'delta-reset') assistantTurnOutputBuffers.set(key, '');
  if (!event.sender.isDestroyed()) event.sender.send('assistant-turn-event', payload);
}

function getAssistantTurnPartialText(event: IpcMainInvokeEvent, requestId: string): string | undefined {
  const text = assistantTurnOutputBuffers.get(selectionTaskKey(event, requestId));
  return text?.trim() ? text : undefined;
}

/** Keep internal scope provenance and Coverage Ledger details in the main process. */
function toPublicCurrentNoteSearchScope(scope: CurrentNoteSearchScope): CurrentNotePublicSearchScope {
  return { mode: scope.mode, coveragePolicy: scope.coveragePolicy };
}

/** Expose only the bounded, ledger-derived counts needed by the existing UI trace. */
function toPublicCurrentNoteSearchCoverage(coverage: CurrentNoteSearchCoverageSummary): CurrentNotePublicSearchCoverage {
  return {
    discoveredHeadingCount: coverage.discoveredHeadingCount,
    readHeadingCount: coverage.readHeadingCount,
    status: coverage.status,
    reason: coverage.reason,
  };
}

function cancelAssistantTurnsForSender(event: IpcMainInvokeEvent, exceptKey?: string): void {
  const prefix = `${event.sender.id}:`;
  for (const [key, controller] of assistantTurnTasks) {
    if (key !== exceptKey && key.startsWith(prefix)) {
      controller.abort();
      assistantTurnTasks.delete(key);
    }
  }
}

// Global Error Handler for startup
process.on('uncaughtException', (error) => {
  appLogger.record('error', 'startup', (error as NodeJS.ErrnoException).code || 'UNCAUGHT_EXCEPTION');
  dialog.showErrorBox('应用程序错误', `应用发生错误，已记录诊断。请重新启动；如仍失败，请检查工作区权限并提供日志。\n日志目录：${app.getPath('logs')}`);
  app.quit();
});

let startupInitialization: Promise<void> | undefined;
let documentProtocolReady = false;

async function initAndCreate() {
  try {
    store = new Store();
    initializeWorkspaceMigrationService();
    appLogger.record('info', 'startup', 'STARTUP_BEGIN');
    dataRootLocks.acquire([getConfiguredWorkspacePath(), ...listRegisteredLibraries(store).filter(library => fs.existsSync(library.path)).map(library => library.path), ...listMaterialsLibraries(store).filter(library => fs.existsSync(library.path)).map(library => library.path)]);
    // Migration precedes default configuration creation and never blocks local editing.
    try { initializeOnboarding(); } catch { appLogger.record('warn', 'startup', 'ONBOARDING_STATE_UNAVAILABLE'); }
    registerEditorImageProtocol(() => {
      const libraryPath = store?.get('libraryPath');
      return typeof libraryPath === 'string' && libraryPath.trim() ? libraryPath : null;
    });
    if (!documentProtocolReady) {
      protocol.handle(DOCUMENT_RESOURCE_SCHEME, async request => {
        try { const resource = await getDocumentSessionService().resources.read(request.url, request.method); return new Response(resource.bytes, { headers: { 'content-type': resource.mimeType, 'cache-control': 'no-store' } }); }
        catch { return new Response('Not found', { status: request.method === 'GET' ? 404 : 405 }); }
      }); documentProtocolReady = true;
    }
    ensureModelHubMigrated(store, {
      provider: readAiProviderConfig(),
      providerSecret: typeof store.get('aiProviderSecret') === 'string' ? store.get('aiProviderSecret') as string : undefined,
      embeddingModel: String(store.get('semanticEmbeddingModel') ?? ''),
    });
    // Pipeline startup may enqueue persisted documents immediately. Configure the
    // main-process-only AI client first so LLM chunking sees the actual provider.
    configureAiProvider(resolveGenerationConfig(store));
    pipelineOrchestrator = new PipelineOrchestrator({
      onStatus: (status) => { if (status.error) appLogger.record('warn', 'pipeline', status.error.code); mainWindow?.webContents.send('pipeline-status', status); },
      onProgress: (progress) => mainWindow?.webContents.send('pipeline-progress', progress),
      onLog: (message) => logToWindow(message),
      getMineruConfig: () => {
        const config = readParsingConfig(store);
        return {
          endpoint: config.mineruEndpoint,
          apiKey: readMineruApiKey(store),
          cloudParsingConsent: config.cloudParsingConsent,
        };
      },
      getAmbiguityConfig: () => readPipelineAmbiguityConfig(store),
      getAmbiguityModel: (libraryPath) => {
        const config = resolveLibraryPipelineLlmConfig(store, libraryPath);
        const provider = config.kind === 'openai-compatible' ? config.provider ?? 'openai-compatible' : 'ollama';
        const model = String(config.model ?? '').trim();
        const available = Boolean(model) && (config.kind === 'ollama' || (config.remoteContentConsent === true && Boolean(config.apiKey)));
        return {
          provider,
          model,
          available,
          fingerprint: `${provider}|${String(config.endpoint ?? '').trim()}|${config.remoteContentConsent === true ? 'remote-consent' : 'local-only'}`,
          generateJson: (input: { model: string; prompt: string; timeoutMs: number; maxOutputTokens: number; signal: AbortSignal }) => generateAiJsonWithOptions({ ...input, providerConfig: config }),
        };
      },
      getPipelineLlmConfig: (libraryPath) => resolveLibraryPipelineLlmConfig(store, libraryPath),
      getStructureConfig: () => readPipelineStructureConfig(store),
      getChunkingConfig: (libraryPath) => readLibraryChunkingConfig(libraryPath, store),
      getKeywordResources: (libraryPath) => readLibraryKeywordStageResources(libraryPath),
      getMaterialEmbeddingAdapter: ({ profile }) => resolveLockedMaterialEmbeddingAdapter(profile),
      onLibraryGraphUpdated: (libraryPath) => mainWindow?.webContents.send('library-graph-updated', libraryPath),
    });
    if (workspaceMigrationService?.recoveryPending) pipelineOrchestrator.pauseForMaintenance();
    for (const library of workspaceMigrationService?.recoveryPending ? [] : listMaterialsLibraries(store)) {
      pipelineOrchestrator.recoverLibrary(library.path);
      void pipelineOrchestrator.enqueuePending(library.path).catch((error) => logToWindow(`[PIPELINE] 自动入队失败：${error instanceof Error ? error.message : String(error)}`));
    }
    const configuredWorkspacePath = getConfiguredWorkspacePath();
    try {
      // Opening the unified store at app startup also recovers expired durable
      // extraction leases. A memory-store failure must not block the editor.
      ensureLocalMemoryPrincipalId(store);
      if (workspaceMigrationService?.recoveryPending) throw new Error('等待恢复工作区迁移。');
      qaMemoryDatabase.getDatabase(configuredWorkspacePath);
      const memoryScope = resolveActiveLongTermMemoryScope().scope;
      const migration = new MemoryMigrationService(
        qaMemoryDatabase,
        assistantMemoryDatabase,
        path.resolve(configuredWorkspacePath),
      ).migrate(memoryScope, [
        ...listRegisteredLibraries(store).map((library) => library.path),
        ...listMaterialsLibraries(store).map((library) => library.path),
      ]);
      if (migration.profile.completed || migration.currentNote.completed || migration.profile.failed || migration.currentNote.failed) {
        logToWindow(`[MEMORY] M8 迁移：画像 ${migration.profile.completed} 条、当前笔记历史 ${migration.currentNote.completed} 轮、失败 ${migration.profile.failed + migration.currentNote.failed} 条。`);
      }
      if (!isRestorePaused(getConfiguredWorkspacePath())) recoverCompletedExplicitMemories(qaMemoryDatabase, getConfiguredWorkspacePath(), memoryScope);
      getMemoryExtractionService().start();
      getConversationSearchService().start(memoryScope);
    } catch (error) {
      logToWindow('[MEMORY] 记忆数据库启动检查失败；编辑与文件浏览仍可继续。', getErrorMessage(error));
    }

    miniSearch = createNoteLexicalIndex();
    // 首帧先显示；渲染进程等 startup:ready 后才读取索引和工作空间。
    createWindow();
    if (!workspaceMigrationService?.recoveryPending) try { await initializeLibraryIndex(); } catch (error) { logToWindow('笔记索引初始化失败：', getErrorMessage(error)); }
    initializeWorkspaceBackupService();
    documentOpenRouter.start();
    appLogger.record('info', 'startup', 'STARTUP_READY');
  } catch (error: any) {
    appLogger.record('error', 'startup', error.code || 'STARTUP_FAILED');
    if (error.code === 'DATA_ROOT_IN_USE') {
      const choice = await dialog.showMessageBox({ type: 'warning', title: desktopText('数据目录正在使用'), message: desktopText('工作区或已登记的库被另一实例占用。关闭该实例后可重新打开；也可以选择其他位置，启动独立的数据配置。原配置和原库会保留。'), buttons: ['退出应用', '选择其他位置'].map(value => desktopText(value)), defaultId: 0, cancelId: 0 });
      if (choice.response === 1) {
        const selected = await dialog.showOpenDialog({ title: desktopText('选择独立数据位置'), properties: ['openDirectory', 'createDirectory'] });
        if (!selected.canceled) {
          const profile = path.join(selected.filePaths[0], `Trellora-profile-${randomUUID()}`); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ workspacePath: path.join(profile, 'Workspace') }), { flag: 'wx' });
          const args = process.argv.slice(1).filter(argument => !argument.startsWith('--user-data-dir=')); const index = args.indexOf('--user-data-dir'); if (index >= 0) args.splice(index, 2);
          app.relaunch({ args: [...args, `--user-data-dir=${profile}`] });
        }
      }
      app.quit(); return;
    }
    dialog.showErrorBox('初始化错误', `应用暂时无法启动。请检查数据目录是否可写、是否已被另一实例打开，然后重试。\n日志目录：${app.getPath('logs')}`);
    app.quit();
  }
}

function getWindowBackgroundColor(): string {
  const preferences = getAppPreferences(store);
  const useDark = preferences.theme === 'dark'
    || (preferences.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return getColorScheme(useDark ? 'dark' : 'light', preferences.lightColorScheme).canvas;
}

nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(getWindowBackgroundColor());
});

const createWindow = () => {
  noteCloseCoordinator.allowed = false;
  const preferences = getAppPreferences(store);
  const appearance: StartupAppearance = {
    theme: preferences.theme === 'dark' || (preferences.theme === 'system' && nativeTheme.shouldUseDarkColors) ? 'dark' : 'light',
    themeMode: preferences.theme,
    lightColorScheme: preferences.lightColorScheme,
    language: preferences.language,
  };
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: getWindowBackgroundColor(),
    icon: getWindowIconPath(),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: [`${STARTUP_APPEARANCE_ARGUMENT}${encodeURIComponent(JSON.stringify(appearance))}`],
      // devTools: true // Keep enabled for potential debugging
    },
  });
  configureMainWindowExternalNavigation(mainWindow);
  const startupWindow = mainWindow;
  startupWindow.once('ready-to-show', () => startupWindow.show());

  // `pnpm dev` starts the unpackaged Electron binary without injecting
  // NODE_ENV. Use the packaging boundary as the default source of truth so
  // development always connects to Vite instead of looking for dist/index.html.
  const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDevelopment) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    console.log('Loading index from:', indexPath);

    mainWindow.loadFile(indexPath).catch(e => {
      dialog.showErrorBox('界面加载错误', `无法加载应用界面：\n${indexPath}\n${e.message}`);
    });

  }

  mainWindow.setMenuBarVisibility(false);
  const mainWindowWebContentsId = mainWindow.webContents.id;

  mainWindow.on('close', (event) => {
    if (workspaceMigrationService?.busy) { event.preventDefault(); return; }
    if (workspaceBackupService?.busy || workspaceRestoreService?.busy) {
      event.preventDefault(); const window = mainWindow;
      void Promise.all([workspaceBackupService?.shutdown(), workspaceRestoreService?.shutdown()]).then(() => { if (window && !window.isDestroyed()) window.close(); }); return;
    }
    if (maintenanceBarrier.phase !== 'idle') { event.preventDefault(); return; }
    if (noteCloseCoordinator.allowed) return;
    event.preventDefault();
    const window = mainWindow!;
    void noteCloseCoordinator.request(window.webContents.id, (requestId) => window.webContents.send('notes:close-request', { requestId }), () => window.close());
  });
  // Clean up
  const detachDocumentRenderer = () => { noteCloseCoordinator.cancelPending(mainWindowWebContentsId); void documentSessionService?.detach(mainWindowWebContentsId); };
  mainWindow.webContents.on('render-process-gone', detachDocumentRenderer);
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) detachDocumentRenderer(); });
  mainWindow.on('closed', () => {
    noteSaveService.release(mainWindowWebContentsId);
    documentSessionService?.release(mainWindowWebContentsId);
    assistantSessionScopeRegistry.releaseWindow(mainWindowWebContentsId);
    mainWindow = null;
  });
};

function getConfiguredEmbeddingModel(): string {
  const slotModel = store ? readModelHub(store).slots.embedding.model.trim() : '';
  return slotModel || String(store?.get('semanticEmbeddingModel') ?? '').trim();
}

/** 将生成槽位同步回旧版 aiProvider 键，保证既有运行时链路（chat/诊断）与模型中枢一致。 */
function syncLegacyGenerationConfig(targetStore = store, configureRuntime = true): void {
  const config = resolveGenerationConfig(targetStore);
  if (config.kind === 'ollama') {
    targetStore.set('aiProvider', { kind: 'ollama', endpoint: config.endpoint, model: config.model, remoteContentConsent: false });
    targetStore.delete('aiProviderSecret');
  } else {
    if (config.apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API Key 未保存。');
      targetStore.set('aiProviderSecret', safeStorage.encryptString(config.apiKey.trim()).toString('base64'));
    } else {
      targetStore.delete('aiProviderSecret');
    }
    targetStore.set('aiProvider', { kind: 'openai-compatible', provider: config.provider, api: config.api, endpoint: config.endpoint, model: config.model, availableModels: config.availableModels ?? [], remoteContentConsent: Boolean(config.remoteContentConsent) });
  }
  if (configureRuntime) configureAiProvider(readAiProviderConfig());
}

/** 语言模型仍由模型档案管理；同步其默认档案到模型中枢，避免独立配置 embedding/rerank 时覆盖语言模型。 */
function syncModelHubGeneration(config: AiProviderConfig | undefined, targetStore = store): void {
  if (!config) return;
  if (config.kind === 'openai-compatible') {
    const providerId = config.provider ?? 'custom';
    saveProviderConnection(targetStore, providerId, {
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.api && config.api !== 'ollama-chat' ? { api: config.api } : {}),
      models: (config.availableModels ?? []).map((model) => model.name),
      ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
    });
  }
  saveModelHub(targetStore, {
    ...(config.kind === 'ollama' ? { ollamaEndpoint: config.endpoint } : {}),
    remoteConsent: Boolean(config.remoteContentConsent),
    slots: {
      generation: {
        source: config.kind === 'ollama' ? 'ollama' : config.provider ?? 'custom',
        model: config.model?.trim() ?? '',
      },
    },
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getLibraryTagVocabulary(): string[] {
  const tags = new Map<string, string>();
  for (const tag of (noteIndex?.notes ?? []).flatMap((note) => note.tags)) {
    const normalized = tag.trim().replace(/^#/, '');
    if (normalized) tags.set(normalized.toLocaleLowerCase('zh-Hans-CN'), normalized);
  }
  return [...tags.values()].sort((first, second) => first.localeCompare(second, 'zh-Hans-CN')).slice(0, 100);
}

/** Ordinary reads return the live projection; only startup/library activation scans. */
function refreshLibraryIndex(): any[] | null {
  noteIndex = indexCoordinator.current ?? null;
  return noteIndex?.fileTree ?? null;
}

async function initializeLibraryIndex(): Promise<void> {
  const library = getCurrentLibraryPath();
  if (!library) return;
  await recoverLibraryPathMove(library);
  const result = await indexCoordinator.initialize(library, miniSearch, (updated, _changes, delta) => {
    noteIndex = updated.noteIndex;
    libraryRevision++;
    if (delta) mainWindow?.webContents.send('notes:index-changed', delta);
  });
  noteIndex = result.noteIndex;
  libraryRevision++;
}

function getCurrentLibraryPath(): string | null {
  if (!store) return null;
  const libraryPath = store.get('libraryPath') as string;
  if (!libraryPath || !fs.existsSync(libraryPath)) return null;
  try {
    return fs.statSync(libraryPath).isDirectory() ? path.resolve(libraryPath) : null;
  } catch {
    return null;
  }
}

function getDefaultWorkspacePath(): string {
  return path.join(app.getPath('documents'), 'Trellora工作区');
}

function getConfiguredWorkspacePath(): string {
  const storedPath = typeof store?.get('workspacePath') === 'string' ? String(store.get('workspacePath')).trim() : '';
  const validated = validateSystemWorkspaceDirectory(storedPath || getDefaultWorkspacePath());
  if (storedPath !== validated.path) store.set('workspacePath', validated.path);
  return validated.path;
}

function setConfiguredWorkspacePath(workspacePath: string): string {
  const validated = validateSystemWorkspaceDirectory(workspacePath);
  dataRootLocks.acquire([validated.path]);
  syncAiSkillsToWorkspace(validated.path, readAiExtensionsSettings(), getBundledAiSkillsPath());
  store.set('workspacePath', validated.path);
  return validated.path;
}

async function activateLibraryPath(libraryPath: string, register = false, alias?: string): Promise<string> {
  const validatedWorkspace = validateWorkspaceDirectory(libraryPath);
  dataRootLocks.acquire([validatedWorkspace.path]);
  const previousLibrary = getCurrentLibraryPath();
  const activate = async () => {
    await indexCoordinator.stopWatching();
    if (register) registerAndActivateLibrary(store, validatedWorkspace.path, new Date(), alias);
    else activateRegisteredLibrary(store, validatedWorkspace.path);
    noteIndex = null;
    try { await initializeLibraryIndex(); }
    catch (error) { logToWindow(`笔记库已切换，索引暂不可用：${String(error)}`); }
    return validatedWorkspace.path;
  };
  return previousLibrary ? noteSaveService.structure(previousLibrary, activate) : activate();
}

function requireCurrentLibraryPath(): string {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('尚未选择有效的笔记库，请先新建或打开笔记库。');
  return libraryPath;
}

function requireRegisteredMaterialsLibrary(libraryPath: string): string {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('资料库路径无效。');
  const normalizedPath = path.resolve(libraryPath);
  if (!listMaterialsLibraries(store).some((library) => library.path === normalizedPath)) {
    throw new Error('该资料库尚未注册。');
  }
  if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isDirectory()) {
    throw new Error('资料库目录不存在或不可读。');
  }
  return normalizedPath;
}

function resolveMaterialEmbeddingProbe(candidateInput: unknown): {
  candidate: MaterialEmbeddingCandidate;
  probe: Parameters<typeof testMaterialEmbeddingCandidate>[0]['probe'];
} {
  const candidate = normalizeMaterialEmbeddingCandidate(candidateInput);
  const hub = readModelHub(store);
  if (candidate.sourceId === 'ollama') {
    if (candidate.transportKind !== 'ollama' || candidate.truncateInputs !== true) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', 'Ollama 候选必须使用 Ollama 传输和截断策略。');
    }
    const endpoint = normalizeEndpointIdentity(hub.ollamaEndpoint.trim() || getDefaultOllamaEndpoint());
    if (endpoint !== candidate.endpointIdentity) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '候选地址与当前 Ollama 连接不一致，请先更新模型连接。');
    }
    const sourceEndpoint = hub.ollamaEndpoint.trim() || undefined;
    return {
      candidate,
      probe: async ({ text, signal }) => {
        const result = await embedOllamaBatch({ endpoint: sourceEndpoint, model: candidate.requestedModel, texts: [text], signal, expectedModel: candidate.requestedModel, requestedDimensions: candidate.requestedDimensions, truncateInputs: candidate.truncateInputs });
        return { vectorDimension: result.dimension, responseModel: result.responseModel ?? candidate.requestedModel };
      },
    };
  }

  if (candidate.transportKind !== 'openai-compatible') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '远程候选必须使用 OpenAI 兼容传输。');
  }
  const provider = hub.providers.find((entry) => entry.id === candidate.sourceId);
  if (!provider) throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '候选模型来源不存在。');
  if (!hub.remoteConsent) throw new MaterialEmbeddingProfileError('EMBEDDING_CONSENT_REQUIRED', '锁定远程向量模型前，请先确认资料库内容发送范围。');
  const credentials = resolveProviderCredentials(store, candidate.sourceId);
  if (!credentials.apiKey) throw new MaterialEmbeddingProfileError('EMBEDDING_CREDENTIAL_REQUIRED', '当前模型来源没有可用 API Key，请先在模型与连接中保存密钥。');
  if (normalizeEndpointIdentity(credentials.endpoint) !== candidate.endpointIdentity) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '候选地址与当前厂商连接不一致，请先更新模型连接。');
  }
  return {
    candidate,
    probe: async ({ text, signal }) => {
      const result = await embedRemoteBatch({ endpoint: credentials.endpoint, apiKey: credentials.apiKey!, model: candidate.requestedModel, texts: [text], signal, expectedModel: candidate.requestedModel, requestedDimensions: candidate.requestedDimensions });
      return { vectorDimension: result.dimension, responseModel: result.responseModel ?? candidate.requestedModel };
    },
  };
}

function resolveLockedMaterialEmbeddingAdapter(profile: MaterialEmbeddingProfile) {
  const hub = readModelHub(store);
  if (profile.transportKind === 'ollama') {
    const endpoint = hub.ollamaEndpoint.trim() || getDefaultOllamaEndpoint();
    if (normalizeEndpointIdentity(endpoint) !== profile.endpointIdentity) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '锁定 profile 的 Ollama 地址与当前连接不一致。');
    }
    return createProfileEmbeddingAdapter({ kind: 'ollama', endpoint });
  }
  if (!hub.remoteConsent) return undefined;
  const credentials = resolveProviderCredentials(store, profile.sourceId);
  if (!credentials.endpoint || !credentials.apiKey) return undefined;
  if (normalizeEndpointIdentity(credentials.endpoint) !== profile.endpointIdentity) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '锁定 profile 的远程地址与当前厂商连接不一致。');
  }
  return createProfileEmbeddingAdapter({ kind: 'remote', endpoint: credentials.endpoint, apiKey: credentials.apiKey });
}

let vectorGenerationService: MaterialVectorGenerationService | undefined;
/** 迁移仅处理注册资料库；来源文件必须仍对应当前已提交的切块投影。 */
function getVectorGenerationService() {
  vectorGenerationService ??= new MaterialVectorGenerationService({
    appVersion: APP_INFO.version,
    adapter: resolveLockedMaterialEmbeddingAdapter,
    assertIdle: libraryPath => {
      if (pipelineOrchestrator?.isLibraryBusy(libraryPath) || workspaceMigrationService?.busy || workspaceBackupService?.busy || workspaceRestoreService?.busy) throw new Error('请等待资料流水线、工作区迁移或备份恢复结束后再操作索引代际。');
    },
    sourcesHash: (libraryPath, documents) => {
      const hashes = documents.map(document => {
        const source = findMaterialsDocument(libraryPath, document.id);
        if (!source || !fs.existsSync(source.absolutePath)) throw new Error('资料原文件缺失，不能构建或切换索引代际。');
        const hash = createHash('sha256').update(fs.readFileSync(source.absolutePath)).digest('hex');
        if (hash !== document.hash) throw new Error('原文件与切块版本不一致，请先重新处理资料。');
        return [document.id, hash];
      });
      return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
    },
  });
  return vectorGenerationService;
}

function isPipelineStageId(value: string): value is PipelineStageId {
  return value === 'parse' || value === 'lines' || value === 'signals' || value === 'ambiguity' || value === 'tree' || value === 'chunks' || value === 'keywords' || value === 'vectors' || value === 'entities';
}

function runKeywordSearchAgent(query: string): KeywordSearchOutcome {
  return createKeywordSearchOutcome(
    miniSearch ? createKeywordCandidates(searchNoteLexically(miniSearch, query), query, getCurrentLibraryPath()) : [],
    8,
  );
}

function requireRegisteredNoteLibrary(libraryPath: string): string {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('笔记库路径无效。');
  const normalizedPath = path.resolve(libraryPath);
  if (!listRegisteredLibraries(store).some((library) => library.path === normalizedPath)) {
    throw new Error('该笔记库尚未注册。');
  }
  if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isDirectory()) {
    throw new Error('笔记库目录不存在或不可读。');
  }
  return normalizedPath;
}

function searchNoteLibraryForAssistant(libraryPath: string, query: string): { index: NoteIndex; outcome: KeywordSearchOutcome } {
  const index = buildNoteIndex(libraryPath);
  const searchIndex = createNoteLexicalIndex();
  searchIndex.addAll(index.notes.map(toNoteSearchDocument));
  const outcome = createKeywordSearchOutcome(createKeywordCandidates(searchNoteLexically(searchIndex, query), query, libraryPath, index), 8);
  return { index, outcome };
}

interface MaterialSearchContext {
  targetPath: string;
  queryTerms?: string[];
  lexicalError?: string;
  adapter?: ReturnType<typeof resolveLockedMaterialEmbeddingAdapter>;
  embeddingProfile?: MaterialEmbeddingProfile;
  embeddingError?: string;
}

/** 资料库检索的统一准备：路径校验、Jieba 查询分词、锁定 embedding 适配器与错误降级。 */
async function prepareMaterialSearchContext(libraryPath: string, query: string, options: { tokenize?: boolean } = {}): Promise<MaterialSearchContext> {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const tokenization = options.tokenize === false ? {} : await tokenizeMaterialSearchQuery(targetPath, query);
  let profileStatus: ReturnType<typeof readMaterialEmbeddingProfile> = { state: 'UNBOUND' };
  let embeddingError: string | undefined;
  try {
    profileStatus = readMaterialEmbeddingProfile(targetPath);
  } catch (error) {
    embeddingError = getErrorMessage(error);
  }
  let adapter: ReturnType<typeof resolveLockedMaterialEmbeddingAdapter> | undefined;
  if (profileStatus.state === 'LOCKED' && profileStatus.profile) {
    try {
      adapter = resolveLockedMaterialEmbeddingAdapter(profileStatus.profile);
      if (!adapter) embeddingError = '锁定向量模型的连接不可用，请检查模型与密钥配置。';
    } catch (error) {
      embeddingError = getErrorMessage(error);
    }
  }
  return {
    targetPath,
    queryTerms: tokenization.terms,
    lexicalError: tokenization.error,
    adapter,
    ...(profileStatus.state === 'LOCKED' && profileStatus.profile ? { embeddingProfile: profileStatus.profile } : {}),
    embeddingError,
  };
}

async function searchKnowledgeBaseForAssistant(
  libraryPath: string,
  query: string,
  options: { mode?: MaterialChunkSearchMode; limit?: number; childOnly?: boolean } = {},
): Promise<ReturnType<typeof searchMaterialChunks>> {
  const mode = options.mode ?? 'hybrid';
  const context = await prepareMaterialSearchContext(libraryPath, query, { tokenize: mode !== 'semantic' });
  return searchMaterialChunks({
    libraryPath: context.targetPath,
    query,
    queryTerms: context.queryTerms,
    lexicalError: context.lexicalError,
    mode,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.childOnly ? { childOnly: true } : {}),
    adapter: context.adapter,
    embeddingError: context.embeddingError,
  });
}

async function tokenizeMaterialSearchQuery(libraryPath: string, query: string): Promise<{ terms?: string[]; error?: string }> {
  try {
    if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
    return { terms: await pipelineOrchestrator.tokenizeMaterialSearchQuery(libraryPath, query) };
  } catch (error) {
    const message = getErrorMessage(error);
    logToWindow(`[PIPELINE] Jieba 查询分词不可用，检索将使用兼容回退：${message}`);
    return { error: message };
  }
}

function createSourceSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const terms = query.toLocaleLowerCase('zh-Hans-CN').split(/\s+/).filter(Boolean);
  const normalized = compact.toLocaleLowerCase('zh-Hans-CN');
  const firstMatch = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 80);
  const end = Math.min(compact.length, start + 260);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

function getAssistantMemoryRepository(libraryPath: string): AssistantMemoryRepository {
  const planPersistenceEnabled = !['off', 'shadow-plan'].includes(getAppPreferences(store).assistantPlanMode);
  const repository = new AssistantMemoryRepository(
    assistantMemoryDatabase,
    libraryPath,
    planPersistenceEnabled,
  );
  return repository;
}

function getNoteDerivedDigestRepository(libraryPath: string, memoryRepository = getAssistantMemoryRepository(libraryPath)): NoteDerivedDigestRepository {
  return new NoteDerivedDigestRepository(assistantMemoryDatabase, memoryRepository, libraryPath);
}

/**
 * 问答区统一记忆编排器（按系统工作区缓存）：会话校验、批次压缩、M1/M2 装配
 * 全部在主进程完成；数据源只影响当前轮检索，不会切换会话或数据库。
 */
function getQaMemoryOrchestrator(): QaMemoryOrchestrator {
  const key = path.resolve(getConfiguredWorkspacePath());
  let orchestrator = qaMemoryOrchestrators.get(key);
  if (!orchestrator) {
    if (!qaLegacyMemoryMigrationAttemptedWorkspaces.has(key)) {
      qaLegacyMemoryMigrationAttemptedWorkspaces.add(key);
      try {
        const migration = qaLegacyMemoryMigrationService.migrate(key);
        if (migration.status === 'completed') {
          logToWindow(`[MEMORY] 旧问答历史已迁移：${migration.copiedSessionCount} 个会话、${migration.copiedTurnCount} 个轮次。`);
        }
      } catch (error) {
        logToWindow('[MEMORY] 旧问答历史迁移失败；qa-memory.db 继续可用。', error instanceof Error ? error.message : String(error));
      }
    }
    // One authority covers prepareTurn and every direct/summary startTurn call.
    const repository = new QaMemoryRepository(qaMemoryDatabase, key, {
      resolveScope: () => path.resolve(getConfiguredWorkspacePath()) === key ? tryResolveConversationArchiveScope() : undefined,
      isRouteEnabled: isMemoryExtractionRouteEnabled,
    });
    repository.recoverInterruptedTurns();
    const userProfileRepository = new UserProfileRepository(qaMemoryDatabase, key);
    orchestrator = new QaMemoryOrchestrator(
      repository,
      resolveQaCompressionModel,
      key,
      undefined,
      userProfileRepository,
    );
    qaMemoryOrchestrators.set(key, orchestrator);
  }
  return orchestrator;
}

/** The renderer never provides workspaceId/principalId for L4 memory. */
function resolveActiveLongTermMemoryScope() {
  return new MemoryScopeResolver({
    getActiveWorkspacePath: () => getConfiguredWorkspacePath(),
    listRegisteredWorkspacePaths: () => [getConfiguredWorkspacePath()],
    getPrincipalId: () => ensureLocalMemoryPrincipalId(store),
  }).resolveActive();
}

function tryResolveConversationArchiveScope(): ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'] | undefined {
  try {
    return resolveActiveLongTermMemoryScope().scope;
  } catch (error) {
    logToWindow(`[MEMORY] 历史对话归属作用域不可用：${getErrorMessage(error)}`);
    return undefined;
  }
}

function getMemoryWriteService(): MemoryWriteService {
  return new MemoryWriteService(qaMemoryDatabase, path.resolve(getConfiguredWorkspacePath()));
}

function resolveMemoryEmbeddingRuntime(): MemoryEmbeddingRuntime | undefined {
  const source = resolveEmbeddingSource(store);
  if (!source?.model.trim()) return undefined;
  return {
    modelId: source.model.trim(),
    embed: async (texts, timeoutMs, signal) => {
      const normalized = texts.map((text) => text.trim()).filter(Boolean);
      if (normalized.length !== texts.length || !normalized.length) throw new Error('长期记忆向量输入为空。');
      if (source.kind === 'remote') {
        return (await embedRemoteBatch({
          endpoint: source.endpoint,
          apiKey: source.apiKey,
          model: source.model,
          texts: normalized,
          timeoutMs,
          signal,
          expectedModel: source.model,
        })).vectors;
      }
      return (await embedOllamaBatch({
        endpoint: source.endpoint,
        model: source.model,
        texts: normalized,
        timeoutMs,
        signal,
        expectedModel: source.model,
        truncateInputs: true,
      })).vectors;
    },
  };
}

function getMemoryRecallService(): MemoryRecallService {
  const workspacePath = path.resolve(getConfiguredWorkspacePath());
  let service = memoryRecallServices.get(workspacePath);
  if (!service) {
    service = new MemoryRecallService(qaMemoryDatabase, workspacePath, resolveMemoryEmbeddingRuntime);
    memoryRecallServices.set(workspacePath, service);
  }
  return service;
}

function getMemoryConditioningService(): MemoryConditioningService {
  return new MemoryConditioningService(qaMemoryDatabase, path.resolve(getConfiguredWorkspacePath()));
}

function getMemoryAffinityService(): MemoryAffinityService {
  return new MemoryAffinityService(qaMemoryDatabase, path.resolve(getConfiguredWorkspacePath()));
}

function getMemoryConsolidationService(storagePath = getConfiguredWorkspacePath()): MemoryConsolidationService {
  const workspacePath = path.resolve(storagePath);
  let service = memoryConsolidationServices.get(workspacePath);
  if (!service) {
    service = new MemoryConsolidationService(qaMemoryDatabase, workspacePath, {
      revalidateScope: (scope) => path.resolve(getConfiguredWorkspacePath()) === workspacePath
        && Boolean(new MemoryScopeResolver({ getActiveWorkspacePath: () => getConfiguredWorkspacePath(), listRegisteredWorkspacePaths: () => [getConfiguredWorkspacePath()], getPrincipalId: () => ensureLocalMemoryPrincipalId(store) }).revalidatePersistedScope(scope)),
    });
    memoryConsolidationServices.set(workspacePath, service);
  }
  return service;
}

function getMemoryTopicService(): MemoryTopicService {
  return new MemoryTopicService(qaMemoryDatabase, path.resolve(getConfiguredWorkspacePath()));
}

function resolveDocumentAffinityFactors(scope: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope']) {
  return (documentIds: readonly string[]): ReadonlyMap<string, number> => {
    const affinities = getMemoryAffinityService().listForCandidates(scope, documentIds);
    return new Map([...affinities].map(([documentId, affinity]) => [documentId, calculateDocumentAffinityFactor(affinity.hits)]));
  };
}

function getConversationSearchService(): ConversationSearchService {
  const workspacePath = path.resolve(getConfiguredWorkspacePath());
  let service = conversationSearchServices.get(workspacePath);
  if (!service) {
    service = new ConversationSearchService(qaMemoryDatabase, workspacePath, {
      resolveEmbeddingRuntime: resolveMemoryEmbeddingRuntime,
      revalidateScope: (scope) => new MemoryScopeResolver({
        getActiveWorkspacePath: () => getConfiguredWorkspacePath(),
        listRegisteredWorkspacePaths: () => [getConfiguredWorkspacePath()],
        getPrincipalId: () => ensureLocalMemoryPrincipalId(store),
      }).revalidatePersistedScope(scope),
      onLog: logToWindow,
    });
    conversationSearchServices.set(workspacePath, service);
  }
  return service;
}

/** L3 availability is independent of the L4 enabled/principal/agent switches. */
function resolveConversationSearchRuntime(currentSessionId: string | null | undefined): SearchConversationsToolRuntime | undefined {
  const sessionId = currentSessionId?.trim();
  if (!sessionId) return undefined;
  try {
    const scope = resolveActiveLongTermMemoryScope().scope;
    const service = getConversationSearchService();
    if (!service.getAvailability(scope).enabled) return undefined;
    return { search: (query, limit) => service.search(scope, query, limit, sessionId) };
  } catch (error) {
    logToWindow(`[MEMORY] 历史对话搜索不可用：${getErrorMessage(error)}`);
    return undefined;
  }
}

async function recallLongTermMemory(query: string): Promise<{ recall: MemoryRecallResult; scope?: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'] }> {
  try {
    const context = resolveActiveLongTermMemoryScope();
    return { recall: await getMemoryRecallService().recall(context.scope, query), scope: context.scope };
  } catch (error) {
    logToWindow(`[MEMORY] 长期记忆召回已降级：${getErrorMessage(error)}`);
    return {
      recall: {
        availability: { enabled: false, reason: 'workspace-disabled' },
        resident: [], situational: [], usedItems: [], prompt: '', vectorUsed: false,
      },
    };
  }
}

function appendLongTermMemoryContext(contextMemory: ContextMemoryResult, recall: MemoryRecallResult, scope: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'] | undefined): ContextMemoryResult {
  if (!scope) return contextMemory;
  const material = createLongTermMemoryContextMaterial({
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    prompt: recall.prompt,
  });
  if (!material) return contextMemory;
  return {
    ...contextMemory,
    materials: [...contextMemory.materials, material],
    version: `${contextMemory.version}:l4:${material.id}`,
  };
}

function createMemoryCutoverContext(materials: readonly ContextMaterial[]): ContextMemoryResult {
  return {
    materials: [...materials],
    version: `memory-cutover:${materials.map((material) => material.id).join(':') || 'empty'}`,
    diagnostics: {
      source: 'memory-cutover',
      loadedTurns: 0,
      loadedSummaries: 0,
      recalledTurns: 0,
      staleItems: 0,
    },
  };
}

function getMemoryExtractionService(): MemoryExtractionService {
  const workspacePath = path.resolve(getConfiguredWorkspacePath());
  let service = memoryExtractionServices.get(workspacePath);
  if (!service) {
    service = new MemoryExtractionService(qaMemoryDatabase, workspacePath, {
      revalidateScope: (scope) => new MemoryScopeResolver({
        getActiveWorkspacePath: () => getConfiguredWorkspacePath(),
        listRegisteredWorkspacePaths: () => [getConfiguredWorkspacePath()],
        getPrincipalId: () => ensureLocalMemoryPrincipalId(store),
      }).revalidatePersistedScope(scope),
      resolveModel: resolveMemoryExtractionModel,
      isRouteEnabled: isMemoryExtractionRouteEnabled,
      getModelConfigurationVersion: () => createHash('sha256').update(JSON.stringify(readModelHub(store))).digest('hex'),
      generateJson: generateAiJsonWithOptions,
      consolidate: async (scope, reviewer) => {
        const outcome = await getMemoryConsolidationService(workspacePath).consolidate(scope, 'automatic', reviewer);
        if (!outcome.skipReason || outcome.skipReason === 'model_declined') {
          logToWindow(`[MEMORY] 自动整理完成：候选 ${outcome.candidateClusters} 组，合并 ${outcome.mergedClusters} 组。`);
        }
      },
      onLog: logToWindow,
    });
    memoryExtractionServices.set(workspacePath, service);
  }
  return service;
}

/**
 * The completed answer is already durable. M3 explicit writes and M4 scheduling
 * remain isolated from it; the M4 service validates canonical user turns itself.
 */
function completeTurnPostProcess(input: {
  userText: string;
  sessionId?: string | null;
  messageId: string;
  modelHint?: { profileId: string; modelId: string; contextWindowTokens: number };
  usedMemories?: readonly MemoryUsedItem[];
  memoryScope?: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'];
  onUsedMemories?: (items: MemoryUsedSnapshot[]) => void;
  onMemorySave?: (receipt: import('./knowledge/memory/memoryTypes').MemorySaveReceipt) => void;
  citedDocuments?: readonly MemoryDocumentCitation[];
  memoryProjectionMode?: MemoryProjectionMode;
}): void {
  const statement = detectExplicitMemoryStatement(input.userText);
  let scope: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'];
  try {
    scope = resolveActiveLongTermMemoryScope().scope;
  } catch (error) {
    logToWindow(`[MEMORY] 长期记忆后处理未启动：${getErrorMessage(error)}`);
    return;
  }
  try {
    getConversationSearchService().enqueueCompletedTurn(scope, input.messageId);
  } catch (error) {
    // The canonical answer is already durable. The archive row is repaired by
    // the startup/polling sweep and must never roll back answer delivery.
    logToWindow(`[MEMORY] 历史对话档案待后台补建：${getErrorMessage(error)}`);
  }
  if (statement) try {
    const receipt = input.sessionId
      ? saveCompletedExplicitMemory(qaMemoryDatabase, getConfiguredWorkspacePath(), scope,
        { sessionId: input.sessionId, messageId: input.messageId, userText: input.userText })
      : { status: 'failed' as const, code: 'MEMORY_SOURCE_NOT_DURABLE' };
    if (receipt) {
      input.onMemorySave?.(receipt);
      logToWindow(`[MEMORY] 显式记忆保存状态：${receipt.status}${receipt.code ? ` (${receipt.code})` : ''}`);
    }
  } catch (error) {
    // 回答已经完成；L4 开关关闭、用户遗忘和本地存储失败均不能反向影响结果。
    logToWindow(`[MEMORY] 显式记忆未写入：${getErrorMessage(error)}`);
    input.onMemorySave?.({ status: 'failed', code: 'MEMORY_SAVE_FAILED' });
  }
  if (isCanonicalMemoryProjection(normalizeMemoryProjectionMode(input.memoryProjectionMode))) {
    try {
      getMemoryExtractionService().scheduleAfterCompletedTurn(scope, {
        sessionId: input.sessionId,
        messageId: input.messageId,
        ...(input.modelHint ? { modelHint: input.modelHint } : {}),
      });
    } catch (error) {
      logToWindow(`[MEMORY] 自动记忆提炼未安排：${getErrorMessage(error)}`);
    }
  }
  if (input.usedMemories?.length && getMemoryWriteService().getAvailability(scope).enabled) try {
    getMemoryRecallService().recordUsedMemories(input.memoryScope ?? scope, input.messageId, input.usedMemories);
    input.onUsedMemories?.(getMemoryRecallService().listUsedMemories(input.memoryScope ?? scope, input.messageId));
  } catch (error) {
    logToWindow(`[MEMORY] 长期记忆使用账本未写入：${getErrorMessage(error)}`);
  }
  if (input.citedDocuments?.length && getMemoryWriteService().getAvailability(scope).enabled) try {
    getMemoryAffinityService().recordCompletedAnswer(scope, input.messageId, input.citedDocuments);
  } catch (error) {
    logToWindow(`[MEMORY] 文档亲和度未写入：${getErrorMessage(error)}`);
  }
}

function parseManualMemoryInput(value: unknown): ManualMemoryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('手工记忆参数无效。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.kind !== 'string' || typeof input.content !== 'string') {
    throw new Error('手工记忆需要类型和内容。');
  }
  return {
    kind: input.kind as ManualMemoryInput['kind'],
    content: input.content,
    ...(typeof input.topic === 'string' ? { topic: input.topic } : {}),
    ...(typeof input.importance === 'number' ? { importance: input.importance } : {}),
    ...(typeof input.expiresAt === 'string' || input.expiresAt === null ? { expiresAt: input.expiresAt } : {}),
  };
}

function parseMemoryItemPatch(value: unknown): MemoryItemPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆编辑参数无效。');
  const input = value as Record<string, unknown>;
  const patch: MemoryItemPatch = {};
  if (typeof input.kind === 'string') patch.kind = input.kind as MemoryItemPatch['kind'];
  if (typeof input.content === 'string') patch.content = input.content;
  if (typeof input.topic === 'string') patch.topic = input.topic;
  if (typeof input.importance === 'number') patch.importance = input.importance;
  if (typeof input.expiresAt === 'string' || input.expiresAt === null) patch.expiresAt = input.expiresAt;
  if (input.expectedFingerprint !== undefined) {
    if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedFingerprint)) throw new Error('记忆快照标识无效。');
    patch.expectedFingerprint = input.expectedFingerprint;
  }
  if (!Object.keys(patch).length) throw new Error('至少提供一个可编辑的记忆字段。');
  return patch;
}

function parseMemoryProposalReview(value: unknown): MemoryProposalReview | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提案审查参数无效。');
  const input = value as Record<string, unknown>;
  if (!['add', 'replace', 'retire'].includes(String(input.expectedAction))
    || typeof input.expectedProposalFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedProposalFingerprint)) throw new Error('请刷新提案后重新审查。');
  const review: MemoryProposalReview = { expectedAction: input.expectedAction as MemoryProposalReview['expectedAction'], expectedProposalFingerprint: input.expectedProposalFingerprint };
  if (input.targetItemId !== undefined || input.expectedTargetFingerprint !== undefined) {
    if (typeof input.targetItemId !== 'string' || !input.targetItemId.trim()
      || typeof input.expectedTargetFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedTargetFingerprint)) throw new Error('请先选择已展示的替换目标。');
    review.targetItemId = input.targetItemId; review.expectedTargetFingerprint = input.expectedTargetFingerprint;
  }
  return review;
}

function resolveUserProfileProviderId(config: AiProviderConfig): string {
  return config.kind === 'ollama' ? 'ollama' : config.provider ?? 'custom';
}

async function resolveMemoryExtractionModel(
  job: MemoryExtractionJobRecord,
  workspaceConfig: WorkspaceMemoryConfig,
): Promise<MemoryExtractionModelResolution> {
  try {
    const settings = readAiModelSettingsInput();
    const configured = workspaceConfig.extractModelId?.trim();
    const configuredProfile = configured
      ? settings.profiles.find((profile) => profile.id === configured || profile.config.model?.trim() === configured)
      : undefined;
    const sourceProfile = job.sourceModelProfileId
      ? settings.profiles.find((profile) => profile.id === job.sourceModelProfileId)
      : undefined;
    const selectedId = configuredProfile?.id ?? sourceProfile?.id ?? settings.defaultProfileId;
    const profile = resolveAssistantProfile(selectedId);
    const modelHint = configured && configuredProfile?.config.model?.trim() === configured
      ? configured
      : !configuredProfile && job.sourceModelId?.trim()
        ? job.sourceModelId.trim()
        : profile.config.model!.trim();
    const providerConfig = { ...profile.config, model: modelHint };
    const model = await getAssistantModel(providerConfig);
    const contextWindowTokens = Number.isInteger(job.sourceContextWindowTokens) && (job.sourceContextWindowTokens ?? 0) > 0
      ? job.sourceContextWindowTokens!
      : (await resolveAssistantContextWindow(providerConfig, model)).tokens;
    return { ready: true, providerConfig, model, contextWindowTokens };
  } catch (error) {
    return {
      ready: false,
      code: 'model_unavailable',
      message: error instanceof Error ? error.message : '当前没有可用的提炼模型。',
    };
  }
}

async function resolveManualMemoryConsolidationModel(
  scope: ReturnType<typeof resolveActiveLongTermMemoryScope>['scope'],
): Promise<MemoryExtractionModelResolution> {
  const timestamp = new Date().toISOString();
  return resolveMemoryExtractionModel({
    id: 'manual-memory-consolidation',
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    capturedGeneration: getMemoryWriteService().getSubject(scope).memoryGeneration,
    status: 'running',
    dueAt: timestamp,
    attempts: 0,
    claimedSessionIds: [],
    sourceModelProfileId: null,
    sourceModelId: null,
    sourceContextWindowTokens: null,
    leaseUntil: null,
    lastError: null,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }, getMemoryWriteService().getWorkspaceConfig(scope));
}

function resolveQaCompressionModel(): { model: string } | undefined {
  try {
    const config = getAiProviderConfig();
    const model = typeof config.model === 'string' ? config.model.trim() : '';
    if (!model) return undefined;
    if (!config.hasApiKey && config.kind !== 'ollama') return undefined;
    return { model };
  } catch {
    return undefined;
  }
}

function getCurrentNoteSnapshotForAssistantMemory(libraryPath: string, notePath: string) {
  if (!noteIndex) refreshLibraryIndex();
  const normalizedPath = path.resolve(notePath);
  const note = noteIndex?.notes.find((candidate) => path.resolve(candidate.path) === normalizedPath);
  if (!note) throw new Error('当前笔记不在已打开的笔记库中。');
  return createCurrentNoteSnapshotFromIndexedNote({ libraryPath, note, revision: libraryRevision });
}

function resolvePersistentAssistantSessionScope(event: IpcMainInvokeEvent, repository: AssistantMemoryRepository, snapshot: ReturnType<typeof createCurrentNoteSnapshotFromIndexedNote>, sessionId?: string): AssistantSessionScope {
  const resolvedSessionId = sessionId ?? repository.createSession({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    title: '新对话',
  }).sessionId;
  const scope = repository.resolveScope({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    sessionId: resolvedSessionId,
  });
  assistantSessionScopeRegistry.authorize(scope, event.sender.id);
  return scope;
}

function getAssistantMemoryMode(repository: AssistantMemoryRepository): AssistantMemoryMode {
  return repository.getSettings().mode;
}

function getAssistantMemoryIpcContext(event: IpcMainInvokeEvent, notePath: unknown) {
  if (typeof notePath !== 'string' || !notePath.trim()) throw new Error('当前笔记路径无效。');
  const libraryPath = requireCurrentLibraryPath();
  const snapshot = getCurrentNoteSnapshotForAssistantMemory(libraryPath, notePath);
  return { libraryPath, snapshot, repository: getAssistantMemoryRepository(libraryPath) };
}

function getAuthorizedAssistantMemoryScope(event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown) {
  const context = getAssistantMemoryIpcContext(event, notePath);
  const scope = resolvePersistentAssistantSessionScope(event, context.repository, context.snapshot, typeof sessionId === 'string' ? sessionId : undefined);
  return { ...context, scope };
}

function validateAssistantCitationForCurrentNote(citation: ReturnType<typeof validateAssistantEvidenceCitation>): AssistantCitationValidation {
  const libraryPath = requireCurrentLibraryPath();
  let snapshot: ReturnType<typeof getCurrentNoteSnapshotForAssistantMemory>;
  try {
    snapshot = getCurrentNoteSnapshotForAssistantMemory(libraryPath, citation.notePath);
  } catch {
    return { status: 'stale', message: '引用笔记已不在当前资料库中，无法定位。' };
  }
  return validateAssistantCitationAgainstSnapshot(citation, snapshot);
}

async function runAssistantTurn(event: IpcMainInvokeEvent, request: AssistantTurnRequest, controller: AbortController): Promise<void> {
  let publicPlanEvents: CurrentNotePublicPlanEvent[] = [];
  let publicModelEvents: AssistantPublicModelEvent[] = [];
  let reactModelRound = 0;
  let detailedTrace: AssistantDetailedTrace | undefined;
  try {
    detailedTrace = new AssistantDetailedTrace(app.getPath('logs'), request.requestId);
    console.info(`[assistant-detailed-trace] ${detailedTrace.filePath}`);
  } catch (error) {
    console.warn(`[assistant-detailed-trace] 无法创建详细日志: ${error instanceof Error ? error.message : String(error)}`);
  }
  const onDetailedTrace: AssistantDetailedTraceSink = (entry) => detailedTrace?.record(entry);
  onDetailedTrace({
    stage: 'turn',
    action: 'assistant-turn',
    status: 'started',
    input: request,
  });
  try {
    const libraryPath = getCurrentLibraryPath();
    if (libraryPath && !noteIndex) refreshLibraryIndex();
    if (request.intent === 'organize' && (!libraryPath || !noteIndex)) throw new Error('当前笔记库尚未完成索引。');
    const snapshotRevision = libraryRevision;
    const selectedProfile = resolveAssistantProfile(request.modelProfileId);
    if (request.intent === 'ask' && !request.contextSources?.length && !request.attachments?.length && !request.skillIds?.length) {
      onboardingService?.beginPracticeRequest(event.sender.id, { requestId: request.requestId, sessionId: request.sessionId, scope: request.scope, profile: selectedProfile, webSearch: request.webSearch });
    }
    const assistantSkillSnapshot = readAssistantSkills();
    const skillSelection = resolveAssistantSkillSelection(assistantSkillSnapshot, request.skillIds);
    const selectedSkills = skillSelection.selectedSkills;
    const resolvedSkillDefinitions = skillSelection.skills;
    const model = await getAssistantModel(selectedProfile.config);
    const effectiveContextWindow = await resolveAssistantContextWindow(selectedProfile.config, model);
    const contextWindowTokens = effectiveContextWindow.tokens;
    const modelCallGate = new ModelCallBudgetGate({
      maxModelCalls: DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxModelCalls,
    });
    const provider = selectedProfile.config.kind;
    const preferences = getAppPreferences(store);
    const onPublicModelEvent = (modelEvent: AssistantPublicModelEvent) => {
      publicModelEvents = [...publicModelEvents, modelEvent];
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'model', event: modelEvent });
    };
    const generateJsonWithTrace = async (jsonRequest: Omit<AiJsonGenerationOptions, 'model' | 'providerConfig' | 'thinkingMode'>): Promise<unknown> => {
      const startedAt = Date.now();
      const callKind = jsonRequest.callKind ?? 'json';
      const stage = callKind === 'plan' ? 'planner' : callKind === 'route-classify' ? 'routing' : 'model';
      const structuredOutputCapabilities = jsonRequest.jsonSchema
        ? resolveAiStructuredOutputCapabilities(selectedProfile.config, model, callKind)
        : undefined;
      let rawResponse: string | undefined;
      const callerRawResponse = jsonRequest.onRawResponse;
      const publicCallKind = callKind === 'decide' || callKind === 'synthesize' ? callKind : undefined;
      const publicRound = publicCallKind ? ++reactModelRound : undefined;
      const publicCallId = publicRound ? `react-model-${publicRound}` : undefined;
      const publicInput = publicCallKind
        ? createAssistantPublicModelText(jsonRequest.prompt, ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS)
        : undefined;
      if (publicCallKind && publicCallId && publicInput) {
        onPublicModelEvent({
          callId: publicCallId,
          round: publicRound!,
          callKind: publicCallKind,
          state: 'started',
          input: publicInput,
        });
      }
      try {
        const value = await generateAiJsonWithOptions({
          ...jsonRequest,
          timeoutMs: null,
          contextWindowTokens,
          model,
          providerConfig: selectedProfile.config,
          thinkingMode: callKind === 'route-classify' ? 'simple' : request.thinkingMode,
          onRawResponse: (text) => {
            rawResponse = text;
            callerRawResponse?.(text);
          },
        });
        onDetailedTrace({
          stage,
          action: `model-${callKind}`,
          status: 'completed',
          callKind,
          input: {
            prompt: jsonRequest.prompt,
            maxOutputTokens: jsonRequest.maxOutputTokens,
            jsonSchema: jsonRequest.jsonSchema,
            structuredOutputTransport: structuredOutputCapabilities?.transport,
            strictToolSchema: structuredOutputCapabilities?.strictToolSchema,
            provider,
            model,
          },
          output: { rawResponse, parsedJson: value },
          elapsedMs: Date.now() - startedAt,
        });
        if (publicCallKind && publicCallId && publicInput) {
          const outputText = rawResponse ?? JSON.stringify(value, null, 2) ?? String(value);
          onPublicModelEvent({
            callId: publicCallId,
            round: publicRound!,
            callKind: publicCallKind,
            state: 'completed',
            input: publicInput,
            output: createAssistantPublicModelText(outputText, ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS),
            elapsedMs: Date.now() - startedAt,
          });
        }
        return value;
      } catch (error) {
        const errorCode = error instanceof SyntaxError
          || isStructuredOutputContractError(error) && error.reason === 'invalid-tool-arguments'
          ? 'invalid-json'
          : isStructuredOutputContractError(error) ? `structured-output-${error.reason}` : 'provider-or-transport-error';
        onDetailedTrace({
          stage,
          action: `model-${callKind}`,
          status: 'rejected',
          callKind,
          input: {
            prompt: jsonRequest.prompt,
            maxOutputTokens: jsonRequest.maxOutputTokens,
            jsonSchema: jsonRequest.jsonSchema,
            structuredOutputTransport: structuredOutputCapabilities?.transport,
            strictToolSchema: structuredOutputCapabilities?.strictToolSchema,
            provider,
            model,
          },
          ...(rawResponse !== undefined ? { output: { rawResponse } } : {}),
          errorCode,
          error: toDetailedTraceError(error),
          elapsedMs: Date.now() - startedAt,
        });
        if (publicCallKind && publicCallId && publicInput) {
          onPublicModelEvent({
            callId: publicCallId,
            round: publicRound!,
            callKind: publicCallKind,
            state: 'rejected',
            input: publicInput,
            ...(rawResponse !== undefined ? { output: createAssistantPublicModelText(rawResponse, ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS) } : {}),
            errorCode,
            elapsedMs: Date.now() - startedAt,
          });
        }
        throw error;
      }
    };
    const modelCallCoordinator = new ModelCallCoordinator(modelCallGate, contextWindowTokens, 'react-turn', undefined, { providerKind: provider, model });
    const skillInstructions = selectedSkills.map((skill) => skill.instruction);
    const scopeLabel = getAssistantScopeLabel(request);
    // 多模态直传（方案 §8 Phase 3）：仅从本轮请求提取 image 附件的 dataUrl，喂给 VLM；文档附件另行解析为有界文本。
    const turnImages: AiTransportImage[] = (request.attachments ?? []).flatMap((attachment) => attachment.kind === 'image'
      ? [{ dataUrl: attachment.dataUrl, mimeType: attachment.mimeType, name: attachment.name }]
      : []);
    const assistantMineru = resolveAssistantMineruRuntimeConfig();
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'started', intent: request.intent, scopeLabel });
    throwIfAssistantCancelled(controller.signal);

    const isSnapshotCurrent = () => !controller.signal.aborted
      && getCurrentLibraryPath() === libraryPath
      && libraryRevision === snapshotRevision;

    const dedicatedKnowledgeBaseSource = getDedicatedKnowledgeBaseRagSource(request);
    if (request.scope === 'wiki-node' && request.wikiTarget) {
      // Wiki 节点问答（方案 §4.2）：作用域锁定当前章节子树，复用知识库 ReAct 引擎。
      const wikiTarget = request.wikiTarget;
      const wikiLibraryPath = requireRegisteredMaterialsLibrary(wikiTarget.libraryPath);
      const wikiOutline = mergeWikiDerivedNodes(
        wikiLibraryPath,
        applyWikiSiblingOrderOverrides(
          wikiLibraryPath,
          await readCurrentWikiDocumentOutline(wikiLibraryPath, wikiTarget.documentId),
        ),
      );
      const wikiOutcome = await runWikiNodeAgentTurn({
        event,
        request,
        controller,
        wikiTarget,
        outline: wikiOutline,
        model,
        provider,
        providerConfig: selectedProfile.config,
        contextWindowTokens,
        ...(turnImages.length ? { images: turnImages } : {}),
        ...(assistantMineru ? { mineru: assistantMineru } : {}),
        modelCallCoordinator,
        onDetailedTrace,
        store,
        emitTurnEvent: (payload) => emitAssistantTurnEvent(event, payload),
        prepareMaterialSearchContext: (libraryPath, query) => prepareMaterialSearchContext(libraryPath, query),
      });
      if (wikiOutcome.result) {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'complete', result: wikiOutcome.result });
        return;
      }
      throw new Error('Wiki 节点问答未返回结果，请稍后重试。');
    }
    if (dedicatedKnowledgeBaseSource) {
      const registeredLibraryPath = requireRegisteredMaterialsLibrary(dedicatedKnowledgeBaseSource.libraryPath);
      const qaOrchestrator = getQaMemoryOrchestrator();
      const knowledgeContextRuntimeMode = resolveQaContextRuntimeMode('knowledge-base');
      const knowledgeMemoryProjectionMode = resolveAssistantMemoryProjectionMode('knowledge-base');
      const useCanonicalKnowledgeMemory = isCanonicalMemoryProjection(knowledgeMemoryProjectionMode);
      const qaPreparation = await qaOrchestrator.prepareTurn({
        sessionId: request.sessionId,
        scope: 'knowledge-base',
        turnId: request.requestId,
        userText: request.userText,
        scopeLabel,
        route: 'knowledge-base',
        attachments: request.attachments,
        libraryPath: registeredLibraryPath,
        contextWindowTokens,
        projectContext: createAssistantProjectContext('knowledge-base', skillInstructions, request.answerDepth, resolvedSkillDefinitions),
        residualMemoryMode: knowledgeContextRuntimeMode,
        memoryProjectionMode: knowledgeMemoryProjectionMode,
      });
      // M5 deliberately runs after canonical history preparation and before
      // rewrite/retrieval. Its local failure is represented as an empty block.
      const longTermMemoryContext = await recallLongTermMemory(request.userText);
      const retrievalConditioning = useCanonicalKnowledgeMemory && longTermMemoryContext.scope
        ? getMemoryConditioningService().build(longTermMemoryContext.scope)
        : undefined;
      const documentAffinityFactors = useCanonicalKnowledgeMemory && longTermMemoryContext.scope && longTermMemoryContext.recall.availability.enabled
        ? resolveDocumentAffinityFactors(longTermMemoryContext.scope)
        : undefined;
      const canonicalKnowledgeContextMemory = appendLongTermMemoryContext(
        qaPreparation.memoryProjection.canonicalContext,
        longTermMemoryContext.recall,
        longTermMemoryContext.scope,
      );
      const knowledgeContextMemory = useCanonicalKnowledgeMemory
        ? canonicalKnowledgeContextMemory
        : qaPreparation.contextMemory;
      recordMemoryCutoverObservation({
        route: 'knowledge-base',
        mode: knowledgeMemoryProjectionMode,
        sessionId: qaPreparation.sessionId,
        legacyContext: qaPreparation.memoryProjection.legacyContext,
        canonicalContext: canonicalKnowledgeContextMemory,
        canonicalHistory: qaPreparation.recentHistoryMessages,
        recallItemIds: longTermMemoryContext.recall.usedItems.map(({ item }) => item.id),
        readDiagnostics: qaPreparation.memoryProjection.readDiagnostics,
      });
      // 记忆信封投影（优化方案 P1）：M1 摘要批次 + 用户画像内容，生产/影子双路共用。
      const knowledgeMemoryEnvelopeInputs = useCanonicalKnowledgeMemory
        ? {}
        : {
          qaSummaryBlocks: qaOrchestrator.repository.listSummaries(qaPreparation.sessionId),
          userProfileEnvelope: qaPreparation.contextMemory.materials
            .filter((material) => material.zone === 'user-profile')
            .map((material) => material.content)
            .join('\n\n') || undefined,
        };
      // 生产与影子链路使用同一本轮快照；工具仅能读取用户选中的技能及附加文件。
      const directorySkillOutcome = assistantSkillSnapshot.directoryOutcome;
      const mergedKnowledgeSkills = assistantSkillSnapshot.merged;
      const knowledgeSkillsInputs = {
        skills: resolvedSkillDefinitions,
        skillInstructionById: skillSelection.skillInstructionById,
        skillResourceRootById: skillSelection.skillResourceRootById,
      };
      onDetailedTrace({
        stage: 'skills',
        action: 'directory-load',
        status: 'completed',
        output: {
          loadedCount: directorySkillOutcome.skills.length,
          mergedCount: mergedKnowledgeSkills.mergedDirectoryCount,
          skipped: directorySkillOutcome.skipped.map((entry) => `${entry.directory}: ${entry.reason}`),
          disabled: directorySkillOutcome.disabled.map((entry) => entry.directory),
          nameConflicts: mergedKnowledgeSkills.nameConflicts.map((entry) => `${entry.directory}: ${entry.reason}`),
        },
      });
      try {
        // 知识库 ReAct Agent（方案 P1）：偏好为 on 时优先新链路，
        // 传输层不可用或引擎异常时自动回退旧流水线（P3 降级约定）。
        let result: AssistantTurnResult | undefined;
        let canonicalAgentMessages: NonNullable<Awaited<ReturnType<typeof runKnowledgeAgentTurn>>['agentMessages']> | undefined;
        let canonicalFinalReasoningContent: string | undefined;
        const knowledgeAgentMode = getAppPreferences(store).assistantKnowledgeAgentMode;
        const knowledgeWebSearchRuntime = resolveWebSearchRuntime(request);
        const knowledgeConversationSearchRuntime = useCanonicalKnowledgeMemory
          ? resolveConversationSearchRuntime(qaPreparation.sessionId)
          : undefined;
        if (shouldUseKnowledgeAgent(knowledgeAgentMode) && !controller.signal.aborted) {
          try {
            const agentOutcome = await runKnowledgeAgentTurn({
              event,
              request,
              controller,
              source: dedicatedKnowledgeBaseSource,
              model,
              provider,
              providerConfig: selectedProfile.config,
              contextWindowTokens,
              modelCallCoordinator,
              onDetailedTrace,
              store,
              emitTurnEvent: (payload) => emitAssistantTurnEvent(event, payload),
              prepareMaterialSearchContext: (libraryPath, query, options) => prepareMaterialSearchContext(libraryPath, query, options),
              qaRecentTurns: qaPreparation.recentTurns,
              ...(useCanonicalKnowledgeMemory ? { qaHistoryMessages: qaPreparation.recentHistoryMessages } : {}),
              qaSessionId: qaPreparation.sessionId,
              ...(knowledgeConversationSearchRuntime ? { conversationSearch: knowledgeConversationSearchRuntime } : {}),
              qaResidualMemoryObservation: qaPreparation.residualObservation,
              assistantContextRuntimeMode: knowledgeContextRuntimeMode,
              ...(useCanonicalKnowledgeMemory && longTermMemoryContext.recall.prompt ? { longTermMemoryPrompt: longTermMemoryContext.recall.prompt } : {}),
              ...(retrievalConditioning?.prompt ? { retrievalConditioning: retrievalConditioning.prompt } : {}),
              ...(documentAffinityFactors ? { documentAffinityFactors } : {}),
              ...(useCanonicalKnowledgeMemory && longTermMemoryContext.scope && longTermMemoryContext.recall.availability.enabled ? {
                memorySearch: {
                  search: (query: string, limit?: number) => getMemoryRecallService().search(longTermMemoryContext.scope!, query, limit),
                },
              } : {}),
              ...knowledgeMemoryEnvelopeInputs,
              ...knowledgeSkillsInputs,
              ...(knowledgeWebSearchRuntime ? { webSearch: knowledgeWebSearchRuntime } : {}),
            });
            result = agentOutcome.result;
            if (result) {
              canonicalAgentMessages = agentOutcome.agentMessages;
              canonicalFinalReasoningContent = agentOutcome.finalReasoningContent;
            }
            if (!result && agentOutcome.fallbackRequested) {
              onDetailedTrace({ stage: 'react', action: 'fallback', status: 'completed', output: { reason: 'transport-unavailable' } });
            }
          } catch (agentError) {
            if (controller.signal.aborted) throw agentError;
            onDetailedTrace({ stage: 'react', action: 'fallback', status: 'completed', output: { reason: 'agent-error', error: getErrorMessage(agentError) } });
            logToWindow(`[ASSISTANT] 知识库 ReAct Agent 失败，已回退旧流水线：${getErrorMessage(agentError)}`);
          }
        }
        if (!result) {
          result = await runDedicatedKnowledgeBaseRagTurn({
          event,
          request,
          controller,
          source: dedicatedKnowledgeBaseSource,
          model,
          provider,
          providerConfig: selectedProfile.config,
          contextWindowTokens,
          effectiveContextWindow,
          skillInstructions,
          modelCallCoordinator,
          onDetailedTrace,
          qaContextMemory: knowledgeContextMemory,
          qaMemoryZoneTokens: qaPreparation.zoneTokens,
          qaRecentTurns: qaPreparation.recentTurns,
          qaResidualMemoryObservation: qaPreparation.residualObservation,
          qaSessionId: qaPreparation.sessionId,
          qaMemoryOrchestrator: qaOrchestrator,
          knowledgeContextRuntimeMode,
          ...(retrievalConditioning?.prompt ? { retrievalConditioning: retrievalConditioning.prompt } : {}),
          ...(documentAffinityFactors ? { documentAffinityFactors } : {}),
          });
        }
        // P2 影子对比：旧链路已出回答后，后台异步跑新链路只落详细轨迹；
        // 影子失败仅记录遥测，不影响已交付的回答。
        if (shouldShadowKnowledgeAgent(knowledgeAgentMode) && !controller.signal.aborted) {
          void runKnowledgeShadowComparison({
            event,
            request,
            controller,
            source: dedicatedKnowledgeBaseSource,
            model,
            provider,
            providerConfig: selectedProfile.config,
            contextWindowTokens,
            onDetailedTrace,
            store,
            prepareMaterialSearchContext: (libraryPath, query, options) => prepareMaterialSearchContext(libraryPath, query, options),
            qaRecentTurns: qaPreparation.recentTurns,
            qaHistoryMessages: qaPreparation.recentHistoryMessages,
            qaSessionId: qaPreparation.sessionId,
            qaResidualMemoryObservation: qaPreparation.residualObservation,
            assistantContextRuntimeMode: knowledgeContextRuntimeMode,
            ...(retrievalConditioning?.prompt ? { retrievalConditioning: retrievalConditioning.prompt } : {}),
            ...(documentAffinityFactors ? { documentAffinityFactors } : {}),
            ...knowledgeMemoryEnvelopeInputs,
            ...knowledgeSkillsInputs,
            ...(knowledgeWebSearchRuntime ? { webSearch: knowledgeWebSearchRuntime } : {}),
          }).then((telemetry) => {
            onDetailedTrace({
              stage: 'react',
              action: 'shadow',
              status: telemetry.status === 'failure' ? 'failed' : 'completed',
              output: telemetry,
              ...(telemetry.elapsedMs !== undefined ? { elapsedMs: telemetry.elapsedMs } : {}),
            });
            logToWindow(`[ASSISTANT] 知识库影子对比 ${telemetry.status}：证据 ${telemetry.evidenceParentChunks ?? 0} 父块 / 引用 ${telemetry.citedParentChunks ?? 0} / 轮次 ${telemetry.rounds ?? 0} / 耗时 ${telemetry.elapsedMs ?? 0}ms`);
          });
        }
        try {
          qaOrchestrator.finalizeTurn(qaPreparation.sessionId, qaPreparation.turnId, result, {
            scope: 'knowledge-base',
            modelProfileId: selectedProfile.id,
            providerId: resolveUserProfileProviderId(selectedProfile.config),
            modelId: model,
            contextWindowTokens,
          }, {
            residualMemoryMode: knowledgeContextRuntimeMode,
            route: 'knowledge-base',
            ...(longTermMemoryContext.scope ? { archiveScope: longTermMemoryContext.scope } : {}),
            ...(canonicalAgentMessages ? { agentMessages: canonicalAgentMessages } : {}),
            ...(canonicalFinalReasoningContent ? { finalReasoningContent: canonicalFinalReasoningContent } : {}),
          });
          completeTurnPostProcess({
            onMemorySave: (receipt) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'memory-saved', receipt }),
            userText: request.userText,
            sessionId: qaPreparation.sessionId,
            messageId: qaPreparation.turnId,
            modelHint: { profileId: selectedProfile.id, modelId: model, contextWindowTokens },
            usedMemories: useCanonicalKnowledgeMemory ? longTermMemoryContext.recall.usedItems : [],
            memoryScope: longTermMemoryContext.scope,
            onUsedMemories: (items) => emitAssistantTurnEvent(event, {
              requestId: request.requestId,
              type: 'memory-used',
              items,
            }),
            citedDocuments: useCanonicalKnowledgeMemory && result.type === 'answer'
              ? (result.knowledgeBaseCitations ?? [])
                .filter((citation) => citation.documentId && result.answer.includes(`[${citation.reference}]`))
                .map((citation) => ({ documentId: citation.documentId!, title: citation.documentName, knowledgeBaseId: registeredLibraryPath }))
              : [],
            memoryProjectionMode: knowledgeMemoryProjectionMode,
          });
        } catch {
          // 记忆落库失败不影响回答交付；本轮标记为失败，不进热窗。
          qaOrchestrator.finishAbortedTurn(qaPreparation.sessionId, qaPreparation.turnId, 'error');
        }
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'complete', result });
      } catch (error) {
        try {
          qaOrchestrator.finishAbortedTurn(
            qaPreparation.sessionId,
            qaPreparation.turnId,
            controller.signal.aborted ? 'cancelled' : 'error',
            controller.signal.aborted ? getAssistantTurnPartialText(event, request.requestId) : undefined,
          );
        } catch {
          // 保留原始错误；记忆写入失败不影响错误展示。
        }
        throw error;
      }
      return;
    }

    if (request.intent === 'ask') {
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在理解你的问题…' });
      const documentNames = (request.attachments ?? [])
        .filter((attachment) => attachment.kind !== 'image')
        .map((attachment) => attachment.name);
      const queryUnderstanding: AssistantQueryUnderstanding = request.scope === 'chat'
        ? {
          rewriteQuery: request.userText.trim(),
          intent: documentNames.length ? 'doc_only' as const : turnImages.length ? 'image_only' as const : 'chitchat' as const,
          imageDescription: '',
          interactionRoute: documentNames.length ? 'react' as const : 'chat' as const,
          usedFallback: false,
        }
        : await createAssistantIntentClassifier({
        generateJson: async ({ prompt, signal, images, jsonSchema, temperature }) => {
          const prepared = modelCallCoordinator.prepare({
            callKind: 'route-classify',
            prompt,
            requestedMaxOutputTokens: images?.length ? 4_096 : 512,
          });
          if (!prepared.ready) throw new ModelCallPreparationError(prepared.reason);
          return generateJsonWithTrace({
            prompt,
            signal,
            callKind: 'route-classify',
            maxOutputTokens: prepared.call.plan.maxOutputTokens,
            jsonSchema,
            temperature,
            ...(images?.length ? { images } : {}),
          });
        },
      }).classify({
        question: request.userText,
        conversation: request.conversation,
        scope: request.scope,
        signal: controller.signal,
        ...(turnImages.length ? { images: turnImages } : {}),
        ...(documentNames.length ? { documentNames } : {}),
        language: '简体中文',
      });
      const interactionRoute = queryUnderstanding.interactionRoute;
      const rewrittenQuestion = queryUnderstanding.rewriteQuery || request.userText.trim();
      onDetailedTrace({
        stage: 'routing',
        action: 'route-classification-result',
        status: 'completed',
        input: { question: request.userText, conversation: request.conversation, scope: request.scope },
        output: {
          interactionRoute,
          intent: queryUnderstanding.intent,
          rewriteQuery: rewrittenQuestion,
          imageDescription: queryUnderstanding.imageDescription.slice(0, 4_000),
          usedFallback: queryUnderstanding.usedFallback,
          ...(queryUnderstanding.fallbackReason ? { fallbackReason: queryUnderstanding.fallbackReason } : {}),
        },
      });
      throwIfAssistantCancelled(controller.signal);
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'route', interactionRoute });
      if (interactionRoute === 'chat') {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在聊天…' });
        const chatStartedAt = Date.now();
        // scope === 'chat' 只能续写开放式问答会话；仓储层会拒绝知识库会话的 sessionId。
        const qaChatOrchestrator = request.scope === 'chat' ? getQaMemoryOrchestrator() : undefined;
        const chatContextRuntimeMode = qaChatOrchestrator ? resolveQaContextRuntimeMode('chat') : 'off';
        const chatMemoryProjectionMode = qaChatOrchestrator
          ? resolveAssistantMemoryProjectionMode('chat')
          : 'canonical';
        const useCanonicalChatMemory = isCanonicalMemoryProjection(chatMemoryProjectionMode);
        const qaChatPreparation = qaChatOrchestrator
          ? await qaChatOrchestrator.prepareTurn({
            sessionId: request.sessionId,
            scope: 'chat',
            turnId: request.requestId,
            userText: request.userText,
            scopeLabel,
            route: 'chat',
            attachments: request.attachments,
            contextWindowTokens,
            projectContext: createAssistantProjectContext('chat', skillInstructions, request.answerDepth, resolvedSkillDefinitions),
            residualMemoryMode: chatContextRuntimeMode,
            memoryProjectionMode: chatMemoryProjectionMode,
          })
          : undefined;
        const chatLongTermMemoryContext = await recallLongTermMemory(request.userText);
        const canonicalChatContextMemory = qaChatPreparation
          ? appendLongTermMemoryContext(qaChatPreparation.memoryProjection.canonicalContext, chatLongTermMemoryContext.recall, chatLongTermMemoryContext.scope)
          : undefined;
        const chatContextMemory = qaChatPreparation
          ? useCanonicalChatMemory ? canonicalChatContextMemory : qaChatPreparation.contextMemory
          : undefined;
        if (qaChatPreparation && canonicalChatContextMemory) recordMemoryCutoverObservation({
          route: 'chat',
          mode: chatMemoryProjectionMode,
          sessionId: qaChatPreparation.sessionId,
          legacyContext: qaChatPreparation.memoryProjection.legacyContext,
          canonicalContext: canonicalChatContextMemory,
          canonicalHistory: qaChatPreparation.recentHistoryMessages,
          recallItemIds: chatLongTermMemoryContext.recall.usedItems.map(({ item }) => item.id),
          readDiagnostics: qaChatPreparation.memoryProjection.readDiagnostics,
        });
        // 开放式问答联网搜索：运行时可用时优先联网链路（ReAct / 固定流水线降级），
        // 链路异常降级直答并落痕；未配置/本轮关闭时保持直答零回归。
        let chatResult: AssistantTurnResult | undefined;
        let canonicalChatAgentMessages: NonNullable<Awaited<ReturnType<typeof runChatWebSearchReactTurn>>['agentMessages']> | undefined;
        let canonicalChatFinalReasoningContent: string | undefined;
        const chatWebRuntime = resolveWebSearchRuntime(request);
        const chatConversationSearchRuntime = useCanonicalChatMemory
          ? resolveConversationSearchRuntime(qaChatPreparation?.sessionId)
          : undefined;
        // 联网 ReAct 的消息协议当前只承载文本；带图轮次必须留在 direct VLM 链路，避免图片被静默丢弃。
        if (chatWebRuntime && turnImages.length === 0 && !controller.signal.aborted) {
          const chatWebTransport = createReActChatTransport(selectedProfile.config, model);
          try {
            const webInput = {
              event,
              request,
              controller,
              model,
              provider,
              providerConfig: selectedProfile.config,
              contextWindowTokens,
              modelCallCoordinator,
              onDetailedTrace,
              emitTurnEvent: (payload: AssistantTurnEvent) => emitAssistantTurnEvent(event, payload),
              webSearch: chatWebRuntime,
              skillInstructions,
              qaSessionId: qaChatPreparation?.sessionId,
              ...(chatConversationSearchRuntime ? { conversationSearch: chatConversationSearchRuntime } : {}),
              ...(useCanonicalChatMemory && chatLongTermMemoryContext.recall.prompt ? { longTermMemoryPrompt: chatLongTermMemoryContext.recall.prompt } : {}),
              ...(useCanonicalChatMemory && chatLongTermMemoryContext.scope && chatLongTermMemoryContext.recall.availability.enabled ? {
                memorySearch: {
                  search: (query: string, limit?: number) => getMemoryRecallService().search(chatLongTermMemoryContext.scope!, query, limit),
                },
              } : {}),
            };
            const webOutcome = chatWebTransport
              ? await runChatWebSearchReactTurn({
                ...webInput,
                qaRecentTurns: qaChatPreparation?.recentTurns,
                ...(useCanonicalChatMemory ? { qaHistoryMessages: qaChatPreparation?.recentHistoryMessages } : {}),
                transport: chatWebTransport,
              })
              : await runChatWebSearchFallbackTurn(webInput);
            chatResult = webOutcome.result;
            canonicalChatAgentMessages = webOutcome.agentMessages;
            canonicalChatFinalReasoningContent = webOutcome.finalReasoningContent;
          } catch (webError) {
            if (controller.signal.aborted) throw webError;
            onDetailedTrace({ stage: 'react', action: 'web-chat', status: 'failed', error: getErrorMessage(webError) });
            logToWindow(`[ASSISTANT] 开放式问答联网搜索失败，回退直答链路：${getErrorMessage(webError)}`);
          }
        }
        const runDirectChatAnswer = async (): Promise<AssistantTurnResult> => {
        let chatAssembly = qaChatPreparation
          ? createQaContextRuntimeAssembly({
            route: 'chat',
            callKind: 'chat',
            question: request.userText,
            sources: [],
            contextMemory: chatContextMemory!,
            memoryZoneTokens: qaChatPreparation.zoneTokens,
            skillInstructions,
            answerDepth: request.answerDepth,
            scope: {
              workspaceId: getConfiguredWorkspacePath(),
              sessionId: qaChatPreparation.sessionId,
              turnId: request.requestId,
            },
            windowProfile: effectiveContextWindow.runtimeProfile,
            residualMemoryObservation: qaChatPreparation.residualObservation,
          })
          : createAssistantChatPromptMessages(request.userText, request.conversation, skillInstructions, request.answerDepth);
        let chatContextDiagnostics: ContextProjectionDiagnostics | undefined;
        let preparedChatContextObservation: ContextRuntimeObservationResult | undefined;
        let chatEnforcementErrorCode: string | undefined;
        let chatHardVeto = false;
        if (qaChatPreparation && chatContextRuntimeMode === 'enforce' && 'envelope' in chatAssembly) {
          const calibrationMultiplier = modelCallCoordinator.getCalibrationMultiplier('chat', CONTEXT_REQUEST_ENVELOPE_VERSION);
          const enforced = await qaChatOrchestrator!.enforceChatContext({
            sessionId: qaChatPreparation.sessionId,
            envelope: chatAssembly.envelope,
            model,
            providerConfig: selectedProfile.config,
            calibrationMultiplier,
            signal: controller.signal,
          });
          chatAssembly = {
            ...chatAssembly,
            envelope: enforced.envelope,
            projection: enforced.projection,
          };
          preparedChatContextObservation = observeContextRuntime({
            mode: 'enforce',
            envelope: enforced.envelope,
            sendPath: 'projection-enforce',
            legacy: {
              combinedPrompt: chatAssembly.prompt,
              systemPrompt: chatAssembly.systemPrompt,
              userPrompt: chatAssembly.userPrompt,
            },
            preparedProjection: enforced.projection,
            preparedAdmission: enforced.admission,
            preparedPressureEpisode: enforced.pressureEpisode,
            qaResidualMemoryEnforcement: enforced.diagnostics,
            modelCallsAdded: enforced.diagnostics.compaction.modelCalls,
            memoryWritesAdded: enforced.diagnostics.compaction.memoryWrites,
          });
          chatEnforcementErrorCode = enforced.sendAllowed ? undefined : enforced.errorCode ?? 'CONTEXT_PRESSURE_THRASHING';
          chatHardVeto = enforced.diagnostics.state === 'hard-veto';
        }
        const chatPrompt = chatAssembly.prompt;
        const chatProjection = qaChatPreparation && chatContextRuntimeMode === 'enforce' && 'projection' in chatAssembly
          ? chatAssembly.projection
          : undefined;
        const publishPreparedChatContextDiagnostics = () => {
          if (!preparedChatContextObservation) return;
          chatContextDiagnostics = preparedChatContextObservation.report.diagnostics;
          emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: preparedChatContextObservation.report.diagnostics });
          recordQaContextRuntimeObservation(onDetailedTrace, preparedChatContextObservation.report);
        };
        if (chatEnforcementErrorCode) {
          publishPreparedChatContextDiagnostics();
          throw new Error(chatEnforcementErrorCode === 'CONTEXT_PRESSURE_THRASHING'
            ? '上下文连续压缩未获得有效收益，已停止自动重试。请移除大附件、切换更大窗口模型或新建会话。'
            : '会话 Checkpoint 压缩未通过契约，未发送模型请求。请重试、切换模型或新建会话。');
        }
        const preparedChatCall = modelCallCoordinator.prepare({
          callKind: 'chat',
          prompt: chatProjection ? combineAssistantRolePrompts(chatProjection.systemPrompt, chatProjection.userPrompt) : chatPrompt,
          serializedBudgetText: chatProjection?.serializedBudgetText
            ?? serializeContextRoleMessagesForBudget(chatAssembly.systemPrompt, chatAssembly.userPrompt, []),
          requestEnvelopeVersion: chatProjection?.requestEnvelopeVersion ?? CONTEXT_REQUEST_ENVELOPE_VERSION,
        });
        if (!preparedChatCall.ready) {
          publishPreparedChatContextDiagnostics();
          throw new ModelCallPreparationError(preparedChatCall.reason);
        }
        if (chatHardVeto) {
          publishPreparedChatContextDiagnostics();
          throw new ModelCallPreparationError('context-budget');
        }
        const chat = await streamKnowledgeAnswer({
            question: request.userText,
            conversation: qaChatPreparation ? [] : request.conversation,
            sources: [],
            prompt: chatPrompt,
            systemPrompt: chatAssembly.systemPrompt,
            userPrompt: chatAssembly.userPrompt,
            temperature: resolveAssistantAnswerTemperature({ grounded: false, skills: selectedSkills }),
            model,
            signal: controller.signal,
            providerConfig: selectedProfile.config,
            thinkingMode: request.thinkingMode,
            ...(turnImages.length ? { images: turnImages } : {}),
            answerDepth: request.answerDepth,
            contextWindowTokens,
            contextWindow: effectiveContextWindow,
            skillInstructions,
            preparedModelCall: preparedChatCall.call,
            modelCallKind: 'chat',
            assistantContextRuntimeMode: chatContextRuntimeMode,
            qaResidualMemoryObservation: chatContextRuntimeMode !== 'enforce' && 'residualMemoryObservation' in chatAssembly
              ? chatAssembly.residualMemoryObservation
              : undefined,
            preparedContextRuntimeObservation: preparedChatContextObservation,
            ...('envelope' in chatAssembly ? { contextEnvelope: chatAssembly.envelope } : {}),
            contextRuntimeRoute: 'chat',
            contextRuntimeScope: {
              workspaceId: getConfiguredWorkspacePath(),
              ...(qaChatPreparation ? { sessionId: qaChatPreparation.sessionId } : {}),
              turnId: request.requestId,
            },
            onContextRuntimeObservation: (report) => {
              chatContextDiagnostics = report.diagnostics;
              emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: report.diagnostics });
              recordQaContextRuntimeObservation(onDetailedTrace, report);
            },
            onDelta: (text) => {
              if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text });
            },
            onThinkingDelta: (text) => {
              if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'thinking-delta', text });
            },
          });
          throwIfAssistantCancelled(controller.signal);
          return {
            type: 'answer',
            answer: chat.answer,
            provider,
            model,
            sourceNotes: [],
            retrievalMode: 'none',
            interactionRoute: 'chat',
            contextUsage: chat.contextUsage,
            executionElapsedMs: Math.max(0, Date.now() - chatStartedAt),
            cacheUsage: { providerReported: chat.contextUsage.source === 'provider' && chat.contextUsage.cachedInputTokens !== undefined },
            ...(chat.thinkingText ? { thinkingText: chat.thinkingText, thinkingElapsedMs: chat.thinkingElapsedMs } : {}),
            ...(qaChatPreparation ? { qaSessionId: qaChatPreparation.sessionId } : {}),
            ...('zoneTokens' in chatAssembly ? { qaMemoryZones: chatAssembly.zoneTokens } : {}),
            ...(chatContextDiagnostics ? { contextDiagnostics: chatContextDiagnostics } : {}),
          };
        };
        let practicePersisted = false;
        try {
          if (!chatResult) {
            chatResult = await runDirectChatAnswer();
          }
          if (qaChatOrchestrator && qaChatPreparation) {
            try {
              qaChatOrchestrator.finalizeTurn(qaChatPreparation.sessionId, qaChatPreparation.turnId, chatResult, {
                scope: 'chat',
                modelProfileId: selectedProfile.id,
                providerId: resolveUserProfileProviderId(selectedProfile.config),
                modelId: model,
                contextWindowTokens,
              }, {
                residualMemoryMode: chatContextRuntimeMode,
                route: 'chat',
                ...(chatLongTermMemoryContext.scope ? { archiveScope: chatLongTermMemoryContext.scope } : {}),
                ...(canonicalChatAgentMessages ? { agentMessages: canonicalChatAgentMessages } : {}),
                ...(canonicalChatFinalReasoningContent ? { finalReasoningContent: canonicalChatFinalReasoningContent } : {}),
              });
              practicePersisted = true;
              completeTurnPostProcess({
                onMemorySave: (receipt) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'memory-saved', receipt }),
                userText: request.userText,
                sessionId: qaChatPreparation.sessionId,
            messageId: qaChatPreparation.turnId,
            modelHint: { profileId: selectedProfile.id, modelId: model, contextWindowTokens },
            usedMemories: useCanonicalChatMemory ? chatLongTermMemoryContext.recall.usedItems : [],
            memoryScope: chatLongTermMemoryContext.scope,
            onUsedMemories: (items) => emitAssistantTurnEvent(event, {
              requestId: request.requestId,
              type: 'memory-used',
              items,
            }),
            memoryProjectionMode: chatMemoryProjectionMode,
          });
            } catch {
              practicePersisted = false;
              // 记忆落库失败不影响回答交付；本轮标记为失败，不进热窗。
              qaChatOrchestrator.finishAbortedTurn(qaChatPreparation.sessionId, qaChatPreparation.turnId, 'error');
            }
          }
          emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'complete', result: chatResult });
          // Tutorial success requires this chat's normal persistence, not just a streamed answer.
          try { onboardingService?.completePractice(event.sender.id, request.requestId, { answer: chatResult.answer, persisted: practicePersisted, sessionId: qaChatPreparation?.sessionId, complete: chatResult.type === 'answer' && (!chatResult.completeness || chatResult.completeness === 'complete') && !controller.signal.aborted }); }
          catch { appLogger.record('warn', 'onboarding', 'ONBOARDING_PROGRESS_SAVE_FAILED'); }
          // 开放式问答建议追问：回答交付后独立小调用生成 chips，失败/取消静默落痕。
          if (request.scope === 'chat' && request.intent === 'ask' && !controller.signal.aborted && !onboardingService?.isPracticeRequest(event.sender.id, request.requestId)) {
            const followUpStartedAt = Date.now();
            let followUpRawOutput: string | undefined;
            try {
              const followUpHistory = selectFollowUpHistory(request.conversation);
              const followUpPrompt = buildFollowUpSuggestionsPrompt({
                question: request.userText,
                answerHead: chatResult.answer.slice(0, 600),
                history: followUpHistory,
              });
              const preparedFollowUpCall = modelCallCoordinator.prepare({ callKind: 'follow-up-suggest', prompt: followUpPrompt });
              if (!preparedFollowUpCall.ready) throw new ModelCallPreparationError(preparedFollowUpCall.reason);
              const questions = await generateFollowUpSuggestions({
                question: request.userText,
                answer: chatResult.answer,
                history: followUpHistory,
                model,
                providerConfig: selectedProfile.config,
                contextWindowTokens,
                signal: controller.signal,
                onRawOutput: (raw) => { followUpRawOutput = raw; },
              });
              onDetailedTrace({
                stage: 'follow-up',
                action: 'follow-up-suggestions',
                status: 'completed',
                callKind: 'follow-up-suggest',
                input: { question: request.userText },
                output: {
                  questions,
                  ...(followUpRawOutput !== undefined ? { rawOutput: followUpRawOutput.slice(0, 2_000) } : {}),
                },
                elapsedMs: Date.now() - followUpStartedAt,
              });
              if (questions.length && !controller.signal.aborted) {
                emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'suggestions', questions });
              }
            } catch (error) {
              onDetailedTrace({
                stage: 'follow-up',
                action: 'follow-up-suggestions',
                status: 'rejected',
                callKind: 'follow-up-suggest',
                input: { question: request.userText },
                errorCode: controller.signal.aborted
                  ? 'cancelled'
                  : error instanceof FollowUpSuggestionsError ? error.code : 'follow-up-unexpected-error',
                ...(!controller.signal.aborted ? { error: toDetailedTraceError(error) } : {}),
                ...(error instanceof FollowUpSuggestionsError && error.rawOutput !== undefined ? { output: { rawOutput: error.rawOutput.slice(0, 2_000) } } : {}),
                elapsedMs: Date.now() - followUpStartedAt,
              });
            }
          }
          return;
        } catch (error) {
          if (qaChatOrchestrator && qaChatPreparation) {
            try {
              qaChatOrchestrator.finishAbortedTurn(
                qaChatPreparation.sessionId,
                qaChatPreparation.turnId,
                controller.signal.aborted ? 'cancelled' : 'error',
                controller.signal.aborted ? getAssistantTurnPartialText(event, request.requestId) : undefined,
              );
            } catch {
              // 保留原始错误；记忆写入失败不影响错误展示。
            }
          }
          throw error;
        }
      }
      if (interactionRoute === 'clarify') {
        const answer = request.scope === 'current-note'
          ? '你是想让我基于当前笔记查找和回答，还是进行普通聊天？'
          : '你是想让我检索笔记库，还是进行普通聊天？';
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: answer });
        emitAssistantTurnEvent(event, {
          requestId: request.requestId,
          type: 'complete',
          result: {
            type: 'answer',
            answer,
            provider,
            model,
            sourceNotes: [],
            retrievalMode: 'none',
            interactionRoute: 'clarify',
            cacheUsage: { providerReported: false },
          },
        });
        return;
      }
      const toolEvents: CurrentNotePublicToolEvent[] = [];
      const executionStartedAt = Date.now();
      const onToolEvent: AssistantPublicToolEventListener = (toolEvent) => {
        toolEvents.push({ ...toolEvent });
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'tool', event: toolEvent });
      };
      const onPlanEvent = (planEvent: CurrentNotePublicPlanEvent) => {
        publicPlanEvents = [...publicPlanEvents, planEvent];
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'plan', event: planEvent });
      };
      const useLibraryPlanAgent = request.scope === 'library-search'
        && interactionRoute === 'react'
        && shouldUseLibraryPlanner(preferences.assistantPlanMode, true)
        && !(request.contextSources?.length)
        && !(request.attachments?.length)
        && Boolean(libraryPath && noteIndex);
      if (useLibraryPlanAgent && libraryPath && noteIndex) {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在使用整库的受控检索…' });
        const sessionId = createAssistantSessionId();
        const snapshotMap = createLibraryNoteSnapshotMap({
          libraryPath,
          index: noteIndex,
          sessionId,
          revision: snapshotRevision,
          indexState: 'latest',
        });
        const libraryResult = await runLibraryPlanAgent({
          snapshotMap,
          sessionId,
          question: rewrittenQuestion,
          conversation: request.conversation,
          providerKind: provider,
          model,
          contextWindowTokens,
          signal: controller.signal,
          modelCallGate,
          modelCallCoordinator,
          adaptiveContextMode: preferences.adaptiveContextMode,
          planner: createLibraryPlanDriver({
            generateJson: ({ prompt, signal, maxOutputTokens, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, callKind, onUsage }),
          }),
          driver: createLibraryStructuredActionDriver({
            generateJson: ({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage }),
          }),
          search: {
            keywordSearch: (query) => miniSearch
              ? createKeywordCandidates(searchNoteLexically(miniSearch, query), query, libraryPath)
              : [],
          },
          isSnapshotCurrent,
          onToolEvent,
          onPlanEvent,
          onDetailedTrace,
          sectionRankShadowMode: 'observe',
          sectionRankNavigationMode: 'observe',
        });
        throwIfAssistantCancelled(controller.signal);
        const sourceNotes = libraryResult.sourceNotes.flatMap((source) => {
          const record = snapshotMap.records.get(source.noteId);
          return record ? [{
            path: record.localSnapshot.notePath,
            title: source.title,
            snippet: source.snippet ?? '',
            score: source.score,
            methods: source.methods,
            sourceType: 'note' as const,
            ...(source.matchTrace?.length ? { matchTrace: source.matchTrace } : {}),
          }] : [];
        });
        const executionElapsedMs = Math.max(0, Date.now() - executionStartedAt);
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: libraryResult.answer });
        emitAssistantTurnEvent(event, {
          requestId: request.requestId,
          type: 'complete',
          result: {
            type: 'answer',
            answer: libraryResult.answer,
            provider,
            model,
            sourceNotes,
            retrievalMode: 'hybrid',
            interactionRoute: 'react',
            contextUsage: libraryResult.contextUsage,
            evidence: libraryResult.evidence,
            completeness: libraryResult.completeness,
            toolStats: libraryResult.toolStats,
            agentStats: libraryResult.agentStats,
            toolEvents,
            planEvents: publicPlanEvents,
            modelEvents: publicModelEvents,
            executionElapsedMs,
            prefixFingerprint: libraryResult.prefixFingerprint,
            cacheUsage: { providerReported: false },
            ...(!isSnapshotCurrent() ? { isStale: true } : {}),
          },
        });
        return;
      }
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: request.scope === 'current-note' ? '正在读取当前笔记…' : '正在检索相关笔记…' });
      const context = await resolveAssistantAnswerContext(
        libraryPath,
        request,
        controller.signal,
        assistantMineru,
        onToolEvent,
        onDetailedTrace,
        {
          retrievalQuery: rewrittenQuestion,
          allowKnowledgeSources: queryUnderstanding.intent !== 'doc_only',
        },
      );
      throwIfAssistantCancelled(controller.signal);
      const currentNoteSnapshot = context.currentNote && libraryPath
        ? createCurrentNoteSnapshotFromIndexedNote({ libraryPath, note: context.currentNote, revision: snapshotRevision })
        : undefined;
      const isResolvedContextCurrent = currentNoteSnapshot
        ? () => !controller.signal.aborted
          && getCurrentLibraryPath() === libraryPath
          && (libraryRevision === snapshotRevision
            || Boolean(noteIndex?.notes.some((note) => matchesCurrentNoteSnapshot(currentNoteSnapshot, note))))
        : isSnapshotCurrent;
      if (request.scope === 'current-note'
        && !(request.contextSources?.length)
        && !(request.attachments?.length)
        && (!currentNoteSnapshot || tokenizeCurrentNoteText(rewrittenQuestion).length === 0)) {
        const answer = '请补充一个可定位当前笔记内容的关键词或具体问题。';
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: answer });
        emitAssistantTurnEvent(event, {
          requestId: request.requestId,
          type: 'complete',
          result: {
            type: 'answer',
            answer,
            provider,
            model,
            sourceNotes: context.sourceNotes,
            retrievalMode: 'none',
            interactionRoute: 'clarify',
            cacheUsage: { providerReported: false },
          },
        });
        return;
      }
      const currentNoteSummaryMode = currentNoteSnapshot && !(request.contextSources?.length) && !(request.attachments?.length)
        ? classifyCurrentNoteSummaryIntent(request.userText)
        : undefined;
      const currentNotePrompt = currentNoteSnapshot && !currentNoteSummaryMode
        ? createCurrentNotePrompt({
          snapshot: currentNoteSnapshot,
          question: request.userText,
          conversation: request.conversation,
          providerKind: provider,
          model,
          contextWindowTokens,
          relatedSources: context.sources
            .filter((source) => source.path !== context.currentNote?.path)
            .map((source) => ({ title: source.title, content: source.content })),
          skillInstructions,
          answerDepth: request.answerDepth,
        })
        : undefined;
      if (currentNoteSummaryMode && currentNoteSnapshot) {
        emitAssistantTurnEvent(event, {
          requestId: request.requestId,
          type: 'status',
          message: currentNoteSummaryMode === 'summary-complete' ? '正在逐节生成完整总结…' : '正在生成快速概括…',
        });
        const memoryRepository = getAssistantMemoryRepository(libraryPath!);
        const memoryMode = getAssistantMemoryMode(memoryRepository);
        const currentNoteSummaryMemoryProjectionMode = resolveAssistantMemoryProjectionMode('current-note-react');
        let canonicalSummaryTurn: { sessionId: string; turnId: string } | undefined;
        if (memoryMode === 'persistent') {
          const sessionScope = resolvePersistentAssistantSessionScope(event, memoryRepository, currentNoteSnapshot, request.sessionId);
          const qaRepository = getQaMemoryOrchestrator().repository;
          qaRepository.ensureSession(sessionScope.sessionId, 'knowledge-base', { libraryPath: libraryPath! });
          const started = qaRepository.startTurn(sessionScope.sessionId, {
            turnId: request.requestId,
            userText: request.userText,
            scopeLabel,
            route: 'current-note-react',
            attachments: request.attachments,
          });
          canonicalSummaryTurn = { sessionId: sessionScope.sessionId, turnId: started.turnId };
        }
        try {
          const summaryResult = await runCurrentNoteSummary({
            snapshot: currentNoteSnapshot,
            question: request.userText,
            providerKind: provider,
            model,
            driver: createNoteSummaryDriver({
              generateJson: ({ prompt, signal, maxOutputTokens, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, callKind, onUsage }),
            }),
            digestRepository: getNoteDerivedDigestRepository(libraryPath!, memoryRepository),
            signal: controller.signal,
            isSnapshotCurrent: isResolvedContextCurrent,
            contextWindowTokens,
            summaryCheckpoint: request.summaryCheckpoint,
          }, currentNoteSummaryMode);
          const executionElapsedMs = Math.max(0, Date.now() - executionStartedAt);
          onDetailedTrace({
            stage: 'result',
            action: 'current-note-summary-result',
            status: 'completed',
            output: summaryResult,
            elapsedMs: executionElapsedMs,
          });
          throwIfAssistantCancelled(controller.signal);
          if (canonicalSummaryTurn) {
            if (isResolvedContextCurrent()) {
              const summaryArchiveScope = tryResolveConversationArchiveScope();
              getQaMemoryOrchestrator().repository.finalizeTurn(canonicalSummaryTurn.sessionId, canonicalSummaryTurn.turnId, {
                type: 'answer',
                answer: summaryResult.answer,
                provider,
                model,
                sourceNotes: context.sourceNotes,
                retrievalMode: 'none',
                interactionRoute: 'react',
                contextMode: summaryResult.contextMode,
                evidence: summaryResult.evidence,
                completeness: summaryResult.completeness,
                toolStats: summaryResult.toolStats,
                agentStats: summaryResult.agentStats,
                toolEvents,
                executionElapsedMs,
                prefixFingerprint: summaryResult.prefixFingerprint,
                summaryCoverage: { mode: summaryResult.mode, ...summaryResult.coverage },
                ...(summaryResult.checkpoint ? { summaryCheckpoint: summaryResult.checkpoint } : {}),
                cacheUsage: { providerReported: false },
              }, {
                route: 'current-note-react',
                ...(summaryArchiveScope ? { archiveScope: summaryArchiveScope } : {}),
              });
            } else {
              getQaMemoryOrchestrator().finishAbortedTurn(canonicalSummaryTurn.sessionId, canonicalSummaryTurn.turnId, 'error');
            }
          }
          if (isResolvedContextCurrent()) {
            completeTurnPostProcess({
              onMemorySave: (receipt) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'memory-saved', receipt }),
              userText: request.userText,
              sessionId: canonicalSummaryTurn?.sessionId ?? request.sessionId ?? null,
              messageId: canonicalSummaryTurn?.turnId ?? request.requestId,
              modelHint: { profileId: selectedProfile.id, modelId: model, contextWindowTokens },
              memoryProjectionMode: currentNoteSummaryMemoryProjectionMode,
            });
          }
          emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: summaryResult.answer });
          emitAssistantTurnEvent(event, {
            requestId: request.requestId,
            type: 'complete',
            result: {
              type: 'answer',
              answer: summaryResult.answer,
              provider,
              model,
              sourceNotes: context.sourceNotes,
              retrievalMode: 'none',
              interactionRoute: 'react',
              contextUsage: summaryResult.contextUsage,
              contextMode: summaryResult.contextMode,
              evidence: summaryResult.evidence,
              completeness: summaryResult.completeness,
              toolStats: summaryResult.toolStats,
              agentStats: summaryResult.agentStats,
              toolEvents,
              executionElapsedMs,
              prefixFingerprint: summaryResult.prefixFingerprint,
              summaryCoverage: { mode: summaryResult.mode, ...summaryResult.coverage },
              ...(summaryResult.checkpoint ? { summaryCheckpoint: summaryResult.checkpoint } : {}),
              cacheUsage: { providerReported: false },
              ...(!isResolvedContextCurrent() ? { isStale: true } : {}),
            },
          });
          return;
        } catch (error) {
          if (canonicalSummaryTurn) {
            try {
              getQaMemoryOrchestrator().finishAbortedTurn(
                canonicalSummaryTurn.sessionId,
                canonicalSummaryTurn.turnId,
                controller.signal.aborted ? 'cancelled' : 'error',
                controller.signal.aborted ? getAssistantTurnPartialText(event, request.requestId) : undefined,
              );
            } catch {
              // The original generation error remains authoritative.
            }
          }
          throw error;
        }
      }
      const useCurrentNoteAgent = Boolean(
        currentNoteSnapshot
        && currentNotePrompt?.contextMode === 'react-search'
        && !(request.contextSources?.length)
        && !(request.attachments?.length),
      );
      const useCurrentNotePlanner = shouldUseCurrentNotePlanner({
        planMode: preferences.assistantPlanMode,
        interactionRoute,
        contextMode: currentNotePrompt?.contextMode,
        hasExternalContext: Boolean(request.contextSources?.length || request.attachments?.length),
      });
      if (useCurrentNoteAgent && currentNoteSnapshot) {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在使用当前笔记的受控检索…' });
        const memoryRepository = getAssistantMemoryRepository(libraryPath!);
        const memoryMode = getAssistantMemoryMode(memoryRepository);
        const currentNoteMemoryProjectionMode = resolveAssistantMemoryProjectionMode('current-note-react');
        const useCanonicalCurrentNoteMemory = isCanonicalMemoryProjection(currentNoteMemoryProjectionMode);
        let sessionId = request.sessionId ?? createAssistantSessionId();
        let sessionScope: AssistantSessionScope | undefined;
        let canonicalCurrentNoteTurn: { sessionId: string; turnId: string } | undefined;
        let conversation = memoryMode === 'disabled' ? [] : selectQaRecentCompleteConversation(request.conversation);
        const conversationMemory = memoryMode === 'disabled' ? new NoteConversationMemory() : currentNoteConversationMemory;
        if (memoryMode === 'persistent') {
          sessionScope = resolvePersistentAssistantSessionScope(event, memoryRepository, currentNoteSnapshot, request.sessionId);
          sessionId = sessionScope.sessionId;
        }
        const memoryScopeKey = `${event.sender.id}:${currentNoteSnapshot.libraryId}:${currentNoteSnapshot.relativePath}:${sessionId}:${currentNoteSnapshot.contentHash}`;
        if (memoryMode === 'persistent' && sessionScope) {
          const qaOrchestrator = getQaMemoryOrchestrator();
          qaOrchestrator.repository.ensureSession(sessionId, 'knowledge-base', { libraryPath: libraryPath! });
          // observe/legacy 保留投影开关；新旧投影的原始对话均读取仍在写入的统一库。
          conversation = projectQaRecentTurnsToConversation(qaOrchestrator.repository.loadRecentCompleteTurns(sessionId));
          const canonicalStarted = qaOrchestrator.repository.startTurn(sessionId, {
            turnId: request.requestId,
            userText: request.userText,
            scopeLabel,
            route: 'current-note-react',
            attachments: request.attachments,
          });
          canonicalCurrentNoteTurn = { sessionId, turnId: canonicalStarted.turnId };
        }
        const onPlanState = (plan: SearchPlan, evidence: AssistantMemoryTurnFinalize['evidence'], persistence?: AssistantSearchPlanPersistenceState) => {
          void plan;
          void persistence;
          // WK-M9 keeps legacy current-note tables read-only. Canonical agent
          // messages and the final result are stored with the unified turn.
          void evidence;
        };
        let agentResult: Awaited<ReturnType<typeof runCurrentNoteAgent>>;
        let executionElapsedMs = 0;
        const currentNoteLongTermMemoryContext = await recallLongTermMemory(request.userText);
        const currentNoteLongTermMemoryMaterial = currentNoteLongTermMemoryContext.scope
          ? createLongTermMemoryContextMaterial({
            workspaceId: currentNoteLongTermMemoryContext.scope.workspaceId,
            principalId: currentNoteLongTermMemoryContext.scope.principalId,
            prompt: currentNoteLongTermMemoryContext.recall.prompt,
          })
          : undefined;
        const currentNoteConversationSearchRuntime = memoryMode === 'persistent'
          && useCanonicalCurrentNoteMemory ? resolveConversationSearchRuntime(sessionId)
          : undefined;
        recordMemoryCutoverObservation({
          route: 'current-note-react',
          mode: currentNoteMemoryProjectionMode,
          sessionId,
          canonicalContext: createMemoryCutoverContext(currentNoteLongTermMemoryMaterial ? [currentNoteLongTermMemoryMaterial] : []),
          legacyHistory: useCanonicalCurrentNoteMemory ? [] : conversation,
          canonicalHistory: useCanonicalCurrentNoteMemory ? conversation : projectQaRecentTurnsToConversation(
            getQaMemoryOrchestrator().repository.loadRecentCompleteTurns(sessionId),
          ),
          recallItemIds: currentNoteLongTermMemoryContext.recall.usedItems.map(({ item }) => item.id),
        });
        try {
          agentResult = await runCurrentNoteAgent({
            snapshot: currentNoteSnapshot,
            question: rewrittenQuestion,
            conversation,
            providerKind: provider,
            model,
            answerDepth: request.answerDepth,
            contextWindowTokens,
            contextWindow: effectiveContextWindow,
            skillInstructions,
            signal: controller.signal,
            modelCallGate,
            modelCallCoordinator,
            adaptiveContextMode: preferences.adaptiveContextMode,
            assistantContextRuntimeMode: resolveAssistantContextRuntimeMode(
              'current-note-react',
              process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_REACT_MODE
                ?? process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_MODE,
            ),
            ...(useCanonicalCurrentNoteMemory && currentNoteLongTermMemoryMaterial ? { longTermMemoryMaterial: currentNoteLongTermMemoryMaterial } : {}),
            ...(currentNoteConversationSearchRuntime ? { conversationSearch: currentNoteConversationSearchRuntime } : {}),
            driver: createStructuredActionDriver({
              generateJson: ({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage, onRawResponse }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage, onRawResponse }),
            }),
            ...(useCurrentNotePlanner ? {
              planMode: preferences.assistantPlanMode,
              planner: createCurrentNotePlanDriver({
                generateJson: ({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, jsonSchema, callKind, onUsage }),
              }),
            } : {}),
            memory: conversationMemory,
            memoryScopeKey,
            isSnapshotCurrent: isResolvedContextCurrent,
            onToolEvent,
            onPlanEvent,
            onPlanState,
            onDetailedTrace,
            toolCallsAlreadyUsed: toolEvents.filter((toolEvent) => toolEvent.state !== 'started').length,
          });
          executionElapsedMs = Math.max(0, Date.now() - executionStartedAt);
          throwIfAssistantCancelled(controller.signal);
          if (canonicalCurrentNoteTurn) {
            if (isResolvedContextCurrent()) {
              getQaMemoryOrchestrator().repository.finalizeTurn(
                  canonicalCurrentNoteTurn.sessionId,
                  canonicalCurrentNoteTurn.turnId,
                  {
                    type: 'answer',
                    answer: agentResult.answer,
                    provider,
                    model,
                    sourceNotes: context.sourceNotes,
                    retrievalMode: agentResult.route === 'clarify' ? 'none' : 'keyword',
                    interactionRoute: agentResult.route === 'clarify' ? 'clarify' : 'react',
                    completeness: agentResult.completeness,
                  },
                  {
                    route: 'current-note-react',
                    agentMessages: agentResult.agentMessages,
                    ...(currentNoteLongTermMemoryContext.scope ? { archiveScope: currentNoteLongTermMemoryContext.scope } : {}),
                  },
                );
            } else {
              getQaMemoryOrchestrator().finishAbortedTurn(canonicalCurrentNoteTurn.sessionId, canonicalCurrentNoteTurn.turnId, 'error');
            }
          }
          if (isResolvedContextCurrent()) {
            completeTurnPostProcess({
              onMemorySave: (receipt) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'memory-saved', receipt }),
              userText: request.userText,
              sessionId: canonicalCurrentNoteTurn?.sessionId ?? request.sessionId ?? null,
              messageId: canonicalCurrentNoteTurn?.turnId ?? request.requestId,
              modelHint: { profileId: selectedProfile.id, modelId: model, contextWindowTokens },
              usedMemories: useCanonicalCurrentNoteMemory ? currentNoteLongTermMemoryContext.recall.usedItems : [],
              memoryScope: currentNoteLongTermMemoryContext.scope,
              onUsedMemories: (items) => emitAssistantTurnEvent(event, {
                requestId: request.requestId,
                type: 'memory-used',
                  items,
              }),
              memoryProjectionMode: currentNoteMemoryProjectionMode,
            });
          }
        } catch (error) {
          if (canonicalCurrentNoteTurn) {
            try {
              getQaMemoryOrchestrator().finishAbortedTurn(
                canonicalCurrentNoteTurn.sessionId,
                canonicalCurrentNoteTurn.turnId,
                controller.signal.aborted ? 'cancelled' : 'error',
                controller.signal.aborted ? getAssistantTurnPartialText(event, request.requestId) : undefined,
              );
            } catch {
              // 保留原始错误；规范轮次表由启动恢复逻辑清理残留 pending。
            }
          }
          throw error;
        }
        const shadowPlan = shouldRunShadowPlanner(preferences.assistantPlanMode)
          ? await runShadowPlan({
            question: rewrittenQuestion,
            conversation,
            providerKind: provider,
            model,
            coordinator: modelCallCoordinator,
            signal: controller.signal,
            isSnapshotCurrent: isResolvedContextCurrent,
            legacyScope: agentResult.searchScope ?? createFallbackCurrentNoteSearchScope(rewrittenQuestion),
            sourceSummaries: context.sourceNotes.map((source) => `${source.title}：${source.snippet}`),
            generateJson: ({ prompt, signal, maxOutputTokens, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, callKind, onUsage }),
          })
          : undefined;
        onDetailedTrace({
          stage: 'result',
          action: 'current-note-agent-result',
          status: 'completed',
          output: agentResult,
          elapsedMs: executionElapsedMs,
          metadata: { traceFile: detailedTrace?.filePath },
        });
        if (agentResult.contextDiagnostics) {
          emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: agentResult.contextDiagnostics });
        }
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: agentResult.answer });
        emitAssistantTurnEvent(event, {
          requestId: request.requestId,
          type: 'complete',
          result: {
            type: 'answer',
            answer: agentResult.answer,
            provider,
            model,
            sourceNotes: context.sourceNotes,
            retrievalMode: agentResult.route === 'clarify' ? 'none' : 'keyword',
            interactionRoute: agentResult.route === 'clarify' ? 'clarify' : 'react',
            contextUsage: agentResult.contextUsage,
            contextMode: agentResult.contextMode,
            evidence: agentResult.evidence,
            completeness: agentResult.completeness,
            toolStats: agentResult.toolStats,
            agentStats: agentResult.agentStats,
            toolEvents,
            planEvents: publicPlanEvents,
            modelEvents: publicModelEvents,
            executionElapsedMs,
            prefixFingerprint: agentResult.prefixFingerprint,
            ...(agentResult.contextDiagnostics ? { contextDiagnostics: agentResult.contextDiagnostics } : {}),
            ...(useCurrentNotePlanner && agentResult.searchScope && agentResult.coverage ? {
              searchScope: toPublicCurrentNoteSearchScope(agentResult.searchScope),
              searchCoverage: toPublicCurrentNoteSearchCoverage(agentResult.coverage),
            } : {}),
            ...(shadowPlan ? { shadowPlan } : {}),
            cacheUsage: { providerReported: false },
            ...(!isResolvedContextCurrent() ? { isStale: true } : {}),
          },
        });
        return;
      }
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在生成回答…' });
      let generationConversation = selectQaRecentCompleteConversation(request.conversation);
      const currentNoteDirectMemoryProjectionMode = request.scope === 'current-note'
        ? resolveAssistantMemoryProjectionMode('current-note-direct')
        : request.scope === 'chat' ? resolveAssistantMemoryProjectionMode('chat') : 'canonical';
      const directTurnRoute = request.scope === 'chat' ? 'chat' as const : 'current-note-direct' as const;
      const useCanonicalCurrentNoteDirectMemory = isCanonicalMemoryProjection(currentNoteDirectMemoryProjectionMode);
      const currentNoteDirectLongTermMemoryContext = request.scope === 'current-note' || request.scope === 'chat'
        ? await recallLongTermMemory(request.userText)
        : undefined;
      const currentNoteDirectMemoryPrompt = useCanonicalCurrentNoteDirectMemory
        ? currentNoteDirectLongTermMemoryContext?.recall.prompt
        : undefined;
      const currentNoteDirectMemoryMaterial = useCanonicalCurrentNoteDirectMemory && currentNoteDirectLongTermMemoryContext?.scope
        ? createLongTermMemoryContextMaterial({
          workspaceId: currentNoteDirectLongTermMemoryContext.scope.workspaceId,
          principalId: currentNoteDirectLongTermMemoryContext.scope.principalId,
          prompt: currentNoteDirectLongTermMemoryContext.recall.prompt,
        })
        : undefined;
      const directRelatedSources = context.sources
        .filter((source) => source.path !== context.currentNote?.path)
        .map((source) => ({ title: source.title, content: source.content }));
      let generationPrompt = currentNoteSnapshot && currentNotePrompt
        ? createCurrentNotePrompt({
          snapshot: currentNoteSnapshot,
          question: request.userText,
          conversation: generationConversation,
          providerKind: provider,
          model,
          contextWindowTokens,
          relatedSources: directRelatedSources,
          skillInstructions,
          answerDepth: request.answerDepth,
          ...(currentNoteDirectMemoryPrompt ? { longTermMemoryPrompt: currentNoteDirectMemoryPrompt } : {}),
        })
        : currentNotePrompt;
      let canonicalDirectTurn: { sessionId: string; turnId: string } | undefined;
      if (request.scope === 'chat') {
        // 文档附件走证据回答分支，仍属于原开放式会话，必须保存用户原文和附件描述。
        const preparation = await getQaMemoryOrchestrator().prepareTurn({
          sessionId: request.sessionId,
          scope: 'chat',
          turnId: request.requestId,
          userText: request.userText,
          scopeLabel,
          route: 'chat',
          attachments: request.attachments,
          contextWindowTokens,
          projectContext: createAssistantProjectContext('chat', skillInstructions, request.answerDepth, resolvedSkillDefinitions),
          residualMemoryMode: resolveQaContextRuntimeMode('chat'),
          memoryProjectionMode: currentNoteDirectMemoryProjectionMode,
        });
        canonicalDirectTurn = { sessionId: preparation.sessionId, turnId: preparation.turnId };
        generationConversation = projectQaRecentTurnsToConversation(preparation.recentCompleteTurns);
      }
      if (currentNoteSnapshot && currentNotePrompt && !(request.contextSources?.length) && !(request.attachments?.length)) {
        const memoryRepository = getAssistantMemoryRepository(libraryPath!);
        const memoryMode = getAssistantMemoryMode(memoryRepository);
        if (memoryMode !== 'persistent') {
          if (memoryMode === 'disabled') generationConversation = [];
          generationPrompt = createCurrentNotePrompt({
            snapshot: currentNoteSnapshot,
            question: request.userText,
            conversation: generationConversation,
            providerKind: provider,
            model,
            contextWindowTokens,
            relatedSources: directRelatedSources,
            skillInstructions,
            answerDepth: request.answerDepth,
            ...(currentNoteDirectMemoryPrompt ? { longTermMemoryPrompt: currentNoteDirectMemoryPrompt } : {}),
          });
        }
        if (memoryMode === 'persistent') {
          const sessionScope = resolvePersistentAssistantSessionScope(event, memoryRepository, currentNoteSnapshot, request.sessionId);
          // 旧库已经停止写 turn；任何投影模式都从统一库读取最近完整问答。
          generationConversation = projectQaRecentTurnsToConversation(
            getQaMemoryOrchestrator().repository.loadRecentCompleteTurns(sessionScope.sessionId),
          );
          generationPrompt = createCurrentNotePrompt({
            snapshot: currentNoteSnapshot,
            question: request.userText,
            conversation: generationConversation,
            providerKind: provider,
            model,
            contextWindowTokens,
            relatedSources: directRelatedSources,
            skillInstructions,
            answerDepth: request.answerDepth,
            ...(currentNoteDirectMemoryPrompt ? { longTermMemoryPrompt: currentNoteDirectMemoryPrompt } : {}),
          });
          const qaOrchestrator = getQaMemoryOrchestrator();
          qaOrchestrator.repository.ensureSession(sessionScope.sessionId, 'knowledge-base', { libraryPath: libraryPath! });
          const canonicalStarted = qaOrchestrator.repository.startTurn(sessionScope.sessionId, {
            turnId: request.requestId,
            userText: request.userText,
            scopeLabel,
            route: 'current-note-direct',
            attachments: request.attachments,
          });
          canonicalDirectTurn = { sessionId: sessionScope.sessionId, turnId: canonicalStarted.turnId };
        }
      }
      if (request.scope === 'current-note' && currentNoteSnapshot && libraryPath && !canonicalDirectTurn) {
        const memoryRepository = getAssistantMemoryRepository(libraryPath);
        if (getAssistantMemoryMode(memoryRepository) === 'persistent') {
          const sessionScope = resolvePersistentAssistantSessionScope(event, memoryRepository, currentNoteSnapshot, request.sessionId);
          const qaOrchestrator = getQaMemoryOrchestrator();
          qaOrchestrator.repository.ensureSession(sessionScope.sessionId, 'knowledge-base', { libraryPath });
          generationConversation = projectQaRecentTurnsToConversation(
            qaOrchestrator.repository.loadRecentCompleteTurns(sessionScope.sessionId),
          );
          generationPrompt = currentNotePrompt
            ? createCurrentNotePrompt({
              snapshot: currentNoteSnapshot,
              question: request.userText,
              conversation: generationConversation,
              providerKind: provider,
              model,
              contextWindowTokens,
              relatedSources: directRelatedSources,
              skillInstructions,
              answerDepth: request.answerDepth,
              ...(currentNoteDirectMemoryPrompt ? { longTermMemoryPrompt: currentNoteDirectMemoryPrompt } : {}),
            })
            : currentNotePrompt;
          const canonicalStarted = qaOrchestrator.repository.startTurn(sessionScope.sessionId, {
            turnId: request.requestId,
            userText: request.userText,
            scopeLabel,
            route: 'current-note-direct',
            attachments: request.attachments,
          });
          canonicalDirectTurn = { sessionId: sessionScope.sessionId, turnId: canonicalStarted.turnId };
        }
      }
      let generation: Awaited<ReturnType<typeof streamKnowledgeAnswer>>;
      let directResult: Extract<AssistantTurnResult, { type: 'answer' }>;
      let directContextDiagnostics: ContextProjectionDiagnostics | undefined;
      let executionElapsedMs = 0;
      if (request.scope === 'current-note' && currentNoteSnapshot) {
        const canonicalHistory = canonicalDirectTurn
          ? projectQaRecentTurnsToConversation(getQaMemoryOrchestrator().repository.loadRecentCompleteTurns(canonicalDirectTurn.sessionId))
          : [];
        recordMemoryCutoverObservation({
          route: 'current-note-direct',
          mode: currentNoteDirectMemoryProjectionMode,
          sessionId: canonicalDirectTurn?.sessionId ?? request.sessionId ?? request.requestId,
          canonicalContext: createMemoryCutoverContext(currentNoteDirectMemoryMaterial ? [currentNoteDirectMemoryMaterial] : []),
          legacyHistory: useCanonicalCurrentNoteDirectMemory ? [] : generationConversation,
          canonicalHistory,
          recallItemIds: currentNoteDirectLongTermMemoryContext?.recall.usedItems.map(({ item }) => item.id) ?? [],
        });
      }
      try {
        const answerImages = [...turnImages, ...context.images];
        const directPromptAssembly = generationPrompt ? undefined : createKnowledgeAnswerPromptMessages(
          request.userText,
          generationConversation,
          context.sources.map((source) => ({ title: source.title, content: source.content })),
          skillInstructions,
          request.answerDepth,
          currentNoteDirectMemoryPrompt,
        );
        const directPrompt = generationPrompt?.prompt ?? directPromptAssembly!.prompt;
        const preparedDirectCall = modelCallCoordinator.prepare({
          callKind: 'direct',
          prompt: directPrompt,
          ...(directPromptAssembly ? {
            serializedBudgetText: serializeContextRoleMessagesForBudget(directPromptAssembly.systemPrompt, directPromptAssembly.userPrompt, []),
            requestEnvelopeVersion: CONTEXT_REQUEST_ENVELOPE_VERSION,
          } : {}),
        });
        if (!preparedDirectCall.ready) throw new ModelCallPreparationError(preparedDirectCall.reason);
        const directContextRuntimeMode = request.scope === 'current-note'
          ? resolveAssistantContextRuntimeMode(
            'current-note-direct',
            process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_DIRECT_MODE
              ?? process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CURRENT_NOTE_MODE,
          )
          : resolveQaContextRuntimeMode(context.sources.length ? 'knowledge-base' : 'chat');
        generation = await streamKnowledgeAnswer({
          question: request.userText,
          conversation: generationConversation,
          sources: context.sources.map((source) => ({ title: source.title, content: source.content })),
          prompt: directPrompt,
          ...(directPromptAssembly ? { systemPrompt: directPromptAssembly.systemPrompt, userPrompt: directPromptAssembly.userPrompt } : {}),
          temperature: resolveAssistantAnswerTemperature({ grounded: true, skills: selectedSkills }),
          model,
          signal: controller.signal,
          providerConfig: selectedProfile.config,
          thinkingMode: request.thinkingMode,
          ...(answerImages.length ? { images: answerImages } : {}),
          answerDepth: request.answerDepth,
          contextWindowTokens,
          contextWindow: effectiveContextWindow,
          skillInstructions,
          preparedModelCall: preparedDirectCall.call,
          modelCallKind: 'direct',
          assistantContextRuntimeMode: directContextRuntimeMode,
          contextRuntimeRoute: request.scope === 'current-note' ? 'current-note' : context.sources.length ? 'knowledge-base' : 'chat',
          contextRuntimeScope: {
            workspaceId: getConfiguredWorkspacePath(),
            ...(libraryPath ? { libraryId: libraryPath } : {}),
            ...(request.currentNotePath ? { noteId: request.currentNotePath } : {}),
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            turnId: request.requestId,
          },
          onContextRuntimeObservation: (report) => {
            directContextDiagnostics = report.diagnostics;
            emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: report.diagnostics });
            recordQaContextRuntimeObservation(onDetailedTrace, report);
          },
          onDelta: (text) => {
            if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text });
          },
          onThinkingDelta: (text) => {
            if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'thinking-delta', text });
          },
        });
        executionElapsedMs = Math.max(0, Date.now() - executionStartedAt);
        throwIfAssistantCancelled(controller.signal);
        directResult = {
          type: 'answer',
          answer: generation.answer,
          provider,
          model,
          sourceNotes: context.sourceNotes,
          retrievalMode: context.retrievalMode,
          interactionRoute: 'react',
          contextUsage: generation.contextUsage,
          toolEvents,
          executionElapsedMs,
          ...(request.scope === 'chat' && canonicalDirectTurn ? { qaSessionId: canonicalDirectTurn.sessionId } : {}),
          ...(generation.thinkingText ? { thinkingText: generation.thinkingText, thinkingElapsedMs: generation.thinkingElapsedMs } : {}),
          ...(generationPrompt ? {
            contextMode: generationPrompt.contextMode,
            prefixFingerprint: generationPrompt.prefixFingerprint,
            cacheUsage: {
              providerReported: generation.contextUsage.source === 'provider' && generation.contextUsage.cachedInputTokens !== undefined,
              ...(generation.contextUsage.cachedInputTokens !== undefined ? { cachedInputTokens: generation.contextUsage.cachedInputTokens } : {}),
            },
          } : {}),
          ...(directContextDiagnostics ? { contextDiagnostics: directContextDiagnostics } : {}),
          ...(context.retrievalWarning ? { retrievalWarning: context.retrievalWarning } : {}),
          ...(!isResolvedContextCurrent() ? { isStale: true } : {}),
        };
        if (canonicalDirectTurn) {
          if (isResolvedContextCurrent()) {
            const archiveScope = tryResolveConversationArchiveScope();
            getQaMemoryOrchestrator().repository.finalizeTurn(
              canonicalDirectTurn.sessionId,
              canonicalDirectTurn.turnId,
              directResult,
              {
                route: directTurnRoute,
                ...(archiveScope ? { archiveScope } : {}),
              },
            );
          } else {
            getQaMemoryOrchestrator().finishAbortedTurn(canonicalDirectTurn.sessionId, canonicalDirectTurn.turnId, 'error');
          }
        }
        if (isResolvedContextCurrent()) {
          completeTurnPostProcess({
            onMemorySave: (receipt) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'memory-saved', receipt }),
            userText: request.userText,
            sessionId: canonicalDirectTurn?.sessionId ?? request.sessionId ?? null,
            messageId: canonicalDirectTurn?.turnId ?? request.requestId,
            modelHint: { profileId: selectedProfile.id, modelId: model, contextWindowTokens },
            usedMemories: useCanonicalCurrentNoteDirectMemory
              ? currentNoteDirectLongTermMemoryContext?.recall.usedItems
              : [],
            memoryScope: currentNoteDirectLongTermMemoryContext?.scope,
            onUsedMemories: (items) => emitAssistantTurnEvent(event, {
              requestId: request.requestId,
              type: 'memory-used',
              items,
            }),
            memoryProjectionMode: currentNoteDirectMemoryProjectionMode,
          });
        }
      } catch (error) {
        if (canonicalDirectTurn) {
          try {
            getQaMemoryOrchestrator().finishAbortedTurn(
              canonicalDirectTurn.sessionId,
              canonicalDirectTurn.turnId,
              controller.signal.aborted ? 'cancelled' : 'error',
              controller.signal.aborted ? getAssistantTurnPartialText(event, request.requestId) : undefined,
            );
          } catch {
            // 保留原始错误；规范轮次表由启动恢复逻辑清理残留 pending。
          }
        }
        throw error;
      }
      const shadowPlan = shouldRunShadowPlanner(preferences.assistantPlanMode)
        ? await runShadowPlan({
          question: rewrittenQuestion,
          conversation: generationConversation,
          providerKind: provider,
          model,
          coordinator: modelCallCoordinator,
          signal: controller.signal,
          isSnapshotCurrent: isResolvedContextCurrent,
          legacyScope: createFallbackCurrentNoteSearchScope(rewrittenQuestion),
          sourceSummaries: context.sourceNotes.map((source) => `${source.title}：${source.snippet}`),
          generateJson: ({ prompt, signal, maxOutputTokens, callKind, onUsage }) => generateJsonWithTrace({ prompt, signal, maxOutputTokens, callKind, onUsage }),
        })
        : undefined;
      emitAssistantTurnEvent(event, {
        requestId: request.requestId,
        type: 'complete',
        result: {
          ...directResult,
          ...(shadowPlan ? { shadowPlan } : {}),
          ...(!isResolvedContextCurrent() ? { isStale: true } : {}),
        },
      });
      return;
    }

    if (request.intent === 'learning-plan') {
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在检索学习资料…' });
      const context = await resolveAssistantAnswerContext(libraryPath, request, controller.signal, assistantMineru, (toolEvent) => {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'tool', event: toolEvent });
      }, onDetailedTrace);
      throwIfAssistantCancelled(controller.signal);
      const sources = context.sources.map((source) => ({ title: source.title, content: source.content }));
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在生成学习路径…' });
      const result = await runLocalKnowledgeAgent({ type: 'plan', goal: request.userText, model, sources }, { signal: controller.signal, providerConfig: selectedProfile.config, skillInstructions, modelCallCoordinator });
      throwIfAssistantCancelled(controller.signal);
      if (result.type !== 'plan') throw new Error('学习路径 Agent 返回了无法识别的结果。');
      if (!isSnapshotCurrent()) throw new Error('知识库内容已更新，请重新生成学习路径。');
      const plan = saveLearningPlan(libraryPath, { goal: request.userText, provider, model, steps: result.steps });
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'complete', result: { type: 'learning-plan', plan } });
      return;
    }

    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在分析笔记库结构…' });
    const notes = noteIndex.notes.map((note) => ({
      title: note.title,
      tags: note.tags,
      headings: note.headings.map((heading) => heading.text),
    }));
    const result = await runLocalKnowledgeAgent({ type: 'organize', model, notes }, { signal: controller.signal, providerConfig: selectedProfile.config, skillInstructions, modelCallCoordinator });
    throwIfAssistantCancelled(controller.signal);
    if (result.type !== 'organize') throw new Error('整理建议 Agent 返回了无法识别的结果。');
    if (!isSnapshotCurrent()) throw new Error('知识库内容已更新，请重新生成整理建议。');
    const suggestion = saveOrganizationSuggestion(libraryPath, { provider, model, groups: result.groups, nextActions: result.nextActions });
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'complete', result: { type: 'organize', suggestion } });
  } catch (error) {
    onDetailedTrace({
      stage: 'turn',
      action: 'assistant-turn',
      status: 'rejected',
      errorCode: controller.signal.aborted ? 'cancelled' : 'turn-error',
      error: toDetailedTraceError(error),
    });
    if (publicPlanEvents.length) {
      const latest = publicPlanEvents.at(-1)!;
      emitAssistantTurnEvent(event, {
        requestId: request.requestId,
        type: 'plan',
        event: { ...latest, phase: 'finished', status: controller.signal.aborted ? 'cancelled' : 'failed' },
      });
    }
    if (controller.signal.aborted) {
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'cancelled' });
      return;
    }
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'error', message: getErrorMessage(error) || 'AI 助手未能完成本次请求。' });
  } finally {
    await detailedTrace?.flush();
  }
}

async function runDedicatedKnowledgeBaseRagTurn(input: {
  event: IpcMainInvokeEvent;
  request: AssistantTurnRequest;
  controller: AbortController;
  source: { libraryPath: string; label?: string };
  model: string;
  provider: AiProviderKind;
  providerConfig: AiProviderConfig;
  contextWindowTokens: number;
  effectiveContextWindow: EffectiveContextWindow;
  skillInstructions: string[];
  modelCallCoordinator: ModelCallCoordinator;
  onDetailedTrace: AssistantDetailedTraceSink;
  qaContextMemory?: ContextMemoryResult;
  qaMemoryZoneTokens?: Pick<QaMemoryZoneTokens, 'rollingSummary' | 'shortTerm'>;
  qaRecentTurns?: QaRecentTurn[];
  qaResidualMemoryObservation?: QaResidualMemoryObservationInput;
  qaSessionId?: string;
  qaMemoryOrchestrator: QaMemoryOrchestrator;
  knowledgeContextRuntimeMode: AssistantContextRuntimeMode;
  retrievalConditioning?: string;
  documentAffinityFactors?: (documentIds: readonly string[]) => ReadonlyMap<string, number>;
}): Promise<AssistantTurnResult> {
  const { event, request, controller, source } = input;
  const toolEvents: CurrentNotePublicToolEvent[] = [];
  const executionStartedAt = Date.now();
  const sourceLabel = source.label?.trim() || '个人知识库';
  const onToolEvent: AssistantPublicToolEventListener = (toolEvent) => {
    toolEvents.push({ ...toolEvent });
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'tool', event: toolEvent });
  };

  const rerankRuntime = resolveRerankRuntime(store);

  // 问题改写（设计 §3–§7）：改写门判定 → LLM 改写；失败回退原文继续（方案 B）。
  const rewriteGate = shouldRewriteQuestion({
    userText: request.userText,
    hasHistory: (input.qaRecentTurns ?? []).length > 0,
  });
  let queryRewrite: QaQueryRewriteRecord;
  let retrievalQueries: string[] = [request.userText];
  let rewriteWarning: string | undefined;
  if (!rewriteGate.rewriting) {
    queryRewrite = { skipped: true, reason: rewriteGate.reason, elapsedMs: 0 };
    input.onDetailedTrace({
      stage: 'rewrite',
      action: 'query-rewrite-gate',
      status: 'completed',
      elapsedMs: 0,
      output: { skipped: true, reason: rewriteGate.reason },
    });
    onToolEvent({ tool: 'rewrite_question', state: 'completed', message: `改写门排除（${rewriteGate.reason ?? 'self-contained'}），检索使用原文。` });
  } else {
    const rewriteStartedAt = Date.now();
    input.onDetailedTrace({
      stage: 'rewrite',
      action: 'query-rewrite',
      status: 'started',
      input: {
        originalQuestion: request.userText,
        historyTurnCount: (input.qaRecentTurns ?? []).length,
        gate: { rewriting: true, matchedSignals: rewriteGate.matchedSignals },
        startedAt: new Date(rewriteStartedAt).toISOString(),
      },
    });
    onToolEvent({ tool: 'rewrite_question', state: 'started', message: '正在结合历史上下文改写问题…' });
    try {
      const rewriteHistory = selectRewriteHistoryTurns(input.qaRecentTurns ?? []);
      const rewritePrompt = buildQueryRewritePrompt({
        question: request.userText,
        history: rewriteHistory,
        ...(input.retrievalConditioning ? { askerBackground: input.retrievalConditioning } : {}),
      });
      const preparedRewriteCall = input.modelCallCoordinator.prepare({ callKind: 'query-rewrite', prompt: rewritePrompt });
      if (!preparedRewriteCall.ready) throw new ModelCallPreparationError(preparedRewriteCall.reason);
      const rewritten = await rewriteKnowledgeQuestion({
        question: request.userText,
        history: rewriteHistory,
        ...(input.retrievalConditioning ? { askerBackground: input.retrievalConditioning } : {}),
        model: input.model,
        providerConfig: input.providerConfig,
        contextWindowTokens: input.contextWindowTokens,
        signal: controller.signal,
        ...(input.knowledgeContextRuntimeMode !== 'off' ? {
          onProviderCallObserved: (event: QueryRewriteProviderCallObservationEvent) => {
            input.onDetailedTrace({
              stage: 'context-runtime',
              action: 'dynamic-memory-s0-provider-call',
              status: event.responseCompleted ? 'completed' : 'rejected',
              callKind: 'query-rewrite',
              output: observeDynamicMemoryS0Call({
                route: 'knowledge-base-direct',
                callKind: 'query-rewrite',
                messages: [{ role: 'user', content: event.request.prompt }],
                structuredOutputSchema: event.request.structuredOutputSchema,
                providerFields: {
                  model: event.request.model,
                  maxOutputTokens: event.request.maxOutputTokens,
                },
                contextWindowTokens: event.request.contextWindowTokens ?? input.contextWindowTokens,
                outputReserveTokens: event.request.maxOutputTokens,
                memoryTexts: rewriteHistory.flatMap((turn) => [turn.userText, turn.answerHead]),
                coverage: input.qaResidualMemoryObservation,
                usage: event.usage,
                responseCompleted: event.responseCompleted,
              }),
            });
          },
        } : {}),
      });
      queryRewrite = {
        skipped: false,
        matchedSignals: rewriteGate.matchedSignals,
        rewrite: rewritten.rewrite,
        shouldSplit: rewritten.shouldSplit,
        subQuestions: rewritten.subQuestions,
        ...(rewritten.rawOutput !== undefined ? { rawOutput: rewritten.rawOutput } : {}),
        model: rewritten.model,
        elapsedMs: rewritten.elapsedMs,
        ...(rewritten.guardTriggered ? { guardTriggered: rewritten.guardTriggered } : {}),
      };
      input.onDetailedTrace({
        stage: 'rewrite',
        action: 'query-rewrite',
        status: 'completed',
        elapsedMs: rewritten.elapsedMs,
        output: {
          rewrite: rewritten.rewrite,
          shouldSplit: rewritten.shouldSplit,
          subQuestions: rewritten.subQuestions,
          ...(rewritten.rawOutput !== undefined ? { rawOutput: rewritten.rawOutput } : {}),
          model: rewritten.model,
          ...(rewritten.guardTriggered ? { guardTriggered: rewritten.guardTriggered } : {}),
        },
      });
      onToolEvent({
        tool: 'rewrite_question',
        state: 'completed',
        message: rewritten.shouldSplit
          ? `改写完成，并拆分为 ${rewritten.subQuestions.length} 个子问题。`
          : `改写完成：${rewritten.rewrite}`,
        ...(rewritten.rawOutput !== undefined ? { outputSummary: rewritten.rawOutput.slice(0, 400) } : {}),
      });
      retrievalQueries = rewritten.shouldSplit ? rewritten.subQuestions : [rewritten.rewrite];
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const failedRaw = error instanceof QueryRewriteError ? error.rawOutput : undefined;
      const failed = {
        code: error instanceof QueryRewriteError ? error.code : 'rewrite-error',
        message: getErrorMessage(error) || '问题改写失败。',
        ...(failedRaw !== undefined ? { rawOutput: failedRaw } : {}),
      };
      queryRewrite = {
        skipped: false,
        matchedSignals: rewriteGate.matchedSignals,
        elapsedMs: Math.max(0, Date.now() - rewriteStartedAt),
        failed,
      };
      input.onDetailedTrace({
        stage: 'rewrite',
        action: 'query-rewrite',
        status: 'rejected',
        elapsedMs: queryRewrite.elapsedMs,
        errorCode: failed.code,
        error: failed.message,
        ...(failedRaw !== undefined ? { output: { rawOutput: failedRaw } } : {}),
      });
      onToolEvent({ tool: 'rewrite_question', state: 'rejected', message: `问题改写失败：${failed.message} 已回退原文检索。` });
      rewriteWarning = `问题改写失败：${failed.message}，已按原文检索。`;
    }
  }
  throwIfAssistantCancelled(controller.signal);

  const retrieval = await runAssistantPublicTool(
    'search_knowledge_base',
    retrievalQueries.length > 1
      ? `正在从「${sourceLabel}」执行双通道混合检索（${retrievalQueries.length} 路子问题，向量 + 关键词，RRF 融合）…`
      : `正在从「${sourceLabel}」执行双通道混合检索（向量 + 关键词，RRF 融合）…`,
    async () => {
      const runSingle = async (query: string, parentTopK: number) => {
        const searchContext = await prepareMaterialSearchContext(source.libraryPath, query);
        return retrieveKnowledgeBaseEvidence({
          libraryPath: searchContext.targetPath,
          query,
          queryTerms: searchContext.queryTerms,
          lexicalError: searchContext.lexicalError,
          adapter: searchContext.adapter,
          embeddingError: searchContext.embeddingError,
          rerankEnabled: rerankRuntime.enabled,
          rerankAdapter: rerankRuntime.adapter,
          ...(input.documentAffinityFactors ? { documentAffinityFactors: input.documentAffinityFactors } : {}),
          parentTopK,
          onStage: (message) => emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message }),
        });
      };
      if (retrievalQueries.length === 1) return runSingle(retrievalQueries[0], KNOWLEDGE_BASE_RAG_PARENT_TOP_K);
      const outcomes: KnowledgeBaseRetrievalOutcome[] = [];
      const failures: string[] = [];
      for (let index = 0; index < retrievalQueries.length; index += 1) {
        emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: `子问题 ${index + 1}/${retrievalQueries.length}：${retrievalQueries[index]}` });
        try {
          outcomes.push(await runSingle(retrievalQueries[index], 3));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          failures.push(`子问题 ${index + 1} 检索失败：${getErrorMessage(error) || String(error)}`);
        }
      }
      if (outcomes.length === 0) throw new Error(failures.join('；') || '知识库检索未完成。');
      const merged = mergeKnowledgeBaseRetrievals(outcomes, KNOWLEDGE_BASE_RAG_PARENT_TOP_K);
      if (failures.length) merged.notice = [merged.notice, ...failures].filter(Boolean).join('；');
      return merged;
    },
    (result) => `已聚合 ${result.children.length} 个子块为 ${result.parentCandidateCount} 个父块候选，最终取 ${result.evidence.length} 个父块作为证据。`,
    onToolEvent,
    input.onDetailedTrace,
    { query: request.userText, retrievalQueries, source, retrieval: 'hybrid-rrf-parent-top-k', rerankEnabled: rerankRuntime.enabled },
    (result) => ({
      used: result.used,
      vectorIndexed: result.vectorIndexed,
      parentCandidateCount: result.parentCandidateCount,
      rerank: result.rerank,
      childHits: result.children.map((child) => ({ documentId: child.documentId, chunkId: child.chunkId, parentChunkId: child.parentChunkId, rrfScore: child.rrfScore, ranks: child.ranks })),
      notice: result.notice,
      expansion: result.expansion,
      graphExpansion: result.graphExpansion,
      channelContribution: result.channelContribution,
      directLoad: result.directLoad,
      historyHits: result.historyHits,
      mmrDropped: result.mmrDropped,
    }),
  );
  throwIfAssistantCancelled(controller.signal);
  if (retrieval.rerank.enabled) {
    onToolEvent({
      tool: 'rerank_knowledge_evidence',
      state: retrieval.rerank.applied ? 'completed' : 'rejected',
      message: retrieval.rerank.applied
        ? `Rerank 完成：对 ${retrieval.parentCandidateCount} 个父块候选重排，gating 剔除 ${retrieval.rerank.gatedOut} 个。`
        : retrieval.rerank.notice ?? 'Rerank 不可用，已回退 RRF 聚合序。',
      ...(retrieval.rerank.applied ? { outputSummary: `rerank applied, gatedOut=${retrieval.rerank.gatedOut}${retrieval.rerank.degradedThreshold !== undefined ? `, degradedThreshold=${retrieval.rerank.degradedThreshold}` : ''}` } : {}),
    });
  }
  if (retrieval.expansion?.triggered) {
    onToolEvent({
      tool: 'search_knowledge_base',
      state: 'completed',
      message: `首轮召回不足，已用 ${retrieval.expansion.variants.length} 条本地扩写变体补召回 ${retrieval.expansion.addedChildren} 个子块。`,
      outputSummary: `expansion strategies=${retrieval.expansion.strategies.join(',') || 'none'}`,
    });
  }
  if (retrieval.graphExpansion && retrieval.graphExpansion.addedChildren > 0) {
    const seedIds = [...new Set(retrieval.graphExpansion.contributions.map((entry) => entry.seedChunkId))];
    onToolEvent({
      tool: 'search_knowledge_base',
      state: 'completed',
      message: `图通道扩展：从 ${retrieval.graphExpansion.seedCount} 个种子块出发补充 ${retrieval.graphExpansion.addedChildren} 个子块（通道贡献 vector=${retrieval.channelContribution.vector} fts=${retrieval.channelContribution.fts} graph=${retrieval.channelContribution.graph}）。`,
      outputSummary: `graph expansion seeds=${retrieval.graphExpansion.seedCount} added=${retrieval.graphExpansion.addedChildren} seedChunks=${seedIds.join(',') || 'none'}`,
    });
  }
  if (retrieval.directLoad) {
    onToolEvent({
      tool: 'search_knowledge_base',
      state: 'completed',
      message: `小文档直载：${retrieval.directLoad.documentIds.length} 篇小文档的 ${retrieval.directLoad.parentCount} 个父块跳过召回与 rerank 直进证据池。`,
    });
  }

  const retrievalWarning = [rewriteWarning, retrieval.notice].filter(Boolean).join('；') || undefined;
  const rawParentEvidence = retrieval.evidence;
  if (rawParentEvidence.length === 0) {
    const answer = retrieval.notice
      ? `本次未能完成知识库混合检索：${retrieval.notice}`
      : retrieval.children.length > 0
        ? '已召回子块，但无法读取对应的父块；为避免将子块直接作为证据，本次不会生成回答。请重新执行资料库切块和向量化。'
        : '没有在当前知识库索引中召回可用子块，因此无法依据资料回答。';
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text: answer });
    return {
        type: 'answer',
        answer,
        provider: input.provider,
        model: input.model,
        sourceNotes: [],
        retrievalMode: 'hybrid',
        interactionRoute: 'react',
        completeness: 'not-found',
        toolEvents,
        executionElapsedMs: Math.max(0, Date.now() - executionStartedAt),
        ...(retrievalWarning ? { retrievalWarning } : {}),
        ...(input.qaSessionId ? { qaSessionId: input.qaSessionId } : {}),
        queryRewrite,
        cacheUsage: { providerReported: false },
    };
  }

  const materialDocuments = listMaterialsDocuments(source.libraryPath);
  const documents = new Map(materialDocuments.map((document) => [document.id, document]));
  const knowledgeBaseImageResolver = new KnowledgeBaseImageResolver(source.libraryPath, { documents: materialDocuments });
  const visualResolution = knowledgeBaseImageResolver.resolve(rawParentEvidence);
  const parentEvidence = visualResolution.evidence;
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visualResolution.mappings);
  const generationQuestion = visualIndex ? `${request.userText}\n\n${visualIndex}` : request.userText;
  emitAssistantTurnEvent(event, {
    requestId: request.requestId,
    type: 'status',
    message: `已选定 ${parentEvidence.length} 个父块${visualResolution.images.length ? `和 ${visualResolution.images.length} 张相关图片` : ''}${retrieval.rerank.applied ? '（经 rerank 重排）' : ''}，正在仅依据父块证据生成回答…`,
  });
  const sources = parentEvidence.map((parent) => {
    const document = documents.get(parent.documentId);
    const documentName = document?.name ?? sourceLabel;
    const title = documentName;
    return {
      path: document?.absolutePath ?? source.libraryPath,
      title,
      documentId: parent.documentId,
      documentName,
      parentOrdinal: parent.parentOrdinal,
      content: parent.text,
      snippet: createSourceSnippet(parent.text, request.userText),
      score: parent.score,
      methods: parent.methods,
      sourceType: 'knowledge-base' as const,
    };
  });
  const promptSources = sources.map((entry, index) => ({
    title: entry.title,
    content: entry.content,
    sourceId: `${parentEvidence[index].documentId}:${parentEvidence[index].parentChunkId}`,
    contentHash: createHash('sha256').update(entry.content, 'utf8').digest('hex'),
  }));
  // 问答区独立记忆（设计 §4.4 知识库剖面）：Zone 布局 S→M1/M2→D→Q→C，不再拼接渲染进程会话。
  if (!input.qaContextMemory) throw new Error('知识库问答缺少统一 QA Context Memory。');
  const promptAssembly = createQaContextRuntimeAssembly({
    route: 'knowledge-base',
    callKind: 'direct',
    question: generationQuestion,
    sources: promptSources,
    contextMemory: input.qaContextMemory,
    memoryZoneTokens: input.qaMemoryZoneTokens ?? { rollingSummary: 0, shortTerm: 0 },
    skillInstructions: input.skillInstructions,
    answerDepth: request.answerDepth,
    scope: {
      workspaceId: getConfiguredWorkspacePath(),
      libraryId: source.libraryPath,
      ...(input.qaSessionId ? { sessionId: input.qaSessionId } : {}),
      turnId: request.requestId,
    },
    windowProfile: input.effectiveContextWindow.runtimeProfile,
    residualMemoryObservation: input.qaResidualMemoryObservation,
  });
  const prompt = promptAssembly.prompt;
  const projectedPromptSources = promptAssembly.projectedSources;
  const knowledgeContextRuntimeMode = input.knowledgeContextRuntimeMode;
  let knowledgeEnvelope = promptAssembly.envelope;
  let knowledgeProjection = knowledgeContextRuntimeMode === 'enforce' ? promptAssembly.projection : undefined;
  let knowledgeContextDiagnostics: ContextProjectionDiagnostics | undefined;
  let preparedKnowledgeContextObservation: ContextRuntimeObservationResult | undefined;
  let knowledgeEnforcementErrorCode: string | undefined;
  let knowledgeHardVeto = false;
  if (knowledgeContextRuntimeMode === 'enforce') {
    if (!input.qaSessionId) throw new Error('知识库 residual enforce 缺少 QA sessionId。');
    const calibrationMultiplier = input.modelCallCoordinator.getCalibrationMultiplier('direct', CONTEXT_REQUEST_ENVELOPE_VERSION);
    const enforced = await input.qaMemoryOrchestrator.enforceKnowledgeBaseContext({
      sessionId: input.qaSessionId,
      envelope: promptAssembly.envelope,
      model: input.model,
      providerConfig: input.providerConfig,
      calibrationMultiplier,
      signal: controller.signal,
    });
    knowledgeEnvelope = enforced.envelope;
    knowledgeProjection = enforced.projection;
    preparedKnowledgeContextObservation = observeContextRuntime({
      mode: 'enforce',
      envelope: enforced.envelope,
      sendPath: 'projection-enforce',
      legacy: {
        combinedPrompt: promptAssembly.prompt,
        systemPrompt: promptAssembly.systemPrompt,
        userPrompt: promptAssembly.userPrompt,
      },
      preparedProjection: enforced.projection,
      preparedAdmission: enforced.admission,
      preparedPressureEpisode: enforced.pressureEpisode,
      qaResidualMemoryEnforcement: enforced.diagnostics,
      modelCallsAdded: enforced.diagnostics.compaction.modelCalls,
      memoryWritesAdded: enforced.diagnostics.compaction.memoryWrites,
    });
    knowledgeEnforcementErrorCode = enforced.sendAllowed ? undefined : enforced.errorCode ?? 'CONTEXT_PRESSURE_THRASHING';
    knowledgeHardVeto = enforced.diagnostics.state === 'hard-veto';
  }
  const publishPreparedKnowledgeContextDiagnostics = () => {
    if (!preparedKnowledgeContextObservation) return;
    knowledgeContextDiagnostics = preparedKnowledgeContextObservation.report.diagnostics;
    emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: knowledgeContextDiagnostics });
    recordQaContextRuntimeObservation(input.onDetailedTrace, preparedKnowledgeContextObservation.report);
  };
  if (knowledgeEnforcementErrorCode) {
    publishPreparedKnowledgeContextDiagnostics();
    throw new Error(knowledgeEnforcementErrorCode === 'CONTEXT_PRESSURE_THRASHING'
      ? '知识库上下文连续压缩未获得有效收益，已停止自动重试。请减少资料范围、切换更大窗口模型或新建会话。'
      : '知识库会话 Checkpoint 压缩未通过契约，未发送模型请求。请重试、切换模型或新建会话。');
  }
  const preparedCall = input.modelCallCoordinator.prepare({
    callKind: 'direct',
    prompt: knowledgeProjection ? combineAssistantRolePrompts(knowledgeProjection.systemPrompt, knowledgeProjection.userPrompt) : prompt,
    serializedBudgetText: knowledgeProjection?.serializedBudgetText
      ?? serializeContextRoleMessagesForBudget(promptAssembly.systemPrompt, promptAssembly.userPrompt, []),
    requestEnvelopeVersion: knowledgeProjection?.requestEnvelopeVersion ?? CONTEXT_REQUEST_ENVELOPE_VERSION,
    ...(knowledgeContextRuntimeMode === 'enforce' && promptAssembly.evidencePromptManifest
      ? { evidencePromptManifest: promptAssembly.evidencePromptManifest }
      : {}),
  });
  if (!preparedCall.ready) {
    publishPreparedKnowledgeContextDiagnostics();
    throw new ModelCallPreparationError(preparedCall.reason);
  }
  if (knowledgeHardVeto) {
    publishPreparedKnowledgeContextDiagnostics();
    throw new ModelCallPreparationError('context-budget');
  }
  const generation = await streamKnowledgeAnswer({
    question: generationQuestion,
    conversation: request.conversation,
    sources: promptSources,
    prompt,
    systemPrompt: promptAssembly.systemPrompt,
    userPrompt: promptAssembly.userPrompt,
    temperature: resolveAssistantAnswerTemperature({ grounded: true }),
    model: input.model,
    signal: controller.signal,
    providerConfig: input.providerConfig,
    ...(visualResolution.images.length ? { images: visualResolution.images } : {}),
    thinkingMode: request.thinkingMode,
    answerDepth: request.answerDepth,
    contextWindowTokens: input.contextWindowTokens,
    contextWindow: input.effectiveContextWindow,
    skillInstructions: input.skillInstructions,
    preparedModelCall: preparedCall.call,
    modelCallKind: 'direct',
    assistantContextRuntimeMode: knowledgeContextRuntimeMode,
    qaResidualMemoryObservation: knowledgeContextRuntimeMode !== 'enforce'
      ? promptAssembly.residualMemoryObservation
      : undefined,
    preparedContextRuntimeObservation: preparedKnowledgeContextObservation,
    contextEnvelope: knowledgeEnvelope,
    contextRuntimeRoute: 'knowledge-base',
    contextRuntimeScope: {
      workspaceId: getConfiguredWorkspacePath(),
      libraryId: source.libraryPath,
      ...(input.qaSessionId ? { sessionId: input.qaSessionId } : {}),
      turnId: request.requestId,
    },
    onContextRuntimeObservation: (report) => {
      knowledgeContextDiagnostics = report.diagnostics;
      emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'context-diagnostics', diagnostics: report.diagnostics });
      recordQaContextRuntimeObservation(input.onDetailedTrace, report);
    },
    onDelta: (text) => {
      if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'delta', text });
    },
    onThinkingDelta: (text) => {
      if (!controller.signal.aborted) emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'thinking-delta', text });
    },
  });
  throwIfAssistantCancelled(controller.signal);
  return {
      type: 'answer',
      answer: generation.answer,
      provider: input.provider,
      model: input.model,
      sourceNotes: sources.map(({ path: sourcePath, title, documentId, parentOrdinal, snippet, score, methods, sourceType }, index) => ({
        path: sourcePath,
        reference: index + 1,
        documentId,
        parentOrdinal,
        title,
        snippet,
        score,
        methods,
        sourceType,
      })),
      knowledgeBaseCitations: projectedPromptSources.map((projected) => {
        const source = sources[projected.reference - 1];
        return {
          reference: projected.reference,
          documentId: source.documentId,
          documentName: source.documentName,
          parentOrdinal: source.parentOrdinal,
          content: projected.content,
        };
      }),
      retrievalMode: 'hybrid',
      interactionRoute: 'react',
      contextUsage: generation.contextUsage,
      completeness: 'complete',
      toolEvents,
      executionElapsedMs: Math.max(0, Date.now() - executionStartedAt),
      ...(generation.thinkingText ? { thinkingText: generation.thinkingText, thinkingElapsedMs: generation.thinkingElapsedMs } : {}),
      ...(retrievalWarning ? { retrievalWarning } : {}),
      ...(input.qaSessionId ? { qaSessionId: input.qaSessionId } : {}),
      queryRewrite,
      qaMemoryZones: promptAssembly.zoneTokens,
      cacheUsage: {
        providerReported: generation.contextUsage.source === 'provider' && generation.contextUsage.cachedInputTokens !== undefined,
        ...(generation.contextUsage.cachedInputTokens !== undefined ? { cachedInputTokens: generation.contextUsage.cachedInputTokens } : {}),
      },
      ...(knowledgeContextDiagnostics ? { contextDiagnostics: knowledgeContextDiagnostics } : {}),
  };
}

function resolveQaContextRuntimeMode(route: 'chat' | 'knowledge-base'): AssistantContextRuntimeMode {
  const routeOverride = route === 'chat'
    ? process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_CHAT_MODE
    : process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_KNOWLEDGE_BASE_MODE;
  return resolveAssistantContextRuntimeMode(route, routeOverride);
}

function resolveAssistantContextRuntimeMode(
  route: 'chat' | 'knowledge-base' | 'current-note-direct' | 'current-note-react',
  environmentRouteOverride?: string,
): AssistantContextRuntimeMode {
  const sharedOverride = process.env.MENGHAN_ASSISTANT_CONTEXT_RUNTIME_MODE;
  const environmentMode = environmentRouteOverride?.trim() || sharedOverride?.trim();
  if (environmentMode) return normalizeAssistantContextRuntimeMode(environmentMode);
  const preferences = getAppPreferences(store);
  const routeMode = route === 'chat'
    ? preferences.assistantContextRuntimeChatMode
    : route === 'knowledge-base'
      ? preferences.assistantContextRuntimeKnowledgeBaseMode
      : route === 'current-note-direct'
        ? preferences.assistantContextRuntimeCurrentNoteDirectMode
        : preferences.assistantContextRuntimeCurrentNoteReactMode;
  return routeMode === 'inherit' ? preferences.assistantContextRuntimeMode : routeMode;
}

function resolveAssistantMemoryProjectionMode(
  route: 'chat' | 'knowledge-base' | 'current-note-direct' | 'current-note-react',
): MemoryProjectionMode {
  const routeEnvironmentKey = route === 'chat'
    ? process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_CHAT_MODE
    : route === 'knowledge-base'
      ? process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_KNOWLEDGE_BASE_MODE
      : route === 'current-note-direct'
        ? process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_CURRENT_NOTE_DIRECT_MODE
        : process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_CURRENT_NOTE_REACT_MODE;
  const environmentMode = routeEnvironmentKey?.trim() || process.env.MENGHAN_ASSISTANT_MEMORY_PROJECTION_MODE?.trim();
  if (environmentMode) return normalizeMemoryProjectionMode(environmentMode);
  const preferences = getAppPreferences(store);
  const routeMode = route === 'chat'
    ? preferences.assistantMemoryProjectionChatMode
    : route === 'knowledge-base'
      ? preferences.assistantMemoryProjectionKnowledgeBaseMode
      : route === 'current-note-direct'
        ? preferences.assistantMemoryProjectionCurrentNoteDirectMode
        : preferences.assistantMemoryProjectionCurrentNoteReactMode;
  return routeMode === 'inherit' ? preferences.assistantMemoryProjectionMode : routeMode;
}

function combineAssistantRolePrompts(systemPrompt: string, userPrompt: string): string {
  return [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
}

function recordQaContextRuntimeObservation(
  trace: AssistantDetailedTraceSink,
  report: ContextRuntimeObservationReport,
): void {
  trace({
    stage: 'context-runtime',
    action: 'qa-context-envelope',
    status: report.invariantViolations.length ? 'rejected' : 'completed',
    callKind: report.callKind,
    input: {
      route: report.route,
      mode: report.mode,
      requestEnvelopeVersion: report.requestEnvelopeVersion,
      candidateMaterials: report.candidateMaterials,
      sendPath: report.sendPath,
    },
    output: {
      differences: report.differences,
      invariantViolations: report.invariantViolations,
      stablePrefixFingerprint: report.stablePrefixFingerprint,
      legacy: report.legacy,
      projection: report.projection,
      diagnostics: report.diagnostics,
    },
  });
}

function getAssistantScopeLabel(request: AssistantTurnRequest): string {
  if (request.scope === 'chat') return request.attachments?.length
    ? `本次使用：附件 ${request.attachments.length} 个，不检索资料库`
    : '本次使用：无资料库，直接询问 AI';
  if (request.scope === 'current-note') {
    const extras = [
      ...(request.contextSources?.map((source) => source.label?.trim() || (source.kind === 'knowledge-base' ? '个人知识库' : '指定笔记库')) ?? []),
      ...(request.attachments?.length ? [`附件 ${request.attachments.length} 个`] : []),
    ];
    return `本次使用：当前笔记（已保存版本）${extras.length ? `、${extras.join('、')}` : ''}`;
  }
  if (request.scope === 'library-structure') return '本次使用：笔记库标题、标签与目录标题（不读取正文）';
  if (request.scope === 'wiki-node') {
    const actionKind = request.wikiTarget?.actionKind;
    const actionLabel = actionKind && actionKind !== 'free'
      ? WIKI_QUICK_ACTIONS.find((action) => action.id === actionKind)?.label ?? '快捷动作'
      : '自由问答';
    return `本次使用：Wiki 节点问答（限定当前章节及其子章节、${actionLabel}）`;
  }
  if (request.contextSources?.length) {
    const labels = request.contextSources.map((source) => source.label?.trim() || (source.kind === 'knowledge-base' ? '个人知识库' : '指定笔记库'));
    return `本次使用：${labels.join('、')}${request.attachments?.length ? `，附件 ${request.attachments.length} 个` : ''}`;
  }
  return request.intent === 'learning-plan'
    ? `本次使用：知识库检索到的相关学习资料${request.attachments?.length ? `，附件 ${request.attachments.length} 个` : ''}`
    : `本次使用：知识库检索到的相关笔记片段${request.attachments?.length ? `，附件 ${request.attachments.length} 个` : ''}`;
}

async function getAssistantModel(config: AiProviderConfig): Promise<string> {
  const status = await getAiProviderStatusForConfig(config);
  const model = config.model?.trim() || status.models[0]?.name;
  if (!status.available || !model) throw new Error(status.message || '请先在“设置 → 模型连接”中选择可用模型。');
  return model;
}

async function resolveAssistantContextWindow(config: AiProviderConfig, model: string): Promise<EffectiveContextWindow> {
  const metadata = config.availableModels?.find((entry) => entry.name.trim() === model.trim());
  const discoveredModelWindow = config.kind === 'ollama'
    ? await getOllamaModelContextWindow(config.endpoint, model)
    : await getRemoteModelContextWindow(config, model);
  return resolveEffectiveContextWindow({
    providerId: config.kind === 'ollama' ? 'ollama' : config.provider ?? 'custom',
    modelId: model,
    discoveredModelWindow,
    discoveredSource: config.kind === 'ollama' ? 'ollama' : 'provider',
    configuredModelWindow: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
    knownModelWindow: metadata?.contextWindowTokens,
    modelMaxOutputTokens: metadata?.maxOutputTokens,
    mode: process.env.MENGHAN_ASSISTANT_CONTEXT_WINDOW_MODE === 'legacy-fixed-128k'
      ? 'legacy-fixed-128k'
      : 'adaptive-real-window',
  });
}

function resolveConfiguredAssistantContextWindow(config: AiProviderConfig): EffectiveContextWindow {
  const model = config.model?.trim() ?? '';
  const metadata = config.availableModels?.find((entry) => entry.name.trim() === model);
  return resolveEffectiveContextWindow({
    providerId: config.kind === 'ollama' ? 'ollama' : config.provider ?? 'custom',
    modelId: model,
    configuredModelWindow: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
    knownModelWindow: metadata?.contextWindowTokens,
    modelMaxOutputTokens: metadata?.maxOutputTokens,
  });
}

type AssistantPublicToolEventListener = (event: CurrentNotePublicToolEvent) => void;

async function runAssistantPublicTool<T>(
  tool: CurrentNotePublicToolEvent['tool'],
  startedMessage: string,
  action: () => T | Promise<T>,
  completedMessage: (result: T) => string,
  onToolEvent?: AssistantPublicToolEventListener,
  onDetailedTrace?: AssistantDetailedTraceSink,
  detailedInput?: unknown,
  detailedOutput?: (result: T) => unknown,
): Promise<T> {
  const startedAt = Date.now();
  onToolEvent?.({ tool, state: 'started', message: startedMessage, inputSummary: startedMessage });
  onDetailedTrace?.({ stage: 'context-tool', action: tool, status: 'started', input: detailedInput ?? { message: startedMessage } });
  try {
    const result = await action();
    const outputSummary = completedMessage(result);
    onToolEvent?.({ tool, state: 'completed', message: outputSummary, outputSummary, elapsedMs: Date.now() - startedAt });
    onDetailedTrace?.({
      stage: 'context-tool',
      action: tool,
      status: 'completed',
      input: detailedInput ?? { message: startedMessage },
      output: detailedOutput ? detailedOutput(result) : result,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    onToolEvent?.({
      tool,
      state: 'rejected',
      message: error instanceof Error ? error.message : '工具执行失败。',
      inputSummary: startedMessage,
      elapsedMs: Date.now() - startedAt,
    });
    onDetailedTrace?.({
      stage: 'context-tool',
      action: tool,
      status: 'rejected',
      input: detailedInput ?? { message: startedMessage },
      error: toDetailedTraceError(error),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function resolveAssistantAnswerContext(
  libraryPath: string | null,
  request: AssistantTurnRequest,
  signal: AbortSignal,
  assistantMineru?: MineruRuntimeConfig,
  onToolEvent?: AssistantPublicToolEventListener,
  onDetailedTrace?: AssistantDetailedTraceSink,
  options: { retrievalQuery?: string; allowKnowledgeSources?: boolean } = {},
): Promise<{
  sources: Array<{ path: string; title: string; content: string; snippet: string; score: number; methods: Array<'keyword' | 'semantic'>; sourceType: 'note' | 'knowledge-base' | 'attachment'; matchTrace?: LexicalMatchTrace[] }>;
  sourceNotes: Array<{ path: string; title: string; snippet: string; score: number; methods: Array<'keyword' | 'semantic'>; sourceType: 'note' | 'knowledge-base' | 'attachment'; matchTrace?: LexicalMatchTrace[] }>;
  retrievalMode: 'hybrid' | 'semantic' | 'keyword' | 'none';
  currentNote?: IndexedNote;
  retrievalWarning?: string;
  images: AiTransportImage[];
}> {
  const sources: Array<{ path: string; title: string; content: string; snippet: string; score: number; methods: Array<'keyword' | 'semantic'>; sourceType: 'note' | 'knowledge-base' | 'attachment'; matchTrace?: LexicalMatchTrace[] }> = [];
  const retrievalModes: Array<'hybrid' | 'semantic' | 'keyword' | 'none'> = [];
  const warnings: string[] = [];
  const derivedImages: AiTransportImage[] = [];
  let currentNote: IndexedNote | undefined;
  const retrievalQuery = options.retrievalQuery?.trim() || request.userText.trim();
  const allowKnowledgeSources = options.allowKnowledgeSources ?? true;

  if (allowKnowledgeSources && request.scope === 'current-note') {
    const note = await runAssistantPublicTool(
      'read_current_note',
      '正在读取当前打开的笔记…',
      () => {
        if (!libraryPath || !noteIndex) throw new Error('当前笔记库尚未完成索引。');
        const safePath = assertInsideDirectory(request.currentNotePath!, libraryPath);
        const indexedNote = noteIndex.notesByPath[path.resolve(safePath)];
        if (!indexedNote) throw new Error('当前笔记不在已索引的笔记库中。');
        return indexedNote;
      },
      (indexedNote) => `已锁定当前笔记《${indexedNote.title}》，不会检索笔记库中的其他笔记。`,
      onToolEvent,
      onDetailedTrace,
      { currentNotePath: request.currentNotePath },
    );
    currentNote = note;
    sources.push({
      path: note.path,
      title: note.title,
      content: note.contentMarkdown,
      snippet: createSourceSnippet(note.plainText, retrievalQuery),
      score: 1,
      methods: [] as Array<'keyword' | 'semantic'>,
      sourceType: 'note',
    });
    retrievalModes.push('none');
  }

  const requestedSources = !allowKnowledgeSources
    ? []
    : request.contextSources?.length
      ? request.contextSources
      : request.scope === 'library-search' && libraryPath
        ? [{ kind: 'note-library' as const, libraryPath, label: '知识库' }]
        : [];
  const seenContextSources = new Set<string>();
  for (const sourceRequest of requestedSources) {
    const targetKey = `${sourceRequest.kind}:${path.resolve(sourceRequest.libraryPath)}`;
    if (seenContextSources.has(targetKey)) continue;
    seenContextSources.add(targetKey);
    if (sourceRequest.kind === 'note-library') {
      const targetPath = requireRegisteredNoteLibrary(sourceRequest.libraryPath);
      const search = await runAssistantPublicTool(
        'search_note_library',
        `正在检索「${sourceRequest.label?.trim() || '指定笔记库'}」…`,
        () => targetPath === libraryPath && noteIndex
          ? ({ index: noteIndex!, outcome: runKeywordSearchAgent(retrievalQuery) })
          : searchNoteLibraryForAssistant(targetPath, retrievalQuery),
        (result) => `已找到 ${result.outcome.results.length} 条相关笔记。`,
        onToolEvent,
        onDetailedTrace,
        { query: retrievalQuery, source: sourceRequest },
        (result) => result.outcome,
      );
      retrievalModes.push(search.outcome.mode);
      for (const match of search.outcome.results) {
        const note = search.index.notesByPath[path.resolve(match.path)];
        if (!note) continue;
        sources.push({
          path: note.path,
          title: note.title,
          content: note.contentMarkdown,
          snippet: createSourceSnippet(note.plainText, retrievalQuery),
          score: match.score,
          methods: match.methods,
          sourceType: 'note',
          ...(match.matchTrace?.length ? { matchTrace: match.matchTrace } : {}),
        });
      }
      continue;
    }

    const targetPath = requireRegisteredMaterialsLibrary(sourceRequest.libraryPath);
    const search = await runAssistantPublicTool(
      'search_knowledge_base',
      `正在检索「${sourceRequest.label?.trim() || '个人知识库'}」…`,
      () => searchKnowledgeBaseForAssistant(targetPath, retrievalQuery),
      (result) => `已找到 ${result.results.length} 条相关资料。`,
      onToolEvent,
      onDetailedTrace,
      { query: retrievalQuery, source: sourceRequest },
    );
    retrievalModes.push(search.used === '综合搜索' ? 'hybrid' : search.used === '语义搜索' ? 'semantic' : 'keyword');
    if (search.notice) warnings.push(`${sourceRequest.label?.trim() || '个人知识库'}：${search.notice}`);
    const documents = new Map(listMaterialsDocuments(targetPath).map((document) => [document.id, document]));
    for (const match of search.results) {
      const document = documents.get(match.documentId);
      const content = match.citation.parent?.text || match.citation.sourceText || match.citation.text;
      sources.push({
        path: document?.absolutePath ?? targetPath,
        title: document?.name ?? sourceRequest.label?.trim() ?? '个人知识库资料',
        content,
        snippet: createSourceSnippet(content, retrievalQuery),
        score: match.score,
        methods: match.matchTypes.includes('语义') ? ['semantic'] : ['keyword'],
        sourceType: 'knowledge-base',
      });
    }
  }

  if (request.attachments?.length) {
    const documentParseSession = await runAssistantPublicTool(
      'read_attachments',
      '正在读取并解析本轮附件…',
      () => parseAssistantDocumentAttachments(request.attachments ?? [], {
        signal,
        ...(assistantMineru ? { mineru: assistantMineru } : {}),
      }),
      (result) => result.documentTextByAttachmentId.size ? `已解析 ${result.documentTextByAttachmentId.size} 个文档附件。` : '附件已读取。',
      onToolEvent,
      onDetailedTrace,
      { attachments: request.attachments.map((attachment) => ({ attachmentId: attachment.attachmentId, kind: attachment.kind, name: attachment.name, sizeBytes: attachment.sizeBytes })) },
      (result) => ({ parsedDocumentIds: [...result.documentTextByAttachmentId.keys()] }),
    );
    try {
    throwIfAssistantCancelled(signal);
    const attachmentProvider = new AttachmentContextProvider(request.attachments, {
      documentTextByAttachmentId: documentParseSession.documentTextByAttachmentId,
      documentImagesByAttachmentId: documentParseSession.documentImagesByAttachmentId,
    });
    const attachmentMetadata = attachmentProvider.listMetadata();
    const searchableMetadata = attachmentMetadata.filter((metadata): metadata is AssistantSearchableAttachmentMetadata => metadata.kind !== 'image');
    const attachmentHits = await runAssistantPublicTool(
      'search_attachment',
      `正在搜索 ${searchableMetadata.length} 个可搜索附件…`,
      () => attachmentProvider.search(retrievalQuery),
      (result) => `已定位 ${result.length} 个相关附件范围。`,
      onToolEvent,
      onDetailedTrace,
      {
        query: retrievalQuery,
        attachments: searchableMetadata.map((metadata) => ({
          attachmentId: metadata.attachmentId,
          name: metadata.name,
          sha256: metadata.sha256,
          lineCount: metadata.lineCount,
        })),
      },
      (result) => result.map(({ attachmentId, lineFrom, lineTo, score, reason }) => ({ attachmentId, lineFrom, lineTo, score, reason })),
    );
    const attachmentReads = attachmentHits.length
      ? await runAssistantPublicTool(
        'read_attachment_range',
        `正在读取 ${attachmentHits.length} 个附件命中范围…`,
        () => attachmentHits.map((hit) => attachmentProvider.readRange(hit)),
        (result) => `已读取 ${result.length} 个有界附件范围。`,
        onToolEvent,
        onDetailedTrace,
        { ranges: attachmentHits.map(({ attachmentId, lineFrom, lineTo }) => ({ attachmentId, lineFrom, lineTo })) },
        (result) => result.map(({ attachmentId, lineFrom, lineTo, sha256, truncated }) => ({ attachmentId, lineFrom, lineTo, sha256, truncated })),
      )
      : [];
    const hitByRange = new Map(attachmentHits.map((hit) => [`${hit.attachmentId}:${hit.lineFrom}:${hit.lineTo}`, hit]));
    if (request.intent === 'ask') {
      const explicitImageBytes = request.attachments.reduce((total, attachment) => total + (attachment.kind === 'image' ? attachment.sizeBytes : 0), 0);
      const selectedDocumentImages = attachmentProvider.selectDocumentImages(attachmentReads, retrievalQuery);
      const explicitImages = request.attachments.flatMap((attachment) => attachment.kind === 'image'
        ? [{ dataUrl: attachment.dataUrl, mimeType: attachment.mimeType, name: attachment.name }]
        : []);
      const materializedDocumentImages = materializeAssistantDocumentImages(selectedDocumentImages, {
        maxTotalBytes: Math.max(0, maxAssistantImageTotalBytes - explicitImageBytes),
        excludedSha256: collectAiTransportImageHashes(explicitImages),
      });
      derivedImages.push(...materializedDocumentImages.map((item) => item.transport));
      if (materializedDocumentImages.length) {
        sources.push({
          path: attachmentProvider.resolveLocalPath(materializedDocumentImages[0]!.source.attachmentId),
          title: '文档图片视觉输入索引',
          content: renderDocumentImageTransportIndex(materializedDocumentImages.map((item) => item.source), request.attachments.filter((attachment) => attachment.kind === 'image').length),
          snippet: `已将 ${materializedDocumentImages.length} 张相关文档图片作为视觉输入提交给回答模型。`,
          score: 100,
          methods: [],
          sourceType: 'attachment',
        });
      }
    }
    for (const read of attachmentReads) {
      const hit = hitByRange.get(`${read.attachmentId}:${read.lineFrom}:${read.lineTo}`);
      sources.push({
        path: attachmentProvider.resolveLocalPath(read.attachmentId),
        title: `附件：${read.name}（L${read.lineFrom}-L${read.lineTo}）`,
        content: renderAttachmentRange(read),
        snippet: createSourceSnippet(read.text, retrievalQuery),
        score: hit?.score ?? 1,
        methods: hit?.reason === 'query-match' ? ['keyword'] : [],
        sourceType: 'attachment',
      });
    }
    for (const metadata of attachmentMetadata) {
      const snippet = metadata.kind === 'image'
        ? `${metadata.name} · ${metadata.mimeType} · ${metadata.sizeBytes} bytes · 图片`
        : metadata.searchable
          ? `${metadata.name} · ${metadata.mimeType} · ${metadata.sizeBytes} bytes · L1-L${metadata.lineCount}`
          : `${metadata.name} · ${metadata.mimeType} · ${metadata.sizeBytes} bytes · 尚未解析`;
      sources.push({
        path: attachmentProvider.resolveLocalPath(metadata.attachmentId),
        title: `附件：${metadata.name}（元数据）`,
        content: renderAttachmentMetadata(metadata),
        snippet,
        score: 0.1,
        methods: [],
        sourceType: 'attachment',
      });
    }
    if (attachmentHits.some((hit) => hit.reason === 'query-match')) retrievalModes.push('keyword');
    } finally {
      documentParseSession.dispose();
    }
  }
  const uniqueSources = [...new Map(sources.map((source) => [`${source.sourceType}:${source.path}:${source.title}`, source])).values()]
    .sort((left, right) => Number(right.sourceType === 'attachment') - Number(left.sourceType === 'attachment') || right.score - left.score)
    .slice(0, 8);
  const retrievalMode = retrievalModes.includes('hybrid') ? 'hybrid' : retrievalModes.includes('semantic') ? 'semantic' : retrievalModes.includes('keyword') ? 'keyword' : 'none';
  return {
    sources: uniqueSources,
    sourceNotes: uniqueSources.map(({ path: sourcePath, title, snippet, score, methods, sourceType, matchTrace }) => ({
      path: sourcePath,
      title,
      snippet,
      score,
      methods,
      sourceType,
      ...(matchTrace?.length ? { matchTrace } : {}),
    })),
    retrievalMode,
    images: derivedImages,
    ...(currentNote ? { currentNote } : {}),
    ...(warnings.length ? { retrievalWarning: warnings.join('；') } : {}),
  };
}

function throwIfAssistantCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
}

function searchKeywordCandidates(query: string, limit = 40): SearchCandidate[] {
  if (!miniSearch || !query.trim()) return [];
  const libraryPath = getCurrentLibraryPath();
  return createKeywordCandidates(searchNoteLexically(miniSearch, query), query, libraryPath, undefined, limit);
}

function createKeywordCandidates(
  entries: readonly any[],
  query: string,
  libraryPath: string | null,
  scopedIndex?: NoteIndex,
  limit = 40,
): SearchCandidate[] {
  const sourceIndex = scopedIndex ?? noteIndex;
  return entries
    .flatMap((entry: any) => {
      if (typeof entry.path !== 'string') return [];
      const note = sourceIndex?.notesByPath[path.resolve(entry.path)];
      const title = typeof entry.title === 'string' ? entry.title : note?.title;
      if (!title) return [];
      const content = typeof entry.content === 'string' ? entry.content : note?.plainText ?? '';
      if (rejectsNumericVersionMismatch(query, `${title}\n${content}`)) return [];
      const queryTerms = readSearchTerms(entry.queryTerms);
      const matchedTerms = readSearchTerms(entry.terms);
      const matchTrace = buildLexicalMatchTrace(queryTerms.length ? queryTerms : [query], matchedTerms);
      return [{
        path: entry.path,
        title,
        score: Number(entry.score) || 0,
        relativePath: libraryPath ? path.relative(libraryPath, entry.path).replace(/\\/g, '/') : entry.path,
        snippet: createSourceSnippet(content, query),
        searchTerm: query,
        matchTrace,
      }];
    })
    .sort((first, second) => lexicalMatchPriority(first.matchTrace ?? []) - lexicalMatchPriority(second.matchTrace ?? [])
      || second.score - first.score
      || first.title.localeCompare(second.title, 'zh-Hans-CN'))
    .slice(0, limit);
}

function readSearchTerms(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

async function searchNotesUnified(query: string): Promise<UnifiedSearchOutcome> {
  const normalizedQuery = query.trim();
  const libraryPath = getCurrentLibraryPath();
  if (!normalizedQuery || !libraryPath) {
    return { results: [], mode: 'keyword', used: '关键词搜索' };
  }
  const results = searchKeywordCandidates(normalizedQuery).map((result) => ({
    path: result.path,
    title: result.title,
    relativePath: result.relativePath ?? path.relative(libraryPath, result.path).replace(/\\/g, '/'),
    ...(result.snippet ? { snippet: result.snippet } : {}),
    ...(result.heading ? { heading: result.heading } : {}),
    matchTypes: ['关键词' as const],
    score: result.score,
    ...(result.searchTerm ? { searchTerm: result.searchTerm } : {}),
    ...(result.matchTrace?.length ? { matchTrace: result.matchTrace } : {}),
  }));
  return {
    results,
    mode: 'keyword',
    used: '关键词搜索',
  };
}


function readAiProviderConfig(): AiProviderConfig | undefined {
  const config = store?.get('aiProvider') as Omit<AiProviderConfig, 'apiKey'> | undefined;
  const encrypted = store?.get('aiProviderSecret') as string | undefined;
  let apiKey: string | undefined;
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try { apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { apiKey = undefined; }
  }
  return config ? { ...config, apiKey } : undefined;
}

function resolveAiApiKey(config: AiProviderConfig, previous: AiProviderConfig | undefined): string | undefined {
  const enteredKey = config.apiKey?.trim();
  if (enteredKey) return enteredKey;
  if (!previous?.apiKey) return undefined;
  const providerMatches = !config.provider || !previous.provider || config.provider === previous.provider;
  const normalizeEndpoint = (value?: string) => value?.trim().replace(/\/+$/, '');
  const endpointMatches = !config.endpoint || !previous.endpoint || normalizeEndpoint(config.endpoint) === normalizeEndpoint(previous.endpoint);
  return providerMatches && endpointMatches ? previous.apiKey : undefined;
}

function readAiModelSettingsInput(persistMigration = true): AiModelSettingsInput {
  const stored = store?.get('aiModelSettings');
  try {
    const settings = validateModelSettingsInput(stored);
    return attachProfileSecrets(settings);
  } catch {
    const legacy = readAiProviderConfig();
    const migrated = createModelSettingsFromLegacy(legacy);
    const withLegacySecret = migrated.profiles.map((profile) => profile.id === migrated.defaultProfileId
      ? { ...profile, config: { ...profile.config, apiKey: legacy?.apiKey } }
      : profile);
    const result = { ...migrated, profiles: withLegacySecret };
    if (persistMigration) persistAiModelSettings(result);
    return result;
  }
}

function getAiModelSettings(): AiModelSettings {
  const settings = readAiModelSettingsInput();
  return redactModelSettings(settings, (profileId) => Boolean(settings.profiles.find((profile) => profile.id === profileId)?.config.apiKey));
}

function prepareAiModelSettings(value: unknown): AiModelSettingsInput {
  const next = validateModelSettingsInput(value);
  const previous = readAiModelSettingsInput(false);
  const previousById = new Map(previous.profiles.map((profile) => [profile.id, profile]));
  const profiles = next.profiles.map((profile) => {
    const previousProfile = previousById.get(profile.id);
    const apiKey = resolveProfileApiKey(profile, previousProfile);
    if (profile.config.kind === 'openai-compatible' && profile.config.model?.trim()) {
      if (!apiKey) throw new Error(`远程模型“${profile.label}”需要 API Key。`);
      if (!profile.config.remoteContentConsent) throw new Error(`请确认远程模型“${profile.label}”的内容发送范围。`);
    }
    return { ...profile, config: { ...profile.config, ...(apiKey ? { apiKey } : {}) } };
  });
  return { ...next, profiles };
}

function isMemoryExtractionRouteEnabled(route: string, agentId: string): boolean {
  return agentId === 'default' && ['chat', 'knowledge-base', 'current-note-direct', 'current-note-react'].includes(route)
    && isCanonicalMemoryProjection(resolveAssistantMemoryProjectionMode(route as Parameters<typeof resolveAssistantMemoryProjectionMode>[0]));
}

let modelConfigurationService: ModelConfigurationService | undefined;

/** 所有模型保存入口复用同一提交门，运行时只在配置整体落盘后更新。 */
function saveModelConfiguration(change: ModelConfigurationChange, confirmationToken?: string): ModelConfigurationSaveResult {
  modelConfigurationService ??= new ModelConfigurationService({
    store,
    libraries: () => listMaterialsLibraries(store),
    prepare: (input, draft: ModelConfigurationStore) => {
      if (!input || (input.kind !== 'profiles' && input.kind !== 'hub')) throw new Error('模型配置格式无效。');
      if (input.kind === 'profiles') {
        const saved = prepareAiModelSettings(input.settings);
        const defaultConfig = saved.profiles.find(profile => profile.id === saved.defaultProfileId)?.config;
        persistAiModelSettings(saved, draft);
        syncLegacyDefaultProfile(defaultConfig, draft);
        syncModelHubGeneration(defaultConfig, draft);
        if (input.hubPatch) saveModelHub(draft, input.hubPatch);
        return { hub: readModelHub(draft), modelSettings: redactModelSettings(saved, id => Boolean(saved.profiles.find(profile => profile.id === id)?.config.apiKey)) };
      }
      if (input.provider) saveProviderConnection(draft, input.provider.id, input.provider.patch);
      if (input.hubPatch) saveModelHub(draft, input.hubPatch);
      syncLegacyGenerationConfig(draft, false);
      return { hub: readModelHub(draft) };
    },
    afterSave: change => { configureAiProvider(readAiProviderConfig()); if (change.kind === 'profiles') onboardingService?.profilesSaved(); },
  });
  return modelConfigurationService.save(change, confirmationToken);
}

/** 兼容 IPC 也不能直接覆盖被引用的地址；交互式确认由统一保存接口完成。 */
function requireSavedModelConfiguration(result: ModelConfigurationSaveResult) {
  if (result.status !== 'saved') throw new Error(`修改连接地址会影响资料库：${result.impacts.map(impact => impact.libraryName).join('、')}。请在“模型配置”中确认后保存。`);
  return result;
}

function saveAiModelSettings(value: unknown): AiModelSettings {
  return requireSavedModelConfiguration(saveModelConfiguration({ kind: 'profiles', settings: value as AiModelSettingsInput })).modelSettings!;
}

/** 读取技能配置，并清理旧版本中已移除的连接字段。 */
function readAiExtensionsSettings(): AiExtensionsSettings {
  try {
    const stored = store?.get('aiExtensionsSettings');
    const settings = validateExtensionsSettings(stored);
    if (stored && typeof stored === 'object' && 'mcpServers' in stored) {
      store?.set('aiExtensionsSettings', settings);
    }
    return settings;
  } catch {
    const defaults = defaultExtensionsSettings();
    store?.set('aiExtensionsSettings', defaults);
    return defaults;
  }
}

function saveAiExtensionsSettings(value: unknown): AiExtensionsSettings {
  const validated = validateExtensionsSettings(value);
  // directorySkillOverrides 只允许由目录技能专用 IPC 修改。设置页的 draft 可能
  // 早于一次导入/启停操作；普通技能保存不能用旧快照覆盖这些新状态。
  const currentOverrides = readAiExtensionsSettings().directorySkillOverrides;
  const settings: AiExtensionsSettings = {
    ...validated,
    ...(currentOverrides ? { directorySkillOverrides: currentOverrides } : { directorySkillOverrides: undefined }),
  };
  syncAiSkillsToWorkspace(getConfiguredWorkspacePath(), settings, getBundledAiSkillsPath());
  store?.set('aiExtensionsSettings', settings);
  return settings;
}

/** 目录技能登记的内存写入；调用方保证 name 已经过运行期扫描（真实技能）。 */
function updateDirectorySkillOverride(name: string, patch: { enabled?: boolean; importedAt?: string; remove?: boolean }): AiExtensionsSettings {
  const settings = readAiExtensionsSettings();
  const overrides: Record<string, DirectorySkillOverride> = { ...(settings.directorySkillOverrides ?? {}) };
  const existingKey = Object.keys(overrides).find((key) => key.toLowerCase() === name.toLowerCase());
  if (patch.remove) {
    if (existingKey) delete overrides[existingKey];
  } else {
    const current = existingKey ? overrides[existingKey] : undefined;
    const importedAt = patch.importedAt ?? current?.importedAt;
    overrides[existingKey ?? name] = importedAt ? { enabled: patch.enabled ?? current?.enabled ?? true, importedAt } : { enabled: patch.enabled ?? current?.enabled ?? true };
  }
  const next = { ...settings, ...(Object.keys(overrides).length > 0 ? { directorySkillOverrides: overrides } : { directorySkillOverrides: undefined }) };
  store?.set('aiExtensionsSettings', next);
  return next;
}

function findDirectorySkillOverride(name: string): DirectorySkillOverride | undefined {
  const overrides = readAiExtensionsSettings().directorySkillOverrides ?? {};
  const nameKey = name.toLowerCase();
  return Object.entries(overrides).find(([entryName]) => entryName.toLowerCase() === nameKey)?.[1];
}

function findDirectorySkillEntry(name: unknown): DirectorySkillEntry {
  if (typeof name !== 'string' || !name.trim()) throw new Error('技能名称无效。');
  const nameKey = name.trim().toLowerCase();
  const entry = loadDirectorySkills(getConfiguredWorkspacePath()).skills.find((skill) => skill.name.toLowerCase() === nameKey);
  if (!entry) throw new Error(`未找到目录技能「${name.trim()}」。`);
  return entry;
}

function getAssistantAiOptions(_requestedProfileId?: string): AssistantAiOptions {
  // API keys stay in the main process; the renderer receives only safe profile data.
  const settings = readAiModelSettingsInput();
  const skills = readAssistantSkills().available;
  const profiles = settings.profiles
    .filter((profile) => Boolean(profile.config.model) && (profile.config.kind === 'ollama' || (Boolean(profile.config.apiKey) && Boolean(profile.config.remoteContentConsent))));
  return {
    defaultProfileId: settings.defaultProfileId,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      kind: profile.config.kind,
      provider: profile.config.provider,
      model: profile.config.model,
      contextWindowTokens: resolveConfiguredAssistantContextWindow(profile.config).tokens,
    })),
    skills: skills.map(({ id, name, description, enabled, system }) => ({ id, name, description, enabled, system })),
  };
}

function resolveAssistantProfile(profileId: string | undefined): AiModelProfile {
  const settings = readAiModelSettingsInput();
  const profile = settings.profiles.find((entry) => entry.id === (profileId || settings.defaultProfileId));
  if (!profile) throw new Error('所选模型档案不存在。');
  if (!profile.config.model?.trim()) throw new Error('所选模型档案尚未选择生成模型。');
  if (profile.config.kind === 'openai-compatible') {
    if (!profile.config.apiKey) throw new Error('所选远程模型尚未保存 API Key。');
    if (!profile.config.remoteContentConsent) throw new Error('请先确认所选远程模型的内容发送范围。');
  }
  return profile;
}

/** 开发与发布使用同一组技能资源；发布后不依赖项目或用户原来的工作区。 */
function getBundledAiSkillsPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'builtin-skills')
    : path.resolve('build', 'builtin-skills');
}

/** 先补齐内置资源，再读取用户启用状态，供菜单和请求校验共用。 */
function readAssistantSkills() {
  const workspacePath = getConfiguredWorkspacePath();
  ensureBundledSkills(workspacePath, getBundledAiSkillsPath());
  return loadAssistantSkills(workspacePath, readAiExtensionsSettings());
}

function attachProfileSecrets(settings: AiModelSettingsInput): AiModelSettingsInput {
  const secrets = readAiProfileSecrets();
  return {
    ...settings,
    profiles: settings.profiles.map((profile) => ({ ...profile, config: { ...profile.config, ...(secrets[profile.id] ? { apiKey: decryptAiSecret(secrets[profile.id]) } : {}) } })),
  };
}

function persistAiModelSettings(settings: AiModelSettingsInput, targetStore = store): void {
  const nextSecrets: Record<string, string> = {};
  const persistedProfiles = settings.profiles.map((profile) => {
    const apiKey = profile.config.apiKey?.trim();
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API Key 未保存。');
      nextSecrets[profile.id] = safeStorage.encryptString(apiKey).toString('base64');
    }
    const { apiKey: _apiKey, ...safeConfig } = profile.config;
    return { ...profile, config: safeConfig };
  });
  targetStore?.set('aiModelSettings', { defaultProfileId: settings.defaultProfileId, profiles: persistedProfiles });
  targetStore?.set('aiProfileSecrets', nextSecrets);
}

function readAiProfileSecrets(): Record<string, string> {
  const value = store?.get('aiProfileSecrets');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([id, encrypted]) => typeof encrypted === 'string' && encrypted.length <= 8_000 ? [[id, encrypted]] : []));
}

function decryptAiSecret(encrypted: string): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { return undefined; }
}

function resolveProfileApiKey(profile: AiModelProfile, previous: AiModelProfile | undefined): string | undefined {
  const entered = profile.config.apiKey?.trim();
  if (entered) return entered;
  if (!previous?.config.apiKey || previous.config.kind !== profile.config.kind) return undefined;
  const sameProvider = previous.config.provider === profile.config.provider;
  const sameEndpoint = previous.config.endpoint?.trim().replace(/\/+$/, '') === profile.config.endpoint?.trim().replace(/\/+$/, '');
  return sameProvider && sameEndpoint ? previous.config.apiKey : undefined;
}

function syncLegacyDefaultProfile(config: AiProviderConfig | undefined, targetStore = store): void {
  if (!config) return;
  const { apiKey, ...safeConfig } = config;
  targetStore?.set('aiProvider', safeConfig);
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API Key 未保存。');
    targetStore?.set('aiProviderSecret', safeStorage.encryptString(apiKey).toString('base64'));
  } else targetStore?.delete('aiProviderSecret');
}

const ownsApplicationInstance = app.requestSingleInstanceLock();
if (ownsApplicationInstance) documentOpenRouter.collect(process.argv, process.cwd(), app.isPackaged);
app.on('second-instance', (_event, argv, workingDirectory) => {
  documentOpenRouter.collect(argv, workingDirectory, app.isPackaged);
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
// 只读握手必须在迁移恢复时可用，才能先展示恢复对话框。
ipcMain.handle('startup:ready', async (event) => {
  assertInternalRenderer(event);
  await startupInitialization;
});
if (ownsApplicationInstance) app.whenReady().then(() => { startupInitialization = initAndCreate(); });
else app.quit();
app.on('will-quit', () => { appLogger.record('info', 'startup', 'APP_EXIT'); dataRootLocks.releaseAll(); });
let shutdownComplete = false;
let shutdownStarted = false;
app.on('before-quit', (event) => {
  if (shutdownComplete || !ownsApplicationInstance) return;
  if (mainWindow && !noteCloseCoordinator.allowed) {
    event.preventDefault();
    const window = mainWindow;
    void noteCloseCoordinator.request(window.webContents.id, (requestId) => window.webContents.send('notes:close-request', { requestId }), () => app.quit());
    return;
  }
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (dailySnapshotTimer) clearInterval(dailySnapshotTimer);
  noteAnalysisOrchestrator.shutdown();
  for (const controller of assistantTurnTasks.values()) controller.abort();
  for (const controller of selectionTransformTasks.values()) controller.abort();
  for (const controller of selectionExpansionTasks.values()) controller.abort();
  selectionExpansionTaskEmitters.clear();
  for (const orchestrator of qaMemoryOrchestrators.values()) orchestrator.shutdown();
  for (const service of memoryExtractionServices.values()) void service.stop();
  for (const service of memoryConsolidationServices.values()) void service.stop();
  for (const service of conversationSearchServices.values()) service.stop();
  void (async () => {
    await Promise.all([...memoryExtractionServices.values(), ...memoryConsolidationServices.values()].map(service => service.stop()));
    await vectorGenerationService?.shutdown();
    await Promise.all([workspaceBackupService?.shutdown(), workspaceRestoreService?.shutdown(), workspaceMigrationService?.shutdown()]);
    await pipelineOrchestrator?.shutdown();
    await indexCoordinator.stopWatching();
    const deadline = Date.now() + 10_000;
    while ([...memoryExtractionServices.values(), ...memoryConsolidationServices.values(), ...conversationSearchServices.values()].some(service => service.maintenanceBusy) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    qaMemoryDatabase.closeAll(); assistantMemoryDatabase.closeAll();
  })().catch(() => appLogger.record('warn', 'startup', 'SHUTDOWN_FAILED')).finally(() => { shutdownComplete = true; app.quit(); });
});

// IPC Handlers
function backupContext() {
  const workspacePath = getConfiguredWorkspacePath();
  const internal = (file: string) => { const relative = path.relative(workspacePath, file); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
  const exists = (file: string) => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
  return { workspacePath, sourceScope: { ...resolveActiveLongTermMemoryScope().scope }, sources: [...listRegisteredLibraries(store).map(library => ({ ...library, kind: 'note' as const, internal: internal(library.path), exists: exists(library.path) })), ...listMaterialsLibraries(store).map(library => ({ ...library, kind: 'materials' as const, internal: internal(library.path), exists: exists(library.path) }))], settings: safeBackupSettings(getAppPreferences(store) as unknown as Record<string, unknown>, store.get('aiModelSettings'), readParsingConfig(store), readModelHub(store)) };
}
function initializeWorkspaceBackupService(): void {
  workspaceRestoreService = new WorkspaceRestoreService({ userDataPath: app.getPath('userData'), version: APP_INFO.version,
    protectedRoots: () => [getConfiguredWorkspacePath(), ...listRegisteredLibraries(store).map(item => item.path), ...listMaterialsLibraries(store).map(item => item.path)],
    resolveTarget: workspacePath => new MemoryScopeResolver({ getActiveWorkspacePath: () => workspacePath, listRegisteredWorkspacePaths: () => [workspacePath], getPrincipalId: () => ensureLocalMemoryPrincipalId(store) }).resolveActive(),
    acquireRoots: roots => dataRootLocks.acquire(roots), onStatus: status => mainWindow?.webContents.send('restore:status', status),
    register: async (preview, workspacePath, settings) => {
      const now = new Date().toISOString();
      for (const kind of ['note', 'materials'] as const) {
        const existing = kind === 'note' ? listRegisteredLibraries(store) : listMaterialsLibraries(store);
        const additional = preview.manifest.registrations.filter(item => item.kind === kind).map(item => ({ path: path.join(preview.targetDirectory, 'roots', item.rootId, ...item.relativePath.split('/').filter(Boolean)), alias: item.alias, icon: item.icon ?? 'book', origin: item.origin ?? 'created', addedAt: now, lastOpenedAt: now }));
        store.set(kind === 'note' ? 'libraries' : 'materialsLibraries', [...existing, ...additional.filter(item => !existing.some(old => path.resolve(old.path) === path.resolve(item.path)))]);
      }
      const saved = store.get('restoredWorkspaces'); const workspaces = Array.isArray(saved) ? saved.filter(item => typeof item === 'string') as string[] : [];
      store.set('restoredWorkspaces', [...new Set([...workspaces, workspacePath])]);
      if (settings?.preferences && typeof settings.preferences === 'object') {
        const safe = safeBackupSettings(settings.preferences as Record<string, unknown>, undefined, { mineruEndpoint: '' });
        if (safe.preferences) saveAppPreferences(store, safe.preferences as Parameters<typeof saveAppPreferences>[1]);
      }
    },
  });
  if (!store.get('desktopBackup')) store.set('desktopBackup', { enabled: false, targetDirectory: '', externalLibraries: backupContext().sources.filter(source => source.exists && !source.internal).map(source => source.path) });
  workspaceBackupService = new WorkspaceBackupService({ store, userDataPath: app.getPath('userData'), version: APP_INFO.version, context: backupContext, capture: (signal, action) => maintenanceBarrier.capture(signal, action), acquireRoots: roots => dataRootLocks.acquire(roots), onStatus: status => mainWindow?.webContents.send('backup:status', status), onError: code => appLogger.record('warn', 'backup', code) });
  dailySnapshotTimer = setInterval(() => { if (maintenanceBarrier.phase === 'idle' && !workspaceRestoreService?.busy) void workspaceBackupService?.runDaily().catch(() => appLogger.record('warn', 'backup', 'DAILY_BACKUP_FAILED')); }, 60_000);
  dailySnapshotTimer.unref();
}
function requireBackupService(): WorkspaceBackupService { if (!workspaceBackupService) throw new Error('备份服务尚未就绪，请稍后重试。'); return workspaceBackupService; }
function desktopText(source: string, values: Record<string, string | number> = {}): string {
  const translated = (store?.get('appPreferences') as { language?: string } | undefined)?.language === 'en-US' ? workspaceMigrationEnglish[source] ?? desktopEnglish[source] ?? source : source;
  return translated.replace(/\{(\w+)\}/gu, (match, key: string) => String(values[key] ?? match));
}

const migrationConfigKeys = ['workspacePath', 'libraries', 'materialsLibraries', 'libraryPath', 'activeLibraryPath', 'activeMaterialsLibraryPath', 'appPreferences', 'onboarding', 'restoredWorkspaces', 'desktopBackup', 'workspaceMigrationCommit'] as const;

/** Release all old workspace memory owners before activation; the schema and memory algorithms stay unchanged. */
async function stopWorkspaceMemory(): Promise<void> {
  for (const service of memoryExtractionServices.values()) void service.stop();
  for (const service of memoryConsolidationServices.values()) void service.stop();
  for (const service of conversationSearchServices.values()) service.stop();
  for (const orchestrator of qaMemoryOrchestrators.values()) orchestrator.shutdown();
  await Promise.all([...memoryExtractionServices.values(), ...memoryConsolidationServices.values()].map(service => service.stop()));
  qaMemoryOrchestrators.clear(); qaMemoryDatabase.closeAll(); assistantMemoryDatabase.closeAll();
  memoryExtractionServices.clear(); conversationSearchServices.clear(); memoryRecallServices.clear(); memoryConsolidationServices.clear();
  if (mainWindow) assistantSessionScopeRegistry.releaseWindow(mainWindow.webContents.id);
}

async function activateWorkspaceRuntime(): Promise<void> {
  await stopWorkspaceMemory();
  qaMemoryDatabase.getDatabase(getConfiguredWorkspacePath());
  await initializeLibraryIndex();
}

function resumeWorkspaceBackground(): void {
  try {
    const scope = resolveActiveLongTermMemoryScope().scope;
    if (!isRestorePaused(getConfiguredWorkspacePath())) recoverCompletedExplicitMemories(qaMemoryDatabase, getConfiguredWorkspacePath(), scope);
    getMemoryExtractionService().start(); getConversationSearchService().start(scope);
  }
  catch (error) { logToWindow('[MEMORY] 工作区后台任务暂不可用：', getErrorMessage(error)); }
  pipelineOrchestrator?.resumeAfterMaintenance();
  for (const library of listMaterialsLibraries(store)) {
    pipelineOrchestrator?.recoverLibrary(library.path);
    void pipelineOrchestrator?.enqueuePending(library.path).catch(error => logToWindow('[PIPELINE] 工作区任务恢复失败：', getErrorMessage(error)));
  }
}

/** Preserve globals and external-library registrations; publish related path fields in one electron-store write. */
function migratedWorkspaceConfig(operationId: string, context: PhysicalRestoreContext): Record<string, unknown> {
  const map = (value: unknown) => typeof value === 'string' ? mapRestoredPath(value, context) : value;
  const registrations = (key: string) => {
    const values = store.get(key);
    return Array.isArray(values) ? values.map(item => ({ ...item, path: map(item.path) })) : [];
  };
  const preferences = store.get('appPreferences') ?? {}, onboarding = store.get('onboarding'), backup = store.get('desktopBackup');
  return {
    workspacePath: context.target.workspacePath,
    libraries: registrations('libraries'), materialsLibraries: registrations('materialsLibraries'),
    libraryPath: map(store.get('libraryPath')) ?? null, activeLibraryPath: map(store.get('activeLibraryPath')) ?? null,
    activeMaterialsLibraryPath: map(store.get('activeMaterialsLibraryPath')) ?? null,
    appPreferences: { ...preferences, ...(preferences.lastOpenedNote ? { lastOpenedNote: map(preferences.lastOpenedNote) } : {}) },
    onboarding: onboarding ? { ...onboarding, ...(onboarding.practice ? { practice: { ...onboarding.practice, libraryPath: map(onboarding.practice.libraryPath) } } : {}) } : null,
    restoredWorkspaces: Array.isArray(store.get('restoredWorkspaces')) ? store.get('restoredWorkspaces').map(map) : [],
    desktopBackup: backup ? { ...backup, externalLibraries: Array.isArray(backup.externalLibraries) ? backup.externalLibraries.map(map) : [] } : null,
    workspaceMigrationCommit: operationId,
  };
}

function initializeWorkspaceMigrationService(): void {
  workspaceMigrationService = new WorkspaceMigrationService({
    userDataPath: app.getPath('userData'),
    context: () => { const context = backupContext(); return { workspacePath: context.workspacePath, scope: context.sourceScope, libraries: context.sources.map(({ path, alias, kind, internal }) => ({ path, alias, kind, internal })) }; },
    config: () => Object.fromEntries(migrationConfigKeys.map(key => [key, store.get(key) ?? null])),
    resolveTarget: workspacePath => new MemoryScopeResolver({ getActiveWorkspacePath: () => workspacePath, listRegisteredWorkspacePaths: () => [workspacePath], getPrincipalId: () => ensureLocalMemoryPrincipalId(store) }).resolveActive(),
    capture: (signal, action) => maintenanceBarrier.capture(signal, action),
    reserveTarget: target => dataRootLocks.reserve([target]), releaseTarget: target => dataRootLocks.releaseReservation(target),
    commit: async (id, context) => {
      await stopWorkspaceMemory(); dataRootLocks.acquire([context.target.workspacePath, ...context.libraries.map(library => library.target)]);
      store.set(migratedWorkspaceConfig(id, context));
      pipelineOrchestrator?.rebindWorkspace(context.roots[0].source, context.target.workspacePath);
    },
    rollback: async previous => {
      const failedPath = getConfiguredWorkspacePath();
      if (typeof previous.workspacePath !== 'string' || !fs.existsSync(previous.workspacePath)) throw new Error('原位置暂不可用，请检查原目录后重试。');
      const libraries = [previous.libraries, previous.materialsLibraries].flatMap(value => Array.isArray(value) ? value : []).flatMap(value => typeof value?.path === 'string' && fs.existsSync(value.path) ? [value.path] : []);
      // Restart after config publication owns only the new roots; reclaim the original leases before rollback.
      dataRootLocks.acquire([previous.workspacePath, ...libraries]);
      await stopWorkspaceMemory(); store.set(previous);
      pipelineOrchestrator?.pauseForMaintenance(); pipelineOrchestrator?.rebindWorkspace(failedPath, getConfiguredWorkspacePath());
      await initializeLibraryIndex();
    },
    activate: activateWorkspaceRuntime,
    onStatus: status => mainWindow?.webContents.send('workspace-migration:status', status),
  });
}

function requireMigrationService(): WorkspaceMigrationService {
  if (!workspaceMigrationService) throw new Error('数据迁移服务尚未就绪。');
  return workspaceMigrationService;
}

registerAppHandler('workspace-migration:get-state', event => { assertInternalRenderer(event); return requireMigrationService().state(); });
registerAppHandler('workspace-migration:preview', async event => {
  assertInternalRenderer(event);
  if (!mainWindow || workspaceBackupService?.busy || workspaceRestoreService?.busy) throw new Error('请等待备份或恢复结束后再迁移。');
  const result = await dialog.showOpenDialog(mainWindow, { title: desktopText('选择新的数据存储位置：请选择空文件夹'), properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : requireMigrationService().preview(result.filePaths[0]);
});
registerAppHandler('workspace-migration:start', async (event, id: string) => {
  assertInternalRenderer(event);
  if (workspaceBackupService?.busy || workspaceRestoreService?.busy) throw new Error('请等待备份或恢复结束后再迁移。');
  const result = await requireMigrationService().start(id);
  if (result.phase === 'completed') resumeWorkspaceBackground();
  return result;
});
registerAppHandler('workspace-migration:cancel', event => { assertInternalRenderer(event); requireMigrationService().cancel(); });
registerAppHandler('workspace-migration:abandon', async (event, id: string) => {
  assertInternalRenderer(event); const pending = requireMigrationService().recoveryPending; await requireMigrationService().abandon(id);
  if (pending) { await activateWorkspaceRuntime(); resumeWorkspaceBackground(); }
});
registerAppHandler('workspace-migration:open-folder', event => { assertInternalRenderer(event); return shell.openPath(getConfiguredWorkspacePath()); });
registerAppHandler('workspace-migration:open-existing', async event => {
  assertInternalRenderer(event);
  if (!mainWindow || workspaceBackupService?.busy || workspaceRestoreService?.busy || requireMigrationService().busy || requireMigrationService().recoveryPending) throw new Error('请先完成当前迁移、备份或恢复。');
  const result = await dialog.showOpenDialog(mainWindow, { title: desktopText('打开已有工作区'), properties: ['openDirectory'] });
  if (result.canceled) return null;
  const selected = path.resolve(result.filePaths[0]);
  if (!fs.existsSync(path.join(selected, '.menghan-workspace')) && !fs.existsSync(path.join(selected, 'ConversationMemory'))) throw new Error('所选文件夹不是已有工作区。更换存储位置请使用迁移功能。');
  const previous = getConfiguredWorkspacePath();
  await maintenanceBarrier.capture(new AbortController().signal, async () => {
    try { await stopWorkspaceMemory(); setConfiguredWorkspacePath(selected); await activateWorkspaceRuntime(); }
    catch (error) { store.set('workspacePath', previous); await activateWorkspaceRuntime(); throw error; }
  });
  resumeWorkspaceBackground(); return selected;
});
registerAppHandler('backup:get-status', () => requireBackupService().status());
registerAppHandler('backup:configure', (_event, config: Pick<BackupConfiguration, 'enabled' | 'targetDirectory' | 'externalLibraries'>) => { if (workspaceRestoreService?.busy) throw new Error('请等待恢复任务结束。'); return requireBackupService().configure(config); });
registerAppHandler('backup:start', (_event, request?: { targetDirectory?: string; externalLibraries?: string[] }) => { if (workspaceRestoreService?.busy) throw new Error('请等待恢复任务结束。'); return requireBackupService().start(request); });
registerAppHandler('restore:pending', () => workspaceRestoreService?.pending() ?? []);
registerAppHandler('restore:preview', async (event) => {
  assertInternalRenderer(event); if (!mainWindow || !workspaceRestoreService || requireBackupService().busy) return null;
  const archive = await dialog.showOpenDialog(mainWindow, { title: desktopText('选择完整备份'), filters: [{ name: desktopText('Trellora 完整备份'), extensions: ['zip'] }], properties: ['openFile'] }); if (archive.canceled) return null;
  const parent = await dialog.showOpenDialog(mainWindow, { title: desktopText('选择恢复父目录：将创建独立的新目录'), properties: ['openDirectory', 'createDirectory'] }); if (parent.canceled) return null;
  return workspaceRestoreService.preview(archive.filePaths[0], parent.filePaths[0]);
});
registerAppHandler('restore:start', (event, id: string, importPreferences: boolean) => { assertInternalRenderer(event); if (!workspaceRestoreService || requireBackupService().busy || maintenanceBarrier.phase !== 'idle') throw new Error('请等待当前备份任务结束。'); return workspaceRestoreService.start(id, importPreferences); });
registerAppHandler('restore:cancel', () => workspaceRestoreService?.cancel());
registerAppHandler('restore:open', async (event, workspacePath: string) => {
  if (workspaceRestoreService?.busy || requireBackupService().busy) throw new Error('请等待备份或恢复任务结束。');
  assertInternalRenderer(event); const registered = store.get('restoredWorkspaces'); if (!Array.isArray(registered) || !registered.includes(workspacePath)) throw new Error('恢复工作区尚未登记。');
  await maintenanceBarrier.capture(new AbortController().signal, async () => {
    for (const service of memoryExtractionServices.values()) void service.stop();
  for (const service of memoryConsolidationServices.values()) void service.stop(); for (const service of conversationSearchServices.values()) service.stop();
    for (const orchestrator of qaMemoryOrchestrators.values()) orchestrator.shutdown(); qaMemoryOrchestrators.clear();
    await Promise.all([...memoryExtractionServices.values(), ...memoryConsolidationServices.values()].map(service => service.stop()));
    qaMemoryDatabase.closeAll(); assistantMemoryDatabase.closeAll(); memoryExtractionServices.clear(); conversationSearchServices.clear(); memoryRecallServices.clear(); memoryConsolidationServices.clear();
    setConfiguredWorkspacePath(workspacePath);
  });
  return workspacePath;
});
registerAppHandler('restore:paused', () => [getConfiguredWorkspacePath(), ...listRegisteredLibraries(store).map(item => item.path), ...listMaterialsLibraries(store).map(item => item.path)].filter(isRestorePaused));
registerAppHandler('restore:connection-hints', () => {
  const workspacePath = getConfiguredWorkspacePath(); const file = assertInsideDirectory(path.join(workspacePath, '.menghan-meta', 'restored-connections.json'), workspacePath);
  if (!fs.existsSync(file) || fs.statSync(file).size > 1024 ** 2) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); const safe = safeBackupSettings({}, raw.aiModelSettings, { mineruEndpoint: typeof raw.parsing?.mineruEndpoint === 'string' ? raw.parsing.mineruEndpoint : '' }, raw.modelHub);
  return { aiModelSettings: safe.aiModelSettings, modelHub: safe.modelHub, parsing: safe.parsing };
});
registerAppHandler('restore:resume', async (event) => {
  if (maintenanceBarrier.phase !== 'idle' || workspaceRestoreService?.busy || requireBackupService().busy) throw new Error('请等待备份或恢复任务结束。');
  assertInternalRenderer(event); if (!mainWindow) return false;
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: desktopText('恢复后台处理'), message: desktopText('恢复的任务会重新执行本地处理及已配置的远程模型请求，可能产生费用。PDF 云解析仍需按文档重新确认上传。'), buttons: ['继续暂停', '恢复后台处理'].map(value => desktopText(value)), defaultId: 0, cancelId: 0 }); if (result.response !== 1) return false;
  for (const root of [getConfiguredWorkspacePath(), ...listRegisteredLibraries(store).map(item => item.path), ...listMaterialsLibraries(store).map(item => item.path)]) if (isRestorePaused(root)) { dataRootLocks.acquire([root]); clearRestorePause(root); }
  const memoryScope = resolveActiveLongTermMemoryScope().scope;
  recoverCompletedExplicitMemories(qaMemoryDatabase, getConfiguredWorkspacePath(), memoryScope);
  getMemoryExtractionService().start(); getConversationSearchService().start(memoryScope);
  for (const library of listMaterialsLibraries(store)) void pipelineOrchestrator?.enqueuePending(library.path); return true;
});
registerAppHandler('backup:cancel', () => requireBackupService().cancel());
registerAppHandler('backup:choose-target', async () => { if (!mainWindow) return null; const result = await dialog.showOpenDialog(mainWindow, { title: desktopText('选择独立的备份目录'), properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
const releaseChecker = new ReleaseChecker({ repositoryUrl: APP_INFO.repositoryUrl, version: APP_INFO.version });
registerAppHandler('release:check', () => releaseChecker.check());
registerAppHandler('ping', () => 'pong');
ipcMain.on('external-web-navigation', handleExternalWebNavigation);
registerAppHandler('editor:read-clipboard-content', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const image = clipboard.readImage();
  const bytes = image.isEmpty() ? undefined : image.toPNG();
  if (bytes && bytes.length > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB。');
  return { text: clipboard.readText(), html: clipboard.readHTML(), ...(bytes ? { imagePng: new Uint8Array(bytes) } : {}) };
});
registerAppHandler('editor:read-clipboard-text', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  return clipboard.readText();
});
registerAppHandler('editor:add-spellchecker-word', (event: IpcMainInvokeEvent, input: unknown) => {
  assertInternalRenderer(event);
  if (typeof input !== 'string') return false;
  const word = input.trim();
  if (!word || word.length > 80 || /\s/u.test(word)) return false;
  return event.sender.session.addWordToSpellCheckerDictionary(word);
});

registerAppHandler('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return path.resolve(result.filePaths[0]);
  }
  return null;
});

registerAppHandler('select-workspace', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择系统工作区',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return setConfiguredWorkspacePath(result.filePaths[0]);
});

registerAppHandler('get-workspace-path', () => getConfiguredWorkspacePath());

/** Inspect persisted usage before creating defaults; preferences alone are not prior use. */
function hasOnboardingUsage(): boolean {
  if (listRegisteredLibraries(store).length || listMaterialsLibraries(store).length) return true;
  if (readAiModelSettingsInput().profiles.some(profile => Boolean(profile.config.model?.trim())
    && (profile.config.kind === 'ollama' || Boolean(profile.config.apiKey && profile.config.remoteContentConsent)))) return true;
  const workspace = getConfiguredWorkspacePath();
  if (fs.existsSync(path.join(workspace, 'ConversationMemory', 'qa-memory.db'))) {
    try { return Boolean(qaMemoryDatabase.getDatabase(workspace).prepare('SELECT 1 FROM qa_turns LIMIT 1').get()); }
    catch { return true; } // A damaged existing history is still an existing user's data.
  }
  return false;
}

/** One local-profile service owns progress; it never writes to a selected library. */
function initializeOnboarding(): OnboardingService {
  if (!onboardingService) onboardingService = new OnboardingService({
    read: () => store.get('onboarding'), write: progress => store.set('onboarding', progress),
    hasUsage: hasOnboardingUsage, profiles: () => readAiModelSettingsInput().profiles,
    defaultProfileId: () => readAiModelSettingsInput().defaultProfileId,
    paths: () => { const libraryPath = getCurrentLibraryPath(); return { workspacePath: getConfiguredWorkspacePath(), libraryPath: libraryPath && fs.existsSync(libraryPath) ? libraryPath : null }; },
    notify: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('onboarding-state-changed', state); },
  });
  onboardingService.get();
  return onboardingService;
}

function getOnboardingState(): OnboardingState { return initializeOnboarding().get(); }
registerAppHandler('onboarding:get', (event) => { assertInternalRenderer(event); return getOnboardingState(); });
registerAppHandler('onboarding:update', (event, input: OnboardingUpdate) => { assertInternalRenderer(event); return initializeOnboarding().update(input); });
registerAppHandler('onboarding:select-profile', (event, profileId: unknown) => {
  assertInternalRenderer(event);
  if (typeof profileId !== 'string' || !profileId.trim() || profileId.length > 128) throw new Error('模型连接标识无效。');
  return initializeOnboarding().selectProfile(profileId);
});
registerAppHandler('onboarding:invalidate-connection', (event, profileId: unknown) => {
  assertInternalRenderer(event);
  if (typeof profileId !== 'string' || profileId.length > 128) throw new Error('模型连接标识无效。');
  return initializeOnboarding().invalidateDraft(profileId);
});
registerAppHandler('onboarding:bind-practice', (event, input: OnboardingPracticeBinding) => {
  assertInternalRenderer(event);
  if (!input || typeof input.sessionId !== 'string' || typeof input.profileId !== 'string') throw new Error('练习会话参数无效。');
  const detail = getQaMemoryOrchestrator().repository.getSession(input.sessionId);
  const state = getOnboardingState();
  const resuming = state.practiceSessionId === input.sessionId && state.selectedProfileId === input.profileId;
  if (detail.session.scope !== 'chat' || (!resuming && (detail.session.turnCount || detail.turns.length))) throw new Error('请新建一个空白开放式练习会话。');
  return initializeOnboarding().bindPractice(event.sender.id, input);
});
registerAppHandler('onboarding:save', (event, status: string) => {
  assertInternalRenderer(event);
  if (!['skipped', 'completed'].includes(status)) throw new Error('引导状态无效。');
  const state = getOnboardingState();
  return initializeOnboarding().update({ action: status === 'skipped' ? 'defer' : 'finish', expectedRevision: state.revision });
});
registerAppHandler('onboarding:import-sample', async (event) => {
  assertInternalRenderer(event);
  const libraryPath = requireCurrentLibraryPath();
  const imported = await noteSaveService.structure(libraryPath, () => indexCoordinator.mutate(() => {
    const paths: string[] = [];
    for (const sample of ONBOARDING_SAMPLES) {
      const target = assertInsideDirectory(path.join(libraryPath, sample.name), libraryPath);
      try { fs.writeFileSync(target, sample.content, { encoding: 'utf8', flag: 'wx' }); paths.push(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return { value: paths, changes: paths.map(file => ({ kind: 'add' as const, path: file })) };
  }));
  initializeOnboarding().sampleImported();
  return imported;
});

registerAppHandler('list-libraries', async () => {
  const activePath = getCurrentLibraryPath();
  return summarizeRegisteredLibraries(store, activePath);
});

registerAppHandler('add-library', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return activateLibraryPath(result.filePaths[0], true);
});

registerAppHandler('create-library', async (_event, name: string, parentDirectoryPath?: string | null) => {
  if (typeof name !== 'string' || !name.trim()) throw new Error('请输入笔记库名称。');
  if (parentDirectoryPath !== undefined && parentDirectoryPath !== null && typeof parentDirectoryPath !== 'string') {
    throw new Error('笔记库存放位置无效。');
  }
  const created = createLibraryDirectory({
    name,
    workspacePath: getConfiguredWorkspacePath(),
    parentDirectoryPath,
  });
  return activateLibraryPath(created.path, true, created.alias);
});

registerAppHandler('activate-library', async (_event, libraryPath: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('笔记库路径无效。');
  return activateLibraryPath(libraryPath);
});

registerAppHandler('remove-library', async (_event, libraryPath: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('笔记库路径无效。');
  const normalizedPath = path.resolve(libraryPath);
  const wasActive = getCurrentLibraryPath() === normalizedPath;
  const remove = async () => {
    if (wasActive) {
      await indexCoordinator.stopWatching();
      noteIndex = null;
      if (miniSearch) miniSearch.removeAll();
    }
    removeRegisteredLibrary(store, normalizedPath);
    return summarizeRegisteredLibraries(store, getCurrentLibraryPath());
  };
  return wasActive ? noteSaveService.structure(normalizedPath, remove) : remove();
});

// 资料库（只读文档集合，未来接入 sqlite-vec 向量化）
registerAppHandler('list-materials-libraries', () => summarizeMaterialsLibraries(store));

registerAppHandler('create-materials-library', (_event, name: string, icon?: string | null, chunkingConfigDraft?: unknown) => {
  if (typeof name !== 'string' || !name.trim()) throw new Error('请输入资料库名称。');
  const root = ensureMaterialsRoot(getConfiguredWorkspacePath());
  const created = createMaterialsLibraryDirectory(root, name, new Date(), chunkingConfigDraft);
  try {
    ensureMaterialsMeta(created.path);
    registerMaterialsLibrary(store, created.path, created.alias, 'created', typeof icon === 'string' ? icon : undefined);
  } catch (error) {
    if (fs.existsSync(created.path)) fs.rmSync(created.path, { recursive: true, force: true });
    throw error;
  }
  return created.path;
});

registerAppHandler('open-materials-library', (_event, libraryPath: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('资料库路径无效。');
  const targetPath = activateMaterialsLibrary(store, libraryPath);
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 自动入队失败：${error instanceof Error ? error.message : String(error)}`));
  return targetPath;
});

registerAppHandler('rename-materials-library', (_event, libraryPath: string, alias: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('资料库路径无效。');
  if (typeof alias !== 'string' || !alias.trim()) throw new Error('请输入资料库名称。');
  return renameMaterialsLibrary(store, libraryPath, alias);
});

registerAppHandler('remove-materials-library', (_event, libraryPath: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('资料库路径无效。');
  removeMaterialsLibrary(store, libraryPath);
  return summarizeMaterialsLibraries(store);
});

registerAppHandler('delete-materials-library', async (_event, libraryPath: string) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('资料库路径无效。');
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  await shell.trashItem(targetPath);
  removeMaterialsLibrary(store, targetPath);
  return summarizeMaterialsLibraries(store);
});

registerAppHandler('upgrade-library-to-materials', (_event, libraryPath: string, icon?: string | null, chunkingConfigDraft?: unknown) => {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) throw new Error('笔记库路径无效。');
  upgradeRegisteredLibraryToMaterials(
    store,
    libraryPath,
    getConfiguredWorkspacePath(),
    typeof icon === 'string' ? icon : undefined,
    new Date(),
    chunkingConfigDraft,
  );
  return summarizeMaterialsLibraries(store);
});

registerAppHandler('list-materials-documents', (_event, libraryPath: string) => {
  return listMaterialsDocuments(requireRegisteredMaterialsLibrary(libraryPath));
});

registerAppHandler('get-materials-pipeline-status', (_event, libraryPath: string): PipelineDocumentStatus[] => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (!pipelineOrchestrator) return [];
  // Status reads must not mutate persisted stage state. Startup recovery owns
  // the one-time RUNNING -> INTERRUPTED transition after a real app restart.
  return pipelineOrchestrator.getStatuses(targetPath);
});

async function readCurrentWikiDocumentOutline(targetPath: string, documentId: string): Promise<WikiDocumentOutline> {
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('Wiki 文档标识无效。');
  const document = findMaterialsDocument(targetPath, documentId);
  if (!document) throw new Error('找不到要打开的 Wiki 文档。');
  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');

  const layout = pipelineOrchestrator.getCurrentLayout(targetPath, document);
  const manifest = readPipelineManifest(layout);
  const treeStage = manifest?.stages.tree;
  if (!treeStage || treeStage.status !== 'SUCCEEDED' || !isStageManifestCurrent(layout, 'tree')) {
    throw new Error('该文档的结构树索引尚未完成或已经过期，请先在资料库完成处理。');
  }
  const output = treeStage.outputs?.['structure.jsonl'];
  if (!output) throw new Error('结构树清单不完整，请重新处理该文档。');
  const structurePath = assertInsideDirectory(path.join(stageDirectory(layout, 'tree'), 'structure.jsonl'), targetPath);
  const markdownPath = assertInsideDirectory(path.join(stageDirectory(layout, 'parse'), 'document.md'), targetPath);
  const lineLayoutPath = assertInsideDirectory(path.join(stageDirectory(layout, 'parse'), 'line-layout.jsonl'), targetPath);
  try {
    await assertArtifactPreviewIntegrity(structurePath, output);
  } catch {
    throw new Error('结构树产物已变化或损坏，请重新处理该文档。');
  }
  return readWikiDocumentOutline({
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    structurePath,
    markdownPath,
    lineLayoutPath,
    updatedAt: treeStage.updatedAt,
  });
}

registerAppHandler('get-wiki-document-outline', async (_event, libraryPath: string, documentId: string): Promise<WikiDocumentOutline> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const outline = await readCurrentWikiDocumentOutline(targetPath, documentId);
  return mergeWikiDerivedNodes(targetPath, applyWikiSiblingOrderOverrides(targetPath, outline));
});

// 来源和目标库都由主进程校验，只读取完整解析产物，不使用可能被截断的 Wiki 节点预览。
registerAppHandler('wiki:import-to-note-library', async (event, sourceLibraryPath: string, documentId: string, contentHash: string, targetLibraryPath: string): Promise<string> => {
  assertNoteWindow(event);
  const sourcePath = requireRegisteredMaterialsLibrary(sourceLibraryPath);
  const targetPath = requireRegisteredNoteLibrary(targetLibraryPath);
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('Wiki 文档标识无效。');
  const document = findMaterialsDocument(sourcePath, documentId);
  if (!document) throw new Error('找不到要打开的 Wiki 来源文档。');
  if (typeof contentHash !== 'string' || document.contentHash !== contentHash) throw new Error('来源文档已变化，请重新打开 Wiki 文档后再试。');
  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  const layout = pipelineOrchestrator.getCurrentLayout(sourcePath, document);
  const parseStage = readPipelineManifest(layout)?.stages.parse;
  if (parseStage?.status !== 'SUCCEEDED' || !isStageManifestCurrent(layout, 'parse')) {
    throw new Error('文档解析产物尚未完成或已经过期，请先在资料库完成处理。');
  }
  const parseDirectory = assertInsideDirectory(stageDirectory(layout, 'parse'), sourcePath);
  for (const fileName of ['document.md', 'line-layout.jsonl', 'images-manifest.json']) {
    const output = parseStage.outputs?.[fileName];
    if (!output) throw new Error('文档解析产物不完整，请先重新处理文档。');
    await assertArtifactPreviewIntegrity(assertInsideDirectory(path.join(parseDirectory, fileName), sourcePath), output);
  }
  return noteSaveService.structure(targetPath, async () => {
    const create = async () => importWikiDocumentAsNote({ sourceLibraryPath: sourcePath, targetLibraryPath: targetPath,
      documentId, contentHash, documentName: document.name, parseDirectory });
    if (getCurrentLibraryPath() !== targetPath) return (await create()).path;
    return indexCoordinator.mutate(async () => {
      const note = await create();
      return { value: note.path, changes: note.created ? [{ kind: 'add' as const, path: note.path }] : [] };
    });
  });
});

registerAppHandler('reorder-wiki-sibling-nodes', async (
  _event,
  libraryPath: string,
  request: WikiSiblingOrderRequest,
): Promise<WikiSiblingOrderResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_ORDER_INVALID', message: '章节排序请求无效。' } };
    }
    const outline = await readCurrentWikiDocumentOutline(targetPath, request.documentId);
    return reorderWikiSiblingNodes({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_ORDER_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

/**
 * 新增派生节点（方案 §6）：先读取并合并现有派生节点的目录，校验父节点存在后落库。
 * 只写 `.menghan-meta/wiki/`，绝不修改用户原始文件。
 */
registerAppHandler('wiki:add-derived-node', async (
  _event,
  libraryPath: string,
  request: WikiDerivedNodeRequest,
): Promise<WikiDerivedNodeResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_DERIVED_INVALID', message: '派生节点请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await addWikiDerivedNode({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_DERIVED_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

/** 重命名派生节点；来源章节受保护不可改名。 */
registerAppHandler('wiki:rename-derived-node', async (
  _event,
  libraryPath: string,
  request: WikiDerivedRenameRequest,
): Promise<WikiDerivedNodeResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_DERIVED_INVALID', message: '派生节点请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await renameWikiDerivedNode({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_DERIVED_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

/** 删除派生节点（级联全部后代）；来源章节受保护不可删。 */
registerAppHandler('wiki:delete-derived-node', async (
  _event,
  libraryPath: string,
  request: WikiDerivedDeleteRequest,
): Promise<WikiDerivedDeleteResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_DERIVED_INVALID', message: '派生节点请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await deleteWikiDerivedNode({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_DERIVED_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

/**
 * Wiki AI 记忆：会话只写入资料库的 `.menghan-meta/wiki/`，不修改用户原始文件。
 * 每次读取都先重新确认当前结构树，源资料变化后旧记忆会随 contentHash 自动失效。
 */
registerAppHandler('wiki:list-ai-memories', async (
  _event,
  libraryPath: string,
  documentId: string,
): Promise<WikiAiMemoryListResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, documentId)),
    );
    return { ok: true, memories: listWikiAiMemories(targetPath, outline) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

registerAppHandler('wiki:upsert-ai-memory', async (
  _event,
  libraryPath: string,
  request: WikiAiMemoryUpsertRequest,
): Promise<WikiAiMemoryResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_MEMORY_INVALID', message: 'Wiki AI 记忆请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await upsertWikiAiMemory({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

registerAppHandler('wiki:create-ai-memory', async (
  _event,
  libraryPath: string,
  request: WikiAiMemoryCreateRequest,
): Promise<WikiAiMemoryResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string' || typeof request.nodeId !== 'string') {
      return { ok: false, error: { code: 'WIKI_MEMORY_INVALID', message: '新建 Wiki AI 对话请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await createWikiAiMemory({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

registerAppHandler('wiki:rename-ai-memory', async (
  _event,
  libraryPath: string,
  request: WikiAiMemoryRenameRequest,
): Promise<WikiAiMemoryResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_MEMORY_INVALID', message: 'Wiki AI 记忆请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await renameWikiAiMemory({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

registerAppHandler('wiki:set-ai-memory-pinned', async (
  _event,
  libraryPath: string,
  request: WikiAiMemoryPinRequest,
): Promise<WikiAiMemoryResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string' || typeof request.pinned !== 'boolean') {
      return { ok: false, error: { code: 'WIKI_MEMORY_INVALID', message: 'Wiki AI 记忆置顶请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await setWikiAiMemoryPinned({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

registerAppHandler('wiki:delete-ai-memory', async (
  _event,
  libraryPath: string,
  request: WikiAiMemoryDeleteRequest,
): Promise<WikiAiMemoryDeleteResult> => {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (!request || typeof request !== 'object' || typeof request.documentId !== 'string') {
      return { ok: false, error: { code: 'WIKI_MEMORY_INVALID', message: 'Wiki AI 记忆请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, request.documentId)),
    );
    return await deleteWikiAiMemory({ libraryPath: targetPath, outline, request });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_MEMORY_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
});

/**
 * 节点建议问题解析（方案 §7.3）：读取并合并派生节点的目录后，定位目标章节，
 * 装配节点路径/子标题/正文，解析当前模型档案后调用 `resolveWikiNodeQuestions`。
 * 生成为最佳努力：模型未配置/来源过期等硬错误返回 ok:false，UI 静默映射为 degraded。
 */
async function resolveWikiNodeQuestionsViaIpc(
  libraryPath: string,
  documentId: string,
  nodeId: string,
  refresh: boolean,
): Promise<WikiNodeQuestionsResult> {
  try {
    const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
    if (typeof documentId !== 'string' || !documentId.trim() || typeof nodeId !== 'string' || !nodeId.trim()) {
      return { ok: false, error: { code: 'WIKI_QUESTIONS_INVALID', message: '节点建议问题请求无效。' } };
    }
    const outline = mergeWikiDerivedNodes(
      targetPath,
      applyWikiSiblingOrderOverrides(targetPath, await readCurrentWikiDocumentOutline(targetPath, documentId)),
    );
    const node = findWikiNode(outline.nodes, nodeId);
    if (!node) {
      return { ok: false, error: { code: 'WIKI_QUESTIONS_NODE_NOT_FOUND', message: '找不到目标章节，请重新加载文档后再试。' } };
    }
    let profile: AiModelProfile;
    try {
      profile = resolveAssistantProfile(undefined);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'WIKI_QUESTIONS_MODEL_UNAVAILABLE',
          message: '尚未配置可用的 AI 模型，无法生成建议问题。',
          diagnostic: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const model = await getAssistantModel(profile.config);
    const effectiveContextWindow = await resolveAssistantContextWindow(profile.config, model);
    const outcome = await resolveWikiNodeQuestions({
      libraryPath: targetPath,
      documentId,
      nodeId,
      contentHash: outline.contentHash,
      nodeTitle: node.title,
      nodePath: formatWikiNodePath(getWikiNodeBreadcrumb(outline.nodes, nodeId)),
      childTitles: collectWikiChildNodes(outline.nodes, nodeId).map((child) => child.title),
      nodeMarkdown: node.markdown ?? '',
      model,
      providerConfig: profile.config,
      contextWindowTokens: effectiveContextWindow.tokens,
      refresh,
    });
    return { ok: true, questions: outcome.questions, degraded: outcome.degraded, fromCache: outcome.fromCache };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WIKI_QUESTIONS_SOURCE_STALE',
        message: '当前章节结构已变化或不可用，请重新加载文档后再试。',
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** 命中缓存直接返回；未命中同步生成（最佳努力，失败返回 degraded）。 */
registerAppHandler('wiki:get-node-questions', async (
  _event,
  libraryPath: string,
  documentId: string,
  nodeId: string,
): Promise<WikiNodeQuestionsResult> => resolveWikiNodeQuestionsViaIpc(libraryPath, documentId, nodeId, false));

/** 忽略缓存重新生成并写回（节点右键「重新生成建议问题」）。 */
registerAppHandler('wiki:refresh-node-questions', async (
  _event,
  libraryPath: string,
  documentId: string,
  nodeId: string,
): Promise<WikiNodeQuestionsResult> => resolveWikiNodeQuestionsViaIpc(libraryPath, documentId, nodeId, true));

registerAppHandler('get-pipeline-artifact-preview', async (_event, libraryPath: string, documentId: string, stage: string, fileName: string, offset?: number, limit?: number, parentChunkId?: string): Promise<PipelineArtifactPreview> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('资料文档标识无效。');
  if (!isPipelineStageId(stage)) throw new Error('流水线阶段无效。');
  if (typeof fileName !== 'string' || !fileName.trim()) throw new Error('产物文件名无效。');
  const normalizedParentChunkId = normalizeArtifactPreviewParentChunkId(parentChunkId);
  if (normalizedParentChunkId && (stage !== 'chunks' || fileName !== 'children.jsonl')) {
    throw new Error('父块过滤只允许读取 children.jsonl。');
  }
  const document = findMaterialsDocument(targetPath, documentId);
  if (!document) throw new Error('找不到要预览的资料文档。');

  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  const layout = pipelineOrchestrator.getCurrentLayout(targetPath, document);
  const manifest = readPipelineManifest(layout);
  const stageManifest = manifest?.stages[stage];
  if (!stageManifest || stageManifest.status !== 'SUCCEEDED') {
    throw new Error('该阶段尚未完成，暂时没有可预览的正式产物。');
  }
    if (!isStageOutputAllowed(layout, stage, fileName)) {
    throw new Error('不允许预览该阶段之外的文件。');
  }
  const output = stageManifest.outputs?.[fileName];
  if (!output) throw new Error('阶段清单中找不到该产物。');
  const artifactPath = path.join(stageDirectory(layout, stage), fileName);
  const safeArtifactPath = assertInsideDirectory(artifactPath, targetPath);
  if (!fs.existsSync(safeArtifactPath) || !fs.statSync(safeArtifactPath).isFile()) {
    throw new Error('阶段产物文件不存在，可能需要重新处理该阶段。');
  }
  const stat = fs.statSync(safeArtifactPath);
  if (stat.size !== output.bytes) throw new Error('阶段产物已变化，缓存校验未通过，请重新处理该阶段。');
  return readArtifactPreview(safeArtifactPath, {
    documentId,
    stage,
    fileName,
    relativePath: path.relative(targetPath, safeArtifactPath).replace(/\\/g, '/'),
    bytes: output.bytes,
    sha256: output.sha256,
    offset,
    limit,
    parentChunkId: normalizedParentChunkId,
  });
});

registerAppHandler('get-pipeline-keyword-preview', async (_event, libraryPath: string, documentId: string, offset?: number, limit?: number): Promise<PipelineKeywordPreview> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('资料文档标识无效。');
  const document = findMaterialsDocument(targetPath, documentId);
  if (!document) throw new Error('找不到要预览的资料文档。');

  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  const layout = pipelineOrchestrator.getCurrentLayout(targetPath, document);
  const manifest = readPipelineManifest(layout);
  const keywordStage = manifest?.stages.keywords;
  const chunksStage = manifest?.stages.chunks;
  if (keywordStage?.status !== 'SUCCEEDED' || chunksStage?.status !== 'SUCCEEDED') {
    throw new Error('关键词阶段尚未完成，暂时没有可定位的关键词产物。');
  }

  const keywordFileName = 'keywords.jsonl';
  const chunksFileName = 'chunks.jsonl';
  if (!stageOutputNames(layout, 'keywords').includes(keywordFileName) || !stageOutputNames(layout, 'chunks').includes(chunksFileName)) {
    throw new Error('关键词预览产物不可用，请重新处理文档。');
  }
  const keywordOutput = keywordStage.outputs?.[keywordFileName];
  const chunksOutput = chunksStage.outputs?.[chunksFileName];
  if (!keywordOutput || !chunksOutput) throw new Error('关键词预览产物清单不完整，请重新处理文档。');

  const keywordPath = assertInsideDirectory(path.join(stageDirectory(layout, 'keywords'), keywordFileName), targetPath);
  const chunksPath = assertInsideDirectory(path.join(stageDirectory(layout, 'chunks'), chunksFileName), targetPath);
  for (const [filePath, output] of [[keywordPath, keywordOutput], [chunksPath, chunksOutput]] as const) {
    try {
      await assertArtifactPreviewIntegrity(filePath, output);
    } catch {
      throw new Error('关键词预览产物已变化或损坏，请重新处理文档。');
    }
  }

  try {
    return await readKeywordPreview({ documentId, keywordsPath: keywordPath, chunksPath, offset, limit });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('KEYWORDS_PREVIEW_')) {
      throw new Error('关键词产物暂时无法预览，请重新处理文档。');
    }
    throw error;
  }
});

registerAppHandler('search-material-chunks', async (_event, libraryPath: string, query: string, mode: string = 'hybrid', documentIds?: unknown) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof query !== 'string') throw new Error('资料库检索词必须是文本。');
  const tokenization = await tokenizeMaterialSearchQuery(targetPath, query);
  const safeMode: MaterialChunkSearchMode = mode === 'keyword' || mode === 'semantic' ? mode : 'hybrid';
  const documentScope = Array.isArray(documentIds)
    ? documentIds.filter((value): value is string => typeof value === 'string').slice(0, 100)
    : undefined;
  let profileStatus: ReturnType<typeof readMaterialEmbeddingProfile> = { state: 'UNBOUND' };
  let embeddingError: string | undefined;
  try {
    profileStatus = readMaterialEmbeddingProfile(targetPath);
  } catch (error) {
    embeddingError = getErrorMessage(error);
  }
  let adapter: ReturnType<typeof resolveLockedMaterialEmbeddingAdapter> | undefined;
  if (profileStatus.state === 'LOCKED' && profileStatus.profile) {
    try {
      adapter = resolveLockedMaterialEmbeddingAdapter(profileStatus.profile);
      if (!adapter) embeddingError = '锁定向量模型的连接不可用，请检查模型与密钥配置。';
    } catch (error) {
      embeddingError = getErrorMessage(error);
    }
  }
  return searchMaterialChunks({
    libraryPath: targetPath,
    query,
    queryTerms: tokenization.terms,
    lexicalError: tokenization.error,
    mode: safeMode,
    documentIds: documentScope,
    adapter,
    embeddingError,
  });
});

registerAppHandler('start-materials-pipeline', async (_event, libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('资料文档标识无效。');
  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  if (!await confirmCloudDocument(targetPath, documentId)) return pipelineOrchestrator.getStatus(targetPath, findMaterialsDocument(targetPath, documentId)!);
  return pipelineOrchestrator.startParse(targetPath, documentId);
});

registerAppHandler('cancel-materials-pipeline', async (_event, libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  return pipelineOrchestrator.cancelParse(targetPath, documentId);
});

registerAppHandler('retry-materials-pipeline', async (_event, libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (!pipelineOrchestrator) throw new Error('解析流水线尚未初始化。');
  if (!await confirmCloudDocument(targetPath, documentId)) return pipelineOrchestrator.getStatus(targetPath, findMaterialsDocument(targetPath, documentId)!);
  return pipelineOrchestrator.startParse(targetPath, documentId);
});

async function confirmCloudDocument(libraryPath: string, documentId: string): Promise<boolean> {
  const document = findMaterialsDocument(libraryPath, documentId);
  if (!document) throw new Error('找不到要处理的资料文档。');
  if (document.extension !== '.pdf' || cloudAuthorization.has(libraryPath, document)) return true;
  if (!mainWindow) return false;
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: desktopText('确认 PDF 云解析'), message: desktopText('将上传 1 个 PDF 至 MinerU：{name}', { name: document.name }), detail: desktopText('上传包含整个 PDF 的文字与图片，需要网络和 MinerU 密钥。仅授权当前文件内容版本；取消后文件仍保存在本地。'), buttons: ['仅保留本地文件', '上传至 MinerU 解析'].map(value => desktopText(value)), defaultId: 0, cancelId: 0, noLink: true });
  if (result.response !== 1) return false;
  cloudAuthorization.authorize(libraryPath, [document]);
  return true;
}

registerAppHandler('import-materials-documents', async (_event, libraryPath: string) => {
  if (!mainWindow) return [];
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: desktopText('导入资料文档：文本本地读取，DOCX 本地解析，PDF 可选云解析'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '资料文档', extensions: [...materialsDocumentExtensions].map((extension) => extension.slice(1)) },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return listMaterialsDocuments(targetPath);
  const pdfFiles = result.filePaths.filter(file => path.extname(file).toLowerCase() === '.pdf');
  let authorizePdf = false;
  if (pdfFiles.length) {
    const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: desktopText('选择 PDF 处理方式'), message: desktopText('本批次包含 {count} 个 PDF', { count: pdfFiles.length }), detail: `${pdfFiles.slice(0, 10).map(file => path.basename(file)).join('\n')}\n\n${desktopText('仅导入会保留本地文件，稍后可解析。云解析会将这批 PDF 的完整文字与图片上传至 MinerU，需要网络和密钥。文本和 DOCX 在本地处理。')}`, buttons: ['仅导入，稍后解析', '导入并上传至 MinerU 解析', '取消导入'].map(value => desktopText(value)), defaultId: 0, cancelId: 2, noLink: true });
    if (choice.response === 2) return listMaterialsDocuments(targetPath);
    authorizePdf = choice.response === 1;
  }
  const previousIds = new Set(listMaterialsDocuments(targetPath).map((document) => document.id));
  const documents = importMaterialsDocuments(targetPath, result.filePaths);
  const importedIds = documents.filter((document) => !previousIds.has(document.id)).map((document) => document.id);
  if (authorizePdf) cloudAuthorization.authorize(targetPath, documents.filter(document => importedIds.includes(document.id) && document.extension === '.pdf'));
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 自动入队失败：${error instanceof Error ? error.message : String(error)}`));
  return documents;
});

registerAppHandler('rename-materials-document', (_event, libraryPath: string, documentId: string, newName: string) => {
  if (typeof newName !== 'string' || !newName.trim()) throw new Error('请输入文档名称。');
  return renameMaterialsDocument(requireRegisteredMaterialsLibrary(libraryPath), documentId, newName);
});

registerAppHandler('read-materials-document', (_event, libraryPath: string, documentId: string) => {
  return readMaterialsDocumentText(requireRegisteredMaterialsLibrary(libraryPath), documentId);
});

registerAppHandler('read-materials-document-bytes', (_event, libraryPath: string, documentId: string) => {
  return readMaterialsDocumentBytes(requireRegisteredMaterialsLibrary(libraryPath), documentId);
});

registerAppHandler('delete-materials-document', async (_event, libraryPath: string, documentId: string) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const document = findMaterialsDocument(targetPath, documentId);
  if (!document) throw new Error('找不到要删除的资料文档。');
  if (!fs.existsSync(document.absolutePath)) {
    listMaterialsDocuments(targetPath);
    throw new Error('该资料文档在磁盘上不存在，已同步清单。');
  }
  if (pipelineOrchestrator) await pipelineOrchestrator.removeDocument(targetPath, document.id);
  else removeKeywordIndexEntries(targetPath, document.id);
  await shell.trashItem(document.absolutePath);
  return listMaterialsDocuments(targetPath);
});

registerAppHandler('list-files', async () => {
  if (!store) return null;
  const libraryPath = store.get('libraryPath') as string;
  if (!libraryPath || !fs.existsSync(libraryPath)) return null;

  try {
    logToWindow('Scanning and indexing:', libraryPath);
    return refreshLibraryIndex();
  } catch (e) {
    console.error("Error scanning files", e);
    throw new Error(`无法加载笔记库：${e instanceof Error ? e.message : String(e)}`);
  }
});

registerAppHandler('read-file', async (_event, filePath) => {
  const libraryPath = requireCurrentLibraryPath();
  const safePath = assertInsideDirectory(filePath, libraryPath);
  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    throw new Error(`找不到笔记文件：${safePath}`);
  }
  return readTextFile(safePath);
});

/** Versioned edit IPC validates the window and lets the service own all existing-note writes. */
function assertNoteWindow(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertInternalRenderer(event as IpcMainInvokeEvent);
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('当前窗口无权编辑笔记。');
}
registerAppHandler('documents:pick-file', async event => {
  assertNoteWindow(event);
  const result = await dialog.showOpenDialog(mainWindow!, { title: desktopText('打开独立文件'), properties: ['openFile'], filters: [{ name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt', 'json', 'csv', 'yaml', 'yml', 'log'] }, { name: 'All Files', extensions: ['*'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新打开文件。');
  return (await documentOpenRouter.submit([path.resolve(result.filePaths[0])]))[0];
});
registerAppHandler('documents:list-open-requests', async event => { assertNoteWindow(event); await documentOpenRouter.flush(); return getDocumentSessionService().listRequests(event.sender.id); });
registerAppHandler('documents:open-failures', event => { assertNoteWindow(event); return documentOpenRouter.takeFailures(); });
registerAppHandler('documents:drop-files', async (event, files: string[]) => {
  assertNoteWindow(event); if (!Array.isArray(files) || files.length > 200 || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) throw new Error('拖放文件路径无效，请使用打开文件。');
  await documentOpenRouter.drop(files);
});
registerAppHandler('documents:open-request', (event, id: string, encoding?: DocumentEncoding) => { assertNoteWindow(event); return getDocumentSessionService().openRequest(event.sender.id, id, encoding); });
registerAppHandler('documents:finish-open-request', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().finishRequest(event.sender.id, id); });
registerAppHandler('documents:update-draft', (event, request: DocumentDraftRequest) => { assertNoteWindow(event); return getDocumentSessionService().updateDraft(event.sender.id, request); });
registerAppHandler('documents:resource-preview', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().previewResources(event.sender.id, id); });
registerAppHandler('documents:grant-resource-root', async (event, id: string) => {
  assertNoteWindow(event); const service = getDocumentSessionService(); service.displayPath(event.sender.id, id);
  const result = await dialog.showOpenDialog(mainWindow!, { title: desktopText('选择只读资源目录'), properties: ['openDirectory'] });
  if (result.canceled) return false; service.grantResourceRoot(event.sender.id, id, result.filePaths[0]); return true;
});
registerAppHandler('documents:open-link', async (event, id: string, href: string) => { assertNoteWindow(event); const service = getDocumentSessionService(); service.snapshot(event.sender.id, id); return (await documentOpenRouter.submit([await service.resources.openLink(id, href)]))[0]; });
registerAppHandler('documents:add-image', (event, id: string, input: { bytes?: Uint8Array; extension?: string; sourcePath?: string }) => {
  assertNoteWindow(event); if (!input || (input.sourcePath ? typeof input.sourcePath !== 'string' : !(input.bytes instanceof Uint8Array) || typeof input.extension !== 'string')) throw new Error('图片参数无效。');
  return getDocumentSessionService().addDraftImage(event.sender.id, id, input);
});
registerAppHandler('documents:ai-run', (event, request: DocumentAiRequest) => { assertNoteWindow(event); return getDocumentAiService().run(event.sender.id, request); });
registerAppHandler('documents:ai-apply', (event, request: DocumentAiApplyRequest) => { assertNoteWindow(event); return getDocumentAiService().apply(event.sender.id, request); });
registerAppHandler('documents:ai-cancel', (event, requestId: string) => { assertNoteWindow(event); documentAiService?.cancel(event.sender.id, requestId); });
registerAppHandler('documents:save', (event, request: DocumentSaveRequest) => { assertNoteWindow(event); return getDocumentSessionService().save(event.sender.id, request); });
const documentSaveAsRequests = new Map<string, { fingerprint: string; task: Promise<DocumentSaveResult | null> }>();
registerAppHandler('documents:save-as', (event, request: DocumentSaveRequest) => {
  assertNoteWindow(event);
  getDocumentSessionService().displayPath(event.sender.id, request?.documentSessionId);
  if (!request?.requestId || typeof request.requestId !== 'string') throw new Error('另存请求无效。');
  const key = `${event.sender.id}:${request.requestId}`, fingerprint = JSON.stringify(request), previous = documentSaveAsRequests.get(key);
  if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('重试参数不能变化。'); return previous.task; }
  const task = (async () => {
  const result = await dialog.showSaveDialog(mainWindow!, { title: desktopText('独立文件另存为'), defaultPath: getDocumentSessionService().displayPath(event.sender.id, request?.documentSessionId), filters: [{ name: 'Text', extensions: ['md', 'txt', 'markdown'] }, { name: 'All Files', extensions: ['*'] }] });
  if (result.canceled || !result.filePath) return null;
  if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新另存。');
  const service = getDocumentSessionService(), target = path.resolve(result.filePath);
  const hash = await service.targetHash(event.sender.id, request.documentSessionId, target);
  if (hash !== null && target !== service.displayPath(event.sender.id, request.documentSessionId)) {
    const confirmation = await dialog.showMessageBox(mainWindow!, { type: 'question', title: desktopText('确认覆盖文件'), message: desktopText('目标文件已存在，是否覆盖？'), detail: target, buttons: [desktopText('覆盖'), desktopText('取消')], defaultId: 1, cancelId: 1, noLink: true });
    if (confirmation.response !== 0) return null;
  }
  if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新另存。');
  return service.saveAs(event.sender.id, request, target, hash);
  })();
  documentSaveAsRequests.set(key, { fingerprint, task });
  void task.catch(() => { documentSaveAsRequests.delete(key); });
  return task;
});
registerAppHandler('documents:refresh', (event, id: string, revision: number, encoding?: DocumentEncoding, discard = false) => { assertNoteWindow(event); return getDocumentSessionService().reopen(event.sender.id, id, revision, encoding, discard === true); });
registerAppHandler('documents:close', async (event, request: DocumentCloseRequest) => { assertNoteWindow(event); const result = await getDocumentSessionService().close(event.sender.id, request); documentAiService?.release(request.documentSessionId); return result; });
registerAppHandler('documents:join-library', (event, request: DocumentJoinRequest) => { assertNoteWindow(event); return getDocumentSessionService().join(event.sender.id, request); });
registerAppHandler('documents:list-recovery', event => { assertNoteWindow(event); return getDocumentSessionService().recovery.list(); });
registerAppHandler('documents:restore-draft', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().restore(event.sender.id, id); });
registerAppHandler('documents:list-recent', event => { assertNoteWindow(event); return getDocumentSessionService().recovery.recent(); });
registerAppHandler('documents:open-recent', async (event, displayPath: string) => {
  assertNoteWindow(event); const service = getDocumentSessionService();
  if (!(await service.recovery.recent()).some(record => record.displayPath === displayPath)) throw new Error('最近文件记录已失效，请重新选择文件。');
  return (await documentOpenRouter.submit([displayPath]))[0];
});
ipcMain.on('notes:close-waiting', (event, request: { requestId: string }) => { assertNoteWindow(event); noteCloseCoordinator.waitForUser(event.sender.id, request.requestId); });
registerAppHandler('notes:open', (event, filePath: string) => { assertNoteWindow(event); return noteSaveService.open(event.sender.id, filePath); });
registerAppHandler('notes:refresh', (event, id: string) => { assertNoteWindow(event); return noteSaveService.refresh(event.sender.id, id); });
registerAppHandler('notes:close', (event, id: string) => { assertNoteWindow(event); return noteSaveService.close(event.sender.id, id); });
registerAppHandler('notes:save', (event, request: SaveNoteRequest) => { assertNoteWindow(event); return noteSaveService.save(event.sender.id, request); });
registerAppHandler('notes:create-from-ai', async (event, request: CreateAssistantNoteRequest) => {
  assertNoteWindow(event);
  if (!request || typeof request.content !== 'string' || !request.content.trim()
    || (request.title !== undefined && typeof request.title !== 'string')) throw new Error('笔记标题或正文无效。');
  const libraryPath = requireRegisteredNoteLibrary(request.libraryPath);
  return noteSaveService.structure(libraryPath, async () => {
    const create = () => createAssistantNote(libraryPath, request.title ?? '', request.content);
    if (getCurrentLibraryPath() !== libraryPath) return create();
    return indexCoordinator.mutate(async () => {
      const note = await create();
      return { value: note, changes: [{ kind: 'add' as const, path: note.path }] };
    });
  });
});
ipcMain.on('notes:close-response', (event, response: NoteCloseResponse) => { assertNoteWindow(event); noteCloseCoordinator.respond(event.sender.id, { ...response, ok: response.ok && !documentSessionService?.hasDirty(event.sender.id) }); });
ipcMain.on('maintenance:response', (event, response: { requestId: string; ok: boolean }) => { assertNoteWindow(event); maintenanceBarrier.acknowledge(event.sender.id, response?.requestId, response?.ok); });
registerAppHandler('notes:retry-index', (event, id: string) => { assertNoteWindow(event); return indexCoordinator.retry(noteSaveService.pathForSession(event.sender.id, id)); });
registerAppHandler('notes:await-index', (event, id: string, diskHash: string) => { assertNoteWindow(event); return indexCoordinator.awaitIndexedVersion(noteSaveService.pathForSession(event.sender.id, id), diskHash); });
registerAppHandler('notes:reconcile', (event) => { assertNoteWindow(event); return noteSaveService.structure(requireCurrentLibraryPath(), () => indexCoordinator.reconcile()); });
registerAppHandler('notes:mutate', (event, request: NoteMutationRequest) => {
  assertNoteWindow(event);
  const filePath = noteSaveService.pathForSession(event.sender.id, request.editSessionId);
  if (request.action === 'tags' && Array.isArray(request.tags) && request.tags.length && request.tags.every((tag) => typeof tag === 'string')) {
    return noteSaveService.save(event.sender.id, { ...request, content: '' }, (current) => applyConfirmedTags(current, request.tags!).markdown, JSON.stringify(['tags', request.tags]));
  }
  if (request.action === 'restore' && typeof request.backupId === 'string') {
    return noteSaveService.save(event.sender.id, { ...request, content: '' }, async () => {
      return decodeTextBuffer(readNoteBackup(filePath, requireCurrentLibraryPath(), request.backupId!));
    }, JSON.stringify(['restore', request.backupId]), true);
  }
  throw new Error('笔记修改请求无效。');
});
registerAppHandler('notes:save-copy', async (event, id: string, name: string, content: string) => {
  assertNoteWindow(event); noteSaveService.pathForSession(event.sender.id, id);
  const library = requireCurrentLibraryPath();
  if (typeof name !== 'string' || typeof content !== 'string') throw new Error('另存参数无效。');
  const filePath = getUniquePath(library, `${sanitizeEntryName(name.replace(/\.md$/i, ''))}.md`);
  await noteSaveService.structure(library, () => indexCoordinator.mutate(async () => {
    const handle = await fs.promises.open(filePath, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    return { value: filePath, changes: [{ kind: 'add', path: filePath }] };
  }));
  return noteSaveService.open(event.sender.id, filePath);
});
registerAppHandler('save-file', () => { throw new Error('旧保存接口已停用，请使用版本化笔记保存。'); });

registerAppHandler('get-library-path', async () => getCurrentLibraryPath());
registerAppHandler('get-app-preferences', () => getAppPreferences(store));
registerAppHandler('save-app-preferences', (_event, patch: AppPreferencesPatch) => {
  const preferences = saveAppPreferences(store, patch);
  mainWindow?.setBackgroundColor(getWindowBackgroundColor());
  return preferences;
});
registerAppHandler('selection-expansion:get-capabilities', (event) => {
  assertInternalRenderer(event);
  return resolveSelectionExpansionCapabilities();
});
registerAppHandler('selection-expansion:get-settings', (event) => {
  assertInternalRenderer(event);
  return readSelectionExpansionSettings(store);
});
registerAppHandler('selection-expansion:save-settings', (event, patch: unknown) => {
  assertInternalRenderer(event);
  return saveSelectionExpansionSettings(store, patch, resolveSelectionExpansionCapabilities());
});
registerAppHandler('assistant-context-diagnostics:get', (_event, turnId?: unknown) => {
  if (turnId !== undefined && (typeof turnId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(turnId))) {
    throw new Error('上下文诊断轮次标识格式无效。');
  }
  return getContextProjectionDiagnostics(turnId);
});
registerAppHandler('get-app-diagnostics', () => createSafeDiagnostics());

function capabilityContext(request: CapabilityRequest = {}) {
  const libraryPath = request.libraryPath === undefined ? undefined : requireRegisteredMaterialsLibrary(request.libraryPath);
  if (request.documentId !== undefined && (!libraryPath || !findMaterialsDocument(libraryPath, request.documentId))) throw new Error('资料文档不存在，请刷新后重试。');
  const embedding = libraryPath ? readMaterialEmbeddingProfile(libraryPath) : undefined;
  const statuses = libraryPath ? pipelineOrchestrator?.getStatuses(libraryPath) ?? [] : [];
  return { libraryPath, documentId: request.documentId, generation: resolveGenerationConfig(store), pdfConfigured: Boolean(readMineruApiKey(store)), statuses, semanticConfigured: embedding?.state === 'LOCKED', semanticIdentity: embedding?.state === 'LOCKED' ? `${libraryPath}|${embedding.profile.profileHash}|${createHash('sha256').update(JSON.stringify({ hub: readModelHub(store), credentials: embedding.profile.sourceId === 'ollama' ? undefined : resolveProviderCredentials(store, embedding.profile.sourceId) })).digest('hex')}` : undefined, semanticCurrent: statuses.some(status => (!request.documentId || status.documentId === request.documentId) && status.state === 'SUCCEEDED' && status.stages?.vectors?.status === 'SUCCEEDED') };
}
registerAppHandler('capabilities:get', (_event, request?: CapabilityRequest): CapabilitySnapshot => userCapabilities.snapshot(capabilityContext(request)));
registerAppHandler('capabilities:cancel', (event, requestId: string) => capabilityProbes.get(`${event.sender.id}:${requestId}`)?.abort());
registerAppHandler('capabilities:probe', async (event, request: CapabilityProbeRequest): Promise<CapabilitySnapshot> => {
  if (!request || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(request.requestId) || !['generation', 'documentWorker', 'materialSemantic'].includes(request.capability)) throw new Error('能力检测请求无效。');
  const context = capabilityContext(request);
  const key = `${event.sender.id}:${request.requestId}`;
  if (capabilityProbes.has(key)) throw new Error('该检测正在进行。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16_000);
  capabilityProbes.set(key, controller);
  const worker = request.capability === 'documentWorker' ? new PythonWorkerClient() : undefined;
  let probeError: string | undefined;
  try {
    const semanticProbe = async () => {
      if (!context.libraryPath || !context.semanticIdentity) throw new Error('尚未绑定向量模型。');
      const profile = readMaterialEmbeddingProfile(context.libraryPath); if (profile.state !== 'LOCKED') throw new Error('尚未绑定向量模型。');
      const resolved = resolveMaterialEmbeddingProbe(profile.profile);
      return testMaterialEmbeddingCandidate({ candidate: resolved.candidate, probe: resolved.probe, signal: controller.signal });
    };
    const task = worker ? worker.probe() : request.capability === 'materialSemantic' ? semanticProbe() : testAiProviderConnection(context.generation, controller.signal);
    const result = await Promise.race([task, new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('检测已取消或超时。')), { once: true }))]);
    controller.signal.throwIfAborted();
    if (request.capability === 'materialSemantic' && context.semanticIdentity) userCapabilities.rememberSemantic(context.semanticIdentity, true);
    else if (!worker) userCapabilities.rememberGeneration(context.generation, result as Awaited<ReturnType<typeof testAiProviderConnection>>);
  } catch (error) {
    probeError = controller.signal.aborted ? '检测已取消或超时。' : '本地文档处理组件不可用，请重新安装应用后重试。';
    appLogger.record('warn', 'capabilities', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'CAPABILITY_PROBE_FAILED');
    if (request.capability === 'materialSemantic' && context.semanticIdentity && !controller.signal.aborted) userCapabilities.rememberSemantic(context.semanticIdentity, false);
    else if (!worker && request.capability === 'generation' && !controller.signal.aborted) userCapabilities.rememberGeneration(context.generation, { available: false, endpoint: '', models: [] });
  } finally {
    clearTimeout(timeout); capabilityProbes.delete(key); await worker?.shutdown();
  }
  const snapshot = userCapabilities.snapshot(context);
  if (worker || controller.signal.aborted) {
    const capability = snapshot.capabilities.find(item => item.id === request.capability)!;
    Object.assign(capability, { state: probeError ? 'unreachable' : 'available', code: probeError ? 'CAPABILITY_PROBE_FAILED' : 'WORKER_READY', message: probeError ?? '本地文档处理组件运行检测通过' });
  }
  return snapshot;
});
registerAppHandler('open-logs-directory', async () => {
  const logsPath = app.getPath('logs');
  fs.mkdirSync(logsPath, { recursive: true });
  const error = await shell.openPath(logsPath);
  if (error) throw new Error('无法打开日志目录。');
  return true;
});
registerAppHandler('export-diagnostic-report', async () => {
  if (!mainWindow) return false;
  const consent = await dialog.showMessageBox(mainWindow, { type: 'info', message: desktopText('诊断包含应用版本、数据路径、连接地址及安全错误记录，不包含笔记正文或密钥。'), buttons: ['导出诊断', '取消'].map(value => desktopText(value)), defaultId: 0, cancelId: 1 });
  if (consent.response !== 0) return false;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: desktopText('导出诊断信息'),
    defaultPath: `Trellora-诊断-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, `${JSON.stringify(createSafeDiagnostics(), null, 2)}\n`, 'utf8');
  return true;
});
registerAppHandler('get-library-ui-state', async () => {
  const libraryPath = requireCurrentLibraryPath();
  return getLibraryUiState(libraryPath);
});
registerAppHandler('save-library-ui-state', async (_event, patch: LibraryUiStatePatch) => {
  const libraryPath = requireCurrentLibraryPath();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('笔记库界面状态格式无效。');
  return saveLibraryUiState(libraryPath, patch);
});

function createSafeDiagnostics() {
  const aiConfig = getAiProviderConfig();
  return {
    generatedAt: new Date().toISOString(),
    appVersion: APP_INFO.version,
    electronVersion: process.versions.electron,
    platform: process.platform,
    architecture: process.arch,
    userDataPath: app.getPath('userData'),
    logsPath: app.getPath('logs'),
    workspacePath: getConfiguredWorkspacePath(),
    libraryConfigured: Boolean(getCurrentLibraryPath()),
    noteCount: noteIndex?.notes.length ?? 0,
    aiProvider: { kind: aiConfig.kind, endpoint: safeServiceEndpoint(aiConfig.endpoint), model: aiConfig.model, hasApiKey: aiConfig.hasApiKey },
    logDegraded: appLogger.degraded,
    recentEvents: appLogger.recent(),
  };
}

registerAppHandler('get-ai-status', async () => getAiProviderStatus());

registerAppHandler('get-parsing-config', () => readParsingConfig(store));
registerAppHandler('save-parsing-config', (_event, config: unknown) => {
  const patch = (config && typeof config === 'object' ? config : {}) as Partial<import('./parsingConfig').ParsingConfig> & { mineruApiKey?: string | null };
  const saved = saveParsingConfig(store, patch);
  void pipelineOrchestrator?.enqueuePendingAll(listMaterialsLibraries(store).map((library) => library.path)).catch((error) => logToWindow(`[PIPELINE] 配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});

registerAppHandler('get-web-search-config', () => ({
  config: readWebSearchConfig(store),
  providers: listWebSearchProviders().map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    requirements: adapter.requirements,
    ...(adapter.docsUrl ? { docsUrl: adapter.docsUrl } : {}),
    ...(adapter.configFields?.length ? { configFields: adapter.configFields } : {}),
  })),
}));
registerAppHandler('save-web-search-config', (_event, config: unknown) => {
  const patch = (config && typeof config === 'object' ? config : {}) as WebSearchConfigPatch;
  return saveWebSearchConfig(store, patch);
});
registerAppHandler('test-web-search-provider', async (_event, providerId: unknown) => {
  const id = typeof providerId === 'string' && (webSearchProviderIds as readonly string[]).includes(providerId)
    ? (providerId as WebSearchProviderId)
    : undefined;
  if (!id) throw new Error('未知的联网搜索厂商。');
  const runtime = readWebSearchRuntimeConfig(store);
  const resolved = resolveWebSearchProvider({ provider: id, config: runtime });
  if (!resolved.adapter) throw new Error(resolved.error ?? '未知联网搜索厂商。');
  if (resolved.error) return { ok: false, message: resolved.error };
  if (resolved.adapter.testConnection) return resolved.adapter.testConnection(runtime);
  try {
    const results = await resolved.adapter.search({ query: 'ping', maxResults: 1, config: runtime, signal: AbortSignal.timeout(15_000) });
    return { ok: true, message: results.length ? '连接正常，已返回搜索结果。' : '连接正常，但本次查询没有结果。' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

/**
 * 解析联网搜索运行时（联网搜索设计方案 §8）；知识库 Agent 与开放式问答共用：
 * 请求开关/总开关/同意态/厂商前置校验任一不满足时返回 undefined，
 * 联网工具不进注册表、提示词同步降级。
 */
function resolveWebSearchRuntime(request: { webSearch?: 'on' | 'off' }): import('./knowledge/knowledgeToolContext').WebSearchToolContext['webSearch'] {
  if (request.webSearch === 'off') return undefined;
  const config = readWebSearchConfig(store);
  if (!config.enabled || !config.consent) return undefined;
  const runtimeConfig = readWebSearchRuntimeConfig(store);
  const resolved = resolveWebSearchProvider({ provider: config.provider, config: runtimeConfig });
  if (!resolved.adapter || resolved.error) {
    logToWindow(`[ASSISTANT] 联网搜索未生效：${resolved.error ?? '适配器不可用。'}`);
    return undefined;
  }
  return { adapter: resolved.adapter, runtimeConfig, maxResults: config.maxResults };
}

/**
 * 聊天 PDF 在已授权且已配置时优先使用 MinerU 提取正文与图片；否则只用 PDF.js
 * 本地提取文本。配置与密钥始终由主进程读取，不会投影到渲染进程或模型上下文。
 */
function resolveAssistantMineruRuntimeConfig(): MineruRuntimeConfig | undefined {
  const config = readParsingConfig(store);
  const apiKey = readMineruApiKey(store);
  if (!config.cloudParsingConsent || !apiKey) return undefined;
  return {
    endpoint: config.mineruEndpoint,
    apiKey,
    cloudParsingConsent: true,
  };
}

registerAppHandler('get-model-hub', () => readModelHub(store));
registerAppHandler('get-material-embedding-profile', (_event, libraryPath: string) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readMaterialEmbeddingProfile(targetPath);
});
registerAppHandler('material-vector-generations:list', (event, libraryPath: string) => {
  assertInternalRenderer(event);
  return getVectorGenerationService().list(requireRegisteredMaterialsLibrary(libraryPath));
});
registerAppHandler('material-vector-generations:create', async (event, libraryPath: string, candidate: unknown) => {
  assertInternalRenderer(event);
  const target = requireRegisteredMaterialsLibrary(libraryPath), resolved = resolveMaterialEmbeddingProbe(candidate);
  return getVectorGenerationService().create(target, resolved.candidate, resolved.probe);
});
registerAppHandler('material-vector-generations:resume', (event, libraryPath: string, id: string) => {
  assertInternalRenderer(event);
  getVectorGenerationService().resume(requireRegisteredMaterialsLibrary(libraryPath), id);
});
registerAppHandler('material-vector-generations:cancel', (event, libraryPath: string, id: string) => {
  assertInternalRenderer(event);
  getVectorGenerationService().cancel(requireRegisteredMaterialsLibrary(libraryPath), id);
});
registerAppHandler('material-vector-generations:activate', (event, libraryPath: string, id: string) => {
  assertInternalRenderer(event);
  const target = requireRegisteredMaterialsLibrary(libraryPath);
  const result = getVectorGenerationService().activate(target, id);
  void pipelineOrchestrator?.enqueuePending(target).catch(error => logToWindow(`[PIPELINE] 索引代际切换后刷新失败：${getErrorMessage(error)}`));
  return result;
});
registerAppHandler('test-material-embedding-profile', async (_event, libraryPath: string, candidate: unknown) => {
  requireRegisteredMaterialsLibrary(libraryPath);
  const resolved = resolveMaterialEmbeddingProbe(candidate);
  return testMaterialEmbeddingCandidate({ candidate: resolved.candidate, probe: resolved.probe });
});
registerAppHandler('lock-material-embedding-profile', async (_event, libraryPath: string, candidate: unknown) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const resolved = resolveMaterialEmbeddingProbe(candidate);
  const profile = await lockMaterialEmbeddingProfile({
    libraryPath: targetPath,
    candidate: resolved.candidate,
    probe: resolved.probe,
    appVersion: APP_INFO.version,
  });
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 向量 profile 锁定后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return profile;
});
registerAppHandler('get-pipeline-ambiguity-config', () => readPipelineAmbiguityConfig(store));
registerAppHandler('save-pipeline-ambiguity-config', (_event, patch: Partial<PipelineAmbiguityConfig>) => {
  const saved = savePipelineAmbiguityConfig(store, patch ?? {});
  void pipelineOrchestrator?.enqueuePendingAll(listMaterialsLibraries(store).map((library) => library.path)).catch((error) => logToWindow(`[PIPELINE] 歧义配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('get-pipeline-structure-config', () => readPipelineStructureConfig(store));
registerAppHandler('save-pipeline-structure-config', (_event, patch: Partial<PipelineStructureConfig>) => {
  const saved = savePipelineStructureConfig(store, patch ?? {});
  void pipelineOrchestrator?.enqueuePendingAll(listMaterialsLibraries(store).map((library) => library.path)).catch((error) => logToWindow(`[PIPELINE] 结构配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('get-library-chunking-config', (_event, libraryPath: string): LibraryChunkingConfig => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readLibraryChunkingConfig(targetPath, store);
});
registerAppHandler('save-library-chunking-config', (_event, libraryPath: string, patch: unknown): LibraryChunkingConfig => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const saved = saveLibraryChunkingConfig(targetPath, patch, store);
  // A library-level config hash makes only chunks and downstream stages stale.
  // Re-enqueue this library alone; all other knowledge bases keep their cache.
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 切块配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('get-library-graph-enhancement-config', (_event, libraryPath: string): LibraryGraphEnhancementConfig => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readLibraryGraphEnhancementConfig(targetPath);
});
registerAppHandler('save-library-graph-enhancement-config', (_event, libraryPath: string, patch: unknown): LibraryGraphEnhancementConfig => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const saved = saveLibraryGraphEnhancementConfig(targetPath, patch);
  // 图谱增强开关只影响 entities 阶段；重新入队让开启后的文档补跑，关闭后由 SKIPPED 语义接管。
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 图谱增强配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('get-library-graph-status', (_event, libraryPath: string): GraphProjectionStatus | null => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readGraphProjectionStatus(targetPath);
});
registerAppHandler('get-library-graph-communities', (_event, libraryPath: string): GraphCommunityProjectionRow[] | null => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readGraphCommunities(targetPath);
});
registerAppHandler('get-library-graph-visualization', (_event, libraryPath: string, options?: { nodeLimit?: number }): GraphVisualizationPayload | null => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readGraphVisualizationPayload(targetPath, options);
});
registerAppHandler('search-library-graph-entities', (_event, libraryPath: string, query: string): GraphVisualizationEntityNode[] => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return searchGraphVisualizationEntities(targetPath, typeof query === 'string' ? query : '');
});
registerAppHandler('get-library-pipeline-llm', (_event, libraryPath: string): LibraryPipelineLlmBinding => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readLibraryPipelineLlmBinding(targetPath);
});
registerAppHandler('save-library-pipeline-llm', (_event, libraryPath: string, patch: unknown): LibraryPipelineLlmBinding => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  const saved = saveLibraryPipelineLlmBinding(targetPath, patch);
  // 语言模型绑定影响歧义消解/智能切块/图谱增强的缓存指纹；变更后重新入队，让失效阶段重跑。
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 语言模型绑定变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('get-pipeline-keyword-resources', (_event, libraryPath: string) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  return readLibraryKeywordStageResources(targetPath);
});
registerAppHandler('save-pipeline-keyword-config', (_event, libraryPath: string, patch: unknown) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('关键词配置格式无效。');
  const saved = saveLibraryKeywordConfig(targetPath, patch as Partial<KeywordExtractionConfig>);
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 关键词配置变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return saved;
});
registerAppHandler('save-pipeline-keyword-dictionary', (_event, libraryPath: string, content: unknown) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof content !== 'string') throw new Error('业务词典内容必须是文本。');
  const resources = saveLibraryKeywordDictionary(targetPath, content);
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 业务词典变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return resources;
});
registerAppHandler('save-pipeline-keyword-stopwords', (_event, libraryPath: string, content: unknown) => {
  const targetPath = requireRegisteredMaterialsLibrary(libraryPath);
  if (typeof content !== 'string') throw new Error('停用词内容必须是文本。');
  const resources = saveLibraryKeywordStopwords(targetPath, content);
  void pipelineOrchestrator?.enqueuePending(targetPath).catch((error) => logToWindow(`[PIPELINE] 停用词变更后重新入队失败：${error instanceof Error ? error.message : String(error)}`));
  return resources;
});
registerAppHandler('save-model-provider', (_event, id: string, patch: { endpoint?: string; api?: Exclude<AiGenerationApi, 'ollama-chat'>; apiKey?: string | null; models?: string[] }) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error('未知的模型厂商。');
  return requireSavedModelConfiguration(saveModelConfiguration({ kind: 'hub', provider: { id, patch: patch ?? {} } })).hub;
});
registerAppHandler('fetch-model-provider-models', async (_event, id: string, draft?: ModelProviderCatalogDraft) => {
  if (typeof id !== 'string' || !id.trim()) throw new Error('未知的模型厂商。');
  return fetchModelProviderCatalog(store, id, draft);
});
registerAppHandler('save-model-hub', (_event, patch: ModelHubPatch) => {
  return requireSavedModelConfiguration(saveModelConfiguration({ kind: 'hub', hubPatch: patch ?? {} })).hub;
});
registerAppHandler('save-model-configuration', (event, change: ModelConfigurationChange, confirmationToken?: string) => {
  assertInternalRenderer(event);
  if (confirmationToken !== undefined && typeof confirmationToken !== 'string') throw new Error('连接确认无效。');
  return saveModelConfiguration(change, confirmationToken);
});
registerAppHandler('get-ai-provider-config', () => ({ ...getAiProviderConfig(), embeddingModel: getConfiguredEmbeddingModel() }));
registerAppHandler('get-ai-model-settings', (event) => {
  assertInternalRenderer(event);
  return getAiModelSettings();
});
registerAppHandler('save-ai-model-settings', (event, input: unknown) => {
  assertInternalRenderer(event);
  return saveAiModelSettings(input);
});
registerAppHandler('get-ai-extensions-settings', (event) => {
  assertInternalRenderer(event);
  const settings = readAiExtensionsSettings();
  syncAiSkillsToWorkspace(getConfiguredWorkspacePath(), settings, getBundledAiSkillsPath());
  return settings;
});
registerAppHandler('save-ai-extensions-settings', (event, input: unknown) => {
  assertInternalRenderer(event);
  return saveAiExtensionsSettings(input);
});
registerAppHandler('get-ai-skills-overview', (event) => {
  assertInternalRenderer(event);
  const settings = readAiExtensionsSettings();
  ensureBundledSkills(getConfiguredWorkspacePath(), getBundledAiSkillsPath());
  const outcome = loadDirectorySkills(getConfiguredWorkspacePath());
  return buildAiSkillsOverview({
    outcome,
    overrides: settings.directorySkillOverrides,
    configSkillNames: settings.skills.map((skill) => skill.name),
  });
});
registerAppHandler('import-ai-skill', async (event, mode: unknown): Promise<SkillImportResult> => {
  assertInternalRenderer(event);
  const kind = mode === 'folder' || mode === 'zip' || mode === 'markdown' ? mode : undefined;
  if (!kind) throw new Error('导入方式无效。');
  const workspacePath = getConfiguredWorkspacePath();
  if (!workspacePath) throw new Error('尚未选择工作区，无法导入技能。');
  const selection = await dialog.showOpenDialog(mainWindow, kind === 'folder'
    ? { title: '选择技能文件夹（内含 SKILL.md）', properties: ['openDirectory'] }
    : {
        title: kind === 'zip' ? '选择技能压缩包' : '选择 SKILL.md 文件',
        properties: ['openFile'],
        filters: kind === 'zip'
          ? [{ name: '技能压缩包', extensions: ['zip'] }]
          : [{ name: 'SKILL.md', extensions: ['md', 'markdown'] }],
      });
  if (selection.canceled || selection.filePaths.length === 0) return { ok: false, error: '已取消导入。' };
  const settings = readAiExtensionsSettings();
  const result = await importAiSkillSource(
    { kind: kind === 'folder' ? 'directory' : kind, path: selection.filePaths[0] },
    { workspacePath, existingConfigSkillNames: new Set(settings.skills.map((skill) => skill.name.toLowerCase())) },
  );
  if (result.ok && result.skillName) updateDirectorySkillOverride(result.skillName, { enabled: true, importedAt: new Date().toISOString() });
  return result;
});
registerAppHandler('set-ai-skill-enabled', (event, name: unknown, enabled: unknown) => {
  assertInternalRenderer(event);
  if (typeof enabled !== 'boolean') throw new Error('技能启用状态无效。');
  const entry = findDirectorySkillEntry(name);
  updateDirectorySkillOverride(entry.name, { enabled });
  return { ok: true };
});
registerAppHandler('remove-ai-skill', (event, name: unknown) => {
  assertInternalRenderer(event);
  const entry = findDirectorySkillEntry(name);
  const override = findDirectorySkillOverride(entry.name);
  if (!override?.importedAt) throw new Error('只能删除通过应用导入的技能；手动放置的技能请直接删除 AI-Skill 下对应文件夹。');
  removeDirectoryRecursively(entry.basePath);
  updateDirectorySkillOverride(entry.name, { remove: true });
  return { ok: true };
});
registerAppHandler('reveal-ai-skill', (event, name: unknown) => {
  assertInternalRenderer(event);
  const entry = findDirectorySkillEntry(name);
  shell.showItemInFolder(path.join(entry.basePath, 'SKILL.md'));
  return { ok: true };
});
registerAppHandler('create-ai-skill-from-form', (event, input: unknown): SkillImportResult => {
  assertInternalRenderer(event);
  const parsed = (input ?? {}) as Record<string, unknown>;
  const settings = readAiExtensionsSettings();
  const result = createDirectorySkillFromForm(
    {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
    },
    { workspacePath: getConfiguredWorkspacePath(), existingConfigSkillNames: new Set(settings.skills.map((skill) => skill.name.toLowerCase())) },
  );
  if (result.ok && result.skillName) updateDirectorySkillOverride(result.skillName, { enabled: true, importedAt: new Date().toISOString() });
  return result;
});
registerAppHandler('update-ai-skill-document', (event, name: unknown, description: unknown, instruction: unknown) => {
  assertInternalRenderer(event);
  const entry = findDirectorySkillEntry(name);
  return updateDirectorySkillDocument({
    basePath: entry.basePath,
    name: entry.name,
    description: typeof description === 'string' ? description : '',
    instruction: typeof instruction === 'string' ? instruction : '',
  });
});
registerAppHandler('export-ai-skill', async (event, name: unknown) => {
  assertInternalRenderer(event);
  const entry = findDirectorySkillEntry(name);
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: '导出技能压缩包',
    defaultPath: `${entry.name}.zip`,
    filters: [{ name: '技能压缩包', extensions: ['zip'] }],
  });
  if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
  return exportDirectorySkillToZip({ basePath: entry.basePath, name: entry.name }, selection.filePath);
});
registerAppHandler('get-assistant-ai-options', (event, profileId: unknown) => {
  assertInternalRenderer(event);
  return getAssistantAiOptions(typeof profileId === 'string' ? profileId : undefined);
});
registerAppHandler('selection-expansion:prepare-source', (event: IpcMainInvokeEvent, currentPath: unknown) => {
  assertInternalRenderer(event);
  if (documentSessionService?.hasActive(event.sender.id)) throw new Error('独立文件当前不支持 AI 编辑，请先加入笔记库。');
  if (typeof currentPath !== 'string' || !currentPath.trim()) throw new Error('当前笔记路径无效。');
  const libraryPath = requireCurrentLibraryPath();
  const safePath = assertInsideDirectory(currentPath, libraryPath);
  const snapshot = getCurrentNoteSnapshotForAssistantMemory(libraryPath, safePath);
  return {
    currentPath: snapshot.notePath,
    contentHash: snapshot.contentHash,
    sourceSnapshotId: snapshot.snapshotId,
  };
});
registerAppHandler('selection-expansion:start', (event: IpcMainInvokeEvent, input: unknown) => {
  assertInternalRenderer(event);
  if (documentSessionService?.hasActive(event.sender.id)) throw new Error('独立文件当前不支持 AI 编辑，请先加入笔记库。');
  const capabilities = resolveSelectionExpansionCapabilities();
  const request = validateSelectionExpansionRequest(input, capabilities);
  const libraryPath = requireCurrentLibraryPath();
  const safePath = assertInsideDirectory(request.currentPath, libraryPath);
  const snapshot = getCurrentNoteSnapshotForAssistantMemory(libraryPath, safePath);
  if (snapshot.contentHash !== request.expectedContentHash || snapshot.snapshotId !== request.sourceSnapshotId) {
    throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  }
  const currentNoteText = snapshot.blocks.map((block) => block.text).join('\n');
  if (!request.selectionLocator && !currentNoteText.includes(request.selectedText)) {
    throw new Error('选区已不在当前保存的笔记中，请重新选择文字后再生成。');
  }
  if (resolveSelectionExpansionMode() === 'adaptive' && !request.selectionLocator) throw new Error('选区定位信息缺失，请重新选择文字后再生成。');
  const requestId = `selection-expansion-${randomUUID()}`;
  const sessionId = `selection-expansion-session-${randomUUID()}`;
  const extendedSources: Parameters<typeof runSelectionExpansionCoordinator>[0]['extendedSources'] = {};
  if (request.settings.sources.noteLibrary) {
    if (!noteIndex) refreshLibraryIndex();
    if (!noteIndex) throw new Error('同库笔记索引尚未准备就绪，请稍后重试。');
    const sourceIndex = noteIndex;
    const sourceLibraryRevision = libraryRevision;
    const sourceSearchIndex = createNoteLexicalIndex();
    sourceSearchIndex.addAll(sourceIndex.notes.map(toNoteSearchDocument));
    extendedSources.noteLibrary = {
      snapshotMap: createLibraryNoteSnapshotMap({
        libraryPath,
        index: sourceIndex,
        sessionId,
        revision: libraryRevision,
        indexState: 'latest',
      }),
      sessionId,
      currentNotePath: snapshot.notePath,
      keywordSearch: (query) => createKeywordCandidates(
        searchNoteLexically(sourceSearchIndex, query),
        query,
        libraryPath,
        sourceIndex,
      ),
      isSnapshotCurrent: () => !controller.signal.aborted
        && getCurrentLibraryPath() === libraryPath
        && libraryRevision === sourceLibraryRevision,
    };
  }
  if (request.settings.sources.materialsLibrary) {
    const activeMaterialsLibrary = getActiveMaterialsLibraryPath(store);
    if (activeMaterialsLibrary) {
      const materialsLibraryPath = requireRegisteredMaterialsLibrary(activeMaterialsLibrary);
      extendedSources.materialsLibrary = {
        libraryPath: materialsLibraryPath,
        prepareQueryContext: (query) => prepareMaterialSearchContext(materialsLibraryPath, query),
      };
    }
  }
  if (request.settings.sources.web !== 'off') {
    // SE-6 双重授权：任务草稿显式开启 + 全局联网开关及隐私同意均满足，
    // 才把运行时适配器交给协调器；否则不会发送搜索或抓取请求。
    const webRuntime = resolveWebSearchRuntime({ webSearch: 'on' });
    if (!webRuntime) {
      throw new Error('联网补充尚未就绪。请先在“设置 → 联网搜索”中启用服务、确认隐私提示并完成服务商配置。');
    }
    extendedSources.web = webRuntime;
  }
  if (request.settings.sources.personalization) {
    // 仅投影受控画像快照；协调器会把它隔离在写作偏好区，绝不写入事实证据账本。
    extendedSources.personalization = {
      snapshot: new UserProfileRepository(qaMemoryDatabase, libraryPath).getContextSnapshot(),
    };
  }
  const key = selectionTaskKey(event, requestId);
  cancelSelectionExpansionTasksForSender(event, key);
  cancelSelectionTransformTasksForSender(event);
  cancelAssistantTurnsForSender(event);
  const controller = new AbortController();
  selectionExpansionTasks.set(key, controller);
  let sequence = 0;
  let terminal = false;
  const emit = (payload: import('./knowledge/selectionExpansionTypes').SelectionExpansionEventPayload) => {
    if (terminal || (controller.signal.aborted && payload.type !== 'cancelled')) return;
    if (payload.type === 'complete' || payload.type === 'cancelled' || payload.type === 'stale' || payload.type === 'error') terminal = true;
    emitSelectionExpansionEvent(event, { ...payload, requestId, sessionId, sequence: ++sequence });
  };
  selectionExpansionTaskEmitters.set(key, emit);
  setTimeout(() => {
    if (selectionExpansionTasks.get(key) !== controller) return;
    emit({ type: 'started' });
    void runSelectionExpansionCoordinator({
      requestId,
      sessionId,
      request,
      snapshot,
      signal: controller.signal,
      isSnapshotCurrent: () => !controller.signal.aborted
        && getCurrentLibraryPath() === libraryPath
        && Boolean(noteIndex?.notes.some((note) => matchesCurrentNoteSnapshot(snapshot, note))),
      extendedSources,
      emit,
    }).catch((error) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        emit({ type: 'cancelled' });
        return;
      }
      if (isSelectionExpansionStaleError(error)) {
        emit({ type: 'stale', message: error instanceof Error ? error.message : '当前笔记已变化，请重新选择文字后再生成。' });
        return;
      }
      emit({
        type: 'error',
        code: 'selection-expansion-failed',
        message: error instanceof Error ? error.message : '扩写优化未能完成。',
      });
    }).finally(() => {
      if (selectionExpansionTasks.get(key) === controller) selectionExpansionTasks.delete(key);
      selectionExpansionTaskEmitters.delete(key);
    });
  }, 0);
  return { requestId, sessionId };
});
registerAppHandler('selection-expansion:cancel', (event: IpcMainInvokeEvent, requestId: unknown) => {
  assertInternalRenderer(event);
  if (typeof requestId !== 'string' || requestId.length > 128) return false;
  const key = selectionTaskKey(event, requestId);
  const controller = selectionExpansionTasks.get(key);
  if (!controller) return false;
  controller.abort();
  selectionExpansionTasks.delete(key);
  selectionExpansionTaskEmitters.get(key)?.({ type: 'cancelled' });
  selectionExpansionTaskEmitters.delete(key);
  return true;
});
/**
 * SE-7 default route. The renderer sends only its editing intent; Electron
 * validates it, resolves the saved-note snapshot and owns the rollback switch.
 */
registerAppHandler('selection-edit:start', async (event: IpcMainInvokeEvent, input: unknown) => {
  assertInternalRenderer(event);
  if (documentSessionService?.hasActive(event.sender.id)) throw new Error('独立文件当前不支持 AI 编辑，请先加入笔记库。');
  const request = validateSelectionEditRunRequest(input);
  const key = selectionTaskKey(event, request.requestId);
  cancelSelectionExpansionTasksForSender(event);
  cancelSelectionTransformTasksForSender(event);
  const currentNoteSource = resolveSelectionEditCurrentNoteSource(request);
  const controller = new AbortController();
  selectionTransformTasks.set(key, controller);
  try {
    // A single explicit environment switch keeps the prior endpoint callable
    // for the observation window without restoring renderer-side coupling.
    if (resolveSelectionEditRuntimeMode() === 'legacy') {
      return await runSelectionTransform({
        requestId: request.requestId,
        action: request.action,
        selectedText: request.selectedText,
        ...(request.context ? { context: request.context } : {}),
        ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
        ...(request.customInstruction ? { instruction: request.customInstruction } : {}),
        ...(request.currentPath ? { currentPath: request.currentPath } : {}),
        contextScope: request.contextScope,
      }, controller.signal, currentNoteSource);
    }
    if (request.action === 'expand' && request.contextScope !== 'nearby' && resolveSelectionExpansionMode() === 'adaptive' && !request.selectionLocator) throw new Error('选区定位信息缺失，请重新选择文字后再生成。');
    const unifiedRequest = currentNoteSource
      ? createCurrentNoteSelectionEditRequest({
        requestId: request.requestId,
        action: request.action,
        sourceSnapshotId: currentNoteSource.snapshot.snapshotId,
        snapshot: currentNoteSource.snapshot,
        selectedText: request.selectedText,
        selectionLocator: request.selectionLocator,
        ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
        ...(request.customInstruction ? { customInstruction: request.customInstruction } : {}),
        contextScope: request.contextScope,
      })
      : createLegacyLocalSelectionEditRequest({
        requestId: request.requestId,
        action: request.action,
        selectedText: request.selectedText,
        ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
        ...(request.customInstruction ? { customInstruction: request.customInstruction } : {}),
      });
    unifiedRequest.contextScope = request.contextScope;
    const result = await runSelectionEditCoordinator({
      request: unifiedRequest,
      ...(request.action === 'expand' && currentNoteSource ? { snapshot: currentNoteSource.snapshot } : {}),
      signal: controller.signal,
      isSnapshotCurrent: currentNoteSource?.isSnapshotCurrent ?? (() => true),
      synthesis: request.context ? { nearbyContext: request.context } : undefined,
    });
    return {
      requestId: result.requestId,
      text: result.text,
      provider: result.provider,
      model: result.model,
      writebackKind: result.writebackKind,
      suggestedApplyMode: result.suggestedApplyMode,
      validation: result.validation,
      qualityReceipt: result.qualityReceipt,
      execution: result.execution,
      contextReceipt: result.receipt,
    };
  } finally {
    if (selectionTransformTasks.get(key) === controller) selectionTransformTasks.delete(key);
  }
});
registerAppHandler('selection-edit:cancel', (event: IpcMainInvokeEvent, requestId: unknown) => {
  assertInternalRenderer(event);
  return cancelSelectionEditTask(event, requestId);
});
// SE-7 compatibility only: old renderer bundles may use this until the
// observation window closes. New renderer code must use selection-edit:*.
registerAppHandler('start-selection-transform', async (event: IpcMainInvokeEvent, input: unknown) => {
  if (documentSessionService?.hasActive(event.sender.id)) throw new Error('独立文件当前不支持 AI 编辑，请先加入笔记库。');
  assertInternalRenderer(event);
  const request = validateSelectionTransformRequest(input);
  const key = selectionTaskKey(event, request.requestId);
  cancelSelectionExpansionTasksForSender(event);
  selectionTransformTasks.get(key)?.abort();
  const currentNoteSource = resolveSelectionEditCurrentNoteSource(request);
  const controller = new AbortController();
  selectionTransformTasks.set(key, controller);
  try {
    return await runSelectionTransform(request, controller.signal, currentNoteSource);
  } finally {
    if (selectionTransformTasks.get(key) === controller) selectionTransformTasks.delete(key);
  }
});
registerAppHandler('cancel-selection-transform', (event: IpcMainInvokeEvent, requestId: unknown) => {
  assertInternalRenderer(event);
  return cancelSelectionEditTask(event, requestId);
});

function collectAssistantAttachmentsFromPaths(filePaths: readonly string[]): AssistantAttachment[] {
  const selectedPaths = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].slice(0, maxAssistantAttachmentCount);
  const collected: AssistantAttachment[] = [];
  let imageTotalBytes = 0;
  for (const resolvedPath of selectedPaths) {
    const extension = path.extname(resolvedPath).toLowerCase();
    const name = path.basename(resolvedPath);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) throw new Error('AI 附件必须是文件。');
    if (assistantImageExtensions.has(extension)) {
      const mimeType = resolveImageMimeTypeFromExtension(extension);
      if (!mimeType) throw new Error(`不支持的图片类型：${extension}。`);
      if (stat.size > maxAssistantImageBytes) throw new Error(`图片“${name}”不能超过 ${Math.floor(maxAssistantImageBytes / 1_000_000)} MB。`);
      imageTotalBytes += stat.size;
      if (imageTotalBytes > maxAssistantImageTotalBytes) throw new Error(`图片附件总大小不能超过 ${Math.floor(maxAssistantImageTotalBytes / 1_000_000)} MB。`);
      const dataUrl = `data:${mimeType};base64,${fs.readFileSync(resolvedPath).toString('base64')}`;
      collected.push({
        kind: 'image',
        attachmentId: `image-${createHash('sha256').update(dataUrl).digest('hex').slice(0, 24)}`,
        name,
        mimeType,
        sizeBytes: stat.size,
        dataUrl,
      });
      continue;
    }
    if (assistantTextExtensions.has(extension)) {
      if (stat.size > maxAssistantAttachmentBytes) throw new Error(`文本附件“${name}”不能超过 ${Math.floor(maxAssistantAttachmentBytes / 1_000_000)} MB。`);
      collected.push({
        kind: 'text',
        attachmentId: `text-${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 24)}`,
        path: resolvedPath,
        name,
        sizeBytes: stat.size,
      });
      continue;
    }
    if (assistantDocumentExtensions.has(extension)) {
      if (stat.size > maxAssistantDocumentBytes) throw new Error(`文档附件“${name}”不能超过 ${Math.floor(maxAssistantDocumentBytes / 1_000_000)} MB。`);
      collected.push({
        kind: 'document',
        attachmentId: `document-${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 24)}`,
        path: resolvedPath,
        name,
        mimeType: extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: stat.size,
      });
      continue;
    }
    throw new Error(`不支持作为 AI 附件的类型：${extension || '未知'}。`);
  }
  return collected;
}

registerAppHandler('select-assistant-attachments', async (event: IpcMainInvokeEvent, input?: unknown): Promise<AssistantAttachment[]> => {
  assertInternalRenderer(event);
  if (input !== undefined && input !== 'image' && input !== 'file') throw new Error('AI 附件选择类型无效。');
  if (!mainWindow) return [];
  const pickerKind = input ?? 'all';
  const imageFilter = { name: '图片', extensions: [...assistantImageExtensions].map((extension) => extension.slice(1)) };
  const fileFilters = [
    { name: '文档', extensions: [...assistantDocumentExtensions].map((extension) => extension.slice(1)) },
    { name: '文本附件', extensions: [...assistantTextExtensions].map((extension) => extension.slice(1)) },
  ];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: pickerKind === 'image' ? '添加 AI 图片' : '添加 AI 附件',
    properties: ['openFile', 'multiSelections'],
    filters: pickerKind === 'image'
      ? [imageFilter]
      : pickerKind === 'file'
        ? fileFilters
        : [imageFilter, ...fileFilters, { name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return collectAssistantAttachmentsFromPaths(result.filePaths);
});
registerAppHandler('ingest-assistant-dropped-files', (event: IpcMainInvokeEvent, input: unknown): AssistantAttachment[] => {
  assertInternalRenderer(event);
  if (!Array.isArray(input) || input.length > maxAssistantAttachmentCount) throw new Error(`一次最多拖入 ${maxAssistantAttachmentCount} 个附件。`);
  const filePaths = input.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4_000) throw new Error('拖入附件路径无效。');
    return value;
  });
  return collectAssistantAttachmentsFromPaths(filePaths);
});
registerAppHandler('start-assistant-turn', (event: IpcMainInvokeEvent, input: unknown) => {
  assertInternalRenderer(event);
  const request = validateAssistantTurnRequest(input);
  const key = selectionTaskKey(event, request.requestId);
  cancelSelectionExpansionTasksForSender(event);
  cancelAssistantTurnsForSender(event, key);
  assistantTurnTasks.get(key)?.abort();
  const controller = new AbortController();
  assistantTurnTasks.set(key, controller);
  void runAssistantTurn(event, request, controller).finally(() => {
    onboardingService?.forgetRequest(event.sender.id, request.requestId);
    const ownsTask = assistantTurnTasks.get(key) === controller;
    if (ownsTask) assistantTurnTasks.delete(key);
    if (ownsTask || !assistantTurnTasks.has(key)) assistantTurnOutputBuffers.delete(key);
  });
  return { requestId: request.requestId };
});
registerAppHandler('cancel-assistant-turn', (event: IpcMainInvokeEvent, requestId: unknown) => {
  assertInternalRenderer(event);
  if (typeof requestId !== 'string' || requestId.length > 128) return false;
  const key = selectionTaskKey(event, requestId);
  const controller = assistantTurnTasks.get(key);
  if (!controller) return false;
  controller.abort();
  assistantTurnTasks.delete(key);
  return true;
});
registerAppHandler('assistant:get-detailed-trace', async (event: IpcMainInvokeEvent, requestId: unknown) => {
  assertInternalRenderer(event);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId)) {
    return { entries: [], filePath: null };
  }
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128);
  const directory = path.join(app.getPath('logs'), 'assistant-detailed');
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    return { entries: [], filePath: null };
  }
  const latest = names.filter((name) => name.startsWith('assistant-turn-') && name.endsWith(`-${safeRequestId}.jsonl`)).sort().at(-1);
  if (!latest) return { entries: [], filePath: null };
  const filePath = path.join(directory, latest);
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const entries = content
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    return { entries, filePath };
  } catch {
    return { entries: [], filePath: null };
  }
});
registerAppHandler('qa-memory:create-session', (event: IpcMainInvokeEvent, scope: unknown = 'chat', libraryPath?: unknown) => {
  assertInternalRenderer(event);
  if (scope !== 'chat' && scope !== 'knowledge-base') throw new Error('问答会话模式无效。');
  const sessionScope = scope as QaSessionScope;
  const normalizedLibraryPath = typeof libraryPath === 'string' ? libraryPath.trim() : '';
  if (sessionScope === 'knowledge-base' && !normalizedLibraryPath) throw new Error('请先选择知识库。');
  return getQaMemoryOrchestrator().repository.createSession(sessionScope, normalizedLibraryPath ? { libraryPath: normalizedLibraryPath } : {});
});
registerAppHandler('memory:get-cutover-report', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  return getMemoryCutoverReport();
});
registerAppHandler('qa-memory:list-sessions', (event: IpcMainInvokeEvent, cursor?: unknown) => {
  assertInternalRenderer(event);
  return getQaMemoryOrchestrator().repository.listSessions({
    cursor: typeof cursor === 'number' ? cursor : undefined,
    pageSize: 10,
  });
});
registerAppHandler('qa-memory:get-session', (event: IpcMainInvokeEvent, sessionId: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('问答记忆会话标识无效。');
  return getQaMemoryOrchestrator().repository.getSession(sessionId);
});
registerAppHandler('qa-memory:rename-session', (event: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string' || typeof title !== 'string') throw new Error('问答记忆会话重命名参数无效。');
  return getQaMemoryOrchestrator().repository.renameSession(sessionId, title);
});
registerAppHandler('qa-memory:set-pinned', (event: IpcMainInvokeEvent, sessionId: unknown, pinned: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string' || typeof pinned !== 'boolean') throw new Error('问答记忆会话置顶参数无效。');
  return getQaMemoryOrchestrator().repository.setPinned(sessionId, pinned);
});
registerAppHandler('qa-memory:delete-session', (event: IpcMainInvokeEvent, sessionId: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('问答记忆会话标识无效。');
  const orchestrator = getQaMemoryOrchestrator();
  orchestrator.cancelSession(sessionId);
  orchestrator.repository.deleteSession(sessionId);
  return true;
});
registerAppHandler('memory:get-overview', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const service = getMemoryWriteService();
  return {
    workspaceConfig: service.getWorkspaceConfig(scope),
    subject: service.getSubject(scope),
    availability: service.getAvailability(scope),
    extractionRuntime: getMemoryExtractionService().getRuntimeStatus(scope),
    itemCounts: service.getItemCounts(scope),
  };
});
registerAppHandler('memory:save-workspace-config', (event: IpcMainInvokeEvent, patch: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const config = getMemoryWriteService().updateWorkspaceConfig(scope, patch as Partial<WorkspaceMemoryConfig>);
  getMemoryExtractionService().refreshConfiguration(scope);
  return config;
});
registerAppHandler('memory:set-principal-enabled', (event: IpcMainInvokeEvent, enabled: unknown) => {
  assertInternalRenderer(event);
  if (typeof enabled !== 'boolean') throw new Error('长期记忆开关参数无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  const result = getMemoryWriteService().setPrincipalEnabled(scope, enabled);
  getMemoryExtractionService().refreshConfiguration(scope);
  return result;
});
registerAppHandler('memory:list-items', (event: IpcMainInvokeEvent, query?: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const normalizedQuery = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryItemListQuery : {};
  return getMemoryWriteService().list(scope, normalizedQuery);
});
registerAppHandler('memory:list-topics', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryTopicService().list(scope);
});
registerAppHandler('memory:list-item-page', (event: IpcMainInvokeEvent, query?: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryItemPageQuery : {};
  return getMemoryWriteService().listPage(scope, normalized);
});
registerAppHandler('memory:list-topic-page', (event: IpcMainInvokeEvent, query?: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryPageQuery : {};
  return getMemoryTopicService().listPage(scope, normalized);
});
registerAppHandler('memory:list-document-page', (event: IpcMainInvokeEvent, query?: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryPageQuery : {};
  return getMemoryAffinityService().listPage(scope, normalized);
});
registerAppHandler('memory:promote-topic', (event: IpcMainInvokeEvent, topicId: unknown) => {
  assertInternalRenderer(event);
  if (typeof topicId !== 'string' || !topicId.trim()) throw new Error('主题标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryTopicService().promote(scope, topicId);
});
registerAppHandler('memory:delete-topic', (event: IpcMainInvokeEvent, topicId: unknown) => {
  assertInternalRenderer(event);
  if (typeof topicId !== 'string' || !topicId.trim()) throw new Error('主题标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  getMemoryTopicService().delete(scope, topicId);
  return true;
});
registerAppHandler('memory:list-documents', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryAffinityService().list(scope);
});
registerAppHandler('memory:delete-document', (event: IpcMainInvokeEvent, documentId: unknown) => {
  assertInternalRenderer(event);
  if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('文档标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryAffinityService().delete(scope, documentId);
});
registerAppHandler('memory:get-used-for-turn', (event: IpcMainInvokeEvent, turnId: unknown) => {
  assertInternalRenderer(event);
  if (typeof turnId !== 'string' || !turnId.trim()) throw new Error('回答标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryRecallService().listUsedMemories(scope, turnId);
});
registerAppHandler('memory:get-citation-source', (event: IpcMainInvokeEvent, turnId: unknown, itemId: unknown) => {
  assertInternalRenderer(event);
  if (typeof turnId !== 'string' || !turnId.trim() || typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆引用标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryRecallService().getCitationSource(scope, turnId, itemId);
});
registerAppHandler('memory:create-item', (event: IpcMainInvokeEvent, input: unknown) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryWriteService().createManual(scope, parseManualMemoryInput(input));
});
registerAppHandler('memory:update-item', (event: IpcMainInvokeEvent, itemId: unknown, patch: unknown) => {
  assertInternalRenderer(event);
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryWriteService().updateManual(scope, itemId, parseMemoryItemPatch(patch));
});
registerAppHandler('memory:delete-item', (event: IpcMainInvokeEvent, itemId: unknown) => {
  assertInternalRenderer(event);
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  getMemoryWriteService().delete(scope, itemId);
  return true;
});
registerAppHandler('memory:confirm-item', (event: IpcMainInvokeEvent, itemId: unknown, review: unknown) => {
  assertInternalRenderer(event);
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryWriteService().confirm(scope, itemId, parseMemoryProposalReview(review));
});
registerAppHandler('memory:get-proposal-context', (event: IpcMainInvokeEvent, itemId: unknown) => {
  assertInternalRenderer(event);
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
  return getMemoryWriteService().getProposalContext(resolveActiveLongTermMemoryScope().scope, itemId);
});
registerAppHandler('memory:get-turn-status', (event: IpcMainInvokeEvent, turnIds: unknown) => {
  assertInternalRenderer(event);
  if (!Array.isArray(turnIds) || turnIds.length > MEMORY_CONSTANTS.management.listDefaultLimit || turnIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('回答标识列表无效。');
  const { scope, workspacePath } = resolveActiveLongTermMemoryScope();
  return new MemoryTurnStatusService(qaMemoryDatabase, workspacePath, isMemoryExtractionRouteEnabled).get(scope, turnIds);
});
registerAppHandler('memory:approve-consolidation', (event: IpcMainInvokeEvent, id: unknown, fingerprint: unknown) => {
  assertInternalRenderer(event);
  if (typeof id !== 'string' || !id.trim() || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('整理预览参数无效。');
  const { scope, workspacePath } = resolveActiveLongTermMemoryScope();
  return getMemoryConsolidationService(workspacePath).approvePreview(scope, id, fingerprint);
});
registerAppHandler('memory:reject-item', (event: IpcMainInvokeEvent, itemId: unknown) => {
  assertInternalRenderer(event);
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryWriteService().reject(scope, itemId);
});
registerAppHandler('memory:clear', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const { scope } = resolveActiveLongTermMemoryScope();
  return getMemoryWriteService().clear(scope);
});
registerAppHandler('memory:export', async (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  if (!mainWindow) throw new Error('应用窗口不可用。');
  const { scope } = resolveActiveLongTermMemoryScope();
  const exported = getMemoryWriteService().export(scope);
  const target = await dialog.showSaveDialog(mainWindow, {
    title: '导出长期记忆',
    defaultPath: `Trellora-长期记忆-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (target.canceled || !target.filePath) return { canceled: true, exportedItems: 0 };
  fs.writeFileSync(target.filePath, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  return { canceled: false, exportedItems: exported.items.length };
});
registerAppHandler('memory:import', async (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  if (!mainWindow) throw new Error('应用窗口不可用。');
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '导入长期记忆备份',
    properties: ['openFile'],
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (selected.canceled || !selected.filePaths[0]) {
    return { canceled: true, importedItems: 0, unchangedItems: 0, skippedItems: 0 };
  }
  const parsed = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8')) as unknown;
  const { scope } = resolveActiveLongTermMemoryScope();
  return { canceled: false, ...getMemoryWriteService().import(scope, parsed) };
});
registerAppHandler('memory:consolidate', async (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const { scope, workspacePath } = resolveActiveLongTermMemoryScope();
  const service = getMemoryConsolidationService(workspacePath);
  let model: MemoryExtractionModelResolution | undefined;
  return service.consolidate(scope, 'manual', async (items, control) => {
    model ??= await resolveManualMemoryConsolidationModel(scope);
    if (!model.ready) throw new Error(`MODEL_UNAVAILABLE:${model.code}`);
    return reviewConsolidationWithModel(generateAiJsonWithOptions, model, items, control);
  });
});

registerAppHandler('assistant-memory:get-settings', (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const libraryPath = requireCurrentLibraryPath();
  return getAssistantMemoryRepository(libraryPath).getSettings();
});
registerAppHandler('assistant-memory:set-settings', (event: IpcMainInvokeEvent, mode: unknown) => {
  assertInternalRenderer(event);
  if (mode !== 'persistent' && mode !== 'session-only' && mode !== 'disabled') throw new Error('AI 会话记忆模式无效。');
  const libraryPath = requireCurrentLibraryPath();
  return getAssistantMemoryRepository(libraryPath).setSettings(mode);
});
registerAppHandler('assistant-memory:create-session', (event: IpcMainInvokeEvent, notePath: unknown) => {
  assertInternalRenderer(event);
  const { snapshot, repository } = getAssistantMemoryIpcContext(event, notePath);
  if (getAssistantMemoryMode(repository) !== 'persistent') {
    const createdAt = new Date().toISOString();
    return { sessionId: createAssistantSessionId(), title: '仅本次对话', status: 'active' as const, turnCount: 0, createdAt, updatedAt: createdAt };
  }
  const session = repository.createSession({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    title: '新对话',
  });
  const scope = repository.resolveScope({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    sessionId: session.sessionId,
  });
  assistantSessionScopeRegistry.authorize(scope, event.sender.id);
  return session;
});
registerAppHandler('assistant-memory:list-sessions', (event: IpcMainInvokeEvent, notePath: unknown, page?: unknown) => {
  assertInternalRenderer(event);
  const { snapshot, repository } = getAssistantMemoryIpcContext(event, notePath);
  if (getAssistantMemoryMode(repository) !== 'persistent') return { items: [] };
  return repository.listSessions({
    libraryId: snapshot.libraryId,
    relativePath: snapshot.relativePath,
    contentHash: snapshot.contentHash,
    ...(typeof page === 'number' ? { page } : {}),
  });
});
registerAppHandler('assistant-memory:get-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown, page?: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
  const { repository, scope } = getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
  return repository.getSession(scope, typeof page === 'number' ? page : undefined);
});
registerAppHandler('assistant-memory:archive-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
  const { repository, scope } = getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
  return repository.archiveSession(scope);
});
registerAppHandler('assistant-memory:delete-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
  const { repository, scope } = getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
  repository.deleteSession(scope);
  return true;
});
registerAppHandler('assistant-memory:clear-note', (event: IpcMainInvokeEvent, notePath: unknown) => {
  assertInternalRenderer(event);
  const { snapshot, repository } = getAssistantMemoryIpcContext(event, notePath);
  return repository.clearNote({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash });
});
registerAppHandler('assistant-memory:export-session', async (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown, format: unknown) => {
  assertInternalRenderer(event);
  if (typeof sessionId !== 'string' || (format !== 'markdown' && format !== 'json')) throw new Error('AI 会话导出参数无效。');
  const { repository, scope } = getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
  const exported = repository.exportSession(scope, format);
  if (!mainWindow) throw new Error('应用窗口不可用。');
  const target = await dialog.showSaveDialog(mainWindow, {
    title: '导出 AI 会话',
    defaultPath: exported.suggestedFileName,
    filters: [format === 'json' ? { name: 'JSON 文件', extensions: ['json'] } : { name: 'Markdown 文件', extensions: ['md'] }],
  });
  if (target.canceled || !target.filePath) return false;
  fs.writeFileSync(target.filePath, exported.content, 'utf8');
  return true;
});
registerAppHandler('assistant-memory:backup', async (event: IpcMainInvokeEvent) => {
  assertInternalRenderer(event);
  const libraryPath = requireCurrentLibraryPath();
  if (!mainWindow) throw new Error('应用窗口不可用。');
  const target = await dialog.showSaveDialog(mainWindow, {
    title: '备份 AI 会话记忆库',
    defaultPath: 'assistant-memory-backup.db',
    filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
  });
  if (target.canceled || !target.filePath) return false;
  await getAssistantMemoryRepository(libraryPath).backup(target.filePath);
  return true;
});
registerAppHandler('assistant-citation:validate', (event: IpcMainInvokeEvent, value: unknown): AssistantCitationValidation => {
  assertInternalRenderer(event);
  return validateAssistantCitationForCurrentNote(validateAssistantEvidenceCitation(value));
});
registerAppHandler('test-ai-provider-config', async (event, config: AiProviderConfig, context?: { profileId: string }) => {
  assertInternalRenderer(event);
  if (context && (typeof context.profileId !== 'string' || context.profileId.length > 128)) throw new Error('模型连接标识无效。');
  const previous = context ? readAiModelSettingsInput().profiles.find(profile => profile.id === context.profileId)?.config : readAiProviderConfig();
  const apiKey = resolveAiApiKey(config, previous);
  const runtimeConfig = normalizeProviderConfig({ ...config, apiKey });
  const token = context ? initializeOnboarding().beginTest(context.profileId, runtimeConfig) : undefined;
  try {
    const result = await testAiProviderConnection(runtimeConfig);
    if (context && token) initializeOnboarding().finishTest(context.profileId, token, result.available);
    return result;
  } catch (error) {
    if (context && token) initializeOnboarding().finishTest(context.profileId, token, false);
    throw error;
  }
});
registerAppHandler('fetch-ai-provider-models', async (event, config: AiProviderConfig, context?: { profileId: string }) => {
  assertInternalRenderer(event);
  if (context && (typeof context.profileId !== 'string' || context.profileId.length > 128)) throw new Error('模型连接标识无效。');
  const previous = context ? readAiModelSettingsInput().profiles.find(profile => profile.id === context.profileId)?.config : readAiProviderConfig();
  const apiKey = resolveAiApiKey(config, previous);
  return fetchAiProviderModels(normalizeProviderConfig({ ...config, apiKey }));
});
registerAppHandler('save-ai-provider-config', (_event, config: AiProviderConfig) => {
  if (!config || (config.kind !== 'ollama' && config.kind !== 'openai-compatible')) throw new Error('AI 提供方配置格式无效。');
  const previous = readAiProviderConfig();
  const apiKey = resolveAiApiKey(config, previous);
  if (config.kind === 'openai-compatible' && !apiKey) throw new Error('远程服务需要 API 密钥。');
  if (config.kind === 'openai-compatible' && !config.remoteContentConsent) throw new Error('请先确认远程发送范围。');
  const previousEmbeddingModel = getConfiguredEmbeddingModel();
  const nextEmbeddingModel = config.embeddingModel?.trim() ?? previousEmbeddingModel;
  const settings = readAiModelSettingsInput(false);
  const input: AiModelSettingsInput = {
    defaultProfileId: settings.defaultProfileId,
    profiles: settings.profiles.map((profile) => profile.id === settings.defaultProfileId
      ? { ...profile, config: { ...config, apiKey, embeddingModel: nextEmbeddingModel } }
      : profile),
  };
  saveAiModelSettings(input);
  return { ...getAiProviderConfig(), embeddingModel: nextEmbeddingModel };
});

registerAppHandler('get-favorite-notes', async () => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return [];
  if (!noteIndex) refreshLibraryIndex();
  return getFavoriteNotePaths(libraryPath);
});

registerAppHandler('set-favorite-note', async (_event, filePath: string, favorite: boolean) => {
  const libraryPath = requireCurrentLibraryPath();
  const safePath = assertInsideDirectory(filePath, libraryPath);
  if (!noteIndex) refreshLibraryIndex();
  return setFavoriteNote(libraryPath, safePath, Boolean(favorite));
});

registerAppHandler('search-notes-unified', async (_event, query: string) => {
  await indexCoordinator.awaitCurrent();
  return searchNotesUnified(query);
});

registerAppHandler('get-ai-insight', async (_event, filePath: string) => {
  await indexCoordinator.awaitCurrent();
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return null;
  assertInsideDirectory(filePath, libraryPath);
  if (!noteIndex) refreshLibraryIndex();
  const note = noteIndex?.notesByPath[path.resolve(filePath)];
  if (!note) return null;
  return getAiInsight(libraryPath, note.path, note.contentHash);
});

/** 每库首次访问恢复中断任务；只操作该库的概览任务表。 */
function getNoteAnalysisRepository(): NoteAnalysisBatchRepository {
  const libraryPath = requireCurrentLibraryPath();
  let repository = noteAnalysisRepositories.get(libraryPath);
  if (!repository) {
    repository = new NoteAnalysisBatchRepository(libraryPath);
    repository.recoverInterrupted();
    noteAnalysisRepositories.set(libraryPath, repository);
  }
  return repository;
}

function isNoteAnalysisSourceCurrent(libraryPath: string, notePath: string, sourceHash: string): boolean {
  try {
    return getCurrentLibraryPath() === libraryPath && getNoteAnalysisSourceHash(readTextFile(notePath)) === sourceHash;
  } catch {
    return false;
  }
}

function exposeNoteAnalysisRun(repository: NoteAnalysisBatchRepository, run: NoteAnalysisRunDetail | null): NoteAnalysisRunDetail | null {
  if (!run) return null;
  assertInsideDirectory(run.notePath, repository.libraryPath);
  return { ...run, ...(isNoteAnalysisSourceCurrent(repository.libraryPath, run.notePath, run.sourceHash) ? {} : { isStale: true }) };
}

/** 密钥仅从主进程模型中枢取出；getAiProviderConfig是安全视图，不含密钥。 */
function getNoteAnalysisConfig(): AiProviderConfig {
  const { hasApiKey: _hasKey, ...view } = getAiProviderConfig();
  return { ...JSON.parse(JSON.stringify(view)), apiKey: resolveGenerationConfig(store).apiKey };
}

/** 固定已保存原文与模型配置，生成入口和兼容入口共用同一批次编排器。 */
function startNoteAnalysis(filePath: string, selectedModel?: string): NoteAnalysisRunDetail {
  const repository = getNoteAnalysisRepository();
  const safePath = assertInsideDirectory(filePath, repository.libraryPath);
  if (!noteIndex) refreshLibraryIndex();
  const note = noteIndex?.notesByPath[path.resolve(safePath)];
  if (!note || note.kind !== 'markdown') throw new Error('请先选择一篇可编辑的Markdown笔记。');
  const markdown = readTextFile(safePath);
  const config = { ...getNoteAnalysisConfig(), model: selectedModel?.trim() || getAiProviderConfig().model };
  if (!config.model) throw new Error('请先在模型设置中选择可用模型。');
  if (config.kind !== 'ollama' && (!config.remoteContentConsent || !config.apiKey)) throw new Error('请先配置可用的远程模型及内容发送确认。');
  const { apiKey: _secret, ...safeConfig } = config;
  const input: NoteAnalysisRunInput = { markdown, title: note.title, currentTags: note.tags, libraryTags: getLibraryTagVocabulary(), config: JSON.parse(JSON.stringify(safeConfig)) };
  const sourceHash = getNoteAnalysisSourceHash(markdown);
  return noteAnalysisOrchestrator.start({ repository, notePath: safePath, sourceHash, input, config, isSourceCurrent: () => isNoteAnalysisSourceCurrent(repository.libraryPath, safePath, sourceHash), onProgress: (progress) => { if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('note-analysis-progress', progress); } });
}

registerAppHandler('get-note-analysis', async (event, filePath: string) => {
  await indexCoordinator.awaitCurrent();
  assertInternalRenderer(event);
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return null;
  assertInsideDirectory(filePath, libraryPath);
  if (!noteIndex) refreshLibraryIndex();
  const note = noteIndex?.notesByPath[path.resolve(filePath)];
  return note ? getNoteAnalysis(libraryPath, note.path, getNoteAnalysisSourceHash(note.rawMarkdown)) : null;
});

registerAppHandler('start-note-analysis', async (event, filePath: string, model?: string) => {
  await indexCoordinator.awaitCurrent();
  assertInternalRenderer(event);
  const run = startNoteAnalysis(filePath, model);
  return { runId: run.runId, state: run.state };
});

registerAppHandler('get-latest-note-analysis-run', (event, filePath: string) => {
  assertInternalRenderer(event);
  const repository = getNoteAnalysisRepository();
  const safePath = assertInsideDirectory(filePath, repository.libraryPath);
  return exposeNoteAnalysisRun(repository, repository.getLatest(safePath));
});

registerAppHandler('get-note-analysis-run', (event, runId: string) => {
  assertInternalRenderer(event);
  const repository = getNoteAnalysisRepository();
  return exposeNoteAnalysisRun(repository, repository.get(runId));
});

registerAppHandler('cancel-note-analysis', (event, runId: string) => {
  assertInternalRenderer(event);
  const repository = getNoteAnalysisRepository();
  const run = exposeNoteAnalysisRun(repository, repository.get(runId));
  if (!run) throw new Error('找不到当前笔记库的分析任务。');
  return noteAnalysisOrchestrator.cancel(repository, runId);
});

registerAppHandler('resume-note-analysis', (event, runId: string) => {
  assertInternalRenderer(event);
  const repository = getNoteAnalysisRepository();
  const run = exposeNoteAnalysisRun(repository, repository.get(runId));
  if (!run) throw new Error('找不到当前笔记库的分析任务。');
  const config = getNoteAnalysisConfig();
  if (config.kind !== 'ollama' && (!config.remoteContentConsent || !config.apiKey)) throw new Error('请先配置可用的远程模型及内容发送确认。');
  if (noteAnalysisProviderFingerprint(config) !== run.providerFingerprint) throw new Error('模型配置已变化，请重新分析。');
  return noteAnalysisOrchestrator.resume(repository, runId, config, () => isNoteAnalysisSourceCurrent(repository.libraryPath, run.notePath, run.sourceHash), (progress) => { if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('note-analysis-progress', progress); });
});

registerAppHandler('generate-note-analysis', async (event, filePath: string, model: string) => {
  await indexCoordinator.awaitCurrent();
  assertInternalRenderer(event);
  const repository = getNoteAnalysisRepository();
  const run = startNoteAnalysis(filePath, model);
  await noteAnalysisOrchestrator.waitForCompletion(repository, run.runId);
  const analysis = getNoteAnalysis(repository.libraryPath, run.notePath, run.sourceHash);
  if (!analysis) throw new Error('分析已完成，但无法读取概览产物。');
  return analysis;
});

registerAppHandler('generate-ai-insight', async (_event, filePath: string, model: string) => {
  await indexCoordinator.awaitCurrent();
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('请先选择笔记库。');
  assertInsideDirectory(filePath, libraryPath);
  if (!noteIndex) refreshLibraryIndex();
  const note = noteIndex?.notesByPath[path.resolve(filePath)];
  if (!note) throw new Error('找不到当前笔记，无法生成 AI 建议。');

  const [summaryResult, tagResult] = await Promise.all([
    runLocalKnowledgeAgent({ type: 'summary', model, markdown: note.rawMarkdown }),
    runLocalKnowledgeAgent({ type: 'tags', model, markdown: note.rawMarkdown }),
  ]);
  if (summaryResult.type !== 'summary' || tagResult.type !== 'tags') {
    throw new Error('知识 Agent 返回了无法识别的结果。');
  }
  return saveAiInsight(libraryPath, {
    summary: summaryResult.summary,
    keyPoints: summaryResult.keyPoints,
    suggestedTags: tagResult.suggestedTags,
    notePath: note.path,
    contentHash: note.contentHash,
    provider: getAiProviderConfig().kind,
    model,
  });
});

registerAppHandler('apply-ai-tags', () => { throw new Error('请通过笔记编辑会话应用标签。'); });

registerAppHandler('ask-knowledge-assistant', async (_event, question: string, model: string) => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('请先选择笔记库。');
  if (!noteIndex) refreshLibraryIndex();
  const search = runKeywordSearchAgent(question);
  const sources = search.results.flatMap((match) => {
    const note = noteIndex?.notesByPath[path.resolve(match.path)];
    return note ? [{
      path: note.path,
      title: note.title,
      content: note.contentMarkdown,
      snippet: createSourceSnippet(note.plainText, question),
      score: match.score,
      methods: match.methods,
      ...(match.matchTrace?.length ? { matchTrace: match.matchTrace } : {}),
    }] : [];
  });
  const result = await runLocalKnowledgeAgent({
    type: 'answer', question, model, sources: sources.map(({ title, content }) => ({ title, content })),
  });
  if (result.type !== 'answer') throw new Error('问答 Agent 返回了无法识别的结果。');
  return {
    ...result,
    sourceNotes: sources.map((source) => ({
      path: source.path,
      title: source.title,
      snippet: source.snippet,
      score: source.score,
      methods: source.methods,
      ...(source.matchTrace?.length ? { matchTrace: source.matchTrace } : {}),
    })),
    retrievalMode: search.mode,
  };
});

registerAppHandler('generate-learning-plan', async (_event, goal: string, model: string) => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('请先选择笔记库。');
  if (!noteIndex) refreshLibraryIndex();
  const search = runKeywordSearchAgent(goal);
  const sources = search.results.flatMap((match) => {
    const note = noteIndex?.notesByPath[path.resolve(match.path)];
    return note ? [{ title: note.title, content: note.contentMarkdown }] : [];
  });
  const result = await runLocalKnowledgeAgent({ type: 'plan', goal, model, sources });
  if (result.type !== 'plan') throw new Error('学习路径 Agent 返回了无法识别的结果。');
  return saveLearningPlan(libraryPath, { goal, provider: getAiProviderConfig().kind, model, steps: result.steps });
});

registerAppHandler('generate-organization-suggestion', async (_event, model: string) => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('请先选择笔记库。');
  if (!noteIndex) refreshLibraryIndex();
  const notes = noteIndex?.notes.map((note) => ({
    title: note.title,
    tags: note.tags,
    headings: note.headings.map((heading) => heading.text),
  })) ?? [];
  const result = await runLocalKnowledgeAgent({ type: 'organize', model, notes });
  if (result.type !== 'organize') throw new Error('整理建议 Agent 返回了无法识别的结果。');
  return saveOrganizationSuggestion(libraryPath, { provider: getAiProviderConfig().kind, model, groups: result.groups, nextActions: result.nextActions });
});

/** Reserve application writers and watcher publication before changing a path. */
async function changeEntryPath(oldPath: string, move: (library: string) => Promise<string | null>): Promise<string | null> {
  const library = requireCurrentLibraryPath();
  const safeOld = assertInsideDirectory(oldPath, library);
  const changed = await noteSaveService.structure(library, () => indexCoordinator.mutate(async () => {
    const affected = (noteIndex?.notes ?? []).filter((note) => note.path === safeOld || note.path.startsWith(`${safeOld}${path.sep}`));
    const order = loadTreeOrder(library);
    const newPath = await move(library);
    if (!newPath || newPath === safeOld) return { value: newPath, changes: [] };
    try { migrateLibraryUiStatePath(library, safeOld, newPath); }
    catch (error) { await restoreEntryPath(library, newPath, safeOld, order); migrateLibraryUiStatePath(library, newPath, safeOld); throw error; }
    return { value: newPath, changes: [{ kind: 'unlink', path: safeOld }, { kind: 'add', path: newPath }],
      moves: affected.map((note) => ({ from: note.path, to: path.join(newPath, path.relative(safeOld, note.path)) })),
      rollback: async () => { await restoreEntryPath(library, newPath, safeOld, order); migrateLibraryUiStatePath(library, newPath, safeOld); },
    };
  }));
  if (changed === safeOld) await indexCoordinator.reorder(path.dirname(safeOld));
  return changed;
}
registerAppHandler('rename-file', (event, oldPath: string, newName: string) => { assertNoteWindow(event); return changeEntryPath(oldPath, (library) => renameEntryInLibrary(library, oldPath, newName)); });
registerAppHandler('rename-entry', (event, oldPath: string, newName: string) => { assertNoteWindow(event); return changeEntryPath(oldPath, (library) => renameEntryInLibrary(library, oldPath, newName)); });
async function trashEntry(entryPath: string): Promise<boolean> {
  const library = requireCurrentLibraryPath(), safePath = assertInsideDirectory(entryPath, library);
  return noteSaveService.structure(library, () => indexCoordinator.mutate(async () => {
    if (!fs.existsSync(safePath)) return { value: false, changes: [] };
    await shell.trashItem(safePath); pruneLibraryUiState(library);
    return { value: true, changes: [{ kind: 'unlink', path: safePath }] };
  }));
}
registerAppHandler('delete-file', (event, filePath: string) => { assertNoteWindow(event); return trashEntry(filePath); });
registerAppHandler('delete-entry', (event, entryPath: string) => { assertNoteWindow(event); return trashEntry(entryPath); });

registerAppHandler('create-file', async (_event: IpcMainInvokeEvent, fileName?: string, parentDirectoryPath?: string | null) => {
  const libraryPath = requireCurrentLibraryPath();
  const parentDirectory = parentDirectoryPath
    ? assertInsideDirectory(parentDirectoryPath, libraryPath)
    : libraryPath;
  if (!fs.existsSync(parentDirectory) || !fs.statSync(parentDirectory).isDirectory()) return null;

  // Use provided name or generate timestamp-based name
  const baseName = sanitizeEntryName(fileName?.trim() || 'Untitled');
  const filePath = getUniquePath(parentDirectory, `${baseName}.md`);

  // Create file with default content
  const defaultContent = `# ${baseName}\n\nStart writing here...`;
  await noteSaveService.structure(libraryPath, () => indexCoordinator.mutate(async () => {
    await fs.promises.writeFile(filePath, defaultContent, { encoding: 'utf8', flag: 'wx' });
    return { value: filePath, changes: [{ kind: 'add', path: filePath }] };
  }));

  return filePath;
});

registerAppHandler('create-folder', async (_event: IpcMainInvokeEvent, parentDirectoryPath: string | null, folderName: string) => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return null;
  const folderPath = await noteSaveService.structure(libraryPath, () => indexCoordinator.mutate(() => {
    const value = createFolderInLibrary(libraryPath, parentDirectoryPath, folderName);
    return { value, changes: value ? [{ kind: 'addDir', path: value }] : [] };
  }));
  return folderPath;
});

registerAppHandler('move-entry', (event, sourcePath: string, targetDirectoryPath: string, position?: MovePosition) => {
  assertNoteWindow(event);
  return changeEntryPath(sourcePath, (library) => moveEntryInLibrary(library, sourcePath, targetDirectoryPath, position));
});

registerAppHandler('save-tree-order', async (_event: IpcMainInvokeEvent, parentDirectoryPath: string, orderedChildPaths: string[]) => {
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return false;
  const saved = saveDirectoryOrder(libraryPath, parentDirectoryPath, orderedChildPaths);
  await indexCoordinator.reorder(parentDirectoryPath);
  return saved;
});

registerAppHandler('import-files', async (_event: IpcMainInvokeEvent, targetDirectoryPath?: string | null) => {
  if (!mainWindow) return [];
  const libraryPath = requireCurrentLibraryPath();

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Text and Markdown Files',
        extensions: [
          'md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'log',
          'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp',
          'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql',
        ],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return [];

  const importedFiles = await noteSaveService.structure(libraryPath, () => indexCoordinator.mutate(() => {
    const value = importTextFilesToLibrary({ libraryPath, sourcePaths: result.filePaths, targetDirectoryPath });
    return { value, changes: value.map((file) => ({ kind: 'add', path: file.targetPath })) };
  }));
  return importedFiles;
});

registerAppHandler('get-note-meta', async (_event, filePath: string) => {
  try { await indexCoordinator.awaitCurrent(); } catch { /* Keep the last complete facts available for editing; search/AI still require current projections. */ }
  if (!noteIndex) refreshLibraryIndex();
  if (!noteIndex) return null;
  return getNoteMeta(noteIndex, filePath);
});

registerAppHandler('get-backlinks', async (_event, filePath: string) => {
  await indexCoordinator.awaitCurrent();
  if (!noteIndex) refreshLibraryIndex();
  if (!noteIndex) return [];
  return getBacklinks(noteIndex, filePath);
});

registerAppHandler('get-all-tags', async () => {
  await indexCoordinator.awaitCurrent();
  if (!noteIndex) refreshLibraryIndex();
  if (!noteIndex) return [];
  return getAllTags(noteIndex);
});

registerAppHandler('get-files-by-tag', async (_event, tag: string) => {
  await indexCoordinator.awaitCurrent();
  if (!noteIndex) refreshLibraryIndex();
  if (!noteIndex) return [];
  return getFilesByTag(noteIndex, tag);
});

registerAppHandler('resolve-wiki-link', async (_event, target: string, fromPath?: string) => {
  if (!noteIndex) refreshLibraryIndex();
  if (!noteIndex) return null;
  return resolveWikiLink(noteIndex, target, fromPath);
});

registerAppHandler('create-linked-note', async (_event, target: string, fromPath?: string) => {
  if (!store) return null;
  if (!noteIndex) refreshLibraryIndex();
  const libraryPath = store.get('libraryPath') as string;
  if (!libraryPath || !fs.existsSync(libraryPath)) return null;

  if (noteIndex) {
    const existingPath = resolveWikiLink(noteIndex, target, fromPath);
    if (existingPath) return existingPath;
  }

  const baseName = sanitizeFileName(path.basename(target).replace(/\.md$/i, '').trim() || 'Untitled');
  const baseDirectory = fromPath && fs.existsSync(fromPath)
    ? path.dirname(fromPath)
    : libraryPath;
  const targetDirectory = path.resolve(baseDirectory);
  const safeDirectory = isInsideDirectory(targetDirectory, libraryPath) ? targetDirectory : path.resolve(libraryPath);

  let filePath = path.join(safeDirectory, `${baseName}.md`);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(safeDirectory, `${baseName} ${counter}.md`);
    counter++;
  }

  await noteSaveService.structure(libraryPath, () => indexCoordinator.mutate(async () => {
    await fs.promises.writeFile(filePath, `# ${baseName}\n\n`, { encoding: 'utf8', flag: 'wx' });
    return { value: filePath, changes: [{ kind: 'add', path: filePath }] };
  }));
  return filePath;
});

registerAppHandler('save-editor-image', async (event, request: unknown) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('当前窗口无权保存编辑器图片。');
  }
  if (documentSessionService?.hasActive(event.sender.id)) throw new Error('独立文件当前不支持图片写入，请先加入笔记库。');

  const libraryPath = requireCurrentLibraryPath();
  if (!request || typeof request !== 'object') throw new Error('图片保存请求无效。');
  const input = request as { notePath?: unknown; bytes?: unknown; sourcePath?: unknown };
  if (typeof input.notePath !== 'string' || !input.notePath.trim()) {
    throw new Error('当前笔记路径无效。');
  }
  const notePath = assertInsideDirectory(input.notePath, libraryPath);

  const hasBytes = input.bytes !== undefined;
  const hasSourcePath = input.sourcePath !== undefined;
  if (hasBytes === hasSourcePath) {
    throw new Error('图片保存请求必须且只能包含一种图片来源。');
  }

  let buffer: Buffer;
  if (hasSourcePath) {
    if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) {
      throw new Error('剪贴板图片路径无效。');
    }
    const sourcePath = path.resolve(input.sourcePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      throw new Error('找不到剪贴板中的本地图片。');
    }
    if (!stat.isFile()) throw new Error('剪贴板图片路径不是文件。');
    if (stat.size > MAX_EDITOR_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');
    buffer = fs.readFileSync(sourcePath);
  } else {
    buffer = toEditorImageBuffer(input.bytes);
  }

  return saveEditorImageToLibrary(libraryPath, notePath, buffer);
});

function toEditorImageBuffer(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Buffer.from(value);
  }
  throw new Error('剪贴板图片数据无效。');
}

registerAppHandler('list-backups', async (event, filePath: string) => {
  assertNoteWindow(event);
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) return [];
  return noteSaveService.listBackups(filePath);
});

registerAppHandler('restore-backup', () => { throw new Error('请通过笔记编辑会话恢复备份。'); });

const MAX_MARKDOWN_EXPORT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_EXPORT_HTML_BYTES = 40 * 1024 * 1024;

registerAppHandler('read-markdown-export-image', async (event, source: string) => {
  assertNoteWindow(event);
  const libraryPath = getCurrentLibraryPath();
  if (!libraryPath) throw new Error('当前未打开笔记库，无法读取导出图片。');
  if (typeof source !== 'string') throw new Error('导出图片地址无效。');
  if (/^https?:\/\//i.test(source)) return readRemoteExportImage(source, MAX_MARKDOWN_EXPORT_IMAGE_BYTES, requestExportImage);
  return readEditorImageDataUrl(source, libraryPath, MAX_MARKDOWN_EXPORT_IMAGE_BYTES);
});

registerAppHandler('export-note', async (event, request: NoteExportRequest) => {
  assertNoteWindow(event);
  if (!request || typeof request.sourcePath !== 'string') throw new Error('笔记导出参数无效。');
  assertInsideDirectory(request.sourcePath, requireCurrentLibraryPath());
  if (!mainWindow) return false;
  return exportNoteFile(mainWindow, request);
});

registerAppHandler('export-html', async (_event, defaultName: string, html: string) => {
  if (!mainWindow) return false;
  if (typeof defaultName !== 'string' || typeof html !== 'string') {
    throw new Error('HTML 导出内容无效。');
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_MARKDOWN_EXPORT_HTML_BYTES) {
    throw new Error('导出文件超过 40 MB 上限。请压缩图片或拆分笔记后重试。');
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${defaultName.replace(/[<>:"/\\|?*]/g, '') || 'note'}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });

  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, html, 'utf8');
  return true;
});

function sanitizeFileName(fileName: string): string {
  const withoutInvalidPathChars = fileName.replace(/[<>:"/\\|?*]/g, '');
  return [...withoutInvalidPathChars].filter((char) => char.charCodeAt(0) >= 32).join('').trim() || 'Untitled';
}

function isInsideDirectory(candidatePath: string, parentPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

registerAppHandler('search-notes', async (_event, query) => {
  await indexCoordinator.awaitCurrent();
  return searchKeywordCandidates(String(query ?? '')).map((result) => ({
    id: result.path,
    ...result,
    lineNumber: 1,
  }));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startupInitialization = initAndCreate();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
