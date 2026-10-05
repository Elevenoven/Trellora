/** Legacy 128K baseline retained for older budgets and the explicit rollback profile. */
export const ASSISTANT_CONTEXT_BUDGET_TOKENS = 131_072;

/** WeKnora-aligned L1 working-memory ceiling. Physical provider limits may be lower. */
export const ASSISTANT_WORKING_MEMORY_MAX_TOKENS = 200_000;

/** Named large-window profiles used by runtime diagnostics and model settings. */
export const ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS = Object.freeze({
  '128k': 131_072,
  '256k': 262_144,
});

/** Unknown models use the strict WeKnora-compatible 200K fallback. */
export const ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS = ASSISTANT_WORKING_MEMORY_MAX_TOKENS;

/** Compact before the provider rejects a request; the remaining space is output/safety headroom. */
export const ASSISTANT_AUTO_COMPACT_RATIO = 0.82;

/** Leaves room for policy, question, short history, tool state, and output. */
export const ASSISTANT_SOURCE_BUDGET_TOKENS = 20_000;
