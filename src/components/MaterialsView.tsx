import { getAppLanguage, t, useI18n } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  AlertCircle,
  Archive,
  ArrowUpRight,
  ArrowUpDown,
  BookOpen,
  Bot,
  Ellipsis,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Lock,
  Pencil,
  Plus,
  PanelLeftOpen,
  Presentation,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import MarkdownPreview from './MarkdownPreview';
import DocumentPreview from './DocumentPreview';
import MaterialsPipelineView from './MaterialsPipelineView';
import CapabilityPanel from './CapabilityPanel';
import ChunkingStrategyConfigModal, { type ChunkingExecutionFact } from './ChunkingStrategyConfigModal';
import { KnowledgeAssistant, type KnowledgeAssistantProps } from './KnowledgePanel';
import { getMaterialsIconOption } from '../utils/materialsIcons';
import { relocateWorkspacePath, type WorkspaceDataChange } from '../utils/workspaceDataEvents';
import type { MaterialsDocument, MaterialsLibrarySummary } from '../electron';

interface MaterialsViewProps {
  onCreateLibrary: () => void;
  onUpgradeLibrary: () => void;
  onOpenParsingSettings: () => void;
  onOpenModelSettings: () => void;
  assistantAiOptions: KnowledgeAssistantProps['assistantAiOptions'];
  onRefreshAssistantAiOptions: KnowledgeAssistantProps['onRefreshAssistantAiOptions'];
  assistantContextRevision: KnowledgeAssistantProps['assistantContextRevision'];
  onStartAssistantTurn: KnowledgeAssistantProps['onStartAssistantTurn'];
  onCancelAssistantTurn: KnowledgeAssistantProps['onCancelAssistantTurn'];
  refreshKey?: number;
}

type SortMode = 'time' | 'name';

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
const ASSISTANT_DEFAULT_WIDTH = 480;
const ASSISTANT_MIN_WIDTH = 360;
const ASSISTANT_MAX_WIDTH = 720;
const ASSISTANT_MIN_DOCUMENT_WIDTH = 320;

export default function MaterialsView({
  onCreateLibrary,
  onUpgradeLibrary,
  onOpenParsingSettings,
  onOpenModelSettings,
  assistantAiOptions,
  onRefreshAssistantAiOptions,
  assistantContextRevision,
  onStartAssistantTurn,
  onCancelAssistantTurn,
  refreshKey = 0,
}: MaterialsViewProps) {
  useI18n();
  const [libraries, setLibraries] = useState<MaterialsLibrarySummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [documents, setDocuments] = useState<MaterialsDocument[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [documentText, setDocumentText] = useState<string | null>(null);
  const [documentBinary, setDocumentBinary] = useState<Uint8Array | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [zoom, setZoom] = useState(1);
  const [showPipeline, setShowPipeline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railWidth, setRailWidth] = useState(224);
  const [isLibraryRailCollapsed, setIsLibraryRailCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(336);
  const [deletingLibraryPath, setDeletingLibraryPath] = useState<string | null>(null);
  const [deletingDocument, setDeletingDocument] = useState<MaterialsDocument | null>(null);
  const [docContextMenu, setDocContextMenu] = useState<{ documentId: string; x: number; y: number } | null>(null);
  const [renamingDocument, setRenamingDocument] = useState<MaterialsDocument | null>(null);
  const [renameDocumentValue, setRenameDocumentValue] = useState('');
  const [renamingLibrary, setRenamingLibrary] = useState<MaterialsLibrarySummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [chunkingConfigOpened, setChunkingConfigOpened] = useState(false);
  const [chunkingConfigRevision, setChunkingConfigRevision] = useState(0);
  const [chunkingExecutionFact, setChunkingExecutionFact] = useState<ChunkingExecutionFact | null>(null);
  const [isAssistantOpened, setIsAssistantOpened] = useState(false);
  const [assistantWidth, setAssistantWidth] = useState(ASSISTANT_DEFAULT_WIDTH);
  const materialsViewRef = useRef<HTMLDivElement>(null);
  const assistantWidthRef = useRef(ASSISTANT_DEFAULT_WIDTH);

  const selectedLibrary = libraries.find((library) => library.path === selectedPath) ?? null;
  const selectedLibraryIcon = getMaterialsIconOption(selectedLibrary?.icon);
  const deletingLibrary = libraries.find((library) => library.path === deletingLibraryPath) ?? null;
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) ?? null;
  const selectedDocumentExtension = selectedDocument?.extension ?? null;
  const contextMenuDocument = documents.find((document) => document.id === docContextMenu?.documentId) ?? null;
  const assistantContextSources = useMemo(
    () => selectedLibrary ? [{ kind: 'knowledge-base' as const, libraryPath: selectedLibrary.path, label: selectedLibrary.alias }] : [],
    [selectedLibrary],
  );

  const visibleDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? documents.filter((document) => document.name.toLowerCase().includes(query))
      : documents;
    if (sortMode === 'name') {
      return [...filtered].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    }
    return filtered;
  }, [documents, searchQuery, sortMode]);

  const refreshLibraries = useCallback(async (preferPath?: string | null): Promise<MaterialsLibrarySummary[]> => {
    if (!window.electronAPI) return [];
    const next = await window.electronAPI.listMaterialsLibraries();
    setLibraries(next);
    setSelectedPath((previous) => {
      const preferred = preferPath ?? previous;
      if (preferred && next.some((library) => library.path === preferred)) return preferred;
      return previous && next.some((library) => library.path === previous) ? previous : null;
    });
    return next;
  }, []);

  const refreshDocuments = useCallback(async (libraryPath: string) => {
    if (!window.electronAPI) return;
    setIsLoadingDocuments(true);
    try {
      const nextDocuments = await window.electronAPI.listMaterialsDocuments(libraryPath);
      setSelectedPath((current) => {
        if (current === libraryPath) {
          setDocuments(nextDocuments);
          setSelectedDocumentId((documentId) => (documentId && nextDocuments.some((document) => document.id === documentId) ? documentId : null));
        }
        return current;
      });
    } catch (documentsError) {
      setError(toMessage(documentsError, t("读取资料文档失败。")));
    } finally {
      setIsLoadingDocuments(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibraries()
      .catch((loadError) => setError(toMessage(loadError, t("读取资料库列表失败。"))))
      .finally(() => setIsLoading(false));
  }, [refreshLibraries]);

  useEffect(() => {
    if (refreshKey === 0) return;
    void refreshLibraries().catch((loadError) => setError(toMessage(loadError, t("读取资料库列表失败。"))));
  }, [refreshKey, refreshLibraries]);

  useEffect(() => {
    const changed = (event: Event) => {
      const { source, target, waitUntil } = (event as CustomEvent<WorkspaceDataChange>).detail;
      const path = relocateWorkspacePath(selectedPath, source, target);
      waitUntil((async () => {
        const next = await refreshLibraries(path);
        if (path && next.some(library => library.path === path)) {
          const nextDocuments = await window.electronAPI.listMaterialsDocuments(path);
          setDocuments(nextDocuments); setSelectedDocumentId(id => id && nextDocuments.some(document => document.id === id) ? id : null);
        }
        setDocContextMenu(null); setError(null);
      })().catch(failure => { setError(toMessage(failure, t('读取资料库列表失败。'))); throw failure; }));
    };
    window.addEventListener('workspace-data-changed', changed);
    return () => window.removeEventListener('workspace-data-changed', changed);
  }, [selectedPath, refreshLibraries]);

  useEffect(() => {
    if (!selectedPath || !window.electronAPI?.onPipelineStatus) return;
    let timer: number | undefined;
    const unsubscribe = window.electronAPI.onPipelineStatus((status) => {
      if (status.libraryPath !== selectedPath) return;
      // 阶段状态变化（尤其 vectors 完成）后回刷文档与资料库，保证“待索引/已索引”徽章实时。
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refreshDocuments(selectedPath);
        void refreshLibraries(selectedPath);
      }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [selectedPath, refreshDocuments, refreshLibraries]);

  useEffect(() => {
    if (!docContextMenu) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDocContextMenu(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [docContextMenu]);

  useEffect(() => {
    if (!selectedPath) {
      setDocuments([]);
      setSelectedDocumentId(null);
      return;
    }
    setSelectedDocumentId(null);
    setShowPipeline(false);
    void window.electronAPI?.openMaterialsLibrary(selectedPath).catch(() => undefined);
    void refreshDocuments(selectedPath);
  }, [selectedPath, refreshDocuments]);

  useEffect(() => {
    if (!selectedPath) setIsLibraryRailCollapsed(false);
  }, [selectedPath]);

  useEffect(() => {
    setIsAssistantOpened(false);
  }, [selectedPath]);

  const constrainAssistantWidth = useCallback((width: number): number => {
    const viewWidth = materialsViewRef.current?.clientWidth ?? window.innerWidth;
    const visibleRailWidth = isLibraryRailCollapsed ? 0 : railWidth;
    const availableWidth = viewWidth - visibleRailWidth - listWidth - ASSISTANT_MIN_DOCUMENT_WIDTH;
    const maximumWidth = Math.max(ASSISTANT_MIN_WIDTH, Math.min(ASSISTANT_MAX_WIDTH, availableWidth));
    return Math.max(ASSISTANT_MIN_WIDTH, Math.min(maximumWidth, width));
  }, [isLibraryRailCollapsed, listWidth, railWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      const nextWidth = constrainAssistantWidth(assistantWidthRef.current);
      assistantWidthRef.current = nextWidth;
      setAssistantWidth(nextWidth);
    };
    window.addEventListener('resize', handleWindowResize);
    handleWindowResize();
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [constrainAssistantWidth]);

  useEffect(() => {
    setDocumentText(null);
    setDocumentBinary(null);
    if (!selectedPath || !selectedDocumentId || !window.electronAPI) return;
    let cancelled = false;
    setIsLoadingDocument(true);
    const readDocument = isBinaryPreviewFile(selectedDocumentExtension)
      ? window.electronAPI.readMaterialsDocumentBytes(selectedPath, selectedDocumentId)
          .then((bytes) => { if (!cancelled) setDocumentBinary(bytes); })
      : window.electronAPI.readMaterialsDocument(selectedPath, selectedDocumentId)
          .then((text) => { if (!cancelled) setDocumentText(text); });
    readDocument
      .catch((readError) => { if (!cancelled) setError(toMessage(readError, t("读取资料文档失败。"))); })
      .finally(() => { if (!cancelled) setIsLoadingDocument(false); });
    return () => { cancelled = true; };
  }, [selectedPath, selectedDocumentId, selectedDocumentExtension]);

  const startResize = (pane: 'rail' | 'list') => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = pane === 'rail' ? railWidth : listWidth;
    const applyWidth = pane === 'rail' ? setRailWidth : setListWidth;
    const minWidth = pane === 'rail' ? 176 : 260;
    const maxWidth = pane === 'rail' ? 360 : 520;
    const onMove = (moveEvent: PointerEvent) => {
      applyWidth(Math.min(maxWidth, Math.max(minWidth, startWidth + moveEvent.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing-materials');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing-materials');
  };

  const startAssistantResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = assistantWidthRef.current;
    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = constrainAssistantWidth(startWidth + startX - moveEvent.clientX);
      assistantWidthRef.current = nextWidth;
      setAssistantWidth(nextWidth);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      document.body.classList.remove('resizing-materials-assistant');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
    window.addEventListener('blur', onUp, { once: true });
    document.body.classList.add('resizing-materials-assistant');
  };

  const handleSelectLibrary = (libraryPath: string) => {
    setSelectedPath(libraryPath);
    setIsLibraryRailCollapsed(true);
  };

  const handleImport = async () => {
    if (!selectedLibrary || !window.electronAPI) return;
    const targetPath = selectedLibrary.path;
    setIsImporting(true);
    setError(null);
    try {
      const previousDocumentIds = new Set(documents.map((document) => document.id));
      const nextDocuments = await window.electronAPI.importMaterialsDocuments(targetPath);
      const firstImportedDocument = nextDocuments.find((document) => !previousDocumentIds.has(document.id));
      // 导入结果只更新发起时的库；摘要刷新保留用户在等待期间选择的库。
      setSelectedPath(current => {
        if (current === targetPath) {
          setDocuments(nextDocuments);
          if (firstImportedDocument) setSelectedDocumentId(firstImportedDocument.id);
        }
        return current;
      });
      await refreshLibraries();
    } catch (importError) {
      setError(toMessage(importError, t("上传资料失败。")));
    } finally {
      setIsImporting(false);
    }
  };

  const handleDeleteDocument = async () => {
    if (!selectedLibrary || !deletingDocument || !window.electronAPI) return;
    try {
      const nextDocuments = await window.electronAPI.deleteMaterialsDocument(selectedLibrary.path, deletingDocument.id);
      setDocuments(nextDocuments);
      if (selectedDocumentId === deletingDocument.id) setSelectedDocumentId(null);
      await refreshLibraries(selectedLibrary.path);
      setDeletingDocument(null);
    } catch (deleteError) {
      setError(toMessage(deleteError, t("删除资料失败。")));
      setDeletingDocument(null);
    }
  };

  const handleRenameDocument = async () => {
    if (!selectedLibrary || !renamingDocument || !window.electronAPI) return;
    try {
      const nextDocuments = await window.electronAPI.renameMaterialsDocument(selectedLibrary.path, renamingDocument.id, renameDocumentValue);
      setDocuments(nextDocuments);
      setRenamingDocument(null);
    } catch (renameError) {
      setError(toMessage(renameError, t("重命名文档失败。")));
    }
  };

  const handleRename = async () => {
    if (!renamingLibrary || !window.electronAPI) return;
    try {
      await window.electronAPI.renameMaterialsLibrary(renamingLibrary.path, renameValue);
      await refreshLibraries(renamingLibrary.path);
      setRenamingLibrary(null);
    } catch (renameError) {
      setError(toMessage(renameError, t("重命名资料库失败。")));
    }
  };

  const handleDeleteLibrary = async () => {
    if (!deletingLibraryPath || !window.electronAPI) return;
    try {
      const next = await window.electronAPI.deleteMaterialsLibrary(deletingLibraryPath);
      setLibraries(next);
      if (selectedPath === deletingLibraryPath) {
        setSelectedPath(null);
        setIsLibraryRailCollapsed(false);
      }
      setDeletingLibraryPath(null);
    } catch (deleteError) {
      setError(toMessage(deleteError, t("删除知识库失败。")));
      setDeletingLibraryPath(null);
    }
  };

  const openChunkingConfig = async () => {
    if (!selectedLibrary || !window.electronAPI) return;
    setChunkingExecutionFact(null);
    setChunkingConfigOpened(true);
    try {
      const statuses = await window.electronAPI.getMaterialsPipelineStatus(selectedLibrary.path);
      const completed = statuses.find((status) => status.stages?.chunks?.status === 'SUCCEEDED');
      if (!completed) return;
      const preview = await window.electronAPI.getPipelineArtifactPreview(selectedLibrary.path, completed.documentId, 'chunks', 'chunks-report.json', 0, 10);
      const report = JSON.parse(preview.rows.map((row) => row.text).join('\n')) as {
        effectiveParentStrategies?: string[];
        effectiveChildStrategies?: string[];
        fallbackReason?: string | null;
        parentLimits?: ChunkingExecutionFact['parentLimits'];
        quality?: { level?: string };
      };
      setChunkingExecutionFact({
        effectiveParentStrategies: report.effectiveParentStrategies,
        effectiveChildStrategies: report.effectiveChildStrategies,
        fallbackReason: report.fallbackReason,
        parentLimits: report.parentLimits,
        qualityLevel: report.quality?.level,
      });
    } catch {
      // The configuration remains editable even when a prior report was cleaned up or is incomplete.
    }
  };

  return (
    <div ref={materialsViewRef} className="materials-view">
      <aside
        className={`materials-rail ${isLibraryRailCollapsed ? 'is-collapsed' : ''}`}
        aria-label={t("资料库列表")}
        aria-hidden={isLibraryRailCollapsed}
        style={{ width: railWidth, flexBasis: railWidth }}
      >
        <Group className="materials-rail-header" justify="space-between" wrap="nowrap">
          <Text size="xs" fw={700} c="dimmed">{t("个人知识库")}</Text>
          <Group gap={2} wrap="nowrap">
            <Tooltip label={t("新建资料库")} withArrow position="bottom">
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("新建资料库")} onClick={onCreateLibrary}><Plus size={15} /></ActionIcon>
            </Tooltip>
            <Tooltip label={t("笔记库升级为资料库")} withArrow position="bottom">
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("笔记库升级为资料库")} onClick={onUpgradeLibrary}><ArrowUpRight size={15} /></ActionIcon>
            </Tooltip>
          </Group>
        </Group>
        {!isLoading && libraries.length === 0 ? (
          <Stack className="materials-pane-empty" align="center" gap="md" py="md">
            <ThemeIcon size={46} radius="xl" variant="light" color="brand"><Archive size={22} /></ThemeIcon>
            <Stack gap={3} align="center">
              <Text size="sm" fw={650}>{t("还没有资料库")}</Text>
              <Text size="xs" c="dimmed" ta="center" maw={200} style={{ textWrap: 'balance' }}>
                {t("先创建一个知识库，再开始整理资料。")}
              </Text>
            </Stack>
            <Stack gap="xs" w={160} maw="100%">
              <Button size="xs" px={6} leftSection={<Plus size={14} />} onClick={onCreateLibrary}>{t("新建资料库")}</Button>
              <Button size="xs" px={6} variant="light" leftSection={<ArrowUpRight size={14} />} onClick={onUpgradeLibrary}>{t("升级笔记库")}</Button>
            </Stack>
          </Stack>
        ) : (
          <ScrollArea className="materials-rail-scroll">
            <Stack gap={2}>
              {libraries.map((library) => {
                const railIcon = getMaterialsIconOption(library.icon);
                return (
                  <button
                    key={library.path}
                    type="button"
                    className={`materials-rail-item ${library.path === selectedPath ? 'active' : ''}`}
                    aria-pressed={library.path === selectedPath}
                    onClick={(event) => {
                      event.currentTarget.blur();
                      handleSelectLibrary(library.path);
                    }}
                  >
                    <ThemeIcon size={22} radius={6} variant="light" color={railIcon.color}><railIcon.Icon size={13} /></ThemeIcon>
                    <Text size="sm" truncate>{library.alias}</Text>
                  </button>
                );
              })}
            </Stack>
          </ScrollArea>
        )}
        <div className="materials-resizer" onPointerDown={startResize('rail')} />
      </aside>

      {showPipeline && selectedLibrary ? (
        <MaterialsPipelineView
          library={selectedLibrary}
          documents={documents}
          onBack={() => setShowPipeline(false)}
          onOpenParsingSettings={onOpenParsingSettings}
          onOpenModelSettings={onOpenModelSettings}
          onConfigureChunking={() => { void openChunkingConfig(); }}
          chunkingConfigRevision={chunkingConfigRevision}
        />
      ) : (
        <>
      <section className="materials-list-pane" style={{ width: listWidth, flexBasis: listWidth }}>
        {isLoading ? (
          <Group className="materials-pane-empty" justify="center"><Loader size="sm" color="brand" /></Group>
        ) : !selectedLibrary ? (
          libraries.length > 0 ? (
            <Stack className="materials-pane-empty" align="center" gap="md">
              <ThemeIcon size={46} radius="xl" variant="light" color="brand"><Archive size={22} /></ThemeIcon>
              <Stack gap={3} align="center">
                <Text size="sm" fw={650}>{t("选择一个知识库")}</Text>
                <Text size="xs" c="dimmed" ta="center" maw={240}>
                  {t("已找到 {0} 个个人知识库，请从左侧选择。", { '0': libraries.length })}
                </Text>
              </Stack>
            </Stack>
          ) : null
        ) : (
          <>
            <header className="materials-list-header">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Group gap="md" wrap="nowrap" miw={0}>
                  <Tooltip label={t("切换知识库")} withArrow position="bottom">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label={t("切换知识库")}
                      onClick={() => setIsLibraryRailCollapsed(false)}
                    >
                      <PanelLeftOpen size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <ThemeIcon size={56} radius="md" variant="light" color={selectedLibraryIcon.color}>
                    <selectedLibraryIcon.Icon size={26} />
                  </ThemeIcon>
                  <Stack gap={2} miw={0}>
                    <Text component="h3" fw={700} size="lg" truncate>{selectedLibrary.alias}</Text>
                    <Text size="xs" c="dimmed">{t("个人知识库 ·")} {selectedLibrary.documentCount} {t("个文档")}</Text>
                  </Stack>
                </Group>
                <Group gap={3} wrap="nowrap">
                  <Tooltip label={t("询问{0}", { '0': selectedLibrary.alias })} withArrow position="bottom">
                    <ActionIcon
                      variant={isAssistantOpened ? 'light' : 'subtle'}
                      color={isAssistantOpened ? 'brand' : 'gray'}
                      aria-label={t("询问{0}", { '0': selectedLibrary.alias })}
                      onClick={() => setIsAssistantOpened(true)}
                    >
                      <Bot size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Menu position="bottom-end" withinPortal>
                  <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={t("{0} 操作", { '0': selectedLibrary.alias })}><Ellipsis size={16} /></ActionIcon></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<Upload size={15} />} onClick={() => void handleImport()} disabled={isImporting || !selectedLibrary.exists}>{t("上传文档")}</Menu.Item>
                    <Menu.Item leftSection={<Pencil size={15} />} onClick={() => { setRenameValue(selectedLibrary.alias); setRenamingLibrary(selectedLibrary); }}>{t("重命名")}</Menu.Item>
                    <Menu.Item leftSection={<RefreshCw size={15} />} onClick={() => void refreshDocuments(selectedLibrary.path)}>{t("同步文档")}</Menu.Item>
                    <Menu.Item leftSection={<Settings2 size={15} />} onClick={() => { void openChunkingConfig(); }}>{t("切块策略")}</Menu.Item>
                    <Menu.Item leftSection={<Workflow size={15} />} onClick={() => setShowPipeline(true)}>{t("切块与流水线")}</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<Trash2 size={15} />} onClick={() => setDeletingLibraryPath(selectedLibrary.path)}>{t("删除知识库")}</Menu.Item>
                  </Menu.Dropdown>
                  </Menu>
                </Group>
              </Group>
            </header>

            {error ? <Alert className="materials-list-alert" icon={<AlertCircle size={14} />} color="red" variant="light" withCloseButton onClose={() => setError(null)}>{error}</Alert> : null}

            <Group className="materials-list-toolbar" justify="space-between" wrap="nowrap">
              <Text size="sm" c="dimmed">{t("内容(")}{visibleDocuments.length})</Text>
              <Group gap={2} wrap="nowrap">
                <Tooltip label={t("搜索文档")} withArrow position="bottom">
                  <ActionIcon variant={isSearching ? 'light' : 'subtle'} color={isSearching ? 'brand' : 'gray'} size="sm" aria-label={t("搜索文档")} onClick={() => { setIsSearching((value) => !value); setSearchQuery(''); }}>
                    <Search size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={sortMode === 'time' ? t("按名称排序") : t("按时间排序")} withArrow position="bottom">
                  <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("切换排序")} onClick={() => setSortMode((mode) => mode === 'time' ? 'name' : 'time')}>
                    <ArrowUpDown size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("重新同步")} withArrow position="bottom">
                  <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("重新同步")} onClick={() => void refreshDocuments(selectedLibrary.path)}>
                    <RefreshCw size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("文本与 DOCX 本地处理；PDF 可先导入，云解析前确认上传。 ")} withArrow position="bottom">
                  <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("导入文档")} loading={isImporting} disabled={!selectedLibrary.exists} onClick={() => void handleImport()}>
                    <Upload size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            {isSearching ? (
              <TextInput
                className="materials-list-search"
                size="xs"
                placeholder={t("按名称过滤")}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                leftSection={<Search size={13} />}
                autoFocus
              />
            ) : null}

            <ScrollArea className="materials-doc-list">
              <Stack gap="xs" p="xs"><Text size="xs" c="dimmed">{t('文本与 DOCX 本地处理；PDF 可先导入，云解析前确认上传。')}</Text><Button variant="subtle" size="xs" onClick={() => setShowCapabilities(true)}>{t('查看功能状态')}</Button></Stack>
              {isLoadingDocuments ? (
                <Group justify="center" py="xl"><Loader size="sm" color="brand" /></Group>
              ) : visibleDocuments.length === 0 ? (
                <Text className="materials-doc-list-empty" size="xs" c="dimmed" ta="center">
                  {documents.length === 0 ? t("暂无文档，点击右上角菜单上传") : t("没有匹配的内容")}
                </Text>
              ) : (
                <Stack gap={2} pb="sm">
                  {visibleDocuments.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      className={`materials-doc-item ${document.id === selectedDocumentId ? 'active' : ''}`}
                      onClick={() => setSelectedDocumentId(document.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelectedDocumentId(document.id);
                        setDocContextMenu({
                          documentId: document.id,
                          x: Math.min(event.clientX, window.innerWidth - 176),
                          y: Math.min(event.clientY, window.innerHeight - 108),
                        });
                      }}
                    >
                      <DocumentTypeIcon extension={document.extension} />
                      <span className="materials-doc-item-body">
                        <Text size="sm" truncate>{document.name}</Text>
                        <Text size="xs" c="dimmed" truncate>{formatBytes(document.sizeBytes)} · {formatDateTime(document.addedAt)}</Text>
                      </span>
                    </button>
                  ))}
                  <Text size="xs" c="dimmed" ta="center" py="md">{t("没有更多内容了")}</Text>
                </Stack>
              )}
            </ScrollArea>
          </>
        )}
        <div className="materials-resizer" onPointerDown={startResize('list')} />
      </section>

      <section className="materials-doc-pane">
        {!selectedDocument ? (
          <Stack className="materials-pane-empty" align="center" gap="xs">
            <FileText size={26} color="var(--text-tertiary)" />
            <Text size="sm" c="dimmed">{t("选择左侧文档查看内容")}</Text>
          </Stack>
        ) : (
          <>
            <header className="materials-doc-header">
              <Group justify="space-between" wrap="nowrap" align="center">
                <Group gap="sm" wrap="nowrap" miw={0}>
                  <DocumentTypeIcon extension={selectedDocument.extension} size={20} />
                  <Stack gap={2} miw={0}>
                    <Text fw={700} truncate title={selectedDocument.relativePath}>{selectedDocument.name}</Text>
                    <Group gap={6} wrap="wrap">
                      <Badge size="xs" variant="light">{documentTypeLabel(selectedDocument.extension)}</Badge>
                      <Badge size="xs" variant="light" color="gray">{formatBytes(selectedDocument.sizeBytes)}</Badge>
                      <Badge size="xs" variant="light" color={selectedDocument.vectorState === 'indexed' ? 'teal' : 'orange'}>
                        {selectedDocument.vectorState === 'indexed' ? t("已索引") : t("待索引")}
                      </Badge>
                      <Badge size="xs" variant="light" color="gray" leftSection={<Lock size={10} />}>{t("只读")}</Badge>
                    </Group>
                  </Stack>
                </Group>
                <Group gap={4} wrap="nowrap">
                  <Tooltip label={t("缩小")} withArrow position="bottom">
                    <ActionIcon variant="subtle" color="gray" aria-label={t("缩小")} disabled={zoom <= ZOOM_MIN} onClick={() => setZoom((value) => Math.max(ZOOM_MIN, Math.round((value - ZOOM_STEP) * 100) / 100))}>
                      <ZoomOut size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("放大")} withArrow position="bottom">
                    <ActionIcon variant="subtle" color="gray" aria-label={t("放大")} disabled={zoom >= ZOOM_MAX} onClick={() => setZoom((value) => Math.min(ZOOM_MAX, Math.round((value + ZOOM_STEP) * 100) / 100))}>
                      <ZoomIn size={15} />
                    </ActionIcon>
                  </Tooltip>
                  <ActionIcon variant="subtle" color="red" aria-label={t("删除文档")} onClick={() => setDeletingDocument(selectedDocument)}>
                    <Trash2 size={15} />
                  </ActionIcon>
                  <Tooltip label={t("关闭预览")} withArrow position="bottom">
                  <ActionIcon variant="subtle" color="gray" aria-label={t("关闭预览")} onClick={() => { setSelectedDocumentId(null); setDocumentText(null); setDocumentBinary(null); }}>
                      <X size={15} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </header>

            <div className="materials-doc-content" style={{ zoom }}>
              {isLoadingDocument ? (
                <Group justify="center" pt="xl"><Loader size="sm" color="brand" /></Group>
              ) : documentBinary !== null ? (
                <DocumentPreview
                  extension={selectedDocument.extension}
                  data={documentBinary}
                />
              ) : documentText !== null ? (
                isMarkdownFile(selectedDocument.extension) ? (
                  <MarkdownPreview
                    key={selectedDocument.id}
                    content={documentText}
                    currentPath={selectedDocument.absolutePath}
                    libraryPath={selectedLibrary?.path}
                    frontmatter="strip"
                    disableApplicationLinks
                    onOutlineChange={() => undefined}
                  />
                ) : (
                  <pre className="materials-doc-plain">{documentText}</pre>
                )
              ) : (
                <Stack align="center" gap="sm" pt="xl">
                  <ThemeIcon size={52} radius="xl" variant="light" color="gray"><BinaryIcon extension={selectedDocument.extension} /></ThemeIcon>
                  <Text fw={650}>{selectedDocument.name}</Text>
                   <Text size="xs" c="dimmed" maw={360} ta="center">
                     {isBinaryPreviewFile(selectedDocument.extension) ? t("预览数据暂不可用，请重新选择文档。") : t("此格式暂不支持直接预览，但仍可以继续索引和检索。")}
                   </Text>
                  <Text size="xs" c="dimmed" ff="monospace" truncate maw={420}>sha256:{selectedDocument.contentHash.slice(0, 24)}…</Text>
                </Stack>
              )}
            </div>
          </>
        )}
      </section>

      {isAssistantOpened && selectedLibrary ? (
        <section
          className="materials-assistant-pane"
          style={{ width: assistantWidth, flexBasis: assistantWidth }}
          aria-label={t("AI 助手 · {0}", { '0': selectedLibrary.alias })}
        >
          <div className="materials-assistant-resizer" role="separator" aria-label={t("调整 AI 助手宽度")} aria-orientation="vertical" onPointerDown={startAssistantResize} />
          <div className="materials-assistant-body">
            <KnowledgeAssistant
              key={selectedLibrary.path}
              onClose={() => setIsAssistantOpened(false)}
              libraryPath={null}
              noteMeta={null}
              assistantAiOptions={assistantAiOptions}
              onRefreshAssistantAiOptions={onRefreshAssistantAiOptions}
              assistantContextRevision={assistantContextRevision}
              onStartAssistantTurn={onStartAssistantTurn}
              onCancelAssistantTurn={onCancelAssistantTurn}
              fixedContextSources={assistantContextSources}
            />
          </div>
        </section>
      ) : null}
      </>
      )}

      {selectedLibrary ? (
        <Modal opened={showCapabilities} onClose={() => setShowCapabilities(false)} title={t('功能状态')} size="lg" centered><CapabilityPanel key={`${selectedLibrary.path}:${selectedDocumentId ?? ''}`} libraryPath={selectedLibrary.path} documentId={selectedDocumentId ?? undefined} onOpenSettings={section => { setShowCapabilities(false); section === 'parsing' ? onOpenParsingSettings() : onOpenModelSettings(); }} /></Modal>
      ) : null}
      {selectedLibrary ? (
        <ChunkingStrategyConfigModal
          opened={chunkingConfigOpened}
          title={t("{0} · 切块策略", { '0': selectedLibrary.alias })}
          documentCount={selectedLibrary.documentCount}
          executionFact={chunkingExecutionFact}
          onLoadConfig={() => window.electronAPI.getLibraryChunkingConfig(selectedLibrary.path)}
          onSave={async (config) => {
            await window.electronAPI.saveLibraryChunkingConfig(selectedLibrary.path, config);
            setChunkingConfigRevision((revision) => revision + 1);
          }}
          onClose={() => setChunkingConfigOpened(false)}
        />
      ) : null}

      <Modal opened={Boolean(deletingDocument)} onClose={() => setDeletingDocument(null)} title={t("删除资料文档")} centered>
        <Stack gap="md">
          <Text size="sm">{t("文档将移入回收站，同时清理该文档的流水线产物和向量索引；删除后可重新上传新版本。")}</Text>
          <Text fw={650} truncate>{deletingDocument?.name}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeletingDocument(null)}>{t("取消")}</Button>
            <Button color="red" leftSection={<Trash2 size={15} />} onClick={() => void handleDeleteDocument()}>{t("删除文档")}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(renamingDocument)} onClose={() => setRenamingDocument(null)} title={t("重命名文档")} centered>
        <Stack gap="md">
          <TextInput
            label={t("文档名称")}
            value={renameDocumentValue}
            onChange={(event) => setRenameDocumentValue(event.currentTarget.value)}
            autoFocus
            onKeyDown={(event) => { if (event.key === 'Enter') void handleRenameDocument(); }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenamingDocument(null)}>{t("取消")}</Button>
            <Button leftSection={<Pencil size={15} />} onClick={() => void handleRenameDocument()}>{t("保存")}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(renamingLibrary)} onClose={() => setRenamingLibrary(null)} title={t("重命名资料库")} centered>
        <Stack gap="md">
          <TextInput
            label={t("资料库名称")}
            value={renameValue}
            onChange={(event) => setRenameValue(event.currentTarget.value)}
            autoFocus
            onKeyDown={(event) => { if (event.key === 'Enter') void handleRename(); }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenamingLibrary(null)}>{t("取消")}</Button>
            <Button leftSection={<Pencil size={15} />} onClick={() => void handleRename()}>{t("保存")}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(deletingLibraryPath)} onClose={() => setDeletingLibraryPath(null)} title={t("删除知识库")} centered>
        <Stack gap="md">
          <Text size="sm">{t("知识库文件夹将移入回收站，并移除应用内注册。")}</Text>
          <Text fw={650}>{deletingLibrary?.alias}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeletingLibraryPath(null)}>{t("取消")}</Button>
            <Button color="red" leftSection={<Trash2 size={15} />} onClick={() => void handleDeleteLibrary()}>{t("删除知识库")}</Button>
          </Group>
        </Stack>
      </Modal>

      {contextMenuDocument ? (
        <>
          <div
            className="materials-ctx-backdrop"
            onClick={() => setDocContextMenu(null)}
            onContextMenu={(event) => { event.preventDefault(); setDocContextMenu(null); }}
          />
          <Paper className="materials-ctx-menu" shadow="md" radius="md" style={{ top: docContextMenu?.y, left: docContextMenu?.x }}>
            <UnstyledButton
              className="materials-ctx-item"
              onClick={() => {
                setRenameDocumentValue(contextMenuDocument.name);
                setRenamingDocument(contextMenuDocument);
                setDocContextMenu(null);
              }}
            >
              <Pencil size={14} /> {t("重命名")}
            </UnstyledButton>
            <UnstyledButton
              className="materials-ctx-item danger"
              onClick={() => {
                setDeletingDocument(contextMenuDocument);
                setDocContextMenu(null);
              }}
            >
              <Trash2 size={14} /> {t("删除文档")}
            </UnstyledButton>
          </Paper>
        </>
      ) : null}
    </div>
  );
}

function BinaryIcon({ extension, size = 22 }: { extension: string; size?: number }) {
  useI18n();
  if (extension === '.ppt' || extension === '.pptx') return <Presentation size={size} />;
  if (['.xls', '.xlsx', '.csv'].includes(extension)) return <FileSpreadsheet size={size} />;
  if (extension === '.epub') return <BookOpen size={size} />;
  if (['.json', '.yaml', '.yml', '.xml'].includes(extension)) return <FileCode2 size={size} />;
  return <File size={size} />;
}

function DocumentTypeIcon({ extension, size = 16 }: { extension: string; size?: number }) {
  useI18n();
  const common = { size, strokeWidth: 1.8 };
  if (extension === '.pdf') return <FileText {...common} color="#d96b5e" />;
  if (extension === '.doc' || extension === '.docx') return <FileText {...common} color="var(--text-secondary)" />;
  if (extension === '.ppt' || extension === '.pptx') return <Presentation {...common} color="#c98a3c" />;
  if (['.xls', '.xlsx', '.csv'].includes(extension)) return <FileSpreadsheet {...common} color="#2d9d7c" />;
  if (extension === '.epub') return <BookOpen {...common} color="#8a63d2" />;
  if (['.json', '.yaml', '.yml', '.xml'].includes(extension)) return <FileCode2 {...common} color="var(--text-secondary)" />;
  if (['.md', '.markdown', '.txt', '.log'].includes(extension)) return <FileText {...common} color="var(--text-secondary)" />;
  return <File {...common} color="#9caabb" />;
}

function isMarkdownFile(extension: string): boolean {
  return extension === '.md' || extension === '.markdown';
}

function isBinaryPreviewFile(extension: string | null): boolean {
  return extension === '.pdf' || extension === '.docx';
}

function documentTypeLabel(extension: string): string {
  switch (extension) {
    case '.pdf': return 'PDF';
    case '.doc':
    case '.docx': return 'Word';
    case '.ppt':
    case '.pptx': return 'PPT';
    case '.xls':
    case '.xlsx':
    case '.csv': return t("表格");
    case '.epub': return t("电子书");
    case '.md':
    case '.markdown': return 'Markdown';
    case '.txt':
    case '.log': return t("文本");
    case '.html':
    case '.htm': return t("网页");
    case '.json':
    case '.yaml':
    case '.yml':
    case '.xml': return t("结构化");
    default: return t("文件");
  }
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("刚刚");
  return new Intl.DateTimeFormat(getAppLanguage(), { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
