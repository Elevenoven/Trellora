import { t, useI18n } from '../../i18n';
import { ActionIcon, Alert, Badge, Button, Group, Menu, ScrollArea, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { Check, ChevronDown, CircleAlert, LocateFixed, Paperclip, Route, Search, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantAiOptions, AssistantAttachment, AssistantThinkingMode } from '../../electron';
import MarkdownContent from '../MarkdownContent';
import { AssistantThinkingTrace, AssistantToolTrace } from '../KnowledgePanel';
import { AssistantComposerAttachments } from '../assistant/AssistantComposerAttachments';
import { AssistantMessageAttachments } from '../assistant/AssistantMessageAttachments';
import { useAssistantAttachments } from '../assistant/useAssistantAttachments';
import { WIKI_QUICK_ACTIONS, type WikiActionKind } from '../../../electron/wiki/wikiQuickActions';
import type { WikiGenerationJob, WikiMapNode, WikiNodeAiRequestOptions, WikiNodeAiState, WikiNodeCitation, WikiRetrievalState } from '../../wiki/wikiTypes';
import type { ResolvedTheme } from '../../utils/theme';
import WikiGenerationProgress from './WikiGenerationProgress';

interface WikiAssistantTabProps {
  node: WikiMapNode;
  aiState: WikiNodeAiState;
  generationJob: WikiGenerationJob | null;
  resolvedTheme: ResolvedTheme;
  assistantAiOptions: AssistantAiOptions;
  operationBusy: boolean;
  onAnalyze: (prompt: string, actionKind: WikiActionKind, attachments: AssistantAttachment[], options: WikiNodeAiRequestOptions) => void;
  onCancel: () => void;
  onRetryTask: (taskId: string) => void;
  onApplyDraft: (mode: 'keep' | 'children') => void;
  onDiscardDraft: () => void;
  onNavigateNode: (nodeId: string) => void;
}

const quickActionHint = '默认先查当前章节；证据不足时最多 5 个周期，并可受控扩大到本文其他章节';

export default function WikiAssistantTab({
  node,
  aiState,
  generationJob,
  resolvedTheme,
  assistantAiOptions,
  operationBusy,
  onAnalyze,
  onCancel,
  onRetryTask,
  onApplyDraft,
  onDiscardDraft,
  onNavigateNode,
}: WikiAssistantTabProps) {
  useI18n();
  const [input, setInput] = useState('');
  const [selectedModelProfileId, setSelectedModelProfileId] = useState(assistantAiOptions.defaultProfileId);
  const [thinkingMode, setThinkingMode] = useState<AssistantThinkingMode>('simple');
  const viewportRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const running = aiState.status === 'running';
  const selectedModelProfile = useMemo(
    () => assistantAiOptions.profiles.find((profile) => profile.id === selectedModelProfileId) ?? null,
    [assistantAiOptions.profiles, selectedModelProfileId],
  );
  const {
    attachments,
    isDragActive,
    addAttachments,
    removeAttachment,
    clearAttachments,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
  } = useAssistantAttachments({ maxCount: 6, disabled: operationBusy });
  // 「猜你想问」芯片（方案 §7.4）：仅 ready 且非空时展示，点击即以 free 动作发送。
  const suggestedQuestions = aiState.questionsStatus === 'ready' ? aiState.suggestedQuestions ?? [] : [];

  const scheduleScrollToBottom = useCallback((force = false) => {
    if (!force && !shouldStickToBottomRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!force && !shouldStickToBottomRef.current) return;
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    shouldStickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
  }, []);

  useEffect(() => {
    scheduleScrollToBottom();
  }, [aiState.messages, aiState.draft, aiState.retrieval, scheduleScrollToBottom]);

  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => scheduleScrollToBottom());
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleScrollToBottom]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    setInput('');
    clearAttachments();
  }, [clearAttachments, node.id]);

  useEffect(() => {
    setSelectedModelProfileId((current) => (
      assistantAiOptions.profiles.some((profile) => profile.id === current)
        ? current
        : assistantAiOptions.defaultProfileId
    ));
  }, [assistantAiOptions.defaultProfileId, assistantAiOptions.profiles]);

  const submit = (prompt: string, actionKind: WikiActionKind) => {
    const text = prompt.trim();
    if (!text || operationBusy || !selectedModelProfile) return;
    const options: WikiNodeAiRequestOptions = {
      thinkingMode,
      ...(selectedModelProfile ? { modelProfileId: selectedModelProfile.id } : {}),
    };
    shouldStickToBottomRef.current = true;
    scheduleScrollToBottom(true);
    onAnalyze(text, actionKind, [...attachments], options);
    setInput('');
    clearAttachments();
  };

  const chooseAttachments = async () => {
    if (!window.electronAPI || operationBusy) return;
    try {
      addAttachments(await window.electronAPI.selectAssistantAttachments());
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '无法添加附件。');
    }
  };

  return (
    <div className="wiki-assistant-tab">
      <div className="wiki-assistant-context">
        <div>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={680} lineClamp={1}>{node.title}</Text>
            <Badge size="xs" variant="light" color={running ? 'blue' : 'teal'}>{running ? t("分析中") : t("当前节点")}</Badge>
          </Group>
          <Text size="xs" c="dimmed" mt={3}>{quickActionHint}</Text>
        </div>
        <Menu position="bottom-end" shadow="md" width={220}>
          <Menu.Target>
            <Button size="xs" variant="default" rightSection={<ChevronDown size={13} />}>{t("快捷动作")}</Button>
          </Menu.Target>
          <Menu.Dropdown>
            {WIKI_QUICK_ACTIONS.map((action) => <Menu.Item key={action.id} onClick={() => submit(action.label, action.id)}>{t(action.label)}</Menu.Item>)}
          </Menu.Dropdown>
        </Menu>
      </div>
      <ScrollArea className="wiki-assistant-scroll" viewportRef={viewportRef} type="auto" onScrollPositionChange={updateScrollState}>
        <Stack ref={messagesContentRef} gap="md" p="md">
          {generationJob ? <WikiGenerationProgress job={generationJob} onRetryTask={onRetryTask} /> : null}
          {aiState.status === 'failed' ? (
            <Alert color="red" icon={<CircleAlert size={16} />} title={t("本次分析未完成")}>
              {aiState.lastError ?? t("请检查模型设置后重新发送。")}
            </Alert>
          ) : null}
          {aiState.messages.length === 0 ? (
            <div className="wiki-assistant-placeholder">
              <Sparkles size={20} />
              <Text size="sm" fw={650}>{t("针对当前章节开始分析")}</Text>
              <Text size="xs" c="dimmed">{t("选择快捷动作，或直接输入你希望生成的内容。")}</Text>
              {aiState.questionsStatus === 'loading' ? (
                <Text size="xs" c="dimmed" mt="sm">{t("正在生成「猜你想问」…")}</Text>
              ) : suggestedQuestions.length > 0 ? (
                <Stack gap={6} mt="md" align="center">
                  <Text size="xs" c="dimmed" fw={650}>{t("猜你想问")}</Text>
                  <Group gap={6} justify="center">
                    {suggestedQuestions.map((question) => (
                      <Button key={question} size="xs" variant="light" radius="xl" disabled={operationBusy} onClick={() => submit(question, 'free')}>
                        {question}
                      </Button>
                    ))}
                  </Group>
                </Stack>
              ) : null}
            </div>
          ) : aiState.messages.map((message) => (
            <article key={message.id} className={`wiki-ai-message ${message.role}`}>
              <Text size="10px" c="dimmed" fw={700}>{message.role === 'user' ? t("你") : 'AI'}</Text>
              {message.role === 'assistant' ? (
                <>
                  {message.toolEvents?.length ? (
                    <AssistantToolTrace
                      events={message.toolEvents}
                      modelEvents={message.modelEvents ?? []}
                      isRunning={Boolean(message.streaming)}
                      executionElapsedMs={message.executionElapsedMs}
                    />
                  ) : null}
                  {message.thinkingText ? (
                    <AssistantThinkingTrace
                      text={message.thinkingText}
                      elapsedMs={message.thinkingElapsedMs}
                      isRunning={Boolean(message.streaming)}
                      hasAnswer={Boolean(message.content)}
                    />
                  ) : null}
                  {message.retrieval ? <WikiEvidenceTrail retrieval={message.retrieval} onNavigateNode={onNavigateNode} /> : null}
                  <MarkdownContent
                    content={message.content}
                    resolvedTheme={resolvedTheme}
                    className="wiki-ai-markdown"
                    isStreaming={Boolean(message.streaming)}
                  />
                </>
              ) : (
                <>
                  <Text size="sm" mt={4}>{message.content}</Text>
                  <AssistantMessageAttachments attachments={message.attachments ?? []} />
                </>
              )}
              {message.streaming ? <span className="wiki-streaming-caret" aria-label={t("正在生成")} /> : null}
              {message.role === 'assistant' && message.citations && message.citations.length > 0 ? (
                <WikiCitationList citations={message.citations} onNavigateNode={onNavigateNode} />
              ) : null}
            </article>
          ))}
          {running && aiState.retrieval ? (
            <WikiEvidenceTrail retrieval={aiState.retrieval} live onNavigateNode={onNavigateNode} />
          ) : null}
          {aiState.draft?.status === 'pending' ? (
            <section className="wiki-ai-draft">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text size="xs" fw={700}>{t("待应用草稿")}</Text>
                  <Text size="sm" fw={650} mt={3}>{aiState.draft.title}</Text>
                </div>
                <Badge size="xs" variant="light" color="yellow">{t("未应用")}</Badge>
              </Group>
              {aiState.draft.proposedChildren.length > 0 ? (
                <Stack gap={4} mt="sm">
                  {aiState.draft.proposedChildren.map((title) => <Text key={title} size="xs">• {title}</Text>)}
                </Stack>
              ) : null}
              <Group gap={6} mt="md">
                {aiState.draft.proposedChildren.length > 0 ? (
                  <Button size="xs" color="teal" leftSection={<Check size={13} />} onClick={() => onApplyDraft('children')}>{t("生成子节点")}</Button>
                ) : null}
                <Button size="xs" variant="default" onClick={() => onApplyDraft('keep')}>{t("保留在当前节点")}</Button>
                <ActionIcon size="sm" variant="subtle" color="red" aria-label={t("丢弃草稿")} onClick={onDiscardDraft}><Trash2 size={14} /></ActionIcon>
              </Group>
            </section>
          ) : null}
        </Stack>
      </ScrollArea>
      {aiState.messages.length > 0 && suggestedQuestions.length > 0 ? (
        <ScrollArea className="wiki-assistant-suggested" type="auto" scrollbarSize={6}>
          <Group gap={6} wrap="nowrap" px="md" py={6}>
            {suggestedQuestions.map((question) => (
              <Button key={question} size="xs" variant="default" radius="xl" disabled={operationBusy} onClick={() => submit(question, 'free')}>
                {question}
              </Button>
            ))}
          </Group>
        </ScrollArea>
      ) : null}
      <div
        className={`wiki-assistant-composer${isDragActive ? ' drag-active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
      >
        <AssistantComposerAttachments attachments={attachments} onRemove={removeAttachment} disabled={operationBusy} />
        <Textarea
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder={t("围绕当前章节提问或生成内容...")}
          autosize
          minRows={2}
          maxRows={5}
          disabled={operationBusy && !running}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(input, 'free');
            }
          }}
        />
        <div className="wiki-assistant-composer-actions">
          <Group className="wiki-assistant-composer-controls" gap={2} wrap="nowrap">
            <Tooltip label={t("添加附件")} withArrow>
              <span>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  disabled={operationBusy || attachments.length >= 6}
                  aria-label={t("添加附件")}
                  onClick={() => void chooseAttachments()}
                >
                  <Paperclip size={16} />
                </ActionIcon>
              </span>
            </Tooltip>
            <Menu position="top-start" shadow="md" width={220} withinPortal>
              <Menu.Target>
                <Button
                  className="wiki-assistant-composer-control"
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  leftSection={<Sparkles size={12} />}
                  rightSection={<ChevronDown size={12} />}
                  disabled={operationBusy}
                  title={t("思考强度：{0}", { '0': thinkingMode === 'advanced' ? t("高级") : t("简单") })}
                >
                  {t("思考：")}{thinkingMode === 'advanced' ? t("高级") : t("简单")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{t("思考强度")}</Menu.Label>
                <Menu.Item
                  className="assistant-thinking-menu-item"
                  data-selected={thinkingMode === 'simple' || undefined}
                  rightSection={thinkingMode === 'simple' ? <Check size={14} aria-hidden="true" /> : null}
                  onClick={() => setThinkingMode('simple')}
                >
                  {t("简单")}<Text size="xs" c="dimmed">{t("快速直接回答")}</Text>
                </Menu.Item>
                <Menu.Item
                  className="assistant-thinking-menu-item"
                  data-selected={thinkingMode === 'advanced' || undefined}
                  rightSection={thinkingMode === 'advanced' ? <Check size={14} aria-hidden="true" /> : null}
                  onClick={() => setThinkingMode('advanced')}
                >
                  {t("高级")}<Text size="xs" c="dimmed">{t("启用更深入的模型思考")}</Text>
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Menu position="top-start" shadow="md" width={280} withinPortal>
              <Menu.Target>
                <Button
                  className="wiki-assistant-composer-control wiki-assistant-model-control"
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  rightSection={<ChevronDown size={12} />}
                  disabled={operationBusy || assistantAiOptions.profiles.length === 0}
                  title={selectedModelProfile ? t("当前模型：{0}", { '0': selectedModelProfile.label }) : t("尚未配置可用模型")}
                >
                  {selectedModelProfile?.label ?? t("未配置模型")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown className="assistant-model-menu-dropdown">
                <Menu.Label>{t("已保存模型")}</Menu.Label>
                <div className="assistant-model-menu-list">
                  {assistantAiOptions.profiles.map((profile) => (
                    <Menu.Item
                      key={profile.id}
                      className="assistant-model-menu-item"
                      data-selected={profile.id === selectedModelProfileId || undefined}
                      rightSection={profile.id === selectedModelProfileId ? <Check size={14} aria-hidden="true" /> : null}
                      onClick={() => setSelectedModelProfileId(profile.id)}
                    >
                      <span className="assistant-model-menu-item-content">
                        <span className="assistant-model-menu-item-name">{profile.label}</span>
                        <span className="assistant-model-menu-item-meta">{profile.model || t("未选择模型")}{profile.kind === 'ollama' ? t(" · 本地") : t(" · 远程")}</span>
                      </span>
                    </Menu.Item>
                  ))}
                </div>
                <Menu.Divider />
                <Menu.Label>{t("模型在“设置 → 模型”中管理")}</Menu.Label>
              </Menu.Dropdown>
            </Menu>
          </Group>
          {running ? (
            <Button size="xs" color="red" variant="light" leftSection={<Square size={13} />} onClick={onCancel}>{t("停止")}</Button>
          ) : (
            <Button size="xs" color="teal" leftSection={<Send size={13} />} disabled={!input.trim() || operationBusy || !selectedModelProfile} onClick={() => submit(input, 'free')}>{t("发送")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 回答引用折叠列表（方案 §4.6）：点击引用号展开章节路径与内容预览。 */
function WikiCitationList({ citations, onNavigateNode }: { citations: WikiNodeCitation[]; onNavigateNode: (nodeId: string) => void }) {
  useI18n();
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <section className="wiki-ai-citations" aria-label={t("回答引用")}>
      <Text size="10px" c="dimmed" fw={700}>{t("回答引用 ·")} {citations.length}</Text>
      <div className="wiki-ai-citation-list">
        {citations.map((citation) => {
          const isExpanded = expanded === citation.reference;
          const pathLabel = citation.nodePath.length > 0 ? citation.nodePath.join(' › ') : t("当前章节");
          return (
            <div className="wiki-ai-citation" key={citation.reference}>
              <button
                type="button"
                className="wiki-ai-citation-toggle"
                aria-expanded={isExpanded}
                title={pathLabel}
                onClick={() => setExpanded((current) => current === citation.reference ? null : citation.reference)}
              >
                <span className="wiki-ai-citation-ref">[{citation.reference}]</span>
                <span className="wiki-ai-citation-path">{pathLabel}</span>
                <ChevronDown size={13} className={isExpanded ? 'wiki-ai-citation-chevron open' : 'wiki-ai-citation-chevron'} />
              </button>
              {isExpanded ? (
                <div className="wiki-ai-citation-details">
                  {citation.preview ? <pre className="wiki-ai-citation-preview">{citation.preview}</pre> : null}
                  {citation.nodeId ? (
                    <button type="button" className="wiki-ai-citation-open" onClick={() => onNavigateNode(citation.nodeId!)}>
                      <LocateFixed size={12} />
                      {t("定位到来源章节")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WikiEvidenceTrail({
  retrieval,
  live = false,
  onNavigateNode,
}: {
  retrieval: WikiRetrievalState;
  live?: boolean;
  onNavigateNode: (nodeId: string) => void;
}) {
  useI18n();
  const scopeLabel = resolveWikiScopeLabel(retrieval, live);
  const detailLabel = resolveWikiScopeDetail(retrieval, live);
  const visibleSections = retrieval.searchedSections.slice(0, 6);
  const hiddenSectionCount = Math.max(0, retrieval.searchedSections.length - visibleSections.length);
  return (
    <section
      className={`wiki-evidence-trail${live ? ' live' : ''}`}
      data-completeness={retrieval.completeness ?? (live ? 'running' : undefined)}
      aria-label={live ? t("当前检索进度") : t("回答证据航迹")}
    >
      <div className="wiki-evidence-trail-head">
        <span className="wiki-evidence-trail-mark" aria-hidden="true"><Route size={13} /></span>
        <span className="wiki-evidence-trail-scope">{scopeLabel}</span>
        <span className="wiki-evidence-trail-cycle">{t("周期")} {retrieval.currentCycle}/{retrieval.maxRetrievalCycles}</span>
      </div>
      {detailLabel ? <div className="wiki-evidence-trail-detail">{detailLabel}</div> : null}
      {visibleSections.length > 0 ? (
        <div className="wiki-evidence-trail-sections">
          <span className="wiki-evidence-trail-sections-label"><Search size={11} />{t("检索章节")}</span>
          <div className="wiki-evidence-trail-section-list">
            {visibleSections.map((section) => {
              const pathLabel = section.nodePath.join(' › ');
              const sectionLabel = section.nodePath.at(-1) ?? t("未命名章节");
              return section.nodeId ? (
                <button key={pathLabel} type="button" title={pathLabel} onClick={() => onNavigateNode(section.nodeId!)}>{sectionLabel}</button>
              ) : (
                <span key={pathLabel} title={pathLabel}>{sectionLabel}</span>
              );
            })}
            {hiddenSectionCount > 0 ? <span>+{hiddenSectionCount}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function resolveWikiScopeLabel(retrieval: WikiRetrievalState, live: boolean): string {
  if (live) return retrieval.activeRange === 'document' ? '正在检索本文其他章节' : '正在检索当前章节';
  if (retrieval.usedOtherSections) return '使用本文其他章节回答';
  if (retrieval.finalScope === 'document') return '已检索整篇文档';
  return '仅当前章节回答';
}

function resolveWikiScopeDetail(retrieval: WikiRetrievalState, live: boolean): string | undefined {
  if (retrieval.escalationReason) {
    const reasons: Record<NonNullable<WikiRetrievalState['escalationReason']>, string> = {
      'explicit-document-scope': '用户问题要求整篇文档范围',
      'explicit-section-reference': '问题指向了其他章节',
      'local-no-hit': '当前章节未命中，已扩大到本文其他章节',
      'local-evidence-incomplete': '当前章节证据不足，已扩大到本文其他章节',
    };
    return reasons[retrieval.escalationReason];
  }
  if (live) return retrieval.newEvidenceCount === 0 && retrieval.phase === 'completed' ? '本周期暂无新证据，正在判断是否继续' : undefined;
  const stopLabels: Record<NonNullable<WikiRetrievalState['stopReason']>, string> = {
    'evidence-sufficient': '证据已满足本轮回答范围',
    'cycle-limit': `已达到 ${retrieval.maxRetrievalCycles} 次受控上限`,
    'no-new-query': '没有新的合法查询路径，已基于现有证据收束',
    'budget-exhausted': '工具预算已用完，答案可能不完整',
    cancelled: '检索已取消',
  };
  return retrieval.stopReason ? stopLabels[retrieval.stopReason] : undefined;
}
