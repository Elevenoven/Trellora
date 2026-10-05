import type { WikiActionKind } from './wikiQuickActions';

export const WIKI_MAX_RETRIEVAL_CYCLES = 5 as const;

export type WikiScopeMode = 'node-locked' | 'node-first' | 'document-first';

export type WikiScopeDecisionReason =
  | 'explicit-node-lock'
  | 'quick-action-node-lock'
  | 'cross-links-action'
  | 'explicit-document-scope'
  | 'default-node-first';

export interface WikiScopeDecision {
  mode: WikiScopeMode;
  reason: WikiScopeDecisionReason;
  /** true 表示范围由用户原文或快捷动作确定，不允许改写模型扩大。 */
  lockedByRequest: boolean;
}

export type WikiScopeEscalationReason =
  | 'explicit-document-scope'
  | 'explicit-section-reference'
  | 'local-no-hit'
  | 'local-evidence-incomplete';

export type WikiSearchRange = 'subtree' | 'document';

export type WikiRetrievalStopReason =
  | 'evidence-sufficient'
  | 'cycle-limit'
  | 'no-new-query'
  | 'budget-exhausted'
  | 'cancelled';

export type WikiSearchBlockReason =
  | 'cycle-limit'
  | 'duplicate-search'
  | 'awaiting-evidence-assessment'
  | 'scope-locked'
  | 'local-search-required'
  | 'scope-already-expanded'
  | 'root-scope';

export interface WikiSearchAttemptDecision {
  allowed: boolean;
  signature: string;
  message: string;
  cycle?: number;
  range?: WikiSearchRange;
  scopeEscalated?: boolean;
  blockReason?: WikiSearchBlockReason;
}

export interface WikiFinalAnswerDecision {
  accept: boolean;
  stopReason?: WikiRetrievalStopReason;
  message?: string;
}

export interface WikiFinalAnswerEvaluationInput {
  /** false means the zero-search answer cannot end, including the mandatory first evidence-tool round. */
  zeroCycleEvidenceSufficient?: boolean;
  /** false means the retrieved evidence still does not support the current question. */
  retrievedEvidenceSufficient?: boolean;
}

export interface WikiScopeState {
  mode: WikiScopeMode;
  documentId: string;
  anchorNodeId: string;
  /** undefined 仅表示锚点是文档根节点；空数组表示没有合法章节。 */
  subtreeHeadingIds: string[] | undefined;
  anchorIsRoot: boolean;
  localAttempted: boolean;
  localSearchCount: number;
  localEvidenceCount: number;
  localDeepReadCompleted: boolean;
  documentScopeEntered: boolean;
  retrievalCycleCount: number;
  readonly maxRetrievalCycles: typeof WIKI_MAX_RETRIEVAL_CYCLES;
  documentSearchCount: number;
  documentEvidenceCount: number;
  attemptedSearchSignatures: Set<string>;
  lastCycleNewEvidenceCount: number;
  lastSearchRange?: WikiSearchRange;
  searchIssuedSinceLastDecision: boolean;
  stopReason?: WikiRetrievalStopReason;
  escalationReason?: WikiScopeEscalationReason;
  authorizedDocumentNodeIds: Set<string>;
}

export interface WikiScopePolicy {
  readonly state: WikiScopeState;
  /** 工具是否可以注册；执行时仍由 beginSearch 实施“先本节后全文”门控。 */
  readonly documentSearchAvailable: boolean;
  canEscalateToDocument(): boolean;
  startModelDecision(): void;
  beginSearch(input: {
    toolName: string;
    range: WikiSearchRange;
    args: Record<string, unknown>;
  }): WikiSearchAttemptDecision;
  completeSearch(input: { range: WikiSearchRange; ok: boolean; newEvidenceCount: number }): void;
  noteRejectedSearch(toolName: string, message: string): void;
  markEvidenceSufficient(): void;
  markNoNewQuery(): void;
  markCycleLimit(): void;
  noteBudgetExhausted(): void;
  markCancelled(): void;
  evaluateFinalAnswer(input?: WikiFinalAnswerEvaluationInput): WikiFinalAnswerDecision;
}

const NODE_LOCKED_ACTIONS = new Set<WikiActionKind>([
  'summarize',
  'key-conclusions',
  'troubleshooting',
  'review-outline',
  'split-children',
]);

const NODE_LOCK_PATTERNS = [
  /(?:只|仅)(?:看|查|根据|依据|参考|使用)?(?:当前|本)(?:章节|节|节点|部分)/u,
  /不要(?:查|参考|搜索|检索)(?:其他|其它|全文|别的)(?:章节|部分)?/u,
  /不(?:要|需|用)(?:扩大|扩展|跨)(?:章节|范围)?/u,
];

const DOCUMENT_SCOPE_PATTERNS = [
  /全文|整篇|全篇|整份文档/u,
  /其他章节|其它章节|别的章节|跨章节/u,
  /前文|后文|上文|下文/u,
  /第[零〇一二三四五六七八九十百千万两\d]+(?:章|节|部分)/u,
];

export function hasExplicitWikiNodeLock(userText: string): boolean {
  const text = userText.trim();
  return NODE_LOCK_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasExplicitWikiDocumentScope(userText: string): boolean {
  const text = userText.trim();
  return DOCUMENT_SCOPE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 范围先由用户原文和快捷动作确定。改写模型只能确认范围，不能凭空把普通问题扩大到全文。
 */
export function resolveWikiScopeDecision(input: {
  actionKind: WikiActionKind;
  userText: string;
  suggestedMode?: WikiScopeMode;
}): WikiScopeDecision {
  if (hasExplicitWikiNodeLock(input.userText)) {
    return { mode: 'node-locked', reason: 'explicit-node-lock', lockedByRequest: true };
  }
  if (NODE_LOCKED_ACTIONS.has(input.actionKind)) {
    return { mode: 'node-locked', reason: 'quick-action-node-lock', lockedByRequest: true };
  }
  if (input.actionKind === 'cross-links') {
    return { mode: 'document-first', reason: 'cross-links-action', lockedByRequest: true };
  }
  if (hasExplicitWikiDocumentScope(input.userText)) {
    return { mode: 'document-first', reason: 'explicit-document-scope', lockedByRequest: true };
  }

  // 普通自由问答固定 node-first。即使模型建议 document-first，也不能扩大原文没有的范围意图。
  return {
    mode: 'node-first',
    reason: 'default-node-first',
    lockedByRequest: false,
  };
}

export function createWikiScopeState(input: {
  decision: WikiScopeDecision;
  documentId: string;
  anchorNodeId: string;
  subtreeHeadingIds: string[] | undefined;
  anchorIsRoot: boolean;
}): WikiScopeState {
  return {
    mode: input.decision.mode,
    documentId: input.documentId,
    anchorNodeId: input.anchorNodeId,
    subtreeHeadingIds: input.subtreeHeadingIds === undefined ? undefined : [...input.subtreeHeadingIds],
    anchorIsRoot: input.anchorIsRoot,
    localAttempted: false,
    localSearchCount: 0,
    localEvidenceCount: 0,
    localDeepReadCompleted: false,
    documentScopeEntered: input.anchorIsRoot || input.decision.mode === 'document-first',
    retrievalCycleCount: 0,
    maxRetrievalCycles: WIKI_MAX_RETRIEVAL_CYCLES,
    documentSearchCount: 0,
    documentEvidenceCount: 0,
    attemptedSearchSignatures: new Set<string>(),
    lastCycleNewEvidenceCount: 0,
    searchIssuedSinceLastDecision: false,
    authorizedDocumentNodeIds: new Set<string>(),
  };
}

export function createWikiScopePolicy(state: WikiScopeState): WikiScopePolicy {
  const policy: WikiScopePolicy = {
    state,
    documentSearchAvailable: state.mode !== 'node-locked' && !state.anchorIsRoot,
    canEscalateToDocument: () => state.mode !== 'node-locked'
      && !state.anchorIsRoot
      && !state.documentScopeEntered
      && state.localAttempted
      && state.retrievalCycleCount < state.maxRetrievalCycles,
    startModelDecision: () => {
      state.searchIssuedSinceLastDecision = false;
    },
    beginSearch: (input) => beginWikiSearch(state, input),
    completeSearch: (input) => completeWikiSearch(state, input),
    noteRejectedSearch: (toolName, message) => {
      if (!isWikiSearchToolName(toolName)) return;
      if (/重复动作签名|重复检索|duplicate/iu.test(message)) state.stopReason = 'no-new-query';
      if (/观察预算|工具调用次数|预算.*用尽/u.test(message)) state.stopReason = 'budget-exhausted';
      if (/周期.*上限|第 6 次|cycle-limit/iu.test(message)) state.stopReason = 'cycle-limit';
    },
    markEvidenceSufficient: () => { state.stopReason = 'evidence-sufficient'; },
    markNoNewQuery: () => { state.stopReason = 'no-new-query'; },
    markCycleLimit: () => { state.stopReason = 'cycle-limit'; },
    noteBudgetExhausted: () => { state.stopReason = 'budget-exhausted'; },
    markCancelled: () => { state.stopReason = 'cancelled'; },
    evaluateFinalAnswer: (input) => evaluateWikiFinalAnswer(state, policy, input),
  };
  return policy;
}

export function normalizeWikiScopeMode(value: unknown, fallback: WikiScopeMode): WikiScopeMode {
  return value === 'node-locked' || value === 'node-first' || value === 'document-first'
    ? value
    : fallback;
}

function beginWikiSearch(
  state: WikiScopeState,
  input: { toolName: string; range: WikiSearchRange; args: Record<string, unknown> },
): WikiSearchAttemptDecision {
  const signature = buildWikiSearchSignature(input.toolName, input.range, input.args);
  if (state.searchIssuedSinceLastDecision) {
    return blockedSearch(signature, 'awaiting-evidence-assessment', '本轮已经执行过一次检索；请先评估该次观察结果，再决定下一周期。');
  }
  if (state.retrievalCycleCount >= state.maxRetrievalCycles) {
    state.stopReason = 'cycle-limit';
    return blockedSearch(signature, 'cycle-limit', `已完成 ${state.maxRetrievalCycles} 个检索周期，禁止启动第 ${state.maxRetrievalCycles + 1} 次检索。`);
  }
  if (state.attemptedSearchSignatures.has(signature)) {
    state.stopReason = 'no-new-query';
    return blockedSearch(signature, 'duplicate-search', '相同工具、范围和参数的检索已经执行过；请更换查询路径或基于现有证据收束。');
  }

  let scopeEscalated = false;
  if (input.range === 'document') {
    if (state.mode === 'node-locked') {
      return blockedSearch(signature, 'scope-locked', '用户或快捷动作已锁定当前章节，禁止检索本文其他章节。');
    }
    if (state.anchorIsRoot) {
      return blockedSearch(signature, 'root-scope', '当前节点已经覆盖整篇文档，无需重复执行跨章节检索。');
    }
    if (state.mode === 'node-first' && !state.documentScopeEntered) {
      if (!state.localAttempted) {
        return blockedSearch(signature, 'local-search-required', 'node-first 必须先完成至少一次当前章节检索，才能扩大到本文其他章节。');
      }
      state.documentScopeEntered = true;
      state.escalationReason = state.localEvidenceCount === 0 ? 'local-no-hit' : 'local-evidence-incomplete';
      scopeEscalated = true;
    }
  } else if (state.documentScopeEntered && !state.anchorIsRoot) {
    return blockedSearch(signature, 'scope-already-expanded', '检索范围已经扩大到当前文档，不能再缩回当前章节重新开始周期。');
  }

  state.stopReason = undefined;
  state.attemptedSearchSignatures.add(signature);
  state.retrievalCycleCount += 1;
  state.searchIssuedSinceLastDecision = true;
  state.lastCycleNewEvidenceCount = 0;
  state.lastSearchRange = input.range;
  if (input.range === 'document') state.documentSearchCount += 1;
  else state.localSearchCount += 1;
  return {
    allowed: true,
    signature,
    message: `开始第 ${state.retrievalCycleCount}/${state.maxRetrievalCycles} 个检索周期。`,
    cycle: state.retrievalCycleCount,
    range: input.range,
    ...(scopeEscalated ? { scopeEscalated: true } : {}),
  };
}

function completeWikiSearch(
  state: WikiScopeState,
  input: { range: WikiSearchRange; ok: boolean; newEvidenceCount: number },
): void {
  const evidenceCount = input.ok && Number.isFinite(input.newEvidenceCount)
    ? Math.max(0, Math.floor(input.newEvidenceCount))
    : 0;
  state.lastCycleNewEvidenceCount = evidenceCount;
  if (input.range === 'document') state.documentEvidenceCount += evidenceCount;
  else {
    state.localAttempted = true;
    state.localEvidenceCount += evidenceCount;
  }
  if (state.retrievalCycleCount >= state.maxRetrievalCycles && evidenceCount === 0) {
    state.stopReason = 'cycle-limit';
  }
}

function evaluateWikiFinalAnswer(
  state: WikiScopeState,
  policy: WikiScopePolicy,
  input?: WikiFinalAnswerEvaluationInput,
): WikiFinalAnswerDecision {
  if (state.stopReason === 'no-new-query' || state.stopReason === 'budget-exhausted' || state.stopReason === 'cancelled') {
    return { accept: true, stopReason: state.stopReason };
  }
  if (state.retrievalCycleCount === 0) {
    if (state.mode === 'document-first' && !state.anchorIsRoot) {
      return {
        accept: false,
        message: '用户要求全文或其他章节范围；请先调用 wiki_search_document 检索当前文档，再给出最终回答。',
      };
    }
    if (input?.retrievedEvidenceSufficient === true) {
      state.stopReason = 'evidence-sufficient';
      return { accept: true, stopReason: state.stopReason };
    }
    if (input?.zeroCycleEvidenceSufficient === false) {
      return {
        accept: false,
        message: state.mode === 'node-locked'
          ? '事实性 Wiki 问答必须先在当前章节及其子章节中完成一次检索或深读，再根据 [0] 与工具证据输出终答。'
          : '事实性 Wiki 问答必须先检索或深读当前章节及其子章节；若本章节仍无证据，再按范围规则扩大到本文其他章节。',
      };
    }
    state.stopReason = 'evidence-sufficient';
    return { accept: true, stopReason: state.stopReason };
  }
  if (input?.retrievedEvidenceSufficient === true) {
    state.stopReason = 'evidence-sufficient';
    return { accept: true, stopReason: state.stopReason };
  }
  if (state.lastCycleNewEvidenceCount > 0) {
    if (input?.retrievedEvidenceSufficient !== false) {
      state.stopReason = 'evidence-sufficient';
      return { accept: true, stopReason: state.stopReason };
    }
  }
  if (state.retrievalCycleCount >= state.maxRetrievalCycles) {
    state.stopReason = 'cycle-limit';
    return { accept: true, stopReason: state.stopReason };
  }
  if (policy.canEscalateToDocument()) {
    return {
      accept: false,
      message: `当前章节检索未获得新证据。请把范围升级到本文其他章节，调用 wiki_search_document 开始第 ${state.retrievalCycleCount + 1}/${state.maxRetrievalCycles} 个检索周期，并使用新的查询表达。`,
    };
  }
  return {
    accept: false,
    message: `上一检索周期未获得新证据，且尚未达到 ${state.maxRetrievalCycles} 次上限。请更换查询措辞或检索方式开始下一周期；若确实没有新的合法查询路径，请明确说明后基于已有证据收束。`,
  };
}

function blockedSearch(signature: string, blockReason: WikiSearchBlockReason, message: string): WikiSearchAttemptDecision {
  return { allowed: false, signature, blockReason, message };
}

function buildWikiSearchSignature(toolName: string, range: WikiSearchRange, args: Record<string, unknown>): string {
  return `${toolName}:${range}:${JSON.stringify(normalizeSignatureValue(args))}`;
}

function normalizeSignatureValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeSignatureValue(item, key));
    return key === 'queries'
      ? [...new Set(items.filter((item): item is string => typeof item === 'string'))].sort()
      : items;
  }
  if (typeof value === 'string') return value.trim().toLocaleLowerCase('zh-CN');
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((childKey) => [
      childKey,
      normalizeSignatureValue(source[childKey], childKey),
    ]));
  }
  return value;
}

function isWikiSearchToolName(toolName: string): boolean {
  return toolName === 'wiki_node_search' || toolName === 'wiki_grep_node' || toolName === 'wiki_search_document';
}
