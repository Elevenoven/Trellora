import json
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline_worker.chunking_stage import finalize_chunking_llm_stage, prepare_chunking_llm_stage, run_chunking_stage
from pipeline_worker.stage_errors import StageError


def _write_jsonl(path: Path, values):
    path.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in values), encoding='utf-8')


def _config(**patch):
    value = {
        'schemaVersion': 2,
        'mode': 'custom',
        'parentStrategies': ['RECURSIVE'],
        'childStrategies': ['LLM', 'RECURSIVE'],
        'parentMinChars': 10,
        'parentTargetChars': 5000,
        'parentMaxChars': 10000,
        'parentOverlapChars': 0,
        'childRecursiveMaxChars': 60,
        'childRecursiveOverlapChars': 0,
        'semanticMaxChars': 60,
        'semanticMinChars': 10,
        'semanticSimilarityThreshold': 0.18,
        'llmEnabled': True,
        'llmMaxChars': 30,
        'llmTimeoutMs': 2000,
        'llmMaxOutputTokens': 200,
        'pageMinMetadataCoverage': 0.8,
    }
    value.update(patch)
    return value


class ChunkingLlmContinuationTests(unittest.TestCase):
    def _prepare(self, root: Path, text: str, **config_patch):
        parse_dir = root / 'parse'
        tree_dir = root / 'tree'
        output_dir = root / 'chunks'
        parse_dir.mkdir(parents=True)
        tree_dir.mkdir(parents=True)
        _write_jsonl(parse_dir / 'blocks.jsonl', [{'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': text, 'source': {}}])
        _write_jsonl(tree_dir / 'structure.jsonl', [{'nodeId': 'n-root', 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}])
        config = _config(**config_patch)
        prepare_chunking_llm_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', config, Event(), lambda *_: None, 'stage-1')
        requests = [json.loads(line) for line in (output_dir / 'chunk-llm-requests.jsonl').read_text(encoding='utf-8').splitlines()]
        return tree_dir, parse_dir, output_dir, config, requests

    @staticmethod
    def _responses(requests, *, wrapper: bool = False):
        return [
            {
                'requestId': request['requestId'],
                'inputHash': request['inputHash'],
                'output': f'切分如下：{json.dumps([request["text"]], ensure_ascii=False)}' if wrapper else json.dumps([request['text']], ensure_ascii=False),
            }
            for request in requests
        ]

    def test_prepare_recursively_bounds_and_conserves_every_llm_input(self):
        with tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
            root = Path(value)
            source = '第一段内容。\n\n第二段内容。\n第三段内容。' * 8
            _tree, _parse, _output, _config_value, requests = self._prepare(root, source)
            self.assertGreater(len(requests), 1)
            self.assertTrue(all(0 < len(request['text']) <= request['maxChars'] for request in requests))
            self.assertEqual(''.join(request['text'] for request in requests), source)
            self.assertTrue(all('apiKey' not in request for request in requests))

    def test_finalize_accepts_short_wrapper_and_commits_only_after_validation(self):
        with tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
            root = Path(value)
            tree, parse, output, config, requests = self._prepare(root, '甲内容。乙内容。丙内容。' * 10)
            finalize_chunking_llm_stage(str(tree), str(parse / 'blocks.jsonl'), str(output), 'doc-1', 'hash-1', config, self._responses(requests, wrapper=True), Event(), lambda *_: None, 'stage-1')
            self.assertTrue((output / 'parents.jsonl').is_file())
            self.assertTrue((output / 'children.jsonl').is_file())
            self.assertFalse((output / 'chunk-llm-state.json').exists())
            self.assertFalse((output / 'chunk-llm-requests.jsonl').exists())

    def test_invalid_or_rewritten_model_output_never_commits(self):
        cases = {
            'markdown': lambda request: f'```json\n{json.dumps([request["text"]], ensure_ascii=False)}\n```',
            'object': lambda request: json.dumps({'chunks': [request['text']]}, ensure_ascii=False),
            'invalid': lambda _request: '["缺少结束括号"',
            'rewritten': lambda _request: '["模型改写后的内容"]',
        }
        for name, output_builder in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
                root = Path(value)
                tree, parse, output, config, requests = self._prepare(root, '原文保持不变。' * 10)
                responses = self._responses(requests)
                responses[0]['output'] = output_builder(requests[0])
                with self.assertRaises(StageError) as error:
                    finalize_chunking_llm_stage(str(tree), str(parse / 'blocks.jsonl'), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
                self.assertIn(error.exception.code, {'CHUNK_LLM_RESPONSE_INVALID', 'CHUNK_TEXT_CONSERVATION_FAILED'})
                self.assertFalse((output / 'parents.jsonl').exists())
                self.assertTrue((output / 'chunk-llm-state.json').is_file())

    def test_rejects_duplicate_or_conflicting_result_before_write(self):
        with tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
            root = Path(value)
            tree, parse, output, config, requests = self._prepare(root, '第一句。第二句。第三句。' * 12)
            responses = self._responses(requests)
            self.assertGreater(len(responses), 1)
            responses[1]['requestId'] = responses[0]['requestId']
            with self.assertRaises(StageError) as error:
                finalize_chunking_llm_stage(str(tree), str(parse / 'blocks.jsonl'), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'CHUNK_LLM_RESPONSE_INVALID')
            self.assertFalse((output / 'parents.jsonl').exists())

    def test_repeated_finalize_is_rejected_after_the_first_commit(self):
        with tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
            root = Path(value)
            tree, parse, output, config, requests = self._prepare(root, '第一句。第二句。第三句。' * 10)
            responses = self._responses(requests)
            finalize_chunking_llm_stage(str(tree), str(parse / 'blocks.jsonl'), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            with self.assertRaises(StageError) as error:
                finalize_chunking_llm_stage(str(tree), str(parse / 'blocks.jsonl'), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'CHUNK_LLM_STATE_MISSING')

    def test_recommended_mode_with_unavailable_model_stays_deterministic(self):
        with tempfile.TemporaryDirectory(prefix='chunking-llm-test-') as value:
            root = Path(value)
            parse_dir, tree_dir, output_dir = root / 'parse', root / 'tree', root / 'chunks'
            parse_dir.mkdir(parents=True)
            tree_dir.mkdir(parents=True)
            _write_jsonl(parse_dir / 'blocks.jsonl', [
                {'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '可切块正文。', 'source': {}},
                {'blockId': 'b-2', 'order': 2, 'kind': 'noise', 'text': 'OCR碎片一', 'source': {}},
                {'blockId': 'b-3', 'order': 3, 'kind': 'noise', 'text': 'OCR碎片二', 'source': {}},
                {'blockId': 'b-4', 'order': 4, 'kind': 'noise', 'text': 'OCR碎片三', 'source': {}},
                {'blockId': 'b-5', 'order': 5, 'kind': 'noise', 'text': 'OCR碎片四', 'source': {}},
                {'blockId': 'b-6', 'order': 6, 'kind': 'noise', 'text': 'OCR碎片五', 'source': {}},
            ])
            _write_jsonl(tree_dir / 'structure.jsonl', [{'nodeId': 'n-root', 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}])
            config = _config(mode='recommended', childStrategies=[], llmEnabled=True, recommendLlmWhenLowQuality=True)
            run_chunking_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', config, Event(), lambda *_: None, 'stage-1', llm_available=False)
            plan = json.loads((output_dir / 'chunk-plan.json').read_text(encoding='utf-8'))
            self.assertEqual(plan['effectiveChildStrategies'], ['RECURSIVE'])
            # Noise blocks are excluded before quality assessment; the remaining
            # sentence is high quality and does not require semantic chunking.
            self.assertEqual(plan['noiseBlocksSkipped'], 5)
            self.assertEqual(plan['quality']['level'], 'HIGH')
            self.assertEqual(plan['recommendation']['reason'], 'QUALITY_NOT_READY_FOR_SEMANTIC')


if __name__ == '__main__':
    unittest.main()
