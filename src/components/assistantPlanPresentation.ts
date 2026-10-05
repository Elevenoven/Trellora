import type { AssistantEvidenceContextStats, CurrentNoteAgentStats, CurrentNotePublicPlanEvent, CurrentNotePublicSearchCoverage, CurrentNotePublicSearchScope } from '../electron';

export function translatePlanStatus(status: CurrentNotePublicPlanEvent['status']): string {
  return ({
    active: '进行中',
    completed: '已完成',
    partial: '部分完成',
    'not-found': '未找到',
    failed: '失败',
    cancelled: '已取消',
    stale: '笔记已变化',
    interrupted: '已中断',
  } as const)[status];
}

export function translatePlanGoalStatus(status: CurrentNotePublicPlanEvent['goals'][number]['status']): string {
  return ({
    pending: '待核实',
    searching: '正在核实',
    partial: '部分完成',
    covered: '已完成',
    conflicted: '存在冲突',
    'not-found': '未找到',
  } as const)[status];
}

export function getAssistantPlanView(event: CurrentNotePublicPlanEvent): {
  statusLabel: string;
  goals: Array<CurrentNotePublicPlanEvent['goals'][number] & { statusLabel: string; evidenceLabel: string }>;
} {
  return {
    statusLabel: translatePlanStatus(event.status),
    goals: event.goals.map((goal) => {
      // A final answer may settle the plan while an unapplied model planPatch
      // leaves its diagnostic goal state at pending/searching. The finished
      // event is authoritative for animation; never present that stale state
      // as work that is still running.
      if (event.phase === 'finished' && (goal.status === 'pending' || goal.status === 'searching')) {
        const status = event.status === 'completed'
          ? 'covered'
          : event.status === 'not-found'
            ? 'not-found'
            : 'partial';
        const statusLabel = event.status === 'completed' || event.status === 'not-found' || event.status === 'partial'
          ? translatePlanGoalStatus(status)
          : translatePlanStatus(event.status);
        return {
          ...goal,
          status,
          statusLabel,
          evidenceLabel: `已读取 ${goal.evidenceCount} 条证据`,
        };
      }
      return {
        ...goal,
        statusLabel: translatePlanGoalStatus(goal.status),
        evidenceLabel: `已读取 ${goal.evidenceCount} 条证据`,
      };
    }),
  };
}

export interface AssistantEvidenceContextView {
  accuracyLabel: string;
  searchHitLabel: string;
  tokenEstimateLabel: string;
  compressionLabel: string;
  manifestLabel: string;
}

/**
 * Presents only safe numeric evidence telemetry. Stage 1 intentionally labels
 * the values as estimates and does not expose Manifest or batch claims.
 */
export function getAssistantEvidenceContextView(
  stats: AssistantEvidenceContextStats | undefined,
): AssistantEvidenceContextView | undefined {
  if (!stats) return undefined;
  return {
    accuracyLabel: stats.accuracy === 'estimate' ? '估算' : '已核验',
    searchHitLabel: `搜索命中 ${stats.searchHitCount} 次（去重后 ${stats.uniqueSearchHitCount} 条）`,
    tokenEstimateLabel: `对应原文约 ${stats.estimatedRawEvidenceTokens} tokens`,
    compressionLabel: stats.mayNeedCompression ? '可能需要压缩' : '当前预算下暂不需要压缩',
    manifestLabel: stats.manifestStatus === 'not-materialized' ? 'Manifest 尚未物化' : 'Manifest 已物化',
  };
}

export interface AssistantSearchCoverageView {
  scopeLabel: string;
  coverageLabel: string;
  locatedLabel: string;
  readLabel: string;
  partialReason?: string;
}

export function translateSearchScopeMode(mode: CurrentNotePublicSearchScope['mode']): string {
  return mode === 'topic-wide' ? '主题综合查找' : '精确查找';
}

export function translateSearchCoveragePolicy(policy: CurrentNotePublicSearchScope['coveragePolicy']): string {
  return ({
    sufficient: '局部充分策略',
    'aspect-complete': '主题方面覆盖',
    'occurrence-complete': '逐处核对',
  } as const)[policy];
}

export function translateSearchCoverageStatus(status: CurrentNotePublicSearchCoverage['status']): string {
  return ({
    complete: '原文证据已满足',
    partial: '已读取部分原文证据',
    insufficient: '等待原文证据',
  } as const)[status];
}

/**
 * Turn the main-process Coverage Ledger projection into copy suitable for the
 * existing plan/tool trace.  No internal enum, score, query or reasoning is
 * returned to the component.
 */
export function getAssistantSearchCoverageView(
  scope: CurrentNotePublicSearchScope | undefined,
  coverage: CurrentNotePublicSearchCoverage | undefined,
  completeness?: 'complete' | 'partial' | 'not-found',
  agentStats?: Pick<CurrentNoteAgentStats, 'stopReason'>,
): AssistantSearchCoverageView | undefined {
  if (!scope || !coverage) return undefined;
  const located = Math.max(0, coverage.discoveredHeadingCount, coverage.readHeadingCount);
  const read = Math.min(located, Math.max(0, coverage.readHeadingCount));
  const partialReason = completeness === 'partial'
    ? agentStats?.stopReason === 'max-tool-calls'
      ? '本轮工具预算已用完，回答仅覆盖已读取部分。'
      : coverage.reason.trim() || '本轮只完成部分范围。'
    : coverage.status === 'partial'
      ? coverage.reason.trim() || '本轮只完成部分范围。'
      : undefined;
  return {
    scopeLabel: translateSearchScopeMode(scope.mode),
    coverageLabel: translateSearchCoverageStatus(coverage.status),
    locatedLabel: `已定位 ${located} 个相关章节`,
    readLabel: located > 0 ? `已读取 ${read}/${located} 个章节` : '已读取 0 个相关章节',
    ...(partialReason ? { partialReason } : {}),
  };
}
