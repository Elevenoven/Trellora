import { expansionMarkdownText } from './selectionExpansionMarkdown';

/** Expansion keeps its product threshold independent from current-note QA. */
export const EXPANSION_FULL_NOTE_CHARACTERS = 12_000;
export const EXPANSION_MAX_TARGET_CHARACTERS = 40_000;
export const EXPANSION_DEFAULT_RATIO = 1.8;

export interface SelectionLengthReceipt {
  originalCharacters: number;
  targetCharacters: number;
  minimumCharacters: number;
  actualCharacters: number;
  missingToMinimum: number;
  missingToTarget: number;
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
  if (!Number.isSafeInteger(target) || target <= original) {
    throw new Error('扩写目标必须大于原文有效字符数，请缩小选区或提高目标长度。');
  }
  return target;
}

export function createSelectionLengthReceipt(selectedText: string, candidateText: string, targetCharacters?: number): SelectionLengthReceipt {
  const originalCharacters = countMeaningfulCharacters(selectedText);
  const target = targetCharacters ?? originalCharacters + 1;
  const minimumCharacters = Math.max(originalCharacters + 1, Math.ceil(target * 0.8));
  const actualCharacters = countMeaningfulCharacters(expansionMarkdownText(candidateText));
  return {
    originalCharacters, targetCharacters: target, minimumCharacters, actualCharacters,
    missingToMinimum: Math.max(0, minimumCharacters - actualCharacters),
    missingToTarget: Math.max(0, target - actualCharacters),
  };
}

/** Coordinates in the source projection use UTF-16, just like JS strings. */
export function normalizeSelectionProjection(text: string): string {
  return text.replace(/\s/gu, '');
}
