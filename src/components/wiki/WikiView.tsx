import { t, useI18n } from '../../i18n';
import { Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantAiOptions, AssistantAttachment, MaterialsLibrarySummary, WikiAiMemory } from '../../electron';
import { copyPlainText } from '../../utils/clipboard';
import type { ResolvedTheme } from '../../utils/theme';
import { relocateWorkspacePath, type WorkspaceDataChange } from '../../utils/workspaceDataEvents';
import {
  listWikiKnowledgeBases,
  listWikiLibraryDocuments,
  loadWikiWorkspace,
  isWikiSiblingOrderConflict,
  reorderElectronWikiSiblingNodes,
  type WikiLibraryDocument,
} from '../../wiki/wikiElectronDataSource';
import { createMockWikiDataSource } from '../../wiki/wikiMockDataSource';
import { ElectronWikiDataSource } from '../../wiki/wikiElectronAgentDataSource';
import type { WikiActionKind, WikiBuildMode, WikiDataSource, WikiEvent, WikiMapInteractionMode, WikiMapNode, WikiNodeAiRequestOptions, WikiWorkspaceSnapshot } from '../../wiki/wikiTypes';
import {
  createEmptyNodeAiState,
  collectWikiSiblingOrderChanges,
  getWikiNodePath,
  reduceWikiEvent,
  reorderWikiSiblings,
  replaceWikiNodeAiState,
  updateWikiNode,
} from '../../wiki/wikiViewState';
import WikiDetailPane, { type WikiDetailTab } from './WikiDetailPane';
import WikiDocumentListPane from './WikiDocumentListPane';
import WikiEmptyState from './WikiEmptyState';
import WikiMapCanvas from './WikiMapCanvas';
import WikiNodeActionModal, { type WikiNodeAction } from './WikiNodeActionModal';
import WikiNodeContextMenu from './WikiNodeContextMenu';
import WikiOutlinePane from './WikiOutlinePane';
import WikiOpenInNotesModal, { type WikiNoteSource } from './WikiOpenInNotesModal';
import WikiSplitPane from './WikiSplitPane';
import WikiStartModal from './WikiStartModal';
import WikiToolbar from './WikiToolbar';

interface WikiViewProps {
  active: boolean;
  resolvedTheme: ResolvedTheme;
  assistantAiOptions: AssistantAiOptions;
  onRefreshAssistantAiOptions: () => Promise<AssistantAiOptions>;
  onOpenWikiDocumentInNotes: (source: WikiNoteSource, targetLibraryPath: string) => Promise<void>;
}

interface ContextMenuState {
  nodeId: string;
  position: { x: number; y: number };
}

export default function WikiView({ active, resolvedTheme, assistantAiOptions, onRefreshAssistantAiOptions, onOpenWikiDocumentInNotes }: WikiViewProps) {
  useI18n();
  const [libraries, setLibraries] = useState<MaterialsLibrarySummary[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [documents, setDocuments] = useState<WikiLibraryDocument[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WikiWorkspaceSnapshot | null>(null);
  const [aiMemories, setAiMemories] = useState<WikiAiMemory[]>([]);
  const [sidebarMode, setSidebarMode] = useState<'documents' | 'outline'>('documents');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WikiDetailTab>('document');
  const [searchQuery, setSearchQuery] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [modeModalOpen, setModeModalOpen] = useState(false);
  const [loadingLibraries, setLoadingLibraries] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [mapInteractionMode, setMapInteractionMode] = useState<WikiMapInteractionMode>('browse');
  const [reorderDirty, setReorderDirty] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; revision: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [nodeAction, setNodeAction] = useState<WikiNodeAction | null>(null);
  const [nodeActionId, setNodeActionId] = useState<string | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1400);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [noteSource, setNoteSource] = useState<WikiNoteSource | null>(null);
  const viewportCompact = useMediaQuery('(max-width: 1159px)');
  const viewportOverlay = useMediaQuery('(max-width: 895px)');
  const askedDocumentsRef = useRef(new Set<string>());
  const questionsRequestRef = useRef(new Set<string>());
  const loadRevisionRef = useRef(0);
  const libraryRevisionRef = useRef(0);
  const librariesLoadRevisionRef = useRef(0);
  const refreshedLibraryPathRef = useRef<{ path: string | null } | null>(null);
  const [migratedDataSource, setMigratedDataSource] = useState<{ path: string; dataSource: WikiDataSource } | null>(null);
  const activeWikiDocumentIdRef = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const reorderBaselineRef = useRef<{
    documentId: string;
    nodes: WikiMapNode[];
    siblingOrderRevisions: Record<string, string>;
  } | null>(null);

  const selectedLibrary = useMemo(
    () => libraries.find((library) => library.path === libraryPath) ?? null,
    [libraries, libraryPath],
  );

  // 数据源按环境选择（方案 §1 目标 4）：存在 window.electronAPI 时走 Electron 真实数据源，浏览器开发态保留 Mock。
  const dataSource = useMemo<WikiDataSource>(
    () => migratedDataSource?.path === libraryPath ? migratedDataSource.dataSource
      : (libraryPath && window.electronAPI ? new ElectronWikiDataSource(libraryPath) : createMockWikiDataSource()),
    [libraryPath, migratedDataSource],
  );

  useEffect(() => { if (snapshot) dataSource.attachWorkspace(snapshot); }, [dataSource, snapshot]);

  const resetWorkspace = useCallback(() => {
    setDocuments([]); setDocumentId(null); activeWikiDocumentIdRef.current = null;
    setSnapshot(null); setAiMemories([]); setSelectedNodeId(null); setSidebarMode('documents');
    setNoteSource(null); setSearchQuery(''); setMapInteractionMode('browse');
    setReorderDirty(false); setReorderSaving(false); reorderBaselineRef.current = null;
    setLoadingDocumentId(null); setContextMenu(null); setNodeAction(null); setNodeActionId(null); setModeModalOpen(false);
    questionsRequestRef.current.clear(); askedDocumentsRef.current.clear();
  }, []);

  useEffect(() => {
    void onRefreshAssistantAiOptions().catch(() => undefined);
  }, [onRefreshAssistantAiOptions]);

  const refreshDocuments = useCallback(async (targetLibraryPath = libraryPath) => {
    if (!targetLibraryPath) return;
    const revision = libraryRevisionRef.current;
    setLoadingDocuments(true);
    try {
      const nextDocuments = await listWikiLibraryDocuments(targetLibraryPath);
      if (targetLibraryPath !== libraryPath || revision !== libraryRevisionRef.current) return;
      setDocuments(nextDocuments);
    } catch (loadError) {
      if (targetLibraryPath === libraryPath && revision === libraryRevisionRef.current) setError(toMessage(loadError));
    } finally {
      if (targetLibraryPath === libraryPath && revision === libraryRevisionRef.current) setLoadingDocuments(false);
    }
  }, [libraryPath]);

  const loadDocument = useCallback(async (document: WikiLibraryDocument) => {
    if (reorderSaving) {
      setFeedback(t("正在保存章节顺序，请稍候"));
      return;
    }
    if (!selectedLibrary || document.outlineState !== 'ready') return;
    const revision = ++loadRevisionRef.current;
    setLoadingDocumentId(document.id);
    setError(null);
    setDocumentId(document.id);
    activeWikiDocumentIdRef.current = document.id;
    setAiMemories([]);
    setSelectedNodeId(null);
    setContextMenu(null);
    setMapInteractionMode('browse');
    setReorderDirty(false);
    setReorderSaving(false);
    reorderBaselineRef.current = null;
    questionsRequestRef.current.clear();
    try {
      const nextSnapshot = await loadWikiWorkspace(selectedLibrary, document);
      if (revision !== loadRevisionRef.current) return;
      dataSource.attachWorkspace(nextSnapshot);
      setSnapshot(nextSnapshot);
      void dataSource.listAiMemories(nextSnapshot.document.id)
        .then((memories) => {
          if (revision === loadRevisionRef.current && activeWikiDocumentIdRef.current === nextSnapshot.document.id) {
            setAiMemories(memories);
          }
        })
        .catch(() => undefined);
      setSidebarMode('outline');
      setOutlineOpen(true);
      setSearchQuery('');
      setModeModalOpen(false);
    } catch (loadError) {
      if (revision !== loadRevisionRef.current) return;
      setSnapshot(null);
      setSidebarMode('documents');
      setError(toMessage(loadError));
    } finally {
      if (revision === loadRevisionRef.current) setLoadingDocumentId(null);
    }
  }, [dataSource, reorderSaving, selectedLibrary]);

  const loadLibraries = useCallback(async () => {
    const revision = ++librariesLoadRevisionRef.current;
    setLoadingLibraries(true);
    setError(null);
    try {
      const nextLibraries = await listWikiKnowledgeBases();
      if (revision !== librariesLoadRevisionRef.current) return;
      setLibraries(nextLibraries);
      setLibraryPath((current) => {
        if (current && nextLibraries.some((library) => library.path === current)) return current;
        return nextLibraries.find((library) => library.isActive)?.path ?? nextLibraries[0]?.path ?? null;
      });
    } catch (loadError) {
      if (revision === librariesLoadRevisionRef.current) setError(toMessage(loadError));
    } finally {
      if (revision === librariesLoadRevisionRef.current) setLoadingLibraries(false);
    }
  }, []);

  const handleLibraryChange = useCallback((nextLibraryPath: string) => {
    if (nextLibraryPath === libraryPath) return;
    // 切换知识库时优先展示其文档列表；窄屏下会打开对应的 Drawer。
    setOutlineOpen(true);
    setMigratedDataSource(null);
    setLibraryPath(nextLibraryPath);
  }, [libraryPath]);

  useEffect(() => { void loadLibraries(); }, [loadLibraries]);

  useEffect(() => {
    const changed = (event: Event) => {
      const { source, target, waitUntil } = (event as CustomEvent<WorkspaceDataChange>).detail;
      const revision = ++librariesLoadRevisionRef.current;
      libraryRevisionRef.current += 1;
      loadRevisionRef.current += 1;
      setLoadingLibraries(true); setLoadingDocuments(true); setError(null);
      const refresh = (async () => {
        const nextLibraries = await listWikiKnowledgeBases();
        const relocated = relocateWorkspacePath(libraryPath, source, target);
        const nextPath = nextLibraries.find(library => library.path === relocated)?.path
          ?? nextLibraries.find(library => library.isActive)?.path ?? nextLibraries[0]?.path ?? null;
        const nextDocuments = nextPath ? await listWikiLibraryDocuments(nextPath) : [];
        if (revision !== librariesLoadRevisionRef.current) return;
        if (nextPath !== libraryPath) refreshedLibraryPathRef.current = { path: nextPath };
        const preserveDocument = source && target && nextPath === relocated
          && (!documentId || nextDocuments.some(document => document.id === documentId));
        if (preserveDocument) {
          if (nextPath && dataSource instanceof ElectronWikiDataSource) {
            dataSource.relocateLibrary(nextPath);
            setMigratedDataSource({ path: nextPath, dataSource });
          }
          // The copied workspace keeps IDs and unsaved order changes; only local file references move.
          const relocateNode = (node: WikiMapNode): WikiMapNode => ({ ...node, sourceRef: {
            ...node.sourceRef, sourcePath: relocateWorkspacePath(node.sourceRef.sourcePath ?? null, source, target) ?? undefined,
          } });
          setSnapshot(current => current ? { ...current, nodes: current.nodes.map(relocateNode) } : null);
          if (reorderBaselineRef.current) reorderBaselineRef.current.nodes = reorderBaselineRef.current.nodes.map(relocateNode);
          setNoteSource(current => current ? { ...current, libraryPath: relocateWorkspacePath(current.libraryPath, source, target) ?? current.libraryPath } : null);
          setLoadingDocumentId(null);
        } else { setMigratedDataSource(null); resetWorkspace(); }
        setLibraries(nextLibraries); setLibraryPath(nextPath); setDocuments(nextDocuments);
      })().catch((failure: unknown) => {
        if (revision === librariesLoadRevisionRef.current) setError(toMessage(failure));
        throw failure;
      }).finally(() => {
        if (revision === librariesLoadRevisionRef.current) { setLoadingLibraries(false); setLoadingDocuments(false); }
      });
      waitUntil(refresh);
    };
    window.addEventListener('workspace-data-changed', changed);
    return () => window.removeEventListener('workspace-data-changed', changed);
  }, [dataSource, documentId, libraryPath, resetWorkspace]);

  useEffect(() => {
    const revision = ++libraryRevisionRef.current;
    loadRevisionRef.current += 1;
    if (refreshedLibraryPathRef.current?.path === libraryPath) { refreshedLibraryPathRef.current = null; return; }
    resetWorkspace();
    setError(null);
    if (!libraryPath) {
      setLoadingDocuments(false);
      return;
    }
    setLibraries((current) => current.map((library) => ({ ...library, isActive: library.path === libraryPath })));
    setLoadingDocuments(true);
    void window.electronAPI.openMaterialsLibrary(libraryPath)
      .then(() => listWikiLibraryDocuments(libraryPath))
      .then((nextDocuments) => {
        if (revision === libraryRevisionRef.current) setDocuments(nextDocuments);
      })
      .catch((loadError) => {
        if (revision === libraryRevisionRef.current) setError(toMessage(loadError));
      })
      .finally(() => {
        if (revision === libraryRevisionRef.current) setLoadingDocuments(false);
      });
  }, [libraryPath, resetWorkspace]);

  useEffect(() => {
    if (!libraryPath || !window.electronAPI?.onPipelineStatus) return;
    let timer: number | undefined;
    const unsubscribe = window.electronAPI.onPipelineStatus((status) => {
      if (status.libraryPath !== libraryPath) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void refreshDocuments(libraryPath); }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [libraryPath, refreshDocuments]);

  useEffect(() => {
    if (!active) return;
    const element = workspaceRef.current;
    if (!element) return;
    const updateWidth = (width = element.getBoundingClientRect().width) => {
      // 菜单切换会隐藏已挂载的页面，零宽度不能作为窄屏布局依据。
      if (width <= 0) return;
      setWorkspaceWidth(width);
    };
    updateWidth();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(([entry]) => entry && updateWidth(entry.contentRect.width));
    const handleWindowResize = () => updateWidth();
    observer?.observe(element);
    window.addEventListener('resize', handleWindowResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [active]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      document.getElementById('wiki-node-search')?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [selectedNodeId, snapshot?.nodes],
  );
  const contextNode = useMemo(
    () => snapshot?.nodes.find((node) => node.id === contextMenu?.nodeId) ?? null,
    [contextMenu?.nodeId, snapshot?.nodes],
  );
  const actionNode = useMemo(
    () => snapshot?.nodes.find((node) => node.id === nodeActionId) ?? null,
    [nodeActionId, snapshot?.nodes],
  );
  const selectedPath = useMemo(
    () => selectedNode && snapshot ? getWikiNodePath(snapshot.nodes, selectedNode.id).map((node) => node.title).join(' / ') : '',
    [selectedNode, snapshot],
  );
  const activeNodeOperation = useMemo(
    () => snapshot ? Object.values(snapshot.nodeAi).find((state) => state.status === 'running') ?? null : null,
    [snapshot],
  );
  const generationRunning = snapshot?.generationJob?.status === 'running';
  const operationBusy = Boolean(generationRunning || activeNodeOperation);
  const hasDocument = Boolean(snapshot);
  const compactOutline = viewportCompact || workspaceWidth < 1104;
  const overlayDetail = viewportOverlay || workspaceWidth - (!compactOutline && outlineOpen ? 264 : 0) < 840;

  useEffect(() => {
    if (!active) return;
    // 尚未打开文档时，进入 Wiki 或切换知识库都优先展示可选文档。
    if (!hasDocument) {
      setSidebarMode('documents');
      setOutlineOpen(true);
    } else if (compactOutline) {
      setOutlineOpen(false);
    }
  }, [active, compactOutline, hasDocument, libraryPath]);

  const consumeEvents = useCallback(async (source: AsyncIterable<WikiEvent>, targetDocumentId: string) => {
    try {
      for await (const event of source) {
        setSnapshot((current) => current?.document.id === targetDocumentId ? reduceWikiEvent(current, event) : current);
      }
      const memories = await dataSource.listAiMemories(targetDocumentId);
      if (activeWikiDocumentIdRef.current === targetDocumentId) setAiMemories(memories);
    } catch (streamError) {
      setFeedback(streamError instanceof Error ? streamError.message : String(streamError));
    }
  }, [dataSource]);

  const startFullGeneration = useCallback((targetDocumentId = documentId) => {
    if (!targetDocumentId || operationBusy) return;
    void consumeEvents(dataSource.startFullGeneration(targetDocumentId), targetDocumentId);
  }, [consumeEvents, dataSource, documentId, operationBusy]);

  const handleStartMode = async (mode: WikiBuildMode) => {
    if (!snapshot) return;
    askedDocumentsRef.current.add(snapshot.document.id);
    await dataSource.setMode(snapshot.document.id, mode);
    setSnapshot((current) => current ? { ...current, mode } : current);
    setModeModalOpen(false);
    if (mode === 'auto') startFullGeneration(snapshot.document.id);
  };

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setContextMenu(null);
  };

  const handleNavigateEvidenceNode = (nodeId: string) => {
    if (!snapshot?.nodes.some((node) => node.id === nodeId)) {
      setFeedback(t("来源章节已随文档更新，请刷新 Wiki 后重试"));
      return;
    }
    setSelectedNodeId(nodeId);
    setActiveTab('document');
    setContextMenu(null);
  };

  const handleToggleCollapsed = (nodeId: string) => {
    setSnapshot((current) => current ? updateWikiNode(current, nodeId, {
      collapsed: !current.nodes.find((node) => node.id === nodeId)?.collapsed,
    }) : current);
  };

  const handleCommitReorder = async () => {
    if (!snapshot || mapInteractionMode !== 'reorder' || reorderSaving) return;
    const baseline = reorderBaselineRef.current;
    if (!baseline || baseline.documentId !== snapshot.document.id) return;
    const changes = collectWikiSiblingOrderChanges(baseline.nodes, snapshot.nodes);
    if (changes.length === 0) {
      setMapInteractionMode('browse');
      reorderBaselineRef.current = null;
      setReorderDirty(false);
      setFeedback(t("未调整章节顺序"));
      return;
    }

    const activeLibrary = selectedLibrary;
    const activeDocument = documents.find((document) => document.id === snapshot.document.id) ?? null;
    const loadRevision = loadRevisionRef.current;
    setReorderSaving(true);
    setFeedback(t("正在保存 {0} 个章节分支的顺序…", { '0': changes.length }));
    const outcomes = await Promise.all(changes.map(async (change) => {
      try {
        const expectedRevision = baseline.siblingOrderRevisions[change.parentId];
        if (!expectedRevision) throw new Error(t("缺少当前章节分支的顺序修订号，请重新加载后再试。"));
        let commit;
        if (snapshot.orderPersistence === 'local') {
          if (!activeLibrary) throw new Error(t("当前知识库不可用，请重新选择后再试。"));
          commit = await reorderElectronWikiSiblingNodes(
            activeLibrary.path,
            snapshot.document.id,
            change.parentId,
            change.orderedNodeIds,
            expectedRevision,
          );
        } else {
          commit = await dataSource.reorderSiblingNodes(
            snapshot.document.id,
            change.parentId,
            change.orderedNodeIds,
            expectedRevision,
          );
        }
        return { change, commit, error: null as unknown };
      } catch (commitError) {
        return { change, commit: null, error: commitError };
      }
    }));

    if (loadRevision !== loadRevisionRef.current) return;
    setReorderSaving(false);
    const failures = outcomes.filter((outcome) => outcome.error !== null);
    if (failures.some((outcome) => isWikiSiblingOrderConflict(outcome.error))) {
      if (activeLibrary && activeDocument) {
        try {
          const reloaded = await loadWikiWorkspace(activeLibrary, activeDocument);
          if (loadRevision !== loadRevisionRef.current) return;
          dataSource.attachWorkspace(reloaded);
          setSnapshot(reloaded);
          reorderBaselineRef.current = {
            documentId: reloaded.document.id,
            nodes: reloaded.nodes.map((node) => ({ ...node })),
            siblingOrderRevisions: { ...reloaded.siblingOrderRevisions },
          };
          setLayoutRevision((revision) => revision + 1);
          setReorderDirty(false);
          setFeedback(t("章节结构或顺序已变化，已重新加载最新目录，请再次调整"));
          return;
        } catch (reloadError) {
          setError(toMessage(reloadError));
        }
      }
    }

    const successfulRevisions = Object.fromEntries(outcomes.flatMap((outcome) => (
      outcome.commit ? [[outcome.change.parentId, outcome.commit.revision]] : []
    )));
    let nextNodes = snapshot.nodes;
    failures.forEach(({ change }) => {
      nextNodes = reorderWikiSiblings(nextNodes, change.parentId, change.previousOrderedNodeIds);
    });
    const nextSnapshot = {
      ...snapshot,
      nodes: nextNodes,
      siblingOrderRevisions: { ...snapshot.siblingOrderRevisions, ...successfulRevisions },
    };
    dataSource.attachWorkspace(nextSnapshot);
    setSnapshot(nextSnapshot);
    setLayoutRevision((revision) => revision + 1);
    setReorderDirty(false);

    if (failures.length === 0) {
      reorderBaselineRef.current = null;
      setMapInteractionMode('browse');
      setFeedback(snapshot.orderPersistence === 'local'
        ? t("章节顺序已保存到当前知识库")
        : t("章节顺序已应用到当前会话（Mock 不持久化）"));
      return;
    }

    reorderBaselineRef.current = {
      documentId: nextSnapshot.document.id,
      nodes: nextSnapshot.nodes.map((node) => ({ ...node })),
      siblingOrderRevisions: { ...nextSnapshot.siblingOrderRevisions },
    };
    const firstFailure = failures[0]?.error;
    setFeedback(t("{0} 未保存的分支已恢复原顺序。", { '0': toMessage(firstFailure) }));
  };

  const handleCancelReorder = () => {
    if (reorderSaving) {
      setFeedback(t("正在保存章节顺序，请稍候"));
      return;
    }
    const baseline = reorderBaselineRef.current;
    if (baseline && snapshot?.document.id === baseline.documentId) {
      const restoredSnapshot = {
        ...snapshot,
        nodes: baseline.nodes.map((node) => ({ ...node })),
        siblingOrderRevisions: { ...baseline.siblingOrderRevisions },
      };
      dataSource.attachWorkspace(restoredSnapshot);
      setSnapshot(restoredSnapshot);
      setLayoutRevision((revision) => revision + 1);
    }
    reorderBaselineRef.current = null;
    setMapInteractionMode('browse');
    setReorderDirty(false);
    setFeedback(t("已取消调整并恢复原顺序"));
  };

  const handleMapInteractionModeChange = (nextMode: WikiMapInteractionMode) => {
    if (!snapshot || reorderSaving || nextMode === mapInteractionMode) return;
    if (nextMode === 'browse') {
      void handleCommitReorder();
      return;
    }
    if (operationBusy) {
      setFeedback(t("当前任务完成后再调整章节顺序"));
      return;
    }
    reorderBaselineRef.current = {
      documentId: snapshot.document.id,
      nodes: snapshot.nodes.map((node) => ({ ...node })),
      siblingOrderRevisions: { ...snapshot.siblingOrderRevisions },
    };
    setReorderDirty(false);
    setMapInteractionMode('reorder');
    setContextMenu(null);
    setFeedback(t("已进入调整顺序模式，只能移动同级章节"));
  };

  const handleReorderSiblings = (parentId: string, orderedNodeIds: string[], anchorNodeId: string) => {
    if (!snapshot || mapInteractionMode !== 'reorder' || reorderSaving) return;
    try {
      const nextSnapshot = {
        ...snapshot,
        nodes: reorderWikiSiblings(snapshot.nodes, parentId, orderedNodeIds),
      };
      dataSource.attachWorkspace(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedNodeId(anchorNodeId);
      const baseline = reorderBaselineRef.current;
      setReorderDirty(Boolean(baseline && collectWikiSiblingOrderChanges(baseline.nodes, nextSnapshot.nodes).length > 0));
    } catch (reorderError) {
      handleCancelReorder();
      setFeedback(toMessage(reorderError));
    }
  };

  const handleAnalyze = (nodeId: string, prompt: string, actionKind: WikiActionKind = 'free', attachments: AssistantAttachment[] = [], options: WikiNodeAiRequestOptions = {}) => {
    if (!snapshot || operationBusy) return;
    setSelectedNodeId(nodeId);
    setActiveTab('ai');
    void consumeEvents(dataSource.analyzeNode(snapshot.document.id, nodeId, prompt, actionKind, attachments, options), snapshot.document.id);
  };

  const handleCreateAiMemory = async (nodeId: string): Promise<void> => {
    try {
      if (!snapshot) throw new Error(t("当前 Wiki 文档不可用，请重新打开后再试。"));
      if (operationBusy) throw new Error(t("当前 AI 任务完成后再新建对话。"));
      const documentIdForMemory = snapshot.document.id;
      const memory = await dataSource.createAiMemory(documentIdForMemory, nodeId);
      if (activeWikiDocumentIdRef.current !== documentIdForMemory) return;
      setAiMemories((current) => sortWikiAiMemories([memory, ...current]));
      setSnapshot((current) => {
        if (!current || current.document.id !== documentIdForMemory) return current;
        const prior = current.nodeAi[nodeId];
        return replaceWikiNodeAiState(current, {
          ...createEmptyNodeAiState(nodeId),
          ...(prior?.suggestedQuestions ? { suggestedQuestions: prior.suggestedQuestions } : {}),
          ...(prior?.questionsStatus ? { questionsStatus: prior.questionsStatus } : {}),
        });
      });
      setActiveTab('ai');
      setFeedback(t("已为当前章节新建对话"));
    } catch (memoryError) {
      setFeedback(toMessage(memoryError));
    }
  };

  const handleSetAiMemoryPinned = async (memoryId: string, pinned: boolean): Promise<void> => {
    if (!snapshot) throw new Error(t("当前 Wiki 文档不可用，请重新打开后再试。"));
    const documentIdForMemory = snapshot.document.id;
    const updated = await dataSource.setAiMemoryPinned(documentIdForMemory, memoryId, pinned);
    if (activeWikiDocumentIdRef.current !== documentIdForMemory) return;
    setAiMemories((current) => sortWikiAiMemories(
      current.map((memory) => memory.id === updated.id ? updated : memory),
    ));
  };

  const handleRenameAiMemory = async (memoryId: string, title: string): Promise<void> => {
    if (!snapshot) throw new Error(t("当前 Wiki 文档不可用，请重新打开后再试。"));
    const documentIdForMemory = snapshot.document.id;
    const updated = await dataSource.renameAiMemory(documentIdForMemory, memoryId, title);
    if (activeWikiDocumentIdRef.current !== documentIdForMemory) return;
    setAiMemories((current) => sortWikiAiMemories(
      current.map((memory) => memory.id === updated.id ? updated : memory),
    ));
  };

  const handleDeleteAiMemory = async (memoryId: string): Promise<void> => {
    if (!snapshot) throw new Error(t("当前 Wiki 文档不可用，请重新打开后再试。"));
    const documentIdForMemory = snapshot.document.id;
    await dataSource.deleteAiMemory(documentIdForMemory, memoryId);
    if (activeWikiDocumentIdRef.current === documentIdForMemory) {
      setAiMemories((current) => current.filter((memory) => memory.id !== memoryId));
    }
  };

  // 节点建议问题（方案 §7.4）：选中节点且切到 AI tab 时后台生成，不阻塞消息区渲染。
  const loadNodeQuestions = useCallback((targetDocumentId: string, targetNodeId: string, refresh: boolean) => {
    const requestKey = `${targetDocumentId}:${targetNodeId}`;
    if (!refresh) {
      if (questionsRequestRef.current.has(requestKey)) return;
      questionsRequestRef.current.add(requestKey);
    }
    const dispatch = (next: WikiEvent) => setSnapshot((current) => (
      current?.document.id === targetDocumentId ? reduceWikiEvent(current, next) : current
    ));
    dispatch(createQuestionsEvent({ type: 'questions-loading', nodeId: targetNodeId }));
    const request = refresh
      ? dataSource.refreshNodeQuestions(targetDocumentId, targetNodeId)
      : dataSource.getNodeQuestions(targetDocumentId, targetNodeId);
    void request
      .then((result) => dispatch(createQuestionsEvent({
        type: 'questions-ready',
        nodeId: targetNodeId,
        questions: result.questions,
        degraded: result.degraded,
      })))
      .catch(() => {
        questionsRequestRef.current.delete(requestKey);
        dispatch(createQuestionsEvent({ type: 'questions-ready', nodeId: targetNodeId, questions: [], degraded: true }));
      });
  }, [dataSource]);

  useEffect(() => {
    if (!snapshot || !selectedNodeId || activeTab !== 'ai') return;
    if ((snapshot.nodeAi[selectedNodeId]?.questionsStatus ?? 'idle') !== 'idle') return;
    loadNodeQuestions(snapshot.document.id, selectedNodeId, false);
  }, [activeTab, loadNodeQuestions, selectedNodeId, snapshot]);

  const handleRefreshQuestions = (nodeId: string) => {
    if (!snapshot) return;
    loadNodeQuestions(snapshot.document.id, nodeId, true);
    setFeedback(t("正在重新生成建议问题…"));
  };

  const handleRetryTask = (taskId: string) => {
    if (!snapshot || operationBusy) return;
    void consumeEvents(dataSource.retryChapter(snapshot.document.id, taskId), snapshot.document.id);
  };

  const handleCancel = async () => {
    const operationId = generationRunning
      ? snapshot?.generationJob?.operationId
      : activeNodeOperation?.operationId;
    if (operationId) await dataSource.cancelOperation(operationId);
  };

  const handleApplyDraft = async (mode: 'keep' | 'children') => {
    if (!snapshot || !selectedNode) return;
    const state = snapshot.nodeAi[selectedNode.id];
    if (!state?.draft) return;
    const draft = state.draft;
    let addedNodes: WikiMapNode[] = [];
    if (mode === 'children') {
      try {
        addedNodes = await Promise.all(draft.proposedChildren.map((title, index) => (
          dataSource.addDerivedNode(snapshot.document.id, selectedNode.id, title, draft.proposedChildSummaries?.[index])
        )));
      } catch (applyError) {
        setFeedback(toMessage(applyError));
        return;
      }
    }
    setSnapshot((current) => {
      if (!current) return current;
      const currentState = current.nodeAi[selectedNode.id] ?? createEmptyNodeAiState(selectedNode.id);
      const nextState = currentState.draft
        ? { ...currentState, draft: { ...currentState.draft, status: 'applied' as const } }
        : currentState;
      const nextSnapshot = replaceWikiNodeAiState(current, nextState);
      return addedNodes.length > 0
        ? { ...nextSnapshot, nodes: [...nextSnapshot.nodes, ...addedNodes], document: { ...nextSnapshot.document, nodeCount: nextSnapshot.nodes.length + addedNodes.length } }
        : nextSnapshot;
    });
    setFeedback(mode === 'children' ? t("草稿已生成派生子节点") : t("草稿已保留在当前节点"));
  };

  const handleDiscardDraft = () => {
    if (!selectedNode) return;
    setSnapshot((current) => {
      if (!current) return current;
      const currentState = current.nodeAi[selectedNode.id] ?? createEmptyNodeAiState(selectedNode.id);
      return replaceWikiNodeAiState(current, {
        ...currentState,
        draft: currentState.draft ? { ...currentState.draft, status: 'discarded' } : null,
      });
    });
  };

  const openNodeAction = (action: WikiNodeAction, nodeId: string) => {
    setNodeAction(action);
    setNodeActionId(nodeId);
    setContextMenu(null);
  };

  const handleNodeActionConfirm = async (value: string) => {
    if (!snapshot || !actionNode || !nodeAction) return;
    try {
      if (nodeAction === 'add') {
        const node = await dataSource.addDerivedNode(snapshot.document.id, actionNode.id, value);
        setSnapshot((current) => current ? {
          ...current,
          nodes: [...current.nodes, node],
          document: { ...current.document, nodeCount: current.nodes.length + 1 },
        } : current);
      } else if (nodeAction === 'rename') {
        const node = await dataSource.renameDerivedNode(snapshot.document.id, actionNode.id, value);
        setSnapshot((current) => current ? updateWikiNode(current, node.id, node) : current);
      } else {
        const deletedIds = await dataSource.deleteDerivedNode(snapshot.document.id, actionNode.id);
        setSnapshot((current) => current ? {
          ...current,
          nodes: current.nodes.filter((node) => !deletedIds.includes(node.id)),
          document: { ...current.document, nodeCount: current.nodes.length - deletedIds.length },
        } : current);
        if (selectedNodeId && deletedIds.includes(selectedNodeId)) setSelectedNodeId(null);
      }
    } catch (actionError) {
      setFeedback(toMessage(actionError));
    }
    setNodeAction(null);
    setNodeActionId(null);
  };

  const outline = snapshot ? (
    <WikiOutlinePane
      document={snapshot.document}
      nodes={snapshot.nodes}
      selectedNodeId={selectedNodeId}
      searchQuery={searchQuery}
      onSelectNode={handleSelectNode}
      onToggleCollapsed={handleToggleCollapsed}
      onBackToDocuments={() => setSidebarMode('documents')}
    />
  ) : null;

  const documentList = selectedLibrary ? (
    <WikiDocumentListPane
      library={selectedLibrary}
      documents={documents}
      selectedDocumentId={documentId}
      loading={loadingDocuments}
      loadingDocumentId={loadingDocumentId}
      error={error}
      onSelectDocument={(document) => void loadDocument(document)}
      onRefresh={() => void refreshDocuments()}
    />
  ) : null;
  const sidebar = sidebarMode === 'outline' && outline ? outline : documentList;

  const selectedAiState = selectedNode
    ? snapshot?.nodeAi[selectedNode.id] ?? createEmptyNodeAiState(selectedNode.id)
    : null;
  const questionReadyNodeIds = useMemo(() => {
    if (!snapshot) return new Set<string>();
    return new Set(
      Object.entries(snapshot.nodeAi)
        .filter(([, state]) => state.questionsStatus === 'ready' && (state.suggestedQuestions?.length ?? 0) > 0)
        .map(([nodeId]) => nodeId),
    );
  }, [snapshot]);
  const contextChildCount = contextNode ? snapshot?.nodes.filter((node) => node.parentId === contextNode.id).length ?? 0 : 0;
  const sourceDocument = documents.find((document) => document.id === snapshot?.document.id);

  return (
    <div ref={workspaceRef} className="wiki-workspace" data-theme={resolvedTheme}>
      <WikiToolbar
        libraries={libraries}
        libraryPath={libraryPath}
        hasDocument={hasDocument}
        sidebarLabel={sidebarMode === 'outline' && snapshot ? t("文档目录") : t("文档列表")}
        mode={snapshot?.mode ?? null}
        searchQuery={searchQuery}
        outlineOpen={outlineOpen}
        job={snapshot?.generationJob ?? null}
        operationBusy={operationBusy}
        mapInteractionMode={mapInteractionMode}
        reorderDirty={reorderDirty}
        reorderSaving={reorderSaving}
        orderPersistence={snapshot?.orderPersistence ?? 'session'}
        onLibraryChange={handleLibraryChange}
        onSearchChange={setSearchQuery}
        onToggleOutline={() => setOutlineOpen((value) => !value)}
        onResetLayout={() => setLayoutRevision((revision) => revision + 1)}
        onMapInteractionModeChange={handleMapInteractionModeChange}
        onCommitReorder={() => void handleCommitReorder()}
        onCancelReorder={handleCancelReorder}
        onOpenMode={() => setModeModalOpen(true)}
        onStartGeneration={() => startFullGeneration()}
        onStop={() => void handleCancel()}
      />
      <div className="wiki-workspace-body">
        {!compactOutline && outlineOpen ? sidebar : null}
        <WikiSplitPane
          secondaryOpen={Boolean(selectedNode && selectedAiState)}
          overlay={overlayDetail}
          primary={snapshot ? (
            <WikiMapCanvas
              nodes={snapshot.nodes}
              questionReadyNodeIds={questionReadyNodeIds}
              selectedNodeId={selectedNodeId}
              searchQuery={searchQuery}
              layoutRevision={layoutRevision}
              interactionMode={mapInteractionMode}
              reorderSaving={reorderSaving}
              focusRequest={focusRequest}
              onSelectNode={handleSelectNode}
              onToggleCollapsed={handleToggleCollapsed}
              onReorderSiblings={handleReorderSiblings}
              onCancelReorder={handleCancelReorder}
              onOpenContextMenu={(nodeId, x, y) => setContextMenu({ nodeId, position: { x, y } })}
              onCloseContextMenu={() => setContextMenu(null)}
            />
          ) : (
            <WikiEmptyState
              loading={loadingLibraries || loadingDocuments || Boolean(loadingDocumentId)}
              error={error}
              onRetry={() => libraryPath ? void refreshDocuments() : void loadLibraries()}
              title={libraries.length === 0 ? t("还没有可用的知识库") : documents.length === 0 ? t("当前知识库没有文档") : t("从左侧选择已索引文档")}
              description={libraries.length === 0 ? t("先在资料库创建知识库并上传文档。") : documents.length === 0 ? t("在资料库中上传文档后，Wiki 会读取其结构树目录。") : t("文档打开后，左侧列表会自动切换为当前文档目录。")}
            />
          )}
          secondary={selectedNode && selectedAiState ? (
            <WikiDetailPane
              node={selectedNode}
              pathLabel={selectedPath}
              documentTitle={snapshot?.document.title ?? ''}
              activeTab={activeTab}
              aiState={selectedAiState}
              generationJob={snapshot?.generationJob ?? null}
              resolvedTheme={resolvedTheme}
              assistantAiOptions={assistantAiOptions}
              operationBusy={operationBusy}
              aiMemories={aiMemories}
              onTabChange={setActiveTab}
              onClose={() => setSelectedNodeId(null)}
              onOpenInNotes={libraryPath && sourceDocument ? () => setNoteSource({
                libraryPath,
                documentId: sourceDocument.id,
                contentHash: sourceDocument.contentHash,
                name: sourceDocument.name,
              }) : undefined}
              onAnalyze={(prompt, actionKind, attachments, options) => handleAnalyze(selectedNode.id, prompt, actionKind, attachments, options)}
              onCancelAnalysis={() => void handleCancel()}
              onRetryTask={handleRetryTask}
              onApplyDraft={(mode) => void handleApplyDraft(mode)}
              onDiscardDraft={handleDiscardDraft}
              onNavigateNode={handleNavigateEvidenceNode}
              onCreateAiMemory={() => handleCreateAiMemory(selectedNode.id)}
              onSetAiMemoryPinned={handleSetAiMemoryPinned}
              onRenameAiMemory={handleRenameAiMemory}
              onDeleteAiMemory={handleDeleteAiMemory}
            />
          ) : null}
        />
      </div>
      {compactOutline ? (
        <Drawer opened={active && outlineOpen} onClose={() => setOutlineOpen(false)} title={sidebarMode === 'outline' && snapshot ? t("文档目录") : t("文档列表")} size={300} padding={0}>
          {sidebar}
        </Drawer>
      ) : null}
      {snapshot ? <WikiStartModal opened={modeModalOpen} documentTitle={snapshot.document.title} onStart={(mode) => void handleStartMode(mode)} /> : null}
      <WikiOpenInNotesModal source={active ? noteSource : null} onClose={() => setNoteSource(null)} onOpen={onOpenWikiDocumentInNotes} />
      {snapshot ? <WikiNodeContextMenu
        node={contextNode}
        position={contextMenu?.position ?? null}
        childCount={contextChildCount}
        onClose={() => setContextMenu(null)}
        onOpen={() => contextNode && handleSelectNode(contextNode.id)}
        onToggleCollapsed={() => contextNode && handleToggleCollapsed(contextNode.id)}
        onFitBranch={() => contextNode && setFocusRequest({ nodeId: contextNode.id, revision: Date.now() })}
        onLocateSource={() => {
          if (!contextNode) return;
          handleSelectNode(contextNode.id);
          setActiveTab('document');
          setFeedback(t("已定位到结构树原文章节"));
        }}
        onAnalyze={() => contextNode && handleAnalyze(contextNode.id, t("总结本节"), 'summarize')}
        onRefreshQuestions={() => contextNode && handleRefreshQuestions(contextNode.id)}
        onAddChild={() => contextNode && openNodeAction('add', contextNode.id)}
        onRename={() => contextNode && openNodeAction('rename', contextNode.id)}
        onCopyPath={() => {
          if (!contextNode) return;
          const path = getWikiNodePath(snapshot.nodes, contextNode.id).map((node) => node.title).join(' / ');
          void copyPlainText(path);
          setContextMenu(null);
          setFeedback(t("节点路径已复制"));
        }}
        onDelete={() => contextNode && openNodeAction('delete', contextNode.id)}
      /> : null}
      <WikiNodeActionModal
        action={nodeAction}
        node={actionNode}
        onClose={() => { setNodeAction(null); setNodeActionId(null); }}
        onConfirm={(value) => void handleNodeActionConfirm(value)}
      />
      {feedback ? <Text className="wiki-feedback" size="xs">{feedback}</Text> : null}
    </div>
  );
}

function sortWikiAiMemories(memories: WikiAiMemory[]): WikiAiMemory[] {
  return [...memories].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
  });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 构造一个本地 WikiEvent（建议问题事件不来自数据源流，operationId/seq 仅满足结构）。 */
function createQuestionsEvent<T extends Omit<WikiEvent, 'operationId' | 'seq' | 'timestamp'>>(event: T): WikiEvent {
  return { ...event, operationId: 'wiki-questions', seq: 0, timestamp: new Date().toISOString() } as unknown as WikiEvent;
}
