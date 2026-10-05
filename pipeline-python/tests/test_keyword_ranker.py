from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEPS = ROOT / '.deps'
if DEPS.is_dir():
    sys.path.insert(0, str(DEPS))

from pipeline_worker.keyword_candidates import (  # noqa: E402
    CandidateGenerationResult,
    CandidateOccurrence,
    KeywordCandidate,
    generate_candidates,
)
from pipeline_worker.keyword_tokenizer import RuleKeywordTokenizer, create_keyword_tokenizer  # noqa: E402
from pipeline_worker.keyword_contract import KeywordChunkInput, canonical_json, normalize_term  # noqa: E402
from pipeline_worker.keyword_baseline import _fixture_to_chunk, evaluate_baseline  # noqa: E402
from pipeline_worker.keyword_ranker import (  # noqa: E402
    HybridRankingConfig,
    candidate_similarity,
    compute_text_rank,
    rank_keyword_chunks,
    run_hybrid_keyword_ranking,
)


def make_chunk(
    chunk_id: str,
    text: str,
    *,
    document_id: str = 'doc-test',
    section_path: tuple[dict[str, str], ...] = (),
    overlap_chars: int = 0,
) -> KeywordChunkInput:
    return KeywordChunkInput(
        document_id=document_id,
        chunk_id=chunk_id,
        parent_chunk_id=f'parent-{chunk_id}',
        ordinal=int(chunk_id.split('-')[-1]),
        text=text,
        section_path=section_path,
        node_ids=(),
        source_refs=({'fixture': chunk_id},),
        overlap_from_chunk_id=None,
        overlap_chars=overlap_chars,
        schema_version=2,
    )


def generate(text: str):
    return generate_candidates(text, RuleKeywordTokenizer())


def manual_candidate(text: str, term: str, *, kind: str = 'word', dictionary_hit: bool = False, sentence_index: int = 0) -> KeywordCandidate:
    start = text.index(term)
    return KeywordCandidate(
        term=term,
        normalized_term=term.lower(),
        kind=kind,
        occurrences=[CandidateOccurrence(start, start + len(term), sentence_index)],
        dictionary_hit=dictionary_hit,
    )


class KeywordRankerTests(unittest.TestCase):
    def test_document_df_downweights_boilerplate_and_preserves_local_tfidf(self):
        chunks = [
            make_chunk('chunk-1', '通用说明 核心术语 核心术语'),
            make_chunk('chunk-2', '通用说明 其他内容'),
        ]
        outputs = rank_keyword_chunks(
            chunks,
            [generate(chunks[0].text), generate(chunks[1].text)],
            config=HybridRankingConfig(min_score=0, max_keywords=5, weights={'tfidf': 1}),
        )
        local_scores = {item['normalizedTerm']: item['score'] for item in outputs[0]['keywords']}
        boilerplate_scores = {item['normalizedTerm']: item['score'] for item in outputs[1]['keywords']}
        self.assertGreater(local_scores['核心术语'], boilerplate_scores['通用说明'])
        self.assertGreater(outputs[0]['keywords'][0]['features']['tfidf'], 0)

    def test_textrank_converges_and_omits_unavailable_feature_for_no_edge_graph(self):
        connected = generate('权限 管理 审批 审计')
        connected_rank = compute_text_rank(connected.candidates)
        self.assertTrue(connected_rank.available)
        self.assertTrue(connected_rank.converged)
        self.assertGreater(connected_rank.edge_count, 0)
        self.assertEqual(max(connected_rank.scores.values()), 1.0)

        isolated_text = '甲甲。乙乙。丙丙。丁丁。'
        isolated = generate(isolated_text)
        isolated_rank = compute_text_rank(isolated.candidates)
        self.assertFalse(isolated_rank.available)
        self.assertEqual(isolated_rank.edge_count, 0)
        output = rank_keyword_chunks(
            [make_chunk('chunk-1', isolated_text)],
            [isolated],
            config=HybridRankingConfig(min_score=0, max_keywords=5),
        )[0]
        self.assertTrue(output['keywords'])
        self.assertTrue(all(item['features']['textRank'] == 0 for item in output['keywords']))

    def test_section_match_only_boosts_existing_evidence(self):
        text = '访问控制系统会记录审计日志。'
        existing = manual_candidate(text, '访问控制', kind='phrase')
        other = manual_candidate(text, '审计日志', kind='phrase')
        result = CandidateGenerationResult((existing, other), 2, False, 0, 0)
        output = rank_keyword_chunks(
            [make_chunk('chunk-1', text, section_path=({'title': '访问控制策略'},))],
            [result],
            config=HybridRankingConfig(min_score=0, max_keywords=5),
        )[0]
        section_keyword = next(item for item in output['keywords'] if item['normalizedTerm'] == '访问控制')
        self.assertEqual(section_keyword['features']['sectionMatch'], 1.0)
        self.assertNotIn('访问控制策略', {item['normalizedTerm'] for item in output['keywords']})

    def test_overlap_only_is_discarded_for_long_new_body(self):
        text = '旧内容。新的正文包含权限审批和审计留痕，后续还有更多有效说明。'
        old = manual_candidate(text, '旧内容')
        new = manual_candidate(text, '权限审批', kind='phrase')
        result = CandidateGenerationResult((old, new), 2, False, 0, 0)
        output = run_hybrid_keyword_ranking(
            [make_chunk('chunk-1', text, overlap_chars=len('旧内容。'))],
            [result],
            config=HybridRankingConfig(min_score=0, max_keywords=5, allow_overlap_fallback=False),
        )
        terms = {item['normalizedTerm'] for item in output.outputs[0]['keywords']}
        self.assertNotIn('旧内容', terms)
        self.assertIn('权限审批', terms)
        self.assertEqual(output.report['counts']['overlapOnlyDiscarded'], 1)

    def test_normalized_dedupe_and_mmr_reduce_containment_duplicates(self):
        text = '访问控制系统 访问控制 API api'
        long_term = manual_candidate(text, '访问控制系统', kind='phrase')
        short_term = manual_candidate(text, '访问控制', kind='phrase', dictionary_hit=True)
        api_upper = manual_candidate(text, 'API', kind='term')
        api_lower = manual_candidate(text, 'api', kind='term')
        result = CandidateGenerationResult((long_term, short_term, api_upper, api_lower), 4, False, 0, 0)
        config = HybridRankingConfig(min_score=0, max_keywords=3, weights={'tfidf': 1})
        first = rank_keyword_chunks([make_chunk('chunk-1', text)], [result], config=config)[0]
        second = rank_keyword_chunks([make_chunk('chunk-1', text)], [result], config=config)[0]
        terms = [item['normalizedTerm'] for item in first['keywords']]
        self.assertEqual(canonical_json(first), canonical_json(second))
        self.assertEqual(len(terms), len(set(terms)))
        self.assertLessEqual(len({'访问控制系统', '访问控制', '控制系统'} & set(terms)), 2)
        self.assertEqual(terms.count('api'), 1)
        self.assertLess(candidate_similarity(long_term, short_term), 1.0)

    def test_offsets_scores_and_ranks_are_stable(self):
        text = 'PipelineOrchestrator 调度权限管理，并在第二句再次记录权限管理。'
        chunk = make_chunk('chunk-1', text)
        result = generate(text)
        outputs = rank_keyword_chunks([chunk], [result], config=HybridRankingConfig(min_score=0, max_keywords=10))
        serialized = canonical_json(outputs)
        self.assertEqual(serialized, canonical_json(rank_keyword_chunks([chunk], [result], config=HybridRankingConfig(min_score=0, max_keywords=10))))
        previous = 1.0
        for expected_rank, item in enumerate(outputs[0]['keywords'], start=1):
            self.assertEqual(item['rank'], expected_rank)
            self.assertLessEqual(item['score'], previous)
            previous = item['score']
            for occurrence in item['occurrences']:
                self.assertEqual(text[occurrence['start']:occurrence['end']], item['term'])

    def test_hybrid_fixture_precision_exceeds_tfidf_baseline_when_jieba_is_available(self):
        if importlib.util.find_spec('jieba') is None:
            self.skipTest('项目隔离依赖未安装 jieba，跳过需要真实 tokenizer 的质量比较。')
        fixtures = json.loads(
            (ROOT / 'tests' / 'fixtures' / 'keyword-baseline-fixtures.json').read_text(encoding='utf-8')
        )
        chunks = [
            _fixture_to_chunk(fixture, index)
            for index, fixture in enumerate(fixtures)
        ]
        parsed_chunks = [
            KeywordChunkInput(
                document_id=value['documentId'],
                chunk_id=value['chunkId'],
                parent_chunk_id=value['parentChunkId'],
                ordinal=value['ordinal'],
                text=value['text'],
                section_path=tuple(value['sectionPath']),
                node_ids=tuple(value['nodeIds']),
                source_refs=tuple(value['sourceRefs']),
                overlap_from_chunk_id=value['overlapFromChunkId'],
                overlap_chars=value['overlapChars'],
                schema_version=value['schemaVersion'],
                legacy_flat_chunk=value['legacyFlatChunk'] if 'legacyFlatChunk' in value else False,
            )
            for value in chunks
        ]
        tokenizer = create_keyword_tokenizer('jieba')
        candidate_results = [generate_candidates(chunk.text, tokenizer) for chunk in parsed_chunks]
        outputs = rank_keyword_chunks(parsed_chunks, candidate_results)
        expected = [{normalize_term(str(term)) for term in fixture.get('expectedTerms', [])} for fixture in fixtures]
        predicted = [{normalize_term(str(item['term'])) for item in output['keywords'][:5]} for output in outputs]
        precision = sum(len(actual & target) / max(1, len(actual)) for actual, target in zip(predicted, expected)) / len(expected)
        baseline_precision = evaluate_baseline(fixtures)['precisionAt5']
        self.assertGreaterEqual(precision, baseline_precision + 0.08)


if __name__ == '__main__':
    unittest.main()
