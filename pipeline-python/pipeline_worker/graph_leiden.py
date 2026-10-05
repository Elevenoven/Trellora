"""层级社区检测（Leiden 主引擎 + Louvain fallback）。

手写层级递归复刻 hierarchical Leiden 语义（GraphRAG 方案 §3.2.1）：引擎只负责
单层分区，递归、MECE carry-down 与产物逻辑两种引擎共享。确定性三件套：
节点/边固定排序 + 固定 seed + leidenConfig 版本号（参与 graphKey）。
"""

from __future__ import annotations

from threading import Event
from typing import Any, Callable, Sequence

from .stage_errors import StageCancelled

DEFAULT_LEIDEN_CONFIG: dict[str, Any] = {
    'resolution': 1.0,
    'maxDepth': 4,
    'minSplitSize': 3,
    'seed': 42,
}

ProgressFn = Callable[[int, int | None, str, str], None]


class _LeidenEngine:
    name = 'leiden'

    def partition(self, node_count: int, edges: list[tuple[int, int, float]], resolution: float, seed: int) -> list[list[int]]:
        import igraph as ig
        import leidenalg

        graph = ig.Graph(n=node_count, edges=[(u, v) for u, v, _ in edges], directed=False)
        graph.es['weight'] = [w for _, _, w in edges]
        partition = leidenalg.find_partition(
            graph,
            leidenalg.RBConfigurationVertexPartition,
            weights='weight',
            resolution_parameter=resolution,
            seed=seed,
        )
        return [sorted(group) for group in partition]

    def modularity(self, node_count: int, edges: list[tuple[int, int, float]], membership: list[int]) -> float | None:
        import igraph as ig

        graph = ig.Graph(n=node_count, edges=[(u, v) for u, v, _ in edges], directed=False)
        graph.es['weight'] = [w for _, _, w in edges]
        try:
            return float(graph.modularity(membership, weights='weight'))
        except Exception:
            return None


class _LouvainEngine:
    name = 'louvain-fallback'

    def partition(self, node_count: int, edges: list[tuple[int, int, float]], resolution: float, seed: int) -> list[list[int]]:
        import networkx as nx
        from networkx.algorithms.community import louvain_communities

        graph = nx.Graph()
        graph.add_nodes_from(range(node_count))
        for u, v, w in edges:
            graph.add_edge(u, v, weight=w)
        groups = louvain_communities(graph, weight='weight', resolution=resolution, seed=seed)
        return [sorted(group) for group in groups]

    def modularity(self, node_count: int, edges: list[tuple[int, int, float]], membership: list[int]) -> float | None:
        import networkx as nx
        from networkx.algorithms.community import modularity as nx_modularity

        graph = nx.Graph()
        graph.add_nodes_from(range(node_count))
        for u, v, w in edges:
            graph.add_edge(u, v, weight=w)
        communities: list[list[int]] = []
        for node, community in enumerate(membership):
            while len(communities) <= community:
                communities.append([])
            communities[community].append(node)
        try:
            return float(nx_modularity(graph, communities, weight='weight'))
        except Exception:
            return None


def resolve_engine(force_fallback: bool = False):
    """选择社区检测引擎；原生依赖缺失时自动退回 networkx louvain。"""
    if not force_fallback:
        try:
            import igraph  # noqa: F401
            import leidenalg  # noqa: F401
            return _LeidenEngine()
        except ImportError:
            pass
    try:
        import networkx  # noqa: F401
        return _LouvainEngine()
    except ImportError as exc:
        raise RuntimeError('社区检测需要 leidenalg+igraph 或 networkx，当前环境均不可用。') from exc


def normalize_leiden_config(config: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(DEFAULT_LEIDEN_CONFIG)
    if isinstance(config, dict):
        candidate = config.get('leiden') if isinstance(config.get('leiden'), dict) else config
        for key in DEFAULT_LEIDEN_CONFIG:
            if key in candidate:
                merged[key] = candidate[key]
    resolution = float(merged['resolution'])
    if not 0.1 <= resolution <= 10.0:
        resolution = float(DEFAULT_LEIDEN_CONFIG['resolution'])
    return {
        'resolution': resolution,
        'maxDepth': _bounded(int(merged['maxDepth']), 1, 8),
        'minSplitSize': _bounded(int(merged['minSplitSize']), 2, 100),
        'seed': int(merged['seed']),
    }


def hierarchical_communities(
    node_keys: Sequence[str],
    edges: list[tuple[str, str, float]],
    config: dict[str, Any] | None,
    cancel_event: Event | None = None,
    progress: ProgressFn | None = None,
    engine: Any = None,
) -> dict[str, Any]:
    """对已排序的节点键与聚合边运行层级社区检测。

    返回：
    - `communities`：逐层互斥完备分区行（level/parentId/memberIndices/edgeCount）；
    - `engine`：实际使用的引擎名；
    - `modularityLevel0`：level-0 分区 modularity（诊断用）；
    - `levels`：层数。
    """
    cfg = normalize_leiden_config(config)
    resolution = cfg['resolution']
    max_depth = cfg['maxDepth']
    min_split_size = cfg['minSplitSize']
    seed = cfg['seed']
    engine = engine or resolve_engine()

    key_index = {key: index for index, key in enumerate(node_keys)}
    aggregated: dict[tuple[int, int], float] = {}
    for source, target, weight in edges:
        if source not in key_index or target not in key_index or source == target:
            continue
        u, v = key_index[source], key_index[target]
        if u > v:
            u, v = v, u
        aggregated[(u, v)] = aggregated.get((u, v), 0.0) + float(weight)
    indexed_edges = sorted((u, v, w) for (u, v), w in aggregated.items())

    chains: list[list[int]] = [[] for _ in node_keys]
    groups_by_id: dict[int, dict[str, Any]] = {}
    next_group_id = 0

    def recurse(member_indices: list[int], level: int) -> None:
        nonlocal next_group_id
        if cancel_event is not None and cancel_event.is_set():
            raise StageCancelled()
        if level >= max_depth or len(member_indices) < min_split_size:
            return
        member_set = set(member_indices)
        local = {node: i for i, node in enumerate(member_indices)}
        local_edges = [(local[u], local[v], w) for u, v, w in indexed_edges if u in member_set and v in member_set]
        if not local_edges:
            return
        groups = engine.partition(len(member_indices), local_edges, resolution, seed)
        if not groups or len(groups) <= 1:
            return
        for group in sorted(groups, key=min):
            group_id = next_group_id
            next_group_id += 1
            members = sorted(member_indices[i] for i in group)
            groups_by_id[group_id] = {'level': level, 'members': members}
            for index in members:
                chains[index].append(group_id)
            if progress is not None:
                progress(level + 1, max_depth, 'community-level', f'第 {level} 层社区分裂完成（成员 {len(members)}）。')
            recurse([member_indices[i] for i in group], level + 1)

    recurse(list(range(len(node_keys))), 0)

    max_level = -1
    for chain in chains:
        max_level = max(max_level, len(chain) - 1)
    if max_level < 0:
        # 不可再分（或无边）：整图作为唯一 level-0 社区，触发小图降级提示。
        groups_by_id[0] = {'level': 0, 'members': list(range(len(node_keys)))}
        for chain in chains:
            chain.append(0)
        max_level = 0

    # 逐层 MECE carry-down：level-L 归属 = 叶祖先链 chain[min(L, len-1)]。
    temp_to_community_id: dict[tuple[int, int], str] = {}
    community_rows: list[dict[str, Any]] = []
    level0_membership: list[int] = []
    for level in range(0, max_level + 1):
        buckets: dict[int, list[int]] = {}
        for node_index, chain in enumerate(chains):
            group_id = chain[min(level, len(chain) - 1)]
            buckets.setdefault(group_id, []).append(node_index)
        ordered = sorted(buckets.items(), key=lambda item: min(item[1]))
        for seq, (group_id, members) in enumerate(ordered):
            community_id = f'c-{level}-{seq:04d}'
            temp_to_community_id[(level, group_id)] = community_id
            parent_id = None
            if level > 0:
                parent_chain = chains[members[0]]
                parent_group_id = parent_chain[min(level - 1, len(parent_chain) - 1)]
                parent_id = temp_to_community_id.get((level - 1, parent_group_id))
            community_rows.append({
                'communityId': community_id,
                'level': level,
                'parentId': parent_id,
                'memberIndices': members,
            })
        if level == 0:
            group_to_seq = {group_id: seq for seq, (group_id, _members) in enumerate(ordered)}
            level0_membership = [group_to_seq[chains[i][0]] for i in range(len(node_keys))]

    modularity_level0 = engine.modularity(len(node_keys), indexed_edges, level0_membership) if len(node_keys) > 1 else None
    return {
        'communities': community_rows,
        'chains': chains,
        'engine': engine.name,
        'modularityLevel0': modularity_level0,
        'levels': max_level + 1,
    }


def _bounded(value: int, minimum: int, maximum: int) -> int:
    try:
        return min(maximum, max(minimum, int(value)))
    except (TypeError, ValueError):
        return min(maximum, max(minimum, 0))
