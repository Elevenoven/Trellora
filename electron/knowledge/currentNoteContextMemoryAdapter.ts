import { createHash } from 'node:crypto';
import type { AssistantConversationMessage } from './assistantTurnTypes';
import { createContextEnvelope } from './contextEnvelope';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
} from './contextMemoryTypes';
import { renderContextEnvelope } from './contextRenderer';
import type {
  AssistantContextRuntimeMode,
  AssistantModelRuntimeProfile,
  ContextCompressStrategy,
  ContextEnvelope,
  ContextEnvelopeScope,
  ContextMaterial,
  ContextProjection,
} from './contextRuntimeTypes';
import {
  isCurrentNoteMemoryConversationMessage,
  type CurrentNoteMemoryConversationMessage,
} from './noteConversationMemory';
import { ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS } from '../../shared/assistantContextBudget';
import { estimateTokenCount } from './tokenEstimator';
import { assertReactConversationMemoryBoundary } from './reactResidualMemoryReview';

export const CURRENT_NOTE_CONTEXT_REQUEST_ENVELOPE_VERSION = 'context-envelope-v1-current-note-phase4';

export interface CurrentNoteMemoryBudgets {
  summaryTokens: number;
  hotTokens: number;
  recallTokens: 0;
}

export interface CurrentNotePromptSegmentLike {
  id: string;
  zone: string;
  text: string;
  estimatedTokens: number;
  priority: number;
  protected: boolean;
  compressStrategy: string;
  sourceIds?: string[];
  goalIds?: string[];
  requirementIds?: string[];
  evidenceIds?: string[];
  snapshotId?: string;
  contentHash?: string;
}

export interface CurrentNoteContextRuntimeInput {
  mode: AssistantContextRuntimeMode;
  scope: ContextEnvelopeScope;
  windowProfile: AssistantModelRuntimeProfile;
  memory: ContextMemoryResult;
  stateVector: ContextEnvelope['stateVector'];
}

export interface CurrentNoteContextProjectionAssembly {
  envelope: ContextEnvelope;
  projection: ContextProjection;
  activePrompt: string;
}

interface HotTurnGroup {
  key: string;
  sourceId: string;
  sourceVersion: string;
  turnSeq?: number;
  messages: AssistantConversationMessage[];
}

/** Current Note uses a bounded M1/M2 allocation without changing repository data. */
export function resolveCurrentNoteMemoryBudgets(contextWindowTokens = ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS): CurrentNoteMemoryBudgets {
  const windowTokens = Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
    ? contextWindowTokens
    : ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
  return {
    summaryTokens: Math.min(4_096, Math.max(512, Math.floor(windowTokens * 0.25))),
    hotTokens: Math.min(4_096, Math.max(512, Math.floor(windowTokens * 0.25))),
    recallTokens: 0,
  };
}

/**
 * Adapts repository-tagged conversation output to independent M1/M2 materials.
 * It performs no SQL and never mixes plans, claims, or evidence into history.
 */
export class CurrentNoteContextMemoryAdapter implements ContextMemoryAdapter {
  readonly id = 'current-note-memory';

  constructor(private readonly conversation: readonly AssistantConversationMessage[]) {}

  supports(request: ContextMemoryRequest): boolean {
    return request.route === 'current-note';
  }

  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    if (!this.supports(request)) throw new Error(`Current Note Memory Adapter 不支持 Route：${request.route}`);
    const expectedContentHash = request.contentHash?.trim();
    const tagged = this.conversation.filter(isCurrentNoteMemoryConversationMessage);
    const staleTagged = expectedContentHash
      ? tagged.filter((message) => message.memory.contentHash !== expectedContentHash)
      : [];
    const currentMessages = expectedContentHash
      ? this.conversation.filter((message) => !isCurrentNoteMemoryConversationMessage(message)
        || message.memory.contentHash === expectedContentHash)
      : [...this.conversation];
    const summaryMessages = currentMessages.filter(isSummaryMessage);
    const summary = summaryMessages.at(-1);
    const summaryContent = summary
      ? truncateByEstimatedTokens(summary.content, normalizeBudget(request.budgets.summaryTokens), 'tail')
      : '';
    const hotGroups = groupHotTurns(currentMessages.filter((message) => !isSummaryMessage(message)));
    const selectedHot = selectHotTurns(hotGroups, normalizeBudget(request.budgets.hotTokens));
    const materials: ContextMaterial[] = [];

    if (summary && summaryContent) {
      const metadata = memoryMetadata(summary);
      materials.push({
        id: `current-note-summary:${metadata.sourceId}`,
        zone: 'conversation-summary',
        channel: 'user',
        trust: 'untrusted-memory',
        content: summaryContent,
        priority: 60,
        protected: false,
        compressStrategy: 'summary',
        source: {
          kind: 'current-note-rolling-summary',
          id: metadata.sourceId,
          version: metadata.sourceVersion,
          ...(expectedContentHash ? { contentHash: expectedContentHash } : {}),
        },
        tokenBudget: { absoluteMax: normalizeBudget(request.budgets.summaryTokens) },
        stalePolicy: 'invalidate',
        overflowPolicy: 'compress',
        provenance: {
          sessionId: request.sessionId,
          ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
          ...(expectedContentHash ? { contentHash: expectedContentHash } : {}),
        },
        cache: { stability: 'session', prefixEligible: false },
      });
    }

    for (const turn of selectedHot) {
      materials.push({
        id: `current-note-hot:${turn.key}`,
        zone: 'conversation-hot',
        channel: 'user',
        trust: 'untrusted-memory',
        content: turn.content,
        priority: 70,
        protected: false,
        compressStrategy: 'truncate',
        source: {
          kind: 'current-note-turn',
          id: turn.sourceId,
          version: turn.sourceVersion,
          ...(expectedContentHash ? { contentHash: expectedContentHash } : {}),
        },
        tokenBudget: { absoluteMax: normalizeBudget(request.budgets.hotTokens) },
        stalePolicy: 'invalidate',
        overflowPolicy: 'compress',
        provenance: {
          sessionId: request.sessionId,
          ...(turn.turnSeq !== undefined ? { turnSeqs: [turn.turnSeq] } : {}),
          ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
          ...(expectedContentHash ? { contentHash: expectedContentHash } : {}),
        },
        cache: { stability: 'session', prefixEligible: false },
      });
    }

    assertReactConversationMemoryBoundary('current-note', materials);
    return {
      materials,
      version: createMemoryVersion(request, materials),
      diagnostics: {
        source: this.id,
        loadedTurns: selectedHot.length,
        loadedSummaries: summaryContent ? 1 : 0,
        recalledTurns: 0,
        staleItems: staleTagged.length,
      },
    };
  }
}

/** Converts an adapter Material back to the existing segment abstraction before compaction. */
export function currentNoteMemoryMaterialToPromptSegment(material: ContextMaterial): CurrentNotePromptSegmentLike {
  return {
    id: material.id,
    zone: material.zone,
    text: material.content,
    estimatedTokens: estimateTokenCount(material.content),
    priority: material.priority,
    protected: material.protected,
    compressStrategy: contextCompressionToPrompt(material.compressStrategy),
    ...(material.provenance?.sourceIds ? { sourceIds: [...material.provenance.sourceIds] } : {}),
    ...(material.provenance?.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
    ...(material.provenance?.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
    ...(material.provenance?.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
    ...(material.provenance?.snapshotId ? { snapshotId: material.provenance.snapshotId } : {}),
    ...(material.provenance?.contentHash ? { contentHash: material.provenance.contentHash } : {}),
  };
}

/** One-way PromptSegment -> ContextMaterial -> ContextProjection compatibility path. */
export function projectCurrentNotePromptSegments(
  callKind: ContextEnvelope['callKind'],
  segments: readonly CurrentNotePromptSegmentLike[],
  runtime: CurrentNoteContextRuntimeInput,
  pressureLevel: ContextProjection['pressureLevel'],
): CurrentNoteContextProjectionAssembly {
  const memoryById = new Map(runtime.memory.materials.map((material) => [material.id, material]));
  const materials = segments.map((segment) => promptSegmentToContextMaterial(
    segment,
    runtime,
    memoryById.get(segment.id),
  ));
  const envelope = createContextEnvelope({
    route: 'current-note',
    callKind,
    scope: runtime.scope,
    windowProfile: runtime.windowProfile,
    materials,
    invariants: [
      'trust-channel-v1',
      'protected-material-v1',
      'stable-prefix-v1',
      'current-note-snapshot-v1',
      'current-note-evidence-manifest-v1',
    ],
    stateVector: runtime.stateVector,
  });
  const rendered = renderContextEnvelope(envelope, {
    requestEnvelopeVersion: CURRENT_NOTE_CONTEXT_REQUEST_ENVELOPE_VERSION,
  });
  const projection: ContextProjection = { ...rendered, pressureLevel };
  return {
    envelope,
    projection,
    activePrompt: combineContextRoles(projection),
  };
}

function promptSegmentToContextMaterial(
  segment: CurrentNotePromptSegmentLike,
  runtime: CurrentNoteContextRuntimeInput,
  memoryMaterial?: ContextMaterial,
): ContextMaterial {
  const content = `[${segment.zone}]\n${segment.text}`;
  if (memoryMaterial) {
    return {
      ...memoryMaterial,
      content,
      priority: segment.priority,
      protected: segment.protected,
      compressStrategy: promptCompressionToContext(segment.compressStrategy),
      source: { ...memoryMaterial.source },
      ...(memoryMaterial.tokenBudget ? { tokenBudget: { ...memoryMaterial.tokenBudget } } : {}),
      ...(memoryMaterial.provenance ? { provenance: copyProvenance(memoryMaterial.provenance) } : {}),
      cache: { ...memoryMaterial.cache },
    } as ContextMaterial;
  }

  const mapped = mapPromptZone(segment);
  const stateContentHash = segment.contentHash ?? runtime.stateVector.contentHash;
  const stateSnapshotId = segment.snapshotId ?? runtime.stateVector.snapshotId;
  const provenance = {
    ...(segment.sourceIds?.length ? { sourceIds: [...segment.sourceIds] } : {}),
    ...(segment.goalIds?.length ? { goalIds: [...segment.goalIds] } : {}),
    ...(segment.requirementIds?.length ? { requirementIds: [...segment.requirementIds] } : {}),
    ...(segment.evidenceIds?.length ? { evidenceIds: [...segment.evidenceIds] } : {}),
    ...(stateSnapshotId ? { snapshotId: stateSnapshotId } : {}),
    ...(stateContentHash ? { contentHash: stateContentHash } : {}),
    ...(runtime.stateVector.planId ? { planId: runtime.stateVector.planId } : {}),
  };
  return {
    id: `current-note-segment:${segment.id}`,
    zone: mapped.zone,
    channel: mapped.channel,
    trust: mapped.trust,
    content,
    priority: segment.priority,
    protected: segment.protected,
    compressStrategy: promptCompressionToContext(segment.compressStrategy),
    source: {
      kind: mapped.sourceKind,
      id: segment.id,
      version: 'current-note-prompt-segment-v1',
      ...(stateContentHash ? { contentHash: stateContentHash } : {}),
    },
    stalePolicy: mapped.stalePolicy,
    overflowPolicy: segment.protected ? 'fail' : mapped.overflowPolicy,
    ...(Object.keys(provenance).length ? { provenance } : {}),
    cache: {
      stability: mapped.prefixEligible ? 'stable' : 'turn',
      prefixEligible: mapped.prefixEligible,
    },
  } as ContextMaterial;
}

function mapPromptZone(segment: CurrentNotePromptSegmentLike): {
  zone: ContextMaterial['zone'];
  channel: ContextMaterial['channel'];
  trust: ContextMaterial['trust'];
  sourceKind: string;
  stalePolicy: ContextMaterial['stalePolicy'];
  overflowPolicy: ContextMaterial['overflowPolicy'];
  prefixEligible: boolean;
} {
  if (segment.id === 'policy') return { zone: 'stable-policy', channel: 'system', trust: 'trusted-policy', sourceKind: 'current-note-policy', stalePolicy: 'keep', overflowPolicy: 'fail', prefixEligible: true };
  if (segment.zone === 'output-contract') return { zone: 'output-contract', channel: 'system', trust: 'trusted-policy', sourceKind: 'current-note-output-contract', stalePolicy: 'keep', overflowPolicy: 'fail', prefixEligible: true };
  if (segment.zone === 'search-plan' || segment.zone === 'coverage' || segment.id === 'execution-trace') {
    return { zone: 'agent-state', channel: 'user', trust: 'trusted-state', sourceKind: segment.id === 'execution-trace' ? 'current-note-execution-trace' : 'current-note-agent-state', stalePolicy: 'invalidate', overflowPolicy: 'compress', prefixEligible: false };
  }
  if (segment.zone === 'conversation-summary') return { zone: 'conversation-summary', channel: 'user', trust: 'untrusted-memory', sourceKind: 'current-note-summary', stalePolicy: 'invalidate', overflowPolicy: 'compress', prefixEligible: false };
  if (segment.zone === 'conversation-hot') return { zone: 'conversation-hot', channel: 'user', trust: 'untrusted-memory', sourceKind: 'current-note-hot', stalePolicy: 'invalidate', overflowPolicy: 'compress', prefixEligible: false };
  if (segment.zone === 'long-term-memory') return { zone: 'long-term-memory', channel: 'user', trust: 'untrusted-memory', sourceKind: 'weknora-long-term-memory', stalePolicy: 'refresh', overflowPolicy: 'drop', prefixEligible: false };
  if (segment.zone === 'note-capsule') return { zone: 'note-capsule', channel: 'user', trust: 'untrusted-evidence', sourceKind: 'current-note-capsule', stalePolicy: 'invalidate', overflowPolicy: 'fail', prefixEligible: false };
  if (segment.zone === 'evidence') return { zone: 'dynamic-evidence', channel: 'user', trust: 'untrusted-evidence', sourceKind: 'current-note-evidence', stalePolicy: 'invalidate', overflowPolicy: 'compress', prefixEligible: false };
  if (segment.zone === 'tool-observation') return { zone: 'tool-observation', channel: 'user', trust: 'untrusted-evidence', sourceKind: 'current-note-tool-observation', stalePolicy: 'invalidate', overflowPolicy: 'compress', prefixEligible: false };
  if (segment.zone === 'question') return { zone: 'current-request', channel: 'user', trust: 'untrusted-memory', sourceKind: 'current-note-question', stalePolicy: 'keep', overflowPolicy: 'fail', prefixEligible: false };
  return { zone: 'agent-state', channel: 'user', trust: 'trusted-state', sourceKind: 'current-note-runtime-rule', stalePolicy: 'refresh', overflowPolicy: 'compress', prefixEligible: false };
}

function groupHotTurns(messages: readonly AssistantConversationMessage[]): HotTurnGroup[] {
  const groups: HotTurnGroup[] = [];
  let fallbackIndex = 0;
  for (const message of messages) {
    if (!message.content.trim()) continue;
    if (isCurrentNoteMemoryConversationMessage(message)) {
      const last = groups.at(-1);
      if (last?.sourceId === message.memory.sourceId) last.messages.push(copyMessage(message));
      else groups.push({
        key: message.memory.turnSeq !== undefined ? String(message.memory.turnSeq).padStart(10, '0') : stableId(message.memory.sourceId),
        sourceId: message.memory.sourceId,
        sourceVersion: message.memory.sourceVersion,
        ...(message.memory.turnSeq !== undefined ? { turnSeq: message.memory.turnSeq } : {}),
        messages: [copyMessage(message)],
      });
      continue;
    }
    const last = groups.at(-1);
    if (message.role === 'assistant' && last?.sourceId.startsWith('renderer-turn:') && !last.messages.some((entry) => entry.role === 'assistant')) {
      last.messages.push(copyMessage(message));
      continue;
    }
    fallbackIndex += 1;
    groups.push({
      key: `renderer-${String(fallbackIndex).padStart(6, '0')}`,
      sourceId: `renderer-turn:${fallbackIndex}`,
      sourceVersion: 'renderer-conversation-v1',
      messages: [copyMessage(message)],
    });
  }
  return groups;
}

function selectHotTurns(groups: readonly HotTurnGroup[], maximumTokens: number): Array<HotTurnGroup & { content: string }> {
  const selected: Array<HotTurnGroup & { content: string }> = [];
  let remaining = maximumTokens;
  for (const group of [...groups].reverse()) {
    if (remaining <= 0) break;
    const full = renderTurn(group.messages);
    const content = estimateTokenCount(full) <= remaining
      ? full
      : renderTurnWithinBudget(group.messages, remaining);
    if (!content) continue;
    selected.push({ ...group, messages: group.messages.map(copyMessage), content });
    remaining -= estimateTokenCount(content);
  }
  return selected.reverse();
}

function renderTurnWithinBudget(messages: readonly AssistantConversationMessage[], maximumTokens: number): string {
  if (maximumTokens <= 0) return '';
  const user = messages.find((message) => message.role === 'user')?.content.trim() ?? '';
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')?.content.trim() ?? '';
  if (!user || !assistant) return truncateByEstimatedTokens(renderTurn(messages), maximumTokens, 'tail');
  const userPrefix = '用户：';
  const assistantPrefix = '助手：';
  const framingTokens = estimateTokenCount(`${userPrefix}\n${assistantPrefix}`);
  if (maximumTokens <= framingTokens) return truncateByEstimatedTokens(renderTurn(messages), maximumTokens, 'tail');
  const contentBudget = maximumTokens - framingTokens;
  const userBudget = Math.max(1, Math.floor(contentBudget * 0.4));
  const userText = truncateByEstimatedTokens(user, userBudget, 'tail');
  const assistantBudget = Math.max(0, contentBudget - estimateTokenCount(userText));
  const assistantText = truncateByEstimatedTokens(assistant, assistantBudget, 'tail');
  return [`${userPrefix}${userText}`, ...(assistantText ? [`${assistantPrefix}${assistantText}`] : [])].join('\n');
}

function renderTurn(messages: readonly AssistantConversationMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim()}`)
    .filter(Boolean)
    .join('\n');
}

function isSummaryMessage(message: AssistantConversationMessage): boolean {
  return isCurrentNoteMemoryConversationMessage(message)
    ? message.memory.zone === 'conversation-summary'
    : message.role === 'assistant' && message.content.trim().startsWith('会话摘要：');
}

function memoryMetadata(message: AssistantConversationMessage): Pick<CurrentNoteMemoryConversationMessage['memory'], 'sourceId' | 'sourceVersion'> {
  return isCurrentNoteMemoryConversationMessage(message)
    ? message.memory
    : { sourceId: 'legacy-rolling-summary', sourceVersion: 'legacy-conversation-v1' };
}

function normalizeBudget(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

function truncateByEstimatedTokens(value: string, maximumTokens: number, keep: 'head' | 'tail'): string {
  const trimmed = value.trim();
  if (maximumTokens <= 0 || !trimmed) return '';
  if (estimateTokenCount(trimmed) <= maximumTokens) return trimmed;
  const contentBudget = Math.max(0, maximumTokens - estimateTokenCount('…'));
  if (contentBudget <= 0) return '…';
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const slice = keep === 'head' ? trimmed.slice(0, middle) : trimmed.slice(trimmed.length - middle);
    if (estimateTokenCount(slice) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  if (low <= 0) return '';
  const slice = keep === 'head' ? trimmed.slice(0, low) : trimmed.slice(trimmed.length - low);
  return keep === 'head' ? `${slice}…` : `…${slice}`;
}

function promptCompressionToContext(value: string): ContextCompressStrategy {
  if (value === 'demote-to-reference') return 'reference';
  if (value === 'dedupe' || value === 'summarize' || value === 'drop' || value === 'none') return value === 'summarize' ? 'summary' : value;
  return 'truncate';
}

function contextCompressionToPrompt(value: ContextCompressStrategy): string {
  if (value === 'reference') return 'demote-to-reference';
  if (value === 'summary') return 'summarize';
  return value;
}

function combineContextRoles(projection: ContextProjection): string {
  return [
    projection.systemPrompt,
    projection.userPrompt,
    ...(projection.toolMessages ?? []).map((message) => `[tool:${message.name}]\n${message.content}`),
  ].filter(Boolean).join('\n\n');
}

function copyMessage(message: AssistantConversationMessage): AssistantConversationMessage {
  return { role: message.role, content: message.content };
}

function copyProvenance(provenance: NonNullable<ContextMaterial['provenance']>): NonNullable<ContextMaterial['provenance']> {
  return {
    ...provenance,
    ...(provenance.turnSeqs ? { turnSeqs: [...provenance.turnSeqs] } : {}),
    ...(provenance.sourceIds ? { sourceIds: [...provenance.sourceIds] } : {}),
    ...(provenance.goalIds ? { goalIds: [...provenance.goalIds] } : {}),
    ...(provenance.requirementIds ? { requirementIds: [...provenance.requirementIds] } : {}),
    ...(provenance.evidenceIds ? { evidenceIds: [...provenance.evidenceIds] } : {}),
  };
}

function stableId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function createMemoryVersion(request: ContextMemoryRequest, materials: readonly ContextMaterial[]): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId: request.sessionId,
    snapshotId: request.snapshotId,
    contentHash: request.contentHash,
    sources: materials.map((material) => ({
      id: material.id,
      sourceId: material.source.id,
      sourceVersion: material.source.version,
      contentHash: material.source.contentHash,
    })),
  }), 'utf8').digest('hex');
}
