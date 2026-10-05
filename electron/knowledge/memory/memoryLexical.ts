import { MEMORY_CONSTANTS } from './memoryConstants';

export interface MemoryLexicalTokens {
  unigrams: ReadonlySet<string>;
  bigrams: ReadonlySet<string>;
}

export interface MemoryLexicalScore {
  score: number;
  matchedUnigrams: number;
  matchedBigrams: number;
  denominator: number;
}

/**
 * WeKnora L4 lexical contract. CJK characters and bigrams are kept inside
 * their original contiguous runs; topic and content are tokenized separately
 * by the caller, so a synthetic cross-field bigram can never be produced.
 */
export function tokenizeMemoryLexical(value: string): MemoryLexicalTokens {
  const unigrams = new Set<string>();
  const bigrams = new Set<string>();
  let cjkRun = '';
  let latinRun = '';

  const flushCjk = () => {
    if (!cjkRun) return;
    for (const character of Array.from(cjkRun)) unigrams.add(character);
    const characters = Array.from(cjkRun);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      bigrams.add(`${characters[index]}${characters[index + 1]}`);
    }
    cjkRun = '';
  };
  const flushLatin = () => {
    if (latinRun.length >= 2) unigrams.add(latinRun.toLocaleLowerCase('en-US'));
    latinRun = '';
  };

  for (const character of Array.from(value.normalize('NFKC'))) {
    if (isCjk(character)) {
      flushLatin();
      cjkRun += character;
      continue;
    }
    if (isLatinOrDigit(character)) {
      flushCjk();
      latinRun += character;
      continue;
    }
    flushCjk();
    flushLatin();
  }
  flushCjk();
  flushLatin();
  return { unigrams, bigrams };
}

export function scoreMemoryLexically(input: {
  query: string;
  topic: string;
  content: string;
  importance: number;
}): MemoryLexicalScore {
  const query = tokenizeMemoryLexical(input.query);
  const topic = tokenizeMemoryLexical(input.topic);
  const content = tokenizeMemoryLexical(input.content);
  const candidateUnigrams = new Set([...topic.unigrams, ...content.unigrams]);
  const candidateBigrams = new Set([...topic.bigrams, ...content.bigrams]);
  let matchedUnigrams = 0;
  let matchedBigrams = 0;
  for (const token of query.unigrams) if (candidateUnigrams.has(token)) matchedUnigrams += 1;
  for (const token of query.bigrams) if (candidateBigrams.has(token)) matchedBigrams += 1;
  const denominator = query.unigrams.size * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.unigramWeight
    + query.bigrams.size * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.cjkBigramWeight;
  const lexical = denominator > 0
    ? (matchedUnigrams * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.unigramWeight
      + matchedBigrams * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.cjkBigramWeight) / denominator
    : 0;
  return {
    score: lexical + normalizeImportance(input.importance) * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.importanceScoreMultiplier,
    matchedUnigrams,
    matchedBigrams,
    denominator,
  };
}

export function isLexicallyRelevant(score: number): boolean {
  return score >= MEMORY_CONSTANTS.lexicalVectorInterestAffinity.lexicalMinimumScore;
}

function normalizeImportance(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(5, Math.trunc(value))) : 1;
}

function isCjk(character: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(character);
}

function isLatinOrDigit(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character) && !isCjk(character);
}
