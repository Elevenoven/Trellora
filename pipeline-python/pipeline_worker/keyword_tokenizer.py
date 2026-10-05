from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Iterable, Protocol

from .keyword_contract import normalize_term


TOKENIZER_NAME = 'jieba-accurate-hmm-off'
RULE_TOKENIZER_NAME = 'rule-explicit'
MAX_DICTIONARY_TERMS = 5_000
TECHNICAL_TOKEN_RE = re.compile(
    r'(?<![A-Za-z0-9_])'
    r'(?:[A-Za-z][A-Za-z0-9]*(?:[._+#/-][A-Za-z0-9]+)*)'
    r'(?:\s+\d+(?:\.\d+)?)?'
    r'(?![A-Za-z0-9_])'
)
CHINESE_RUN_RE = re.compile(r'[\u3400-\u9fff]+')
SENTENCE_BOUNDARIES = frozenset('。！？；.!?;\n\r')


@dataclass(frozen=True)
class TokenSpan:
    term: str
    start: int
    end: int
    kind: str
    sentence_index: int


class KeywordTokenizer(Protocol):
    def tokenize(self, text: str) -> list[TokenSpan]:
        """Tokenize without changing the input text or its offsets."""


class KeywordTokenizerUnavailable(RuntimeError):
    code = 'KEYWORDS_TOKENIZER_UNAVAILABLE'

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class KeywordTokenizerConfigError(ValueError):
    code = 'KEYWORDS_CONFIG_INVALID'


class JiebaKeywordTokenizer:
    """Deterministic jieba tokenizer with rule-based technical-token supplementation."""

    name = TOKENIZER_NAME

    def __init__(self, dictionary_terms: Iterable[str] = ()) -> None:
        dictionary = normalize_dictionary_terms(dictionary_terms)
        try:
            import jieba
        except ImportError as exc:
            raise KeywordTokenizerUnavailable('jieba 未安装，不能启用默认中文分词器。请安装固定版本 jieba==0.42.1。') from exc

        self._tokenizer = jieba.Tokenizer()
        for term in dictionary:
            self._tokenizer.add_word(term)
        try:
            self.version = version('jieba')
        except PackageNotFoundError:
            self.version = '0.42.1'
        self.dictionary_terms = dictionary
        self.dictionary_hash = dictionary_hash(dictionary)

    def tokenize(self, text: str) -> list[TokenSpan]:
        spans: dict[tuple[int, int, str], TokenSpan] = {}
        for term, start, end in self._tokenizer.tokenize(text, mode='default', HMM=False):
            if term.strip():
                _add_span(spans, text, term, start, end, 'word')
        _add_technical_spans(spans, text)
        return sorted(spans.values(), key=lambda item: (item.start, item.end, item.term))


class RuleKeywordTokenizer:
    """Explicit, dependency-free tokenizer for fixtures and diagnostics only."""

    name = RULE_TOKENIZER_NAME
    version = 'rule-1'
    dictionary_terms: tuple[str, ...] = ()
    dictionary_hash = 'none'

    def __init__(self, dictionary_terms: Iterable[str] = ()) -> None:
        self.dictionary_terms = normalize_dictionary_terms(dictionary_terms)
        self.dictionary_hash = dictionary_hash(self.dictionary_terms)

    def tokenize(self, text: str) -> list[TokenSpan]:
        spans: dict[tuple[int, int, str], TokenSpan] = {}
        for match in CHINESE_RUN_RE.finditer(text):
            _add_span(spans, text, match.group(0), match.start(), match.end(), 'word')
        _add_technical_spans(spans, text)
        return sorted(spans.values(), key=lambda item: (item.start, item.end, item.term))


def create_keyword_tokenizer(name: str = 'jieba', dictionary_terms: Iterable[str] = ()) -> KeywordTokenizer:
    if name == 'jieba':
        return JiebaKeywordTokenizer(dictionary_terms)
    if name == RULE_TOKENIZER_NAME:
        return RuleKeywordTokenizer(dictionary_terms)
    raise KeywordTokenizerConfigError(f'不支持的关键词 tokenizer：{name}。')


def normalize_dictionary_terms(values: Iterable[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise KeywordTokenizerConfigError('业务词典必须是有界字符串数组，不能直接传入字符串。')
    terms: dict[str, str] = {}
    try:
        for value in values:
            if not isinstance(value, str):
                raise KeywordTokenizerConfigError('业务词典词条必须是字符串。')
            term = value.strip()
            normalized = normalize_term(term)
            if not 2 <= len(normalized) <= 64:
                raise KeywordTokenizerConfigError('业务词典词条长度必须在 2～64 个字符之间。')
            terms.setdefault(normalized, term)
            if len(terms) > MAX_DICTIONARY_TERMS:
                raise KeywordTokenizerConfigError('业务词典超过 5000 条资源上限。')
    except TypeError as exc:
        raise KeywordTokenizerConfigError('业务词典必须是可迭代的字符串数组。') from exc
    return tuple(terms.values())


def dictionary_hash(values: Iterable[str]) -> str:
    canonical = '\n'.join(normalize_term(value) for value in values)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest() if canonical else 'none'


def _add_technical_spans(spans: dict[tuple[int, int, str], TokenSpan], text: str) -> None:
    for match in TECHNICAL_TOKEN_RE.finditer(text):
        _add_span(spans, text, match.group(0), match.start(), match.end(), 'term')


def _add_span(spans: dict[tuple[int, int, str], TokenSpan], text: str, term: str, start: int, end: int, kind: str) -> None:
    if start < 0 or end <= start or end > len(text) or text[start:end] != term:
        return
    key = (start, end, term)
    spans.setdefault(key, TokenSpan(term, start, end, kind, _sentence_index(text, start)))


def _sentence_index(text: str, offset: int) -> int:
    return sum(1 for character in text[:offset] if character in SENTENCE_BOUNDARIES)
