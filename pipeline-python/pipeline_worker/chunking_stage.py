"""Parent/Child chunking coordinator for Worker chunks v2."""

from __future__ import annotations

import json
import os
import hashlib
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable

from .chunking_models import SourceBlock, clean_text, context_body_limit, dedupe_refs, render_context, section_key, section_title, validate_v2_config
from .chunking_quality import assess_quality, recommend_child_strategies
from .chunking_strategies import group_adjacent_structure, group_by_page, group_by_regex, join_blocks, recursive_split, regex_split, split_text
from .stage_errors import StageCancelled, StageError


CHUNKING_SCHEMA_VERSION = 2
CHECKPOINT_INTERVAL = 100
FALLBACK_PARENT_DEFAULTS = (1200, 2400, 3500)
LLM_WRAPPER_MAX_CHARS = 240
# This path is deliberately separate from the normal recursive strategy. The
# latter cleans and repacks natural units, while an LLM request must retain the
# exact canonical source text so its response can be checked byte-for-byte.
_LLM_INPUT_BOUNDARIES = (
    re.compile(r'\n\s*\n'),
    re.compile(r'\n'),
    re.compile(r'(?<=[。！？!?；;])\s+|(?<=[。！？!?；;])(?=[\u4e00-\u9fffA-Za-z])'),
)


def run_chunking_stage(
    tree_input_path: str,
    source_blocks_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any],
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
    llm_available: bool = False,
    llm_segments: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    config = validate_v2_config(config)
    tree_path = Path(tree_input_path) / 'structure.jsonl'
    blocks_path = Path(source_blocks_path)
    output = Path(output_dir)
    if not tree_path.is_file():
        raise StageError('CHUNKS_TREE_INPUT_NOT_FOUND', '结构树阶段缺少 structure.jsonl，无法切块。', False)
    if not blocks_path.is_file():
        raise StageError('CHUNKS_BLOCKS_INPUT_NOT_FOUND', '解析阶段缺少 blocks.jsonl，无法建立切块来源回溯。', False)
    output.mkdir(parents=True, exist_ok=True)
    blocks, valid_heading_count, quality_blocks, noise_blocks_skipped = _load_source_blocks(blocks_path, tree_path, cancel_event)
    if not blocks:
        raise StageError('CHUNKS_NO_SOURCE_BLOCKS', '解析产物没有可切块的有效文档块。', False)
    try:
        quality = assess_quality(quality_blocks)
        recommendation = recommend_child_strategies(config, quality, llm_available=llm_available)
        parents, plan = _build_parents(blocks, valid_heading_count, config, cancel_event, document_id)
        children = _build_children(parents, config, cancel_event, recommendation['strategies'], llm_segments)
        _annotate_overlaps(parents, 'parentId')
        _annotate_overlaps(children, 'chunkId')
        plan['requestedChildStrategies'] = list(config.get('childStrategies') or [])
        plan['effectiveChildStrategies'] = list(recommendation['strategies'])
        plan['recommendation'] = recommendation
        plan['quality'] = quality
        plan['noiseBlocksSkipped'] = noise_blocks_skipped
        _validate_outputs(parents, children, config)
        _write_jsonl(output / 'parents.jsonl', parents)
        _write_jsonl(output / 'children.jsonl', children)
        _write_jsonl(output / 'chunks.jsonl', children)
        report = {
            'schemaVersion': CHUNKING_SCHEMA_VERSION,
            'stage': 'chunks',
            'stageKey': stage_key,
            'documentId': document_id,
            'contentHash': content_hash,
            'counts': {
                'parents': len(parents),
                'children': len(children),
                'chunks': len(children),
                'sourceBlocks': len(blocks),
                'noiseBlocksSkipped': noise_blocks_skipped,
                'validHeadings': valid_heading_count,
            },
            'effectiveParentStrategies': plan['effectiveParentStrategies'],
            'effectiveChildStrategies': plan['effectiveChildStrategies'],
            'fallbackReason': plan.get('fallbackReason'),
            'parentLimits': plan['parentLimits'],
            'quality': quality,
            'recommendation': recommendation,
            'generatedAt': _now(),
        }
        _write_json(output / 'chunk-plan.json', {**plan, 'schemaVersion': CHUNKING_SCHEMA_VERSION, 'stageKey': stage_key})
        _write_json(output / 'chunks-report.json', report)
        _write_json(output / 'checkpoint.json', {'schemaVersion': CHUNKING_SCHEMA_VERSION, 'stageKey': stage_key, 'parents': len(parents), 'children': len(children), 'complete': True})
        progress(len(children), len(children), 'chunk', f'父子切块完成，共 {len(parents)} 个父块、{len(children)} 个子块。')
        return report['counts']
    except StageCancelled:
        raise
    except StageError:
        raise
    except ValueError as exc:
        message = str(exc)
        if message.startswith('PAGE_METADATA_COVERAGE:'):
            raise StageError('CHUNK_PAGE_METADATA_REQUIRED', '按页切块需要足够的页码元数据覆盖率。', False, message) from exc
        raise StageError('CHUNKS_CONFIG_EXECUTION_FAILED', f'切块配置执行失败：{message}', False) from exc
    except Exception as exc:
        raise StageError('CHUNKS_WRITE_FAILED', f'父子切块阶段写入失败：{exc}', True) from exc


def prepare_chunking_llm_stage(
    tree_input_path: str,
    source_blocks_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any],
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """Prepare bounded, no-overlap LLM requests without passing secrets to the Worker."""
    config = validate_v2_config(config)
    tree_path = Path(tree_input_path) / 'structure.jsonl'
    blocks_path = Path(source_blocks_path)
    output = Path(output_dir)
    if not tree_path.is_file() or not blocks_path.is_file():
        raise StageError('CHUNK_LLM_INPUT_NOT_FOUND', 'LLM 切块准备阶段缺少结构树或解析 blocks。', False)
    output.mkdir(parents=True, exist_ok=True)
    blocks, valid_heading_count, quality_blocks, noise_blocks_skipped = _load_source_blocks(blocks_path, tree_path, cancel_event)
    if not blocks:
        raise StageError('CHUNKS_NO_SOURCE_BLOCKS', '解析产物没有可切块的有效文档块。', False)
    quality = assess_quality(quality_blocks)
    recommendation = recommend_child_strategies(config, quality, llm_available=True)
    if 'LLM' not in recommendation['strategies']:
        # Recommended mode may find a document that is healthy enough for a
        # deterministic plan. Produce the final artifacts in this same temp dir.
        return run_chunking_stage(tree_input_path, source_blocks_path, output_dir, document_id, content_hash, config, cancel_event, progress, stage_key, llm_available=True)
    parents, plan = _build_parents(blocks, valid_heading_count, config, cancel_event, document_id)
    requests = _build_llm_requests(parents, int(config['llmMaxChars']))
    if not requests:
        raise StageError('CHUNK_LLM_PREPARE_FAILED', 'LLM 切块没有生成可执行请求。', False)
    digest = _request_digest(requests)
    _write_jsonl(output / 'chunk-llm-requests.jsonl', requests)
    _write_json(output / 'chunk-llm-state.json', {
        'schemaVersion': CHUNKING_SCHEMA_VERSION,
        'stageKey': stage_key,
        'documentId': document_id,
        'contentHash': content_hash,
        'requestsDigest': digest,
        'requestCount': len(requests),
        'noiseBlocksSkipped': noise_blocks_skipped,
        'effectiveChildStrategies': recommendation['strategies'],
        'quality': quality,
        'recommendation': recommendation,
        'parentPlan': plan,
    })
    progress(0, len(requests), 'llm-request', f'已准备 {len(requests)} 段模型切块请求。')
    return {'llmRequests': len(requests), 'needsLlmContinuation': 1, 'noiseBlocksSkipped': noise_blocks_skipped}


def finalize_chunking_llm_stage(
    tree_input_path: str,
    source_blocks_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any],
    responses: Any,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """Validate model arrays and write final chunks only after text conservation succeeds."""
    output = Path(output_dir)
    state_path = output / 'chunk-llm-state.json'
    if not state_path.is_file():
        raise StageError('CHUNK_LLM_STATE_MISSING', 'LLM 切块准备状态不存在，无法继续。', False)
    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise StageError('CHUNK_LLM_STATE_INVALID', 'LLM 切块准备状态无法读取。', False) from exc
    if state.get('stageKey') != stage_key or state.get('documentId') != document_id or state.get('contentHash') != content_hash:
        raise StageError('CHUNK_LLM_STATE_CONFLICT', 'LLM 切块准备状态与当前任务不一致。', False)
    requests_path = output / 'chunk-llm-requests.jsonl'
    requests = list(_iter_jsonl(requests_path)) if requests_path.is_file() else []
    if len(requests) != int(state.get('requestCount') or 0) or _request_digest(requests) != state.get('requestsDigest'):
        raise StageError('CHUNK_LLM_STATE_CONFLICT', 'LLM 切块请求已变化，拒绝继续执行。', False)
    segments = _validate_llm_responses(requests, responses)
    counts = run_chunking_stage(tree_input_path, source_blocks_path, output_dir, document_id, content_hash, config, cancel_event, progress, stage_key, llm_available=True, llm_segments=segments)
    requests_path.unlink(missing_ok=True)
    state_path.unlink(missing_ok=True)
    return counts


def _build_llm_requests(parents: list[dict[str, Any]], max_chars: int) -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = []
    for parent in parents:
        parent_id = str(parent['parentId'])
        source = str(parent['sourceText'])
        pieces = _split_llm_input(source, max_chars)
        if ''.join(pieces) != source:
            raise StageError('CHUNK_LLM_PREPARE_FAILED', '模型输入预切分未能完整保留清洗后的原文。', False)
        for index, source_text in enumerate(pieces, 1):
            if not source_text:
                continue
            request_id = f'{parent_id}-llm-{index:04d}'
            requests.append({
                'requestId': request_id,
                'parentChunkId': parent_id,
                'documentId': parent['documentId'],
                'text': source_text,
                'inputHash': _text_hash(source_text),
                'maxChars': max_chars,
            })
    return requests


def _split_llm_input(text: str, max_chars: int) -> list[str]:
    """Recursively bound an LLM request without overlap or text rewriting."""
    if len(text) <= max_chars:
        return [text] if text else []
    for pattern in _LLM_INPUT_BOUNDARIES:
        cuts = [match.end() for match in pattern.finditer(text) if 0 < match.end() <= max_chars]
        if cuts:
            cut = max(cuts)
            return [text[:cut], *_split_llm_input(text[cut:], max_chars)]
    # No natural boundary exists in the window. A fixed window is the only
    # remaining safe option and always advances by at least one character.
    return [text[:max_chars], *_split_llm_input(text[max_chars:], max_chars)]


def _validate_llm_responses(requests: list[dict[str, Any]], responses: Any) -> dict[str, list[str]]:
    if not isinstance(responses, list) or len(responses) != len(requests):
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应数量与切块请求不一致。', False)
    expected = {str(item.get('requestId')): item for item in requests}
    result: dict[str, list[str]] = {}
    seen: set[str] = set()
    for response in responses:
        if not isinstance(response, dict):
            raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应必须是对象数组。', False)
        request_id = str(response.get('requestId') or '')
        expected_request = expected.get(request_id)
        if not expected_request or request_id in seen or str(response.get('inputHash') or '') != str(expected_request.get('inputHash') or ''):
            raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应与原始切块请求不匹配。', False, request_id or None)
        raw = response.get('output')
        if not isinstance(raw, str):
            raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应必须是 JSON 字符串数组。', False, request_id)
        value = _parse_llm_array(raw, request_id)
        if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value):
            raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应必须是非空字符串数组。', False, request_id)
        source_text = str(expected_request.get('text') or '')
        if ''.join(value) != source_text:
            raise StageError('CHUNK_TEXT_CONSERVATION_FAILED', '模型切块结果改变或遗漏了原文，未提交任何产物。', False, request_id)
        result.setdefault(str(expected_request.get('parentChunkId') or ''), []).extend(value)
        seen.add(request_id)
    if len(seen) != len(expected):
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应不完整。', False)
    return result


def _parse_llm_array(raw: str, request_id: str) -> Any:
    """Allow a short prose wrapper, but reject Markdown and JSON objects."""
    value = raw.strip()
    if '```' in value:
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应不能使用 Markdown 代码围栏。', False, request_id)
    start, end = value.find('['), value.rfind(']')
    if start < 0 or end < start:
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应不是 JSON 字符串数组。', False, request_id)
    prefix, suffix = value[:start].strip(), value[end + 1:].strip()
    if len(prefix) > LLM_WRAPPER_MAX_CHARS or len(suffix) > LLM_WRAPPER_MAX_CHARS or any(marker in prefix + suffix for marker in ('{', '}', '|')):
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应外壳不符合 JSON 数组契约。', False, request_id)
    try:
        return json.loads(value[start:end + 1])
    except json.JSONDecodeError as exc:
        raise StageError('CHUNK_LLM_RESPONSE_INVALID', '模型响应不是 JSON 字符串数组。', False, request_id) from exc


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _request_digest(requests: list[dict[str, Any]]) -> str:
    canonical = json.dumps(requests, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    return _text_hash(canonical)


def _load_source_blocks(blocks_path: Path, tree_path: Path, cancel_event: Event) -> tuple[list[SourceBlock], int, list[SourceBlock], int]:
    nodes = list(_iter_jsonl(tree_path))
    section_ids = {
        str(node.get('nodeId'))
        for node in nodes
        if str(node.get('type')) in {'DOCUMENT_TITLE', 'HEADING'}
    }
    noise_only_block_ids = _noise_only_block_ids(nodes)
    block_sections: dict[str, tuple[list[dict[str, Any]], str]] = {}
    for node in nodes:
        path = node.get('sectionPath') if isinstance(node.get('sectionPath'), list) else []
        key = section_key(path)
        if not key:
            continue
        valid = any(str(item.get('nodeId')) in section_ids for item in path if isinstance(item, dict))
        if not valid:
            continue
        for reference in node.get('sourceRefs') if isinstance(node.get('sourceRefs'), list) else []:
            if isinstance(reference, dict) and reference.get('blockId'):
                block_sections[str(reference['blockId'])] = (list(path), key)
    blocks: list[SourceBlock] = []
    quality_blocks: list[SourceBlock] = []
    noise_blocks_skipped = 0
    with blocks_path.open('r', encoding='utf-8', errors='replace') as stream:
        for index, line in enumerate(stream, 1):
            if cancel_event.is_set():
                raise StageCancelled()
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            text = clean_text(value.get('text') or value.get('rawText'))
            if not text:
                continue
            block_id = str(value.get('blockId') or f'b-{index:06d}')
            path, key = block_sections.get(block_id, ([], ''))
            if section_ids and not path:
                path = [{'nodeId': 'n-preamble', 'path': '/preamble/', 'text': '文档前言'}]
                key = 'n-preamble'
            source = value.get('source') if isinstance(value.get('source'), dict) else {}
            refs = [dict(source, blockId=block_id)] if source else [{'blockId': block_id}]
            source_block = SourceBlock(
                block_id=block_id,
                text=text,
                order=int(value.get('order') or index),
                kind=str(value.get('kind') or 'paragraph'),
                page=int(source['page']) if isinstance(source.get('page'), int) else None,
                section_path=path,
                section_id=key,
                section_title=section_title(path),
                section_path_text=' > '.join(str(item.get('text') or '').strip() for item in path if isinstance(item, dict)),
                source_refs=refs,
            )
            # The structure tree remains the audit record for all logical
            # lines. Only discard a parser block when every mapped logical
            # line is NOISE; a mixed block could contain meaningful text.
            if block_id in noise_only_block_ids or source_block.kind.lower() == 'noise':
                noise_blocks_skipped += 1
                continue
            quality_blocks.append(source_block)
            if source_block.kind.lower() != 'page_break':
                blocks.append(source_block)
    blocks.sort(key=lambda block: (block.order, block.block_id))
    quality_blocks.sort(key=lambda block: (block.order, block.block_id))
    return blocks, len(section_ids), quality_blocks, noise_blocks_skipped


def _noise_only_block_ids(nodes: list[dict[str, Any]]) -> set[str]:
    """Return parser blocks whose mapped logical lines contain no usable text.

    Signals and the tree are line-oriented while v2 chunking is block-oriented.
    A block is safe to exclude only when all of its observed tree nodes are
    noise (or blanks). This avoids erasing a multi-line parser block that has
    both a page marker and a real paragraph.
    """
    types_by_block: dict[str, set[str]] = defaultdict(set)
    for node in nodes:
        node_type = str(node.get('type') or '')
        for reference in node.get('sourceRefs') if isinstance(node.get('sourceRefs'), list) else []:
            if isinstance(reference, dict) and reference.get('blockId'):
                types_by_block[str(reference['blockId'])].add(node_type)
    ignorable_types = {'NOISE', 'BLANK'}
    return {
        block_id
        for block_id, types in types_by_block.items()
        if 'NOISE' in types and types.issubset(ignorable_types)
    }


def _build_parents(blocks: list[SourceBlock], heading_count: int, config: dict[str, Any], cancel_event: Event, document_id: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    requested = list(config.get('parentStrategies') or ['STRUCTURE', 'RECURSIVE'])
    use_structure = requested and requested[0] == 'STRUCTURE'
    fallback_reason: str | None = None
    effective = list(requested)
    if use_structure and heading_count == 0:
        fallback_reason = 'NO_VALID_HEADING'
        effective = ['RECURSIVE'] + [code for code in requested[1:] if code != 'RECURSIVE']
    groups: list[list[SourceBlock]]
    if 'PAGE' in effective:
        groups = group_by_page(blocks, float(config['pageMinMetadataCoverage']))
    elif 'REGEX' in effective:
        groups = group_by_regex(blocks, str(config.get('regexPattern') or ''), list(config.get('regexFlags') or []), str(config.get('regexBoundary') or 'before')) if config.get('regexPattern') else [blocks]
    elif use_structure and heading_count > 0:
        groups = group_adjacent_structure(blocks)
    else:
        groups = [blocks]
    if fallback_reason:
        min_chars = max(int(config['parentMinChars']), FALLBACK_PARENT_DEFAULTS[0])
        target_chars = max(int(config['parentTargetChars']), FALLBACK_PARENT_DEFAULTS[1])
        max_chars = max(int(config['parentMaxChars']), FALLBACK_PARENT_DEFAULTS[2])
    else:
        min_chars, target_chars, max_chars = int(config['parentMinChars']), int(config['parentTargetChars']), int(config['parentMaxChars'])
    parents: list[dict[str, Any]] = []
    for group in groups:
        _raise_if_cancelled(cancel_event)
        if not group:
            continue
        body_max = context_body_limit(group[0].section_path, max_chars)
        body_target = min(target_chars, body_max)
        body_min = min(min_chars, body_max)
        parent_config = _with_parent_body_budget(config, body_max)
        if use_structure and heading_count > 0:
            segments = _split_group(group, body_max, min(int(config['parentOverlapChars']), body_max - 1))
        elif effective and effective[0] not in {'RECURSIVE', 'PAGE'}:
            strategy = effective[0]
            if strategy == 'LLM':
                raise StageError('CHUNK_LLM_UNAVAILABLE', '已选择 LLM 切块，但当前本地 Worker 没有可用模型。', False)
            source_text = join_blocks(group)
            pieces = _split_strategy(source_text, strategy, parent_config, True)
            pieces = _fit_parent_pieces(pieces, body_max, int(config['parentOverlapChars']))
            segments = [(piece, group, f'PARENT_{strategy}') for piece in pieces]
        else:
            segments = _window_group(group, body_target, body_max, body_min, min(int(config['parentOverlapChars']), body_max - 1))
        for segment_text, source_blocks, boundary in segments:
            parents.append(_parent_record(len(parents) + 1, segment_text, source_blocks, boundary, max_chars, document_id))
    # Apply additional deterministic parent text strategies after the structural seed.
    for strategy in effective[1:] if use_structure and heading_count > 0 else effective[1:] if effective and effective[0] == 'RECURSIVE' else []:
        if strategy in {'RECURSIVE', 'STRUCTURE'}:
            continue
        if strategy == 'LLM':
            raise StageError('CHUNK_LLM_UNAVAILABLE', '已选择 LLM 切块，但当前本地 Worker 没有可用模型。', False)
        expanded: list[dict[str, Any]] = []
        for parent in parents:
            body_max = context_body_limit(parent['_sectionPath'], max_chars)
            pieces = _split_strategy(parent['sourceText'], strategy, _with_parent_body_budget(config, body_max), True)
            pieces = _fit_parent_pieces(pieces, body_max, int(config['parentOverlapChars']))
            for piece in pieces:
                clone = dict(parent)
                clone['sourceText'] = piece
                clone['text'], clone['sectionContext'] = render_context(parent['_sectionPath'], piece, max_chars)
                clone['charCount'] = len(clone['text'])
                expanded.append(clone)
        parents = expanded
    return parents, {
        'requestedParentStrategies': requested,
        'effectiveParentStrategies': effective,
        'fallbackReason': fallback_reason,
        'parentLimits': {
            'minChars': min_chars,
            'targetChars': target_chars,
            'maxChars': max_chars,
            'overlapChars': int(config['parentOverlapChars']),
        },
    }


def _with_parent_body_budget(config: dict[str, Any], body_max: int) -> dict[str, Any]:
    next_config = dict(config)
    next_config['parentMaxChars'] = body_max
    next_config['parentTargetChars'] = min(int(config['parentTargetChars']), body_max)
    next_config['parentOverlapChars'] = min(int(config['parentOverlapChars']), body_max - 1)
    return next_config


def _with_child_body_budget(config: dict[str, Any], body_max: int) -> dict[str, Any]:
    next_config = dict(config)
    next_config['childRecursiveMaxChars'] = body_max
    next_config['childRecursiveOverlapChars'] = min(int(config['childRecursiveOverlapChars']), body_max - 1)
    next_config['semanticMaxChars'] = body_max
    next_config['childFixedMaxChars'] = body_max
    next_config['childFixedTargetChars'] = min(int(config['childFixedTargetChars']), body_max)
    next_config['childFixedMinChars'] = min(int(config['childFixedMinChars']), next_config['childFixedTargetChars'])
    next_config['childFixedOverlapChars'] = min(int(config['childFixedOverlapChars']), body_max - 1)
    return next_config


def _fit_parent_pieces(pieces: list[str], body_max: int, overlap_chars: int) -> list[str]:
    result: list[str] = []
    for piece in pieces:
        text = clean_text(piece)
        if not text:
            continue
        if len(text) <= body_max:
            result.append(text)
        else:
            result.extend(recursive_split(text, body_max, min(overlap_chars, body_max - 1)))
    return result


def _window_group(group: list[SourceBlock], target_chars: int, max_chars: int, min_chars: int, overlap_chars: int) -> list[tuple[str, list[SourceBlock], str]]:
    result: list[tuple[str, list[SourceBlock], str]] = []
    current: list[SourceBlock] = []
    for block in group:
        if len(block.text) > max_chars:
            if current:
                result.append((join_blocks(current), current, 'BLOCK_WINDOW_CLOSED_BEFORE_OVERSIZE'))
                current = []
            for piece in _split_strategy(block.text, 'RECURSIVE', {'parentMaxChars': max_chars, 'parentOverlapChars': overlap_chars}, True):
                result.append((piece, [block], 'OVERSIZE_BLOCK_RECURSIVE'))
            continue
        candidate = join_blocks(current + [block])
        if current and len(candidate) > max_chars:
            result.append((join_blocks(current), current, 'PARENT_MAX_REACHED'))
            current = [block]
        else:
            current.append(block)
    if current:
        if result and len(join_blocks(current)) < min_chars and len(result[-1][0]) + 2 + len(join_blocks(current)) <= max_chars:
            previous_text, previous_blocks, reason = result.pop()
            merged = previous_blocks + current
            result.append((join_blocks(merged), merged, 'SHORT_TAIL_MERGED'))
        else:
            result.append((join_blocks(current), current, 'FINAL_PARENT'))
    return result


def _split_group(group: list[SourceBlock], max_chars: int, overlap_chars: int) -> list[tuple[str, list[SourceBlock], str]]:
    text = join_blocks(group)
    if len(text) <= max_chars:
        return [(text, group, 'STRUCTURE_SECTION')]
    pieces = _split_strategy(text, 'RECURSIVE', {'parentMaxChars': max_chars, 'parentOverlapChars': overlap_chars}, True)
    return [(piece, group, 'STRUCTURE_SECTION_SPLIT') for piece in pieces]


def _build_children(
    parents: list[dict[str, Any]],
    config: dict[str, Any],
    cancel_event: Event,
    effective_strategies: list[str] | None = None,
    llm_segments: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    effective = list(effective_strategies or config.get('childStrategies') or ['RECURSIVE'])
    children: list[dict[str, Any]] = []
    for parent in parents:
        _raise_if_cancelled(cancel_event)
        strategy = effective[0]
        final_strategy = effective[-1]
        child_max = int(config['childFixedMaxChars']) if final_strategy == 'FIXED' else int(config['semanticMaxChars']) if final_strategy == 'SEMANTIC' else int(config['childRecursiveMaxChars'])
        body_max = context_body_limit(parent['_sectionPath'], child_max)
        pieces = _child_pieces(parent, effective, _with_child_body_budget(config, body_max), (llm_segments or {}).get(str(parent['parentId'])))
        pieces = _fit_child_pieces(pieces, body_max, int(config['childRecursiveOverlapChars']))
        valid = [(clean_text(text), source) for text, source in pieces if clean_text(text)]
        if not valid:
            valid = [(parent['sourceText'], _blocks_from_parent(parent))]
        for text, source in valid:
            child_id = f'c-{len(children) + 1:06d}'
            rendered, context = render_context(parent['_sectionPath'], text, child_max)
            children.append({
                'schemaVersion': CHUNKING_SCHEMA_VERSION,
                'chunkId': child_id,
                'childId': child_id,
                'parentChunkId': parent['parentId'],
                'documentId': parent['documentId'],
                'ordinal': len(children) + 1,
                'text': rendered,
                'sourceText': text,
                'charCount': len(rendered),
                'sectionPath': parent['sectionPath'],
                'sectionContext': context,
                'sourceBlockIds': [block.block_id for block in source] or parent['sourceBlockIds'],
                'sourceRefs': dedupe_refs(ref for block in source for ref in block.source_refs) or parent['sourceRefs'],
                'boundaryReason': f'CHILD_{strategy}',
                'overlapFromChunkId': None,
                'overlapChars': 0,
            })
        parent['_childCount'] = len(valid)
    for parent in parents:
        parent.pop('_childCount', None)
        parent.pop('_sectionPath', None)
    return children


def _fit_child_pieces(pieces: list[tuple[str, list[SourceBlock]]], body_max: int, overlap_chars: int) -> list[tuple[str, list[SourceBlock]]]:
    result: list[tuple[str, list[SourceBlock]]] = []
    for piece, source in pieces:
        text = clean_text(piece)
        if not text:
            continue
        if len(text) <= body_max:
            result.append((text, source))
        else:
            result.extend((value, source) for value in recursive_split(text, body_max, min(overlap_chars, body_max - 1)))
    return result


def _child_pieces(parent: dict[str, Any], strategies: list[str], config: dict[str, Any], llm_segments: list[str] | None = None) -> list[tuple[str, list[SourceBlock]]]:
    source_blocks = _blocks_from_parent(parent)
    if strategies == ['STRUCTURE']:
        max_child = int(config['childRecursiveMaxChars'])
        pieces: list[tuple[str, list[SourceBlock]]] = []
        for block in source_blocks:
            if len(block.text) <= max_child:
                pieces.append((block.text, [block]))
            else:
                pieces.extend((piece, [block]) for piece in _split_strategy(block.text, 'RECURSIVE', config, False))
        return pieces
    current: list[tuple[str, list[SourceBlock]]] = [(parent['sourceText'], source_blocks)]
    for strategy in strategies:
        if strategy == 'LLM':
            if not llm_segments:
                raise StageError('CHUNK_LLM_CONTINUATION_REQUIRED', 'LLM 切块需要先由主进程完成模型请求。', False)
            current = [(piece, source_blocks) for piece in llm_segments]
            continue
        if strategy == 'PAGE':
            current = [(join_blocks(group), group) for group in group_by_page(source_blocks, float(config['pageMinMetadataCoverage']))]
            continue
        next_values: list[tuple[str, list[SourceBlock]]] = []
        for text, refs in current:
            next_values.extend((piece, refs) for piece in _split_strategy(text, strategy, config, False))
        current = next_values
    return current


def _blocks_from_parent(parent: dict[str, Any]) -> list[SourceBlock]:
    values = parent.get('_sourceBlocks') or []
    return list(values)


def _parent_record(ordinal: int, source_text: str, source_blocks: list[SourceBlock], boundary: str, max_chars: int, document_id: str) -> dict[str, Any]:
    path = list(source_blocks[0].section_path) if source_blocks else []
    rendered, context = render_context(path, source_text, max_chars)
    return {
        'schemaVersion': CHUNKING_SCHEMA_VERSION,
        'parentId': f'p-{ordinal:06d}',
        'documentId': document_id,
        'ordinal': ordinal,
        'text': rendered,
        'sourceText': source_text,
        'charCount': len(rendered),
        'sectionPath': path,
        'sectionContext': context,
        'sourceBlockIds': [block.block_id for block in source_blocks],
        'sourceRefs': dedupe_refs(ref for block in source_blocks for ref in block.source_refs),
        'boundaryReason': boundary,
        'overlapFromChunkId': None,
        'overlapChars': 0,
        '_sectionPath': path,
        '_sourceBlocks': source_blocks,
    }


def _split_strategy(text: str, strategy: str, config: dict[str, Any], parent: bool) -> list[str]:
    if strategy == 'PAGE':
        return [clean_text(text)] if clean_text(text) else []
    if strategy == 'REGEX':
        return regex_split(text, str(config.get('regexPattern') or ''), list(config.get('regexFlags') or []), str(config.get('regexBoundary') or 'before'), bool(config.get('regexKeepDelimiter', True)))
    if strategy == 'LLM':
        raise StageError('CHUNK_LLM_UNAVAILABLE', '已选择 LLM 切块，但当前本地 Worker 没有可用模型。', False)
    return split_text(text, strategy, config, parent=parent)


def _validate_outputs(parents: list[dict[str, Any]], children: list[dict[str, Any]], config: dict[str, Any]) -> None:
    parent_ids = {str(parent['parentId']) for parent in parents}
    if len(parent_ids) != len(parents) or not parents:
        raise StageError('CHUNKS_INVARIANT_FAILED', 'Parent ID 不唯一或没有有效 Parent。', False)
    if any(str(child.get('parentChunkId')) not in parent_ids for child in children):
        raise StageError('CHUNKS_INVARIANT_FAILED', 'Child 引用了不存在的 Parent。', False)
    counts = defaultdict(int)
    for child in children:
        if not clean_text(child.get('text')):
            raise StageError('CHUNKS_INVARIANT_FAILED', 'Child 不能是空文本。', False)
        counts[str(child['parentChunkId'])] += 1
    if any(counts[parent_id] < 1 for parent_id in parent_ids):
        raise StageError('CHUNKS_INVARIANT_FAILED', '每个有效 Parent 至少需要一个 Child。', False)


def _annotate_overlaps(values: list[dict[str, Any]], id_field: str) -> None:
    previous: dict[str, Any] | None = None
    for value in values:
        value['overlapFromChunkId'] = None
        value['overlapChars'] = 0
        same_parent = previous is not None and (
            value.get('parentChunkId') == previous.get('parentChunkId')
            if id_field == 'chunkId'
            else value.get('sectionPath') == previous.get('sectionPath')
        )
        if same_parent:
            left = clean_text(previous.get('sourceText'))
            right = clean_text(value.get('sourceText'))
            limit = min(len(left), len(right))
            overlap = 0
            for size in range(limit, 0, -1):
                if left[-size:] == right[:size]:
                    overlap = size
                    break
            if overlap:
                value['overlapFromChunkId'] = previous.get(id_field)
                value['overlapChars'] = overlap
        previous = value


def _iter_jsonl(path: Path):
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                yield value


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    with path.open('w', encoding='utf-8', newline='\n') as stream:
        for value in values:
            output = {key: item for key, item in value.items() if not key.startswith('_')}
            stream.write(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _raise_if_cancelled(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise StageCancelled()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
