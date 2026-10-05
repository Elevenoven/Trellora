import type { AssistantAttachment, AssistantTurnResult } from './assistantTurnTypes';
import type { AiProviderConfig } from './aiTypes';
import type { QaMemoryRepository } from './qaMemoryRepository';
import { QaMemoryCompressionQueue, buildQaFallbackSummaryBody } from './qaMemoryCompressor';
import { resolveQaZoneBudget } from './qaMemoryAssembler';
import type { QaAgentMessageInput, QaCanonicalRoute, QaMemoryPreparation, QaProjectContextInput, QaSessionScope } from './qaMemoryTypes';
import { UserProfileExtractionQueue } from './userProfileExtractionQueue';
import type { UserProfileExtractionScheduleInput } from './userProfileTypes';
import { ContextMemoryRegistry } from './contextMemoryRegistry';
import { ProjectContextAdapter } from './projectContextAdapter';
import { QaContextMemoryAdapter } from './qaContextMemoryAdapter';
import { estimateTokenCount } from './tokenEstimator';
import { UserProfileContextAdapter } from './userProfileContextAdapter';
import type { UserProfileRepository } from './userProfileRepository';
import {
  QaResidualMemoryEnforcer,
  type QaResidualMemoryEnforcementInput,
  type QaResidualMemoryEnforcementResult,
} from './qaResidualMemoryEnforcer';
import type { AssistantContextRuntimeMode } from './contextRuntimeTypes';
import type { TrustedMemoryScope } from './memory/memoryTypes';
import { isCanonicalMemoryProjection, normalizeMemoryProjectionMode, selectMemoryProjection, type MemoryProjectionMode } from './memory/memoryCutover';
import type { ContextMemoryResult } from './contextMemoryTypes';

export interface QaMemoryModelSelection {
  model: string;
  providerConfig?: AiProviderConfig;
}

/**
 * 问答区记忆编排器（设计 §6，主进程单一权威）：
 * 会话开始校验补压、每轮批次评估（先写 fallback 占位再入队 LLM）、
 * M1/M2 分区装配与轮次落库。渲染进程不参与裁剪与拼接。
 */
export class QaMemoryOrchestrator {
  readonly compressionQueue: QaMemoryCompressionQueue;
  readonly qaContextMemoryAdapter: QaContextMemoryAdapter;
  readonly contextMemoryRegistry: ContextMemoryRegistry;
  readonly residualMemoryEnforcer: QaResidualMemoryEnforcer;
  private readonly projectContextAdapter: ProjectContextAdapter;

  constructor(
    readonly repository: QaMemoryRepository,
    resolveModel: () => QaMemoryModelSelection | undefined,
    private readonly workspaceId = 'qa-workspace',
    readonly userProfileExtractionQueue?: UserProfileExtractionQueue,
    userProfileRepository?: UserProfileRepository,
  ) {
    this.compressionQueue = new QaMemoryCompressionQueue(repository, resolveModel);
    this.residualMemoryEnforcer = new QaResidualMemoryEnforcer(repository);
    this.qaContextMemoryAdapter = new QaContextMemoryAdapter(repository);
    this.projectContextAdapter = new ProjectContextAdapter();
    this.contextMemoryRegistry = new ContextMemoryRegistry(
      this.projectContextAdapter,
      [this.qaContextMemoryAdapter],
      userProfileRepository ? [new UserProfileContextAdapter(userProfileRepository)] : [],
    );
  }

  /** Phase 3 chat enforce：两遍装配、P1/P2 重算与按需前台 checkpoint。 */
  enforceChatContext(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    return this.residualMemoryEnforcer.enforce(input);
  }

  /** Phase 4 knowledge-base enforce：先固定动态父块证据，再把真实剩余窗口分给会话。 */
  enforceKnowledgeBaseContext(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    return this.residualMemoryEnforcer.enforce(input);
  }

  /**
   * 每轮开始（设计 §6 步骤 1–4）：落库 pending → 会话开始校验（首次）→
   * 批次评估（占位 + 入队）→ 装配 M1/M2 → 返回可拼入 prompt 的记忆分区。
   */
  async prepareTurn(input: {
    sessionId?: string;
    /** 会话固定模式；已有内容的 sessionId 不允许跨模式继续。 */
    scope: QaSessionScope;
    turnId: string;
    userText: string;
    scopeLabel: string;
    route?: QaCanonicalRoute;
    attachments?: readonly AssistantAttachment[];
    libraryPath?: string;
    contextWindowTokens?: number;
    projectContext: QaProjectContextInput;
    residualMemoryMode?: AssistantContextRuntimeMode;
    memoryProjectionMode?: MemoryProjectionMode;
  }): Promise<QaMemoryPreparation> {
    const session = input.sessionId
      ? this.repository.ensureSession(input.sessionId, input.scope, input.libraryPath ? { libraryPath: input.libraryPath } : {})
      : this.repository.createSession(input.scope, input.libraryPath ? { libraryPath: input.libraryPath } : {});
    const sessionId = session.sessionId;
    const started = this.repository.startTurn(sessionId, {
      turnId: input.turnId,
      userText: input.userText,
      scopeLabel: input.scopeLabel,
      route: input.route ?? input.scope,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const budget = resolveQaZoneBudget(input.scope, input.contextWindowTokens);
    const memoryRequest = {
      route: input.scope,
      workspaceId: this.workspaceId,
      ...(input.libraryPath ? { libraryId: input.libraryPath } : {}),
      sessionId,
      currentQuestion: input.userText,
      budgets: {
        summaryTokens: budget.rollingSummary,
        hotTokens: budget.shortTerm,
        recallTokens: 0,
      },
      projectContext: input.projectContext,
    } as const;
    const memoryProjectionMode = normalizeMemoryProjectionMode(input.memoryProjectionMode);
    let contextMemory: QaMemoryPreparation['contextMemory'];
    let legacyContext: ContextMemoryResult;
    let canonicalContext: ContextMemoryResult;
    let recentTurns: QaMemoryPreparation['recentTurns'];
    let recentCompleteTurns: QaMemoryPreparation['recentCompleteTurns'];
    let recentHistoryMessages: QaMemoryPreparation['recentHistoryMessages'];
    try {
      const canonicalStartedAt = Date.now();
      const [projectContext, canonicalHistoryContext] = await Promise.all([
        this.projectContextAdapter.load(memoryRequest),
        this.qaContextMemoryAdapter.loadCanonical(memoryRequest),
      ]);
      canonicalContext = combineContextMemoryResults(projectContext, canonicalHistoryContext);
      const canonicalReadMs = Math.max(0, Date.now() - canonicalStartedAt);
      let legacyReadMs = 0;
      if (isCanonicalMemoryProjection(memoryProjectionMode)) {
        legacyContext = emptyContextMemory('legacy-reader:disabled-after-cutover');
      } else {
        const legacyStartedAt = Date.now();
        legacyContext = await this.contextMemoryRegistry.load(memoryRequest);
        legacyReadMs = Math.max(0, Date.now() - legacyStartedAt);
      }
      contextMemory = selectMemoryProjection(memoryProjectionMode, legacyContext, canonicalContext).active;
      recentTurns = await this.qaContextMemoryAdapter.loadQueryRewriteHistory(memoryRequest);
      recentCompleteTurns = this.qaContextMemoryAdapter.loadRecentCompleteTurns(memoryRequest);
      recentHistoryMessages = this.qaContextMemoryAdapter.loadRecentHistoryMessages(memoryRequest);
      const activeReader = memoryProjectionMode === 'canonical' ? 'canonical' : 'legacy';
      const residualContext = legacyContext;
      return {
        sessionId,
        contextMemory,
        zoneTokens: {
          rollingSummary: sumMaterialTokens(contextMemory, 'conversation-summary'),
          shortTerm: sumMaterialTokens(contextMemory, 'conversation-hot'),
        },
        recentTurns,
        recentCompleteTurns,
        recentHistoryMessages,
        memoryProjection: {
          mode: memoryProjectionMode,
          activeReader,
          legacyContext,
          canonicalContext,
          readDiagnostics: { legacyReadMs, canonicalReadMs },
        },
        residualObservation: {
          memorableTurns: this.repository.loadMemorableTurnsAfter(sessionId),
          legacy: {
            rollingSummaryTokens: sumMaterialTokens(residualContext, 'conversation-summary'),
            shortTermTokens: sumMaterialTokens(residualContext, 'conversation-hot'),
            summaryMaterialCount: residualContext.materials.filter((material) => material.zone === 'conversation-summary').length,
            summaryTurnRanges: residualContext.materials
              .filter((material) => material.zone === 'conversation-summary')
              .map((material) => material.provenance?.turnSeqs ?? [])
              .filter((turnSeqs) => turnSeqs.length > 0)
              .map((turnSeqs) => ({ turnFrom: Math.min(...turnSeqs), turnTo: Math.max(...turnSeqs) })),
            hotTurnSeqs: residualContext.materials
              .filter((material) => material.zone === 'conversation-hot')
              .flatMap((material) => material.provenance?.turnSeqs ?? []),
          },
        },
        turnSeq: started.turnSeq,
        turnId: started.turnId,
      };
    } catch (error) {
      this.finishAbortedTurn(sessionId, started.turnId, 'error');
      throw error;
    }
  }

  /** 轮次成功结束：落库完整结果，再评估是否产生新的完整批次。 */
  finalizeTurn(
    sessionId: string,
    turnId: string,
    result: AssistantTurnResult,
    profileExtraction?: Omit<UserProfileExtractionScheduleInput, 'sourceTurnId' | 'sessionId'>,
    options?: {
      residualMemoryMode?: AssistantContextRuntimeMode;
      agentMessages?: readonly QaAgentMessageInput[];
      finalReasoningContent?: string;
      route?: QaCanonicalRoute;
      archiveScope?: TrustedMemoryScope;
    },
  ): void {
    this.repository.finalizeTurn(sessionId, turnId, result, {
      ...(options?.agentMessages ? { agentMessages: options.agentMessages } : {}),
      ...(options?.finalReasoningContent ? { finalReasoningContent: options.finalReasoningContent } : {}),
      ...(options?.route ? { route: options.route } : {}),
      ...(options?.archiveScope ? { archiveScope: options.archiveScope } : {}),
    });
    // WK-M9: legacy summaries/checkpoints/profile are read-only rollback data.
    // Canonical L4 extraction is scheduled by completeTurnPostProcess instead.
    void profileExtraction;
  }

  /** 轮次取消/失败：落库终止状态；取消与失败轮不进热窗也不参与压缩。 */
  finishAbortedTurn(sessionId: string, turnId: string, status: 'cancelled' | 'error', assistantText?: string): void {
    this.repository.finishAbortedTurn(sessionId, turnId, status, assistantText);
  }

  /** 应用退出：中止后台压缩，避免悬挂请求。 */
  shutdown(): void {
    this.compressionQueue.abortAll();
    this.residualMemoryEnforcer.abortAll();
    this.userProfileExtractionQueue?.abortAll();
  }

  /** 删除会话前取消该会话的后台维护调用。 */
  cancelSession(sessionId: string): void {
    this.compressionQueue.cancelSession(sessionId);
    this.residualMemoryEnforcer.cancelSession(sessionId);
    this.userProfileExtractionQueue?.cancelSession(sessionId);
  }

  /**
   * 批次评估（设计 §3.1 / §3.4 / §6 步骤 3）：
   * missing 批次立即写确定性占位并推进 seq，随后全部批次按升序入队 LLM。
   * 全程不阻塞当轮回答。
   */
  private evaluatePendingBatches(sessionId: string): void {
    const planned = this.repository.planPendingBatches(sessionId);
    if (planned.length === 0) return;
    for (const batch of planned) {
      if (batch.need !== 'missing') continue;
      const turns = this.repository.loadTurnRange(sessionId, batch.turnFrom, batch.turnTo);
      if (turns.length === 0) continue;
      this.repository.upsertSummary({
        sessionId,
        turnFrom: batch.turnFrom,
        turnTo: batch.turnTo,
        summaryText: buildQaFallbackSummaryBody(turns),
        compressor: 'fallback',
        status: 'done',
      });
    }
    this.compressionQueue.enqueue(sessionId, planned);
  }
}

function combineContextMemoryResults(...results: readonly ContextMemoryResult[]): ContextMemoryResult {
  const materials = results.flatMap((result) => result.materials);
  return {
    materials,
    version: results.map((result) => result.version).join(':'),
    diagnostics: {
      source: results.map((result) => result.diagnostics.source).join('+'),
      loadedTurns: results.reduce((sum, result) => sum + result.diagnostics.loadedTurns, 0),
      loadedSummaries: results.reduce((sum, result) => sum + result.diagnostics.loadedSummaries, 0),
      recalledTurns: results.reduce((sum, result) => sum + result.diagnostics.recalledTurns, 0),
      staleItems: results.reduce((sum, result) => sum + result.diagnostics.staleItems, 0),
    },
  };
}

function emptyContextMemory(source: string): ContextMemoryResult {
  return {
    materials: [],
    version: source,
    diagnostics: { source, loadedTurns: 0, loadedSummaries: 0, recalledTurns: 0, staleItems: 0 },
  };
}

function sumMaterialTokens(
  contextMemory: QaMemoryPreparation['contextMemory'],
  zone: 'conversation-summary' | 'conversation-hot',
): number {
  return contextMemory.materials
    .filter((material) => material.zone === zone)
    .reduce((total, material) => total + estimateTokenCount(material.content), 0);
}
