import { createHash } from 'node:crypto';
import { extractMarkdownEvidenceBlocks, extractMarkdownKnowledgeFacts } from './markdownAst';
import { buildCurrentNoteStructure, getMarkdownLineOffsets } from './currentNoteStructure';
import { countNoteAnalysisCharacters } from './noteAnalysisLengthPolicy';
import type { NoteAnalysisPreparationStats, NoteAnalysisSourceSpan } from './noteAnalysisTypes';

export const NOTE_ANALYSIS_PREPARATION_VERSION = 'markdown-clean-exact-block-v1';

interface TextMapping {
  cleanedFrom: number;
  cleanedTo: number;
  sourceFrom: number;
  sourceTo: number;
}

export interface NoteAnalysisPreparedUnit {
  source: NoteAnalysisSourceSpan;
  headingPath: string[];
  headingId: string;
  text: string;
  mapping: TextMapping[];
  duplicateSpans: NoteAnalysisSourceSpan[];
}

/** 只在主进程快照内使用，映射与正文不通过任务IPC发给渲染进程。 */
export interface NoteAnalysisPreparedDocument {
  version: string;
  sourceTextHash: string;
  units: NoteAnalysisPreparedUnit[];
  excluded: Array<{ source: NoteAnalysisSourceSpan; reason: 'noise' | 'duplicate'; duplicateOf?: string }>;
  stats: NoteAnalysisPreparationStats;
}

export function noteAnalysisTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function noteAnalysisLineAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

/** 保留code/table逐行内容；正文只去噪，不做大小写、数字或语义归一化。 */
function cleanUnit(markdown: string, source: NoteAnalysisSourceSpan): { text: string; mapping: TextMapping[] } {
  const raw = markdown.slice(source.startOffset, source.endOffset);
  const trimmed = raw.trim();
  const protectedBlock = source.kind === 'code' || source.kind === 'table';
  if (!protectedBlock && (/^(?:<!--[\s\S]*?-->\s*)+$/u.test(trimmed) || ((source.kind === 'other' || source.kind === 'paragraph') && /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/u.test(trimmed)))) return { text: '', mapping: [] };
  const pieces: Array<{ text: string; sourceFrom: number; sourceTo: number }> = [];
  let cursor = source.startOffset;
  let blankLines = 0;
  for (const line of raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!line[0]) continue;
    const newline = /\r\n$|\r$|\n$/u.exec(line[0])?.[0] ?? '';
    const content = newline ? line[0].slice(0, -newline.length) : line[0];
    const isBlank = !content.trim();
    const keepLine = protectedBlock || !isBlank || (pieces.length > 0 && blankLines < 2);
    blankLines = isBlank ? blankLines + 1 : 0;
    if (keepLine) {
      const trailing = protectedBlock ? 0 : /[\t ]+$/u.exec(content)?.[0].length ?? 0;
      const hardBreak = !protectedBlock && / {2,}$/u.test(content) ? 2 : 0;
      const contentEnd = content.length - trailing;
      for (let index = 0; index < contentEnd; index += 1) {
        const character = content[index];
        if (cursor + index === 0 && character === '\uFEFF') continue;
        const code = character.charCodeAt(0);
        if (!protectedBlock && ((code < 32 && code !== 9) || code === 127 || character === '\u200B' || character === '\uFEFF')) continue;
        pieces.push({ text: character, sourceFrom: cursor + index, sourceTo: cursor + index + 1 });
      }
      for (let index = content.length - hardBreak; index < content.length; index += 1) pieces.push({ text: content[index], sourceFrom: cursor + index, sourceTo: cursor + index + 1 });
      if (newline) pieces.push({ text: '\n', sourceFrom: cursor + content.length, sourceTo: cursor + line[0].length });
    }
    cursor += line[0].length;
  }
  // 块之间由规划器补分隔符，移除的末尾空行仍通过原文source范围保留来源。
  while (pieces.at(-1)?.text === '\n' && !protectedBlock) pieces.pop();
  const mapping: TextMapping[] = [];
  let text = '';
  for (const piece of pieces) {
    const previous = mapping.at(-1);
    const from = text.length;
    text += piece.text;
    if (previous && previous.sourceTo === piece.sourceFrom && previous.sourceTo - previous.sourceFrom === previous.cleanedTo - previous.cleanedFrom && piece.sourceTo - piece.sourceFrom === piece.text.length) {
      previous.cleanedTo = text.length;
      previous.sourceTo = piece.sourceTo;
    } else mapping.push({ cleanedFrom: from, cleanedTo: text.length, sourceFrom: piece.sourceFrom, sourceTo: piece.sourceTo });
  }
  return { text, mapping };
}

/** 清洗和精确块去重只改变模型输入，原文坐标与重复出现的位置全部保存。 */
export function prepareNoteAnalysisInput(markdown: string): NoteAnalysisPreparedDocument {
  const facts = extractMarkdownKnowledgeFacts(markdown);
  const structure = buildCurrentNoteStructure({ markdown, contentHash: facts.contentHash, headings: facts.headings });
  const offsets = structure.lineOffsets;
  const units: NoteAnalysisPreparedUnit[] = [];
  const excluded: NoteAnalysisPreparedDocument['excluded'] = [];
  const seen = new Map<string, NoteAnalysisPreparedUnit>();
  let unitIndex = 0;
  let originalBodyCharacters = 0;
  let duplicateCharacters = 0;
  const add = (startOffset: number, endOffset: number, kind: NoteAnalysisSourceSpan['kind']) => {
    const raw = markdown.slice(startOffset, endOffset);
    originalBodyCharacters += countNoteAnalysisCharacters(raw);
    if (!raw.trim()) return;
    unitIndex += 1;
    const lineFrom = noteAnalysisLineAt(offsets, startOffset);
    const source: NoteAnalysisSourceSpan = { startOffset, endOffset, kind, unitIndex, unitId: `unit-${unitIndex}`, lineFrom, lineTo: noteAnalysisLineAt(offsets, Math.max(startOffset, endOffset - 1)) };
    const heading = structure.headings.filter(heading => heading.lineFrom <= lineFrom && heading.lineTo >= lineFrom).at(-1);
    const headingPath = heading?.path ?? [];
    const headingId = heading ? `heading:${heading.headingId}` : 'document-preamble';
    const cleaned = cleanUnit(markdown, source);
    if (!cleaned.text.trim()) { excluded.push({ source, reason: 'noise' }); return; }
    const key = noteAnalysisTextHash(JSON.stringify({ kind, headingId, text: cleaned.text }));
    const prior = countNoteAnalysisCharacters(cleaned.text) >= 80 ? seen.get(key) : undefined;
    if (prior) {
      prior.duplicateSpans.push(source);
      excluded.push({ source, reason: 'duplicate', duplicateOf: prior.source.unitId });
      duplicateCharacters += countNoteAnalysisCharacters(cleaned.text);
      return;
    }
    const unit = { source, headingPath: [...headingPath], headingId, ...cleaned, duplicateSpans: [] };
    units.push(unit);
    seen.set(key, unit);
  };
  let cursor = 0;
  for (const block of extractMarkdownEvidenceBlocks(markdown)) {
    const start = offsets[block.lineFrom - 1] ?? 0;
    const end = offsets[block.lineTo] ?? markdown.length;
    if (start > cursor) add(cursor, start, 'other');
    if (block.kind !== 'heading' && block.kind !== 'frontmatter') add(start, end, block.kind);
    cursor = Math.max(cursor, end);
  }
  if (cursor < markdown.length) add(cursor, markdown.length, 'other');
  if (!units.length) throw new Error('当前笔记清洗后没有可分析的正文。');
  return { version: NOTE_ANALYSIS_PREPARATION_VERSION, sourceTextHash: noteAnalysisTextHash(markdown), units, excluded, stats: { sourceCharacters: countNoteAnalysisCharacters(markdown), originalBodyCharacters, cleanedBodyCharacters: countNoteAnalysisCharacters(units.map(unit => unit.text).join('\n\n')), duplicateBlocks: excluded.filter(entry => entry.reason === 'duplicate').length, duplicateCharacters, removedBlocks: excluded.filter(entry => entry.reason === 'noise').length } };
}

function sourceBoundary(unit: NoteAnalysisPreparedUnit, boundary: number): number {
  if (boundary === 0) return unit.source.startOffset;
  if (boundary === unit.text.length) return unit.source.endOffset;
  const segment = unit.mapping.find(entry => entry.cleanedFrom <= boundary && entry.cleanedTo > boundary);
  if (!segment) throw new Error('清洗输入的原文映射缺失。');
  return segment.sourceFrom + (boundary - segment.cleanedFrom);
}

/** 切分清洗文本时映射回原文，保持CRLF与emoji边界完整。 */
export function preparedNoteAnalysisSpan(unit: NoteAnalysisPreparedUnit, from: number, to: number, offsets: readonly number[]): NoteAnalysisSourceSpan {
  const startOffset = sourceBoundary(unit, from);
  const endOffset = sourceBoundary(unit, to);
  return { ...unit.source, cleanedFrom: from, cleanedTo: to, startOffset, endOffset, lineFrom: noteAnalysisLineAt(offsets, startOffset), lineTo: noteAnalysisLineAt(offsets, Math.max(startOffset, endOffset - 1)) };
}

export function readPreparedNoteAnalysisSpans(document: NoteAnalysisPreparedDocument, spans: readonly NoteAnalysisSourceSpan[]): string {
  const byId = new Map(document.units.map(unit => [unit.source.unitId, unit]));
  return spans.map(span => {
    const unit = byId.get(span.unitId);
    if (!unit || span.cleanedFrom === undefined || span.cleanedTo === undefined) throw new Error('分析批次缺少清洗文本映射，请重新分析。');
    return unit.text.slice(span.cleanedFrom, span.cleanedTo);
  }).join('\n\n');
}

export function getPreparedNoteAnalysisOffsets(markdown: string): number[] {
  return getMarkdownLineOffsets(markdown);
}
