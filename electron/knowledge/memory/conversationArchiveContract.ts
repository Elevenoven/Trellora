import { createHash } from 'node:crypto';

/** Canonical WK-M6 archive body. Only the user question and final answer enter L3. */
export function renderConversationArchiveText(question: string, answer: string): string {
  return `[Session]\nQ: ${question}\nA: ${answer}`;
}

export function normalizeConversationSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

export function calculateConversationArchiveHash(question: string, answer: string): string {
  return createHash('sha256')
    .update(renderConversationArchiveText(question, answer), 'utf8')
    .digest('hex');
}
