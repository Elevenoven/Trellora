"""Deterministic document quality assessment and recommended Child plan."""

from __future__ import annotations

import re
from typing import Any, Iterable

from .chunking_models import SourceBlock, clean_text


QUALITY_SCHEMA_VERSION = 1


def assess_quality(blocks: Iterable[SourceBlock]) -> dict[str, Any]:
    values = list(blocks)
    total_blocks = len(values)
    non_empty = [block for block in values if clean_text(block.text)]
    canonical_chars = sum(len(clean_text(block.text)) for block in non_empty)
    average_chars = canonical_chars / len(non_empty) if non_empty else 0.0
    noise_blocks = sum(1 for block in values if str(block.kind).lower() in {'noise', 'page_break'})
    short_blocks = sum(1 for block in non_empty if len(clean_text(block.text)) < 40)
    natural_blocks = sum(1 for block in non_empty if _has_sentence_boundary(block.text) or '\n' in block.text)
    paragraph_count = sum(1 for block in non_empty if _looks_like_paragraph(block.text))
    blank_separators = sum(clean_text(block.text).count('\n\n') for block in non_empty)
    noise_rate = noise_blocks / total_blocks if total_blocks else 0.0
    short_rate = short_blocks / len(non_empty) if non_empty else 0.0
    coverage = len(non_empty) / total_blocks if total_blocks else 0.0
    length_score = min(1.0, average_chars / 240.0)
    natural_score = natural_blocks / len(non_empty) if non_empty else 0.0
    score = round(max(0.0, min(1.0, 0.35 * coverage + 0.25 * length_score + 0.2 * natural_score + 0.2 * (1.0 - noise_rate))), 4)
    if not non_empty:
        level = 'LOW'
    elif score < 0.45:
        level = 'LOW'
    elif score < 0.70:
        level = 'MEDIUM'
    else:
        level = 'HIGH'
    paragraph_ready = bool(
        len(non_empty) >= 3
        and paragraph_count >= 3
        and average_chars >= 80
        and noise_rate <= 0.20
        and (natural_blocks >= 2 or blank_separators >= 1)
    )
    reasons: list[str] = []
    if not non_empty:
        reasons.append('EMPTY_DOCUMENT')
    if coverage < 0.80:
        reasons.append('LOW_TEXT_COVERAGE')
    if noise_rate > 0.20:
        reasons.append('HIGH_NOISE')
    if short_rate > 0.50:
        reasons.append('SHORT_FRAGMENT_RATIO')
    if natural_blocks:
        reasons.append('NATURAL_BOUNDARIES_PRESENT')
    if paragraph_ready:
        reasons.append('PARAGRAPH_READY')
    return {
        'schemaVersion': QUALITY_SCHEMA_VERSION,
        'level': level,
        'score': score,
        'totalBlocks': total_blocks,
        'nonEmptyBlocks': len(non_empty),
        'canonicalChars': canonical_chars,
        'averageChars': round(average_chars, 4),
        'noiseBlocks': noise_blocks,
        'noiseRate': round(noise_rate, 4),
        'shortBlocks': short_blocks,
        'shortRate': round(short_rate, 4),
        'naturalBoundaryBlocks': natural_blocks,
        'paragraphCount': paragraph_count,
        'blankSeparators': blank_separators,
        'paragraphReady': paragraph_ready,
        'reasons': reasons,
    }


def recommend_child_strategies(
    config: dict[str, Any],
    quality: dict[str, Any],
    *,
    llm_available: bool = False,
) -> dict[str, Any]:
    configured = [str(value).upper() for value in config.get('childStrategies') or []]
    if configured:
        return {
            'strategies': configured,
            'source': 'USER_CONFIG',
            'reason': 'CHILD_STRATEGIES_CONFIGURED',
            'llmAvailable': llm_available,
        }
    level = str(quality.get('level') or 'LOW')
    if (
        level == 'LOW'
        and bool(config.get('llmEnabled'))
        and bool(config.get('recommendLlmWhenLowQuality', True))
        and llm_available
    ):
        return {
            'strategies': ['LLM', 'RECURSIVE'],
            'source': 'AUTO_RECOMMENDED',
            'reason': 'LOW_QUALITY_LLM_AVAILABLE',
            'llmAvailable': True,
        }
    if level in {'MEDIUM', 'HIGH'} and bool(quality.get('paragraphReady')):
        reason = 'PARAGRAPH_READY_SEMANTIC' if level == 'HIGH' else 'MEDIUM_QUALITY_PARAGRAPH_READY'
        return {
            'strategies': ['SEMANTIC', 'RECURSIVE'],
            'source': 'AUTO_RECOMMENDED',
            'reason': reason,
            'llmAvailable': llm_available,
        }
    reason = 'LLM_UNAVAILABLE_OR_DISABLED' if level == 'LOW' and bool(config.get('llmEnabled')) else 'QUALITY_NOT_READY_FOR_SEMANTIC'
    return {
        'strategies': ['RECURSIVE'],
        'source': 'AUTO_RECOMMENDED',
        'reason': reason,
        'llmAvailable': llm_available,
    }


def _looks_like_paragraph(text: str) -> bool:
    value = clean_text(text)
    return len(value) >= 40 and not re.match(r'^(?:[-*+]|\d+[.)、])\s+', value)


def _has_sentence_boundary(text: str) -> bool:
    return bool(re.search(r'[。！？!?；;.]', clean_text(text)))
