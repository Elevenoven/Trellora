/**
 * User-visible admission limit for ordinary selection editing.
 *
 * CJK text usually has no whitespace word boundary, so each Han character is
 * counted as one editing unit. Latin and numeric runs remain one word. The
 * model-context check is a separate, request-specific boundary.
 */
export const MAX_SELECTION_EDIT_WORDS = 1_000;

export function countSelectionEditWords(value: string): number {
  return value.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)?.length ?? 0;
}

export function assertSelectionEditWordLimit(value: string): void {
  const count = countSelectionEditWords(value);
  if (count > MAX_SELECTION_EDIT_WORDS) {
    throw new Error(`选中文字不能超过 ${MAX_SELECTION_EDIT_WORDS.toLocaleString('zh-CN')} 词（中文按字计）。`);
  }
}
