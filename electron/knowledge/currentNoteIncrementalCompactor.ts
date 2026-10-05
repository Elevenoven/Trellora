import { estimateTokenCount } from './tokenEstimator';
import { compactPromptSegmentsL1 } from './incrementalContextCompactor';
import type { PromptSegment, PromptZone } from './planAwarePromptProjector';
import type { ContextMaterial, ContextZone } from './contextRuntimeTypes';

export interface CurrentNoteIncrementalCompactionResult {
  materials: ContextMaterial[];
  omittedMaterialIds: string[];
  changedMaterialIds: string[];
}

/**
 * Context Runtime adapter for the established current-note L1 compactor.
 * Protected materials never enter the legacy compactor and remain byte-exact.
 */
export function compactCurrentNoteContextMaterials(
  materials: readonly ContextMaterial[],
): CurrentNoteIncrementalCompactionResult {
  const candidates = materials.filter((material) => !material.protected && !isRuntimeCoreZone(material.zone));
  const compacted = compactPromptSegmentsL1(candidates.map(toPromptSegment));
  const byId = new Map(compacted.segments.map((segment) => [segment.id, segment]));
  const omittedMaterialIds = candidates
    .filter((material) => !byId.has(material.id))
    .map((material) => material.id);
  const omitted = new Set(omittedMaterialIds);
  const changedMaterialIds: string[] = [];
  const output = materials.flatMap((material): ContextMaterial[] => {
    if (material.protected || isRuntimeCoreZone(material.zone)) return [copyMaterial(material)];
    if (omitted.has(material.id)) return [];
    const segment = byId.get(material.id);
    if (!segment) return [copyMaterial(material)];
    if (segment.text !== material.content) changedMaterialIds.push(material.id);
    return [{
      ...copyMaterial(material),
      content: segment.text,
      provenance: mergeProvenance(material, segment),
    } as ContextMaterial];
  });
  return { materials: output, omittedMaterialIds, changedMaterialIds };
}

function isRuntimeCoreZone(zone: ContextZone): boolean {
  // Large Tool Observations belong to L2 Artifact handling. Truncating them at
  // L1 would discard the only raw copy before the Artifact Store can persist it.
  return zone === 'stable-policy'
    || zone === 'current-request'
    || zone === 'output-contract'
    || zone === 'tool-observation';
}

function toPromptSegment(material: ContextMaterial): PromptSegment {
  return {
    id: material.id,
    zone: mapZone(material.zone),
    text: material.content,
    estimatedTokens: estimateTokenCount(material.content),
    priority: material.priority,
    protected: false,
    compressStrategy: material.compressStrategy === 'reference'
      ? 'demote-to-reference'
      : material.compressStrategy === 'summary' ? 'summarize' : material.compressStrategy,
    sourceIds: [...new Set([material.source.id, ...(material.provenance?.sourceIds ?? [])])],
    ...(material.provenance?.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
    ...(material.provenance?.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
    ...(material.provenance?.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
    ...(material.provenance?.snapshotId ? { snapshotId: material.provenance.snapshotId } : {}),
    ...(material.provenance?.contentHash ? { contentHash: material.provenance.contentHash } : {}),
  };
}

function mapZone(zone: ContextZone): PromptZone {
  if (zone === 'stable-policy' || zone === 'project-context') return 'policy';
  if (zone === 'agent-state') return 'execution-trace';
  if (zone === 'dynamic-evidence') return 'evidence';
  if (zone === 'current-request') return 'question';
  return zone;
}

function mergeProvenance(material: ContextMaterial, segment: PromptSegment): ContextMaterial['provenance'] {
  const provenance = material.provenance ?? {};
  return {
    ...provenance,
    ...(segment.sourceIds ? { sourceIds: [...segment.sourceIds] } : {}),
    ...(segment.goalIds ? { goalIds: [...segment.goalIds] } : {}),
    ...(segment.requirementIds ? { requirementIds: [...segment.requirementIds] } : {}),
    ...(segment.evidenceIds ? { evidenceIds: [...segment.evidenceIds] } : {}),
  };
}

function copyMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
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
