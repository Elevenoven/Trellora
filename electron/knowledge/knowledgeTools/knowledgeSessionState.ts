import { CitationReferenceAllocator, ObservationBudgetTracker, type ObservationBudget } from '../reactAgent/toolResultBudget';
import type { ReActCitationLedgerEntry } from '../reactAgent/reactEngineTypes';

/** 工具侧登记的证据条目（父块粒度）；引用号全局递增且按块去重。 */
export interface KnowledgeEvidenceRecord {
  documentId: string;
  /** 文档显示名；观察文本与引用投影使用。 */
  documentName?: string;
  parentChunkId: string;
  ordinal: number;
  /** 带章节上下文的检索文本；观察渲染使用。 */
  text: string;
  /** 原文保全；终答引用校验（assistantCitationGuard）使用。 */
  sourceText: string;
  sectionContext?: string;
  score?: number;
  methods?: Array<'keyword' | 'semantic'>;
}

export interface KnowledgeEvidenceRegistration {
  /** 分配或复用的引用号，形如 [3]。 */
  reference: string;
  /** 该证据在本会话是否已被登记过（seenChunks/seenUrls 命中）。 */
  alreadySeen: boolean;
}

/** 工具侧登记的网页证据条目（联网搜索设计方案 §7.1）；引用号与知识库块共享同一递增序列。 */
export interface WebEvidenceRecord {
  url: string;
  title: string;
  /** 厂商适配器 id，如 'zhipu'。 */
  source: string;
  /** 被引用的证据文本（摘要或正文摘录）；终答引用投影使用。 */
  sourceText: string;
}

/**
 * 知识库 ReAct 单轮会话状态（方案 §2.2 / §4.3）：
 * - seenChunks：按 文档+父块 去重，重复命中时复用引用号并标注"已见过"；
 * - 引用号台账：全局递增分配，终答引用投影取这里；
 * - 观察规模：委托 ObservationBudgetTracker 作兼容诊断；发送预算由 L1 投影控制。
 */
export class KnowledgeAgentSessionState {
  private readonly seen = new Map<string, string>();
  private readonly ledger = new Map<string, ReActCitationLedgerEntry>();
  private readonly allocator = new CitationReferenceAllocator();
  private readonly observations: ObservationBudgetTracker;

  constructor(budget: ObservationBudget) {
    this.observations = new ObservationBudgetTracker(budget);
  }

  get budgetTracker(): ObservationBudgetTracker {
    return this.observations;
  }

  private keyOf(record: { documentId: string; parentChunkId: string }): string {
    return `${record.documentId}|${record.parentChunkId}`;
  }

  isSeen(record: { documentId: string; parentChunkId: string }): boolean {
    return this.seen.has(this.keyOf(record));
  }

  referenceOf(record: { documentId: string; parentChunkId: string }): string | undefined {
    return this.seen.get(this.keyOf(record));
  }

  /** 登记证据：已见过的父块复用原引用号；新块分配新引用号。 */
  registerEvidence(record: KnowledgeEvidenceRecord): KnowledgeEvidenceRegistration {
    const key = this.keyOf(record);
    const existing = this.seen.get(key);
    if (existing) return { reference: existing, alreadySeen: true };
    const reference = this.allocator.allocate();
    this.seen.set(key, reference);
    this.ledger.set(reference, {
      reference,
      documentId: record.documentId,
      chunkId: record.parentChunkId,
      parentChunkId: record.parentChunkId,
      ordinal: record.ordinal,
      sourceText: record.sourceText,
      ...(record.sectionContext ? { sectionContext: record.sectionContext } : {}),
      ...(record.score !== undefined ? { score: record.score } : {}),
    });
    return { reference, alreadySeen: false };
  }

  /** 深读窗口按 文档+序号 登记，防止 list_knowledge_chunks 重复展开。 */
  seenWindowKey(documentId: string, ordinal: number, window: number): string {
    return `window|${documentId}|${ordinal - window}..${ordinal + window}`;
  }

  // —— 网页证据：seenUrls 去重 + 台账登记 + 验证升级（联网搜索设计方案 §7.1）——
  private readonly seenUrls = new Map<string, string>();

  isUrlSeen(url: string): boolean {
    return this.seenUrls.has(url);
  }

  referenceOfUrl(url: string): string | undefined {
    return this.seenUrls.get(url);
  }

  /** 本轮 web_search 返回过的 URL 集合；web_fetch 白名单（防提示注入诱导抓取）。 */
  private readonly searchableUrls = new Set<string>();

  markSearchableUrl(url: string): void {
    this.searchableUrls.add(url);
  }

  isSearchableUrl(url: string): boolean {
    return this.searchableUrls.has(url);
  }

  /** 本轮是否存在任何 web_search 返回过的 URL；无链接结果时 web_fetch 整体不可用。 */
  hasSearchableUrls(): boolean {
    return this.searchableUrls.size > 0;
  }

  /** 登记网页证据：已见过的 URL 复用原引用号；新 URL 分配新引用号。无链接条目（部分引擎仅返回标题/摘要）按 标题+摘要 去重，且不进入 web_fetch 白名单。 */
  registerWebEvidence(record: WebEvidenceRecord): KnowledgeEvidenceRegistration {
    const hasUrl = record.url.trim().length > 0;
    // 已登记为证据的 URL 必然来自本轮搜索结果，白名单保持一致（防提示注入）。
    if (hasUrl) this.searchableUrls.add(record.url);
    const key = hasUrl ? record.url : `no-link|${record.title}|${record.sourceText.slice(0, 120)}`;
    const existing = this.seenUrls.get(key);
    if (existing) return { reference: existing, alreadySeen: true };
    const reference = this.allocator.allocate();
    this.seenUrls.set(key, reference);
    this.ledger.set(reference, {
      reference,
      kind: 'web',
      url: record.url,
      title: record.title,
      source: record.source,
      sourceText: record.sourceText,
      pageVerified: false,
    });
    return { reference, alreadySeen: false };
  }

  /** web_fetch 全文核对成功后升级原引用条目的验证状态（引用号不变）。 */
  verifyWebEvidence(reference: string, verifiedText?: string): boolean {
    const entry = this.ledger.get(reference);
    if (!entry || entry.kind !== 'web') return false;
    this.ledger.set(reference, { ...entry, pageVerified: true, ...(verifiedText ? { sourceText: verifiedText } : {}) });
    return true;
  }

  /** 单轮循环内联网工具次数限额（联网搜索设计方案 §8）；超限在工具内拒绝。 */
  private webSearchCalls = 0;
  private webFetchCalls = 0;

  consumeWebSearchCall(limit: number): boolean {
    this.webSearchCalls += 1;
    return this.webSearchCalls <= limit;
  }

  consumeWebFetchCall(limit: number): boolean {
    this.webFetchCalls += 1;
    return this.webFetchCalls <= limit;
  }

  private readonly seenWindows = new Set<string>();

  markWindowSeen(key: string): void {
    this.seenWindows.add(key);
  }

  isWindowSeen(key: string): boolean {
    return this.seenWindows.has(key);
  }

  get citationCount(): number {
    return this.allocator.count;
  }

  /** 本轮已登记证据的父块键；供检索层作为历史引用放宽门控（不凭空注入证据）。 */
  seenEvidenceKeys(): Array<{ documentId: string; parentChunkId: string }> {
    return [...this.ledger.values()]
      .filter((entry) => entry.kind !== 'web' && entry.documentId && entry.parentChunkId)
      .map((entry) => ({ documentId: entry.documentId as string, parentChunkId: entry.parentChunkId as string }));
  }

  /** 终答引用投影与 agentStats 使用的完整台账。 */
  ledgerEntries(): ReActCitationLedgerEntry[] {
    return [...this.ledger.values()];
  }
}
