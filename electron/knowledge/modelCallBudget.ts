import type { PromptCallKind } from './currentNoteContextBudget';

export type ModelCallKind = PromptCallKind;
export type ModelCallBudgetKind = 'react-turn' | 'summary-run' | 'shadow' | 'maintenance-job';

export interface ModelCallTicket {
  ticketId: string;
  callKind: ModelCallKind;
  budgetKind: ModelCallBudgetKind;
  modelCallOrdinal: number;
  remainingModelCallsAfterSend: number;
  /** Absent when the caller explicitly allows the turn to run until cancellation. */
  deadlineAt?: number;
  finalSynthesisReserved: boolean;
  retryOfTicketId?: string;
}

export interface ModelCallBudgetGateOptions {
  maxModelCalls: number;
  startedAt?: number;
  /** Omit to disable the wall-clock deadline while retaining the call-count budget. */
  maxWallTimeMs?: number;
}

/**
 * Reserves model calls without giving prompt sizing code permission to mint
 * retries. Unsent tickets can be cancelled; once marked sent they consume the
 * ordinal even when the provider later rejects the request.
 */
export class ModelCallBudgetGate {
  private readonly maxModelCalls: number;
  private readonly deadlineAt?: number;
  private modelCallsUsed = 0;
  private nextTicketOrdinal = 0;
  private readonly pending = new Map<string, ModelCallTicket>();

  constructor(options: ModelCallBudgetGateOptions) {
    if (!Number.isSafeInteger(options.maxModelCalls) || options.maxModelCalls < 1) throw new Error('模型调用上限必须是正整数。');
    if (options.maxWallTimeMs !== undefined && (!Number.isSafeInteger(options.maxWallTimeMs) || options.maxWallTimeMs < 1)) throw new Error('模型调用墙钟预算必须是正整数。');
    this.maxModelCalls = options.maxModelCalls;
    this.deadlineAt = options.maxWallTimeMs === undefined
      ? undefined
      : (options.startedAt ?? Date.now()) + options.maxWallTimeMs;
  }

  get modelCalls(): number { return this.modelCallsUsed; }
  get maxCalls(): number { return this.maxModelCalls; }
  get deadlineAtMs(): number | undefined { return this.deadlineAt; }
  get remainingModelCalls(): number { return Math.max(0, this.maxModelCalls - this.modelCallsUsed - this.pending.size); }
  get finalSynthesisReserved(): boolean { return this.hasPendingOrRemainingFinalTicket(); }

  reserve(input: { callKind: ModelCallKind; budgetKind: ModelCallBudgetKind; retryOfTicketId?: string }): ModelCallTicket | undefined {
    if (this.deadlineAt !== undefined && Date.now() > this.deadlineAt) return undefined;
    const reservedBefore = this.modelCallsUsed + this.pending.size;
    const remainingAfterSend = this.maxModelCalls - reservedBefore - 1;
    // Only calls which can be followed by more ReAct work must preserve the
    // final synthesis slot. Route/chat/direct calls are terminal calls even
    // though they share the turn gate with the current-note agent.
    const requiresFinalReserve = input.budgetKind === 'react-turn'
      && (input.callKind === 'plan' || input.callKind === 'decide');
    if (remainingAfterSend < 0 || (requiresFinalReserve && remainingAfterSend < 1)) return undefined;

    const ticketId = `model-ticket-${++this.nextTicketOrdinal}`;
    const ticket: ModelCallTicket = {
      ticketId,
      callKind: input.callKind,
      budgetKind: input.budgetKind,
      modelCallOrdinal: reservedBefore + 1,
      remainingModelCallsAfterSend: remainingAfterSend,
      finalSynthesisReserved: requiresFinalReserve && remainingAfterSend >= 1,
      ...(this.deadlineAt !== undefined ? { deadlineAt: this.deadlineAt } : {}),
      ...(input.retryOfTicketId ? { retryOfTicketId: input.retryOfTicketId } : {}),
    };
    this.pending.set(ticketId, ticket);
    return ticket;
  }

  markSent(ticket: ModelCallTicket): void {
    const pending = this.pending.get(ticket.ticketId);
    if (!pending) throw new Error('模型调用票据不存在或已提交。');
    this.pending.delete(ticket.ticketId);
    this.modelCallsUsed += 1;
  }

  cancelUnsent(ticket: ModelCallTicket): void {
    this.pending.delete(ticket.ticketId);
  }

  isWithinDeadline(): boolean { return this.deadlineAt === undefined || Date.now() <= this.deadlineAt; }

  private hasPendingOrRemainingFinalTicket(): boolean {
    return this.maxModelCalls - (this.modelCallsUsed + this.pending.size) >= 1;
  }
}
