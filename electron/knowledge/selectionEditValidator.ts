import { countMeaningfulCharacters } from '../../shared/selectionExpansionPolicy';
import { expansionMarkdownFormatLosses, expansionMarkdownText } from '../../shared/selectionExpansionMarkdown';
import type {
  SelectionEditAction,
  SelectionEditQualityIssue,
  SelectionEditValidation,
  SelectionEvidenceItem,
} from './selectionEditTypes';
import type { SelectionEditProtectedAnchorKind } from './selectionEditProfiles';

export interface SelectionEditValidationInput {
  action: SelectionEditAction;
  selectedText: string;
  selectedMarkdown?: string;
  candidateText: string;
  targetLanguage?: string;
  evidence: readonly SelectionEvidenceItem[];
  protectedAnchorKinds: readonly SelectionEditProtectedAnchorKind[];
}

/**
 * The model is deliberately not trusted to enforce edit boundaries.  This
 * validator does not attempt to prove prose true; it enforces the stable,
 * deterministic constraints that decide whether a suggestion can be applied
 * inline.  Additive sentences must overlap an already-read evidence record.
 */
export function validateSelectionEditOutput(input: SelectionEditValidationInput): SelectionEditValidation {
  const original = normalizeForValidation(input.selectedText);
  const candidate = normalizeForValidation(input.action === 'expand' ? expansionMarkdownText(input.candidateText) : input.candidateText);
  const protectedAnchorLosses = findProtectedAnchorLosses(
    original,
    input.action === 'expand' ? input.candidateText : candidate,
    input.protectedAnchorKinds,
  );
  const warnings: string[] = [];
  const unsupportedClaims: string[] = [];
  const issues: SelectionEditQualityIssue[] = [];

  if (input.action === 'expand' && input.selectedMarkdown) {
    protectedAnchorLosses.push(...findProtectedAnchorLosses(input.selectedMarkdown, input.candidateText, ['code', 'link-target']));
    const lostFormats = expansionMarkdownFormatLosses(input.selectedMarkdown, input.candidateText);
    if (lostFormats.length) {
      const message = '扩写未保留原文 Markdown 格式';
      warnings.push(message);
      issues.push({ code: 'MARKDOWN_FORMAT_LOST', message, retryable: true });
    }
  }

  if (!candidate) warnings.push('模型没有返回可用建议。');
  if (input.action === 'shorten' && candidate.length >= original.length) {
    warnings.push('精简建议没有比原文更短。');
  }
  if (input.action === 'expand' && countMeaningfulCharacters(candidate) <= countMeaningfulCharacters(original)) {
    const message = '扩写未达到目标长度';
    warnings.push(message);
    issues.push({ code: 'EXPAND_NOT_LONGER', message, retryable: true });
  }
  if (input.action === 'proofread' && isBroadRewrite(original, candidate)) {
    warnings.push('校对建议改写幅度过大。');
  }
  if (input.action === 'translate' && !matchesTargetLanguage(candidate, input.targetLanguage)) {
    warnings.push('翻译结果与目标语言不一致。');
  }

  if (input.action === 'expand' || input.action === 'explain') {
    const additions = findUnsupportedAdditions(original, candidate, input.evidence);
    unsupportedClaims.push(...additions.messages);
    if (additions.messages.length > 0) {
      // Whether a planned evidence goal was covered is decided by the final
      // coordinator gate. Here we only describe this candidate's unsupported
      // new sentence, so result UI never mistakes it for a planning failure.
      issues.push({ code: 'UNSUPPORTED_ADDITION', message: additions.messages[0]!, retryable: true });
    }
  } else if (input.action !== 'translate') {
    const additions = findNewConcreteTokens(original, candidate);
    unsupportedClaims.push(...additions);
    if (additions.length > 0) {
      issues.push({ code: 'UNSUPPORTED_ADDITION', message: additions[0]!, retryable: false });
    }
  }

  if (protectedAnchorLosses.length > 0) {
    issues.push({
      code: 'PROTECTED_ANCHOR_LOST',
      message: `原文关键信息未完整保留：${protectedAnchorLosses.join('、')}`,
      retryable: true,
    });
  }

  return {
    passed: protectedAnchorLosses.length === 0 && warnings.length === 0 && unsupportedClaims.length === 0,
    warnings,
    protectedAnchorLosses,
    unsupportedClaims,
    issues,
  };
}

function normalizeForValidation(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function findProtectedAnchorLosses(
  original: string,
  candidate: string,
  kinds: readonly SelectionEditProtectedAnchorKind[],
): string[] {
  const anchors = new Set<string>();
  for (const kind of kinds) {
    for (const anchor of collectAnchors(original, kind)) anchors.add(anchor);
  }
  return [...anchors].filter((anchor) => !candidate.includes(anchor));
}

function collectAnchors(value: string, kind: SelectionEditProtectedAnchorKind): string[] {
  const patterns: Record<SelectionEditProtectedAnchorKind, RegExp> = {
    number: /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?%?(?![\p{L}\p{N}])/gu,
    date: /\b\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/gu,
    url: /(?:https?:\/\/|www\.)[^\s)\]}>,]+/giu,
    code: /`[^`\n]+`|```[\s\S]*?```/gu,
    'proper-noun': /\b[A-Z][A-Za-z0-9_-]{1,}\b/gu,
    'link-target': /\[[^\]]*\]\(([^)]+)\)/gu,
    placeholder: /\{\{[^}]+\}\}|\$\{[^}]+\}|%[A-Za-z]\d*|<[^<>\n]+>/gu,
  };
  const pattern = patterns[kind];
  const matches = value.matchAll(pattern);
  const values: string[] = [];
  for (const match of matches) {
    const anchor = kind === 'link-target' ? (match[1] ?? '') : match[0];
    if (anchor.trim()) values.push(anchor);
  }
  return values;
}

function isBroadRewrite(original: string, candidate: string): boolean {
  if (!original || !candidate) return true;
  if (candidate.length > Math.ceil(original.length * 1.35) + 48) return true;
  const overlap = characterOverlapRatio(original, candidate);
  return overlap < 0.56;
}

function characterOverlapRatio(left: string, right: string): number {
  const leftCounts = characterCounts(left);
  const rightCounts = characterCounts(right);
  let shared = 0;
  for (const [character, count] of leftCounts) shared += Math.min(count, rightCounts.get(character) ?? 0);
  return shared / Math.max(1, Math.min([...left].length, [...right].length));
}

function characterCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of value.replace(/\s/gu, '')) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

function matchesTargetLanguage(value: string, targetLanguage: string | undefined): boolean {
  const target = targetLanguage?.trim().toLocaleLowerCase('en-US');
  if (!target) return false;
  if (/中文|汉语|chinese|mandarin/u.test(target)) return /[\u3400-\u9fff]/u.test(value);
  if (/英语|英文|english/u.test(target)) return /[A-Za-z]/u.test(value);
  return true;
}

function findNewConcreteTokens(original: string, candidate: string): string[] {
  const originalTokens = new Set([
    ...collectAnchors(original, 'number'),
    ...collectAnchors(original, 'date'),
    ...collectAnchors(original, 'url'),
  ]);
  const additions = [
    ...collectAnchors(candidate, 'number'),
    ...collectAnchors(candidate, 'date'),
    ...collectAnchors(candidate, 'url'),
  ].filter((token) => !originalTokens.has(token));
  return [...new Set(additions)].map((token) => `新增具体信息“${token}”没有原文依据。`);
}

function findUnsupportedAdditions(
  original: string,
  candidate: string,
  evidence: readonly SelectionEvidenceItem[],
): { messages: string[] } {
  const originalSentences = new Set(splitSentences(original).map(normalizeSentence));
  const additiveSentences = splitSentences(candidate)
    .filter((sentence) => {
      const normalized = normalizeSentence(sentence);
      return Boolean(normalized) && !originalSentences.has(normalized);
    });
  if (additiveSentences.length === 0) return { messages: [] };
  if (evidence.length === 0) {
    return {
      messages: ['没有已读证据，不能为扩写或解释提供一键应用。'],
      
    };
  }
  const evidenceTerms = new Set(evidence.flatMap((item) => collectMeaningfulTerms(item.content)));
  const unsupported: string[] = [];
  for (const sentence of additiveSentences) {
    const overlap = collectMeaningfulTerms(sentence).filter((term) => evidenceTerms.has(term));
    if (overlap.length < 2) unsupported.push(`新增内容“${sentence.slice(0, 80)}”无法关联已读证据。`);
  }
  return { messages: unsupported.slice(0, 6) };
}

function splitSentences(value: string): string[] {
  return value.split(/(?<=[。！？!?；;]|\n)/u).map((item) => item.trim()).filter(Boolean);
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function collectMeaningfulTerms(value: string): string[] {
  const latin = value.match(/[A-Za-z][A-Za-z0-9_-]{1,}/gu) ?? [];
  const cjkPairs: string[] = [];
  const cjk = value.match(/[\u3400-\u9fff]/gu) ?? [];
  for (let index = 0; index < cjk.length - 1; index += 1) cjkPairs.push(`${cjk[index]}${cjk[index + 1]}`);
  return [...new Set([...latin, ...cjkPairs].map((item) => item.toLocaleLowerCase('zh-CN')))];
}
