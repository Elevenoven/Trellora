import { estimateTokenCount } from './tokenEstimator';
import type {
  ContextAdmissionDiagnostics,
  ContextEnvelope,
  ContextMaterial,
  ContextOmission,
} from './contextRuntimeTypes';

export interface LazyContextAdmissionInput {
  activePhases?: readonly string[];
  selectedSkillIds?: readonly string[];
  requestedAttachmentIds?: readonly string[];
}

export interface LazyContextAdmissionResult {
  envelope: ContextEnvelope;
  omissions: ContextOmission[];
  diagnostics: ContextAdmissionDiagnostics;
}

/** Deterministic admission only; it does not read files, execute tools, or select Skills. */
export class LazyContextLoader {
  admit(envelope: ContextEnvelope, input: LazyContextAdmissionInput = {}): LazyContextAdmissionResult {
    const activePhases = new Set(input.activePhases ?? []);
    const selectedSkills = new Set(input.selectedSkillIds ?? []);
    const requestedAttachments = new Set(input.requestedAttachmentIds ?? []);
    const admitted: ContextMaterial[] = [];
    const omissions: ContextOmission[] = [];
    const activationReasons = new Set<string>();
    const diagnostics: ContextAdmissionDiagnostics = {
      candidateMaterials: envelope.materials.length,
      admittedMaterials: 0,
      deferredMaterials: 0,
      toolCatalogTokens: 0,
      activeToolDefinitionTokens: 0,
      skillDescriptionTokens: 0,
      selectedSkillBodyTokens: 0,
      attachmentMetadataTokens: 0,
      attachmentContentTokens: 0,
      activationReasons: [],
    };

    for (const material of envelope.materials) {
      const admission = material.admission;
      if (!admission || shouldAdmit(admission, activePhases, selectedSkills, requestedAttachments)) {
        admitted.push(copyMaterial(material));
        if (admission) {
          activationReasons.add(admission.activationReason);
          addAdmissionTokens(diagnostics, admission.kind, estimateTokenCount(material.content));
        }
        continue;
      }
      diagnostics.deferredMaterials += 1;
      omissions.push({
        materialId: material.id,
        reason: 'policy',
        estimatedTokens: estimateTokenCount(material.content),
        detail: `按需准入：${admission.kind} 尚未激活。`,
      });
    }
    diagnostics.admittedMaterials = admitted.length;
    diagnostics.activationReasons = [...activationReasons].sort();
    return { envelope: { ...envelope, materials: admitted }, omissions, diagnostics };
  }
}

function shouldAdmit(
  admission: NonNullable<ContextMaterial['admission']>,
  activePhases: ReadonlySet<string>,
  selectedSkills: ReadonlySet<string>,
  requestedAttachments: ReadonlySet<string>,
): boolean {
  if (admission.activeByDefault) return true;
  if (admission.kind === 'tool-definition') return Boolean(admission.phase && activePhases.has(admission.phase));
  if (admission.kind === 'skill-body') return selectedSkills.has(admission.key);
  if (admission.kind === 'attachment-content') return requestedAttachments.has(admission.key);
  return false;
}

function addAdmissionTokens(diagnostics: ContextAdmissionDiagnostics, kind: NonNullable<ContextMaterial['admission']>['kind'], tokens: number): void {
  if (kind === 'tool-catalog') diagnostics.toolCatalogTokens += tokens;
  else if (kind === 'tool-definition') diagnostics.activeToolDefinitionTokens += tokens;
  else if (kind === 'skill-description') diagnostics.skillDescriptionTokens += tokens;
  else if (kind === 'skill-body') diagnostics.selectedSkillBodyTokens += tokens;
  else if (kind === 'attachment-metadata') diagnostics.attachmentMetadataTokens += tokens;
  else diagnostics.attachmentContentTokens += tokens;
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
