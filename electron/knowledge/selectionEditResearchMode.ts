/**
 * RA-2 research-agent rollout switch. The user-facing selection editor stays
 * on its established direct route unless an internal environment explicitly
 * selects a research mode.
 */
export const selectionEditResearchModes = ['direct', 'shadow', 'react'] as const;
export type SelectionEditResearchMode = typeof selectionEditResearchModes[number];

/**
 * Shadow invokes an additional model/tool sequence, so it is deliberately
 * unavailable in production and must be explicitly selected in development or
 * tests. Unknown values fail closed to direct.
 */
export function resolveSelectionEditResearchMode(
  rawMode = process.env.MENGHAN_SELECTION_EDIT_RESEARCH_MODE,
  environment = process.env.NODE_ENV,
): SelectionEditResearchMode {
  if (!selectionEditResearchModes.includes(rawMode as SelectionEditResearchMode)) return 'direct';
  const mode = rawMode as SelectionEditResearchMode;
  if (mode === 'shadow' && environment !== 'development' && environment !== 'test') return 'direct';
  return mode;
}
