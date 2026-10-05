from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


KEYWORD_CONTRACT_SCHEMA_VERSION = 1
KEYWORD_OUTPUT_SCHEMA_VERSION = 3
MAX_SEARCH_TOKENS_PER_CHUNK = 8_192
MAX_SEARCH_TOKEN_CHARACTERS = 128
KEYWORD_BASELINE_ALGORITHM_VERSION = 'kw-baseline-1'


class KeywordContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class KeywordChunkInput:
    document_id: str
    chunk_id: str
    parent_chunk_id: str | None
    ordinal: int
    text: str
    section_path: tuple[dict[str, Any], ...]
    node_ids: tuple[str, ...]
    source_refs: tuple[dict[str, Any], ...]
    overlap_from_chunk_id: str | None
    overlap_chars: int
    schema_version: int = 1
    legacy_flat_chunk: bool = False


def normalize_term(value: str) -> str:
    """Normalize only for comparison; offsets always refer to the original text."""
    normalized = unicodedata.normalize('NFKC', value).strip().lower()
    return re.sub(r'\s+', ' ', normalized)


def parse_keyword_chunk(value: Mapping[str, Any]) -> KeywordChunkInput:
    if not isinstance(value, Mapping):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', '子块记录必须是 JSON 对象。')

    schema_version = _required_int(value, 'schemaVersion', minimum=1)
    if schema_version not in (1, 2):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'不支持的子块 Schema 版本：{schema_version}。')
    document_id = _required_text(value, 'documentId')
    chunk_id = _required_text(value, 'chunkId')
    text = _required_text(value, 'text', allow_empty=True)
    ordinal = _required_int(value, 'ordinal', minimum=0)

    parent_value = value.get('parentChunkId')
    if schema_version >= 2:
        parent_chunk_id = _required_text(value, 'parentChunkId')
        legacy_flat_chunk = False
    elif parent_value is None or str(parent_value).strip() == '':
        parent_chunk_id = None
        legacy_flat_chunk = True
    else:
        parent_chunk_id = _required_text(value, 'parentChunkId')
        legacy_flat_chunk = False

    section_path = _object_list(value.get('sectionPath'), 'sectionPath')
    node_ids = _string_list(value.get('nodeIds'), 'nodeIds')
    source_refs = _object_list(value.get('sourceRefs'), 'sourceRefs')
    overlap_chars = _required_int(value, 'overlapChars', minimum=0)
    if overlap_chars > len(text):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'overlapChars 超出 chunk.text 长度：{chunk_id}。')
    overlap_from = value.get('overlapFromChunkId')
    if overlap_from is not None and not isinstance(overlap_from, str):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'overlapFromChunkId 必须是字符串或 null：{chunk_id}。')

    return KeywordChunkInput(
        document_id=document_id,
        chunk_id=chunk_id,
        parent_chunk_id=parent_chunk_id,
        ordinal=ordinal,
        text=text,
        section_path=tuple(section_path),
        node_ids=tuple(node_ids),
        source_refs=tuple(source_refs),
        overlap_from_chunk_id=overlap_from,
        overlap_chars=overlap_chars,
        schema_version=schema_version,
        legacy_flat_chunk=legacy_flat_chunk,
    )


def parse_keyword_chunks(values: Sequence[Mapping[str, Any]]) -> list[KeywordChunkInput]:
    chunks = [parse_keyword_chunk(value) for value in values]
    seen: set[str] = set()
    for chunk in chunks:
        if chunk.chunk_id in seen:
            raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'chunkId 重复：{chunk.chunk_id}。')
        seen.add(chunk.chunk_id)
    return chunks


def validate_keyword_output(output: Mapping[str, Any], chunk: KeywordChunkInput, max_keywords: int = 20) -> None:
    if not isinstance(output, Mapping):
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', '关键词输出必须是 JSON 对象。')
    output_schema_version = output.get('schemaVersion')
    if output_schema_version not in (1, 2, KEYWORD_OUTPUT_SCHEMA_VERSION):
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', '关键词输出 Schema 版本不匹配。')
    if output.get('documentId') != chunk.document_id or output.get('chunkId') != chunk.chunk_id:
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词输出与输入 chunk 不匹配：{chunk.chunk_id}。')
    if output.get('parentChunkId') != chunk.parent_chunk_id:
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'parentChunkId 与输入不一致：{chunk.chunk_id}。')
    if not isinstance(output.get('chunkContentHash'), str) or not output['chunkContentHash']:
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', 'chunkContentHash 必须存在。')
    if not isinstance(output.get('algorithm'), Mapping):
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', 'algorithm 必须存在。')
    keywords = output.get('keywords')
    if not isinstance(keywords, list) or len(keywords) > max_keywords:
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词数量超过上限：{chunk.chunk_id}。')
    compact_terms = output.get('keyword')
    if output_schema_version >= 2 and (
        not isinstance(compact_terms, list)
        or any(not isinstance(term, str) or not term for term in compact_terms)
    ):
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'keyword 字段必须是字符串数组：{chunk.chunk_id}。')
    empty_reason = output.get('emptyReason')
    if (not keywords and (not isinstance(empty_reason, str) or not empty_reason.strip())) or (keywords and empty_reason is not None):
        raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'空原因与关键词数组不一致：{chunk.chunk_id}。')

    previous_score = math.inf
    normalized_seen: set[str] = set()
    for expected_rank, item in enumerate(keywords, start=1):
        if not isinstance(item, Mapping):
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词项必须是对象：{chunk.chunk_id}。')
        if item.get('rank') != expected_rank:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词 rank 不连续：{chunk.chunk_id}。')
        score = item.get('score')
        if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= float(score) <= 1:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词 score 越界：{chunk.chunk_id}。')
        if float(score) > previous_score + 1e-12:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词 score 未按非递增排序：{chunk.chunk_id}。')
        previous_score = float(score)
        term = item.get('term')
        normalized = item.get('normalizedTerm')
        if not isinstance(term, str) or not term or not isinstance(normalized, str) or normalized != normalize_term(term):
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词文本不合法：{chunk.chunk_id}。')
        if normalized in normalized_seen:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词 normalizedTerm 重复：{chunk.chunk_id}。')
        normalized_seen.add(normalized)
        occurrences = item.get('occurrences')
        if not isinstance(occurrences, list) or not occurrences:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'关键词缺少 occurrence：{chunk.chunk_id}。')
        for occurrence in occurrences:
            if not isinstance(occurrence, Mapping):
                raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'occurrence 必须是对象：{chunk.chunk_id}。')
            start = occurrence.get('start')
            end = occurrence.get('end')
            if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
                raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'occurrence offset 必须是整数：{chunk.chunk_id}。')
            if start < 0 or end <= start or end > len(chunk.text) or chunk.text[start:end] != term:
                raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'occurrence 无法回指原文：{chunk.chunk_id}。')

    if output_schema_version >= 2:
        expected_compact_terms = [str(item['term']) for item in keywords]
        if compact_terms != expected_compact_terms:
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'keyword 字段与 keywords 不一致：{chunk.chunk_id}。')
    if output_schema_version >= 3:
        search_tokens = output.get('searchTokens')
        if (
            not isinstance(search_tokens, list)
            or len(search_tokens) > MAX_SEARCH_TOKENS_PER_CHUNK
            or any(
                not isinstance(token, str)
                or not token
                or token != token.strip()
                or len(token) > MAX_SEARCH_TOKEN_CHARACTERS
                or any(not character.isprintable() for character in token)
                for token in search_tokens
            )
        ):
            raise KeywordContractError('KEYWORDS_OUTPUT_INVALID', f'searchTokens 字段无效：{chunk.chunk_id}。')


def chunk_content_hash(text: str) -> str:
    return f'sha256:{hashlib.sha256(text.encode("utf-8")).hexdigest()}'


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _required_text(value: Mapping[str, Any], key: str, allow_empty: bool = False) -> str:
    item = value.get(key)
    if not isinstance(item, str) or (not allow_empty and not item.strip()):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'{key} 必须是非空字符串。')
    return item if allow_empty else item.strip()


def _required_int(value: Mapping[str, Any], key: str, minimum: int) -> int:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int) or item < minimum:
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'{key} 必须是不小于 {minimum} 的整数。')
    return item


def _object_list(value: Any, key: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'{key} 必须是对象数组。')
    return list(value)


def _string_list(value: Any, key: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise KeywordContractError('KEYWORDS_INPUT_INVALID', f'{key} 必须是非空字符串数组。')
    return list(value)
