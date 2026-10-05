import {
  ASSISTANT_AUTO_COMPACT_RATIO,
  ASSISTANT_CONTEXT_BUDGET_TOKENS,
  ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS,
  ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS,
  ASSISTANT_WORKING_MEMORY_MAX_TOKENS,
} from './assistantContextBudget';

export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;

export type EffectiveContextWindowSource = 'application-fixed' | 'provider' | 'ollama' | 'configured' | 'known-model' | 'conservative-default';
export type EffectiveContextWindowConfidence = 'exact' | 'declared' | 'estimated';
export type AssistantPhysicalContextSource = 'provider' | 'model-catalog' | 'ollama' | 'user' | 'unknown';
export type AssistantContextWindowMode = 'adaptive-real-window' | 'legacy-fixed-128k';
export type AssistantContextRuntimeProfileId = 'conservative-200k' | '128k' | '256k' | 'custom';
export type AssistantProductContextCapMode = 'follow-model' | 'fixed';

export interface AssistantModelRuntimeProfile {
  providerId: string;
  modelId: string;
  runtimeProfileId: AssistantContextRuntimeProfileId;
  physicalContextTokens?: number;
  physicalSource: AssistantPhysicalContextSource;
  productCapMode: AssistantProductContextCapMode;
  productCeilingTokens: number;
  userCapTokens?: number;
  effectiveContextTokens: number;
  autoCompactAtTokens: number;
  reservedOutputTokens: number;
  safetyTokens: number;
  warnings: string[];
}

export interface EffectiveContextWindow {
  tokens: number;
  applicationCeiling: number;
  source: EffectiveContextWindowSource;
  confidence: EffectiveContextWindowConfidence;
  discoveredTokens?: number;
  configuredCapTokens?: number;
  knownModelTokens?: number;
  modelMaxOutputTokens?: number;
  warning?: string;
  runtimeProfile: AssistantModelRuntimeProfile;
}

export interface EffectiveContextWindowInput {
  applicationCeiling?: number;
  discoveredModelWindow?: number;
  discoveredSource?: Extract<EffectiveContextWindowSource, 'provider' | 'ollama'>;
  configuredModelWindow?: number;
  knownModelWindow?: number;
  modelMaxOutputTokens?: number;
  providerId?: string;
  modelId?: string;
  reservedOutputTokens?: number;
  safetyTokens?: number;
  mode?: AssistantContextWindowMode;
}

/**
 * Resolves the model's real usable window. Every applicable ceiling
 * participates in the minimum, so stale UI metadata can never enlarge a
 * provider-declared or locally discovered physical window.
 */
export function resolveAssistantModelRuntimeProfile(input: EffectiveContextWindowInput = {}): AssistantModelRuntimeProfile {
  const configuredProductCeiling = normalizePositiveInteger(input.applicationCeiling);
  const discoveredTokens = normalizePositiveInteger(input.discoveredModelWindow);
  const userCapTokens = normalizePositiveInteger(input.configuredModelWindow);
  const knownModelTokens = normalizePositiveInteger(input.knownModelWindow);
  const modelMaxOutputTokens = normalizePositiveInteger(input.modelMaxOutputTokens);
  const warnings: string[] = [];

  if (input.mode === 'legacy-fixed-128k') {
    warnings.push('已启用 Legacy Fixed128K 回退模式；该模式不会校验模型真实物理窗口。');
    const productCeiling = ASSISTANT_CONTEXT_BUDGET_TOKENS;
    const safetyTokens = resolveSafetyTokens(productCeiling, input.safetyTokens);
    const reservedOutputTokens = resolveReservedOutputTokens(productCeiling, modelMaxOutputTokens, input.reservedOutputTokens);
    return {
      providerId: input.providerId?.trim() || 'unknown-provider',
      modelId: input.modelId?.trim() || 'unknown-model',
      runtimeProfileId: '128k',
      physicalSource: 'unknown',
      productCapMode: 'fixed',
      productCeilingTokens: ASSISTANT_CONTEXT_BUDGET_TOKENS,
      ...(userCapTokens ? { userCapTokens } : {}),
      effectiveContextTokens: productCeiling,
      autoCompactAtTokens: Math.floor(productCeiling * ASSISTANT_AUTO_COMPACT_RATIO),
      reservedOutputTokens,
      safetyTokens,
      warnings,
    };
  }

  let physicalContextTokens: number;
  let physicalSource: AssistantPhysicalContextSource;
  if (discoveredTokens) {
    physicalContextTokens = discoveredTokens;
    physicalSource = input.discoveredSource === 'ollama' ? 'ollama' : 'provider';
  } else if (knownModelTokens) {
    physicalContextTokens = knownModelTokens;
    physicalSource = 'model-catalog';
  } else if (userCapTokens) {
    physicalContextTokens = userCapTokens;
    physicalSource = 'user';
    warnings.push(`未发现模型窗口元数据，暂按用户设置的 ${userCapTokens} token 上限运行；请确认模型实际支持。`);
  } else {
    physicalContextTokens = ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
    physicalSource = 'unknown';
    warnings.push(`未识别模型上下文窗口，已按保守的 ${ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS} token 运行。`);
  }

  const productCeiling = configuredProductCeiling ?? physicalContextTokens;
  const effectiveContextTokens = Math.min(
    configuredProductCeiling ?? Number.MAX_SAFE_INTEGER,
    physicalContextTokens,
    discoveredTokens ?? Number.MAX_SAFE_INTEGER,
    userCapTokens ?? Number.MAX_SAFE_INTEGER,
    knownModelTokens ?? Number.MAX_SAFE_INTEGER,
  );
  if (configuredProductCeiling && (physicalContextTokens > configuredProductCeiling
    || userCapTokens && userCapTokens > configuredProductCeiling
    || knownModelTokens && knownModelTokens > configuredProductCeiling)) {
    warnings.push(`模型或用户上限超过产品上限，已限制为 ${productCeiling} token。`);
  }
  if (userCapTokens && discoveredTokens && userCapTokens > discoveredTokens) {
    warnings.push(`用户上限 ${userCapTokens} token 高于已发现的物理窗口 ${discoveredTokens} token，已采用较小值。`);
  }
  const safetyTokens = resolveSafetyTokens(effectiveContextTokens, input.safetyTokens);
  const reservedOutputTokens = resolveReservedOutputTokens(effectiveContextTokens, modelMaxOutputTokens, input.reservedOutputTokens);

  return {
    providerId: input.providerId?.trim() || 'unknown-provider',
    modelId: input.modelId?.trim() || 'unknown-model',
    runtimeProfileId: resolveRuntimeProfileId(effectiveContextTokens, physicalSource),
    physicalContextTokens,
    physicalSource,
    productCapMode: configuredProductCeiling ? 'fixed' : 'follow-model',
    productCeilingTokens: productCeiling,
    ...(userCapTokens ? { userCapTokens } : {}),
    effectiveContextTokens,
    autoCompactAtTokens: Math.floor(effectiveContextTokens * ASSISTANT_AUTO_COMPACT_RATIO),
    reservedOutputTokens,
    safetyTokens,
    warnings,
  };
}

export function resolveEffectiveContextWindow(input: EffectiveContextWindowInput = {}): EffectiveContextWindow {
  const runtimeProfile = resolveAssistantModelRuntimeProfile(input);
  const discoveredTokens = normalizePositiveInteger(input.discoveredModelWindow);
  const configuredCapTokens = normalizePositiveInteger(input.configuredModelWindow);
  const knownModelTokens = normalizePositiveInteger(input.knownModelWindow);
  const modelMaxOutputTokens = normalizePositiveInteger(input.modelMaxOutputTokens);
  const legacyFixed = input.mode === 'legacy-fixed-128k';
  const source = legacyFixed || runtimeProfile.productCapMode === 'fixed'
      && runtimeProfile.effectiveContextTokens === runtimeProfile.productCeilingTokens
      && runtimeProfile.physicalContextTokens !== undefined
      && runtimeProfile.physicalContextTokens > runtimeProfile.productCeilingTokens
    ? 'application-fixed'
    : configuredCapTokens !== undefined
      && runtimeProfile.effectiveContextTokens === configuredCapTokens
      && configuredCapTokens < (runtimeProfile.physicalContextTokens ?? Number.MAX_SAFE_INTEGER)
      ? 'configured'
      : knownModelTokens !== undefined
        && runtimeProfile.effectiveContextTokens === knownModelTokens
        && knownModelTokens < (discoveredTokens ?? Number.MAX_SAFE_INTEGER)
        ? 'known-model'
        : runtimeProfile.physicalSource === 'provider' ? 'provider'
          : runtimeProfile.physicalSource === 'ollama' ? 'ollama'
            : runtimeProfile.physicalSource === 'model-catalog' ? 'known-model'
              : runtimeProfile.physicalSource === 'user' ? 'configured'
                : 'conservative-default';
  return {
    tokens: runtimeProfile.effectiveContextTokens,
    applicationCeiling: runtimeProfile.productCeilingTokens,
    source,
    confidence: source === 'application-fixed' || source === 'provider' || source === 'ollama'
      ? 'exact'
      : source === 'conservative-default' ? 'estimated' : 'declared',
    ...(discoveredTokens ? { discoveredTokens } : {}),
    ...(configuredCapTokens ? { configuredCapTokens } : {}),
    ...(knownModelTokens ? { knownModelTokens } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    ...(runtimeProfile.warnings.length ? { warning: runtimeProfile.warnings.join(' ') } : {}),
    runtimeProfile,
  };
}

/**
 * L1 uses a stable 200K product ceiling while the final provider send still
 * observes the resolved physical window and ModelCallCoordinator hard veto.
 */
export function resolveWorkingMemoryWindowTokens(resolvedContextWindowTokens?: number): number {
  const resolved = normalizePositiveInteger(resolvedContextWindowTokens)
    ?? ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
  return Math.min(ASSISTANT_WORKING_MEMORY_MAX_TOKENS, resolved);
}

function resolveReservedOutputTokens(contextWindowTokens: number, modelMaxOutputTokens?: number, requested?: number): number {
  const scaled = Math.max(1_024, Math.floor(contextWindowTokens * 0.125));
  return Math.min(requested ?? 8_192, modelMaxOutputTokens ?? Number.MAX_SAFE_INTEGER, scaled);
}

function resolveSafetyTokens(contextWindowTokens: number, requested?: number): number {
  const configured = normalizePositiveInteger(requested);
  if (configured) return Math.min(configured, contextWindowTokens);
  const ratio = contextWindowTokens < ASSISTANT_CONTEXT_BUDGET_TOKENS ? 0.05 : 0.03125;
  return Math.min(contextWindowTokens, Math.max(2_048, Math.floor(contextWindowTokens * ratio)));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resolveRuntimeProfileId(
  effectiveContextTokens: number,
  physicalSource: AssistantPhysicalContextSource,
): AssistantContextRuntimeProfileId {
  if (physicalSource === 'unknown' && effectiveContextTokens === ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS) return 'conservative-200k';
  if (effectiveContextTokens === ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS['128k']) return '128k';
  if (effectiveContextTokens === ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS['256k']) return '256k';
  return 'custom';
}
