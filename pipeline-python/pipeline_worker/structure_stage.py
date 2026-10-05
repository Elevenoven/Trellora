from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable, Iterable

from .stage_errors import StageCancelled, StageError


TREE_SCHEMA_VERSION = 1
CHUNKS_SCHEMA_VERSION = 1
CHECKPOINT_INTERVAL = 200
DEFAULT_CHUNK_CONFIG = {
    'strategy': 'heading',
    'targetChars': 800,
    'overlapChars': 120,
    'minChars': 160,
    'maxChars': 1800,
}


def run_structure_tree_stage(
    input_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    source = Path(input_path) / 'ambiguity.jsonl'
    output = Path(output_dir)
    partial_path = output / 'structure.partial.jsonl'
    nodes_path = output / 'structure.jsonl'
    checkpoint_path = output / 'checkpoint.json'
    if not source.is_file():
        raise StageError('TREE_INPUT_NOT_FOUND', '歧义消解产物不存在，无法组装结构树。', False)
    output.mkdir(parents=True, exist_ok=True)

    checkpoint = _read_checkpoint(checkpoint_path, stage_key, 'tree')
    if checkpoint and partial_path.is_file():
        _truncate_bytes(partial_path, int(checkpoint.get('partialBytes', 0)))
        state = checkpoint.get('state') if isinstance(checkpoint.get('state'), dict) else _new_tree_state()
        resume_line = int(checkpoint.get('lastLineNo', 0))
        nodes_written = int(checkpoint.get('nodes', 0))
    else:
        state = _new_tree_state()
        resume_line = 0
        nodes_written = 0
        partial_path.unlink(missing_ok=True)
        _append_json_line(partial_path, _root_node(document_id, content_hash))
        nodes_written = 1

    total_signals = _read_report_count(Path(input_path) / 'ambiguity-report.json', 'signals')
    stats: Counter[str] = Counter(checkpoint.get('stats', {}) if checkpoint else {})
    batch_number = int(checkpoint.get('batches', 0)) if checkpoint else 0

    try:
        with partial_path.open('ab') as destination:
            for batch in _iter_jsonl(source):
                _raise_if_cancelled(cancel_event)
                last_line = int(batch.get('lastLineNo') or 0)
                if last_line <= resume_line:
                    continue
                pending_nodes: list[dict[str, Any]] = []
                document_title = batch.get('documentTitle')
                if not state['initialized']:
                    if isinstance(document_title, dict) and str(document_title.get('normalizedText') or document_title.get('rawText') or '').strip():
                        title = _make_title_node(document_title, document_id, content_hash)
                        pending_nodes.append(title)
                        state['documentTitle'] = _make_ref(title, title['sectionPath'])
                        # documentTitle itself is synthetic at line 0; the
                        # signal stage keeps its logical source line here even
                        # when parser provenance points to another raw line.
                        title_source = document_title.get('source') if isinstance(document_title.get('source'), dict) else {}
                        state['documentTitleLineNo'] = int(title_source.get('derivedFromLineNo') or 0)
                        state['sectionOffset'] = 1
                        stats['documentTitles'] += 1
                    state['initialized'] = True

                signals = batch.get('signals') if isinstance(batch.get('signals'), list) else []
                for signal in signals:
                    _raise_if_cancelled(cancel_event)
                    if not isinstance(signal, dict):
                        continue
                    line_no = int(signal.get('lineNo') or 0)
                    title_line_no = int(state.get('documentTitleLineNo') or 0)
                    if title_line_no > 0 and line_no == title_line_no and isinstance(state.get('documentTitle'), dict):
                        # The selected source heading is already represented by
                        # DOCUMENT_TITLE. Activate it at its original position
                        # without emitting the same heading a second time.
                        state['currentSection'] = state['documentTitle']
                        state['currentListItem'] = None
                        state['listStack'] = []
                        state['previousLineNo'] = line_no
                        state['previousType'] = 'DOCUMENT_TITLE'
                        continue
                    node = _build_tree_node(signal, state, document_id, content_hash)
                    pending_nodes.append(node)
                    stats[str(node['type'])] += 1
                    stats['maxDepth'] = max(stats.get('maxDepth', 0), int(node['depth']))

                for node in pending_nodes:
                    destination.write((json.dumps(node, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
                nodes_written += len(pending_nodes)
                batch_number += 1
                destination.flush()
                _write_checkpoint(
                    checkpoint_path,
                    {
                        'schemaVersion': TREE_SCHEMA_VERSION,
                        'stage': 'tree',
                        'stageKey': stage_key,
                        'lastLineNo': last_line,
                        'nodes': nodes_written,
                        'batches': batch_number,
                        'partialBytes': destination.tell(),
                        'state': state,
                        'stats': dict(stats),
                        'complete': False,
                        'updatedAt': _now(),
                    },
                )
                progress(last_line, total_signals or None, 'node', f'结构树已处理至第 {last_line} 行。')
                resume_line = last_line

            destination.flush()
            os.fsync(destination.fileno())
        _raise_if_cancelled(cancel_event)
        counts = _finalize_tree(partial_path, nodes_path, output, stage_key, document_id, content_hash, stats)
        partial_path.unlink(missing_ok=True)
        _write_checkpoint(
            checkpoint_path,
            {
                'schemaVersion': TREE_SCHEMA_VERSION,
                'stage': 'tree',
                'stageKey': stage_key,
                'lastLineNo': resume_line,
                'nodes': counts['nodes'],
                'batches': batch_number,
                'partialBytes': 0,
                'state': state,
                'stats': dict(stats),
                'complete': True,
                'updatedAt': _now(),
            },
        )
        progress(total_signals or resume_line, total_signals or resume_line, 'node', f'结构树完成，共 {counts["nodes"]} 个节点。')
        return counts
    except StageCancelled:
        raise
    except StageError:
        raise
    except Exception as exc:
        raise StageError('TREE_WRITE_FAILED', f'结构树阶段写入失败：{exc}', True) from exc


def run_structure_chunks_stage(
    input_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any] | None,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    source = Path(input_path) / 'structure.jsonl'
    output = Path(output_dir)
    chunks_path = output / 'chunks.jsonl'
    checkpoint_path = output / 'checkpoint.json'
    if not source.is_file():
        raise StageError('CHUNKS_INPUT_NOT_FOUND', '结构树产物不存在，无法生成结构感知切块。', False)
    output.mkdir(parents=True, exist_ok=True)
    normalized_config = _normalize_chunk_config(config)
    checkpoint = _read_checkpoint(checkpoint_path, stage_key, 'chunks')
    if checkpoint and chunks_path.is_file():
        _truncate_bytes(chunks_path, int(checkpoint.get('outputBytes', 0)))
        builder = checkpoint.get('builder') if isinstance(checkpoint.get('builder'), dict) else _new_builder(normalized_config['maxChars'])
        resume_line = int(checkpoint.get('lastLineNo', 0))
        ordinal = int(checkpoint.get('chunks', 0))
        records = int(checkpoint.get('records', 0))
    else:
        chunks_path.unlink(missing_ok=True)
        builder = _new_builder(normalized_config['maxChars'])
        resume_line = 0
        ordinal = 0
        records = 0

    total_nodes = _count_jsonl(source)
    stats: Counter[str] = Counter(checkpoint.get('stats', {}) if checkpoint else {})
    try:
        with chunks_path.open('ab') as destination:
            for node in _iter_jsonl(source):
                _raise_if_cancelled(cancel_event)
                line_no = int(node.get('lastLineNo') or node.get('firstLineNo') or 0)
                if line_no <= resume_line:
                    continue
                records += 1
                node_type = str(node.get('type') or 'BODY')
                text = str(node.get('text') or '').strip()
                if node_type == 'DOCUMENT_ROOT':
                    pass
                elif node_type == 'NOISE':
                    stats['noiseSkipped'] += 1
                elif node_type == 'BLANK':
                    if _builder_has_content(builder):
                        ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'blank-boundary')
                        stats['chunks'] += 1
                        builder = _next_builder(builder, normalized_config, False)
                    else:
                        builder['prefixText'] = ''
                elif node_type == 'SEPARATOR':
                    if _builder_has_content(builder):
                        ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'separator-boundary')
                        stats['chunks'] += 1
                        builder = _next_builder(builder, normalized_config, False)
                    else:
                        builder['prefixText'] = ''
                elif text:
                    if node_type == 'HEADING':
                        if _builder_has_body(builder):
                            ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'heading-boundary')
                            stats['chunks'] += 1
                            builder = _next_builder(builder, normalized_config, False)
                        builder = _append_node(builder, node, text, normalized_config)
                    elif node_type == 'BODY' and len(text) > normalized_config['maxChars']:
                        if _builder_has_body(builder):
                            ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'body-hard-limit')
                            stats['chunks'] += 1
                            builder = _next_builder(builder, normalized_config, False)
                        else:
                            builder['prefixText'] = ''
                            builder['prefixFromChunkId'] = None
                            builder['prefixChars'] = 0
                        pieces = _split_text(text, normalized_config['maxChars'])
                        for index, piece in enumerate(pieces):
                            piece_node = dict(node)
                            piece_node['text'] = piece
                            builder = _append_node(builder, piece_node, piece, normalized_config)
                            if index < len(pieces) - 1:
                                ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'body-hard-limit')
                                stats['chunks'] += 1
                                builder = _next_builder(builder, normalized_config, False)
                    else:
                        if _would_exceed(builder, text, normalized_config['maxChars']) and _builder_has_body(builder):
                            ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'max-boundary')
                            stats['chunks'] += 1
                            builder = _next_builder(builder, normalized_config, True)
                        elif _would_exceed(builder, text, normalized_config['maxChars']):
                            builder['prefixText'] = ''
                            builder['prefixFromChunkId'] = None
                            builder['prefixChars'] = 0
                        elif _should_close_fixed(builder, normalized_config, node_type):
                            ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'target-boundary')
                            stats['chunks'] += 1
                            builder = _next_builder(builder, normalized_config, True)
                        builder = _append_node(builder, node, text, normalized_config)

                resume_line = line_no
                if records % CHECKPOINT_INTERVAL == 0:
                    destination.flush()
                    _write_checkpoint(
                        checkpoint_path,
                        {
                            'schemaVersion': CHUNKS_SCHEMA_VERSION,
                            'stage': 'chunks',
                            'stageKey': stage_key,
                            'lastLineNo': resume_line,
                            'records': records,
                            'chunks': ordinal,
                            'outputBytes': destination.tell(),
                            'builder': builder,
                            'stats': dict(stats),
                            'complete': False,
                            'updatedAt': _now(),
                        },
                    )
                    progress(records, total_nodes or None, 'chunk', f'结构切块已处理 {records} 个树节点。')

            if _builder_has_content(builder):
                ordinal = _emit_chunk(destination, builder, ordinal, document_id, content_hash, 'end-of-document')
                stats['chunks'] += 1
                builder = _next_builder(builder, normalized_config, False)
            destination.flush()
            os.fsync(destination.fileno())
        _raise_if_cancelled(cancel_event)
        counts = {
            'nodes': records,
            'chunks': ordinal,
            'maxChunkChars': _max_chunk_chars(chunks_path),
            'targetChars': normalized_config['targetChars'],
            'overlapChars': normalized_config['overlapChars'],
            'maxChars': normalized_config['maxChars'],
            'oversizeChunks': _count_oversize(chunks_path, normalized_config['maxChars']),
            'noiseSkipped': stats.get('noiseSkipped', 0),
        }
        report = {
            'schemaVersion': CHUNKS_SCHEMA_VERSION,
            'stage': 'chunks',
            'stageKey': stage_key,
            'config': normalized_config,
            'counts': counts,
            'generatedAt': _now(),
        }
        _write_json(output / 'chunks-report.json', report)
        _write_checkpoint(
            checkpoint_path,
            {
                'schemaVersion': CHUNKS_SCHEMA_VERSION,
                'stage': 'chunks',
                'stageKey': stage_key,
                'lastLineNo': resume_line,
                'records': records,
                'chunks': ordinal,
                'outputBytes': chunks_path.stat().st_size,
                'builder': builder,
                'stats': dict(stats),
                'complete': True,
                'updatedAt': _now(),
            },
        )
        progress(total_nodes or records, total_nodes or records, 'chunk', f'结构切块完成，共 {ordinal} 个 chunk。')
        return counts
    except StageCancelled:
        raise
    except Exception as exc:
        raise StageError('CHUNKS_WRITE_FAILED', f'结构切块阶段写入失败：{exc}', True) from exc


def _new_tree_state() -> dict[str, Any]:
    return {
        'initialized': False,
        'sectionOffset': 0,
        'documentTitle': None,
        'documentTitleLineNo': 0,
        'currentSection': _root_ref(),
        'currentListItem': None,
        'listStack': [],
        'latestHeadingByDepth': {},
        'latestHeadingByNumericPath': {},
        'previousLineNo': 0,
        'previousType': '',
    }


def _root_node(document_id: str, content_hash: str) -> dict[str, Any]:
    return {
        'schemaVersion': TREE_SCHEMA_VERSION,
        'nodeId': 'n-root',
        'parentId': None,
        'type': 'DOCUMENT_ROOT',
        'text': document_id,
        'depth': 0,
        'path': '/',
        'firstLineNo': 0,
        'lastLineNo': 0,
        'sourceRefs': [{'documentId': document_id, 'contentHash': content_hash, 'synthetic': True}],
        'sectionPath': [],
        'childCount': 0,
    }


def _make_title_node(signal: dict[str, Any], document_id: str, content_hash: str) -> dict[str, Any]:
    text = str(signal.get('normalizedText') or signal.get('rawText') or '').strip()
    signal_source = dict(signal.get('source')) if isinstance(signal.get('source'), dict) else {}
    source_ref = {
        'documentId': document_id,
        'contentHash': content_hash,
        **signal_source,
        'synthetic': True,
        'signalId': signal.get('signalId', 's-title'),
    }
    return {
        'schemaVersion': TREE_SCHEMA_VERSION,
        'nodeId': 'n-title',
        'parentId': 'n-root',
        'type': 'DOCUMENT_TITLE',
        'text': text,
        'depth': 1,
        'path': '/0/',
        'firstLineNo': 0,
        'lastLineNo': 0,
        'sourceRefs': [source_ref],
        'sectionPath': [{'nodeId': 'n-title', 'path': '/0/', 'text': text}],
        'signalId': signal.get('signalId', 's-title'),
        'childCount': 0,
    }


def _build_tree_node(signal: dict[str, Any], state: dict[str, Any], document_id: str, content_hash: str) -> dict[str, Any]:
    signal_id = str(signal.get('signalId') or f"s-{int(signal.get('lineNo') or 0):06d}")
    line_no = int(signal.get('lineNo') or 0)
    signal_type = str(signal.get('type') or 'BODY')
    text = str(signal.get('normalizedText') or signal.get('rawText') or '').strip()
    root = _root_ref()
    parent = state.get('currentSection') if isinstance(state.get('currentSection'), dict) else root
    section_path = list(parent.get('sectionPath') or [])
    extra: dict[str, Any] = {}

    if signal_type == 'HEADING':
        level, numeric_path = _heading_info(text, str(signal.get('ruleId') or ''))
        text = _clean_heading_text(text)
        parent = _heading_parent(state, level, numeric_path, root)
        section_path = list(parent.get('sectionPath') or [])
        extra['headingLevel'] = level
        if numeric_path:
            extra['numericPath'] = numeric_path
    elif signal_type == 'LIST_ITEM':
        indent = _list_indent(str(signal.get('rawText') or text))
        while state['listStack'] and int(state['listStack'][-1].get('indent', 0)) >= indent:
            state['listStack'].pop()
        parent = state['listStack'][-1]['ref'] if state['listStack'] else parent
        section_path = list(parent.get('sectionPath') or [])
        extra['indent'] = indent
    elif signal_type in {'BLANK', 'SEPARATOR'}:
        state['currentListItem'] = None
        state['listStack'] = []
        parent = state.get('currentSection') if isinstance(state.get('currentSection'), dict) else root
        section_path = list(parent.get('sectionPath') or [])
    elif signal_type == 'NOISE':
        parent = root
        section_path = []
    elif signal_type == 'BODY' and state.get('currentListItem') and _is_consecutive(state, line_no):
        parent = state['currentListItem']
        section_path = list(parent.get('sectionPath') or [])
    elif signal_type in {'TABLE_ROW', 'QUOTE', 'STEP_ITEM', 'HEADING_CANDIDATE'}:
        parent = state.get('currentSection') if isinstance(state.get('currentSection'), dict) else root
        section_path = list(parent.get('sectionPath') or [])

    node_id = f'n-{signal_id}'
    path = _child_path(str(parent.get('path') or '/'), line_no, node_id)
    depth = int(parent.get('depth', 0)) + 1
    if signal_type == 'HEADING':
        ref = _make_ref({'nodeId': node_id, 'path': path, 'depth': depth, 'type': signal_type}, section_path + [{'nodeId': node_id, 'path': path, 'text': text}])
        state['currentSection'] = ref
        state['currentListItem'] = None
        state['listStack'] = []
        level = int(extra.get('headingLevel', 1))
        state['latestHeadingByDepth'] = {key: value for key, value in state['latestHeadingByDepth'].items() if int(key) < level}
        state['latestHeadingByDepth'][str(level)] = ref
        numeric_path = extra.get('numericPath')
        if numeric_path:
            state['latestHeadingByNumericPath'][numeric_path] = ref
            prefix = numeric_path + '.'
            state['latestHeadingByNumericPath'] = {key: value for key, value in state['latestHeadingByNumericPath'].items() if key == numeric_path or not key.startswith(prefix)}
        section_path = list(ref.get('sectionPath') or [])
    else:
        ref = _make_ref({'nodeId': node_id, 'path': path, 'depth': depth, 'type': signal_type}, section_path)
        if signal_type == 'LIST_ITEM':
            state['listStack'].append({'indent': int(extra.get('indent', 0)), 'ref': ref})
            state['currentListItem'] = ref
        elif signal_type not in {'BODY'}:
            state['currentListItem'] = None

    source_refs = signal.get('source') if isinstance(signal.get('source'), dict) else {}
    if not source_refs:
        source_refs = {'lineNo': line_no, 'signalId': signal_id}
    node = {
        'schemaVersion': TREE_SCHEMA_VERSION,
        'nodeId': node_id,
        'parentId': parent.get('nodeId'),
        'type': signal_type,
        'text': text,
        'depth': depth,
        'path': path,
        'firstLineNo': line_no,
        'lastLineNo': line_no,
        'sourceRefs': [source_refs],
        'sectionPath': section_path,
        'signalId': signal_id,
        'confidence': signal.get('confidence'),
        'ruleId': signal.get('ruleId'),
        'childCount': 0,
        **extra,
    }
    state['previousLineNo'] = line_no
    state['previousType'] = signal_type
    return node


def _heading_parent(state: dict[str, Any], level: int, numeric_path: str | None, root: dict[str, Any]) -> dict[str, Any]:
    if numeric_path and '.' in numeric_path:
        numeric_parent = state['latestHeadingByNumericPath'].get(numeric_path.rsplit('.', 1)[0])
        if isinstance(numeric_parent, dict):
            return numeric_parent
    if level > 1:
        # A same-level heading is a sibling, never a child of the current
        # heading. When an author skips a Markdown level, attach to the nearest
        # preceding lower level instead of growing an artificial deep chain.
        for parent_level in range(level - 1, 0, -1):
            depth_parent = state['latestHeadingByDepth'].get(str(parent_level))
            if isinstance(depth_parent, dict):
                return depth_parent
    if level <= 1:
        title = state.get('documentTitle')
        if isinstance(title, dict):
            return title
        return root
    title = state.get('documentTitle')
    if isinstance(title, dict):
        return title
    return root


def _make_ref(node: dict[str, Any], section_path: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        'nodeId': node['nodeId'],
        'path': node['path'],
        'depth': int(node['depth']),
        'type': node.get('type', ''),
        'sectionPath': list(section_path),
    }


def _root_ref() -> dict[str, Any]:
    return {'nodeId': 'n-root', 'path': '/', 'depth': 0, 'type': 'DOCUMENT_ROOT', 'sectionPath': []}


def _child_path(parent_path: str, line_no: int, node_id: str) -> str:
    base = parent_path if parent_path.endswith('/') else f'{parent_path}/'
    return f'{base}{line_no}-{node_id[2:]}/'


def _heading_info(text: str, rule_id: str) -> tuple[int, str | None]:
    markdown = re.match(r'^\s*(#{1,6})\s+', text)
    if markdown:
        return len(markdown.group(1)), None
    numeric = re.match(r'^\s*(\d+(?:\.\d+)*)[.)、]?\s+', text)
    if numeric:
        value = numeric.group(1)
        return value.count('.') + 1, value
    if rule_id == 'appendix' or rule_id == 'cn-chapter' or rule_id == 'cn-outline':
        return 1, None
    return 1, None


def _clean_heading_text(text: str) -> str:
    value = re.sub(r'^\s*#{1,6}\s+', '', text).strip()
    wrappers = ('**', '__', '~~', '`')
    changed = True
    while changed:
        changed = False
        for wrapper in wrappers:
            if value.startswith(wrapper) and value.endswith(wrapper) and len(value) > len(wrapper) * 2:
                value = value[len(wrapper):-len(wrapper)].strip()
                changed = True
                break
    return value


def _list_indent(text: str) -> int:
    match = re.match(r'^(\s*)', text)
    prefix = match.group(1) if match else ''
    return len(prefix.expandtabs(4))


def _is_consecutive(state: dict[str, Any], line_no: int) -> bool:
    return int(state.get('previousLineNo', 0)) + 1 == line_no and state.get('previousType') not in {'BLANK', 'NOISE', 'SEPARATOR'}


def _finalize_tree(partial_path: Path, nodes_path: Path, output: Path, stage_key: str, document_id: str, content_hash: str, stats: Counter[str]) -> dict[str, int]:
    child_counts: Counter[str] = Counter()
    counts: Counter[str] = Counter()
    parent_map: dict[str, str | None] = {}
    path_map: dict[str, str] = {}
    signal_ids: set[str] = set()
    root_count = 0
    max_depth = 0
    previous_line = -1
    for node in _iter_jsonl(partial_path):
        node_id = str(node.get('nodeId') or '')
        if not node_id or node_id in parent_map:
            raise StageError('TREE_VALIDATION_FAILED', '结构树包含重复或缺失 nodeId。', False)
        first_line = int(node.get('firstLineNo') or 0)
        last_line = int(node.get('lastLineNo') or first_line)
        if first_line > last_line or first_line < previous_line:
            raise StageError('TREE_VALIDATION_FAILED', '结构树行号不是单调可回溯序列。', False)
        previous_line = last_line
        parent_id = str(node.get('parentId')) if node.get('parentId') is not None else None
        parent_map[node_id] = parent_id
        path_map[node_id] = str(node.get('path') or '')
        signal_id = node.get('signalId')
        if signal_id is not None:
            signal_value = str(signal_id)
            if signal_value in signal_ids:
                raise StageError('TREE_VALIDATION_FAILED', '结构树包含重复 signalId，无法保证来源回溯。', False)
            signal_ids.add(signal_value)
        parent_id = node.get('parentId')
        if parent_id:
            child_counts[str(parent_id)] += 1
        counts['nodes'] += 1
        counts[str(node.get('type') or 'BODY')] += 1
        max_depth = max(max_depth, int(node.get('depth') or 0))
        if parent_id is None:
            root_count += 1
    if root_count != 1 or 'n-root' not in parent_map or parent_map['n-root'] is not None:
        raise StageError('TREE_VALIDATION_FAILED', '结构树必须包含且只能包含一个根节点。', False)
    for node_id, parent_id in parent_map.items():
        if parent_id is not None:
            if parent_id not in parent_map:
                raise StageError('TREE_VALIDATION_FAILED', f'结构树节点 {node_id} 的父节点不存在。', False)
            parent_path = path_map[parent_id]
            if not str(path_map[node_id]).startswith(parent_path if parent_path.endswith('/') else f'{parent_path}/'):
                raise StageError('TREE_VALIDATION_FAILED', f'结构树节点 {node_id} 的 path 与父节点不一致。', False)
        visited: set[str] = set()
        current: str | None = node_id
        while current is not None:
            if current in visited:
                raise StageError('TREE_VALIDATION_FAILED', f'结构树检测到环：{node_id}。', False)
            visited.add(current)
            current = parent_map.get(current)
    temporary = nodes_path.with_name('.structure.jsonl.tmp')
    with temporary.open('wb') as destination:
        for node in _iter_jsonl(partial_path):
            node['childCount'] = child_counts.get(str(node.get('nodeId')), 0)
            destination.write((json.dumps(node, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
        destination.flush()
        os.fsync(destination.fileno())
    temporary.replace(nodes_path)
    report_counts = {
        'nodes': counts['nodes'],
        'signals': counts['nodes'] - counts.get('DOCUMENT_ROOT', 0) - counts.get('DOCUMENT_TITLE', 0),
        'headings': counts.get('HEADING', 0),
        'headingCandidates': counts.get('HEADING_CANDIDATE', 0),
        'listItems': counts.get('LIST_ITEM', 0),
        'tableRows': counts.get('TABLE_ROW', 0),
        'bodyNodes': counts.get('BODY', 0),
        'noiseNodes': counts.get('NOISE', 0),
        'maxDepth': max_depth,
        'rootNodes': root_count,
    }
    summary = {
        'schemaVersion': TREE_SCHEMA_VERSION,
        'stage': 'tree',
        'stageKey': stage_key,
        'documentId': document_id,
        'contentHash': content_hash,
        'rootNodeId': 'n-root',
        'counts': report_counts,
        'generatedAt': _now(),
    }
    _write_json(output / 'structure.json', summary)
    _write_json(output / 'tree-report.json', summary)
    return report_counts


def _new_builder(max_chars: int = DEFAULT_CHUNK_CONFIG['maxChars']) -> dict[str, Any]:
    return {
        'parts': [],
        'nodeIds': [],
        'sourceRefs': [],
        'firstLineNo': None,
        'lastLineNo': None,
        'sectionPath': [],
        'typeCounts': {},
        'prefixText': '',
        'prefixFromChunkId': None,
        'prefixChars': 0,
        'hasBody': False,
        'maxChars': max_chars,
    }


def _next_builder(previous: dict[str, Any], config: dict[str, Any], allow_overlap: bool) -> dict[str, Any]:
    builder = _new_builder(config['maxChars'])
    if allow_overlap and config['overlapChars'] > 0 and previous.get('hasBody'):
        tail = _builder_text(previous)[-config['overlapChars']:]
        if tail:
            builder['prefixText'] = tail
            builder['prefixFromChunkId'] = previous.get('_emittedChunkId')
            builder['prefixChars'] = len(tail)
    return builder


def _normalize_chunk_config(value: dict[str, Any] | None) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    strategy = str(source.get('strategy') or DEFAULT_CHUNK_CONFIG['strategy'])
    if strategy not in {'heading', 'fixed'}:
        strategy = 'heading'
    target = _bounded_int(source.get('targetChars'), DEFAULT_CHUNK_CONFIG['targetChars'], 200, 4000)
    overlap = _bounded_int(source.get('overlapChars'), DEFAULT_CHUNK_CONFIG['overlapChars'], 0, 1000)
    minimum = _bounded_int(source.get('minChars'), DEFAULT_CHUNK_CONFIG['minChars'], 0, target)
    maximum = _bounded_int(source.get('maxChars'), DEFAULT_CHUNK_CONFIG['maxChars'], target, 8000)
    return {'strategy': strategy, 'targetChars': target, 'overlapChars': min(overlap, max(0, maximum - 1)), 'minChars': minimum, 'maxChars': maximum}


def _bounded_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def _append_node(builder: dict[str, Any], node: dict[str, Any], text: str, config: dict[str, Any]) -> dict[str, Any]:
    if builder['firstLineNo'] is None:
        builder['firstLineNo'] = int(node.get('firstLineNo') or 0)
        builder['sectionPath'] = list(node.get('sectionPath') or [])
    builder['lastLineNo'] = int(node.get('lastLineNo') or node.get('firstLineNo') or 0)
    if builder['parts']:
        builder['parts'].append('\n')
    builder['parts'].append(text)
    node_id = str(node.get('nodeId') or '')
    if node_id and node_id not in builder['nodeIds']:
        builder['nodeIds'].append(node_id)
    for source_ref in node.get('sourceRefs') if isinstance(node.get('sourceRefs'), list) else []:
        if source_ref not in builder['sourceRefs']:
            builder['sourceRefs'].append(source_ref)
    node_type = str(node.get('type') or 'BODY')
    type_counts = builder['typeCounts']
    type_counts[node_type] = int(type_counts.get(node_type, 0)) + 1
    if node_type != 'DOCUMENT_TITLE':
        builder['hasBody'] = True
    return builder


def _builder_text(builder: dict[str, Any]) -> str:
    prefix = str(builder.get('prefixText') or '')
    body = ''.join(str(part) for part in builder.get('parts', []))
    if prefix and body:
        return f'{prefix}\n{body}'
    return prefix or body


def _builder_has_content(builder: dict[str, Any]) -> bool:
    return bool(_builder_text(builder).strip())


def _builder_has_body(builder: dict[str, Any]) -> bool:
    return bool(builder.get('hasBody'))


def _would_exceed(builder: dict[str, Any], text: str, maximum: int) -> bool:
    current = len(_builder_text(builder))
    return current > 0 and current + 1 + len(text) > maximum


def _should_close_fixed(builder: dict[str, Any], config: dict[str, Any], node_type: str) -> bool:
    if not _builder_has_body(builder) or node_type in {'HEADING', 'LIST_ITEM', 'TABLE_ROW'}:
        return False
    if config['strategy'] == 'heading':
        return False
    return len(_builder_text(builder)) >= config['targetChars'] and len(_builder_text(builder)) >= config['minChars']


def _emit_chunk(destination: Any, builder: dict[str, Any], ordinal: int, document_id: str, content_hash: str, reason: str) -> int:
    text = _builder_text(builder).strip()
    if not text:
        return ordinal
    ordinal += 1
    first_line = int(builder.get('firstLineNo') or 0)
    last_line = int(builder.get('lastLineNo') or first_line)
    digest = hashlib.sha256(f'{content_hash}:{first_line}:{last_line}:{ordinal}:{text}'.encode('utf-8')).hexdigest()[:20]
    chunk_id = f'c-{digest}'
    chunk = {
        'schemaVersion': CHUNKS_SCHEMA_VERSION,
        'chunkId': chunk_id,
        'documentId': document_id,
        'ordinal': ordinal,
        'text': text,
        'charCount': len(text),
        'firstLineNo': first_line,
        'lastLineNo': last_line,
        'nodeIds': list(builder.get('nodeIds') or []),
        'sourceRefs': list(builder.get('sourceRefs') or []),
        'sectionPath': list(builder.get('sectionPath') or []),
        'typeCounts': dict(builder.get('typeCounts') or {}),
        'boundaryReason': reason,
        'overlapFromChunkId': builder.get('prefixFromChunkId'),
        'overlapChars': int(builder.get('prefixChars') or 0),
        'oversize': reason == 'oversize-block' or len(text) > int(builder.get('maxChars') or DEFAULT_CHUNK_CONFIG['maxChars']),
    }
    builder['_emittedChunkId'] = chunk_id
    destination.write((json.dumps(chunk, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    return ordinal


def _split_text(text: str, maximum: int) -> list[str]:
    return [text[index:index + maximum] for index in range(0, len(text), maximum)] or ['']


def _max_chunk_chars(path: Path) -> int:
    maximum = 0
    for chunk in _iter_jsonl(path):
        maximum = max(maximum, int(chunk.get('charCount') or 0))
    return maximum


def _count_oversize(path: Path, maximum: int) -> int:
    return sum(1 for chunk in _iter_jsonl(path) if int(chunk.get('charCount') or 0) > maximum)


def _read_report_count(path: Path, key: str) -> int:
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        counts = value.get('counts') if isinstance(value, dict) else {}
        return int(counts.get(key) or 0) if isinstance(counts, dict) else 0
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return 0


def _count_jsonl(path: Path) -> int:
    try:
        with path.open('rb') as stream:
            return sum(1 for _ in stream)
    except OSError:
        return 0


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        for value in stream:
            try:
                item = json.loads(value)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                yield item


def _read_checkpoint(path: Path, stage_key: str, stage: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or value.get('stage') != stage or value.get('stageKey') != stage_key or value.get('complete'):
            return None
        return value
    except (OSError, json.JSONDecodeError):
        return None


def _write_checkpoint(path: Path, value: dict[str, Any]) -> None:
    _write_json(path, value)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _append_json_line(path: Path, value: dict[str, Any]) -> None:
    with path.open('ab') as destination:
        destination.write((json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))


def _truncate_bytes(path: Path, size: int) -> None:
    with path.open('r+b') as stream:
        stream.truncate(max(0, size))


def _raise_if_cancelled(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise StageCancelled()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
