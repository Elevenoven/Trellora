"""Deterministic chunk boundary strategies used by the v2 coordinator."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, Callable, Iterable

from .chunking_models import SourceBlock, clean_text


def join_blocks(blocks: Iterable[SourceBlock]) -> str:
    return '\n\n'.join(block.text for block in blocks if block.text)


def group_adjacent_structure(blocks: list[SourceBlock]) -> list[list[SourceBlock]]:
    """Group only adjacent identical section identities; never merge by title globally."""
    groups: list[list[SourceBlock]] = []
    for block in blocks:
        if groups and groups[-1][0].section_key == block.section_key:
            groups[-1].append(block)
        else:
            groups.append([block])
    return groups


def group_by_page(blocks: list[SourceBlock], min_coverage: float) -> list[list[SourceBlock]]:
    if not blocks:
        return []
    known = sum(1 for block in blocks if block.page is not None)
    coverage = known / len(blocks)
    if coverage < min_coverage:
        raise ValueError(f'PAGE_METADATA_COVERAGE:{coverage:.3f}')
    groups: list[list[SourceBlock]] = []
    for block in blocks:
        if groups and groups[-1][0].page == block.page:
            groups[-1].append(block)
        else:
            groups.append([block])
    return groups


def group_by_regex(blocks: list[SourceBlock], pattern: str, flags: list[str] | None = None, boundary: str = 'before') -> list[list[SourceBlock]]:
    expression = re.compile(pattern, (re.I if flags and 'i' in flags else 0) | (re.M if flags and 'm' in flags else 0))
    groups: list[list[SourceBlock]] = []
    for block in blocks:
        matches = list(expression.finditer(block.text))
        if not matches:
            if groups:
                groups[-1].append(block)
            else:
                groups.append([block])
            continue
        # Block-level regex is intentionally conservative: preserve the source block and
        # use the first match only as a deterministic section boundary marker.
        if groups and boundary == 'before':
            groups.append([])
        groups.append([block])
    return [group for group in groups if group]


def regex_split(text: str, pattern: str, flags: list[str] | None = None, boundary: str = 'before', keep_delimiter: bool = True) -> list[str]:
    expression = re.compile(pattern, (re.I if flags and 'i' in flags else 0) | (re.M if flags and 'm' in flags else 0))
    matches = list(expression.finditer(text))
    if not matches:
        return [clean_text(text)] if clean_text(text) else []
    result: list[str] = []
    start = 0
    for match in matches:
        if boundary == 'before':
            cut = match.start()
            value = text[start:cut].strip()
            if value:
                result.append(value)
            start = match.start() if keep_delimiter else match.end()
        else:
            cut = match.end()
            value = text[start:cut if keep_delimiter else match.start()].strip()
            if value:
                result.append(value)
            start = cut
    tail = text[start:].strip()
    if tail:
        result.append(tail)
    return result


_BOUNDARY_PATTERNS = (
    re.compile(r'\n\s*\n'),
    re.compile(r'\n'),
    re.compile(r'(?<=[。！？!?；;])\s+|(?<=[。！？!?；;])(?=[\u4e00-\u9fffA-Za-z])'),
)


def _split_at_boundaries(text: str, pattern: re.Pattern[str]) -> list[str]:
    parts: list[str] = []
    start = 0
    for match in pattern.finditer(text):
        end = match.end()
        if end <= start:
            continue
        value = text[start:end].strip()
        if value:
            parts.append(value)
        start = end
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def _fixed_windows(text: str, max_chars: int, overlap_chars: int) -> list[str]:
    text = clean_text(text)
    if not text:
        return []
    max_chars = max(1, int(max_chars))
    overlap_chars = max(0, min(int(overlap_chars), max_chars - 1))
    step = max(1, max_chars - overlap_chars)
    result: list[str] = []
    start = 0
    while start < len(text):
        result.append(text[start:start + max_chars])
        if start + max_chars >= len(text):
            break
        start += step
    return result


def _pack_units(units: list[str], max_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ''
    for unit in units:
        unit = clean_text(unit)
        if not unit:
            continue
        candidate = f'{current}\n\n{unit}' if current else unit
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = unit
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def recursive_split(text: str, max_chars: int, overlap_chars: int = 0) -> list[str]:
    """Paragraph -> line -> sentence -> fixed-window recursive splitter."""
    text = clean_text(text)
    max_chars = max(1, int(max_chars))
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    units: list[str] = []
    for pattern in _BOUNDARY_PATTERNS:
        candidate = _split_at_boundaries(text, pattern)
        if len(candidate) > 1:
            units = candidate
            break
    if not units:
        return _fixed_windows(text, max_chars, overlap_chars)
    # A natural unit that is itself too long must descend to the next boundary.
    packed: list[str] = []
    for unit in units:
        if len(unit) <= max_chars:
            packed.append(unit)
        else:
            packed.extend(recursive_split(unit, max_chars, 0))
    chunks = _pack_units(packed, max_chars)
    if overlap_chars <= 0 or len(chunks) < 2:
        return chunks
    result: list[str] = [chunks[0]]
    for chunk in chunks[1:]:
        # The overlap is joined with two newlines, so reserve those separators
        # before deciding how much predecessor text can be copied.
        room = max(0, max_chars - len(chunk) - 2)
        overlap = min(int(overlap_chars), len(result[-1]), room)
        prefix = result[-1][-overlap:] if overlap else ''
        result.append(f'{prefix}\n\n{chunk}' if prefix else chunk)
    return result


def semantic_split(text: str, max_chars: int, min_chars: int, threshold: float) -> list[str]:
    text = clean_text(text)
    if not text or len(text) <= max_chars:
        return [text] if text else []
    sentences = _split_at_boundaries(text, _BOUNDARY_PATTERNS[2]) or [text]
    result: list[str] = []
    current = ''
    tokens: set[str] = set()
    for sentence in sentences:
        if len(sentence) > max_chars:
            if current:
                result.append(current)
                current = ''
                tokens = set()
            result.extend(recursive_split(sentence, max_chars, 0))
            continue
        candidate = f'{current} {sentence}'.strip() if current else sentence
        sentence_tokens = _tokens(sentence)
        similarity = _jaccard(tokens, sentence_tokens) if tokens else 1.0
        should_cut = bool(current) and len(current) >= min_chars and (len(candidate) > max_chars or similarity < threshold)
        if should_cut:
            result.append(current)
            current = sentence
            tokens = set(sentence_tokens)
        else:
            current = candidate
            tokens.update(sentence_tokens)
    if current:
        if result and len(current) < min_chars and len(result[-1]) + len(current) + 2 <= max_chars:
            result[-1] = f'{result[-1]}\n\n{current}'
        else:
            result.append(current)
    return result


def fixed_split(text: str, target_chars: int, max_chars: int, overlap_chars: int) -> list[str]:
    return _fixed_windows(clean_text(text), max(1, min(target_chars, max_chars)), overlap_chars)


def split_text(text: str, strategy: str, config: dict[str, Any], *, parent: bool = False) -> list[str]:
    strategy = strategy.upper()
    if strategy == 'RECURSIVE':
        return recursive_split(text, int(config['parentMaxChars'] if parent else config['childRecursiveMaxChars']), int(config['parentOverlapChars'] if parent else config['childRecursiveOverlapChars']))
    if strategy == 'FIXED':
        return fixed_split(text, int(config['parentTargetChars'] if parent else config['childFixedTargetChars']), int(config['parentMaxChars'] if parent else config['childFixedMaxChars']), int(config['parentOverlapChars'] if parent else config['childFixedOverlapChars']))
    if strategy == 'SEMANTIC':
        return semantic_split(text, int(config['semanticMaxChars']), int(config['semanticMinChars']), float(config['semanticSimilarityThreshold']))
    return [clean_text(text)] if clean_text(text) else []


def _tokens(text: str) -> set[str]:
    values: set[str] = set()
    lowered = text.lower()
    for run in re.findall(r'[\u4e00-\u9fff]+', lowered):
        values.update(run)
        values.update(run[index:index + 2] for index in range(max(0, len(run) - 1)))
    values.update(value for value in re.findall(r'[a-z0-9_]+', lowered) if value)
    return values


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def aggregate_stats(values: Iterable[dict[str, Any]]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for value in values:
        counts[str(value.get('kind') or 'unknown')] += 1
    return counts
