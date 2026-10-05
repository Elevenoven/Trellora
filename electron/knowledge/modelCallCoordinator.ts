import { ModelCallBudgetGate, type ModelCallBudgetKind, type ModelCallKind, type ModelCallTicket } from './modelCallBudget';
import { PromptBudgetScheduler, type PromptBudgetPlan } from './currentNoteContextBudget';
import type { AiProviderKind } from './aiTypes';
import { sharedTokenCalibrationStore, type TokenCalibrationStore } from './tokenCalibration';
import type { EvidencePromptManifest } from './assistantTurnTypes';

export type ModelCallPreparationFailure = 'model-budget' | 'context-budget' | 'timeout';

export class ModelCallPreparationError extends Error {
  readonly code = 'MODEL_CALL_NOT_AUTHORIZED';
  readonly reason: ModelCallPreparationFailure;

  constructor(reason: ModelCallPreparationFailure) {
    super(reason === 'context-budget'
      ? '当前模型窗口不足，未发送模型请求。'
      : reason === 'timeout' ? '模型调用已超时或取消，未发送模型请求。' : '当前模型调用预算已用尽，未发送模型请求。');
    this.reason = reason;
    this.name = 'ModelCallPreparationError';
  }
}

export interface PreparedModelCall {
  ticket: ModelCallTicket;
  plan: PromptBudgetPlan;
}

export interface ModelCallPreparationResult {
  ready: true;
  call: PreparedModelCall;
}

export interface ModelCallPreparationRejected {
  ready: false;
  reason: ModelCallPreparationFailure;
}

export interface EvidenceCompressionPreparationInput {
  prompt: string;
  serializedBudgetText?: string;
  requestEnvelopeVersion?: string;
  requestedMaxOutputTokens?: number;
  providerMaxOutputTokens?: number;
}

/**
 * The only shared authorization helper for assistant model sends. It performs
 * the ticket reservation and complete-prompt sizing in one operation; callers
 * must not invoke a provider unless this returns ready=true.
 */
export class ModelCallCoordinator {
  readonly gate: ModelCallBudgetGate;
  private readonly scheduler: PromptBudgetScheduler;
  private readonly contextWindowTokens?: number;
  private readonly budgetKind: ModelCallBudgetKind;
  private readonly tokenCalibrationStore: TokenCalibrationStore;
  private readonly providerKind?: AiProviderKind;
  private readonly model?: string;
  private readonly maxEvidenceCompressionCalls: number;
  private readonly finalSynthesisReserveMs: number;
  private evidenceCompressionCallCount = 0;

  constructor(
    gate: ModelCallBudgetGate,
    contextWindowTokens?: number,
    budgetKind: ModelCallBudgetKind = 'react-turn',
    scheduler = new PromptBudgetScheduler(),
    options: { providerKind?: AiProviderKind; model?: string; tokenCalibrationStore?: TokenCalibrationStore; maxEvidenceCompressionCalls?: number; finalSynthesisReserveMs?: number } = {},
  ) {
    this.gate = gate;
    this.contextWindowTokens = contextWindowTokens;
    this.budgetKind = budgetKind;
    this.scheduler = scheduler;
    this.providerKind = options.providerKind;
    this.model = options.model;
    this.tokenCalibrationStore = options.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    this.maxEvidenceCompressionCalls = options.maxEvidenceCompressionCalls ?? 5;
    this.finalSynthesisReserveMs = options.finalSynthesisReserveMs ?? 0;
    if (!Number.isSafeInteger(this.maxEvidenceCompressionCalls) || this.maxEvidenceCompressionCalls < 1) throw new Error('证据压缩调用上限必须是正整数。');
    if (!Number.isSafeInteger(this.finalSynthesisReserveMs) || this.finalSynthesisReserveMs < 0) throw new Error('最终合成保留时间必须是非负整数。');
  }

  get evidenceCompressionCallsUsed(): number {
    return this.evidenceCompressionCallCount;
  }

  getCalibrationMultiplier(callKind: ModelCallKind, requestEnvelopeVersion?: string): number {
    return this.providerKind && this.model
      ? this.tokenCalibrationStore.getMultiplier({
        providerKind: this.providerKind,
        model: this.model,
        callKind,
        requestEnvelopeVersion,
      })
      : 1;
  }

  /** Stage 4 uses the existing total-call/deadline gate without wiring compression into Agent synthesis. */
  prepareEvidenceCompression(input: EvidenceCompressionPreparationInput): ModelCallPreparationResult | ModelCallPreparationRejected {
    if (this.evidenceCompressionCallCount >= this.maxEvidenceCompressionCalls) return { ready: false, reason: 'model-budget' };
    const deadlineAt = this.gate.deadlineAtMs;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt - this.finalSynthesisReserveMs) return { ready: false, reason: 'timeout' };
    const prepared = this.prepare({
      // Compression is an intermediate derivation call. Reuse the existing
      // non-terminal gate kind so a final synthesis slot remains reserved.
      callKind: 'decide',
      prompt: input.prompt,
      ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
      ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      providerMaxOutputTokens: input.providerMaxOutputTokens,
    });
    if (prepared.ready) this.evidenceCompressionCallCount += 1;
    return prepared;
  }

  prepare(input: {
    callKind: ModelCallKind;
    prompt: string;
    serializedBudgetText?: string;
    requestEnvelopeVersion?: string;
    retryOfTicketId?: string;
    requestedMaxOutputTokens?: number;
    providerMaxOutputTokens?: number;
    evidencePromptManifest?: EvidencePromptManifest;
  }): ModelCallPreparationResult | ModelCallPreparationRejected {
    const ticket = this.gate.reserve({
      callKind: input.callKind,
      budgetKind: this.budgetKind,
      ...(input.retryOfTicketId ? { retryOfTicketId: input.retryOfTicketId } : {}),
    });
    if (!ticket) {
      return { ready: false, reason: this.gate.isWithinDeadline() ? 'model-budget' : 'timeout' };
    }
    const plan = this.scheduler.plan({
      prompt: input.prompt,
      ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
      ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
      contextWindowTokens: this.contextWindowTokens,
      callKind: input.callKind,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      providerMaxOutputTokens: input.providerMaxOutputTokens,
      calibrationMultiplier: this.getCalibrationMultiplier(input.callKind, input.requestEnvelopeVersion),
    });
    if (!plan.fits) {
      this.gate.cancelUnsent(ticket);
      return { ready: false, reason: 'context-budget' };
    }
    if (input.evidencePromptManifest) {
      try {
        assertEvidencePromptManifest(input.evidencePromptManifest, plan);
      } catch (error) {
        this.gate.cancelUnsent(ticket);
        throw error;
      }
    }
    // A provider rejection still consumes the call. Mark before crossing the
    // provider boundary so overflow and invalid JSON cannot mint a refund.
    this.gate.markSent(ticket);
    return { ready: true, call: { ticket, plan } };
  }
}

export interface MaintenanceModelCallCoordinatorOptions {
  maxConcurrent?: number;
  maxModelCallsPerJob?: number;
  maxWallTimeMs?: number;
  scheduler?: PromptBudgetScheduler;
  tokenCalibrationStore?: TokenCalibrationStore;
}

export interface MaintenanceModelCallRunInput<T> {
  jobId: string;
  sessionId?: string;
  callKind: Extract<ModelCallKind, 'memory-compress' | 'conversation-maintenance' | 'follow-up-suggest' | 'user-profile-extract'>;
  prompt: string;
  serializedBudgetText?: string;
  requestEnvelopeVersion?: string;
  contextWindowTokens: number;
  providerKind?: AiProviderKind;
  model: string;
  requestedMaxOutputTokens?: number;
  providerMaxOutputTokens?: number;
  signal?: AbortSignal;
  execute: (input: { call: PreparedModelCall; signal: AbortSignal }) => Promise<T>;
}

export interface MaintenanceModelCallStats {
  queued: number;
  active: number;
  sent: number;
  failed: number;
  cancelled: number;
}

interface MaintenanceWaiter {
  sessionId?: string;
  resolve: (granted: boolean) => void;
}

/**
 * Low-concurrency model lane for background work. Each job gets its own gate,
 * deadline, and abort scope, so maintenance cannot consume an interactive
 * ReAct ticket or extend the current answer's wall-clock budget.
 */
export class MaintenanceModelCallCoordinator {
  private readonly maxConcurrent: number;
  private readonly maxModelCallsPerJob: number;
  private readonly maxWallTimeMs: number;
  private readonly scheduler: PromptBudgetScheduler;
  private readonly tokenCalibrationStore: TokenCalibrationStore;
  private readonly waiters: MaintenanceWaiter[] = [];
  private readonly controllers = new Map<string, { sessionId?: string; controller: AbortController }>();
  private readonly cancelledSessions = new Set<string>();
  private active = 0;
  private sent = 0;
  private failed = 0;
  private cancelled = 0;
  private stopped = false;

  constructor(options: MaintenanceModelCallCoordinatorOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxModelCallsPerJob = options.maxModelCallsPerJob ?? 1;
    this.maxWallTimeMs = options.maxWallTimeMs ?? 30_000;
    this.scheduler = options.scheduler ?? new PromptBudgetScheduler();
    this.tokenCalibrationStore = options.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    assertPositiveInteger(this.maxConcurrent, '维护调用并发上限');
    assertPositiveInteger(this.maxModelCallsPerJob, '维护任务调用上限');
    assertPositiveInteger(this.maxWallTimeMs, '维护任务墙钟预算');
  }

  getStats(): MaintenanceModelCallStats {
    return {
      queued: this.waiters.length,
      active: this.active,
      sent: this.sent,
      failed: this.failed,
      cancelled: this.cancelled,
    };
  }

  async run<T>(input: MaintenanceModelCallRunInput<T>): Promise<T> {
    if (!input.jobId.trim()) throw new Error('维护任务标识不能为空。');
    if (this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) throw createMaintenanceAbortError();
    await this.acquire(input.sessionId);
    if (this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) {
      this.release();
      throw createMaintenanceAbortError();
    }

    const controller = new AbortController();
    this.controllers.set(input.jobId, { ...(input.sessionId ? { sessionId: input.sessionId } : {}), controller });
    const timeoutSignal = AbortSignal.timeout(this.maxWallTimeMs);
    const signal = input.signal
      ? AbortSignal.any([controller.signal, timeoutSignal, input.signal])
      : AbortSignal.any([controller.signal, timeoutSignal]);
    const gate = new ModelCallBudgetGate({ maxModelCalls: this.maxModelCallsPerJob, maxWallTimeMs: this.maxWallTimeMs });
    const coordinator = new ModelCallCoordinator(gate, input.contextWindowTokens, 'maintenance-job', this.scheduler, {
      providerKind: input.providerKind,
      model: input.model,
      tokenCalibrationStore: this.tokenCalibrationStore,
    });
    try {
      const prepared = coordinator.prepare({
        callKind: input.callKind,
        prompt: input.prompt,
        ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
        ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
        requestedMaxOutputTokens: input.requestedMaxOutputTokens,
        providerMaxOutputTokens: input.providerMaxOutputTokens,
      });
      if (!prepared.ready) throw new ModelCallPreparationError(prepared.reason);
      this.sent += 1;
      return await input.execute({ call: prepared.call, signal });
    } catch (error) {
      if (signal.aborted || this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) this.cancelled += 1;
      else this.failed += 1;
      throw error;
    } finally {
      this.controllers.delete(input.jobId);
      this.release();
    }
  }

  cancelSession(sessionId: string): void {
    if (!sessionId.trim()) return;
    this.cancelledSessions.add(sessionId);
    for (const entry of this.controllers.values()) {
      if (entry.sessionId === sessionId) entry.controller.abort();
    }
    this.drain();
  }

  abortAll(): void {
    this.stopped = true;
    for (const entry of this.controllers.values()) entry.controller.abort();
    while (this.waiters.length) this.waiters.shift()?.resolve(false);
  }

  private async acquire(sessionId?: string): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    const granted = await new Promise<boolean>((resolve) => this.waiters.push({ ...(sessionId ? { sessionId } : {}), resolve }));
    if (!granted) throw createMaintenanceAbortError();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (this.stopped || waiter.sessionId && this.cancelledSessions.has(waiter.sessionId)) {
        waiter.resolve(false);
        continue;
      }
      this.active += 1;
      waiter.resolve(true);
    }
  }
}

function assertEvidencePromptManifest(manifest: EvidencePromptManifest, plan: PromptBudgetPlan): void {
  const retrieved = new Set(manifest.turnRetrievedEvidenceIds);
  const represented = new Set(manifest.representedEvidenceIds);
  if (manifest.missingEvidenceIds.length !== 0
    || retrieved.size !== represented.size
    || [...retrieved].some((evidenceId) => !represented.has(evidenceId))
    || manifest.representationCoverage !== 1) {
    throw new Error('最终模型发送前的 EvidencePromptManifest 未达到 100% 表示覆盖。');
  }
  if (plan.predictedPromptTokens > plan.maxPromptTokens) {
    throw new Error('最终模型发送前的完整 Prompt 超出 maxPromptTokens。');
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
}

function createMaintenanceAbortError(): Error {
  const error = new Error('维护模型任务已取消。');
  error.name = 'AbortError';
  return error;
}
