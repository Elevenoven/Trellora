import './styles/editorPreferences.css';
import { useExternalDocuments } from './hooks/useExternalDocuments';
import ExternalDocumentWorkspace from './components/ExternalDocumentWorkspace';
import { useTypewriterScroll } from './hooks/useTypewriterScroll';
import { hasVisibleOverlay } from './editor/visibleOverlay';
import { canHandleEditorEscape, consumeEditorEscape } from './editor/escapeBoundary';
import { getNoteViewportRect } from './editor/editorCoordinates';
import { defaultEditorPreferences, normalizeEditorPreferences, editorContentWidths } from '../shared/editorPreferences';
import { setAppLanguage, t, useI18n } from './i18n';
import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView as CodeMirrorView, keymap as codeMirrorKeymap } from '@codemirror/view';
import type { CSSProperties } from 'react';
import { markdown as codemirrorMarkdown } from '@codemirror/lang-markdown';
import Sidebar, { type LeftPanelMode } from './components/Sidebar';
import Editor from './components/Editor';
import SearchModal, { type SearchNavigationTarget } from './components/SearchModal';
import CreateFileModal from './components/CreateFileModal';
import KnowledgePanel from './components/KnowledgePanel';
import TagModal from './components/TagModal';
import MarkdownPreview from './components/MarkdownPreview';
import EditorZoomControl from './components/EditorZoomControl';
import EditorWordCount from './components/EditorWordCount';
import SettingsPanel, { type SettingsSection } from './components/SettingsPanel';
import { useModelConfigurationSave } from './components/settings/useModelConfigurationSave';
import type { ModelConfigurationChange, ModelProviderCatalogDraft } from '../shared/modelConfiguration';
import WorkspaceMigrationDialog from './components/WorkspaceMigrationDialog';
import { notifyWorkspaceDataChanged } from './utils/workspaceDataEvents';
import NavRail, { type MainView } from './components/NavRail';

import MaterialsView from './components/MaterialsView';
import AssistantWorkspaceView from './components/AssistantWorkspaceView';
import LibraryGraphView from './components/LibraryGraphView';
import LibraryManagerView from './components/LibraryManagerView';
import { useOnboarding } from './components/onboarding/useOnboarding';
import { OnboardingAiTask, OnboardingBar, OnboardingCompletion, OnboardingMenus, type OnboardingModelDraft } from './components/onboarding/OnboardingGuide';
import { Button } from '@mantine/core';
import WikiView from './components/wiki/WikiView';
import type { WikiNoteSource } from './components/wiki/WikiOpenInNotesModal';
import CreateLibraryModal from './components/CreateLibraryModal';
import CreateMaterialsLibraryModal, { type MaterialsLibraryModalMode } from './components/CreateMaterialsLibraryModal';
import { NoteSaveController, type NoteSaveView } from './utils/noteSaveController';
import { applyNoteIndexDelta } from './utils/noteIndexDelta';
import { NOTE_BACKUP_RETENTION } from '../shared/noteBackup';
import { ASSISTANT_RELEASE_DEFAULTS } from '../shared/assistantReleaseDefaults';
import type { NoteExportFormat } from '../shared/noteExport';
import type { MarkdownRelativeLinkTarget } from './utils/markdownLinks';
import type { AiExtensionsSettings, AiModelSettings, AiModelSettingsInput, AiProviderConfig, AiProviderStatus, AppPreferences, AssistantAiOptions, AssistantCitationValidation, AssistantEvidenceCitation, AssistantTurnRequest, BackupEntry, FileNode, HeadingEntry, LibrarySummary, ModelHub, NoteAnalysis, NoteAnalysisRunDetail, NoteMeta, RemoteProviderModelsResult, SavedEditorImage, SelectionExpansionEvent, SelectionExpansionSettings, TagSummary } from './electron';
import { createSelectionLocatorCapture, getSelectionWritebackCapability, type SelectionSnapshot } from './editor/selectionActions';
import type { SelectionExpansionApplyRequest, SelectionExpansionDraftSession } from './editor/selectionExpansion';
import { primarySelectionEditQualityIssue, selectionEditQualityIssueLabel } from '../electron/knowledge/selectionEditQuality';
import { collapseAllFolders } from './utils/fileTreeState';
import { applyAppearance, resolveTheme, type ResolvedTheme } from './utils/theme';
import {
  formatSavedEditorImageMarkdown,
  getClipboardImageSources,
  MAX_EDITOR_IMAGE_BYTES,
  type ClipboardImageSource,
} from './utils/editorImageClipboard';

type EditorMode = 'wysiwyg' | 'preview' | 'source';
type CreateEntryMode = 'file' | 'folder';


const defaultPreferences: AppPreferences = {
  schemaVersion: 1,
  ...defaultEditorPreferences,
  theme: 'system',
  lightColorScheme: 'green',
  density: 'comfortable',
  language: 'zh-CN',
  startupBehavior: 'library',
  externalLinkOpenMode: 'in-app',
  backupRetention: NOTE_BACKUP_RETENTION,
  defaultEditorMode: 'wysiwyg',
  autosaveDelayMs: 1_000,
  previewPreference: 'rendered',
  ...ASSISTANT_RELEASE_DEFAULTS,
  leftSidebarWidth: 240,
  rightPanelWidth: 280,
};

const defaultAiModelSettings: AiModelSettings = { schemaVersion: 1, defaultProfileId: '', profiles: [] };
const defaultAiExtensionsSettings: AiExtensionsSettings = { schemaVersion: 1, skills: [] };
const defaultAssistantAiOptions: AssistantAiOptions = { defaultProfileId: '', profiles: [], skills: [] };
const defaultModelHub: ModelHub = {
  ollamaEndpoint: 'http://127.0.0.1:11434',
  ollamaEmbeddingPresets: [],
  remoteConsent: true,
  providers: [],
  slots: {
    generation: { source: 'ollama', model: '' },
    embedding: { source: 'ollama', model: '' },
    rerank: { source: 'none', model: '' },
  },
};

function isSelectionExpansionTerminalStatus(status: SelectionExpansionDraftSession['status']): boolean {
  return status === 'completed'
    || status === 'partial'
    || status === 'not-found'
    || status === 'cancelled'
    || status === 'stale'
    || status === 'error';
}

interface AppProps {
  onResolvedThemeChange: (theme: ResolvedTheme, scheme: AppPreferences['lightColorScheme']) => void;
  onStartupReady: () => void;
}

function App({ onResolvedThemeChange, onStartupReady }: AppProps) {
  const { save: saveConfigurationWithConfirmation, dialog: modelConnectionDialog } = useModelConfigurationSave();
  useI18n();
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [currentSearchTerm, setCurrentSearchTerm] = useState<string | null>(null);
  const [searchScrollTarget, setSearchScrollTarget] = useState<{ text?: string; lineFrom?: number; lineTo?: number; nonce: number } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isCreateLibraryModalOpen, setIsCreateLibraryModalOpen] = useState(false);
  const [materialsModal, setMaterialsModal] = useState<{ opened: boolean; mode: MaterialsLibraryModalMode; upgradePath: string | null }>({ opened: false, mode: 'create', upgradePath: null });
  const [materialsRefreshKey, setMaterialsRefreshKey] = useState(0);
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);
  const [mainView, setMainView] = useState<MainView>('home');
  const [introMenu, setIntroMenu] = useState<MainView>('home');
  const [onboardingModelDraft, setOnboardingModelDraft] = useState<OnboardingModelDraft>();
  const [isMaintaining, setIsMaintaining] = useState(false);
  const [migrationBlocked, setMigrationBlocked] = useState(false);
  const [migrationRequest, setMigrationRequest] = useState<{ sequence: number; mode: 'migrate' | 'open' }>({ sequence: 0, mode: 'migrate' });
  // 已访问的一级菜单保持挂载；切换时只隐藏，保留各页面自己的筛选、滚动和草稿状态。
  const [cachedMainViews, setCachedMainViews] = useState<ReadonlySet<MainView>>(() => new Set(['home']));
  // 地图视图「就这个社区提问」→ 预填问题跳转问答区（引导走图谱全局检索）。
  const [graphQuestionDraft, setGraphQuestionDraft] = useState<{ libraryPath: string; question: string } | null>(null);
  const [settingsReturnView, setSettingsReturnView] = useState<Exclude<MainView, 'settings'>>('home');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [settingsSectionRequestId, setSettingsSectionRequestId] = useState(0);
  const [memoryReviewRequest, setMemoryReviewRequest] = useState<{ itemId: string; requestId: number } | undefined>();
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig>({ kind: 'ollama', endpoint: 'http://127.0.0.1:11434' });
  const [aiModelSettings, setAiModelSettings] = useState<AiModelSettings>(defaultAiModelSettings);
  const [aiExtensionsSettings, setAiExtensionsSettings] = useState<AiExtensionsSettings>(defaultAiExtensionsSettings);
  const [modelHub, setModelHub] = useState<ModelHub>(defaultModelHub);
  const [assistantAiOptions, setAssistantAiOptions] = useState<AssistantAiOptions>(defaultAssistantAiOptions);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(defaultPreferences);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(defaultPreferences.theme));
  const [themeFeedback, setThemeFeedback] = useState<string | null>(null);
  const [arePreferencesLoaded, setArePreferencesLoaded] = useState(false);
  const [startupDataLoaded, setStartupDataLoaded] = useState(false);
  const [startupRestoreFinished, setStartupRestoreFinished] = useState(false);
  const guide = useOnboarding(arePreferencesLoaded);
  const [noteMeta, setNoteMeta] = useState<NoteMeta | null>(null);
  const [noteAnalysis, setNoteAnalysis] = useState<NoteAnalysis | null>(null);
  const [noteAnalysisRun, setNoteAnalysisRun] = useState<NoteAnalysisRunDetail | null>(null);
  const noteAnalysisLoadRef = useRef(0);
  const notifiedNoteAnalysisFailuresRef = useRef(new Set<string>());
  const [aiStatus, setAiStatus] = useState<AiProviderStatus | null>(null);
  const [assistantContextRevision, setAssistantContextRevision] = useState(0);
  const [isStartingNoteAnalysis, setIsStartingNoteAnalysis] = useState(false);
  const isAnalyzingNote = isStartingNoteAnalysis || Boolean(noteAnalysisRun?.notePath === currentPath && (noteAnalysisRun.state === 'queued' || noteAnalysisRun.state === 'running'));
  const [allTags, setAllTags] = useState<TagSummary[]>([]);
  const [favoritePaths, setFavoritePaths] = useState<string[]>([]);
  const [pinnedEntryPaths, setPinnedEntryPaths] = useState<string[]>([]);
  const [isNoteLibraryDialogOpen, setIsNoteLibraryDialogOpen] = useState(false);
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<string[]>([]);
  const [currentHeadings, setCurrentHeadings] = useState<HeadingEntry[]>([]);
  const [headingJump, setHeadingJump] = useState<{ heading: HeadingEntry; nonce: number } | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('wysiwyg');
  const [editorZoom, setEditorZoom] = useState(1);
  const editorZoomRef = useRef(editorZoom);
  useEffect(() => { editorZoomRef.current = editorZoom; }, [editorZoom]);
  const [exportingFormat, setExportingFormat] = useState<NoteExportFormat | null>(null);
  const [leftPanelMode, setLeftPanelMode] = useState<LeftPanelMode>('files');
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(false);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  const [isCurrentNoteAssistantOpen, setIsCurrentNoteAssistantOpen] = useState(false);
  const [selectionExpansionSession, setSelectionExpansionSession] = useState<SelectionExpansionDraftSession | null>(null);
  const selectionExpansionPreparationRef = useRef(0);
  const [selectionExpansionApply, setSelectionExpansionApply] = useState<SelectionExpansionApplyRequest | null>(null);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [createEntryParentDirectory, setCreateEntryParentDirectory] = useState<string | null>(null);
  const [createEntryMode, setCreateEntryMode] = useState<CreateEntryMode>('file');

  const currentPathRef = useRef<string | null>(null);
  const migrationNoteRef = useRef<{ source: string; target: string; path: string | null } | null>(null);
  const appPreferencesRef = useRef(appPreferences);
  const preferenceSaveSequenceRef = useRef(0);
  const [isSaveCopyModalOpen, setIsSaveCopyModalOpen] = useState(false);
  const [saveView, setSaveView] = useState<NoteSaveView>({ status: 'clean', frozen: false });
  const [saveController] = useState(() => new NoteSaveController((request) => window.electronAPI.saveNote(request), setSaveView));
  const externalLibraryOpener = useRef<(library: string, file: string) => Promise<boolean>>(async () => false);
  const externalDocuments = useExternalDocuments({ beforeOpen: () => saveController.flush(), openLibrary: (library, file) => externalLibraryOpener.current(library, file), showNotes: () => setMainView('notes'), blocked: isMaintaining || migrationBlocked });
  const externalDocumentsRef = useRef(externalDocuments); externalDocumentsRef.current = externalDocuments;
  const indexEventRef = useRef({ library: '', generation: 0, revision: 0 });
  useEffect(() => {
    if (!saveController.dirty && saveController.snapshot?.path === currentPath && saveController.content !== content) setContent(saveController.content);
  }, [saveController, saveView, currentPath, content]);
  const materialsNavigationPendingRef = useRef(false);
  const selectionRequestIdRef = useRef(0);
  const startupRestoredRef = useRef(false);
  const assistantAiOptionsRequestsRef = useRef(new Map<string, Promise<AssistantAiOptions>>());
  const assistantAiOptionsRefreshSequenceRef = useRef(0);
  const themeFeedbackTimerRef = useRef<number | null>(null);
  const sourceEditorRef = useRef<ReactCodeMirrorRef>(null);
  const codeMirrorExtensions = useMemo(() => [codemirrorMarkdown(), CodeMirrorView.lineWrapping, codeMirrorKeymap.of([{ key: 'Mod-Shift-v', run: view => {
    const doc = view.state.doc, selection = view.state.selection;
    const notePath = currentPathRef.current;
    void window.electronAPI.readClipboardText().then(text => {
      if (!text || currentPathRef.current !== notePath || sourceEditorRef.current?.view !== view || !view.state.facet(CodeMirrorView.editable) || view.state.doc !== doc || !view.state.selection.eq(selection)) return;
      view.dispatch({ changes: { from: selection.main.from, to: selection.main.to, insert: text }, selection: { anchor: selection.main.from + text.length }, userEvent: 'input.paste' });
    }).catch(error => window.alert(String(error)));
    return true;
  } }])], []);
  const currentIsMarkdown = noteMeta?.kind !== 'text';
  // These surfaces own focus and must suspend editor-only floating controls.
  // Keep this derived state local: it is not user data and is never persisted.
  const isEditorInteractionBlocked = isSearchOpen
    || isCreateModalOpen
    || isSaveCopyModalOpen
    || isCreateLibraryModalOpen
    || materialsModal.opened
    || isTagModalOpen
    || isNoteLibraryDialogOpen;

  useEffect(() => {
    setCachedMainViews((current) => {
      if (current.has(mainView)) return current;
      return new Set([...current, mainView]);
    });
  }, [mainView]);

  const isMainViewMounted = (view: MainView) => mainView === view || cachedMainViews.has(view);

  const replaceAppPreferences = useCallback((preferences: AppPreferences) => {
    const normalized = { ...preferences, ...normalizeEditorPreferences(preferences) };
    if (normalized.defaultEditorZoom !== appPreferencesRef.current.defaultEditorZoom) setEditorZoom(normalized.defaultEditorZoom);
    setAppLanguage(preferences.language);
    appPreferencesRef.current = normalized;
    setAppPreferences(normalized);
  }, []);

  const synchronizeAppearance = useCallback((preferences: AppPreferences) => {
    const nextTheme = applyAppearance(preferences);
    setResolvedTheme(nextTheme);
    onResolvedThemeChange(nextTheme, preferences.lightColorScheme);
  }, [onResolvedThemeChange]);

  const showThemeFeedback = useCallback((message: string) => {
    if (themeFeedbackTimerRef.current) window.clearTimeout(themeFeedbackTimerRef.current);
    setThemeFeedback(message);
    themeFeedbackTimerRef.current = window.setTimeout(() => {
      setThemeFeedback(null);
      themeFeedbackTimerRef.current = null;
    }, 2_400);
  }, []);

  const resetCurrentNote = useCallback(() => {
    if (saveController.snapshot) void window.electronAPI.closeNoteEditSession(saveController.snapshot.editSessionId);
    saveController.reset();
    currentPathRef.current = null;
    setCurrentPath(null);
    setContent('');
    setNoteMeta(null);
    setNoteAnalysis(null);
    setNoteAnalysisRun(null);
    setBackups([]);
    setCurrentHeadings([]);
    setHeadingJump(null);
    setSearchScrollTarget(null);
    setSelectionExpansionSession(null);
    setSelectionExpansionApply(null);
  }, [saveController]);

  const loadAllTags = useCallback(async () => {
    if (!window.electronAPI) return;
    const tags = await window.electronAPI.getAllTags();
    setAllTags(tags);
  }, []);

  const loadFavoritePaths = useCallback(async () => {
    if (!window.electronAPI) return;
    setFavoritePaths(await window.electronAPI.getFavoriteNotes());
  }, []);

  const loadFiles = useCallback(async (): Promise<boolean> => {
    if (!window.electronAPI) return false;
    try {
      const fileList = await window.electronAPI.listFiles();
      const currentLibraryPath = await window.electronAPI.getLibraryPath();
      setLibraryPath(currentLibraryPath);
      setWorkspaceError(null);
      if (fileList) {
        setFiles(fileList);
        setIsReady(true);
        const [, , uiState] = await Promise.all([
          loadAllTags(),
          loadFavoritePaths(),
          window.electronAPI.getLibraryUiState().catch((error) => {
            console.warn(t("无法读取目录树状态，已使用安全默认值。"), error);
            return { schemaVersion: 1 as const, collapsedFolderPaths: collapseAllFolders(fileList), pinnedEntryPaths: [] };
          }),
        ]);
        setCollapsedFolderPaths(uiState.collapsedFolderPaths);
        setPinnedEntryPaths(uiState.pinnedEntryPaths ?? []);
        return true;
      }
      setFiles([]);
      setIsReady(false);
      setAllTags([]);
      setFavoritePaths([]);
      setPinnedEntryPaths([]);
      setCollapsedFolderPaths([]);
      return false;
    } catch (error) {
      const configuredPath = await window.electronAPI.getLibraryPath().catch(() => null);
      setFiles([]); setIsReady(false); setLibraryPath(configuredPath); setAllTags([]);
      setFavoritePaths([]);
      setPinnedEntryPaths([]);
      setCollapsedFolderPaths([]);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [loadAllTags, loadFavoritePaths]);

  const loadLibraries = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      setLibraries(await window.electronAPI.listLibraries());
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadNoteMeta = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    try {
      const meta = await window.electronAPI.getNoteMeta(path);
      if (currentPathRef.current === path) setNoteMeta(meta);
    } catch (error) {
      if (currentPathRef.current === path && !saveController.dirty) saveController.indexState(t("部分笔记信息暂不可用：{0}", { '0': String(error) }));
    }
  }, [saveController]);

  const loadBackups = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    try {
      const entries = await window.electronAPI.listBackups(path);
      if (currentPathRef.current === path) setBackups(entries);
    } catch (error) {
      if (currentPathRef.current === path && !saveController.dirty) saveController.indexState(t("备份列表暂不可用：{0}", { '0': String(error) }));
    }
  }, [saveController]);

  /** 按路径发现持久任务；序号防止快速进度和切换笔记时旧响应覆盖新状态。 */
  const loadNoteAnalysisResults = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    const loadId = ++noteAnalysisLoadRef.current;
    const [analysis, run] = await Promise.all([
      window.electronAPI.getNoteAnalysis(path),
      window.electronAPI.getLatestNoteAnalysisRun?.(path) ?? Promise.resolve(null),
    ]);
    if (currentPathRef.current !== path || noteAnalysisLoadRef.current !== loadId) return;
    setNoteAnalysis(analysis);
    setNoteAnalysisRun(run);
  }, []);

  const loadAiContext = useCallback(async (path: string) => {
    if (!window.electronAPI) return;
    try {
      const [status] = await Promise.all([
        window.electronAPI.getAiStatus(),
        loadNoteAnalysisResults(path),
      ]);
      if (currentPathRef.current === path) setAiStatus(status);
    } catch (error) {
      if (currentPathRef.current === path) setWorkspaceError(t("笔记分析信息暂不可用：{0}", { '0': String(error) }));
    }
  }, [loadNoteAnalysisResults]);

  useEffect(() => {
    if (!window.electronAPI?.onNoteAnalysisProgress) return;
    return window.electronAPI.onNoteAnalysisProgress((progress) => {
      // 每次执行只提示一次终态失败；恢复后重新允许提示，切换笔记也不吞掉后台错误。
      if (progress.state === 'queued' || progress.state === 'running') {
        notifiedNoteAnalysisFailuresRef.current.delete(progress.runId);
      } else if ((progress.state === 'failed' || progress.state === 'partial') && !notifiedNoteAnalysisFailuresRef.current.has(progress.runId)) {
        notifiedNoteAnalysisFailuresRef.current.add(progress.runId);
        const noteName = progress.notePath.replace(/\\/g, '/').split('/').at(-1) || t("当前笔记");
        window.alert(t("笔记“{0}”分析未完成：\n{1}", { '0': noteName, '1': progress.error?.message || t("分析失败，请查看分析状态后重试。") }));
      }
      if (currentPathRef.current !== progress.notePath) return;
      void loadNoteAnalysisResults(progress.notePath).catch((error: unknown) => {
        setWorkspaceError(error instanceof Error ? error.message : String(error));
      });
    });
  }, [loadNoteAnalysisResults]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const flushPendingSave = useCallback(() => saveController.flush(), [saveController]);
  const awaitCurrentNoteIndex = useCallback(async () => {
    const snapshot = saveController.snapshot;
    if (!snapshot) return;
    const state = await window.electronAPI.awaitNoteIndex(snapshot.editSessionId, snapshot.version.diskHash);
    if (state !== 'current') { saveController.conflict(t("磁盘笔记已发生变化，请重新加载或另存草稿。")); throw new Error(t("笔记版本已变化，当前操作未开始。")); }
  }, [saveController]);
  const scheduleSave = useCallback((path: string, nextContent: string) => {
    if (saveController.snapshot?.path === path) saveController.edit(nextContent, appPreferencesRef.current.autosaveDelayMs);
  }, [saveController]);

  useEffect(() => {
    const prepare = window.electronAPI.onMaintenancePrepare(({ requestId }) => {
      saveController.freeze(true, 'maintenance');
      void Promise.all([saveController.flush(), externalDocumentsRef.current.maintain()]).then(([ok]) => window.electronAPI.respondMaintenance(requestId, ok)).catch(() => window.electronAPI.respondMaintenance(requestId, false));
    });
    const changed = window.electronAPI.onMaintenanceChanged(({ phase }) => { const active = phase !== 'idle'; setIsMaintaining(active); saveController.freeze(active, 'maintenance'); if (!active) externalDocumentsRef.current.releaseMaintenance(); });
    return () => { prepare(); changed(); };
  }, [saveController]);

  useEffect(() => {
    if (!window.electronAPI?.onNoteCloseRequested) return;
    const unsubscribeClose = window.electronAPI.onNoteCloseRequested(({ requestId }) => {
      saveController.freeze(true);
      if (externalDocumentsRef.current.controller.snapshot) window.electronAPI.waitForNoteCloseDecision(requestId);
      void (async () => await saveController.flush() && await externalDocumentsRef.current.prepareTransition())().then((ok) => {
        window.electronAPI.respondNoteClose({ requestId, ok });
        if (!ok) saveController.freeze(false);
      }).catch(() => { window.electronAPI.respondNoteClose({ requestId, ok: false }); saveController.freeze(false); });
    });
    const unsubscribeState = window.electronAPI.onNoteSaveState((state) => {
      if (!state.editSessionId) { saveController.freeze(false); saveController.indexState(state.message); return; }
      if (state.editSessionId === saveController.snapshot?.editSessionId) saveController.acknowledgeIndex(state.indexState, state.editRevision ?? 0, state.message);
    });
    return () => { unsubscribeClose(); unsubscribeState(); };
  }, [saveController]);

  useEffect(() => {
    let alive = true;
    const workspace = window.electronAPI?.getWorkspacePath().then(setWorkspacePath).catch((error) => {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    });
    void Promise.allSettled([loadFiles(), loadLibraries(), workspace]).then(() => {
      if (alive) setStartupDataLoaded(true);
    });

    if (window.electronAPI) {
      // 可选模型配置读取失败不能阻止偏好、引导和本地编辑完成初始化。
      void Promise.allSettled([
        window.electronAPI.getAppPreferences(),
        window.electronAPI.getAiProviderConfig(),
        window.electronAPI.getAiModelSettings(),
        window.electronAPI.getAiExtensionsSettings(),
      ]).then(([preferencesResult, config, modelSettings, extensionsSettings]) => {
        if (!alive) return;
        const appearance = window.electronAPI.startupAppearance;
        const preferences = preferencesResult.status === 'fulfilled' ? preferencesResult.value : {
          ...defaultPreferences,
          theme: appearance?.themeMode ?? defaultPreferences.theme,
          lightColorScheme: appearance?.lightColorScheme ?? defaultPreferences.lightColorScheme,
          language: appearance?.language ?? defaultPreferences.language,
        };
        replaceAppPreferences(preferences);
        setArePreferencesLoaded(true);
        setEditorMode(preferences.defaultEditorMode);
        setEditorZoom(normalizeEditorPreferences(preferences).defaultEditorZoom);
        if (config.status === 'fulfilled') setAiProviderConfig(config.value);
        if (modelSettings.status === 'fulfilled') setAiModelSettings(modelSettings.value);
        if (extensionsSettings.status === 'fulfilled') setAiExtensionsSettings(extensionsSettings.value);
        if (preferencesResult.status === 'rejected') setWorkspaceError(t('应用配置读取失败，请在设置中重试。'));
      });
    } else {
      setArePreferencesLoaded(true);
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        setIsSearchOpen((previous) => !previous);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    if (window.electronAPI?.onLog) {
      window.electronAPI.onLog((msg) => {
        console.log('%c[MAIN]', 'background: #3f3f3b; color: #fff; padding: 2px 4px; borderRadius: 2px;', msg);
      });
    }

    return () => {
      alive = false;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loadFiles, loadLibraries, replaceAppPreferences]);

  useLayoutEffect(() => {
    if (!arePreferencesLoaded) return undefined;
    synchronizeAppearance(appPreferences);
    if (appPreferences.theme !== 'system') return undefined;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => synchronizeAppearance(appPreferences);
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, [appPreferences, arePreferencesLoaded, synchronizeAppearance]);

  useEffect(() => () => {
    if (themeFeedbackTimerRef.current) window.clearTimeout(themeFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (noteMeta?.kind === 'text' && editorMode !== 'source') {
      setEditorMode('source');
    }
  }, [editorMode, noteMeta?.kind]);

  useEffect(() => {
    if (!headingJump || editorMode !== 'source') return;
    const line = document.querySelectorAll<HTMLElement>('.cm-line')[Math.max(headingJump.heading.line - 1, 0)];
    line?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [editorMode, headingJump]);

  useEffect(() => {
    if (editorMode === 'source' || !currentIsMarkdown) {
      setCurrentHeadings(noteMeta?.headings ?? []);
    }
  }, [currentIsMarkdown, editorMode, noteMeta?.headings]);

  const handleSelectWorkspace = async () => {
    setMigrationRequest(current => ({ sequence: current.sequence + 1, mode: 'migrate' }));
  };
  const handleOpenWorkspace = async () => { setMigrationRequest(current => ({ sequence: current.sequence + 1, mode: 'open' })); };

  const openCreateLibraryModal = () => {
    setWorkspaceError(null);
    setIsCreateLibraryModalOpen(true);
  };

  const handleCreateLibrary = async (name: string, parentDirectoryPath: string | null) => {
    if (!await externalDocumentsRef.current.prepareTransition()) return;
    if (!window.electronAPI) return;
    await saveController.mutate(async () => {
      try {
        const selectedPath = await window.electronAPI.createLibrary(name, parentDirectoryPath);
        if (!selectedPath) return;
        resetCurrentNote();
        await Promise.all([loadFiles(), loadLibraries()]);
        setMainView('home');
        setIsCreateLibraryModalOpen(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWorkspaceError(message);
        throw error;
      }
    });
  };

  const handleActivateLibrary = async (nextPath: string) => {
    if (!window.electronAPI) return;
    if (!await externalDocumentsRef.current.prepareTransition()) return;
    if (normalizePathForCompare(nextPath) === normalizePathForCompare(libraryPath ?? '')) {
      setMainView('notes');
      return;
    }
    await saveController.mutate(async () => {
      try {
        await window.electronAPI.activateLibrary(nextPath);
        resetCurrentNote();
        await Promise.all([loadFiles(), loadLibraries()]);
        setMainView('notes');
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : String(error));
      }
    });
  };

  const handleRemoveLibrary = async (targetPath: string) => {
    if (!window.electronAPI) return;
    const removed = await saveController.mutate(async () => {
      try {
        const wasActive = normalizePathForCompare(libraryPath ?? '') === normalizePathForCompare(targetPath);
        const nextLibraries = await window.electronAPI.removeLibrary(targetPath);
        setLibraries(nextLibraries);
        if (wasActive) {
          resetCurrentNote();
          await loadFiles();
          setMainView('libraries');
        }
        return true;
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    if (!removed) throw new Error(t("当前笔记尚未完成保存，请处理保存提示后再移除笔记库。"));
  };

  const openCreateMaterialsModal = () => {
    setWorkspaceError(null);
    setMaterialsModal({ opened: true, mode: 'create', upgradePath: null });
  };

  const openUpgradeMaterialsModal = (libraryPath?: string) => {
    setWorkspaceError(null);
    setMaterialsModal({ opened: true, mode: 'upgrade', upgradePath: libraryPath ?? null });
  };

  const handleCreateMaterialsLibrary = async (name: string, icon: string) => {
    if (!window.electronAPI) return;
    try {
      const createdPath = await window.electronAPI.createMaterialsLibrary(name, icon);
      if (!createdPath) return;
      setMaterialsModal({ opened: false, mode: 'create', upgradePath: null });
      setMaterialsRefreshKey((key) => key + 1);
      setMainView('sources');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkspaceError(message);
      throw error;
    }
  };

  const handleUpgradeLibraryToMaterials = async (targetPath: string, icon: string) => {
    if (!window.electronAPI) return;
    await saveController.mutate(async () => {
      try {
        await window.electronAPI.upgradeLibraryToMaterials(targetPath, icon);
        setMaterialsModal({ opened: false, mode: 'upgrade', upgradePath: null });
        setMaterialsRefreshKey((key) => key + 1);
        setMainView('sources');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWorkspaceError(message);
        throw error;
      }
    });
  };

  const handleOpenSettings = useCallback(async (section: SettingsSection = 'general') => {
    if (!window.electronAPI) return;
    if (mainView !== 'settings') setSettingsReturnView(mainView);
    const [config, preferences, modelSettings, extensionsSettings, hub] = await Promise.all([window.electronAPI.getAiProviderConfig(), window.electronAPI.getAppPreferences(), window.electronAPI.getAiModelSettings(), window.electronAPI.getAiExtensionsSettings(), window.electronAPI.getModelHub()]);
    setAiProviderConfig(config);
    replaceAppPreferences(preferences);
    setAiModelSettings(modelSettings);
    setAiExtensionsSettings(extensionsSettings);
    setModelHub(hub);
    setSettingsSection(section);
    setSettingsSectionRequestId(id => id + 1);
    setMainView('settings');
  }, [mainView, replaceAppPreferences]);
  useEffect(() => {
    const reviewMemory = (event: Event) => {
      const itemId = (event as CustomEvent<{ itemId?: string }>).detail?.itemId;
      if (!itemId) return;
      setMemoryReviewRequest({ itemId, requestId: Date.now() });
      void handleOpenSettings('user-information');
    };
    window.addEventListener('trellora:review-memory', reviewMemory);
    return () => window.removeEventListener('trellora:review-memory', reviewMemory);
  }, [handleOpenSettings]);
  const handleSaveAiModelSettings = async (settings: AiModelSettingsInput) => {
    if (!window.electronAPI) return aiModelSettings;
    const result = await saveConfigurationWithConfirmation({ kind: 'profiles', settings });
    const saved = result.modelSettings!;
    setAiModelSettings(saved);
    setModelHub(result.hub);
    void Promise.allSettled([window.electronAPI.getAiProviderConfig(), window.electronAPI.getAiStatus(), window.electronAPI.getAssistantAiOptions()]).then(([config, status, options]) => {
      if (config.status === 'fulfilled') setAiProviderConfig(config.value);
      if (status.status === 'fulfilled') setAiStatus(status.value);
      if (options.status === 'fulfilled') setAssistantAiOptions(options.value);
    });
    return saved;
  };
  const handleFetchModelProviderModels = async (id: string, draft?: ModelProviderCatalogDraft): Promise<{ result: RemoteProviderModelsResult; hub: ModelHub }> => {
    if (!window.electronAPI) return { result: { available: false, models: [], message: t("桌面运行时不可用。") }, hub: modelHub };
    return window.electronAPI.fetchModelProviderModels(id, draft);
  };
  const handleSaveModelConfiguration = async (change: ModelConfigurationChange) => {
    const saved = await saveConfigurationWithConfirmation(change);
    setModelHub(saved.hub);
    void Promise.allSettled([window.electronAPI.getAiProviderConfig(), window.electronAPI.getAiStatus()]).then(([config, status]) => {
      if (config.status === 'fulfilled') setAiProviderConfig(config.value);
      if (status.status === 'fulfilled') setAiStatus(status.value);
    });
    return saved.hub;
  };
  const handleSaveAiExtensionsSettings = async (settings: AiExtensionsSettings) => {
    if (!window.electronAPI) return;
    const saved = await window.electronAPI.saveAiExtensionsSettings(settings);
    setAiExtensionsSettings(saved);
    setAssistantAiOptions(await window.electronAPI.getAssistantAiOptions());
  };
  const handleRefreshAssistantAiOptions = useCallback(async (profileId?: string) => {
    if (!window.electronAPI) return defaultAssistantAiOptions;
    const requestKey = profileId ?? '';
    const requestSequence = ++assistantAiOptionsRefreshSequenceRef.current;
    const pending = assistantAiOptionsRequestsRef.current.get(requestKey);
    if (pending) {
      return pending.then((options) => {
        if (assistantAiOptionsRefreshSequenceRef.current === requestSequence) setAssistantAiOptions(options);
        return options;
      });
    }

    const request = window.electronAPI.getAssistantAiOptions(profileId);
    assistantAiOptionsRequestsRef.current.set(requestKey, request);
    // React StrictMode replays mount effects in development. Reuse the same
    // in-flight IPC request so one assistant mount still probes once, while a
    // model switch gets its own request key and its own metadata refresh.
    void request.then(
      () => {
        if (assistantAiOptionsRequestsRef.current.get(requestKey) === request) assistantAiOptionsRequestsRef.current.delete(requestKey);
      },
      () => {
        if (assistantAiOptionsRequestsRef.current.get(requestKey) === request) assistantAiOptionsRequestsRef.current.delete(requestKey);
      },
    );
    return request.then((options) => {
      if (assistantAiOptionsRefreshSequenceRef.current === requestSequence) setAssistantAiOptions(options);
      return options;
    });
  }, []);
  const handleSavePreferences = useCallback(async (patch: Partial<Omit<AppPreferences, 'schemaVersion'>>) => {
    if (!window.electronAPI) return;
    const previousPreferences = appPreferencesRef.current;
    const previousZoom = editorZoomRef.current;
    if (patch.defaultEditorZoom !== undefined) setEditorZoom(patch.defaultEditorZoom);
    const optimisticPreferences = { ...previousPreferences, ...patch };
    const saveSequence = ++preferenceSaveSequenceRef.current;
    replaceAppPreferences(optimisticPreferences);
    synchronizeAppearance(optimisticPreferences);
    try {
      const saved = await window.electronAPI.saveAppPreferences(patch);
      if (preferenceSaveSequenceRef.current === saveSequence) {
        replaceAppPreferences(saved);
        synchronizeAppearance(saved);
      }
    } catch (error) {
      if (preferenceSaveSequenceRef.current === saveSequence) {
        replaceAppPreferences(previousPreferences);
        if (patch.defaultEditorZoom !== undefined) setEditorZoom(previousZoom);
        synchronizeAppearance(previousPreferences);
      }
      throw error;
    }
  }, [replaceAppPreferences, synchronizeAppearance]);

  useEffect(() => {
    const handleThemeShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'l') return;
      event.preventDefault();
      const nextTheme: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
      void handleSavePreferences({ theme: nextTheme })
        .then(() => showThemeFeedback(t("已切换为{0}外观", { '0': nextTheme === 'dark' ? t("深色") : t("浅色") })))
        .catch(() => showThemeFeedback(t("外观切换失败，请在设置中重试。")));
    };
    window.addEventListener('keydown', handleThemeShortcut);
    return () => window.removeEventListener('keydown', handleThemeShortcut);
  }, [handleSavePreferences, resolvedTheme, showThemeFeedback]);
  const handleRightPanelWidthChange = useCallback(async (width: number) => {
    await handleSavePreferences({ rightPanelWidth: width });
  }, [handleSavePreferences]);
  const handleLeftSidebarWidthChange = useCallback(async (width: number) => {
    await handleSavePreferences({ leftSidebarWidth: width });
  }, [handleSavePreferences]);

  const handleSelectFile = useCallback(async (
    path: string,
    searchTerm?: string,
    navigationTarget?: SearchNavigationTarget,
    headingFragment?: string,
  ) => {
    if (!window.electronAPI) return;
    if (!window.electronAPI.openNoteEditSession) { setWorkspaceError(t("应用代码已更新，请重启桌面应用后再编辑笔记。")); return; }
    if (!await externalDocumentsRef.current.prepareTransition()) return false;
    const saved = await flushPendingSave();
    if (!saved) return;

    const requestId = selectionRequestIdRef.current + 1;
    selectionRequestIdRef.current = requestId;
    saveController.freeze(true);
    let snapshot;
    try {
      snapshot = await window.electronAPI.openNoteEditSession(path);
      const results = await Promise.allSettled([window.electronAPI.getNoteMeta(path), window.electronAPI.listBackups(path), window.electronAPI.getAllTags()]);
      const meta = results[0].status === 'fulfilled' ? results[0].value : null;
      const backupEntries = results[1].status === 'fulfilled' ? results[1].value : [];
      const tags = results[2].status === 'fulfilled' ? results[2].value : [];

      if (selectionRequestIdRef.current !== requestId) { await window.electronAPI.closeNoteEditSession(snapshot.editSessionId); return; }
      if (saveController.snapshot) await window.electronAPI.closeNoteEditSession(saveController.snapshot.editSessionId);
      saveController.open(snapshot);
      if (results.some((result) => result.status === 'rejected')) saveController.indexState(t("内容已读取，部分索引或备份信息暂不可用。"));
      currentPathRef.current = path;
      setCurrentPath(path);
      setCurrentSearchTerm(searchTerm || null);
      setSearchScrollTarget(null);
      setHeadingJump(null);
      setCurrentHeadings([]);
      setContent('');
      setNoteMeta(null);
      setNoteAnalysis(null);
      setNoteAnalysisRun(null);
      setBackups([]);

      setContent(snapshot.content); setNoteMeta(meta); setBackups(backupEntries); setAllTags(tags);
      const preferredMode = meta?.kind === 'text'
        ? 'source'
        : appPreferences.defaultEditorMode === 'preview'
          ? (appPreferences.previewPreference === 'source' ? 'source' : 'preview')
          : appPreferences.defaultEditorMode;
      const targetHeading = navigationTarget?.heading
        ? meta?.headings.find((heading) => heading.text.trim() === navigationTarget.heading?.trim())
        : undefined;
      if (headingFragment && meta?.kind !== 'text') {
        setEditorMode('preview');
        setHeadingJump({
          heading: { id: headingFragment, level: 1, text: headingFragment, line: 1, index: -1 },
          nonce: Date.now(),
        });
      } else if (targetHeading) {
        // Search navigation must render a scrollable document target. Source and
        // preview modes cannot reliably expose the AST heading element to the
        // editor's positioning effect, so search results open in WYSIWYG.
        setEditorMode('wysiwyg');
        setHeadingJump({ heading: targetHeading, nonce: Date.now() });
      } else if (navigationTarget?.snippet?.trim() && meta?.kind !== 'text') {
        setEditorMode('wysiwyg');
        setSearchScrollTarget({ text: navigationTarget.snippet, nonce: Date.now() });
      } else {
        setEditorMode(preferredMode);
      }
      void handleSavePreferences({ lastOpenedNote: path });
      void loadAiContext(path);
      return true;
    } catch (error) {
      if (snapshot && snapshot.editSessionId !== saveController.snapshot?.editSessionId) await window.electronAPI.closeNoteEditSession(snapshot.editSessionId);
      if (selectionRequestIdRef.current === requestId) setWorkspaceError(t("打开笔记失败：{0}", { '0': String(error) }));
      return false;
    } finally { if (selectionRequestIdRef.current === requestId) saveController.freeze(false); }

  }, [
    appPreferences.defaultEditorMode,
    appPreferences.previewPreference,
    saveController,
    flushPendingSave,
    handleSavePreferences,
    loadAiContext,
  ]);

  externalLibraryOpener.current = async (targetLibrary, filePath) => {
    if (normalizePathForCompare(targetLibrary) !== normalizePathForCompare(libraryPath ?? '')) {
      if (!window.confirm(t('该文件属于另一个笔记库，是否切换并打开？'))) return false;
      await window.electronAPI.activateLibrary(targetLibrary); resetCurrentNote(); await Promise.all([loadFiles(), loadLibraries()]);
    }
    const opened = await handleSelectFile(filePath);
    if (opened) setMainView('notes'); return opened === true;
  };

  const handleNavigateAssistantCitation = useCallback(async (citation: AssistantEvidenceCitation): Promise<AssistantCitationValidation> => {
    if (!window.electronAPI) return { status: 'stale', message: t("桌面引用定位能力不可用。") };
    // A citation is bound to a saved snapshot. Flush a local edit first so
    // the main-process guard cannot validate one version while the editor
    // displays another.
    if (!await flushPendingSave()) return { status: 'stale', message: t("当前笔记尚未保存，暂时不能定位引用。") };
    const validation = await window.electronAPI.validateAssistantCitation(citation);
    if (validation.status !== 'valid') return validation;
    // A citation is an explicit request to inspect its source. The Q&A entry
    // itself remains a separate workspace; only this deliberate action opens
    // the note editor.
    setMainView('notes');
    if (currentPathRef.current !== citation.notePath) await handleSelectFile(citation.notePath);
    setCurrentSearchTerm(null);
    setEditorMode('wysiwyg');
    setSearchScrollTarget({
      lineFrom: citation.lineFrom,
      lineTo: citation.lineTo,
      text: citation.preview,
      nonce: Date.now(),
    });
    return validation;
  }, [flushPendingSave, handleSelectFile]);

  /** 确认目标库后先保存当前草稿，再导入文档、切换库并通过版本化会话打开笔记。 */
  const handleOpenWikiDocumentInNotes = useCallback(async (source: WikiNoteSource, targetLibraryPath: string) => {
    if (!window.electronAPI?.importWikiDocumentToNoteLibrary) throw new Error(t("应用代码已更新，请重启桌面应用后再打开笔记。"));
    const notePath = await saveController.mutate(async () => {
      const importedPath = await window.electronAPI.importWikiDocumentToNoteLibrary(source.libraryPath, source.documentId, source.contentHash, targetLibraryPath);
      if (normalizePathForCompare(targetLibraryPath) !== normalizePathForCompare(libraryPath ?? '')) {
        await window.electronAPI.activateLibrary(targetLibraryPath);
        resetCurrentNote();
      }
      const loaded = await loadFiles();
      await loadLibraries();
      if (!loaded) throw new Error(t("无法读取目标笔记库，请检查目录后重试。"));
      return importedPath;
    });
    if (!notePath) throw new Error(t("当前笔记尚未保存，暂时无法打开来源文档。"));
    await handleSelectFile(notePath);
    if (saveController.snapshot?.path !== notePath) throw new Error(t("笔记已生成，但打开失败，请重试。"));
    setMainView('notes');
  }, [saveController, libraryPath, resetCurrentNote, loadFiles, loadLibraries, handleSelectFile]);

  useEffect(() => {
    if (!startupDataLoaded || !arePreferencesLoaded || startupRestoredRef.current) return;
    startupRestoredRef.current = true;
    if (!isReady || appPreferences.startupBehavior !== 'last-note' || !appPreferences.lastOpenedNote) {
      setStartupRestoreFinished(true);
      return;
    }
    const existsInTree = flattenFileNodes(files).some((node) => normalizePathForCompare(node.path) === normalizePathForCompare(appPreferences.lastOpenedNote!));
    if (existsInTree) {
      void handleSelectFile(appPreferences.lastOpenedNote)
        .catch(error => setWorkspaceError(error instanceof Error ? error.message : String(error)))
        .finally(() => setStartupRestoreFinished(true));
    } else setStartupRestoreFinished(true);
    // handleSelectFile intentionally runs only once after startup state is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPreferences.lastOpenedNote, appPreferences.startupBehavior, arePreferencesLoaded, files, isReady, startupDataLoaded]);

  useEffect(() => {
    if (!startupRestoreFinished || (!guide.state && !guide.error)) return;
    onStartupReady();
  }, [guide.error, guide.state, onStartupReady, startupRestoreFinished]);

  useEffect(() => {
    if (!window.electronAPI?.onNoteIndexChanged) return;
    return window.electronAPI.onNoteIndexChanged((delta) => {
      const event = indexEventRef.current;
      if (delta.libraryPath !== libraryPath || (event.library === delta.libraryPath && (delta.libraryGeneration < event.generation || (delta.libraryGeneration === event.generation && delta.indexRevision <= event.revision)))) return;
      indexEventRef.current = { library: delta.libraryPath, generation: delta.libraryGeneration, revision: delta.indexRevision };
      if (delta.changedFields.includes('tree')) setFiles((current) => applyNoteIndexDelta(current, delta));
      if (delta.changedFields.includes('tags') || delta.changes.some((change) => change.kind === 'unlink')) void loadAllTags();
      setAssistantContextRevision((revision) => revision + 1);
      const activePath = currentPathRef.current;
      if (!activePath) return;
      const activeChanges = delta.changes.filter((change) => normalizePathForCompare(change.path) === normalizePathForCompare(activePath) || normalizePathForCompare(activePath).startsWith(`${normalizePathForCompare(change.path)}/`));
      if (activeChanges.some((change) => change.kind === 'unlink' || change.kind === 'unlinkDir')) {
        if (delta.source === 'external') saveController.conflict(t("原笔记已被删除或移动，当前草稿已保留，可另存为新笔记。"));
        return;
      }
      // Content/link changes also affect backlinks of other notes.
      if (delta.changedFields.some((field) => ['content', 'links', 'title'].includes(field))) void loadNoteMeta(activePath);
      if (activeChanges.length) { void loadBackups(activePath); void loadAiContext(activePath); if (delta.source === 'reconcile') saveController.indexState(); }
      if (!activeChanges.length || delta.source !== 'external' || !saveController.snapshot || saveController.blocked) return;
      if (saveController.dirty && !saveController.saving) { saveController.conflict(t("磁盘笔记已被其他程序修改，当前草稿已保留。")); return; }
      const sessionId = saveController.snapshot.editSessionId;
      void (async () => {
        if (saveController.saving && !await saveController.flush()) return;
        if (saveController.dirty) return;
        const revision = saveController.revision;
        const snapshot = await window.electronAPI.refreshNoteEditSession(sessionId);
        if (saveController.snapshot?.editSessionId !== sessionId || saveController.dirty || saveController.revision !== revision || currentPathRef.current !== activePath) return;
        saveController.open(snapshot); setContent(snapshot.content);
      })().catch((error) => saveController.indexState(String(error)));
    });
  }, [libraryPath, loadAiContext, loadAllTags, loadBackups, loadNoteMeta, saveController]);

  const handleToggleFavorite = async (filePath: string) => {
    if (!window.electronAPI) return;
    const normalizedPath = normalizePathForCompare(filePath);
    const favorite = !favoritePaths.some((entry) => normalizePathForCompare(entry) === normalizedPath);
    setFavoritePaths(await window.electronAPI.setFavoriteNote(filePath, favorite));
  };

  // Restore registration and optional preferences are committed by the main process.
  const handleWorkspaceDataChanged = async () => {
    const [workspace, preferences] = await Promise.all([window.electronAPI.getWorkspacePath(), window.electronAPI.getAppPreferences(), loadLibraries()]);
    setWorkspacePath(workspace);
    replaceAppPreferences(preferences);
    setWorkspaceError(null);
  };

  const handleMigrationBlocked = useCallback((blocked: boolean) => { setMigrationBlocked(blocked); }, []);
  const handleMigratedData = async (source?: string, target?: string) => {
    const moving = Boolean(source && target && source !== target);
    // Keep the reopen target across failures, including failures after the note has already reopened.
    if (moving && source && target && (migrationNoteRef.current?.source !== source || migrationNoteRef.current?.target !== target)) {
      const current = currentPathRef.current;
      migrationNoteRef.current = { source, target, path: current ? getPathAfterEntryMove(current, source, target) ?? current : null };
      resetCurrentNote();
    }
    const relocated = moving ? migrationNoteRef.current?.path : null;
    await handleWorkspaceDataChanged();
    const loaded = await loadFiles();
    if (!loaded && await window.electronAPI.getLibraryPath()) throw new Error(t('新位置的数据暂未加载，请重试加载。'));
    if (relocated && currentPathRef.current !== relocated && !externalDocumentsRef.current.controller.snapshot) {
      await handleSelectFile(relocated);
      if (currentPathRef.current !== relocated) throw new Error(t('新位置的数据暂未加载，请重试加载。'));
    }
    setAssistantContextRevision(key => key + 1);
    await notifyWorkspaceDataChanged(source, target);
    migrationNoteRef.current = null;
  };

  // 置顶只改变同级展示顺序；排序和收藏继续使用各自的持久化状态。
  const handleTogglePinned = async (entryPath: string) => {
    if (!window.electronAPI) return;
    const nextPaths = pinnedEntryPaths.includes(entryPath)
      ? pinnedEntryPaths.filter((path) => path !== entryPath)
      : [...pinnedEntryPaths, entryPath];
    const state = await window.electronAPI.saveLibraryUiState({ pinnedEntryPaths: nextPaths });
    setPinnedEntryPaths(state.pinnedEntryPaths);
  };

  // 查看任意笔记的已有概览；当前笔记先完成保存与索引，避免展示旧标签。
  const loadNoteOverview = async (path: string) => {
    if (currentPathRef.current === path) {
      if (!(await flushPendingSave())) throw new Error(t("请先保存当前笔记，再查看概览。"));
      await awaitCurrentNoteIndex();
    }
    const [meta, analysis] = await Promise.all([
      window.electronAPI.getNoteMeta(path),
      window.electronAPI.getNoteAnalysis(path),
    ]);
    if (!meta) throw new Error(t("未找到这篇笔记，请刷新笔记库后重试。"));
    return { meta, analysis };
  };

  const handleGenerateNoteAnalysis = async (): Promise<void> => {
    if (!window.electronAPI || !currentPath) throw new Error(t("请先选择一篇笔记。"));
    const saved = await flushPendingSave();
    if (!saved) throw new Error(t("保存当前笔记后才能分析。"));
    await awaitCurrentNoteIndex();

    const status = await window.electronAPI.getAiStatus();
    setAiStatus(status);
    const model = aiProviderConfig.model || status.models[0]?.name;
    if (!status.available || !model) {
      const message = status.message || t("请先在“模型”设置中选择可用模型。");
      window.alert(message);
      throw new Error(message);
    }

    const analysisPath = currentPath;
    setIsStartingNoteAnalysis(true);
    try {
      if (!window.electronAPI.startNoteAnalysis) throw new Error(t("笔记分析功能已更新，请重启应用后再生成。"));
      await window.electronAPI.startNoteAnalysis(analysisPath, model);
      await loadNoteAnalysisResults(analysisPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(t("笔记分析未完成：{0}", { '0': message }));
      throw error;
    } finally {
      setIsStartingNoteAnalysis(false);
    }
  };

  const handleCancelNoteAnalysis = async (): Promise<void> => {
    if (!window.electronAPI || !noteAnalysisRun) return;
    await window.electronAPI.cancelNoteAnalysis(noteAnalysisRun.runId);
    await loadNoteAnalysisResults(noteAnalysisRun.notePath);
  };

  const handleResumeNoteAnalysis = async (): Promise<void> => {
    if (!window.electronAPI || !noteAnalysisRun || !(await flushPendingSave())) return;
    try {
      await window.electronAPI.resumeNoteAnalysis(noteAnalysisRun.runId);
      await loadNoteAnalysisResults(noteAnalysisRun.notePath);
    } catch (error) {
      window.alert(t("恢复笔记分析失败：{0}", { '0': error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  };

  const handleApplySuggestedTags = async (suggestedTags: string[], requireCurrentAnalysis = true): Promise<void> => {
    if (!window.electronAPI || !currentPath || !suggestedTags.length) return;
    await saveController.mutate(async () => {
      if (requireCurrentAnalysis) {
        const [analysis, run] = await Promise.all([window.electronAPI.getNoteAnalysis(currentPath), window.electronAPI.getLatestNoteAnalysisRun?.(currentPath) ?? Promise.resolve(null)]);
        if (!analysis || analysis.isStale || (run && (run.state !== 'completed' || run.isStale))) throw new Error(t("请完成当前版本的分析后再应用建议标签。"));
      }
      const existingTags = new Set((noteMeta?.tags ?? []).map((tag) => tag.toLocaleLowerCase('zh-CN')));
      const newTags = suggestedTags.filter((tag) => !existingTags.has(tag.toLocaleLowerCase('zh-CN')));
      if (!newTags.length) return;
      if (await saveController.commitMutation((request) => window.electronAPI.mutateNote({ ...request, action: 'tags', tags: newTags }))) setContent(saveController.content);
    });
  };

  const handleStartAssistantTurn = useCallback(async (request: AssistantTurnRequest): Promise<{ requestId: string }> => {
    if (!window.electronAPI) throw new Error(t("桌面能力不可用。"));
    if (request.scope === 'current-note') {
      if (!currentPathRef.current) throw new Error(t("请先选择一篇笔记。"));
      const saved = await flushPendingSave();
      if (!saved) throw new Error(t("当前笔记尚未保存，无法作为本次上下文。"));
      await awaitCurrentNoteIndex();
      request = { ...request, currentNotePath: currentPathRef.current };
    }
    return window.electronAPI.startAssistantTurn(request);
  }, [flushPendingSave, awaitCurrentNoteIndex]);

  const handleCancelAssistantTurn = useCallback(async (requestId: string): Promise<boolean> => {
    if (!window.electronAPI) return false;
    return window.electronAPI.cancelAssistantTurn(requestId);
  }, []);

  const handleOpenSelectionExpansion = useCallback(async (snapshot: SelectionSnapshot): Promise<void> => {
    if (!window.electronAPI) return;
    if (appPreferencesRef.current.editorFocusModeEnabled) await handleSavePreferences({ editorFocusModeEnabled: false });
    try {
      const [capabilities, settings] = await Promise.all([
        window.electronAPI.getSelectionExpansionCapabilities(),
        window.electronAPI.getSelectionExpansionSettings(),
      ]);
      if (!capabilities.enabled) {
        window.alert(t("选区扩写优化尚未启用。"));
        return;
      }
      setIsRightPanelCollapsed(false);
      setSelectionExpansionSession({
        id: `selection-expansion-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        snapshot,
        writeback: getSelectionWritebackCapability(snapshot),
        settings,
        capabilities,
        status: 'configuring',
        sequence: 0,
        evidence: [],
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("无法打开选区扩写设置。"));
    }
  }, [handleSavePreferences]);

  const handleSelectionExpansionSettingsChange = useCallback((settings: SelectionExpansionSettings) => {
    setSelectionExpansionSession((current) => current ? { ...current, settings } : current);
  }, []);

  const handleSaveSelectionExpansionDefaults = useCallback(async (settings: SelectionExpansionSettings): Promise<void> => {
    if (!window.electronAPI) return;
    try {
      const saved = await window.electronAPI.saveSelectionExpansionSettings(settings);
      setSelectionExpansionSession((current) => current ? { ...current, settings: saved } : current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("扩写默认设置保存失败。"));
    }
  }, []);

  const handlePrepareSelectionEditSource = useCallback(async (snapshot: SelectionSnapshot) => {
    if (!window.electronAPI || currentPathRef.current !== snapshot.currentPath) throw new Error(t("当前笔记已切换，请重新选择文字。"));
    if (!await flushPendingSave()) throw new Error(t("当前笔记尚未保存，无法开始扩写。"));
    await awaitCurrentNoteIndex();
    if (currentPathRef.current !== snapshot.currentPath) throw new Error(t("当前笔记已切换，请重新选择文字。"));
    return window.electronAPI.prepareSelectionExpansionSource(snapshot.currentPath);
  }, [flushPendingSave, awaitCurrentNoteIndex]);

  const handleStartSelectionExpansion = useCallback(async (): Promise<void> => {
    if (!window.electronAPI) throw new Error(t("桌面能力不可用。"));
    const session = selectionExpansionSession;
    const notePath = currentPathRef.current;
    if (!session || !notePath || notePath !== session.snapshot.currentPath) {
      throw new Error(t("选区已失效，请重新选择要扩写的文字。"));
    }
    if (session.status === 'planning' || session.status === 'researching' || session.status === 'synthesizing') return;
    const preparation = ++selectionExpansionPreparationRef.current;
    setSelectionExpansionSession((current) => current?.id === session.id ? { ...current, status: 'planning', message: t("正在保存并确认选区原文…"), error: undefined } : current);
    try {
      const selectionLocator = await createSelectionLocatorCapture(session.snapshot);
      const source = await handlePrepareSelectionEditSource(session.snapshot);
      if (preparation !== selectionExpansionPreparationRef.current || currentPathRef.current !== notePath) return;
      const started = await window.electronAPI.startSelectionExpansion({
        selectionSnapshotId: `${session.snapshot.editorSessionId}:${session.snapshot.docRevision}:${session.snapshot.from}:${session.snapshot.to}`,
        sourceSnapshotId: source.sourceSnapshotId,
        currentPath: source.currentPath,
        selectedText: session.snapshot.selectedText,
        selectionLocator,
        expectedContentHash: source.contentHash,
        settings: session.settings,
      });
      if (preparation !== selectionExpansionPreparationRef.current || currentPathRef.current !== notePath) {
        await window.electronAPI.cancelSelectionExpansion(started.requestId);
        return;
      }
      setSelectionExpansionSession((current) => current?.id === session.id ? {
        ...current,
        status: 'planning',
        message: t("正在生成需要核实的证据目标…"),
        requestId: started.requestId,
        taskSessionId: started.sessionId,
        sequence: 0,
        plan: undefined,
        evidence: [],
        result: undefined,
        error: undefined,
      } : current);
    } catch (error) {
      if (preparation === selectionExpansionPreparationRef.current) setSelectionExpansionSession((current) => current?.id === session.id ? { ...current, status: 'error', error: error instanceof Error ? error.message : t("扩写未能启动。") } : current);
      throw error;
    }
  }, [handlePrepareSelectionEditSource, selectionExpansionSession]);

  const handleCancelSelectionExpansion = useCallback(async (): Promise<void> => {
    selectionExpansionPreparationRef.current += 1;
    const requestId = selectionExpansionSession?.requestId;
    if (!requestId) {
      setSelectionExpansionSession((current) => current ? { ...current, status: 'cancelled', message: undefined } : current);
      return;
    }
    if (!window.electronAPI) return;
    await window.electronAPI.cancelSelectionExpansion(requestId);
  }, [selectionExpansionSession?.requestId]);

  const handleCloseSelectionExpansion = useCallback(() => {
    selectionExpansionPreparationRef.current += 1;
    const requestId = selectionExpansionSession?.requestId;
    if (requestId && window.electronAPI) void window.electronAPI.cancelSelectionExpansion(requestId);
    setSelectionExpansionApply(null);
    setSelectionExpansionSession(null);
  }, [selectionExpansionSession?.requestId]);

  useEffect(() => {
    if (!window.electronAPI?.onSelectionExpansionEvent) return undefined;
    return window.electronAPI.onSelectionExpansionEvent((event: SelectionExpansionEvent) => {
      setSelectionExpansionSession((current) => {
        if (!current || current.requestId !== event.requestId || current.taskSessionId !== event.sessionId || event.sequence <= current.sequence) return current;
        if (isSelectionExpansionTerminalStatus(current.status)) return current;
        const next = { ...current, sequence: event.sequence };
        if (event.type === 'started') return { ...next, status: 'planning' as const };
        if (event.type === 'status') return { ...next, status: event.phase, message: event.message, error: undefined };
        if (event.type === 'plan') return { ...next, plan: event.plan };
        if (event.type === 'evidence') return {
          ...next,
          evidence: next.evidence.some((item) => item.evidenceId === event.evidence.evidenceId) ? next.evidence : [...next.evidence, event.evidence],
        };
        if (event.type === 'complete') {
          const status = !event.result.text
            ? 'not-found'
            : event.result.qualityReceipt.validation === 'passed'
              ? 'completed'
              : 'partial';
          const qualityIssue = primarySelectionEditQualityIssue(event.result.qualityReceipt);
          return {
            ...next,
            status,
            message: status === 'completed'
              ? t("扩写建议已生成，可先审阅再使用。")
              : qualityIssue
                ? selectionEditQualityIssueLabel(qualityIssue)
                : t("已生成保守建议，请人工核对。"),
            result: event.result,
          };
        }
        if (event.type === 'cancelled') return { ...next, status: 'cancelled', message: undefined };
        if (event.type === 'stale') return { ...next, status: 'stale', error: event.message, message: undefined };
        return { ...next, status: 'error', error: event.message, message: undefined };
      });
    });
  }, []);

  const handleApplySelectionExpansion = useCallback(() => {
    const session = selectionExpansionSession;
    const result = session?.result;
    const text = result?.text.trim();
    if (!session || !result || !text) return;
    if (result.qualityReceipt.validation !== 'passed' || !result.validation.passed) {
      const qualityIssue = primarySelectionEditQualityIssue(result.qualityReceipt);
      const message = qualityIssue
        ? selectionEditQualityIssueLabel(qualityIssue)
        : result.validation.warnings[0]
        ?? result.validation.protectedAnchorLosses[0]
        ?? result.validation.unsupportedClaims[0]
        ?? t("扩写建议未通过写回验证，请复制后人工核对。");
      setSelectionExpansionSession((current) => current?.id === session.id ? { ...current, message } : current);
      return;
    }
    if (session.writeback.mode === 'copy-only') {
      setSelectionExpansionSession((current) => current?.id === session.id
        ? { ...current, message: session.writeback.message }
        : current);
      return;
    }
    setSelectionExpansionApply({
      id: `selection-expansion-apply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      snapshot: session.snapshot,
      text,
    });
  }, [selectionExpansionSession]);

  const handleSelectionExpansionApplyResult = useCallback((result: { id: string; applied: boolean; message?: string }) => {
    setSelectionExpansionApply((current) => current?.id === result.id ? null : current);
    setSelectionExpansionSession((current) => {
      if (!current) return current;
      if (result.applied) return { ...current, message: t("扩写建议已写入编辑器，正在按当前自动保存策略保存。"), error: undefined };
      return { ...current, status: 'error', error: result.message || t("扩写建议未能写入，原文没有改动。"), message: undefined };
    });
  }, []);

  const handleContentChange = useCallback((newContent: string, filePath: string) => {
    if (saveController.blocked || !saveController.snapshot || currentPathRef.current !== filePath) return;
    setContent(newContent);
    scheduleSave(filePath, newContent);
  }, [scheduleSave, saveController]);

  const handleSaveEditorImage = useCallback(async (
    notePath: string,
    source: ClipboardImageSource,
  ): Promise<SavedEditorImage> => {
    if (!window.electronAPI) throw new Error(t("桌面图片保存能力不可用。"));
    if (source.kind === 'local-path') {
      return window.electronAPI.saveEditorImage({ notePath, sourcePath: source.sourcePath });
    }
    if (source.file.size > MAX_EDITOR_IMAGE_BYTES) throw new Error(t("图片不能超过 20 MB。"));
    const bytes = new Uint8Array(await source.file.arrayBuffer());
    return window.electronAPI.saveEditorImage({ notePath, bytes });
  }, []);

  const handleSourceEditorPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>, notePath: string) => {
    if (appPreferencesRef.current.editorPasteMode === 'plain-text' && event.clipboardData.getData('text/plain')) return;
    const sources = getClipboardImageSources(event.clipboardData);
    if (sources.length === 0) return;

    event.preventDefault();
    const initialView = sourceEditorRef.current?.view;
    const initialDoc = initialView?.state.doc;
    const initialSelection = initialView?.state.selection;
    void (async () => {
      const savedImages: SavedEditorImage[] = [];
      for (const source of sources) {
        savedImages.push(await handleSaveEditorImage(notePath, source));
      }
      if (saveController.blocked || currentPathRef.current !== notePath) return;

      const view = sourceEditorRef.current?.view;
      if (!view || view !== initialView || view.state.doc !== initialDoc || !initialSelection || !view.state.selection.eq(initialSelection)) return;
      const selection = view.state.selection.main;
      const markdown = savedImages.map(formatSavedEditorImageMarkdown).join('\n\n');
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: markdown },
        selection: { anchor: selection.from + markdown.length },
        userEvent: 'input.paste',
      });
      view.focus();
    })().catch((error) => {
      window.alert(t("图片粘贴失败：{0}", { '0': error instanceof Error ? error.message : String(error) }));
    });
  }, [handleSaveEditorImage, saveController]);

  const openCreateFileModal = (parentDirectoryPath?: string | null) => {
    setCreateEntryMode('file');
    setCreateEntryParentDirectory(parentDirectoryPath ?? null);
    setIsCreateModalOpen(true);
  };

  const openCreateFolderModal = (parentDirectoryPath?: string | null) => {
    setCreateEntryMode('folder');
    setCreateEntryParentDirectory(parentDirectoryPath ?? null);
    setIsCreateModalOpen(true);
  };

  const handleCreateFile = async (fileName: string, parentDirectoryPath?: string | null) => {
    if (!window.electronAPI) return;
    const saved = await flushPendingSave();
    if (!saved) return;
    try {
      const newFilePath = await window.electronAPI.createFile(fileName, parentDirectoryPath ?? null);
      if (!newFilePath) throw new Error(t("无法创建新笔记。"));
      await loadFiles();
      await handleSelectFile(newFilePath);
    } catch (error) {
      window.alert(t("新建笔记失败：{0}", { '0': error instanceof Error ? error.message : String(error) }));
    }
  };

  const createFolderFromModal = async (folderName: string, parentDirectoryPath?: string | null) => {
    if (!window.electronAPI) return;
    if (!folderName.trim()) return;

    try {
      await window.electronAPI.createFolder(parentDirectoryPath ?? null, folderName.trim());
      await loadFiles();
    } catch (error: any) {
      alert(t("新建文件夹失败: {0}", { '0': error.message }));
    }
  };

  const _handleCreateFolder = async (parentDirectoryPath?: string | null) => {
    if (!window.electronAPI) return;
    const folderName = window.prompt(t("请输入文件夹名称"));
    if (!folderName?.trim()) return;

    try {
      await window.electronAPI.createFolder(parentDirectoryPath ?? null, folderName.trim());
      await loadFiles();
    } catch (error: any) {
      alert(t("新建文件夹失败: {0}", { '0': error.message }));
    }
  };

  const handleImportFiles = async (targetDirectoryPath?: string | null) => {
    if (!window.electronAPI) return;
    const saved = await flushPendingSave();
    if (!saved) return;

    try {
      const importedFiles = await window.electronAPI.importFiles(targetDirectoryPath ?? null);
      await loadFiles();
      if (importedFiles.length > 0) {
        await handleSelectFile(importedFiles[0].targetPath);
      }
    } catch (error: any) {
      alert(t("导入失败: {0}", { '0': error.message }));
    }
  };

  const handleOpenWikiLink = async (target: string) => {
    if (!window.electronAPI || !currentPath) return;
    const saved = await flushPendingSave();
    if (!saved) return;

    const sourcePath = currentPathRef.current;
    if (!sourcePath) return;

    const resolvedPath = await window.electronAPI.resolveWikiLink(target, sourcePath);
    if (resolvedPath) {
      await handleSelectFile(resolvedPath);
      return;
    }

    if (window.confirm(t("笔记“{0}”不存在，是否创建？", { '0': target }))) {
      const newPath = await window.electronAPI.createLinkedNote(target, sourcePath);
      if (newPath) {
        await loadFiles();
        await handleSelectFile(newPath);
      }
    }
  };

  const handleOpenRelativeMarkdownLink = async ({ path, fragment }: MarkdownRelativeLinkTarget) => {
    if (!window.electronAPI) return;
    const sourcePath = currentPathRef.current;
    if (!sourcePath) return;

    const resolvedPath = await window.electronAPI.resolveWikiLink(path, sourcePath);
    if (!resolvedPath) {
      alert(t("找不到链接笔记：{0}", { '0': path }));
      return;
    }
    await handleSelectFile(resolvedPath, undefined, undefined, fragment);
  };

  const handleSelectTag = async (tag: string) => {
    if (!window.electronAPI) return;
    const taggedFiles = await window.electronAPI.getFilesByTag(tag);
    setFiles(taggedFiles);
    setLeftPanelMode('files');
  };

  const handleJumpToHeading = (heading: HeadingEntry) => {
    setHeadingJump({ heading, nonce: Date.now() });
  };

  const handleRestoreBackup = async (backupId: string) => {
    if (!window.electronAPI || !currentPath || !backupId) return;
    if (!window.confirm(t("确定要恢复这个历史版本吗？当前内容会被覆盖。"))) return;
    await saveController.mutate(async () => {
      if (await saveController.commitMutation((request) => window.electronAPI.mutateNote({ ...request, action: 'restore', backupId }))) { setContent(saveController.content); void loadBackups(currentPath); }
    });
  };

  const handleReloadDisk = async () => {
    if (!saveController.snapshot || !window.confirm(t("重新加载会放弃当前未保存的草稿，是否继续？"))) return;
    saveController.freeze(true);
    try {
      const snapshot = await window.electronAPI.refreshNoteEditSession(saveController.snapshot.editSessionId);
      saveController.open(snapshot); setContent(snapshot.content);
    } catch (error) { saveController.indexState(String(error)); }
    finally { saveController.freeze(false); }
  };
  const handleSaveDraftCopy = async (name: string) => {
    const snapshot = saveController.snapshot;
    if (!snapshot) return;
    if (!name?.trim()) return;
    saveController.freeze(true);
    try {
      const copy = await window.electronAPI.saveNoteCopy(snapshot.editSessionId, name, saveController.content);
      await window.electronAPI.closeNoteEditSession(snapshot.editSessionId);
      setIsSaveCopyModalOpen(false); saveController.open(copy); currentPathRef.current = copy.path; setCurrentPath(copy.path); setContent(copy.content);
      await loadNoteMeta(copy.path); await loadBackups(copy.path);
    } catch (error) { saveController.indexState(String(error)); }
    finally { saveController.freeze(false); }
  };

  /** 导出点击时的编辑内容快照；HTML/PDF 共用渲染，PDF 采用便于打印的浅色样式。 */
  const handleExportNote = async (format: NoteExportFormat) => {
    if (!window.electronAPI || !currentPath || !currentIsMarkdown || exportingFormat) return;
    if (!window.electronAPI.exportNote) { window.alert(t("应用代码已更新，请重启桌面应用后再导出笔记。")); return; }
    const title = noteMeta?.title ?? currentPath.split(/[\\/]/).at(-1)?.replace(/\.(?:md|markdown)$/i, '') ?? 'note';
    setExportingFormat(format);
    try {
      let output = content;
      if (format !== 'md') {
        const { renderMarkdownExport } = await import('./utils/markdownExport');
        output = await renderMarkdownExport({ title, markdown: content, currentPath, libraryPath, resolvedTheme,
          output: format, resolveImageDataUrl: source => window.electronAPI.readMarkdownExportImage(source) });
      }
      await window.electronAPI.exportNote({ format, defaultName: title, content: output, sourcePath: currentPath });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("{0} 导出失败：{1}", { '0': format.toUpperCase(), '1': String(error) }));
    } finally {
      setExportingFormat(null);
    }
  };

  const adoptMovedNote = async (oldPath: string, newPath: string) => {
    const updated = getPathAfterEntryMove(currentPathRef.current, oldPath, newPath);
    if (updated) await handleSelectFile(updated);
    void loadFavoritePaths();
    setPinnedEntryPaths((await window.electronAPI.getLibraryUiState()).pinnedEntryPaths);
  };
  const handleRenameFile = async (oldPath: string, newName: string) => {
    if (!window.electronAPI) return false;
    try {
      return await saveController.mutate(async () => {
        const newPath = await window.electronAPI.renameEntry(oldPath, newName);
        if (newPath) await adoptMovedNote(oldPath, newPath);
        return Boolean(newPath);
      }) ?? false;
    } catch (error) { alert(t("重命名失败: {0}", { '0': String(error) })); return false; }
  };
  const handleDeleteFile = async (entryPath: string, isDirectory = false) => {
    if (!window.electronAPI || !window.confirm(isDirectory ? t("确定要删除此文件夹吗？文件夹内的所有内容都会移入回收站。") : t("确定要删除此文件吗？它将被移入回收站。"))) return;
    try {
      await saveController.mutate(async () => {
        if (await window.electronAPI.deleteEntry(entryPath)) {
          if (currentPathRef.current && isSameOrInsidePath(currentPathRef.current, entryPath)) resetCurrentNote();
          void loadFavoritePaths();
          setPinnedEntryPaths((paths) => paths.filter((path) => !isSameOrInsidePath(path, entryPath)));
        }
      });
    } catch (error) {
      window.alert(t("删除失败：{0}", { '0': error instanceof Error ? error.message : String(error) }));
    }
  };
  const handleMoveEntry = async (sourcePath: string, targetDirectoryPath: string): Promise<string | null> => {
    if (!window.electronAPI) return null;
    try {
      return await saveController.mutate(async () => {
        const newPath = await window.electronAPI.moveEntry(sourcePath, targetDirectoryPath, { type: 'inside' });
        if (newPath) await adoptMovedNote(sourcePath, newPath);
        return newPath;
      }) ?? null;
    } catch (error) { alert(t("移动失败: {0}", { '0': String(error) })); return null; }
  };

  const handleSaveTreeOrder = async (parentDirectoryPath: string, orderedChildPaths: string[]): Promise<boolean> => {
    if (!window.electronAPI) return false;
    try {
      const saved = await window.electronAPI.saveTreeOrder(parentDirectoryPath, orderedChildPaths);
      await loadFiles();
      return saved;
    } catch (error: any) {
      alert(t("保存排序失败: {0}", { '0': error.message }));
      return false;
    }
  };

  const handleSetCollapsedFolderPaths = useCallback((paths: string[]) => {
    setCollapsedFolderPaths(paths);
    void window.electronAPI.saveLibraryUiState({ collapsedFolderPaths: paths }).catch((error) => {
      console.error(t("保存目录树状态失败："), error);
    });
  }, []);

  const handleOpenRecentNote = async () => {
    if (!appPreferences.lastOpenedNote) return;
    const existsInTree = flattenFileNodes(files).some((node) => normalizePathForCompare(node.path) === normalizePathForCompare(appPreferences.lastOpenedNote!));
    if (!existsInTree) return;
    setMainView('notes');
    await handleSelectFile(appPreferences.lastOpenedNote);
  };

  const handleNavigateMainView = useCallback(async (nextView: MainView) => {
    if (nextView !== 'sources') {
      setMainView(nextView);
      if (nextView === 'libraries') await loadLibraries();
      return;
    }
    if (materialsNavigationPendingRef.current) return;

    materialsNavigationPendingRef.current = true;
    try {
      if (await flushPendingSave()) setMainView(nextView);
    } finally {
      materialsNavigationPendingRef.current = false;
    }
  }, [flushPendingSave, loadLibraries]);

  // Changing tutorial pages preserves cached editors and conversations.
  useEffect(() => {
    if (!guide.visible) return;
    if (guide.step === 'ai' && !guide.celebrate) { setSettingsSection('model'); setMainView('settings'); }
    else setMainView('home');
  }, [guide.visible, guide.step, guide.celebrate]);

  const navigateDuringGuide = async (view: MainView) => {
    if (guide.visible && guide.step === 'menus' && !guide.celebrate) { setIntroMenu(view); return; }
    if (guide.visible) await guide.pause();
    await handleNavigateMainView(view);
  };

  const editorPreferences = normalizeEditorPreferences(appPreferences);
  const focusActive = editorPreferences.editorFocusModeEnabled && mainView === 'notes' && Boolean(currentPath || externalDocuments.controller.snapshot);
  const documentStyle = {
    '--editor-zoom': editorZoom,
    '--editor-font-size': `${editorPreferences.editorFontSizePx}px`,
    '--editor-line-height': editorPreferences.editorLineHeight,
    '--editor-paragraph-spacing': `${editorPreferences.editorParagraphSpacingPx}px`,
    '--editor-content-width': editorContentWidths[editorPreferences.editorContentWidth] ? `${editorContentWidths[editorPreferences.editorContentWidth]}px` : '100%',
  } as CSSProperties;
  const focusDocument = useCallback(() => {
    const rich = document.querySelector<HTMLElement & { editor?: import('@tiptap/core').Editor }>('.notes-main-view .tiptap');
    if (rich?.editor) rich.editor.commands.focus(undefined, { scrollIntoView: false });
    else sourceEditorRef.current?.view?.focus();
  }, []);
  const saveWritingMode = (patch: Partial<AppPreferences>) => { void handleSavePreferences(patch).then(focusDocument).catch(error => window.alert(error instanceof Error ? error.message : String(error))); };
  const sourceTypewriterTarget = useCallback(() => {
    const view = sourceEditorRef.current?.view;
    if (!view || saveView.frozen) return null;
    const caret = view.coordsAtPos(view.state.selection.main.head);
    return { scroller: view.scrollDOM, content: view.contentDOM, collapsed: view.state.selection.main.empty,
      caret: caret ? getNoteViewportRect(caret, view.contentDOM) : null, requestMeasure: () => view.requestMeasure() };
  }, [saveView.frozen]);
  useTypewriterScroll({ enabled: editorPreferences.editorTypewriterModeEnabled, active: mainView === 'notes' && !externalDocuments.controller.snapshot && (editorMode === 'source' || !currentIsMarkdown) && Boolean(currentPath),
    getTarget: sourceTypewriterTarget, layoutKey: `${currentPath}:${editorMode}:${editorZoom}:${editorPreferences.editorFontSizePx}:${editorPreferences.editorLineHeight}:${editorPreferences.editorContentWidth}:${focusActive}`,
    navigationKey: `${headingJump?.nonce}:${searchScrollTarget?.nonce}`, zoom: editorZoom });
  useEffect(() => {
    const panels = document.querySelectorAll<HTMLElement>('.app-nav-rail, .notes-main-view > aside, .notes-main-view > .sidebar, .notes-main-view > .sidebar-collapsed, .notes-main-view .workspace > .knowledge-panel, .notes-main-view .workspace > .knowledge-panel-collapsed');
    panels.forEach(panel => { panel.inert = focusActive; });
    const escape = (event: KeyboardEvent) => {
      if (!focusActive || isEditorInteractionBlocked || event.key !== 'Escape' || !canHandleEditorEscape(event) || hasVisibleOverlay('[role="dialog"], .mantine-Popover-dropdown, .selection-context-menu, .selection-floating-toolbar, .code-language-popover')) return;
      consumeEditorEscape(event);
      void handleSavePreferences({ editorFocusModeEnabled: false }).then(focusDocument).catch(error => window.alert(String(error)));
    };
    window.addEventListener('keydown', escape);
    return () => { panels.forEach(panel => { panel.inert = false; }); window.removeEventListener('keydown', escape); };
  }, [focusActive, isEditorInteractionBlocked, handleSavePreferences, focusDocument]);

  return (
    <>
      {modelConnectionDialog}
      {externalDocuments.dialog}
      <WorkspaceMigrationDialog request={migrationRequest} onBlockedChange={handleMigrationBlocked} onDataChanged={handleMigratedData} />
      <div className={`app-shell${focusActive ? ' note-focus-active' : ''}`} ref={element => { if (element) element.inert = migrationBlocked; }} data-workspace-migration-blocked={migrationBlocked || undefined}>
        {isMaintaining && !migrationBlocked && <div role="status" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, padding: '8px 16px' }}>{t('正在保存并捕获数据快照，完成后即可继续编辑。')}</div>}
        {!guide.state && guide.error && <div className="onboarding-state-error" role="status">{t('使用引导暂时无法读取，可在设置中重试')}<Button size="compact-xs" variant="subtle" onClick={() => void guide.refresh().catch(() => undefined)}>{t('重试')}</Button></div>}
        <NavRail activeView={mainView} tourSelected={guide.visible && guide.step === 'menus' ? introMenu : undefined} onNavigate={(view) => void navigateDuringGuide(view)} onOpenFile={() => void externalDocuments.open()} onRecoverFiles={() => void externalDocuments.recover()} onRecentFiles={() => void externalDocuments.recent()} onPendingFiles={externalDocuments.showPendingFiles} pendingFileCount={externalDocuments.pendingFiles.length} onOpenSettings={() => {
          if (guide.visible && guide.step === 'menus') setIntroMenu('settings');
          else void (async () => { if (guide.visible) await guide.pause(); await handleOpenSettings(); })();
        }} />
        {isMainViewMounted('libraries') ? (
          <main className="main-pane" hidden={mainView !== 'libraries'}>
            <LibraryManagerView
              libraries={libraries}
              activeLibraryPath={libraryPath}
              workspacePath={workspacePath}
              workspaceError={workspaceError}
              onAddLibrary={openCreateLibraryModal}
              onOpenLibrary={handleActivateLibrary}
              onRemoveLibrary={handleRemoveLibrary}
              onUpgradeToMaterials={openUpgradeMaterialsModal}
              onReturnToNotes={() => {
                setMainView('notes');
                if (!currentPath) void handleOpenRecentNote();
              }}
            />
          </main>
        ) : null}
        {isMainViewMounted('home') ? (
          <main className="main-pane qa-main-pane" hidden={mainView !== 'home'}>
            {guide.visible && !guide.celebrate && <OnboardingBar guide={guide} />}
            {guide.visible && guide.step === 'menus' && !guide.celebrate && <OnboardingMenus guide={guide} selected={introMenu} onSelect={setIntroMenu} />}
            {guide.celebrate && <OnboardingCompletion guide={guide} onNotes={() => { guide.closeCelebration(); setMainView('notes'); }} onMaterials={() => { guide.closeCelebration(); void handleNavigateMainView('sources'); }} />}
            {!guide.visible && guide.state?.status === 'deferred' && <div className="onboarding-resume"><span>{t('引导进度已保留，准备好后可以继续。')}</span><Button size="compact-xs" variant="light" onClick={() => void guide.open()}>{t('继续引导')}</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={() => void guide.act('dismiss')}>{t('不再提醒')}</Button></div>}
            <AssistantWorkspaceView
              onboarding={guide.visible && guide.step === 'question' && !guide.celebrate ? guide : undefined}
              assistantAiOptions={assistantAiOptions}
              assistantContextRevision={assistantContextRevision}
              onRefreshAssistantAiOptions={handleRefreshAssistantAiOptions}
              onStartAssistantTurn={handleStartAssistantTurn}
              onCancelAssistantTurn={handleCancelAssistantTurn}
              onOpenSettings={() => void handleOpenSettings('model')}
              pendingQuestionDraft={graphQuestionDraft}
              onConsumeQuestionDraft={() => setGraphQuestionDraft(null)}
            />
          </main>
        ) : null}
        {isMainViewMounted('settings') ? (
          <main className={`main-pane settings-main-pane${guide.visible && guide.step === 'ai' ? ' onboarding-settings-pane' : ''}`} hidden={mainView !== 'settings'}>
            {guide.visible && guide.step === 'ai' && <OnboardingBar guide={guide} />}
            <div className={guide.visible && guide.step === 'ai' ? 'onboarding-body' : 'onboarding-settings-content'}>
            <SettingsPanel
              guidedModel={guide.visible && guide.step === 'ai'}
              onOnboardingModelDraft={setOnboardingModelDraft}
              onOpenOnboarding={() => void guide.open()}
              onAddLibrary={openCreateLibraryModal}
              initialSection={settingsSection}
              sectionRequestId={settingsSectionRequestId}
              memoryReviewRequest={memoryReviewRequest}
              preferences={appPreferences}
              resolvedTheme={resolvedTheme}
              workspacePath={workspacePath}
              workspaceError={workspaceError}
              aiConfig={aiProviderConfig}
              aiModelSettings={aiModelSettings}
              aiExtensionsSettings={aiExtensionsSettings}
              modelHub={modelHub}
              onClose={() => { if (guide.visible) void guide.pause().then(() => setMainView(settingsReturnView)); else setMainView(settingsReturnView); }}
              onSelectWorkspace={handleSelectWorkspace}
              onOpenWorkspace={handleOpenWorkspace}
              onWorkspaceDataChanged={handleWorkspaceDataChanged}
              onSavePreferences={handleSavePreferences}
              onSaveAiModelSettings={handleSaveAiModelSettings}
              onSaveAiExtensionsSettings={handleSaveAiExtensionsSettings}
              onFetchModelProviderModels={handleFetchModelProviderModels}
              onSaveModelConfiguration={handleSaveModelConfiguration}
            />
            {guide.visible && guide.step === 'ai' && <OnboardingAiTask guide={guide} draft={onboardingModelDraft} />}
            </div>
          </main>
        ) : null}
        {isMainViewMounted('sources') ? (
          <main className="main-pane" hidden={mainView !== 'sources'}>
            <MaterialsView
              onCreateLibrary={openCreateMaterialsModal}
              onUpgradeLibrary={() => openUpgradeMaterialsModal()}
              onOpenParsingSettings={() => void handleOpenSettings('parsing')}
              onOpenModelSettings={() => void handleOpenSettings('model')}
              assistantAiOptions={assistantAiOptions}
              onRefreshAssistantAiOptions={handleRefreshAssistantAiOptions}
              assistantContextRevision={assistantContextRevision}
              onStartAssistantTurn={handleStartAssistantTurn}
              onCancelAssistantTurn={handleCancelAssistantTurn}
              refreshKey={materialsRefreshKey}
            />
          </main>
        ) : null}
        {isMainViewMounted('wiki') ? (
          <main className="main-pane wiki-main-pane" hidden={mainView !== 'wiki'}>
            <WikiView
              active={mainView === 'wiki'}
              onOpenWikiDocumentInNotes={handleOpenWikiDocumentInNotes}
              resolvedTheme={resolvedTheme}
              assistantAiOptions={assistantAiOptions}
              onRefreshAssistantAiOptions={handleRefreshAssistantAiOptions}
            />
          </main>
        ) : null}
        {isMainViewMounted('graph') ? (
          <main className="main-pane graph-main-pane" hidden={mainView !== 'graph'}>
            <LibraryGraphView
              resolvedTheme={resolvedTheme}
              onAskAboutCommunity={(libraryPath, question) => {
                setGraphQuestionDraft({ libraryPath, question });
                setMainView('home');
              }}
            />
          </main>
        ) : null}
        {isMainViewMounted('notes') ? (
          <div className="notes-main-view" hidden={mainView !== 'notes'}>
            {externalDocuments.controller.snapshot && <ExternalDocumentWorkspace documents={externalDocuments} libraries={libraries} preferences={editorPreferences} theme={resolvedTheme} documentStyle={documentStyle} active={mainView === 'notes'} blocked={isMaintaining || migrationBlocked} zoom={editorZoom} onZoom={setEditorZoom} onReturnLibrary={() => void externalDocuments.prepareTransition()} />}
            {!externalDocuments.controller.snapshot && <Sidebar
              files={files}
              currentPath={currentPath}
              libraryPath={libraryPath}
              libraries={libraries}
              headings={currentHeadings}
              favoritePaths={favoritePaths}
              pinnedEntryPaths={pinnedEntryPaths}
              entryActionsDisabled={saveView.frozen}
              onDialogOpenedChange={setIsNoteLibraryDialogOpen}
              collapsedFolderPaths={collapsedFolderPaths}
              mode={leftPanelMode}
              isCollapsed={isLeftSidebarCollapsed}
              width={appPreferences.leftSidebarWidth}
              onSetMode={setLeftPanelMode}
              onToggleCollapse={() => setIsLeftSidebarCollapsed((value) => !value)}
              onWidthChange={(width) => void handleLeftSidebarWidthChange(width)}
              onSelectFile={handleSelectFile}
              onCreateFile={openCreateFileModal}
              onCreateFolder={openCreateFolderModal}
              onImportFiles={handleImportFiles}
              onActivateLibrary={(nextPath) => void handleActivateLibrary(nextPath)}
              onAddLibrary={openCreateLibraryModal}
              onOpenLibraries={() => void handleNavigateMainView('libraries')}
              onOpenSearch={() => setIsSearchOpen(true)}
              onOpenTags={async () => {
                await loadAllTags();
                setIsTagModalOpen(true);
              }}
              onRefresh={async () => { await window.electronAPI.reconcileNotes(); await loadFiles(); }}
              onRename={handleRenameFile}
              onDelete={handleDeleteFile}
              onMoveEntry={handleMoveEntry}
              onSaveTreeOrder={handleSaveTreeOrder}
              onJumpToHeading={handleJumpToHeading}
              onToggleFavorite={handleToggleFavorite}
              onTogglePinned={handleTogglePinned}
              onLoadNoteOverview={loadNoteOverview}
              onSetCollapsedFolderPaths={handleSetCollapsedFolderPaths}
            />}
            <main className="main-pane" hidden={Boolean(externalDocuments.controller.snapshot)}>
          {currentPath ? (
            <div className="workspace">
              <div className="editor-pane note-document-surface" style={documentStyle}>
                <div className="editor-mode-bar">
                  <div className="segmented-control">
                    <button
                      className={editorMode === 'wysiwyg' ? 'active' : ''}
                      disabled={!currentIsMarkdown}
                      onClick={() => setEditorMode('wysiwyg')}
                    >
                      {t("编辑")}
                    </button>
                    <button
                      className={editorMode === 'preview' ? 'active' : ''}
                      disabled={!currentIsMarkdown}
                      onClick={() => setEditorMode('preview')}
                    >
                      {t("预览")}
                    </button>
                    <button className={editorMode === 'source' ? 'active' : ''} onClick={() => setEditorMode('source')}>
                      {t("源码")}
                    </button>
                  </div>
                  <select className="mode-action editor-export-select" aria-label={t("导出笔记")} value="" disabled={!currentIsMarkdown || Boolean(exportingFormat)} onChange={(event) => { if (event.target.value) void handleExportNote(event.target.value as NoteExportFormat); }}>
                    <option value="">{exportingFormat ? t("正在导出 {0}…", { '0': exportingFormat.toUpperCase() }) : t("导出笔记")}</option>
                    <option value="md">{t("导出 Markdown (.md)")}</option>
                    <option value="html">{t("导出 HTML (.html)")}</option>
                    <option value="pdf">{t("导出 PDF (.pdf)")}</option>
                  </select>
                  <select className="mode-select" value="" onChange={(event) => handleRestoreBackup(event.target.value)}>
                    <option value="">{t("恢复备份")}</option>
                    {backups.map((backup) => (
                      <option key={backup.id} value={backup.id}>{backup.id}</option>
                    ))}
                  </select>
                  <EditorWordCount content={content} isMarkdown={currentIsMarkdown} />
                  <div className="note-save-notice" role="status" aria-live="polite" data-status={saveView.status}>
                    {saveView.status === 'clean' && saveView.indexState === 'pending' ? t("已保存，正在更新索引…") : ({ clean: t("已保存"), dirty: t("尚未保存"), saving: t("正在保存…"), conflict: t("保存冲突"), error: t("保存失败") })[saveView.status]}
                  </div>
                  <EditorZoomControl value={editorZoom} defaultValue={editorPreferences.defaultEditorZoom} onChange={setEditorZoom} />
                  <button className="editor-writing-toggle" aria-pressed={focusActive} onClick={() => saveWritingMode({ editorFocusModeEnabled: !editorPreferences.editorFocusModeEnabled })}>{t(focusActive ? '退出专注' : '进入专注')}</button>
                  <button className="editor-writing-toggle" aria-pressed={editorPreferences.editorTypewriterModeEnabled} onClick={() => saveWritingMode({ editorTypewriterModeEnabled: !editorPreferences.editorTypewriterModeEnabled })}>{t('打字机模式')}</button>
                  {focusActive && <button className="editor-writing-toggle" onClick={() => void handleOpenSettings('editor')}>{t('编辑器设置')}</button>}
                </div>
                {(saveView.message || saveView.status === 'conflict' || saveView.status === 'error') && <div className="note-save-details" role="status" aria-live="polite">
                  {saveView.message && <span>{saveView.message}</span>}
                  {saveView.status === 'error' && <button disabled={saveView.frozen} onClick={() => void saveController.flush()}>{t("重试保存")}</button>}
                  {saveView.status === 'conflict' && <button disabled={saveView.frozen} onClick={() => void handleReloadDisk()}>{t("重新加载磁盘版本")}</button>}
                  {(saveView.status === 'conflict' || saveView.status === 'error') && <button disabled={saveView.frozen} onClick={() => setIsSaveCopyModalOpen(true)}>{t("另存为新笔记")}</button>}
                  {saveView.status === 'clean' && saveView.message && <button onClick={() => { if (saveController.snapshot) void window.electronAPI.retryNoteIndex(saveController.snapshot.editSessionId).then(() => saveController.indexState()).catch((error) => saveController.indexState(String(error))); }}>{t("重试索引")}</button>}
                </div>}
                {editorMode === 'wysiwyg' && currentIsMarkdown && (
                  <Editor
                    key={currentPath}
                    content={content}
                    preferences={editorPreferences}
                    active={mainView === 'notes' && !externalDocuments.controller.snapshot}
                    currentPath={currentPath}
                    libraryPath={libraryPath}
                    zoom={editorZoom}
                    isInteractionBlocked={isEditorInteractionBlocked || saveView.frozen}
                    readOnly={saveView.frozen || !saveController.snapshot}
                    showLineNumbers={isCurrentNoteAssistantOpen && !focusActive}
                    highlightTerm={currentSearchTerm}
                    headingJump={headingJump}
                    scrollTarget={searchScrollTarget}
                    onChange={(value) => handleContentChange(value, currentPath)}
                    onOutlineChange={setCurrentHeadings}
                    onOpenWikiLink={handleOpenWikiLink}
                    onSaveImage={(source) => handleSaveEditorImage(currentPath, source)}
                    onOpenSelectionExpansion={(snapshot) => void handleOpenSelectionExpansion(snapshot)}
                    onPrepareSelectionEditSource={handlePrepareSelectionEditSource}
                    selectionExpansionApply={selectionExpansionApply}
                    onSelectionExpansionApplyResult={handleSelectionExpansionApplyResult}
                  />
                )}
                {editorMode === 'preview' && currentIsMarkdown && (
                  <MarkdownPreview
                    key={currentPath}
                    content={content}
                    currentPath={currentPath}
                    libraryPath={libraryPath}
                    zoom={editorZoom}
                    headingJump={headingJump}
                    highlightTerm={currentSearchTerm}
                    scrollTarget={searchScrollTarget}
                    resolvedTheme={resolvedTheme}
                    showCodeCopyActions
                    onOpenWikiLink={handleOpenWikiLink}
                    onOpenRelativeMarkdownLink={handleOpenRelativeMarkdownLink}
                    onOutlineChange={setCurrentHeadings}
                  />
                )}
                {(editorMode === 'source' || !currentIsMarkdown) && (
                  <div className="source-editor-zoom" style={{ zoom: editorZoom }}>
                    <CodeMirror
                      ref={sourceEditorRef}
                      key={currentPath}
                      className="source-editor"
                      value={content}
                      editable={!saveView.frozen && Boolean(saveController.snapshot) && !externalDocuments.controller.snapshot}
                      height="100%"
                      extensions={codeMirrorExtensions}
                      theme={resolvedTheme}
                      onPaste={(event) => {
                        if (currentIsMarkdown) handleSourceEditorPaste(event, currentPath);
                      }}
                      onChange={(value) => handleContentChange(value, currentPath)}
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: true,
                        highlightActiveLine: true,
                      }}
                    />
                  </div>
                )}
              </div>
              <KnowledgePanel
                libraryPath={libraryPath}
                noteMeta={noteMeta}
                noteAnalysis={noteAnalysis}
                noteAnalysisRun={noteAnalysisRun}
                aiStatus={aiStatus}
                isAnalyzingNote={isAnalyzingNote}
                allTags={allTags}
                isCollapsed={isRightPanelCollapsed}
                width={appPreferences.rightPanelWidth}
                onToggleCollapse={() => setIsRightPanelCollapsed((value) => !value)}
                onWidthChange={(width) => void handleRightPanelWidthChange(width)}
                onSelectTag={handleSelectTag}
                onGenerateNoteAnalysis={handleGenerateNoteAnalysis}
                onCancelNoteAnalysis={handleCancelNoteAnalysis}
                onResumeNoteAnalysis={handleResumeNoteAnalysis}
                onAddNoteTag={(tag) => handleApplySuggestedTags([tag], false)}
                onApplySuggestedTags={handleApplySuggestedTags}
                assistantAiOptions={assistantAiOptions}
                onRefreshAssistantAiOptions={handleRefreshAssistantAiOptions}
                assistantContextRevision={assistantContextRevision}
                onStartAssistantTurn={handleStartAssistantTurn}
                onCancelAssistantTurn={handleCancelAssistantTurn}
                onNavigateAssistantCitation={handleNavigateAssistantCitation}
                onAssistantVisibilityChange={setIsCurrentNoteAssistantOpen}
                selectionExpansionSession={selectionExpansionSession}
                onSelectionExpansionSettingsChange={handleSelectionExpansionSettingsChange}
                onSaveSelectionExpansionDefaults={handleSaveSelectionExpansionDefaults}
                onStartSelectionExpansion={handleStartSelectionExpansion}
                onCancelSelectionExpansion={handleCancelSelectionExpansion}
                onApplySelectionExpansion={handleApplySelectionExpansion}
                onCloseSelectionExpansion={handleCloseSelectionExpansion}
              />
            </div>
          ) : (
            <div className="workspace">
              <div className="empty-editor" style={{ flex: 1 }}>{t("选择笔记开始写作")}</div>
              <KnowledgePanel
                libraryPath={libraryPath}
                noteMeta={null}
                noteAnalysis={null}
                aiStatus={aiStatus}
                isAnalyzingNote={false}
                allTags={allTags}
                isCollapsed={isRightPanelCollapsed}
                width={appPreferences.rightPanelWidth}
                onToggleCollapse={() => setIsRightPanelCollapsed((value) => !value)}
                onWidthChange={(width) => void handleRightPanelWidthChange(width)}
                onSelectTag={handleSelectTag}
                onGenerateNoteAnalysis={handleGenerateNoteAnalysis}
                onAddNoteTag={(tag) => handleApplySuggestedTags([tag], false)}
                onApplySuggestedTags={handleApplySuggestedTags}
                assistantAiOptions={assistantAiOptions}
                onRefreshAssistantAiOptions={handleRefreshAssistantAiOptions}
                assistantContextRevision={assistantContextRevision}
                onStartAssistantTurn={handleStartAssistantTurn}
                onCancelAssistantTurn={handleCancelAssistantTurn}
                onNavigateAssistantCitation={handleNavigateAssistantCitation}
                onAssistantVisibilityChange={setIsCurrentNoteAssistantOpen}
              />
            </div>
          )}
            </main>
          </div>
        ) : null}
      </div>
      {themeFeedback ? <div className="theme-toast" role="status">{themeFeedback}</div> : null}
      <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectFile={handleSelectFile}
      />
      <CreateFileModal isOpen={isSaveCopyModalOpen} title={t("另存为新笔记")} defaultName={t("草稿副本")} confirmText={t("保存副本")} onClose={() => setIsSaveCopyModalOpen(false)} onConfirm={(name) => void handleSaveDraftCopy(name)} />
      <CreateFileModal
        isOpen={isCreateModalOpen}
        title={createEntryMode === 'folder' ? t("新建文件夹") : t("新建笔记")}
        label={createEntryMode === 'folder' ? t("文件夹名称") : t("笔记名称")}
        defaultName={createEntryMode === 'folder' ? t("新建文件夹") : t("未命名")}
        confirmText={t("创建")}
        onClose={() => {
          setIsCreateModalOpen(false);
          setCreateEntryParentDirectory(null);
        }}
        onConfirm={async (fileName) => {
          if (createEntryMode === 'folder') {
            await createFolderFromModal(fileName, createEntryParentDirectory);
          } else {
            await handleCreateFile(fileName, createEntryParentDirectory);
          }
          setCreateEntryParentDirectory(null);
        }}
      />
      <TagModal
        isOpen={isTagModalOpen}
        tags={allTags}
        onClose={() => setIsTagModalOpen(false)}
        onSelectFile={handleSelectFile}
      />
      <CreateLibraryModal
        opened={isCreateLibraryModalOpen}
        workspacePath={workspacePath}
        onClose={() => setIsCreateLibraryModalOpen(false)}
        onSelectDirectory={() => window.electronAPI.selectDirectory()}
        onCreate={handleCreateLibrary}
      />
      <CreateMaterialsLibraryModal
        opened={materialsModal.opened}
        mode={materialsModal.mode}
        workspacePath={workspacePath}
        noteLibraries={libraries}
        initialUpgradePath={materialsModal.upgradePath}
        onClose={() => setMaterialsModal((previous) => ({ ...previous, opened: false }))}
        onModeChange={(mode) => setMaterialsModal((previous) => ({ ...previous, mode, upgradePath: mode === 'upgrade' ? previous.upgradePath : null }))}
        onCreate={handleCreateMaterialsLibrary}
        onUpgrade={handleUpgradeLibraryToMaterials}
      />
    </>
  );
}

function normalizePathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function flattenFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => node.isDirectory ? flattenFileNodes(node.children ?? []) : [node]);
}

function isSameOrInsidePath(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizePathForCompare(candidatePath);
  const parent = normalizePathForCompare(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function getPathAfterEntryMove(currentPath: string | null, oldPath: string, newPath: string): string | null {
  if (!currentPath) return null;
  if (!isSameOrInsidePath(currentPath, oldPath)) return null;

  const normalizedCurrent = currentPath.replace(/\\/g, '/');
  const normalizedOld = oldPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const suffix = normalizedCurrent.slice(normalizedOld.length);
  return `${newPath}${suffix.replace(/\//g, '\\')}`;
}

export default App;
