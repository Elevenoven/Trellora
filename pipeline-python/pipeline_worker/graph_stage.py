"""库级图装配阶段（graph-v3）：消费已提交的 entities 产物，构建加权无向图并跑层级社区检测。

Worker 只读各文档的 09-entities 产物，写 Electron 分配的输出目录；
不接触 SQLite、密钥或模型配置（方案 §3.2）。
"""

from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable

from .graph_leiden import hierarchical_communities, normalize_leiden_config
from .stage_errors import StageCancelled, StageError

GRAPH_SCHEMA_VERSION = 3
DESCRIPTION_LIMIT = 2000
EDGE_DESCRIPTION_LIMIT = 500

# 关系权重 = PMI 共现分量 + LLM 强度分量，归一化后压到 1~10（借鉴 WeKnora，见优化方案 P0-1）。
PMI_WEIGHT = 0.6
STRENGTH_WEIGHT = 0.4
WEIGHT_MIN = 1
WEIGHT_MAX = 10
WEIGHT_CONFIG = {
    'version': 'pmi-v2',
    'formula': 'weight = 1 + 9 * (0.6 * norm(PMI) + 0.4 * norm(strengthMean))',
    'pmiWeight': PMI_WEIGHT,
    'strengthWeight': STRENGTH_WEIGHT,
    'strengthAggregation': 'mean',
    'scale': [WEIGHT_MIN, WEIGHT_MAX],
}
# chunk 图投影：单条关系两端同文档 chunk 对超过上限时跳过，防止 hub×hub 边爆炸。
CHUNK_EDGE_PAIR_LIMIT = 200

ProgressFn = Callable[[int, int | None, str, str], None]


def run_graph_stage(
    entities_dirs: list[str],
    output_dir: str,
    graph_key: str,
    config: dict[str, Any],
    cancel_event: Event,
    progress: ProgressFn,
    stage_key: str = '',
    engine_override: Any = None,
) -> dict[str, Any]:
    """聚合全部已提交 entities 产物，建图、跑层级社区检测并写产物。"""
    started = time.monotonic()
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    inputs = _load_entities_inputs(entities_dirs, cancel_event)
    if not inputs:
        raise StageError('GRAPH_INPUTS_MISSING', '没有可用的 entities 产物，无法装配图谱。', False)

    leiden_config = normalize_leiden_config(config)
    nodes, edges = _aggregate_graph(inputs, cancel_event)
    node_keys = sorted(nodes)
    if not node_keys:
        raise StageError('GRAPH_INPUTS_MISSING', 'entities 产物中没有可用实体。', False)
    _calculate_weights(nodes, edges)
    edge_rows = sorted(edges.values(), key=lambda row: (row['sourceKey'], row['targetKey']))
    progress(1, 3, 'graph-build', f'已聚合 {len(node_keys)} 实体、{len(edge_rows)} 关系边。')

    for row in edge_rows:
        degree_source = nodes[row['sourceKey']]
        degree_target = nodes[row['targetKey']]
        degree_source['degree'] += 1
        degree_target['degree'] += 1

    if cancel_event.is_set():
        raise StageCancelled()
    community_result = hierarchical_communities(
        node_keys,
        [(row['sourceKey'], row['targetKey'], row['weight']) for row in edge_rows],
        leiden_config,
        cancel_event,
        progress,
        engine_override,
    )
    progress(2, 3, 'graph-build', f'社区检测完成：{community_result["levels"]} 层，引擎 {community_result["engine"]}。')

    node_community: dict[int, str] = {}
    for row in community_result['communities']:
        if row['level'] == 0:
            for index in row['memberIndices']:
                node_community[index] = row['communityId']

    node_rows = []
    for index, key in enumerate(node_keys):
        node = nodes[key]
        node_rows.append({
            'kind': 'node',
            'canonicalKey': key,
            'mention': node['mention'],
            'type': node['type'],
            'description': node['description'],
            'degree': node['degree'],
            'docIds': sorted(node['docIds']),
            'chunkIds': sorted(node['chunkIds']),
            'communityId': node_community.get(index, ''),
        })
    graph_rows = node_rows + [
        {
            'kind': 'edge',
            'sourceKey': row['sourceKey'],
            'targetKey': row['targetKey'],
            'weight': row['weight'],
            'strengthMean': row['strengthMean'],
            'strengthSampleCount': row['strengthSampleCount'],
            'pmi': row['pmi'],
            'supportChunkCount': row['supportChunkCount'],
            'supportDocCount': row['supportDocCount'],
            'kinds': row['kinds'],
            'description': row['description'],
            'chunkIds': row['chunkIds'],
        }
        for row in edge_rows
    ]
    _write_jsonl(output / 'graph.jsonl', graph_rows)

    # chunk 级图投影（优化方案 P0-2）：实体关系 → 同文档 chunk 对加权边，供混合检索图扩展。
    chunk_edge_rows, skipped_pairs = _build_chunk_edges(inputs, nodes, edges, cancel_event)
    _write_jsonl(output / 'chunk_edges.jsonl', chunk_edge_rows)

    edge_endpoint_index = {}
    for row in edge_rows:
        edge_endpoint_index.setdefault(row['sourceKey'], []).append(row)
        if row['targetKey'] != row['sourceKey']:
            edge_endpoint_index.setdefault(row['targetKey'], []).append(row)
    community_rows = []
    for row in community_result['communities']:
        member_keys = sorted(node_keys[index] for index in row['memberIndices'])
        member_set = set(member_keys)
        seen_edges: set[tuple[str, str]] = set()
        edge_count = 0
        detail_chars = 0
        for key in member_keys:
            detail_chars += len(nodes[key]['description'])
            for edge in edge_endpoint_index.get(key, []):
                edge_id = (edge['sourceKey'], edge['targetKey'])
                if edge_id in seen_edges or edge['targetKey'] not in member_set:
                    continue
                seen_edges.add(edge_id)
                edge_count += 1
                detail_chars += len(edge['description']) + sum(len(kind) for kind in edge['kinds'])
        community_rows.append({
            'communityId': row['communityId'],
            'level': row['level'],
            'parentId': row['parentId'],
            'memberKeys': member_keys,
            'edgeCount': edge_count,
            # 粗估社区明细规模，供 P3 摘要预算；中文按约 2 字符/ token 估算。
            'tokens': (detail_chars + 1) // 2,
        })
    _write_jsonl(output / 'communities.jsonl', community_rows)

    communities_by_level: dict[int, int] = {}
    for row in community_rows:
        communities_by_level[row['level']] = communities_by_level.get(row['level'], 0) + 1
    duration_ms = int((time.monotonic() - started) * 1000)
    report = {
        'schemaVersion': GRAPH_SCHEMA_VERSION,
        'stage': 'graph',
        'graphKey': graph_key,
        'stageKey': stage_key,
        'engine': community_result['engine'],
        'leidenConfig': leiden_config,
        'counts': {
            'nodes': len(node_rows),
            'edges': len(edge_rows),
            'communities': len(community_rows),
            'levels': community_result['levels'],
            'chunkEdges': len(chunk_edge_rows),
        },
        'chunkEdgePairsSkipped': skipped_pairs,
        'weightConfig': WEIGHT_CONFIG,
        'communitiesByLevel': {str(level): count for level, count in sorted(communities_by_level.items())},
        'modularityLevel0': community_result['modularityLevel0'],
        'sourceDocuments': sorted({document_id for document_id, _entities, _relations in inputs if document_id}),
        'durationMs': duration_ms,
        'generatedAt': _now(),
    }
    _write_json(output / 'graph-report.json', report)
    progress(3, 3, 'graph-build', f'图谱装配完成：{len(node_rows)} 节点、{len(edge_rows)} 边、{len(community_rows)} 社区。')
    return dict(report['counts'])


def _load_entities_inputs(entities_dirs: list[str], cancel_event: Event) -> list[tuple[str, list[dict[str, Any]], list[dict[str, Any]]]]:
    inputs: list[tuple[str, list[dict[str, Any]], list[dict[str, Any]]]] = []
    for directory in entities_dirs or []:
        if cancel_event.is_set():
            raise StageCancelled()
        root = Path(str(directory))
        entities_path = root / 'entities.jsonl'
        relations_path = root / 'relations.jsonl'
        if not entities_path.is_file() or not relations_path.is_file():
            raise StageError('GRAPH_INPUTS_MISSING', f'entities 产物缺失：{root}', False)
        document_id = ''
        report_path = root / 'extraction-report.json'
        if report_path.is_file():
            try:
                document_id = str(json.loads(report_path.read_text(encoding='utf-8')).get('documentId') or '')
            except (OSError, json.JSONDecodeError):
                document_id = ''
        inputs.append((document_id, list(_iter_jsonl(entities_path)), list(_iter_jsonl(relations_path))))
    return inputs


def _aggregate_graph(inputs, cancel_event: Event):
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str], dict[str, Any]] = {}
    for document_id, entity_rows, relation_rows in inputs:
        for row in entity_rows:
            if cancel_event.is_set():
                raise StageCancelled()
            key = str(row.get('canonicalKey') or '').strip()
            if not key:
                continue
            node = nodes.get(key)
            description = str(row.get('description') or '').strip()
            entity_type = str(row.get('type') or 'concept')
            mention = str(row.get('mention') or key)
            chunk_ids = [str(value) for value in (row.get('chunkIds') or []) if str(value)]
            if node is None:
                nodes[key] = {
                    'mention': mention,
                    'type': entity_type,
                    'description': description,
                    'degree': 0,
                    'docIds': {document_id} if document_id else set(),
                    'chunkIds': set(chunk_ids),
                    # 按文档分组的 chunk 集合：chunk 图投影只连同文档内的 chunk 对。
                    'chunkIdsByDoc': {document_id: set(chunk_ids)} if document_id else {},
                }
                continue
            node['chunkIds'].update(chunk_ids)
            if document_id:
                node['docIds'].add(document_id)
                node['chunkIdsByDoc'].setdefault(document_id, set()).update(chunk_ids)
            if len(mention) > len(node['mention']):
                node['mention'] = mention
            if node['type'] == 'concept' and entity_type != 'concept':
                node['type'] = entity_type
            if description and description not in node['description']:
                node['description'] = _clip(f"{node['description']}；{description}" if node['description'] else description, DESCRIPTION_LIMIT)
        for row in relation_rows:
            if cancel_event.is_set():
                raise StageCancelled()
            source = str(row.get('sourceKey') or '').strip()
            target = str(row.get('targetKey') or '').strip()
            if not source or not target or source == target or source not in nodes or target not in nodes:
                continue
            edge_key = (source, target) if source < target else (target, source)
            strength_mean, strength_sample_count = _read_relation_strength(row)
            kind = str(row.get('kind') or 'related')
            description = str(row.get('description') or '').strip()
            chunk_ids = sorted(set(str(value) for value in (row.get('chunkIds') or []) if str(value)))
            edge = edges.get(edge_key)
            if edge is None:
                edges[edge_key] = {
                    'sourceKey': edge_key[0],
                    'targetKey': edge_key[1],
                    # 语义强度与支持次数分离；最终 weight 由 _calculate_weights 校准。
                    'weight': WEIGHT_MIN,
                    'strengthMean': strength_mean,
                    'strengthSampleCount': strength_sample_count,
                    'pmi': 0.0,
                    'supportChunkCount': len(chunk_ids),
                    'supportDocCount': 1 if document_id else 0,
                    'supportDocIds': {document_id} if document_id else set(),
                    'kinds': [kind],
                    'description': description,
                    'chunkIds': chunk_ids,
                }
                continue
            previous_count = edge['strengthSampleCount']
            combined_count = previous_count + strength_sample_count
            edge['strengthMean'] = (
                edge['strengthMean'] * previous_count + strength_mean * strength_sample_count
            ) / combined_count
            edge['strengthSampleCount'] = combined_count
            if kind not in edge['kinds']:
                edge['kinds'].append(kind)
            if description and description not in edge['description']:
                edge['description'] = _clip(f"{edge['description']}；{description}" if edge['description'] else description, EDGE_DESCRIPTION_LIMIT)
            for chunk_id in chunk_ids:
                if chunk_id not in edge['chunkIds']:
                    edge['chunkIds'].append(chunk_id)
            edge['chunkIds'].sort()
            if document_id:
                edge['supportDocIds'].add(document_id)
            edge['supportChunkCount'] = len(edge['chunkIds'])
            edge['supportDocCount'] = len(edge['supportDocIds'])
    for node in nodes.values():
        node['docIds'] = set(node['docIds'])
    for edge in edges.values():
        edge['strengthMean'] = round(edge['strengthMean'], 4)
        edge['supportChunkCount'] = len(edge['chunkIds'])
        edge['supportDocCount'] = len(edge['supportDocIds'])
    return nodes, edges


def _read_relation_strength(row: dict[str, Any]) -> tuple[float, int]:
    """读取 v3 strengthMean；旧产物仅有 weight 时按一个样本兼容并钳制到 1~10。"""
    raw_strength = row.get('strengthMean')
    if raw_strength is None:
        raw_strength = row.get('weight')
    try:
        strength_mean = float(raw_strength)
    except (TypeError, ValueError):
        strength_mean = float(WEIGHT_MIN)
    if not math.isfinite(strength_mean):
        strength_mean = float(WEIGHT_MIN)
    strength_mean = min(float(WEIGHT_MAX), max(float(WEIGHT_MIN), strength_mean))
    try:
        sample_count = int(row.get('strengthSampleCount') or 1)
    except (TypeError, ValueError):
        sample_count = 1
    return strength_mean, max(1, sample_count)


def _calculate_weights(nodes: dict[str, dict[str, Any]], edges: dict[tuple[str, str], dict[str, Any]]) -> None:
    """PMI + Strength 归一化权重（优化方案 P0-1）。

    PMI(u,v) = max(log2(P(u,v) / (P(u)·P(v))), 0)，概率以 chunk 频率估计：
    P(u) = |chunks(u)| / N，P(u,v) = 关系证据共现块数 / N。
    weight = 1 + 9 × (0.6 × PMI/maxPMI + 0.4 × strengthMean/maxStrength)，压到 1~10。
    """
    total_chunks = len({chunk for node in nodes.values() for chunk in node['chunkIds']})
    max_pmi = 0.0
    max_strength = 0.0
    for edge in edges.values():
        source_size = len(nodes[edge['sourceKey']]['chunkIds'])
        target_size = len(nodes[edge['targetKey']]['chunkIds'])
        co_occurrence = len(edge['chunkIds'])
        pmi = 0.0
        if total_chunks and source_size and target_size and co_occurrence:
            pmi = math.log2((co_occurrence * total_chunks) / (source_size * target_size))
        edge['pmi'] = round(max(pmi, 0.0), 4)
        max_pmi = max(max_pmi, edge['pmi'])
        max_strength = max(max_strength, edge['strengthMean'])
    for edge in edges.values():
        pmi_term = edge['pmi'] / max_pmi if max_pmi > 0 else 0.0
        strength_term = edge['strengthMean'] / max_strength if max_strength > 0 else 0.0
        combined = PMI_WEIGHT * pmi_term + STRENGTH_WEIGHT * strength_term
        edge['weight'] = max(WEIGHT_MIN, min(WEIGHT_MAX, WEIGHT_MIN + round((WEIGHT_MAX - WEIGHT_MIN) * combined)))


def _build_chunk_edges(inputs, nodes, edges, cancel_event: Event):
    """实体图 → 同文档 chunk 对加权无向边（优化方案 P0-2）。

    对每条关系，把两端实体在该文档内的 chunk 两两连边；边权取关系最终权重，
    多关系同 chunk 对取最大。跨文档对噪声大，第一版不做。
    """
    pair_weights: dict[tuple[str, str], int] = {}
    skipped_pairs = 0
    for document_id, _entity_rows, relation_rows in inputs:
        if not document_id:
            continue
        for row in relation_rows:
            if cancel_event.is_set():
                raise StageCancelled()
            source = str(row.get('sourceKey') or '').strip()
            target = str(row.get('targetKey') or '').strip()
            if not source or not target or source == target or source not in nodes or target not in nodes:
                continue
            edge_key = (source, target) if source < target else (target, source)
            edge = edges.get(edge_key)
            if edge is None:
                continue
            source_chunks = sorted(nodes[source]['chunkIdsByDoc'].get(document_id, ()))
            target_chunks = sorted(nodes[target]['chunkIdsByDoc'].get(document_id, ()))
            if not source_chunks or not target_chunks:
                continue
            if len(source_chunks) * len(target_chunks) > CHUNK_EDGE_PAIR_LIMIT:
                skipped_pairs += 1
                continue
            for source_chunk in source_chunks:
                for target_chunk in target_chunks:
                    if source_chunk == target_chunk:
                        continue
                    pair = (source_chunk, target_chunk) if source_chunk < target_chunk else (target_chunk, source_chunk)
                    existing = pair_weights.get(pair)
                    if existing is None or edge['weight'] > existing:
                        pair_weights[pair] = edge['weight']
    chunk_edge_rows = [{'chunkIdA': pair[0], 'chunkIdB': pair[1], 'weight': weight} for pair, weight in sorted(pair_weights.items())]
    return chunk_edge_rows, skipped_pairs


def _clip(value: str, limit: int) -> str:
    return value[:limit]


def _iter_jsonl(path: Path):
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    import os

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
