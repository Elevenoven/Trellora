import { t, useI18n } from '../../i18n';
import { ActionIcon, Badge, Tooltip } from '@mantine/core';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, FileText, Sparkles } from 'lucide-react';
import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import type { WikiMapNode as WikiMapNodeModel } from '../../wiki/wikiTypes';

export type WikiMapNodeData = {
  node: WikiMapNodeModel;
  branchColor: string;
  childCount: number;
  hasSuggestedQuestions: boolean;
  selected: boolean;
  dimmed: boolean;
  searchMatch: boolean;
  reorderMode: boolean;
  reorderSaving: boolean;
  dragging: boolean;
  reorderDimmed: boolean;
  placeholder: boolean;
  dropIndicator: 'before' | 'after' | null;
  onNodeSizeMeasured: (nodeId: string, height: number) => void;
  onToggleCollapsed: (nodeId: string) => void;
  onKeyboardReorder: (nodeId: string, direction: -1 | 1) => void;
  onKeyboardContextMenu: (nodeId: string, x: number, y: number) => void;
};

export type WikiFlowNode = Node<WikiMapNodeData, 'wikiNode'>;

const statusLabels: Record<WikiMapNodeModel['status'], string> = {
  idle: '未分析',
  queued: '等待中',
  running: '生成中',
  complete: '已完成',
  failed: '失败',
  stale: '已过期',
  cancelled: '已停止',
};

export default function WikiMapNode({ data }: NodeProps<WikiFlowNode>) {
  useI18n();
  const {
    node,
    childCount,
    hasSuggestedQuestions,
    selected,
    dimmed,
    searchMatch,
    reorderMode,
    reorderSaving,
    dragging,
    reorderDimmed,
    placeholder,
    dropIndicator,
    onNodeSizeMeasured,
    onToggleCollapsed,
    onKeyboardReorder,
    onKeyboardContextMenu,
  } = data;
  const NodeIcon = node.kind === 'derived' ? Sparkles : FileText;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 布局需要真实渲染高度（标题换行会撑高节点），测量后回填给画布重新布局。
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || placeholder) return;
    const report = () => onNodeSizeMeasured(node.id, element.offsetHeight);
    report();
    const observer = new ResizeObserver(() => report());
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.id, onNodeSizeMeasured, placeholder]);

  if (placeholder) {
    return <div className="wiki-map-node-placeholder" aria-hidden="true" />;
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (reorderMode && !reorderSaving && node.parentId && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      onKeyboardReorder(node.id, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    onKeyboardContextMenu(node.id, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  };

  return (
    <div
      ref={rootRef}
      style={{ '--wiki-branch-color': data.branchColor } as CSSProperties}
      className={[
        'wiki-map-node',
        node.parentId ? '' : 'root',
        selected ? 'selected' : '',
        dimmed ? 'dimmed' : '',
        searchMatch ? 'search-match' : '',
        reorderMode && node.parentId ? 'reorder-enabled' : '',
        reorderSaving && node.parentId ? 'reorder-saving' : '',
        dragging ? 'dragging' : '',
        reorderDimmed ? 'reorder-dimmed' : '',
        dropIndicator ? `drop-${dropIndicator}` : '',
        `status-${node.status}`,
      ].filter(Boolean).join(' ')}
      tabIndex={0}
      aria-label={`${node.title}，${statusLabels[node.status]}`}
      aria-grabbed={reorderMode && node.parentId ? dragging : undefined}
      aria-busy={reorderSaving || undefined}
      onKeyDown={handleKeyDown}
    >
      <Handle className="wiki-map-handle" type="target" position={Position.Left} isConnectable={false} />
      <span className="wiki-map-node-icon" aria-hidden="true"><NodeIcon size={14} /></span>
      <Tooltip label={node.title} openDelay={500} withArrow>
        <span className="wiki-map-node-title">{node.title}</span>
      </Tooltip>
      {hasSuggestedQuestions ? (
        <Tooltip label={t("已加载建议问题")} withArrow>
          <span className="wiki-map-node-questions" aria-label={t("已加载建议问题")}><Sparkles size={12} /></span>
        </Tooltip>
      ) : null}
      <Badge className="wiki-map-node-status" size="xs" variant="light" color={getStatusColor(node.status)}>
        {statusLabels[node.status]}
      </Badge>
      {childCount > 0 ? (
        <Tooltip label={node.collapsed ? t("展开分支") : t("收起分支")} withArrow>
          <ActionIcon
            className="wiki-map-node-collapse nodrag"
            size={20}
            variant="subtle"
            color="gray"
            aria-label={node.collapsed ? t("展开分支") : t("收起分支")}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapsed(node.id);
            }}
          >
            {node.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </ActionIcon>
        </Tooltip>
      ) : null}
      <Handle className="wiki-map-handle" type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function getStatusColor(status: WikiMapNodeModel['status']): string {
  if (status === 'complete') return 'teal';
  if (status === 'running' || status === 'queued') return 'blue';
  if (status === 'failed') return 'red';
  if (status === 'stale') return 'yellow';
  return 'gray';
}
