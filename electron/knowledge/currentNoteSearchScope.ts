/**
 * Runtime-only search scope for current-note retrieval.
 *
 * The model may suggest the mode and coverage policy, but the main-process
 * resolver owns the final value.  Scope is deliberately not part of the
 * persisted SearchPlan shape in phase 1.
 */

export const currentNoteScopeModes = ['focused', 'topic-wide'] as const;
export type CurrentNoteScopeMode = typeof currentNoteScopeModes[number];

export const currentNoteCoveragePolicies = ['sufficient', 'aspect-complete', 'occurrence-complete'] as const;
export type CurrentNoteCoveragePolicy = typeof currentNoteCoveragePolicies[number];
/** Backward-compatible descriptive alias for callers that namespace constants. */
export const currentNoteScopeCoveragePolicies = currentNoteCoveragePolicies;
export type CurrentNoteScopeCoveragePolicy = CurrentNoteCoveragePolicy;

export const currentNoteScopeOrigins = ['user-explicit', 'planner-inferred', 'session-inherited', 'controller-fallback'] as const;
export type CurrentNoteScopeOrigin = typeof currentNoteScopeOrigins[number];

export const currentNoteScopeConfidences = ['high', 'medium', 'low'] as const;
export type CurrentNoteScopeConfidence = typeof currentNoteScopeConfidences[number];

export interface CurrentNoteSearchScope {
  mode: CurrentNoteScopeMode;
  coveragePolicy: CurrentNoteScopeCoveragePolicy;
  targetTopic?: string;
  targetAspects: string[];
  origin: CurrentNoteScopeOrigin;
  confidence: CurrentNoteScopeConfidence;
}

/** Only these fields may be returned by the model. */
export interface CurrentNoteSearchScopePlannerInput {
  mode: CurrentNoteScopeMode;
  coveragePolicy: CurrentNoteScopeCoveragePolicy;
  targetTopic?: string;
  targetAspects?: string[];
}

export class CurrentNoteSearchScopeValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CurrentNoteSearchScopeValidationError';
  }
}

const MAX_TOPIC_LENGTH = 80;
const MAX_ASPECTS = 6;
const MAX_ASPECT_LENGTH = 80;
const MIN_ASPECT_LENGTH = 2;

/**
 * Parses model-facing scope without allowing provenance/confidence or hidden
 * controller fields to cross the process boundary.
 */
export function parseCurrentNoteSearchScopePlannerInput(
  value: unknown,
  question: string,
): CurrentNoteSearchScopePlannerInput {
  assertPlainObject(value, 'Planner scope');
  assertOnlyKeys(value, ['mode', 'coveragePolicy', 'targetTopic', 'targetAspects'], 'Planner scope');
  const mode = readEnum(value.mode, currentNoteScopeModes, 'Planner scope.mode');
  const coveragePolicy = readEnum(value.coveragePolicy, currentNoteCoveragePolicies, 'Planner scope.coveragePolicy');
  if (mode === 'focused' && coveragePolicy !== 'sufficient') {
    fail('focused-coverage', 'focused 范围只能使用 sufficient 覆盖策略。');
  }
  if (coveragePolicy === 'occurrence-complete' && !hasExplicitOccurrenceWording(question)) {
    fail('occurrence-not-explicit', 'occurrence-complete 必须由用户明确要求逐处或全部命中。');
  }
  const targetTopic = value.targetTopic === undefined || value.targetTopic === null
    ? undefined
    : readBoundedText(value.targetTopic, 'Planner scope.targetTopic', 1, MAX_TOPIC_LENGTH);
  const targetAspects = value.targetAspects === undefined ? [] : readAspects(value.targetAspects);
  return {
    mode,
    coveragePolicy,
    ...(targetTopic ? { targetTopic } : {}),
    ...(targetAspects.length ? { targetAspects } : {}),
  };
}

/** Short public name used by verification and future Planner adapters. */
export function parseCurrentNoteSearchScope(value: unknown, question: string): CurrentNoteSearchScopePlannerInput {
  return parseCurrentNoteSearchScopePlannerInput(value, question);
}

/**
 * Resolves user wording first, then a validated Planner suggestion, and lastly
 * a deterministic local fallback.  This function is intended to run in the
 * main process and is the authoritative scope whitelist.
 */
export function resolveCurrentNoteSearchScope(
  question: string,
  plannerInput?: unknown,
): CurrentNoteSearchScope {
  const normalizedQuestion = question.trim();
  const explicit = classifyExplicitUserScope(normalizedQuestion);
  if (explicit) return explicit;

  if (plannerInput !== undefined) {
    const parsed = parseCurrentNoteSearchScopePlannerInput(plannerInput, normalizedQuestion);
    return canonicalizeScope(parsed, 'planner-inferred', 'medium', normalizedQuestion);
  }
  return createFallbackCurrentNoteSearchScope(normalizedQuestion);
}

/** Creates a legal scope without another model call. */
export function createFallbackCurrentNoteSearchScope(question: string): CurrentNoteSearchScope {
  const normalizedQuestion = question.trim();
  const explicit = classifyExplicitUserScope(normalizedQuestion);
  if (explicit) return explicit;
  const topic = inferTopic(normalizedQuestion);
  const targetAspects = inferAspects(normalizedQuestion);
  if (hasExplicitOccurrenceWording(normalizedQuestion)) {
    return canonicalScope({ mode: 'topic-wide', coveragePolicy: 'occurrence-complete', targetTopic: topic, targetAspects }, 'user-explicit', 'high');
  }
  if (hasTopicWideWording(normalizedQuestion)) {
    return canonicalScope({ mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: topic, targetAspects }, 'user-explicit', 'high');
  }
  return canonicalScope({ mode: 'focused', coveragePolicy: 'sufficient', targetTopic: topic, targetAspects }, 'controller-fallback', 'low');
}

export function hasExplicitOccurrenceWording(question: string): boolean {
  return /逐处|逐条列出|每一处|各处|所有[^\n]{0,12}(提到|出现|命中)|全部[^\n]{0,12}(提到|出现|命中)/u.test(question);
}

export function hasTopicWideWording(question: string): boolean {
  return /全部|所有|都讲了什么|各方面|完整列出|全面|全文|全篇/u.test(question);
}

export function isWholeNoteSummaryWording(question: string): boolean {
  return /总结|概括|综述|梳理/u.test(question) && /当前笔记|这篇笔记|全文|整篇|全篇/u.test(question);
}

function classifyExplicitUserScope(question: string): CurrentNoteSearchScope | undefined {
  const topic = inferTopic(question);
  const targetAspects = inferAspects(question);
  if (/只看|只说|仅看|仅说|这一节|本节|该节|这个小节/u.test(question)) {
    return canonicalScope({ mode: 'focused', coveragePolicy: 'sufficient', targetTopic: topic, targetAspects }, 'user-explicit', 'high');
  }
  if (hasExplicitOccurrenceWording(question)) {
    return canonicalScope({ mode: 'topic-wide', coveragePolicy: 'occurrence-complete', targetTopic: topic, targetAspects }, 'user-explicit', 'high');
  }
  if (hasTopicWideWording(question)) {
    return canonicalScope({ mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: topic, targetAspects }, 'user-explicit', 'high');
  }
  return undefined;
}

function canonicalizeScope(
  planner: CurrentNoteSearchScopePlannerInput,
  origin: CurrentNoteScopeOrigin,
  confidence: CurrentNoteScopeConfidence,
  question: string,
): CurrentNoteSearchScope {
  const targetTopic = planner.targetTopic ?? inferTopic(question);
  const targetAspects = planner.targetAspects?.length ? planner.targetAspects : inferAspects(question);
  return canonicalScope({ ...planner, targetTopic, targetAspects }, origin, confidence);
}

function canonicalScope(
  value: Pick<CurrentNoteSearchScope, 'mode' | 'coveragePolicy' | 'targetTopic' | 'targetAspects'>,
  origin: CurrentNoteScopeOrigin,
  confidence: CurrentNoteScopeConfidence,
): CurrentNoteSearchScope {
  return {
    mode: value.mode,
    coveragePolicy: value.coveragePolicy,
    ...(value.targetTopic ? { targetTopic: value.targetTopic } : {}),
    targetAspects: [...(value.targetAspects ?? [])],
    origin,
    confidence,
  };
}

function inferTopic(question: string): string | undefined {
  const identifier = question.match(/\b(?:NER|RAG|RBG|MiniSearch|SQLite|Electron)\b/iu)?.[0];
  if (identifier) return identifier.toUpperCase() === 'MINISEARCH' ? 'MiniSearch' : identifier.toUpperCase();
  const chinese = question.match(/[\u4e00-\u9fff]{2,20}/u)?.[0];
  return chinese && !/当前笔记|这篇笔记|全文|全部|所有/u.test(chinese) ? chinese : undefined;
}

function inferAspects(question: string): string[] {
  const aspects: string[] = [];
  if (/模型.{0,3}分类|分类.{0,3}模型/u.test(question)) aspects.push('模型分类');
  if (/定义|是什么/u.test(question)) aspects.push('定义');
  if (/评估|评价/u.test(question)) aspects.push('评估');
  if (/局限|限制|问题/u.test(question)) aspects.push('局限性');
  return aspects.slice(0, MAX_ASPECTS);
}

function readAspects(value: unknown): string[] {
  if (!Array.isArray(value)) fail('invalid-aspects', 'Planner scope.targetAspects 必须是字符串数组。');
  if (value.length > MAX_ASPECTS) fail('aspect-count', `Planner scope.targetAspects 最多 ${MAX_ASPECTS} 项。`);
  const aspects = value.map((item, index) => readBoundedText(item, `Planner scope.targetAspects[${index}]`, MIN_ASPECT_LENGTH, MAX_ASPECT_LENGTH));
  if (new Set(aspects.map((aspect) => aspect.toLocaleLowerCase())).size !== aspects.length) fail('duplicate-aspect', 'Planner scope.targetAspects 不能重复。');
  return aspects;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-object', `${label} 必须是对象。`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail('unknown-field', `${label} 包含不允许的字段：${key}。`);
}

function readEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('invalid-enum', `${label} 不是允许的枚举值。`);
  return value as T[number];
}

function readBoundedText(value: unknown, label: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid-text', `${label} 必须是字符串。`);
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) fail('text-length', `${label} 长度必须在 ${minLength} 到 ${maxLength} 个字符之间。`);
  return text;
}

function fail(code: string, message: string): never {
  throw new CurrentNoteSearchScopeValidationError(code, message);
}
