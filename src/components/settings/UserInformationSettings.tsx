import { localizeOptions, t, useI18n } from '../../i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Check, Database, FileDown, FileUp, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { MemoryProposalReviewDialog } from './MemoryProposalReviewDialog';
import { reviewReasonLabel } from './memoryPresentation';
import type { MemoryProposalContext, MemoryProposalReview, MemoryConsolidationPreview, MemoryPage, MemoryItemCounts } from '../../../electron/knowledge/memory/memoryTypes';
import type {
  ManualMemoryInput,
  MemoryDocumentAffinity,
  MemoryExtractionRuntimeStatus,
  MemoryItemPatch,
  MemoryItemRecord,
  MemorySubjectRecord,
  MemoryTopicRecord,
  WorkspaceMemoryConfig,
} from '../../electron';

type MemoryKind = MemoryItemRecord['kind'];
type MemoryView = 'active' | 'pending' | 'all' | 'topics' | 'documents';

const kindOptions: Array<{ value: MemoryKind; label: string }> = [
  { value: 'profile', label: '画像' },
  { value: 'preference', label: '偏好' },
  { value: 'fact', label: '事实' },
  { value: 'task', label: '任务' },
  { value: 'interest', label: '兴趣' },
];

const emptyDraft: ManualMemoryInput = { kind: 'fact', content: '', topic: '', importance: 3, expiresAt: null };
const memoryPageSize = 10;
type MemorySelection = { view: MemoryView; kindFilter: MemoryKind | 'all'; page: number };

export function UserInformationSettings({ setFeedback, setError, reviewRequest }: {
  setFeedback: (value: string | null) => void;
  setError: (value: string | null) => void;
  reviewRequest?: { itemId: string; requestId: number };
}) {
  useI18n();
  const [config, setConfig] = useState<WorkspaceMemoryConfig | null>(null);
  const [runtime, setRuntime] = useState<MemoryExtractionRuntimeStatus | null>(null);
  const [subject, setSubject] = useState<MemorySubjectRecord | null>(null);
  const [items, setItems] = useState<MemoryItemRecord[]>([]);
  const [topics, setTopics] = useState<MemoryTopicRecord[]>([]);
  const [documents, setDocuments] = useState<MemoryDocumentAffinity[]>([]);
  const [selection, setSelection] = useState<MemorySelection>({ view: 'active', kindFilter: 'all', page: 1 });
  const { view, kindFilter, page } = selection;
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 1 });
  const [itemCounts, setItemCounts] = useState<MemoryItemCounts>({ active: 0, pending: 0, all: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryItemRecord | null>(null);
  const [draft, setDraft] = useState<ManualMemoryInput>(emptyDraft);
  const [clearOpen, setClearOpen] = useState(false);
  const [reviewContext, setReviewContext] = useState<MemoryProposalContext | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [mergePreviews, setMergePreviews] = useState<MemoryConsolidationPreview[]>([]);
  const [mergeReviewOpen, setMergeReviewOpen] = useState(false);
  const [mergeReviewError, setMergeReviewError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const currentSelection = useRef(selection);
  useLayoutEffect(() => { currentSelection.current = selection; }, [selection]);
  const setView = useCallback((next: MemoryView) => setSelection(current => ({ ...current, view: next, page: 1 })), []);
  const setKindFilter = useCallback((next: MemoryKind | 'all') => setSelection(current => ({ ...current, kindFilter: next, page: 1 })), []);
  const setPage = useCallback((next: number) => setSelection(current => ({ ...current, page: next })), []);

  const load = useCallback(async (silent = false) => {
    if (currentSelection.current !== selection) return;
    const sequence = ++loadSequence.current;
    const isCurrent = () => sequence === loadSequence.current && currentSelection.current === selection;
    if (!silent) { setLoading(true); setError(null); }
    try {
      if (!window.electronAPI.listLongTermMemoryItemPage) throw new Error(t('请重启应用以加载记忆分页功能。'));
      const statuses = view === 'all'
        ? undefined
        : view === 'pending' ? ['pending' as const] : ['active' as const, 'pending' as const];
      const query = { page, pageSize: memoryPageSize };
      // Fetch only the selected tab; background refresh uses the same bounded page query.
      const selectedPage: Promise<MemoryPage<MemoryItemRecord | MemoryTopicRecord | MemoryDocumentAffinity>> = view === 'topics'
        ? window.electronAPI.listLongTermMemoryTopicPage(query)
        : view === 'documents' ? window.electronAPI.listLongTermMemoryDocumentPage(query)
        : window.electronAPI.listLongTermMemoryItemPage({ ...query,
          ...(statuses ? { statuses } : {}), ...(kindFilter === 'all' ? {} : { kinds: [kindFilter] }) });
      const [overview, result] = await Promise.all([
        window.electronAPI.getLongTermMemoryOverview(),
        selectedPage,
      ]);
      if (!isCurrent()) return;
      setConfig(overview.workspaceConfig);
      setSubject(overview.subject);
      setRuntime(overview.extractionRuntime);
      setItemCounts(overview.itemCounts);
      setPageInfo({ total: result.total, totalPages: result.totalPages });
      if (view === 'topics') setTopics(result.items as MemoryTopicRecord[]);
      else if (view === 'documents') setDocuments(result.items as MemoryDocumentAffinity[]);
      else setItems(result.items as MemoryItemRecord[]);
      if (result.page !== page) setSelection(current => current === selection ? { ...current, page: result.page } : current);
    } catch (loadError) {
      if (isCurrent() && !silent) setError(messageOf(loadError));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [kindFilter, page, selection, setError, view]);

  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, [load]);

  useEffect(() => {
    if (!reviewRequest) return;
    let mounted = true;
    setView('pending'); setReviewError(null);
    void window.electronAPI.getLongTermMemoryProposalContext(reviewRequest.itemId).then(context => { if (mounted) setReviewContext(context); })
      .catch(reviewLoadError => { if (mounted) setError(messageOf(reviewLoadError)); });
    return () => { mounted = false; };
  }, [reviewRequest, setError, setView]);

  useEffect(() => {
    const timer = setInterval(() => { void load(true); }, 5000);
    return () => { clearInterval(timer); };
  }, [load]);

  const pendingCount = itemCounts.pending;
  const isItemView = view === 'active' || view === 'pending' || view === 'all';
  const readingEnabled = runtime?.routes.some((route) => route.readEnabled) ?? false;
  const memoryStatus = !config?.enabled || !subject?.enabled ? '已关闭' : readingEnabled ? '已生效' : '等待入口启用';

  const updateConfig = async (patch: Partial<WorkspaceMemoryConfig>) => {
    setBusy('settings');
    setError(null);
    try {
      // 总开关开启时恢复当前主体的读取和写入资格，避免隐藏的主体开关使按钮无效。
      if (patch.enabled === true && subject?.enabled === false) await window.electronAPI.setLongTermMemoryPrincipalEnabled(true);
      setConfig(await window.electronAPI.saveLongTermMemoryWorkspaceConfig(patch));
      const overview = await window.electronAPI.getLongTermMemoryOverview();
      setRuntime(overview.extractionRuntime);
      setSubject(overview.subject);
      setFeedback(t("设置已保存"));
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setBusy(null);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft);
    setEditorOpen(true);
  };

  const openEdit = (item: MemoryItemRecord) => {
    setEditing(item);
    setDraft({ kind: item.kind, content: item.content, topic: item.topic, importance: item.importance, expiresAt: item.expiresAt });
    setEditorOpen(true);
  };

  const saveItem = async () => {
    if (!draft.content.trim()) return;
    setBusy('editor');
    setError(null);
    try {
      if (editing) {
        const saved = await window.electronAPI.updateLongTermMemoryItem(editing.id, { ...draft, expectedFingerprint: editing.proposalFingerprint ?? editing.targetFingerprint } as MemoryItemPatch);
        setFeedback(saved.status === 'archived' ? t('已保存，因容量限制未生效') : saved.status === 'pending' ? t('待确认正文已更新') : t('记忆已更新'));
      } else {
        const saved = await window.electronAPI.createLongTermMemoryItem(draft);
        setFeedback(saved.item.status === 'archived' ? t('已保存，因容量限制未生效') : t('记忆已添加'));
      }
      setEditorOpen(false);
      await load();
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setBusy(null);
    }
  };

  const runItemAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      setFeedback(success);
      await load();
    } catch (actionError) {
      setError(messageOf(actionError));
    } finally {
      setBusy(null);
    }
  };

  const openReview = async (item: MemoryItemRecord) => {
    setBusy(item.id); setReviewError(null);
    try { setReviewContext(await window.electronAPI.getLongTermMemoryProposalContext(item.id)); }
    catch (reviewLoadError) { setError(messageOf(reviewLoadError)); }
    finally { setBusy(null); }
  };
  const confirmReview = async (review: MemoryProposalReview) => {
    if (!reviewContext) return;
    setBusy(reviewContext.proposal.id); setReviewError(null);
    try {
      const saved = await window.electronAPI.confirmLongTermMemoryItem(reviewContext.proposal.id, review);
      setReviewContext(null);
      setFeedback(saved.status === 'archived' && review.expectedAction !== 'retire' ? t('已保存，因容量限制未生效') : t('记忆已确认'));
      await load();
    } catch (reviewSaveError) { setReviewError(messageOf(reviewSaveError)); }
    finally { setBusy(null); }
  };

  const transfer = async (mode: 'import' | 'export') => {
    setBusy(mode);
    setError(null);
    try {
      if (mode === 'export') {
        const result = await window.electronAPI.exportLongTermMemory();
        if (!result.canceled) setFeedback(t("已导出 ") + result.exportedItems + t(" 条记忆"));
      } else {
        const result = await window.electronAPI.importLongTermMemory();
        if (!result.canceled) setFeedback(t("已导入 ") + result.importedItems + t(" 条，跳过 ") + result.skippedItems + t(" 条"));
      }
      await load();
    } catch (transferError) {
      setError(messageOf(transferError));
    } finally {
      setBusy(null);
    }
  };

  const consolidate = async () => {
    setBusy('consolidate');
    setError(null);
    setMergeReviewError(null);
    try {
      const result = await window.electronAPI.consolidateLongTermMemory();
      setMergePreviews(result.previews ?? []);
      setMergeReviewOpen(Boolean(result.previews?.length));
      const skipped = (result.skippedChangedClusters ?? 0) + (result.skippedExpiryClusters ?? 0);
      const reason = result.previews?.length ? ' · ' + t('合并方案待审查，原记忆继续有效') : result.skipReason ? ' · ' + skipReasonLabel(result.skipReason) : '';
      const prefix = result.previews?.length ? t('合并方案已生成：归档 ') : result.skipReason ? t('本次未合并：归档 ') : t('整理完成：归档 ');
      setFeedback(prefix + result.archivedExpired + t("，降级 ") + result.decayedTasks + t("，合并 ") + result.mergedClusters + (skipped ? t("，跳过 ") + skipped : "") + reason);
      await load();
    } catch (consolidateError) {
      setError(messageOf(consolidateError));
      setMergeReviewError(messageOf(consolidateError));
    } finally {
      setBusy(null);
    }
  };

  const confirmMerge = async (preview: MemoryConsolidationPreview) => {
    setBusy(preview.id); setMergeReviewError(null);
    try {
      await window.electronAPI.approveLongTermMemoryConsolidation(preview.id, preview.fingerprint);
      setMergePreviews(current => current.filter(item => item.id !== preview.id));
      setFeedback(t('记忆已合并'));
      await load();
    } catch (mergeError) { setMergeReviewError(messageOf(mergeError)); }
    finally { setBusy(null); }
  };

  const itemList = loading
    ? <ViewEmpty label={t("正在读取…")} />
    : items.length
      ? <Stack gap="xs">
        {items.map((item) => <MemoryRow
          key={item.id}
          item={item}
          busy={busy === item.id}
          onEdit={() => openEdit(item)}
          onConfirm={() => void openReview(item)}
          onReject={() => void runItemAction(item.id, () => window.electronAPI.rejectLongTermMemoryItem(item.id), t("记忆已拒绝"))}
          onDelete={() => void runItemAction(item.id, () => window.electronAPI.deleteLongTermMemoryItem(item.id), t("记忆已删除"))}
        />)}
      </Stack>
      : <ViewEmpty label={view === 'pending' ? t("没有待确认记忆") : t("暂无记忆")}
        description={view === 'pending' ? t('已有的有效记忆无需再次确认。要合并记忆，请点击“整理”，有方案时会打开确认窗口。') : undefined} />;

  if (loading && !config) {
    return <Stack align="center" py="xl"><RefreshCw size={18} /><Text size="sm" c="dimmed">{t("正在读取记忆…")}</Text></Stack>;
  }

  return <Stack gap="md">
    <Paper withBorder p="md" radius="md">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <div>
              <Text fw={700}>{t("长期记忆")}</Text>
            </div>
            <Badge size="sm" variant="light" color={readingEnabled ? 'teal' : 'gray'} data-testid="memory-effective-status">{t(memoryStatus)}</Badge>
          </Group>
          <Switch
            aria-label={t("启用长期记忆")}
            checked={Boolean(config?.enabled && subject?.enabled)}
            disabled={busy === 'settings'}
            onChange={(event) => void updateConfig({ enabled: event.currentTarget.checked })}
          />
        </Group>

        <Text size="xs" c="dimmed">{t("关闭后不读取或写入长期记忆，已保存的记忆会保留。")}</Text>
        <Text size="xs" c="dimmed">{t('自动提炼的新记忆确认后才用于回答；已有效的记忆无需再次确认。')}</Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
          <Metric label={t("有效")} value={itemCounts.active} />
          <Metric label={t("待确认")} value={pendingCount} />
          <Metric label={t("代际")} value={subject?.memoryGeneration ?? 0} />
        </SimpleGrid>

        <Divider />

        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
          <Select
            label={t("写入")}
            value={config?.writeMode ?? 'explicit_only'}
            data={[{ value: 'explicit_only', label: t("仅明确保存") }, { value: 'auto', label: t("自动提炼") }]}
            disabled={busy === 'settings'}
            onChange={(value) => value && void updateConfig({ writeMode: value as WorkspaceMemoryConfig['writeMode'] })}
          />
          <NumberInput
            label={t("容量")}
            value={config?.maxItems ?? 200}
            min={10}
            max={2000}
            disabled={busy === 'settings'}
            onChange={(value) => typeof value === 'number' && setConfig((current) => current ? { ...current, maxItems: value } : current)}
            onBlur={() => config && void updateConfig({ maxItems: config.maxItems })}
          />
          <Switch
            label={t("检索时参考记忆")}
            mt={28}
            checked={config?.retrievalConditioning ?? true}
            disabled={busy === 'settings'}
            onChange={(event) => void updateConfig({ retrievalConditioning: event.currentTarget.checked })}
          />
        </SimpleGrid>
        {runtime ? <Stack gap={4} data-testid="memory-read-runtime" aria-live="polite">
          <Text size="xs" c="dimmed">{readingEnabled ? t("回答读取已生效") : t("回答读取未启用")}</Text>
          <Group gap="xs" wrap="wrap">{runtime.routes.map((route) => <Badge key={route.route} size="xs" variant="light" color={route.readEnabled ? 'teal' : 'gray'}>
            {t(({ chat: '问答', 'knowledge-base': '知识库', 'current-note-direct': '当前笔记直答', 'current-note-react': '当前笔记工具问答' } as const)[route.route])}：{t(({ enabled: '已开启', memory_disabled: '记忆未启用', route_disabled: '入口未启用' } as const)[route.readReason ?? 'route_disabled'])}
          </Badge>)}</Group>
        </Stack> : null}
        {runtime ? <Stack gap={4} data-testid="memory-extraction-runtime" aria-live="polite">
          <Text size="xs" c="dimmed">{runtime.pauseCode && config?.enabled && subject?.enabled && config.writeMode === 'auto' ? t("自动提炼正在升级，待处理来源已保留") : runtime.routes.some((route) => route.eligible)
            ? runtime.modelState === 'ready' ? t("自动提炼已生效") : runtime.modelState === 'unavailable' ? t("自动提炼模型不可用，请检查模型设置") : t("自动提炼已开启，等待模型验证")
            : !config?.enabled || !subject?.enabled ? t("自动提炼已关闭") : config.writeMode === 'explicit_only' ? t("仅明确保存，不自动提炼") : t("自动提炼尚未生效")}</Text>
          <Group gap="xs" wrap="wrap">{runtime.routes.map((route) => <Badge key={route.route} size="xs" variant="light" color={route.eligible ? 'teal' : 'gray'}>
            {t(({ chat: '问答', 'knowledge-base': '知识库', 'current-note-direct': '当前笔记直答', 'current-note-react': '当前笔记工具问答' } as const)[route.route])}：{t(({ eligible: '已开启', memory_disabled: '记忆未启用', explicit_only: '仅明确保存', route_disabled: '入口未启用', paused: '已暂停' } as const)[route.reason])}
          </Badge>)}</Group>
          <Text size="xs" c="dimmed">{t("等待")} {runtime.queuedJobs}{t("，运行中 ")} {runtime.runningJobs}{t("，失败 ")} {runtime.failedJobs}{runtime.nextDueAt ? t(" · 下次 ") + new Date(runtime.nextDueAt).toLocaleTimeString() : ''}</Text>
          {runtime.migrationHeldJobs ? <Text size="xs" c="dimmed">{t("部分旧任务缺少来源记录，已暂停自动处理")} ({runtime.migrationHeldJobs})</Text> : null}
        </Stack> : null}
      </Stack>
    </Paper>

    <Group justify="space-between" align="center" wrap="wrap">
      {isItemView ? <Select
        size="xs"
        aria-label={t("按类型筛选记忆")}
        value={kindFilter}
        onChange={(value) => setKindFilter((value as MemoryKind | 'all') ?? 'all')}
        data={[{ value: 'all', label: t("全部类型") }, ...localizeOptions(kindOptions)]}
      /> : <Text size="xs" c="dimmed">{view === 'topics' ? t("观察到的主题") : t("回答中使用过的文档")}</Text>}
      <Group gap={6}>
        <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} aria-label={t("刷新记忆")} loading={loading} disabled={busy !== null} onClick={() => void load()}>{t("刷新")}</Button>
        <Tooltip label={t("导入备份")}>
          <ActionIcon variant="default" size="lg" aria-label={t("导入记忆备份")} loading={busy === 'import'} onClick={() => void transfer('import')}><FileUp size={16} /></ActionIcon>
        </Tooltip>
        <Tooltip label={t("导出备份")}>
          <ActionIcon variant="default" size="lg" aria-label={t("导出记忆备份")} loading={busy === 'export'} onClick={() => void transfer('export')}><FileDown size={16} /></ActionIcon>
        </Tooltip>
        <Button size="xs" variant="light" leftSection={<Sparkles size={14} />} loading={busy === 'consolidate'} disabled={busy !== null && busy !== 'consolidate'}
          data-testid="memory-consolidation-action" onClick={() => mergePreviews.length ? setMergeReviewOpen(true) : void consolidate()}>
          {mergePreviews.length ? t('审查合并方案（{0}）', { '0': mergePreviews.length }) : t("整理")}
        </Button>
        <Button size="xs" leftSection={<Plus size={14} />} onClick={openCreate}>{t("添加")}</Button>
      </Group>
    </Group>

    <Text size="xs" c="dimmed">{t('待确认只显示尚未生效的记忆；合并方案请通过“整理”生成并确认。')}</Text>

    <Tabs value={view} onChange={(value) => setView((value as MemoryView) ?? 'active')} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="active" rightSection={<Badge size="xs" variant="light">{itemCounts.active}</Badge>}>{t("记忆")}</Tabs.Tab>
        <Tabs.Tab value="pending" rightSection={pendingCount ? <Badge size="xs" color="yellow">{pendingCount}</Badge> : undefined}>{t("待确认")}</Tabs.Tab>
        <Tabs.Tab value="topics">{t("主题")}</Tabs.Tab>
        <Tabs.Tab value="documents">{t("文档")}</Tabs.Tab>
        <Tabs.Tab value="all">{t("全部")}</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="active" pt="md">{itemList}</Tabs.Panel>
      <Tabs.Panel value="pending" pt="md">{itemList}</Tabs.Panel>
      <Tabs.Panel value="all" pt="md">{itemList}</Tabs.Panel>

      <Tabs.Panel value="topics" pt="md">
        {loading ? <ViewEmpty label={t("正在读取…")} /> : topics.length ? <Stack gap="xs">
          {topics.map((topic) => <Paper key={topic.id} withBorder p="sm" radius="md">
            <Group justify="space-between" align="center" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600}>{topic.topic}</Text>
                <Text size="xs" c="dimmed">{t("出现")} {topic.hits} {t("次")}{topic.aliases.length ? ' · ' + topic.aliases.join('、') : ''}</Text>
              </div>
              <Group gap={4} wrap="nowrap">
                {!topic.promotedItemId ? <Button size="compact-xs" variant="light" onClick={() => void runItemAction('topic:' + topic.id, () => window.electronAPI.promoteLongTermMemoryTopic(topic.id), t("已加入兴趣记忆"))}>{t("加入记忆")}</Button> : <Badge size="xs" color="teal">{t('兴趣条目已生成')}</Badge>}
                <Tooltip label={t("删除主题")}><ActionIcon variant="subtle" color="red" aria-label={t("删除主题")} loading={busy === 'topic:' + topic.id} onClick={() => void runItemAction('topic:' + topic.id, () => window.electronAPI.deleteLongTermMemoryTopic(topic.id), t("主题已删除"))}><Trash2 size={16} /></ActionIcon></Tooltip>
              </Group>
            </Group>
          </Paper>)}
        </Stack> : <ViewEmpty label={t("暂无主题")} />}
      </Tabs.Panel>

      <Tabs.Panel value="documents" pt="md">
        {loading ? <ViewEmpty label={t("正在读取…")} /> : documents.length ? <Stack gap="xs">
          {documents.map((document) => <Paper key={document.documentId} withBorder p="sm" radius="md">
            <Group justify="space-between" align="center" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>{document.title || document.documentId}</Text>
                <Text size="xs" c="dimmed">{t("引用")} {document.hits} {t("次 ·")} {new Date(document.lastUsedAt).toLocaleString()}</Text>
              </div>
              <Tooltip label={t("删除文档记录")}><ActionIcon variant="subtle" color="red" aria-label={t("删除文档记录")} loading={busy === 'document:' + document.documentId} onClick={() => void runItemAction('document:' + document.documentId, () => window.electronAPI.deleteLongTermMemoryDocument(document.documentId), t("文档记录已删除"))}><Trash2 size={16} /></ActionIcon></Tooltip>
            </Group>
          </Paper>)}
        </Stack> : <ViewEmpty label={t("暂无文档记录")} />}
      </Tabs.Panel>
    </Tabs>

    <Group justify="space-between" align="center" wrap="wrap" data-testid="memory-pagination">
      <Text size="xs" c="dimmed">{loading ? t('正在读取…') : t('共 {0} 条，每页 {1} 条', { '0': pageInfo.total, '1': memoryPageSize })}</Text>
      {pageInfo.total > 0 ? <Pagination size="sm" value={page} total={pageInfo.totalPages} onChange={setPage}
        disabled={loading} withEdges aria-label={t('记忆分页')}
        getItemProps={pageNumber => ({ 'aria-label': t('第 {0} 页', { '0': pageNumber }) })}
        getControlProps={control => ({ 'aria-label': t(({ first: '第一页', previous: '上一页', next: '下一页', last: '最后一页' })[control]) })} /> : null}
    </Group>

    <Group justify="flex-end">
      <Button color="red" variant="subtle" size="xs" leftSection={<Trash2 size={14} />} onClick={() => setClearOpen(true)}>{t("清空")}</Button>
    </Group>

    {reviewContext ? <MemoryProposalReviewDialog key={reviewContext.proposal.proposalFingerprint ?? reviewContext.proposal.id} context={reviewContext}
      busy={busy === reviewContext.proposal.id} error={reviewError} onClose={() => setReviewContext(null)}
      onConfirm={review => void confirmReview(review)}
      onEdit={() => { openEdit(reviewContext.proposal); setReviewContext(null); }}
      onReject={() => void runItemAction(reviewContext.proposal.id, async () => { await window.electronAPI.rejectLongTermMemoryItem(reviewContext.proposal.id); setReviewContext(null); }, t('记忆已拒绝'))} /> : null}
    <Modal opened={mergeReviewOpen && mergePreviews.length > 0} onClose={() => setMergeReviewOpen(false)} closeButtonProps={{ 'aria-label': t('关闭合并方案') }}
      title={t('审查记忆整理方案')} centered size="lg">
      <Stack gap="md">
        <Text size="sm">{t('逐组确认后才会合并。关闭或跳过保留原记忆。')}</Text>
        <Text size="xs" c="dimmed">{t('关闭后可通过“审查合并方案”重新打开。方案失效时请重新整理。')}</Text>
        {mergeReviewError ? <Text size="sm" c="red" role="alert">{mergeReviewError}</Text> : null}
        {mergeReviewError ? <Group justify="flex-end"><Button size="xs" variant="default" disabled={busy !== null}
          onClick={() => void consolidate()}>{t('重新整理')}</Button></Group> : null}
        {mergePreviews.map(preview => <Paper key={preview.id} withBorder p="sm" data-testid="memory-merge-preview">
          <Stack gap="xs">
            <Text size="xs" c="dimmed">{t('原记忆')}</Text>
            {preview.sources.map(source => <Text key={source.id} size="sm">{source.content} · {t(source.writeProtection === 'none' ? '自动提炼' : source.writeProtection === 'legacy' ? '旧数据保护' : '用户保护')}</Text>)}
            <Divider /><Text size="xs" c="dimmed">{t('合并后')}</Text><Text size="sm">{preview.result.content}</Text>
            <Group justify="flex-end">
              <Button size="xs" variant="default" disabled={busy !== null} onClick={() => setMergePreviews(current => current.filter(item => item.id !== preview.id))}>{t('跳过')}</Button>
              <Button size="xs" loading={busy === preview.id} disabled={busy !== null && busy !== preview.id} onClick={() => void confirmMerge(preview)}>{t('确认合并')}</Button>
            </Group>
          </Stack>
        </Paper>)}
      </Stack>
    </Modal>
    <Modal opened={editorOpen} onClose={() => setEditorOpen(false)} title={editing ? t("编辑记忆") : t("添加记忆")} centered>
      <Stack>
        <Select label={t("类型")} value={draft.kind} data={localizeOptions(kindOptions)} onChange={(value) => value && setDraft((current) => ({ ...current, kind: value as MemoryKind }))} />
        <TextInput label={t("主题")} value={draft.topic ?? ''} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, topic: event.currentTarget.value }))} />
        <Textarea label={t("内容")} value={draft.content} maxLength={300} minRows={3} autosize onChange={(event) => setDraft((current) => ({ ...current, content: event.currentTarget.value }))} />
        <NumberInput label={t("重要度")} value={draft.importance ?? 3} min={1} max={5} onChange={(value) => typeof value === 'number' && setDraft((current) => ({ ...current, importance: value }))} />
        <Group justify="flex-end"><Button variant="default" onClick={() => setEditorOpen(false)}>{t("取消")}</Button><Button loading={busy === 'editor'} disabled={!draft.content.trim()} onClick={() => void saveItem()}>{t("保存")}</Button></Group>
      </Stack>
    </Modal>

    <Modal opened={clearOpen} onClose={() => setClearOpen(false)} title={t("清空长期记忆")} centered>
      <Stack>
        <Text size="sm">{t("删除记忆、主题和文档记录。")}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setClearOpen(false)}>{t("取消")}</Button>
          <Button color="red" loading={busy === 'clear'} onClick={() => void runItemAction('clear', async () => { await window.electronAPI.clearLongTermMemory(); setClearOpen(false); }, t("长期记忆已清空"))}>{t("确认清空")}</Button>
        </Group>
      </Stack>
    </Modal>
  </Stack>;
}

function Metric({ label, value }: { label: string; value: number }) {
  useI18n();
  return <Paper withBorder p="sm" radius="sm"><Text size="xs" c="dimmed">{label}</Text><Text fw={700} size="lg">{value}</Text></Paper>;
}

function ViewEmpty({ label, description }: { label: string; description?: string }) {
  useI18n();
  return <Paper withBorder p="xl" radius="md"><Stack align="center" gap="xs"><Database size={21} /><Text size="sm" c="dimmed">{label}</Text>
    {description ? <Text size="xs" c="dimmed" ta="center">{description}</Text> : null}
  </Stack></Paper>;
}

function MemoryRow({ item, busy, onEdit, onConfirm, onReject, onDelete }: {
  item: MemoryItemRecord;
  busy: boolean;
  onEdit: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onDelete: () => void;
}) {
  useI18n();
  const kind = kindOptions.find((entry) => entry.value === item.kind)?.label ?? item.kind;
  const status = statusLabel(item.status);
  const statusColor = item.status === 'pending' ? 'yellow' : item.status === 'active' ? 'teal' : 'gray';
  return <Paper withBorder p="sm" radius="md" data-memory-item-id={item.id}>
    <Group justify="space-between" align="flex-start" gap="sm" wrap="nowrap">
      <Stack gap={5} style={{ minWidth: 0, flex: 1 }}>
        <Group gap={5} wrap="wrap"><Badge size="xs" variant="light">{t(kind)}</Badge><Badge size="xs" color={statusColor} variant="dot">{status}</Badge>{item.topic ? <Text size="xs" c="dimmed">{item.topic}</Text> : null}</Group>
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{item.content}</Text>
        {item.status === 'pending' ? <Text size="xs" c="dimmed">{reviewReasonLabel(item.reviewReason)} · {t('确认前原记忆继续生效')}</Text> : item.reviewReason?.startsWith('TARGET_') ? <Text size="xs" c="dimmed">{reviewReasonLabel(item.reviewReason)}</Text> : null}
        <Text size="xs" c="dimmed">{t(({ explicit: '明确保存', extracted: '自动提炼', manual: '手工维护' } as const)[item.origin])}
          {item.writeProtection !== 'none' ? ' · ' + t(item.writeProtection === 'user' ? '用户保护' : '旧数据保护') : ''}</Text>
        <Text size="xs" c="dimmed">{t("重要度")} {item.importance} {t("· 使用")} {item.useCount} {t("次 ·")} {new Date(item.updatedAt).toLocaleString()}</Text>
      </Stack>
      <Group gap={2} wrap="nowrap">
        {item.status === 'pending' ? <>
          <Tooltip label={t("审查并确认")}><ActionIcon variant="light" color="teal" aria-label={t("确认记忆")} loading={busy} onClick={onConfirm}><Check size={16} /></ActionIcon></Tooltip>
          <Tooltip label={t("拒绝")}><ActionIcon variant="subtle" color="orange" aria-label={t("拒绝记忆")} disabled={busy} onClick={onReject}><X size={16} /></ActionIcon></Tooltip>
        </> : null}
        {(item.status === 'active' || item.status === 'pending') && item.proposalAction !== 'retire' ? <Tooltip label={t("编辑")}><ActionIcon variant="subtle" aria-label={t("编辑记忆")} disabled={busy} onClick={onEdit}><Pencil size={16} /></ActionIcon></Tooltip> : null}
        <Tooltip label={t("删除")}><ActionIcon variant="subtle" color="red" aria-label={t("删除记忆")} disabled={busy} onClick={onDelete}><Trash2 size={16} /></ActionIcon></Tooltip>
      </Group>
    </Group>
  </Paper>;
}

function statusLabel(status: MemoryItemRecord['status']): string {
  return ({ active: t("有效"), pending: t("待确认"), superseded: t("已替代"), archived: t("已归档") } as const)[status];
}

function skipReasonLabel(reason: string): string {
  if (reason === 'review_required') return t('合并需要审查确认');
  return ({ too_soon: t("操作过于频繁"), too_few_items: t("条目不足"), no_candidates: t("没有可合并内容"), model_unavailable: t("模型不可用"), model_declined: t("模型未批准合并"), sources_skipped: t("来源已变化或有效期不匹配"), busy: t("整理正在进行"), timeout: t("整理超时，可稍后重试"), cancelled: t("整理已取消"), failed: t("整理失败，请检查模型设置") } as Record<string, string>)[reason] ?? reason;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
