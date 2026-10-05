import type { WikiActionKind } from './wikiQuickActions';

export interface WikiDirectEvidenceAssessment {
  requiresEvidence: boolean;
  overviewRequest: boolean;
  likelySupported: boolean;
  directCitationPresent: boolean;
  acceptWithoutSearch: boolean;
  queryTerms: string[];
  matchedTerms: string[];
}

const NON_FACTUAL_PATTERN = /^(?:你好|您好|嗨|谢谢|感谢|辛苦了|再见|好的|明白了)[！!。.，,\s]*$/u;
const OVERVIEW_PATTERNS = [
  /(?:这篇|这份|这个|当前|该|本|这一|这)(?:文章|文档|章节|章|节|节点|部分).{0,12}(?:讲(?:了)?什么|说(?:了)?什么|主要(?:内容|讲)|核心内容|内容(?:是)?什么|关于什么|大意|主旨)/u,
  /(?:总结|概括|梳理|介绍)(?:一下|下)?(?:这篇|这份|这个|当前|该|本|这一|这)(?:文章|文档|章节|章|节|节点|部分)/u,
  /^(?:请|帮我|麻烦)?(?:简单|简要|详细)?(?:总结|概括|梳理|介绍)(?:一下|下)?[？?！!。.，,\s]*$/u,
];
const QUESTION_FILLERS = [
  '只根据本节回答', '只依据本节回答', '仅根据本节回答', '仅依据本节回答',
  '当前章节', '当前节点', '本章节', '本节', '本文', '全文', '整篇文档',
  '请问', '请说明', '请解释', '请回答', '回答', '是什么', '有什么', '是多少',
  '多少', '多久', '哪里', '哪一处', '怎么', '如何', '为何', '为什么', '呢',
  '吗', '会吗', '会不会',
  '的规定', '规定', '说明了', '说明', '相关内容', '内容',
];
const GENERIC_TERMS = new Set([
  '当前', '章节', '节点', '本节', '本文', '全文', '回答', '说明', '规定', '内容',
  '什么', '多少', '多久', '哪里', '怎么', '如何', '是否', '这个', '那个',
]);

/**
 * A conservative lexical gate for zero-search Wiki answers. It does not judge
 * semantic correctness; it only prevents a model from citing [0] when none of
 * the question's distinctive wording is present in the directly loaded node.
 */
export function assessWikiDirectEvidence(input: {
  question: string;
  nodeMarkdown: string;
  answer: string;
  actionKind: WikiActionKind;
}): WikiDirectEvidenceAssessment {
  const question = input.question.trim();
  const requiresEvidence = input.actionKind !== 'free' || !NON_FACTUAL_PATTERN.test(question);
  const overviewRequest = OVERVIEW_PATTERNS.some((pattern) => pattern.test(question.normalize('NFKC')));
  const queryTerms = extractDistinctiveTerms(question);
  const normalizedNode = normalizeEvidenceText(input.nodeMarkdown);
  const matchedTerms = queryTerms.filter((term) => normalizedNode.includes(term));
  const exactCoreMatch = queryTerms.some((term) => term.length >= 4 && normalizedNode.includes(term));
  const chineseBigramTerms = queryTerms.filter((term) => /^[\p{Script=Han}]{2}$/u.test(term));
  const matchedChineseBigrams = chineseBigramTerms.filter((term) => normalizedNode.includes(term));
  // The source may say “原始文件” while the user asks about “原始文档”. A
  // broad match across several Chinese bigrams is strong enough for the direct
  // node, even when no single four-character phrase is identical.
  const broadChineseCoverage = matchedChineseBigrams.length >= 4
    && matchedChineseBigrams.length / Math.max(1, chineseBigramTerms.length) >= 0.35;
  const likelySupported = input.actionKind !== 'free'
    || (overviewRequest && normalizedNode.replace(/\s/gu, '').length > 0)
    || queryTerms.length === 0
    || exactCoreMatch
    || broadChineseCoverage
    || (matchedTerms.length >= 2 && matchedTerms.length / queryTerms.length >= 0.5);
  const directCitationPresent = input.answer.includes('[0]');
  return {
    requiresEvidence,
    overviewRequest,
    likelySupported,
    directCitationPresent,
    // Wiki factual/content requests are Agentic RAG tasks: direct node content
    // may support the answer, but it no longer bypasses the first evidence-tool
    // round. Pure non-factual conversation remains eligible for zero-tool exit.
    acceptWithoutSearch: !requiresEvidence,
    queryTerms,
    matchedTerms,
  };
}

function extractDistinctiveTerms(value: string): string[] {
  let normalized = normalizeEvidenceText(value);
  for (const filler of QUESTION_FILLERS) normalized = normalized.replaceAll(normalizeEvidenceText(filler), ' ');
  const terms: string[] = [];
  for (const token of normalized.match(/[\p{Script=Han}A-Za-z0-9_.%-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4 && !GENERIC_TERMS.has(token)) terms.push(token);
      // Long Chinese clauses used to be reduced to bigrams only. That made the
      // `exactCoreMatch` branch below unreachable for the most common Chinese
      // questions and rejected answers even when a distinctive four-character
      // phrase (for example “原始文档”) was present in the loaded node.
      for (let index = 0; index < token.length - 3; index += 1) {
        const fourGram = token.slice(index, index + 4);
        if (!GENERIC_TERMS.has(fourGram)) terms.push(fourGram);
      }
      for (let index = 0; index < token.length - 1; index += 1) {
        const bigram = token.slice(index, index + 2);
        if (!GENERIC_TERMS.has(bigram)) terms.push(bigram);
      }
    } else if (token.length >= 2) {
      terms.push(token);
    }
  }
  return [...new Set(terms.filter((term) => term.length >= 2))];
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{Letter}\p{Number}_.%-]+/gu, ' ');
}
