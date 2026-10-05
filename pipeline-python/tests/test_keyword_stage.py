from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from threading import Event

ROOT = Path(__file__).resolve().parents[1]

import sys

sys.path.insert(0, str(ROOT))

from pipeline_worker.stage_errors import StageCancelled, StageError  # noqa: E402
from pipeline_worker.keyword_contract import parse_keyword_chunk, validate_keyword_output  # noqa: E402
from pipeline_worker.keyword_stage import run_keywords_stage  # noqa: E402


DICTIONARY = ['权限管理', '审计留痕', '文档处理']


def chunk_record(ordinal: int, *, document_id: str = 'doc-stage') -> dict[str, object]:
    return {
        'schemaVersion': 2,
        'documentId': document_id,
        'chunkId': f'chunk-{ordinal}',
        'parentChunkId': f'parent-{ordinal}',
        'ordinal': ordinal,
        'text': f'权限管理负责第 {ordinal} 个文档处理任务，并保留审计留痕。',
        'sectionPath': [{'title': '权限管理'}],
        'nodeIds': [f'node-{ordinal}'],
        'sourceRefs': [{'lineNo': ordinal + 1}],
        'overlapFromChunkId': None,
        'overlapChars': 0,
    }


def write_chunks(path: Path, count: int = 3) -> list[dict[str, object]]:
    records = [chunk_record(index) for index in range(count)]
    path.write_text('\n'.join(json.dumps(record, ensure_ascii=False) for record in records) + '\n', encoding='utf-8')
    return records


def stage_options() -> dict[str, object]:
    return {
        'stageKey': 'keywords-test-v1',
        'documentId': 'doc-stage',
        'tokenizer': 'rule-explicit',
        'dictionaryTerms': DICTIONARY,
        'config': {
            'enabled': True,
            'maxCandidatesPerChunk': 32,
            'maxKeywords': 5,
            'minScore': 0,
            'allowOverlapFallback': True,
        },
    }


class KeywordStageTests(unittest.TestCase):
    def test_two_pass_stage_writes_contract_report_and_manifest(self):
        with tempfile.TemporaryDirectory(prefix='keywords-stage-') as temporary:
            root = Path(temporary)
            chunks_path = root / 'chunks.jsonl'
            output_path = root / '07-keywords'
            records = write_chunks(chunks_path)
            progress: list[tuple[int, int | None, str, str]] = []

            counts = run_keywords_stage(
                str(chunks_path),
                str(output_path),
                stage_options(),
                Event(),
                lambda completed, total, unit, message: progress.append((completed, total, unit, message)),
            )

            self.assertEqual(counts['chunks'], 3)
            self.assertGreater(counts['keywords'], 0)
            self.assertTrue((output_path / 'keyword-report.json').is_file())
            self.assertTrue((output_path / 'stage-manifest.json').is_file())
            self.assertFalse((output_path / 'keyword-candidates.partial.jsonl').exists())
            checkpoint = json.loads((output_path / 'checkpoint.json').read_text(encoding='utf-8'))
            self.assertTrue(checkpoint['complete'])
            self.assertEqual(checkpoint['phase'], 'rank')
            self.assertEqual([item[2] for item in progress[-2:]], ['rank', 'chunk'])

            outputs = [json.loads(line) for line in (output_path / 'keywords.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(len(outputs), len(records))
            for record, output in zip(records, outputs):
                chunk = parse_keyword_chunk(record)
                validate_keyword_output(output, chunk, max_keywords=5)
                self.assertEqual(output['schemaVersion'], 3)
                self.assertEqual(output['keyword'], [item['term'] for item in output['keywords']])
                self.assertIsInstance(output['searchTokens'], list)
                self.assertGreater(len(output['searchTokens']), 0)
                self.assertEqual(output['algorithm']['version'], 'kw-1')

    def test_collect_and_rank_can_resume_from_checkpoints_after_cancellation(self):
        with tempfile.TemporaryDirectory(prefix='keywords-stage-resume-') as temporary:
            root = Path(temporary)
            chunks_path = root / 'chunks.jsonl'
            output_path = root / '07-keywords'
            write_chunks(chunks_path, count=110)

            first_cancel = Event()

            def cancel_collect(completed: int, _total: int | None, unit: str, _message: str) -> None:
                if unit == 'candidate' and completed >= 50:
                    first_cancel.set()

            with self.assertRaises(StageCancelled):
                run_keywords_stage(str(chunks_path), str(output_path), stage_options(), first_cancel, cancel_collect)
            collect_checkpoint = json.loads((output_path / 'checkpoint.json').read_text(encoding='utf-8'))
            self.assertEqual(collect_checkpoint['phase'], 'collect')
            self.assertFalse(collect_checkpoint['complete'])
            self.assertTrue((output_path / 'keyword-candidates.partial.jsonl').is_file())

            rank_cancel = Event()

            def cancel_rank(completed: int, _total: int | None, unit: str, _message: str) -> None:
                if unit == 'rank' and completed >= 50:
                    rank_cancel.set()

            with self.assertRaises(StageCancelled):
                run_keywords_stage(str(chunks_path), str(output_path), stage_options(), rank_cancel, cancel_rank)
            rank_checkpoint = json.loads((output_path / 'checkpoint.json').read_text(encoding='utf-8'))
            self.assertEqual(rank_checkpoint['phase'], 'rank')
            self.assertEqual(rank_checkpoint['rankedChunks'], 50)
            self.assertFalse(rank_checkpoint['complete'])

            counts = run_keywords_stage(str(chunks_path), str(output_path), stage_options(), Event(), lambda *_args: None)
            self.assertEqual(counts['chunks'], 110)
            self.assertTrue(json.loads((output_path / 'checkpoint.json').read_text(encoding='utf-8'))['complete'])
            self.assertEqual(len((output_path / 'keywords.jsonl').read_text(encoding='utf-8').splitlines()), 110)

    def test_invalid_input_has_stable_non_retryable_error(self):
        with tempfile.TemporaryDirectory(prefix='keywords-stage-invalid-') as temporary:
            root = Path(temporary)
            chunks_path = root / 'chunks.jsonl'
            chunks_path.write_text('{"schemaVersion":2,"chunkId":"broken"}\n', encoding='utf-8')
            with self.assertRaises(StageError) as context:
                run_keywords_stage(str(chunks_path), str(root / '07-keywords'), stage_options(), Event(), lambda *_args: None)
            self.assertEqual(context.exception.code, 'KEYWORDS_INPUT_INVALID')
            self.assertFalse(context.exception.retryable)

    def test_disabled_config_writes_a_disabled_report(self):
        with tempfile.TemporaryDirectory(prefix='keywords-stage-disabled-') as temporary:
            root = Path(temporary)
            options = stage_options()
            options['config'] = {'enabled': False}
            counts = run_keywords_stage(str(root / 'missing.jsonl'), str(root / '07-keywords'), options, Event(), lambda *_args: None)
            self.assertEqual(counts['keywords'], 0)
            report = json.loads((root / '07-keywords' / 'keyword-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['status'], 'disabled')


if __name__ == '__main__':
    unittest.main()
