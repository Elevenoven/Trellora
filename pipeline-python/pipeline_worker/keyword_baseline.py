from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .keyword_contract import (
    KEYWORD_BASELINE_ALGORITHM_VERSION,
    KEYWORD_OUTPUT_SCHEMA_VERSION,
    KeywordChunkInput,
    canonical_json,
    chunk_content_hash,
    normalize_term,
    parse_keyword_chunks,
    validate_keyword_output,
)


BASELINE_STOPWORDS = frozenset({
    '的', '了', '是', '和', '在', '与', '及', '为', '将', '从', '到', '对', '把', '由', '本', '该',
    '需要', '通过', '用于', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'is', 'to',
})
ASCII_TOKEN = re.compile(r'[A-Za-z][A-Za-z0-9]*(?:[._+#/-][A-Za-z0-9]+)*')
CHINESE_RUN = re.compile(r'[\u3400-\u9fff]+')
NOISE_RE = re.compile(r'(.)\1{3,}')


@dataclass(frozen=True)
class _Occurrence:
    start: int
    end: int
    sentence_index: int


@dataclass
class _Candidate:
    term: str
    normalized_term: str
    kind: str
    occurrences: list[_Occurrence]


def extract_tfidf_baseline(chunks: Sequence[KeywordChunkInput], max_keywords: int = 10, min_score: float = 0.28) -> list[dict[str, Any]]:
    """Return a deterministic, intentionally small TF-IDF-only reference baseline."""
    candidate_maps = [_collect_candidates(chunk.text) for chunk in chunks]
    document_indexes: dict[str, list[int]] = defaultdict(list)
    for index, chunk in enumerate(chunks):
        document_indexes[chunk.document_id].append(index)
    document_frequencies: dict[str, Counter[str]] = {}
    document_counts: dict[str, int] = {}
    for document_id, indexes in document_indexes.items():
        frequency: Counter[str] = Counter()
        for index in indexes:
            frequency.update(candidate_maps[index].keys())
        document_frequencies[document_id] = frequency
        document_counts[document_id] = max(1, len(indexes))

    outputs: list[dict[str, Any]] = []
    for chunk, candidates in zip(chunks, candidate_maps):
        document_frequency = document_frequencies[chunk.document_id]
        document_count = document_counts[chunk.document_id]
        scores: list[tuple[float, str, _Candidate, float]] = []
        for normalized, candidate in candidates.items():
            count = len(candidate.occurrences)
            tf = 1.0 + math.log(count)
            idf = math.log((document_count + 1) / (document_frequency[normalized] + 1)) + 1.0
            scores.append((tf * idf, normalized, candidate, tf * idf))
        maximum = max((score[0] for score in scores), default=0.0)
        ranked = sorted(
            ((score / maximum if maximum else 0.0, normalized, candidate) for _raw, normalized, candidate, score in scores),
            key=lambda item: (-item[0], -len(item[1]), item[1], item[2].occurrences[0].start),
        )
        limit = min(max_keywords, _adaptive_limit(len(chunk.text)))
        selected = ranked[:limit]
        if selected and all(score < min_score for score, _normalized, _candidate in selected):
            selected = selected[:1]
        output_keywords = []
        for rank, (score, _normalized, candidate) in enumerate(selected, start=1):
            output_keywords.append({
                'term': candidate.term,
                'normalizedTerm': candidate.normalized_term,
                'kind': candidate.kind if candidate.kind in {'word', 'phrase', 'term'} else 'term',
                'rank': rank,
                'score': round(max(0.0, min(1.0, score)), 4),
                'occurrences': [
                    {'start': occurrence.start, 'end': occurrence.end, 'sentenceIndex': occurrence.sentence_index}
                    for occurrence in candidate.occurrences
                ],
                'features': {
                    'tfidf': round(max(0.0, min(1.0, score)), 4),
                    'textRank': 0.0,
                    'position': 0.0,
                    'sentenceSpread': 0.0,
                    'sectionMatch': 0.0,
                    'termQuality': 0.0,
                    'domainBoost': False,
                    'overlapOnly': bool(chunk.overlap_chars and all(item.end <= chunk.overlap_chars for item in candidate.occurrences)),
                },
                'forcedTop1': bool(selected and rank == 1 and score < min_score),
            })
        output: dict[str, Any] = {
            'schemaVersion': KEYWORD_OUTPUT_SCHEMA_VERSION,
            'documentId': chunk.document_id,
            'chunkId': chunk.chunk_id,
            'parentChunkId': chunk.parent_chunk_id,
            'chunkContentHash': chunk_content_hash(chunk.text),
            'algorithm': {
                'name': 'tfidf-baseline',
                'version': KEYWORD_BASELINE_ALGORITHM_VERSION,
                'tokenizer': 'deterministic-regex',
                'tokenizerVersion': 'baseline-1',
                'dictionaryHash': 'none',
                'stopwordHash': hashlib.sha256(canonical_json(sorted(BASELINE_STOPWORDS)).encode('utf-8')).hexdigest(),
            },
            'keyword': [str(item['term']) for item in output_keywords],
            'searchTokens': _baseline_search_tokens(chunk.text),
            'keywords': output_keywords,
            'emptyReason': None if output_keywords else ('EMPTY_TEXT' if not chunk.text.strip() else 'NO_VALID_CANDIDATE'),
        }
        validate_keyword_output(output, chunk, max_keywords=max_keywords)
        outputs.append(output)
    return outputs


def evaluate_baseline(fixtures: Sequence[Mapping[str, Any]], max_keywords: int = 10, min_score: float = 0.28) -> dict[str, Any]:
    chunks = parse_keyword_chunks([_fixture_to_chunk(item, index) for index, item in enumerate(fixtures)])
    started = time.perf_counter()
    first_outputs = extract_tfidf_baseline(chunks, max_keywords=max_keywords, min_score=min_score)
    duration_ms = (time.perf_counter() - started) * 1000
    second_outputs = extract_tfidf_baseline(chunks, max_keywords=max_keywords, min_score=min_score)
    first_serialized = canonical_json(first_outputs)
    second_serialized = canonical_json(second_outputs)
    predictions = [
        {normalize_term(str(item['term'])) for item in output['keywords'][:5]}
        for output in first_outputs
    ]
    expected = [{normalize_term(str(term)) for term in item.get('expectedTerms', [])} for item in fixtures]
    precision, recall, f1 = _precision_recall_f1(predictions, expected)
    occurrence_total = sum(len(item['occurrences']) for output in first_outputs for item in output['keywords'])
    valid_occurrences = sum(
        1
        for output, chunk in zip(first_outputs, chunks)
        for item in output['keywords']
        for occurrence in item['occurrences']
        if chunk.text[occurrence['start']:occurrence['end']] == item['term']
    )
    return {
        'schemaVersion': 1,
        'stage': 'keywords-baseline',
        'algorithmVersion': KEYWORD_BASELINE_ALGORITHM_VERSION,
        'fixtureCount': len(fixtures),
        'durationMs': round(duration_ms, 3),
        'avgMsPerChunk': round(duration_ms / len(chunks), 3) if chunks else 0.0,
        'precisionAt5': round(precision, 4),
        'recallAt5': round(recall, 4),
        'f1At5': round(f1, 4),
        'offsetAccuracy': round(valid_occurrences / occurrence_total, 4) if occurrence_total else 1.0,
        'deterministic': first_serialized == second_serialized,
        'outputsSha256': hashlib.sha256(first_serialized.encode('utf-8')).hexdigest(),
        'emptyChunks': sum(1 for output in first_outputs if not output['keywords']),
        'keywordCount': sum(len(output['keywords']) for output in first_outputs),
    }


def _collect_candidates(text: str) -> dict[str, _Candidate]:
    candidates: dict[str, _Candidate] = {}
    for match in ASCII_TOKEN.finditer(text):
        _add_candidate(candidates, match.group(0), match.start(), match.end(), text, 'term')
    for match in CHINESE_RUN.finditer(text):
        value = match.group(0)
        if _is_noise(value):
            continue
        _add_candidate(candidates, value, match.start(), match.end(), text, 'phrase')
        for size in (2, 3):
            for offset in range(0, len(value) - size + 1):
                start = match.start() + offset
                end = start + size
                _add_candidate(candidates, text[start:end], start, end, text, 'word' if size == 2 else 'phrase')
    if len(candidates) > 256:
        ordered = sorted(candidates.values(), key=lambda item: (-len(item.occurrences), item.occurrences[0].start, item.normalized_term))[:256]
        return {item.normalized_term: item for item in ordered}
    return candidates


def _baseline_search_tokens(text: str) -> list[str]:
    matches = [*ASCII_TOKEN.finditer(text), *CHINESE_RUN.finditer(text)]
    return [
        normalize_term(match.group(0))
        for match in sorted(matches, key=lambda item: (item.start(), item.end()))
        if normalize_term(match.group(0)) not in BASELINE_STOPWORDS
        and not _is_noise(match.group(0))
    ]


def _add_candidate(candidates: dict[str, _Candidate], term: str, start: int, end: int, text: str, kind: str) -> None:
    normalized = normalize_term(term)
    if not normalized or normalized in BASELINE_STOPWORDS or len(normalized) < 2 or not term.strip() or _is_noise(term):
        return
    candidate = candidates.setdefault(normalized, _Candidate(term=term, normalized_term=normalized, kind=kind, occurrences=[]))
    if not candidate.occurrences:
        candidate.term = term
        candidate.kind = kind
    candidate.occurrences.append(_Occurrence(start, end, _sentence_index(text, start)))


def _sentence_index(text: str, offset: int) -> int:
    return sum(1 for character in text[:offset] if character in '。！？；.!?;\n')


def _is_noise(value: str) -> bool:
    printable = sum(1 for character in value if character.isprintable())
    return not printable or printable / max(1, len(value)) < 0.75 or bool(NOISE_RE.search(value))


def _adaptive_limit(length: int) -> int:
    if length <= 160:
        return 3
    if length <= 480:
        return 5
    if length <= 900:
        return 8
    return 10


def _precision_recall_f1(predictions: Iterable[set[str]], expected: Iterable[set[str]]) -> tuple[float, float, float]:
    precision_values: list[float] = []
    recall_values: list[float] = []
    for predicted, target in zip(predictions, expected):
        precision_values.append(len(predicted & target) / max(1, len(predicted)))
        recall_values.append(len(predicted & target) / max(1, len(target)))
    precision = sum(precision_values) / len(precision_values) if precision_values else 0.0
    recall = sum(recall_values) / len(recall_values) if recall_values else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


def _fixture_to_chunk(item: Mapping[str, Any], index: int) -> dict[str, Any]:
    fixture_id = str(item.get('id') or f'fixture-{index + 1:03d}')
    schema_version = int(item.get('schemaVersion', 2))
    return {
        'schemaVersion': schema_version,
        'documentId': str(item.get('documentId') or f'doc-{fixture_id.split("-")[0]}'),
        'chunkId': str(item.get('chunkId') or f'c-{fixture_id}'),
        'parentChunkId': item.get('parentChunkId', None if schema_version == 1 else f'p-{fixture_id}'),
        'ordinal': int(item.get('ordinal', index + 1)),
        'text': str(item.get('text') or ''),
        'sectionPath': item.get('sectionPath') or [],
        'nodeIds': item.get('nodeIds') or [],
        'sourceRefs': item.get('sourceRefs') or [{'fixture': fixture_id}],
        'overlapFromChunkId': item.get('overlapFromChunkId'),
        'overlapChars': int(item.get('overlapChars', 0)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='生成关键词 TF-IDF baseline 评测报告。')
    parser.add_argument('--fixtures', required=True, help='fixture JSON 文件路径')
    parser.add_argument('--report', required=True, help='报告输出路径')
    args = parser.parse_args()
    fixtures = json.loads(Path(args.fixtures).read_text(encoding='utf-8'))
    if not isinstance(fixtures, list):
        raise SystemExit('fixture 文件必须是 JSON 数组。')
    report = evaluate_baseline(fixtures)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
