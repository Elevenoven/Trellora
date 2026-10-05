import json
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline_worker.entities_stage import run_entities_finalize_stage, run_entities_prepare_stage
from pipeline_worker.stage_errors import StageCancelled, StageError


def _write_jsonl(path: Path, values):
    path.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in values), encoding='utf-8')


def _read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


TEXT_C1 = '孟汉使用 Electron 开发桌面应用。'
TEXT_C2 = '孟汉与 Electron 团队共同维护 GraphRAG 项目。'
TEXT_C3 = 'GraphRAG 的社区检测依赖 Leiden 算法。'


def _write_chunks(chunks_dir: Path, rows=None):
    chunks_dir.mkdir(parents=True, exist_ok=True)
    if rows is None:
        rows = [
            {'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': TEXT_C1},
            {'chunkId': 'c-2', 'parentChunkId': 'p-1', 'text': TEXT_C2},
        ]
    _write_jsonl(chunks_dir / 'children.jsonl', rows)


def _prepare(root: Path, rows=None, **config_patch):
    chunks_dir = root / 'chunks'
    output_dir = root / 'entities'
    _write_chunks(chunks_dir, rows)
    config = dict(config_patch)
    counts = run_entities_prepare_stage(str(chunks_dir), str(output_dir), 'doc-1', 'hash-1', config, Event(), lambda *_: None, 'stage-1')
    requests = _read_jsonl(output_dir / 'entities-llm-requests.jsonl')
    return chunks_dir, output_dir, config, counts, requests


def _entity_response(request, entities, relations=()):
    return {
        'requestId': request['requestId'],
        'inputHash': request['inputHash'],
        'output': json.dumps({'entities': entities, 'relations': list(relations)}, ensure_ascii=False),
    }


def _entity(name, chunk_id, quote, **overrides):
    value = {'name': name, 'type': 'concept', 'description': '', 'evidence': [{'chunkId': chunk_id, 'quote': quote}]}
    value.update(overrides)
    return value


class EntitiesPrepareStageTests(unittest.TestCase):
    def test_prepare_batches_three_chunks_per_request(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [{'chunkId': f'c-{index}', 'parentChunkId': 'p-1', 'text': f'第{index}块正文。'} for index in range(1, 8)]
            _chunks, output, _config, counts, requests = _prepare(root, rows)
            self.assertEqual(counts, {'chunks': 7, 'llmRequests': 3, 'needsLlmContinuation': 1})
            self.assertEqual([request['requestId'] for request in requests], ['ent-00001', 'ent-00002', 'ent-00003'])
            self.assertEqual([request['chunkIds'] for request in requests],
                             [['c-1', 'c-2', 'c-3'], ['c-4', 'c-5', 'c-6'], ['c-7']])
            self.assertEqual(requests[0]['chunkId'], 'c-1')
            state = json.loads((output / 'entities-llm-state.json').read_text(encoding='utf-8'))
            self.assertEqual(state['batchSize'], 3)
            self.assertEqual(state['requestCount'], 3)

    def test_prepare_writes_tagged_full_text_without_truncation(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            long_text = '实体文本。' * 2000
            rows = [
                {'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': long_text},
                {'chunkId': 'c-2', 'parentChunkId': 'p-1', 'text': 'x < y & z > 0'},
            ]
            _chunks, _output, _config, counts, requests = _prepare(root, rows)
            self.assertEqual(counts['llmRequests'], 1)
            text = requests[0]['text']
            self.assertTrue(text.startswith('<chunks>'))
            self.assertIn(f'<chunk id="c-1">{long_text}</chunk>', text)
            self.assertIn('<chunk id="c-2">x &lt; y &amp; z &gt; 0</chunk>', text)
            self.assertTrue(text.endswith('</chunks>'))
            self.assertEqual(requests[0]['maxChars'], len(text))

    def test_prepare_without_chunks_raises(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            with self.assertRaises(StageError) as error:
                _prepare(root, rows=[])
            self.assertEqual(error.exception.code, 'ENTITIES_NO_CHUNKS')
            self.assertFalse(error.exception.retryable)

    def test_prepare_skips_blank_text_batches(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [
                {'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': '   '},
                {'chunkId': 'c-2', 'parentChunkId': 'p-1', 'text': '   '},
                {'chunkId': 'c-3', 'parentChunkId': 'p-1', 'text': '   '},
                {'chunkId': 'c-4', 'parentChunkId': 'p-1', 'text': '有内容的块。'},
            ]
            _chunks, _output, _config, counts, requests = _prepare(root, rows)
            self.assertEqual(counts['llmRequests'], 1)
            self.assertEqual(requests[0]['chunkIds'], ['c-4'])


class EntitiesFinalizeStageTests(unittest.TestCase):
    def test_finalize_aggregates_with_verified_evidence(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [
                {'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': TEXT_C1},
                {'chunkId': 'c-2', 'parentChunkId': 'p-1', 'text': TEXT_C2},
                {'chunkId': 'c-3', 'parentChunkId': 'p-1', 'text': TEXT_C3},
                {'chunkId': 'c-4', 'parentChunkId': 'p-1', 'text': '孟汉宣布 GraphRAG 项目已完成第一阶段交付。'},
            ]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows)
            responses = [
                _entity_response(requests[0], [
                    _entity('孟汉', 'c-1', '孟汉使用 Electron', type='person', description='开发者'),
                    _entity('Electron', 'c-1', '使用 Electron 开发桌面应用', type='technology'),
                    _entity('GraphRAG', 'c-2', '共同维护 GraphRAG 项目', type='project'),
                ], [
                    {'source': '孟汉', 'target': 'Electron', 'kind': '使用', 'strength': 3,
                     'evidence': [{'chunkId': 'c-1', 'quote': '孟汉使用 Electron 开发桌面应用'}]},
                    {'source': '孟汉', 'target': 'GraphRAG', 'kind': '维护', 'strength': 4,
                     'evidence': [{'chunkId': 'c-2', 'quote': '孟汉与 Electron 团队共同维护 GraphRAG 项目'}]},
                ]),
                _entity_response(requests[1], [
                    _entity('孟汉', 'c-4', '孟汉宣布 GraphRAG', type='person'),
                    _entity('GraphRAG', 'c-4', 'GraphRAG 项目已完成第一阶段', type='project'),
                ], [
                    {'source': '孟汉', 'target': 'GraphRAG', 'kind': '维护', 'strength': 2,
                     'evidence': [{'chunkId': 'c-4', 'quote': '孟汉宣布 GraphRAG 项目已完成第一阶段交付'}]},
                ]),
            ]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            entities = {row['canonicalKey']: row for row in _read_jsonl(output / 'entities.jsonl')}
            self.assertEqual(counts['entities'], len(entities))
            menghan = entities['孟汉']
            self.assertEqual(menghan['occurrences'], 2)
            self.assertEqual(menghan['chunkIds'], ['c-1', 'c-4'])
            self.assertEqual(menghan['evidence'], [
                {'chunkId': 'c-1', 'quote': '孟汉使用 Electron'},
                {'chunkId': 'c-4', 'quote': '孟汉宣布 GraphRAG'},
            ])
            graphrag = entities['graphrag']
            self.assertEqual(graphrag['occurrences'], 2)
            self.assertEqual(graphrag['chunkIds'], ['c-2', 'c-4'])
            relations = _read_jsonl(output / 'relations.jsonl')
            self.assertEqual(len(relations), 2)
            maintenance = next(row for row in relations if row['kind'] == '维护')
            self.assertEqual(maintenance['strengthMean'], 3)
            self.assertEqual(maintenance['strengthSampleCount'], 2)
            self.assertEqual(maintenance['supportChunkCount'], 2)
            self.assertNotIn('weight', maintenance)
            self.assertEqual(maintenance['chunkIds'], ['c-2', 'c-4'])
            self.assertEqual(len(maintenance['evidence']), 2)
            report = json.loads((output / 'extraction-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['counts']['droppedEntities'], 0)
            self.assertEqual(report['counts']['droppedRelations'], 0)
            self.assertFalse((output / 'entities-llm-requests.jsonl').exists())

    def test_finalize_drops_entries_without_recallable_evidence(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            responses = [
                _entity_response(requests[0], [
                    _entity('有证据实体', 'c-1', '孟汉使用 Electron'),
                    _entity('实体乙', 'c-1', '使用 Electron 开发'),
                    _entity('无证据实体', 'c-1', ''),
                    _entity('引用不存在', 'c-1', '原文里根本没有这句话'),
                    _entity('越界块引用', 'c-9', '孟汉使用 Electron'),
                ], [
                    {'source': '有证据实体', 'target': '实体乙', 'kind': '关联', 'strength': 2,
                     'evidence': [{'chunkId': 'c-1', 'quote': '这句引用在原文里不存在'}]},
                ]),
            ]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            entities = {row['canonicalKey']: row for row in _read_jsonl(output / 'entities.jsonl')}
            self.assertEqual(sorted(entities), ['实体乙', '有证据实体'])
            self.assertEqual(counts['droppedEntities'], 3)
            self.assertEqual(counts['relations'], 0)
            self.assertEqual(counts['droppedRelations'], 1)

    def test_finalize_accepts_markdown_fence(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            payload = json.dumps({
                'entities': [{'name': '孟汉', 'type': 'person', 'description': '', 'evidence': [{'chunkId': 'c-1', 'quote': '孟汉使用 Electron'}]}],
                'relations': [],
            }, ensure_ascii=False)
            responses = [dict(_entity_response(requests[0], []), output=f'```json\n{payload}\n```')]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['failed'], 0)
            self.assertEqual(counts['entities'], 1)

    def test_finalize_recovers_truncated_output_without_closing_fence(self):
        # 优化方案 P1-6：截断输出只剩开围栏，内容本身完整，应恢复成功。
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            payload = json.dumps({
                'entities': [{'name': '孟汉', 'type': 'person', 'description': '', 'evidence': [{'chunkId': 'c-1', 'quote': '孟汉使用 Electron'}]}],
                'relations': [],
            }, ensure_ascii=False)
            responses = [dict(_entity_response(requests[0], []), output=f'```json\n{payload} ``')]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['failed'], 0)
            self.assertEqual(counts['entities'], 1)

    def test_finalize_recovers_naked_json_embedded_in_prose(self):
        # 优化方案 P1-6：无围栏的裸 JSON 混在散文中，字符串内含转义引号与括号，
        # 状态机括号配对必须尊重字符串转义才能取到最外层块。
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            payload = json.dumps({
                'entities': [{
                    'name': '孟汉', 'type': 'person',
                    'description': '描述含 "转义引号" 与 } 字符',
                    'evidence': [{'chunkId': 'c-1', 'quote': '孟汉使用 Electron'}],
                }],
                'relations': [],
            }, ensure_ascii=False)
            responses = [dict(_entity_response(requests[0], []), output=f'提取结果如下：{payload} 以上。')]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['failed'], 0)
            self.assertEqual(counts['entities'], 1)

    def test_finalize_still_fails_when_truncation_cuts_inside_json(self):
        # 优化方案 P1-6：截断切在 JSON 内部时无法恢复，仍计为失败（只放宽解析，不放宽事实）。
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [
                {'chunkId': f'c-{index}', 'parentChunkId': 'p-1', 'text': f'第{index}块正文内容。'} for index in range(1, 5)
            ]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows)
            responses = [
                _entity_response(requests[0], [_entity('实体一', 'c-1', '第1块正文内容')]),
                dict(_entity_response(requests[1], []), output='```json\n{"entities": [{"name": "实体二"'),
            ]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['failed'], 1)
            self.assertEqual(counts['entities'], 1)

    def test_finalize_records_partial_failures_and_still_commits(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [
                {'chunkId': f'c-{index}', 'parentChunkId': 'p-1', 'text': f'第{index}块正文内容。'} for index in range(1, 13)
            ]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows)
            self.assertEqual(len(requests), 4)
            responses = [
                _entity_response(requests[index], [_entity(f'实体{index + 1}', f'c-{index * 3 + 1}', f'第{index * 3 + 1}块正文内容')])
                for index in range(3)
            ]
            responses.append(dict(_entity_response(requests[3], []), output='这不是 JSON'))
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['succeeded'], 3)
            self.assertEqual(counts['failed'], 1)
            report = json.loads((output / 'extraction-report.json').read_text(encoding='utf-8'))
            self.assertEqual([failure['requestId'] for failure in report['failures']], [requests[3]['requestId']])
            self.assertEqual(report['failures'][0]['reason'], 'schema-validation')

    def test_finalize_fails_when_majority_of_requests_fail(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [
                {'chunkId': f'c-{index}', 'parentChunkId': 'p-1', 'text': f'第{index}块正文内容。'} for index in range(1, 7)
            ]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows)
            responses = [dict(_entity_response(request, []), output='坏输出') for request in requests]
            with self.assertRaises(StageError) as error:
                run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'ENTITIES_LLM_FAILED')
            self.assertTrue(error.exception.retryable)
            self.assertFalse((output / 'entities.jsonl').exists())

    def test_finalize_rejects_conflicting_state(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            responses = [_entity_response(requests[0], [_entity('实体', 'c-1', '孟汉使用 Electron')])]
            with self.assertRaises(StageError) as error:
                run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-2', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'ENTITIES_STATE_CONFLICT')

    def test_finalize_requires_state_file(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, _requests = _prepare(root)
            (output / 'entities-llm-state.json').unlink()
            with self.assertRaises(StageError) as error:
                run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, [], Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'ENTITIES_STATE_MISSING')

    def test_finalize_ignores_responses_with_mismatched_input_hash(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            rows = [{'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': '唯一块正文。'}]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows)
            responses = [dict(_entity_response(requests[0], [_entity('实体', 'c-1', '唯一块正文')]), inputHash='tampered')]
            with self.assertRaises(StageError) as error:
                run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'ENTITIES_LLM_FAILED')

    def test_finalize_respects_cancel_event(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            chunks_dir, output, config, _counts, requests = _prepare(root)
            cancel_event = Event()
            cancel_event.set()
            with self.assertRaises(StageCancelled):
                run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, requests, cancel_event, lambda *_: None, 'stage-1')

    def test_finalize_caps_batch_entities_and_relations(self):
        with tempfile.TemporaryDirectory(prefix='entities-test-') as value:
            root = Path(value)
            text = '甲与乙、丙、丁、戊、己、庚、辛、壬、癸、子、丑共同维护子块零。'
            rows = [{'chunkId': 'c-1', 'parentChunkId': 'p-1', 'text': text}]
            chunks_dir, output, config, _counts, requests = _prepare(root, rows, maxEntitiesPerChunk=2, maxRelationsPerChunk=2)
            # 上限口径为每块上限 × 批大小（2 × 3 = 6）。
            names = ['甲', '乙', '丙', '丁', '戊', '己', '庚']
            entities = [_entity(name, 'c-1', '共同维护子块零') for name in names]
            relations = [
                {'source': '甲', 'target': name, 'kind': '关联', 'strength': 1,
                 'evidence': [{'chunkId': 'c-1', 'quote': '共同维护子块零'}]}
                for name in names[1:]
            ]
            responses = [_entity_response(requests[0], entities, relations)]
            counts = run_entities_finalize_stage(str(chunks_dir), str(output), 'doc-1', 'hash-1', config, responses, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(counts['entities'], 6)
            # 甲→庚 的目标实体庚超出批上限被丢弃，对应关系也随之一并被拒。
            self.assertEqual(counts['relations'], 5)


if __name__ == '__main__':
    unittest.main()
