from __future__ import annotations

from functools import lru_cache
from typing import Any, Iterable

from .keyword_candidates import extract_search_tokens, load_builtin_stopwords, normalize_stopwords
from .keyword_tokenizer import create_keyword_tokenizer, normalize_dictionary_terms


MAX_SEARCH_QUERY_CHARACTERS = 4_096
MAX_SEARCH_QUERY_TOKENS = 64


def tokenize_search_query(
    query: str,
    dictionary_terms: Iterable[str] = (),
    custom_stopwords: Iterable[str] = (),
) -> dict[str, Any]:
    if not isinstance(query, str):
        raise ValueError('检索词必须是字符串。')
    normalized_query = query.strip()
    if len(normalized_query) > MAX_SEARCH_QUERY_CHARACTERS:
        raise ValueError('检索词超过 4096 个字符上限。')
    dictionary = normalize_dictionary_terms(dictionary_terms)
    stopwords = normalize_stopwords((*load_builtin_stopwords(), *custom_stopwords))
    tokenizer = _cached_jieba_tokenizer(dictionary)
    tokens = extract_search_tokens(
        normalized_query,
        tokenizer,
        stopwords=stopwords,
        max_tokens=MAX_SEARCH_QUERY_TOKENS,
    ) if normalized_query else ()
    return {
        'tokens': list(tokens),
        'tokenizer': str(getattr(tokenizer, 'name', 'jieba-accurate-hmm-off')),
        'tokenizerVersion': str(getattr(tokenizer, 'version', 'unresolved')),
        'dictionaryHash': str(getattr(tokenizer, 'dictionary_hash', 'none')),
    }


@lru_cache(maxsize=8)
def _cached_jieba_tokenizer(dictionary_terms: tuple[str, ...]):
    # Each cache entry owns an isolated jieba.Tokenizer, so per-library
    # dictionaries never leak into another materials library.
    return create_keyword_tokenizer('jieba', dictionary_terms)
