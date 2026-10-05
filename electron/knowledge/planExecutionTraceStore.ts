import { createHash } from 'node:crypto';

export const planExecutionTraceKinds = ['action', 'observation', 'correction'] as const;
export type PlanExecutionTraceKind = typeof planExecutionTraceKinds[number];

export interface PlanExecutionTraceInput {
  planId: string;
  planVersion: number;
  goalId: string;
  kind: PlanExecutionTraceKind;
  tool?: string;
  summary: string;
  evidenceIds?: readonly string[];
}

export interface PlanExecutionTraceEvent extends PlanExecutionTraceInput {
  seq: number;
  traceId: string;
}

export interface PlanExecutionTraceL1Event {
  planId: string;
  planVersion: number;
  goalId: string;
  kind: PlanExecutionTraceKind;
  tool?: string;
  summary: string;
  evidenceIds: string[];
  firstSeq: number;
  lastSeq: number;
  count: number;
}

/**
 * Audit-only execution trace. It accepts controller-produced summaries, never
 * raw tool output. Evidence text remains exclusively in the Evidence Ledger.
 */
export class PlanExecutionTraceStore {
  private events: PlanExecutionTraceEvent[] = [];
  private nextSeq = 1;

  record(input: PlanExecutionTraceInput): PlanExecutionTraceEvent {
    assertTraceInput(input);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds ?? []);
    const summary = normalizeTraceSummary(input.summary);
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const event: PlanExecutionTraceEvent = {
      planId: input.planId,
      planVersion: input.planVersion,
      goalId: input.goalId,
      kind: input.kind,
      ...(input.tool ? { tool: input.tool } : {}),
      summary,
      evidenceIds,
      seq,
      traceId: createTraceId(input.planId, input.planVersion, input.goalId, input.kind, input.tool, summary, seq),
    };
    this.events = [...this.events, event];
    return copyEvent(event);
  }

  list(): PlanExecutionTraceEvent[] {
    return this.events.map(copyEvent);
  }

  throughSeq(seq = Number.MAX_SAFE_INTEGER): PlanExecutionTraceEvent[] {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('trace seq 必须是非负安全整数。');
    return this.events.filter((event) => event.seq <= seq).map(copyEvent);
  }

  get latestSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  /**
   * L1 is deliberately model-free: identical controller observations are
   * folded, evidence IDs are unioned, and active-goal events stay first.
   */
  compactL1(input: {
    planId: string;
    planVersion: number;
    activeGoalId?: string | null;
    throughSeq?: number;
    maxEvents?: number;
  }): PlanExecutionTraceL1Event[] {
    assertPlanIdentity(input.planId, input.planVersion);
    const maxEvents = input.maxEvents ?? 24;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('L1 trace 事件上限无效。');
    const source = this.events.filter((event) => event.planId === input.planId
      && event.planVersion <= input.planVersion
      && (input.throughSeq === undefined || event.seq <= input.throughSeq));
    const folded = new Map<string, PlanExecutionTraceL1Event>();
    for (const event of source) {
      const key = `${event.planVersion}\u0000${event.goalId}\u0000${event.kind}\u0000${event.tool ?? ''}\u0000${event.summary}`;
      const existing = folded.get(key);
      if (existing) {
        existing.lastSeq = event.seq;
        existing.count += 1;
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...event.evidenceIds])].sort(compareText);
      } else {
        folded.set(key, {
          planId: event.planId,
          planVersion: event.planVersion,
          goalId: event.goalId,
          kind: event.kind,
          ...(event.tool ? { tool: event.tool } : {}),
          summary: event.summary,
          evidenceIds: [...event.evidenceIds].sort(compareText),
          firstSeq: event.seq,
          lastSeq: event.seq,
          count: 1,
        });
      }
    }
    const events = [...folded.values()].sort((first, second) => {
      const firstActive = input.activeGoalId !== null && input.activeGoalId !== undefined && first.goalId === input.activeGoalId;
      const secondActive = input.activeGoalId !== null && input.activeGoalId !== undefined && second.goalId === input.activeGoalId;
      return Number(secondActive) - Number(firstActive) || second.lastSeq - first.lastSeq || first.goalId.localeCompare(second.goalId);
    });
    return events.slice(0, maxEvents).map(copyL1Event);
  }
}

function assertTraceInput(input: PlanExecutionTraceInput): void {
  assertPlanIdentity(input.planId, input.planVersion);
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(input.goalId)) throw new Error('trace goalId 格式无效。');
  if (!planExecutionTraceKinds.includes(input.kind)) throw new Error('trace kind 无效。');
  if (input.tool !== undefined && (!input.tool.trim() || input.tool.length > 120)) throw new Error('trace tool 无效。');
  if (!input.summary.trim() || input.summary.length > 1_000) throw new Error('trace summary 必须是受控短摘要。');
}

function assertPlanIdentity(planId: string, planVersion: number): void {
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(planId)) throw new Error('trace planId 格式无效。');
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new Error('trace planVersion 无效。');
}

function normalizeTraceSummary(summary: string): string {
  return summary.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, 360);
}

function normalizeEvidenceIds(evidenceIds: readonly string[]): string[] {
  return [...new Set(evidenceIds.filter((evidenceId) => /^evidence-[a-f0-9]{24}$/u.test(evidenceId)))].sort(compareText);
}

function createTraceId(planId: string, planVersion: number, goalId: string, kind: PlanExecutionTraceKind, tool: string | undefined, summary: string, seq: number): string {
  return `trace-${createHash('sha256').update(`${planId}\u0000${planVersion}\u0000${goalId}\u0000${kind}\u0000${tool ?? ''}\u0000${summary}\u0000${seq}`, 'utf8').digest('hex').slice(0, 24)}`;
}

function copyEvent(event: PlanExecutionTraceEvent): PlanExecutionTraceEvent {
  return { ...event, evidenceIds: [...event.evidenceIds] };
}

function copyL1Event(event: PlanExecutionTraceL1Event): PlanExecutionTraceL1Event {
  return { ...event, evidenceIds: [...event.evidenceIds] };
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
