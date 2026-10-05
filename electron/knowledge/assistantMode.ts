export const assistantPlanModes = ['off', 'shadow-plan', 'current-note', 'library-beta', 'default'] as const;
export type AssistantPlanMode = typeof assistantPlanModes[number];

export const adaptiveContextModes = ['off', 'observe', 'enforce'] as const;
export type AdaptiveContextMode = typeof adaptiveContextModes[number];

export const assistantEvidenceProjectionModes = ['minimal', 'all-retrieved'] as const;
export type AssistantEvidenceProjectionMode = typeof assistantEvidenceProjectionModes[number];

export const evidenceCompressionModes = ['off', 'observe', 'enforce'] as const;
export type EvidenceCompressionMode = typeof evidenceCompressionModes[number];

/**
 * 知识库 ReAct Agent 入口开关：on 时知识库问答默认走 ReAct 引擎，
 * 失败自动回退旧流水线（P3 默认开启）；shadow 供影子对比；off 回旧流水线。
 */
export const assistantKnowledgeAgentModes = ['off', 'shadow', 'on'] as const;
export type AssistantKnowledgeAgentMode = typeof assistantKnowledgeAgentModes[number];

export function normalizeAssistantKnowledgeAgentMode(value: unknown): AssistantKnowledgeAgentMode {
  return typeof value === 'string' && (assistantKnowledgeAgentModes as readonly string[]).includes(value)
    ? (value as AssistantKnowledgeAgentMode)
    : 'on';
}

export function shouldUseKnowledgeAgent(mode: AssistantKnowledgeAgentMode): boolean {
  return mode === 'on';
}

/** P2 影子对比：旧链路出回答，新链路后台并行跑、只落详细轨迹。 */
export function shouldShadowKnowledgeAgent(mode: AssistantKnowledgeAgentMode): boolean {
  return mode === 'shadow';
}

export interface AssistantModeConfig {
  assistantPlanMode: AssistantPlanMode;
  adaptiveContextMode: AdaptiveContextMode;
}

export interface AssistantEvidenceModeConfig {
  assistantEvidenceProjectionMode: AssistantEvidenceProjectionMode;
  evidenceCompressionMode: EvidenceCompressionMode;
}

/**
 * Current-note planning is the stable default. Library planning remains an
 * explicit opt-in, and off+enforce is not a legal combination because there is
 * no formal plan projection to enforce.
 */
export function normalizeAssistantModeConfig(input: Partial<AssistantModeConfig> | undefined): AssistantModeConfig {
  const assistantPlanMode = isAssistantPlanMode(input?.assistantPlanMode) ? input.assistantPlanMode : 'current-note';
  const requestedAdaptiveMode = isAdaptiveContextMode(input?.adaptiveContextMode) ? input.adaptiveContextMode : 'observe';
  return {
    assistantPlanMode,
    adaptiveContextMode: assistantPlanMode === 'off' && requestedAdaptiveMode === 'enforce' ? 'observe' : requestedAdaptiveMode,
  };
}

/**
 * Evidence projection is kept separate from the legacy plan/adaptive config so
 * older callers continue to receive the exact two-field mode contract.
 */
export function normalizeAssistantEvidenceModeConfig(input: Partial<AssistantEvidenceModeConfig> | undefined): AssistantEvidenceModeConfig {
  const projectionValue = input?.assistantEvidenceProjectionMode;
  const compressionValue = input?.evidenceCompressionMode;
  const hasValidEvidenceProjectionMode = isAssistantEvidenceProjectionMode(projectionValue);
  const hasValidEvidenceCompressionMode = isEvidenceCompressionMode(compressionValue);
  const requestedEvidenceProjectionMode = hasValidEvidenceProjectionMode ? projectionValue : 'minimal';
  const requestedEvidenceCompressionMode = hasValidEvidenceCompressionMode ? compressionValue : 'observe';
  const evidenceModeIsValid = hasValidEvidenceProjectionMode && hasValidEvidenceCompressionMode
    && !(requestedEvidenceProjectionMode === 'minimal' && requestedEvidenceCompressionMode === 'enforce');
  return {
    assistantEvidenceProjectionMode: evidenceModeIsValid ? requestedEvidenceProjectionMode : 'minimal',
    evidenceCompressionMode: evidenceModeIsValid ? requestedEvidenceCompressionMode : 'observe',
  };
}

export function shouldUseCurrentNotePlanner(planMode: AssistantPlanMode): boolean {
  return planMode === 'current-note' || planMode === 'library-beta' || planMode === 'default';
}

export function shouldUseLibraryPlanner(planMode: AssistantPlanMode, optedIn = true): boolean {
  return optedIn && (planMode === 'library-beta' || planMode === 'default');
}

export function shouldRunShadowPlanner(planMode: AssistantPlanMode): boolean {
  return planMode === 'shadow-plan';
}

function isAssistantPlanMode(value: unknown): value is AssistantPlanMode {
  return typeof value === 'string' && (assistantPlanModes as readonly string[]).includes(value);
}

function isAdaptiveContextMode(value: unknown): value is AdaptiveContextMode {
  return typeof value === 'string' && (adaptiveContextModes as readonly string[]).includes(value);
}

function isAssistantEvidenceProjectionMode(value: unknown): value is AssistantEvidenceProjectionMode {
  return typeof value === 'string' && (assistantEvidenceProjectionModes as readonly string[]).includes(value);
}

function isEvidenceCompressionMode(value: unknown): value is EvidenceCompressionMode {
  return typeof value === 'string' && (evidenceCompressionModes as readonly string[]).includes(value);
}
