import { getAppLanguage, t, useI18n } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  Bot,
  ChevronDown,
  Database,
  History,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AssistantAiOptions,
  AssistantTurnRequest,
  MaterialsLibrarySummary,
  QaSessionScope,
  QaSessionSummary,
  QaStoredTurn,
} from '../electron';
import { KnowledgeAssistant, type AssistantContextSourceOption } from './KnowledgePanel';
import type { OnboardingController } from './onboarding/useOnboarding';
import { ONBOARDING_QUESTION } from '../../shared/onboarding';
import { relocateWorkspacePath, type WorkspaceDataChange } from '../utils/workspaceDataEvents';
import { Alert, Title } from '@mantine/core';

interface AssistantWorkspaceViewProps {
  onboarding?: OnboardingController;
  assistantAiOptions: AssistantAiOptions;
  assistantContextRevision: number;
  onRefreshAssistantAiOptions: (profileId?: string) => Promise<AssistantAiOptions>;
  onStartAssistantTurn: (request: AssistantTurnRequest) => Promise<{ requestId: string }>;
  onCancelAssistantTurn: (requestId: string) => Promise<boolean>;
  onOpenSettings: () => void;
  /** 地图视图「就这个社区提问」等入口预填的问题草稿；消费后由调用方置空。 */
  pendingQuestionDraft?: { libraryPath: string; question: string } | null;
  onConsumeQuestionDraft?: () => void;
}

interface SessionContextMenuState {
  session: QaSessionSummary;
  x: number;
  y: number;
}

interface PendingModeSwitchState {
  libraryPath: string | null;
  draft?: string;
}

export default function AssistantWorkspaceView({
  onboarding,
  assistantAiOptions,
  assistantContextRevision,
  onRefreshAssistantAiOptions,
  onStartAssistantTurn,
  onCancelAssistantTurn,
  onOpenSettings,
  pendingQuestionDraft,
  onConsumeQuestionDraft,
}: AssistantWorkspaceViewProps) {
  useI18n();
  const [materialsLibraries, setMaterialsLibraries] = useState<MaterialsLibrarySummary[]>([]);
  const [selectedLibraryPath, setSelectedLibraryPath] = useState<string | null>(null);
  const [incomingDraft, setIncomingDraft] = useState<string | null>(null);
  const [conversationHasContent, setConversationHasContent] = useState(false);
  const [pendingModeSwitch, setPendingModeSwitch] = useState<PendingModeSwitchState | null>(null);
  const [isDebugRailOpen, setIsDebugRailOpen] = useState(false);
  const [historyOpened, setHistoryOpened] = useState(false);
  const [sessions, setSessions] = useState<QaSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [restoredTurns, setRestoredTurns] = useState<QaStoredTurn[]>([]);
  const [workspaceMemoryRevision, setWorkspaceMemoryRevision] = useState(0);
  const [preserveComposerRevision, setPreserveComposerRevision] = useState<number>();
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<QaSessionSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<QaSessionSummary | null>(null);
  const historyRequestRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const historyCloseButtonRef = useRef<HTMLButtonElement>(null);
  const debugRailTriggerRef = useRef<HTMLButtonElement>(null);
  const [practiceSessionId, setPracticeSessionId] = useState<string>();
  const [practiceProfileId, setPracticeProfileId] = useState<string>();
  const [authorizedReviewId, setAuthorizedReviewId] = useState<number>();
  const [practiceDraft, setPracticeDraft] = useState<{ id: number; text: string }>();
  const [practiceChoice, setPracticeChoice] = useState<'new' | 'resume' | null>(null);
  const [practiceError, setPracticeError] = useState<string>();
  const [preparingPractice, setPreparingPractice] = useState(false);
  const practicePreparationLock = useRef(false);
  const [composerState, setComposerState] = useState({ hasDraft: false, busy: false, failed: false });
  const reportComposerState = useCallback((next: typeof composerState) => {
    setComposerState(current => current.hasDraft === next.hasDraft && current.busy === next.busy && current.failed === next.failed ? current : next);
  }, []);
  // Skipping the setup lesson does not disable an already saved model.
  const preview = Boolean(onboarding && (!onboarding.state?.connection.profileId || onboarding.state.connection.state === 'missing'));
  const practiceReady = Boolean(practiceSessionId && practiceSessionId === activeSessionId
    && practiceProfileId === onboarding?.state?.connection.profileId && !preview && !selectedLibraryPath
    && (!onboarding?.review || authorizedReviewId === onboarding.reviewId));
  const canStartDirectPractice = Boolean(onboarding && !onboarding.review && !preview && !conversationHasContent && !selectedLibraryPath);

  const closeHistory = useCallback(() => {
    setHistoryOpened(false);
    window.requestAnimationFrame(() => historyTriggerRef.current?.focus());
  }, []);

  const setDebugDrawerOpen = useCallback((open: boolean) => {
    setIsDebugRailOpen(open);
    if (!open) window.requestAnimationFrame(() => debugRailTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!historyOpened) return;
    const focusFrame = window.requestAnimationFrame(() => historyCloseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [historyOpened]);

  useEffect(() => {
    if (!historyOpened) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isDebugRailOpen) {
        setDebugDrawerOpen(false);
        return;
      }
      if (!contextMenu && !renameTarget && !deleteTarget) closeHistory();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeHistory, contextMenu, deleteTarget, historyOpened, isDebugRailOpen, renameTarget, setDebugDrawerOpen]);

  useEffect(() => {
    if (!isDebugRailOpen || historyOpened) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDebugDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyOpened, isDebugRailOpen, setDebugDrawerOpen]);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI?.listMaterialsLibraries()
      .then((libraries) => {
        if (disposed) return;
        setMaterialsLibraries(libraries);
        setSelectedLibraryPath((current) => {
          if (current === null) return null;
          if (current && libraries.some((library) => library.path === current && library.exists && library.vectorState === '已索引')) return current;
          return libraries.find((library) => library.isActive && library.exists && library.vectorState === '已索引')?.path ?? null;
        });
      })
      .catch(() => {
        if (!disposed) setMaterialsLibraries([]);
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onPipelineStatus) return;
    let disposed = false;
    let timer: number | undefined;
    const unsubscribe = window.electronAPI.onPipelineStatus(() => {
      // 后台流水线完成 vectors 后刷新资料库摘要，让“待索引”知识库及时变为可选。
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void window.electronAPI?.listMaterialsLibraries().then((libraries) => {
          if (!disposed) setMaterialsLibraries(libraries);
        }).catch(() => undefined);
      }, 300);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const selectedLibrary = materialsLibraries.find((library) => library.path === selectedLibraryPath) ?? null;
  const contextSources = useMemo(
    () => selectedLibrary ? [{ kind: 'knowledge-base' as const, libraryPath: selectedLibrary.path, label: selectedLibrary.alias }] : [],
    [selectedLibrary],
  );
  const contextSourceOptions = useMemo<AssistantContextSourceOption[]>(() => materialsLibraries.map((library) => ({
    source: { kind: 'knowledge-base', libraryPath: library.path, label: library.alias },
    description: `${library.documentCount} 篇资料 · ${library.exists ? library.vectorState : '路径不可用'}`,
    disabled: !library.exists || library.vectorState !== '已索引',
  })), [materialsLibraries]);
  const isReady = Boolean(assistantAiOptions.profiles.length && (!selectedLibrary || selectedLibrary.vectorState === '已索引'));
  const readinessLabel = selectedLibrary
    ? t("{0} 篇资料已建立向量索引", { '0': selectedLibrary.documentCount })
    : t("开放式问答，不检索个人资料库");
  // 两种问答仍共用同一历史列表与数据库，但每个会话由 scope 固定为一种模式。
  const loadHistoryPage = useCallback(async (cursor = 0, append = false) => {
    if (!window.electronAPI || historyLoadingRef.current) return;
    const requestId = ++historyRequestRef.current;
    historyLoadingRef.current = true;
    setIsLoadingHistory(true);
    setHistoryError(null);
    try {
      const page = await window.electronAPI.listQaMemorySessions(cursor);
      if (requestId !== historyRequestRef.current) return;
      setSessions((current) => append ? mergeSessions(current, page.items) : page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (requestId === historyRequestRef.current) {
        setHistoryError(error instanceof Error ? error.message : t("无法读取历史记忆。"));
      }
    } finally {
      if (requestId === historyRequestRef.current) {
        historyLoadingRef.current = false;
        setIsLoadingHistory(false);
      }
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    await loadHistoryPage(0, false);
  }, [loadHistoryPage]);

  // Keep the composer and active session; refresh relocated source references without remounting the workspace.
  useEffect(() => {
    const changed = (event: Event) => {
      const { source, target, waitUntil } = (event as CustomEvent<WorkspaceDataChange>).detail;
      const refresh = (async () => {
        const libraries = await window.electronAPI.listMaterialsLibraries();
        setMaterialsLibraries(libraries); setSelectedLibraryPath(value => relocateWorkspacePath(value, source, target));
        await refreshHistory();
        setPreserveComposerRevision(workspaceMemoryRevision + 1);
        if (source && target && activeSessionId) {
          const detail = await window.electronAPI.getQaMemorySession(activeSessionId); setRestoredTurns(detail.turns); setWorkspaceMemoryRevision(revision => revision + 1);
        } else if (!source || !target) { setActiveSessionId(null); setRestoredTurns([]); setConversationHasContent(false); setWorkspaceMemoryRevision(revision => revision + 1); }
      })().catch(failure => { setHistoryError(String(failure)); throw failure; });
      waitUntil(refresh);
    };
    window.addEventListener('workspace-data-changed', changed);
    return () => window.removeEventListener('workspace-data-changed', changed);
  }, [activeSessionId, refreshHistory, workspaceMemoryRevision]);

  useEffect(() => {
    void loadHistoryPage(0, false);
  }, [loadHistoryPage]);

  const createSessionRecord = useCallback(async () => {
    if (!window.electronAPI) throw new Error(t("问答记忆不可用。"));
    const sessionScope: QaSessionScope = selectedLibrary ? 'knowledge-base' : 'chat';
    return window.electronAPI.createQaMemorySession(sessionScope, selectedLibrary?.path);
  }, [selectedLibrary]);

  const adoptCreatedSession = useCallback((session: QaSessionSummary, resetConversation: boolean) => {
    setActiveSessionId(session.sessionId);
    setRestoredTurns([]);
    setConversationHasContent(false);
    setSessions((current) => mergeSessions(current, [session]));
    if (resetConversation) setWorkspaceMemoryRevision((current) => current + 1);
  }, []);

  const startNewSession = useCallback(() => {
    setActiveSessionId(null);
    setRestoredTurns([]);
    setConversationHasContent(false);
    setWorkspaceMemoryRevision((current) => current + 1);
    setHistoryOpened(false);
    return Promise.resolve();
  }, []);

  const restoreSession = useCallback(async (session: QaSessionSummary) => {
    if (!window.electronAPI) return;
    const detail = await window.electronAPI.getQaMemorySession(session.sessionId);
    const restoredLibraryPath = detail.session.scope === 'knowledge-base'
      ? materialsLibraries.find((library) => library.path === detail.session.libraryPath && library.exists && library.vectorState === '已索引')?.path
        ?? materialsLibraries.find((library) => library.exists && library.vectorState === '已索引')?.path
        ?? null
      : null;
    setActiveSessionId(detail.session.sessionId);
    setRestoredTurns(detail.turns);
    setConversationHasContent(detail.turns.length > 0);
    setSelectedLibraryPath(restoredLibraryPath);
    setSessions((current) => mergeSessions(current, [detail.session]));
    setWorkspaceMemoryRevision((current) => current + 1);
    setHistoryOpened(false);
    if (detail.session.scope === 'knowledge-base' && !restoredLibraryPath) {
      setHistoryError(t("该会话使用的知识库当前不可用，请先完成索引。"));
    }
  }, [materialsLibraries]);

  const applyContextSourceChange = useCallback((libraryPath: string | null, draft?: string) => {
    setSelectedLibraryPath(libraryPath);
    if (draft) setIncomingDraft(draft);
    setHistoryOpened(false);
  }, []);

  const requestContextSourceChange = useCallback((libraryPath: string | null, draft?: string) => {
    if (libraryPath === selectedLibraryPath) {
      if (draft) setIncomingDraft(draft);
      setHistoryOpened(false);
      return;
    }
    const switchesMode = Boolean(libraryPath) !== Boolean(selectedLibraryPath);
    if (switchesMode && conversationHasContent) {
      setPendingModeSwitch({ libraryPath, ...(draft ? { draft } : {}) });
      return;
    }
    applyContextSourceChange(libraryPath, draft);
  }, [applyContextSourceChange, conversationHasContent, selectedLibraryPath]);

  const confirmModeSwitch = useCallback(() => {
    if (!pendingModeSwitch) return;
    applyContextSourceChange(pendingModeSwitch.libraryPath, pendingModeSwitch.draft);
    setActiveSessionId(null);
    setRestoredTurns([]);
    setConversationHasContent(false);
    setWorkspaceMemoryRevision((current) => current + 1);
    setPendingModeSwitch(null);
  }, [applyContextSourceChange, pendingModeSwitch]);

  // 预填问题（地图视图入口）也遵守模式边界，不把知识库问题混入已有开放式会话。
  useEffect(() => {
    if (!pendingQuestionDraft) return;
    requestContextSourceChange(pendingQuestionDraft.libraryPath, pendingQuestionDraft.question);
    onConsumeQuestionDraft?.();
  }, [onConsumeQuestionDraft, pendingQuestionDraft, requestContextSourceChange]);

  const togglePinned = useCallback(async (session: QaSessionSummary) => {
    if (!window.electronAPI) return;
    await window.electronAPI.setQaMemorySessionPinned(session.sessionId, !session.pinned);
    setContextMenu(null);
    await refreshHistory();
  }, [refreshHistory]);

  const saveRename = useCallback(async () => {
    if (!renameTarget || !window.electronAPI) return;
    const updated = await window.electronAPI.renameQaMemorySession(renameTarget.sessionId, renameTitle);
    setSessions((current) => current.map((session) => session.sessionId === updated.sessionId ? updated : session));
    setRenameTarget(null);
    setRenameTitle('');
  }, [renameTarget, renameTitle]);

  const deleteSession = useCallback(async () => {
    if (!deleteTarget || !window.electronAPI) return;
    await window.electronAPI.deleteQaMemorySession(deleteTarget.sessionId);
    const deletedActiveSession = deleteTarget.sessionId === activeSessionId;
    setDeleteTarget(null);
    if (deletedActiveSession) {
      setActiveSessionId(null);
      setRestoredTurns([]);
      setWorkspaceMemoryRevision((current) => current + 1);
    }
    await refreshHistory();
  }, [activeSessionId, deleteTarget, refreshHistory]);

  const loadMoreHistory = useCallback(() => {
    if (nextCursor === undefined || isLoadingHistory) return;
    void loadHistoryPage(nextCursor, true);
  }, [isLoadingHistory, loadHistoryPage, nextCursor]);

  const workspaceMemory = useMemo(() => ({
    sessionId: activeSessionId,
    turns: restoredTurns,
    revision: workspaceMemoryRevision,
    preserveComposer: preserveComposerRevision === workspaceMemoryRevision,
    onCreateSession: createSessionRecord,
    onSessionCreated: (session: QaSessionSummary) => adoptCreatedSession(session, false),
    onNewSession: startNewSession,
    onTurnSettled: () => { void refreshHistory(); },
  }), [activeSessionId, adoptCreatedSession, createSessionRecord, refreshHistory, restoredTurns, startNewSession, workspaceMemoryRevision, preserveComposerRevision]);

  // Send is also an explicit choice for an empty chat; keep the draft and avoid a workspace reset.
  const preparePractice = async (mode: 'new' | 'resume', forSend = false) => {
    if (!onboarding || composerState.busy || practicePreparationLock.current) return;
    if (forSend && !canStartDirectPractice) return;
    practicePreparationLock.current = true;
    setPreparingPractice(true); setPracticeError(undefined); setPracticeChoice(null);
    try {
      const current = await onboarding.refresh();
      const profileId = current.connection.profileId;
      if (!profileId || current.connection.state === 'missing') throw new Error(t('请先填写并保存语言模型。'));
      const session = forSend && activeSessionId
        ? (await window.electronAPI.getQaMemorySession(activeSessionId)).session
        : mode === 'resume' && current.practiceSessionId
        ? (await window.electronAPI.getQaMemorySession(current.practiceSessionId)).session
        : await window.electronAPI.createQaMemorySession('chat');
      await window.electronAPI.bindOnboardingPractice({ profileId, sessionId: session.sessionId, expectedRevision: current.revision });
      if (mode === 'resume') await restoreSession(session);
      else { setSelectedLibraryPath(null); adoptCreatedSession(session, !forSend); setHistoryOpened(false); }
      setPracticeSessionId(session.sessionId);
      setPracticeProfileId(profileId);
      if (onboarding.review) setAuthorizedReviewId(onboarding.reviewId);
      await onboarding.refresh();
      return { sessionId: session.sessionId, profileId };
    } catch (failure) { setPracticeError(failure instanceof Error ? t(failure.message) : t('练习对话准备失败，请重试。')); }
    finally { practicePreparationLock.current = false; setPreparingPractice(false); }
  };
  const choosePractice = (mode: 'new' | 'resume') => {
    if (conversationHasContent || composerState.hasDraft) setPracticeChoice(mode);
    else void preparePractice(mode);
  };

  return (
    <div className={onboarding ? 'onboarding-question' : 'onboarding-assistant'}>
    <section className={`qa-workspace${historyOpened ? ' history-open' : ''}`} aria-label={t("AI 问答")}>
      <header className="qa-workspace-header">
        <div className="qa-workspace-title">
          <span className="qa-workspace-mark" aria-hidden="true"><Bot size={17} /></span>
          <div>
            <h1>{t("AI 问答")}</h1>
            <p>{selectedLibrary ? t("检索所选个人知识库，并依据父块证据回答。") : t("开放式问答，不读取个人资料库。")}</p>
          </div>
        </div>
        <div className="qa-workspace-status">
          <span className="qa-workspace-context" title={selectedLibrary?.path}>
            <Database size={13} />{selectedLibrary?.alias ?? t("无资料库")}
          </span>
          <span className={`qa-workspace-readiness ${isReady ? 'ready' : 'pending'}`}>
            <Sparkles size={12} />{readinessLabel}
          </span>
          <span className="qa-workspace-actions">
            <button
              type="button"
              className="qa-workspace-new-session"
              disabled={Boolean(onboarding)}
              onClick={() => void startNewSession().catch((error) => setHistoryError(error instanceof Error ? error.message : t("无法新建会话。")))}
              aria-label={t("新对话")}
              title={t("新对话")}
            >
              <Plus size={14} />
              <span>{t("新对话")}</span>
            </button>
            <button
              ref={debugRailTriggerRef}
              type="button"
              className="qa-workspace-debug"
              onClick={() => setDebugDrawerOpen(!isDebugRailOpen)}
              aria-label={isDebugRailOpen ? t("收起调试轨道") : t("打开调试轨道")}
              aria-controls="qa-debug-drawer"
              aria-expanded={isDebugRailOpen}
              title={isDebugRailOpen ? t("收起调试轨道") : t("打开调试轨道")}
            >
              <SquareTerminal size={15} />
            </button>
            <button type="button" className="qa-workspace-settings" onClick={onOpenSettings} aria-label={t("打开模型设置")} title={t("打开模型设置")}>
              <Settings2 size={15} />
            </button>
          </span>
        </div>
      </header>

      {!historyOpened ? (
        <Tooltip label={t("历史记忆")} position="right" withArrow>
          <button
            ref={historyTriggerRef}
            type="button"
            className="qa-memory-drawer-trigger"
            onClick={() => setHistoryOpened(true)}
            aria-label={t("打开历史记忆")}
            aria-expanded="false"
          >
            <History size={15} />
            <span>{t("记忆")}</span>
          </button>
        </Tooltip>
      ) : null}

      <div className="qa-workspace-stage">
        <KnowledgeAssistant
          onboarding={onboarding ? {
            profileId: !preview ? onboarding.state?.connection.profileId ?? undefined : undefined,
            sendDisabled: (!practiceReady && !canStartDirectPractice) || preparingPractice || onboarding.busy,
            prepareSend: !practiceReady && canStartDirectPractice ? () => preparePractice('new', true) : undefined,
            draftRequest: practiceDraft,
          } : undefined}
          onComposerStateChange={reportComposerState}
          libraryPath={null}
          noteMeta={null}
          fixedContextSources={contextSources}
          contextSourceOptions={contextSourceOptions}
          selectedContextSourcePath={selectedLibrary?.path ?? null}
          initialDraft={incomingDraft}
          onSelectContextSource={(libraryPath) => {
            requestContextSourceChange(libraryPath);
          }}
          onConversationActivityChange={setConversationHasContent}
          workspaceMemory={workspaceMemory}
          showConversationNavigation
          assistantAiOptions={assistantAiOptions}
          onRefreshAssistantAiOptions={onRefreshAssistantAiOptions}
          assistantContextRevision={assistantContextRevision}
          onStartAssistantTurn={onStartAssistantTurn}
          onCancelAssistantTurn={onCancelAssistantTurn}
          debugRailOpen={isDebugRailOpen}
          onDebugRailOpenChange={setDebugDrawerOpen}
          hideDebugRailToggle
          hideNewConversationAction
        />
      </div>

      {historyOpened ? (
        <aside className="qa-memory-drawer-content" aria-label={t("历史记忆")}>
          <div className="qa-memory-drawer-header">
            <div className="qa-memory-drawer-title">
              <span>{t("历史记忆")}</span>
              <small>{t("统一保存在 ConversationMemory/qa-memory.db（开放式与知识库会话分开）")}</small>
            </div>
            <button
              ref={historyCloseButtonRef}
              type="button"
              className="qa-memory-drawer-close"
              onClick={closeHistory}
              aria-label={t("关闭历史记忆")}
            >
              <X size={18} />
            </button>
          </div>

          <div className="qa-memory-drawer-body">
            <Button
              className="qa-memory-new-session"
              leftSection={<Plus size={15} />}
              variant="light"
              fullWidth
              onClick={() => void startNewSession().catch((error) => setHistoryError(error instanceof Error ? error.message : t("无法新建会话。")))}
            >
              {t("新建会话")}
            </Button>

            <ScrollArea
              className="qa-memory-session-scroll"
              type="auto"
              offsetScrollbars
            >
              <Stack gap={5} className="qa-memory-session-list">
                {sessions.map((session) => (
                  <button
                    type="button"
                    key={session.sessionId}
                    className={`qa-memory-session${session.sessionId === activeSessionId ? ' active' : ''}`}
                    onClick={() => void restoreSession(session).catch((error) => setHistoryError(error instanceof Error ? error.message : t("无法恢复会话。")))}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextMenu({ session, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="qa-memory-session-icon" aria-hidden="true"><MessageSquareText size={14} /></span>
                    <span className="qa-memory-session-copy">
                      <strong>{session.title}</strong>
                      <small>{session.scope === 'knowledge-base' ? t("知识库问答") : t("开放式问答")} · {formatSessionTime(session.updatedAt)} · {session.turnCount} {t("轮")}</small>
                    </span>
                    {session.pinned ? <Pin className="qa-memory-session-pin" size={13} aria-label={t("已置顶")} /> : null}
                  </button>
                ))}

                {!isLoadingHistory && !sessions.length && !historyError ? (
                  <div className="qa-memory-empty">
                    <MessageSquareText size={22} />
                    <strong>{t("还没有历史记忆")}</strong>
                    <span>{t("发起第一次提问，或新建一个会话。")}</span>
                  </div>
                ) : null}
                {historyError ? <Text className="qa-memory-error" size="xs">{historyError}</Text> : null}
                {isLoadingHistory && !sessions.length ? <Group className="qa-memory-loading" gap={8} justify="center"><Loader size={14} /><Text size="xs">{t("正在读取 10 条记忆…")}</Text></Group> : null}

                {sessions.length > 0 ? (
                  <div className="qa-memory-pagination" aria-live="polite">
                    {nextCursor !== undefined || isLoadingHistory ? (
                      <>
                        <Tooltip label={isLoadingHistory ? t("正在加载更多会话") : t("加载更多会话")} position="right" withArrow>
                          <button
                            type="button"
                            className="qa-memory-load-more"
                            onClick={loadMoreHistory}
                            disabled={isLoadingHistory}
                            aria-label={isLoadingHistory ? t("正在加载更多会话") : t("加载更多会话")}
                            aria-busy={isLoadingHistory}
                          >
                            {isLoadingHistory ? <Loader size={14} /> : <ChevronDown size={17} />}
                          </button>
                        </Tooltip>
                        <Text className="qa-memory-pagination-label" size="xs">
                          {isLoadingHistory ? t("正在加载…") : t("加载更多会话")}
                        </Text>
                      </>
                    ) : <Text className="qa-memory-end" size="xs">{t("已经到底了")}</Text>}
                  </div>
                ) : null}
              </Stack>
            </ScrollArea>
          </div>
        </aside>
      ) : null}

      <Menu
        opened={Boolean(contextMenu)}
        onChange={(opened) => { if (!opened) setContextMenu(null); }}
        position="right-start"
        shadow="md"
        width={168}
        withinPortal
      >
        <Menu.Target>
          <span
            className="qa-memory-context-anchor"
            style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
            aria-hidden="true"
          />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={contextMenu?.session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            onClick={() => contextMenu && void togglePinned(contextMenu.session).catch((error) => setHistoryError(error instanceof Error ? error.message : t("置顶操作失败。")))}
          >
            {contextMenu?.session.pinned ? t("取消置顶") : t("置顶")}
          </Menu.Item>
          <Menu.Item leftSection={<Pencil size={14} />} onClick={() => {
            if (!contextMenu) return;
            setRenameTarget(contextMenu.session);
            setRenameTitle(contextMenu.session.title);
            setContextMenu(null);
          }}>{t("重命名")}</Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => {
            if (!contextMenu) return;
            setDeleteTarget(contextMenu.session);
            setContextMenu(null);
          }}>{t("删除")}</Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal
        opened={Boolean(pendingModeSwitch)}
        onClose={() => setPendingModeSwitch(null)}
        title={t("开启新的问答会话？")}
        centered
        size="sm"
      >
        <Text size="sm">
          {t("当前会话已有问答内容。开放式问答与知识库问答使用独立会话；切换到“")}{pendingModeSwitch?.libraryPath ? t("知识库问答") : t("开放式问答")}{t("”将从空白会话开始，当前历史仍会保留。")}
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="gray" onClick={() => setPendingModeSwitch(null)}>{t("留在当前会话")}</Button>
          <Button leftSection={<Plus size={15} />} onClick={confirmModeSwitch}>{t("新建并切换")}</Button>
        </Group>
      </Modal>

      <Modal opened={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title={t("重命名会话")} centered size="sm">
        <TextInput
          label={t("会话名称")}
          value={renameTitle}
          maxLength={80}
          autoFocus
          onChange={(event) => setRenameTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && renameTitle.trim()) void saveRename().catch((error) => setHistoryError(error instanceof Error ? error.message : t("重命名失败。")));
          }}
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="gray" onClick={() => setRenameTarget(null)}>{t("取消")}</Button>
          <Button disabled={!renameTitle.trim()} onClick={() => void saveRename().catch((error) => setHistoryError(error instanceof Error ? error.message : t("重命名失败。")))}>{t("保存")}</Button>
        </Group>
      </Modal>

      <Modal opened={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title={t("删除会话")} centered size="sm">
        <Text size="sm">{t("将删除“")}{deleteTarget?.title}{t("”及其中的全部问答记录。此操作无法撤销。")}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="gray" onClick={() => setDeleteTarget(null)}>{t("取消")}</Button>
          <Button color="red" onClick={() => void deleteSession().catch((error) => setHistoryError(error instanceof Error ? error.message : t("删除失败。")))}>{t("删除")}</Button>
        </Group>
      </Modal>
    </section>
    {onboarding && <aside className="onboarding-task" aria-label={t('第一次提问任务卡')} data-testid="onboarding-question-task"><Stack gap="md">
      <div className="onboarding-eyebrow">{t('第 3 步，共 3 步')}</div><Title order={3}>{preview ? t('先看看怎样提问') : t('让助手回答一个问题')}</Title>
      <Text size="sm" c="dimmed">{t('练习使用开放式问答，不读取个人资料，也不联网搜索。')}</Text>
      {preview ? <Text size="sm">{t('还未配置 AI。你可以填写示例草稿，配置后再发送。')}</Text> : !practiceReady ? <>
        <Text size="sm">{onboarding.review ? t('查看操作不会创建对话。如需练习，请主动新建。') : canStartDirectPractice ? t('已找到保存的模型，输入问题即可发送，无需重新配置或测试连接。') : t('新建一个练习对话，当前对话仍会保留。')}</Text>
        <Button loading={preparingPractice} disabled={composerState.busy} onClick={() => choosePractice('new')}>{t('新建练习对话')}</Button>
        {!onboarding.review && onboarding.state?.practiceSessionId && <Button variant="default" disabled={composerState.busy || preparingPractice} onClick={() => choosePractice('resume')}>{t('继续练习对话')}</Button>}
        {(conversationHasContent || composerState.hasDraft) && <Button variant="subtle" color="gray" onClick={() => void onboarding.pause()}>{t('保留当前对话')}</Button>}
      </> : <Text className="onboarding-practice-status">{t('练习对话已就绪，模型与设置中的连接一致。')}</Text>}
      <Button variant="light" disabled={composerState.busy || preparingPractice} onClick={() => setPracticeDraft({ id: Date.now(), text: t(ONBOARDING_QUESTION) })}>{t('填入示例问题')}</Button>
      <Text size="xs" c="dimmed">{t('点击发送，或按 Enter；Shift + Enter 换行。')}</Text>
      <Text size="xs" c="dimmed">{t('遇到错误可以修改问题重试，也可以停止生成。停止后不会计为完成。')}</Text>
      {composerState.busy && <Text role="status" size="sm">{t('正在等待真实回答…')}</Text>}
      {composerState.failed && <Alert color="orange">{t('本轮未完成。问题已保留在对话中，请重试或检查模型设置。')}</Alert>}
      {practiceError && <Alert color="red">{practiceError}</Alert>}{onboarding.error && <Alert color="red">{onboarding.error}</Alert>}
      {!onboarding.review && <Button disabled={onboarding.state?.progress.question !== 'done' || onboarding.state.connection.state !== 'tested' || composerState.busy || onboarding.busy} onClick={() => void onboarding.act('finish')}>{t('完成引导')}</Button>}
      <Button variant="subtle" size="xs" color="gray" disabled={composerState.busy} onClick={onboarding.backAi}>{t('返回配置 AI')}</Button>
    </Stack></aside>}
    <Modal opened={practiceChoice !== null} onClose={() => setPracticeChoice(null)} title={t('保留当前对话')} centered>
      <Text size="sm">{t('当前对话会保留在历史中，未发送草稿会带入练习。是否切换到练习对话？')}</Text><Group justify="flex-end" mt="md"><Button variant="default" onClick={() => { setPracticeChoice(null); void onboarding?.pause(); }}>{t('保留当前对话')}</Button><Button onClick={() => { if (practiceChoice) void preparePractice(practiceChoice); }}>{t('切换到练习')}</Button></Group>
    </Modal>
    </div>
  );
}

function mergeSessions(
  current: QaSessionSummary[],
  incoming: QaSessionSummary[],
): QaSessionSummary[] {
  const merged = new Map(current.map((session) => [session.sessionId, session]));
  for (const session of incoming) merged.set(session.sessionId, session);
  return [...merged.values()].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt) || right.sessionId.localeCompare(left.sessionId);
  });
}

function formatSessionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return t("时间未知");
  const today = new Date();
  const sameDay = time.getFullYear() === today.getFullYear()
    && time.getMonth() === today.getMonth()
    && time.getDate() === today.getDate();
  return new Intl.DateTimeFormat(getAppLanguage(), sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'numeric', day: 'numeric' }).format(time);
}
