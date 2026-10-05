import type { ContextMaterial } from './contextRuntimeTypes';

export type ReactResidualMemoryRoute = 'current-note' | 'library';

export interface ReactResidualMemoryRouteReview {
  route: ReactResidualMemoryRoute;
  residualBudget: 'reuse';
  checkpointContract: 'defer';
  qaStorage: 'forbidden';
  blockers: readonly string[];
  requiredBeforeEnforce: readonly string[];
}

export interface ReactResidualMemoryAdaptationReview {
  schemaVersion: 'react-residual-memory-review-v1';
  decision: 'defer-route-enforce';
  sharedBoundary: {
    reusable: readonly ['residual-budget-math', 'checkpoint-semantic-contract'];
    authoritativeState: readonly ['search-plan', 'evidence-ledger', 'tool-trace'];
    forbidden: readonly ['qa-table-reuse', 'authoritative-state-in-conversation-memory'];
  };
  routes: Readonly<Record<ReactResidualMemoryRoute, ReactResidualMemoryRouteReview>>;
}

/**
 * Phase 5 is an executable architecture decision, not a rollout switch. Both
 * ReAct routes may share pure budget/checkpoint contracts only after they own a
 * complete route-local transcript and CAS checkpoint. QA persistence remains
 * private to chat/knowledge-base.
 */
export const REACT_RESIDUAL_MEMORY_ADAPTATION_REVIEW: ReactResidualMemoryAdaptationReview = Object.freeze({
  schemaVersion: 'react-residual-memory-review-v1',
  decision: 'defer-route-enforce',
  sharedBoundary: {
    reusable: ['residual-budget-math', 'checkpoint-semantic-contract'],
    authoritativeState: ['search-plan', 'evidence-ledger', 'tool-trace'],
    forbidden: ['qa-table-reuse', 'authoritative-state-in-conversation-memory'],
  },
  routes: {
    'current-note': {
      route: 'current-note',
      residualBudget: 'reuse',
      checkpointContract: 'defer',
      qaStorage: 'forbidden',
      blockers: [
        'assistant-memory-loads-only-three-terminal-turns',
        'assistant-rolling-summary-has-fixed-character-cap',
        'assistant-checkpoint-is-not-the-residual-checkpoint-contract',
      ],
      requiredBeforeEnforce: [
        'route-local-complete-transcript-after-covered-sequence',
        'route-owned-checkpoint-cas-and-source-hash',
        'residual-two-pass-envelope-assembly',
      ],
    },
    library: {
      route: 'library',
      residualBudget: 'reuse',
      checkpointContract: 'defer',
      qaStorage: 'forbidden',
      blockers: [
        'conversation-is-renderer-provided',
        'react-session-id-is-created-per-turn',
        'route-has-no-transcript-or-checkpoint-authority',
      ],
      requiredBeforeEnforce: [
        'stable-main-process-library-session',
        'route-local-complete-transcript-after-covered-sequence',
        'route-owned-checkpoint-cas-and-source-hash',
      ],
    },
  },
});

/** Conversation materials cannot impersonate or carry ReAct authority. */
export function collectReactConversationMemoryBoundaryViolations(
  route: ReactResidualMemoryRoute,
  materials: readonly ContextMaterial[],
): string[] {
  const violations: string[] = [];
  for (const material of materials) {
    if (material.zone !== 'conversation-summary' && material.zone !== 'conversation-hot') {
      violations.push(`${route} 会话记忆包含非法 Zone：${material.id}/${material.zone}`);
    }
    if (material.channel !== 'user' || material.trust !== 'untrusted-memory') {
      violations.push(`${route} 会话记忆必须保持 User Channel / untrusted-memory：${material.id}`);
    }
    if (material.protected) violations.push(`${route} 会话记忆不得升级为受保护权威材料：${material.id}`);
    if (material.cache.prefixEligible) violations.push(`${route} 会话记忆不得进入稳定前缀：${material.id}`);
    if (material.source.kind.startsWith('qa-')) violations.push(`${route} 会话记忆不得复用 QA 存储身份：${material.id}`);
    if (material.provenance?.planId
      || material.provenance?.goalIds?.length
      || material.provenance?.requirementIds?.length
      || material.provenance?.evidenceIds?.length) {
      violations.push(`${route} 会话记忆不得携带 SearchPlan 或 Evidence Ledger 身份：${material.id}`);
    }
  }
  return violations;
}

export function assertReactConversationMemoryBoundary(
  route: ReactResidualMemoryRoute,
  materials: readonly ContextMaterial[],
): void {
  const violations = collectReactConversationMemoryBoundaryViolations(route, materials);
  if (violations.length) throw new Error(violations.join(' '));
}
