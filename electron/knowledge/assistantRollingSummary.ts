import { createHash } from 'node:crypto';
import type { SearchPlan } from './searchPlanTypes';
import { estimateTokenCount } from './tokenEstimator';

export const ROLLING_SUMMARY_SCHEMA_VERSION = 1;
export const DETERMINISTIC_TURN_DIGEST_VERSION = 1;
export const HOT_TERMINAL_TURN_COUNT = 3;
export const MAX_ROLLING_SUMMARY_DIGESTS = 500;
export const MAX_ROLLING_SUMMARY_CHARS = 4_000;

export type RollingTerminalStatus = 'complete' | 'partial' | 'not-found';

export interface PlanOutcomeReference {
  planId: string;
  planVersion: number;
  status: SearchPlan['status'];
  activeGoalId: string | null;
  goals: Array<{ goalId: string; status: SearchPlan['goals'][number]['status']; evidenceCount: number }>;
}

export interface DeterministicTurnDigest {
  digestId: string;
  digestVersion: number;
  turnId: string;
  turnSeq: number;
  contentHash: string;
  status: RollingTerminalStatus;
  question: string;
  answer: string;
  evidenceIds: string[];
  planOutcome?: PlanOutcomeReference;
}

export interface RollingSummaryPayload {
  schemaVersion: typeof ROLLING_SUMMARY_SCHEMA_VERSION;
  contentHash: string;
  coveredThroughSeq: number;
  turnDigests: DeterministicTurnDigest[];
  unresolvedQuestions: string[];
  /** Preserves a v3 string summary alongside digests for backward compatibility. */
  legacyText?: string;
}

export interface RollingSummaryState {
  version: number;
  contentHash: string;
  coveredThroughSeq: number;
  payload: RollingSummaryPayload;
  rendered: string;
  budget: RollingSummaryBudgetMetadata;
}

export interface RollingSummaryBudgetMetadata {
  characterCount: number;
  estimatedTokens: number;
  explicitCharacterLimit: number;
}

export interface DeterministicTurnDigestInput {
  turnId: string;
  turnSeq: number;
  contentHash: string;
  question: string;
  answer: string;
  status: RollingTerminalStatus;
  evidenceIds?: readonly string[];
  plan?: SearchPlan;
}

export function emptyRollingSummaryPayload(contentHash: string, legacyText = ''): RollingSummaryPayload {
  assertContentHash(contentHash);
  return {
    schemaVersion: ROLLING_SUMMARY_SCHEMA_VERSION,
    contentHash,
    coveredThroughSeq: 0,
    turnDigests: [],
    unresolvedQuestions: [],
    ...(legacyText.trim() ? { legacyText: legacyText.trim().slice(-MAX_ROLLING_SUMMARY_CHARS) } : {}),
  };
}

/** No provider call: the digest is a bounded, reproducible projection of a finished turn. */
export function createDeterministicTurnDigest(input: DeterministicTurnDigestInput): DeterministicTurnDigest {
  assertTurnIdentity(input.turnId, input.turnSeq, input.contentHash);
  if (!input.question.trim() || input.question.length > 2_000) throw new Error('turn digest 问题长度无效。');
  if (!input.answer.trim() || input.answer.length > 20_000) throw new Error('turn digest 回答长度无效。');
  if (!['complete', 'partial', 'not-found'].includes(input.status)) throw new Error('turn digest 终态无效。');
  const question = normalizeDigestText(input.question, 480);
  const answer = normalizeDigestText(input.answer, 1_200);
  const evidenceIds = [...new Set((input.evidenceIds ?? []).filter((value) => typeof value === 'string' && value.trim()))].sort(compareText);
  const digest: DeterministicTurnDigest = {
    digestId: createDigestId(input.turnId, input.turnSeq, input.contentHash, input.status, question, answer, evidenceIds),
    digestVersion: DETERMINISTIC_TURN_DIGEST_VERSION,
    turnId: input.turnId,
    turnSeq: input.turnSeq,
    contentHash: input.contentHash,
    status: input.status,
    question,
    answer,
    evidenceIds,
    ...(input.plan ? { planOutcome: createPlanOutcomeReference(input.plan) } : {}),
  };
  return cloneDigest(digest);
}

export function mergeRollingSummaryPayload(
  current: RollingSummaryPayload,
  contentHash: string,
  digests: readonly DeterministicTurnDigest[],
): RollingSummaryPayload {
  assertRollingSummaryPayload(current);
  assertContentHash(contentHash);
  const base = current.contentHash === contentHash ? current : emptyRollingSummaryPayload(contentHash);
  const byTurn = new Map(base.turnDigests.map((digest) => [digest.turnId, cloneDigest(digest)]));
  const unresolved = new Map(base.unresolvedQuestions.map((question) => [normalizeQuestion(question), question]));
  let coveredThroughSeq = base.contentHash === contentHash ? base.coveredThroughSeq : 0;
  for (const digest of digests) {
    if (digest.contentHash !== contentHash) throw new Error('turn digest contentHash 与滚动摘要不一致。');
    assertDeterministicTurnDigest(digest);
    byTurn.set(digest.turnId, cloneDigest(digest));
    coveredThroughSeq = Math.max(coveredThroughSeq, digest.turnSeq);
    const questionKey = normalizeQuestion(digest.question);
    if (digest.status === 'complete') unresolved.delete(questionKey);
    else unresolved.set(questionKey, digest.question);
  }
  const turnDigests = [...byTurn.values()].sort((first, second) => first.turnSeq - second.turnSeq || first.turnId.localeCompare(second.turnId)).slice(-MAX_ROLLING_SUMMARY_DIGESTS);
  return {
    schemaVersion: ROLLING_SUMMARY_SCHEMA_VERSION,
    contentHash,
    coveredThroughSeq,
    turnDigests,
    unresolvedQuestions: [...unresolved.values()].sort(compareText).slice(-20),
    ...(base.legacyText ? { legacyText: base.legacyText } : {}),
  };
}

export function renderRollingSummary(payload: RollingSummaryPayload, maxChars = MAX_ROLLING_SUMMARY_CHARS): string {
  assertRollingSummaryPayload(payload);
  const blocks: string[] = [];
  if (payload.legacyText) blocks.push(payload.legacyText);
  for (const digest of payload.turnDigests) {
    const outcome = digest.planOutcome ? `；plan=${digest.planOutcome.planId}@v${digest.planOutcome.planVersion}/${digest.planOutcome.status}` : '';
    blocks.push(`轮次 ${digest.turnSeq}（${digest.status}${outcome}）\n问：${digest.question}\n答：${digest.answer}${digest.evidenceIds.length ? `\n证据：${digest.evidenceIds.join(',')}` : ''}`);
  }
  if (payload.unresolvedQuestions.length) blocks.push(`待跟进问题：${payload.unresolvedQuestions.join('；')}`);
  return blocks.join('\n\n').slice(-maxChars);
}

/**
 * Prompt-facing current-note memory contains conversation semantics only.
 * Persisted plan/evidence references remain available to their repositories,
 * but never become an alternative SearchPlan or Evidence Ledger fact source.
 */
export function renderConversationMemorySummary(payload: RollingSummaryPayload, maxChars = MAX_ROLLING_SUMMARY_CHARS): string {
  assertRollingSummaryPayload(payload);
  const blocks: string[] = [];
  if (payload.legacyText) blocks.push(payload.legacyText);
  for (const digest of payload.turnDigests) {
    blocks.push(`轮次 ${digest.turnSeq}（${digest.status}）\n问：${digest.question}\n答：${digest.answer}`);
  }
  if (payload.unresolvedQuestions.length) blocks.push(`待跟进问题：${payload.unresolvedQuestions.join('；')}`);
  return blocks.join('\n\n').slice(-maxChars);
}

/** Budget metadata is explicit so later prompt adapters never infer an 800-char hot-message limit. */
export function createRollingSummaryBudgetMetadata(rendered: string): RollingSummaryBudgetMetadata {
  return {
    characterCount: Array.from(rendered).length,
    estimatedTokens: estimateTokenCount(rendered),
    explicitCharacterLimit: MAX_ROLLING_SUMMARY_CHARS,
  };
}

export function parseRollingSummaryPayload(value: string, contentHash: string, legacyText = ''): RollingSummaryPayload {
  assertContentHash(contentHash);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    const payload = parsed as RollingSummaryPayload;
    assertRollingSummaryPayload(payload);
    if (payload.contentHash !== contentHash) return emptyRollingSummaryPayload(contentHash);
    return clonePayload(payload);
  } catch {
    return emptyRollingSummaryPayload(contentHash, legacyText);
  }
}

export function assertRollingSummaryPayload(payload: RollingSummaryPayload): void {
  if (!payload || payload.schemaVersion !== ROLLING_SUMMARY_SCHEMA_VERSION
    || !Number.isSafeInteger(payload.coveredThroughSeq) || payload.coveredThroughSeq < 0
    || !Array.isArray(payload.turnDigests) || payload.turnDigests.length > MAX_ROLLING_SUMMARY_DIGESTS
    || !Array.isArray(payload.unresolvedQuestions) || payload.unresolvedQuestions.length > 20
    || (payload.legacyText !== undefined && (typeof payload.legacyText !== 'string' || payload.legacyText.length > MAX_ROLLING_SUMMARY_CHARS))) {
    throw new Error('滚动摘要 payload 无效。');
  }
  assertContentHash(payload.contentHash);
  for (const digest of payload.turnDigests) assertDeterministicTurnDigest(digest);
  if (payload.turnDigests.some((digest) => digest.contentHash !== payload.contentHash || digest.turnSeq > payload.coveredThroughSeq)) throw new Error('滚动摘要覆盖序号或 contentHash 无效。');
}

function assertDeterministicTurnDigest(digest: DeterministicTurnDigest): void {
  assertTurnIdentity(digest.turnId, digest.turnSeq, digest.contentHash);
  if (digest.digestVersion !== DETERMINISTIC_TURN_DIGEST_VERSION || !digest.digestId.startsWith('turn-digest-')
    || !['complete', 'partial', 'not-found'].includes(digest.status)
    || !digest.question.trim() || digest.question.length > 480
    || !digest.answer.trim() || digest.answer.length > 1_200
    || !Array.isArray(digest.evidenceIds) || digest.evidenceIds.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('确定性 turn digest 无效。');
  if (digest.planOutcome) {
    if (!digest.planOutcome.planId.trim() || !Number.isSafeInteger(digest.planOutcome.planVersion) || digest.planOutcome.planVersion < 1
      || !Array.isArray(digest.planOutcome.goals) || digest.planOutcome.goals.some((goal) => !goal.goalId.trim() || !Number.isSafeInteger(goal.evidenceCount) || goal.evidenceCount < 0)) throw new Error('turn digest 的 plan outcome 引用无效。');
  }
}

function createPlanOutcomeReference(plan: SearchPlan): PlanOutcomeReference {
  return {
    planId: plan.planId,
    planVersion: plan.version,
    status: plan.status,
    activeGoalId: plan.activeGoalId,
    goals: plan.goals.map((goal) => ({
      goalId: goal.goalId,
      status: goal.status,
      evidenceCount: new Set([
        ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
        ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
      ]).size,
    })),
  };
}

function assertTurnIdentity(turnId: string, turnSeq: number, contentHash: string): void {
  if (!turnId.trim() || !Number.isSafeInteger(turnSeq) || turnSeq < 1) throw new Error('turn digest 标识无效。');
  assertContentHash(contentHash);
}

function assertContentHash(contentHash: string): void {
  // Existing databases and fixtures may use an opaque content-hash token;
  // production snapshots still provide the full SHA-256 value.
  if (typeof contentHash !== 'string' || !contentHash.trim() || contentHash.length > 256) throw new Error('滚动摘要 contentHash 无效。');
}

function normalizeDigestText(value: string, maxChars: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function normalizeQuestion(value: string): string {
  return normalizeDigestText(value, 480).toLocaleLowerCase('zh-CN');
}

function createDigestId(turnId: string, turnSeq: number, contentHash: string, status: RollingTerminalStatus, question: string, answer: string, evidenceIds: readonly string[]): string {
  return `turn-digest-${sha256([turnId, turnSeq, contentHash, status, question, answer, ...evidenceIds].join('\u0000')).slice(0, 24)}`;
}

function cloneDigest(digest: DeterministicTurnDigest): DeterministicTurnDigest {
  return { ...digest, evidenceIds: [...digest.evidenceIds], ...(digest.planOutcome ? { planOutcome: { ...digest.planOutcome, goals: digest.planOutcome.goals.map((goal) => ({ ...goal })) } } : {}) };
}

function clonePayload(payload: RollingSummaryPayload): RollingSummaryPayload {
  return { ...payload, turnDigests: payload.turnDigests.map(cloneDigest), unresolvedQuestions: [...payload.unresolvedQuestions] };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
