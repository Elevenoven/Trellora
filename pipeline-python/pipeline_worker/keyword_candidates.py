from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from .keyword_contract import normalize_term
from .keyword_tokenizer import (
    MAX_DICTIONARY_TERMS,
    KeywordTokenizer,
    TokenSpan,
    normalize_dictionary_terms,
)


MAX_CANDIDATES_PER_CHUNK = 1_024
DEFAULT_MAX_CANDIDATES = 256
MAX_STOPWORDS = 10_000
MAX_TEXT_CHARACTERS = 200_000
MAX_NGRAM = 3
MAX_SEARCH_TOKENS_PER_CHUNK = 8_192
MAX_SEARCH_TOKEN_CHARACTERS = 128
PURE_NUMBER_RE = re.compile(r'^\d+(?:[./-]\d+)*$')
PURE_ORDINAL_RE = re.compile(r'^(?:第\s*)?\d+(?:页|章|节|条)?$')
REPEATED_CHARACTER_RE = re.compile(r'(.)\1{3,}')
CHINESE_ONLY_RE = re.compile(r'^[\u3400-\u9fff]+$')


@dataclass(frozen=True)
class CandidateOccurrence:
    start: int
    end: int
    sentence_index: int


@dataclass
class KeywordCandidate:
    term: str
    normalized_term: str
    kind: str
    occurrences: list[CandidateOccurrence]
    dictionary_hit: bool = False


@dataclass(frozen=True)
class CandidateGenerationResult:
    candidates: tuple[KeywordCandidate, ...]
    candidate_count_before_cap: int
    candidate_capped: bool
    discarded_candidates: int
    dictionary_hits: int
    search_tokens: tuple[str, ...] = ()


class KeywordCandidateError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def load_builtin_stopwords(resource_dir: Path | None = None) -> tuple[str, ...]:
    directory = resource_dir or Path(__file__).with_name('resources')
    values: list[str] = []
    for file_name in ('stopwords-zh.txt', 'stopwords-en.txt'):
        path = directory / file_name
        if not path.is_file():
            raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', f'停用词资源不存在：{path.name}。')
        values.extend(
            line.strip()
            for line in path.read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.lstrip().startswith('#')
        )
    return normalize_stopwords(values)


def normalize_stopwords(values: Iterable[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', '停用词必须是有界字符串数组，不能直接传入字符串。')
    terms: dict[str, str] = {}
    try:
        for value in values:
            if not isinstance(value, str):
                raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', '停用词词条必须是字符串。')
            term = value.strip()
            normalized = normalize_term(term)
            if not normalized or len(normalized) > 64:
                raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', '停用词长度必须在 1～64 个字符之间。')
            terms.setdefault(normalized, term)
            if len(terms) > MAX_STOPWORDS:
                raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', '停用词超过 10000 条资源上限。')
    except TypeError as exc:
        raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', '停用词必须是可迭代的字符串数组。') from exc
    return tuple(terms.keys())


def generate_candidates(
    text: str,
    tokenizer: KeywordTokenizer,
    *,
    dictionary_terms: Iterable[str] = (),
    stopwords: Iterable[str] | None = None,
    ngram_min: int = 1,
    ngram_max: int = MAX_NGRAM,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    max_text_characters: int = MAX_TEXT_CHARACTERS,
) -> CandidateGenerationResult:
    if len(text) > max_text_characters:
        raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', '子块正文超过关键词候选生成字符上限。')
    if not 1 <= ngram_min <= ngram_max <= MAX_NGRAM:
        raise KeywordCandidateError('KEYWORDS_CONFIG_INVALID', 'ngram 范围必须在 1～3 且 ngramMin 不得大于 ngramMax。')
    if not 1 <= max_candidates <= MAX_CANDIDATES_PER_CHUNK:
        raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', '候选数量资源上限必须在 1～1024 之间。')

    dictionary = normalize_dictionary_terms(dictionary_terms)
    stopword_set = set(load_builtin_stopwords() if stopwords is None else normalize_stopwords(stopwords))
    tokens = _stable_tokens(tokenizer.tokenize(text), text)
    search_tokens = _search_tokens(tokens, stopword_set)
    candidates: dict[str, KeywordCandidate] = {}

    for token in tokens:
        _add_candidate(candidates, text[token.start:token.end], token.start, token.end, token.sentence_index, token.kind, stopword_set, False)

    for start_index, _token in enumerate(tokens):
        for size in range(max(ngram_min, 2), ngram_max + 1):
            end_index = start_index + size
            if end_index > len(tokens):
                break
            window = tokens[start_index:end_index]
            if not _same_sentence_and_boundary(window, text):
                break
            trimmed = _trim_outer_stopwords(window, stopword_set, text)
            if trimmed is None:
                continue
            trimmed_term, trimmed_start, trimmed_end = trimmed
            _add_candidate(candidates, trimmed_term, trimmed_start, trimmed_end, window[0].sentence_index, 'phrase', stopword_set, False)

    for dictionary_term in dictionary:
        for match in _find_exact_occurrences(text, dictionary_term):
            _add_candidate(candidates, dictionary_term, match[0], match[1], _sentence_index(text, match[0]), 'phrase', stopword_set, True)

    before_cap = len(candidates)
    ordered = sorted(candidates.values(), key=_candidate_sort_key)
    capped = len(ordered) > max_candidates
    selected = tuple(ordered[:max_candidates])
    return CandidateGenerationResult(
        candidates=selected,
        candidate_count_before_cap=before_cap,
        candidate_capped=capped,
        discarded_candidates=max(0, before_cap - len(selected)),
        dictionary_hits=sum(1 for candidate in selected if candidate.dictionary_hit),
        search_tokens=search_tokens,
    )


def extract_search_tokens(
    text: str,
    tokenizer: KeywordTokenizer,
    *,
    stopwords: Iterable[str] = (),
    max_tokens: int = MAX_SEARCH_TOKENS_PER_CHUNK,
) -> tuple[str, ...]:
    """Return the same bounded token stream used by the FTS5 projection."""
    if not isinstance(text, str) or len(text) > MAX_TEXT_CHARACTERS:
        raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', '待分词文本超过字符上限。')
    if not 1 <= max_tokens <= MAX_SEARCH_TOKENS_PER_CHUNK:
        raise KeywordCandidateError('KEYWORDS_RESOURCE_LIMIT', '检索词元数量上限无效。')
    stopword_set = set(normalize_stopwords(stopwords))
    return _search_tokens(_stable_tokens(tokenizer.tokenize(text), text), stopword_set, max_tokens)


def _search_tokens(
    tokens: Sequence[TokenSpan],
    stopwords: set[str],
    max_tokens: int = MAX_SEARCH_TOKENS_PER_CHUNK,
) -> tuple[str, ...]:
    values: list[str] = []
    for token in tokens:
        normalized = normalize_term(token.term)
        if (
            not normalized
            or normalized in stopwords
            or len(normalized) > MAX_SEARCH_TOKEN_CHARACTERS
            or any(not character.isprintable() for character in normalized)
        ):
            continue
        values.append(normalized)
        if len(values) >= max_tokens:
            break
    return tuple(values)


def _stable_tokens(values: Sequence[TokenSpan], text: str) -> list[TokenSpan]:
    unique: dict[tuple[int, int, str], TokenSpan] = {}
    for token in values:
        if token.start < 0 or token.end <= token.start or token.end > len(text) or text[token.start:token.end] != token.term:
            continue
        unique.setdefault((token.start, token.end, token.term), token)
    ordered = sorted(unique.values(), key=lambda item: (item.start, -(item.end - item.start), item.end, item.term))
    selected: list[TokenSpan] = []
    for token in ordered:
        if selected and token.start < selected[-1].end:
            continue
        selected.append(token)
    return selected


def _add_candidate(
    candidates: dict[str, KeywordCandidate],
    term: str,
    start: int,
    end: int,
    sentence_index: int,
    kind: str,
    stopwords: set[str],
    dictionary_hit: bool,
) -> None:
    normalized = normalize_term(term)
    if not _is_valid_candidate(term, normalized, stopwords):
        return
    candidate = candidates.setdefault(
        normalized,
        KeywordCandidate(term=term, normalized_term=normalized, kind='phrase' if kind == 'phrase' else kind, occurrences=[]),
    )
    candidate.dictionary_hit = candidate.dictionary_hit or dictionary_hit
    if not candidate.occurrences:
        candidate.term = term
        candidate.kind = 'phrase' if kind == 'phrase' else kind
    occurrence = CandidateOccurrence(start, end, sentence_index)
    if occurrence not in candidate.occurrences:
        candidate.occurrences.append(occurrence)


def _is_valid_candidate(term: str, normalized: str, stopwords: set[str]) -> bool:
    if not normalized or normalized in stopwords or not 2 <= len(normalized) <= 64:
        return False
    if any(not character.isprintable() for character in term):
        return False
    if PURE_NUMBER_RE.fullmatch(normalized) or PURE_ORDINAL_RE.fullmatch(normalized):
        return False
    if REPEATED_CHARACTER_RE.search(term):
        return False
    if not any(character.isalpha() for character in term) and not CHINESE_ONLY_RE.fullmatch(term.replace(' ', '')):
        return False
    if CHINESE_ONLY_RE.fullmatch(normalized) and len(normalized) > 12:
        return False
    return True


def _same_sentence_and_boundary(window: Sequence[TokenSpan], text: str) -> bool:
    if not window or any(token.sentence_index != window[0].sentence_index for token in window):
        return False
    for previous, current in zip(window, window[1:]):
        gap = text[previous.end:current.start]
        if any(character in gap for character in '\r\n|') or any(character in gap for character in '。！？；.!?;'):
            return False
    return True


def _trim_outer_stopwords(
    window: Sequence[TokenSpan],
    stopwords: set[str],
    text: str,
) -> tuple[str, int, int] | None:
    left = 0
    right = len(window)
    while left < right and normalize_term(window[left].term) in stopwords:
        left += 1
    while right > left and normalize_term(window[right - 1].term) in stopwords:
        right -= 1
    if right - left < 2:
        return None
    start, end = window[left].start, window[right - 1].end
    return text[start:end], start, end


def _find_exact_occurrences(text: str, term: str) -> list[tuple[int, int]]:
    occurrences: list[tuple[int, int]] = []
    offset = 0
    while True:
        start = text.find(term, offset)
        if start < 0:
            return occurrences
        end = start + len(term)
        occurrences.append((start, end))
        offset = end


def _candidate_sort_key(candidate: KeywordCandidate) -> tuple[int, int, int, int, str]:
    first_start = candidate.occurrences[0].start if candidate.occurrences else 0
    return (
        0 if candidate.dictionary_hit else 1,
        -len(candidate.occurrences),
        first_start,
        -len(candidate.normalized_term),
        candidate.normalized_term,
    )


def _sentence_index(text: str, offset: int) -> int:
    return sum(1 for character in text[:offset] if character in '。！？；.!?;\n\r')
