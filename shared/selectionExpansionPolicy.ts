import { expansionMarkdownText } from './selectionExpansionMarkdown';

/** Expansion keeps its product threshold independent from current-note QA. */
export const EXPANSION_FULL_NOTE_CHARACTERS = 12_000;
export const EXPANSION_MAX_TARGET_CHARACTERS = 40_000;
export const EXPANSION_DEFAULT_RATIO = 1.8;

export interface SelectionLengthReceipt {
  originalCharacters: number;
  targetCharacters: number;
  actualCharacters: number;
}

/** Whitespace is ignored for output length, but punctuation and Unicode count. */
export function countMeaningfulCharacters(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}

export function countFullNoteCharacters(markdown: string): number {
  return Array.from(markdown.replace(/\r\n?/gu, '\n')).length;
}

export function resolveExpansionTarget(selectedText: string, targetCharacters?: number, ratio = EXPANSION_DEFAULT_RATIO): number {
  const original = countMeaningfulCharacters(selectedText);
  const target = Math.min(EXPANSION_MAX_TARGET_CHARACTERS, targetCharacters ?? Math.ceil(original * ratio));
  if (!Number.isSafeInteger(target) || target <= 0) {
    throw new Error('扩写参考目标必须为正整数。');
  }
  return target;
}

/** Length is informational; users review whether the expansion is sufficient. */
export function createSelectionLengthReceipt(selectedText: string, candidateText: string, targetCharacters?: number): SelectionLengthReceipt {
  const originalCharacters = countMeaningfulCharacters(selectedText);
  const target = targetCharacters ?? originalCharacters + 1;
  const actualCharacters = countMeaningfulCharacters(expansionMarkdownText(candidateText));
  return {
    originalCharacters, targetCharacters: target, actualCharacters,
  };
}

/** Coordinates in the source projection use UTF-16, just like JS strings. */
export function normalizeSelectionProjection(text: string): string {
  return text.replace(/\s/gu, '');
}
