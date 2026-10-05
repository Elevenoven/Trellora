import { t, useI18n } from '../../i18n';
import { Menu, Text } from '@mantine/core';
import { ChevronDown, Crosshair, FileSearch, FolderPlus, MessageSquareText, Pencil, Sparkles, Trash2, UnfoldVertical, Copy } from 'lucide-react';
import type { WikiMapNode } from '../../wiki/wikiTypes';

interface WikiNodeContextMenuProps {
  node: WikiMapNode | null;
  position: { x: number; y: number } | null;
  childCount: number;
  onClose: () => void;
  onOpen: () => void;
  onToggleCollapsed: () => void;
  onFitBranch: () => void;
  onLocateSource: () => void;
  onAnalyze: () => void;
  onRefreshQuestions: () => void;
  onAddChild: () => void;
  onRename: () => void;
  onCopyPath: () => void;
  onDelete: () => void;
}

export default function WikiNodeContextMenu({
  node,
  position,
  childCount,
  onClose,
  onOpen,
  onToggleCollapsed,
  onFitBranch,
  onLocateSource,
  onAnalyze,
  onRefreshQuestions,
  onAddChild,
  onRename,
  onCopyPath,
  onDelete,
}: WikiNodeContextMenuProps) {
  useI18n();
  const opened = Boolean(node && position);
  return (
    <Menu opened={opened} onChange={(nextOpened) => !nextOpened && onClose()} position="bottom-start" shadow="md" width={238}>
      <Menu.Target>
        <span
          className="wiki-context-menu-anchor"
          style={{ left: position?.x ?? 0, top: position?.y ?? 0 }}
          aria-hidden="true"
        />
      </Menu.Target>
      <Menu.Dropdown className="wiki-context-menu">
        <Menu.Label>{node?.title}</Menu.Label>
        <Menu.Item leftSection={<FileSearch size={14} />} onClick={onOpen}>{t("打开节点详情")}</Menu.Item>
        <Menu.Item leftSection={node?.collapsed ? <UnfoldVertical size={14} /> : <ChevronDown size={14} />} disabled={childCount === 0} onClick={onToggleCollapsed}>
          {node?.collapsed ? t("展开此分支") : t("收起此分支")}
        </Menu.Item>
        <Menu.Item leftSection={<Crosshair size={14} />} onClick={onFitBranch}>{t("适配此分支到视图")}</Menu.Item>
        <Menu.Item leftSection={<FileSearch size={14} />} onClick={onLocateSource}>{t("在原文中定位")}</Menu.Item>
        <Menu.Item leftSection={<MessageSquareText size={14} />} onClick={onAnalyze}>{t("分析此节点")}</Menu.Item>
        <Menu.Item leftSection={<Sparkles size={14} />} onClick={onRefreshQuestions}>{t("重新生成建议问题")}</Menu.Item>
        <Menu.Divider />
        <Menu.Item leftSection={<FolderPlus size={14} />} onClick={onAddChild}>{t("添加派生子节点")}</Menu.Item>
        <Menu.Item leftSection={<Pencil size={14} />} disabled={node?.kind !== 'derived'} onClick={onRename}>
          {t("重命名派生节点")}
          {node?.kind !== 'derived' ? <Text component="span" size="10px" c="dimmed" ml={6}>{t("来源节点不可修改")}</Text> : null}
        </Menu.Item>
        <Menu.Item leftSection={<Copy size={14} />} onClick={onCopyPath}>{t("复制节点路径")}</Menu.Item>
        <Menu.Item color="red" leftSection={<Trash2 size={14} />} disabled={node?.kind !== 'derived'} onClick={onDelete}>
          {t("删除派生节点")}
          {node?.kind !== 'derived' ? <Text component="span" size="10px" c="dimmed" ml={6}>{t("来源节点不可删除")}</Text> : null}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
