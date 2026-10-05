from __future__ import annotations

import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence

from .keyword_candidates import CandidateGenerationResult, KeywordCandidate
from .keyword_contract import KEYWORD_OUTPUT_SCHEMA_VERSION, KeywordChunkInput, chunk_content_hash, normalize_term, validate_keyword_output


HYBRID_KEYWORD_ALGORITHM_VERSION = 'kw-1'
DEFAULT_BOILERPLATE_DF_RATIO = 0.65
DEFAULT_TEXT_RANK_WINDOW = 4
DEFAULT_TEXT_RANK_DAMPING = 0.85
DEFAULT_TEXT_RANK_ITERATIONS = 30
DEFAULT_TEXT_RANK_TOLERANCE = 1e-6
MAX_RANKING_CHUNKS = 50_000
MAX_TEXT_RANK_NODES = 2_048
MAX_TEXT_RANK_EDGES = 10_000
MAX_SECTION_TEXT = 20_000
CHINESE_ONLY_RE = re.compile(r'^[\u3400-\u9fff]+$')
TECHNICAL_TERM_RE = re.compile(r'^[A-Za-z][A-Za-z0-9]*(?:[._+#/-][A-Za-z0-9]+)*(?:\s+\d+(?:\.\d+)?)?$')
REPEATED_CHARACTER_RE = re.compile(r'(.)\1{3,}')
TOKEN_RE = re.compile(r'[\u3400-\u9fff]|[A-Za-z0-9]+(?:[._+#/-][A-Za-z0-9]+)*')


@dataclass(frozen=True)
class HybridRankingConfig:
    min_score: float = 0.28
    min_keywords: int = 1
    max_keywords: int = 10
    window_size: int = DEFAULT_TEXT_RANK_WINDOW
    damping: float = DEFAULT_TEXT_RANK_DAMPING
    max_iterations: int = DEFAULT_TEXT_RANK_ITERATIONS
    tolerance: float = DEFAULT_TEXT_RANK_TOLERANCE
    boilerplate_df_ratio: float = DEFAULT_BOILERPLATE_DF_RATIO
    allow_overlap_fallback: bool = True
    weights: Mapping[str, float] | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.min_score <= 1:
            raise ValueError('min_score 必须在 [0, 1] 范围内。')
        if not 0 <= self.min_keywords <= 5:
            raise ValueError('min_keywords 必须在 [0, 5] 范围内。')
        if not 1 <= self.max_keywords <= 20:
            raise ValueError('max_keywords 必须在 [1, 20] 范围内。')
        if not 2 <= self.window_size <= 10:
            raise ValueError('window_size 必须在 [2, 10] 范围内。')
        if not 0.5 <= self.damping <= 0.95:
            raise ValueError('damping 必须在 [0.5, 0.95] 范围内。')
        if not 10 <= self.max_iterations <= 100:
            raise ValueError('max_iterations 必须在 [10, 100] 范围内。')
        if not 1e-9 <= self.tolerance <= 0.1:
            raise ValueError('tolerance 必须在 [1e-9, 0.1] 范围内。')
        if not 0.4 <= self.boilerplate_df_ratio <= 0.95:
            raise ValueError('boilerplate_df_ratio 必须在 [0.4, 0.95] 范围内。')
        raw_weights = self.weights or {
            'tfidf': 0.35,
            'textRank': 0.25,
            'position': 0.15,
            'sentenceSpread': 0.10,
            'sectionMatch': 0.10,
            'termQuality': 0.05,
        }
        if any(not math.isfinite(float(value)) or float(value) < 0 for value in raw_weights.values()):
            raise ValueError('评分权重必须是非负有限数字。')
        if not any(float(raw_weights.get(key, 0)) > 0 for key in _FEATURE_NAMES):
            raise ValueError('至少需要一个正评分权重。')
        normalized = {key: float(raw_weights.get(key, 0.0)) for key in _FEATURE_NAMES}
        total = sum(normalized.values())
        object.__setattr__(self, 'weights', {key: value / total for key, value in normalized.items()})


@dataclass(frozen=True)
class TextRankResult:
    scores: Mapping[str, float]
    available: bool
    converged: bool
    iterations: int
    edge_count: int
    node_capped: bool = False
    edge_capped: bool = False


@dataclass(frozen=True)
class HybridRankingRun:
    outputs: tuple[dict[str, Any], ...]
    report: dict[str, Any]


class KeywordRankingCancelled(RuntimeError):
    """Raised by the pure ranking layer when its caller requests cancellation."""


@dataclass
class _ScoredCandidate:
    candidate: KeywordCandidate
    features: dict[str, float | bool]
    score: float
    first_start: int
    forced_top1: bool = False


_FEATURE_NAMES = ('tfidf', 'textRank', 'position', 'sentenceSpread', 'sectionMatch', 'termQuality')


def rank_keyword_chunks(
    chunks: Sequence[KeywordChunkInput],
    candidate_results: Sequence[CandidateGenerationResult],
    *,
    config: HybridRankingConfig | None = None,
    tokenizer_name: str = 'jieba-accurate-hmm-off',
    tokenizer_version: str = 'unresolved',
    dictionary_hash: str = 'none',
    stopword_hash: str = 'unresolved',
) -> list[dict[str, Any]]:
    return list(run_hybrid_keyword_ranking(
        chunks,
        candidate_results,
        config=config,
        tokenizer_name=tokenizer_name,
        tokenizer_version=tokenizer_version,
        dictionary_hash=dictionary_hash,
        stopword_hash=stopword_hash,
    ).outputs)


def rank_keyword_chunk(
    chunk: KeywordChunkInput,
    candidate_result: CandidateGenerationResult,
    document_df: Mapping[str, int],
    document_size: int,
    *,
    config: HybridRankingConfig | None = None,
    tokenizer_name: str = 'jieba-accurate-hmm-off',
    tokenizer_version: str = 'unresolved',
    dictionary_hash: str = 'none',
    stopword_hash: str = 'unresolved',
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[dict[str, Any], Counter[str]]:
    """Rank one chunk against a precomputed document DF snapshot.

    The stage runner uses this bounded API in its second pass so it does not
    retain every chunk body and candidate list in memory.
    """
    _check_cancel(cancel_check)
    return _rank_chunk(
        chunk,
        candidate_result,
        Counter(document_df),
        max(1, int(document_size)),
        config or HybridRankingConfig(),
        tokenizer_name,
        tokenizer_version,
        dictionary_hash,
        stopword_hash,
        cancel_check,
    )


def run_hybrid_keyword_ranking(
    chunks: Sequence[KeywordChunkInput],
    candidate_results: Sequence[CandidateGenerationResult],
    *,
    config: HybridRankingConfig | None = None,
    tokenizer_name: str = 'jieba-accurate-hmm-off',
    tokenizer_version: str = 'unresolved',
    dictionary_hash: str = 'none',
    stopword_hash: str = 'unresolved',
) -> HybridRankingRun:
    ranking_config = config or HybridRankingConfig()
    if len(chunks) != len(candidate_results):
        raise ValueError('chunks 与 candidate_results 数量必须一致。')
    if len(chunks) > MAX_RANKING_CHUNKS:
        raise ValueError('关键词评分子块数量超过资源上限。')

    started = time.perf_counter()
    df_by_document, document_sizes = _build_document_df(chunks, candidate_results)
    outputs: list[dict[str, Any]] = []
    counters = Counter({
        'emptyChunks': 0,
        'forcedTop1Chunks': 0,
        'overlapOnlyDiscarded': 0,
        'boilerplatePenalized': 0,
        'noiseCandidatesDiscarded': 0,
        'invalidEvidenceDiscarded': 0,
        'candidateCappedChunks': 0,
        'textRankNodeCappedChunks': 0,
        'textRankEdgeCappedChunks': 0,
    })

    for chunk, result in zip(chunks, candidate_results):
        output, local_counts = _rank_chunk(
            chunk,
            result,
            df_by_document.get(chunk.document_id, Counter()),
            document_sizes.get(chunk.document_id, 1),
            ranking_config,
            tokenizer_name,
            tokenizer_version,
            dictionary_hash,
            stopword_hash,
        )
        outputs.append(output)
        counters.update(local_counts)

    keyword_count = sum(len(output['keywords']) for output in outputs)
    distribution = [len(output['keywords']) for output in outputs]
    report = {
        'schemaVersion': KEYWORD_OUTPUT_SCHEMA_VERSION,
        'stage': 'keywords',
        'algorithmVersion': HYBRID_KEYWORD_ALGORITHM_VERSION,
        'config': _config_to_json(ranking_config),
        'counts': {
            'chunks': len(chunks),
            'keywords': keyword_count,
            **{key: int(value) for key, value in counters.items()},
        },
        'distribution': {
            'minKeywordsPerChunk': min(distribution, default=0),
            'avgKeywordsPerChunk': round(keyword_count / len(outputs), 4) if outputs else 0.0,
            'maxKeywordsPerChunk': max(distribution, default=0),
        },
        'durationMs': round((time.perf_counter() - started) * 1000, 3),
        'generatedAt': datetime.now(timezone.utc).isoformat(),
    }
    return HybridRankingRun(tuple(outputs), report)


def compute_text_rank(
    candidates: Sequence[KeywordCandidate],
    *,
    window_size: int = DEFAULT_TEXT_RANK_WINDOW,
    damping: float = DEFAULT_TEXT_RANK_DAMPING,
    max_iterations: int = DEFAULT_TEXT_RANK_ITERATIONS,
    tolerance: float = DEFAULT_TEXT_RANK_TOLERANCE,
    max_nodes: int = MAX_TEXT_RANK_NODES,
    max_edges: int = MAX_TEXT_RANK_EDGES,
    cancel_check: Callable[[], bool] | None = None,
) -> TextRankResult:
    if not 2 <= window_size <= 10:
        raise ValueError('window_size 必须在 [2, 10] 范围内。')
    # TextRank is built from content tokens. Phrase candidates are scored from
    # their component-token ranks below, otherwise the 2/3-gram expansion
    # would inflate the graph with duplicate nodes and favor long phrases.
    if max_nodes < 4 or max_edges < 1:
        raise ValueError('TextRank 图资源上限不合法。')
    _check_cancel(cancel_check)
    unique_candidates = _deduplicate_candidates(
        candidate for candidate in candidates if candidate.kind != 'phrase'
    )
    node_capped = len(unique_candidates) > max_nodes
    if node_capped:
        unique_candidates = sorted(
            unique_candidates,
            key=lambda item: (-len(item.occurrences), _first_start(item), item.normalized_term),
        )[:max_nodes]
    node_names = sorted(candidate.normalized_term for candidate in unique_candidates)
    if len(node_names) < 4:
        return TextRankResult({name: 0.0 for name in node_names}, False, True, 0, 0, node_capped, False)

    events_by_sentence: dict[int, list[tuple[int, str]]] = defaultdict(list)
    for candidate in unique_candidates:
        _check_cancel(cancel_check)
        for occurrence in candidate.occurrences:
            events_by_sentence[occurrence.sentence_index].append((occurrence.start, candidate.normalized_term))

    adjacency: dict[str, Counter[str]] = {name: Counter() for name in node_names}
    edge_pairs: set[tuple[str, str]] = set()
    edge_capped = False
    for events in events_by_sentence.values():
        _check_cancel(cancel_check)
        ordered = sorted(events, key=lambda item: (item[0], item[1]))
        for index, (_start, left) in enumerate(ordered):
            for _other_start, right in ordered[index + 1:index + 1 + window_size]:
                _check_cancel(cancel_check)
                if left == right:
                    continue
                pair = (left, right) if left < right else (right, left)
                if pair not in edge_pairs and len(edge_pairs) >= max_edges:
                    edge_capped = True
                    continue
                edge_pairs.add(pair)
                adjacency[left][right] += 1
                adjacency[right][left] += 1

    edge_count = sum(len(neighbors) for neighbors in adjacency.values()) // 2
    if edge_count == 0:
        return TextRankResult({name: 0.0 for name in node_names}, False, True, 0, 0, node_capped, edge_capped)

    node_count = len(node_names)
    ranks = {name: 1.0 / node_count for name in node_names}
    converged = False
    iterations = 0
    for iterations in range(1, max_iterations + 1):
        _check_cancel(cancel_check)
        next_ranks: dict[str, float] = {}
        for node in node_names:
            incoming = 0.0
            for source in node_names:
                _check_cancel(cancel_check)
                weight = adjacency[source].get(node, 0)
                total_weight = sum(adjacency[source].values())
                if weight and total_weight:
                    incoming += ranks[source] * weight / total_weight
            next_ranks[node] = (1.0 - damping) / node_count + damping * incoming
        difference = max(abs(next_ranks[node] - ranks[node]) for node in node_names)
        ranks = next_ranks
        if difference <= tolerance:
            converged = True
            break

    maximum = max(ranks.values(), default=0.0)
    normalized = {node: (value / maximum if maximum else 0.0) for node, value in ranks.items()}
    return TextRankResult(normalized, True, converged, iterations, edge_count, node_capped, edge_capped)


def candidate_similarity(left: KeywordCandidate, right: KeywordCandidate) -> float:
    """Return the deterministic similarity used by MMR for two candidate terms."""
    left_term = normalize_term(left.term)
    right_term = normalize_term(right.term)
    if not left_term or not right_term:
        return 0.0
    left_tokens = _similarity_tokens(left_term)
    right_tokens = _similarity_tokens(right_term)
    token_union = left_tokens | right_tokens
    token_jaccard = len(left_tokens & right_tokens) / len(token_union) if token_union else 0.0
    left_bigrams = _bigrams(left_term)
    right_bigrams = _bigrams(right_term)
    bigram_union = left_bigrams | right_bigrams
    bigram_jaccard = len(left_bigrams & right_bigrams) / len(bigram_union) if bigram_union else 0.0
    containment = 1.0 if left_term in right_term or right_term in left_term else 0.0
    similarity = 0.45 * token_jaccard + 0.35 * bigram_jaccard + 0.20 * containment
    if left.dictionary_hit or right.dictionary_hit or left.kind == 'term' or right.kind == 'term':
        similarity *= 0.75
    return max(0.0, min(1.0, similarity))


def _rank_chunk(
    chunk: KeywordChunkInput,
    result: CandidateGenerationResult,
    df: Counter[str],
    document_size: int,
    config: HybridRankingConfig,
    tokenizer_name: str,
    tokenizer_version: str,
    dictionary_hash: str,
    stopword_hash: str,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[dict[str, Any], Counter[str]]:
    _check_cancel(cancel_check)
    local_counts = Counter()
    if result.candidate_capped:
        local_counts['candidateCappedChunks'] += 1

    candidates = _deduplicate_candidates(result.candidates)
    if not candidates:
        local_counts['emptyChunks'] += 1
        return _empty_output(chunk, result.search_tokens, tokenizer_name, tokenizer_version, dictionary_hash, stopword_hash), local_counts

    non_overlap_length = max(0, len(chunk.text) - chunk.overlap_chars)
    active: list[KeywordCandidate] = []
    for candidate in candidates:
        _check_cancel(cancel_check)
        if not _candidate_evidence_is_valid(candidate, chunk.text):
            local_counts['invalidEvidenceDiscarded'] += 1
            continue
        if _noise_penalty(candidate.term) >= 0.25:
            local_counts['noiseCandidatesDiscarded'] += 1
            continue
        overlap_only = _is_overlap_only(candidate, chunk.overlap_chars)
        if overlap_only and not (config.allow_overlap_fallback and non_overlap_length < 80):
            local_counts['overlapOnlyDiscarded'] += 1
            continue
        active.append(candidate)

    if not active:
        local_counts['emptyChunks'] += 1
        reason = 'OVERLAP_ONLY' if candidates else 'NO_VALID_CANDIDATE'
        return _empty_output(chunk, result.search_tokens, tokenizer_name, tokenizer_version, dictionary_hash, stopword_hash, reason), local_counts

    text_rank = compute_text_rank(
        active,
        window_size=config.window_size,
        damping=config.damping,
        max_iterations=config.max_iterations,
        tolerance=config.tolerance,
        cancel_check=cancel_check,
    )
    if text_rank.node_capped:
        local_counts['textRankNodeCappedChunks'] += 1
    if text_rank.edge_capped:
        local_counts['textRankEdgeCappedChunks'] += 1
    tfidf_values = _tfidf_values(active, chunk, df, document_size)
    max_tfidf = max((value[0] for value in tfidf_values.values()), default=0.0)
    max_idf = max(value[1] for value in tfidf_values.values()) if tfidf_values else 0.0
    section_text = _section_text(chunk.section_path)
    section_normalized = normalize_term(section_text)
    denominator = sum(config.weights[name] for name in _FEATURE_NAMES if name != 'textRank' or text_rank.available)
    available_weights = {
        name: config.weights[name] / denominator
        for name in _FEATURE_NAMES
        if name != 'textRank' or text_rank.available
    }
    scored: list[_ScoredCandidate] = []
    for candidate in active:
        _check_cancel(cancel_check)
        tf_value, idf_value = tfidf_values[candidate.normalized_term]
        overlap_only = _is_overlap_only(candidate, chunk.overlap_chars)
        features: dict[str, float | bool] = {
            'tfidf': _clamp((tf_value / max_tfidf if max_tfidf else 0.0) * (idf_value / max_idf if max_idf else 0.0)),
            'textRank': _clamp(_phrase_text_rank(candidate, active, text_rank.scores)) if text_rank.available else 0.0,
            'position': _position_score(candidate, chunk.text),
            'sentenceSpread': _sentence_spread(candidate, chunk.text),
            'sectionMatch': 1.0 if section_normalized and normalize_term(candidate.term) in section_normalized else 0.0,
            'termQuality': _term_quality(candidate),
            'domainBoost': bool(candidate.dictionary_hit),
            'overlapOnly': overlap_only,
        }
        overlap_penalty = 0.5 if overlap_only else 0.0
        df_ratio = df.get(candidate.normalized_term, 0) / max(1, document_size)
        boilerplate_penalty = _boilerplate_penalty(df_ratio, config.boilerplate_df_ratio)
        noise_penalty = _noise_penalty(candidate.term)
        if boilerplate_penalty > 0:
            local_counts['boilerplatePenalized'] += 1
        features.update({
            'overlapPenalty': overlap_penalty,
            'boilerplatePenalty': boilerplate_penalty,
            'noisePenalty': noise_penalty,
        })
        raw_score = sum(float(features[name]) * available_weights.get(name, 0.0) for name in available_weights)
        score = raw_score * (1.15 if candidate.dictionary_hit else 1.0)
        score *= 1.0 - overlap_penalty
        score *= 1.0 - boilerplate_penalty
        score *= 1.0 - noise_penalty
        scored.append(_ScoredCandidate(candidate, features, _clamp(score), _first_start(candidate)))

    selected, forced_top1 = _select_mmr(scored, config, len(chunk.text))
    if forced_top1:
        local_counts['forcedTop1Chunks'] += 1
    selected.sort(key=_score_sort_key)
    keywords = [
        _serialize_candidate(item, rank, forced_top1 and rank == 1)
        for rank, item in enumerate(selected, start=1)
    ]
    if not keywords:
        local_counts['emptyChunks'] += 1
    output = {
        'schemaVersion': KEYWORD_OUTPUT_SCHEMA_VERSION,
        'documentId': chunk.document_id,
        'chunkId': chunk.chunk_id,
        'parentChunkId': chunk.parent_chunk_id,
        'chunkContentHash': chunk_content_hash(chunk.text),
        'algorithm': {
            'name': 'hybrid-statistical',
            'version': HYBRID_KEYWORD_ALGORITHM_VERSION,
            'tokenizer': tokenizer_name,
            'tokenizerVersion': tokenizer_version,
            'dictionaryHash': dictionary_hash,
            'stopwordHash': stopword_hash,
        },
        # Compact surface terms are the stable input field for the future
        # semantic stage; keep the detailed `keywords` array for auditability.
        'keyword': [str(item['term']) for item in keywords],
        'searchTokens': list(result.search_tokens),
        'keywords': keywords,
        'emptyReason': None if keywords else ('EMPTY_TEXT' if not chunk.text.strip() else 'NO_VALID_CANDIDATE'),
    }
    validate_keyword_output(output, chunk, max_keywords=config.max_keywords)
    return output, local_counts


def _build_document_df(
    chunks: Sequence[KeywordChunkInput],
    candidate_results: Sequence[CandidateGenerationResult],
) -> tuple[dict[str, Counter[str]], Counter[str]]:
    df_by_document: dict[str, Counter[str]] = defaultdict(Counter)
    document_sizes: Counter[str] = Counter()
    for chunk, result in zip(chunks, candidate_results):
        if chunk.text.strip():
            document_sizes[chunk.document_id] += 1
        document_terms: set[str] = set()
        for candidate in _deduplicate_candidates(result.candidates):
            if not _candidate_evidence_is_valid(candidate, chunk.text):
                continue
            if any(occurrence.end > chunk.overlap_chars for occurrence in candidate.occurrences):
                document_terms.add(candidate.normalized_term)
        df_by_document[chunk.document_id].update(document_terms)
    return df_by_document, document_sizes


def _tfidf_values(
    candidates: Sequence[KeywordCandidate],
    chunk: KeywordChunkInput,
    df: Counter[str],
    document_size: int,
) -> dict[str, tuple[float, float]]:
    values: dict[str, tuple[float, float]] = {}
    for candidate in candidates:
        effective_count = sum(1 for occurrence in candidate.occurrences if occurrence.end > chunk.overlap_chars)
        count = effective_count or len(candidate.occurrences)
        tf = 1.0 + math.log(max(1, count))
        idf = math.log((max(1, document_size) + 1) / (df.get(candidate.normalized_term, 0) + 1)) + 1.0
        values[candidate.normalized_term] = (tf, idf)
    return values


def _select_mmr(scored: Sequence[_ScoredCandidate], config: HybridRankingConfig, text_length: int) -> tuple[list[_ScoredCandidate], bool]:
    ordered = sorted(scored, key=_score_sort_key)
    if not ordered:
        return [], False
    eligible = [item for item in ordered if item.score >= config.min_score]
    forced_top1 = False
    if not eligible:
        eligible = ordered[:1]
        forced_top1 = True
    # The adaptive limit follows the chunk text length, not the number of
    # candidates, so short noisy chunks cannot emit a long keyword list.
    limit = min(config.max_keywords, _adaptive_limit_from_text_length(text_length))
    selected: list[_ScoredCandidate] = []
    remaining = list(eligible)
    while remaining and len(selected) < limit:
        if not selected:
            chosen = remaining[0]
        else:
            chosen = max(
                remaining,
                key=lambda item: (
                    0.85 * item.score - 0.15 * max(candidate_similarity(item.candidate, previous.candidate) for previous in selected),
                    item.score,
                    -item.first_start,
                    item.candidate.normalized_term,
                ),
            )
        selected.append(chosen)
        remaining.remove(chosen)
    return selected, forced_top1


def _serialize_candidate(item: _ScoredCandidate, rank: int, forced_top1: bool) -> dict[str, Any]:
    features = {
        key: round(float(value), 4) if isinstance(value, (int, float)) else value
        for key, value in item.features.items()
    }
    return {
        'term': item.candidate.term,
        'normalizedTerm': item.candidate.normalized_term,
        'kind': item.candidate.kind if item.candidate.kind in {'word', 'phrase', 'term'} else 'term',
        'rank': rank,
        'score': round(item.score, 4),
        'occurrences': [
            {
                'start': occurrence.start,
                'end': occurrence.end,
                'sentenceIndex': occurrence.sentence_index,
            }
            for occurrence in item.candidate.occurrences
        ],
        'features': features,
        'forcedTop1': forced_top1,
    }


def _empty_output(
    chunk: KeywordChunkInput,
    search_tokens: Sequence[str],
    tokenizer_name: str,
    tokenizer_version: str,
    dictionary_hash: str,
    stopword_hash: str,
    reason: str | None = None,
) -> dict[str, Any]:
    output = {
        'schemaVersion': KEYWORD_OUTPUT_SCHEMA_VERSION,
        'documentId': chunk.document_id,
        'chunkId': chunk.chunk_id,
        'parentChunkId': chunk.parent_chunk_id,
        'chunkContentHash': chunk_content_hash(chunk.text),
        'algorithm': {
            'name': 'hybrid-statistical',
            'version': HYBRID_KEYWORD_ALGORITHM_VERSION,
            'tokenizer': tokenizer_name,
            'tokenizerVersion': tokenizer_version,
            'dictionaryHash': dictionary_hash,
            'stopwordHash': stopword_hash,
        },
        'keyword': [],
        'searchTokens': list(search_tokens),
        'keywords': [],
        'emptyReason': reason or ('EMPTY_TEXT' if not chunk.text.strip() else 'NO_VALID_CANDIDATE'),
    }
    validate_keyword_output(output, chunk)
    return output


def _deduplicate_candidates(candidates: Iterable[KeywordCandidate]) -> list[KeywordCandidate]:
    unique: dict[str, KeywordCandidate] = {}
    for candidate in candidates:
        normalized = normalize_term(candidate.normalized_term or candidate.term)
        if not normalized:
            continue
        existing = unique.get(normalized)
        if existing is None or _candidate_preferred(candidate, existing):
            candidate.normalized_term = normalized
            unique[normalized] = candidate
        elif candidate.dictionary_hit:
            existing.dictionary_hit = True
    return sorted(unique.values(), key=lambda item: (_first_start(item), item.normalized_term))


def _candidate_preferred(left: KeywordCandidate, right: KeywordCandidate) -> bool:
    return (
        len(left.occurrences),
        int(left.dictionary_hit),
        -_first_start(left),
        left.term,
    ) > (
        len(right.occurrences),
        int(right.dictionary_hit),
        -_first_start(right),
        right.term,
    )


def _candidate_evidence_is_valid(candidate: KeywordCandidate, text: str) -> bool:
    if not candidate.term or not candidate.occurrences:
        return False
    return all(
        0 <= occurrence.start < occurrence.end <= len(text)
        and text[occurrence.start:occurrence.end] == candidate.term
        for occurrence in candidate.occurrences
    )


def _is_overlap_only(candidate: KeywordCandidate, overlap_chars: int) -> bool:
    return bool(overlap_chars) and bool(candidate.occurrences) and all(
        occurrence.end <= overlap_chars for occurrence in candidate.occurrences
    )


def _first_start(candidate: KeywordCandidate) -> int:
    return min((occurrence.start for occurrence in candidate.occurrences), default=0)


def _score_sort_key(item: _ScoredCandidate) -> tuple[float, int, int, str]:
    return (-item.score, -int(item.candidate.dictionary_hit), item.first_start, item.candidate.normalized_term)


def _phrase_text_rank(candidate: KeywordCandidate, candidates: Sequence[KeywordCandidate], scores: Mapping[str, float]) -> float:
    direct = scores.get(candidate.normalized_term, 0.0)
    components = [
        scores[other.normalized_term]
        for other in candidates
        if other.normalized_term != candidate.normalized_term
        and len(other.normalized_term) >= 2
        and other.normalized_term in scores
        and other.normalized_term in candidate.normalized_term
    ]
    if components:
        return sum([direct, *components]) / (len(components) + 1)
    return direct


def _position_score(candidate: KeywordCandidate, text: str) -> float:
    if not text:
        return 0.0
    return _clamp(1.0 - (_first_start(candidate) / max(1, len(text))))


def _sentence_spread(candidate: KeywordCandidate, text: str) -> float:
    sentence_count = max(1, sum(1 for character in text if character in '。！？；.!?;\n\r') + 1)
    return _clamp(len({occurrence.sentence_index for occurrence in candidate.occurrences}) / sentence_count)


def _section_text(section_path: Sequence[Mapping[str, Any]]) -> str:
    values: list[str] = []
    for item in section_path:
        for key in ('title', 'text', 'name', 'label', 'heading'):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
        if len(' '.join(values)) >= MAX_SECTION_TEXT:
            break
    return ' '.join(values)[:MAX_SECTION_TEXT]


def _term_quality(candidate: KeywordCandidate) -> float:
    normalized = normalize_term(candidate.term)
    if candidate.kind == 'term' or TECHNICAL_TERM_RE.fullmatch(candidate.term):
        return 1.0
    if candidate.kind == 'phrase':
        return 0.95
    if CHINESE_ONLY_RE.fullmatch(normalized):
        return _clamp(0.65 + min(0.35, len(normalized) / 12))
    return 0.8


def _boilerplate_penalty(df_ratio: float, threshold: float) -> float:
    if df_ratio <= threshold:
        return 0.0
    if df_ratio < 0.9:
        return 0.2 * (df_ratio - threshold) / max(1e-9, 0.9 - threshold)
    return 0.25


def _noise_penalty(term: str) -> float:
    if not term or any(not character.isprintable() for character in term):
        return 0.25
    if REPEATED_CHARACTER_RE.search(term):
        return 0.25
    normalized = normalize_term(term)
    has_alpha = any(character.isalpha() for character in normalized)
    has_digit = any(character.isdigit() for character in normalized)
    if has_alpha and has_digit and not TECHNICAL_TERM_RE.fullmatch(term):
        return 0.15
    if len(normalized) > 40:
        return 0.1
    return 0.0


def _similarity_tokens(term: str) -> set[str]:
    tokens: set[str] = set()
    for value in TOKEN_RE.findall(term):
        if CHINESE_ONLY_RE.fullmatch(value):
            tokens.update(value)
        else:
            tokens.add(value)
    return tokens


def _bigrams(term: str) -> set[str]:
    compact = re.sub(r'\s+', '', term)
    if len(compact) < 2:
        return {compact} if compact else set()
    return {compact[index:index + 2] for index in range(len(compact) - 1)}


def _adaptive_limit_from_text_length(length: int) -> int:
    if length <= 160:
        return 3
    if length <= 480:
        return 5
    if length <= 900:
        return 8
    return 10


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _check_cancel(cancel_check: Callable[[], bool] | None) -> None:
    if cancel_check is not None and cancel_check():
        raise KeywordRankingCancelled()


def _config_to_json(config: HybridRankingConfig) -> dict[str, Any]:
    return {
        'minScore': config.min_score,
        'minKeywords': config.min_keywords,
        'maxKeywords': config.max_keywords,
        'textRank': {
            'windowSize': config.window_size,
            'damping': config.damping,
            'maxIterations': config.max_iterations,
            'tolerance': config.tolerance,
        },
        'boilerplateDfRatio': config.boilerplate_df_ratio,
        'allowOverlapFallback': config.allow_overlap_fallback,
        'weights': dict(config.weights or {}),
    }
