import { getAppLanguage, t, useI18n } from '../i18n';
import { normalizeMemorySaveClaims } from '../../shared/memorySaveClaims';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ActionIcon, Badge, Button, Checkbox, Collapse, Group, HoverCard, Menu, Modal, Pagination, Paper, Tabs, Text, Textarea, TextInput, UnstyledButton } from '@mantine/core';
import { Bot, BrainCircuit, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Copy, Database, ExternalLink, FileText, FileUp, Globe, Hash, ImagePlus, Link2, LoaderCircle, PanelRightClose, PanelRightOpen, Plus, RotateCcw, Search, Send, Sparkles, Square, SquareTerminal, Tags, X } from 'lucide-react';
import type { AiProviderStatus, AssistantAiOptions, AssistantAttachment, AssistantCitationValidation, AssistantContextSource, AssistantDetailedTraceRecordView, AssistantEvidenceCitation, AssistantIntent, AssistantKnowledgeBaseCitation, AssistantMemoryMode, AssistantPublicModelEvent, AssistantScope, AssistantSessionDetail, AssistantSessionSummary, AssistantTurnResult, AssistantTurnRequest, AssistantWebCitation, ContextProjectionDiagnostics, CurrentNoteAgentStats, CurrentNotePublicPlanEvent, CurrentNotePublicSearchCoverage, CurrentNotePublicSearchScope, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, NoteAnalysis, NoteMeta, QaSessionSummary, QaStoredTurn, TagSummary } from '../electron';
import CollapsibleAiContent from './CollapsibleAiContent';
import NoteAnalysisBatches from './NoteAnalysisBatches';
import type { NoteAnalysisRunDetail } from '../electron';
import MarkdownContent from './MarkdownContent';
import { getAssistantPlanView, getAssistantSearchCoverageView, translatePlanGoalStatus, translatePlanStatus } from './assistantPlanPresentation';
import { formatKnowledgeBaseCitationMarkdown, getReferencedKnowledgeBaseCitations, getReferencedWebCitations, knowledgeBaseCitationElementId } from './assistantKnowledgeBaseCitations';
import { copyPlainText } from '../utils/clipboard';
import { markAssistantTurnCancelled } from '../utils/assistantTurnLifecycle';
import { AssistantComposerAttachments } from './assistant/AssistantComposerAttachments';
import { AssistantMessageAttachments } from './assistant/AssistantMessageAttachments';
import AssistantConversationNav from './assistant/AssistantConversationNav';
import { useAssistantAttachments } from './assistant/useAssistantAttachments';
import { useAssistantStreamBuffer, type AssistantStreamFlush } from './assistant/useAssistantStreamBuffer';
import SelectionExpansionWorkspace from './assistant/SelectionExpansionWorkspace';
import AssistantSaveNoteModal from './assistant/AssistantSaveNoteModal';
import MemoryTurnStatusBadge from './assistant/MemoryTurnStatusBadge';
import AssistantMemoryCitationList from './assistant/AssistantMemoryCitationList';
import { formatMemoryCitationMarkdown, memoryCitationElementId } from './assistantMemoryCitations';
import type { MemoryCitationSnapshot } from '../../shared/memoryCitations';
import type { CreateAssistantNoteResult } from '../../shared/assistantNote';
import ProviderIcon from './ProviderIcon';
import type { SelectionExpansionDraftSession } from '../editor/selectionExpansion';
import type { SelectionExpansionSettings } from '../electron';

interface KnowledgePanelProps {
  libraryPath: string | null;
  noteMeta: NoteMeta | null;
  noteAnalysis: NoteAnalysis | null;
  noteAnalysisRun?: NoteAnalysisRunDetail | null;
  aiStatus: AiProviderStatus | null;
  isAnalyzingNote: boolean;
  allTags: TagSummary[];
  isCollapsed: boolean;
  width: number;
  onToggleCollapse: () => void;
  onWidthChange: (width: number) => void;
  onSelectTag: (tag: string) => void;
  onGenerateNoteAnalysis: () => Promise<void>;
  onCancelNoteAnalysis?: () => Promise<void>;
  onResumeNoteAnalysis?: () => Promise<void>;
  onAddNoteTag: (tag: string) => Promise<void>;
  onApplySuggestedTags: (tags: string[]) => Promise<void>;
  assistantAiOptions: AssistantAiOptions;
  onRefreshAssistantAiOptions: (profileId?: string) => Promise<AssistantAiOptions>;
  assistantContextRevision: number;
  onStartAssistantTurn: (request: AssistantTurnRequest) => Promise<{ requestId: string }>;
  onCancelAssistantTurn: (requestId: string) => Promise<boolean>;
  onNavigateAssistantCitation?: (citation: AssistantEvidenceCitation) => Promise<AssistantCitationValidation>;
  onAssistantVisibilityChange?: (visible: boolean) => void;
  selectionExpansionSession?: SelectionExpansionDraftSession | null;
  onSelectionExpansionSettingsChange?: (settings: SelectionExpansionSettings) => void;
  onSaveSelectionExpansionDefaults?: (settings: SelectionExpansionSettings) => Promise<void>;
  onStartSelectionExpansion?: () => Promise<void>;
  onCancelSelectionExpansion?: () => Promise<void>;
  onApplySelectionExpansion?: () => void;
  onCloseSelectionExpansion?: () => void;
}

export interface AssistantContextSourceOption {
  source: AssistantContextSource;
  description: string;
  disabled?: boolean;
}

export type KnowledgeAssistantProps = Pick<KnowledgePanelProps,
  | 'libraryPath'
  | 'noteMeta'
  | 'assistantAiOptions'
  | 'onRefreshAssistantAiOptions'
  | 'assistantContextRevision'
  | 'onStartAssistantTurn'
  | 'onCancelAssistantTurn'
  | 'onNavigateAssistantCitation'
> & Partial<Pick<KnowledgePanelProps, 'width' | 'onWidthChange'>> & {
  onWidthPreviewChange?: (width: number) => number;
  /** 嵌入侧栏时，在助手工具栏提供关闭入口。 */
  onClose?: () => void;
  onOpenFile?: (path: string) => void;
  fixedContextSources?: AssistantContextSource[];
  contextSourceOptions?: AssistantContextSourceOption[];
  selectedContextSourcePath?: string | null;
  onSelectContextSource?: (libraryPath: string | null) => void;
  /** 向工作台报告当前会话是否已有内容，用于安全切换问答模式。 */
  onConversationActivityChange?: (hasContent: boolean) => void;
  /** 外部预填的问题草稿（如地图视图「就这个社区提问」）；变化时写入输入框。 */
  initialDraft?: string | null;
  /** Tutorial controls never infer success; main attests the bound request. */
  onboarding?: { profileId?: string; sendDisabled: boolean; draftRequest?: { id: number; text: string }; prepareSend?: () => Promise<{ sessionId: string; profileId: string } | undefined> };
  onComposerStateChange?: (state: { hasDraft: boolean; busy: boolean; failed: boolean }) => void;
  /** 由外层工作台控制调试轨道时使用；未提供则保留组件内的独立开关。 */
  debugRailOpen?: boolean;
  onDebugRailOpenChange?: (open: boolean) => void;
  /** 外层已经提供调试轨道入口时，隐藏对话工具栏中的重复入口。 */
  hideDebugRailToggle?: boolean;
  /** 外层工作台承接新对话操作时，隐藏对话工具栏中的重复入口。 */
  hideNewConversationAction?: boolean;
  /** 问答首页显示当前会话的问题导航，笔记侧栏保持原有布局。 */
  showConversationNavigation?: boolean;
  workspaceMemory?: {
    sessionId: string | null;
    turns: QaStoredTurn[];
    revision: number;
    /** Data relocation refreshes references while keeping the unsent question and attachments. */
    preserveComposer?: boolean;
    onCreateSession: () => Promise<QaSessionSummary>;
    onSessionCreated: (session: QaSessionSummary) => void;
    onNewSession: () => Promise<void>;
    onTurnSettled: () => void;
  };
};

type PanelTab = 'info' | 'ai';

const minimumPanelWidth = 260;
const minimumWorkspaceWidth = 360;
const collapsePanelWidth = 176;

export default function KnowledgePanel(props: KnowledgePanelProps) {
  useI18n();
  const notePath = props.noteMeta?.path;
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(props.width);
  const preferredWidthRef = useRef(props.width);
  const [panelWidth, setPanelWidth] = useState(props.width);
  const [activeTab, setActiveTab] = useState<PanelTab>('info');
  const { isCollapsed, onAssistantVisibilityChange } = props;

  const getWorkspaceWidth = useCallback(() => {
    return panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  }, []);

  const constrainPanelWidth = useCallback((width: number): number => {
    const workspaceWidth = getWorkspaceWidth();
    const availableWidth = workspaceWidth - minimumWorkspaceWidth;
    return Math.max(minimumPanelWidth, Math.min(Math.max(minimumPanelWidth, availableWidth), width));
  }, [getWorkspaceWidth]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [notePath]);

  useEffect(() => {
    onAssistantVisibilityChange?.(!isCollapsed && activeTab === 'ai');
  }, [activeTab, isCollapsed, onAssistantVisibilityChange]);

  useEffect(() => {
    if (props.selectionExpansionSession && !props.isCollapsed) setActiveTab('ai');
  }, [props.isCollapsed, props.selectionExpansionSession]);

  useEffect(() => {
    preferredWidthRef.current = props.width;
    const nextWidth = constrainPanelWidth(props.width);
    widthRef.current = nextWidth;
    setPanelWidth(nextWidth);
  }, [constrainPanelWidth, props.width]);

  useEffect(() => {
    const handleWindowResize = () => {
      const nextWidth = constrainPanelWidth(preferredWidthRef.current);
      widthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    };
    window.addEventListener('resize', handleWindowResize);
    const workspaceElement = panelRef.current?.parentElement;
    let resizeObserver: ResizeObserver | null = null;
    if (workspaceElement && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleWindowResize);
      resizeObserver.observe(workspaceElement);
    }
    handleWindowResize();
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver?.disconnect();
    };
  }, [constrainPanelWidth, props.isCollapsed]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    let isCollapsing = false;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const rawWidth = startWidth + startX - moveEvent.clientX;
      if (rawWidth <= collapsePanelWidth) {
        isCollapsing = true;
        finishResize();
        props.onToggleCollapse();
        return;
      }
      const nextWidth = constrainPanelWidth(rawWidth);
      widthRef.current = nextWidth;
      preferredWidthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    };
    const finishResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('blur', finishResize);
      document.body.classList.remove('resizing-knowledge-panel');
      if (!isCollapsing) props.onWidthChange(widthRef.current);
    };
    document.body.classList.add('resizing-knowledge-panel');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize, { once: true });
    window.addEventListener('pointercancel', finishResize, { once: true });
    window.addEventListener('blur', finishResize, { once: true });
  };

  const previewPanelWidth = useCallback((width: number): number => {
    const nextWidth = constrainPanelWidth(width);
    widthRef.current = nextWidth;
    preferredWidthRef.current = nextWidth;
    setPanelWidth(nextWidth);
    return nextWidth;
  }, [constrainPanelWidth]);

  if (props.isCollapsed) {
    return <aside className="knowledge-panel-collapsed"><ActionIcon title={t("展开右侧栏")} aria-label={t("展开右侧栏")} variant="subtle" color="gray" size="md" onClick={props.onToggleCollapse}><PanelRightOpen size={16} /></ActionIcon></aside>;
  }

  return (
    <aside
      ref={panelRef}
      className="knowledge-panel"
      style={{ width: panelWidth, flexBasis: panelWidth }}
    >
      <div className="knowledge-panel-resizer" role="separator" aria-label={t("调整右侧栏宽度，向右拖到底可收起")} aria-orientation="vertical" onPointerDown={startResize} />
      <div className="knowledge-panel-header">
        <Tabs value={activeTab} onChange={(value) => value && setActiveTab(value as PanelTab)} className="knowledge-tabs" aria-label={t("右侧栏")}>
          <Tabs.List>
            <Tabs.Tab value="info">{t("笔记信息")}</Tabs.Tab>
            <Tabs.Tab value="ai">{t("AI 助手")}</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <ActionIcon title={t("收起右侧栏")} aria-label={t("收起右侧栏")} variant="subtle" color="gray" size="md" onClick={props.onToggleCollapse}><PanelRightClose size={15} /></ActionIcon>
      </div>
      <div ref={scrollRef} className={`knowledge-panel-scroll${activeTab === 'ai' ? ' ai-active' : ''}`}>
        {activeTab === 'info' ? <InfoTab {...props} /> : null}
        {activeTab === 'ai' ? <>
          <div className="knowledge-panel-ai-view" hidden={Boolean(props.selectionExpansionSession)}><KnowledgeAssistant {...props} width={panelWidth} onWidthPreviewChange={previewPanelWidth} /></div>
          {props.selectionExpansionSession && props.onSelectionExpansionSettingsChange && props.onSaveSelectionExpansionDefaults && props.onStartSelectionExpansion && props.onCancelSelectionExpansion && props.onApplySelectionExpansion && props.onCloseSelectionExpansion ? <SelectionExpansionWorkspace
            session={props.selectionExpansionSession}
            onChange={props.onSelectionExpansionSettingsChange}
            onSaveDefaults={props.onSaveSelectionExpansionDefaults}
            onStart={props.onStartSelectionExpansion}
            onCancel={props.onCancelSelectionExpansion}
            onApply={props.onApplySelectionExpansion}
            onClose={props.onCloseSelectionExpansion}
          /> : null}
        </> : null}
      </div>
    </aside>
  );
}

type AssistantMessageState = 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';

interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  intent: AssistantIntent;
  scope: AssistantScope;
  scopeLabel: string;
  interactionRoute?: 'chat' | 'clarify' | 'react';
  content: string;
  /** 仅保留在当前渲染会话，用于回显本轮已发送附件；不会进入文字历史或持久化记忆。 */
  attachments?: AssistantAttachment[];
  createdAt: string;
  state: AssistantMessageState;
  statusMessage?: string;
  error?: string;
  result?: AssistantTurnResult;
  contextDiagnostics?: ContextProjectionDiagnostics;
  evidence?: AssistantEvidenceCitation[];
  toolEvents?: CurrentNotePublicToolEvent[];
  planEvents?: CurrentNotePublicPlanEvent[];
  modelEvents?: AssistantPublicModelEvent[];
  executionElapsedMs?: number;
  /** 本轮流式接收的深度思考原文；完成后以 result.thinkingText 为准。 */
  thinkingText?: string;
  isStale?: boolean;
  /** 开放式问答建议追问（仅当下会话，不随历史恢复）。 */
  suggestions?: string[];
  /** 后台画像任务完成后的非阻塞回执；不包含画像正文。 */
  profileUpdatedCount?: number;
  /** 本次回答实际注入并写入账本的长期记忆快照。 */
  usedMemories?: MemoryCitationSnapshot[];
  memorySave?: import('../../electron/knowledge/memory/memoryTypes').MemorySaveReceipt;
}

function restoreWorkspaceMessages(turns: QaStoredTurn[]): AssistantMessage[] {
  return turns.flatMap((turn) => {
    const result = turn.result;
    const completed = turn.status === 'complete' || turn.status === 'partial' || turn.status === 'not-found';
    const restoredScope: AssistantScope = result?.type === 'answer' && result.retrievalMode === 'none' ? 'chat' : 'library-search';
    const error = turn.status === 'interrupted'
      ? t("上一轮在应用关闭前中断。")
      : turn.status === 'error'
          ? t("本轮未能完成。")
          : turn.status === 'pending'
            ? t("本轮仍在处理中。")
            : undefined;
    return [
      {
        id: `${turn.turnId}-user`,
        role: 'user' as const,
        intent: 'ask' as const,
        scope: restoredScope,
        scopeLabel: turn.scopeLabel,
        interactionRoute: result?.type === 'answer' ? result.interactionRoute : undefined,
        content: turn.userText,
        createdAt: turn.createdAt,
        state: 'complete' as const,
      },
      {
        id: turn.turnId,
        role: 'assistant' as const,
        intent: 'ask' as const,
        scope: restoredScope,
        scopeLabel: turn.scopeLabel,
        content: turn.assistantText ?? '',
        createdAt: turn.finishedAt ?? turn.createdAt,
        state: completed ? 'complete' as const : turn.status === 'cancelled' ? 'cancelled' as const : 'error' as const,
        ...(result ? { result } : {}),
        ...(result?.type === 'answer' ? {
          toolEvents: result.toolEvents,
          modelEvents: result.modelEvents,
          executionElapsedMs: result.executionElapsedMs,
        } : {}),
        ...(turn.usedMemories?.length ? { usedMemories: turn.usedMemories } : {}),
        ...(error ? { error } : {}),
      },
    ];
  });
}

type AssistantPreset = { id: string; intent: AssistantIntent; scope: AssistantScope; label: string; draft: string };

const assistantPresets: AssistantPreset[] = [
  { id: 'ask', intent: 'ask', scope: 'current-note', label: '当前笔记问答', draft: '请根据当前笔记回答：' },
  { id: 'summary-complete', intent: 'ask', scope: 'current-note', label: '完整总结当前笔记', draft: '请完整总结当前笔记。' },
  { id: 'summary-quick', intent: 'ask', scope: 'current-note', label: '快速概括当前笔记', draft: '请用三句话快速概括当前笔记。' },
  { id: 'learning-plan', intent: 'learning-plan', scope: 'library-search', label: '制定学习路径', draft: '请为我制定学习路径。学习目标：' },
  { id: 'organize', intent: 'organize', scope: 'library-structure', label: '整理建议', draft: '请给出保守、可执行的知识库整理建议；不要移动、修改或自动应用任何笔记。' },
];

const emptyAssistantContextSources: AssistantContextSource[] = [];

export function KnowledgeAssistant(props: KnowledgeAssistantProps) {
  useI18n();
  const notePath = props.noteMeta?.path ?? null;
  const fixedContextSources = props.fixedContextSources ?? emptyAssistantContextSources;
  const fixedContextKey = fixedContextSources.map((source) => `${source.kind}:${source.libraryPath}:${source.label ?? ''}`).join('|');
  const isContextLocked = fixedContextSources.length > 0;
  const isDataSourceWorkspace = props.contextSourceOptions !== undefined;
  const onConversationActivityChange = props.onConversationActivityChange;
  const onComposerStateChange = props.onComposerStateChange;
  const controlledDebugRailOpen = props.debugRailOpen;
  const onDebugRailOpenChange = props.onDebugRailOpenChange;
  const defaultScope: AssistantScope = isContextLocked ? 'library-search' : isDataSourceWorkspace ? 'chat' : notePath ? 'current-note' : 'library-search';
  const onCancelAssistantTurn = props.onCancelAssistantTurn;
  const onRefreshAssistantAiOptions = props.onRefreshAssistantAiOptions;
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const messageScrollFrameRef = useRef<number | null>(null);
  const assistantWorkspaceRef = useRef<HTMLDivElement>(null);
  const initialDebugRailWidth = props.width === undefined
    ? 304
    : Math.max(270, Math.min(304, props.width - 10));
  const debugRailWidthRef = useRef(initialDebugRailWidth);
  const previewPanelWidthRef = useRef(props.width ?? 0);
  const activeRequestIdRef = useRef<string | null>(null);
  const turnContextKey = JSON.stringify([props.libraryPath, notePath, fixedContextKey, props.workspaceMemory?.revision]);
  const turnContextKeyRef = useRef(turnContextKey);
  useLayoutEffect(() => {
    turnContextKeyRef.current = turnContextKey;
  }, [turnContextKey]);
  const lastSettledRequestIdRef = useRef<string | null>(null);
  const workspaceMemoryRef = useRef(props.workspaceMemory);
  const previousLibraryPathRef = useRef(props.libraryPath);
  const previousNotePathRef = useRef(notePath);
  const previousRevisionRef = useRef(props.assistantContextRevision);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isMessageListAtBottom, setIsMessageListAtBottom] = useState(true);
  const applyAssistantStreamFlush = useCallback((flush: AssistantStreamFlush) => {
    setMessages((current) => current.map((message) => {
      if (message.id !== flush.requestId || message.role !== 'assistant') return message;
      return {
        ...message,
        ...(flush.contentDelta ? {
          content: `${message.content}${flush.contentDelta}`,
          state: 'streaming' as const,
          statusMessage: undefined,
        } : {}),
        ...(flush.thinkingDelta ? {
          thinkingText: `${message.thinkingText ?? ''}${flush.thinkingDelta}`,
          statusMessage: undefined,
        } : {}),
      };
    }));
  }, []);
  const {
    enqueue: enqueueAssistantStream,
    flush: flushAssistantStream,
    reset: resetAssistantStream,
  } = useAssistantStreamBuffer(applyAssistantStreamFlush);
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<AssistantIntent>('ask');
  const [scope, setScope] = useState<AssistantScope>(defaultScope);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [selectedModelProfileId, setSelectedModelProfileId] = useState(props.assistantAiOptions.defaultProfileId);
  const [thinkingMode, setThinkingMode] = useState<NonNullable<AssistantTurnRequest['thinkingMode']>>('simple');
  const [answerDepth, setAnswerDepth] = useState<NonNullable<AssistantTurnRequest['answerDepth']>>('auto');
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const previousFixedContextKeyRef = useRef(fixedContextKey);
  const [contextSources, setContextSources] = useState<AssistantContextSource[]>(fixedContextSources);
  const attachmentsDisabled = Boolean(activeRequestId) || intent === 'organize' || Boolean(props.onboarding);
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
  } = useAssistantAttachments({ maxCount: 6, disabled: attachmentsDisabled });
  const [assistantSessionId, setAssistantSessionId] = useState<string | null>(null);
  const [assistantSessions, setAssistantSessions] = useState<AssistantSessionSummary[]>([]);
  const [assistantMemoryMode, setAssistantMemoryMode] = useState<AssistantMemoryMode>('persistent');
  const [replacementDraft, setReplacementDraft] = useState<string | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const lastDraftRequest = useRef<number>();
  const [uncontrolledDebugRailOpen, setUncontrolledDebugRailOpen] = useState(false);
  const [debugRailWidth, setDebugRailWidth] = useState(initialDebugRailWidth);
  const [debugTurnId, setDebugTurnId] = useState<string | null>(null);
  const [debugMemory, setDebugMemory] = useState<AssistantSessionDetail | null>(null);
  const refreshedDebugTurnRef = useRef<string | null>(null);
  const onWidthPreviewChange = props.onWidthPreviewChange;
  const onWidthChange = props.onWidthChange;
  const isDebugRailOpen = controlledDebugRailOpen ?? uncontrolledDebugRailOpen;
  const setDebugRailOpen = useCallback((open: boolean) => {
    if (controlledDebugRailOpen === undefined) setUncontrolledDebugRailOpen(open);
    onDebugRailOpenChange?.(open);
  }, [controlledDebugRailOpen, onDebugRailOpenChange]);

  const updateAssistantScrollState = useCallback(() => {
    const scroll = messagesScrollRef.current;
    if (!scroll) return;
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
    shouldStickToBottomRef.current = atBottom;
    setIsMessageListAtBottom((current) => current === atBottom ? current : atBottom);
  }, []);

  const scrollMessagesToBottom = useCallback((force = false) => {
    if (force) {
      shouldStickToBottomRef.current = true;
      setIsMessageListAtBottom(true);
    }
    if (messageScrollFrameRef.current !== null) window.cancelAnimationFrame(messageScrollFrameRef.current);
    messageScrollFrameRef.current = window.requestAnimationFrame(() => {
      messageScrollFrameRef.current = null;
      if (!force && !shouldStickToBottomRef.current) return;
      const scroll = messagesScrollRef.current;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }, []);

  // 手动定位旧问题时停止跟随流式输出，并撤销尚未执行的滚动到底部任务。
  const pauseConversationFollowing = useCallback(() => {
    shouldStickToBottomRef.current = false;
    setIsMessageListAtBottom(false);
    if (messageScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messageScrollFrameRef.current);
      messageScrollFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    workspaceMemoryRef.current = props.workspaceMemory;
  }, [props.workspaceMemory]);

  useEffect(() => {
    onConversationActivityChange?.(messages.length > 0);
  }, [messages.length, onConversationActivityChange]);

  useEffect(() => {
    onComposerStateChange?.({ hasDraft: Boolean(draft.trim()), busy: Boolean(activeRequestId), failed: messages.at(-1)?.state === 'error' || messages.at(-1)?.state === 'cancelled' });
  }, [activeRequestId, draft, messages, onComposerStateChange]);
  useEffect(() => {
    const request = props.onboarding?.draftRequest;
    if (!request || lastDraftRequest.current === request.id) return;
    lastDraftRequest.current = request.id;
    if (draftRef.current.trim()) setReplacementDraft(request.text);
    else { setDraft(request.text); window.requestAnimationFrame(() => assistantWorkspaceRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()); }
  }, [props.onboarding?.draftRequest]);
  useEffect(() => {
    const profileId = props.onboarding?.profileId;
    if (!profileId) return;
    setSelectedModelProfileId(profileId); setIntent('ask'); setScope('chat'); setSelectedSkillIds([]);
    void onRefreshAssistantAiOptions(profileId).catch(() => undefined);
  }, [onRefreshAssistantAiOptions, props.onboarding?.profileId]);

  // 外部预填草稿：仅在新草稿到达时写入，不覆盖用户正在输入的内容。
  useEffect(() => {
    if (props.initialDraft) setDraft(props.initialDraft);
  }, [props.initialDraft]);

  const constrainDebugRailWidth = useCallback((width: number): number => {
    const minimumWidth = 270;
    const maximumWidth = onWidthPreviewChange
      ? 720
      : Math.max(minimumWidth, (assistantWorkspaceRef.current?.clientWidth ?? window.innerWidth) - 240);
    return Math.max(minimumWidth, Math.min(maximumWidth, width));
  }, [onWidthPreviewChange]);

  const applyDebugRailWidth = useCallback((nextWidth: number, panelWidth?: number): number => {
    const constrainedWidth = constrainDebugRailWidth(nextWidth);
    debugRailWidthRef.current = constrainedWidth;
    setDebugRailWidth(constrainedWidth);
    if (onWidthPreviewChange && panelWidth !== undefined) {
      previewPanelWidthRef.current = onWidthPreviewChange(panelWidth);
    }
    return constrainedWidth;
  }, [constrainDebugRailWidth, onWidthPreviewChange]);

  const startDebugRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startRailWidth = debugRailWidthRef.current;
    const startPanelWidth = props.width ?? assistantWorkspaceRef.current?.clientWidth ?? 0;
    const canPreviewPanelWidth = Boolean(onWidthPreviewChange && onWidthChange && props.width !== undefined);
    previewPanelWidthRef.current = startPanelWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextRailWidth = constrainDebugRailWidth(startRailWidth + delta);
      const actualDelta = nextRailWidth - startRailWidth;
      applyDebugRailWidth(nextRailWidth, canPreviewPanelWidth ? startPanelWidth + actualDelta : undefined);
    };
    const finishResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('blur', finishResize);
      document.body.classList.remove('resizing-knowledge-debug-rail');
      if (canPreviewPanelWidth) onWidthChange?.(previewPanelWidthRef.current);
    };

    document.body.classList.add('resizing-knowledge-debug-rail');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize, { once: true });
    window.addEventListener('pointercancel', finishResize, { once: true });
    window.addEventListener('blur', finishResize, { once: true });
  };

  const handleDebugRailResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? 16 : -16;
    const nextRailWidth = constrainDebugRailWidth(debugRailWidthRef.current + direction);
    const actualDelta = nextRailWidth - debugRailWidthRef.current;
    const nextPanelWidth = props.width !== undefined ? props.width + actualDelta : undefined;
    applyDebugRailWidth(nextRailWidth, nextPanelWidth);
    if (nextPanelWidth !== undefined) onWidthChange?.(previewPanelWidthRef.current);
  };

  useEffect(() => {
    const constrainCurrentWidth = () => {
      const nextWidth = constrainDebugRailWidth(debugRailWidthRef.current);
      debugRailWidthRef.current = nextWidth;
      setDebugRailWidth(nextWidth);
    };
    window.addEventListener('resize', constrainCurrentWidth);
    const workspaceElement = assistantWorkspaceRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (workspaceElement && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(constrainCurrentWidth);
      resizeObserver.observe(workspaceElement);
    }
    constrainCurrentWidth();
    return () => {
      window.removeEventListener('resize', constrainCurrentWidth);
      resizeObserver?.disconnect();
    };
  }, [constrainDebugRailWidth, isDebugRailOpen]);

  useEffect(() => {
    void onRefreshAssistantAiOptions().catch(() => undefined);
  }, [onRefreshAssistantAiOptions]);

  const refreshAssistantMemory = useCallback(async () => {
    if (!notePath || !window.electronAPI) {
      setAssistantSessions([]);
      return;
    }
    const settings = await window.electronAPI.getAssistantMemorySettings();
    setAssistantMemoryMode(settings.mode);
    if (settings.mode !== 'persistent') {
      setAssistantSessions([]);
      return;
    }
    const sessions = await window.electronAPI.listAssistantMemorySessions(notePath);
    setAssistantSessions(sessions.items);
  }, [notePath]);

  useEffect(() => {
    void refreshAssistantMemory().catch(() => {
      setAssistantSessions([]);
    });
  }, [refreshAssistantMemory]);

  const refreshDebugMemory = useCallback(async (sessionId = assistantSessionId) => {
    if (!notePath || !sessionId || !window.electronAPI || assistantMemoryMode !== 'persistent') {
      setDebugMemory(null);
      return;
    }
    const detail = await window.electronAPI.getAssistantMemorySession(notePath, sessionId);
    setDebugMemory(detail);
  }, [assistantMemoryMode, assistantSessionId, notePath]);

  useEffect(() => {
    if (!isDebugRailOpen) return;
    void refreshDebugMemory().catch(() => setDebugMemory(null));
  }, [isDebugRailOpen, refreshDebugMemory]);

  const cancelActiveTurn = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void onCancelAssistantTurn(requestId);
  }, [onCancelAssistantTurn]);

  const cancelAndSettleActiveTurn = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void onCancelAssistantTurn(requestId);
    flushAssistantStream(requestId);
    lastSettledRequestIdRef.current = requestId;
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setMessages((current) => markAssistantTurnCancelled(current, requestId));
  }, [flushAssistantStream, onCancelAssistantTurn]);

  useEffect(() => {
    const workspaceMemory = workspaceMemoryRef.current;
    if (!workspaceMemory) return;
    cancelActiveTurn();
    resetAssistantStream();
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setAssistantSessionId(workspaceMemory.sessionId);
    setMessages(restoreWorkspaceMessages(workspaceMemory.turns));
    if (!workspaceMemory.preserveComposer) {
      if (!props.onboarding) setDraft('');
      setIntent('ask');
      clearAttachments();
    }
    // A confirmed practice switch carries the existing draft until explicitly replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelActiveTurn, clearAttachments, props.workspaceMemory?.revision, resetAssistantStream]);

  useEffect(() => {
    const previous = previousFixedContextKeyRef.current;
    previousFixedContextKeyRef.current = fixedContextKey;
    if (previous === fixedContextKey) return;
    if (isDataSourceWorkspace) {
      // 外层工作台已在跨模式时新建会话；这里只同步当前模式与检索来源。
      setScope(defaultScope);
      setContextSources(fixedContextSources);
      return;
    }
    cancelActiveTurn();
    resetAssistantStream();
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setMessages([]);
    setDraft('');
    setIntent('ask');
    setScope(defaultScope);
    setContextSources(fixedContextSources);
    clearAttachments();
    setAssistantSessionId(null);
    setAssistantSessions([]);
  }, [cancelActiveTurn, clearAttachments, defaultScope, fixedContextKey, fixedContextSources, isDataSourceWorkspace, resetAssistantStream]);

  useEffect(() => {
    if (!window.electronAPI?.onAssistantTurnEvent) return;
    return window.electronAPI.onAssistantTurnEvent((event) => {
      // suggestions 事件在 complete 之后到达，此时 activeRequestId 已清空，需按最近 settled 轮放行。
      const isFollowUpForSettledTurn = event.type === 'suggestions' && event.requestId === lastSettledRequestIdRef.current;
      const isProfileReceipt = event.type === 'profile-updated';
      if (event.requestId !== activeRequestIdRef.current && !isFollowUpForSettledTurn && !isProfileReceipt) return;
      if (event.type === 'delta') {
        enqueueAssistantStream(event.requestId, 'content', event.text);
        return;
      }
      if (event.type === 'thinking-delta') {
        enqueueAssistantStream(event.requestId, 'thinking', event.text);
        return;
      }
      if (event.type === 'started' || event.type === 'delta-reset') resetAssistantStream(event.requestId);
      if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') {
        flushAssistantStream(event.requestId);
      }
      const interactionRoute = event.type === 'complete' && event.result.type === 'answer'
        ? event.result.interactionRoute
        : undefined;
      // 视图未传 workspaceMemory 时（如资料库 AI 助手），请求不带 sessionId，
      // 主进程会为每轮自动建会话；轮完成时回传 qaSessionId，这里接管它，
      // 让后续轮落入同一会话，问题改写热窗才能看到历史轮。
      const completedQaSessionId = event.type === 'complete' && event.result.type === 'answer'
        ? event.result.qaSessionId
        : undefined;
      if (completedQaSessionId) {
        setAssistantSessionId((current) => current ?? completedQaSessionId);
      }
      setMessages((current) => current.map((message) => {
        if (event.type === 'route') {
          return message.id === `${event.requestId}-user` && message.role === 'user'
            ? { ...message, interactionRoute: event.interactionRoute }
            : message;
        }
        if (interactionRoute && message.id === `${event.requestId}-user` && message.role === 'user') {
          return { ...message, interactionRoute };
        }
        if (message.id !== event.requestId || message.role !== 'assistant') return message;
        if (event.type === 'started') return { ...message, scopeLabel: event.scopeLabel, statusMessage: t("正在准备…"), state: 'pending' };
        if (event.type === 'status') return { ...message, statusMessage: event.message, state: 'pending' };
        if (event.type === 'tool') return { ...message, toolEvents: [...(message.toolEvents ?? []), event.event], statusMessage: undefined, state: 'pending' };
        if (event.type === 'plan') return { ...message, planEvents: [...(message.planEvents ?? []), event.event], statusMessage: undefined, state: event.event.phase === 'finished' ? message.state : 'pending' };
        if (event.type === 'model') return { ...message, modelEvents: [...(message.modelEvents ?? []), event.event], statusMessage: undefined, state: 'pending' };
        if (event.type === 'context-diagnostics') return { ...message, contextDiagnostics: event.diagnostics };
        if (event.type === 'profile-updated') return { ...message, profileUpdatedCount: event.updatedItemCount };
        if (event.type === 'memory-used') return { ...message, usedMemories: event.items };
        if (event.type === 'memory-saved') return { ...message, memorySave: event.receipt };
        if (event.type === 'delta-reset') return { ...message, content: '', state: 'pending', statusMessage: undefined };
        if (event.type === 'complete') {
          return {
            ...message,
            content: event.result.type === 'answer' ? event.result.answer : message.content,
            state: 'complete',
            statusMessage: undefined,
            result: event.result,
            toolEvents: event.result.type === 'answer' ? event.result.toolEvents ?? message.toolEvents : message.toolEvents,
            planEvents: event.result.type === 'answer' ? event.result.planEvents ?? message.planEvents : message.planEvents,
            modelEvents: event.result.type === 'answer' ? event.result.modelEvents ?? message.modelEvents : message.modelEvents,
            executionElapsedMs: event.result.type === 'answer' ? event.result.executionElapsedMs : message.executionElapsedMs,
            isStale: event.result.type === 'answer' ? event.result.isStale : message.isStale,
            contextDiagnostics: event.result.type === 'answer' ? event.result.contextDiagnostics ?? message.contextDiagnostics : message.contextDiagnostics,
          };
        }
        if (event.type === 'suggestions') return { ...message, suggestions: event.questions };
        if (event.type === 'error') return { ...message, state: 'error', statusMessage: undefined, error: event.message };
        return { ...message, state: 'cancelled', statusMessage: undefined };
      }));
      if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') {
        lastSettledRequestIdRef.current = event.requestId;
        activeRequestIdRef.current = null;
        setActiveRequestId(null);
        workspaceMemoryRef.current?.onTurnSettled();
      }
    });
  }, [enqueueAssistantStream, flushAssistantStream, resetAssistantStream]);

  useEffect(() => {
    const previous = previousLibraryPathRef.current;
    previousLibraryPathRef.current = props.libraryPath;
    if (previous === props.libraryPath) return;
    cancelActiveTurn();
    resetAssistantStream();
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setMessages([]);
    setDraft('');
    setIntent('ask');
    setScope(defaultScope);
    setContextSources([]);
    clearAttachments();
    setAssistantSessionId(null);
    setAssistantSessions([]);
  }, [cancelActiveTurn, clearAttachments, defaultScope, props.libraryPath, resetAssistantStream]);

  useEffect(() => {
    const previous = previousNotePathRef.current;
    previousNotePathRef.current = notePath;
    if (previous === notePath) return;
    cancelAndSettleActiveTurn();
    setMessages((current) => current.map((message) => message.role === 'assistant' && message.state === 'complete'
      ? { ...message, isStale: true }
      : message));
    setAssistantSessionId(null);
    setAssistantSessions([]);
    setScope(defaultScope);
    setContextSources(fixedContextSources);
  }, [cancelAndSettleActiveTurn, defaultScope, fixedContextSources, notePath]);

  useEffect(() => {
    const previous = previousRevisionRef.current;
    previousRevisionRef.current = props.assistantContextRevision;
    if (previous === props.assistantContextRevision) return;
    setMessages((current) => current.map((message) => message.role === 'assistant' && message.state === 'complete'
      ? { ...message, isStale: true }
      : message));
  }, [props.assistantContextRevision]);

  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) scrollMessagesToBottom();
    });
    observer.observe(content);
    if (shouldStickToBottomRef.current) scrollMessagesToBottom();
    return () => observer.disconnect();
  }, [scrollMessagesToBottom]);

  useEffect(() => {
    if (shouldStickToBottomRef.current) scrollMessagesToBottom();
  }, [messages.length, scrollMessagesToBottom]);

  useEffect(() => () => {
    if (messageScrollFrameRef.current !== null) window.cancelAnimationFrame(messageScrollFrameRef.current);
    // 卸载也使尚未完成的建会话操作失效，迟到的 IPC 结果不能继续发送。
    activeRequestIdRef.current = null;
  }, []);

  useEffect(() => {
    if (!isDebugRailOpen) return;
    const latest = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!latest) {
      setDebugTurnId(null);
      return;
    }
    setDebugTurnId((current) => messages.some((message) => message.id === current) ? current : latest.id);
  }, [isDebugRailOpen, messages]);

  useEffect(() => {
    if (!isDebugRailOpen || !assistantSessionId || assistantMemoryMode !== 'persistent') return;
    const latestCompleted = [...messages].reverse().find((message) => message.role === 'assistant' && message.state === 'complete');
    if (!latestCompleted || refreshedDebugTurnRef.current === latestCompleted.id) return;
    refreshedDebugTurnRef.current = latestCompleted.id;
    void refreshDebugMemory().catch(() => setDebugMemory(null));
  }, [assistantMemoryMode, assistantSessionId, isDebugRailOpen, messages, refreshDebugMemory]);

  useEffect(() => {
    const profiles = props.assistantAiOptions.profiles;
    if (!profiles.some((profile) => profile.id === selectedModelProfileId)) {
      setSelectedModelProfileId(profiles.find((profile) => profile.id === props.assistantAiOptions.defaultProfileId)?.id ?? profiles[0]?.id ?? '');
    }
    setSelectedSkillIds((current) => current.filter((id) => props.assistantAiOptions.skills.some((skill) => skill.id === id)));
  }, [props.assistantAiOptions, selectedModelProfileId]);

  const selectPreset = (presetId: string) => {
    const preset = assistantPresets.find((item) => item.id === presetId);
    if (!preset || ((isContextLocked || isDataSourceWorkspace) && preset.intent !== 'ask')) return;
    if (isContextLocked || isDataSourceWorkspace) {
      setIntent('ask');
      setScope(isContextLocked ? 'library-search' : 'chat');
      setContextSources(fixedContextSources);
      clearAttachments();
      setDraft(isContextLocked ? '请根据所选知识库回答：' : '');
      return;
    }
    if (preset.scope === 'current-note' && !notePath) return;
    setIntent(preset.intent);
    setScope(preset.scope);
    if (preset.intent === 'organize' || preset.scope === 'current-note') {
      setContextSources([]);
      clearAttachments();
    }
    setDraft(preset.draft);
  };

  const startNewAssistantSession = async () => {
    if (!notePath || !window.electronAPI) return;
    cancelAndSettleActiveTurn();
    const transitionId = createAssistantRequestId();
    activeRequestIdRef.current = transitionId;
    setActiveRequestId(transitionId);
    try {
      const session = await window.electronAPI.createAssistantMemorySession(notePath);
      if (activeRequestIdRef.current !== transitionId || turnContextKeyRef.current !== turnContextKey) return;
      setAssistantSessionId(session.sessionId);
      setDebugMemory(null);
      refreshedDebugTurnRef.current = null;
      setMessages([]);
      setDraft('');
      setIntent('ask');
      setScope('current-note');
      setContextSources([]);
      clearAttachments();
      await refreshAssistantMemory();
    } catch (error) {
      if (activeRequestIdRef.current === transitionId && turnContextKeyRef.current === turnContextKey) {
        window.alert(error instanceof Error ? error.message : t("无法新建会话。"));
      }
    } finally {
      if (activeRequestIdRef.current === transitionId) {
        activeRequestIdRef.current = null;
        setActiveRequestId(null);
      }
    }
  };

  const restoreAssistantSession = async (session: AssistantSessionSummary) => {
    if (!notePath || !window.electronAPI) return;
    cancelAndSettleActiveTurn();
    const transitionId = createAssistantRequestId();
    activeRequestIdRef.current = transitionId;
    setActiveRequestId(transitionId);
    try {
      const detail = await window.electronAPI.getAssistantMemorySession(notePath, session.sessionId);
      if (activeRequestIdRef.current !== transitionId || turnContextKeyRef.current !== turnContextKey) return;
      setAssistantSessionId(session.sessionId);
      setDebugMemory(detail);
      refreshedDebugTurnRef.current = null;
      setMessages(detail.turns.items.flatMap((turn) => [
        { id: `${turn.turnId}-user`, role: 'user' as const, intent: 'ask' as const, scope: 'current-note' as const, scopeLabel: t("当前笔记"), content: turn.userText, createdAt: turn.createdAt, state: 'complete' as const },
        { id: turn.turnId, role: 'assistant' as const, intent: 'ask' as const, scope: 'current-note' as const, scopeLabel: t("当前笔记"), content: turn.assistantText ?? '', createdAt: turn.finishedAt ?? turn.createdAt, state: turn.status === 'complete' || turn.status === 'partial' || turn.status === 'not-found' ? 'complete' as const : turn.status === 'cancelled' ? 'cancelled' as const : 'error' as const, evidence: turn.evidence, toolEvents: turn.toolEvents, ...(turn.planEvent ? { planEvents: [turn.planEvent] } : {}), executionElapsedMs: turn.executionElapsedMs, ...(turn.status === 'interrupted' ? { error: t("上一轮在应用关闭前中断。") } : {}) },
      ]));
      setIntent('ask');
      setScope('current-note');
      setContextSources([]);
      clearAttachments();
    } catch (error) {
      if (activeRequestIdRef.current === transitionId && turnContextKeyRef.current === turnContextKey) {
        window.alert(error instanceof Error ? error.message : t("无法恢复会话。"));
      }
    } finally {
      if (activeRequestIdRef.current === transitionId) {
        activeRequestIdRef.current = null;
        setActiveRequestId(null);
      }
    }
  };

  const changeAssistantMemoryMode = async (mode: AssistantMemoryMode) => {
    if (!window.electronAPI) return;
    await window.electronAPI.setAssistantMemorySettings(mode);
    setAssistantMemoryMode(mode);
    setAssistantSessionId(null);
    setDebugMemory(null);
    refreshedDebugTurnRef.current = null;
    setMessages([]);
    await refreshAssistantMemory();
  };

  const archiveAssistantSession = async () => {
    if (!notePath || !assistantSessionId || !window.electronAPI) return;
    await window.electronAPI.archiveAssistantMemorySession(notePath, assistantSessionId);
    setAssistantSessionId(null);
    setDebugMemory(null);
    refreshedDebugTurnRef.current = null;
    setMessages([]);
    await refreshAssistantMemory();
  };

  const deleteAssistantSession = async () => {
    if (!notePath || !assistantSessionId || !window.electronAPI || !window.confirm(t("删除当前 AI 会话及其引用？此操作无法撤销。"))) return;
    await window.electronAPI.deleteAssistantMemorySession(notePath, assistantSessionId);
    setAssistantSessionId(null);
    setDebugMemory(null);
    refreshedDebugTurnRef.current = null;
    setMessages([]);
    await refreshAssistantMemory();
  };

  const clearAssistantMemoryForNote = async () => {
    if (!notePath || !window.electronAPI || !window.confirm(t("清空当前笔记的全部 AI 会话与引用？此操作无法撤销。"))) return;
    await window.electronAPI.clearAssistantMemoryNote(notePath);
    setAssistantSessionId(null);
    setDebugMemory(null);
    refreshedDebugTurnRef.current = null;
    setMessages([]);
    await refreshAssistantMemory();
  };

  const exportAssistantSession = async (format: 'markdown' | 'json') => {
    if (!notePath || !assistantSessionId || !window.electronAPI) return;
    await window.electronAPI.exportAssistantMemorySession(notePath, assistantSessionId, format);
  };

  const startTurn = async (resume?: { userText: string; summaryCheckpoint: NonNullable<AssistantTurnRequest['summaryCheckpoint']> }, overrideUserText?: string) => {
    if (props.onboarding?.sendDisabled) return;
    const userText = (resume?.userText ?? overrideUserText ?? draft).trim();
    if (!userText || activeRequestIdRef.current || (!isDataSourceWorkspace && !props.libraryPath && !contextSources.length && !attachments.length)) return;
    const effectiveScope: AssistantScope = resume
      ? 'current-note'
      : isDataSourceWorkspace
        ? isContextLocked ? 'library-search' : 'chat'
        : intent === 'ask' && !isContextLocked ? 'current-note' : scope;
    if (effectiveScope === 'current-note' && !notePath) return;
    // 第一处 await 之前同步占用请求；停止/切换会话会清空它，使所有迟到结果失效。
    const requestId = createAssistantRequestId();
    const isPreparationCurrent = () => activeRequestIdRef.current === requestId
      && turnContextKeyRef.current === turnContextKey;
    activeRequestIdRef.current = requestId;
    setActiveRequestId(requestId);
    let submitted = false;
    try {
      let sessionId = assistantSessionId;
      let onboardingProfileId = props.onboarding?.profileId;
      if (props.onboarding?.prepareSend) {
        const practice = await props.onboarding.prepareSend();
        if (!practice || !isPreparationCurrent()) return;
        sessionId = practice.sessionId;
        onboardingProfileId = practice.profileId;
        setAssistantSessionId(sessionId);
      }
      const needsWorkspaceQaSession = Boolean(props.workspaceMemory)
        && !sessionId
        && (isContextLocked || effectiveScope === 'chat');
      if (needsWorkspaceQaSession && props.workspaceMemory) {
        const session = await props.workspaceMemory.onCreateSession();
        if (!isPreparationCurrent()) return;
        sessionId = session.sessionId;
        setAssistantSessionId(sessionId);
        props.workspaceMemory.onSessionCreated(session);
      }
      if (effectiveScope === 'current-note' && notePath && !sessionId) {
        const session = await window.electronAPI?.createAssistantMemorySession(notePath);
        if (!isPreparationCurrent()) return;
        if (!session) throw new Error(t("无法创建当前笔记的 AI 会话。"));
        sessionId = session.sessionId;
        setAssistantSessionId(sessionId);
        await refreshAssistantMemory();
      }
      if (!isPreparationCurrent()) return;
      const effectiveIntent: AssistantIntent = resume ? 'ask' : intent;
      const scopeLabel = getDraftScopeLabel(effectiveIntent, effectiveScope, props.noteMeta);
      const history = getConversationHistory(messages);
      const now = new Date().toISOString();
      const request: AssistantTurnRequest = {
        requestId,
        intent: resume ? 'ask' : intent,
        scope: effectiveScope,
        userText,
        conversation: history,
        modelProfileId: onboardingProfileId ?? selectedModelProfileId,
        ...(props.onboarding ? { webSearch: 'off' as const } : {}),
        thinkingMode,
        answerDepth,
        skillIds: selectedSkillIds,
        ...(sessionId ? { sessionId } : {}),
        ...(!props.onboarding && intent !== 'organize' && effectiveScope !== 'current-note' && contextSources.length ? { contextSources } : {}),
        ...(!props.onboarding && intent !== 'organize' && attachments.length ? { attachments } : {}),
        ...(resume ? { summaryCheckpoint: resume.summaryCheckpoint } : {}),
      };
      resetAssistantStream(requestId);
      scrollMessagesToBottom(true);
      setMessages((current) => [
        ...current,
        { id: `${requestId}-user`, role: 'user', intent: effectiveIntent, scope: effectiveScope, scopeLabel, content: userText, ...(attachments.length ? { attachments: [...attachments] } : {}), createdAt: now, state: 'complete' },
        { id: requestId, role: 'assistant', intent: effectiveIntent, scope: effectiveScope, scopeLabel, content: '', createdAt: now, state: 'pending', statusMessage: t("正在准备…") },
      ]);
      setDraft('');
      clearAttachments();
      submitted = true;
      await props.onStartAssistantTurn(request);
    } catch (error) {
      if (!isPreparationCurrent()) return;
      const message = error instanceof Error ? error.message : t("AI 助手未能开始本次请求。");
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
      if (submitted) setMessages((current) => current.map((entry) => entry.id === requestId ? { ...entry, state: 'error', statusMessage: undefined, error: message } : entry));
      else window.alert(message);
    } finally {
      // 取消、准备失败或 onboarding 拒绝发送时释放自己的锁，不能清掉后来请求的状态。
      if (!submitted && activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        setActiveRequestId(null);
      }
    }
  };

  const resumeSummary = (message: AssistantMessage) => {
    const result = message.result;
    if (result?.type !== 'answer' || !result.summaryCheckpoint || activeRequestId) return;
    const userMessage = messages.find((entry) => entry.id === `${message.id}-user` && entry.role === 'user');
    if (!userMessage) return;
    void startTurn({ userText: userMessage.content, summaryCheckpoint: result.summaryCheckpoint });
  };

  const clearConversation = () => {
    if (props.workspaceMemory) {
      void props.workspaceMemory.onNewSession().catch((error) => window.alert(error instanceof Error ? error.message : t("无法新建会话。")));
      return;
    }
    cancelActiveTurn();
    resetAssistantStream();
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setMessages([]);
    setDraft('');
    setIntent('ask');
    setScope(defaultScope);
    setContextSources(fixedContextSources);
    clearAttachments();
    setAssistantSessionId(null);
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
      event.preventDefault();
      void startTurn();
    }
  };

  const unavailable = isDataSourceWorkspace
    ? false
    : intent === 'ask' && !isContextLocked
    ? !notePath
    : !props.libraryPath && !contextSources.length && !attachments.length;
  const selectedProfile = props.assistantAiOptions.profiles.find((profile) => profile.id === selectedModelProfileId);
  const toggleSkill = (skillId: string) => setSelectedSkillIds((current) => current.includes(skillId) ? current.filter((id) => id !== skillId) : [...current, skillId].slice(0, 3));
  const chooseAttachments = async (kind: 'image' | 'file') => {
    if (!window.electronAPI || attachmentsDisabled) return;
    try {
      const selected = await window.electronAPI.selectAssistantAttachments(kind);
      addAttachments(selected);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };
  const selectedSkills = selectedSkillIds.flatMap((skillId) => {
    const skill = props.assistantAiOptions.skills.find((item) => item.id === skillId);
    return skill ? [skill] : [];
  });
  const currentContextUsage = useMemo(() => getCurrentContextUsage(messages), [messages]);
  const selectedContextCount = attachments.length + selectedSkills.length;
  const lockedContextLabel = fixedContextSources.map((source) => source.label?.trim() || t("个人知识库")).join('、');
  const visiblePresets = (isContextLocked || isDataSourceWorkspace ? assistantPresets.filter((preset) => preset.id === 'ask') : assistantPresets)
    .filter((preset) => isContextLocked || isDataSourceWorkspace || preset.scope !== 'current-note' || Boolean(notePath));
  const activeAssistantSession = assistantSessions.find((session) => session.sessionId === assistantSessionId);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const showConversationNavigation = props.showConversationNavigation && messages.some((message) => message.role === 'user');
const lastAssistantMessage = assistantMessages.at(-1);
  const selectedDebugMessage = assistantMessages.find((message) => message.id === debugTurnId) ?? assistantMessages.at(-1) ?? null;
  return <section className={`assistant-tab${isDebugRailOpen ? ' debug-open' : ''}${isDataSourceWorkspace ? ' debug-drawer' : ''}`} aria-label={t("AI 助手")}>
    <div className="assistant-chat-toolbar">
      <div><strong><Bot size={15} />{t("AI 助手")}</strong></div>
      {notePath ? <Menu shadow="md" width={220} position="bottom-end">
        <Menu.Target><Button variant="subtle" color="gray" size="compact-sm">{activeAssistantSession?.title || (assistantMemoryMode === 'persistent' ? t("新对话") : assistantMemoryMode === 'session-only' ? t("仅本次") : t("不使用记忆"))} <ChevronDown size={13} /></Button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>当前笔记会话</Menu.Label>
          <Menu.Item onClick={() => void startNewAssistantSession().catch((error) => window.alert(error instanceof Error ? error.message : t("无法新建会话。")))}>{t("新建会话")}</Menu.Item>
          {assistantMemoryMode === 'persistent' && assistantSessions.length ? <>
            <Menu.Divider />
            <Menu.Label>继续会话</Menu.Label>
            {assistantSessions.map((session) => <Menu.Item key={session.sessionId} onClick={() => void restoreAssistantSession(session).catch((error) => window.alert(error instanceof Error ? error.message : t("无法恢复会话。")))}>{session.sessionId === assistantSessionId ? '✓ ' : ''}{session.title}</Menu.Item>)}
          </> : null}
          {assistantMemoryMode === 'persistent' && assistantSessionId ? <>
            <Menu.Divider />
            <Menu.Item onClick={() => void exportAssistantSession('markdown').catch((error) => window.alert(error instanceof Error ? error.message : t("导出失败。")))}>{t("导出为 Markdown")}</Menu.Item>
            <Menu.Item onClick={() => void exportAssistantSession('json').catch((error) => window.alert(error instanceof Error ? error.message : t("导出失败。")))}>{t("导出为 JSON")}</Menu.Item>
            <Menu.Item onClick={() => void archiveAssistantSession().catch((error) => window.alert(error instanceof Error ? error.message : t("归档失败。")))}>{t("归档当前会话")}</Menu.Item>
            <Menu.Item color="red" onClick={() => void deleteAssistantSession().catch((error) => window.alert(error instanceof Error ? error.message : t("删除失败。")))}>{t("删除当前会话")}</Menu.Item>
            <Menu.Item color="red" onClick={() => void clearAssistantMemoryForNote().catch((error) => window.alert(error instanceof Error ? error.message : t("清空失败。")))}>{t("清空当前笔记记忆")}</Menu.Item>
          </> : null}
          <Menu.Divider />
          <Menu.Label>{t("记忆模式")}</Menu.Label>
          {(['persistent', 'session-only', 'disabled'] as AssistantMemoryMode[]).map((mode) => <Menu.Item key={mode} onClick={() => void changeAssistantMemoryMode(mode).catch((error) => window.alert(error instanceof Error ? error.message : t("无法更新记忆模式。")))}>{assistantMemoryMode === mode ? '✓ ' : ''}{mode === 'persistent' ? t("本地持久化") : mode === 'session-only' ? t("仅本次启动") : t("不使用记忆")}</Menu.Item>)}
          {assistantMemoryMode === 'persistent' ? <Menu.Item onClick={() => {
            if (!window.electronAPI) return;
            void window.electronAPI.backupAssistantMemory().catch((error) => window.alert(error instanceof Error ? error.message : t("备份失败。")));
          }}>{t("备份会话记忆库")}</Menu.Item> : null}
        </Menu.Dropdown>
      </Menu> : null}
      <Group gap={2} wrap="nowrap">
        {!props.hideDebugRailToggle ? <ActionIcon title={isDebugRailOpen ? t("收起调试轨道") : t("打开调试轨道")} aria-label={isDebugRailOpen ? t("收起调试轨道") : t("打开调试轨道")} aria-pressed={isDebugRailOpen} variant={isDebugRailOpen ? 'light' : 'subtle'} color="gray" size="sm" onClick={() => setDebugRailOpen(!isDebugRailOpen)}><SquareTerminal size={14} /></ActionIcon> : null}
        {!props.hideNewConversationAction ? <ActionIcon title={t("新对话")} aria-label={t("新对话")} variant="subtle" color="gray" size="sm" onClick={clearConversation}><RotateCcw size={14} /></ActionIcon> : null}
        {props.onClose ? <ActionIcon title={t("关闭 AI 助手")} aria-label={t("关闭 AI 助手")} variant="subtle" color="gray" size="sm" onClick={props.onClose}><X size={15} /></ActionIcon> : null}
      </Group>
    </div>
    <div
      ref={assistantWorkspaceRef}
      className="assistant-workspace"
      style={isDebugRailOpen ? { '--assistant-debug-rail-width': `${debugRailWidth}px` } as CSSProperties : undefined}
    >
      <div className="assistant-conversation">
        <div className={`assistant-message-scroll-shell${showConversationNavigation ? ' has-conversation-nav' : ''}`}>
          {showConversationNavigation ? <AssistantConversationNav messages={messages} scrollRef={messagesScrollRef} contentRef={messagesContentRef} onNavigate={pauseConversationFollowing} /> : null}
          <div ref={messagesScrollRef} className="assistant-message-list" role="log" aria-live="polite" aria-busy={Boolean(activeRequestId)} onScroll={updateAssistantScrollState}>
            <div ref={messagesContentRef} className="assistant-message-list-content">
              {messages.length === 0 ? <AssistantEmptyState onSelectPreset={selectPreset} presets={visiblePresets} mode={isDataSourceWorkspace ? isContextLocked ? 'knowledge-base' : 'chat' : isContextLocked ? 'knowledge-base' : 'note'} /> : messages.map((message) => {
                      const suggestionQuestions = message.id === lastAssistantMessage?.id && !activeRequestId && message.state === 'complete'
                        ? message.suggestions
                        : undefined;
                      return <AssistantMessageView key={message.id} message={message} showCompactTrace={!isDebugRailOpen} onNavigateCitation={props.onNavigateAssistantCitation} onResumeSummary={resumeSummary} currentPath={notePath} libraryPath={props.libraryPath} suggestionQuestions={suggestionQuestions} onSelectSuggestion={(question) => { void startTurn(undefined, question); }} />;
                    })}
            </div>
          </div>
          {!isMessageListAtBottom ? <button type="button" className="assistant-scroll-to-bottom" onClick={() => scrollMessagesToBottom(true)} aria-label={t("回到最新回答")} title={t("回到最新回答")}><ChevronDown size={15} aria-hidden="true" /></button> : null}
        </div>
        <div
          className={`assistant-composer${isDragActive ? ' drag-active' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
        >
          <AssistantComposerAttachments attachments={attachments} onRemove={removeAttachment} disabled={Boolean(activeRequestId)} />
      <div className="assistant-composer-input">
        <Textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={handleComposerKeyDown} onPaste={handlePaste} onCompositionStart={() => setIsComposing(true)} onCompositionEnd={() => setIsComposing(false)} minRows={4} maxRows={8} autosize disabled={unavailable || Boolean(activeRequestId)} placeholder={intent === 'learning-plan' ? t("输入学习目标…") : intent === 'organize' ? t("可修改整理建议的侧重点…") : t("输入问题，Enter 发送；Shift + Enter 换行…")} aria-label={t("向 AI 助手输入问题")} />
      </div>
      <div className="assistant-composer-footer">
        <Group className="assistant-composer-leading" gap={3} wrap="nowrap">
          <AssistantComposerAddMenu
            attachments={attachments}
            selectedSkills={selectedSkills}
            skills={props.assistantAiOptions.skills}
            onRefreshSkills={onRefreshAssistantAiOptions}
            disabled={attachmentsDisabled}
            onChooseImages={() => void chooseAttachments('image')}
            onChooseFiles={() => void chooseAttachments('file')}
            onRemoveAttachment={removeAttachment}
            onToggleSkill={toggleSkill}
          />
          {isDataSourceWorkspace ? <AssistantDataSourceSelector options={props.contextSourceOptions ?? []} selectedLibraryPath={props.selectedContextSourcePath ?? null} disabled={Boolean(activeRequestId) || Boolean(props.onboarding)} onSelect={(libraryPath) => props.onSelectContextSource?.(libraryPath)} /> : isContextLocked ? <span className="assistant-composer-fixed-scope" title={t("当前范围：{0}", { '0': lockedContextLabel })}><Database size={13} />{lockedContextLabel}</span> : null}
          {!isContextLocked && !isDataSourceWorkspace && (intent === 'ask'
            ? <span className="assistant-composer-fixed-scope" title={t("回答范围固定为当前打开的笔记")}><Sparkles size={13} /></span>
            : <span className="assistant-composer-mode-label">{intent === 'learning-plan' ? t("知识库检索") : t("笔记库结构")}</span>)}
          {selectedContextCount ? <span className="assistant-composer-selection-count" title={t("已添加 {0} 个附件、{1} 个技能", { '0': attachments.length, '1': selectedSkills.length })}>+{selectedContextCount}</span> : null}
        </Group>
        <Group className="assistant-composer-actions" gap={3} wrap="nowrap">
          {!props.onboarding && <AssistantContextWindowUsage usage={currentContextUsage} contextWindowTokens={selectedProfile?.contextWindowTokens} />}
          {isDataSourceWorkspace && !props.onboarding ? (
            <Menu position="top-end" shadow="md" width={240} withinPortal>
              <Menu.Target><Button className="assistant-composer-control" title={t("回答深度：{0}", { '0': answerDepth === 'auto' ? t("自适应") : answerDepth === 'concise' ? t("简洁") : t("详细") })} aria-label={t("回答深度：{0}", { '0': answerDepth === 'auto' ? t("自适应") : answerDepth === 'concise' ? t("简洁") : t("详细") })} variant="subtle" color="gray" size="compact-sm" rightSection={<ChevronDown size={12} />} disabled={Boolean(activeRequestId)}>{t("回答：")}{answerDepth === 'auto' ? t("自适应") : answerDepth === 'concise' ? t("简洁") : t("详细")}</Button></Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{t("回答深度")}</Menu.Label>
                <Menu.Item className="assistant-thinking-menu-item" data-selected={answerDepth === 'auto' || undefined} rightSection={answerDepth === 'auto' ? <Check size={14} aria-hidden="true" /> : null} onClick={() => setAnswerDepth('auto')}>
                  {t("自适应")}<Text size="xs" c="dimmed">{t("按问题复杂度组织答案")}</Text>
                </Menu.Item>
                <Menu.Item className="assistant-thinking-menu-item" data-selected={answerDepth === 'concise' || undefined} rightSection={answerDepth === 'concise' ? <Check size={14} aria-hidden="true" /> : null} onClick={() => setAnswerDepth('concise')}>
                  {t("简洁")}<Text size="xs" c="dimmed">{t("结论优先，控制篇幅")}</Text>
                </Menu.Item>
                <Menu.Item className="assistant-thinking-menu-item" data-selected={answerDepth === 'detailed' || undefined} rightSection={answerDepth === 'detailed' ? <Check size={14} aria-hidden="true" /> : null} onClick={() => setAnswerDepth('detailed')}>
                  {t("详细")}<Text size="xs" c="dimmed">{t("补充原理、示例和边界")}</Text>
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
          {!props.onboarding && <Menu position="top-end" shadow="md" width={220} withinPortal>
            <Menu.Target><Button className="assistant-composer-control assistant-thinking-control" title={t("思考强度：{0}", { '0': thinkingMode === 'advanced' ? t("高级") : t("简单") })} aria-label={t("思考强度：{0}", { '0': thinkingMode === 'advanced' ? t("高级") : t("简单") })} variant="subtle" color="gray" size="compact-sm" leftSection={<Sparkles size={12} />} rightSection={<ChevronDown size={12} />} disabled={Boolean(activeRequestId)}>{thinkingMode === 'advanced' ? t("高级") : t("简单")}</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{t("思考强度")}</Menu.Label>
              <Menu.Item className="assistant-thinking-menu-item" data-selected={thinkingMode === 'simple' || undefined} rightSection={thinkingMode === 'simple' ? <Check size={14} aria-hidden="true" /> : null} onClick={() => setThinkingMode('simple')}>
                {t("简单")}<Text size="xs" c="dimmed">{t("快速直接回答")}</Text>
              </Menu.Item>
              <Menu.Item className="assistant-thinking-menu-item" data-selected={thinkingMode === 'advanced' || undefined} rightSection={thinkingMode === 'advanced' ? <Check size={14} aria-hidden="true" /> : null} onClick={() => setThinkingMode('advanced')}>
                {t("高级")}<Text size="xs" c="dimmed">{t("启用更深入的模型思考")}</Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>}
          <Menu position="top-start" shadow="md" width={280} withinPortal trigger="click-hover" openDelay={120} closeDelay={180}>
            <Menu.Target><Button className="assistant-composer-control" variant="subtle" color="gray" size="compact-sm" leftSection={selectedProfile ? <ProviderIcon provider={selectedProfile.kind === 'ollama' ? 'ollama' : selectedProfile.provider} size={16} /> : undefined} rightSection={<ChevronDown size={12} />} disabled={Boolean(activeRequestId) || Boolean(props.onboarding) || !props.assistantAiOptions.profiles.length}>{selectedProfile ? selectedProfile.label : t("未配置模型")}</Button></Menu.Target>
            <Menu.Dropdown className="assistant-model-menu-dropdown">
              <Menu.Label>{t("已保存模型")}</Menu.Label>
              <div className="assistant-model-menu-list">
                {props.assistantAiOptions.profiles.map((profile) => (
                  <Menu.Item
                    key={profile.id}
                    className="assistant-model-menu-item"
                    data-selected={profile.id === selectedModelProfileId || undefined}
                    leftSection={<ProviderIcon provider={profile.kind === 'ollama' ? 'ollama' : profile.provider} size={20} />}
                    rightSection={profile.id === selectedModelProfileId ? <Check size={14} aria-hidden="true" /> : null}
                    onClick={() => {
                      if (profile.id === selectedModelProfileId) return;
                      setSelectedModelProfileId(profile.id);
                      void onRefreshAssistantAiOptions(profile.id).catch(() => undefined);
                    }}
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
        {activeRequestId ? <ActionIcon title={t("停止生成")} aria-label={t("停止生成")} variant="filled" color="gray" size="lg" onClick={cancelAndSettleActiveTurn}><Square size={14} fill="currentColor" /></ActionIcon> : <ActionIcon data-onboarding-anchor="send-question" title={t("发送")} aria-label={t("发送")} variant="filled" color="brand" size="lg" disabled={unavailable || props.onboarding?.sendDisabled || !selectedProfile || !draft.trim()} onClick={() => void startTurn()}><Send size={15} /></ActionIcon>}
      </div>
        </div>
      </div>
      <Modal opened={replacementDraft !== null} onClose={() => setReplacementDraft(null)} title={t('输入框已有草稿')} centered returnFocus>
        <Text size="sm">{t('是否用示例问题替换当前草稿？')}</Text><Group justify="flex-end" mt="md"><Button variant="default" onClick={() => setReplacementDraft(null)}>{t('保留我的草稿')}</Button><Button onClick={() => { if (replacementDraft) setDraft(replacementDraft); setReplacementDraft(null); window.requestAnimationFrame(() => assistantWorkspaceRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()); }}>{t('替换为示例')}</Button></Group>
      </Modal>
      {isDebugRailOpen ? <div id={isDataSourceWorkspace ? 'qa-debug-drawer' : undefined} className="assistant-debug-rail-shell">
        {isDataSourceWorkspace ? <button type="button" className="assistant-debug-drawer-close" onClick={() => setDebugRailOpen(false)} aria-label={t("关闭调试轨道")} title={t("关闭调试轨道")}><PanelRightClose size={15} /></button> : null}
        <div
          className="assistant-debug-rail-resizer"
          role="separator"
          aria-label={t("调整调试轨道宽度")}
          aria-orientation="vertical"
          aria-valuemin={270}
          aria-valuemax={720}
          aria-valuenow={Math.round(debugRailWidth)}
          tabIndex={0}
          title={t("向左拖动以加宽调试轨道")}
          onPointerDown={startDebugRailResize}
          onKeyDown={handleDebugRailResizeKeyDown}
        />
        {isContextLocked ? <KnowledgeBaseDebugRail
          messages={messages}
          selectedMessage={selectedDebugMessage}
          onSelectMessage={setDebugTurnId}
          contextWindowTokens={selectedProfile?.contextWindowTokens}
          onStartNewTopic={clearConversation}
        /> : <AssistantDebugRail
          messages={messages}
          selectedMessage={selectedDebugMessage}
          onSelectMessage={setDebugTurnId}
          memoryMode={assistantMemoryMode}
          memory={debugMemory}
          contextUsage={currentContextUsage}
          contextWindowTokens={selectedProfile?.contextWindowTokens}
          onStartNewTopic={clearConversation}
        />}
      </div> : null}
    </div>
  </section>;
}

function AssistantComposerAddMenu({ attachments, selectedSkills, skills, disabled, onRefreshSkills, onChooseImages, onChooseFiles, onRemoveAttachment, onToggleSkill }: {
  attachments: AssistantAttachment[];
  selectedSkills: AssistantAiOptions['skills'];
  skills: AssistantAiOptions['skills'];
  disabled: boolean;
  onRefreshSkills: () => Promise<AssistantAiOptions>;
  onChooseImages: () => void;
  onChooseFiles: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onToggleSkill: (skillId: string) => void;
}) {
  useI18n();
  const [skillPage, setSkillPage] = useState(1);
  const [refreshingSkills, setRefreshingSkills] = useState(false);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(enabledSkills.length / pageSize));
  const currentPage = Math.min(skillPage, pageCount);
  const visibleSkills = enabledSkills.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedSkillIds = new Set(selectedSkills.map((skill) => skill.id));
  const attachmentLimitReached = attachments.length >= 6;
  const hasSelections = attachments.length > 0 || selectedSkills.length > 0;
  return <Menu position="top-start" shadow="md" width={320} withinPortal closeOnItemClick={false} onOpen={() => {
    setSkillPage(1);
    setRefreshingSkills(true);
    void onRefreshSkills().catch(() => undefined).finally(() => setRefreshingSkills(false));
  }}>
    <Menu.Target><ActionIcon className="assistant-composer-plus" data-populated={hasSelections || undefined} title={t("添加图片、附件或技能")} aria-label={t("添加图片、附件或技能")} variant="subtle" color="gray" size="sm" disabled={disabled}><Plus size={15} /></ActionIcon></Menu.Target>
    <Menu.Dropdown className="assistant-composer-add-menu">
      <Menu.Label>{t("添加到本轮")}</Menu.Label>
      <Menu.Item className="assistant-composer-add-menu-item" leftSection={<ImagePlus size={15} />} closeMenuOnClick onClick={onChooseImages} disabled={attachmentLimitReached}>
        <span className="assistant-composer-add-menu-copy"><strong>{t("上传图片")}</strong><small>{t("PNG、JPEG、WebP、GIF，单张不超过 5 MB")}</small></span>
      </Menu.Item>
      <Menu.Item className="assistant-composer-add-menu-item" leftSection={<FileUp size={15} />} closeMenuOnClick onClick={onChooseFiles} disabled={attachmentLimitReached}>
        <span className="assistant-composer-add-menu-copy"><strong>{t("上传附件")}</strong><small>{t("PDF、DOCX、Markdown、TXT、CSV、JSON 等")}</small></span>
      </Menu.Item>
      {attachments.length ? <>
        <Menu.Divider />
        <Menu.Label>{t("已添加附件")}</Menu.Label>
        {attachments.map((attachment) => <Menu.Item key={`remove:${attachment.attachmentId}`} className="assistant-composer-add-menu-item" leftSection={<X size={14} />} closeMenuOnClick onClick={() => onRemoveAttachment(attachment.attachmentId)}><span className="assistant-composer-add-menu-copy"><strong>{attachment.name}</strong><small>{t("点击移除")}</small></span></Menu.Item>)}
      </> : null}
      <Menu.Divider />
      <Menu.Label>{t("选择技能（")}{selectedSkills.length}/3）</Menu.Label>
      <div className="assistant-composer-skill-list" aria-busy={refreshingSkills}>
        {enabledSkills.length ? visibleSkills.map((skill) => {
          const selected = selectedSkillIds.has(skill.id);
          return <Menu.Item key={skill.id} className="assistant-composer-add-menu-item" data-selected={selected || undefined} disabled={refreshingSkills || (!selected && selectedSkills.length >= 3)} rightSection={selected ? <Check size={14} aria-hidden="true" /> : null} onClick={() => onToggleSkill(skill.id)}>
            <span className="assistant-composer-add-menu-copy"><strong>{skill.name}</strong><small>{skill.description}</small></span>
          </Menu.Item>;
        }) : <Text className="assistant-composer-add-menu-empty" size="xs">{t("暂无可选技能，请先在设置中启用或创建。")}</Text>}
      </div>
      {enabledSkills.length ? <Group className="assistant-composer-skill-pagination" justify="space-between" gap={6}><Text size="xs" c="dimmed">{currentPage}/{pageCount} · {enabledSkills.length} {t("个已启用")}</Text><Pagination size="xs" total={pageCount} value={currentPage} onChange={setSkillPage} siblings={0} boundaries={0} /></Group> : null}
    </Menu.Dropdown>
  </Menu>;
}

function AssistantDataSourceSelector({ options, selectedLibraryPath, disabled, onSelect }: {
  options: AssistantContextSourceOption[];
  selectedLibraryPath: string | null;
  disabled: boolean;
  onSelect: (libraryPath: string | null) => void;
}) {
  useI18n();
  const [query, setQuery] = useState('');
  const selectedOption = options.find((option) => option.source.libraryPath === selectedLibraryPath);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) => `${option.source.label ?? ''} ${option.source.libraryPath} ${option.description}`.toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const select = (libraryPath: string | null) => {
    setQuery('');
    onSelect(libraryPath);
  };

  return <Menu position="top-start" shadow="md" width={330} withinPortal onClose={() => setQuery('')}>
    <Menu.Target>
      <button type="button" className="assistant-data-source-trigger" disabled={disabled} title={selectedOption?.source.libraryPath ?? t("不检索个人资料库")} aria-label={t("问答数据源：{0}", { '0': selectedOption?.source.label ?? t("无") })}>
        <Database size={13} aria-hidden="true" />
        <span>{selectedOption?.source.label ?? t("无")}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </Menu.Target>
    <Menu.Dropdown className="assistant-data-source-menu">
      <Menu.Label>{t("问答数据源")}</Menu.Label>
      <div className="assistant-data-source-search">
        <Search size={13} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => event.stopPropagation()} placeholder={t("搜索个人资料库")} aria-label={t("搜索个人资料库")} autoFocus />
      </div>
      <Menu.Item className="assistant-data-source-item" data-selected={selectedLibraryPath === null ? true : undefined} rightSection={selectedLibraryPath === null ? <Check size={14} aria-hidden="true" /> : null} onClick={() => select(null)}>
        <strong>{t("开放式问答")}</strong><Text size="xs" c="dimmed">{t("不检索资料库，直接询问 AI")}</Text>
      </Menu.Item>
      <Menu.Divider />
      <div className="assistant-data-source-list">
        {visibleOptions.map((option) => {
          const isSelected = option.source.libraryPath === selectedLibraryPath;
          return <Menu.Item key={option.source.libraryPath} className="assistant-data-source-item" data-selected={isSelected || undefined} disabled={option.disabled} rightSection={isSelected ? <Check size={14} aria-hidden="true" /> : null} onClick={() => select(option.source.libraryPath)}>
            <strong>{option.source.label?.trim() || t("未命名资料库")}</strong><Text size="xs" c="dimmed">{option.description}</Text>
          </Menu.Item>;
        })}
        {!visibleOptions.length ? <Text className="assistant-data-source-empty" size="xs" c="dimmed">{t("没有匹配的个人资料库")}</Text> : null}
      </div>
    </Menu.Dropdown>
  </Menu>;
}

function AssistantEmptyState({ onSelectPreset, presets, mode }: { onSelectPreset: (presetId: string) => void; presets: AssistantPreset[]; mode: 'chat' | 'knowledge-base' | 'note' }) {
  useI18n();
  const title = mode === 'knowledge-base' ? t("从选定知识库中找到答案") : mode === 'chat' ? t("直接询问 AI") : t("围绕当前笔记继续思考");
  const askLabel = mode === 'knowledge-base' ? t("知识库问答") : mode === 'chat' ? t("开放式问答") : t("当前笔记问答");
  return <div className="assistant-empty-state"><Bot size={20} /><strong>{title}</strong><p>{t("输入问题，或选择一个预置任务。")}</p><div>{presets.map((preset) => <button key={preset.id} type="button" onClick={() => onSelectPreset(preset.id)}>{preset.id === 'ask' ? askLabel : t(preset.label)}</button>)}</div></div>;
}

function AssistantMessageView({ message, showCompactTrace, onNavigateCitation, onResumeSummary, currentPath, libraryPath, suggestionQuestions, onSelectSuggestion }: { message: AssistantMessage; showCompactTrace: boolean; onNavigateCitation?: (citation: AssistantEvidenceCitation) => Promise<AssistantCitationValidation>; onResumeSummary?: (message: AssistantMessage) => void; currentPath: string | null; libraryPath: string | null; suggestionQuestions?: string[]; onSelectSuggestion?: (question: string) => void }) {
  useI18n();
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveNoteOpen, setSaveNoteOpen] = useState(false);
  const [savedNote, setSavedNote] = useState<CreateAssistantNoteResult | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const copyMessageText = useCallback(() => {
    if (!message.content) return;
    void copyPlainText(normalizeMemorySaveClaims(message.content)).then((copied) => {
      setCopyState(copied ? 'success' : 'error');
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyState('idle');
        copyResetTimerRef.current = null;
      }, 1_800);
    });
  }, [message.content]);

  if (message.role === 'user') return <article className="assistant-message user" data-conversation-turn-id={message.id}><div className="assistant-message-meta"><span>{translateIntent(message.intent, message.scope, message.interactionRoute)}</span><time>{formatDate(message.createdAt)}</time></div><p>{message.content}</p><AssistantMessageAttachments attachments={message.attachments ?? []} /></article>;
  const result = message.result;
  const toolEvents = result?.type === 'answer' ? result.toolEvents ?? message.toolEvents ?? [] : message.toolEvents ?? [];
  const memorySave = message.memorySave ?? (result?.type === 'answer' ? result.memorySave : undefined);
  const modelEvents = result?.type === 'answer' ? result.modelEvents ?? message.modelEvents ?? [] : message.modelEvents ?? [];
  const planEvents = result?.type === 'answer' ? result.planEvents ?? message.planEvents ?? [] : message.planEvents ?? [];
  const executionElapsedMs = result?.type === 'answer' ? result.executionElapsedMs ?? message.executionElapsedMs : message.executionElapsedMs;
  const thinkingText = result?.type === 'answer' ? result.thinkingText ?? message.thinkingText : message.thinkingText;
  const thinkingElapsedMs = result?.type === 'answer' ? result.thinkingElapsedMs : undefined;
  const contextDiagnostics = result?.type === 'answer' ? result.contextDiagnostics ?? message.contextDiagnostics : message.contextDiagnostics;
  const compressionNotice = buildAssistantContextCompressionNotice(contextDiagnostics, modelEvents);
  const searchScope = result?.type === 'answer' ? result.searchScope : undefined;
  const searchCoverage = result?.type === 'answer' ? result.searchCoverage : undefined;
  const knowledgeBaseCitations = result?.type === 'answer' ? result.knowledgeBaseCitations ?? [] : [];
  const webCitations = result?.type === 'answer' ? result.webCitations ?? [] : [];
  return <article className={`assistant-message assistant ${message.state}`}>
    <div className="assistant-message-meta">
      <div className="assistant-message-title">
        <span>{t("AI 助手")}</span>
        {message.content ? <button type="button" className="assistant-message-copy-button" data-state={copyState} onClick={copyMessageText} aria-label={copyState === 'success' ? t("已复制 AI 回复") : copyState === 'error' ? t("复制 AI 回复失败，请重试") : t("复制 AI 回复文本")} title={copyState === 'success' ? t("已复制") : copyState === 'error' ? t("复制失败，请重试") : t("复制文本")}>{copyState === 'success' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}<span>{copyState === 'success' ? t("已复制") : copyState === 'error' ? t("复制失败") : t("复制文本")}</span></button> : null}
        {message.content ? <button type="button" className="assistant-message-copy-button assistant-message-save-button" onClick={() => setSaveNoteOpen(true)} disabled={message.state === 'pending' || message.state === 'streaming'} aria-label={t('保存 AI 回复为笔记')} title={t('保存笔记')}><FileText size={12} aria-hidden="true" /><span>{t('保存笔记')}</span></button> : null}
        {savedNote ? <span className="assistant-saved-note-receipt" role="status" title={savedNote.path}>{t('已保存为 {0}', { '0': savedNote.title })}</span> : null}
        {message.profileUpdatedCount ? <span className="assistant-profile-update-receipt" role="status"><CircleCheck size={12} aria-hidden="true" />{t("画像已更新")} {message.profileUpdatedCount} {t("项")}</span> : null}
        <MemoryTurnStatusBadge turnId={message.id} settled={message.state === 'complete'} receipt={memorySave} />
      </div>
      <time>{formatDate(message.createdAt)}</time>
    </div>
    {message.statusMessage ? <div className="assistant-message-status"><Sparkles size={13} />{message.statusMessage}</div> : null}
    {saveNoteOpen ? <AssistantSaveNoteModal content={normalizeMemorySaveClaims(message.content)} currentPath={currentPath} libraryPath={libraryPath} onClose={() => setSaveNoteOpen(false)} onSaved={note => { setSavedNote(note); setSaveNoteOpen(false); }} /> : null}
    {compressionNotice ? <AssistantContextCompressionNotice notice={compressionNotice} /> : null}
    {showCompactTrace && planEvents.length ? <AssistantPlanTrace event={planEvents[planEvents.length - 1]} searchScope={searchScope} searchCoverage={searchCoverage} completeness={result?.type === 'answer' ? result.completeness : undefined} agentStats={result?.type === 'answer' ? result.agentStats : undefined} /> : null}
    {showCompactTrace && toolEvents.length ? <AssistantToolTrace events={toolEvents} modelEvents={modelEvents} isRunning={message.state === 'pending' || message.state === 'streaming'} executionElapsedMs={executionElapsedMs} /> : null}
    {thinkingText ? <AssistantThinkingTrace text={thinkingText} elapsedMs={thinkingElapsedMs} isRunning={message.state === 'pending' || message.state === 'streaming'} hasAnswer={Boolean(message.content)} /> : null}
    {message.usedMemories?.length ? <details className="assistant-thinking-trace"><summary><Database size={13} aria-hidden="true" /><span>{t("本次提供记忆")} {message.usedMemories.length} {t("条")}</span><ChevronDown className="assistant-thinking-trace-chevron" size={13} aria-hidden="true" /></summary><div className="assistant-thinking-trace-body"><ul>{message.usedMemories.map((item) => <li key={item.itemId}>{item.contentSnapshot}</li>)}</ul></div></details> : null}
    {message.content ? knowledgeBaseCitations.length || webCitations.length || message.usedMemories?.length ? <AssistantKnowledgeBaseAnswerContent content={normalizeMemorySaveClaims(message.content)} citations={knowledgeBaseCitations} webCitations={webCitations} memories={message.usedMemories} turnId={message.id} resetKey={`${message.id}-${message.content.length}`} currentPath={currentPath} libraryPath={libraryPath} /> : <CollapsibleAiContent resetKey={`${message.id}-${message.content.length}`}><MarkdownContent className="assistant-markdown-content" content={normalizeMemorySaveClaims(message.content)} currentPath={currentPath} libraryPath={libraryPath} showCodeCopyActions isStreaming={message.state === 'streaming'} /></CollapsibleAiContent> : null}
    {message.state === 'complete' && suggestionQuestions?.length ? (
      <div className="assistant-suggestions">
        <span className="assistant-suggestions-heading">{t("你可以接着问：")}</span>
        <div className="assistant-suggestions-chips">
          {suggestionQuestions.map((question) => (
            <button key={question} type="button" className="assistant-suggestion-chip" onClick={() => onSelectSuggestion?.(question)}>{question}</button>
          ))}
        </div>
      </div>
    ) : null}
    {result?.type === 'answer' ? <>
      <AssistantCitationList citations={result.evidence ?? message.evidence ?? []} currentPath={currentPath} onNavigateCitation={onNavigateCitation} />
      {result.retrievalWarning ? <div className="assistant-retrieval-warning">{result.retrievalWarning}</div> : null}
      {result.summaryCheckpoint?.mode === 'summary-complete' ? <Button className="assistant-summary-resume" variant="light" color="brand" size="xs" onClick={() => onResumeSummary?.(message)}>{t("继续完整总结")}</Button> : null}
    </> : null}
    {!result && message.evidence?.length ? <AssistantCitationList citations={message.evidence} currentPath={currentPath} onNavigateCitation={onNavigateCitation} /> : null}
    {result?.type === 'learning-plan' ? <AiArtifactMeta model={result.plan.model} generatedAt={result.plan.generatedAt} artifactKey={result.plan.generatedAt} hideMeta><strong>{t("学习目标：")}{result.plan.goal}</strong><ol>{result.plan.steps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.rationale}</p>{step.sourceTitles.length ? <small>{t("来源：")}{step.sourceTitles.join('、')}</small> : null}</li>)}</ol></AiArtifactMeta> : null}
    {result?.type === 'organize' ? <AiArtifactMeta model={result.suggestion.model} generatedAt={result.suggestion.generatedAt} artifactKey={result.suggestion.generatedAt} hideMeta>{result.suggestion.groups.map((group) => <div key={group.title} className="organize-group"><strong>{group.title}</strong><p>{group.rationale}</p><small>{group.noteTitles.join('、')}</small></div>)}{result.suggestion.nextActions.length ? <><strong>{t("建议下一步")}</strong><ul>{result.suggestion.nextActions.map((action) => <li key={action}>{action}</li>)}</ul></> : null}</AiArtifactMeta> : null}
    {message.error ? <div className="knowledge-error" role="alert">{message.error}</div> : null}
    {message.state === 'cancelled' ? <div className="assistant-message-cancelled">{t("已停止生成；已输出内容已保留。")}</div> : null}
    {message.isStale ? <div className="ai-artifact-stale">{t("知识库内容已更新；此回答基于之前的上下文，可重新生成以获得最新结果。")}</div> : null}
  </article>;
}

export function AssistantThinkingTrace({ text, elapsedMs, isRunning, hasAnswer }: { text: string; elapsedMs?: number; isRunning: boolean; hasAnswer: boolean }) {
  useI18n();
  const [expanded, setExpanded] = useState(!hasAnswer);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => elapsedMs !== undefined ? Math.max(1, Math.round(elapsedMs / 1_000)) : 1);
  const autoCollapsedRef = useRef(hasAnswer);

  useEffect(() => {
    if (hasAnswer && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setExpanded(false);
    }
  }, [hasAnswer]);

  useEffect(() => {
    if (!isRunning) {
      if (elapsedMs !== undefined) setElapsedSeconds(Math.max(1, Math.round(elapsedMs / 1_000)));
      return undefined;
    }
    const startedAt = Date.now();
    setElapsedSeconds(1);
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1_000))), 1_000);
    return () => window.clearInterval(timer);
  }, [isRunning, elapsedMs]);

  return <details className="assistant-thinking-trace" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="assistant-thinking-trace-icon" aria-hidden="true">{isRunning && !hasAnswer ? <LoaderCircle size={13} /> : <BrainCircuit size={13} />}</span>
      <span>{isRunning && !hasAnswer ? t("深度思考中") : t("深度思考")}</span>
      <span className="assistant-thinking-trace-elapsed">· {elapsedSeconds}s</span>
      <ChevronDown className="assistant-thinking-trace-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="assistant-thinking-trace-body">{text}</div>
  </details>;
}

function AssistantKnowledgeBaseAnswerContent({ content, citations, webCitations, memories = [], turnId, resetKey, currentPath, libraryPath }: {
  content: string;
  citations: AssistantKnowledgeBaseCitation[];
  webCitations: AssistantWebCitation[];
  memories?: MemoryCitationSnapshot[];
  turnId: string;
  resetKey: string;
  currentPath: string | null;
  libraryPath: string | null;
}) {
  useI18n();
  const [expandedReference, setExpandedReference] = useState<number | null>(null);
  const [expandedMemoryReference, setExpandedMemoryReference] = useState<number | null>(null);
  const renderedContent = useMemo(() => formatMemoryCitationMarkdown(formatKnowledgeBaseCitationMarkdown(content, citations, webCitations), memories, turnId), [citations, webCitations, content, memories, turnId]);
  const referencedCitations = useMemo(() => getReferencedKnowledgeBaseCitations(content, citations), [citations, content]);
  const referencedWebCitations = useMemo(() => getReferencedWebCitations(content, webCitations), [webCitations, content]);

  const toggleCitation = useCallback((reference: number) => {
    setExpandedReference((current) => current === reference ? null : reference);
    requestAnimationFrame(() => document.getElementById(knowledgeBaseCitationElementId(reference))?.scrollIntoView({ block: 'nearest' }));
  }, []);
  const toggleMemoryCitation = useCallback((reference: number) => {
    setExpandedMemoryReference((current) => current === reference ? null : reference);
    requestAnimationFrame(() => document.getElementById(memoryCitationElementId(turnId, reference))?.scrollIntoView({ block: 'nearest' }));
  }, [turnId]);

  const handleCitationClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const memoryLink = target.closest<HTMLAnchorElement>('a[data-memory-reference]');
    if (memoryLink && event.currentTarget.contains(memoryLink)) {
      const reference = Number(memoryLink.dataset.memoryReference);
      if (!memories.some((memory) => memory.reference === reference)) return;
      event.preventDefault(); toggleMemoryCitation(reference); return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href^="#knowledge-base-citation-"]');
    if (!link || !event.currentTarget.contains(link)) return;
    const reference = Number(link.getAttribute('href')?.slice('#knowledge-base-citation-'.length));
    if (!Number.isSafeInteger(reference)) return;
    if (!citations.some((citation) => citation.reference === reference) && !webCitations.some((citation) => citation.reference === reference)) return;
    event.preventDefault();
    toggleCitation(reference);
  };

  return <>
    <CollapsibleAiContent resetKey={resetKey}>
      <div className="assistant-knowledge-base-answer" onClick={handleCitationClick}>
        <MarkdownContent className="assistant-markdown-content" content={renderedContent} currentPath={currentPath} libraryPath={libraryPath} showCodeCopyActions />
      </div>
    </CollapsibleAiContent>
    <AssistantKnowledgeBaseCitationList citations={referencedCitations} webCitations={referencedWebCitations} expandedReference={expandedReference} onToggle={toggleCitation} />
    <AssistantMemoryCitationList turnId={turnId} content={content} memories={memories} expandedReference={expandedMemoryReference} onToggle={toggleMemoryCitation} />
  </>;
}

function getWebCitationHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function AssistantKnowledgeBaseCitationList({ citations, webCitations, expandedReference, onToggle }: {
  citations: AssistantKnowledgeBaseCitation[];
  webCitations: AssistantWebCitation[];
  expandedReference: number | null;
  onToggle: (reference: number) => void;
}) {
  useI18n();
  if (!citations.length && !webCitations.length) return null;
  const knowledgeByReference = new Map(citations.map((citation) => [citation.reference, citation]));
  const webByReference = new Map(webCitations.map((citation) => [citation.reference, citation]));
  const references = [...knowledgeByReference.keys(), ...webByReference.keys()].sort((first, second) => first - second);
  return <section className="assistant-knowledge-base-citations" aria-label={t("知识库回答引用")}>
    <strong>{t("回答引用")}</strong>
    <div className="assistant-knowledge-base-citation-list">{references.map((reference) => {
      const webCitation = webByReference.get(reference);
      const isExpanded = expandedReference === reference;
      const contentId = knowledgeBaseCitationElementId(reference);
      return webCitation ? <button key={reference} type="button" className="assistant-knowledge-base-citation-link" data-web="true" aria-expanded={isExpanded} aria-controls={contentId} onClick={() => onToggle(reference)} title={webCitation.title || webCitation.url}>
        <Globe size={11} aria-hidden="true" />
        <span>{t("引用")} {reference}</span>
        {webCitation.pageVerified ? null : <span className="assistant-web-citation-badge">{t("摘要来源")}</span>}
      </button> : <button key={reference} type="button" className="assistant-knowledge-base-citation-link" aria-expanded={isExpanded} aria-controls={contentId} onClick={() => onToggle(reference)} title={t("展开{0}的父块内容", { '0': knowledgeByReference.get(reference)?.documentName ?? '' })}>
        <Link2 size={11} aria-hidden="true" />
        <span>{t("引用")} {reference}</span>
      </button>;
    })}</div>
    {references.map((reference) => {
      if (expandedReference !== reference) return null;
      const webCitation = webByReference.get(reference);
      if (webCitation) {
        return <article id={knowledgeBaseCitationElementId(reference)} className="assistant-knowledge-base-citation-detail" key={reference}>
          <header><strong>{webCitation.title || (webCitation.url ? getWebCitationHostname(webCitation.url) : t("引用 {0}", { '0': reference }))}</strong><span>{webCitation.url ? `${getWebCitationHostname(webCitation.url)} · ` : t("无链接 · ")}{webCitation.pageVerified ? t("已全文核对") : t("摘要来源，未经全文验证")}</span></header>
          {webCitation.content ? <pre>{webCitation.content}</pre> : null}
          {webCitation.url ? <a href={webCitation.url} target="_blank" rel="noreferrer"><ExternalLink size={11} aria-hidden="true" />{t("在浏览器中打开原文")}</a> : null}
        </article>;
      }
      const citation = knowledgeByReference.get(reference);
      return citation ? <article id={knowledgeBaseCitationElementId(reference)} className="assistant-knowledge-base-citation-detail" key={reference}>
        <header><strong>{citation.documentName}</strong><span>{t("父块")} {citation.parentOrdinal}</span></header>
        <pre>{citation.content}</pre>
      </article> : null;
    })}
  </section>;
}

interface AssistantToolTraceEntry {
  id: string;
  tool: CurrentNotePublicToolEvent['tool'];
  state: CurrentNotePublicToolEvent['state'];
  round?: number;
  rationale?: string;
  outcome?: string;
  inputSummary?: string;
  outputSummary?: string;
  contentPreviews?: CurrentNotePublicToolContentPreview[];
  publicResults?: CurrentNotePublicToolEvent['publicResults'];
  sectionNavigation?: CurrentNotePublicToolEvent['sectionNavigation'];
  elapsedMs?: number;
}

function AssistantSearchPlanSummary({ plan, finalQueryTerms }: { plan: NonNullable<CurrentNotePublicPlanEvent['searchPlan']>; finalQueryTerms?: string[] }) {
  useI18n();
  return <div className="assistant-debug-search-plan" aria-label={t("SearchPlan 与 QueryTerm")}>
    <div className="assistant-debug-search-plan-heading"><strong>SearchPlan</strong><span>v{plan.version} · {translatePlanStatus(plan.status)}</span></div>
    <div className="assistant-debug-search-plan-question"><span>{t("原始问题")}</span><p>{plan.originalQuestion}</p></div>
    {plan.activeGoalLabel ? <div className="assistant-debug-search-plan-question"><span>{t("当前目标")}</span><p>{plan.activeGoalLabel}</p></div> : null}
    <div className="assistant-debug-search-goals">
      {plan.goals.map((goal, index) => <details className="assistant-debug-search-goal" data-status={goal.status} key={`${goal.label}-${index}`}>
        <summary><span>{t("目标")} {index + 1} · {goal.label}</span><small>{translatePlanGoalStatus(goal.status)} {t("· 已读")} {goal.evidenceCount} {t("条")}</small></summary>
        <div className="assistant-debug-search-goal-body">
          <div className="assistant-debug-search-goal-meta"><span>{t("证据类型")}</span><strong>{translateSearchEvidenceKind(goal.evidenceKind)}</strong></div>
          {goal.requirements.length ? <div className="assistant-debug-search-requirements"><span>{t("要求")}</span>{goal.requirements.map((requirement) => <p key={requirement.label}>{requirement.label} {t("· 至少")} {requirement.minEvidence} {t("条证据")}</p>)}</div> : null}
          <div className="assistant-debug-query-terms"><span>QueryTerm{goal.queryTermCount > goal.queryTerms.length ? t("（显示 {0}/{1}）", { '0': goal.queryTerms.length, '1': goal.queryTermCount }) : ''}</span><div>{goal.queryTerms.length ? goal.queryTerms.map((queryTerm) => <span className="assistant-debug-query-term" data-source={queryTerm.source} key={`${queryTerm.term}-${queryTerm.source}`}>{queryTerm.term}<small>{translateQueryTermSource(queryTerm.source)}</small></span>) : <em>{t("暂无")}</em>}</div></div>
        </div>
      </details>)}
    </div>
    <div className="assistant-debug-final-query"><span>{t("最后查询关键词")}</span><div>{finalQueryTerms?.length ? finalQueryTerms.map((term) => <span className="assistant-debug-query-term assistant-debug-query-term-final" key={term}>{term}</span>) : <em>{t("本轮尚未执行关键词查询")}</em>}</div></div>
  </div>;
}

function translateSearchEvidenceKind(kind: NonNullable<CurrentNotePublicPlanEvent['searchPlan']>['goals'][number]['evidenceKind']): string {
  return ({ fact: t("事实"), definition: '定义', comparison: '比较', cause: '原因', timeline: '时间线' } as const)[kind];
}

function translateQueryTermSource(source: NonNullable<CurrentNotePublicPlanEvent['searchPlan']>['goals'][number]['queryTerms'][number]['source']): string {
  return ({ planner: 'Planner', 'note-map': t("目录"), 'search-observation': '检索观察', 'model-synonym': '模型变体', 'user-confirmed': '用户确认' } as const)[source];
}

function AssistantPlanTrace({ event, searchScope, searchCoverage, completeness, agentStats }: { event: CurrentNotePublicPlanEvent; searchScope?: CurrentNotePublicSearchScope; searchCoverage?: CurrentNotePublicSearchCoverage; completeness?: 'complete' | 'partial' | 'not-found'; agentStats?: CurrentNoteAgentStats }) {
  useI18n();
  const view = getAssistantPlanView(event);
  const coverageView = getAssistantSearchCoverageView(searchScope, searchCoverage, completeness, agentStats);
  return <section className="assistant-plan-trace" data-status={event.status} aria-label={t("当前核实计划")}>
    <div className="assistant-plan-trace-heading"><strong>{t("核实计划")}</strong><span>{view.statusLabel}</span></div>
    <div className="assistant-plan-trace-list" role="list">
      {view.goals.map((goal, index) => <div className="assistant-plan-trace-goal" data-status={goal.status} role="listitem" key={`${index}-${goal.label}`}>
        <span className="assistant-plan-trace-goal-state" aria-label={goal.statusLabel}>{goal.status === 'covered' ? <CircleCheck size={12} /> : goal.status === 'conflicted' ? <CircleX size={12} /> : goal.status === 'searching' ? <LoaderCircle size={12} /> : <span aria-hidden="true">•</span>}</span>
        <span className="assistant-plan-trace-goal-label">{goal.label}</span>
        <span className="assistant-plan-trace-goal-status">{goal.statusLabel}</span>
        <span className="assistant-plan-trace-evidence">{goal.evidenceLabel}</span>
      </div>)}
    </div>
    {coverageView ? <AssistantSearchCoverageSummary view={coverageView} /> : null}
  </section>;
}

function AssistantSearchCoverageSummary({ view }: { view: ReturnType<typeof getAssistantSearchCoverageView> }) {
  useI18n();
  if (!view) return null;
  return <div className="assistant-plan-trace-coverage" aria-label={t("检索范围与覆盖")}>
    <div><span>{t("范围")}</span><strong>{view.scopeLabel}</strong></div>
    <div><span>{t("覆盖")}</span><strong>{view.coverageLabel}</strong></div>
    <div><span>{t("进度")}</span><strong>{view.locatedLabel} · {view.readLabel}</strong></div>
    {view.partialReason ? <p>{view.partialReason}</p> : null}
  </div>;
}

function AssistantToolResultViews({ results }: { results: NonNullable<AssistantToolTraceEntry['publicResults']> }) {
  useI18n();
  return <div className="assistant-debug-content-list" aria-label={t("工具返回结果")}>
    {results.map((item, index) => <article className="assistant-debug-content-preview" data-kind="candidate" key={`${item.reference ?? item.url ?? item.title ?? 'result'}-${index}`}>
      <header>
        <strong>{item.reference ? `${item.reference} ` : ''}{item.title || item.url || t("结果 {0}", { '0': index + 1 })}</strong>
        <span>{[
          item.location,
          item.score !== undefined ? `score ${item.score.toFixed(3)}` : undefined,
          item.methods?.length ? item.methods.map((method) => method === 'semantic' ? t("语义") : t("关键词")).join('+') : undefined,
          item.seen ? t("本轮复用") : undefined,
          item.pageVerified === true ? t("已全文验证") : item.pageVerified === false ? t("摘要级") : undefined,
          item.publishedAt,
          item.source,
        ].filter(Boolean).join(' · ')}</span>
      </header>
      {item.url ? <p className="assistant-debug-evidence-snippet">{item.url}</p> : null}
      <pre>{item.snippet || item.excerpt || t("该结果没有可展示的摘要。")}</pre>
    </article>)}
  </div>;
}

function AssistantLibrarySectionNavigation({ observation }: { observation: NonNullable<CurrentNotePublicToolEvent['sectionNavigation']> }) {
  useI18n();
  return <section className="assistant-debug-section-navigation" aria-label={t("推荐章节导航状态")}>
    <header><strong>{t("推荐章节")} {observation.candidates.length}</strong><span>{t("导航状态 · 已评估")} {observation.evaluatedSectionCount} {t("章")}</span></header>
    {observation.fallbackUsed ? <p>{t("根据已读原文中的区分词继续定位。")}</p> : null}
    {observation.ambiguous ? <p data-state="ambiguous">{t("当前查询词无法区分章节，需要更具体主题。")}</p> : null}
    {observation.candidates.length ? <div className="assistant-debug-section-navigation-list">
      {observation.candidates.map((candidate, index) => <article key={`${candidate.lineFrom}-${candidate.lineTo}-${index}`}>
        <div><strong>{candidate.headingPath.length ? candidate.headingPath.join(' / ') : t("笔记开头")}</strong><span>L{candidate.lineFrom}–L{candidate.lineTo}</span></div>
        <small>score {candidate.score.toFixed(2)} · matched terms {candidate.matchedTerms.length ? candidate.matchedTerms.join('、') : t("无")}</small>
      </article>)}
    </div> : null}
  </section>;
}

export function AssistantToolTrace({ events, modelEvents, isRunning, executionElapsedMs }: { events: CurrentNotePublicToolEvent[]; modelEvents: AssistantPublicModelEvent[]; isRunning: boolean; executionElapsedMs?: number }) {
  useI18n();
  const entries = useMemo(() => groupAssistantToolEvents(events), [events]);
  const modelEntries = useMemo(() => groupAssistantModelEvents(modelEvents), [modelEvents]);
  const modelOutputByToolId = useMemo(() => pairAssistantModelOutputs(entries, modelEntries), [entries, modelEntries]);
  const wasRunningRef = useRef(isRunning);
  const [expanded, setExpanded] = useState(isRunning);

  useEffect(() => {
    if (isRunning && !wasRunningRef.current) setExpanded(true);
    if (!isRunning && wasRunningRef.current) setExpanded(false);
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  const rejectedCount = entries.filter((entry) => entry.state === 'rejected').length;
  return <details className="assistant-tool-trace" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="assistant-tool-trace-summary-icon" aria-hidden="true">{isRunning ? <LoaderCircle size={13} /> : <SquareTerminal size={13} />}</span>
      <span>{isRunning ? t("正在运行工具 · {0} 步", { '0': entries.length }) : t("运行过程 · {0} 次工具", { '0': entries.length })}</span>
      {!isRunning && executionElapsedMs !== undefined ? <span className="assistant-tool-trace-elapsed">{t("耗时")} {formatExecutionDuration(executionElapsedMs)}</span> : null}
      {!isRunning && rejectedCount ? <span className="assistant-tool-trace-warning">{rejectedCount} {t("次未完成")}</span> : null}
      <ChevronRight className="assistant-tool-trace-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="assistant-tool-trace-list" role="list" aria-label={t("本轮工具运行过程")}>
      {entries.map((entry) => <div key={entry.id} className="assistant-tool-trace-entry" data-state={entry.state} role="listitem">
        <span className="assistant-tool-trace-state" aria-label={translateToolEventState(entry.state)}>
          {entry.state === 'completed' ? <CircleCheck size={13} /> : entry.state === 'rejected' ? <CircleX size={13} /> : <LoaderCircle size={13} />}
        </span>
        <div className="assistant-tool-trace-body">
          <div className="assistant-tool-trace-heading">
            <strong>{translateCurrentNoteTool(entry.tool)}</strong>
            {entry.elapsedMs !== undefined ? <time>{formatExecutionDuration(entry.elapsedMs)}</time> : null}
          </div>
          {entry.rationale ? <p>{entry.rationale}</p> : null}
          <AssistantToolOutputDetails entry={entry} modelEvent={modelOutputByToolId.get(entry.id)} />
        </div>
      </div>)}
    </div>
  </details>;
}

function AssistantToolOutputDetails({ entry, modelEvent }: { entry: AssistantToolTraceEntry; modelEvent?: AssistantPublicModelEvent }) {
  useI18n();
  const summaries = [...new Set([entry.outputSummary, entry.outcome]
    .filter((value): value is string => Boolean(value?.trim()) && value !== entry.rationale))];
  const hasStructuredOutput = Boolean(entry.sectionNavigation || entry.publicResults?.length || entry.contentPreviews?.length);
  const hasModelOutput = Boolean(modelEvent?.output?.text.trim());
  if (entry.state === 'started' || !hasModelOutput && summaries.length === 0 && !hasStructuredOutput) return null;

  const label = hasModelOutput ? 'AI 过程说明' : entry.state === 'rejected' ? '失败详情' : '工具输出';
  return <details className="assistant-tool-output" data-state={entry.state}>
    <summary>
      <ChevronRight className="assistant-tool-output-chevron" size={12} aria-hidden="true" />
      <span>{label}</span>
      {modelEvent ? <small>{t("第")} {modelEvent.round} {t("轮")}{modelEvent.elapsedMs === undefined ? '' : ` · ${formatExecutionDuration(modelEvent.elapsedMs)}`}</small> : null}
    </summary>
    <div className="assistant-tool-output-body">
      {hasModelOutput ? <>
        <pre>{modelEvent!.output!.text}</pre>
        {modelEvent!.output!.truncated ? <small>{t("输出过长，这里只保留开头和结尾。")}</small> : null}
      </> : null}
      {summaries.map((summary) => <p className="assistant-tool-output-summary" key={summary}>{summary}</p>)}
      {entry.sectionNavigation ? <AssistantLibrarySectionNavigation observation={entry.sectionNavigation} /> : null}
      {entry.publicResults?.length ? <AssistantToolResultViews results={entry.publicResults} /> : null}
      {entry.contentPreviews?.length ? <div className="assistant-tool-output-previews">
        {entry.contentPreviews.map((preview, index) => <article key={`${preview.kind}-${preview.lineFrom}-${preview.lineTo}-${index}`}>
          <header><strong>{preview.kind === 'candidate' ? t("检索候选 {0}", { '0': index + 1 }) : t("已读原文")}</strong><span>{preview.headingPath.length ? preview.headingPath.join(' / ') : t("笔记开头")} · L{preview.lineFrom}–L{preview.lineTo}</span></header>
          <pre>{preview.text}</pre>
          {preview.truncated ? <small>{t("内容较长，这里只显示有界预览。")}</small> : null}
        </article>)}
      </div> : null}
    </div>
  </details>;
}

function pairAssistantModelOutputs(entries: AssistantToolTraceEntry[], modelEvents: AssistantPublicModelEvent[]): Map<string, AssistantPublicModelEvent> {
  const outputs = modelEvents.filter((event) => event.callKind === 'decide' && event.state !== 'started' && event.output?.text.trim());
  const byRound = new Map(outputs.map((event) => [event.round, event]));
  const paired = new Map<string, AssistantPublicModelEvent>();
  const usedCallIds = new Set<string>();

  for (const entry of entries) {
    if (entry.round !== undefined) {
      const event = byRound.get(entry.round);
      if (event) paired.set(entry.id, event);
      continue;
    }
    const toolNames = getAssistantModelToolNames(entry.tool);
    const event = outputs.find((candidate) => !usedCallIds.has(candidate.callId)
      && toolNames.some((toolName) => candidate.output?.text.includes(toolName)));
    if (!event) continue;
    paired.set(entry.id, event);
    usedCallIds.add(event.callId);
  }
  return paired;
}

function getAssistantModelToolNames(tool: CurrentNotePublicToolEvent['tool']): string[] {
  const aliases: Partial<Record<CurrentNotePublicToolEvent['tool'], string>> = {
    knowledge_agent_search: 'knowledge_search',
    knowledge_agent_grep: 'grep_chunks',
    knowledge_agent_deep_read: 'list_knowledge_chunks',
    knowledge_agent_doc_info: 'get_document_info',
    knowledge_agent_skill: 'read_skill',
    knowledge_agent_graph_search: 'graph_local_search',
    knowledge_agent_graph_global_search: 'graph_global_search',
    knowledge_agent_web_search: 'web_search',
    knowledge_agent_web_fetch: 'web_fetch',
    assistant_web_search: 'web_search',
    assistant_web_fetch: 'web_fetch',
    assistant_tool_error: '工具调用失败',
    search_conversations: 'search_conversations',
  };
  return [aliases[tool] ?? tool];
}

function groupAssistantToolEvents(events: CurrentNotePublicToolEvent[]): AssistantToolTraceEntry[] {
  const entries: AssistantToolTraceEntry[] = [];
  events.forEach((event, index) => {
    if (event.state === 'started') {
      entries.push({ id: `${event.tool}-${index}`, tool: event.tool, state: event.state, rationale: event.message, inputSummary: event.inputSummary ?? event.message, ...(event.round !== undefined ? { round: event.round } : {}) });
      return;
    }
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      if (entry.tool !== event.tool || entry.state !== 'started') continue;
      entries[entryIndex] = {
        ...entry,
        state: event.state,
        outcome: event.message,
        ...(event.round !== undefined ? { round: event.round } : {}),
        ...(event.inputSummary ? { inputSummary: event.inputSummary } : {}),
        ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
        ...(event.contentPreviews?.length ? { contentPreviews: event.contentPreviews } : {}),
        ...(event.publicResults?.length ? { publicResults: event.publicResults } : {}),
        ...(event.sectionNavigation ? { sectionNavigation: event.sectionNavigation } : {}),
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
      };
      return;
    }
    entries.push({
      id: `${event.tool}-${index}`,
      tool: event.tool,
      state: event.state,
      outcome: event.message,
      ...(event.round !== undefined ? { round: event.round } : {}),
      ...(event.inputSummary ? { inputSummary: event.inputSummary } : {}),
      ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
      ...(event.contentPreviews?.length ? { contentPreviews: event.contentPreviews } : {}),
      ...(event.publicResults?.length ? { publicResults: event.publicResults } : {}),
      ...(event.sectionNavigation ? { sectionNavigation: event.sectionNavigation } : {}),
      ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    });
  });
  return entries;
}

function ContextProjectionDiagnosticsPanel({ diagnostics, onStartNewTopic }: {
  diagnostics?: ContextProjectionDiagnostics;
  onStartNewTopic: () => void;
}) {
  useI18n();
  if (!diagnostics) {
    return <section className="assistant-debug-section assistant-context-diagnostics-section">
      <div className="assistant-debug-section-heading"><strong>Context Envelope</strong><span>{t("等待本轮")}</span></div>
      <DebugEmptyHint>{t("完成或启动一轮问答后，这里会展示不含提示词原文的上下文诊断。")}</DebugEmptyHint>
    </section>;
  }
  const finalDenominator = Math.max(1, diagnostics.tokens.final);
  const confirmNewTopic = () => {
    const confirmed = window.confirm('新建话题会结束当前上下文链，并从空白会话开始；已有历史仍保留在本地，可从历史记录重新打开。是否继续？');
    if (confirmed) onStartNewTopic();
  };
  return <section className="assistant-debug-section assistant-context-diagnostics-section">
    <details className="assistant-context-diagnostics" data-pressure={diagnostics.pressureLevel}>
      <summary>
        <ChevronRight className="assistant-debug-disclosure-icon" size={12} aria-hidden="true" />
        <span>Context Envelope</span>
        <small>{translateContextRuntimeMode(diagnostics.mode)} · L{diagnostics.pressureLevel} · {translateContextRoute(diagnostics.route)}</small>
      </summary>
      <div className="assistant-context-diagnostics-body">
        <div className="assistant-context-token-ledger" aria-label={t("上下文 Token 账本")}>
          <div><span>Candidate</span><b>{formatExactTokens(diagnostics.tokens.candidate)}</b></div>
          <div><span>Final</span><b>{formatExactTokens(diagnostics.tokens.final)}</b></div>
          <div><span>Output Reserve</span><b>{formatExactTokens(diagnostics.tokens.outputReserve)}</b></div>
          <div><span>Safety</span><b>{formatExactTokens(diagnostics.tokens.safety)}</b></div>
        </div>
        <dl className="assistant-context-window-ledger">
          <div><dt>{t("物理窗口")}</dt><dd>{diagnostics.window.physicalTokens ? formatExactTokens(diagnostics.window.physicalTokens) : t("未知")} · {translatePhysicalSource(diagnostics.window.physicalSource)}</dd></div>
          <div><dt>{t("产品上限")}</dt><dd>{diagnostics.window.productCapMode === 'follow-model' ? t("跟随模型") : formatExactTokens(diagnostics.window.productCeilingTokens)}</dd></div>
          <div><dt>{t("用户上限")}</dt><dd>{diagnostics.window.userCapTokens ? formatExactTokens(diagnostics.window.userCapTokens) : t("未设置")}</dd></div>
          <div><dt>{t("有效窗口")}</dt><dd>{formatExactTokens(diagnostics.window.effectiveTokens)}</dd></div>
          <div><dt>{t("可用输入")}</dt><dd>{formatExactTokens(diagnostics.window.availablePromptTokens)}</dd></div>
          <div><dt>{t("自动压缩")}</dt><dd>{formatExactTokens(diagnostics.window.autoCompactAtTokens)}</dd></div>
        </dl>
        {diagnostics.admission ? <>
          <div className="assistant-debug-section-heading"><strong>{t("按需准入")}</strong><span>{diagnostics.admission.admittedMaterials} / {diagnostics.admission.candidateMaterials}</span></div>
          <div className="assistant-context-token-ledger" aria-label={t("按需准入 Token 账本")}>
            <div><span>Tool Catalog</span><b>{formatExactTokens(diagnostics.admission.toolCatalogTokens)}</b></div>
            <div><span>Active Defs</span><b>{formatExactTokens(diagnostics.admission.activeToolDefinitionTokens)}</b></div>
            <div><span>Skill Desc</span><b>{formatExactTokens(diagnostics.admission.skillDescriptionTokens)}</b></div>
            <div><span>Skill Body</span><b>{formatExactTokens(diagnostics.admission.selectedSkillBodyTokens)}</b></div>
            <div><span>Attachment Meta</span><b>{formatExactTokens(diagnostics.admission.attachmentMetadataTokens)}</b></div>
            <div><span>Attachment Body</span><b>{formatExactTokens(diagnostics.admission.attachmentContentTokens)}</b></div>
          </div>
          <Text size="xs" c="dimmed">{t("延迟加载")} {diagnostics.admission.deferredMaterials} {t("项")}{diagnostics.admission.activationReasons.length ? ` · ${diagnostics.admission.activationReasons.join('；')}` : ''}</Text>
        </> : null}
        {diagnostics.pressureEpisode ? <>
          <div className="assistant-debug-section-heading"><strong>Pressure Episode</strong><span>{diagnostics.pressureEpisode.initialLevel} → {diagnostics.pressureEpisode.finalLevel}</span></div>
          <dl className="assistant-context-window-ledger">
            <div><dt>U_window</dt><dd>{formatUsagePercent(diagnostics.pressureEpisode.initialUWindow * 100)} → {formatUsagePercent(diagnostics.pressureEpisode.finalUWindow * 100)}</dd></div>
            <div><dt>{t("材料指纹")}</dt><dd><code>{diagnostics.pressureEpisode.materialFingerprint.slice(0, 16)}</code></dd></div>
            <div><dt>{t("最小有效收益")}</dt><dd>{formatExactTokens(diagnostics.pressureEpisode.minPressureGainTokens)}</dd></div>
            <div><dt>{t("停止原因")}</dt><dd>{diagnostics.pressureEpisode.stoppedReason}{diagnostics.pressureEpisode.ineffectiveGain ? t(" · 低收益") : ''}</dd></div>
          </dl>
          {diagnostics.pressureEpisode.actions.length ? <ul className="assistant-context-pressure-actions">{diagnostics.pressureEpisode.actions.map((action, index) => <li key={`${action.kind}:${index}`}><span>{action.level} · {action.kind}</span><b>{t("释放")} {formatExactTokens(action.releasedTokens)}</b></li>)}</ul> : null}
        </> : null}
        {diagnostics.residualMemory ? <>
          <div className="assistant-debug-section-heading"><strong>{t("Residual Memory · 只观测")}</strong><span>{diagnostics.residualMemory.wouldOptimize.pressureLevel}</span></div>
          <div className="assistant-context-token-ledger" aria-label={t("剩余窗口 Token 账本")}>
            {(['W', 'O', 'G', 'N', 'C', 'M', 'H'] as const).map((key) => <div key={key}><span>{key}</span><b>{formatExactTokens(diagnostics.residualMemory!.budget[key])}</b></div>)}
            <div><span>U_window</span><b>{formatUsagePercent(diagnostics.residualMemory.budget.UWindow * 100)}</b></div>
          </div>
          <dl className="assistant-context-window-ledger">
            <div><dt>{t("旧路径实际 M1 / M2")}</dt><dd>{formatExactTokens(diagnostics.residualMemory.legacy.M1.tokens)} / {formatExactTokens(diagnostics.residualMemory.legacy.M2.tokens)}</dd></div>
            <div><dt>would-optimize</dt><dd>{diagnostics.residualMemory.wouldOptimize.required ? diagnostics.residualMemory.wouldOptimize.actions.join(' → ') : t("否")}</dd></div>
            <div><dt>would-include</dt><dd>{diagnostics.residualMemory.wouldInclude.turnCount} {t("轮 ·")} {formatExactTokens(diagnostics.residualMemory.wouldInclude.estimatedTokens)}</dd></div>
            <div><dt>would-compact</dt><dd>{diagnostics.residualMemory.wouldCompact.candidate ? t("至轮 {0}", { '0': diagnostics.residualMemory.wouldCompact.compactThroughTurnSeq ?? '--' }) : t("否")}</dd></div>
          </dl>
        </> : null}
        {diagnostics.residualMemoryEnforcement ? <>
          <div className="assistant-debug-section-heading"><strong>Residual Memory · Chat Enforce</strong><span>{diagnostics.residualMemoryEnforcement.initialPressureLevel} → {diagnostics.residualMemoryEnforcement.finalPressureLevel}</span></div>
          <div className="assistant-context-token-ledger" aria-label={t("会话剩余窗口 Token 账本")}>
            {(['W', 'O', 'G', 'N', 'C', 'M', 'H'] as const).map((key) => <div key={key}><span>{key}</span><b>{formatExactTokens(diagnostics.residualMemoryEnforcement!.budget[key])}</b></div>)}
            <div><span>U_window</span><b>{formatUsagePercent(diagnostics.residualMemoryEnforcement.budget.UWindow * 100)}</b></div>
          </div>
          <dl className="assistant-context-window-ledger">
            <div><dt>{t("运行状态")}</dt><dd>{diagnostics.residualMemoryEnforcement.state}</dd></div>
            <div><dt>Checkpoint</dt><dd>v{diagnostics.residualMemoryEnforcement.conversation.checkpointVersion} {t("· 覆盖至轮")} {diagnostics.residualMemoryEnforcement.conversation.coveredThroughSeq} · {formatExactTokens(diagnostics.residualMemoryEnforcement.conversation.checkpointTokens)}</dd></div>
            <div><dt>{t("原始会话尾部")}</dt><dd>{diagnostics.residualMemoryEnforcement.conversation.rawTurnCount} {t("轮 ·")} {formatExactTokens(diagnostics.residualMemoryEnforcement.conversation.rawTokens)} {t("· 完整原文")}</dd></div>
            <div><dt>{t("压缩边界")}</dt><dd>{diagnostics.residualMemoryEnforcement.compaction.triggered ? t("轮 {0}–{1}", { '0': diagnostics.residualMemoryEnforcement.compaction.compactedFromSeq ?? '--', '1': diagnostics.residualMemoryEnforcement.compaction.compactedThroughSeq ?? '--' }) : t("未触发")}</dd></div>
            <div><dt>{t("压缩尝试")}</dt><dd>{diagnostics.residualMemoryEnforcement.compaction.attempts} {t("次 · 模型")} {diagnostics.residualMemoryEnforcement.compaction.modelCalls} {t("· 写入")} {diagnostics.residualMemoryEnforcement.compaction.memoryWrites}{diagnostics.residualMemoryEnforcement.compaction.fallbackUsed ? ' · fallback' : ''}</dd></div>
            <div><dt>{t("回滞目标 / 释放")}</dt><dd>{formatExactTokens(diagnostics.residualMemoryEnforcement.budget.reentryTargetPromptTokens)} / {formatExactTokens(diagnostics.residualMemoryEnforcement.compaction.releasedTokens)}</dd></div>
          </dl>
        </> : null}
        {diagnostics.providerUsage ? <dl className="assistant-context-window-ledger" aria-label={t("Provider usage 估算误差")}>
          <div><dt>Provider usage</dt><dd>{diagnostics.providerUsage.reported ? formatExactTokens(diagnostics.providerUsage.providerInputTokens ?? 0) : t("未返回")}</dd></div>
          <div><dt>{t("本地原始 / 校准估算")}</dt><dd>{formatExactTokens(diagnostics.providerUsage.localRawInputTokens)} / {formatExactTokens(diagnostics.providerUsage.localCalibratedInputTokens)}</dd></div>
          <div><dt>{t("原始估算误差")}</dt><dd>{diagnostics.providerUsage.rawEstimateRelativeError !== undefined ? formatUsagePercent(diagnostics.providerUsage.rawEstimateRelativeError * 100) : '--'}</dd></div>
          <div><dt>{t("校准估算误差")}</dt><dd>{diagnostics.providerUsage.calibratedEstimateRelativeError !== undefined ? formatUsagePercent(diagnostics.providerUsage.calibratedEstimateRelativeError * 100) : '--'}</dd></div>
        </dl> : null}
        <div className="assistant-context-zone-list" aria-label={t("上下文分区诊断")}>
          {diagnostics.zones.map((zone) => <article key={zone.zone} className="assistant-context-zone" style={{ '--context-zone-share': `${Math.max(3, Math.min(100, zone.finalTokens / finalDenominator * 100))}%` } as CSSProperties}>
            <header><strong>{translateContextZone(zone.zone)}</strong><span>{formatExactTokens(zone.candidateTokens)} → {formatExactTokens(zone.finalTokens)}</span></header>
            <div className="assistant-context-zone-bar"><i /></div>
            <p>{zone.channels.join('+')} · {zone.trusts.join('+')}{zone.protectedMaterials ? ` · protected ${zone.protectedMaterials}` : ''}</p>
            {zone.compressionActions.length ? <small>{zone.compressionActions.map(translateContextAction).join(' · ')}</small> : null}
          </article>)}
        </div>
        {diagnostics.omissions.length ? <details className="assistant-context-omissions">
          <summary>{t("省略材料")} {diagnostics.omissions.length} {t("项")}</summary>
          <ul>{diagnostics.omissions.map((item) => <li key={`${item.materialId}:${item.reason}`}><code>{item.materialId}</code><span>{translateContextZone(item.zone)} · {translateContextOmission(item.reason)} · {formatExactTokens(item.estimatedTokens)}</span></li>)}</ul>
        </details> : null}
        <div className="assistant-context-prefix">
          <span>{t("稳定前缀")}</span>
          <code>{diagnostics.stablePrefix.fingerprint ?? t("无")}</code>
          <small>{diagnostics.stablePrefix.cacheEligible ? t("具备前缀复用条件") : t("本轮不具备前缀复用条件")}{t("；这里只表示可复用性，不代表 Provider 已命中缓存。")}</small>
        </div>
        {diagnostics.invariantViolations.length ? <div className="assistant-context-violations" role="alert"><strong>{t("投影校验未通过")}</strong>{diagnostics.invariantViolations.map((message, index) => <p key={`${message}-${index}`}>{message}</p>)}</div> : null}
        <div className="assistant-context-diagnostics-actions">
          <span>{diagnostics.providerId} · {diagnostics.modelId} · {diagnostics.sendPath}</span>
          <Button size="compact-xs" variant="light" color="gray" leftSection={<Plus size={12} />} onClick={confirmNewTopic}>{t("新建话题")}</Button>
        </div>
      </div>
    </details>
  </section>;
}

function translateContextRuntimeMode(mode: ContextProjectionDiagnostics['mode']): string {
  return mode === 'enforce' ? '正式投影' : '观察对比';
}

function translateContextRoute(route: ContextProjectionDiagnostics['route']): string {
  return route === 'knowledge-base' ? '知识库' : route === 'current-note' ? t("当前笔记") : '直接聊天';
}

function translatePhysicalSource(source: ContextProjectionDiagnostics['window']['physicalSource']): string {
  if (source === 'provider') return t("服务商");
  if (source === 'model-catalog') return t("模型目录");
  if (source === 'ollama') return 'Ollama';
  if (source === 'user') return '用户设置';
  return '保守估算';
}

function translateContextZone(zone: ContextProjectionDiagnostics['zones'][number]['zone']): string {
  const labels: Record<ContextProjectionDiagnostics['zones'][number]['zone'], string> = {
    'stable-policy': 'S 稳定策略',
    'project-context': 'P 项目上下文',
    'user-profile': '用户画像',
    'long-term-memory': 'L4 长期记忆',
    'agent-state': 'A Agent 状态',
    'conversation-summary': 'M1 会话摘要',
    'conversation-hot': 'M2 热记忆',
    'conversation-recall': 'M3 召回记忆',
    'note-capsule': 'N 笔记胶囊',
    'dynamic-evidence': t("D 动态证据"),
    'tool-observation': 'T 工具观察',
    'current-request': 'Q 当前请求',
    'output-contract': 'C 输出契约',
  };
  return labels[zone];
}

function translateContextAction(action: string): string {
  if (action.startsWith('omit:')) return `省略：${translateContextOmission(action.slice(5))}`;
  const labels: Record<string, string> = { dedupe: '去重', reference: '转引用', truncate: '截断', summary: '摘要', drop: '丢弃' };
  return labels[action] ?? action;
}

function translateContextOmission(reason: string): string {
  const labels: Record<string, string> = { duplicate: '重复', budget: '预算不足', stale: '状态过期', invalid: '校验失败', policy: '策略排除' };
  return labels[reason] ?? reason;
}

function formatExactTokens(tokens: number): string {
  return `${tokens.toLocaleString(getAppLanguage())} tok`;
}

function AssistantDebugRail({
  messages,
  selectedMessage,
  onSelectMessage,
  memoryMode,
  memory,
  contextUsage,
  contextWindowTokens,
  onStartNewTopic,
}: {
  messages: AssistantMessage[];
  selectedMessage: AssistantMessage | null;
  onSelectMessage: (messageId: string) => void;
  memoryMode: AssistantMemoryMode;
  memory: AssistantSessionDetail | null;
  contextUsage: AssistantContextWindowUsageSummary;
  contextWindowTokens?: number;
  onStartNewTopic: () => void;
}) {
  useI18n();
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const result = selectedMessage?.result?.type === 'answer' ? selectedMessage.result : undefined;
  const contextDiagnostics = result?.contextDiagnostics ?? selectedMessage?.contextDiagnostics;
  const planEvents = result?.planEvents ?? selectedMessage?.planEvents ?? [];
  const modelEvents = result?.modelEvents ?? selectedMessage?.modelEvents ?? [];
  const modelEntries = groupAssistantModelEvents(modelEvents);
  const compressionNotice = buildAssistantContextCompressionNotice(contextDiagnostics, modelEvents);
  const toolEvents = result?.toolEvents ?? selectedMessage?.toolEvents ?? [];
  const toolEntries = groupAssistantToolEvents(toolEvents);
  const latestPlanEvent = planEvents.at(-1);
  const finalQueryTerms = latestPlanEvent?.finalQueryTerms ?? getLastSearchQueryTerms(toolEntries);
  const plannerOutputs = planEvents.flatMap((event) => event.plannerOutputJson ? [event.plannerOutputJson] : []);
  const coverageView = getAssistantSearchCoverageView(result?.searchScope, result?.searchCoverage, result?.completeness, result?.agentStats);
  const memoryText = memory?.rollingSummary.trim();
  const selectedMessageIndex = selectedMessage ? messages.findIndex((message) => message.id === selectedMessage.id) : -1;
  const selectedQuestion = selectedMessageIndex > 0
    ? [...messages.slice(0, selectedMessageIndex)].reverse().find((message) => message.role === 'user')?.content.trim()
    : undefined;
  const retrievedPreviews = toolEntries.flatMap((entry) => entry.contentPreviews ?? []);
  const evidencePreviewCount = retrievedPreviews.filter((preview) => preview.kind === 'evidence').length;
  const recentStoredTurns = memory ? [...memory.turns.items].sort((first, second) => second.turnSeq - first.turnSeq).slice(0, 3) : [];
  const usagePercent = contextWindowTokens && contextWindowTokens > 0
    ? contextUsage.totalTokens / contextWindowTokens * 100
    : undefined;

  return <aside className="assistant-debug-rail" aria-label={t("AI 调试轨道")}>
    <header className="assistant-debug-heading">
      <span><SquareTerminal size={14} aria-hidden="true" />{t("调试轨道")}</span>
      <small>{t("本地可审计摘要")}</small>
    </header>
    {compressionNotice ? <AssistantContextCompressionNotice notice={compressionNotice} inDebugRail /> : null}
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("执行轮次")}</strong><span>{assistantMessages.length}</span></div>
      {assistantMessages.length ? <div className="assistant-debug-turn-list" role="list" aria-label={t("选择执行轮次")}>
        {assistantMessages.map((message, index) => <button key={message.id} type="button" role="listitem" data-active={message.id === selectedMessage?.id || undefined} onClick={() => onSelectMessage(message.id)}>
          <span>#{index + 1}</span><small>{message.state === 'complete' ? t("已完成") : message.state === 'error' ? t("失败") : message.state === 'cancelled' ? t("已取消") : t("执行中")}</small>
        </button>)}
      </div> : <DebugEmptyHint>{t("发起一次 AI 请求后，这里会保留本轮公开执行轨迹。")}</DebugEmptyHint>}
    </section>
    <ContextProjectionDiagnosticsPanel diagnostics={contextDiagnostics} onStartNewTopic={onStartNewTopic} />
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>Planner Structured Output</strong><span>{plannerOutputs.length}</span></div>
      {plannerOutputs.length ? <pre className="assistant-debug-planner-json" aria-label="Planner Structured Output JSON">{plannerOutputs[0]}</pre>
        : planEvents.length ? <DebugEmptyHint>{t("本轮未保留通过 Schema 校验的 Planner Structured Output；下方仅展示已接受的 SearchPlan。")}</DebugEmptyHint>
          : <DebugEmptyHint>{t("本轮未启用 Planner，或尚未产生公开计划。")}</DebugEmptyHint>}
      {latestPlanEvent?.searchPlan ? <AssistantSearchPlanSummary plan={latestPlanEvent.searchPlan} finalQueryTerms={finalQueryTerms} /> : null}
      {coverageView ? <AssistantSearchCoverageSummary view={coverageView} /> : null}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("ReAct 模型轮次")}</strong><span>{modelEntries.length}</span></div>
      {modelEntries.length ? <div className="assistant-debug-model-list" aria-label={t("ReAct 每轮模型输入输出")}>{modelEntries.map((entry, index) => <details className="assistant-debug-model-call" data-state={entry.state} key={entry.callId} open={entry.state === 'started' || index === modelEntries.length - 1}>
        <summary>
          <ChevronRight className="assistant-debug-disclosure-icon" size={12} aria-hidden="true" />
          <span>{t("第")} {entry.round} {t("轮 ·")} {translateAssistantModelCallKind(entry.callKind)}</span>
          <small>{translateToolEventState(entry.state)}{entry.elapsedMs === undefined ? '' : ` · ${formatExecutionDuration(entry.elapsedMs)}`}</small>
        </summary>
        <div className="assistant-debug-model-io">
          <article data-direction="input">
            {entry.inputCompression ? <AssistantModelInputCompressionNotice compression={entry.inputCompression} /> : null}
            <header><strong>{t("交给模型的输入")}</strong><span>{entry.input.originalCharacters.toLocaleString(getAppLanguage())} {t("字")}{entry.inputCompression ? t(" · 已压缩") : ''}{entry.input.truncated ? t(" · 首尾预览") : ''}</span></header>
            <pre>{entry.input.text}</pre>
            {entry.input.truncated ? <small>{t("为避免 128K 提示词拖慢界面，这里保留实际输入的开头和结尾，中间内容已标出省略数量。")}</small> : null}
          </article>
          <article data-direction="output">
            <header><strong>{t("模型原始输出")}</strong><span>{entry.output ? t("{0} 字{1}", { '0': entry.output.originalCharacters.toLocaleString(getAppLanguage()), '1': entry.output.truncated ? t(" · 首尾预览") : '' }) : entry.state === 'started' ? t("等待返回") : entry.errorCode ?? t("无返回")}</span></header>
            <pre>{entry.output?.text ?? (entry.state === 'started' ? t("模型正在生成本轮输出…") : t("模型未返回可展示的原始内容。"))}</pre>
            {entry.output?.truncated ? <small>{t("输出过长，已保留开头和结尾。")}</small> : null}
          </article>
        </div>
      </details>)}</div> : <DebugEmptyHint>{t("本轮还没有 ReAct 模型调用。该轨迹只保留在本次应用运行中，恢复的历史会话不包含模型收发原文。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("ReAct 工具调用")}</strong><span>{toolEntries.length}</span></div>
      {toolEntries.length ? <div className="assistant-debug-tool-list">{toolEntries.map((entry) => <details className="assistant-debug-tool" data-state={entry.state} key={entry.id} open={entry.state === 'started'}>
        <summary>
          <ChevronRight className="assistant-debug-disclosure-icon" size={12} aria-hidden="true" />
          <span className="assistant-debug-tool-title">{translateCurrentNoteTool(entry.tool)}</span>
          <small>{translateToolEventState(entry.state)}{entry.elapsedMs === undefined ? '' : ` · ${formatExecutionDuration(entry.elapsedMs)}`}</small>
          <span className="assistant-debug-tool-teaser">{getAssistantToolTeaser(entry)}</span>
        </summary>
        <dl>
          <div><dt>{t("输入")}</dt><dd>{entry.inputSummary ?? entry.rationale ?? t("未提供可展示的输入摘要。")}</dd></div>
          <div><dt>{entry.state === 'rejected' ? t("结果") : t("输出")}</dt><dd>{entry.outputSummary ?? entry.outcome ?? (entry.state === 'started' ? t("等待工具返回…") : t("未提供可展示的输出摘要。"))}</dd></div>
        </dl>
        {entry.sectionNavigation ? <AssistantLibrarySectionNavigation observation={entry.sectionNavigation} /> : null}
        {entry.publicResults?.length ? <AssistantToolResultViews results={entry.publicResults} /> : null}
        {entry.contentPreviews?.length ? <div className="assistant-debug-content-list" aria-label={t("工具返回内容")}>
          {entry.contentPreviews.map((preview, previewIndex) => <article className="assistant-debug-content-preview" data-kind={preview.kind} key={`${preview.kind}-${preview.lineFrom}-${preview.lineTo}-${previewIndex}`}>
            <header><strong>{preview.kind === 'candidate' ? t("检索候选 {0}", { '0': previewIndex + 1 }) : t("已读原文")}</strong><span>{preview.headingPath.length ? preview.headingPath.join(' / ') : t("笔记开头")} · L{preview.lineFrom}–L{preview.lineTo}</span></header>
            <pre>{preview.text}</pre>
            {preview.truncated ? <small>{t("这里只显示前 2,400 个字符；Agent 已读取的范围以上方行号为准。")}</small> : null}
          </article>)}
        </div> : null}
      </details>)}</div> : <DebugEmptyHint>{t("本轮没有工具调用；普通聊天不会产生 ReAct 轨迹。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section assistant-debug-context">
      <div className="assistant-debug-section-heading"><strong>{t("上下文与记忆")}</strong><span>{memoryMode === 'persistent' ? t("本地") : memoryMode === 'session-only' ? t("本次") : t("关闭")}</span></div>
      <div className="assistant-debug-context-stats">
        <span>{t("当前用量")} <b>{formatTokenCountInK(contextUsage.totalTokens)}</b></span>
        <span>{t("窗口")} {contextWindowTokens ? `${formatTokenCountInK(contextWindowTokens)} · ${formatUsagePercent(usagePercent)}` : t("未配置")}</span>
        {result?.agentStats ? <span>ReAct {result.agentStats.decisionRounds} {t("轮 · 模型")} {result.agentStats.modelCalls} {t("次")}</span> : null}
        {result?.toolStats ? <span>{t("工具")} {result.toolStats.calls} {t("次 · 读取")} {result.toolStats.readCharacters.toLocaleString(getAppLanguage())} {t("字")}</span> : null}
      </div>
      {result?.qaMemoryZones ? <div className="assistant-debug-context-stats" aria-label={t("本轮上下文分区 Token")}>
        <span>{t("S 静态策略")} <b>{result.qaMemoryZones.staticPrefix.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("M1 滚动摘要")} <b>{result.qaMemoryZones.rollingSummary.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("M2 短期记忆")} <b>{result.qaMemoryZones.shortTerm.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("Q+C 问题约束")} <b>{result.qaMemoryZones.questionConstraint.toLocaleString(getAppLanguage())}</b></span>
      </div> : null}
      <div className="assistant-debug-context-ledger" aria-label={t("可审计上下文内容")}>
        <div><span>{t("当前问题")}</span><p>{selectedQuestion || t("当前轮次没有可显示的问题文本。")}</p></div>
        <div><span>{t("已读原文")}</span><p>{evidencePreviewCount ? t("{0} 段可在上方对应工具中查看", { '0': evidencePreviewCount }) : t("本轮尚未读入原文证据")}</p></div>
        <div><span>{t("会话记录")}</span><p>{memoryMode === 'persistent' ? t("本地已保存 {0} 轮，模型按需使用滚动记忆与最近轮次", { '0': memory?.session.turnCount ?? 0 }) : memoryMode === 'session-only' ? t("使用本次应用内的对话记录") : t("本轮不使用会话记忆")}</p></div>
      </div>
      {memoryMode === 'disabled' ? <DebugEmptyHint>{t("已关闭会话记忆，本轮不会读取或写入持久化摘要。")}</DebugEmptyHint>
        : memoryMode === 'session-only' ? <DebugEmptyHint>{t("仅保留在本次应用运行中；关闭应用后不会恢复。")}</DebugEmptyHint>
          : memory ? <details className="assistant-debug-memory" open>
            <summary>{t("滚动记忆 v")}{memory.rollingSummaryVersion} {t("· 已覆盖")} {memory.rollingSummaryCoveredThroughSeq} {t("轮")}</summary>
            <pre>{memoryText || t("当前还没有可复用的滚动记忆；近期轮次会以即时对话上下文参与。")}</pre>
            {memory.rollingSummaryPayload.unresolvedQuestions.length ? <small>{t("待跟进：")}{memory.rollingSummaryPayload.unresolvedQuestions.join('；')}</small> : null}
          </details> : <DebugEmptyHint>{t("正在读取当前会话的本地滚动记忆；完成一轮后会自动刷新。")}</DebugEmptyHint>}
      {memoryMode === 'persistent' && memory ? <details className="assistant-debug-memory assistant-debug-stored-turns" open>
        <summary>{t("近期已保存对话 · 显示")} {recentStoredTurns.length}/{memory.session.turnCount} {t("轮")}</summary>
        {recentStoredTurns.length ? <div className="assistant-debug-stored-turn-list">
          {recentStoredTurns.map((turn) => <article key={turn.turnId}>
            <header><strong>{t("第")} {turn.turnSeq} {t("轮")}</strong><span>{translateStoredTurnStatus(turn.status)}</span></header>
            <div><b>{t("你")}</b><p>{turn.userText}</p></div>
            <div><b>AI</b><p>{turn.assistantText || t("该轮没有保存回答文本。")}</p></div>
          </article>)}
        </div> : <DebugEmptyHint>{t("当前会话还没有已保存的完成轮次。")}</DebugEmptyHint>}
      </details> : null}
    </section>
    <DetailedTraceSection requestId={selectedMessage?.id ?? null} isRunning={selectedMessage?.state === 'pending' || selectedMessage?.state === 'streaming'} />
  </aside>;
}

function groupAssistantModelEvents(events: AssistantPublicModelEvent[]): AssistantPublicModelEvent[] {
  const entries: AssistantPublicModelEvent[] = [];
  const indexes = new Map<string, number>();
  for (const event of events) {
    const existingIndex = indexes.get(event.callId);
    if (existingIndex === undefined) {
      indexes.set(event.callId, entries.length);
      entries.push(event);
      continue;
    }
    entries[existingIndex] = { ...entries[existingIndex], ...event };
  }
  return entries;
}

interface AssistantContextCompressionNoticeView {
  detail: string;
}

function buildAssistantContextCompressionNotice(
  diagnostics: ContextProjectionDiagnostics | undefined,
  modelEvents: AssistantPublicModelEvent[],
): AssistantContextCompressionNoticeView | undefined {
  const details: string[] = [];
  const compressedModelCalls = groupAssistantModelEvents(modelEvents).filter((event) => event.inputCompression);
  const latestModelCall = compressedModelCalls.at(-1);
  if (latestModelCall?.inputCompression) {
    details.push(`模型第 ${latestModelCall.round} 轮已执行${formatAssistantCompressionActions(latestModelCall.inputCompression.actions)}`);
  }

  const residualCompaction = diagnostics?.residualMemoryEnforcement?.compaction;
  if (residualCompaction?.triggered) {
    details.push(`较早会话已压缩为 Checkpoint，覆盖第 ${residualCompaction.compactedFromSeq ?? '--'}–${residualCompaction.compactedThroughSeq ?? '--'} 轮`);
  }

  const pressureActions = diagnostics?.mode === 'enforce'
    ? diagnostics.pressureEpisode?.actions.filter((action) => action.releasedTokens > 0 && action.kind !== 'conversation-checkpoint') ?? []
    : [];
  if (pressureActions.length) {
    const releasedTokens = pressureActions.reduce((sum, action) => sum + action.releasedTokens, 0);
    details.push(`上下文投影执行 ${pressureActions.length} 项降压，约释放 ${formatExactTokens(releasedTokens)}`);
  }

  if (!details.length) return undefined;
  return {
    detail: `${details.join('；')}。模型看到的是处理后的上下文；原始会话和工具记录没有因此被删除。`,
  };
}

function AssistantContextCompressionNotice({ notice, inDebugRail = false }: {
  notice: AssistantContextCompressionNoticeView;
  inDebugRail?: boolean;
}) {
  useI18n();
  return <div className="assistant-context-compression-notice" data-debug-rail={inDebugRail || undefined} role="status" aria-live="polite">
    <BrainCircuit size={14} aria-hidden="true" />
    <div><strong>{t("本轮已发生上下文压缩")}</strong><p>{notice.detail}</p></div>
  </div>;
}

function AssistantModelInputCompressionNotice({ compression }: {
  compression: NonNullable<AssistantPublicModelEvent['inputCompression']>;
}) {
  useI18n();
  return <div className="assistant-debug-model-compression" role="status">
    <BrainCircuit size={13} aria-hidden="true" />
    <div>
      <strong>{t("本次送模前已压缩上下文")}</strong>
      <span>{formatAssistantCompressionActions(compression.actions)} {t("· 估算")} {formatExactTokens(compression.estimatedTokensBefore)} → {formatExactTokens(compression.estimatedTokensAfter)}</span>
      <small>{t("下方是模型实际收到的压缩后输入；“首尾预览”只影响调试显示。")}</small>
    </div>
  </div>;
}

function formatAssistantCompressionActions(actions: NonNullable<AssistantPublicModelEvent['inputCompression']>['actions']): string {
  return actions.map((action) => {
    if (action.kind === 'tool-result-budget') return `工具结果 ${action.affectedItems} 项按预算保留首尾`;
    if (action.kind === 'history-consolidation') return `较早历史 ${action.affectedItems} 条整理为${action.method === 'raw-archive' ? '本地归档摘要' : '模型摘要'}`;
    return `最旧历史 ${action.affectedGroups ?? action.affectedItems} 组原子裁剪`;
  }).join('、');
}

function translateAssistantModelCallKind(callKind: AssistantPublicModelEvent['callKind']): string {
  return callKind === 'decide' ? '动作决策' : '最终汇总';
}

function getAssistantToolTeaser(entry: AssistantToolTraceEntry): string {
  const source = entry.contentPreviews?.[0]?.text || entry.outputSummary || entry.outcome || entry.rationale || t("等待工具返回…");
  const compact = source.replace(/\s+/gu, ' ').trim();
  return compact.length > 96 ? `${compact.slice(0, 95)}…` : compact;
}

function getLastSearchQueryTerms(entries: AssistantToolTraceEntry[]): string[] | undefined {
  const entry = [...entries].reverse().find((candidate) => candidate.tool === 'search_note' && candidate.state !== 'rejected');
  const summary = entry?.inputSummary?.match(/^关键词：(.+?)(?:；|$)/u)?.[1];
  if (!summary || summary === '无') return undefined;
  const terms = summary.split('、').map((term) => term.trim()).filter(Boolean);
  return terms.length ? terms : undefined;
}

function translateStoredTurnStatus(status: NonNullable<AssistantSessionDetail>['turns']['items'][number]['status']): string {
  if (status === 'complete') return t("已完成");
  if (status === 'partial') return t("部分完成");
  if (status === 'not-found') return '未找到';
  if (status === 'cancelled') return t("已取消");
  if (status === 'interrupted') return '已中断';
  return status === 'pending' ? t("执行中") : t("失败");
}

function DebugEmptyHint({ children }: { children: React.ReactNode }) {
  useI18n();
  return <p className="assistant-debug-empty">{children}</p>;
}

/** 全过程痕迹视图：读取主进程落盘的 detailed trace JSONL，按序展示每步输入/输出。 */
function translateTraceStatus(status: string): string {
  if (status === 'started') return '进行中';
  if (status === 'completed') return t("已完成");
  if (status === 'rejected') return '已拒绝';
  return status;
}

function getTraceFileName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? filePath;
}

function DetailedTraceSection({ requestId, isRunning }: { requestId: string | null; isRunning?: boolean }) {
  useI18n();
  const [trace, setTrace] = useState<{ entries: AssistantDetailedTraceRecordView[]; filePath: string | null } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!requestId || !window.electronAPI?.getAssistantDetailedTrace) { setTrace(null); return; }
    let cancelled = false;
    void window.electronAPI.getAssistantDetailedTrace(requestId)
      .then((result) => { if (!cancelled) setTrace(result); })
      .catch(() => { if (!cancelled) setTrace({ entries: [], filePath: null }); });
    return () => { cancelled = true; };
  }, [requestId, refreshTick]);
  useEffect(() => {
    if (!isRunning || !requestId) return;
    const timer = setInterval(() => setRefreshTick((value) => value + 1), 2_500);
    return () => clearInterval(timer);
  }, [isRunning, requestId]);
  const entries = trace?.entries ?? [];
  return <section className="assistant-debug-section assistant-debug-trace-section">
    <div className="assistant-debug-section-heading assistant-debug-trace-heading">
      <strong>{t("全过程痕迹")}</strong>
      <button type="button" className="assistant-debug-trace-refresh" onClick={() => setRefreshTick((value) => value + 1)} title={t("重新读取本轮痕迹文件")} aria-label={t("重新读取本轮痕迹文件")}>{t("刷新")}</button>
      <span>{entries.length || '--'}</span>
    </div>
    {entries.length ? <div className="assistant-debug-trace-list" aria-label={t("本轮全过程输入输出")}>
      {entries.map((entry) => <details className="assistant-debug-memory assistant-debug-trace-entry" key={entry.sequence} data-status={entry.status}>
        <summary>
          <span title={`#${entry.sequence} · ${entry.stage}/${entry.action}`}>#{entry.sequence} · {entry.stage}/{entry.action}</span>
          <small>{translateTraceStatus(entry.status)}{entry.elapsedMs !== undefined ? ` · ${formatExecutionDuration(entry.elapsedMs)}` : ''}</small>
        </summary>
        {entry.input !== undefined ? <><b>{t("输入")}</b><pre>{JSON.stringify(entry.input, null, 2)}</pre></> : null}
        {entry.output !== undefined ? <><b>{t("输出")}</b><pre>{JSON.stringify(entry.output, null, 2)}</pre></> : null}
        {entry.error !== undefined ? <><b>{t("错误")}</b><pre>{JSON.stringify(entry.error, null, 2)}</pre></> : null}
      </details>)}
    </div> : <DebugEmptyHint>{requestId ? t("本轮暂无痕迹条目；执行中会自动刷新，也可点击“刷新”重读。") : t("选择上方执行轮次后，这里展示该轮每个阶段的输入与输出。")}</DebugEmptyHint>}
    {trace?.filePath ? <p className="assistant-debug-trace-path" title={trace.filePath}><span>{t("轨迹文件")}</span><code>{getTraceFileName(trace.filePath)}</code></p> : null}
  </section>;
}

interface KnowledgeBaseEvidenceEntry {
  reference: number;
  title: string;
  parentOrdinal?: number;
  score?: number;
  snippet?: string;
  methods?: Array<'keyword' | 'semantic'>;
  content: string;
  inPrompt: boolean;
}

function getKnowledgeBaseEvidenceEntries(result: Extract<AssistantTurnResult, { type: 'answer' }> | undefined): KnowledgeBaseEvidenceEntry[] {
  if (!result) return [];
  const citations = result.knowledgeBaseCitations ?? [];
  const sourceNotes = result.sourceNotes ?? [];
  const sourceNotesByReference = new Map(sourceNotes.map((note, index) => [note.reference ?? index + 1, note]));
  const entries: KnowledgeBaseEvidenceEntry[] = citations.map((citation) => {
    const note = sourceNotesByReference.get(citation.reference);
    return {
      reference: citation.reference,
      title: citation.documentName,
      parentOrdinal: citation.parentOrdinal,
      ...(note ? { score: note.score, snippet: note.snippet, ...(note.methods.length ? { methods: note.methods } : {}) } : {}),
      content: citation.content,
      inPrompt: true,
    };
  });
  const citedReferences = new Set(entries.map((entry) => entry.reference));
  sourceNotes.forEach((note, index) => {
    const reference = note.reference ?? index + 1;
    if (citedReferences.has(reference)) return;
    entries.push({ reference, title: note.title, ...(note.parentOrdinal !== undefined ? { parentOrdinal: note.parentOrdinal } : {}), score: note.score, snippet: note.snippet, ...(note.methods.length ? { methods: note.methods } : {}), content: '', inPrompt: false });
  });
  return entries;
}

function getKnowledgeBaseTurnTokens(result: AssistantTurnResult | undefined) {
  const usage = result?.type === 'answer' ? result.contextUsage : undefined;
  if (!usage) return { hasUsage: false } as const;
  const outputTokens = usage.outputTokens
    ?? (usage.totalTokens !== undefined ? Math.max(0, usage.totalTokens - usage.inputTokens) : undefined);
  const totalTokens = usage.totalTokens ?? usage.inputTokens + (outputTokens ?? 0);
  return { hasUsage: true, usage, outputTokens, totalTokens } as const;
}

interface KnowledgeBaseMemoryWindowEntry {
  role: 'user' | 'assistant';
  content: string;
  characters: number;
}

/** 渲染侧留存的对话记录（展示用）；实际传入模型的记忆窗口由主进程按 M1/M2 分区装配。 */
function getKnowledgeBaseMemoryWindow(previousMessages: AssistantMessage[]): KnowledgeBaseMemoryWindowEntry[] {
  const completed = previousMessages.flatMap((message) => message.state !== 'complete' || !message.content.trim()
    ? []
    : [{ role: message.role, content: message.content }]);
  const selected = completed.slice(-6);
  const entries: KnowledgeBaseMemoryWindowEntry[] = [];
  let totalCharacters = 0;
  for (const entry of [...selected].reverse()) {
    const remaining = 4_000 - totalCharacters;
    if (remaining <= 0) break;
    const content = entry.content.slice(Math.max(0, entry.content.length - remaining));
    totalCharacters += content.length;
    entries.push({ role: entry.role, content, characters: content.length });
  }
  return entries.reverse();
}

function formatKnowledgeBaseScore(score: number | undefined): string {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(3) : '--';
}

function KnowledgeBaseDebugRail({
  messages,
  selectedMessage,
  onSelectMessage,
  contextWindowTokens,
  onStartNewTopic,
}: {
  messages: AssistantMessage[];
  selectedMessage: AssistantMessage | null;
  onSelectMessage: (messageId: string) => void;
  contextWindowTokens?: number;
  onStartNewTopic: () => void;
}) {
  useI18n();
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const result = selectedMessage?.result?.type === 'answer' ? selectedMessage.result : undefined;
  const contextDiagnostics = result?.contextDiagnostics ?? selectedMessage?.contextDiagnostics;
  const modelEvents = result?.modelEvents ?? selectedMessage?.modelEvents ?? [];
  const compressionNotice = buildAssistantContextCompressionNotice(contextDiagnostics, modelEvents);
  const toolEntries = groupAssistantToolEvents(result?.toolEvents ?? selectedMessage?.toolEvents ?? []);
  const recallEntries = toolEntries.filter((entry) => entry.tool === 'search_knowledge_base' || entry.tool === 'rerank_knowledge_evidence' || entry.tool === 'knowledge_agent_search' || entry.tool === 'knowledge_agent_grep');
  const evidenceEntries = getKnowledgeBaseEvidenceEntries(result);
  const tokens = getKnowledgeBaseTurnTokens(result);
  const usage = tokens.hasUsage ? tokens.usage : undefined;
  const usagePercent = contextWindowTokens && contextWindowTokens > 0 && tokens.hasUsage
    ? tokens.totalTokens / contextWindowTokens * 100
    : undefined;
  const selectedMessageIndex = selectedMessage ? messages.findIndex((message) => message.id === selectedMessage.id) : -1;
  const memoryWindow = selectedMessageIndex > 0 ? getKnowledgeBaseMemoryWindow(messages.slice(0, selectedMessageIndex)) : [];
  const memoryWindowCharacters = memoryWindow.reduce((sum, entry) => sum + entry.characters, 0);
  const zoneTokens = result?.qaMemoryZones;
  const queryRewrite = result?.queryRewrite;
  const turnTokenRows = assistantMessages.map((message, index) => ({ index, id: message.id, tokens: getKnowledgeBaseTurnTokens(message.result) }));
  const sessionTotalTokens = turnTokenRows.reduce((sum, row) => sum + (row.tokens.hasUsage ? row.tokens.totalTokens : 0), 0);
  const isRunning = selectedMessage?.state === 'pending' || selectedMessage?.state === 'streaming';

  return <aside className="assistant-debug-rail" aria-label={t("知识库调试轨道")}>
    <header className="assistant-debug-heading">
      <span><SquareTerminal size={14} aria-hidden="true" />{t("调试轨道 · 知识库")}</span>
      <small>{t("召回 / 记忆 / Token 审计")}</small>
    </header>
    {compressionNotice ? <AssistantContextCompressionNotice notice={compressionNotice} inDebugRail /> : null}
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("执行轮次")}</strong><span>{assistantMessages.length}</span></div>
      {assistantMessages.length ? <div className="assistant-debug-turn-list" role="list" aria-label={t("选择执行轮次")}>
        {assistantMessages.map((message, index) => <button key={message.id} type="button" role="listitem" data-active={message.id === selectedMessage?.id || undefined} onClick={() => onSelectMessage(message.id)}>
          <span>#{index + 1}</span><small>{message.state === 'complete' ? t("已完成") : message.state === 'error' ? t("失败") : message.state === 'cancelled' ? t("已取消") : t("执行中")}</small>
        </button>)}
      </div> : <DebugEmptyHint>{t("发起一次知识库问答后，这里会按轮次保留召回证据、对话记忆与 Token 用量。")}</DebugEmptyHint>}
    </section>
    <ContextProjectionDiagnosticsPanel diagnostics={contextDiagnostics} onStartNewTopic={onStartNewTopic} />
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("召回证据")}</strong><span>{evidenceEntries.length}</span></div>
      {recallEntries.length ? <div className="assistant-debug-kb-recall-list">{recallEntries.map((entry, index) => <div className="assistant-debug-kb-recall" key={`${entry.tool}-${index}`}>
        <span>{translateCurrentNoteTool(entry.tool)} · {translateToolEventState(entry.state)}{entry.elapsedMs === undefined ? '' : ` · ${formatExecutionDuration(entry.elapsedMs)}`}</span>
        <p>{entry.outputSummary ?? entry.outcome ?? entry.rationale ?? t("正在执行检索阶段…")}</p>
      </div>)}</div> : null}
      {result?.retrievalWarning ? <div className="assistant-retrieval-warning">{result.retrievalWarning}</div> : null}
      {evidenceEntries.length ? <div className="assistant-debug-evidence-list" aria-label={t("本轮回溯的父块证据")}>
        {evidenceEntries.map((entry) => <details className="assistant-debug-evidence" key={entry.reference} data-in-prompt={entry.inPrompt || undefined}>
          <summary>
            <ChevronRight className="assistant-debug-disclosure-icon" size={12} aria-hidden="true" />
            <span className="assistant-debug-evidence-title">[{entry.reference}] {entry.title}</span>
            <small>{entry.parentOrdinal !== undefined ? t("父块 {0} · ", { '0': entry.parentOrdinal }) : ''}score {formatKnowledgeBaseScore(entry.score)}{entry.methods?.length ? ` · ${entry.methods.map((method) => method === 'semantic' ? t("语义") : t("关键词")).join('+')}` : ''}</small>
          </summary>
          {entry.snippet ? <p className="assistant-debug-evidence-snippet">{entry.snippet}</p> : null}
          {entry.inPrompt ? <pre>{entry.content}</pre> : <p className="assistant-debug-evidence-snippet">{t("该父块未进入提示词预算，模型本轮没有看到它。")}</p>}
        </details>)}
      </div> : <DebugEmptyHint>{isRunning ? t("正在执行向量召回与父块回溯，完成后这里会展示每块证据的分数与进入提示词的原文。") : t("本轮没有召回可用证据；完成一次向量召回后，这里会展示子块回溯出的父块原文与分数。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("工具调用与返回")}</strong><span>{toolEntries.length}</span></div>
      {toolEntries.length ? <div className="assistant-debug-tool-list">{toolEntries.map((entry) => <details className="assistant-debug-tool" data-state={entry.state} key={entry.id} open={entry.state === 'started'}>
        <summary>
          <ChevronRight className="assistant-debug-disclosure-icon" size={12} aria-hidden="true" />
          <span className="assistant-debug-tool-title">{translateCurrentNoteTool(entry.tool)}</span>
          <small>{translateToolEventState(entry.state)}{entry.elapsedMs === undefined ? '' : ` · ${formatExecutionDuration(entry.elapsedMs)}`}</small>
          <span className="assistant-debug-tool-teaser">{getAssistantToolTeaser(entry)}</span>
        </summary>
        <dl>
          <div><dt>{t("输入")}</dt><dd>{entry.inputSummary ?? entry.rationale ?? t("未提供可展示的输入摘要。")}</dd></div>
          <div><dt>{entry.state === 'rejected' ? t("结果") : t("输出")}</dt><dd>{entry.outputSummary ?? entry.outcome ?? (entry.state === 'started' ? t("等待工具返回…") : t("未提供可展示的输出摘要。"))}</dd></div>
        </dl>
        {entry.sectionNavigation ? <AssistantLibrarySectionNavigation observation={entry.sectionNavigation} /> : null}
        {entry.publicResults?.length ? <AssistantToolResultViews results={entry.publicResults} /> : null}
        {entry.contentPreviews?.length ? <div className="assistant-debug-content-list" aria-label={t("工具返回内容")}>
          {entry.contentPreviews.map((preview, previewIndex) => <article className="assistant-debug-content-preview" data-kind={preview.kind} key={`${preview.kind}-${preview.lineFrom}-${preview.lineTo}-${previewIndex}`}>
            <header><strong>{preview.kind === 'candidate' ? t("检索候选 {0}", { '0': previewIndex + 1 }) : t("已读原文")}</strong><span>{preview.headingPath.length ? preview.headingPath.join(' / ') : t("笔记开头")} · L{preview.lineFrom}–L{preview.lineTo}</span></header>
            <pre>{preview.text}</pre>
            {preview.truncated ? <small>{t("这里只显示前 2,400 个字符；Agent 已读取的范围以上方行号为准。")}</small> : null}
          </article>)}
        </div> : null}
      </details>)}</div> : <DebugEmptyHint>{t("本轮没有工具调用；联网搜索或知识库检索触发后，这里会展示每次工具的输入与返回结果。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("问题改写")}</strong><span>{queryRewrite ? (queryRewrite.skipped ? t("排除") : queryRewrite.failed ? t("失败回退") : queryRewrite.shouldSplit ? t("拆分 {0} 路", { '0': queryRewrite.subQuestions?.length ?? 0 }) : t("已改写")) : '--'}</span></div>
      {queryRewrite ? <div className="assistant-debug-context-ledger" aria-label={t("问题改写记录")}>
        {queryRewrite.skipped ? <div><span>{t("排除原因")}</span><p>{queryRewrite.reason ?? 'self-contained'}{t("：本轮未调用改写模型，检索使用原文。")}</p></div> : null}
        {queryRewrite.matchedSignals?.length ? <div><span>{t("放行信号")}</span><p>{queryRewrite.matchedSignals.join('、')}</p></div> : null}
        {queryRewrite.rewrite ? <div><span>{t("改写结果")}</span><p>{queryRewrite.rewrite}</p></div> : null}
        {queryRewrite.shouldSplit && queryRewrite.subQuestions?.length ? <div><span>{t("子问题")}</span><p>{queryRewrite.subQuestions.map((sub, index) => `${index + 1}. ${sub}`).join('　')}</p></div> : null}
        {queryRewrite.guardTriggered ? <div><span>{t("护栏")}</span><p>{queryRewrite.guardTriggered}{t("：改写超长，已回退原文。")}</p></div> : null}
        {queryRewrite.failed ? <div><span>{t("失败")}</span><p>{queryRewrite.failed.code}：{queryRewrite.failed.message}</p></div> : null}
        <div><span>{t("耗时 / 模型")}</span><p>{queryRewrite.elapsedMs.toLocaleString(getAppLanguage())} ms{queryRewrite.model ? ` · ${queryRewrite.model}` : ''}</p></div>
        {queryRewrite.rawOutput ? <details className="assistant-debug-memory"><summary>{t("模型原始输出")}</summary><pre>{queryRewrite.rawOutput}</pre></details> : null}
      </div> : <DebugEmptyHint>{t("完成一轮知识库问答后，这里会展示改写门判定、改写/拆分结果与模型原始输出。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("Token 消耗")}</strong><span>{turnTokenRows.filter((row) => row.tokens.hasUsage).length}</span></div>
      {tokens.hasUsage ? <div className="assistant-debug-context-stats">
        <span>{t("本轮输入")} <b>{usage?.inputTokens.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("本轮输出")} <b>{tokens.outputTokens === undefined ? '--' : tokens.outputTokens.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("合计")} <b>{formatTokenCountInK(tokens.totalTokens)}</b> · {usage?.source === 'provider' ? t("服务商上报") : t("本地估算")}</span>
        {usage?.cachedInputTokens !== undefined ? <span>{t("缓存命中")} <b>{usage.cachedInputTokens.toLocaleString(getAppLanguage())}</b></span> : null}
        <span>{t("窗口")} {contextWindowTokens ? `${formatTokenCountInK(contextWindowTokens)} · ${formatUsagePercent(usagePercent)}` : t("未配置")}</span>
        {result?.executionElapsedMs !== undefined ? <span>{t("耗时")} {formatExecutionDuration(result.executionElapsedMs)}</span> : null}
      </div> : <DebugEmptyHint>{t("本轮还没有 Token 用量；完成后会区分服务商上报与本地估算。")}</DebugEmptyHint>}
      {turnTokenRows.some((row) => row.tokens.hasUsage) ? <div className="assistant-debug-token-list" aria-label={t("每轮 Token 消耗")}>
        {turnTokenRows.map((row) => row.tokens.hasUsage ? <div key={row.id} className="assistant-debug-token-row" data-active={row.id === selectedMessage?.id || undefined}>
          <span>#{row.index + 1}</span>
          <small>{t("入")} {formatTokenCountInK(row.tokens.usage.inputTokens)} {t("· 出")} {row.tokens.outputTokens === undefined ? '--' : formatTokenCountInK(row.tokens.outputTokens)}</small>
          <b>{formatTokenCountInK(row.tokens.totalTokens)}</b>
        </div> : null)}
        <div className="assistant-debug-token-row assistant-debug-token-total"><span>{t("会话合计")}</span><small>{turnTokenRows.filter((row) => row.tokens.hasUsage).length} {t("轮有用量")}</small><b>{formatTokenCountInK(sessionTotalTokens)}</b></div>
      </div> : null}
    </section>
    <section className="assistant-debug-section">
      <div className="assistant-debug-section-heading"><strong>{t("记忆分区")}</strong><span>{zoneTokens ? 'S/M1/M2/D/Q' : '--'}</span></div>
      {zoneTokens ? <div className="assistant-debug-context-stats" aria-label={t("本轮上下文分区 Token")}>
        <span>{t("S 静态策略")} <b>{zoneTokens.staticPrefix.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("M1 滚动摘要")} <b>{zoneTokens.rollingSummary.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("M2 短期记忆")} <b>{zoneTokens.shortTerm.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("D 动态证据")} <b>{zoneTokens.dynamic.toLocaleString(getAppLanguage())}</b></span>
        <span>{t("Q+C 问题约束")} <b>{zoneTokens.questionConstraint.toLocaleString(getAppLanguage())}</b></span>
      </div> : <DebugEmptyHint>{t("完成一轮问答后，这里会展示主进程装配的各上下文分区实际 Token。")}</DebugEmptyHint>}
    </section>
    <section className="assistant-debug-section assistant-debug-context">
      <div className="assistant-debug-section-heading"><strong>{t("每轮记忆")}</strong><span>{memoryWindow.length}</span></div>
      <div className="assistant-debug-context-ledger" aria-label={t("知识库会话记忆策略")}>
        <div><span>{t("会话存储")}</span><p>{t("每轮完成后统一写入 ConversationMemory/qa-memory.db；开放式问答与知识库问答分属不同会话，历史轮次仍保留完整召回与用量轨迹。")}</p></div>
        <div><span>{t("记忆策略")}</span><p>{t("主进程装配：M2 保留最近 ≤6 轮原文（每轮封顶 1,500 token），更早轮次每 3 轮后台压缩为 M1 摘要（单批 ≤800）。")}</p></div>
      </div>
      {selectedMessage ? (memoryWindow.length ? <details className="assistant-debug-memory">
        <summary>{t("会话对话记录（展示用） ·")} {memoryWindow.length} {t("条 ·")} {memoryWindowCharacters.toLocaleString(getAppLanguage())} {t("字")}</summary>
        <div className="assistant-debug-stored-turn-list">
          {memoryWindow.map((entry, index) => <article key={`${entry.role}-${index}`}>
            <header><strong>{entry.role === 'user' ? t("你") : 'AI'}</strong><span>{entry.characters.toLocaleString(getAppLanguage())} {t("字")}</span></header>
            <p>{entry.content}</p>
          </article>)}
        </div>
      </details> : <DebugEmptyHint>{t("本轮是会话的第一轮，暂无历史对话记录。")}</DebugEmptyHint>) : <DebugEmptyHint>{t("选择一轮后，这里展示该轮之前的会话对话记录。")}</DebugEmptyHint>}
    </section>
    <DetailedTraceSection requestId={selectedMessage?.id ?? null} isRunning={isRunning} />
  </aside>;
}

function AssistantCitationList({ citations, currentPath, onNavigateCitation }: { citations: AssistantEvidenceCitation[]; currentPath: string | null; onNavigateCitation?: (citation: AssistantEvidenceCitation) => Promise<AssistantCitationValidation> }) {
  useI18n();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  if (!citations.length) return null;

  const navigate = async (citation: AssistantEvidenceCitation) => {
    if (!onNavigateCitation) return;
    const effectiveCitation = citation.notePath || !currentPath ? citation : { ...citation, notePath: currentPath };
    if (!effectiveCitation.notePath) {
      setFeedback('当前未打开引用所属笔记，无法定位。');
      return;
    }
    setPendingId(citation.evidenceId);
    setFeedback(null);
    try {
      const validation = await onNavigateCitation(effectiveCitation);
      if (validation.status === 'stale') setFeedback(validation.message);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '引用定位失败，请稍后重试。');
    } finally {
      setPendingId(null);
    }
  };

  return <section className="assistant-citations" aria-label={t("回答引用")}>
    <strong>{t("引用")} {citations.length} {t("条")}</strong>
    <div className="assistant-citation-list">{citations.map((citation, index) =>
      <button key={citation.evidenceId} type="button" className="assistant-citation-link" disabled={!onNavigateCitation || pendingId === citation.evidenceId} onClick={() => void navigate(citation)} title={t("校验当前笔记后定位并短暂高亮引用原文")}>
        <Link2 size={11} aria-hidden="true" />
        <span>{index + 1}. {citation.headingPath.length ? citation.headingPath.join(' / ') : t("正文")} · L{citation.lineFrom}-L{citation.lineTo}</span>
      </button>
    )}</div>
    {feedback ? <div className="assistant-citation-feedback" role="status">{feedback}</div> : null}
  </section>;
}

interface AssistantContextWindowUsageSummary {
  totalTokens: number;
  contextWindowSource?: 'application-fixed' | 'provider' | 'ollama' | 'configured' | 'known-model' | 'conservative-default';
  contextWindowWarning?: string;
  promptStats?: {
    callKind: string;
    projectionLevel: 0 | 1 | 3 | 4;
    planId?: string;
    planVersion?: number;
    predictedPromptTokens: number;
    maxPromptTokens?: number;
    protectedTokens: number;
    evidenceHotTokens: number;
    evidenceWarmTokens: number;
    evidenceColdTokens: number;
    partitions: Array<{ zone: string; tokens: number; protectedTokens: number }>;
  };
}

function AssistantContextWindowUsage({
  usage,
  contextWindowTokens,
}: {
  usage: AssistantContextWindowUsageSummary;
  contextWindowTokens?: number;
}) {
  useI18n();
  const usagePercent = contextWindowTokens && contextWindowTokens > 0
    ? usage.totalTokens / contextWindowTokens * 100
    : undefined;
  const ringPercent = Math.max(0, Math.min(100, usagePercent ?? 0));
  const tone = usagePercent === undefined ? 'unknown' : usagePercent >= 85 ? 'danger' : usagePercent >= 65 ? 'warning' : 'safe';
  const totalLabel = formatTokenCountInK(usage.totalTokens);
  const maximumLabel = contextWindowTokens ? formatTokenCountInK(contextWindowTokens) : '--';
  const percentLabel = formatUsagePercent(usagePercent);
  const accessibleSummary = contextWindowTokens
    ? `当前上下文使用 ${totalLabel}，最大窗口 ${maximumLabel}，占 ${percentLabel}`
    : `当前上下文使用 ${totalLabel}，最大窗口未配置`;

  return <div className={`assistant-context-usage ${tone}`}>
    <HoverCard openDelay={120} closeDelay={160} withinPortal position="top" offset={10} shadow="md" zIndex={3000}>
      <HoverCard.Target>
        <button type="button" className="assistant-context-usage-trigger" aria-haspopup="dialog" aria-label={accessibleSummary} title={t("悬浮查看上下文窗口用量")}>
          <span className="assistant-token-usage-ring" aria-hidden="true">
            <svg viewBox="0 0 18 18" focusable="false">
              <circle className="assistant-token-usage-ring-track" cx="9" cy="9" r="7" />
              <circle className="assistant-token-usage-ring-value" cx="9" cy="9" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - ringPercent} />
            </svg>
          </span>
        </button>
      </HoverCard.Target>
      <HoverCard.Dropdown className="assistant-context-usage-dropdown">
          <div className="assistant-context-usage-popover">
            <strong className="assistant-context-usage-summary">{t("合计")} {totalLabel} {t("/ 最大")} {maximumLabel}</strong>
            <span className="assistant-context-usage-percent">{percentLabel}</span>
          </div>
      </HoverCard.Dropdown>
    </HoverCard>
  </div>;
}

function formatTokenCountInK(value: number): string {
  const kiloTokens = Math.round(Math.max(0, value) / 1024 * 10) / 10;
  return `${kiloTokens.toLocaleString(getAppLanguage(), { maximumFractionDigits: 1 })}k`;
}

function formatUsagePercent(value: number | undefined): string {
  if (value === undefined) return '--%';
  if (value > 0 && value < 1) return `${value.toFixed(1).replace(/\.0$/u, '')}%`;
  return `${Math.round(value)}%`;
}

function getCurrentContextUsage(messages: AssistantMessage[]): AssistantContextWindowUsageSummary {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const usage = message.result?.type === 'answer' ? message.result.contextUsage : undefined;
    if (!usage) continue;
    const turnOutputTokens = usage.outputTokens
      ?? (usage.totalTokens !== undefined ? Math.max(0, usage.totalTokens - usage.inputTokens) : 0);
    return {
      totalTokens: usage.totalTokens ?? usage.inputTokens + turnOutputTokens,
      ...(usage.contextWindowSource ? { contextWindowSource: usage.contextWindowSource } : {}),
      ...(usage.contextWindowWarning ? { contextWindowWarning: usage.contextWindowWarning } : {}),
      ...(usage.promptStats ? { promptStats: usage.promptStats } : {}),
    };
  }
  return { totalTokens: 0 };
}

// 用量弹层的窗口来源文案投影暂时隐藏，保留映射供后续恢复展示。
function _formatContextWindowSource(source: NonNullable<AssistantContextWindowUsageSummary['contextWindowSource']>): string {
  return {
    'application-fixed': '应用统一 128K',
    provider: '服务商声明',
    ollama: 'Ollama 模型元数据',
    configured: '用户配置上限',
    'known-model': '已知模型表',
    'conservative-default': '保守默认值',
  }[source];
}

function formatExecutionDuration(value: number): string {
  const elapsedMs = Math.max(0, Math.round(value));
  if (elapsedMs < 1_000) return `${elapsedMs} ms`;
  const totalSeconds = Math.round(elapsedMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function translateCurrentNoteTool(tool: CurrentNotePublicToolEvent['tool']): string {
  return ({
    read_current_note: '读取当前笔记',
    search_note_library: '检索笔记库',
    search_knowledge_base: '检索个人知识库',
    rerank_knowledge_evidence: '重排知识库证据',
    read_attachments: '读取附件',
    search_attachment: '搜索附件',
    read_attachment_range: '读取附件范围',
    get_note_map: '查看笔记地图',
    search_note: '搜索当前笔记',
    read_note_range: '读取原文范围',
    read_note_section: '读取笔记章节',
    expand_evidence: '扩展证据上下文',
    get_library_note_map: '查看候选笔记地图',
    search_library_note_blocks: '搜索候选笔记',
    read_library_note_range: '读取库内原文范围',
    read_library_note_section: '读取库内原文章节',
    expand_library_evidence: '扩展库内证据',
    read_library_adjacent_section: '读取相邻同级章节',
    rewrite_question: '改写问题',
    knowledge_agent_search: '知识库语义检索',
    knowledge_agent_grep: '知识库字面量检索',
    knowledge_agent_deep_read: '深读知识库原文',
    knowledge_agent_doc_info: '查看知识库文档信息',
    knowledge_agent_skill: '加载 AI 技能',
    knowledge_agent_graph_search: '知识库图谱检索',
    knowledge_agent_graph_global_search: '知识库全局图谱综合',
    knowledge_agent_web_search: t("联网搜索"),
    knowledge_agent_web_fetch: '读取网页全文',
    assistant_web_search: t("联网搜索"),
    assistant_web_fetch: '读取网页全文',
    assistant_tool_error: '工具调用失败',
    search_conversations: '搜索历史对话',
  } as const)[tool];
}

function translateToolEventState(state: CurrentNotePublicToolEvent['state']): string {
  return ({ started: t("运行中"), completed: t("已完成"), rejected: '未完成' } as const)[state];
}

function getConversationHistory(messages: AssistantMessage[]): AssistantTurnRequest['conversation'] {
  const completed = messages.flatMap((message) => {
    if (message.state !== 'complete' || !message.content.trim()) return [];
    return [{ role: message.role, content: message.content } as const];
  });
  const selected = completed.slice(-6);
  const result: AssistantTurnRequest['conversation'] = [];
  let total = 0;
  for (const message of [...selected].reverse()) {
    // 与主进程 IPC 契约一致：单条历史 ≤2000 字符、总量 ≤4000 字符，超长保留尾部。
    const budget = Math.min(4_000 - total, 2_000);
    if (budget <= 0) break;
    const content = message.content.slice(Math.max(0, message.content.length - budget)).trim();
    if (!content) continue;
    total += content.length;
    result.push({ ...message, content });
  }
  return result.reverse();
}

function getDraftScopeLabel(intent: AssistantIntent, scope: AssistantScope, noteMeta: NoteMeta | null): string {
  if (scope === 'chat') return '本次使用：无资料库，直接询问 AI';
  if (scope === 'current-note') return `本次使用：当前笔记《${noteMeta?.title ?? '未命名笔记'}》（已保存版本）`;
  if (scope === 'library-structure') return '本次使用：笔记库标题、标签与目录标题（不读取正文）';
  return intent === 'learning-plan' ? '本次使用：知识库检索到的相关学习资料' : '本次使用：知识库检索到的相关笔记片段';
}

function createAssistantRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `assistant_${random}`.slice(0, 128);
}

function translateIntent(intent: AssistantIntent, scope: AssistantScope, interactionRoute?: 'chat' | 'clarify' | 'react'): string {
  if (intent === 'learning-plan') return '学习路径';
  if (intent === 'organize') return t("整理建议");
  if (scope === 'chat') return '普通聊天';
  if (interactionRoute === 'chat') return '普通聊天';
  if (interactionRoute === 'clarify') return '需求澄清';
  return scope === 'current-note' ? t("当前笔记问答") : t("知识库问答");
}

function InfoTab(props: KnowledgePanelProps) {
  useI18n();
  const notePath = props.noteMeta?.path;
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [isAddingTag, setIsAddingTag] = useState(false);
  useEffect(() => {
    setOverviewExpanded(false);
    setTagEditorOpen(false);
    setTagDraft('');
    setTagError(null);
  }, [notePath]);

  if (!props.noteMeta) {
    return <div className="knowledge-tab-content"><h3 className="knowledge-note-title">{t("知识库概览")}</h3><EmptyHint>{t("选择一篇笔记后，这里会显示概览、标签和智能建议。")}</EmptyHint><LibraryTags tags={props.allTags} onSelectTag={props.onSelectTag} /></div>;
  }

  const note = props.noteMeta;
  const submitTag = async (event: React.FormEvent) => {
    event.preventDefault();
    const tag = normalizeTagInput(tagDraft);
    if (!tag) {
      setTagError(t("请输入标签名称。"));
      return;
    }
    if (note.tags.some((entry) => entry.toLocaleLowerCase('zh-Hans-CN') === tag.toLocaleLowerCase('zh-Hans-CN'))) {
      setTagError(t("当前笔记已经有这个标签。"));
      return;
    }
    setIsAddingTag(true);
    setTagError(null);
    try {
      await props.onAddNoteTag(tag);
      setTagDraft('');
      setTagEditorOpen(false);
    } catch (error) {
      setTagError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAddingTag(false);
    }
  };

  return <div className="knowledge-tab-content note-info-content">
    <header className="note-info-header">
      <Text component="h3" className="knowledge-note-title" lineClamp={2}>{note.title}</Text>
      <Text className="knowledge-note-path" lineClamp={2}>{getRelativePath(note.path, props.libraryPath)}</Text>
      <Text className="note-info-meta" size="xs" c="dimmed">
        <span>{note.kind === 'markdown' ? 'Markdown' : note.extension.replace(/^\./, '').toUpperCase()}</span>
        <span>{formatCharacterCount(note.contentMarkdown)} {t("字")}</span>
        <span>{formatRelativeModifiedTime(note.mtimeMs)}</span>
      </Text>
      <Group className="note-info-tags" gap={5} align="center">
        {note.tags.map((tag) => <Button key={tag} className="note-tag-button" variant="light" color="brand" size="compact-xs" onClick={() => props.onSelectTag(tag)}>#{tag}</Button>)}
        <Button className="note-add-tag-toggle" variant="subtle" color="gray" size="compact-xs" leftSection={<Plus size={12} />} onClick={() => { setTagEditorOpen((value) => !value); setTagError(null); }}>{t("标签")}</Button>
      </Group>
      <Collapse in={tagEditorOpen}>
        <form className="note-tag-editor" onSubmit={(event) => void submitTag(event)}>
          <TextInput value={tagDraft} onChange={(event) => setTagDraft(event.currentTarget.value)} placeholder={t("输入标签名称")} aria-label={t("输入标签名称")} error={tagError} size="xs" leftSection={<Hash size={13} />} />
          <Group gap={6} justify="flex-end">
            <Button variant="subtle" color="gray" size="compact-xs" onClick={() => { setTagEditorOpen(false); setTagError(null); }}>{t("取消")}</Button>
            <Button type="submit" variant="light" color="brand" size="compact-xs" loading={isAddingTag}>{t("添加")}</Button>
          </Group>
        </form>
      </Collapse>
    </header>

    <PanelSection
      title={t("概览")}
      icon={<FileText size={14} />}
      action={<Button variant="subtle" color="gray" size="compact-xs" loading={props.isAnalyzingNote} disabled={!props.aiStatus?.available} onClick={() => void props.onGenerateNoteAnalysis().catch(() => undefined)}>{props.noteAnalysis ? t("更新") : t("生成")}</Button>}
    >
      {props.noteAnalysis ? <>
        <CollapsibleAiContent resetKey={props.noteAnalysis.generatedAt}><Text className="note-overview-summary note-analysis-summary-text" size="sm">{props.noteAnalysis.summary}</Text></CollapsibleAiContent>
        {props.noteAnalysis.keyPoints.length ? <>
          <UnstyledButton className="note-overview-toggle" onClick={() => setOverviewExpanded((value) => !value)} aria-expanded={overviewExpanded}>
            <span>{props.noteAnalysis.keyPoints.length} {t("个关键要点")}</span>
            <span>{overviewExpanded ? t("收起") : t("展开")}{overviewExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
          </UnstyledButton>
          <Collapse in={overviewExpanded}><ul className="note-key-points">{props.noteAnalysis.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></Collapse>
        </> : null}
        {props.noteAnalysis.isStale ? <Text className="note-stale-hint" size="xs">{t("笔记内容已更新，请重新分析后再应用建议。")}</Text> : null}
      </> : <EmptyHint>{props.aiStatus?.available ? t("生成一次概览后，这里会显示摘要和关键要点。") : (props.aiStatus?.message || t("配置可用模型后，可以生成摘要和智能建议。"))}</EmptyHint>}
      <NoteAnalysisBatches key={note.path} analysis={props.noteAnalysis} run={props.noteAnalysisRun} onCancel={props.onCancelNoteAnalysis} onResume={props.onResumeNoteAnalysis} />
    </PanelSection>

    <NoteInsightsSection {...props} />
  </div>;
}

function NoteInsightsSection(props: KnowledgePanelProps) {
  useI18n();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const selectionIdentityRef = useRef('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const analysis = props.noteAnalysis;
  const suggestionsLocked = Boolean(analysis?.isStale || (props.noteAnalysisRun && (props.noteAnalysisRun.state !== 'completed' || props.noteAnalysisRun.isStale)));
  const candidates = useMemo(() => {
    const existingTags = new Set((props.noteMeta?.tags ?? []).map((tag) => tag.toLocaleLowerCase('zh-Hans-CN')));
    return (analysis?.tagCandidates ?? []).filter((candidate) => !existingTags.has(candidate.name.toLocaleLowerCase('zh-Hans-CN')));
  }, [analysis?.tagCandidates, props.noteMeta?.tags]);

  useEffect(() => {
    // 同一完成结果的进度／索引刷新不重置选择，也不关闭正在确认的标签对话框。
    const identity = JSON.stringify({ path: analysis?.notePath, generatedAt: analysis?.generatedAt, suggestionsLocked, candidates: candidates.map(candidate => [candidate.name, candidate.confidence]) });
    if (selectionIdentityRef.current === identity) return;
    selectionIdentityRef.current = identity;
    setSelectedTags(suggestionsLocked ? [] : candidates.filter((candidate) => candidate.confidence === 'high').map((candidate) => candidate.name));
    setConfirmationOpen(false);
    setApplyError(null);
  }, [analysis?.notePath, analysis?.generatedAt, suggestionsLocked, candidates]);

  const toggleTag = (tag: string) => setSelectedTags((current) => current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag]);
  const applySelectedTags = async () => {
    setIsApplying(true);
    setApplyError(null);
    try {
      await props.onApplySuggestedTags(selectedTags);
      setConfirmationOpen(false);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsApplying(false);
    }
  };
  const suggestionCount = candidates.length;

  return <PanelSection
    title={<span className="note-section-title">{t("智能建议")} <Badge size="xs" variant="light" color="gray">{suggestionCount}</Badge></span>}
    icon={<Sparkles size={14} />}
    action={analysis ? <Button variant="subtle" color="gray" size="compact-xs" loading={props.isAnalyzingNote} disabled={!props.aiStatus?.available} onClick={() => void props.onGenerateNoteAnalysis().catch(() => undefined)}>{analysis.isStale ? t("更新分析") : t("重新分析")}</Button> : undefined}
  >
    {!analysis ? <EmptyHint>{t("生成概览后，会在这里提供标签建议。")}</EmptyHint> : <>
      {suggestionsLocked ? <Text className="note-stale-hint" size="xs">{t("当前版本分析尚未完成或内容已更新，建议已锁定。")}</Text> : null}
      {candidates.length ? <div className="note-suggestion-list">
        {candidates.map((candidate) => <Checkbox key={candidate.name} className="note-tag-suggestion" checked={selectedTags.includes(candidate.name)} disabled={suggestionsLocked} onChange={() => toggleTag(candidate.name)} label={`#${candidate.name}`} description={`${translateConfidence(candidate.confidence)} · ${candidate.evidence}`} size="xs" />)}
        {!suggestionsLocked ? <Button className="knowledge-action" variant="light" color="brand" size="compact-xs" disabled={!selectedTags.length} onClick={() => { setApplyError(null); setConfirmationOpen(true); }}>{t("应用")} {selectedTags.length} {t("个标签")}</Button> : null}
      </div> : <EmptyHint>{t("没有需要新增的标签建议。")}</EmptyHint>}
      <Text className="note-analysis-meta" size="xs" c="dimmed">{analysis.model} · {formatDate(analysis.generatedAt)} {t("· 不会自动修改 Markdown")}</Text>
    </>}
    <Modal opened={confirmationOpen} onClose={() => setConfirmationOpen(false)} title={t("应用标签建议")} centered size="sm">
      <Text size="sm">{t("将以下标签写入当前 Markdown 的 Frontmatter：")}</Text>
      <Group className="note-confirm-tags" gap={6}>{selectedTags.map((tag) => <Badge key={tag} variant="light" color="brand">#{tag}</Badge>)}</Group>
      {applyError ? <Text className="note-related-error" size="xs" mt="sm" role="alert">{applyError}</Text> : null}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={() => setConfirmationOpen(false)}>{t("取消")}</Button>
        <Button color="brand" loading={isApplying} onClick={() => void applySelectedTags()}>{t("确认应用")}</Button>
      </Group>
    </Modal>
  </PanelSection>;
}

function PanelSection({ title, icon, action, children }: { title: React.ReactNode; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  useI18n();
  return <section className="knowledge-section"><Group className="knowledge-section-heading" gap={6} justify="space-between" wrap="nowrap"><Text component="h4">{icon}{title}</Text>{action}</Group><Paper className="knowledge-section-body" radius="md" withBorder>{children}</Paper></section>;
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  useI18n();
  return <Text className="knowledge-empty" size="xs" c="dimmed">{children}</Text>;
}

function AiArtifactMeta({ model, generatedAt, artifactKey, isStale = false, hideMeta = false, children }: { model: string; generatedAt: string; artifactKey: string; isStale?: boolean; hideMeta?: boolean; children: React.ReactNode }) {
  useI18n();
  return <Paper className="ai-artifact" radius="md" withBorder><CollapsibleAiContent resetKey={artifactKey}>{children}</CollapsibleAiContent>{isStale ? <div className="ai-artifact-stale">{t("笔记内容已更新，当前显示的是最近一次分析结果；请重新分析后再应用标签。")}</div> : null}{hideMeta ? null : <div className="ai-artifact-meta">{t("模型：")}{model} · {formatDate(generatedAt)}<br />{t("仅供参考，不会自动修改 Markdown。")}</div>}</Paper>;
}

function LibraryTags({ tags, onSelectTag, hideTitle = false }: { tags: TagSummary[]; onSelectTag: (tag: string) => void; hideTitle?: boolean }) {
  useI18n();
  return <section className="knowledge-section">{hideTitle ? null : <Group className="knowledge-section-heading" gap={6}><Text component="h4"><Tags size={14} />{t("知识库标签")}</Text></Group>}<Paper className="knowledge-section-body" radius="md" withBorder>{tags.length ? <div className="tag-pills">{tags.map((tag) => <Button key={tag.tag} variant="light" color="brand" size="xs" onClick={() => onSelectTag(tag.tag)}>#{tag.tag} {tag.count}</Button>)}</div> : <EmptyHint>{t("当前笔记库还没有标签。")}</EmptyHint>}</Paper></section>;
}

function getRelativePath(notePath: string, libraryPath: string | null): string {
  if (!libraryPath) return notePath;
  const normalizedLibrary = libraryPath.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedNote = notePath.replace(/\\/g, '/');
  return normalizedNote.toLowerCase().startsWith(`${normalizedLibrary.toLowerCase()}/`) ? normalizedNote.slice(normalizedLibrary.length + 1) : notePath;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getAppLanguage());
}

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 80);
}

function formatCharacterCount(markdown: string): string {
  return markdown.replace(/\s/g, '').length.toLocaleString(getAppLanguage());
}

function formatRelativeModifiedTime(mtimeMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - mtimeMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前更新`;
  return `${new Date(mtimeMs).toLocaleDateString(getAppLanguage())} 更新`;
}

function translateConfidence(value: NoteAnalysis['tagCandidates'][number]['confidence']): string {
  return value === 'high' ? '高置信' : value === 'low' ? '低置信' : '需确认';
}
