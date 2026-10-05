import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { readStartupAppearance } from '../shared/startupAppearance';
import type { WorkspaceMigrationStatus } from '../shared/workspaceMigration';
import type { CapabilityProbeRequest, CapabilityRequest } from '../shared/userCapabilities';
import type { BackupConfiguration, BackupStatus, RestoreStatus } from '../shared/workspaceBackup';
import type { NoteMutationRequest, SaveNoteRequest, NoteCloseResponse } from '../shared/noteSave';
import type { CreateAssistantNoteRequest } from '../shared/assistantNote';
import type { NoteExportRequest } from '../shared/noteExport';
import type { SelectionTransformRequest } from './knowledge/selectionTransformTypes';
import type { SelectionEditRunRequest, SelectionEditRunResult } from './knowledge/selectionEditIpc';
import type { SelectionExpansionCapabilities, SelectionExpansionEvent, SelectionExpansionRequest, SelectionExpansionSettings, SelectionExpansionSettingsPatch, SelectionExpansionSourcePreparation } from './knowledge/selectionExpansionTypes';
import type { AssistantAttachment, AssistantCitationValidation, AssistantEvidenceCitation, AssistantTurnEvent, AssistantTurnRequest } from './knowledge/assistantTurnTypes';
import type { AssistantMemoryMode, AssistantMemorySettings, AssistantSessionDetail, AssistantSessionSummary } from './knowledge/assistantMemoryTypes';
import type { QaMemoryPage, QaSessionDetail, QaSessionScope, QaSessionSummary } from './knowledge/qaMemoryTypes';
import type { ManualMemoryInput, MemoryExtractionRuntimeStatus, MemoryClearResult, MemoryConsolidationResult, MemoryDocumentAffinity, MemoryImportResult, MemoryItemListQuery, MemoryItemPage, MemoryItemPatch, MemoryItemRecord, MemorySubjectRecord, MemoryTopicRecord, MemoryUsedSnapshot, MemoryWriteResult, WorkspaceMemoryConfig, MemoryProposalReview, MemoryProposalContext, MemoryTurnStatus } from './knowledge/memory/memoryTypes';
import type { MemoryCitationSource } from '../shared/memoryCitations';
import type { MemoryPage, MemoryPageQuery, MemoryItemPageQuery, MemoryItemCounts } from './knowledge/memory/memoryTypes';
import type { MemoryCutoverReport } from './knowledge/memory/memoryCutover';
import type { AssistantDetailedTraceRecordView } from './knowledge/assistantDetailedTrace';
import type { AiExtensionsSettings, AiModelSettingsInput, AiSkillImportKind, AiSkillsOverview, SkillDocumentUpdateResult, SkillExportResult, SkillFormCreateInput, SkillImportResult } from './knowledge/aiTypes';
import type { WikiSiblingOrderRequest, WikiSiblingOrderResult } from './wikiOutline';
import type {
  WikiDerivedDeleteRequest,
  WikiDerivedDeleteResult,
  WikiDerivedNodeRequest,
  WikiDerivedNodeResult,
  WikiDerivedRenameRequest,
} from './wiki/wikiDerivedNodes';
import type {
  WikiAiMemoryCreateRequest,
  WikiAiMemoryDeleteRequest,
  WikiAiMemoryDeleteResult,
  WikiAiMemoryListResult,
  WikiAiMemoryPinRequest,
  WikiAiMemoryRenameRequest,
  WikiAiMemoryResult,
  WikiAiMemoryUpsertRequest,
} from './wiki/wikiAiMemories';
import type { WikiNodeQuestionsResult } from './wiki/wikiNodeQuestions';

let noteCloseSubscribers = 0;
// 首帧期间尚无可编辑内容；React 接管后继续使用原有保存握手。
ipcRenderer.on('notes:close-request', (_event, request: { requestId: string }) => {
    if (noteCloseSubscribers === 0) ipcRenderer.send('notes:close-response', { requestId: request.requestId, ok: true });
});

contextBridge.exposeInMainWorld('electronAPI', {
    startupAppearance: readStartupAppearance(process.argv),
    waitForStartup: () => ipcRenderer.invoke('startup:ready'),
    ping: () => ipcRenderer.invoke('ping'),
    // File System APIs
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
    getWorkspacePath: () => ipcRenderer.invoke('get-workspace-path'),
    getWorkspaceMigrationState: () => ipcRenderer.invoke('workspace-migration:get-state'),
    previewWorkspaceMigration: () => ipcRenderer.invoke('workspace-migration:preview'),
    startWorkspaceMigration: (id: string) => ipcRenderer.invoke('workspace-migration:start', id),
    cancelWorkspaceMigration: () => ipcRenderer.invoke('workspace-migration:cancel'),
    abandonWorkspaceMigration: (id: string) => ipcRenderer.invoke('workspace-migration:abandon', id),
    openWorkspaceFolder: () => ipcRenderer.invoke('workspace-migration:open-folder'),
    openExistingWorkspace: () => ipcRenderer.invoke('workspace-migration:open-existing'),
    onWorkspaceMigrationStatus: (callback: (status: WorkspaceMigrationStatus) => void) => {
      const listener = (_event: unknown, status: WorkspaceMigrationStatus) => callback(status);
      ipcRenderer.on('workspace-migration:status', listener);
      return () => ipcRenderer.removeListener('workspace-migration:status', listener);
    },
    listLibraries: () => ipcRenderer.invoke('list-libraries'),
    addLibrary: () => ipcRenderer.invoke('add-library'),
    createLibrary: (name: string, parentDirectoryPath?: string | null) => ipcRenderer.invoke('create-library', name, parentDirectoryPath),
    activateLibrary: (libraryPath: string) => ipcRenderer.invoke('activate-library', libraryPath),
    removeLibrary: (libraryPath: string) => ipcRenderer.invoke('remove-library', libraryPath),
    getLibraryPath: () => ipcRenderer.invoke('get-library-path'),
    // Materials Library APIs
    listMaterialsLibraries: () => ipcRenderer.invoke('list-materials-libraries'),
    createMaterialsLibrary: (name: string, icon?: string | null, chunkingConfigDraft?: unknown) => ipcRenderer.invoke('create-materials-library', name, icon, chunkingConfigDraft),
    openMaterialsLibrary: (libraryPath: string) => ipcRenderer.invoke('open-materials-library', libraryPath),
    renameMaterialsLibrary: (libraryPath: string, alias: string) => ipcRenderer.invoke('rename-materials-library', libraryPath, alias),
    removeMaterialsLibrary: (libraryPath: string) => ipcRenderer.invoke('remove-materials-library', libraryPath),
    deleteMaterialsLibrary: (libraryPath: string) => ipcRenderer.invoke('delete-materials-library', libraryPath),
    upgradeLibraryToMaterials: (libraryPath: string, icon?: string | null, chunkingConfigDraft?: unknown) => ipcRenderer.invoke('upgrade-library-to-materials', libraryPath, icon, chunkingConfigDraft),
    listMaterialsDocuments: (libraryPath: string) => ipcRenderer.invoke('list-materials-documents', libraryPath),
    getMaterialsPipelineStatus: (libraryPath: string) => ipcRenderer.invoke('get-materials-pipeline-status', libraryPath),
    getWikiDocumentOutline: (libraryPath: string, documentId: string) => ipcRenderer.invoke('get-wiki-document-outline', libraryPath, documentId),
    importWikiDocumentToNoteLibrary: (sourceLibraryPath: string, documentId: string, contentHash: string, targetLibraryPath: string) => ipcRenderer.invoke('wiki:import-to-note-library', sourceLibraryPath, documentId, contentHash, targetLibraryPath),
    reorderWikiSiblingNodes: (libraryPath: string, request: WikiSiblingOrderRequest) => ipcRenderer.invoke('reorder-wiki-sibling-nodes', libraryPath, request) as Promise<WikiSiblingOrderResult>,
    addWikiDerivedNode: (libraryPath: string, request: WikiDerivedNodeRequest) => ipcRenderer.invoke('wiki:add-derived-node', libraryPath, request) as Promise<WikiDerivedNodeResult>,
    renameWikiDerivedNode: (libraryPath: string, request: WikiDerivedRenameRequest) => ipcRenderer.invoke('wiki:rename-derived-node', libraryPath, request) as Promise<WikiDerivedNodeResult>,
    deleteWikiDerivedNode: (libraryPath: string, request: WikiDerivedDeleteRequest) => ipcRenderer.invoke('wiki:delete-derived-node', libraryPath, request) as Promise<WikiDerivedDeleteResult>,
    listWikiAiMemories: (libraryPath: string, documentId: string) => ipcRenderer.invoke('wiki:list-ai-memories', libraryPath, documentId) as Promise<WikiAiMemoryListResult>,
    upsertWikiAiMemory: (libraryPath: string, request: WikiAiMemoryUpsertRequest) => ipcRenderer.invoke('wiki:upsert-ai-memory', libraryPath, request) as Promise<WikiAiMemoryResult>,
    createWikiAiMemory: (libraryPath: string, request: WikiAiMemoryCreateRequest) => ipcRenderer.invoke('wiki:create-ai-memory', libraryPath, request) as Promise<WikiAiMemoryResult>,
    setWikiAiMemoryPinned: (libraryPath: string, request: WikiAiMemoryPinRequest) => ipcRenderer.invoke('wiki:set-ai-memory-pinned', libraryPath, request) as Promise<WikiAiMemoryResult>,
    renameWikiAiMemory: (libraryPath: string, request: WikiAiMemoryRenameRequest) => ipcRenderer.invoke('wiki:rename-ai-memory', libraryPath, request) as Promise<WikiAiMemoryResult>,
    deleteWikiAiMemory: (libraryPath: string, request: WikiAiMemoryDeleteRequest) => ipcRenderer.invoke('wiki:delete-ai-memory', libraryPath, request) as Promise<WikiAiMemoryDeleteResult>,
    getWikiNodeQuestions: (libraryPath: string, documentId: string, nodeId: string) => ipcRenderer.invoke('wiki:get-node-questions', libraryPath, documentId, nodeId) as Promise<WikiNodeQuestionsResult>,
    refreshWikiNodeQuestions: (libraryPath: string, documentId: string, nodeId: string) => ipcRenderer.invoke('wiki:refresh-node-questions', libraryPath, documentId, nodeId) as Promise<WikiNodeQuestionsResult>,
    getMaterialEmbeddingProfile: (libraryPath: string) => ipcRenderer.invoke('get-material-embedding-profile', libraryPath),
    listMaterialVectorGenerations: (libraryPath: string) => ipcRenderer.invoke('material-vector-generations:list', libraryPath),
    createMaterialVectorGeneration: (libraryPath: string, candidate: unknown) => ipcRenderer.invoke('material-vector-generations:create', libraryPath, candidate),
    resumeMaterialVectorGeneration: (libraryPath: string, id: string) => ipcRenderer.invoke('material-vector-generations:resume', libraryPath, id),
    cancelMaterialVectorGeneration: (libraryPath: string, id: string) => ipcRenderer.invoke('material-vector-generations:cancel', libraryPath, id),
    activateMaterialVectorGeneration: (libraryPath: string, id: string) => ipcRenderer.invoke('material-vector-generations:activate', libraryPath, id),
    getLibraryPipelineLlm: (libraryPath: string) => ipcRenderer.invoke('get-library-pipeline-llm', libraryPath),
    saveLibraryPipelineLlm: (libraryPath: string, patch: unknown) => ipcRenderer.invoke('save-library-pipeline-llm', libraryPath, patch),
    testMaterialEmbeddingProfile: (libraryPath: string, candidate: unknown) => ipcRenderer.invoke('test-material-embedding-profile', libraryPath, candidate),
    lockMaterialEmbeddingProfile: (libraryPath: string, candidate: unknown) => ipcRenderer.invoke('lock-material-embedding-profile', libraryPath, candidate),
      getPipelineArtifactPreview: (libraryPath: string, documentId: string, stage: string, fileName: string, offset?: number, limit?: number, parentChunkId?: string) => ipcRenderer.invoke('get-pipeline-artifact-preview', libraryPath, documentId, stage, fileName, offset, limit, parentChunkId),
      getPipelineKeywordPreview: (libraryPath: string, documentId: string, offset?: number, limit?: number) => ipcRenderer.invoke('get-pipeline-keyword-preview', libraryPath, documentId, offset, limit),
    searchMaterialChunks: (libraryPath: string, query: string, mode?: 'hybrid' | 'keyword' | 'semantic', documentIds?: string[]) => ipcRenderer.invoke('search-material-chunks', libraryPath, query, mode, documentIds),
    startMaterialsPipeline: (libraryPath: string, documentId: string) => ipcRenderer.invoke('start-materials-pipeline', libraryPath, documentId),
    cancelMaterialsPipeline: (libraryPath: string, documentId: string) => ipcRenderer.invoke('cancel-materials-pipeline', libraryPath, documentId),
    retryMaterialsPipeline: (libraryPath: string, documentId: string) => ipcRenderer.invoke('retry-materials-pipeline', libraryPath, documentId),
    readMaterialsDocument: (libraryPath: string, documentId: string) => ipcRenderer.invoke('read-materials-document', libraryPath, documentId),
    readMaterialsDocumentBytes: (libraryPath: string, documentId: string) => ipcRenderer.invoke('read-materials-document-bytes', libraryPath, documentId),
    renameMaterialsDocument: (libraryPath: string, documentId: string, newName: string) => ipcRenderer.invoke('rename-materials-document', libraryPath, documentId, newName),
    importMaterialsDocuments: (libraryPath: string) => ipcRenderer.invoke('import-materials-documents', libraryPath),
    deleteMaterialsDocument: (libraryPath: string, documentId: string) => ipcRenderer.invoke('delete-materials-document', libraryPath, documentId),
    getAppPreferences: () => ipcRenderer.invoke('get-app-preferences'),
    saveAppPreferences: (patch: unknown) => ipcRenderer.invoke('save-app-preferences', patch),
    getAppDiagnostics: () => ipcRenderer.invoke('get-app-diagnostics'),
    getWorkspaceBackupStatus: () => ipcRenderer.invoke('backup:get-status'),
    checkLatestRelease: () => ipcRenderer.invoke('release:check'),
    previewWorkspaceRestore: () => ipcRenderer.invoke('restore:preview'),
    getPendingWorkspaceRestores: () => ipcRenderer.invoke('restore:pending'),
    startWorkspaceRestore: (id: string, importPreferences: boolean) => ipcRenderer.invoke('restore:start', id, importPreferences),
    cancelWorkspaceRestore: () => ipcRenderer.invoke('restore:cancel'),
    openRestoredWorkspace: (workspacePath: string) => ipcRenderer.invoke('restore:open', workspacePath),
    getRestorePausedRoots: () => ipcRenderer.invoke('restore:paused'),
    getRestoredConnectionHints: () => ipcRenderer.invoke('restore:connection-hints'),
    resumeRestoredTasks: () => ipcRenderer.invoke('restore:resume'),
    onWorkspaceRestoreStatus: (callback: (status: RestoreStatus) => void) => { const listener = (_event: unknown, status: RestoreStatus) => callback(status); ipcRenderer.on('restore:status', listener); return () => ipcRenderer.removeListener('restore:status', listener); },
    configureWorkspaceBackup: (config: Pick<BackupConfiguration, 'enabled' | 'targetDirectory' | 'externalLibraries'>) => ipcRenderer.invoke('backup:configure', config),
    startWorkspaceBackup: (request?: { targetDirectory?: string; externalLibraries?: string[] }) => ipcRenderer.invoke('backup:start', request),
    cancelWorkspaceBackup: () => ipcRenderer.invoke('backup:cancel'),
    chooseBackupTarget: () => ipcRenderer.invoke('backup:choose-target'),
    onWorkspaceBackupStatus: (callback: (status: BackupStatus) => void) => { const listener = (_event: unknown, status: BackupStatus) => callback(status); ipcRenderer.on('backup:status', listener); return () => { ipcRenderer.removeListener('backup:status', listener); }; },
    onMaintenancePrepare: (callback: (request: { requestId: string }) => void) => { const listener = (_event: unknown, request: { requestId: string }) => callback(request); ipcRenderer.on('maintenance:prepare', listener); return () => { ipcRenderer.removeListener('maintenance:prepare', listener); }; },
    onMaintenanceChanged: (callback: (status: { phase: 'idle' | 'preparing' | 'capturing' }) => void) => { const listener = (_event: unknown, status: { phase: 'idle' | 'preparing' | 'capturing' }) => callback(status); ipcRenderer.on('maintenance:changed', listener); return () => { ipcRenderer.removeListener('maintenance:changed', listener); }; },
    respondMaintenance: (requestId: string, ok: boolean) => ipcRenderer.send('maintenance:response', { requestId, ok }),
    getOnboardingState: () => ipcRenderer.invoke('onboarding:get'),
    updateOnboardingState: (input: unknown) => ipcRenderer.invoke('onboarding:update', input),
    selectOnboardingProfile: (profileId: string) => ipcRenderer.invoke('onboarding:select-profile', profileId),
    invalidateOnboardingConnection: (profileId: string) => ipcRenderer.invoke('onboarding:invalidate-connection', profileId),
    bindOnboardingPractice: (input: unknown) => ipcRenderer.invoke('onboarding:bind-practice', input),
    onOnboardingStateChanged: (callback: (state: unknown) => void) => { const listener = (_event: unknown, state: unknown) => callback(state); ipcRenderer.on('onboarding-state-changed', listener); return () => ipcRenderer.removeListener('onboarding-state-changed', listener); },
    saveOnboardingState: (status: 'skipped' | 'completed') => ipcRenderer.invoke('onboarding:save', status),
    importOnboardingSample: () => ipcRenderer.invoke('onboarding:import-sample'),
    getUserCapabilities: (request?: CapabilityRequest) => ipcRenderer.invoke('capabilities:get', request),
    probeUserCapability: (request: CapabilityProbeRequest) => ipcRenderer.invoke('capabilities:probe', request),
    cancelCapabilityProbe: (requestId: string) => ipcRenderer.invoke('capabilities:cancel', requestId),
    openLogsDirectory: () => ipcRenderer.invoke('open-logs-directory'),
    exportDiagnosticReport: () => ipcRenderer.invoke('export-diagnostic-report'),
    getLibraryUiState: () => ipcRenderer.invoke('get-library-ui-state'),
    saveLibraryUiState: (patch: unknown) => ipcRenderer.invoke('save-library-ui-state', patch),
    getAiStatus: () => ipcRenderer.invoke('get-ai-status'),
    getAiProviderConfig: () => ipcRenderer.invoke('get-ai-provider-config'),
    getAiModelSettings: () => ipcRenderer.invoke('get-ai-model-settings'),
    saveAiModelSettings: (settings: AiModelSettingsInput) => ipcRenderer.invoke('save-ai-model-settings', settings),
    getAiExtensionsSettings: () => ipcRenderer.invoke('get-ai-extensions-settings'),
    saveAiExtensionsSettings: (settings: AiExtensionsSettings) => ipcRenderer.invoke('save-ai-extensions-settings', settings),
    getAiSkillsOverview: () => ipcRenderer.invoke('get-ai-skills-overview') as Promise<AiSkillsOverview>,
    importAiSkill: (mode: AiSkillImportKind) => ipcRenderer.invoke('import-ai-skill', mode) as Promise<SkillImportResult>,
    setAiSkillEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('set-ai-skill-enabled', name, enabled),
    removeAiSkill: (name: string) => ipcRenderer.invoke('remove-ai-skill', name),
    revealAiSkill: (name: string) => ipcRenderer.invoke('reveal-ai-skill', name),
    createAiSkillFromForm: (input: SkillFormCreateInput) => ipcRenderer.invoke('create-ai-skill-from-form', input) as Promise<SkillImportResult>,
    updateAiSkillDocument: (name: string, description: string, instruction: string) => ipcRenderer.invoke('update-ai-skill-document', name, description, instruction) as Promise<SkillDocumentUpdateResult>,
    exportAiSkill: (name: string) => ipcRenderer.invoke('export-ai-skill', name) as Promise<SkillExportResult>,
    getAssistantAiOptions: (profileId?: string) => ipcRenderer.invoke('get-assistant-ai-options', profileId),
    getParsingConfig: () => ipcRenderer.invoke('get-parsing-config'),
    saveParsingConfig: (config: unknown) => ipcRenderer.invoke('save-parsing-config', config),
    getWebSearchConfig: () => ipcRenderer.invoke('get-web-search-config'),
    saveWebSearchConfig: (config: unknown) => ipcRenderer.invoke('save-web-search-config', config),
    testWebSearchProvider: (providerId: string) => ipcRenderer.invoke('test-web-search-provider', providerId),
    getPipelineAmbiguityConfig: () => ipcRenderer.invoke('get-pipeline-ambiguity-config'),
    savePipelineAmbiguityConfig: (patch: unknown) => ipcRenderer.invoke('save-pipeline-ambiguity-config', patch),
    getPipelineStructureConfig: () => ipcRenderer.invoke('get-pipeline-structure-config'),
    savePipelineStructureConfig: (patch: unknown) => ipcRenderer.invoke('save-pipeline-structure-config', patch),
    getLibraryChunkingConfig: (libraryPath: string) => ipcRenderer.invoke('get-library-chunking-config', libraryPath),
    saveLibraryChunkingConfig: (libraryPath: string, patch: unknown) => ipcRenderer.invoke('save-library-chunking-config', libraryPath, patch),
    getLibraryGraphEnhancementConfig: (libraryPath: string) => ipcRenderer.invoke('get-library-graph-enhancement-config', libraryPath),
    saveLibraryGraphEnhancementConfig: (libraryPath: string, patch: unknown) => ipcRenderer.invoke('save-library-graph-enhancement-config', libraryPath, patch),
    getLibraryGraphStatus: (libraryPath: string) => ipcRenderer.invoke('get-library-graph-status', libraryPath),
    getLibraryGraphCommunities: (libraryPath: string) => ipcRenderer.invoke('get-library-graph-communities', libraryPath),
    getLibraryGraphVisualization: (libraryPath: string, options?: { nodeLimit?: number }) => ipcRenderer.invoke('get-library-graph-visualization', libraryPath, options),
    searchLibraryGraphEntities: (libraryPath: string, query: string) => ipcRenderer.invoke('search-library-graph-entities', libraryPath, query),
    getPipelineKeywordResources: (libraryPath: string) => ipcRenderer.invoke('get-pipeline-keyword-resources', libraryPath),
    savePipelineKeywordConfig: (libraryPath: string, patch: unknown) => ipcRenderer.invoke('save-pipeline-keyword-config', libraryPath, patch),
    savePipelineKeywordDictionary: (libraryPath: string, content: string) => ipcRenderer.invoke('save-pipeline-keyword-dictionary', libraryPath, content),
    savePipelineKeywordStopwords: (libraryPath: string, content: string) => ipcRenderer.invoke('save-pipeline-keyword-stopwords', libraryPath, content),
    getModelHub: () => ipcRenderer.invoke('get-model-hub'),
    saveModelProvider: (id: string, patch: unknown) => ipcRenderer.invoke('save-model-provider', id, patch),
    fetchModelProviderModels: (id: string, draft?: unknown) => ipcRenderer.invoke('fetch-model-provider-models', id, draft),
    saveModelConfiguration: (change: unknown, confirmationToken?: string) => ipcRenderer.invoke('save-model-configuration', change, confirmationToken),
    saveModelHub: (patch: unknown) => ipcRenderer.invoke('save-model-hub', patch),
    testAiProviderConfig: (config: unknown, context?: { profileId: string }) => ipcRenderer.invoke('test-ai-provider-config', config, context),
    fetchAiProviderModels: (config: unknown, context?: { profileId: string }) => ipcRenderer.invoke('fetch-ai-provider-models', config, context),
    saveAiProviderConfig: (config: unknown) => ipcRenderer.invoke('save-ai-provider-config', config),
    readClipboardContent: () => ipcRenderer.invoke('editor:read-clipboard-content'),
    readClipboardText: () => ipcRenderer.invoke('editor:read-clipboard-text') as Promise<string>,
    addSpellcheckerWord: (word: string) => ipcRenderer.invoke('editor:add-spellchecker-word', word) as Promise<boolean>,
    startSelectionTransform: (request: SelectionTransformRequest) => ipcRenderer.invoke('start-selection-transform', request),
    cancelSelectionTransform: (requestId: string) => ipcRenderer.invoke('cancel-selection-transform', requestId),
    startSelectionEdit: (request: SelectionEditRunRequest) => ipcRenderer.invoke('selection-edit:start', request) as Promise<SelectionEditRunResult>,
    cancelSelectionEdit: (requestId: string) => ipcRenderer.invoke('selection-edit:cancel', requestId) as Promise<boolean>,
    getSelectionExpansionCapabilities: () => ipcRenderer.invoke('selection-expansion:get-capabilities') as Promise<SelectionExpansionCapabilities>,
    getSelectionExpansionSettings: () => ipcRenderer.invoke('selection-expansion:get-settings') as Promise<SelectionExpansionSettings>,
    saveSelectionExpansionSettings: (patch: SelectionExpansionSettingsPatch) => ipcRenderer.invoke('selection-expansion:save-settings', patch) as Promise<SelectionExpansionSettings>,
    prepareSelectionExpansionSource: (currentPath: string) => ipcRenderer.invoke('selection-expansion:prepare-source', currentPath) as Promise<SelectionExpansionSourcePreparation>,
    startSelectionExpansion: (request: SelectionExpansionRequest) => ipcRenderer.invoke('selection-expansion:start', request) as Promise<{ requestId: string; sessionId: string }>,
    cancelSelectionExpansion: (requestId: string) => ipcRenderer.invoke('selection-expansion:cancel', requestId) as Promise<boolean>,
    onSelectionExpansionEvent: (callback: (event: SelectionExpansionEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SelectionExpansionEvent) => callback(payload);
      ipcRenderer.on('selection-expansion-event', listener);
      return () => ipcRenderer.removeListener('selection-expansion-event', listener);
    },
    startAssistantTurn: (request: AssistantTurnRequest) => ipcRenderer.invoke('start-assistant-turn', request),
    getAssistantContextDiagnostics: (turnId?: string) => ipcRenderer.invoke('assistant-context-diagnostics:get', turnId),
    selectAssistantAttachments: (kind?: 'image' | 'file') => ipcRenderer.invoke('select-assistant-attachments', kind) as Promise<AssistantAttachment[]>,
    ingestAssistantDroppedFiles: (files: File[]) => ipcRenderer.invoke(
      'ingest-assistant-dropped-files',
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ) as Promise<AssistantAttachment[]>,
    cancelAssistantTurn: (requestId: string) => ipcRenderer.invoke('cancel-assistant-turn', requestId),
        createQaMemorySession: (scope: QaSessionScope = 'chat', libraryPath?: string) => ipcRenderer.invoke('qa-memory:create-session', scope, libraryPath) as Promise<QaSessionSummary>,
        getMemoryCutoverReport: () => ipcRenderer.invoke('memory:get-cutover-report') as Promise<MemoryCutoverReport>,
        getAssistantDetailedTrace: (requestId: string) => ipcRenderer.invoke('assistant:get-detailed-trace', requestId) as Promise<{ entries: AssistantDetailedTraceRecordView[]; filePath: string | null }>,
        listQaMemorySessions: (cursor?: number) => ipcRenderer.invoke('qa-memory:list-sessions', cursor) as Promise<QaMemoryPage<QaSessionSummary>>,
        getQaMemorySession: (sessionId: string) => ipcRenderer.invoke('qa-memory:get-session', sessionId) as Promise<QaSessionDetail>,
        renameQaMemorySession: (sessionId: string, title: string) => ipcRenderer.invoke('qa-memory:rename-session', sessionId, title) as Promise<QaSessionSummary>,
        setQaMemorySessionPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke('qa-memory:set-pinned', sessionId, pinned) as Promise<QaSessionSummary>,
        deleteQaMemorySession: (sessionId: string) => ipcRenderer.invoke('qa-memory:delete-session', sessionId) as Promise<boolean>,
        getLongTermMemoryOverview: () => ipcRenderer.invoke('memory:get-overview') as Promise<{ workspaceConfig: WorkspaceMemoryConfig; subject: MemorySubjectRecord; availability: { enabled: boolean; reason?: string }; extractionRuntime: MemoryExtractionRuntimeStatus; itemCounts: MemoryItemCounts }>,
        saveLongTermMemoryWorkspaceConfig: (patch: Partial<WorkspaceMemoryConfig>) => ipcRenderer.invoke('memory:save-workspace-config', patch) as Promise<WorkspaceMemoryConfig>,
        setLongTermMemoryPrincipalEnabled: (enabled: boolean) => ipcRenderer.invoke('memory:set-principal-enabled', enabled) as Promise<{ enabled: boolean }>,
        listLongTermMemoryItems: (query?: MemoryItemListQuery) => ipcRenderer.invoke('memory:list-items', query) as Promise<MemoryItemPage>,
        listLongTermMemoryItemPage: (query?: MemoryItemPageQuery) => ipcRenderer.invoke('memory:list-item-page', query) as Promise<MemoryPage<MemoryItemRecord>>,
        listLongTermMemoryTopicPage: (query?: MemoryPageQuery) => ipcRenderer.invoke('memory:list-topic-page', query) as Promise<MemoryPage<MemoryTopicRecord>>,
        listLongTermMemoryDocumentPage: (query?: MemoryPageQuery) => ipcRenderer.invoke('memory:list-document-page', query) as Promise<MemoryPage<MemoryDocumentAffinity>>,
        listLongTermMemoryTopics: () => ipcRenderer.invoke('memory:list-topics') as Promise<MemoryTopicRecord[]>,
        promoteLongTermMemoryTopic: (topicId: string) => ipcRenderer.invoke('memory:promote-topic', topicId) as Promise<MemoryTopicRecord>,
        deleteLongTermMemoryTopic: (topicId: string) => ipcRenderer.invoke('memory:delete-topic', topicId) as Promise<boolean>,
        listLongTermMemoryDocuments: () => ipcRenderer.invoke('memory:list-documents') as Promise<MemoryDocumentAffinity[]>,
        deleteLongTermMemoryDocument: (documentId: string) => ipcRenderer.invoke('memory:delete-document', documentId) as Promise<boolean>,
        getLongTermMemoryUsedForTurn: (turnId: string) => ipcRenderer.invoke('memory:get-used-for-turn', turnId) as Promise<MemoryUsedSnapshot[]>,
        getLongTermMemoryCitationSource: (turnId: string, itemId: string) => ipcRenderer.invoke('memory:get-citation-source', turnId, itemId) as Promise<MemoryCitationSource>,
        createLongTermMemoryItem: (input: ManualMemoryInput) => ipcRenderer.invoke('memory:create-item', input) as Promise<MemoryWriteResult>,
        updateLongTermMemoryItem: (itemId: string, patch: MemoryItemPatch) => ipcRenderer.invoke('memory:update-item', itemId, patch) as Promise<MemoryItemRecord>,
        deleteLongTermMemoryItem: (itemId: string) => ipcRenderer.invoke('memory:delete-item', itemId) as Promise<boolean>,
        getLongTermMemoryTurnStatus: (turnIds: string[]) => ipcRenderer.invoke('memory:get-turn-status', turnIds) as Promise<MemoryTurnStatus[]>,
        getLongTermMemoryProposalContext: (itemId: string) => ipcRenderer.invoke('memory:get-proposal-context', itemId) as Promise<MemoryProposalContext>,
        approveLongTermMemoryConsolidation: (id: string, fingerprint: string) => ipcRenderer.invoke('memory:approve-consolidation', id, fingerprint) as Promise<MemoryItemRecord>,
        confirmLongTermMemoryItem: (itemId: string, review?: MemoryProposalReview) => ipcRenderer.invoke('memory:confirm-item', itemId, review) as Promise<MemoryItemRecord>,
        rejectLongTermMemoryItem: (itemId: string) => ipcRenderer.invoke('memory:reject-item', itemId) as Promise<MemoryItemRecord>,
        clearLongTermMemory: () => ipcRenderer.invoke('memory:clear') as Promise<MemoryClearResult>,
        exportLongTermMemory: () => ipcRenderer.invoke('memory:export') as Promise<{ canceled: boolean; exportedItems: number }>,
        importLongTermMemory: () => ipcRenderer.invoke('memory:import') as Promise<MemoryImportResult & { canceled: boolean }>,
        consolidateLongTermMemory: () => ipcRenderer.invoke('memory:consolidate') as Promise<MemoryConsolidationResult>,
    getAssistantMemorySettings: () => ipcRenderer.invoke('assistant-memory:get-settings') as Promise<AssistantMemorySettings>,
    setAssistantMemorySettings: (mode: AssistantMemoryMode) => ipcRenderer.invoke('assistant-memory:set-settings', mode) as Promise<AssistantMemorySettings>,
    createAssistantMemorySession: (notePath: string) => ipcRenderer.invoke('assistant-memory:create-session', notePath) as Promise<AssistantSessionSummary>,
    listAssistantMemorySessions: (notePath: string, page?: number) => ipcRenderer.invoke('assistant-memory:list-sessions', notePath, page) as Promise<{ items: AssistantSessionSummary[]; nextCursor?: number }>,
    getAssistantMemorySession: (notePath: string, sessionId: string, page?: number) => ipcRenderer.invoke('assistant-memory:get-session', notePath, sessionId, page) as Promise<AssistantSessionDetail>,
    archiveAssistantMemorySession: (notePath: string, sessionId: string) => ipcRenderer.invoke('assistant-memory:archive-session', notePath, sessionId) as Promise<AssistantSessionSummary>,
    deleteAssistantMemorySession: (notePath: string, sessionId: string) => ipcRenderer.invoke('assistant-memory:delete-session', notePath, sessionId) as Promise<boolean>,
    clearAssistantMemoryNote: (notePath: string) => ipcRenderer.invoke('assistant-memory:clear-note', notePath) as Promise<number>,
    exportAssistantMemorySession: (notePath: string, sessionId: string, format: 'markdown' | 'json') => ipcRenderer.invoke('assistant-memory:export-session', notePath, sessionId, format) as Promise<boolean>,
    backupAssistantMemory: () => ipcRenderer.invoke('assistant-memory:backup') as Promise<boolean>,
    validateAssistantCitation: (citation: AssistantEvidenceCitation) => ipcRenderer.invoke('assistant-citation:validate', citation) as Promise<AssistantCitationValidation>,
    getFavoriteNotes: () => ipcRenderer.invoke('get-favorite-notes'),
    setFavoriteNote: (filePath: string, favorite: boolean) => ipcRenderer.invoke('set-favorite-note', filePath, favorite),
    searchNotesUnified: (query: string) => ipcRenderer.invoke('search-notes-unified', query),
    getNoteAnalysis: (filePath: string) => ipcRenderer.invoke('get-note-analysis', filePath),
    generateNoteAnalysis: (filePath: string, model: string) => ipcRenderer.invoke('generate-note-analysis', filePath, model),
    startNoteAnalysis: (filePath: string, model?: string) => ipcRenderer.invoke('start-note-analysis', filePath, model),
    getLatestNoteAnalysisRun: (filePath: string) => ipcRenderer.invoke('get-latest-note-analysis-run', filePath),
    getNoteAnalysisRun: (runId: string) => ipcRenderer.invoke('get-note-analysis-run', runId),
    cancelNoteAnalysis: (runId: string) => ipcRenderer.invoke('cancel-note-analysis', runId),
    resumeNoteAnalysis: (runId: string) => ipcRenderer.invoke('resume-note-analysis', runId),
    onNoteAnalysisProgress: (callback: (progress: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
        ipcRenderer.on('note-analysis-progress', listener);
        return () => ipcRenderer.removeListener('note-analysis-progress', listener);
    },
    getAiInsight: (filePath: string) => ipcRenderer.invoke('get-ai-insight', filePath),
    generateAiInsight: (filePath: string, model: string) => ipcRenderer.invoke('generate-ai-insight', filePath, model),
    applyAiTags: (filePath: string, suggestedTags: string[]) => ipcRenderer.invoke('apply-ai-tags', filePath, suggestedTags),
    askKnowledgeAssistant: (question: string, model: string) => ipcRenderer.invoke('ask-knowledge-assistant', question, model),
    generateLearningPlan: (goal: string, model: string) => ipcRenderer.invoke('generate-learning-plan', goal, model),
    generateOrganizationSuggestion: (model: string) => ipcRenderer.invoke('generate-organization-suggestion', model),
    listFiles: () => ipcRenderer.invoke('list-files'),
    readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
    pickDocumentFile: () => ipcRenderer.invoke('documents:pick-file'),
    listDocumentOpenRequests: () => ipcRenderer.invoke('documents:list-open-requests'),
    takeDocumentOpenFailures: () => ipcRenderer.invoke('documents:open-failures'),
    dropDocumentFiles: async (files: File[]) => {
      const paths = files.map(file => webUtils.getPathForFile(file)).filter(Boolean);
      if (paths.length !== files.length || !paths.length) { await ipcRenderer.invoke('documents:pick-file'); return; }
      await ipcRenderer.invoke('documents:drop-files', paths);
    },
    openDocumentRequest: (id: string, encoding?: string) => ipcRenderer.invoke('documents:open-request', id, encoding),
    finishDocumentOpenRequest: (id: string) => ipcRenderer.invoke('documents:finish-open-request', id),
    updateDocumentDraft: (request: import('../shared/documentSession').DocumentDraftRequest): Promise<import('../shared/documentSession').DocumentDraftResult> => ipcRenderer.invoke('documents:update-draft', request),
    previewDocumentResources: (id: string) => ipcRenderer.invoke('documents:resource-preview', id),
    grantDocumentResourceRoot: (id: string) => ipcRenderer.invoke('documents:grant-resource-root', id),
    openDocumentLink: (id: string, href: string) => ipcRenderer.invoke('documents:open-link', id, href),
    addDocumentImage: (id: string, input: { bytes?: Uint8Array; extension?: string; sourcePath?: string }) => ipcRenderer.invoke('documents:add-image', id, input),
    runDocumentAi: (request: import('../shared/documentAi').DocumentAiRequest) => ipcRenderer.invoke('documents:ai-run', request),
    applyDocumentAi: (request: import('../shared/documentAi').DocumentAiApplyRequest) => ipcRenderer.invoke('documents:ai-apply', request),
    cancelDocumentAi: (requestId: string) => ipcRenderer.invoke('documents:ai-cancel', requestId),
    saveDocument: (request: import('../shared/documentSession').DocumentSaveRequest) => ipcRenderer.invoke('documents:save', request),
    saveDocumentAs: (request: import('../shared/documentSession').DocumentSaveRequest) => ipcRenderer.invoke('documents:save-as', request),
    refreshDocument: (id: string, revision: number, encoding?: string, discard = false) => ipcRenderer.invoke('documents:refresh', id, revision, encoding, discard),
    closeDocument: (request: import('../shared/documentSession').DocumentCloseRequest): Promise<import('../shared/documentSession').DocumentCloseResult> => ipcRenderer.invoke('documents:close', request),
    joinDocumentLibrary: (request: import('../shared/documentSession').DocumentJoinRequest) => ipcRenderer.invoke('documents:join-library', request),
    listDocumentRecovery: () => ipcRenderer.invoke('documents:list-recovery'),
    restoreDocumentDraft: (id: string) => ipcRenderer.invoke('documents:restore-draft', id),
    listRecentDocuments: () => ipcRenderer.invoke('documents:list-recent'),
    openRecentDocument: (displayPath: string) => ipcRenderer.invoke('documents:open-recent', displayPath),
    waitForNoteCloseDecision: (requestId: string) => ipcRenderer.send('notes:close-waiting', { requestId }),
    onDocumentOpenRequested: (callback: () => void) => {
        const listener = () => callback(); ipcRenderer.on('documents:open-requested', listener);
        return () => ipcRenderer.removeListener('documents:open-requested', listener);
    },
    openNoteEditSession: (filePath: string) => ipcRenderer.invoke('notes:open', filePath),
    refreshNoteEditSession: (id: string) => ipcRenderer.invoke('notes:refresh', id),
    closeNoteEditSession: (id: string) => ipcRenderer.invoke('notes:close', id),
    saveNote: (request: SaveNoteRequest) => ipcRenderer.invoke('notes:save', request),
    createNoteFromAssistant: (request: CreateAssistantNoteRequest) => ipcRenderer.invoke('notes:create-from-ai', request),
    mutateNote: (request: NoteMutationRequest) => ipcRenderer.invoke('notes:mutate', request),
    saveNoteCopy: (id: string, name: string, content: string) => ipcRenderer.invoke('notes:save-copy', id, name, content),
    retryNoteIndex: (id: string) => ipcRenderer.invoke('notes:retry-index', id),
    awaitNoteIndex: (id: string, diskHash: string) => ipcRenderer.invoke('notes:await-index', id, diskHash),
    reconcileNotes: () => ipcRenderer.invoke('notes:reconcile'),
    respondNoteClose: (response: NoteCloseResponse) => ipcRenderer.send('notes:close-response', response),
    onNoteCloseRequested: (callback: (request: { requestId: string }) => void) => {
      noteCloseSubscribers++;
      const listener = (_event: unknown, request: { requestId: string }) => callback(request);
      ipcRenderer.on('notes:close-request', listener);
      return () => { noteCloseSubscribers--; ipcRenderer.removeListener('notes:close-request', listener); };
    },
    onNoteSaveState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on('notes:save-state', listener);
      return () => ipcRenderer.removeListener('notes:save-state', listener);
    },
    onNoteIndexChanged: (callback: (delta: unknown) => void) => {
      const listener = (_event: unknown, delta: unknown) => callback(delta);
      ipcRenderer.on('notes:index-changed', listener);
      return () => ipcRenderer.removeListener('notes:index-changed', listener);
    },
    createFile: (fileName?: string, parentDirectoryPath?: string | null) => ipcRenderer.invoke('create-file', fileName, parentDirectoryPath),
    renameFile: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-file', oldPath, newName),
    renameEntry: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-entry', oldPath, newName),
    deleteFile: (filePath: string) => ipcRenderer.invoke('delete-file', filePath),
    deleteEntry: (entryPath: string) => ipcRenderer.invoke('delete-entry', entryPath),
    createFolder: (parentDirectoryPath: string | null, folderName: string) => ipcRenderer.invoke('create-folder', parentDirectoryPath, folderName),
    moveEntry: (sourcePath: string, targetDirectoryPath: string, position?: any) => ipcRenderer.invoke('move-entry', sourcePath, targetDirectoryPath, position),
    saveTreeOrder: (parentDirectoryPath: string, orderedChildPaths: string[]) => ipcRenderer.invoke('save-tree-order', parentDirectoryPath, orderedChildPaths),
    importFiles: (targetDirectoryPath?: string | null) => ipcRenderer.invoke('import-files', targetDirectoryPath),
    // Search API
    searchNotes: (query: string) => ipcRenderer.invoke('search-notes', query),
    // Knowledge graph APIs
    getNoteMeta: (filePath: string) => ipcRenderer.invoke('get-note-meta', filePath),
    getBacklinks: (filePath: string) => ipcRenderer.invoke('get-backlinks', filePath),
    getAllTags: () => ipcRenderer.invoke('get-all-tags'),
    getFilesByTag: (tag: string) => ipcRenderer.invoke('get-files-by-tag', tag),
    resolveWikiLink: (target: string, fromPath?: string) => ipcRenderer.invoke('resolve-wiki-link', target, fromPath),
    createLinkedNote: (target: string, fromPath?: string) => ipcRenderer.invoke('create-linked-note', target, fromPath),
    saveEditorImage: (request: { notePath: string; bytes?: Uint8Array; sourcePath?: string }) => ipcRenderer.invoke('save-editor-image', request),
    listBackups: (filePath: string) => ipcRenderer.invoke('list-backups', filePath),
    restoreBackup: (filePath: string, backupId: string) => ipcRenderer.invoke('restore-backup', filePath, backupId),
    readMarkdownExportImage: (source: string) => ipcRenderer.invoke('read-markdown-export-image', source),
    exportHtml: (defaultName: string, html: string) => ipcRenderer.invoke('export-html', defaultName, html),
    exportNote: (request: NoteExportRequest) => ipcRenderer.invoke('export-note', request),
    // Logging API
    onLog: (callback: (message: string) => void) => {
        ipcRenderer.on('main-log', (_event, message) => callback(message));
    },
    onLibraryChanged: (callback: (payload: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
        ipcRenderer.on('library-changed', listener);
        return () => ipcRenderer.removeListener('library-changed', listener);
    },
    onAssistantTurnEvent: (callback: (event: AssistantTurnEvent) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: AssistantTurnEvent) => callback(payload);
        ipcRenderer.on('assistant-turn-event', listener);
        return () => ipcRenderer.removeListener('assistant-turn-event', listener);
    },
    onPipelineStatus: (callback: (status: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
        ipcRenderer.on('pipeline-status', listener);
        return () => ipcRenderer.removeListener('pipeline-status', listener);
    },
    onPipelineProgress: (callback: (progress: unknown) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
        ipcRenderer.on('pipeline-progress', listener);
        return () => ipcRenderer.removeListener('pipeline-progress', listener);
    },
    onLibraryGraphUpdated: (callback: (libraryPath: string) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, libraryPath: string) => callback(libraryPath);
        ipcRenderer.on('library-graph-updated', listener);
        return () => ipcRenderer.removeListener('library-graph-updated', listener);
    },
});
