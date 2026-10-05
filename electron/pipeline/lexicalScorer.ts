/** LexScore v2：自研词法打分器。分域 BM25（body/title/keyword）× 覆盖率门控 + 精确命中加成。 */

export interface LexicalScorerParams {
  k1Body: number;
  bBody: number;
  k1Title: number;
  bTitle: number;
  k1Kw: number;
  bKw: number;
  wBody: number;
  wTitle: number;
  wKw: number;
  /** 覆盖率指数：score ∝ coverage^gamma。 */
  gamma: number;
  /** 全部查询词命中时的乘法加成。 */
  fullMatchBonus: number;
  /** raw query 命中章节标题子串时的加法加成。 */
  titleExactBonus: number;
  /** raw query 命中正文子串（短语）时的加法加成。 */
  phraseBonus: number;
  /** 饱和常数：final = raw/(raw+kappa)。 */
  kappa: number;
  /** df/N 超过该阈值的词视为止停词，idf 置 0。 */
  stopwordDfRatio: number;
}

export const DEFAULT_LEXICAL_SCORER_PARAMS: LexicalScorerParams = {
  k1Body: 1.2,
  bBody: 0.75,
  k1Title: 1.2,
  bTitle: 0.3,
  k1Kw: 1.2,
  bKw: 0.5,
  wBody: 1.0,
  wTitle: 2.2,
  wKw: 1.6,
  gamma: 0.9,
  fullMatchBonus: 0.25,
  titleExactBonus: 0.15,
  phraseBonus: 0.1,
  kappa: 8,
  stopwordDfRatio: 0.85,
};

export interface LexicalCorpusStats {
  docCount: number;
  avgBodyLen: number;
  avgKwLen: number;
}

export interface LexicalTermDf {
  body: number;
  keyword: number;
}

export interface LexicalScorerCandidate {
  rowId: number;
  bodyTf: Map<string, number>;
  kwTf: Map<string, number>;
  bodyLen: number;
  kwLen: number;
  sectionPathText: string;
  sourceText: string;
}

export interface LexicalScoreBreakdown {
  body: number;
  title: number;
  keyword: number;
  coverage: number;
  bonus: number;
  raw: number;
  final: number;
}

function idf(docCount: number, df: number, stopwordDfRatio: number): number {
  if (docCount <= 0 || df <= 0) return 0;
  if (df / docCount > stopwordDfRatio) return 0;
  return Math.max(0, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)));
}

function bm25Term(tf: number, dl: number, avgdl: number, k1: number, b: number, termIdf: number): number {
  if (tf <= 0 || termIdf <= 0) return 0;
  const safeAvgdl = avgdl > 0 ? avgdl : 1;
  const safeDl = dl > 0 ? dl : safeAvgdl;
  return termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (safeDl / safeAvgdl)));
}

export function scoreLexicalCandidates(input: {
  queryTerms: string[];
  rawQuery: string;
  corpus: LexicalCorpusStats;
  termDf: Map<string, LexicalTermDf>;
  candidates: LexicalScorerCandidate[];
  params?: Partial<LexicalScorerParams>;
}): Map<number, LexicalScoreBreakdown> {
  const params = { ...DEFAULT_LEXICAL_SCORER_PARAMS, ...input.params };
  const terms = [...new Set(input.queryTerms.map((term) => term.trim()).filter(Boolean))];
  const result = new Map<number, LexicalScoreBreakdown>();
  if (terms.length === 0 || input.corpus.docCount <= 0) return result;
  const rawQuery = input.rawQuery.trim();

  for (const candidate of input.candidates) {
    let bodyScore = 0;
    let titleScore = 0;
    let kwScore = 0;
    let matched = 0;
    for (const term of terms) {
      const df = input.termDf.get(term) ?? { body: 0, keyword: 0 };
      const bodyIdf = idf(input.corpus.docCount, df.body, params.stopwordDfRatio);
      const kwIdf = idf(input.corpus.docCount, df.keyword, params.stopwordDfRatio);
      const titleIdf = idf(input.corpus.docCount, Math.max(df.body, 1), params.stopwordDfRatio);
      const bodyTf = candidate.bodyTf.get(term) ?? 0;
      const kwTf = candidate.kwTf.get(term) ?? 0;
      const titleHit = candidate.sectionPathText.length > 0 && candidate.sectionPathText.includes(term);
      if (bodyTf > 0) bodyScore += bm25Term(bodyTf, candidate.bodyLen, input.corpus.avgBodyLen, params.k1Body, params.bBody, bodyIdf);
      if (titleHit) titleScore += bm25Term(1, input.corpus.avgBodyLen, input.corpus.avgBodyLen, params.k1Title, params.bTitle, titleIdf);
      if (kwTf > 0) kwScore += bm25Term(kwTf, candidate.kwLen, input.corpus.avgKwLen, params.k1Kw, params.bKw, kwIdf);
      if (bodyTf > 0 || kwTf > 0 || titleHit) matched += 1;
    }
    const coverage = matched / terms.length;
    if (coverage <= 0) {
      result.set(candidate.rowId, { body: 0, title: 0, keyword: 0, coverage: 0, bonus: 0, raw: 0, final: 0 });
      continue;
    }
    const weighted = params.wBody * bodyScore + params.wTitle * titleScore + params.wKw * kwScore;
    const raw = weighted * Math.pow(coverage, params.gamma) * (coverage === 1 ? 1 + params.fullMatchBonus : 1);
    let bonus = 0;
    if (rawQuery.length >= 2) {
      if (candidate.sectionPathText.includes(rawQuery)) bonus += params.titleExactBonus;
      if (candidate.sourceText.includes(rawQuery)) bonus += params.phraseBonus;
    }
    const final = Math.min(1, raw / (raw + params.kappa) + bonus);
    result.set(candidate.rowId, {
      body: Number(bodyScore.toFixed(6)),
      title: Number(titleScore.toFixed(6)),
      keyword: Number(kwScore.toFixed(6)),
      coverage: Number(coverage.toFixed(6)),
      bonus: Number(bonus.toFixed(6)),
      raw: Number(raw.toFixed(6)),
      final: Number(final.toFixed(6)),
    });
  }
  return result;
}
