import { createHash } from 'node:crypto';
import type { QaMemoryRepository } from './qaMemoryRepository';
import {
  renderQaSummaryBlock,
  selectQaRollingSummaryBlocks,
  selectQaShortTermEntries,
} from './qaMemoryAssembler';
import { projectQaRecentTurnsToHistoryMessages } from './qaCanonicalHistory';
import type { QaCanonicalHistoryMessage, QaRecentCompleteTurn, QaRecentTurn, QaStoredTurn } from './qaMemoryTypes';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
} from './contextMemoryTypes';
import type { ContextMaterial } from './contextRuntimeTypes';

type QaMemoryReader = Pick<QaMemoryRepository, 'listSummaries' | 'loadRecentCompleteTurns'>;

export class QaContextMemoryAdapter implements ContextMemoryAdapter {
  readonly id = 'qa-memory';

  constructor(private readonly repository: QaMemoryReader) {}

  supports(request: ContextMemoryRequest): boolean {
    return request.route === 'chat' || request.route === 'knowledge-base';
  }

  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    if (!this.supports(request)) throw new Error(`QA Memory Adapter 不支持 Route：${request.route}`);
    const summaries = selectQaRollingSummaryBlocks(
      this.repository.listSummaries(request.sessionId),
      normalizeBudget(request.budgets.summaryTokens),
    ).blocks;
    const recentTurns = this.repository.loadRecentCompleteTurns(request.sessionId);
    const hotEntries = selectQaShortTermEntries(
      recentTurns.map(toStoredTurn).reverse(),
      normalizeBudget(request.budgets.hotTokens),
    );
    const materials: ContextMaterial[] = [
      ...summaries.map((block, index): ContextMaterial => ({
        id: `qa-summary:${String(block.turnFrom).padStart(10, '0')}`,
        zone: 'conversation-summary',
        channel: 'user',
        trust: 'untrusted-memory',
        content: `${index === 0 ? '[Zone M1 滚动摘要]\n' : ''}${renderQaSummaryBlock(block)}`,
        priority: 60,
        protected: false,
        compressStrategy: 'summary',
        source: {
          kind: 'qa-summary-batch',
          id: block.batchId,
          version: block.updatedAt,
        },
        tokenBudget: { absoluteMax: 800 },
        stalePolicy: 'refresh',
        overflowPolicy: 'drop',
        provenance: {
          sessionId: request.sessionId,
          turnSeqs: range(block.turnFrom, block.turnTo),
        },
        cache: { stability: 'session', prefixEligible: false },
      })),
      ...hotEntries.map((entry, index): ContextMaterial => ({
        id: `qa-hot:${String(entry.turn.turnSeq).padStart(10, '0')}`,
        zone: 'conversation-hot',
        channel: 'user',
        trust: 'untrusted-memory',
        content: `${index === 0 ? '[Zone M2 短期记忆]\n' : ''}${entry.content}`,
        priority: 70,
        protected: false,
        compressStrategy: 'truncate',
        source: {
          kind: 'qa-turn',
          id: entry.turn.turnId,
          version: entry.turn.finishedAt ?? entry.turn.createdAt,
        },
        tokenBudget: { absoluteMax: 1_500 },
        stalePolicy: 'keep',
        overflowPolicy: 'compress',
        provenance: {
          sessionId: request.sessionId,
          turnSeqs: [entry.turn.turnSeq],
        },
        cache: { stability: 'session', prefixEligible: false },
      })),
    ];
    return {
      materials,
      version: createMemoryVersion(request.sessionId, materials),
      diagnostics: {
        source: this.id,
        loadedTurns: hotEntries.length,
        loadedSummaries: summaries.length,
        recalledTurns: 0,
        staleItems: 0,
      },
    };
  }

  /**
   * WK-M9 canonical L2 projector. It reads exactly the shared recent-complete
   * turn contract and never reads legacy summary/checkpoint/profile tables.
   */
  async loadCanonical(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    if (!this.supports(request)) throw new Error(`QA Memory Adapter 不支持 Route：${request.route}`);
    const recentTurns = this.repository.loadRecentCompleteTurns(request.sessionId);
    const materials = recentTurns.map((turn, index): ContextMaterial => ({
      id: `qa-canonical-l2:${turn.turnId}`,
      zone: 'conversation-hot',
      channel: 'user',
      trust: 'untrusted-memory',
      content: `${index === 0 ? '[最近 5 轮完整对话]\n' : ''}用户：${turn.userText}\n助手：${turn.assistantText}`,
      priority: 75,
      protected: false,
      compressStrategy: 'checkpoint',
      source: {
        kind: 'qa-turn',
        id: turn.turnId,
        version: turn.finishedAt ?? turn.createdAt,
      },
      stalePolicy: 'keep',
      overflowPolicy: 'compress',
      provenance: { sessionId: request.sessionId, turnSeqs: [turn.turnSeq] },
      cache: { stability: 'session', prefixEligible: false },
    }));
    return {
      materials,
      version: createMemoryVersion(`${request.sessionId}:canonical-l2`, materials),
      diagnostics: {
        source: `${this.id}:canonical-l2`,
        loadedTurns: recentTurns.length,
        loadedSummaries: 0,
        recalledTurns: 0,
        staleItems: 0,
      },
    };
  }

  /** Explicit M2 view for Query Rewrite; it never reads summaries or old recall. */
  async loadQueryRewriteHistory(request: ContextMemoryRequest): Promise<QaRecentTurn[]> {
    if (!this.supports(request)) return [];
    return this.repository.loadRecentCompleteTurns(request.sessionId, 3).map((turn) => ({
      userText: turn.userText,
      answerHead: turn.assistantText.slice(0, 200),
    }));
  }

  loadRecentCompleteTurns(request: ContextMemoryRequest): QaRecentCompleteTurn[] {
    if (!this.supports(request)) return [];
    return this.repository.loadRecentCompleteTurns(request.sessionId);
  }

  loadRecentHistoryMessages(request: ContextMemoryRequest): QaCanonicalHistoryMessage[] {
    return projectQaRecentTurnsToHistoryMessages(this.loadRecentCompleteTurns(request));
  }
}

function toStoredTurn(turn: QaRecentCompleteTurn): QaStoredTurn {
  return {
    turnId: turn.turnId,
    requestId: turn.requestId,
    attemptNo: turn.attemptNo,
    turnSeq: turn.turnSeq,
    userText: turn.userText,
    assistantText: turn.assistantText,
    scopeLabel: turn.scopeLabel,
    status: turn.status,
    createdAt: turn.createdAt,
    finishedAt: turn.finishedAt,
  };
}

function normalizeBudget(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

function createMemoryVersion(sessionId: string, materials: readonly ContextMaterial[]): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId,
    sources: materials.map((material) => ({
      id: material.id,
      sourceId: material.source.id,
      sourceVersion: material.source.version,
    })),
  }), 'utf8').digest('hex');
}
