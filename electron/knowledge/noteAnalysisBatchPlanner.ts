import { countNoteAnalysisCharacters, NOTE_ANALYSIS_MAX_INPUT, NOTE_ANALYSIS_OVERLAP } from './noteAnalysisLengthPolicy';
import { prepareNoteAnalysisInput, preparedNoteAnalysisSpan, readPreparedNoteAnalysisSpans, getPreparedNoteAnalysisOffsets, noteAnalysisTextHash, type NoteAnalysisPreparedDocument } from './noteAnalysisInputPreparation';
import type { NoteAnalysisBatchPlan, NoteAnalysisBatchSection, NoteAnalysisSourceSpan } from './noteAnalysisTypes';

export { noteAnalysisTextHash } from './noteAnalysisInputPreparation';

/** 原文来源核验使用未清洗快照；模型输入必须使用readPreparedNoteAnalysisSpans。 */
export function readNoteAnalysisSpans(markdown: string, spans: readonly NoteAnalysisSourceSpan[]): string {
  return spans.map(span => markdown.slice(span.startOffset, span.endOffset)).join('');
}

/** 以Unicode字符计数，并优先在后半段的行／句末切分。 */
function boundedEnd(text: string, start: number, end: number, limit: number, align = true): number {
  let cursor = start;
  let count = 0;
  while (cursor < end && count < limit) { cursor += (text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1; count += 1; }
  if (!align || cursor >= end) return Math.min(cursor, end);
  const fragment = text.slice(start, cursor);
  const minimum = boundedEnd(text, start, cursor, Math.floor(limit * 0.6), false) - start;
  for (const pattern of [/\n\s*\n/gu, /\n/gu, /[。！？]|[.!?](?=\s|$)/gu]) {
    const last = [...fragment.matchAll(pattern)].filter(match => match.index + match[0].length >= minimum).at(-1);
    if (last) return start + last.index + last[0].length;
  }
  return cursor;
}

interface Draft { coreSpans: NoteAnalysisSourceSpan[]; contextSpans: NoteAnalysisSourceSpan[] }

function plannerTools(markdown: string, document: NoteAnalysisPreparedDocument) {
  const offsets = getPreparedNoteAnalysisOffsets(markdown);
  const byId = new Map(document.units.map(unit => [unit.source.unitId, unit]));
  const text = (spans: NoteAnalysisSourceSpan[]) => readPreparedNoteAnalysisSpans(document, spans);
  const size = (spans: NoteAnalysisSourceSpan[]) => countNoteAnalysisCharacters(text(spans));
  const span = (original: NoteAnalysisSourceSpan, from: number, to: number) => preparedNoteAnalysisSpan(byId.get(original.unitId)!, from, to, offsets);
  const coalesce = (spans: NoteAnalysisSourceSpan[]) => {
    const result: NoteAnalysisSourceSpan[] = [];
    for (const core of spans) {
      const previous = result.at(-1);
      if (previous?.unitId === core.unitId && previous.cleanedTo === core.cleanedFrom) result[result.length - 1] = span(previous, previous.cleanedFrom!, core.cleanedTo!);
      else result.push(core);
    }
    return result;
  };
  const context = (previous: Draft | undefined, next: NoteAnalysisSourceSpan, maximum: number): NoteAnalysisSourceSpan[] => {
    if (!previous) return [];
    const last = previous.coreSpans.at(-1)!;
    // 完整章节边界无需重叠；同一长块或连续无标题正文才承接上批。
    if (last.unitId !== next.unitId && (byId.get(last.unitId)!.headingPath.length || byId.get(next.unitId)!.headingPath.length)) return [];
    const result: NoteAnalysisSourceSpan[] = [];
    for (const core of [...previous.coreSpans].reverse()) {
      const remaining = maximum - size(result) - (result.length ? 2 : 0);
      if (remaining <= 0) break;
      const unit = byId.get(core.unitId)!;
      const length = countNoteAnalysisCharacters(unit.text.slice(core.cleanedFrom, core.cleanedTo));
      let from = boundedEnd(unit.text, core.cleanedFrom!, core.cleanedTo!, Math.max(0, length - remaining), false);
      if (length > remaining) {
        const boundary = /\n|[。！？]/u.exec(unit.text.slice(from, Math.min(core.cleanedTo!, from + 250)));
        if (boundary) from += boundary.index + boundary[0].length;
      }
      if (from < core.cleanedTo!) result.unshift(span(core, from, core.cleanedTo!));
    }
    return result;
  };
  return { byId, size, span, context, coalesce };
}

function labelSections(sections: NoteAnalysisBatchSection[], full: boolean): string {
  const titles = sections.map(section => section.headingPath.join(' / ')).filter(Boolean);
  if (full) return titles.length ? `【全文｜${titles.length}个章节】` : '【全文】';
  const spans = sections.flatMap(section => section.coreSpans);
  const describe = (span: NoteAnalysisSourceSpan) => `${span.unitIndex}${span.partCount ? `（第${span.partIndex}/${span.partCount}部分）` : ''}`;
  const range = `正文块 ${describe(spans[0])}${spans.length > 1 ? `–${describe(spans.at(-1)!)}` : ''}`;
  if (titles.length) return `【${titles.slice(0, 2).join('；')}${titles.length > 2 ? ` 等${titles.length}个章节` : ''}｜${range}】`;
  return `【${range}】`;
}

/** 所有保留块逐字覆盖；合并章节只改变装箱边界，不丢标题及去重来源。 */
function finalize(markdown: string, document: NoteAnalysisPreparedDocument, drafts: Draft[], full: boolean): NoteAnalysisBatchPlan[] {
  const { byId, size } = plannerTools(markdown, document);
  for (const unit of document.units) {
    const parts = drafts.flatMap(draft => draft.coreSpans).filter(span => span.unitId === unit.source.unitId);
    let covered = 0;
    for (const [index, part] of parts.entries()) {
      if (part.cleanedFrom !== covered || part.cleanedTo! <= covered) throw new Error('清洗正文覆盖校验发现缺口或重复。');
      covered = part.cleanedTo!;
      if (parts.length > 1) { part.partIndex = index + 1; part.partCount = parts.length; }
    }
    if (covered !== unit.text.length) throw new Error('清洗正文尾部未进入分析批次。');
  }
  return drafts.map((draft, batchIndex) => {
    const sections: NoteAnalysisBatchSection[] = [];
    for (const core of draft.coreSpans) {
      const unit = byId.get(core.unitId)!;
      let section = sections.at(-1);
      if (!section || section.headingId !== unit.headingId) {
        section = { headingPath: [...unit.headingPath], headingId: unit.headingId, coreSpans: [], duplicateSpans: [] };
        sections.push(section);
      }
      section.coreSpans.push(core);
      if (core.cleanedFrom === 0) section.duplicateSpans.push(...unit.duplicateSpans);
    }
    const headingPath = [...sections[0].headingPath];
    while (headingPath.length && sections.some(section => headingPath.some((heading, index) => section.headingPath[index] !== heading))) headingPath.pop();
    const inputHash = noteAnalysisTextHash(JSON.stringify({ preparation: document.version, full, core: readPreparedNoteAnalysisSpans(document, draft.coreSpans), context: readPreparedNoteAnalysisSpans(document, draft.contextSpans), sections }));
    return { ...draft, batchIndex, batchId: `batch-${batchIndex}-${inputHash.slice(0, 16)}`, inputHash, sections, headingPath, mode: sections.some(section => section.headingPath.length) ? 'structured' : 'plain', processingMode: full ? 'full-document' : 'batched', sourceLabel: labelSections(sections, full), inputCharacterCount: size([...draft.contextSpans, ...draft.coreSpans]), overlapCharacterCount: size(draft.contextSpans) };
  });
}

/** 全文模式由完整提示词的token预算准入，不受长笔记的12000字符切块上限约束。 */
export function planFullNoteAnalysis(markdown: string, document = prepareNoteAnalysisInput(markdown)): NoteAnalysisBatchPlan {
  const offsets = getPreparedNoteAnalysisOffsets(markdown);
  return finalize(markdown, document, [{ coreSpans: document.units.map(unit => preparedNoteAnalysisSpan(unit, 0, unit.text.length, offsets)), contextSpans: [] }], true)[0];
}

/** 跨标题装箱，接近容量后优先章节边界；仅过长的单块继续拆分。 */
export function planNoteAnalysisBatches(markdown: string, maxInputCharacters = NOTE_ANALYSIS_MAX_INPUT, document = prepareNoteAnalysisInput(markdown)): NoteAnalysisBatchPlan[] {
  if (!Number.isInteger(maxInputCharacters) || maxInputCharacters < 256 || maxInputCharacters > NOTE_ANALYSIS_MAX_INPUT) throw new Error('分析批次字符预算无效。');
  const { byId, size, span, context, coalesce } = plannerTools(markdown, document);
  const overlap = Math.min(NOTE_ANALYSIS_OVERLAP, Math.floor(maxInputCharacters / 4));
  const drafts: Draft[] = [];
  let unitIndex = 0;
  let cursor = 0;
  while (unitIndex < document.units.length) {
    const first = document.units[unitIndex];
    const draft: Draft = { coreSpans: [], contextSpans: context(drafts.at(-1), span(first.source, cursor, first.text.length), overlap) };
    while (unitIndex < document.units.length) {
      const unit = document.units[unitIndex];
      const used = size([...draft.contextSpans, ...draft.coreSpans]);
      const capacity = maxInputCharacters - used - (draft.contextSpans.length || draft.coreSpans.length ? 2 : 0);
      const whole = countNoteAnalysisCharacters(unit.text.slice(cursor));
      const last = draft.coreSpans.at(-1);
      if (last && used >= maxInputCharacters * 0.85 && byId.get(last.unitId)!.headingId !== unit.headingId) break;
      if (last && whole > capacity && whole <= maxInputCharacters) break;
      if (capacity <= 0) break;
      const end = boundedEnd(unit.text, cursor, unit.text.length, capacity);
      draft.coreSpans.push(span(unit.source, cursor, end));
      cursor = end;
      if (cursor < unit.text.length) break;
      unitIndex += 1;
      cursor = 0;
    }
    if (!draft.coreSpans.length) throw new Error('批次规划未覆盖新的正文。');
    drafts.push(draft);
  }
  // 小尾批先合并；装不下则均分最后两批，避免额外一次调用只分析少量内容。
  if (drafts.length > 1 && size(drafts.at(-1)!.coreSpans) < maxInputCharacters * 0.3) {
    const previous = drafts.at(-2)!;
    const combined = coalesce([...previous.coreSpans, ...drafts.at(-1)!.coreSpans]);
    if (size([...previous.contextSpans, ...combined]) <= maxInputCharacters) {
      previous.coreSpans = combined;
      drafts.pop();
    } else {
      const target = Math.floor(size(combined) / 2);
      const left: NoteAnalysisSourceSpan[] = [];
      const right: NoteAnalysisSourceSpan[] = [];
      for (const core of combined) {
        const remaining = target - size(left) - (left.length ? 2 : 0);
        const unit = byId.get(core.unitId)!;
        const length = countNoteAnalysisCharacters(unit.text.slice(core.cleanedFrom, core.cleanedTo));
        if (right.length || remaining <= 0) right.push(core);
        else if (length <= remaining) left.push(core);
        else {
          const cut = boundedEnd(unit.text, core.cleanedFrom!, core.cleanedTo!, remaining);
          left.push(span(core, core.cleanedFrom!, cut));
          if (cut < core.cleanedTo!) right.push(span(core, cut, core.cleanedTo!));
        }
      }
      if (left.length && right.length && size([...previous.contextSpans, ...left]) <= maxInputCharacters) {
        const nextContext = context({ ...previous, coreSpans: left }, right[0], overlap);
        if (size([...nextContext, ...right]) <= maxInputCharacters) { previous.coreSpans = left; drafts.at(-1)!.coreSpans = right; drafts.at(-1)!.contextSpans = nextContext; }
      }
    }
  }
  for (const draft of drafts) draft.coreSpans = coalesce(draft.coreSpans);
  const batches = finalize(markdown, document, drafts, false);
  if (batches.some(batch => batch.inputCharacterCount > maxInputCharacters)) throw new Error('分析批次超过输入预算。');
  return batches;
}
