import { t, useI18n } from '../../i18n';
import { ActionIcon, Badge, Button, Group, Popover, Progress, SegmentedControl, Select, Text, TextInput, Tooltip } from '@mantine/core';
import { Check, Info, LayoutDashboard, Menu, PanelLeftClose, PanelLeftOpen, Search, Square, Sparkles, X } from 'lucide-react';
import type { MaterialsLibrarySummary } from '../../electron';
import type { WikiBuildMode, WikiGenerationJob, WikiMapInteractionMode, WikiOrderPersistence } from '../../wiki/wikiTypes';

interface WikiToolbarProps {
  libraries: MaterialsLibrarySummary[];
  libraryPath: string | null;
  hasDocument: boolean;
  sidebarLabel: string;
  mode: WikiBuildMode | null;
  searchQuery: string;
  outlineOpen: boolean;
  job: WikiGenerationJob | null;
  operationBusy: boolean;
  mapInteractionMode: WikiMapInteractionMode;
  reorderDirty: boolean;
  reorderSaving: boolean;
  orderPersistence: WikiOrderPersistence;
  onLibraryChange: (libraryPath: string) => void;
  onSearchChange: (value: string) => void;
  onToggleOutline: () => void;
  onResetLayout: () => void;
  onMapInteractionModeChange: (mode: WikiMapInteractionMode) => void;
  onCommitReorder: () => void;
  onCancelReorder: () => void;
  onOpenMode: () => void;
  onStartGeneration: () => void;
  onStop: () => void;
}

export default function WikiToolbar({
  libraries,
  libraryPath,
  hasDocument,
  sidebarLabel,
  mode,
  searchQuery,
  outlineOpen,
  job,
  operationBusy,
  mapInteractionMode,
  reorderDirty,
  reorderSaving,
  orderPersistence,
  onLibraryChange,
  onSearchChange,
  onToggleOutline,
  onResetLayout,
  onMapInteractionModeChange,
  onCommitReorder,
  onCancelReorder,
  onOpenMode,
  onStartGeneration,
  onStop,
}: WikiToolbarProps) {
  useI18n();
  const generationRunning = job?.status === 'running';
  return (
    <header className="wiki-toolbar">
      <Group className="wiki-toolbar-primary" gap={8} wrap="nowrap">
        <Text className="wiki-toolbar-title" fw={720}>Wiki</Text>
        <Tooltip label={`${outlineOpen ? t("收起") : t("展开")}${sidebarLabel}`} withArrow>
          <ActionIcon variant="subtle" color="gray" onClick={onToggleOutline} aria-label={`${outlineOpen ? t("收起") : t("展开")}${sidebarLabel}`}>
            {outlineOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </ActionIcon>
        </Tooltip>
        <Select
          className="wiki-library-select"
          value={libraryPath}
          data={libraries.map((library) => ({ value: library.path, label: library.alias }))}
          onChange={(value) => value && onLibraryChange(value)}
          allowDeselect={false}
          searchable
          disabled={reorderSaving}
          placeholder={t("选择知识库")}
          aria-label={t("选择知识库")}
        />
        <TextInput
          className="wiki-node-search"
          id="wiki-node-search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          leftSection={<Search size={15} />}
          placeholder={t("搜索节点")}
          aria-label={t("搜索 Wiki 节点")}
          disabled={!hasDocument}
        />
      </Group>
      <Group className="wiki-toolbar-actions" gap={7} wrap="nowrap">
        {job ? (
          <div className="wiki-toolbar-progress" title={job.stage}>
            <Text size="11px" c="dimmed">{job.stage}</Text>
            <Progress value={job.progress} size={5} color={job.status === 'partial' ? 'yellow' : 'teal'} />
          </div>
        ) : null}
        {hasDocument ? <Badge variant="light" color={mode === 'auto' ? 'blue' : 'teal'}>{mode === 'auto' ? t("整篇生成") : t("节点分析")}</Badge> : null}
        {hasDocument ? (
          <Group className="wiki-map-mode-controls" gap={5} wrap="nowrap">
            <SegmentedControl
              size="xs"
              value={mapInteractionMode}
              data={[
                { value: 'browse', label: t("浏览") },
                { value: 'reorder', label: t("调整顺序") },
              ]}
              onChange={(value) => onMapInteractionModeChange(value as WikiMapInteractionMode)}
              disabled={operationBusy || reorderSaving}
              aria-label={t("章节导图操作模式")}
            />
            {mapInteractionMode === 'reorder' ? (
              <>
                <Tooltip label={reorderDirty ? (orderPersistence === 'local' ? t("保存章节顺序") : t("应用当前会话中的章节顺序")) : t("退出调整顺序")} withArrow>
                  <Button size="xs" variant="light" color="brand" leftSection={<Check size={14} />} loading={reorderSaving} disabled={reorderSaving} onClick={onCommitReorder}>
                    {t("完成")}
                  </Button>
                </Tooltip>
                <Tooltip label={t("取消并恢复进入排序模式前的顺序")} withArrow>
                  <ActionIcon variant="subtle" color="gray" disabled={reorderSaving} onClick={onCancelReorder} aria-label={t("取消调整顺序")}>
                    <X size={15} />
                  </ActionIcon>
                </Tooltip>
              </>
            ) : null}
          </Group>
        ) : null}
        <Tooltip label={t("恢复自动布局")} withArrow>
          <ActionIcon variant="default" onClick={onResetLayout} aria-label={t("恢复自动布局")} disabled={!hasDocument || mapInteractionMode === 'reorder'}><LayoutDashboard size={16} /></ActionIcon>
        </Tooltip>
        <Popover width={260} position="bottom-end" shadow="md">
          <Popover.Target>
            <ActionIcon variant="default" aria-label={t("导图说明")}><Info size={16} /></ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Text size="sm" fw={650}>{t("章节导图")}</Text>
            <Text size="xs" c="dimmed" mt={5}>{t("浏览模式可自由拖动节点整理当前画面，父子连线会保持独立的正交路径；进入调整顺序后，只能在同一父章节下上下移动，也可用 Alt + ↑/↓ 微调。")}</Text>
            <Text size="xs" c="dimmed" mt={6}>
              {orderPersistence === 'local'
                ? t("完成调整后，顺序会保存到当前知识库的本地元数据；不会修改原始文档或结构树。")
                : t("当前为 Mock 数据，排序只在本次打开期间生效。")}
            </Text>
          </Popover.Dropdown>
        </Popover>
        {hasDocument ? <Button variant="default" leftSection={<Menu size={15} />} onClick={onOpenMode}>{t("切换模式")}</Button> : null}
        {hasDocument && generationRunning ? (
          <Button color="red" variant="light" leftSection={<Square size={14} />} onClick={onStop}>{t("停止")}</Button>
        ) : hasDocument ? (
          <Button color="brand" leftSection={<Sparkles size={15} />} disabled={operationBusy || mapInteractionMode === 'reorder'} onClick={onStartGeneration}>{t("生成完整 Wiki")}</Button>
        ) : null}
      </Group>
    </header>
  );
}
