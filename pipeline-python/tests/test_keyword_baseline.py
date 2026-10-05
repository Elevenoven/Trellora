from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline_worker.keyword_baseline import evaluate_baseline, extract_tfidf_baseline
from pipeline_worker.keyword_contract import (
    KeywordContractError,
    normalize_term,
    parse_keyword_chunk,
    parse_keyword_chunks,
    validate_keyword_output,
)


FIXTURE_PATH = Path(__file__).parent / 'fixtures' / 'keyword-baseline-fixtures.json'


class KeywordBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))

    def test_fixture_count_and_contract_coverage(self):
        self.assertGreaterEqual(len(self.fixtures), 30)
        self.assertLessEqual(len(self.fixtures), 50)
        chunks = [self._fixture_to_chunk(item, index) for index, item in enumerate(self.fixtures)]
        parsed = parse_keyword_chunks(chunks)
        self.assertEqual(len(parsed), len(self.fixtures))
        self.assertTrue(any(chunk.legacy_flat_chunk for chunk in parsed))
        self.assertTrue(any(chunk.overlap_chars for chunk in parsed))
        self.assertTrue(any(item['category'] == '表格' for item in self.fixtures))
        self.assertTrue(any(item['category'] == 'OCR噪声' for item in self.fixtures))

    def test_baseline_is_deterministic_and_offsets_are_exact(self):
        chunks = parse_keyword_chunks([self._fixture_to_chunk(item, index) for index, item in enumerate(self.fixtures)])
        first = extract_tfidf_baseline(chunks)
        second = extract_tfidf_baseline(chunks)
        self.assertEqual(json.dumps(first, ensure_ascii=False, sort_keys=True), json.dumps(second, ensure_ascii=False, sort_keys=True))
        for output, chunk in zip(first, chunks):
            validate_keyword_output(output, chunk)
            for item in output['keywords']:
                for occurrence in item['occurrences']:
                    self.assertEqual(chunk.text[occurrence['start']:occurrence['end']], item['term'])

    def test_report_contains_quality_and_timing_baseline(self):
        report = evaluate_baseline(self.fixtures)
        self.assertEqual(report['fixtureCount'], len(self.fixtures))
        self.assertGreaterEqual(report['durationMs'], 0)
        self.assertGreaterEqual(report['avgMsPerChunk'], 0)
        self.assertEqual(report['offsetAccuracy'], 1.0)
        self.assertTrue(report['deterministic'])
        self.assertGreater(report['keywordCount'], 0)
        self.assertGreater(report['recallAt5'], 0)

    def test_tfidf_document_frequency_does_not_cross_document_boundary(self):
        base_values = [
            self._simple_chunk('doc-a', 'c-a-1', '缓存阶段需要稳定。', 1),
            self._simple_chunk('doc-a', 'c-a-2', '缓存命中后继续执行。', 2),
        ]
        expanded_values = base_values + [self._simple_chunk('doc-b', 'c-b-1', '缓存来自另一个文档。', 1)]
        base_chunks = parse_keyword_chunks(base_values)
        expanded_chunks = parse_keyword_chunks(expanded_values)
        base_outputs = extract_tfidf_baseline(base_chunks)
        expanded_outputs = extract_tfidf_baseline(expanded_chunks)[:2]
        self.assertEqual(
            json.dumps(base_outputs, ensure_ascii=False, sort_keys=True),
            json.dumps(expanded_outputs, ensure_ascii=False, sort_keys=True),
        )

    def test_invalid_overlap_and_duplicate_chunk_are_rejected(self):
        value = self._fixture_to_chunk(self.fixtures[0], 0)
        value['overlapChars'] = len(value['text']) + 1
        with self.assertRaisesRegex(KeywordContractError, 'overlapChars'):
            parse_keyword_chunk(value)
        duplicate = self._fixture_to_chunk(self.fixtures[1], 1)
        duplicate['chunkId'] = self._fixture_to_chunk(self.fixtures[0], 0)['chunkId']
        with self.assertRaisesRegex(KeywordContractError, 'chunkId 重复'):
            parse_keyword_chunks([self._fixture_to_chunk(self.fixtures[0], 0), duplicate])

    def test_output_validator_rejects_fake_offset(self):
        chunk = parse_keyword_chunk(self._fixture_to_chunk(self.fixtures[0], 0))
        output = extract_tfidf_baseline([chunk])[0]
        if not output['keywords']:
            self.fail('baseline fixture unexpectedly produced no keywords')
        output['keywords'][0]['occurrences'][0]['end'] += 1
        with self.assertRaisesRegex(KeywordContractError, '回指原文'):
            validate_keyword_output(output, chunk)

    def test_empty_and_noise_only_text_have_explicit_reasons(self):
        item = next(item for item in self.fixtures if item['id'] == 'short-02')
        chunk = parse_keyword_chunk(self._fixture_to_chunk(item, 0))
        output = extract_tfidf_baseline([chunk])[0]
        self.assertEqual(output['keywords'], [])
        self.assertEqual(output['emptyReason'], 'NO_VALID_CANDIDATE')

        empty_chunk = parse_keyword_chunk({
            'schemaVersion': 2,
            'documentId': 'doc-empty',
            'chunkId': 'c-empty',
            'parentChunkId': 'p-empty',
            'ordinal': 1,
            'text': '',
            'sectionPath': [],
            'nodeIds': [],
            'sourceRefs': [],
            'overlapFromChunkId': None,
            'overlapChars': 0,
        })
        self.assertEqual(extract_tfidf_baseline([empty_chunk])[0]['emptyReason'], 'EMPTY_TEXT')

    @staticmethod
    def _fixture_to_chunk(item: dict, index: int) -> dict:
        fixture_id = item['id']
        schema_version = int(item.get('schemaVersion', 2))
        return {
            'schemaVersion': schema_version,
            'documentId': item.get('documentId', f'doc-{fixture_id}'),
            'chunkId': item.get('chunkId', f'c-{fixture_id}'),
            'parentChunkId': item.get('parentChunkId', None if schema_version == 1 else f'p-{fixture_id}'),
            'ordinal': item.get('ordinal', index + 1),
            'text': item.get('text', ''),
            'sectionPath': item.get('sectionPath', []),
            'nodeIds': item.get('nodeIds', []),
            'sourceRefs': item.get('sourceRefs', [{'fixture': fixture_id}]),
            'overlapFromChunkId': item.get('overlapFromChunkId'),
            'overlapChars': item.get('overlapChars', 0),
        }

    @staticmethod
    def _simple_chunk(document_id: str, chunk_id: str, text: str, ordinal: int) -> dict:
        return {
            'schemaVersion': 2,
            'documentId': document_id,
            'chunkId': chunk_id,
            'parentChunkId': f'p-{chunk_id}',
            'ordinal': ordinal,
            'text': text,
            'sectionPath': [],
            'nodeIds': [],
            'sourceRefs': [],
            'overlapFromChunkId': None,
            'overlapChars': 0,
        }


if __name__ == '__main__':
    unittest.main()
