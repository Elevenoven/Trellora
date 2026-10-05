import { getAppLanguage, t, useI18n } from '../../i18n';
import { ActionIcon, Badge, Divider, Group, NavLink, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { ArrowLeft, ChevronRight, Clock3, FileText, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WikiDocumentSummary, WikiMapNode } from '../../wiki/wikiTypes';

interface WikiOutlinePaneProps {
  document: WikiDocumentSummary;
  nodes: WikiMapNode[];
  selectedNodeId: string | null;
  searchQuery: string;
  onSelectNode: (nodeId: string) => void;
  onToggleCollapsed: (nodeId: string) => void;
  onBackToDocuments: () => void;
}

export default function WikiOutlinePane({
  document,
  nodes,
  selectedNodeId,
  searchQuery,
  onSelectNode,
  onToggleCollapsed,
  onBackToDocuments,
}: WikiOutlinePaneProps) {
  useI18n();
  const childrenByParent = new Map<string | null, WikiMapNode[]>();
  nodes.forEach((node) => {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  });
  childrenByParent.forEach((siblings) => siblings.sort((left, right) => left.order - right.order));
  const query = searchQuery.trim().toLocaleLowerCase('zh-CN');

  const renderBranch = (parentId: string | null): ReactNode => (
    childrenByParent.get(parentId)?.map((node) => {
      const children = childrenByParent.get(node.id) ?? [];
      const matches = !query || node.title.toLocaleLowerCase('zh-CN').includes(query);
      const descendantMatches = query && hasMatchingDescendant(node.id, childrenByParent, query);
      if (!matches && !descendantMatches) return null;
      return (
        <NavLink
          key={node.id}
          className="wiki-outline-link"
          label={node.title}
          leftSection={node.kind === 'derived' ? <GitBranch size={13} /> : <FileText size={13} />}
          rightSection={children.length > 0 ? <ChevronRight className={node.collapsed ? '' : 'expanded'} size={13} /> : null}
          active={node.id === selectedNodeId}
          opened={!node.collapsed || Boolean(query)}
          onClick={() => onSelectNode(node.id)}
          onChange={() => children.length > 0 && onToggleCollapsed(node.id)}
        >
          {children.length > 0 ? renderBranch(node.id) : null}
        </NavLink>
      );
    }) ?? null
  );

  return (
    <aside className="wiki-outline-pane" aria-label={t("Wiki 文档目录")}>
      <div className="wiki-outline-header">
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed" fw={700}>{t("文档目录")}</Text>
          <Tooltip label={t("返回文档列表")} withArrow>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("返回文档列表")} onClick={onBackToDocuments}>
              <ArrowLeft size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Text size="sm" fw={680} mt={5} lineClamp={2}>{document.title}</Text>
        <Text size="xs" c="dimmed" mt={4}>{document.description}</Text>
      </div>
      <ScrollArea className="wiki-outline-scroll" type="auto">
        <Stack gap={1}>{renderBranch(null)}</Stack>
      </ScrollArea>
      <div className="wiki-outline-footer">
        <Divider mb="sm" />
        <Stack gap={7}>
          <div className="wiki-outline-fact"><Clock3 size={13} /><Text size="xs">{t("更新于")} {formatDate(document.updatedAt)}</Text></div>
          <div className="wiki-outline-fact"><GitBranch size={13} /><Text size="xs">{nodes.length} {t("个节点")}</Text><Badge size="xs" variant="light" color="teal">{t("结构树")}</Badge></div>
        </Stack>
      </div>
    </aside>
  );
}

function hasMatchingDescendant(nodeId: string, childrenByParent: Map<string | null, WikiMapNode[]>, query: string): boolean {
  const children = childrenByParent.get(nodeId) ?? [];
  return children.some((child) => child.title.toLocaleLowerCase('zh-CN').includes(query) || hasMatchingDescendant(child.id, childrenByParent, query));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(getAppLanguage(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
