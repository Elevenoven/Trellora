from __future__ import annotations

import hashlib
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable, Iterable, Mapping

from .stage_errors import StageCancelled, StageError
from .keyword_candidates import (
    MAX_CANDIDATES_PER_CHUNK,
    MAX_NGRAM,
    MAX_TEXT_CHARACTERS,
    CandidateGenerationResult,
    KeywordCandidate,
    KeywordCandidateError,
    generate_candidates,
    load_builtin_stopwords,
    normalize_stopwords,
)
from .keyword_contract import KeywordChunkInput, KeywordContractError, canonical_json, parse_keyword_chunk
from .keyword_ranker import (
    HYBRID_KEYWORD_ALGORITHM_VERSION,
    HybridRankingConfig,
    KeywordRankingCancelled,
    rank_keyword_chunk,
)
from .keyword_tokenizer import (
    KeywordTokenizerConfigError,
    KeywordTokenizerUnavailable,
    create_keyword_tokenizer,
    dictionary_hash,
    normalize_dictionary_terms,
)


KEYWORDS_STAGE_SCHEMA_VERSION = 3
CHECKPOINT_INTERVAL = 50
MAX_DF_KEYS = 200_000
MAX_DICTIONARY_HASH_INPUT = 5_000
MAX_CHECKPOINT_IDS = 50_000


def run_keywords_stage(
    input_path: str,
    output_dir: str,
    options: Mapping[str, Any] | None,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    """Run the bounded two-pass keywords stage over a chunks JSONL artifact."""
    normalized_options = dict(options or {})
    output = Path(output_dir)
    source = _resolve_chunks_path(input_path)
    try:
        output.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise StageError('KEYWORDS_WRITE_FAILED', f'关键词阶段输出目录不可写：{exc}', True) from exc

    stage_key = str(stage_key or normalized_options.get('stageKey') or '')
    raw_config = normalized_options.get('config')
    if raw_config is None:
        config_record: dict[str, Any] = {}
    elif isinstance(raw_config, dict):
        config_record = raw_config
    else:
        raise StageError('KEYWORDS_CONFIG_INVALID', '关键词配置必须是 JSON 对象。', False)
    enabled = config_record.get('enabled', True) is not False
    if not enabled:
        try:
            return _write_disabled_stage(output, stage_key, config_record, progress)
        except OSError as exc:
            raise StageError('KEYWORDS_WRITE_FAILED', f'关键词阶段写入失败：{exc}', True) from exc
    if not source.is_file():
        raise StageError('KEYWORDS_INPUT_NOT_FOUND', '结构切块产物 chunks.jsonl 不存在，无法提取关键词。', False)

    config, max_candidates, ngram_min, ngram_max, max_text_characters = _normalize_stage_config(config_record)
    try:
        dictionary_terms = normalize_dictionary_terms(_option_list(normalized_options, 'dictionaryTerms', 'businessDictionary'))
        builtin_stopwords = load_builtin_stopwords()
        custom_stopwords = _option_list(normalized_options, 'stopwords')
        stopwords = normalize_stopwords((*builtin_stopwords, *custom_stopwords))
        tokenizer_name = str(normalized_options.get('tokenizer') or config_record.get('tokenizer') or 'jieba')
        tokenizer = create_keyword_tokenizer(tokenizer_name, dictionary_terms)
    except KeywordTokenizerUnavailable as exc:
        raise StageError(exc.code, str(exc), False) from exc
    except (KeywordTokenizerConfigError, KeywordCandidateError) as exc:
        raise StageError(getattr(exc, 'code', 'KEYWORDS_CONFIG_INVALID'), str(exc), False) from exc

    tokenizer_version = str(getattr(tokenizer, 'version', 'unresolved'))
    stopword_hash = _hash_terms(stopwords)
    business_dictionary_hash = dictionary_hash(dictionary_terms)
    document_id_expected = normalized_options.get('documentId')

    checkpoint_path = output / 'checkpoint.json'
    candidate_partial_path = output / 'keyword-candidates.partial.jsonl'
    keywords_path = output / 'keywords.jsonl'
    checkpoint = _read_checkpoint(checkpoint_path, stage_key)
    if checkpoint is None or checkpoint.get('complete'):
        _reset_stage_outputs(candidate_partial_path, keywords_path)
        checkpoint = None

    try:
        if checkpoint and checkpoint.get('phase') == 'rank' and candidate_partial_path.is_file():
            df_state = _restore_df_state(checkpoint.get('dfState'))
            document_sizes = Counter({str(key): int(value) for key, value in (checkpoint.get('documentSizes') or {}).items()})
            collect_counts = Counter(checkpoint.get('stats') or {})
            collect_counts['chunks'] = int(checkpoint.get('chunks') or collect_counts.get('chunks', 0))
            _truncate_file(keywords_path, int(checkpoint.get('keywordOutputBytes') or 0))
            rank_start_ordinal = int(checkpoint.get('lastOrdinal') or 0)
        else:
            df_state, document_sizes, collect_counts = _collect_candidates(
                source,
                candidate_partial_path,
                checkpoint if checkpoint and checkpoint.get('phase') == 'collect' else None,
                stage_key,
                document_id_expected,
                tokenizer,
                dictionary_terms,
                stopwords,
                ngram_min,
                ngram_max,
                max_candidates,
                max_text_characters,
                cancel_event,
                progress,
                checkpoint_path,
            )
            rank_start_ordinal = -1
            _write_checkpoint(
                checkpoint_path,
                _checkpoint_payload(
                    stage_key=stage_key,
                    phase='rank',
                    last_ordinal=-1,
                    input_bytes=source.stat().st_size,
                    candidate_output_bytes=candidate_partial_path.stat().st_size,
                    keyword_output_bytes=0,
                    chunks=int(collect_counts.get('chunks', 0)),
                    ranked_chunks=0,
                    df_state=df_state,
                    document_sizes=document_sizes,
                    stats=collect_counts,
                    seen_chunk_ids=[],
                    complete=False,
                ),
            )

        rank_counts = _rank_candidates(
            candidate_partial_path,
            keywords_path,
            checkpoint_path,
            checkpoint if checkpoint and checkpoint.get('phase') == 'rank' else _read_checkpoint(checkpoint_path, stage_key),
            stage_key,
            df_state,
            document_sizes,
            collect_counts,
            rank_start_ordinal,
            config,
            tokenizer_name,
            tokenizer_version,
            business_dictionary_hash,
            stopword_hash,
            cancel_event,
            progress,
        )
        counts = dict(rank_counts)
        report = {
            'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
            'stage': 'keywords',
            'stageKey': stage_key,
            'algorithmVersion': HYBRID_KEYWORD_ALGORITHM_VERSION,
            'algorithm': {
                'name': 'hybrid-statistical',
                'version': HYBRID_KEYWORD_ALGORITHM_VERSION,
                'tokenizer': getattr(tokenizer, 'name', tokenizer_name),
                'tokenizerVersion': tokenizer_version,
                'dictionaryHash': business_dictionary_hash,
                'stopwordHash': stopword_hash,
            },
            'config': _config_to_json(config_record, config, max_candidates, ngram_min, ngram_max, max_text_characters),
            'counts': counts,
            'distribution': {
                'minKeywordsPerChunk': int(rank_counts.get('minKeywordsPerChunk', 0)),
                'avgKeywordsPerChunk': round(float(rank_counts.get('keywords', 0)) / max(1, int(rank_counts.get('chunks', 0))), 4),
                'maxKeywordsPerChunk': int(rank_counts.get('maxKeywordsPerChunk', 0)),
            },
            'generatedAt': _now(),
        }
        _write_json(output / 'keyword-report.json', report)
        _write_json(output / 'stage-manifest.json', {
            'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
            'stage': 'keywords',
            'stageKey': stage_key,
            'artifacts': ['keywords.jsonl', 'keyword-report.json', 'checkpoint.json'],
            'generatedAt': report['generatedAt'],
        })
        final_checkpoint = _read_checkpoint(checkpoint_path, stage_key) or {}
        final_checkpoint.update({
            'phase': 'rank',
            'stage': 'keywords',
            'stageKey': stage_key,
            'complete': True,
            'keywordOutputBytes': keywords_path.stat().st_size if keywords_path.exists() else 0,
            'updatedAt': _now(),
        })
        _write_checkpoint(checkpoint_path, final_checkpoint)
        candidate_partial_path.unlink(missing_ok=True)
        progress(int(rank_counts.get('chunks', 0)), int(rank_counts.get('chunks', 0)), 'chunk', f'关键词阶段完成，共 {rank_counts.get("keywords", 0)} 个关键词。')
        return counts
    except StageCancelled:
        raise
    except KeywordRankingCancelled as exc:
        raise StageCancelled() from exc
    except (KeywordContractError, KeywordCandidateError, KeywordTokenizerConfigError) as exc:
        raise StageError(getattr(exc, 'code', 'KEYWORDS_INPUT_INVALID'), str(exc), False) from exc
    except KeywordTokenizerUnavailable as exc:
        raise StageError(exc.code, str(exc), False) from exc
    except StageError:
        raise
    except OSError as exc:
        raise StageError('KEYWORDS_WRITE_FAILED', f'关键词阶段写入失败：{exc}', True) from exc
    except Exception as exc:
        raise StageError('KEYWORDS_WRITE_FAILED', f'关键词阶段执行失败：{exc}', True) from exc


def _collect_candidates(
    source: Path,
    partial_path: Path,
    checkpoint: dict[str, Any] | None,
    stage_key: str,
    document_id_expected: Any,
    tokenizer: Any,
    dictionary_terms: tuple[str, ...],
    stopwords: tuple[str, ...],
    ngram_min: int,
    ngram_max: int,
    max_candidates: int,
    max_text_characters: int,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    checkpoint_path: Path,
) -> tuple[dict[str, Counter[str]], Counter[str], Counter[str]]:
    resume_input_bytes = int(checkpoint.get('inputBytes') or 0) if checkpoint else 0
    resume_output_bytes = int(checkpoint.get('candidateOutputBytes') or 0) if checkpoint else 0
    if resume_input_bytes < 0 or resume_input_bytes > source.stat().st_size or not partial_path.is_file():
        resume_input_bytes = 0
        resume_output_bytes = 0
        checkpoint = None
    _truncate_file(partial_path, resume_output_bytes)
    df_state = _restore_df_state(checkpoint.get('dfState')) if checkpoint else defaultdict(Counter)
    document_sizes = Counter({str(key): int(value) for key, value in (checkpoint.get('documentSizes') or {}).items()}) if checkpoint else Counter()
    stats = Counter(checkpoint.get('stats') or {}) if checkpoint else Counter()
    seen_chunk_ids = set(str(value) for value in (checkpoint.get('seenChunkIds') or [])) if checkpoint else set()
    processed_chunks = int(checkpoint.get('chunks') or stats.get('chunks', 0)) if checkpoint else int(stats.get('chunks', 0))
    input_bytes = resume_input_bytes
    total_chunks = _count_nonempty_lines(source)
    mode = 'ab' if resume_input_bytes else 'wb'

    with source.open('rb') as source_stream, partial_path.open(mode) as destination:
        if resume_input_bytes:
            source_stream.seek(resume_input_bytes)
        while True:
            _raise_if_cancelled(cancel_event)
            raw_line = source_stream.readline()
            if not raw_line:
                break
            input_bytes += len(raw_line)
            if not raw_line.strip():
                continue
            chunk = _parse_chunk_line(raw_line, processed_chunks + 1, document_id_expected)
            if chunk.chunk_id in seen_chunk_ids:
                raise StageError('KEYWORDS_INPUT_INVALID', f'chunkId 重复：{chunk.chunk_id}。', False)
            seen_chunk_ids.add(chunk.chunk_id)
            if len(seen_chunk_ids) > MAX_CHECKPOINT_IDS:
                raise StageError('KEYWORDS_RESOURCE_LIMIT', '关键词阶段 chunkId 数量超过资源上限。', False)
            if len(chunk.text) > max_text_characters:
                raise StageError('KEYWORDS_RESOURCE_LIMIT', f'子块正文超过关键词阶段字符上限：{chunk.chunk_id}。', False)
            try:
                result = generate_candidates(
                    chunk.text,
                    tokenizer,
                    dictionary_terms=dictionary_terms,
                    stopwords=stopwords,
                    ngram_min=ngram_min,
                    ngram_max=ngram_max,
                    max_candidates=max_candidates,
                    max_text_characters=max_text_characters,
                )
            except KeywordTokenizerUnavailable:
                raise
            except KeywordCandidateError:
                raise
            _write_partial_record(destination, chunk, result)
            processed_chunks += 1
            document_sizes[chunk.document_id] += 1
            _update_df(df_state, chunk, result)
            stats['chunks'] = processed_chunks
            stats['candidateRecords'] = stats.get('candidateRecords', 0) + len(result.candidates)
            stats['candidateCountBeforeCap'] = stats.get('candidateCountBeforeCap', 0) + result.candidate_count_before_cap
            if result.candidate_capped:
                stats['candidateCappedChunks'] += 1
            if processed_chunks % CHECKPOINT_INTERVAL == 0:
                destination.flush()
                _write_checkpoint(checkpoint_path, _checkpoint_payload(
                    stage_key=stage_key,
                    phase='collect',
                    last_ordinal=chunk.ordinal,
                    input_bytes=input_bytes,
                    candidate_output_bytes=destination.tell(),
                    keyword_output_bytes=0,
                    chunks=processed_chunks,
                    ranked_chunks=0,
                    df_state=df_state,
                    document_sizes=document_sizes,
                    stats=stats,
                    seen_chunk_ids=seen_chunk_ids,
                    complete=False,
                ))
                progress(processed_chunks, total_chunks or None, 'candidate', f'关键词候选生成已处理 {processed_chunks} 个子块。')
        destination.flush()
        os.fsync(destination.fileno())
    return df_state, document_sizes, stats


def _rank_candidates(
    partial_path: Path,
    keywords_path: Path,
    checkpoint_path: Path,
    checkpoint: dict[str, Any] | None,
    stage_key: str,
    df_state: dict[str, Counter[str]],
    document_sizes: Counter[str],
    base_counts: Counter[str],
    rank_start_ordinal: int,
    config: HybridRankingConfig,
    tokenizer_name: str,
    tokenizer_version: str,
    dictionary_hash_value: str,
    stopword_hash: str,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
) -> Counter[str]:
    _truncate_file(keywords_path, int(checkpoint.get('keywordOutputBytes') or 0) if checkpoint and checkpoint.get('phase') == 'rank' else 0)
    counts = Counter(base_counts)
    counts.setdefault('chunks', int(base_counts.get('chunks', 0)))
    counts.setdefault('keywords', 0)
    counts.setdefault('emptyChunks', 0)
    counts.setdefault('forcedTop1Chunks', 0)
    counts.setdefault('overlapOnlyDiscarded', 0)
    counts.setdefault('boilerplatePenalized', 0)
    counts.setdefault('noiseCandidatesDiscarded', 0)
    counts.setdefault('invalidEvidenceDiscarded', 0)
    counts.setdefault('candidateCappedChunks', 0)
    counts.setdefault('textRankNodeCappedChunks', 0)
    counts.setdefault('textRankEdgeCappedChunks', 0)
    counts.setdefault('minKeywordsPerChunk', 0)
    counts.setdefault('maxKeywordsPerChunk', 0)
    counts.setdefault('keywordOutputBytes', 0)
    ranked_chunks = int(checkpoint.get('rankedChunks') or 0) if checkpoint and checkpoint.get('phase') == 'rank' else 0
    total_chunks = int(counts.get('chunks', 0))
    mode = 'ab' if keywords_path.exists() and keywords_path.stat().st_size else 'wb'
    with partial_path.open('r', encoding='utf-8') as source, keywords_path.open(mode) as destination:
        for raw_line in source:
            _raise_if_cancelled(cancel_event)
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise StageError('KEYWORDS_INPUT_INVALID', f'候选临时产物 JSON 无效：{exc}', False) from exc
            if not isinstance(record, dict):
                raise StageError('KEYWORDS_INPUT_INVALID', '候选临时产物记录必须是对象。', False)
            chunk = parse_keyword_chunk(record.get('chunk') if isinstance(record.get('chunk'), dict) else {})
            if chunk.ordinal <= rank_start_ordinal:
                continue
            candidates = _deserialize_candidates(record.get('candidates'))
            result = CandidateGenerationResult(
                tuple(candidates),
                int(record.get('candidateCountBeforeCap') or len(candidates)),
                bool(record.get('candidateCapped')),
                int(record.get('discardedCandidates') or 0),
                int(record.get('dictionaryHits') or 0),
                _deserialize_search_tokens(record.get('searchTokens')),
            )
            try:
                output, local_counts = rank_keyword_chunk(
                    chunk,
                    result,
                    df_state.get(chunk.document_id, Counter()),
                    document_sizes.get(chunk.document_id, 1),
                    config=config,
                    tokenizer_name=tokenizer_name,
                    tokenizer_version=tokenizer_version,
                    dictionary_hash=dictionary_hash_value,
                    stopword_hash=stopword_hash,
                    cancel_check=cancel_event.is_set,
                )
            except KeywordRankingCancelled as exc:
                raise StageCancelled() from exc
            encoded = (json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
            destination.write(encoded)
            ranked_chunks += 1
            counts['keywords'] += len(output['keywords'])
            counts.update(local_counts)
            counts['minKeywordsPerChunk'] = min(counts.get('minKeywordsPerChunk', len(output['keywords'])), len(output['keywords'])) if ranked_chunks > 1 else len(output['keywords'])
            counts['maxKeywordsPerChunk'] = max(counts.get('maxKeywordsPerChunk', 0), len(output['keywords']))
            if not output['keywords']:
                counts['emptyChunks'] += 1
            if ranked_chunks % CHECKPOINT_INTERVAL == 0:
                destination.flush()
                output_bytes = destination.tell()
                counts['keywordOutputBytes'] = output_bytes
                _write_checkpoint(checkpoint_path, _checkpoint_payload(
                    stage_key=stage_key,
                    phase='rank',
                    last_ordinal=chunk.ordinal,
                    input_bytes=0,
                    candidate_output_bytes=partial_path.stat().st_size,
                    keyword_output_bytes=output_bytes,
                    chunks=total_chunks,
                    ranked_chunks=ranked_chunks,
                    df_state=df_state,
                    document_sizes=document_sizes,
                    stats=counts,
                    seen_chunk_ids=[],
                    complete=False,
                ))
                progress(ranked_chunks, total_chunks or None, 'rank', f'关键词评分已处理 {ranked_chunks} 个子块。')
        destination.flush()
        os.fsync(destination.fileno())
        counts['keywordOutputBytes'] = destination.tell()
        if ranked_chunks and ranked_chunks % CHECKPOINT_INTERVAL:
            progress(ranked_chunks, total_chunks or None, 'rank', f'关键词评分已处理 {ranked_chunks} 个子块。')
    return counts


def _parse_chunk_line(raw_line: bytes, line_no: int, expected_document_id: Any) -> KeywordChunkInput:
    try:
        value = json.loads(raw_line.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StageError('KEYWORDS_INPUT_INVALID', f'第 {line_no} 个 chunk JSON 无效。', False) from exc
    if not isinstance(value, dict):
        raise StageError('KEYWORDS_INPUT_INVALID', f'第 {line_no} 个 chunk 必须是 JSON 对象。', False)
    try:
        chunk = parse_keyword_chunk(value)
    except KeywordContractError as exc:
        raise StageError('KEYWORDS_INPUT_INVALID', str(exc), False) from exc
    if expected_document_id is not None and str(expected_document_id) and chunk.document_id != str(expected_document_id):
        raise StageError('KEYWORDS_INPUT_INVALID', f'chunk {chunk.chunk_id} 的 documentId 与任务不一致。', False)
    return chunk


def _write_partial_record(destination: Any, chunk: KeywordChunkInput, result: CandidateGenerationResult) -> None:
    record = {
        'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
        'chunk': _chunk_to_dict(chunk),
        'candidateCountBeforeCap': result.candidate_count_before_cap,
        'candidateCapped': result.candidate_capped,
        'discardedCandidates': result.discarded_candidates,
        'dictionaryHits': result.dictionary_hits,
        'searchTokens': list(result.search_tokens),
        'candidates': [_candidate_to_dict(candidate) for candidate in result.candidates],
    }
    destination.write((json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))


def _candidate_to_dict(candidate: KeywordCandidate) -> dict[str, Any]:
    return {
        'term': candidate.term,
        'normalizedTerm': candidate.normalized_term,
        'kind': candidate.kind,
        'dictionaryHit': candidate.dictionary_hit,
        'occurrences': [
            {
                'start': occurrence.start,
                'end': occurrence.end,
                'sentenceIndex': occurrence.sentence_index,
            }
            for occurrence in candidate.occurrences
        ],
    }


def _deserialize_candidates(value: Any) -> list[KeywordCandidate]:
    if not isinstance(value, list):
        raise StageError('KEYWORDS_INPUT_INVALID', '候选临时产物缺少 candidates 数组。', False)
    candidates: list[KeywordCandidate] = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get('term'), str) or not isinstance(item.get('occurrences'), list):
            raise StageError('KEYWORDS_INPUT_INVALID', '候选临时产物包含非法候选。', False)
        try:
            from .keyword_candidates import CandidateOccurrence
            occurrences = [
                CandidateOccurrence(int(value['start']), int(value['end']), int(value.get('sentenceIndex', 0)))
                for value in item['occurrences']
                if isinstance(value, dict)
            ]
        except (KeyError, TypeError, ValueError) as exc:
            raise StageError('KEYWORDS_INPUT_INVALID', '候选临时产物 occurrence 非法。', False) from exc
        candidates.append(KeywordCandidate(
            term=item['term'],
            normalized_term=str(item.get('normalizedTerm') or item['term']),
            kind=str(item.get('kind') or 'term'),
            occurrences=occurrences,
            dictionary_hit=bool(item.get('dictionaryHit')),
        ))
    return candidates


def _deserialize_search_tokens(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise StageError('KEYWORDS_INPUT_INVALID', '候选临时产物缺少有效 searchTokens 数组。', False)
    return tuple(value)


def _chunk_to_dict(chunk: KeywordChunkInput) -> dict[str, Any]:
    return {
        'schemaVersion': chunk.schema_version,
        'documentId': chunk.document_id,
        'chunkId': chunk.chunk_id,
        'parentChunkId': chunk.parent_chunk_id,
        'ordinal': chunk.ordinal,
        'text': chunk.text,
        'sectionPath': list(chunk.section_path),
        'nodeIds': list(chunk.node_ids),
        'sourceRefs': list(chunk.source_refs),
        'overlapFromChunkId': chunk.overlap_from_chunk_id,
        'overlapChars': chunk.overlap_chars,
    }


def _update_df(df_state: dict[str, Counter[str]], chunk: KeywordChunkInput, result: CandidateGenerationResult) -> None:
    terms = df_state.setdefault(chunk.document_id, Counter())
    for candidate in result.candidates:
        if any(occurrence.end > chunk.overlap_chars for occurrence in candidate.occurrences):
            if candidate.normalized_term not in terms:
                if sum(len(value) for value in df_state.values()) >= MAX_DF_KEYS:
                    raise StageError('KEYWORDS_RESOURCE_LIMIT', '关键词 DF 词条超过资源上限。', False)
                terms[candidate.normalized_term] += 1


def _normalize_stage_config(config: Mapping[str, Any]) -> tuple[HybridRankingConfig, int, int, int, int]:
    text_rank = config.get('textRank') if isinstance(config.get('textRank'), dict) else {}
    weights = config.get('weights') if isinstance(config.get('weights'), dict) else {}
    try:
        ranking_config = HybridRankingConfig(
            min_score=float(config.get('minScore', 0.28)),
            min_keywords=int(config.get('minKeywords', 1)),
            max_keywords=int(config.get('maxKeywords', 10)),
            window_size=int(text_rank.get('windowSize', 4)),
            damping=float(text_rank.get('damping', 0.85)),
            max_iterations=int(text_rank.get('maxIterations', 30)),
            tolerance=float(text_rank.get('tolerance', 1e-6)),
            boilerplate_df_ratio=float(config.get('boilerplateDfRatio', 0.65)),
            allow_overlap_fallback=config.get('allowOverlapFallback', True) is not False,
            weights=weights,
        )
        max_candidates = int(config.get('maxCandidatesPerChunk', 256))
        ngram_min = int(config.get('ngramMin', 1))
        ngram_max = int(config.get('ngramMax', 3))
        max_text_characters = int(config.get('maxTextCharacters', MAX_TEXT_CHARACTERS))
    except (TypeError, ValueError) as exc:
        raise StageError('KEYWORDS_CONFIG_INVALID', f'关键词配置非法：{exc}', False) from exc
    if not 32 <= max_candidates <= MAX_CANDIDATES_PER_CHUNK:
        raise StageError('KEYWORDS_CONFIG_INVALID', 'maxCandidatesPerChunk 必须在 32～1024 之间。', False)
    if not 1 <= ngram_min <= ngram_max <= MAX_NGRAM:
        raise StageError('KEYWORDS_CONFIG_INVALID', 'ngram 范围必须在 1～3。', False)
    if not 1 <= max_text_characters <= MAX_TEXT_CHARACTERS:
        raise StageError('KEYWORDS_CONFIG_INVALID', 'maxTextCharacters 超出安全范围。', False)
    return ranking_config, max_candidates, ngram_min, ngram_max, max_text_characters


def _option_list(options: Mapping[str, Any], *names: str) -> list[str]:
    for name in names:
        if name in options:
            value = options[name]
            if not isinstance(value, list):
                raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', f'{name} 必须是字符串数组。')
            return value
    return []


def _write_disabled_stage(output: Path, stage_key: str, config: Mapping[str, Any], progress: Callable[[int, int | None, str, str], None]) -> dict[str, Any]:
    keywords_path = output / 'keywords.jsonl'
    keywords_path.write_text('', encoding='utf-8')
    report = {
        'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
        'stage': 'keywords',
        'stageKey': stage_key,
        'status': 'disabled',
        'algorithmVersion': HYBRID_KEYWORD_ALGORITHM_VERSION,
        'config': dict(config),
        'counts': {
            'chunks': 0,
            'keywords': 0,
            'emptyChunks': 0,
            'forcedTop1Chunks': 0,
            'overlapOnlyDiscarded': 0,
            'boilerplatePenalized': 0,
            'noiseCandidatesDiscarded': 0,
            'invalidEvidenceDiscarded': 0,
            'candidateCappedChunks': 0,
        },
        'distribution': {'minKeywordsPerChunk': 0, 'avgKeywordsPerChunk': 0, 'maxKeywordsPerChunk': 0},
        'generatedAt': _now(),
    }
    _write_json(output / 'keyword-report.json', report)
    _write_json(output / 'stage-manifest.json', {
        'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
        'stage': 'keywords',
        'stageKey': stage_key,
        'artifacts': ['keywords.jsonl', 'keyword-report.json', 'checkpoint.json'],
        'generatedAt': report['generatedAt'],
    })
    _write_checkpoint(output / 'checkpoint.json', {
        'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
        'stage': 'keywords',
        'stageKey': stage_key,
        'phase': 'disabled',
        'complete': True,
        'updatedAt': _now(),
    })
    progress(0, 0, 'chunk', '关键词阶段已按配置关闭。')
    return report['counts']


def _checkpoint_payload(*, stage_key: str, phase: str, last_ordinal: int, input_bytes: int, candidate_output_bytes: int, keyword_output_bytes: int, chunks: int, ranked_chunks: int, df_state: Mapping[str, Counter[str]], document_sizes: Mapping[str, int], stats: Mapping[str, Any], seen_chunk_ids: Iterable[str], complete: bool) -> dict[str, Any]:
    return {
        'schemaVersion': KEYWORDS_STAGE_SCHEMA_VERSION,
        'stage': 'keywords',
        'stageKey': stage_key,
        'phase': phase,
        'lastOrdinal': last_ordinal,
        'inputBytes': input_bytes,
        'candidateOutputBytes': candidate_output_bytes,
        'keywordOutputBytes': keyword_output_bytes,
        'chunks': chunks,
        'rankedChunks': ranked_chunks,
        'dfState': {document_id: dict(counter) for document_id, counter in df_state.items()},
        'documentSizes': dict(document_sizes),
        'stats': dict(stats),
        'seenChunkIds': sorted(seen_chunk_ids),
        'complete': complete,
        'updatedAt': _now(),
    }


def _restore_df_state(value: Any) -> dict[str, Counter[str]]:
    if not isinstance(value, dict):
        return defaultdict(Counter)
    return {
        str(document_id): Counter({str(term): int(count) for term, count in terms.items()})
        for document_id, terms in value.items()
        if isinstance(terms, dict)
    }


def _read_checkpoint(path: Path, stage_key: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get('stage') != 'keywords' or value.get('stageKey') != stage_key:
        return None
    return value


def _resolve_chunks_path(input_path: str) -> Path:
    path = Path(input_path)
    if path.is_dir():
        return path / 'chunks.jsonl'
    return path


def _count_nonempty_lines(path: Path) -> int:
    with path.open('rb') as stream:
        return sum(1 for line in stream if line.strip())


def _truncate_file(path: Path, size: int) -> None:
    if size < 0:
        size = 0
    if path.exists():
        with path.open('r+b') as stream:
            stream.truncate(size)


def _reset_stage_outputs(candidate_partial_path: Path, keywords_path: Path) -> None:
    candidate_partial_path.unlink(missing_ok=True)
    keywords_path.unlink(missing_ok=True)


def _write_checkpoint(path: Path, value: dict[str, Any]) -> None:
    _write_json(path, value)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _hash_terms(values: Iterable[str]) -> str:
    return hashlib.sha256(canonical_json(sorted(set(values))).encode('utf-8')).hexdigest()


def _config_to_json(config_record: Mapping[str, Any], ranking_config: HybridRankingConfig, max_candidates: int, ngram_min: int, ngram_max: int, max_text_characters: int) -> dict[str, Any]:
    return {
        **dict(config_record),
        'minScore': ranking_config.min_score,
        'minKeywords': ranking_config.min_keywords,
        'maxKeywords': ranking_config.max_keywords,
        'maxCandidatesPerChunk': max_candidates,
        'ngramMin': ngram_min,
        'ngramMax': ngram_max,
        'maxTextCharacters': max_text_characters,
        'weights': dict(ranking_config.weights or {}),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _raise_if_cancelled(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise StageCancelled()
