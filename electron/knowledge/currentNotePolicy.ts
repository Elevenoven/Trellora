/**
 * Product authorization for putting an entire current note into a model prompt.
 *
 * This is intentionally independent from a provider's context window. The
 * latter may reject an otherwise eligible note, but it can never promote a
 * large note to direct-full mode.
 */
export interface StrictSmallNotePolicy {
  maxCharacters: number;
  maxLines: number;
  maxTokens: number;
  maxContextRatio: number;
}

export interface CurrentNoteSize {
  characters: number;
  lineCount: number;
  tokenEstimate: number;
}

export interface CurrentNoteContextCapacity {
  contextWindowTokens?: number;
  hasOutputAndHistoryReserve: boolean;
}

export type StrictSmallNoteRejection =
  | 'max-characters'
  | 'max-lines'
  | 'max-tokens'
  | 'context-ratio'
  | 'context-reserve';

export interface StrictSmallNoteDecision {
  allowed: boolean;
  rejections: StrictSmallNoteRejection[];
}

export const DEFAULT_STRICT_SMALL_NOTE_POLICY: Readonly<StrictSmallNotePolicy> = Object.freeze({
  maxCharacters: 1_200,
  maxLines: 30,
  maxTokens: 1_600,
  maxContextRatio: 0.08,
});

export function evaluateStrictSmallNotePolicy(
  note: CurrentNoteSize,
  capacity: CurrentNoteContextCapacity,
  policy: StrictSmallNotePolicy = DEFAULT_STRICT_SMALL_NOTE_POLICY,
): StrictSmallNoteDecision {
  const rejections: StrictSmallNoteRejection[] = [];
  if (note.characters > policy.maxCharacters) rejections.push('max-characters');
  if (note.lineCount > policy.maxLines) rejections.push('max-lines');
  if (note.tokenEstimate > policy.maxTokens) rejections.push('max-tokens');

  // An unknown context window is not an authorization to send the full note.
  if (!capacity.contextWindowTokens || note.tokenEstimate > capacity.contextWindowTokens * policy.maxContextRatio) {
    rejections.push('context-ratio');
  }
  if (!capacity.hasOutputAndHistoryReserve) rejections.push('context-reserve');
  return { allowed: rejections.length === 0, rejections };
}

export function assertStrictSmallNoteAllowed(
  note: CurrentNoteSize,
  capacity: CurrentNoteContextCapacity,
  policy: StrictSmallNotePolicy = DEFAULT_STRICT_SMALL_NOTE_POLICY,
): void {
  const decision = evaluateStrictSmallNotePolicy(note, capacity, policy);
  if (!decision.allowed) {
    throw new Error(`当前笔记不满足全文直读硬门槛：${decision.rejections.join('、')}。`);
  }
}
