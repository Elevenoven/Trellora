from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEPS = ROOT / '.deps'
if DEPS.is_dir():
    sys.path.insert(0, str(DEPS))

from pipeline_worker.keyword_candidates import (
    DEFAULT_MAX_CANDIDATES,
    KeywordCandidateError,
    generate_candidates,
    load_builtin_stopwords,
)
from pipeline_worker.keyword_tokenizer import (
    KeywordTokenizerUnavailable,
    RuleKeywordTokenizer,
    create_keyword_tokenizer,
)


class KeywordCandidateTests(unittest.TestCase):
    def test_rule_tokenizer_is_explicit_and_keeps_technical_offsets(self):
        text = '使用 GPT-5、sqlite-vec 和 PipelineOrchestrator。'
        tokenizer = RuleKeywordTokenizer()
        spans = tokenizer.tokenize(text)
        terms = {span.term for span in spans}
        self.assertIn('GPT-5', terms)
        self.assertIn('sqlite-vec', terms)
        self.assertIn('PipelineOrchestrator', terms)
        for span in spans:
            self.assertEqual(text[span.start:span.end], span.term)

    def test_jieba_is_default_and_missing_dependency_is_explicit(self):
        if importlib.util.find_spec('jieba') is None:
            with self.assertRaises(KeywordTokenizerUnavailable) as context:
                create_keyword_tokenizer('jieba')
            self.assertEqual(context.exception.code, 'KEYWORDS_TOKENIZER_UNAVAILABLE')
        else:
            tokenizer = create_keyword_tokenizer('jieba')
            self.assertEqual(getattr(tokenizer, 'name'), 'jieba-accurate-hmm-off')

    def test_mixed_language_and_business_dictionary_candidates(self):
        text = '资料库 Library 使用 tenantKey 进行租户隔离，PipelineOrchestrator 负责调度。'
        dictionary_terms = ['租户隔离', '不存在的词']
        tokenizer = (
            create_keyword_tokenizer('jieba', dictionary_terms)
            if importlib.util.find_spec('jieba') is not None
            else RuleKeywordTokenizer(dictionary_terms)
        )
        result = generate_candidates(
            text,
            tokenizer,
            dictionary_terms=dictionary_terms,
        )
        terms = {candidate.normalized_term for candidate in result.candidates}
        self.assertIn('library', terms)
        self.assertIn('tenantkey', terms)
        self.assertIn('租户隔离', terms)
        self.assertNotIn('不存在的词', terms)
        self.assertEqual(result.dictionary_hits, 1)

    def test_jieba_search_tokens_preserve_business_term_boundaries(self):
        if importlib.util.find_spec('jieba') is None:
            self.skipTest('jieba is not installed in this interpreter')
        text = '投标保证金应在开标前缴纳'
        tokenizer = create_keyword_tokenizer('jieba', ['投标保证金'])
        result = generate_candidates(text, tokenizer, dictionary_terms=['投标保证金'])
        self.assertIn('投标保证金', result.search_tokens)
        self.assertIn('开标', result.search_tokens)
        self.assertIn('缴纳', result.search_tokens)

    def test_builtin_stopwords_and_nonprintable_candidates_are_filtered(self):
        result = generate_candidates('系统 的 管理\x00流程', RuleKeywordTokenizer())
        terms = {candidate.term for candidate in result.candidates}
        self.assertNotIn('的', terms)
        self.assertNotIn('系统 的 管理\x00流程', terms)
        self.assertIn('系统', terms)
        self.assertIn('管理', terms)

    def test_one_to_three_gram_does_not_cross_sentence_newline_or_table_cell(self):
        text = '权限 管理 系统。审批 流程\n归档 | 记录'
        result = generate_candidates(text, RuleKeywordTokenizer(), stopwords=load_builtin_stopwords())
        terms = {candidate.term for candidate in result.candidates}
        self.assertIn('权限 管理', terms)
        self.assertIn('权限 管理 系统', terms)
        self.assertNotIn('审批 流程 归档', terms)
        self.assertNotIn('流程 归档 记录', terms)

    def test_candidate_limit_is_stable_and_reports_discarded_candidates(self):
        text = ' '.join(f'词条{index:03d}' for index in range(120))
        result = generate_candidates(text, RuleKeywordTokenizer(), max_candidates=32)
        self.assertEqual(len(result.candidates), 32)
        self.assertTrue(result.candidate_capped)
        self.assertEqual(result.discarded_candidates, result.candidate_count_before_cap - 32)
        self.assertLessEqual(len(result.candidates), DEFAULT_MAX_CANDIDATES)

    def test_resource_and_ngram_limits_are_rejected(self):
        with self.assertRaisesRegex(KeywordCandidateError, 'ngram'):
            generate_candidates('权限 管理', RuleKeywordTokenizer(), ngram_max=4)
        with self.assertRaisesRegex(KeywordCandidateError, '资源上限'):
            generate_candidates('权限 管理', RuleKeywordTokenizer(), max_candidates=1025)
        with self.assertRaisesRegex(KeywordCandidateError, '字符上限'):
            generate_candidates('权限', RuleKeywordTokenizer(), max_text_characters=1)

    def test_unknown_tokenizer_does_not_silently_fallback(self):
        with self.assertRaisesRegex(ValueError, '不支持'):
            create_keyword_tokenizer('unknown')


if __name__ == '__main__':
    unittest.main()
