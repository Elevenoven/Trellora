import { getAppLanguage, t, useI18n } from '../i18n';
import MaterialVectorGenerationsPanel from './materials/MaterialVectorGenerationsPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  AlertCircle,
  ArrowLeft,
  BrainCircuit,
  Check,
  CircleDashed,
  Clock,
  Info,
  KeyRound,
  LockKeyhole,
  Loader,
  Package,
  RefreshCw,
  Settings2,
  Share2,
  ShieldCheck,
  TestTube2,
  type LucideIcon,
} from 'lucide-react';
import { getMaterialsIconOption } from '../utils/materialsIcons';
import { getDefaultArtifactPreviewMode, type ArtifactPreviewMode } from '../utils/pipelineArtifactPreview';
import { KeywordPreviewModal, KeywordStageConfig } from './KeywordStagePanel';
import { PipelineArtifactPreviewContent } from './PipelineArtifactPreview';
import type { LibraryChunkingConfig, LibraryGraphCommunityRow, LibraryGraphEnhancementConfig, LibraryGraphProjectionStatus, LibraryPipelineLlmBinding, MaterialEmbeddingCandidate, MaterialEmbeddingProfileStatus, MaterialEmbeddingProfileTestResult, MaterialsDocument, MaterialsLibrarySummary, ModelHub, ParsingConfig, PipelineArtifactPreview, PipelineDocumentStatus, PipelineKeywordPreview, PipelineKeywordResources, PipelineProgressEvent } from '../electron';

interface MaterialsPipelineViewProps {
  library: MaterialsLibrarySummary;
  documents: MaterialsDocument[];
  onBack: () => void;
  onOpenParsingSettings: () => void;
  onOpenModelSettings: () => void;
  onConfigureChunking: () => void;
  chunkingConfigRevision: number;
}

type StageStatus = 'done' | 'running' | 'pending' | 'error' | 'waiting' | 'cancelled' | 'skipped';
type StageId = 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'fts' | 'vectors' | 'entities';
type PreviewableStageId = Exclude<StageId, 'fts' | 'vectors'>;
type ParsingRoute = 'direct' | 'mammoth' | 'mineru' | 'unsupported';

interface PipelineStage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail: string;
  cacheFile: string;
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.log', '.xml', '.html', '.htm',
]);
const STATUS_META: Record<StageStatus, { label: string; color: string; Icon: LucideIcon }> = {
  done: { label: '完成', color: 'teal', Icon: Check },
  running: { label: '运行中', color: 'blue', Icon: Loader },
  pending: { label: '待执行', color: 'orange', Icon: Clock },
  error: { label: '失败', color: 'red', Icon: AlertCircle },
  waiting: { label: '等待中', color: 'gray', Icon: CircleDashed },
  cancelled: { label: '已取消', color: 'gray', Icon: CircleDashed },
  skipped: { label: '已跳过', color: 'gray', Icon: CircleDashed },
};

export default function MaterialsPipelineView({ library, documents, onBack, onOpenParsingSettings, onOpenModelSettings, onConfigureChunking, chunkingConfigRevision }: MaterialsPipelineViewProps) {
  useI18n();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(documents[0]?.id ?? null);
  const [activeStageId, setActiveStageId] = useState<StageId | null>(null);
  const [parsingConfig, setParsingConfig] = useState<ParsingConfig | null>(null);
  const [chunkingConfig, setChunkingConfig] = useState<LibraryChunkingConfig | null>(null);
  const [graphConfig, setGraphConfig] = useState<LibraryGraphEnhancementConfig | null>(null);
  const [graphConfigSaving, setGraphConfigSaving] = useState(false);
  const [graphConfigError, setGraphConfigError] = useState<string | null>(null);
  const [graphStatus, setGraphStatus] = useState<LibraryGraphProjectionStatus | null>(null);
  const [graphDrawerOpened, setGraphDrawerOpened] = useState(false);
  const [graphCommunities, setGraphCommunities] = useState<LibraryGraphCommunityRow[] | null>(null);
  const [modelHub, setModelHub] = useState<ModelHub | null>(null);
  const [embeddingProfileStatus, setEmbeddingProfileStatus] = useState<MaterialEmbeddingProfileStatus | null>(null);
  const [embeddingSource, setEmbeddingSource] = useState('ollama');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingTest, setEmbeddingTest] = useState<MaterialEmbeddingProfileTestResult | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState<'loading' | 'testing' | 'locking' | null>(null);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const [lockConfirmOpened, setLockConfirmOpened] = useState(false);
  const [llmSettingsOpened, setLlmSettingsOpened] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [pipelineLlm, setPipelineLlm] = useState<LibraryPipelineLlmBinding>({ schemaVersion: 1, source: '', model: '' });
  const [pipelineLlmSavedJson, setPipelineLlmSavedJson] = useState<string | null>(null);
  const llmPendingSaves = useRef(0);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmSaveRetry, setLlmSaveRetry] = useState(0);
  const [pipelineStatuses, setPipelineStatuses] = useState<PipelineDocumentStatus[]>([]);
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgressEvent | null>(null);
  const [artifactPreviewStageId, setArtifactPreviewStageId] = useState<PreviewableStageId | null>(null);
  const [artifactPreviewFileName, setArtifactPreviewFileName] = useState<string | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<PipelineArtifactPreview | null>(null);
  const [artifactPreviewMode, setArtifactPreviewMode] = useState<ArtifactPreviewMode>('json');
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [keywordResources, setKeywordResources] = useState<PipelineKeywordResources | null>(null);
  const [keywordSettingsSaving, setKeywordSettingsSaving] = useState(false);
  const [keywordSettingsError, setKeywordSettingsError] = useState<string | null>(null);
  const [keywordPreviewOpened, setKeywordPreviewOpened] = useState(false);
  const [keywordPreview, setKeywordPreview] = useState<PipelineKeywordPreview | null>(null);
  const [keywordPreviewLoading, setKeywordPreviewLoading] = useState(false);
  const [keywordPreviewError, setKeywordPreviewError] = useState<string | null>(null);

  const loadEmbeddingConfig = useCallback(async () => {
    setEmbeddingBusy('loading');
    try {
      const [hub, profile] = await Promise.all([
        window.electronAPI.getModelHub(),
        window.electronAPI.getMaterialEmbeddingProfile(library.path),
      ]);
      setModelHub(hub);
      setEmbeddingProfileStatus(profile);
      if (profile.state !== 'LOCKED') {
        const slot = hub.slots.embedding;
        setEmbeddingSource(slot.source || 'ollama');
        setEmbeddingModel(slot.model || hub.ollamaEmbeddingPresets[0] || '');
      }
      setEmbeddingTest(null);
      setEmbeddingError(null);
    } catch (error) {
      setEmbeddingError(error instanceof Error ? error.message : String(error));
    } finally {
      setEmbeddingBusy(null);
    }
  }, [library.path]);

  useEffect(() => {
    void window.electronAPI.getParsingConfig().then(setParsingConfig).catch(() => setParsingConfig(null));
    void window.electronAPI.getLibraryChunkingConfig(library.path).then(setChunkingConfig).catch(() => setChunkingConfig(null));
    void window.electronAPI.getLibraryGraphEnhancementConfig(library.path).then(setGraphConfig).catch(() => setGraphConfig(null));
    void window.electronAPI.getLibraryGraphStatus(library.path).then(setGraphStatus).catch(() => setGraphStatus(null));
    void window.electronAPI.getPipelineKeywordResources(library.path).then(setKeywordResources).catch(() => setKeywordResources(null));
    void loadEmbeddingConfig();
    void window.electronAPI.getLibraryPipelineLlm(library.path).then((binding) => {
      setPipelineLlmSavedJson(JSON.stringify(binding));
      setPipelineLlm(binding);
    }).catch(() => setPipelineLlm({ schemaVersion: 1, source: '', model: '' }));
    void window.electronAPI.getMaterialsPipelineStatus(library.path).then(setPipelineStatuses).catch(() => setPipelineStatuses([]));
    const unsubscribeStatus = window.electronAPI.onPipelineStatus((status) => {
      if (status.libraryPath !== library.path) return;
      setPipelineStatuses((previous) => {
        const next = previous.filter((item) => item.documentId !== status.documentId);
        return [...next, status];
      });
      setPipelineProgress((previous) => {
        if (!previous || previous.documentId !== status.documentId) return previous;
        const progressStage = status.stages?.[previous.stage];
        return progressStage?.status === 'RUNNING' && progressStage.jobId === previous.jobId
          ? previous
          : null;
      });
    });
    const unsubscribeProgress = window.electronAPI.onPipelineProgress((progress) => {
      if (progress.libraryPath === library.path) setPipelineProgress(progress);
    });
    return () => {
      unsubscribeStatus();
      unsubscribeProgress();
    };
  }, [library.path, chunkingConfigRevision, loadEmbeddingConfig]);

  const embeddingCandidate = useMemo(() => buildEmbeddingCandidate(modelHub, embeddingSource, embeddingModel), [modelHub, embeddingSource, embeddingModel]);
  const embeddingTestMatchesCurrent = Boolean(embeddingTest && embeddingCandidate && JSON.stringify(embeddingTest.candidate) === JSON.stringify(embeddingCandidate));

  useEffect(() => {
    const json = JSON.stringify(pipelineLlm);
    if (pipelineLlmSavedJson === null || (pipelineLlmSavedJson === json && llmPendingSaves.current === 0)) { setLlmSaving(false); return; }
    let current = true;
    setLlmSaving(llmPendingSaves.current > 0);
    const timer = window.setTimeout(() => {
      setLlmSaving(true);
      llmPendingSaves.current += 1;
      // 只有成功回执才能确认保存；迟到的旧配置回执不能覆盖正在编辑的新配置。
      void window.electronAPI.saveLibraryPipelineLlm(library.path, pipelineLlm).then(() => {
        if (!current) return;
        setPipelineLlmSavedJson(json); setLlmError(null); setLlmSaving(false);
      }).catch((error) => {
        if (!current) return;
        setLlmError(error instanceof Error ? error.message : String(error)); setLlmSaving(false);
      }).finally(() => { llmPendingSaves.current -= 1; setLlmSaving(llmPendingSaves.current > 0); });
    }, 500);
    return () => { current = false; window.clearTimeout(timer); };
  }, [pipelineLlm, library.path, pipelineLlmSavedJson, llmSaveRetry]);
  const llmModelOptions = useMemo(() => generationModelOptions(modelHub, pipelineLlm.source), [modelHub, pipelineLlm.source]);

  const testEmbeddingProfile = async () => {
    if (!embeddingCandidate) {
      setEmbeddingError(t("请先选择向量来源和模型。"));
      return;
    }
    setEmbeddingBusy('testing');
    setEmbeddingError(null);
    setEmbeddingTest(null);
    try {
      const result = await window.electronAPI.testMaterialEmbeddingProfile(library.path, embeddingCandidate);
      setEmbeddingTest(result);
    } catch (error) {
      setEmbeddingError(error instanceof Error ? error.message : String(error));
    } finally {
      setEmbeddingBusy(null);
    }
  };

  const lockTestedEmbeddingProfile = async () => {
    if (!embeddingCandidate || !embeddingTestMatchesCurrent) {
      setEmbeddingError(t("请先测试当前向量模型；模型或连接变化后需要重新测试。"));
      setLockConfirmOpened(false);
      return;
    }
    setEmbeddingBusy('locking');
    setEmbeddingError(null);
    try {
      const profile = await window.electronAPI.lockMaterialEmbeddingProfile(library.path, embeddingCandidate);
      setEmbeddingProfileStatus({ state: 'LOCKED', profile });
      setEmbeddingTest(null);
      setLockConfirmOpened(false);
      setPipelineStatuses(await window.electronAPI.getMaterialsPipelineStatus(library.path));
    } catch (error) {
      setEmbeddingError(error instanceof Error ? error.message : String(error));
    } finally {
      setEmbeddingBusy(null);
    }
  };

  const libraryIcon = getMaterialsIconOption(library.icon);
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) ?? documents[0] ?? null;
  const selectedPipelineStatus = selectedDocument ? pipelineStatuses.find((status) => status.documentId === selectedDocument.id) ?? null : null;
  const visiblePipelineProgress = pipelineProgress && selectedDocument && selectedPipelineStatus
    && pipelineProgress.documentId === selectedDocument.id
    && selectedPipelineStatus.stages?.[pipelineProgress.stage]?.status === 'RUNNING'
    && selectedPipelineStatus.stages[pipelineProgress.stage]?.jobId === pipelineProgress.jobId
    ? pipelineProgress
    : null;

  const loadArtifactPreview = async (stageId: PreviewableStageId, fileName: string, offset = 0) => {
    if (!selectedDocument || !window.electronAPI) return;
    setArtifactPreviewFileName(fileName);
    setArtifactPreviewLoading(true);
    setArtifactPreviewError(null);
    try {
      const preview = await window.electronAPI.getPipelineArtifactPreview(library.path, selectedDocument.id, stageId, fileName, offset, 40);
      setArtifactPreview(preview);
    } catch (error) {
      setArtifactPreviewError(error instanceof Error ? error.message : String(error));
      setArtifactPreview(null);
    } finally {
      setArtifactPreviewLoading(false);
    }
  };

  const loadArtifactChildren = async (parentChunkId: string, offset = 0): Promise<PipelineArtifactPreview> => {
    if (!selectedDocument || !window.electronAPI) throw new Error(t("当前资料文档不可用。"));
    return window.electronAPI.getPipelineArtifactPreview(
      library.path,
      selectedDocument.id,
      'chunks',
      'children.jsonl',
      offset,
      20,
      parentChunkId,
    );
  };

  const openArtifactPreview = (stage: PipelineStage) => {
    if (!isPreviewableStageId(stage.id) || stage.status !== 'done') return;
    setActiveStageId(null);
    if (stage.id === 'keywords') {
      setKeywordPreviewOpened(true);
      setKeywordPreview(null);
      setKeywordPreviewError(null);
      void loadKeywordPreview(0);
      return;
    }
    const outputNames = Object.keys(selectedPipelineStatus?.stages?.[stage.id]?.outputs ?? {});
    const fileName = choosePreviewFile(outputNames);
    if (!fileName) return;
    setArtifactPreviewStageId(stage.id);
    setArtifactPreviewMode(getDefaultArtifactPreviewMode(stage.id, fileName));
    setArtifactPreview(null);
    setArtifactPreviewError(null);
    void loadArtifactPreview(stage.id, fileName);
  };

  const loadKeywordPreview = async (offset = 0) => {
    if (!selectedDocument || !window.electronAPI) return;
    setKeywordPreviewLoading(true);
    setKeywordPreviewError(null);
    try {
      const preview = await window.electronAPI.getPipelineKeywordPreview(library.path, selectedDocument.id, offset, 20);
      setKeywordPreview(preview);
    } catch {
      setKeywordPreviewError(t("关键词预览暂时不可用，请先重新处理该文档。"));
      setKeywordPreview(null);
    } finally {
      setKeywordPreviewLoading(false);
    }
  };

  const saveKeywordConfig = async (patch: Partial<import('../electron').KeywordExtractionConfig>) => {
    if (!window.electronAPI) return;
    setKeywordSettingsSaving(true);
    setKeywordSettingsError(null);
    try {
      await window.electronAPI.savePipelineKeywordConfig(library.path, patch);
      const resources = await window.electronAPI.getPipelineKeywordResources(library.path);
      setKeywordResources(resources);
      setPipelineStatuses(await window.electronAPI.getMaterialsPipelineStatus(library.path));
    } catch {
      setKeywordSettingsError(t("关键词设置保存失败，请检查输入后重试。"));
    } finally {
      setKeywordSettingsSaving(false);
    }
  };

  const saveGraphEnhancementConfig = async (patch: Partial<LibraryGraphEnhancementConfig>) => {
    if (!window.electronAPI) return;
    setGraphConfigSaving(true);
    setGraphConfigError(null);
    try {
      const saved = await window.electronAPI.saveLibraryGraphEnhancementConfig(library.path, patch);
      setGraphConfig(saved);
      setPipelineStatuses(await window.electronAPI.getMaterialsPipelineStatus(library.path));
      void window.electronAPI.getLibraryGraphStatus(library.path).then(setGraphStatus).catch(() => setGraphStatus(null));
    } catch (error) {
      setGraphConfigError(error instanceof Error ? error.message : t("图谱增强设置保存失败。"));
    } finally {
      setGraphConfigSaving(false);
    }
  };

  const saveKeywordDictionary = async (content: string) => {
    if (!window.electronAPI) return;
    setKeywordSettingsSaving(true);
    setKeywordSettingsError(null);
    try {
      const resources = await window.electronAPI.savePipelineKeywordDictionary(library.path, content);
      setKeywordResources(resources);
      setPipelineStatuses(await window.electronAPI.getMaterialsPipelineStatus(library.path));
    } catch {
      setKeywordSettingsError(t("业务词典保存失败，请检查词条数量和长度后重试。"));
    } finally {
      setKeywordSettingsSaving(false);
    }
  };

  const closeArtifactPreview = () => {
    setArtifactPreviewStageId(null);
    setArtifactPreviewFileName(null);
    setArtifactPreview(null);
    setArtifactPreviewMode('json');
    setArtifactPreviewError(null);
  };

  const previewFileNames = artifactPreviewStageId
    ? Object.keys(selectedPipelineStatus?.stages?.[artifactPreviewStageId]?.outputs ?? {})
    : [];

  const selectedStages = selectedDocument ? buildStages(selectedDocument, chunkingConfig, graphConfig, selectedPipelineStatus) : [];
  const activeStage = selectedStages.find((stage) => stage.id === activeStageId) ?? null;

  const runParse = async () => {
    if (!selectedDocument || !window.electronAPI) return;
    try {
      const next = selectedPipelineStatus?.state === 'FAILED_RETRYABLE' || selectedPipelineStatus?.state === 'FAILED' || selectedPipelineStatus?.state === 'INTERRUPTED'
        ? await window.electronAPI.retryMaterialsPipeline(library.path, selectedDocument.id)
        : await window.electronAPI.startMaterialsPipeline(library.path, selectedDocument.id);
      setPipelineStatuses((previous) => [...previous.filter((item) => item.documentId !== next.documentId), next]);
    } catch (error) {
      setPipelineStatuses((previous) => [...previous.filter((item) => item.documentId !== selectedDocument.id), {
        libraryPath: library.path,
        documentId: selectedDocument.id,
        documentName: selectedDocument.name,
        extension: selectedDocument.extension,
        route: resolveParsingRoute(selectedDocument.extension),
        sourceContentHash: selectedDocument.contentHash,
        stage: 'parse',
        state: 'FAILED',
        error: { code: 'PIPELINE_START_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true },
        updatedAt: new Date().toISOString(),
      }]);
    }
  };

  const cancelParse = async () => {
    if (!selectedDocument || !window.electronAPI) return;
    const next = await window.electronAPI.cancelMaterialsPipeline(library.path, selectedDocument.id);
    setPipelineStatuses((previous) => [...previous.filter((item) => item.documentId !== next.documentId), next]);
  };

  const openGraphDrawer = () => {
    setGraphDrawerOpened(true);
    setGraphCommunities(null);
    void window.electronAPI.getLibraryGraphCommunities(library.path).then(setGraphCommunities).catch(() => setGraphCommunities([]));
  };

  return (
    <section className="materials-pipeline-view">
      <header className="materials-pipeline-header">
        <Group wrap="nowrap" gap="sm" justify="space-between">
          <Group wrap="nowrap" gap="sm">
            <ActionIcon variant="subtle" color="gray" aria-label={t("返回文档列表")} onClick={onBack}>
              <ArrowLeft size={16} />
            </ActionIcon>
            <ThemeIcon size={34} radius="md" variant="light" color={libraryIcon.color}>
              <libraryIcon.Icon size={17} />
            </ThemeIcon>
            <Stack gap={0} miw={0}>
              <Group gap={6} wrap="nowrap">
                <Text fw={700} truncate>{library.alias}</Text>
                <Badge size="xs" variant="light" color="blue">{t("处理工作台 · P6")}</Badge>
                {graphStatus ? (
                  <Tooltip label={t("点击查看知识图谱社区与摘要（只读）")} position="bottom" withArrow>
                    <Badge
                      size="xs"
                      variant="light"
                      color="violet"
                      leftSection={<Share2 size={10} />}
                      style={{ cursor: 'pointer' }}
                      onClick={openGraphDrawer}
                    >
                      {t("图谱")} {graphStatus.entityCount} {t("实体 ·")} {graphStatus.relationCount} {t("边 ·")} {graphStatus.levels} {t("层 · 摘要")} {graphStatus.summaryCoverage}/{graphStatus.communityCount}
                    </Badge>
                  </Tooltip>
                ) : null}
              </Group>
              <Text size="xs" c="dimmed">{t("切块、关键词与流水线链路")}</Text>
            </Stack>
          </Group>
          <Tooltip label={t("资料库模型设置")} position="bottom" withArrow>
            <ActionIcon variant="subtle" color="gray" aria-label={t("资料库模型设置")} onClick={() => setLlmSettingsOpened(true)}>
              <Settings2 size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </header>

      <ScrollArea>
        <Stack gap="md" className="materials-pipeline-body">
          <VectorProfileSummary
            status={embeddingProfileStatus}
            busy={embeddingBusy}
            onRefresh={() => void loadEmbeddingConfig()}
            onOpenSettings={() => setLlmSettingsOpened(true)}
          />
          <MaterialVectorGenerationsPanel libraryPath={library.path} status={embeddingProfileStatus} hub={modelHub} onChanged={loadEmbeddingConfig} />
          <Paper withBorder radius="md" p="md">
            <Stack gap="sm">
              <Group justify="space-between" wrap="wrap" align="flex-end">
                <Text fw={650} size="sm">{t("流水线链路")}</Text>
                {documents.length > 0 ? (
                  <Select
                    size="xs"
                    w={260}
                    label={t("查看文档")}
                    placeholder={t("选择文档")}
                    searchable
                    data={documents.map((document) => ({ value: document.id, label: document.name }))}
                    value={selectedDocument?.id ?? null}
                    onChange={(value) => setSelectedDocumentId(value)}
                  />
                ) : null}
              </Group>

              {documents.length === 0 || !selectedDocument ? (
                <Text size="xs" c="dimmed" ta="center" py="xl">{t("暂无文档，返回上传后可查看处理链路。")}</Text>
              ) : (
                <>
                  <div className="materials-pipeline-track">
                    {selectedStages.map((stage, index) => {
                      const meta = STATUS_META[stage.status];
                      const previous = index > 0 ? selectedStages[index - 1] : null;
                      return (
                        <div
                          key={stage.id}
                          className="materials-pipeline-step"
                          role="button"
                          tabIndex={0}
                          onClick={() => setActiveStageId(stage.id)}
                          onKeyDown={(event) => { if (event.key === 'Enter') setActiveStageId(stage.id); }}
                        >
                          {previous ? <div className={`materials-pipeline-connector ${previous.status === 'done' ? 'done' : ''}`} /> : null}
                          <div className={`materials-pipeline-bullet ${stage.status}`}><meta.Icon size={13} /></div>
                          <Text size="xs" fw={600}>{t(stage.label)}</Text>
                          <Badge size="xs" variant="light" color={meta.color}>{stageStatusLabel(stage, selectedPipelineStatus)}</Badge>
                        </div>
                      );
                    })}
                  </div>

                  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
                    {selectedStages.map((stage) => {
                      const meta = STATUS_META[stage.status];
                      return (
                        <Paper
                          key={stage.id}
                          withBorder
                          radius="sm"
                          p="sm"
                          className="materials-stage-card"
                          onClick={() => setActiveStageId(stage.id)}
                        >
                          <Stack gap={6} className="materials-stage-card-content">
                            <Group gap={6} justify="space-between" wrap="nowrap">
                              <Text size="xs" fw={650}>{t(stage.label)}</Text>
                              <Badge size="xs" variant="light" color={meta.color}>{stageStatusLabel(stage, selectedPipelineStatus)}</Badge>
                            </Group>
                            <Text size="xs" c="dimmed" lineClamp={2}>{t(stage.detail)}</Text>
                            <Group gap={6} wrap="nowrap">
                              <Package size={12} />
                              <Text size="xs" c="dimmed" truncate>{stageArtifactLabel(stage)}</Text>
                            </Group>
                            <Group gap={6} className="materials-stage-card-actions" wrap="nowrap">
                              <Button
                                size="compact-xs"
                                variant="light"
                                leftSection={<Settings2 size={12} />}
                                onClick={(event) => { event.stopPropagation(); stage.id === 'chunks' ? onConfigureChunking() : setActiveStageId(stage.id); }}
                              >
                                {stage.id === 'fts' ? t("详情") : t("配置")}
                              </Button>
                              {isPreviewableStageId(stage.id) && stage.status === 'done' ? (
                                <Button
                                  size="compact-xs"
                                  variant="default"
                                  leftSection={<Package size={12} />}
                                  onClick={(event) => { event.stopPropagation(); openArtifactPreview(stage); }}
                                >
                                  {t("预览")}
                                </Button>
                              ) : null}
                              {stage.id === 'fts' && selectedDocument && canRetryStage(stage, selectedPipelineStatus) ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={(event) => { event.stopPropagation(); void runParse(); }}>
                                  {t("重建")}
                                </Button>
                              ) : stage.id === 'vectors' && stage.status === 'waiting' ? (
                                <Button size="compact-xs" variant="light" leftSection={<Settings2 size={12} />} onClick={(event) => { event.stopPropagation(); setActiveStageId('vectors'); }}>
                                  {t("配置向量模型")}
                                </Button>
                              ) : stage.id === 'vectors' && stage.status === 'pending' ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={(event) => { event.stopPropagation(); void runParse(); }}>
                                  {t("运行")}
                                </Button>
                              ) : stage.id === 'vectors' && stage.status === 'running' ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={(event) => { event.stopPropagation(); void cancelParse(); }}>{t("取消")}</Button>
                              ) : stage.id === 'vectors' && selectedDocument && canRetryStage(stage, selectedPipelineStatus) ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={(event) => { event.stopPropagation(); void runParse(); }}>{t("重试")}</Button>
                              ) : stage.id === 'entities' && stage.status === 'waiting' && selectedPipelineStatus?.stages?.entities?.status === 'WAITING_CONFIG' ? (
                                <Button size="compact-xs" variant="light" leftSection={<Settings2 size={12} />} onClick={(event) => { event.stopPropagation(); onOpenModelSettings(); }}>
                                  {t("配置生成模型")}
                                </Button>
                              ) : isPreviewableStageId(stage.id) && selectedDocument && canRunParse(selectedDocument.extension) && canRetryStage(stage, selectedPipelineStatus) ? (
                                <Button
                                  size="compact-xs"
                                  variant="default"
                                  leftSection={<RefreshCw size={12} />}
                                  onClick={(event) => { event.stopPropagation(); void runParse(); }}
                                >
                                  {t("重试")}
                                </Button>
                              ) : stage.id === 'parse' && selectedDocument && canRunParse(selectedDocument.extension) && stage.status === 'running' ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={() => void cancelParse()}>{t("取消")}</Button>
                              ) : stage.id === 'parse' && selectedDocument && canRunParse(selectedDocument.extension) && stage.status === 'pending' ? (
                                <Button size="compact-xs" variant="default" leftSection={<RefreshCw size={12} />} onClick={() => void runParse()}>
                                  {t("运行")}
                                </Button>
                              ) : stage.id === 'parse' && selectedDocument && resolveParsingRoute(selectedDocument.extension) === 'mineru' && stage.status === 'waiting' ? (
                                <Button size="compact-xs" variant="light" leftSection={<Settings2 size={12} />} onClick={onOpenParsingSettings}>{t("配置 MinerU")}</Button>
                              ) : null}
                            </Group>
                          </Stack>
                        </Paper>
                      );
                    })}
                  </SimpleGrid>

                   <Alert icon={<Info size={13} />} color="blue" variant="light" py={6}>
                     {t("当前链路为“关键词 → FTS5 索引 → 向量化”；FTS5 使用 Jieba 词元建立原文与关键词倒排，向量不可用时仍可独立检索。")}
                  </Alert>
                  {visiblePipelineProgress ? (
                    <Stack gap={4}>
                      <Group justify="space-between" gap="xs">
                        <Text size="xs" c="dimmed">{visiblePipelineProgress.message}</Text>
                        <Text size="xs" c="dimmed">{visiblePipelineProgress.total ? `${visiblePipelineProgress.completed}/${visiblePipelineProgress.total}` : t("处理中")}</Text>
                      </Group>
                      <Progress size="xs" value={visiblePipelineProgress.total ? (visiblePipelineProgress.completed / visiblePipelineProgress.total) * 100 : 12} animated />
                    </Stack>
                  ) : null}
                </>
              )}
            </Stack>
          </Paper>
        </Stack>
      </ScrollArea>

      <Modal
        opened={lockConfirmOpened}
        onClose={() => setLockConfirmOpened(false)}
        title={t("锁定资料库向量模型")}
        centered
        size="md"
      >
        <Stack gap="md">
          <Alert icon={<LockKeyhole size={15} />} color="orange" variant="light">
            {t("锁定后，这个资料库的文档向量和后续 query 向量都必须使用同一语义空间。普通设置中不能更换模型；如需迁移，必须建立新的索引代际。")}
          </Alert>
          {embeddingCandidate && embeddingTest ? (
            <Paper withBorder radius="sm" p="sm">
              <Stack gap={6}>
                <Text size="sm" fw={650}>{embeddingCandidate.requestedModel}</Text>
                <Text size="xs" c="dimmed">{embeddingCandidate.sourceId} · {embeddingCandidate.endpointIdentity}</Text>
                <Group gap="xs"><Badge size="sm" color="teal">{t("已测试")}</Badge><Text size="xs">{embeddingTest.vectorDimension} {t("维 · cosine · float32")}</Text></Group>
              </Stack>
            </Paper>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setLockConfirmOpened(false)}>{t("返回修改")}</Button>
            <Button color="blue" loading={embeddingBusy === 'locking'} disabled={!embeddingTestMatchesCurrent} leftSection={<LockKeyhole size={14} />} onClick={() => void lockTestedEmbeddingProfile()}>
              {t("确认并锁定")}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={llmSettingsOpened}
        onClose={() => setLlmSettingsOpened(false)}
        title={t("资料库模型设置")}
        centered
        size="lg"
      >
        <Stack gap="lg">
          <Stack gap="sm">
            <Group gap={6}>
              <ThemeIcon size={20} radius="sm" variant="light" color="blue"><ShieldCheck size={12} /></ThemeIcon>
              <Text size="sm" fw={650}>{t("资料库向量语义空间")}</Text>
            </Group>
            <VectorProfileSettings
              status={embeddingProfileStatus}
              hub={modelHub}
              source={embeddingSource}
              model={embeddingModel}
              candidate={embeddingCandidate}
              tested={embeddingTest}
              testedMatchesCurrent={embeddingTestMatchesCurrent}
              busy={embeddingBusy}
              error={embeddingError}
              onSourceChange={(value) => {
                setEmbeddingSource(value);
                setEmbeddingModel(modelOptions(modelHub, value)[0] ?? '');
                setEmbeddingTest(null);
                setEmbeddingError(null);
              }}
              onModelChange={(value) => {
                setEmbeddingModel(value);
                setEmbeddingTest(null);
                setEmbeddingError(null);
              }}
              onTest={() => void testEmbeddingProfile()}
              onOpenLockConfirm={() => setLockConfirmOpened(true)}
              onOpenModelSettings={onOpenModelSettings}
            />
          </Stack>
          <Divider />
          <Stack gap="sm">
            <Group gap={6}>
              <ThemeIcon size={20} radius="sm" variant="light" color="violet"><BrainCircuit size={12} /></ThemeIcon>
              <Text size="sm" fw={650}>{t("语言模型绑定")}</Text>
            </Group>
            <Text size="xs" c="dimmed">
              {t("为该资料库的歧义消解、智能切块与图谱增强指定语言模型；密钥沿用“模型与连接”的厂商连接。绑定独立于向量锁定，可随时更改，更改后相关阶段缓存自动失效。")}
            </Text>
            <Select
            size="sm"
            label={t("语言模型来源")}
            data={[{ value: '', label: t("跟随全局“模型与连接”") }, { value: 'ollama', label: t("本地 Ollama") }, ...(modelHub?.providers ?? []).map((item) => ({ value: item.id, label: item.hasKey ? item.label : t("{0}（未配置密钥）", { '0': item.label }) }))]}
            value={pipelineLlm.source}
            onChange={(value) => {
              setLlmError(null);
              setPipelineLlm((previous) => ({ ...previous, source: value ?? '', model: '' }));
            }}
            disabled={!modelHub}
          />
          <Autocomplete
            size="sm"
            label={t("语言模型")}
            description={pipelineLlm.source ? (llmModelOptions.length ? t("可使用候选，也可输入私有部署模型名。") : t("输入该连接下的生成模型名。")) : t("未绑定时使用全局生成槽位模型。")}
            data={llmModelOptions}
            value={pipelineLlm.model}
            onChange={(value) => {
              setLlmError(null);
              setPipelineLlm((previous) => ({ ...previous, model: value }));
            }}
            disabled={!modelHub || !pipelineLlm.source}
            placeholder={pipelineLlm.source ? t("例如 qwen-plus") : t("跟随全局")}
          />
          {pipelineLlmSavedJson !== JSON.stringify(pipelineLlm) || llmPendingSaves.current > 0 ? (
            <Alert icon={<Info size={15} />} color="gray" variant="light">{t(llmError ? "语言模型绑定尚未保存。" : llmSaving ? "正在保存语言模型绑定…" : "语言模型绑定待保存。")}</Alert>
          ) : pipelineLlm.source && pipelineLlm.model.trim() ? (
            <Alert icon={<Check size={15} />} color="teal" variant="light">{t("已绑定：")}{pipelineLlm.source} · {pipelineLlm.model.trim()}</Alert>
          ) : (
            <Alert icon={<Info size={15} />} color="gray" variant="light">{t("当前跟随全局生成槽位模型。")}</Alert>
          )}
          {llmError ? (
            <Alert icon={<AlertCircle size={15} />} color="red" variant="light">
              <Group justify="space-between" align="center" gap="sm" wrap="wrap">
                <Text size="xs">{llmError}</Text>
                <Button size="compact-xs" variant="light" color="red" loading={llmSaving} onClick={() => { setLlmError(null); setLlmSaveRetry(value => value + 1); }}>{t("重试保存")}</Button>
              </Group>
            </Alert>
          ) : null}
          </Stack>
        </Stack>
      </Modal>

      <Modal
        opened={activeStage !== null}
        onClose={() => setActiveStageId(null)}
        title={activeStage ? `${activeStage.label} · ${activeStage.id === 'fts' ? t("索引状态") : t("阶段配置")}` : ''}
        centered
        size="lg"
      >
        {activeStage ? (
          <Stack gap="md">
            <Group gap={8} wrap="nowrap">
              <Badge size="xs" variant="light" color={STATUS_META[activeStage.status].color}>
                {stageStatusLabel(activeStage, selectedPipelineStatus)}
              </Badge>
              <Text size="xs" c="dimmed">{activeStage.detail}</Text>
            </Group>

            <div>
              <Text size="xs" fw={650} mb={6}>{activeStage.id === 'fts' ? t("索引状态") : t("阶段配置")}</Text>
              {activeStage.id === 'parse' ? <ParsingStageConfig document={selectedDocument} parsingConfig={parsingConfig} onOpenParsingSettings={onOpenParsingSettings} /> : null}
              {activeStage.id === 'lines' ? (
                <Alert icon={<Info size={13} />} color="blue" variant="light" py={6}>
                  {t("从 01-parse/document.md 逐行生成 02-lines/lines.jsonl，保留 rawText、normalizedText、blockId、页码和 sourceRef；空行不在此阶段删除。")}
                </Alert>
              ) : null}
              {activeStage.status === 'waiting' && activeStage.id !== 'parse' ? (
                <Alert icon={<Clock size={13} />} color="orange" variant="light" py={6}>
                  {t("上游阶段尚未完成，请先处理前置阶段；流水线会在上游产物校验通过后自动继续。")}
                </Alert>
              ) : null}
              {activeStage.id === 'signals' ? (
                <Alert icon={<Info size={13} />} color="teal" variant="light" py={6}>
                  {t("逐批读取逻辑行，按空行、分隔符、噪声、标题、步骤、表格、引用、列表到 BODY 的固定优先级分类。候选标题暂不调用模型，保留 ruleId、置信度和上下文供 P4 判定。")}
                </Alert>
              ) : null}
              {activeStage.id === 'ambiguity' ? (
                <Alert icon={<Info size={13} />} color="violet" variant="light" py={6}>
                  {t("只将置信度落在配置区间内的 HEADING_CANDIDATE 发送给已配置的生成模型；输出必须匹配候选 signalId、HEADING/LIST_ITEM 枚举和 0～1 置信度。超时、网络错误或非法 JSON 都会静默回退到规则结果，详见 04-ambiguity/ambiguity-report.json。")}
                </Alert>
              ) : null}
              {activeStage.id === 'tree' ? (
                <Alert icon={<Info size={13} />} color="blue" variant="light" py={6}>
                  {t("从 04-ambiguity/ambiguity.jsonl 线性扫描生成 05-tree/structure.jsonl。每个节点保留 nodeId、parentId、path、行号、信号来源和 childCount，并在完成时检查根节点、父节点和行号关系。")}
                </Alert>
              ) : null}
              {activeStage.id === 'chunks' ? <ChunkingStageConfig config={chunkingConfig} onConfigure={onConfigureChunking} /> : null}
              {activeStage.id === 'keywords' ? (
                <KeywordStageConfig
                  resources={keywordResources}
                  saving={keywordSettingsSaving}
                  error={keywordSettingsError}
                  onSaveConfig={saveKeywordConfig}
                  onSaveDictionary={saveKeywordDictionary}
                />
              ) : null}
              {activeStage.id === 'fts' ? <FtsStageFact status={selectedPipelineStatus?.ftsIndex} /> : null}
              {activeStage.id === 'vectors' ? (
                <VectorStageFact status={embeddingProfileStatus} pipelineStatus={selectedPipelineStatus} onOpenSettings={onOpenModelSettings} />
              ) : null}
              {activeStage.id === 'entities' ? (
                <GraphEnhancementPanel
                  config={graphConfig}
                  chunkCount={Number(selectedPipelineStatus?.stages?.chunks?.counts?.children ?? selectedPipelineStatus?.stages?.chunks?.counts?.chunks ?? 0)}
                  saving={graphConfigSaving}
                  error={graphConfigError}
                  onSave={(patch) => void saveGraphEnhancementConfig(patch)}
                />
              ) : null}
            </div>

            <div>
              <Text size="xs" fw={650} mb={6}>{t("缓存产物")}</Text>
              <Paper withBorder radius="sm" p="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap={6} wrap="nowrap" miw={0}>
                      <Package size={13} />
                      <Text size="xs" c="dimmed" truncate>{stageArtifactLabel(activeStage)}</Text>
                    </Group>
                  <Badge size="xs" variant="light" color={STATUS_META[activeStage.status].color}>{stageStatusLabel(activeStage, selectedPipelineStatus)}</Badge>
                  </Group>
                <Group justify="space-between" align="center" mt={4}>
                  <Text size="xs" c="dimmed">{t("每个阶段的输出独立缓存；重试时会先校验上游产物，不会读取失效缓存。")}</Text>
                  {isPreviewableStageId(activeStage.id) && activeStage.status === 'done' ? (
                    <Button size="compact-xs" variant="light" leftSection={<Package size={12} />} onClick={() => openArtifactPreview(activeStage)}>
                      {t("预览产物")}
                    </Button>
                  ) : null}
                </Group>
              </Paper>
            </div>

            <Group justify="flex-end">
              {activeStage.id === 'fts' && selectedDocument && canRetryStage(activeStage, selectedPipelineStatus) ? (
                <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void runParse()}>{t("重建 FTS5 索引")}</Button>
              ) : isPreviewableStageId(activeStage.id) && selectedDocument && canRunParse(selectedDocument.extension) && canRetryStage(activeStage, selectedPipelineStatus) ? (
                <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void runParse()}>{t("重试此阶段")}</Button>
              ) : activeStage.id === 'vectors' && activeStage.status === 'waiting' ? (
                <Button size="xs" variant="light" leftSection={<Settings2 size={14} />} onClick={onOpenModelSettings}>{t("打开模型与连接")}</Button>
              ) : activeStage.id === 'vectors' && activeStage.status === 'pending' ? (
                <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void runParse()}>{t("运行向量化")}</Button>
              ) : activeStage.id === 'vectors' && activeStage.status === 'running' ? (
                <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void cancelParse()}>{t("取消向量化")}</Button>
              ) : activeStage.id === 'vectors' && canRetryStage(activeStage, selectedPipelineStatus) ? (
                <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void runParse()}>{t("重试向量化")}</Button>
              ) : activeStage.id === 'entities' && activeStage.status === 'waiting' && selectedPipelineStatus?.stages?.entities?.status === 'WAITING_CONFIG' ? (
                <Button size="xs" variant="light" leftSection={<Settings2 size={14} />} onClick={onOpenModelSettings}>{t("打开模型与连接")}</Button>
              ) : activeStage.id === 'parse' && selectedDocument && canRunParse(selectedDocument.extension) && (activeStage.status === 'running' || activeStage.status === 'pending') ? (
                activeStage.status === 'running'
                  ? <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void cancelParse()}>{t("取消解析")}</Button>
                  : <Button size="xs" leftSection={<RefreshCw size={14} />} onClick={() => void runParse()}>{t("运行此阶段")}</Button>
              ) : activeStage.id === 'parse' && selectedDocument && resolveParsingRoute(selectedDocument.extension) === 'mineru' && activeStage.status === 'waiting' ? (
                <Button size="xs" leftSection={<Settings2 size={14} />} onClick={onOpenParsingSettings}>{t("配置 MinerU")}</Button>
              ) : null}
              <Button size="xs" variant="default" onClick={() => setActiveStageId(null)}>{t("关闭")}</Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <KeywordPreviewModal
        opened={keywordPreviewOpened}
        preview={keywordPreview}
        loading={keywordPreviewLoading}
        error={keywordPreviewError}
        onClose={() => {
          setKeywordPreviewOpened(false);
          setKeywordPreview(null);
          setKeywordPreviewError(null);
        }}
        onLoadPage={(offset) => void loadKeywordPreview(offset)}
      />

      <Modal
        opened={artifactPreviewStageId !== null}
        onClose={closeArtifactPreview}
        title={t("{0} · 产物预览", { '0': selectedStages.find((stage) => stage.id === artifactPreviewStageId)?.label ?? t("阶段") })}
        centered
        size="xl"
      >
        <Stack gap="sm">
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              label={t("选择产物")}
              w={300}
              data={previewFileNames.map((fileName) => ({ value: fileName, label: previewFileLabel(fileName) }))}
              value={artifactPreviewFileName}
              onChange={(value) => {
                if (value && artifactPreviewStageId) {
                  setArtifactPreviewMode(getDefaultArtifactPreviewMode(artifactPreviewStageId, value));
                  void loadArtifactPreview(artifactPreviewStageId, value);
                }
              }}
              placeholder={t("选择阶段产物")}
            />
            {artifactPreview ? (
              <Text size="xs" c="dimmed">
                {artifactPreview.relativePath} · {formatBytes(artifactPreview.bytes)} {t("· 共")} {artifactPreview.lineCount} {t("行")}
              </Text>
            ) : null}
          </Group>

          {artifactPreviewLoading ? (
            <Stack gap={6} py="xl">
              <Group justify="center"><Loader size={22} /></Group>
              <Text size="xs" c="dimmed" ta="center">{t("正在读取当前页产物，不会加载整个大文件。")}</Text>
            </Stack>
          ) : artifactPreviewError ? (
            <Alert icon={<AlertCircle size={14} />} color="red" variant="light">
              {artifactPreviewError}
            </Alert>
          ) : artifactPreview ? (
            <>
              <PipelineArtifactPreviewContent
                preview={artifactPreview}
                mode={artifactPreviewMode}
                onModeChange={setArtifactPreviewMode}
                onLoadChildren={loadArtifactChildren}
              />
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {t("第")} {artifactPreview.rows[0]?.lineNumber ?? 0}–{artifactPreview.rows.at(-1)?.lineNumber ?? 0} {t("行")}
                </Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="default"
                    disabled={artifactPreview.offset <= 0 || artifactPreviewLoading || !artifactPreviewFileName || !artifactPreviewStageId}
                    onClick={() => {
                      if (artifactPreviewStageId && artifactPreviewFileName) void loadArtifactPreview(artifactPreviewStageId, artifactPreviewFileName, Math.max(0, artifactPreview.offset - artifactPreview.limit));
                    }}
                  >
                    {t("上一页")}
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={!artifactPreview.hasMore || artifactPreviewLoading || !artifactPreviewFileName || !artifactPreviewStageId}
                    onClick={() => {
                      if (artifactPreviewStageId && artifactPreviewFileName) void loadArtifactPreview(artifactPreviewStageId, artifactPreviewFileName, artifactPreview.offset + artifactPreview.limit);
                    }}
                  >
                    {t("下一页")}
                  </Button>
                </Group>
              </Group>
            </>
          ) : (
            <Text size="xs" c="dimmed" ta="center" py="xl">{t("请选择一个已完成阶段的产物。")}</Text>
          )}
        </Stack>
      </Modal>

      <GraphCommunityDrawer
        opened={graphDrawerOpened}
        status={graphStatus}
        communities={graphCommunities}
        onClose={() => setGraphDrawerOpened(false)}
      />
    </section>
  );
}

function buildStages(document: MaterialsDocument, chunkingConfig: LibraryChunkingConfig | null, graphConfig: LibraryGraphEnhancementConfig | null, pipelineStatus: PipelineDocumentStatus | null): PipelineStage[] {
  const parsingRoute = resolveParsingRoute(document.extension);
  const parseStatus = toStageStatus(pipelineStatus?.stages?.parse?.status ?? (pipelineStatus?.stage === 'parse' ? pipelineStatus.state : undefined));
  const linesStatus = toStageStatus(pipelineStatus?.stages?.lines?.status ?? (pipelineStatus?.stage === 'lines' ? pipelineStatus.state : undefined));
  const signalsStatus = toStageStatus(pipelineStatus?.stages?.signals?.status ?? (pipelineStatus?.stage === 'signals' ? pipelineStatus.state : undefined));
  const ambiguityStatus = toStageStatus(pipelineStatus?.stages?.ambiguity?.status ?? (pipelineStatus?.stage === 'ambiguity' ? pipelineStatus.state : undefined));
  const treeStatus = toStageStatus(pipelineStatus?.stages?.tree?.status ?? (pipelineStatus?.stage === 'tree' ? pipelineStatus.state : undefined));
  const chunksStatus = toStageStatus(pipelineStatus?.stages?.chunks?.status ?? (pipelineStatus?.stage === 'chunks' ? pipelineStatus.state : undefined));
  const keywordsStatus = toStageStatus(pipelineStatus?.stages?.keywords?.status ?? (pipelineStatus?.stage === 'keywords' ? pipelineStatus.state : undefined));
  const ftsStatus = toFtsStageStatus(pipelineStatus?.ftsIndex);
  const vectorsStatus = toStageStatus(pipelineStatus?.stages?.vectors?.status ?? (pipelineStatus?.stage === 'vectors' ? pipelineStatus.state : undefined));
  const entitiesStatus = toStageStatus(pipelineStatus?.stages?.entities?.status ?? (pipelineStatus?.stage === 'entities' ? pipelineStatus.state : undefined));
  const parseCache = pipelineStatus?.stages?.parse?.artifactPath ? `${pipelineStatus.stages.parse.artifactPath}/blocks.jsonl` : '01-parse/未生成';
  const linesCache = pipelineStatus?.stages?.lines?.artifactPath ? `${pipelineStatus.stages.lines.artifactPath}/lines.jsonl` : '02-lines/未生成';
  const signalsCache = pipelineStatus?.stages?.signals?.artifactPath ? `${pipelineStatus.stages.signals.artifactPath}/signals.jsonl` : '03-signals/未生成';
  const ambiguityCache = pipelineStatus?.stages?.ambiguity?.artifactPath ? `${pipelineStatus.stages.ambiguity.artifactPath}/ambiguity.jsonl` : '04-ambiguity/未生成';
  const treeCache = pipelineStatus?.stages?.tree?.artifactPath ? `${pipelineStatus.stages.tree.artifactPath}/structure.jsonl` : '05-tree/未生成';
  const chunksCache = pipelineStatus?.stages?.chunks?.artifactPath ? `${pipelineStatus.stages.chunks.artifactPath}/chunks.jsonl` : '06-chunks/未生成';
  const keywordsCache = pipelineStatus?.stages?.keywords?.artifactPath ? `${pipelineStatus.stages.keywords.artifactPath}/keywords.jsonl` : '07-keywords/未生成';
  const ftsCache = '.menghan-meta/index.db · material_chunk_fts';
  const vectorsCache = pipelineStatus?.stages?.vectors?.artifactPath ? `${pipelineStatus.stages.vectors.artifactPath}/vector-report.json` : '08-vectors/未生成';
  const entitiesCache = pipelineStatus?.stages?.entities?.artifactPath ? `${pipelineStatus.stages.entities.artifactPath}/entities.jsonl` : '09-entities/未生成';
  const stages: PipelineStage[] = [
    { id: 'parse', label: t("解析"), status: parseStatus, detail: parseDetail(parsingRoute, pipelineStatus), cacheFile: parseCache },
    { id: 'lines', label: t("逻辑行"), status: linesStatus, detail: linesDetail(pipelineStatus), cacheFile: linesCache },
    { id: 'signals', label: t("规则信号"), status: signalsStatus, detail: signalsDetail(pipelineStatus), cacheFile: signalsCache },
    { id: 'ambiguity', label: t("歧义消解"), status: ambiguityStatus, detail: ambiguityDetail(pipelineStatus), cacheFile: ambiguityCache },
    { id: 'tree', label: t("结构树"), status: treeStatus, detail: treeDetail(pipelineStatus), cacheFile: treeCache },
    { id: 'chunks', label: t("父子切块"), status: chunksStatus, detail: chunksDetail(pipelineStatus, chunkingConfig), cacheFile: chunksCache },
    { id: 'keywords', label: t("关键词"), status: keywordsStatus, detail: keywordsDetail(pipelineStatus), cacheFile: keywordsCache },
    { id: 'fts', label: t("FTS5索引"), status: ftsStatus, detail: ftsDetail(pipelineStatus), cacheFile: ftsCache },
    { id: 'vectors', label: t("向量化"), status: vectorsStatus, detail: vectorsDetail(pipelineStatus), cacheFile: vectorsCache },
    { id: 'entities', label: t("图谱增强"), status: entitiesStatus, detail: entitiesDetail(pipelineStatus, graphConfig), cacheFile: entitiesCache },
  ];
  return stages.map((stage, index) => {
    if (index === 0 || stage.status === 'skipped' || stages[index - 1].status === 'done') return stage;
    const upstream = stages[index - 1];
    return {
      ...stage,
      status: 'waiting',
      detail: t("等待上游阶段“{0}”完成后再执行。", { '0': upstream.label }),
    };
  });
}

function isPreviewableStageId(stageId: StageId): stageId is PreviewableStageId {
  return stageId === 'parse' || stageId === 'lines' || stageId === 'signals' || stageId === 'ambiguity' || stageId === 'tree' || stageId === 'chunks' || stageId === 'keywords' || stageId === 'entities';
}

function choosePreviewFile(fileNames: string[]): string | null {
  const preferred = ['parents.jsonl', 'children.jsonl', 'chunks.jsonl', 'chunk-plan.json', 'chunks-report.json', 'document.md', 'lines.jsonl', 'signals.jsonl', 'ambiguity.jsonl', 'structure.jsonl', 'keywords.jsonl', 'entities.jsonl', 'relations.jsonl', 'extraction-report.json', 'blocks.jsonl', 'parse-report.json', 'tree-report.json', 'keyword-report.json', 'structure.json'];
  return preferred.find((fileName) => fileNames.includes(fileName)) ?? fileNames[0] ?? null;
}

function previewFileLabel(fileName: string): string {
  if (fileName === 'parents.jsonl') return t("parents.jsonl · Parent 回答上下文");
  if (fileName === 'children.jsonl') return t("children.jsonl · Child 检索单元");
  if (fileName === 'chunks.jsonl') return t("chunks.jsonl · Child 兼容投影");
  if (fileName === 'chunk-plan.json') return t("chunk-plan.json · 执行计划");
  if (fileName === 'chunks-report.json') return t("chunks-report.json · 执行报告");
  return fileName;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toStageStatus(state: PipelineDocumentStatus['state'] | undefined): StageStatus {
  if (state === 'RUNNING' || state === 'QUEUED') return 'running';
  if (state === 'SUCCEEDED') return 'done';
  if (state === 'SKIPPED') return 'skipped';
  if (state === 'FAILED' || state === 'FAILED_RETRYABLE' || state === 'INTERRUPTED') return 'error';
  if (state === 'CANCELLED') return 'cancelled';
  if (state === 'WAITING_CONFIG') return 'waiting';
  return 'pending';
}

function toFtsStageStatus(status: PipelineDocumentStatus['ftsIndex']): StageStatus {
  if (status?.state === 'CURRENT') return 'done';
  if (status?.state === 'MISSING' || status?.state === 'STALE' || status?.state === 'FAILED') return 'error';
  return 'pending';
}

function canRetryStage(stage: PipelineStage, status: PipelineDocumentStatus | null): boolean {
  if (stage.id === 'fts') return stage.status === 'error' && status?.ftsIndex?.error?.retryable === true;
  if (stage.status === 'cancelled') return true;
  if (stage.status !== 'error') return false;
  const stageManifest = status?.stages?.[stage.id];
  const state = stageManifest?.status ?? (status?.stage === stage.id ? status.state : undefined);
  const error = stageManifest?.error ?? (status?.stage === stage.id ? status.error : undefined);
  return state === 'FAILED_RETRYABLE' || state === 'INTERRUPTED' || error?.retryable === true;
}

function stageStatusLabel(stage: PipelineStage, status: PipelineDocumentStatus | null): string {
  if (stage.id === 'fts' && stage.status === 'error' && canRetryStage(stage, status)) return t("需重建");
  if (stage.status === 'error' && canRetryStage(stage, status)) return t("失败可重试");
  return t(STATUS_META[stage.status].label);
}

function parseDetail(route: ParsingRoute, status: PipelineDocumentStatus | null): string {
  const parseStage = status?.stages?.parse;
  if (route === 'mineru') {
    if (parseStage?.status === 'WAITING_CONFIG') return t("PDF 固定交给 MinerU；请先完成独立授权配置。");
    if (parseStage?.status === 'SUCCEEDED') return t("MinerU 解析完成：{0} 个文档块。", { '0': parseStage.counts?.blocks ?? 0 });
    if (parseStage?.error) return `${parseStage.error.message}${parseStage.error.retryable ? t(" 可重试。") : ''}`;
    return t("PDF 固定交给 MinerU，结果下载后只保存在本地缓存。");
  }
  if (route === 'direct') {
    if (parseStage?.status === 'SUCCEEDED') return t("文本直读完成：{0} 行，已生成统一块缓存。", { '0': parseStage.counts?.lines ?? 0 });
    if (parseStage?.error) return `${parseStage.error.message}${parseStage.error.retryable ? t(" 可重试。") : ''}`;
    return t("文本资料直接读取，不经过 Mammoth 或 MinerU。");
  }
  if (route === 'unsupported') return status?.error?.message ?? t("当前格式暂不支持解析。");
  if (parseStage?.status === 'SUCCEEDED') return t("Mammoth 解析完成：{0} 个文档块。", { '0': parseStage.counts?.blocks ?? 0 });
  if (parseStage?.error) return `${parseStage.error.message}${parseStage.error.retryable ? t(" 可重试。") : ''}`;
  return t("DOCX 交给本机 Mammoth 解析。");
}

function linesDetail(status: PipelineDocumentStatus | null): string {
  if (status?.stages?.lines?.status === 'SUCCEEDED') return t("逻辑行完成：{0} 行，保留来源映射。", { '0': status.stages.lines.counts?.lines ?? 0 });
  if (status?.stages?.lines?.error) return `${status.stages.lines.error.message}${status.stages.lines.error.retryable ? t(" 可重试。") : ''}`;
  return t("按紧凑 document.md 逐行生成 lines.jsonl，并保留被压缩空行的判定上下文。");
}

function signalsDetail(status: PipelineDocumentStatus | null): string {
  if (status?.stages?.signals?.status === 'SUCCEEDED') return t("规则信号完成：{0} 个信号，候选 {1} 条。", { '0': status.stages.signals.counts?.signals ?? 0, '1': status.stages.signals.counts?.headingCandidates ?? 0 });
  if (status?.stages?.signals?.error) return `${status.stages.signals.error.message}${status.stages.signals.error.retryable ? t(" 可重试。") : ''}`;
  return t("固定优先级分类，批量写入 signals.jsonl，并保存 checkpoint。");
}

function ambiguityDetail(status: PipelineDocumentStatus | null): string {
  if (status?.stages?.ambiguity?.status === 'SUCCEEDED') {
    const counts = status.stages.ambiguity.counts ?? {};
    if (counts.requests === 0) return t("歧义消解完成：未发起模型请求，候选 {0} 条均保留规则结果。", { '0': counts.candidates ?? 0 });
    return t("歧义消解完成：{0} 条已采用模型判定，{1} 条回退规则结果。", { '0': counts.applied ?? 0, '1': counts.fallbackCandidates ?? 0 });
  }
  if (status?.stages?.ambiguity?.error) return `${status.stages.ambiguity.error.message}${status.stages.ambiguity.error.retryable ? t(" 可重试。") : ''}`;
  return t("仅处理低置信度标题候选；模型关闭、不可用或输出非法时静默回退。");
}

function treeDetail(status: PipelineDocumentStatus | null): string {
  if (status?.stages?.tree?.status === 'SUCCEEDED') return t("结构树完成：{0} 个节点，最大深度 {1}。", { '0': status.stages.tree.counts?.nodes ?? 0, '1': status.stages.tree.counts?.maxDepth ?? 0 });
  if (status?.stages?.tree?.error) return `${status.stages.tree.error.message}${status.stages.tree.error.retryable ? t(" 可重试。") : ''}`;
  return t("线性扫描恢复标题、列表和正文父子关系，保留来源回溯。");
}

function chunksDetail(status: PipelineDocumentStatus | null, config: LibraryChunkingConfig | null): string {
  if (status?.stages?.chunks?.status === 'SUCCEEDED') {
    const counts = status.stages.chunks.counts ?? {};
    const parents = counts.parents;
    const children = counts.children ?? counts.chunks ?? 0;
    return parents === undefined
      ? t("兼容切块完成：{0} 个 chunk。", { '0': children })
      : t("父子切块完成：{0} 个 Parent、{1} 个 Child；chunks.jsonl 保留 Child 兼容投影。", { '0': parents, '1': children });
  }
  if (status?.stages?.chunks?.error) return `${status.stages.chunks.error.message}${status.stages.chunks.error.retryable ? t(" 可重试。") : ''}`;
  if (!config) return t("正在读取资料库切块策略。");
  const parent = strategyNames(config.parentStrategies);
  const child = config.mode === 'recommended' ? t("按质量自动推荐") : strategyNames(config.childStrategies);
  return t("Parent {0}；Child {1}；长度 {2}/{3}/{4}。", { '0': parent, '1': child, '2': config.parentMinChars, '3': config.parentTargetChars, '4': config.parentMaxChars });
}

function keywordsDetail(status: PipelineDocumentStatus | null): string {
  if (status?.stages?.keywords?.status === 'SUCCEEDED') {
    const counts = status.stages.keywords.counts ?? {};
    return t("关键词完成：{0} 个关键词，覆盖 {1} 个子块。", { '0': counts.keywords ?? 0, '1': counts.chunks ?? 0 });
  }
  if (status?.stages?.keywords?.error) {
    const error = status.stages.keywords.error;
    return `${error.message}${error.retryable ? t(" 可重试。") : ''}`;
  }
  return t("从子块原文提取 Top-K 关键词，点击产物可查看证据和评分特征。");
}

function ftsDetail(status: PipelineDocumentStatus | null): string {
  const index = status?.ftsIndex;
  if (index?.state === 'CURRENT') {
    return t("FTS5 完成：{0}/{1} 个子块已用 Jieba 建立倒排，关键词 {2} 条。", { '0': index.ftsRows, '1': index.expectedChunks, '2': index.indexedKeywords });
  }
  if (index?.error) return index.error.message;
  return t("等待关键词阶段完成后，由 Electron 在 SQLite 事务中写入 Jieba 词元倒排。");
}

function vectorsDetail(status: PipelineDocumentStatus | null): string {
  const stage = status?.stages?.vectors;
  if (stage?.status === 'SUCCEEDED') {
    const counts = stage.counts ?? {};
    return t("向量完成：{0}/{1} 个子块已落库，profile 已校验。", { '0': counts.indexed ?? 0, '1': counts.chunks ?? 0 });
  }
  if (stage?.status === 'RUNNING' || stage?.status === 'QUEUED') {
    const counts = stage.counts ?? {};
    return counts.chunks ? t("正在生成向量：{0}/{1} 个子块。", { '0': counts.indexed ?? 0, '1': counts.chunks }) : t("正在按批次生成并写入 sqlite-vec。");
  }
  if (stage?.error) return `${stage.error.message}${stage.error.retryable ? t(" 可重试。") : ''}`;
  if (stage?.status === 'WAITING_CONFIG') return t("请先测试并锁定资料库向量模型。");
  return t("使用资料库锁定 profile，按 contentHash 增量写入 08-vectors。");
}

function entitiesDetail(status: PipelineDocumentStatus | null, graphConfig: LibraryGraphEnhancementConfig | null): string {
  const stage = status?.stages?.entities;
  if (!graphConfig?.enabled) return t("图谱增强未开启。开启后将由生成模型对子块抽取实体与关系。");
  if (stage?.status === 'SUCCEEDED') {
    const counts = stage.counts ?? {};
    return t("实体抽取完成：{0} 实体、{1} 关系，请求成功 {2}/{3}。", { '0': counts.entities ?? 0, '1': counts.relations ?? 0, '2': counts.succeeded ?? 0, '3': counts.requests ?? 0 });
  }
  if (stage?.status === 'RUNNING' || stage?.status === 'QUEUED') return t("正在调用生成模型抽取实体与关系。");
  if (stage?.status === 'WAITING_CONFIG') return stage?.error?.message ?? t("请先在设置中选择生成模型，再运行实体抽取。");
  if (stage?.error) return `${stage.error.message}${stage.error.retryable ? t(" 可重试。") : ''}`;
  return t("开启后按子块调用生成模型，生成 entities.jsonl 与 relations.jsonl 作为图谱输入。");
}

function modelOptions(hub: ModelHub | null, source: string): string[] {
  if (!hub) return [];
  if (source === 'ollama') return Array.from(new Set(hub.ollamaEmbeddingPresets));
  const provider = hub.providers.find((item) => item.id === source);
  return provider ? Array.from(new Set([...provider.embeddingPresets, ...provider.models])) : [];
}

function generationModelOptions(hub: ModelHub | null, source: string): string[] {
  if (!hub || source === 'ollama' || !source) return [];
  const provider = hub.providers.find((item) => item.id === source);
  return provider ? Array.from(new Set(provider.models)) : [];
}

function buildEmbeddingCandidate(hub: ModelHub | null, source: string, model: string): MaterialEmbeddingCandidate | null {
  const requestedModel = model.trim();
  if (!hub || !requestedModel) return null;
  const isOllama = source === 'ollama';
  const provider = isOllama ? null : hub.providers.find((item) => item.id === source);
  const endpoint = (isOllama ? hub.ollamaEndpoint : provider?.endpoint || provider?.defaultEndpoint || '').trim();
  if (!endpoint) return null;
  return {
    schemaVersion: 1,
    sourceId: source,
    transportKind: isOllama ? 'ollama' : 'openai-compatible',
    endpointIdentity: endpoint,
    requestedModel,
    vectorType: 'float32',
    distanceMetric: 'cosine',
    encodingFormat: 'float',
    truncateInputs: false,
    documentInputVersion: 'material-chunk-text-v1',
    queryInputVersion: 'material-query-text-v1',
  };
}

function VectorProfileSummary({ status, busy, onRefresh, onOpenSettings }: {
  status: MaterialEmbeddingProfileStatus | null;
  busy: 'loading' | 'testing' | 'locking' | null;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  useI18n();
  const locked = status?.state === 'LOCKED' && status.profile;
  return (
    <Paper withBorder radius="md" p="md" className="materials-vector-profile-panel">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={38} radius="md" variant="light" color={locked ? 'teal' : 'blue'}>
            {locked ? <LockKeyhole size={18} /> : <ShieldCheck size={18} />}
          </ThemeIcon>
          <Box>
            <Text fw={700} size="sm">{t("资料库向量语义空间")}</Text>
            <Text size="xs" c="dimmed" mt={3}>{t("先测试，再锁定；锁定后只读，避免索引与检索使用不同模型。")}</Text>
          </Box>
        </Group>
        <Group gap="xs">
          <Badge variant="light" color={locked ? 'teal' : status?.state === 'LEGACY_UNBOUND' ? 'orange' : 'gray'}>
            {locked ? t("LOCKED · 已锁定") : status?.state === 'LEGACY_UNBOUND' ? t("需要迁移") : status ? t("UNBOUND · 未锁定") : t("读取中")}
          </Badge>
          <ActionIcon variant="subtle" color="gray" aria-label={t("刷新向量 profile")} onClick={onRefresh} disabled={busy !== null}>
            <RefreshCw size={15} />
          </ActionIcon>
          <Button size="compact-xs" variant="light" leftSection={<Settings2 size={12} />} onClick={onOpenSettings}>{t("配置")}</Button>
        </Group>
      </Group>
      {locked ? (
        <Paper withBorder radius="sm" p="sm" mt="md" style={{ background: 'var(--mantine-color-teal-light)' }}>
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
            <Box>
              <Text size="sm" fw={650}>{locked.responseModel ?? locked.requestedModel}</Text>
              <Text size="xs" c="dimmed" mt={3}>{locked.sourceId} · {locked.endpointIdentity}</Text>
            </Box>
            <Badge color="teal" variant="filled">{locked.vectorDimension} {t("维 · cosine")}</Badge>
          </Group>
          <Divider my="sm" />
          <Group gap="xs" wrap="wrap">
            <Text size="xs" c="dimmed">profileHash</Text>
            <Text size="xs" ff="monospace">{locked.profileHash.slice(0, 16)}…</Text>
            <Text size="xs" c="dimmed">{t("锁定于")} {formatDateTime(locked.lockedAt)}</Text>
          </Group>
        </Paper>
      ) : status?.state === 'LEGACY_UNBOUND' ? (
        <Alert mt="md" icon={<AlertCircle size={15} />} color="orange" variant="light">
          {t("检测到未标识的旧向量索引。请先备份资料库并完成迁移，当前不会覆盖旧向量或自动切换模型。")}
        </Alert>
      ) : (
        <Alert mt="md" icon={<Info size={15} />} color="blue" variant="light">
          {t("尚未锁定向量模型；点击“配置”完成测试与锁定。")}
        </Alert>
      )}
    </Paper>
  );
}

function VectorProfileSettings({
  status,
  hub,
  source,
  model,
  candidate,
  tested,
  testedMatchesCurrent,
  busy,
  error,
  onSourceChange,
  onModelChange,
  onTest,
  onOpenLockConfirm,
  onOpenModelSettings,
}: {
  status: MaterialEmbeddingProfileStatus | null;
  hub: ModelHub | null;
  source: string;
  model: string;
  candidate: MaterialEmbeddingCandidate | null;
  tested: MaterialEmbeddingProfileTestResult | null;
  testedMatchesCurrent: boolean;
  busy: 'loading' | 'testing' | 'locking' | null;
  error: string | null;
  onSourceChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onTest: () => void;
  onOpenLockConfirm: () => void;
  onOpenModelSettings: () => void;
}) {
  useI18n();
  const locked = status?.state === 'LOCKED' && status.profile;
  const options = modelOptions(hub, source);
  return locked ? (
    <Stack gap="sm">
      <Paper withBorder radius="sm" p="sm" style={{ background: 'var(--mantine-color-teal-light)' }}>
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Box>
            <Text size="sm" fw={650}>{locked.responseModel ?? locked.requestedModel}</Text>
            <Text size="xs" c="dimmed" mt={3}>{locked.sourceId} · {locked.endpointIdentity}</Text>
          </Box>
          <Badge color="teal" variant="filled">{locked.vectorDimension} {t("维 · cosine")}</Badge>
        </Group>
        <Divider my="sm" />
        <Group gap="xs" wrap="wrap">
          <Text size="xs" c="dimmed">profileHash</Text>
          <Text size="xs" ff="monospace">{locked.profileHash.slice(0, 16)}…</Text>
          <Text size="xs" c="dimmed">{t("锁定于")} {formatDateTime(locked.lockedAt)}</Text>
        </Group>
      </Paper>
      <Text size="xs" c="dimmed">{t("该资料库已固定文档输入版本、查询输入版本、维度和距离度量。全局“模型与连接”仅影响其他未锁定资料库的候选，不会改变这里的 profile。")}</Text>
    </Stack>
  ) : status?.state === 'LEGACY_UNBOUND' ? (
    <Alert icon={<AlertCircle size={15} />} color="orange" variant="light">
      {t("检测到未标识的旧向量索引。请先备份资料库并完成迁移，当前不会覆盖旧向量或自动切换模型。")}
    </Alert>
  ) : (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Select
          size="sm"
          label={t("向量来源")}
          description={t("沿用全局连接；锁定时会把端点身份写入 profile。")}
          data={[{ value: 'ollama', label: t("本地 Ollama") }, ...(hub?.providers ?? []).map((item) => ({ value: item.id, label: item.hasKey ? item.label : t("{0}（未配置密钥）", { '0': item.label }) }))]}
          value={source}
          onChange={(value) => value && onSourceChange(value)}
          disabled={!hub || busy !== null}
        />
        <Autocomplete
          size="sm"
          label={t("向量模型")}
          description={options.length ? t("可使用候选，也可输入私有部署模型名。") : t("请在“模型与连接”中配置候选或连接。")}
          data={options}
          value={model}
          onChange={(value) => onModelChange(value)}
          disabled={!hub || busy !== null}
          placeholder={t("例如 bge-m3")}
        />
      </SimpleGrid>
      {candidate ? <Text size="xs" c="dimmed">{t("当前端点：")}{candidate.endpointIdentity} {t("· 输入版本：")}{candidate.documentInputVersion} {t("· 截断：关闭")}</Text> : null}
      {tested ? (
        <Alert icon={<Check size={15} />} color={testedMatchesCurrent ? 'teal' : 'orange'} variant="light">
          {testedMatchesCurrent ? t("测试通过：{0} 返回 {1} 维向量。", { '0': tested.responseModel ?? tested.candidate.requestedModel, '1': tested.vectorDimension }) : t("测试结果对应旧配置；模型或连接变化后必须重新测试。")}
        </Alert>
      ) : null}
      {error ? (
        <Alert icon={<AlertCircle size={15} />} color="red" variant="light">
          <Group justify="space-between" align="center" gap="sm" wrap="wrap">
            <Text size="xs">{error}</Text>
            <Button size="compact-xs" variant="light" color="red" leftSection={<KeyRound size={12} />} onClick={onOpenModelSettings}>{t("修复模型与密钥")}</Button>
          </Group>
        </Alert>
      ) : null}
      <Group justify="flex-end" gap="sm">
        <Button size="sm" variant="light" loading={busy === 'testing'} disabled={!candidate || busy !== null} leftSection={<TestTube2 size={14} />} onClick={onTest}>{t("测试连接与维度")}</Button>
        <Button size="sm" disabled={!testedMatchesCurrent || busy !== null} leftSection={<LockKeyhole size={14} />} onClick={onOpenLockConfirm}>{t("锁定此 profile")}</Button>
      </Group>
    </Stack>
  );
}

function VectorStageFact({ status, pipelineStatus, onOpenSettings }: { status: MaterialEmbeddingProfileStatus | null; pipelineStatus: PipelineDocumentStatus | null; onOpenSettings: () => void }) {
  useI18n();
  const profile = status?.profile;
  const stage = pipelineStatus?.stages?.vectors;
  if (!profile) return <Alert icon={<LockKeyhole size={14} />} color="orange" variant="light">{t("vectors 阶段需要先锁定资料库 profile。")}<Button size="compact-xs" variant="light" ml="sm" onClick={onOpenSettings}>{t("打开模型与连接")}</Button></Alert>;
  const counts = stage?.counts ?? {};
  return (
    <Stack gap="sm">
      <Alert icon={<ShieldCheck size={14} />} color="teal" variant="light">{t("当前阶段只接受已锁定 profile：")}{profile.responseModel ?? profile.requestedModel} · {profile.vectorDimension} {t("维 ·")} {profile.distanceMetric}。</Alert>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("已落库")}</Text><Text size="lg" fw={700}>{counts.indexed ?? 0}</Text></Paper>
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("跳过")}</Text><Text size="lg" fw={700}>{counts.skipped ?? 0}</Text></Paper>
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("批次 / 重试")}</Text><Text size="lg" fw={700}>{counts.batches ?? 0} / {counts.retries ?? 0}</Text></Paper>
      </SimpleGrid>
      {stage?.error ? <Alert icon={<AlertCircle size={14} />} color="red" variant="light">{stage.error.message}<Button size="compact-xs" variant="light" color="red" ml="sm" onClick={onOpenSettings}>{t("检查连接")}</Button></Alert> : null}
    </Stack>
  );
}

function FtsStageFact({ status }: { status: PipelineDocumentStatus['ftsIndex'] }) {
  useI18n();
  const current = status?.state === 'CURRENT';
  return (
    <Stack gap="sm">
      <Alert icon={current ? <Check size={14} /> : <Info size={14} />} color={current ? 'teal' : status?.error ? 'orange' : 'blue'} variant="light">
        {current
          ? t("资料全文索引已更新，可以搜索当前文档。")
          : status?.error?.message ?? t("关键词处理完成后会自动更新全文索引，无需额外选择模型。")}
      </Alert>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("可搜索片段")}</Text><Text size="lg" fw={700}>{status?.ftsRows ?? 0} / {status?.expectedChunks ?? 0}</Text></Paper>
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("已索引片段")}</Text><Text size="lg" fw={700}>{status?.indexedChunks ?? 0}</Text></Paper>
        <Paper withBorder radius="sm" p="sm"><Text size="xs" c="dimmed">{t("已索引关键词")}</Text><Text size="lg" fw={700}>{status?.indexedKeywords ?? 0}</Text></Paper>
      </SimpleGrid>
      <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>{t('查看技术详情')}</summary><Text size="xs" c="dimmed" mt={6}>{t("分词器：Jieba 精确模式（HMM 关闭） · FTS5 tokenizer：unicode61 · 原文保存在 material_chunks，空格分隔词元写入 material_chunk_fts。")}</Text></details>
      {status?.indexedAt ? <Text size="xs" c="dimmed">{t("最近落库：")}{formatDateTime(status.indexedAt)}</Text> : null}
    </Stack>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getAppLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
}

function stageArtifactLabel(stage: PipelineStage): string {
  if (stage.id === 'keywords') return stage.status === 'done' ? t("关键词结果已生成") : t("关键词结果");
  if (stage.id === 'fts') return 'index.db · material_chunk_fts';
  return stage.cacheFile;
}

function canRunParse(extension: string): boolean {
  const route = resolveParsingRoute(extension);
  return route !== 'unsupported';
}

function resolveParsingRoute(extension: string): ParsingRoute {
  if (TEXT_PREVIEW_EXTENSIONS.has(extension)) return 'direct';
  if (extension === '.docx') return 'mammoth';
  return extension === '.pdf' ? 'mineru' : 'unsupported';
}

function ParsingStageConfig({ document, parsingConfig, onOpenParsingSettings }: { document: MaterialsDocument | null; parsingConfig: ParsingConfig | null; onOpenParsingSettings: () => void }) {
  useI18n();
  const route = document ? resolveParsingRoute(document.extension) : 'direct';
  if (route === 'direct') {
    return <Alert icon={<Info size={13} />} color="gray" variant="light" py={6}>{t("文本类资料直接读取，导入后自动生成 document.md 与 blocks.jsonl，本地缓存供后续逐行扫描使用。")}</Alert>;
  }
  if (route === 'mammoth') return <Alert icon={<Info size={13} />} color="teal" variant="light" py={6}>{t("当前 DOCX 固定交给本机 Mammoth；内容不会离开此设备，也不需要 Python 解析运行时。")}</Alert>;
  if (route === 'unsupported') return <Alert icon={<AlertCircle size={13} />} color="red" variant="light" py={6}>{t("当前格式暂不支持解析。请先转换为 DOCX、PDF、Markdown 或纯文本。")}</Alert>;
  return <Stack gap="xs">
    <Alert icon={<Info size={13} />} color="orange" variant="light" py={6}>{t("PDF 固定交给 MinerU 官方云 API，不能切换为 Mammoth；任务完成后只保存统一解析产物，不保存完整远程响应。")}</Alert>
    <Group gap="xs" wrap="wrap">
      <Badge size="xs" variant="light" color={parsingConfig?.hasMineruKey ? 'teal' : 'orange'}>{parsingConfig?.hasMineruKey ? t("API Key 已配置") : t("API Key 未配置")}</Badge>
      <Button size="compact-xs" variant="light" leftSection={<Settings2 size={12} />} onClick={onOpenParsingSettings}>{t("配置 MinerU")}</Button>
    </Group>
  </Stack>;
}

function ChunkingStageConfig({ config, onConfigure }: { config: LibraryChunkingConfig | null; onConfigure: () => void }) {
  useI18n();
  if (!config) return <Alert icon={<Info size={13} />} color="gray" variant="light" py={6}>{t("正在读取当前资料库的父子切块策略。")}</Alert>;
  return (
    <Stack gap="sm">
      <Alert icon={<Info size={13} />} color="blue" variant="light" py={6}>
        <Text size="xs">{t("配置计划：Parent")} {strategyNames(config.parentStrategies)}；Child {config.mode === 'recommended' ? t("按文档质量自动推荐") : strategyNames(config.childStrategies)}{t("。所有 Child 自动保留章节路径，并可回到对应 Parent。")}</Text>
      </Alert>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <Paper withBorder radius="sm" p="xs"><Text size="xs" c="dimmed">{t("最低字数")}</Text><Text size="sm" fw={650}>{config.parentMinChars}</Text></Paper>
        <Paper withBorder radius="sm" p="xs"><Text size="xs" c="dimmed">{t("目标字数")}</Text><Text size="sm" fw={650}>{config.parentTargetChars}</Text></Paper>
        <Paper withBorder radius="sm" p="xs"><Text size="xs" c="dimmed">{t("最大字数")}</Text><Text size="sm" fw={650}>{config.parentMaxChars}</Text></Paper>
      </SimpleGrid>
      <Text size="xs" c="dimmed">{t("保存策略后仅会重新安排 06-chunks 及其下游阶段，已完成的结构树可以继续复用。")}</Text>
      <Group justify="flex-end"><Button size="xs" leftSection={<Settings2 size={13} />} onClick={onConfigure}>{t("调整切块策略")}</Button></Group>
    </Stack>
  );
}

function strategyNames(strategies: string[]): string {
  const labels: Record<string, string> = { STRUCTURE: t("结构"), RECURSIVE: t("递归"), SEMANTIC: t("语义"), LLM: 'LLM', PAGE: t("按页"), REGEX: t("正则"), FIXED: t("固定长度") };
  return strategies.map((strategy) => labels[strategy] ?? strategy).join(' → ');
}

function GraphEnhancementPanel({ config, chunkCount, saving, error, onSave }: {
  config: LibraryGraphEnhancementConfig | null;
  chunkCount: number;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<LibraryGraphEnhancementConfig>) => void;
}) {
  useI18n();
  if (!config) return <Alert icon={<Info size={13} />} color="gray" variant="light" py={6}>{t("正在读取当前资料库的图谱增强配置。")}</Alert>;
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Box>
          <Text size="sm" fw={650}>{t("实体与关系抽取（可选）")}</Text>
          <Text size="xs" c="dimmed" mt={3}>{t("默认关闭。开启后由生成模型对每个子块抽取实体与关系，产物写入 09-entities，供后续图谱检索使用。")}</Text>
        </Box>
        <Switch
          checked={config.enabled}
          disabled={saving}
          label={config.enabled ? t("已开启") : t("未开启")}
          onChange={(event) => onSave({ enabled: event.currentTarget.checked })}
        />
      </Group>
      {config.enabled ? (
        <Alert icon={<Info size={13} />} color="blue" variant="light" py={6}>
          <Text size="xs">{t("成本预估：当前文档约")} {chunkCount} {t("个子块，每 3 个子块为一批（不截断原文），预计调用生成模型约")} {Math.max(1, Math.ceil(chunkCount / 3))} {t("次；每个实体与关系都必须携带可召回原文的证据，无法给出出处的条目会被丢弃。")}</Text>
        </Alert>
      ) : (
        <Text size="xs" c="dimmed">{t("开启前请确认已在“模型与连接”中配置可用的生成模型；模型不可用时阶段会进入等待配置状态，不影响其他阶段。")}</Text>
      )}
      {error ? <Alert icon={<AlertCircle size={13} />} color="red" variant="light" py={6}><Text size="xs">{error}</Text></Alert> : null}
    </Stack>
  );
}

/** 图谱社区浏览抽屉（方案 §4.4）：只读展示社区层级与摘要，不提供编辑与引用。 */
function GraphCommunityDrawer({ opened, status, communities, onClose }: {
  opened: boolean;
  status: LibraryGraphProjectionStatus | null;
  communities: LibraryGraphCommunityRow[] | null;
  onClose: () => void;
}) {
  useI18n();
  const levels = useMemo(() => {
    if (!communities || communities.length === 0) return [] as Array<{ level: number; items: LibraryGraphCommunityRow[] }>;
    const grouped = new Map<number, LibraryGraphCommunityRow[]>();
    for (const community of communities) {
      const list = grouped.get(community.level) ?? [];
      list.push(community);
      grouped.set(community.level, list);
    }
    return [...grouped.entries()]
      .sort((first, second) => second[0] - first[0])
      .map(([level, items]) => ({ level, items }));
  }, [communities]);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title={<Text fw={650} size="sm">{t("知识图谱社区浏览")}</Text>}>
      <Stack gap="sm">
        {status ? (
          <Text size="xs" c="dimmed">
            {t("引擎")} {status.engine || t("未知")} · {status.entityCount} {t("实体 ·")} {status.relationCount} {t("边 ·")} {status.communityCount} {t("社区 ·")} {status.levels} {t("层 · 摘要覆盖")} {status.summaryCoverage}/{status.communityCount}
            {status.summaryGeneratedAt ? t("（生成于 {0}）", { '0': new Date(status.summaryGeneratedAt).toLocaleString() }) : ''}
          </Text>
        ) : null}
        <Alert icon={<Info size={13} />} color="gray" variant="light" py={6}>
          <Text size="xs">{t("社区摘要只用于把握全局脉络，不能作为原文引用；事实结论请回到知识库问答的证据块。")}</Text>
        </Alert>
        {communities === null ? (
          <Group justify="center" py="xl"><Loader size={16} /><Text size="xs" c="dimmed">{t("正在读取社区摘要…")}</Text></Group>
        ) : levels.length === 0 ? (
          <Text size="xs" c="dimmed" ta="center" py="xl">{t("尚无社区摘要；开启图谱增强并完成库级图装配后自动生成。")}</Text>
        ) : (
          levels.map((group) => (
            <Stack key={group.level} gap={6}>
              <Text size="xs" fw={650}>{t("第")} {group.level} {t("层（")}{group.items.length} {t("个社区）")}</Text>
              {group.items.map((community) => (
                <Paper key={community.communityId} withBorder radius="sm" p="sm">
                  <Stack gap={4}>
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text size="xs" fw={600} truncate>{t("社区")} {community.communityId}</Text>
                      <Badge size="xs" variant="light" color="gray">{community.memberCount} {t("成员")}</Badge>
                    </Group>
                    {community.summary.trim() ? (
                      <Text size="xs" c="dimmed">{community.summary}</Text>
                    ) : (
                      <Text size="xs" c="dimmed" fs="italic">{t("摘要尚未生成。")}</Text>
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ))
        )}
      </Stack>
    </Drawer>
  );
}
