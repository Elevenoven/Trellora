from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable, Iterable

from .stage_errors import StageCancelled, StageError
from .lines_stage import normalize_text


SIGNAL_SCHEMA_VERSION = 1
RULE_VERSION = 'p3-rules-7'
BATCH_SIZE = 800
CONTEXT_LIMIT = 8_000
TITLE_SCAN_LIMIT = 50
LIST_CONFIDENCE_THRESHOLD = 0.35
HEADING_CONFIDENCE_THRESHOLD = 0.85
BASE_HEADING_CONFIDENCE = 0.50

SIGNAL_TYPES = (
    'DOCUMENT_TITLE', 'HEADING', 'HEADING_CANDIDATE', 'STEP_ITEM', 'LIST_ITEM',
    'TABLE_ROW', 'QUOTE', 'BODY', 'BLANK', 'NOISE', 'SEPARATOR',
)

RULE_SPECS = (
    {'ruleId': 'blank', 'priority': 1, 'version': RULE_VERSION, 'positive': [''], 'negative': ['普通正文']},
    {'ruleId': 'noise', 'priority': 2, 'version': RULE_VERSION, 'positive': ['第 3 页', '版权所有 2026'], 'negative': ['第 3 章 总则', '## 岗位职责']},
    {'ruleId': 'separator', 'priority': 2, 'version': RULE_VERSION, 'positive': ['---', '***', '- - -', '##'], 'negative': ['## 适用范围', '- 列表项', '***强调***']},
    {'ruleId': 'fenced-code', 'priority': 3, 'version': RULE_VERSION, 'positive': ['```\n# 代码注释\n```'], 'negative': ['# 正文标题']},
    {'ruleId': 'markdown-heading', 'priority': 3, 'version': RULE_VERSION, 'positive': ['## 适用范围'], 'negative': ['这是 ## 正文']},
    {'ruleId': 'explicit-step', 'priority': 4, 'version': RULE_VERSION, 'positive': ['第一步：安装依赖'], 'negative': ['第一步工作已经完成。']},
    {'ruleId': 'cn-chapter', 'priority': 5, 'version': RULE_VERSION, 'positive': ['第一章 总则'], 'negative': ['第一章内容如下。']},
    {'ruleId': 'appendix', 'priority': 6, 'version': RULE_VERSION, 'positive': ['附录 A 接口清单'], 'negative': ['详见附录。']},
    {'ruleId': 'numeric-heading', 'priority': 7, 'version': RULE_VERSION, 'positive': ['1.2 适用范围'], 'negative': ['版本 1.2 已发布。']},
    {'ruleId': 'table-row', 'priority': 8, 'version': RULE_VERSION, 'positive': ['| 名称 | 说明 |'], 'negative': ['A | B 是两个条件。']},
    {'ruleId': 'quote', 'priority': 9, 'version': RULE_VERSION, 'positive': ['> 引用内容'], 'negative': ['引用内容如下。']},
    {'ruleId': 'checkbox', 'priority': 10, 'version': RULE_VERSION, 'positive': ['- [x] 已完成'], 'negative': ['[x]不是复选框']},
    {'ruleId': 'unordered-list', 'priority': 11, 'version': RULE_VERSION, 'positive': ['- 安装依赖'], 'negative': ['减法 - 安装依赖']},
    {'ruleId': 'ambiguous-outline-score', 'priority': 12, 'version': RULE_VERSION, 'positive': ['1、项目背景', '（一）范围'], 'negative': ['1、第一项\n2、第二项', '包含以下内容：\n1、第一项']},
)

MARKDOWN_HEADING_PATTERN = re.compile(r'^ {0,3}#{1,6}\s+\S+')
CN_CHAPTER_PATTERN = re.compile(r'^第\s*[一二三四五六七八九十百千万\d]+\s*[章节篇部回]\s*\S+')
APPENDIX_PATTERN = re.compile(r'^附录(?:\s*[A-Z一二三四五六七八九十\d]+)?(?:\s*[：:、.．\-—]|\s+)\S+')
_SEPARATOR_SYMBOLS = frozenset('-—–―_*＊=＝=~～·•・。.…─━═')


def run_signals_stage(
    input_path: str,
    output_dir: str,
    document_id: str,
    content_hash: str,
    cancel_event: Event,
    progress: Callable[[int, int | None, str, str], None],
    stage_key: str = '',
) -> dict[str, Any]:
    lines_path = Path(input_path)
    output = Path(output_dir)
    if not lines_path.is_file():
        raise StageError('SIGNALS_INPUT_NOT_FOUND', '逻辑行产物不存在，无法执行规则分类。', False)
    output.mkdir(parents=True, exist_ok=True)
    signals_path = output / 'signals.jsonl'
    checkpoint_path = output / 'checkpoint.json'
    checkpoint = _read_checkpoint(checkpoint_path, stage_key)
    resume_line = int(checkpoint.get('lastLineNo', 0)) if checkpoint else 0
    batch_index = int(checkpoint.get('batchIndex', 0)) if checkpoint else 0
    emitted = int(checkpoint.get('signals', 0)) if checkpoint else 0
    title_selection = _restore_title_selection(checkpoint.get('documentTitle')) if checkpoint else None
    if resume_line > 0 and not signals_path.is_file():
        resume_line = 0
        batch_index = 0
        emitted = 0
    counts, frequencies, first_lines, last_lines, explicit_h1_lines = _profile_lines(lines_path, cancel_event)
    if title_selection is None:
        title_selection = _select_title(
            explicit_h1_lines,
            cancel_event,
            counts['lines'],
            frequencies,
            first_lines,
            last_lines,
        )
    mode = 'a' if resume_line > 0 else 'w'
    batch: list[dict[str, Any]] = []
    batch_line_text: list[str] = []
    total_signals = 0

    try:
        with signals_path.open(mode, encoding='utf-8', newline='\n') as destination:
            for previous_line, line, next_line in _iter_line_context(lines_path):
                _raise_if_cancelled(cancel_event)
                line_no = int(line.get('lineNo', 0))
                if line_no <= resume_line:
                    continue
                signal = classify_line(
                    line,
                    counts['lines'],
                    frequencies,
                    first_lines,
                    last_lines,
                    previous_line=previous_line,
                    next_line=next_line,
                )
                batch.append(signal)
                batch_line_text.append(str(line.get('normalizedText') or ''))
                total_signals += 1
                if len(batch) >= BATCH_SIZE:
                    batch_index += 1
                    _write_batch(destination, document_id, content_hash, batch_index, batch, batch_line_text, title_selection if batch_index == 1 and resume_line == 0 else None)
                    emitted += len(batch)
                    _write_checkpoint(checkpoint_path, stage_key, line_no, batch_index, emitted, title_selection, False)
                    destination.flush()
                    progress(line_no, counts['lines'], 'signal', f'已完成第 {batch_index} 个信号批次。')
                    batch = []
                    batch_line_text = []
            if batch:
                batch_index += 1
                last_line_no = int(batch[-1]['lineNo'])
                _write_batch(destination, document_id, content_hash, batch_index, batch, batch_line_text, title_selection if batch_index == 1 and resume_line == 0 else None)
                emitted += len(batch)
                _write_checkpoint(checkpoint_path, stage_key, last_line_no, batch_index, emitted, title_selection, False)
            destination.flush()
        _raise_if_cancelled(cancel_event)
        heading_count = _count_signal_type(signals_path, {'HEADING', 'HEADING_CANDIDATE'})
        candidate_count = _count_signal_type(signals_path, {'HEADING_CANDIDATE'})
        report = {
            'schemaVersion': SIGNAL_SCHEMA_VERSION,
            'stage': 'signals',
            'stageKey': stage_key,
            'ruleVersion': RULE_VERSION,
            'batchSize': BATCH_SIZE,
            'counts': {
                'lines': counts['lines'],
                'signals': emitted,
                'batches': batch_index,
                'headings': heading_count,
                'headingCandidates': candidate_count,
            },
            'generatedAt': datetime.now(timezone.utc).isoformat(),
        }
        _write_json(output / 'signal-report.json', report)
        _write_checkpoint(checkpoint_path, stage_key, counts['lines'], batch_index, emitted, title_selection, True)
        progress(counts['lines'], counts['lines'], 'signal', f'规则信号分类完成，共 {emitted} 行。')
        return report['counts']
    except StageError:
        raise
    except Exception as exc:
        raise StageError('SIGNALS_WRITE_FAILED', f'规则信号阶段写入失败：{exc}', True) from exc


def classify_line(
    line: dict[str, Any],
    total_lines: int,
    frequencies: Counter[str],
    first_lines: set[int],
    last_lines: set[int],
    previous_line: dict[str, Any] | None = None,
    next_line: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raw_text = str(line.get('rawText') or '')
    normalized_text = str(line.get('normalizedText') or normalize_text(raw_text))
    line_no = int(line.get('lineNo', 0))
    source = line.get('source') if isinstance(line.get('source'), dict) else {}
    source_payload = dict(source)
    if line.get('blockId'):
        source_payload['blockId'] = line['blockId']
    signal_type, rule_id, confidence, reason, score_breakdown = _classify_type_with_evidence(
        normalized_text,
        line_no,
        total_lines,
        frequencies,
        first_lines,
        last_lines,
        previous_line,
        next_line,
        current_line=line,
    )
    return {
        'signalId': f's-{line_no:06d}',
        'lineNo': line_no,
        'type': signal_type,
        'rawText': raw_text,
        'normalizedText': normalized_text,
        'confidence': confidence,
        'ruleId': rule_id,
        'ruleVersion': RULE_VERSION,
        'source': source_payload,
        **({'reason': reason} if reason else {}),
        **({'scoreBreakdown': score_breakdown} if score_breakdown else {}),
    }


def _classify_type(text: str, line_no: int, total_lines: int, frequencies: Counter[str], first_lines: set[int], last_lines: set[int]) -> tuple[str, str, float, str | None]:
    return _classify_type_with_evidence(text, line_no, total_lines, frequencies, first_lines, last_lines)[:4]


def _classify_type_with_evidence(
    text: str,
    line_no: int,
    total_lines: int,
    frequencies: Counter[str],
    first_lines: set[int],
    last_lines: set[int],
    previous_line: dict[str, Any] | None = None,
    next_line: dict[str, Any] | None = None,
    current_line: dict[str, Any] | None = None,
) -> tuple[str, str, float, str | None, dict[str, Any] | None]:
    if bool((current_line or {}).get('inCodeFence')):
        return 'BODY', 'fenced-code', 1.0, None, {'inCodeFence': True}
    if not text:
        return 'BLANK', 'blank', 1.0, None, None
    if _is_separator(text):
        return 'SEPARATOR', 'separator', 0.97, None, None
    if _is_noise(text, line_no, total_lines, frequencies, first_lines, last_lines):
        return 'NOISE', 'noise', 0.98, 'page-or-repeated-header-footer', None
    if MARKDOWN_HEADING_PATTERN.match(text):
        return 'HEADING', 'markdown-heading', 0.99, None, None
    if re.match(r'^(?:第\s*[一二三四五六七八九十百千万\d]+\s*步|步骤\s*[一二三四五六七八九十百千万\d]+)\s*[：:、.．\-—]?\s*\S+', text):
        return 'STEP_ITEM', 'explicit-step', 0.98, None, None
    if CN_CHAPTER_PATTERN.match(text):
        return 'HEADING', 'cn-chapter', 0.98, None, None
    if APPENDIX_PATTERN.match(text):
        return 'HEADING', 'appendix', 0.96, None, None
    if re.match(r'^\s*\d+(?:\.\d+){1,}(?:[.)、]|\s+)\s*\S+', text):
        return 'HEADING', 'numeric-heading', 0.94, None, None
    if _parse_ambiguous_outline_marker(text):
        score, breakdown = _score_ambiguous_outline(text, line_no, previous_line, next_line, current_line)
        if score >= HEADING_CONFIDENCE_THRESHOLD:
            return 'HEADING', 'scored-outline-heading', score, None, breakdown
        if score <= LIST_CONFIDENCE_THRESHOLD:
            return 'LIST_ITEM', 'scored-outline-list', score, None, breakdown
        return 'HEADING_CANDIDATE', 'ambiguous-outline-score', score, 'score-inconclusive', breakdown
    if _is_table_row(text):
        return 'TABLE_ROW', 'table-row', 0.96, None, None
    if re.match(r'^\s*>\s?', text) or text.startswith(('“', '”')):
        return 'QUOTE', 'quote', 0.95, None, None
    if re.match(r'^\s*(?:[-*+]\s+)?\[[ xX]\]\s+\S+', text):
        return 'LIST_ITEM', 'checkbox', 0.99, None, None
    if re.match(r'^\s*[-*+]\s+\S+', text) or re.match(r'^\s*•\s+\S+', text):
        return 'LIST_ITEM', 'unordered-list', 0.97, None, None
    if _looks_like_heading_candidate(text):
        return 'HEADING_CANDIDATE', 'heading-candidate', 0.58, 'short-title-like-line', None
    return 'BODY', 'fallback-body', 0.75, None, None


def _parse_ambiguous_outline_marker(text: str) -> dict[str, Any] | None:
    value = text.strip()
    arabic = re.match(r'^(?P<number>\d+)(?P<delimiter>[、.)．.])(?P<body>\s*\S.*)$', value)
    if arabic:
        body = str(arabic.group('body')).strip()
        # 1.2 is a hierarchical heading and is handled by numeric-heading above.
        if arabic.group('delimiter') in {'.', '．'} and body[:1].isdigit():
            return None
        return {
            'family': 'arabic',
            'number': int(arabic.group('number')),
            'body': body,
            'marker': f"{arabic.group('number')}{arabic.group('delimiter')}",
        }

    chinese = re.match(
        r'^(?P<marker>\([一二三四五六七八九十百千万零〇两\d]+\)|（[一二三四五六七八九十百千万零〇两\d]+）|[一二三四五六七八九十百千万零〇两]+[、.．])(?P<body>\s*\S.*)$',
        value,
    )
    if not chinese:
        return None
    body = str(chinese.group('body')).strip()
    marker = str(chinese.group('marker'))
    marker_value = marker.strip('()（）').rstrip('、.．')
    return {
        'family': 'chinese',
        'number': _chinese_number_to_int(marker_value),
        'body': body,
        'marker': marker,
    }


def _chinese_number_to_int(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    digits = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
    units = {'十': 10, '百': 100, '千': 1000, '万': 10_000}
    if not value or any(char not in digits and char not in units for char in value):
        return None
    total = 0
    section = 0
    number = 0
    for char in value:
        if char in digits:
            number = digits[char]
        else:
            unit = units[char]
            if unit == 10_000:
                section = (section + number) * unit
                total += section
                section = 0
                number = 0
            else:
                section += (number or 1) * unit
                number = 0
    return total + section + number


def _line_text(line: dict[str, Any] | None) -> str:
    if not isinstance(line, dict):
        return ''
    return str(line.get('normalizedText') or line.get('rawText') or '').strip()


def _line_number(line: dict[str, Any] | None) -> int | None:
    if not isinstance(line, dict):
        return None
    try:
        return int(line.get('lineNo'))
    except (TypeError, ValueError):
        return None


def _are_adjacent(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    left_no = _line_number(left)
    right_no = _line_number(right)
    return left_no is not None and right_no is not None and left_no + 1 == right_no


def _looks_like_plain_heading_body(text: str) -> bool:
    if len(text) < 2 or len(text) > 80:
        return False
    if text.endswith(('。', '！', '？', '；', ':', '：', '，', ',', '.', '。')):
        return False
    return not text.startswith(('http://', 'https://', '```'))


def _score_ambiguous_outline(
    text: str,
    line_no: int,
    previous_line: dict[str, Any] | None,
    next_line: dict[str, Any] | None,
    current_line: dict[str, Any] | None = None,
) -> tuple[float, dict[str, Any]]:
    marker = _parse_ambiguous_outline_marker(text) or {'family': 'unknown', 'number': None, 'body': text, 'marker': ''}
    previous_text = _line_text(previous_line)
    next_text = _line_text(next_line)
    blank_before = (previous_line is not None and not previous_text) or bool((current_line or {}).get('blankBefore'))
    blank_after = (next_line is not None and not next_text) or bool((next_line or {}).get('blankBefore'))
    current_line = {'lineNo': line_no}
    previous_marker = _parse_ambiguous_outline_marker(previous_text) if _are_adjacent(previous_line, current_line) else None
    next_marker = _parse_ambiguous_outline_marker(next_text) if _are_adjacent(current_line, next_line) else None

    sequence_detected = False
    current_number = marker.get('number')
    if current_number is not None:
        if previous_marker and previous_marker.get('family') == marker.get('family') and previous_marker.get('number') is not None:
            sequence_detected = int(previous_marker['number']) + 1 == int(current_number)
        if next_marker and next_marker.get('family') == marker.get('family') and next_marker.get('number') is not None:
            sequence_detected = sequence_detected or int(current_number) + 1 == int(next_marker['number'])

    plain_heading = _looks_like_plain_heading_body(str(marker.get('body') or text))
    previous_colon = bool(previous_text.endswith((':', '：')))
    score = BASE_HEADING_CONFIDENCE
    score += 0.20 if plain_heading else 0.0
    score += 0.10 if blank_before else 0.0
    score += 0.10 if blank_after else 0.0
    score -= 0.35 if sequence_detected else 0.0
    score -= 0.25 if previous_colon else 0.0
    score = round(max(0.0, min(1.0, score)), 3)
    return score, {
        'base': BASE_HEADING_CONFIDENCE,
        'plainHeading': 0.20 if plain_heading else 0.0,
        'blankBefore': 0.10 if blank_before else 0.0,
        'blankAfter': 0.10 if blank_after else 0.0,
        'sequencePenalty': -0.35 if sequence_detected else 0.0,
        'previousColonPenalty': -0.25 if previous_colon else 0.0,
        'markerFamily': marker.get('family'),
        'markerValue': marker.get('number'),
        'sequenceDetected': sequence_detected,
        'previousColon': previous_colon,
        'blankBeforeDetected': blank_before,
        'blankAfterDetected': blank_after,
    }


def _is_separator(text: str) -> bool:
    # Symbol-only lines (---, ***, - - -, ———) and bare heading markers with
    # no following text are visual dividers, not heading candidates.
    if re.match(r'^ {0,3}#{1,6}\s*$', text):
        return True
    stripped = text.replace(' ', '')
    return len(stripped) >= 2 and all(ch in _SEPARATOR_SYMBOLS for ch in stripped)


def _has_explicit_heading_syntax(text: str) -> bool:
    # Explicit structural markers win over the repeated running-head
    # heuristic so template documents (job posts, contracts) keep their
    # repeated section headings.
    return bool(
        MARKDOWN_HEADING_PATTERN.match(text)
        or CN_CHAPTER_PATTERN.match(text)
        or APPENDIX_PATTERN.match(text)
    )


def _is_noise(text: str, line_no: int, total_lines: int, frequencies: Counter[str], first_lines: set[int], last_lines: set[int]) -> bool:
    if _has_explicit_heading_syntax(text):
        return False
    if re.match(r'^[-—]?\s*(?:第\s*)?\d+\s*(?:/\s*\d+\s*)?(?:页|page)?\s*[-—]?$', text, re.IGNORECASE):
        return True
    if re.search(r'(?:版权所有|版权声明|copyright|©)', text, re.IGNORECASE):
        return True
    return frequencies[text] >= 3 and (line_no in first_lines or line_no in last_lines) and len(text) <= 120


def _is_table_row(text: str) -> bool:
    if not (text.startswith('|') and text.endswith('|')):
        return False
    cells = [cell.strip() for cell in text.strip('|').split('|')]
    return len(cells) >= 2 and all(len(cell) <= 200 for cell in cells)


def _looks_like_heading_candidate(text: str) -> bool:
    if len(text) < 2 or len(text) > 80:
        return False
    if text.endswith(('。', '！', '？', '；', ':', '：', '，', ',', '.', '。')):
        return False
    if text.startswith(('http://', 'https://', '```')):
        return False
    return not bool(re.match(r'^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+', text))


def _profile_lines(path: Path, cancel_event: Event) -> tuple[dict[str, int], Counter[str], set[int], set[int], list[dict[str, Any]]]:
    frequencies: Counter[str] = Counter()
    first_lines: set[int] = set()
    explicit_h1_lines: list[dict[str, Any]] = []
    total = 0
    for line in _iter_jsonl(path):
        _raise_if_cancelled(cancel_event)
        total += 1
        line_no = int(line.get('lineNo', total))
        if line_no <= 5:
            first_lines.add(line_no)
        text = str(line.get('normalizedText') or '')
        if text and len(text) <= 160 and (text in frequencies or len(frequencies) < 50_000):
            frequencies[text] += 1
        if re.match(r'^ {0,3}#\s+', text):
            explicit_h1_lines.append(line)
    last_lines = {max(1, total - offset) for offset in range(5)}
    return {'lines': total}, frequencies, first_lines, last_lines, explicit_h1_lines


def _select_title(
    lines: Iterable[dict[str, Any]],
    cancel_event: Event,
    total_lines: int,
    frequencies: Counter[str],
    first_lines: set[int],
    last_lines: set[int],
) -> dict[str, Any] | None:
    candidates: list[tuple[int, dict[str, Any]]] = []
    explicit_h1_count = 0
    for line in lines:
        _raise_if_cancelled(cancel_event)
        line_no = int(line.get('lineNo', 0))
        text = str(line.get('normalizedText') or '')
        if not text or not re.match(r'^ {0,3}#\s+', text):
            continue
        signal_type, rule_id, confidence, _reason, _score = _classify_type_with_evidence(
            text,
            line_no,
            total_lines,
            frequencies,
            first_lines,
            last_lines,
            current_line=line,
        )
        if signal_type != 'HEADING':
            continue
        explicit_h1_count += 1
        if line_no <= TITLE_SCAN_LIMIT:
            candidates.append((line_no, _make_title_selection(line, text, signal_type, rule_id, confidence)))
    # A lone explicit Markdown H1 can represent the document title. Once the
    # document contains peer H1 headings, their source hierarchy is stronger
    # evidence: promoting the first one would make every later H1 its child.
    if explicit_h1_count != 1 or len(candidates) != 1:
        return None
    return candidates[0][1]


def _make_title_selection(line: dict[str, Any], text: str, signal_type: str, rule_id: str, confidence: float) -> dict[str, Any]:
    source = dict(line.get('source')) if isinstance(line.get('source'), dict) else {}
    if line.get('blockId'):
        source['blockId'] = line['blockId']
    if line.get('page') is not None:
        source.setdefault('page', line['page'])
    if line.get('sourceRef') is not None:
        source.setdefault('sourceRef', line['sourceRef'])
    return {
        'text': _clean_title_text(text),
        'rawText': str(line.get('rawText') or text),
        'lineNo': int(line.get('lineNo', 0)),
        'source': source,
        'sourceSignalType': signal_type,
        'sourceRuleId': rule_id,
        'confidence': confidence,
    }


def _clean_title_text(text: str) -> str:
    value = re.sub(r'^\s*#{1,6}\s+', '', text).strip()
    wrappers = ('**', '__', '~~', '`')
    changed = True
    while changed:
        changed = False
        for wrapper in wrappers:
            if value.startswith(wrapper) and value.endswith(wrapper) and len(value) > len(wrapper) * 2:
                value = value[len(wrapper):-len(wrapper)].strip()
                changed = True
                break
    return value


def _restore_title_selection(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        text = str(value.get('text') or '').strip()
        return {**value, 'text': text} if text else None
    if isinstance(value, str) and value.strip():
        # Accept checkpoints written by p3-rules-1 so an interrupted task can resume safely.
        text = value.strip()
        return {'text': text, 'rawText': text, 'lineNo': 0, 'source': {}, 'confidence': 0.82}
    return None


def _write_batch(destination: Any, document_id: str, content_hash: str, batch_index: int, signals: list[dict[str, Any]], texts: list[str], title: dict[str, Any] | None) -> None:
    context = '\n'.join(texts)
    if len(context) > CONTEXT_LIMIT:
        context = context[:CONTEXT_LIMIT // 2] + '\n…\n' + context[-CONTEXT_LIMIT // 2:]
    title_source = dict(title.get('source')) if title and isinstance(title.get('source'), dict) else {}
    title_line_no = int(title.get('lineNo', 0)) if title else 0
    if title:
        title_source['synthetic'] = True
        if title_line_no > 0:
            title_source['derivedFromLineNo'] = title_line_no
    payload = {
        'schemaVersion': SIGNAL_SCHEMA_VERSION,
        'documentId': document_id,
        'contentHash': content_hash,
        'batchIndex': batch_index - 1,
        'firstLineNo': signals[0]['lineNo'],
        'lastLineNo': signals[-1]['lineNo'],
        'contextText': context,
        'signals': signals,
        **({'documentTitle': {
            'signalId': 's-title',
            'lineNo': 0,
            'type': 'DOCUMENT_TITLE',
            'rawText': str(title.get('rawText') or title['text']),
            'normalizedText': str(title['text']),
            'confidence': float(title.get('confidence', 0.82)),
            'ruleId': 'document-title',
            'ruleVersion': RULE_VERSION,
            'source': title_source,
            'derivedFromType': title.get('sourceSignalType'),
            'derivedFromRuleId': title.get('sourceRuleId'),
        }} if title else {}),
    }
    destination.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')


def _count_signal_type(path: Path, types: set[str]) -> int:
    count = 0
    for batch in _iter_jsonl(path):
        signals = batch.get('signals') if isinstance(batch.get('signals'), list) else []
        count += sum(1 for signal in signals if isinstance(signal, dict) and signal.get('type') in types)
    return count


def _iter_line_context(path: Path) -> Iterable[tuple[dict[str, Any] | None, dict[str, Any], dict[str, Any] | None]]:
    iterator = iter(_iter_jsonl(path))
    previous: dict[str, Any] | None = None
    current = next(iterator, None)
    while current is not None:
        following = next(iterator, None)
        yield previous, current, following
        previous, current = current, following


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open('r', encoding='utf-8', errors='replace') as stream:
        for value in stream:
            try:
                item = json.loads(value)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                yield item


def _read_checkpoint(path: Path, stage_key: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or value.get('stageKey') != stage_key or value.get('complete'):
            return None
        return value
    except (OSError, json.JSONDecodeError):
        return None


def _write_checkpoint(path: Path, stage_key: str, last_line_no: int, batch_index: int, signals: int, title: dict[str, Any] | None, complete: bool) -> None:
    _write_json(path, {
        'schemaVersion': SIGNAL_SCHEMA_VERSION,
        'stage': 'signals',
        'stageKey': stage_key,
        'lastLineNo': last_line_no,
        'batchIndex': batch_index,
        'signals': signals,
        'documentTitle': title,
        'complete': complete,
        'updatedAt': datetime.now(timezone.utc).isoformat(),
    })


def _write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f'.{path.name}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _raise_if_cancelled(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise StageCancelled()
