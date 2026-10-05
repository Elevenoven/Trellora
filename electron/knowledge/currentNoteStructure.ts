import { createHash } from 'node:crypto';
import { extractMarkdownEvidenceBlocks, type MarkdownEvidenceBlockKind } from './markdownAst';
import { isTechnicalIdentifier, normalizeTechnicalTerm } from './lexicalMatchPolicy';

export interface CurrentNoteHeadingSource {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
}

export interface CurrentNoteHeadingRange {
  headingId: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  path: string[];
  lineFrom: number;
  lineTo: number;
}

export interface CurrentNoteEvidenceBlock {
  blockId: string;
  kind: MarkdownEvidenceBlockKind;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  normalizedTerms: string[];
  blockHash: string;
}

export interface CurrentNoteStructure {
  lineOffsets: number[];
  lineCount: number;
  headings: CurrentNoteHeadingRange[];
  blocks: CurrentNoteEvidenceBlock[];
}

export function buildCurrentNoteStructure(input: {
  markdown: string;
  contentHash: string;
  headings: readonly CurrentNoteHeadingSource[];
}): CurrentNoteStructure {
  const lineOffsets = getMarkdownLineOffsets(input.markdown);
  const lineCount = lineOffsets.length;
  const headings = buildHeadingRanges(input.headings, lineCount);
  const blocks = extractMarkdownEvidenceBlocks(input.markdown).map((block) => {
    const blockHash = sha256(block.text);
    return {
      blockId: `block-${sha256(`${input.contentHash}\u0000${block.kind}\u0000${block.lineFrom}\u0000${block.lineTo}\u0000${blockHash}`).slice(0, 24)}`,
      kind: block.kind,
      headingPath: getHeadingPathAtLine(headings, block.lineFrom),
      lineFrom: block.lineFrom,
      lineTo: block.lineTo,
      text: block.text,
      normalizedTerms: tokenizeCurrentNoteText(block.text),
      blockHash,
    };
  });

  return { lineOffsets, lineCount, headings, blocks };
}

export function getMarkdownLineOffsets(markdown: string): number[] {
  const offsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === '\r') {
      if (markdown[index + 1] === '\n') index += 1;
      offsets.push(index + 1);
    } else if (character === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

export function readMarkdownLineRange(markdown: string, lineOffsets: readonly number[], lineFrom: number, lineTo: number): string {
  if (!Number.isInteger(lineFrom) || !Number.isInteger(lineTo) || lineFrom < 1 || lineTo < lineFrom || lineTo > lineOffsets.length) {
    throw new Error('读取行范围无效。');
  }
  const start = lineOffsets[lineFrom - 1] ?? 0;
  const nextLineStart = lineOffsets[lineTo] ?? markdown.length;
  let end = nextLineStart;
  if (end > start && markdown[end - 1] === '\n') {
    end -= 1;
    if (end > start && markdown[end - 1] === '\r') end -= 1;
  } else if (end > start && markdown[end - 1] === '\r') {
    end -= 1;
  }
  return markdown.slice(start, end);
}

/** Shared deterministic tokenizer for block indexing and query coverage. */
export function tokenizeCurrentNoteText(value: string, maxTerms = 256): string[] {
  const terms = new Set<string>();
  const add = (term: string) => {
    const normalized = normalizeTechnicalTerm(term);
    if (normalized && terms.size < maxTerms) terms.add(normalized);
  };

  for (const chunk of value.match(/[\u3400-\u9fff]+|[A-Za-z][A-Za-z0-9_./:-]*|\d+(?:\.\d+)?/gu) ?? []) {
    if (/^[\u3400-\u9fff]+$/u.test(chunk)) {
      for (const character of chunk) add(character);
      for (let index = 0; index < chunk.length - 1; index += 1) add(chunk.slice(index, index + 2));
      continue;
    }
    add(chunk);
    for (const segment of splitIdentifier(chunk)) add(segment);
  }
  return [...terms];
}

export function normalizeCurrentNoteText(value: string): string {
  return normalizeTechnicalTerm(value).replace(/\s+/gu, '');
}

export function isCurrentNoteIdentifier(value: string): boolean {
  return isTechnicalIdentifier(value);
}

function buildHeadingRanges(headings: readonly CurrentNoteHeadingSource[], lineCount: number): CurrentNoteHeadingRange[] {
  const ordered = [...headings]
    .filter((heading) => heading.text.trim() && heading.line >= 1 && heading.line <= lineCount)
    .sort((first, second) => first.line - second.line || first.level - second.level || first.id.localeCompare(second.id));
  const stack: CurrentNoteHeadingRange[] = [];
  const usedHeadingIds = new Set<string>();
  return ordered.map((heading, index) => {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    const headingId = allocateUniqueHeadingId(heading.id, index, usedHeadingIds);
    const range: CurrentNoteHeadingRange = {
      headingId,
      level: heading.level,
      text: heading.text.trim(),
      path: [...stack.map((entry) => entry.text), heading.text.trim()],
      lineFrom: heading.line,
      lineTo: findHeadingEndLine(ordered, index, lineCount),
    };
    stack.push(range);
    return range;
  });
}

function allocateUniqueHeadingId(value: string, index: number, usedHeadingIds: Set<string>): string {
  const base = value.trim() || `heading-${index + 1}`;
  let headingId = base;
  let occurrence = 2;
  while (usedHeadingIds.has(headingId)) {
    headingId = `${base}-${occurrence}`;
    occurrence += 1;
  }
  usedHeadingIds.add(headingId);
  return headingId;
}

function findHeadingEndLine(headings: readonly CurrentNoteHeadingSource[], index: number, lineCount: number): number {
  const heading = headings[index];
  for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
    const next = headings[nextIndex];
    if (next.level <= heading.level) return Math.max(heading.line, next.line - 1);
  }
  return lineCount;
}

function getHeadingPathAtLine(headings: readonly CurrentNoteHeadingRange[], line: number): string[] {
  let current: CurrentNoteHeadingRange | undefined;
  for (const heading of headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) current = heading;
  }
  return current ? [...current.path] : [];
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .split(/[_./:-]+|\s+/u)
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/gu) ?? [])
    .filter(Boolean);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
