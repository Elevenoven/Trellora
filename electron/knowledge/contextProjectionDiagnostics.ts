import { estimateTokenCount } from './tokenEstimator';
import type {
  AssistantContextRuntimeMode,
  ContextEnvelope,
  ContextProjection,
  ContextProjectionDiagnostics,
  ContextProjectionZoneDiagnostics,
  ContextZone,
} from './contextRuntimeTypes';

export function createContextProjectionDiagnostics(input: {
  envelope: ContextEnvelope;
  projection?: ContextProjection;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  sendPath: ContextProjectionDiagnostics['sendPath'];
  invariantViolations?: readonly string[];
  recordedAt?: string;
}): ContextProjectionDiagnostics {
  const { envelope, projection } = input;
  const materialById = new Map(envelope.materials.map((material) => [material.id, material]));
  const includedById = new Map((projection?.included ?? []).map((material) => [material.id, material]));
  const omissionById = new Map((projection?.omitted ?? []).map((omission) => [omission.materialId, omission]));
  const zones = new Map<ContextZone, ContextProjectionZoneDiagnostics>();

  for (const material of envelope.materials) {
    const row = zones.get(material.zone) ?? createZoneRow(material.zone);
    const candidateTokens = material.diagnosticCandidateTokens ?? estimateTokenCount(material.content);
    row.candidateTokens += candidateTokens;
    row.candidateMaterials += 1;
    addUnique(row.channels, material.channel);
    addUnique(row.trusts, material.trust);
    if (material.protected) row.protectedMaterials += 1;
    if (material.compressStrategy !== 'none') addUnique(row.compressionActions, material.compressStrategy);
    const included = includedById.get(material.id);
    if (included) {
      row.finalTokens += included.estimatedTokens;
      row.includedMaterials += 1;
    }
    const omission = omissionById.get(material.id);
    if (omission) {
      row.omittedMaterials += 1;
      addUnique(row.compressionActions, `omit:${omission.reason}`);
    }
    zones.set(material.zone, row);
  }

  const profile = envelope.windowProfile;
  const availablePromptTokens = Math.max(0, profile.effectiveContextTokens - profile.reservedOutputTokens - profile.safetyTokens);
  const candidateTokens = envelope.materials.reduce(
    (total, material) => total + (material.diagnosticCandidateTokens ?? estimateTokenCount(material.content)),
    0,
  );
  const stablePrefixEligible = envelope.materials.some((material) => material.cache.prefixEligible
    && includedById.has(material.id));
  const sendPath = input.sendPath;

  return {
    schemaVersion: 1,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(envelope.scope.turnId ? { turnId: envelope.scope.turnId } : {}),
    route: envelope.route,
    callKind: envelope.callKind,
    mode: input.mode,
    sendPath,
    providerId: profile.providerId,
    modelId: profile.modelId,
    pressureLevel: projection?.pressureLevel ?? 0,
    window: {
      ...(profile.runtimeProfileId ? { runtimeProfileId: profile.runtimeProfileId } : {}),
      ...(profile.physicalContextTokens ? { physicalTokens: profile.physicalContextTokens } : {}),
      physicalSource: profile.physicalSource,
      ...(profile.productCapMode ? { productCapMode: profile.productCapMode } : {}),
      productCeilingTokens: profile.productCeilingTokens,
      ...(profile.userCapTokens ? { userCapTokens: profile.userCapTokens } : {}),
      effectiveTokens: profile.effectiveContextTokens,
      autoCompactAtTokens: profile.autoCompactAtTokens,
      outputReserveTokens: profile.reservedOutputTokens,
      safetyTokens: profile.safetyTokens,
      availablePromptTokens,
    },
    tokens: {
      candidate: candidateTokens,
      final: projection?.stats.serializedTokens ?? 0,
      outputReserve: profile.reservedOutputTokens,
      safety: profile.safetyTokens,
    },
    zones: [...zones.values()],
    omissions: (projection?.omitted ?? []).map((omission) => ({
      materialId: omission.materialId,
      zone: materialById.get(omission.materialId)?.zone ?? 'agent-state',
      reason: omission.reason,
      estimatedTokens: omission.estimatedTokens,
    })),
    stablePrefix: {
      ...(projection?.stablePrefixFingerprint ? { fingerprint: projection.stablePrefixFingerprint } : {}),
      cacheEligible: stablePrefixEligible,
      providerCacheHitClaimed: false,
    },
    invariantViolations: (input.invariantViolations ?? []).map(redactDiagnosticMessage),
  };
}

function createZoneRow(zone: ContextZone): ContextProjectionZoneDiagnostics {
  return {
    zone,
    candidateTokens: 0,
    finalTokens: 0,
    candidateMaterials: 0,
    includedMaterials: 0,
    omittedMaterials: 0,
    channels: [],
    trusts: [],
    protectedMaterials: 0,
    compressionActions: [],
  };
}

function addUnique<T extends string>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function redactDiagnosticMessage(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 400);
}
