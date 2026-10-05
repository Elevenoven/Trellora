import { estimateTokenCount } from './tokenEstimator';
import { renderContextEnvelope } from './contextRenderer';
import { compactCurrentNoteContextMaterials } from './currentNoteIncrementalCompactor';
import { applyCurrentNoteEvidenceCompression } from './currentNoteEvidenceCompressor';
import type { EvidenceCompressionArtifact } from './evidenceCompressionTypes';
import type { ContextArtifactStore, ContextArtifactRecord } from './contextArtifactStore';
import { ContextPressureCircuitBreaker } from './contextPressureCircuitBreaker';
import type {
  ContextEnvelope,
  ContextMaterial,
  ContextOmission,
  ContextPressureEpisodeDiagnostics,
  ContextProjection,
  ContextProgressivePressureLevel,
} from './contextRuntimeTypes';

export { ContextArtifactStore } from './contextArtifactStore';

export type ContextPressureLevel = ContextProjection['pressureLevel'];

export type ContextPressureActionKind =
  | 'dedupe'
  | 'old-tool-cleanup'
  | 'compact'
  | 'artifact-reference'
  | 'evidence-compression'
  | 'cold-reference'
  | 'trace-state'
  | 'hierarchical-summary'
  | 'bounded-drop';

export interface ContextPressureAction {
  level: ContextPressureLevel;
  kind: ContextPressureActionKind;
  materialIds: string[];
  beforeTokens: number;
  afterTokens: number;
  reason: string;
  artifactId?: string;
}

export interface ContextPressureProjection {
  envelope: ContextEnvelope;
  projection: ContextProjection;
  actions: ContextPressureAction[];
}

export interface ContextPressureAttempt extends ContextPressureProjection {
  fits: boolean;
}

export interface ContextPressureResult extends ContextPressureProjection {
  attempts: ContextPressureAttempt[];
}

export interface ContextPressureControllerOptions {
  artifactStore?: ContextArtifactStore;
  currentNoteEvidenceArtifacts?: readonly EvidenceCompressionArtifact[];
  canReadSource?: (material: ContextMaterial) => boolean;
  artifactThresholdTokens?: number;
  artifactPreviewChars?: number;
}

export interface ContextNonConversationReliefResult extends ContextPressureProjection {
  diagnostics: ContextPressureEpisodeDiagnostics;
}
  
export interface ProjectContextPressureOptions {
  maxPromptTokens?: number;
}

export interface ProjectContextToFitOptions {
  maxPromptTokens: number;
  previousLevel?: ContextPressureLevel;
  maxProjectionAttempts?: number;
}

export class ContextPressureExhaustedError extends Error {
  readonly code = 'CONTEXT_PRESSURE_EXHAUSTED';

  constructor(readonly attempts: readonly ContextPressureAttempt[]) {
    super('上下文在最大投影尝试次数后仍超过模型窗口，未发送模型请求。');
    this.name = 'ContextPressureExhaustedError';
  }
}

/** Bounded, monotonic L0-L5 context pressure controller. */
export class ContextPressureController {
  private readonly artifactThresholdTokens: number;
  private readonly artifactPreviewChars: number;

  constructor(private readonly options: ContextPressureControllerOptions = {}) {
    this.artifactThresholdTokens = normalizePositiveInteger(options.artifactThresholdTokens ?? 1_200, 'Artifact 转换阈值');
    this.artifactPreviewChars = normalizePositiveInteger(options.artifactPreviewChars ?? 480, 'Artifact 预览字符数');
  }

  /**
   * Residual-memory Phase 1 path: immediate large-output Artifact followed by
   * monotonic P1/P2 non-conversation relief. Conversation materials are never
   * removed or rewritten here.
   */
  relieveNonConversation(input: {
    envelope: ContextEnvelope;
    calibrationMultiplier?: number;
    circuitBreaker?: ContextPressureCircuitBreaker;
    materialFingerprint?: string;
  }): ContextNonConversationReliefResult {
    const envelope = input.envelope;
    const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
    const breaker = input.circuitBreaker ?? new ContextPressureCircuitBreaker();
    const episode = breaker.begin({ envelope, ...(input.materialFingerprint ? { fingerprint: input.materialFingerprint } : {}) });
    const omissions: ContextOmission[] = [];
    const actions: ContextPressureAction[] = [];
    const skippedZeroGainActions: string[] = [];
    let materials = envelope.materials.map(copyMaterial);
    const initialProjection = renderContextEnvelope(envelope);
    const initialUWindow = calculateUWindow(envelope, initialProjection, calibrationMultiplier);
    const initialLevel = resolveProgressivePressureLevel(initialUWindow);
    let ineffectiveGain = false;
    let tripped = false;
    let repeatedZeroGain = false;

    const apply = (
      actionKey: string,
      level: ContextPressureLevel,
      transform: (before: readonly ContextMaterial[]) => { materials: ContextMaterial[]; actions: ContextPressureAction[]; omissions?: ContextOmission[] },
    ) => {
      if (episode.shouldSkip(actionKey)) {
        skippedZeroGainActions.push(actionKey);
        repeatedZeroGain = true;
        return;
      }
      const beforeProjection = renderContextEnvelope({ ...envelope, materials });
      const result = transform(materials);
      materials = result.materials;
      actions.push(...result.actions);
      omissions.push(...(result.omissions ?? []));
      const afterProjection = renderContextEnvelope({ ...envelope, materials });
      if (level === 0 && result.actions.length === 0
        && beforeProjection.stats.serializedTokens === afterProjection.stats.serializedTokens) return;
      const outcome = episode.record(actionKey, {
        beforeTokens: beforeProjection.stats.serializedTokens,
        afterTokens: afterProjection.stats.serializedTokens,
      });
      ineffectiveGain ||= outcome.ineffective;
      tripped ||= outcome.tripped;
      if (result.actions.length === 0 && beforeProjection.stats.serializedTokens === afterProjection.stats.serializedTokens) {
        actions.push({
          level,
          kind: level === 1 ? 'old-tool-cleanup' : level === 2 ? 'cold-reference' : 'artifact-reference',
          materialIds: [],
          beforeTokens: beforeProjection.stats.serializedTokens,
          afterTokens: afterProjection.stats.serializedTokens,
          reason: `${actionKey} 没有可安全执行的候选。`,
        });
      }
    };

    apply('p0-immediate-tool-artifact', 0, (before) => {
      const nextActions: ContextPressureAction[] = [];
      return {
        materials: before.map((material) => this.materializeLargeToolObservation(envelope, material, nextActions, 0)),
        actions: nextActions,
      };
    });

    let currentProjection = renderContextEnvelope({ ...envelope, materials });
    let currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    if (!tripped && currentUWindow >= 0.80) {
      apply('p1-tool-cleanup', 1, (before) => applyP1Cleanup(before));
      currentProjection = renderContextEnvelope({ ...envelope, materials });
      currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    }
    if (!tripped && currentUWindow >= 0.90) {
      apply('p2-artifact-evidence-trace-reference', 2, (before) => this.applyP2Relief(envelope, before, calibrationMultiplier));
      currentProjection = renderContextEnvelope({ ...envelope, materials });
      currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    }

    assertProtectedMaterialsPreserved(envelope.materials, materials);
    assertConversationMaterialsPreserved(envelope.materials, materials);
    const finalLevel = resolveProgressivePressureLevel(currentUWindow);
    const projectedEnvelope: ContextEnvelope = { ...envelope, materials };
    const projection: ContextProjection = {
      ...currentProjection,
      pressureLevel: pressureLevelNumber(finalLevel),
      omitted: omissions,
      stats: {
        ...currentProjection.stats,
        candidateMaterials: envelope.materials.length,
        omittedMaterials: omissions.length,
      },
    };
    return {
      envelope: projectedEnvelope,
      projection,
      actions,
      diagnostics: {
        pressureEpisodeId: episode.pressureEpisodeId,
        materialFingerprint: episode.materialFingerprint,
        initialLevel,
        finalLevel,
        initialUWindow,
        finalUWindow: currentUWindow,
        minPressureGainTokens: episode.minPressureGainTokens,
        stoppedReason: repeatedZeroGain
          ? 'repeated-zero-gain'
          : tripped
            ? 'ineffective-gain'
            : initialUWindow < 0.80
              ? 'below-p1'
              : currentUWindow < 0.90
                ? 'below-p2'
                : finalLevel === 'P1'
                  ? 'p1-complete'
                  : 'p2-complete',
        ineffectiveGain,
        actions: actions.map((action) => ({
          level: progressiveLevelFromNumber(action.level),
          kind: action.kind,
          materialIds: [...action.materialIds],
          beforeTokens: action.beforeTokens,
          afterTokens: action.afterTokens,
          releasedTokens: Math.max(0, action.beforeTokens - action.afterTokens),
          reason: action.reason,
          ...(action.artifactId ? { artifactId: action.artifactId } : {}),
        })),
        skippedZeroGainActions,
      },
    };
  }

  projectAtLevel(
    envelope: ContextEnvelope,
    level: ContextPressureLevel,
    options: ProjectContextPressureOptions = {},
  ): ContextPressureProjection {
    assertPressureLevel(level);
    let materials = envelope.materials.map(copyMaterial);
    const omissions: ContextOmission[] = [];
    const actions: ContextPressureAction[] = [];

    if (level >= 1) {
      const compacted = envelope.route === 'current-note'
        ? compactCurrentNoteContextMaterials(materials)
        : dedupeExactMaterials(materials);
      for (const materialId of compacted.omittedMaterialIds) {
        const original = materials.find((material) => material.id === materialId);
        if (original) omissions.push(toOmission(original, 'duplicate', 'L1 合并完全相同的非受保护材料。'));
      }
      for (const materialId of compacted.changedMaterialIds) {
        const before = materials.find((material) => material.id === materialId);
        const after = compacted.materials.find((material) => material.id === materialId);
        if (before && after) actions.push(toAction(1, 'compact', [materialId], before.content, after.content, '复用当前笔记确定性 L1 压缩策略。'));
      }
      if (compacted.omittedMaterialIds.length) {
        const beforeTokens = sumMaterialTokens(materials.filter((material) => compacted.omittedMaterialIds.includes(material.id)));
        actions.push({
          level: 1,
          kind: 'dedupe',
          materialIds: [...compacted.omittedMaterialIds],
          beforeTokens,
          afterTokens: 0,
          reason: '合并完全相同的非受保护材料，并保留首个来源身份。',
        });
      }
      materials = compacted.materials;
    }

    if (level >= 2) {
      materials = materials.map((material) => this.materializeLargeToolObservation(envelope, material, actions));
    }

    if (level >= 3) {
      if (envelope.route === 'current-note') {
        const compressed = applyCurrentNoteEvidenceCompression(
          materials,
          this.options.currentNoteEvidenceArtifacts ?? [],
        );
        for (const materialId of compressed.changedMaterialIds) {
          const before = materials.find((material) => material.id === materialId);
          const after = compressed.materials.find((material) => material.id === materialId);
          if (before && after) actions.push(toAction(3, 'evidence-compression', [materialId], before.content, after.content, '复用已经校验的当前笔记证据压缩 Artifact；不改写 SearchPlan 或 Evidence Ledger。'));
        }
        materials = compressed.materials;
      }
      materials = materials.map((material) => this.referenceReadableColdMaterial(material, actions));
    }

    if (level >= 4) {
      const hierarchical = applyHierarchicalSummaries(materials);
      for (const removed of hierarchical.removed) {
        omissions.push(toOmission(removed, 'budget', 'L4 已由可追溯分层摘要覆盖，原始轮次仍保留在问答数据库。'));
      }
      if (hierarchical.removed.length) {
        actions.push({
          level: 4,
          kind: 'hierarchical-summary',
          materialIds: hierarchical.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(hierarchical.removed),
          afterTokens: 0,
          reason: '用同会话、含来源范围的高层摘要覆盖冷历史；数据库原始 Turn 不变。',
        });
      }
      materials = hierarchical.materials;
    }

    if (level >= 5 && Number.isFinite(options.maxPromptTokens)) {
      const dropped = dropBoundedOverflowMaterials(envelope, materials, Number(options.maxPromptTokens));
      for (const removed of dropped.removed) omissions.push(toOmission(removed, 'policy', 'L5 仅移除 overflowPolicy=drop 的非受保护低优先级材料。'));
      if (dropped.removed.length) {
        actions.push({
          level: 5,
          kind: 'bounded-drop',
          materialIds: dropped.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(dropped.removed),
          afterTokens: 0,
          reason: '在核心策略、当前问题、输出契约、Plan 身份和受保护证据之外执行有界舍弃。',
        });
      }
      materials = dropped.materials;
    }

    assertProtectedMaterialsPreserved(envelope.materials, materials);
    const projectedEnvelope: ContextEnvelope = { ...envelope, materials };
    const rendered = renderContextEnvelope(projectedEnvelope);
    const projection: ContextProjection = {
      ...rendered,
      pressureLevel: level,
      omitted: omissions,
      stats: {
        ...rendered.stats,
        candidateMaterials: envelope.materials.length,
        omittedMaterials: omissions.length,
      },
    };
    return { envelope: projectedEnvelope, projection, actions };
  }

  projectToFit(envelope: ContextEnvelope, options: ProjectContextToFitOptions): ContextPressureResult {
    const maxPromptTokens = normalizeNonNegativeInteger(options.maxPromptTokens, '最大 Prompt token');
    const previousLevel = options.previousLevel ?? 0;
    assertPressureLevel(previousLevel);
    const maxAttempts = normalizeAttemptCount(options.maxProjectionAttempts ?? 3);
    const attemptLevels = buildAttemptLevels(previousLevel, maxAttempts);
    const attempts: ContextPressureAttempt[] = [];
    for (const level of attemptLevels) {
      const result = this.projectAtLevel(envelope, level, { maxPromptTokens });
      const attempt: ContextPressureAttempt = {
        ...result,
        fits: result.projection.stats.serializedTokens <= maxPromptTokens,
      };
      attempts.push(attempt);
      if (attempt.fits) return { ...result, attempts };
    }
    throw new ContextPressureExhaustedError(attempts);
  }

  private materializeLargeToolObservation(
    envelope: ContextEnvelope,
    material: ContextMaterial,
    actions: ContextPressureAction[],
    actionLevel: 0 | 2 = 2,
  ): ContextMaterial {
    if (material.protected
      || material.zone !== 'tool-observation'
      || material.channel !== 'tool'
      || estimateTokenCount(material.content) < this.artifactThresholdTokens
      || !this.options.artifactStore
      || !envelope.scope.sessionId
      || !envelope.scope.turnId) return material;
    let artifact: ContextArtifactRecord;
    try {
      artifact = this.options.artifactStore.write({
        sessionId: envelope.scope.sessionId,
        turnId: envelope.scope.turnId,
        materialId: material.id,
        sourceTool: material.toolName ?? material.source.kind,
        content: material.content,
      });
      this.options.artifactStore.read({
        sessionId: envelope.scope.sessionId,
        turnId: envelope.scope.turnId,
        artifactId: artifact.artifactId,
      });
    } catch {
      return material;
    }
    const content = renderArtifactReference(artifact, this.artifactPreviewChars);
    if (estimateTokenCount(content) >= estimateTokenCount(material.content)) return material;
    actions.push({
      ...toAction(actionLevel, 'artifact-reference', [material.id], material.content, content, '大型 Tool Observation 已脱离 Prompt，并通过完整性校验后的 Artifact ID 读取。'),
      artifactId: artifact.artifactId,
    });
    return {
      ...material,
      content,
      compressStrategy: 'reference',
      source: { ...material.source, version: `${material.source.version}:${artifact.sha256}` },
      provenance: {
        ...material.provenance,
        sourceIds: [...new Set([...(material.provenance?.sourceIds ?? []), artifact.artifactId])],
        contentHash: artifact.sha256,
      },
    } as ContextMaterial;
  }

  private referenceReadableColdMaterial(
    material: ContextMaterial,
    actions: ContextPressureAction[],
    actionLevel: 2 | 3 = 3,
  ): ContextMaterial {
    if (material.protected
      || material.compressStrategy !== 'reference'
      || material.zone !== 'dynamic-evidence' && material.zone !== 'agent-state'
      || !this.options.canReadSource?.(material)) return material;
    const ids = [material.source.id, ...(material.provenance?.sourceIds ?? []), ...(material.provenance?.evidenceIds ?? [])];
    const content = `[冷材料引用]\nsource=${material.source.kind}:${material.source.id}@${material.source.version}\nids=${[...new Set(ids)].sort().join(',')}`;
    if (estimateTokenCount(content) >= estimateTokenCount(material.content)) return material;
    actions.push(toAction(actionLevel, 'cold-reference', [material.id], material.content, content, '来源已确认可读，将冷证据或执行轨迹降为目录引用。'));
    return { ...material, content } as ContextMaterial;
  }

  private applyP2Relief(
    envelope: ContextEnvelope,
    inputMaterials: readonly ContextMaterial[],
    calibrationMultiplier: number,
  ): { materials: ContextMaterial[]; actions: ContextPressureAction[]; omissions: ContextOmission[] } {
    const actions: ContextPressureAction[] = [];
    const omissions: ContextOmission[] = [];
    let materials = inputMaterials.map((material) => this.materializeLargeToolObservation(envelope, material, actions));
    materials = materials.map((material) => this.referenceReadableColdMaterial(material, actions, 2));
    const trace = stateizeCompletedTrace(materials);
    materials = trace.materials;
    actions.push(...trace.actions);
    omissions.push(...trace.omissions);
    const targetPromptTokens = Math.max(0, Math.floor(envelope.windowProfile.effectiveContextTokens * 0.90)
      - envelope.windowProfile.reservedOutputTokens - envelope.windowProfile.safetyTokens);
    if (calculateUWindow(envelope, renderContextEnvelope({ ...envelope, materials }), calibrationMultiplier) >= 0.90) {
      const dropped = dropBoundedOverflowMaterials(envelope, materials, targetPromptTokens);
      for (const removed of dropped.removed) omissions.push(toOmission(removed, 'policy', 'P2 仅省略可重读、无活动依赖且允许 drop 的非会话材料。'));
      if (dropped.removed.length) {
        actions.push({
          level: 2,
          kind: 'bounded-drop',
          materialIds: dropped.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(dropped.removed),
          afterTokens: 0,
          reason: 'P2 在受保护材料之外执行有界省略，权威来源保持不变。',
        });
      }
      materials = dropped.materials;
    }
    return { materials, actions, omissions };
  }
}

function applyP1Cleanup(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  actions: ContextPressureAction[];
  omissions: ContextOmission[];
} {
  const deduped = dedupeExactMaterials(materials);
  const omissions: ContextOmission[] = [];
  const actions: ContextPressureAction[] = [];
  const duplicateMaterials = materials.filter((material) => deduped.omittedMaterialIds.includes(material.id));
  for (const material of duplicateMaterials) omissions.push(toOmission(material, 'duplicate', 'P1 合并完全相同的非受保护材料。'));
  if (duplicateMaterials.length) {
    actions.push({
      level: 1,
      kind: 'dedupe',
      materialIds: duplicateMaterials.map((material) => material.id),
      beforeTokens: sumMaterialTokens(duplicateMaterials),
      afterTokens: 0,
      reason: 'P1 精确去重并合并 provenance。',
    });
  }
  const cleanup = cleanupOldToolObservations(deduped.materials);
  for (const material of cleanup.removed) omissions.push(toOmission(material, 'stale', 'P1 清理已过期、已被覆盖且可重读的旧 Tool Observation。'));
  if (cleanup.removed.length) {
    actions.push({
      level: 1,
      kind: 'old-tool-cleanup',
      materialIds: cleanup.removed.map((material) => material.id),
      beforeTokens: sumMaterialTokens(cleanup.removed),
      afterTokens: 0,
      reason: '保留最新成功结果、最新错误/纠正和活动依赖，仅省略可重读旧输出。',
    });
  }
  return { materials: cleanup.materials, actions, omissions };
}

function cleanupOldToolObservations(materials: readonly ContextMaterial[]): { materials: ContextMaterial[]; removed: ContextMaterial[] } {
  const groups = new Map<string, ContextMaterial[]>();
  for (const material of materials) {
    if (material.zone !== 'tool-observation' || material.protected || material.lifecycle?.activeDependency) continue;
    const key = material.toolName?.trim() || `${material.source.kind}:${material.source.id}`;
    const group = groups.get(key) ?? [];
    group.push(material);
    groups.set(key, group);
  }
  const removeIds = new Set<string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (right.lifecycle?.sequence ?? 0) - (left.lifecycle?.sequence ?? 0)
      || right.id.localeCompare(left.id));
    let latestSuccessKept = false;
    let latestCorrectionKept = false;
    let latestErrorKept = false;
    for (const material of ordered) {
      const status = material.lifecycle?.status;
      const rereadable = material.lifecycle?.rereadable === true;
      if (status === 'correction' && !latestCorrectionKept) { latestCorrectionKept = true; continue; }
      if (status === 'error' && !latestErrorKept) { latestErrorKept = true; continue; }
      if ((status === 'completed' || status === 'active' || status === undefined) && !latestSuccessKept) { latestSuccessKept = true; continue; }
      if (rereadable && (status === 'stale' || status === 'superseded' || status === 'completed')) removeIds.add(material.id);
    }
  }
  return {
    materials: materials.filter((material) => !removeIds.has(material.id)),
    removed: materials.filter((material) => removeIds.has(material.id)),
  };
}

function stateizeCompletedTrace(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  actions: ContextPressureAction[];
  omissions: ContextOmission[];
} {
  const candidates = materials.filter((material) => !material.protected
    && !material.lifecycle?.activeDependency
    && material.lifecycle?.status === 'completed'
    && material.lifecycle.rereadable
    && (material.zone === 'agent-state' || /trace|progress|planner/iu.test(material.source.kind)));
  if (candidates.length < 2) return { materials: [...materials], actions: [], omissions: [] };
  const keep = [...candidates].sort((left, right) => (right.lifecycle?.sequence ?? 0) - (left.lifecycle?.sequence ?? 0))[0];
  const removed = candidates.filter((material) => material.id !== keep.id);
  const content = `[执行轨迹状态]\nlatest=${keep.source.kind}:${keep.source.id}@${keep.source.version}\ncompleted=${candidates.map((material) => material.id).sort().join(',')}`;
  const replacement = { ...keep, content, compressStrategy: 'reference' as const } as ContextMaterial;
  const output = materials.filter((material) => !candidates.includes(material)).concat(replacement);
  const beforeTokens = sumMaterialTokens(candidates);
  const afterTokens = estimateTokenCount(content);
  if (afterTokens >= beforeTokens) return { materials: [...materials], actions: [], omissions: [] };
  return {
    materials: output,
    actions: [{ level: 2, kind: 'trace-state', materialIds: candidates.map((material) => material.id), beforeTokens, afterTokens, reason: 'P2 将已完成轨迹折叠为可重读状态，活动 Goal、错误和纠正不参与折叠。' }],
    omissions: removed.map((material) => toOmission(material, 'policy', 'P2 已由确定性执行轨迹状态覆盖。')),
  };
}

function dedupeExactMaterials(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  omittedMaterialIds: string[];
  changedMaterialIds: string[];
} {
  const seen = new Map<string, ContextMaterial>();
  const omittedMaterialIds: string[] = [];
  const output: ContextMaterial[] = [];
  for (const material of materials) {
    if (material.protected || isRuntimeCore(material)) {
      output.push(material);
      continue;
    }
    const key = `${material.zone}\u0000${material.channel}\u0000${material.content}`;
    const existing = seen.get(key);
    if (existing) {
      omittedMaterialIds.push(material.id);
      existing.provenance = mergeMaterialProvenance(existing, material);
      continue;
    }
    seen.set(key, material);
    output.push(material);
  }
  return { materials: output, omittedMaterialIds, changedMaterialIds: [] };
}

function mergeMaterialProvenance(first: ContextMaterial, second: ContextMaterial): ContextMaterial['provenance'] {
  const firstProvenance = first.provenance ?? {};
  const secondProvenance = second.provenance ?? {};
  const sourceIds = mergeStrings(
    [first.source.id, ...(firstProvenance.sourceIds ?? [])],
    [second.source.id, ...(secondProvenance.sourceIds ?? [])],
  )!;
  const turnSeqs = mergeNumbers(firstProvenance.turnSeqs, secondProvenance.turnSeqs);
  const goalIds = mergeStrings(firstProvenance.goalIds, secondProvenance.goalIds);
  const requirementIds = mergeStrings(firstProvenance.requirementIds, secondProvenance.requirementIds);
  const evidenceIds = mergeStrings(firstProvenance.evidenceIds, secondProvenance.evidenceIds);
  return {
    ...firstProvenance,
    sourceIds,
    ...(turnSeqs ? { turnSeqs } : {}),
    ...(goalIds ? { goalIds } : {}),
    ...(requirementIds ? { requirementIds } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
  };
}

function applyHierarchicalSummaries(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  removed: ContextMaterial[];
} {
  const rollups = materials.filter((material) => material.zone === 'conversation-summary'
    && material.source.kind === 'qa-summary-rollup'
    && material.provenance?.sessionId
    && material.provenance.turnSeqs?.length);
  if (rollups.length === 0) return { materials: [...materials], removed: [] };
  const coveredBySession = new Map<string, Set<number>>();
  for (const rollup of rollups) {
    const covered = coveredBySession.get(rollup.provenance!.sessionId!) ?? new Set<number>();
    for (const turnSeq of rollup.provenance!.turnSeqs ?? []) covered.add(turnSeq);
    coveredBySession.set(rollup.provenance!.sessionId!, covered);
  }
  const removed: ContextMaterial[] = [];
  const output = materials.filter((material) => {
    if (material.protected || rollups.includes(material)) return true;
    if (material.zone !== 'conversation-summary' && material.zone !== 'conversation-hot') return true;
    const sessionId = material.provenance?.sessionId;
    const turnSeqs = material.provenance?.turnSeqs ?? [];
    const covered = sessionId ? coveredBySession.get(sessionId) : undefined;
    const databaseBacked = material.source.kind === 'qa-turn' || material.source.kind === 'qa-summary-batch';
    if (!databaseBacked || !covered || turnSeqs.length === 0 || turnSeqs.some((turnSeq) => !covered.has(turnSeq))) return true;
    removed.push(material);
    return false;
  });
  return { materials: output, removed };
}

function dropBoundedOverflowMaterials(
  originalEnvelope: ContextEnvelope,
  materials: readonly ContextMaterial[],
  maxPromptTokens: number,
): { materials: ContextMaterial[]; removed: ContextMaterial[] } {
  let output = [...materials];
  const removed: ContextMaterial[] = [];
  const candidates = materials
    .filter((material) => material.overflowPolicy === 'drop' && !isL5Protected(originalEnvelope, material))
    .sort((first, second) => first.priority - second.priority
      || estimateTokenCount(second.content) - estimateTokenCount(first.content)
      || first.id.localeCompare(second.id));
  for (const candidate of candidates) {
    if (renderContextEnvelope({ ...originalEnvelope, materials: output }).stats.serializedTokens <= maxPromptTokens) break;
    output = output.filter((material) => material.id !== candidate.id);
    removed.push(candidate);
  }
  return { materials: output, removed };
}

function isL5Protected(envelope: ContextEnvelope, material: ContextMaterial): boolean {
  if (material.protected || isRuntimeCore(material)) return true;
  if (material.provenance?.planId || material.provenance?.evidenceIds?.length) return true;
  if (/search-plan|evidence-ledger/iu.test(material.source.kind)) return true;
  return envelope.stateVector.planId !== undefined && material.source.id === envelope.stateVector.planId;
}

function isRuntimeCore(material: ContextMaterial): boolean {
  return material.zone === 'stable-policy'
    || material.zone === 'current-request'
    || material.zone === 'output-contract';
}

function assertProtectedMaterialsPreserved(original: readonly ContextMaterial[], projected: readonly ContextMaterial[]): void {
  const byId = new Map(projected.map((material) => [material.id, material]));
  for (const material of original) {
    if (!material.protected) continue;
    const current = byId.get(material.id);
    if (!current || current.content !== material.content) throw new Error(`压力控制改写或遗漏了受保护材料：${material.id}`);
  }
}

function assertConversationMaterialsPreserved(original: readonly ContextMaterial[], projected: readonly ContextMaterial[]): void {
  const conversationZones = new Set(['conversation-summary', 'conversation-hot', 'conversation-recall']);
  const projectedById = new Map(projected.map((material) => [material.id, material]));
  for (const material of original) {
    if (!conversationZones.has(material.zone)) continue;
    const current = projectedById.get(material.id);
    if (!current || current.content !== material.content) throw new Error(`P1/P2 不允许改写或遗漏会话材料：${material.id}`);
  }
}

function calculateUWindow(envelope: ContextEnvelope, projection: ContextProjection, calibrationMultiplier: number): number {
  const profile = envelope.windowProfile;
  if (profile.effectiveContextTokens <= 0) return 1;
  const predictedPromptTokens = Math.ceil(projection.stats.serializedTokens * calibrationMultiplier);
  return (predictedPromptTokens + profile.reservedOutputTokens + profile.safetyTokens) / profile.effectiveContextTokens;
}

function resolveProgressivePressureLevel(utilization: number): ContextProgressivePressureLevel {
  if (utilization >= 1) return 'P4';
  if (utilization >= 0.95) return 'P3';
  if (utilization >= 0.90) return 'P2';
  if (utilization >= 0.80) return 'P1';
  return 'P0';
}

function pressureLevelNumber(level: ContextProgressivePressureLevel): ContextPressureLevel {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 } as const)[level];
}

function progressiveLevelFromNumber(level: ContextPressureLevel): ContextProgressivePressureLevel {
  if (level >= 5) return 'P5';
  if (level >= 4) return 'P4';
  if (level === 3) return 'P3';
  if (level === 2) return 'P2';
  if (level === 1) return 'P1';
  return 'P0';
}

function renderArtifactReference(artifact: ContextArtifactRecord, previewChars: number): string {
  const headChars = Math.ceil(previewChars * 0.65);
  const tailChars = Math.floor(previewChars * 0.25);
  const preview = artifact.content.length <= previewChars
    ? artifact.content
    : `${artifact.content.slice(0, headChars)}\n…（完整内容请按 Artifact ID 读取）…\n${artifact.content.slice(-tailChars)}`;
  return `[Tool Observation Artifact]\nartifactId=${artifact.artifactId}\nsha256=${artifact.sha256}\nbytes=${artifact.byteLength}\nmime=${artifact.mimeType}\npreview:\n${preview}`;
}

function buildAttemptLevels(start: ContextPressureLevel, maxAttempts: number): ContextPressureLevel[] {
  if (maxAttempts === 1 || start === 5) return [start];
  if (maxAttempts === 2) return [...new Set([start, 5])] as ContextPressureLevel[];
  const middle = Math.max(start, 3) as ContextPressureLevel;
  return [...new Set([start, middle, 5])].slice(0, maxAttempts) as ContextPressureLevel[];
}

function toAction(
  level: ContextPressureLevel,
  kind: ContextPressureActionKind,
  materialIds: string[],
  before: string,
  after: string,
  reason: string,
): ContextPressureAction {
  return {
    level,
    kind,
    materialIds,
    beforeTokens: estimateTokenCount(before),
    afterTokens: estimateTokenCount(after),
    reason,
  };
}

function toOmission(material: ContextMaterial, reason: ContextOmission['reason'], detail: string): ContextOmission {
  return { materialId: material.id, reason, estimatedTokens: estimateTokenCount(material.content), detail };
}

function sumMaterialTokens(materials: readonly ContextMaterial[]): number {
  return materials.reduce((total, material) => total + estimateTokenCount(material.content), 0);
}

function mergeStrings(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])].sort();
  return merged.length ? merged : undefined;
}

function mergeNumbers(first: readonly number[] | undefined, second: readonly number[] | undefined): number[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])].sort((left, right) => left - right);
  return merged.length ? merged : undefined;
}

function copyMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
    ...(material.admission ? { admission: { ...material.admission } } : {}),
    ...(material.lifecycle ? { lifecycle: { ...material.lifecycle } } : {}),
    ...(material.provenance ? {
      provenance: {
        ...material.provenance,
        ...(material.provenance.turnSeqs ? { turnSeqs: [...material.provenance.turnSeqs] } : {}),
        ...(material.provenance.sourceIds ? { sourceIds: [...material.provenance.sourceIds] } : {}),
        ...(material.provenance.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
        ...(material.provenance.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
        ...(material.provenance.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
      },
    } : {}),
    cache: { ...material.cache },
  } as ContextMaterial;
}

function assertPressureLevel(value: number): asserts value is ContextPressureLevel {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) throw new Error('上下文压力等级必须位于 L0-L5。');
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负整数。`);
  return Number(value);
}

function normalizeAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error('上下文投影尝试次数必须位于 1-3。');
  return value;
}
