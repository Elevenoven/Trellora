"""Small no-dependency acceptance check for the deterministic chunks v2 Worker stage."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from threading import Event

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'pipeline-python'))

from pipeline_worker.chunking_stage import run_chunking_stage  # noqa: E402
from pipeline_worker.chunking_strategies import recursive_split  # noqa: E402


CHECK_DIR = ROOT / 'pipeline-python' / '.chunking-v2-verification'


def write_jsonl(path: Path, values: list[dict]) -> None:
    path.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in values), encoding='utf-8')


def config(**patch: object) -> dict:
    value: dict[str, object] = {
        'schemaVersion': 2, 'mode': 'custom',
        'parentStrategies': ['STRUCTURE', 'RECURSIVE'], 'childStrategies': ['RECURSIVE'],
        'parentMinChars': 20, 'parentTargetChars': 80, 'parentMaxChars': 120, 'parentOverlapChars': 10,
        'childRecursiveMaxChars': 45, 'childRecursiveOverlapChars': 8,
        'semanticMaxChars': 45, 'semanticMinChars': 10, 'semanticSimilarityThreshold': 0.18,
        'pageMinMetadataCoverage': 0.8,
    }
    value.update(patch)
    return value


def run_case(name: str, blocks: list[dict], nodes: list[dict], settings: dict) -> tuple[list[dict], list[dict]]:
    base = CHECK_DIR / name
    parse_dir, tree_dir, output_dir = base / 'parse', base / 'tree', base / 'chunks'
    parse_dir.mkdir(parents=True, exist_ok=True)
    tree_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(parse_dir / 'blocks.jsonl', blocks)
    write_jsonl(tree_dir / 'structure.jsonl', nodes)
    run_chunking_stage(str(tree_dir), str(parse_dir / 'blocks.jsonl'), str(output_dir), 'doc-1', 'hash-1', settings, Event(), lambda *_: None, 'verify')
    parents = [json.loads(line) for line in (output_dir / 'parents.jsonl').read_text(encoding='utf-8').splitlines()]
    children = [json.loads(line) for line in (output_dir / 'children.jsonl').read_text(encoding='utf-8').splitlines()]
    compatibility_children = [json.loads(line) for line in (output_dir / 'chunks.jsonl').read_text(encoding='utf-8').splitlines()]
    assert compatibility_children == children, 'legacy chunks.jsonl 必须是完整 Child 投影'
    assert all(
        child['parentChunkId'] and child['text'] and child['sourceText']
        and isinstance(child['sectionContext'], str) and isinstance(child['sourceRefs'], list)
        for child in compatibility_children
    ), 'Child 兼容投影必须保留上下文检索文本、原文、章节和 Parent 回溯键'
    return parents, children


def main() -> None:
    if CHECK_DIR.exists():
        shutil.rmtree(CHECK_DIR)
    chapter_a = [{'nodeId': 'h-a', 'text': '第一章'}]
    chapter_b = [{'nodeId': 'h-b', 'text': '第二章'}]
    nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'h-a', 'type': 'HEADING', 'sectionPath': chapter_a, 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'a-body', 'type': 'BODY', 'sectionPath': chapter_a, 'sourceRefs': [{'blockId': 'b-2'}]},
        {'nodeId': 'h-b', 'type': 'HEADING', 'sectionPath': chapter_b, 'sourceRefs': [{'blockId': 'b-3'}]},
        {'nodeId': 'b-body', 'type': 'BODY', 'sectionPath': chapter_b, 'sourceRefs': [{'blockId': 'b-4'}]},
        {'nodeId': 'a-again', 'type': 'BODY', 'sectionPath': chapter_a, 'sourceRefs': [{'blockId': 'b-5'}]},
    ]
    blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': text, 'source': {'page': index}} for index, text in enumerate(['第一章', '甲内容。', '第二章', '乙内容。', '甲补充。'], 1)]
    parents, children = run_case('structure', blocks, nodes, config())
    assert len(parents) == 3 and len(children) >= 3
    assert [parent['sectionPath'][-1]['text'] for parent in parents] == ['第一章', '第二章', '第一章']
    assert all(child['parentChunkId'] for child in children)
    assert all(child['sectionContext'] and '章节：' in child['text'] for child in children[:2])
    assert all('章节：' not in child['sourceText'] for child in children[:2])

    no_heading_nodes = [{'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []}]
    long_blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': '无章节正文。' * 30, 'source': {}} for index in range(1, 3)]
    fallback_parents, fallback_children = run_case('fallback', long_blocks, no_heading_nodes, config(parentMinChars=10, parentTargetChars=20, parentMaxChars=30))
    assert fallback_parents and fallback_children
    assert all(parent['boundaryReason'] != 'STRUCTURE_SECTION' for parent in fallback_parents)
    assert all(len(child['text']) > 0 for child in fallback_children)
    fallback_report = json.loads((CHECK_DIR / 'fallback' / 'chunks' / 'chunks-report.json').read_text(encoding='utf-8'))
    assert fallback_report['fallbackReason'] == 'NO_VALID_HEADING'
    assert fallback_report['parentLimits'] == {'minChars': 1200, 'targetChars': 2400, 'maxChars': 3500, 'overlapChars': 10}

    semantic_blocks = [{'blockId': f'b-{index}', 'order': index, 'kind': 'paragraph', 'text': '这是一个有明确语义边界的段落。' * 10, 'source': {}} for index in range(1, 5)]
    run_case('semantic', semantic_blocks, no_heading_nodes, config(mode='recommended', parentStrategies=['RECURSIVE'], childStrategies=[], parentTargetChars=100, parentMaxChars=200, childRecursiveMaxChars=60, semanticMaxChars=60, semanticMinChars=20))
    semantic_plan = json.loads((CHECK_DIR / 'semantic' / 'chunks' / 'chunk-plan.json').read_text(encoding='utf-8'))
    assert semantic_plan['quality']['paragraphReady'] is True
    assert semantic_plan['effectiveChildStrategies'] == ['SEMANTIC', 'RECURSIVE']

    noise_nodes = [
        {'nodeId': 'n-root', 'parentId': None, 'type': 'DOCUMENT_ROOT', 'sectionPath': [], 'sourceRefs': []},
        {'nodeId': 'noise-page', 'type': 'NOISE', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-1'}]},
        {'nodeId': 'body', 'type': 'BODY', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-2'}]},
        {'nodeId': 'noise-mixed', 'type': 'NOISE', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-3'}]},
        {'nodeId': 'body-mixed', 'type': 'BODY', 'sectionPath': [], 'sourceRefs': [{'blockId': 'b-3'}]},
    ]
    noise_blocks = [
        {'blockId': 'b-1', 'order': 1, 'kind': 'paragraph', 'text': '第 2 页', 'source': {'page': 2}},
        {'blockId': 'b-2', 'order': 2, 'kind': 'paragraph', 'text': '有效正文。', 'source': {'page': 2}},
        {'blockId': 'b-3', 'order': 3, 'kind': 'paragraph', 'text': '混合块中的有效正文。', 'source': {'page': 2}},
    ]
    _noise_parents, noise_children = run_case('noise', noise_blocks, noise_nodes, config(parentStrategies=['RECURSIVE']))
    assert all('b-1' not in child['sourceBlockIds'] and '第 2 页' not in child['sourceText'] for child in noise_children)
    assert any('b-3' in child['sourceBlockIds'] for child in noise_children), '混合来源块不能被误删'
    noise_report = json.loads((CHECK_DIR / 'noise' / 'chunks' / 'chunks-report.json').read_text(encoding='utf-8'))
    assert noise_report['counts']['noiseBlocksSkipped'] == 1

    recursive = recursive_split('第一段。\n\n第二段。\n第三段。' * 30, 40, 8)
    assert recursive and all(0 < len(value) <= 40 for value in recursive)
    print(f'pipeline chunking v2 verification passed: {len(parents)} parents, {len(children)} children')
    shutil.rmtree(CHECK_DIR)


if __name__ == '__main__':
    main()
