import { t, useI18n } from '../../i18n';
import { ActionIcon, Badge, Group, Tabs, Text, Tooltip } from '@mantine/core';
import { Bot, FileText, History, SquarePen, X } from 'lucide-react';
import { useState } from 'react';
import type { AssistantAiOptions, AssistantAttachment, WikiAiMemory } from '../../electron';
import type { WikiActionKind, WikiGenerationJob, WikiMapNode, WikiNodeAiRequestOptions, WikiNodeAiState } from '../../wiki/wikiTypes';
import type { ResolvedTheme } from '../../utils/theme';
import WikiAssistantTab from './WikiAssistantTab';
import WikiAiMemoryDrawer from './WikiAiMemoryDrawer';
import WikiDocumentTab from './WikiDocumentTab';

export type WikiDetailTab = 'document' | 'ai';

interface WikiDetailPaneProps {
  node: WikiMapNode;
  pathLabel: string;
  documentTitle: string;
  activeTab: WikiDetailTab;
  aiState: WikiNodeAiState;
  generationJob: WikiGenerationJob | null;
  resolvedTheme: ResolvedTheme;
  assistantAiOptions: AssistantAiOptions;
  operationBusy: boolean;
  aiMemories: WikiAiMemory[];
  onTabChange: (tab: WikiDetailTab) => void;
  onClose: () => void;
  onOpenInNotes?: () => void;
  onAnalyze: (prompt: string, actionKind: WikiActionKind, attachments: AssistantAttachment[], options: WikiNodeAiRequestOptions) => void;
  onCancelAnalysis: () => void;
  onRetryTask: (taskId: string) => void;
  onApplyDraft: (mode: 'keep' | 'children') => void;
  onDiscardDraft: () => void;
  onNavigateNode: (nodeId: string) => void;
  onCreateAiMemory: () => Promise<void>;
  onSetAiMemoryPinned: (memoryId: string, pinned: boolean) => Promise<void>;
  onRenameAiMemory: (memoryId: string, title: string) => Promise<void>;
  onDeleteAiMemory: (memoryId: string) => Promise<void>;
}

export default function WikiDetailPane({
  node,
  pathLabel,
  documentTitle,
  activeTab,
  aiState,
  generationJob,
  resolvedTheme,
  assistantAiOptions,
  operationBusy,
  aiMemories,
  onTabChange,
  onClose,
  onOpenInNotes,
  onAnalyze,
  onCancelAnalysis,
  onRetryTask,
  onApplyDraft,
  onDiscardDraft,
  onNavigateNode,
  onCreateAiMemory,
  onSetAiMemoryPinned,
  onRenameAiMemory,
  onDeleteAiMemory,
}: WikiDetailPaneProps) {
  useI18n();
  const [memoryOpened, setMemoryOpened] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const handleCreateConversation = () => {
    if (creatingConversation || operationBusy) return;
    setCreatingConversation(true);
    void onCreateAiMemory().finally(() => setCreatingConversation(false));
  };
  return (
    <div className="wiki-detail-pane">
      <div className="wiki-detail-header">
        <div className="wiki-detail-title-block">
          <Group gap={7} wrap="nowrap">
            <Text size="sm" fw={720} lineClamp={1}>{node.title}</Text>
            {node.kind === 'derived' ? <Badge size="xs" variant="light" color="teal">{t("派生节点")}</Badge> : null}
          </Group>
          <Text size="xs" c="dimmed" lineClamp={1} mt={2}>{pathLabel}</Text>
        </div>
        <Group gap={2} wrap="nowrap">
          <Tooltip label="新建对话" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t("为当前章节新建 AI 对话")}
              disabled={operationBusy || creatingConversation}
              loading={creatingConversation}
              onClick={handleCreateConversation}
            ><SquarePen size={17} /></ActionIcon>
          </Tooltip>
          <Tooltip label={t("Wiki AI 记忆")} withArrow>
            <ActionIcon variant="subtle" color="gray" aria-label={t("打开 Wiki AI 记忆")} onClick={() => setMemoryOpened(true)}><History size={17} /></ActionIcon>
          </Tooltip>
          <Tooltip label={t("关闭详情")} withArrow>
            <ActionIcon variant="subtle" color="gray" aria-label={t("关闭节点详情")} onClick={onClose}><X size={17} /></ActionIcon>
          </Tooltip>
        </Group>
      </div>
      <Tabs className="wiki-detail-tabs" value={activeTab} onChange={(value) => value && onTabChange(value as WikiDetailTab)} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="document" leftSection={<FileText size={14} />}>{t("文档")}</Tabs.Tab>
          <Tabs.Tab value="ai" leftSection={<Bot size={14} />}>AI</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="document" className="wiki-detail-panel">
          <WikiDocumentTab node={node} pathLabel={pathLabel} resolvedTheme={resolvedTheme} onOpenInNotes={onOpenInNotes} />
        </Tabs.Panel>
        <Tabs.Panel value="ai" className="wiki-detail-panel">
          <WikiAssistantTab
            node={node}
            aiState={aiState}
            generationJob={generationJob}
            resolvedTheme={resolvedTheme}
            assistantAiOptions={assistantAiOptions}
            operationBusy={operationBusy}
            onAnalyze={onAnalyze}
            onCancel={onCancelAnalysis}
            onRetryTask={onRetryTask}
            onApplyDraft={onApplyDraft}
            onDiscardDraft={onDiscardDraft}
            onNavigateNode={onNavigateNode}
          />
        </Tabs.Panel>
      </Tabs>
      <WikiAiMemoryDrawer
        opened={memoryOpened}
        documentTitle={documentTitle}
        memories={aiMemories}
        onClose={() => setMemoryOpened(false)}
        onSetPinned={onSetAiMemoryPinned}
        onRename={onRenameAiMemory}
        onDelete={onDeleteAiMemory}
      />
    </div>
  );
}
