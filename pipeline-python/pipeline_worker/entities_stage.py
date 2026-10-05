"""GraphRAG 实体关系抽取阶段（prepare/finalize 两相 LLM，Worker 不持密钥）。

v3 契约（graph-entities-v3）：
- 每 `batchSize`（默认 3）个子块为一批装入同一请求，子块原文不截断；
- 批次文本用标签分隔：`<chunks><chunk id="...">…</chunk>…</chunks>`；
- 每个实体/关系必须携带可召回原文的证据（chunkId + 逐字 quote），
  finalize 逐条做子串校验，无法召回原文的条目不允许落库。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable

from .stage_errors import StageCancelled, StageError

ENTITIES_SCHEMA_VERSION = 2
DEFAULT_BATCH_SIZE = 3
DEFAULT_MAX_ENTITIES_PER_CHUNK = 20
DEFAULT_MAX_RELATIONS_PER_CHUNK = 30
EVIDENCE_QUOTE_MAX_CHARS = 120
MAX_EVIDENCE_PER_ROW = 12
KNOWN_ENTITY_TYPES = ('person', 'organization', 'project', 'technology', 'concept', 'event', 'artifact')
WHITESPACE = re.compile(r'\s+')


def run_entities_prepare_stage(
    chunks_input_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any],
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """读取子块产物，按批生成标签分隔的实体抽取请求；不截断原文，不把密钥传入 Worker。"""
    output = Path(output_dir)
    chunks = _load_child_chunks(Path(chunks_input_path), cancel_event)
    if not chunks:
        raise StageError('ENTITIES_NO_CHUNKS', '切块阶段没有可抽取的子块产物。', False)
    output.mkdir(parents=True, exist_ok=True)
    prompt_version = str(config.get('promptVersion') or 'graph-entities-v3')
    batch_size = _bounded_int(config.get('batchSize'), DEFAULT_BATCH_SIZE, 1, 10)
    requests: list[dict[str, Any]] = []
    for batch_index in range(0, len(chunks), batch_size):
        if cancel_event.is_set():
            raise StageCancelled()
        batch = [chunk for chunk in chunks[batch_index:batch_index + batch_size] if chunk['text']]
        if not batch:
            continue
        text = _build_batch_text(batch)
        requests.append({
            'requestId': f'ent-{len(requests) + 1:05d}',
            'chunkId': batch[0]['chunkId'],
            'chunkIds': [chunk['chunkId'] for chunk in batch],
            'parentChunkId': batch[0].get('parentChunkId') or '',
            'documentId': document_id,
            'text': text,
            'inputHash': _text_hash(f'{prompt_version}\n{text}'),
            # 仅记录批次字符数；v2 起不再截断子块原文。
            'maxChars': len(text),
        })
    if not requests:
        raise StageError('ENTITIES_NO_CHUNKS', '子块产物没有可抽取的文本。', False)
    _write_jsonl(output / 'entities-llm-requests.jsonl', requests)
    _write_json(output / 'entities-llm-state.json', {
        'schemaVersion': ENTITIES_SCHEMA_VERSION,
        'stage': 'entities',
        'stageKey': stage_key,
        'documentId': document_id,
        'contentHash': content_hash,
        'promptVersion': prompt_version,
        'batchSize': batch_size,
        'requestCount': len(requests),
        'chunkCount': len(chunks),
        'requestsDigest': _request_digest(requests),
    })
    progress(0, len(requests), 'llm-request', f'已准备 {len(requests)} 批实体抽取请求（每批 {batch_size} 子块）。')
    return {'chunks': len(chunks), 'llmRequests': len(requests), 'needsLlmContinuation': 1}


def run_entities_finalize_stage(
    chunks_input_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    config: dict[str, Any],
    responses: Any,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """校验模型输出并聚合实体/关系：证据必须可召回原文；失败请求记痕、失败率过半才判阶段失败。"""
    output = Path(output_dir)
    state_path = output / 'entities-llm-state.json'
    if not state_path.is_file():
        raise StageError('ENTITIES_STATE_MISSING', '实体抽取准备状态不存在，无法继续。', False)
    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise StageError('ENTITIES_STATE_INVALID', '实体抽取准备状态无法读取。', False) from exc
    if state.get('stageKey') != stage_key or state.get('documentId') != document_id or state.get('contentHash') != content_hash:
        raise StageError('ENTITIES_STATE_CONFLICT', '实体抽取准备状态与当前任务不一致。', False)
    requests_path = output / 'entities-llm-requests.jsonl'
    requests = list(_iter_jsonl(requests_path)) if requests_path.is_file() else []
    if len(requests) != int(state.get('requestCount') or 0) or _request_digest(requests) != state.get('requestsDigest'):
        raise StageError('ENTITIES_STATE_CONFLICT', '实体抽取请求已变化，拒绝继续执行。', False)
    response_by_id = _index_responses(responses, requests)
    chunk_texts = _normalized_chunk_texts(Path(chunks_input_path), cancel_event)

    batch_size = _bounded_int(state.get('batchSize') or config.get('batchSize'), DEFAULT_BATCH_SIZE, 1, 10)
    max_entities = _bounded_int(config.get('maxEntitiesPerChunk'), DEFAULT_MAX_ENTITIES_PER_CHUNK, 1, 100) * batch_size
    max_relations = _bounded_int(config.get('maxRelationsPerChunk'), DEFAULT_MAX_RELATIONS_PER_CHUNK, 1, 200) * batch_size
    entities: dict[str, dict[str, Any]] = {}
    relations: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    succeeded = 0
    dropped_entities = 0
    dropped_relations = 0
    for position, request in enumerate(requests):
        if cancel_event.is_set():
            raise StageCancelled()
        request_id = str(request.get('requestId') or '')
        entry = response_by_id.get(request_id)
        parsed = _parse_extraction(entry.get('output') if isinstance(entry, dict) else None)
        if parsed is None:
            failures.append({
                'requestId': request_id,
                'reason': 'schema-validation' if entry else 'missing-response',
                'rawOutput': str((entry or {}).get('output') or '')[:240],
            })
            progress(position + 1, len(requests), 'llm-request', f'实体抽取请求 {position + 1}/{len(requests)} 失败，已记痕。')
            continue
        succeeded += 1
        batch_chunk_ids = _request_chunk_ids(request)
        dropped = _merge_chunk_extraction(parsed, batch_chunk_ids, chunk_texts, entities, relations, max_entities, max_relations)
        dropped_entities += dropped['entities']
        dropped_relations += dropped['relations']
        progress(position + 1, len(requests), 'llm-request', f'实体抽取请求 {position + 1}/{len(requests)} 完成。')
    failed = len(requests) - succeeded
    if failed * 2 > len(requests):
        raise StageError('ENTITIES_LLM_FAILED', '实体抽取失败率超过 50%，阶段失败，可重试。', True)

    entity_rows = sorted(entities.values(), key=lambda row: row['canonicalKey'])
    relation_rows = sorted((_finalize_relation_row(row) for row in relations.values()), key=lambda row: (row['sourceKey'], row['targetKey'], row['kind']))
    _write_jsonl(output / 'entities.jsonl', entity_rows)
    _write_jsonl(output / 'relations.jsonl', relation_rows)
    prompt_version = str(state.get('promptVersion') or config.get('promptVersion') or 'graph-entities-v3')
    report = {
        'schemaVersion': ENTITIES_SCHEMA_VERSION,
        'stage': 'entities',
        'stageKey': stage_key,
        'documentId': document_id,
        'contentHash': content_hash,
        'promptVersion': prompt_version,
        'counts': {
            'chunks': int(state.get('chunkCount') or 0),
            'requests': len(requests),
            'succeeded': succeeded,
            'failed': len(failures),
            'entities': len(entity_rows),
            'relations': len(relation_rows),
            'droppedEntities': dropped_entities,
            'droppedRelations': dropped_relations,
        },
        'failures': failures[:50],
        'generatedAt': _now(),
    }
    _write_json(output / 'extraction-report.json', report)
    requests_path.unlink(missing_ok=True)
    state_path.unlink(missing_ok=True)
    progress(len(requests), len(requests), 'llm-request', f'实体抽取完成：{len(entity_rows)} 实体、{len(relation_rows)} 关系（丢弃无证据条目 {dropped_entities + dropped_relations}）。')
    return dict(report['counts'])


def _load_child_chunks(chunks_dir: Path, cancel_event: Event) -> list[dict[str, Any]]:
    source = chunks_dir / 'children.jsonl'
    if not source.is_file():
        source = chunks_dir / 'chunks.jsonl'
    if not source.is_file():
        raise StageError('ENTITIES_CHUNKS_MISSING', '切块阶段缺少 children.jsonl/chunks.jsonl，无法抽取实体。', False)
    chunks: list[dict[str, Any]] = []
    for row in _iter_jsonl(source):
        if cancel_event.is_set():
            raise StageCancelled()
        chunk_id = str(row.get('chunkId') or row.get('childId') or row.get('id') or '')
        text = WHITESPACE.sub(' ', str(row.get('text') or '')).strip()
        if chunk_id and text:
            chunks.append({'chunkId': chunk_id, 'parentChunkId': str(row.get('parentChunkId') or ''), 'text': text})
    return chunks


def _build_batch_text(batch: list[dict[str, Any]]) -> str:
    """批次文本：标签分隔的原文片段（不截断）；转义 XML 敏感字符防止破坏标签结构。"""
    parts = ['<chunks>']
    for chunk in batch:
        parts.append(f'<chunk id="{_escape_xml(chunk["chunkId"])}">{_escape_xml(chunk["text"])}</chunk>')
    parts.append('</chunks>')
    return '\n'.join(parts)


def _escape_xml(value: str) -> str:
    return value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def _request_chunk_ids(request: dict[str, Any]) -> set[str]:
    chunk_ids = request.get('chunkIds')
    if isinstance(chunk_ids, list) and chunk_ids:
        return {str(value) for value in chunk_ids if str(value)}
    fallback = str(request.get('chunkId') or '')
    return {fallback} if fallback else set()


def _normalized_chunk_texts(chunks_dir: Path, cancel_event: Event) -> dict[str, str]:
    """证据校验用的原文索引：与 prepare 相同的空白归一口径。"""
    return {chunk['chunkId']: chunk['text'] for chunk in _load_child_chunks(chunks_dir, cancel_event)}


def _verify_evidence(raw_evidence: Any, batch_chunk_ids: set[str], chunk_texts: dict[str, str]) -> list[dict[str, str]]:
    """逐条校验证据：chunkId 必须属于本批，quote 必须是对应原文的子串（空白归一后）。"""
    verified: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    if not isinstance(raw_evidence, list):
        return verified
    for entry in raw_evidence:
        if not isinstance(entry, dict):
            continue
        chunk_id = str(entry.get('chunkId') or '').strip()
        quote = WHITESPACE.sub(' ', str(entry.get('quote') or '')).strip()[:EVIDENCE_QUOTE_MAX_CHARS]
        if not chunk_id or chunk_id not in batch_chunk_ids or not quote:
            continue
        source = chunk_texts.get(chunk_id)
        if source is None or quote not in source:
            continue
        marker = (chunk_id, quote)
        if marker in seen:
            continue
        seen.add(marker)
        verified.append({'chunkId': chunk_id, 'quote': quote})
        if len(verified) >= MAX_EVIDENCE_PER_ROW:
            break
    return verified


def _index_responses(responses: Any, requests: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    expected = {str(request.get('requestId') or ''): str(request.get('inputHash') or '') for request in requests}
    indexed: dict[str, dict[str, Any]] = {}
    if isinstance(responses, list):
        for entry in responses:
            if not isinstance(entry, dict):
                continue
            request_id = str(entry.get('requestId') or '')
            if request_id not in expected:
                continue
            if str(entry.get('inputHash') or '') != expected[request_id]:
                continue
            indexed[request_id] = entry
    return indexed


def _parse_extraction(output: Any) -> dict[str, list[dict[str, Any]]] | None:
    if not isinstance(output, str) or not output.strip():
        return None
    payload = _lenient_json(output)
    if not isinstance(payload, dict):
        return None
    raw_entities = payload.get('entities')
    raw_relations = payload.get('relations')
    if not isinstance(raw_entities, list) or not isinstance(raw_relations, list):
        return None
    entities: list[dict[str, Any]] = []
    for entry in raw_entities:
        if not isinstance(entry, dict):
            continue
        name = _normalize_name(entry.get('name'))
        if not name:
            continue
        entities.append({
            'name': name,
            'type': _normalize_type(entry.get('type')),
            'description': _clip_text(entry.get('description'), 1000),
            'evidence': entry.get('evidence'),
        })
    relations: list[dict[str, Any]] = []
    for entry in raw_relations:
        if not isinstance(entry, dict):
            continue
        source = _normalize_name(entry.get('source'))
        target = _normalize_name(entry.get('target'))
        if not source or not target or source == target:
            continue
        strength = entry.get('strength')
        relations.append({
            'source': source,
            'target': target,
            'kind': _clip_text(entry.get('kind'), 40) or 'related',
            'description': _clip_text(entry.get('description'), 500),
            'strength': _bounded_int(strength, 1, 1, 10),
            'evidence': entry.get('evidence'),
        })
    if not entities:
        return None
    return {'entities': entities, 'relations': relations}


def _merge_chunk_extraction(
    parsed: dict[str, list[dict[str, Any]]],
    batch_chunk_ids: set[str],
    chunk_texts: dict[str, str],
    entities: dict[str, dict[str, Any]],
    relations: dict[str, dict[str, Any]],
    max_entities: int,
    max_relations: int,
) -> dict[str, int]:
    """聚合前先校验证据：无有效证据的实体/关系直接丢弃（出处必须可召回原文）。"""
    dropped = {'entities': 0, 'relations': 0}
    chunk_entity_keys: dict[str, str] = {}
    accepted_entities = 0
    for entity in parsed['entities']:
        if accepted_entities >= max_entities:
            break
        evidence = _verify_evidence(entity.get('evidence'), batch_chunk_ids, chunk_texts)
        if not evidence:
            dropped['entities'] += 1
            continue
        accepted_entities += 1
        key = entity['name'].casefold()
        chunk_entity_keys[key] = key
        current = entities.get(key)
        if current is None:
            entities[key] = {
                'canonicalKey': key,
                'mention': entity['name'],
                'type': entity['type'],
                'description': entity['description'],
                'occurrences': 1,
                'chunkIds': sorted({item['chunkId'] for item in evidence}),
                'evidence': evidence,
            }
        else:
            current['occurrences'] += 1
            current['chunkIds'] = sorted(set(current['chunkIds']) | {item['chunkId'] for item in evidence})
            _append_evidence(current, evidence)
            if not current['description'] and entity['description']:
                current['description'] = entity['description']
    accepted = 0
    for relation in parsed['relations']:
        if accepted >= max_relations:
            break
        source_key = relation['source'].casefold()
        target_key = relation['target'].casefold()
        if source_key not in chunk_entity_keys or target_key not in chunk_entity_keys:
            continue
        evidence = _verify_evidence(relation.get('evidence'), batch_chunk_ids, chunk_texts)
        if not evidence:
            dropped['relations'] += 1
            continue
        accepted += 1
        relation_key = f'{source_key}\x00{target_key}\x00{relation["kind"]}'
        current = relations.get(relation_key)
        if current is None:
            relations[relation_key] = {
                'sourceKey': source_key,
                'targetKey': target_key,
                'kind': relation['kind'],
                'description': relation['description'],
                'strengthMean': float(relation['strength']),
                'strengthSampleCount': 1,
                'chunkIds': sorted({item['chunkId'] for item in evidence}),
                'evidence': evidence,
            }
        else:
            sample_count = int(current['strengthSampleCount']) + 1
            current['strengthMean'] += (relation['strength'] - current['strengthMean']) / sample_count
            current['strengthSampleCount'] = sample_count
            current['chunkIds'] = sorted(set(current['chunkIds']) | {item['chunkId'] for item in evidence})
            _append_evidence(current, evidence)
            if not current['description'] and relation['description']:
                current['description'] = relation['description']
    return dropped


def _finalize_relation_row(row: dict[str, Any]) -> dict[str, Any]:
    """输出可审计的语义强度均值与独立支持计数，不把出现次数混进 strength。"""
    chunk_ids = sorted(set(str(value) for value in (row.get('chunkIds') or []) if str(value)))
    return {
        'sourceKey': row['sourceKey'],
        'targetKey': row['targetKey'],
        'kind': row['kind'],
        'description': row['description'],
        'strengthMean': round(float(row.get('strengthMean') or 1.0), 4),
        'strengthSampleCount': max(1, int(row.get('strengthSampleCount') or 1)),
        'supportChunkCount': len(chunk_ids),
        'chunkIds': chunk_ids,
        'evidence': row['evidence'],
    }


def _append_evidence(row: dict[str, Any], evidence: list[dict[str, str]]) -> None:
    existing = row.get('evidence')
    merged = list(existing) if isinstance(existing, list) else []
    seen = {(item.get('chunkId'), item.get('quote')) for item in merged if isinstance(item, dict)}
    for item in evidence:
        marker = (item['chunkId'], item['quote'])
        if marker in seen or len(merged) >= MAX_EVIDENCE_PER_ROW:
            continue
        seen.add(marker)
        merged.append(item)
    row['evidence'] = merged


def _lenient_json(output: str) -> Any:
    """三级恢复（优化方案 P1-6，与 WeKnora stripFencesAndExtract 同构）：
    1. 严格围栏正则；2. 只有开围栏（截断输出）取其后内容；3. 无围栏时状态机括号配对。
    只放宽解析，不放宽事实：恢复出的 JSON 仍由 _parse_extraction 走完整证据校验。"""
    text = output.strip()
    fence = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fence:
        parsed = _loads_or_none(fence.group(1).strip())
        if parsed is not None:
            return parsed
        return _extract_outermost_json(fence.group(1))
    opened = re.search(r'```(?:json)?\s*', text)
    if opened:
        # 输出被 max_tokens 截断时无闭合围栏：取开围栏后的内容，去尾部反引号。
        candidate = text[opened.end():].rstrip('`').strip()
        parsed = _loads_or_none(candidate)
        if parsed is not None:
            return parsed
        return _extract_outermost_json(candidate)
    parsed = _loads_or_none(text)
    if parsed is not None:
        return parsed
    return _extract_outermost_json(text)


def _loads_or_none(text: str) -> Any:
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def _extract_outermost_json(text: str) -> Any:
    """无围栏时的裸 JSON 恢复：逐个起始括号做状态机配对（尊重字符串转义），
    依次尝试直到解析成功；配不上或解析失败返回 None。"""
    for index, char in enumerate(text):
        if char not in '{[':
            continue
        candidate = _match_balanced_block(text, index)
        if candidate is None:
            continue
        parsed = _loads_or_none(candidate)
        if parsed is not None:
            return parsed
    return None


def _match_balanced_block(text: str, start: int) -> str | None:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in '{[':
            depth += 1
        elif char in '}]':
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _normalize_name(value: Any) -> str:
    if not isinstance(value, str):
        return ''
    name = WHITESPACE.sub(' ', value).strip()
    return name[:120]


def _normalize_type(value: Any) -> str:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in KNOWN_ENTITY_TYPES:
            return lowered
    return 'concept'


def _clip_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ''
    return WHITESPACE.sub(' ', value).strip()[:limit]


def _bounded_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) and not (isinstance(value, float) and value.is_integer()):
        try:
            value = int(str(value))
        except (TypeError, ValueError):
            return fallback
    number = int(value)
    return min(maximum, max(minimum, number))


def _request_digest(requests: list[dict[str, Any]]) -> str:
    canonical = json.dumps(requests, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    return _text_hash(canonical)


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _iter_jsonl(path: Path):
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    with path.open('w', encoding='utf-8', newline='\n') as stream:
        for value in values:
            stream.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
