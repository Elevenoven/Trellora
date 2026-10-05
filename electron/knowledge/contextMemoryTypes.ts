import type { ContextMaterial, ContextRoute } from './contextRuntimeTypes';
import type { ResolvedSkillDefinitions } from './skillDefinitionResolver';

export interface ContextProjectInput {
  /** Stable product policy already validated by the application. */
  stablePolicy: string;
  /** Optional validated project/Skill constraints without leading separators. */
  validatedInstructions?: string;
  /** Discovery descriptions are separate from selected, protected Skill bodies. */
  skills?: ResolvedSkillDefinitions;
  version: string;
}

export interface ContextMemoryRequest {
  route: ContextRoute;
  workspaceId: string;
  libraryId?: string;
  noteId?: string;
  sessionId: string;
  currentQuestion: string;
  snapshotId?: string;
  contentHash?: string;
  budgets: {
    summaryTokens: number;
    hotTokens: number;
    recallTokens: number;
  };
  projectContext?: ContextProjectInput;
}

export interface ContextMemoryDiagnostics {
  source: string;
  loadedTurns: number;
  loadedSummaries: number;
  recalledTurns: number;
  staleItems: number;
}

export interface ContextMemoryResult {
  materials: ContextMaterial[];
  version: string;
  diagnostics: ContextMemoryDiagnostics;
}

export interface ContextMemoryAdapter {
  readonly id: string;
  supports(request: ContextMemoryRequest): boolean;
  load(request: ContextMemoryRequest): Promise<ContextMemoryResult>;
}

/**
 * Adds cross-route context without competing for the single route adapter.
 * Supplemental failures must be isolated by the registry.
 */
export interface SupplementalContextAdapter extends ContextMemoryAdapter {
  readonly role: 'supplemental';
}
