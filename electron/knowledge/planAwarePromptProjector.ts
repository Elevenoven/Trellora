import type { AssistantConversationMessage, EvidencePromptManifest } from './assistantTurnTypes';
import { compactPromptSegmentsL1 } from './incrementalContextCompactor';
import type { PlanExecutionTraceStore } from './planExecutionTraceStore';
import { calculateEvidencePayloadBudgetTokens, type PromptCallKind } from './currentNoteContextBudget';
import { DEFAULT_SEARCH_PLAN_BUDGET, SEARCH_QUERY_TERM_BATCH_SIZE, SEARCH_QUERY_TERM_PROJECTION_LIMIT, type SearchPlan, type SearchQueryTerm } from './searchPlanTypes';
import type { AssistantEvidenceProjectionMode, EvidenceCompressionMode } from './assistantMode';
import { estimateAssistantEvidenceContextStats, estimateTokenCount, type AssistantPromptStats, type SearchHitEvidenceTokenMetadata } from './tokenEstimator';
import type { EvidenceCompressionArtifact } from './evidenceCompressionTypes';
import {
  currentNoteMemoryMaterialToPromptSegment,
  projectCurrentNotePromptSegments,
  type CurrentNoteContextRuntimeInput,
} from './currentNoteContextMemoryAdapter';
import type { ContextEnvelope, ContextProjection as UnifiedContextProjection } from './contextRuntimeTypes';
import type { LibrarySectionRecommendationObservation } from './librarySectionRanker';

export type PromptZone = 'policy' | 'note-capsule' | 'conversation-hot' | 'conversation-summary' | 'question' | 'search-plan' | 'coverage' | 'evidence' | 'execution-trace' | 'tool-observation' | 'output-contract';
export type PromptCompressionStrategy = 'none' | 'dedupe' | 'summarize' | 'demote-to-reference' | 'drop';
export type PlanProjectionCallKind = Extract<PromptCallKind, 'plan' | 'decide' | 'synthesize' | 'citation-repair'>;
export type PromptProjectionLevel = 0 | 1 | 3 | 4;
export type EvidenceProjectionState = 'hot' | 'warm' | 'cold';

export interface PromptSegment {
  id: string;
  zone: PromptZone;
  text: string;
  estimatedTokens: number;
  priority: number;
  protected: boolean;
  compressStrategy: PromptCompressionStrategy;
  sourceIds?: string[];
  goalIds?: string[];
  requirementIds?: string[];
  evidenceIds?: string[];
  snapshotId?: string;
  contentHash?: string;
  /** Stage 5 derived context; raw Ledger evidence remains authoritative. */
  compressedArtifacts?: readonly EvidenceCompressionArtifact[];
  compressionRounds?: number;
}

export interface PromptProjectionEvidence {
  evidenceId: string;
  text: string;
  contentHash?: string;
  snapshotId?: string;
  noteId?: string;
  lineFrom?: number;
  lineTo?: number;
  headingPath?: readonly string[];
  supports?: readonly string[];
  admission?: 'search-hit' | 'explicit-read' | 'expanded-read' | 'memory-reuse';
  admissions?: readonly ('search-hit' | 'explicit-read' | 'expanded-read' | 'memory-reuse')[];
  firstSeenSeq?: number;
}

export interface LatestEvidenceObservation {
  goalId: string;
  evidenceId: string;
  hasNextCursor: boolean;
  nextCursor?: number;
}

export interface EvidenceProtectionRequirement {
  goalId: string;
  requirementId: string;
  minEvidence: number;
  selectedEvidenceIds: string[];
  missing: boolean;
}

export interface EvidenceProtectionSet {
  callKind: Extract<PlanProjectionCallKind, 'decide' | 'synthesize'>;
  protectedEvidenceIds: string[];
  conflictEvidenceIds: string[];
  requiredEvidenceIds: string[];
  missingEvidenceIds: string[];
  missingRequirements: EvidenceProtectionRequirement[];
  states: Record<string, EvidenceProjectionState>;
}

export interface PlanAwarePromptProjectorInput {
  callKind: PlanProjectionCallKind;
  stablePrefix: string;
  capsuleText?: string;
  question: string;
  conversation?: readonly AssistantConversationMessage[];
  plan?: SearchPlan;
  baseVersion?: number;
  evidence?: readonly PromptProjectionEvidence[];
  traceStore?: PlanExecutionTraceStore;
  toolInstructions?: readonly { name: string; description: string }[];
  rulesText?: string;
  outputSchema: string;
  answer?: string;
  citationError?: string;
  allowedEvidenceIds?: readonly string[];
  projectionLevel?: PromptProjectionLevel;
  recentEvidenceIds?: readonly string[];
  failedEvidenceIds?: readonly string[];
  /** Decision-only bounded previews of the latest explicit reads for the active goal. */
  latestEvidenceObservations?: readonly LatestEvidenceObservation[];
  /** Stage 2 single-goal synthesis candidates resolved by the controller. */
  candidateEvidenceIds?: readonly string[];
  /** Stage 3 navigation-only candidates. They are projected only into decide calls. */
  navigationObservations?: readonly LibrarySectionRecommendationObservation[];
  /** Stage 1 metadata-only observation input; it never enters the prompt. */
  searchHitMetadata?: readonly SearchHitEvidenceTokenMetadata[];
  assistantEvidenceProjectionMode?: AssistantEvidenceProjectionMode;
  evidenceCompressionMode?: EvidenceCompressionMode;
  evidenceBudgetTokens?: number;
  /** Stage 3 complete-prompt budget supplied by the shared scheduler. */
  maxPromptTokens?: number;
  snapshotId?: string;
  contentHash?: string;
  /** Phase 4 route-scoped memory and Envelope projection. Omit for legacy callers. */
  contextRuntime?: CurrentNoteContextRuntimeInput;
}

export interface PromptProjection {
  callKind: PlanProjectionCallKind;
  prompt: string;
  legacyPrompt: string;
  segments: PromptSegment[];
  protectedEvidenceIds: string[];
  compactionLevel: PromptProjectionLevel;
  planId?: string;
  planVersion?: number;
  activeGoalId?: string | null;
  evidenceProtection?: EvidenceProtectionSet;
  evidencePromptManifest?: EvidencePromptManifest;
  evidenceContextStats?: AssistantPromptStats['evidenceContextStats'];
  promptStats: AssistantPromptStats;
  contextRuntimeMode?: CurrentNoteContextRuntimeInput['mode'];
  contextEnvelope?: ContextEnvelope;
  contextProjection?: UnifiedContextProjection;
  serializedBudgetText?: string;
  requestEnvelopeVersion?: string;
}

const nullableString = () => ({ anyOf: [{ type: 'string' }, { type: 'null' }] });

const planPatchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['baseVersion', 'activeGoalId', 'goalOrder', 'goalUpdates'],
  properties: {
    baseVersion: { type: 'integer', minimum: 0 },
    activeGoalId: nullableString(),
    goalOrder: { type: 'array', maxItems: 4, items: { type: 'string' } },
    goalUpdates: {
      type: 'array',
      maxItems: DEFAULT_SEARCH_PLAN_BUDGET.maxGoals,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goalId', 'status', 'queryVariants', 'evidenceBindings', 'conflictBindings', 'missingEvidence', 'clearMissingEvidence'],
        properties: {
          goalId: { type: 'string' },
          status: {
            anyOf: [
              { enum: ['pending', 'searching', 'partial', 'covered', 'conflicted', 'not-found'] },
              { type: 'null' },
            ],
          },
          queryVariants: {
            anyOf: [
              {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['term', 'source'],
                  properties: {
                    term: { type: 'string' },
                    source: { enum: ['note-map', 'search-observation', 'model-synonym', 'user-confirmed'] },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          evidenceBindings: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['requirementId', 'evidenceIds'],
                  properties: {
                    requirementId: { type: 'string' },
                    evidenceIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          conflictBindings: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['requirementId', 'supportsEvidenceIds', 'contradictsEvidenceIds'],
                  properties: {
                    requirementId: { type: 'string' },
                    supportsEvidenceIds: { type: 'array', items: { type: 'string' } },
                    contradictsEvidenceIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          missingEvidence: {
            description: '设置新的证据缺口；本字段无变化时必须为 null。',
            ...nullableString(),
          },
          clearMissingEvidence: {
            type: 'boolean',
            description: '仅在需要删除已有 missingEvidence 时为 true，否则必须为 false。',
          },
        },
      },
    },
  },
} as const;

const optionalPlanPatchSchema = {
  description: '仅在本轮确实改变计划时返回补丁；没有任何实际变化时必须返回 null，不能复写当前值或提交等价空补丁。',
  anyOf: [planPatchSchema, { type: 'null' }],
} as const;

const toolArgumentsSchema = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['detail'], properties: { detail: { enum: ['outline', 'stats', 'terms'] } } },
    { type: 'object', additionalProperties: false, required: ['terms', 'limit', 'cursor'], properties: { terms: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' }, cursor: nullableString() } },
    { type: 'object', additionalProperties: false, required: ['lineFrom', 'lineTo'], properties: { lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['headingId', 'cursor'], properties: { headingId: { type: 'string' }, cursor: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    { type: 'object', additionalProperties: false, required: ['evidenceId', 'beforeLines', 'afterLines'], properties: { evidenceId: { type: 'string' }, beforeLines: { type: 'integer' }, afterLines: { type: 'integer' } } },
  ],
} as const;

const conversationSearchToolArgumentsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'limit'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 8 },
  },
} as const;

const answerActionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'answer', 'citations', 'completeness', 'planPatch'],
  properties: {
    type: { const: 'answer' },
    answer: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
    completeness: { enum: ['complete', 'partial', 'not-found'] },
    planPatch: optionalPlanPatchSchema,
  },
} as const;

// Structured Outputs requires the root schema to be an object (not `anyOf`).
// The controller enforces the tool/answer branch correlation locally after the
// provider returns this flat, nullable union-shaped object.
const decideSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'goalId', 'tool', 'arguments', 'publicRationale', 'answer', 'citations', 'completeness', 'planPatch'],
  properties: {
    type: { enum: ['tool', 'answer'] },
    goalId: nullableString(),
    tool: { anyOf: [{ enum: ['get_note_map', 'search_note', 'read_note_range', 'read_note_section', 'expand_evidence'] }, { type: 'null' }] },
    arguments: { anyOf: [toolArgumentsSchema, { type: 'null' }] },
    publicRationale: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 80 },
        { type: 'null' },
      ],
    },
    answer: nullableString(),
    citations: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    completeness: { anyOf: [{ enum: ['complete', 'partial', 'not-found'] }, { type: 'null' }] },
    planPatch: optionalPlanPatchSchema,
  },
} as const;

const synthesizeSchema = answerActionSchema;

export const DEFAULT_PLAN_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'goals'],
  properties: {
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'coveragePolicy', 'targetTopic', 'targetAspects'],
      properties: {
        mode: { enum: ['focused', 'topic-wide'] },
        coveragePolicy: { enum: ['sufficient', 'aspect-complete', 'occurrence-complete'] },
        targetTopic: nullableString(),
        targetAspects: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', minLength: 2, maxLength: 80 },
        },
      },
    },
    goals: {
      type: 'array',
      minItems: 1,
      maxItems: DEFAULT_SEARCH_PLAN_BUDGET.maxGoals,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goalId', 'question', 'evidenceKind', 'requirements', 'queryTerms'],
        properties: {
          goalId: nullableString(),
          question: { type: 'string' },
          evidenceKind: { enum: ['fact', 'definition', 'comparison', 'cause', 'timeline'] },
          requirements: {
            type: 'array',
            minItems: 1,
            maxItems: DEFAULT_SEARCH_PLAN_BUDGET.maxRequirementsPerGoal,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['requirementId', 'label', 'subject', 'minEvidence'],
              properties: {
                requirementId: { type: 'string' },
                label: { type: 'string' },
                subject: nullableString(),
                minEvidence: { type: 'integer', minimum: 1, maximum: 3 },
              },
            },
          },
          queryTerms: {
            type: 'array',
            minItems: 1,
            maxItems: SEARCH_QUERY_TERM_BATCH_SIZE,
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
      },
    },
  },
});
export const DEFAULT_DECIDE_JSON_SCHEMA = JSON.stringify(decideSchema);

/** M6 is advertised to the current-note model only when the host bound a ready L3 runtime. */
export function createCurrentNoteDecideJsonSchema(conversationSearchEnabled: boolean): string {
  if (!conversationSearchEnabled) return DEFAULT_DECIDE_JSON_SCHEMA;
  return JSON.stringify({
    ...decideSchema,
    properties: {
      ...decideSchema.properties,
      tool: {
        anyOf: [
          { enum: [...decideSchema.properties.tool.anyOf[0].enum, 'search_conversations'] },
          { type: 'null' },
        ],
      },
      arguments: {
        anyOf: [
          { anyOf: [...toolArgumentsSchema.anyOf, conversationSearchToolArgumentsSchema] },
          { type: 'null' },
        ],
      },
    },
  });
}
export const DEFAULT_SYNTHESIZE_JSON_SCHEMA = JSON.stringify(synthesizeSchema);
export const DEFAULT_CITATION_REPAIR_JSON_SCHEMA = '{"type":"object","additionalProperties":false,"required":["citations"],"properties":{"citations":{"type":"array","items":{"type":"string"}}}}';

export interface StructuredOutputSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

/** Converts the prompt contract into the OpenAI-compatible strict transport shape. */
export function toStructuredOutputSchema(name: string, schemaText: string): StructuredOutputSchema {
  const schema = JSON.parse(schemaText) as unknown;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('结构化输出 Schema 必须是 JSON 对象。');
  return { name, strict: true, schema: schema as Record<string, unknown> };
}

/** Builds a transient provider projection without mutating plans or ledgers. */
export class PlanAwarePromptProjector {
  constructor(private readonly defaultTraceStore?: PlanExecutionTraceStore) {}

  build(input: PlanAwarePromptProjectorInput): PromptProjection {
    assertInput(input);
    const plan = input.plan;
    const evidence = copyEvidence(input.evidence ?? []);
    const allRetrievedRawMode = isAllRetrievedRawMode(input);
    const allRetrievedCompressionMode = isAllRetrievedCompressionMode(input);
    const allRetrievedEvidenceMode = allRetrievedRawMode || allRetrievedCompressionMode;
    const projectionLevel = input.projectionLevel ?? 0;
    const protection = plan && (input.callKind === 'decide' || input.callKind === 'synthesize')
      ? deriveEvidenceProtectionSet(plan, evidence, input.callKind, input.recentEvidenceIds, input.failedEvidenceIds)
      : undefined;
    const segments: PromptSegment[] = [
      segment('policy', 'policy', input.stablePrefix, 100, true, 'none'),
    ];
    if (input.capsuleText?.trim()) segments.push(segment('capsule', 'note-capsule', input.capsuleText.trim(), 95, true, 'none'));
    if (input.contextRuntime && input.contextRuntime.mode !== 'off') {
      segments.push(...input.contextRuntime.memory.materials.map((material) => currentNoteMemoryMaterialToPromptSegment(material) as PromptSegment));
    } else if (input.conversation?.length) {
      segments.push(createConversationSegment(input.conversation));
    }
    segments.push(segment('question', 'question', input.question.trim(), 100, true, 'none'));
    if (input.rulesText?.trim()) segments.push(segment('rules', 'policy', input.rulesText.trim(), 95, true, 'none'));

    if (input.callKind === 'plan') {
      if (input.toolInstructions?.length) {
        segments.push(segment('plan-tools', 'tool-observation', input.toolInstructions.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'), 75, false, 'summarize'));
      }
    } else if (plan) {
      segments.push(...createPlanSegments(plan, input.callKind, input.baseVersion ?? plan.version, protection));
      if (input.callKind === 'decide') {
        const traceSegment = createTraceSegment(plan, input.traceStore ?? this.defaultTraceStore);
        if (traceSegment) segments.push(traceSegment);
        segments.push(createEvidenceDirectorySegment(evidence, protection, projectionLevel));
      } else if (input.callKind === 'synthesize') {
        const candidateEvidence = allRetrievedEvidenceMode ? evidence : selectCandidateEvidence(input, evidence);
        segments.push(createEvidenceDirectorySegment(candidateEvidence, protection, projectionLevel));
        const selected = allRetrievedEvidenceMode
          ? sortEvidenceForPrompt(evidence)
          : input.candidateEvidenceIds
          ? candidateEvidence
          : selectMinimalEvidence(plan, evidence, protection);
        if (allRetrievedEvidenceMode) {
          const artifacts = input.compressedArtifacts ?? [];
          const rawEvidence = removeCompressedSourceEvidence(selected, artifacts);
          segments.push(createEvidencePromptManifestSegment(createEvidencePromptManifest(input, selected, rawEvidence, artifacts, 0)));
          segments.push(createEvidenceSegment(rawEvidence, 'synthesis-evidence', 'raw-evidence'));
          segments.push(...createCompressedEvidenceSegments(artifacts));
        } else {
          segments.push(createEvidenceSegment(selected, 'synthesis-evidence'));
        }
      } else if (input.callKind === 'citation-repair') {
        segments.push(...createCitationSegments(input, selectAllowedEvidence(input, evidence)));
      }
    } else if (input.callKind === 'decide') {
      const traceSegment = createTraceSegment(undefined, input.traceStore ?? this.defaultTraceStore);
      if (traceSegment) segments.push(traceSegment);
      segments.push(createEvidenceDirectorySegment(evidence, undefined, projectionLevel));
    } else if (input.callKind === 'synthesize') {
      const selected = allRetrievedEvidenceMode ? sortEvidenceForPrompt(evidence) : evidence.slice(0, projectionLevel >= 4 ? 4 : 8);
      segments.push(createEvidenceDirectorySegment(evidence, undefined, projectionLevel));
      if (allRetrievedEvidenceMode) {
        const artifacts = input.compressedArtifacts ?? [];
        const rawEvidence = removeCompressedSourceEvidence(selected, artifacts);
        segments.push(createEvidencePromptManifestSegment(createEvidencePromptManifest(input, selected, rawEvidence, artifacts, 0)));
        segments.push(createEvidenceSegment(rawEvidence, 'synthesis-evidence', 'raw-evidence'));
        segments.push(...createCompressedEvidenceSegments(artifacts));
      } else {
        segments.push(createEvidenceSegment(selected, 'synthesis-evidence'));
      }
    } else if (input.callKind === 'citation-repair') {
      segments.push(...createCitationSegments(input, selectAllowedEvidence(input, evidence)));
    }

    if (input.callKind === 'decide') {
      const latestEvidenceSegment = createLatestEvidenceObservationSegment(input, evidence, projectionLevel);
      if (latestEvidenceSegment) segments.push(latestEvidenceSegment);
      const navigationSegment = createNavigationObservationSegment(input, projectionLevel);
      if (navigationSegment) segments.push(navigationSegment);
    }

    segments.push(segment('output-contract', 'output-contract', `只输出符合以下 JSON Schema 的对象：\n${input.outputSchema}`, 100, true, 'none'));
    let compacted = compactPromptSegmentsL1(applyProjectionLevel(segments, projectionLevel, protection));
    let evidencePromptManifest: EvidencePromptManifest | undefined;
    if (allRetrievedEvidenceMode) {
      const orderedEvidence = sortEvidenceForPrompt(evidence);
      const rawEvidence = removeCompressedSourceEvidence(orderedEvidence, input.compressedArtifacts ?? []);
      for (let iteration = 0; iteration < 3; iteration += 1) {
        evidencePromptManifest = finalizeEvidencePromptManifest(compacted.segments, input, orderedEvidence, rawEvidence, input.compressedArtifacts ?? []);
        compacted = { ...compacted, segments: compacted.segments.map((current) => current.id === 'evidence-manifest'
          ? createEvidencePromptManifestSegment(evidencePromptManifest as EvidencePromptManifest)
          : current) };
      }
    }
    const evidenceContextStats = input.searchHitMetadata
      ? estimateAssistantEvidenceContextStats({
        projectionMode: input.assistantEvidenceProjectionMode ?? 'minimal',
        compressionMode: input.evidenceCompressionMode ?? 'observe',
        searchHits: input.searchHitMetadata,
        evidenceBudgetTokens: input.evidenceBudgetTokens,
      })
      : undefined;
    const legacyPrompt = renderPromptSegments(compacted.segments);
    const contextAssembly = input.contextRuntime && input.contextRuntime.mode !== 'off'
      ? projectCurrentNotePromptSegments(
        input.callKind,
        compacted.segments,
        input.contextRuntime,
        mapProjectionLevelToPressure(projectionLevel === 0 ? compacted.level : projectionLevel),
      )
      : undefined;
    const projection: PromptProjection = {
      callKind: input.callKind,
      prompt: input.contextRuntime?.mode === 'enforce' && contextAssembly
        ? contextAssembly.activePrompt
        : legacyPrompt,
      legacyPrompt,
      segments: compacted.segments,
      protectedEvidenceIds: protection?.protectedEvidenceIds ?? collectProtectedEvidenceIds(compacted.segments),
      compactionLevel: projectionLevel === 0 ? compacted.level : projectionLevel,
      ...(plan ? { planId: plan.planId, planVersion: plan.version, activeGoalId: plan.activeGoalId } : {}),
      ...(protection ? { evidenceProtection: protection } : {}),
      ...(evidencePromptManifest ? { evidencePromptManifest } : {}),
      ...(evidenceContextStats ? { evidenceContextStats } : {}),
      ...(input.contextRuntime ? { contextRuntimeMode: input.contextRuntime.mode } : {}),
      ...(contextAssembly ? {
        contextEnvelope: contextAssembly.envelope,
        contextProjection: contextAssembly.projection,
        serializedBudgetText: contextAssembly.projection.serializedBudgetText,
        requestEnvelopeVersion: contextAssembly.projection.requestEnvelopeVersion,
      } : {}),
      promptStats: createPromptStats(
        input.callKind,
        projectionLevel === 0 ? compacted.level : projectionLevel,
        compacted.segments,
        plan,
        evidenceContextStats,
      ),
    };
    assertPromptProjectionInvariants(input, projection);
    assertProtectedSegmentProjection(projection);
    return projection;
  }
}

export function renderPromptSegments(segments: readonly PromptSegment[]): string {
  return segments.map((segment) => `[${segment.zone}]\n${segment.text}`).join('\n\n');
}

export function assertPromptProjectionInvariants(input: PlanAwarePromptProjectorInput, projection: PromptProjection): void {
  const protectedText = projection.segments.filter((segment) => segment.protected).map((segment) => segment.text).join('\n');
  if (!protectedText.includes(input.question.trim())) throw new Error('Prompt projection 丢失当前问题保护区。');
  if (!protectedText.includes(input.outputSchema)) throw new Error('Prompt projection 丢失 JSON Schema 保护区。');
  if (input.callKind !== 'plan' && input.plan) {
    const identity = `planId=${input.plan.planId}`;
    if (!protectedText.includes(identity) || !protectedText.includes(`planVersion=${input.plan.version}`) || !protectedText.includes(`baseVersion=${input.baseVersion ?? input.plan.version}`)) {
      throw new Error('Prompt projection 丢失 planId/version/baseVersion 保护区。');
    }
    if (!protectedText.includes(`activeGoalId=${input.plan.activeGoalId ?? 'null'}`)) throw new Error('Prompt projection 丢失 activeGoalId 保护区。');
  }
  const evidenceIds = new Set((input.evidence ?? []).map((record) => record.evidenceId));
  if (input.allowedEvidenceIds?.some((evidenceId) => !evidenceIds.has(evidenceId))) {
    throw new Error('citation-repair 引用了不在当前 Ledger 的 evidenceId。');
  }
  if (input.candidateEvidenceIds?.some((evidenceId) => !evidenceIds.has(evidenceId))) {
    throw new Error('synthesize candidateEvidenceIds 引用了不在当前 Ledger 的 evidenceId。');
  }
  if (input.latestEvidenceObservations?.some((observation) => !evidenceIds.has(observation.evidenceId))) {
    throw new Error('latest-evidence-observation 引用了不在当前 Ledger 的 evidenceId。');
  }
  if (input.latestEvidenceObservations?.some((observation) => observation.hasNextCursor !== (observation.nextCursor !== undefined))) {
    throw new Error('latest-evidence-observation 的 nextCursor 状态不一致。');
  }
  if (input.plan?.activeGoalId && input.latestEvidenceObservations?.some((observation) => observation.goalId !== input.plan?.activeGoalId)) {
    throw new Error('latest-evidence-observation 包含非当前 active goal 的证据。');
  }
  if (input.plan) {
    const planEvidenceIds = input.plan.goals.flatMap((goal) => [
      ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
      ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
    ]);
    if (planEvidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new Error('SearchPlan 的 evidence binding 无法解析到当前 Ledger。');
    }
  }
  for (const evidenceId of projection.protectedEvidenceIds) {
    if (!evidenceIds.has(evidenceId)) throw new Error(`Prompt projection 引用了不存在的 evidenceId：${evidenceId}`);
  }
  if (projection.evidenceProtection?.missingEvidenceIds.length && projection.compactionLevel >= 3) {
    const missing = new Set(projection.evidenceProtection.missingEvidenceIds);
    if (projection.protectedEvidenceIds.some((evidenceId) => missing.has(evidenceId))) {
      throw new Error('Prompt projection 的保护集合包含无法解析的 evidenceId。');
    }
  }
  if (projection.evidencePromptManifest) {
    const retrieved = new Set(projection.evidencePromptManifest.turnRetrievedEvidenceIds);
    const represented = new Set(projection.evidencePromptManifest.representedEvidenceIds);
    const inputEvidenceIds = new Set((input.evidence ?? []).map((record) => record.evidenceId));
    for (const artifact of input.compressedArtifacts ?? []) {
      if (artifact.snapshotId !== (input.snapshotId ?? artifact.snapshotId)
        || artifact.contentHash !== (input.contentHash ?? artifact.contentHash)
        || artifact.sourceEvidenceIds.some((evidenceId) => !inputEvidenceIds.has(evidenceId))) {
        throw new Error('EvidenceCompressionArtifact 已脱离当前 Snapshot 或 Ledger。');
      }
    }
    if (projection.evidencePromptManifest.missingEvidenceIds.length !== 0
      || retrieved.size !== represented.size
      || [...retrieved].some((evidenceId) => !represented.has(evidenceId))
      || projection.evidencePromptManifest.representationCoverage !== 1) {
      throw new Error('EvidencePromptManifest 未达到 100% 表示覆盖。');
    }
    if (!projection.prompt.includes('[raw-evidence]')) throw new Error('全量证据投影缺少 raw-evidence 段。');
    if (projection.evidencePromptManifest.compressionArtifactIds.length > 0 && !projection.prompt.includes('[compressed-unit]')) {
      throw new Error('压缩证据投影缺少 compressed-unit 段。');
    }
  }
}

function selectCandidateEvidence(
  input: PlanAwarePromptProjectorInput,
  evidence: readonly PromptProjectionEvidence[],
): PromptProjectionEvidence[] {
  if (!input.candidateEvidenceIds) return [...evidence];
  const candidates = new Set(input.candidateEvidenceIds);
  return evidence.filter((record) => candidates.has(record.evidenceId));
}

function createPlanSegments(plan: SearchPlan, callKind: PlanProjectionCallKind, baseVersion: number, protection?: EvidenceProtectionSet): PromptSegment[] {
  const activeGoal = plan.goals.find((goal) => goal.goalId === plan.activeGoalId);
  const identity = `planId=${plan.planId} planVersion=${plan.version} baseVersion=${baseVersion} activeGoalId=${plan.activeGoalId ?? 'null'} status=${plan.status}`;
  const goals = callKind === 'decide' && activeGoal ? [activeGoal] : plan.goals;
  const requirementIds = goals.flatMap((goal) => goal.requirements.map((requirement) => requirement.requirementId));
  const coverage = goals.map((goal) => {
    const requirements = goal.requirements.map((requirement) => {
      const binding = goal.evidenceBindings.find((candidate) => candidate.requirementId === requirement.requirementId);
      const conflict = goal.conflictBindings.find((candidate) => candidate.requirementId === requirement.requirementId);
      const ids = [...new Set([...(binding?.evidenceIds ?? []), ...(conflict?.supportsEvidenceIds ?? []), ...(conflict?.contradictsEvidenceIds ?? [])])];
      return `req=${requirement.requirementId}:${ids.length}/${requirement.minEvidence} evidenceIds=${ids.join(',') || 'none'}`;
    }).join('\n');
    return `goalId=${goal.goalId} status=${goal.status} question=${goal.question}\n${requirements || 'requirements=none'}`;
  }).join('\n');
  const queryTerms = callKind === 'decide' && activeGoal
    ? `\nactiveQueryTerms=${formatProjectedQueryTerms(activeGoal.queryTerms)}`
    : '';
  const protectionText = protection && callKind !== 'plan'
    ? `\nprotectedEvidenceIds=${protection.protectedEvidenceIds.join(',') || 'none'} conflictEvidenceIds=${protection.conflictEvidenceIds.join(',') || 'none'} missingRequirements=${protection.missingRequirements.filter((requirement) => requirement.missing).map((requirement) => `${requirement.goalId}/${requirement.requirementId}`).join(',') || 'none'}`
    : '';
  return [
    segment('plan-identity', 'search-plan', identity, 100, true, 'none', { planIds: [plan.planId] }),
    segment('coverage', 'coverage', `${coverage || '无目标覆盖信息。'}${protectionText}`, 100, true, 'none', { goalIds: goals.map((goal) => goal.goalId), requirementIds }),
    ...(queryTerms ? [segment('active-query-terms', 'search-plan', queryTerms, 70, false, 'demote-to-reference', { goalIds: activeGoal ? [activeGoal.goalId] : [] })] : []),
  ];
}

function formatProjectedQueryTerms(queryTerms: readonly SearchQueryTerm[]): string {
  const visible = projectHeadAndTail(queryTerms, SEARCH_QUERY_TERM_PROJECTION_LIMIT);
  const omitted = queryTerms.length - visible.length;
  const text = visible.map((term) => `${term.term}[${term.source}]`).join('|');
  return omitted > 0 ? `${text}|…[省略${omitted}个]` : text;
}

function projectHeadAndTail<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const headCount = Math.ceil(limit / 2);
  return [...values.slice(0, headCount), ...values.slice(-(limit - headCount))];
}

function createTraceSegment(plan: SearchPlan | undefined, store: PlanExecutionTraceStore | undefined): PromptSegment | undefined {
  if (!store) return undefined;
  const events = store.compactL1({ planId: plan?.planId ?? 'trace-plan', planVersion: plan?.version ?? Number.MAX_SAFE_INTEGER, activeGoalId: plan?.activeGoalId });
  if (!events.length) return undefined;
  const text = events.map((event) => `goalId=${event.goalId} summary=${event.summary} evidenceId=${event.evidenceIds.join(',') || 'none'}`).join('\n');
  return segment('execution-trace', 'tool-observation', text, 65, false, 'dedupe', {
    goalIds: events.map((event) => event.goalId),
    evidenceIds: events.flatMap((event) => event.evidenceIds),
  });
}

function createLatestEvidenceObservationSegment(
  input: PlanAwarePromptProjectorInput,
  evidence: readonly PromptProjectionEvidence[],
  projectionLevel: PromptProjectionLevel,
): PromptSegment | undefined {
  const activeGoalId = input.plan?.activeGoalId;
  if (!activeGoalId) return undefined;
  const byId = new Map(evidence.map((record) => [record.evidenceId, record]));
  const observations = [...(input.latestEvidenceObservations ?? [])]
    .filter((observation) => observation.goalId === activeGoalId)
    .map((observation) => ({ observation, record: byId.get(observation.evidenceId) }))
    .filter((entry): entry is { observation: LatestEvidenceObservation; record: PromptProjectionEvidence } => Boolean(entry.record))
    .filter(({ record }) => record.admission === 'explicit-read'
      || record.admission === 'expanded-read'
      || record.admissions?.some((admission) => admission === 'explicit-read' || admission === 'expanded-read'));
  if (!observations.length) return undefined;

  const visible = projectionLevel >= 3 ? observations.slice(-1) : observations.slice(-2);
  const previewCharacters = projectionLevel >= 4 ? 240 : projectionLevel >= 3 ? 800 : 1_200;
  const entries = visible.map(({ observation, record }, index) => {
    const heading = record.headingPath?.map(toSingleLine).join(' / ') || '(root)';
    const rawText = record.text.trim();
    const preview = rawText.length <= previewCharacters
      ? rawText
      : `${rawText.slice(0, previewCharacters)}\n…（最新证据预览已截断，完整原文仍在 Evidence Ledger）…`;
    return [
      `${index + 1}. evidenceId=${record.evidenceId} section=${heading} L${record.lineFrom ?? '?'}-${record.lineTo ?? '?'} hasNextCursor=${observation.hasNextCursor}${observation.nextCursor !== undefined ? ` nextCursor=${observation.nextCursor}` : ' nextCursor=none'}`,
      preview,
    ].join('\n');
  });
  const text = [
    '[latest-evidence-observation decision-only]',
    `goalId=${activeGoalId} count=${visible.length}`,
    ...entries,
    '该观察只用于决定继续读取还是结束检索，不代表最终 citations 或 evidenceBindings；引用仍以最终 Synthesize action 为准。',
  ].join('\n\n');
  return segment(
    'latest-evidence-observation',
    'tool-observation',
    text,
    88,
    projectionLevel >= 4,
    'none',
    { goalIds: [activeGoalId], evidenceIds: visible.map(({ record }) => record.evidenceId) },
  );
}

function createNavigationObservationSegment(
  input: PlanAwarePromptProjectorInput,
  projectionLevel: PromptProjectionLevel,
): PromptSegment | undefined {
  const activeGoalId = input.plan?.activeGoalId;
  if (!activeGoalId) return undefined;
  const observation = [...(input.navigationObservations ?? [])]
    .filter((candidate) => candidate.goalId === activeGoalId)
    .at(-1);
  if (!observation) return undefined;

  const topSections = observation.topSections.slice(0, 3);
  const header = '[related-section-candidates navigation-only]';
  const instruction = '这些候选不是 Evidence Ledger 原文，不能写入 citations 或 evidenceBindings；必须调用 read_library_note_section 后，候选原文才是可引用证据。';
  if (projectionLevel >= 4) {
    const text = [
      header,
      `goalId=${observation.goalId} candidates=${topSections.length} ambiguous=${observation.ambiguous} fallbackUsed=${observation.fallbackUsed}`,
      instruction,
    ].join('\n');
    return segment('navigation-observations', 'tool-observation', text, 55, false, 'none', {
      goalIds: [observation.goalId],
      evidenceIds: [observation.sourceEvidenceId],
    });
  }

  let remainingPreviewCharacters = 720;
  const candidates = topSections.map((candidate, index) => {
    const matchedTerms = candidate.matchedQueryTerms.map(toSingleLine).join('|') || 'none';
    const lines = [
      `${index + 1}. noteId=${candidate.noteId} headingId=${candidate.headingId} L${candidate.lineFrom}-L${candidate.lineTo} score=${candidate.score.toFixed(2)} matched=${matchedTerms}`,
      `   path=${candidate.headingPath.map(toSingleLine).join(' / ') || '(root)'}`,
    ];
    if (projectionLevel < 3 && remainingPreviewCharacters > 0) {
      const preview = toSingleLine(candidate.preview).slice(0, Math.min(240, remainingPreviewCharacters));
      remainingPreviewCharacters -= preview.length;
      lines.push(`   preview=${preview}`);
    }
    return lines.join('\n');
  });
  const text = [
    header,
    `goalId=${observation.goalId} sourceEvidenceId=${observation.sourceEvidenceId}`,
    `evaluatedSections=${observation.evaluatedSectionCount} queryTerms=${observation.queryTermCount} ambiguous=${observation.ambiguous} fallbackUsed=${observation.fallbackUsed}`,
    ...candidates,
    instruction,
  ].join('\n');
  return segment('navigation-observations', 'tool-observation', text, 55, false, 'none', {
    goalIds: [observation.goalId],
    evidenceIds: [observation.sourceEvidenceId],
  });
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function createEvidenceDirectorySegment(
  evidence: readonly PromptProjectionEvidence[],
  protection: EvidenceProtectionSet | undefined,
  projectionLevel: PromptProjectionLevel,
): PromptSegment {
  const visible = projectionLevel >= 4 && protection
    ? evidence.filter((record) => protection.protectedEvidenceIds.includes(record.evidenceId))
    : evidence;
  const text = visible.length
    ? visible.map((record) => {
      const state = protection?.states[record.evidenceId] ?? (projectionLevel >= 3 ? 'cold' : 'warm');
      const preview = state === 'warm' && projectionLevel >= 3 ? ` preview=${record.text.replace(/\s+/gu, ' ').slice(0, 120)}` : '';
      return `${record.evidenceId}${record.noteId ? ` noteId=${record.noteId}` : ''}${record.lineFrom !== undefined && record.lineTo !== undefined ? ` L${record.lineFrom}-${record.lineTo}` : ''} state=${state}${record.contentHash ? ` contentHash=${record.contentHash}` : ''}${record.supports?.length ? ` supports=${record.supports.join('|')}` : ''}${preview}`;
    }).join('\n')
    : '尚无可引用原文证据。';
  return segment('evidence-directory', 'evidence', text, 60, false, 'demote-to-reference', { evidenceIds: visible.map((record) => record.evidenceId) });
}

function createEvidenceSegment(evidence: readonly PromptProjectionEvidence[], id: string, label?: 'raw-evidence'): PromptSegment {
  const body = evidence.length
    ? evidence.map((record) => `${record.evidenceId}${record.noteId ? ` noteId=${record.noteId}` : ''}${record.lineFrom !== undefined && record.lineTo !== undefined ? ` L${record.lineFrom}-${record.lineTo}` : ''}\n${record.text}`).join('\n\n')
    : '尚无可引用原文证据。';
  const text = label ? `[${label}]\n${body}` : body;
  return segment(id, 'evidence', text, 90, true, 'none', { evidenceIds: evidence.map((record) => record.evidenceId) });
}

function createCompressedEvidenceSegments(artifacts: readonly EvidenceCompressionArtifact[]): PromptSegment[] {
  return artifacts.flatMap((artifact) => artifact.compressedSegments.map((segmentData) => segment(
    `compressed-${artifact.artifactId}-${segmentData.segmentId}`,
    'evidence',
    `[compressed-unit] artifactId=${artifact.artifactId} batchId=${artifact.batchId} sourceEvidenceIds=${segmentData.sourceEvidenceIds.join(',')}\n${segmentData.text}`,
    90,
    true,
    'none',
    { evidenceIds: segmentData.sourceEvidenceIds },
  )));
}

function createEvidencePromptManifestSegment(manifest: EvidencePromptManifest): PromptSegment {
  const coverage = `${Math.round(manifest.representationCoverage * 100)}%`;
  const text = [
    '[evidence-manifest]',
    `retrieved=${manifest.turnRetrievedEvidenceIds.length} raw=${manifest.rawEvidenceIds.length} compressed=${manifest.compressionArtifactIds.length} represented=${manifest.representedEvidenceIds.length} missing=${manifest.missingEvidenceIds.length} coverage=${coverage}`,
    `rawTokens=${manifest.rawTokens} compressedSourceTokens=${manifest.compressedSourceTokens} compressedOutputTokens=${manifest.compressedOutputTokens} finalEvidenceTokens=${manifest.finalEvidenceTokens} evidenceBudgetTokens=${manifest.evidenceBudgetTokens}`,
  ].join('\n');
  return segment('evidence-manifest', 'evidence', text, 100, true, 'none', {
    evidenceIds: manifest.representedEvidenceIds,
  });
}

function isAllRetrievedRawMode(input: PlanAwarePromptProjectorInput): boolean {
  return input.callKind === 'synthesize'
    && input.assistantEvidenceProjectionMode === 'all-retrieved'
    && input.evidenceCompressionMode === 'off';
}

function isAllRetrievedCompressionMode(input: PlanAwarePromptProjectorInput): boolean {
  return input.callKind === 'synthesize'
    && input.assistantEvidenceProjectionMode === 'all-retrieved'
    && input.evidenceCompressionMode === 'enforce';
}

function removeCompressedSourceEvidence(
  evidence: readonly PromptProjectionEvidence[],
  artifacts: readonly EvidenceCompressionArtifact[],
): PromptProjectionEvidence[] {
  const compressedIds = new Set(artifacts.flatMap((artifact) => artifact.sourceEvidenceIds));
  return evidence.filter((record) => !compressedIds.has(record.evidenceId));
}

function sortEvidenceForPrompt(evidence: readonly PromptProjectionEvidence[]): PromptProjectionEvidence[] {
  return [...evidence].sort((first, second) =>
    (first.firstSeenSeq ?? Number.MAX_SAFE_INTEGER) - (second.firstSeenSeq ?? Number.MAX_SAFE_INTEGER)
    || (first.lineFrom ?? Number.MAX_SAFE_INTEGER) - (second.lineFrom ?? Number.MAX_SAFE_INTEGER)
    || (first.lineTo ?? Number.MAX_SAFE_INTEGER) - (second.lineTo ?? Number.MAX_SAFE_INTEGER)
    || first.evidenceId.localeCompare(second.evidenceId));
}

function createEvidencePromptManifest(
  input: PlanAwarePromptProjectorInput,
  allEvidence: readonly PromptProjectionEvidence[],
  rawEvidence: readonly PromptProjectionEvidence[],
  artifacts: readonly EvidenceCompressionArtifact[],
  evidenceBudgetTokens: number,
): EvidencePromptManifest {
  const ordered = sortEvidenceForPrompt(allEvidence);
  const rawIds = rawEvidence.map((record) => record.evidenceId);
  const compressedSourceEvidenceIds = [...new Set(artifacts.flatMap((artifact) => artifact.sourceEvidenceIds))];
  const representedEvidenceIds = [...new Set([...rawIds, ...compressedSourceEvidenceIds])];
  const rawTokens = ordered.reduce((total, record) => total + estimateTokenCount(record.text), 0);
  const compressedSourceTokens = artifacts.reduce((total, artifact) => total + artifact.sourceTokenCount, 0);
  const compressedOutputTokens = artifacts.reduce((total, artifact) => total + artifact.compressedTokenCount, 0);
  const turnRetrievedEvidenceIds = ordered.map((record) => record.evidenceId);
  const snapshotId = input.snapshotId ?? ordered.find((record) => record.snapshotId)?.snapshotId ?? '';
  const contentHash = input.contentHash ?? ordered.find((record) => record.contentHash)?.contentHash ?? '';
  return {
    snapshotId,
    contentHash,
    searchRetrievedEvidenceIds: ordered
      .filter((record) => record.admission === 'search-hit' || record.admissions?.includes('search-hit'))
      .map((record) => record.evidenceId),
    turnRetrievedEvidenceIds,
    rawEvidenceIds: rawIds,
    compressedSourceEvidenceIds,
    compressionArtifactIds: artifacts.map((artifact) => artifact.artifactId),
    representedEvidenceIds,
    missingEvidenceIds: turnRetrievedEvidenceIds.filter((evidenceId) => !representedEvidenceIds.includes(evidenceId)),
    rawTokens,
    compressedSourceTokens,
    compressedOutputTokens,
    finalEvidenceTokens: rawEvidence.reduce((total, record) => total + estimateTokenCount(record.text), 0) + compressedOutputTokens,
    evidenceBudgetTokens,
    representationCoverage: turnRetrievedEvidenceIds.length > 0 ? representedEvidenceIds.filter((evidenceId) => turnRetrievedEvidenceIds.includes(evidenceId)).length / turnRetrievedEvidenceIds.length : 1,
    compressionRounds: input.compressionRounds ?? (artifacts.length > 0 ? 1 : 0),
    compressionBatchCount: artifacts.length,
  };
}

function finalizeEvidencePromptManifest(
  segments: readonly PromptSegment[],
  input: PlanAwarePromptProjectorInput,
  allEvidence: readonly PromptProjectionEvidence[],
  rawEvidence: readonly PromptProjectionEvidence[],
  artifacts: readonly EvidenceCompressionArtifact[],
): EvidencePromptManifest {
  const finalEvidenceTokens = rawEvidence.reduce((total, record) => total + estimateTokenCount(record.text), 0)
    + artifacts.reduce((total, artifact) => total + artifact.compressedTokenCount, 0);
  const renderedPromptTokens = estimateTokenCount(renderPromptSegments(segments));
  const allNonEvidenceAndFramingTokens = Math.max(0, renderedPromptTokens - finalEvidenceTokens);
  const evidenceBudgetTokens = calculateEvidencePayloadBudgetTokens(input.maxPromptTokens ?? 0, allNonEvidenceAndFramingTokens);
  return createEvidencePromptManifest(input, allEvidence, rawEvidence, artifacts, evidenceBudgetTokens);
}

function createCitationSegments(input: PlanAwarePromptProjectorInput, evidence: readonly PromptProjectionEvidence[]): PromptSegment[] {
  return [
    ...(input.answer?.trim() ? [segment('citation-answer', 'conversation-hot', input.answer.trim(), 90, true, 'none')] : []),
    ...(input.citationError?.trim() ? [segment('citation-error', 'tool-observation', input.citationError.trim(), 80, true, 'none')] : []),
    segment('allowed-evidence', 'evidence', `allowedEvidenceIds=${(input.allowedEvidenceIds ?? evidence.map((record) => record.evidenceId)).join(',') || 'none'}`, 100, true, 'none', { evidenceIds: evidence.map((record) => record.evidenceId) }),
    createEvidenceSegment(evidence, 'citation-evidence'),
  ];
}

function createConversationSegment(messages: readonly AssistantConversationMessage[]): PromptSegment {
  const selected = messages.slice(-6).map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim().slice(-800)}`);
  return segment('conversation', 'conversation-hot', selected.join('\n') || '无', 55, false, 'summarize');
}

function selectMinimalEvidence(
  plan: SearchPlan,
  evidence: readonly PromptProjectionEvidence[],
  protection = deriveEvidenceProtectionSet(plan, evidence, 'synthesize'),
): PromptProjectionEvidence[] {
  const byId = new Map(evidence.map((record) => [record.evidenceId, record]));
  const selectedIds = new Set(protection.protectedEvidenceIds);
  return [...selectedIds]
    .map((evidenceId) => byId.get(evidenceId))
    .filter((record): record is PromptProjectionEvidence => Boolean(record))
    .sort(compareEvidence);
}

/** Derives per-call protection from the authoritative bindings only. */
export function deriveEvidenceProtectionSet(
  plan: SearchPlan,
  evidence: readonly PromptProjectionEvidence[],
  callKind: Extract<PlanProjectionCallKind, 'decide' | 'synthesize'>,
  recentEvidenceIds: readonly string[] = [],
  failedEvidenceIds: readonly string[] = [],
): EvidenceProtectionSet {
  const byId = new Map(evidence.map((record) => [record.evidenceId, record]));
  const protectedIds = new Set<string>();
  const conflictIds = new Set<string>();
  const requiredIds = new Set<string>();
  const missingIds = new Set<string>();
  const missingRequirements: EvidenceProtectionRequirement[] = [];
  const states: Record<string, EvidenceProjectionState> = {};
  const goals = callKind === 'decide'
    ? plan.goals.filter((goal) => goal.goalId === plan.activeGoalId)
    : plan.goals;

  for (const goal of goals) {
    for (const requirement of goal.requirements) {
      const binding = goal.evidenceBindings.find((candidate) => candidate.requirementId === requirement.requirementId);
      const boundIds = distinctExisting(binding?.evidenceIds ?? [], byId);
      const selected = callKind === 'synthesize'
        ? selectRequirementEvidence(goal.status, boundIds, requirement.minEvidence)
        : selectRequirementEvidence(goal.status, boundIds, requirement.minEvidence, true);
      const satisfied = boundIds.length >= requirement.minEvidence;
      if (callKind === 'synthesize' || !satisfied) {
        for (const evidenceId of selected) {
          protectedIds.add(evidenceId);
          requiredIds.add(evidenceId);
        }
      }
      if (!satisfied) {
        missingRequirements.push({ goalId: goal.goalId, requirementId: requirement.requirementId, minEvidence: requirement.minEvidence, selectedEvidenceIds: selected, missing: true });
        for (const evidenceId of binding?.evidenceIds ?? []) if (!byId.has(evidenceId)) missingIds.add(evidenceId);
      }

      const conflict = goal.conflictBindings.find((candidate) => candidate.requirementId === requirement.requirementId);
      if (conflict) {
        const supportIds = distinctExisting(conflict.supportsEvidenceIds, byId);
        const contradictIds = distinctExisting(conflict.contradictsEvidenceIds, byId);
        const supportSelected = supportIds.slice(0, Math.max(1, requirement.minEvidence));
        const contradictSelected = contradictIds.slice(0, Math.max(1, requirement.minEvidence));
        for (const evidenceId of [...supportSelected, ...contradictSelected]) {
          protectedIds.add(evidenceId);
          conflictIds.add(evidenceId);
          requiredIds.add(evidenceId);
        }
        for (const evidenceId of [...conflict.supportsEvidenceIds, ...conflict.contradictsEvidenceIds]) {
          if (!byId.has(evidenceId)) missingIds.add(evidenceId);
        }
      }
    }
  }

  if (callKind === 'decide') {
    for (const evidenceId of [...recentEvidenceIds, ...failedEvidenceIds]) {
      if (byId.has(evidenceId)) protectedIds.add(evidenceId);
    }
  }
  for (const evidenceId of protectedIds) states[evidenceId] = 'hot';
  for (const record of evidence) states[record.evidenceId] ??= callKind === 'decide' ? 'warm' : 'cold';
  return {
    callKind,
    protectedEvidenceIds: [...protectedIds].sort(compareText),
    conflictEvidenceIds: [...conflictIds].sort(compareText),
    requiredEvidenceIds: [...requiredIds].sort(compareText),
    missingEvidenceIds: [...missingIds].sort(compareText),
    missingRequirements,
    states,
  };
}

/**
 * Stage 5 cold-batch protection. This is deliberately structural: it uses
 * SearchPlan conflict bindings, per-goal scores, recent reads and short raw
 * records only. It does not inspect keywords or invent semantic importance.
 */
export function deriveEvidenceCompressionProtectionIds(
  plan: SearchPlan | undefined,
  evidence: readonly PromptProjectionEvidence[],
): string[] {
  const byId = new Map(evidence.map((record) => [record.evidenceId, record]));
  const protectedIds = new Set<string>();
  for (const goal of plan?.goals ?? []) {
    for (const conflict of goal.conflictBindings) {
      const support = distinctExisting(conflict.supportsEvidenceIds, byId)[0];
      const contradict = distinctExisting(conflict.contradictsEvidenceIds, byId)[0];
      if (support) protectedIds.add(support);
      if (contradict) protectedIds.add(contradict);
    }
    const best = evidence
      .filter((record) => record.goalIds?.includes(goal.goalId) && record.bestScore !== undefined)
      .sort((first, second) => (second.bestScore ?? Number.NEGATIVE_INFINITY) - (first.bestScore ?? Number.NEGATIVE_INFINITY) || compareEvidence(first, second))[0];
    if (best) protectedIds.add(best.evidenceId);
  }
  evidence
    .filter((record) => record.admission === 'explicit-read' || record.admission === 'expanded-read' || record.admissions?.some((admission) => admission === 'explicit-read' || admission === 'expanded-read'))
    .sort((first, second) => (second.firstSeenSeq ?? 0) - (first.firstSeenSeq ?? 0) || compareEvidence(first, second))
    .slice(0, 2)
    .forEach((record) => protectedIds.add(record.evidenceId));
  evidence.filter((record) => estimateTokenCount(record.text) <= 512).forEach((record) => protectedIds.add(record.evidenceId));
  return sortEvidenceForPrompt([...protectedIds].map((evidenceId) => byId.get(evidenceId)).filter((record): record is PromptProjectionEvidence => Boolean(record))).map((record) => record.evidenceId);
}

function selectRequirementEvidence(status: SearchPlan['goals'][number]['status'], boundIds: string[], minEvidence: number, includeUncovered = false): string[] {
  if (!includeUncovered && status !== 'covered' && status !== 'partial' && status !== 'conflicted') return [];
  return boundIds.slice(0, Math.max(1, minEvidence));
}

function distinctExisting(ids: readonly string[], byId: Map<string, PromptProjectionEvidence>): string[] {
  return [...new Set(ids)]
    .map((evidenceId) => byId.get(evidenceId))
    .filter((record): record is PromptProjectionEvidence => Boolean(record))
    .sort(compareEvidence)
    .map((record) => record.evidenceId);
}

function compareEvidence(first: PromptProjectionEvidence, second: PromptProjectionEvidence): number {
  const firstSpan = first.lineFrom !== undefined && first.lineTo !== undefined ? first.lineTo - first.lineFrom : Number.MAX_SAFE_INTEGER;
  const secondSpan = second.lineFrom !== undefined && second.lineTo !== undefined ? second.lineTo - second.lineFrom : Number.MAX_SAFE_INTEGER;
  return firstSpan - secondSpan || first.evidenceId.localeCompare(second.evidenceId);
}

function selectAllowedEvidence(input: PlanAwarePromptProjectorInput, evidence: readonly PromptProjectionEvidence[]): PromptProjectionEvidence[] {
  const allowed = input.allowedEvidenceIds ? new Set(input.allowedEvidenceIds) : undefined;
  return allowed ? evidence.filter((record) => allowed.has(record.evidenceId)) : evidence.slice(0, 8);
}

function applyProjectionLevel(
  segments: readonly PromptSegment[],
  level: PromptProjectionLevel,
  protection: EvidenceProtectionSet | undefined,
): PromptSegment[] {
  if (level < 3) return [...segments];
  const protectedIds = new Set(protection?.protectedEvidenceIds ?? []);
  return segments.flatMap((current) => {
    if (current.zone !== 'evidence' || current.protected) return [current];
    if (level >= 4 && current.id === 'evidence-directory' && protection) {
      const ids = (current.evidenceIds ?? []).filter((evidenceId) => protectedIds.has(evidenceId));
      const lines = current.text.split('\n').filter((line) => ids.some((evidenceId) => line.startsWith(evidenceId)));
      return [{ ...current, text: lines.join('\n') || '保护集合中尚无可引用原文证据。', estimatedTokens: estimateTokenCount(lines.join('\n') || '保护集合中尚无可引用原文证据。'), evidenceIds: ids }];
    }
    return [{
      ...current,
      text: current.text.replace(/ preview=[^\n]*/gu, '').replace(/state=warm/gu, 'state=cold'),
      estimatedTokens: estimateTokenCount(current.text.replace(/ preview=[^\n]*/gu, '').replace(/state=warm/gu, 'state=cold')),
    }];
  });
}

function createPromptStats(
  callKind: PlanProjectionCallKind,
  projectionLevel: PromptProjectionLevel,
  segments: readonly PromptSegment[],
  plan?: SearchPlan,
  evidenceContextStats?: AssistantPromptStats['evidenceContextStats'],
): AssistantPromptStats {
  const byZone = new Map<string, PromptSegment[]>();
  for (const current of segments) byZone.set(current.zone, [...(byZone.get(current.zone) ?? []), current]);
  const partitions = [...byZone.entries()].map(([zone, values]) => ({
    zone,
    tokens: values.reduce((total, current) => total + current.estimatedTokens, 0),
    protectedTokens: values.filter((current) => current.protected).reduce((total, current) => total + current.estimatedTokens, 0),
    segmentIds: values.map((current) => current.id),
  }));
  const evidence = partitions.find((partition) => partition.zone === 'evidence');
  return {
    callKind,
    projectionLevel,
    ...(plan ? { planId: plan.planId, planVersion: plan.version, activeGoalId: plan.activeGoalId } : {}),
    predictedPromptTokens: segments.reduce((total, current) => total + current.estimatedTokens, 0),
    protectedTokens: segments.filter((current) => current.protected).reduce((total, current) => total + current.estimatedTokens, 0),
    evidenceHotTokens: evidence?.protectedTokens ?? 0,
    evidenceWarmTokens: evidence ? Math.max(0, evidence.tokens - evidence.protectedTokens) : 0,
    evidenceColdTokens: projectionLevel >= 3 && evidence ? Math.max(0, evidence.tokens - evidence.protectedTokens) : 0,
    partitions,
    ...(evidenceContextStats ? { evidenceContextStats } : {}),
  };
}

function mapProjectionLevelToPressure(level: PromptProjectionLevel): UnifiedContextProjection['pressureLevel'] {
  return level;
}

function assertProtectedSegmentProjection(projection: PromptProjection): void {
  if (!projection.contextEnvelope) return;
  for (const protectedSegment of projection.segments.filter((segment) => segment.protected)) {
    const material = projection.contextEnvelope.materials.find((candidate) => candidate.id === `current-note-segment:${protectedSegment.id}`);
    if (!material || material.content !== `[${protectedSegment.zone}]\n${protectedSegment.text}`) {
      throw new Error(`Current Note Envelope 改写了受保护 Segment：${protectedSegment.id}`);
    }
  }
}

function copyEvidence(evidence: readonly PromptProjectionEvidence[]): PromptProjectionEvidence[] {
  return evidence.map((record) => ({ ...record, ...(record.headingPath ? { headingPath: [...record.headingPath] } : {}), ...(record.supports ? { supports: [...record.supports] } : {}) }));
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function collectProtectedEvidenceIds(segments: readonly PromptSegment[]): string[] {
  return [...new Set(segments.filter((segment) => segment.protected).flatMap((segment) => segment.evidenceIds ?? []))].sort();
}

function segment(id: string, zone: PromptZone, text: string, priority: number, protectedSegment: boolean, compressStrategy: PromptCompressionStrategy, links: { planIds?: string[]; goalIds?: string[]; requirementIds?: string[]; evidenceIds?: string[] } = {}): PromptSegment {
  return {
    id,
    zone,
    text,
    estimatedTokens: estimateTokenCount(text),
    priority,
    protected: protectedSegment,
    compressStrategy,
    ...(links.planIds ? { sourceIds: links.planIds } : {}),
    ...(links.goalIds ? { goalIds: links.goalIds } : {}),
    ...(links.requirementIds ? { requirementIds: links.requirementIds } : {}),
    ...(links.evidenceIds ? { evidenceIds: links.evidenceIds } : {}),
  };
}

function assertInput(input: PlanAwarePromptProjectorInput): void {
  if (!input.stablePrefix.trim()) throw new Error('Prompt projection 缺少固定策略。');
  if (!input.question.trim()) throw new Error('Prompt projection 缺少当前问题。');
  if (!input.outputSchema.trim()) throw new Error('Prompt projection 缺少 JSON Schema。');
  if (input.plan && (!Number.isSafeInteger(input.plan.version) || input.plan.version < 1)) throw new Error('Prompt projection 的 planVersion 无效。');
  if ((isAllRetrievedRawMode(input) || isAllRetrievedCompressionMode(input))
    && (!Number.isSafeInteger(input.maxPromptTokens) || (input.maxPromptTokens ?? 0) < 0)) {
    throw new Error('all-retrieved 必须提供有效的 maxPromptTokens。');
  }
  const runtimeSnapshotId = input.contextRuntime?.stateVector.snapshotId;
  const runtimeContentHash = input.contextRuntime?.stateVector.contentHash;
  if (input.snapshotId && runtimeSnapshotId && input.snapshotId !== runtimeSnapshotId) {
    throw new Error('Current Note Context Runtime snapshotId 与 Prompt 输入不一致。');
  }
  if (input.contentHash && runtimeContentHash && input.contentHash !== runtimeContentHash) {
    throw new Error('Current Note Context Runtime contentHash 与 Prompt 输入不一致。');
  }
  if ((input.evidence ?? []).some((record) => record.snapshotId && runtimeSnapshotId && record.snapshotId !== runtimeSnapshotId
    || record.contentHash && runtimeContentHash && record.contentHash !== runtimeContentHash)) {
    throw new Error('Current Note Evidence 已脱离 Context Runtime 当前快照。');
  }
}
