import json
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline_worker.chunking_stage import run_chunking_stage
from pipeline_worker.chunking_strategies import recursive_split
from pipeline_worker.stage_errors import StageError


def _write_jsonl(path: Path, values):
    path.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in values), encoding='utf-8')


def _config(**patch):
    value = {
        'schemaVersion': 2,
        'mode': 'custom',
        'parentStrategies': ['STRUCTURE', 'RECURSIVE'],
        'childStrategies': ['RECURSIVE'],
        'parentMinChars': 20,
        'parentTargetChars': 80,
        'parentMaxChars': 120,
        'parentOverlapChars': 10,
        'childRecursiveMaxChars': 45,
        'childRecursiveOverlapChars': 8,
        'semanticMaxChars': 45,
        'semanticMinChars': 10,
        'semanticSimilarityThreshold': 0.18,
        'pageMinMetadataCoverage': 0.8,
    }
    value.update(patch)
    return value


def _run(tmp_path: Path, blocks, nodes, config=None):
    parse_dir = tmp_path / 'parse'
    tree_dir = tmp_path / 'tree'
    output_dir = tmp_path / 'chunks'
    parse_dir.mkdir(parents=True)
    tree_dir.mkdir(parents=True)
    _write_jsonl(parse_dir / 'blocks.jsonl', blocks)
    _write_jsonl(tree_dir / 'structure.jsonl', nodes)
    run_chunking_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', config or _config(), Event(), lambda *_: None, 'stage-1')
    return [json.loads(line) for line in (output_dir / 'parents.jsonl').read_text(encoding='utf-8').splitlines()], [json.loads(line) for line in (output_dir / 'children.jsonl').read_text(encoding='utf-8').splitlines()]


def test_structure_groups_only_adjacent_sections_and_children_keep_context(tmp_path):
    path_a = [{'nodeId': 'h-a', 'text': '第一章', 'type': 'HEADING'}]
    path_b = [{'nodeId': 'h-b', 'text': '第二章', 'type': 'HEADING'}]
    nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'h-a', 'type': 'HEADING', 'sectionPath': path_a, 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'body-a', 'type': 'BODY', 'sectionPath': path_a, 'sourceRefs': [{'blockId': 'b-2'}]},
        {'nodeId': 'h-b', 'type': 'HEADING', 'sectionPath': path_b, 'sourceRefs': [{'blockId': 'b-3'}]},
        {'nodeId': 'body-b', 'type': 'BODY', 'sectionPath': path_b, 'sourceRefs': [{'blockId': 'b-4'}]},
        {'nodeId': 'body-a-again', 'type': 'BODY', 'sectionPath': path_a, 'sourceRefs': [{'blockId': 'b-5'}]},
    ]
    blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': text, 'source': {'page': index}} for index, text in enumerate(['第一章', '甲内容', '第二章', '乙内容', '第一章补充'], 1)]
    parents, children = _run(tmp_path, blocks, nodes)
    assert len(parents) == 3
    assert [parent['sectionPath'][-1]['text'] for parent in parents] == ['第一章', '第二章', '第一章']
    assert len(children) >= len(parents)
    assert all(child['parentChunkId'] in {parent['parentId'] for parent in parents} for child in children)
    assert all(child['sectionContext'] for child in children)
    assert all('章节：' in child['text'] for child in children)


def test_document_title_is_a_real_section_without_absorbing_preamble(tmp_path):
    title_path = [{'nodeId': 'n-title', 'text': '入库全链路总览', 'type': 'DOCUMENT_TITLE'}]
    nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'n-title', 'type': 'DOCUMENT_TITLE', 'sectionPath': title_path, 'sourceRefs': [{'blockId': 'b-2', 'synthetic': True}]},
        {'nodeId': 'preamble', 'type': 'BODY', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'body', 'type': 'BODY', 'sectionPath': title_path, 'sourceRefs': [{'blockId': 'b-3'}]},
    ]
    blocks = [
        {'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '文档前言。', 'source': {'line': 1}},
        {'blockId': 'b-2', 'order': 2, 'kind': 'heading', 'text': '## **入库全链路总览**', 'source': {'line': 2}},
        {'blockId': 'b-3', 'order': 3, 'kind': 'paragraph', 'text': '正文内容。', 'source': {'line': 3}},
    ]
    parents, children = _run(tmp_path, blocks, nodes)

    assert [parent['sectionPath'][-1]['text'] for parent in parents] == ['文档前言', '入库全链路总览']
    assert parents[0]['sourceText'] == '文档前言。'
    assert parents[1]['sourceText'] == '## **入库全链路总览**\n\n正文内容。'
    assert all('入库全链路总览 / 入库全链路总览' not in child['text'] for child in children)


def test_structure_without_heading_falls_back_to_large_recursive_parent(tmp_path):
    nodes = [{'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}]
    blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': '段落内容。' * 25, 'source': {}} for index in range(1, 4)]
    parents, children = _run(tmp_path, blocks, nodes, _config(parentStrategies=['STRUCTURE', 'RECURSIVE'], parentMinChars=10, parentTargetChars=20, parentMaxChars=30, parentOverlapChars=5))
    assert parents
    assert all(parent['boundaryReason'] != 'STRUCTURE_SECTION' for parent in parents)
    assert all(len(child['text']) > 0 for child in children)


def test_long_children_reserve_full_section_context_before_splitting(tmp_path):
    section_path = [{'nodeId': 'h-1', 'text': '超长章节', 'type': 'HEADING'}]
    nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'h-1', 'type': 'HEADING', 'sectionPath': section_path, 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'body-1', 'type': 'BODY', 'sectionPath': section_path, 'sourceRefs': [{'blockId': 'b-2'}]},
    ]
    blocks = [
        {'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '超长章节', 'source': {'page': 1}},
        {'blockId': 'b-2', 'order': 2, 'kind': 'paragraph', 'text': '这是用于验证上下文预算的正文。' * 80, 'source': {'page': 1}},
    ]
    _parents, children = _run(tmp_path, blocks, nodes, _config(parentMaxChars=120, childRecursiveMaxChars=45, childRecursiveOverlapChars=8))
    assert len(children) > 1
    assert all(child['sectionContext'] == '章节：超长章节' for child in children)
    assert all(child['text'] == f"{child['sectionContext']}\n\n{child['sourceText']}" for child in children)
    assert all(len(child['text']) <= 45 for child in children)


def test_recursive_split_uses_natural_boundaries_and_makes_progress():
    text = '第一段内容。\n\n第二段内容。\n第三段内容。' * 20
    chunks = recursive_split(text, 40, 8)
    assert chunks
    assert all(0 < len(chunk) <= 40 for chunk in chunks)
    assert len(chunks) < len(text)


def test_replay_is_deterministic(tmp_path):
    nodes = [{'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}]
    blocks = [{'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '稳定文本。' * 20, 'source': {}}]
    first_parents, first_children = _run(tmp_path / 'one', blocks, nodes, _config(parentStrategies=['RECURSIVE'], parentMaxChars=80))
    second_parents, second_children = _run(tmp_path / 'two', blocks, nodes, _config(parentStrategies=['RECURSIVE'], parentMaxChars=80))
    assert first_parents == second_parents
    assert first_children == second_children


def test_recommended_mode_persists_semantic_plan(tmp_path):
    parse_dir = tmp_path / 'parse'
    tree_dir = tmp_path / 'tree'
    output_dir = tmp_path / 'chunks'
    parse_dir.mkdir(parents=True)
    tree_dir.mkdir(parents=True)
    blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': ('这是一个有明确语义边界的段落。' * 10), 'source': {}} for index in range(1, 5)]
    nodes = [{'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}]
    _write_jsonl(parse_dir / 'blocks.jsonl', blocks)
    _write_jsonl(tree_dir / 'structure.jsonl', nodes)
    settings = _config(mode='recommended', parentStrategies=['RECURSIVE'], childStrategies=[], parentTargetChars=100, parentMaxChars=200, childRecursiveMaxChars=60, semanticMaxChars=60, semanticMinChars=20)
    run_chunking_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', settings, Event(), lambda *_: None, 'stage-1')
    plan = json.loads((output_dir / 'chunk-plan.json').read_text(encoding='utf-8'))
    assert plan['quality']['paragraphReady'] is True
    assert plan['effectiveChildStrategies'] == ['SEMANTIC', 'RECURSIVE']
    assert plan['recommendation']['reason'] in {'PARAGRAPH_READY_SEMANTIC', 'MEDIUM_QUALITY_PARAGRAPH_READY'}


def test_noise_only_blocks_are_excluded_but_mixed_blocks_are_retained(tmp_path):
    parse_dir = tmp_path / 'parse'
    tree_dir = tmp_path / 'tree'
    output_dir = tmp_path / 'chunks'
    parse_dir.mkdir(parents=True)
    tree_dir.mkdir(parents=True)
    section_path = [{'nodeId': 'h-1', 'text': '第一章', 'type': 'HEADING'}]
    nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'h-1', 'type': 'HEADING', 'sectionPath': section_path, 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'noise-page', 'type': 'NOISE', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-2'}]},
        {'nodeId': 'body-1', 'type': 'BODY', 'sectionPath': section_path, 'sourceRefs': [{'blockId': 'b-3'}]},
        {'nodeId': 'noise-mixed', 'type': 'NOISE', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-4'}]},
        {'nodeId': 'body-mixed', 'type': 'BODY', 'sectionPath': section_path, 'sourceRefs': [{'blockId': 'b-4'}]},
    ]
    blocks = [
        {'blockId': 'b-1', 'order': 1, 'kind': 'heading', 'text': '第一章', 'source': {'page': 1}},
        {'blockId': 'b-2', 'order': 2, 'kind': 'paragraph', 'text': '第 2 页', 'source': {'page': 2}},
        {'blockId': 'b-3', 'order': 3, 'kind': 'paragraph', 'text': '这是应当保留的正文。', 'source': {'page': 2}},
        {'blockId': 'b-4', 'order': 4, 'kind': 'paragraph', 'text': '混合块中的有效正文。', 'source': {'page': 2}},
    ]
    _write_jsonl(parse_dir / 'blocks.jsonl', blocks)
    _write_jsonl(tree_dir / 'structure.jsonl', nodes)
    counts = run_chunking_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', _config(), Event(), lambda *_: None, 'stage-1')
    children = [json.loads(line) for line in (output_dir / 'children.jsonl').read_text(encoding='utf-8').splitlines()]

    assert counts['noiseBlocksSkipped'] == 1
    assert all('b-2' not in child['sourceBlockIds'] for child in children)
    assert all('第 2 页' not in child['sourceText'] for child in children)
    assert any('b-4' in child['sourceBlockIds'] for child in children)
    report = json.loads((output_dir / 'chunks-report.json').read_text(encoding='utf-8'))
    assert report['counts']['noiseBlocksSkipped'] == 1


class ChunkingStageTests(unittest.TestCase):
    def _with_temp(self, callback):
        with tempfile.TemporaryDirectory(prefix='chunking-v2-test-') as value:
            callback(Path(value))

    def test_structure_contract(self):
        self._with_temp(test_structure_groups_only_adjacent_sections_and_children_keep_context)

    def test_document_title_section_contract(self):
        self._with_temp(test_document_title_is_a_real_section_without_absorbing_preamble)

    def test_no_heading_fallback(self):
        self._with_temp(test_structure_without_heading_falls_back_to_large_recursive_parent)

    def test_long_children_keep_context_within_hard_limit(self):
        self._with_temp(test_long_children_reserve_full_section_context_before_splitting)

    def test_recursive_progress(self):
        test_recursive_split_uses_natural_boundaries_and_makes_progress()

    def test_replay_contract(self):
        self._with_temp(test_replay_is_deterministic)

    def test_regex_child_splits_and_page_metadata_failure_is_explicit(self):
        def run(path: Path):
            nodes = [{'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}]
            blocks = [{'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '第一段\n第二段\n第三段', 'source': {'page': 1}}]
            parents, children = _run(path, blocks, nodes, _config(parentStrategies=['RECURSIVE'], childStrategies=['REGEX'], regexPattern='\\n'))
            self.assertGreaterEqual(len(children), 2)
            with self.assertRaises(StageError) as error:
                _run(path / 'page', [{'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '无页码', 'source': {}}], nodes, _config(parentStrategies=['PAGE'], childStrategies=['RECURSIVE']))
            self.assertEqual(error.exception.code, 'CHUNK_PAGE_METADATA_REQUIRED')

        self._with_temp(run)

    def test_recommended_semantic_plan(self):
        self._with_temp(test_recommended_mode_persists_semantic_plan)

    def test_noise_only_blocks_do_not_reach_children(self):
        self._with_temp(test_noise_only_blocks_are_excluded_but_mixed_blocks_are_retained)
