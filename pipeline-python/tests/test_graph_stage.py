import json
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline_worker.graph_leiden import resolve_engine
from pipeline_worker.graph_stage import run_graph_stage
from pipeline_worker.stage_errors import StageCancelled, StageError

try:
    import igraph  # noqa: F401
    import leidenalg  # noqa: F401
    HAS_LEIDEN = True
except ImportError:
    HAS_LEIDEN = False


def _write_jsonl(path: Path, values):
    path.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in values), encoding='utf-8')


def _read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def _entities_rows():
    return [
        {'canonicalKey': 'a1', 'mention': 'A1', 'type': 'concept', 'description': '甲簇实体一', 'occurrences': 1, 'chunkIds': ['c-a1']},
        {'canonicalKey': 'a2', 'mention': 'A2', 'type': 'concept', 'description': '甲簇实体二', 'occurrences': 1, 'chunkIds': ['c-a2']},
        {'canonicalKey': 'a3', 'mention': 'A3', 'type': 'concept', 'description': '甲簇实体三', 'occurrences': 1, 'chunkIds': ['c-a3']},
        {'canonicalKey': 'b1', 'mention': 'B1', 'type': 'technology', 'description': '乙簇实体一', 'occurrences': 1, 'chunkIds': ['c-b1']},
        {'canonicalKey': 'b2', 'mention': 'B2', 'type': 'technology', 'description': '乙簇实体二', 'occurrences': 1, 'chunkIds': ['c-b2']},
        {'canonicalKey': 'b3', 'mention': 'B3', 'type': 'technology', 'description': '乙簇实体三', 'occurrences': 1, 'chunkIds': ['c-b3']},
    ]


def _relation_rows():
    rows = []
    for source, target in [('a1', 'a2'), ('a2', 'a3'), ('a1', 'a3')]:
        rows.append({'sourceKey': source, 'targetKey': target, 'kind': '同簇', 'description': '', 'strengthMean': 8, 'strengthSampleCount': 1, 'supportChunkCount': 2, 'chunkIds': [f'c-{source}', f'c-{target}']})
    for source, target in [('b1', 'b2'), ('b2', 'b3'), ('b1', 'b3')]:
        rows.append({'sourceKey': source, 'targetKey': target, 'kind': '同簇', 'description': '', 'strengthMean': 8, 'strengthSampleCount': 1, 'supportChunkCount': 2, 'chunkIds': [f'c-{source}', f'c-{target}']})
    rows.append({'sourceKey': 'b1', 'targetKey': 'a3', 'kind': '桥接', 'description': '弱桥边', 'strengthMean': 1, 'strengthSampleCount': 1, 'supportChunkCount': 2, 'chunkIds': ['c-a3', 'c-b1']})
    return rows


def _build_inputs(root: Path, directories=1):
    dirs = []
    for index in range(directories):
        entities_dir = root / f'entities-{index}'
        entities_dir.mkdir(parents=True, exist_ok=True)
        _write_jsonl(entities_dir / 'entities.jsonl', _entities_rows())
        _write_jsonl(entities_dir / 'relations.jsonl', _relation_rows())
        (entities_dir / 'extraction-report.json').write_text(
            json.dumps({'documentId': f'doc-{index}', 'counts': {}}), encoding='utf-8')
        dirs.append(str(entities_dir))
    return dirs


def _run(root: Path, output_name='out', **kwargs):
    dirs = kwargs.pop('entities_dirs', None) or _build_inputs(root)
    output = root / output_name
    counts = run_graph_stage(dirs, str(output), 'graph-key-1', {}, Event(), lambda *_: None, 'stage-1', **kwargs)
    return output, counts


class GraphStageTests(unittest.TestCase):
    def test_graph_artifacts_and_counts(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            output, counts = _run(root)
            self.assertEqual(counts['nodes'], 6)
            self.assertEqual(counts['edges'], 7)
            self.assertEqual(counts['chunkEdges'], 7, '每条关系两端各 1 个 chunk → 7 条 chunk 边')
            graph_rows = _read_jsonl(output / 'graph.jsonl')
            nodes = [row for row in graph_rows if row['kind'] == 'node']
            edges = [row for row in graph_rows if row['kind'] == 'edge']
            self.assertEqual([node['canonicalKey'] for node in nodes], ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'])
            self.assertEqual(edges[0]['sourceKey'], 'a1')
            bridge = [edge for edge in edges if {edge['sourceKey'], edge['targetKey']} == {'a3', 'b1'}][0]
            self.assertEqual(bridge['strengthMean'], 1, '必须保留原始 LLM 语义强度均值')
            self.assertEqual(bridge['strengthSampleCount'], 1)
            self.assertEqual(bridge['supportChunkCount'], 2)
            self.assertEqual(bridge['supportDocCount'], 1)
            self.assertEqual(bridge['weight'], 7, '桥边 = 0.6×满 PMI + 0.4×(1/8) → 1+round(9×0.65)')
            strong = [edge for edge in edges if {edge['sourceKey'], edge['targetKey']} == {'a1', 'a2'}][0]
            self.assertEqual(strong['weight'], 10, '强边 = 满 PMI + 满强度 → 上限 10')
            chunk_edges = _read_jsonl(output / 'chunk_edges.jsonl')
            self.assertEqual(len(chunk_edges), 7)
            for row in chunk_edges:
                self.assertLess(row['chunkIdA'], row['chunkIdB'], 'chunk 边必须规范化为 a < b')
                self.assertTrue(1 <= row['weight'] <= 10)
            report = json.loads((output / 'graph-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['graphKey'], 'graph-key-1')
            self.assertEqual(report['sourceDocuments'], ['doc-0'])
            self.assertEqual(report['schemaVersion'], 3)
            self.assertEqual(report['weightConfig']['version'], 'pmi-v2')
            self.assertEqual(report['weightConfig']['strengthAggregation'], 'mean')
            self.assertEqual(report['counts']['chunkEdges'], 7)
            self.assertGreaterEqual(report['durationMs'], 0)

    def test_cross_document_edge_weights_aggregate(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            dirs = _build_inputs(root, directories=2)
            output, counts = _run(root, entities_dirs=dirs)
            graph_rows = _read_jsonl(output / 'graph.jsonl')
            edge = [row for row in graph_rows if row['kind'] == 'edge' and row['sourceKey'] == 'a1'][0]
            self.assertEqual(edge['strengthMean'], 8, '跨文档重复关系不得抬高语义强度均值')
            self.assertEqual(edge['strengthSampleCount'], 2)
            self.assertEqual(edge['supportDocCount'], 2, '跨文档支持数必须独立累计')
            self.assertTrue(1 <= edge['weight'] <= 10, '最终权重必须归一化到 1~10，不得随文档数膨胀')
            node = [row for row in graph_rows if row['kind'] == 'node' and row['canonicalKey'] == 'a1'][0]
            self.assertEqual(node['docIds'], ['doc-0', 'doc-1'])
            report = json.loads((output / 'graph-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['sourceDocuments'], ['doc-0', 'doc-1'])

    def test_chunk_edges_only_within_same_document(self):
        """chunk 图投影只连同文档内的 chunk 对，跨文档对第一版不做（防概念同名虚假关联）。"""
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            # doc-0：x↔y；doc-1：x↔z。x 的 chunk 分属两文档，不得产生 cx0↔cz1 这类跨文档边。
            for index, (entities, relations) in enumerate([
                ([{'canonicalKey': 'x', 'mention': 'X', 'type': 'concept', 'description': '', 'occurrences': 1, 'chunkIds': ['cx0']},
                  {'canonicalKey': 'y', 'mention': 'Y', 'type': 'concept', 'description': '', 'occurrences': 1, 'chunkIds': ['cy0']}],
                 [{'sourceKey': 'x', 'targetKey': 'y', 'kind': '相关', 'description': '', 'weight': 3, 'chunkIds': ['cx0', 'cy0']}]),
                ([{'canonicalKey': 'x', 'mention': 'X', 'type': 'concept', 'description': '', 'occurrences': 1, 'chunkIds': ['cx1']},
                  {'canonicalKey': 'z', 'mention': 'Z', 'type': 'concept', 'description': '', 'occurrences': 1, 'chunkIds': ['cz1']}],
                 [{'sourceKey': 'x', 'targetKey': 'z', 'kind': '相关', 'description': '', 'weight': 2, 'chunkIds': ['cx1', 'cz1']}]),
            ]):
                entities_dir = root / f'entities-{index}'
                entities_dir.mkdir(parents=True, exist_ok=True)
                _write_jsonl(entities_dir / 'entities.jsonl', entities)
                _write_jsonl(entities_dir / 'relations.jsonl', relations)
                (entities_dir / 'extraction-report.json').write_text(
                    json.dumps({'documentId': f'doc-{index}', 'counts': {}}), encoding='utf-8')
            output, _counts = _run(root, entities_dirs=[str(root / 'entities-0'), str(root / 'entities-1')])
            chunk_edges = _read_jsonl(output / 'chunk_edges.jsonl')
            pairs = {frozenset((row['chunkIdA'], row['chunkIdB'])) for row in chunk_edges}
            self.assertEqual(pairs, {frozenset(('cx0', 'cy0')), frozenset(('cx1', 'cz1'))},
                             '只允许同文档内的 chunk 对，不得出现跨文档边')

    @unittest.skipUnless(HAS_LEIDEN, 'igraph/leidenalg 不可用')
    def test_two_clusters_split_at_level_zero(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            output, _counts = _run(root)
            communities = _read_jsonl(output / 'communities.jsonl')
            level0 = [row for row in communities if row['level'] == 0]
            self.assertEqual(len(level0), 2, '双簇 + 弱桥边 level-0 必须分裂为 2 社区')
            groups = sorted(sorted(row['memberKeys']) for row in level0)
            self.assertEqual(groups, [['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']])
            for row in level0:
                self.assertIsNone(row['parentId'])

    def test_deterministic_community_ids_across_runs(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            first, _counts = _run(root, output_name='out-1')
            second, _counts = _run(root, output_name='out-2')
            first_ids = [row['communityId'] for row in _read_jsonl(first / 'communities.jsonl')]
            second_ids = [row['communityId'] for row in _read_jsonl(second / 'communities.jsonl')]
            self.assertEqual(first_ids, second_ids, '同 seed 两次运行社区编号必须一致')

    def test_mece_partition_at_every_level(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            output, _counts = _run(root)
            communities = _read_jsonl(output / 'communities.jsonl')
            all_keys = {'a1', 'a2', 'a3', 'b1', 'b2', 'b3'}
            levels = sorted({row['level'] for row in communities})
            self.assertIn(0, levels)
            for level in levels:
                seen = []
                for row in communities:
                    if row['level'] != level:
                        continue
                    seen.extend(row['memberKeys'])
                    if level > 0:
                        parent = [candidate for candidate in communities if candidate['communityId'] == row['parentId']]
                        self.assertEqual(len(parent), 1, '高层社区必须引用存在的父社区')
                        self.assertEqual(parent[0]['level'], level - 1)
                        self.assertTrue(set(row['memberKeys']) <= set(parent[0]['memberKeys']))
                self.assertEqual(sorted(seen), sorted(all_keys), f'level {level} 必须互斥完备覆盖全部节点')
                self.assertEqual(len(seen), len(set(seen)), f'level {level} 社区之间不得重叠')

    def test_fallback_engine_keeps_schema(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            output, counts = _run(root, engine_override=resolve_engine(force_fallback=True))
            report = json.loads((output / 'graph-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['engine'], 'louvain-fallback')
            self.assertEqual(counts['nodes'], 6)
            communities = _read_jsonl(output / 'communities.jsonl')
            for row in communities:
                self.assertEqual(set(row.keys()), {'communityId', 'level', 'parentId', 'memberKeys', 'edgeCount', 'tokens'})

    def test_cancel_event_raises(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            dirs = _build_inputs(root)
            cancel_event = Event()
            cancel_event.set()
            with self.assertRaises(StageCancelled):
                run_graph_stage(dirs, str(root / 'out'), 'graph-key-1', {}, cancel_event, lambda *_: None, 'stage-1')

    def test_missing_entities_dir_raises(self):
        with tempfile.TemporaryDirectory(prefix='graph-test-') as value:
            root = Path(value)
            with self.assertRaises(StageError) as error:
                run_graph_stage([str(root / 'missing')], str(root / 'out'), 'graph-key-1', {}, Event(), lambda *_: None, 'stage-1')
            self.assertEqual(error.exception.code, 'GRAPH_INPUTS_MISSING')
            self.assertFalse(error.exception.retryable)


if __name__ == '__main__':
    unittest.main()
