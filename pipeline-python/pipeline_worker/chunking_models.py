"""Parent/Child chunking domain models and deterministic normalization helpers."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

from .stage_errors import StageError


def clean_text(value: Any) -> str:
    """Normalize parser noise without flattening paragraph semantics."""
    text = unicodedata.normalize('NFKC', str(value or '').replace('\ufeff', ''))
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    text = ''.join(ch for ch in text if ch not in '\x00\x0b\x0c\x85\u200b')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'[ \t]+\n', '\n', text)
    return text.strip()


def dedupe_refs(refs: Iterable[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in refs:
        if not isinstance(value, dict):
            continue
        key = repr(sorted((str(k), str(v)) for k, v in value.items()))
        if key not in seen:
            seen.add(key)
            result.append(dict(value))
    return result


def section_key(section_path: Any) -> str:
    if not isinstance(section_path, list):
        return ''
    return '/'.join(str(item.get('nodeId') or item.get('path') or item.get('text') or '') for item in section_path if isinstance(item, dict))


def section_title(section_path: Any) -> str:
    if not isinstance(section_path, list):
        return ''
    values = [clean_text(item.get('text')) for item in section_path if isinstance(item, dict) and clean_text(item.get('text'))]
    return ' / '.join(values)


def section_path_text(section_path: Any) -> str:
    if not isinstance(section_path, list):
        return ''
    values = [clean_text(item.get('text')) for item in section_path if isinstance(item, dict) and clean_text(item.get('text'))]
    return ' > '.join(values)


@dataclass
class SourceBlock:
    block_id: str
    text: str
    order: int
    kind: str = 'paragraph'
    page: int | None = None
    section_path: list[dict[str, Any]] = field(default_factory=list)
    section_id: str = ''
    section_title: str = ''
    section_path_text: str = ''
    source_refs: list[dict[str, Any]] = field(default_factory=list)
    first_line_no: int | None = None
    last_line_no: int | None = None

    @property
    def section_key(self) -> str:
        return self.section_id or section_key(self.section_path)

    def as_ref(self) -> dict[str, Any]:
        result: dict[str, Any] = {'blockId': self.block_id}
        if self.page is not None:
            result['page'] = self.page
        if self.first_line_no is not None:
            result['firstLineNo'] = self.first_line_no
        if self.last_line_no is not None:
            result['lastLineNo'] = self.last_line_no
        result.update({'kind': self.kind, 'sourceRefs': self.source_refs})
        return result


def validate_v2_config(config: dict[str, Any]) -> dict[str, Any]:
    """Validate the cross-process config contract; Electron performs strict UI validation too."""
    if config.get('schemaVersion', 2) != 2:
        raise StageError('CHUNK_CONFIG_INVALID', '切块配置 schemaVersion 必须为 2。', False)
    result = dict(config)
    for name in ('parentStrategies', 'childStrategies'):
        value = result.get(name, [])
        if not isinstance(value, list) or any(not isinstance(code, str) for code in value):
            raise StageError('CHUNK_CONFIG_INVALID', f'{name} 必须是策略数组。', False)
        result[name] = [code.upper() for code in value if code]
    known = {'STRUCTURE', 'RECURSIVE', 'SEMANTIC', 'LLM', 'PAGE', 'REGEX', 'FIXED'}
    for name in ('parentStrategies', 'childStrategies'):
        unknown = [code for code in result[name] if code not in known]
        if unknown:
            raise StageError('CHUNK_CONFIG_INVALID', f'{name} 包含未知策略：{unknown[0]}。', False)
    if result.get('mode', 'recommended') not in {'recommended', 'custom'}:
        raise StageError('CHUNK_CONFIG_INVALID', '切块模式必须是 recommended 或 custom。', False)
    numbers = ('parentMinChars', 'parentTargetChars', 'parentMaxChars', 'parentOverlapChars',
               'childRecursiveMaxChars', 'childRecursiveOverlapChars', 'semanticMaxChars',
               'semanticMinChars', 'semanticSimilarityThreshold', 'childFixedTargetChars',
               'childFixedMinChars', 'childFixedMaxChars', 'childFixedOverlapChars',
               'pageMinMetadataCoverage', 'llmMaxChars', 'llmTimeoutMs', 'llmMaxOutputTokens')
    defaults = {
        'parentMinChars': 1200, 'parentTargetChars': 2400, 'parentMaxChars': 3500, 'parentOverlapChars': 200,
        'childRecursiveMaxChars': 700, 'childRecursiveOverlapChars': 100, 'semanticMaxChars': 700,
        'semanticMinChars': 240, 'semanticSimilarityThreshold': 0.18, 'childFixedTargetChars': 700,
        'childFixedMinChars': 160, 'childFixedMaxChars': 900, 'childFixedOverlapChars': 100,
        'pageMinMetadataCoverage': 0.8, 'llmMaxChars': 3500, 'llmTimeoutMs': 45000,
        'llmMaxOutputTokens': 2000,
    }
    for name in numbers:
        value = result.get(name, defaults[name])
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            raise StageError('CHUNK_CONFIG_INVALID', f'{name} 必须是非负数字。', False)
        result[name] = int(value) if name != 'semanticSimilarityThreshold' and name != 'pageMinMetadataCoverage' else float(value)
    if not 0 <= result['semanticSimilarityThreshold'] <= 1 or not 0 <= result['pageMinMetadataCoverage'] <= 1:
        raise StageError('CHUNK_CONFIG_INVALID', '语义阈值和页码覆盖率必须在 0 到 1 之间。', False)
    if not (result['parentMinChars'] <= result['parentTargetChars'] <= result['parentMaxChars']):
        raise StageError('CHUNK_CONFIG_INVALID', 'Parent 长度必须满足 min ≤ target ≤ max。', False)
    if result['parentOverlapChars'] >= result['parentMaxChars'] or result['childRecursiveOverlapChars'] >= result['childRecursiveMaxChars']:
        raise StageError('CHUNK_CONFIG_INVALID', 'overlap 必须小于对应最大长度。', False)
    if result['childFixedMinChars'] > result['childFixedTargetChars'] or result['childFixedTargetChars'] > result['childFixedMaxChars']:
        raise StageError('CHUNK_CONFIG_INVALID', 'Child Fixed 长度必须满足 min ≤ target ≤ max。', False)
    if result['childFixedOverlapChars'] >= result['childFixedMaxChars']:
        raise StageError('CHUNK_CONFIG_INVALID', 'Child Fixed overlap 必须小于最大长度。', False)
    if result['llmMaxChars'] < 1 or result['llmTimeoutMs'] < 1_000 or result['llmMaxOutputTokens'] < 1:
        raise StageError('CHUNK_CONFIG_INVALID', 'LLM 输入、超时和输出长度必须为有效正数。', False)
    if any(code == 'STRUCTURE' for code in result['parentStrategies'][1:]):
        raise StageError('CHUNK_CONFIG_INVALID', 'Parent STRUCTURE 只能作为第一策略。', False)
    if 'STRUCTURE' in result['childStrategies'] and result['childStrategies'] != ['STRUCTURE']:
        raise StageError('CHUNK_CONFIG_INVALID', 'Child STRUCTURE 必须是唯一策略。', False)
    if 'LLM' in result['childStrategies'] and result['childStrategies'].index('LLM') != 0:
        raise StageError('CHUNK_CONFIG_INVALID', 'Child LLM 必须是第一策略，后续只能继续做确定性收敛。', False)
    if result.get('mode') == 'custom' and 'LLM' in result['childStrategies'] and not bool(result.get('llmEnabled')):
        raise StageError('CHUNK_CONFIG_INVALID', '自定义 Child 使用 LLM 时必须先启用 llmEnabled。', False)
    if result.get('regexPattern') and not isinstance(result['regexPattern'], str):
        raise StageError('CHUNK_CONFIG_INVALID', 'regexPattern 必须是文本。', False)
    if result.get('regexPattern'):
        if len(result['regexPattern']) > 256 or re.search(r'\\[1-9]|\(\?<|\(\?>', result['regexPattern']):
            raise StageError('CHUNK_CONFIG_INVALID', '正则表达式包含不支持的回溯或前瞻语法。', False)
        try:
            regex_mode = (re.I if 'i' in result.get('regexFlags', []) else 0) | (re.M if 'm' in result.get('regexFlags', []) else 0)
            re.compile(result['regexPattern'], regex_mode)
        except re.error as exc:
            raise StageError('CHUNK_CONFIG_INVALID', f'正则表达式无效：{exc}。', False) from exc
    if result.get('regexFlags') is not None and (not isinstance(result.get('regexFlags'), list) or any(flag not in {'i', 'm'} for flag in result.get('regexFlags', []))):
        raise StageError('CHUNK_CONFIG_INVALID', 'regexFlags 只支持 i、m。', False)
    if result.get('regexBoundary', 'before') not in {'before', 'after'}:
        raise StageError('CHUNK_CONFIG_INVALID', 'regexBoundary 必须是 before 或 after。', False)
    if any(code == 'REGEX' for name in ('parentStrategies', 'childStrategies') for code in result[name]) and not result.get('regexPattern'):
        raise StageError('CHUNK_CONFIG_INVALID', '选择 REGEX 策略时必须填写正则表达式。', False)
    return result


def section_context_prefix(section_path: list[dict[str, Any]]) -> tuple[str, str]:
    title = section_title(section_path)
    path_text = section_path_text(section_path)
    if not title:
        return '', ''
    context = f'章节：{title}'
    if path_text and path_text != title:
        context = f'章节路径：{path_text}\n章节：{title}'
    return context, context + '\n\n'


def context_body_limit(section_path: list[dict[str, Any]], max_chars: int) -> int:
    """Reserve the complete section prefix before a hard text budget is applied."""
    context, prefix = section_context_prefix(section_path)
    if not context:
        return max(1, int(max_chars))
    limit = int(max_chars) - len(prefix)
    if limit < 1:
        raise StageError('CHUNK_CONTEXT_TOO_LONG', '章节上下文已超过当前块长度上限，请提高对应 Parent 或 Child 最大长度。', False)
    return limit


def render_context(section_path: list[dict[str, Any]], body: str, max_chars: int | None = None) -> tuple[str, str]:
    body = clean_text(body)
    context, prefix = section_context_prefix(section_path)
    if not context:
        return body if max_chars is None else body[:max_chars], ''
    if max_chars is not None:
        body_limit = context_body_limit(section_path, max_chars)
        if len(body) > body_limit:
            raise StageError('CHUNK_CONTEXT_BUDGET_EXCEEDED', '切块正文未为章节上下文预留长度预算。', False)
    return prefix + body, context
