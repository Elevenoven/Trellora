import { createHash } from 'node:crypto';
import type { AssistantEvidenceCitation } from './assistantTurnTypes';
import { readMarkdownLineRange } from './currentNoteStructure';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { getLibraryNoteRecord, type LibraryNoteSnapshotMap } from './libraryNoteSnapshot';

export interface LibraryEvidenceRecord {
  evidenceId: string;
  libraryId: string;
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingPath: string[];
  /** Stable navigation metadata. It is intentionally excluded from evidence identity. */
  anchorHeadingId?: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  textHash: string;
  matchedTerms: string[];
  supports: string[];
  sourceToolCallId: string;
}

export interface LibraryEvidenceInput {
  noteId: string;
  headingPath: string[];
  anchorHeadingId?: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  matchedTerms: string[];
  supports: string[];
  sourceToolCallId: string;
}

/** Evidence is keyed by the scoped snapshot, not by title or path. */
export class LibraryEvidenceLedger {
  private records: LibraryEvidenceRecord[] = [];

  constructor(
    private readonly snapshotMap: LibraryNoteSnapshotMap,
    private readonly sessionId: string,
    private readonly maxRawEvidenceChars: number,
  ) {
    if (!Number.isSafeInteger(maxRawEvidenceChars) || maxRawEvidenceChars < 1) throw new Error('证据账本容量无效。');
    if (snapshotMap.sessionId !== sessionId) throw new Error('Evidence Ledger 会话范围不一致。');
  }

  get totalChars(): number {
    return this.records.reduce((total, record) => total + record.text.length, 0);
  }

  list(): LibraryEvidenceRecord[] {
    return this.records.map(copyRecord);
  }

  get(evidenceId: string): LibraryEvidenceRecord | undefined {
    const record = this.records.find((entry) => entry.evidenceId === evidenceId);
    return record ? copyRecord(record) : undefined;
  }

  add(input: LibraryEvidenceInput): { record: LibraryEvidenceRecord; added: boolean } {
    const snapshot = getLibraryNoteRecord(this.snapshotMap, input.noteId, this.sessionId).localSnapshot;
    assertEvidenceInput(snapshot, input);
    const overlaps = this.records.filter((record) => record.noteId === input.noteId
      && record.contentHash === snapshot.contentHash
      && record.lineFrom <= input.lineTo
      && record.lineTo >= input.lineFrom);
    const lineFrom = Math.min(input.lineFrom, ...overlaps.map((record) => record.lineFrom));
    const lineTo = Math.max(input.lineTo, ...overlaps.map((record) => record.lineTo));
    const text = overlaps.length
      ? readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo)
      : input.text;
    const nextTotalChars = this.totalChars - overlaps.reduce((total, record) => total + record.text.length, 0) + text.length;
    if (nextTotalChars > this.maxRawEvidenceChars) throw new Error('原始证据总量已达到本轮上限。');
    const matchedTerms = [...new Set([...overlaps.flatMap((record) => record.matchedTerms), ...input.matchedTerms])].sort(compareText);
    const supports = [...new Set([...overlaps.flatMap((record) => record.supports), ...input.supports])].sort(compareText);
    const anchorHeadingId = input.anchorHeadingId ?? overlaps[0]?.anchorHeadingId;
    const record: LibraryEvidenceRecord = {
      evidenceId: createEvidenceId(this.snapshotMap.libraryId, input.noteId, snapshot.snapshotId, lineFrom, lineTo, text),
      libraryId: this.snapshotMap.libraryId,
      noteId: input.noteId,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      headingPath: [...(overlaps[0]?.headingPath ?? input.headingPath)],
      ...(anchorHeadingId ? { anchorHeadingId } : {}),
      lineFrom,
      lineTo,
      text,
      textHash: sha256(text),
      matchedTerms,
      supports,
      sourceToolCallId: input.sourceToolCallId,
    };
    const unchanged = overlaps.length === 1
      && overlaps[0].lineFrom === record.lineFrom
      && overlaps[0].lineTo === record.lineTo
      && overlaps[0].textHash === record.textHash;
    this.records = [...this.records.filter((entry) => !overlaps.includes(entry)), record]
      .sort((first, second) => first.noteId.localeCompare(second.noteId) || first.lineFrom - second.lineFrom || first.lineTo - second.lineTo);
    return { record: copyRecord(record), added: !unchanged };
  }

  verifyEvidenceIds(evidenceIds: readonly string[]): string[] {
    return [...new Set(evidenceIds)].filter((evidenceId) => {
      const record = this.records.find((entry) => entry.evidenceId === evidenceId);
      if (!record) return false;
      const current = this.snapshotMap.records.get(record.noteId);
      if (!current || current.contentHash !== record.contentHash || current.snapshotId !== record.snapshotId) return false;
      const source = readMarkdownLineRange(current.localSnapshot.markdown, current.localSnapshot.lineOffsets, record.lineFrom, record.lineTo);
      return sha256(source) === record.textHash;
    });
  }

  toAssistantCitations(evidenceIds: readonly string[]): AssistantEvidenceCitation[] {
    const validIds = new Set(this.verifyEvidenceIds(evidenceIds));
    return this.records.filter((record) => validIds.has(record.evidenceId)).map((record) => {
      const source = this.snapshotMap.records.get(record.noteId);
      return {
        evidenceId: record.evidenceId,
        notePath: source?.localSnapshot.notePath ?? '[笔记已失效]',
        libraryId: record.libraryId,
        noteId: record.noteId,
        contentHash: record.contentHash,
        headingPath: [...record.headingPath],
        lineFrom: record.lineFrom,
        lineTo: record.lineTo,
        quoteHash: record.textHash,
        preview: record.text.replace(/\s+/gu, ' ').trim().slice(0, 240),
      };
    });
  }
}

function assertEvidenceInput(snapshot: CurrentNoteSnapshot, input: LibraryEvidenceInput): void {
  if (!Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo)
    || input.lineFrom < 1 || input.lineTo < input.lineFrom || input.lineTo > snapshot.lineCount) {
    throw new Error('证据行号无效。');
  }
  if (!input.text.trim()) throw new Error('证据正文不能为空。');
  if (input.anchorHeadingId !== undefined
    && !snapshot.headings.some((heading) => heading.headingId === input.anchorHeadingId)) {
    throw new Error('证据章节锚点不属于当前快照。');
  }
  const source = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, input.lineFrom, input.lineTo);
  if (source !== input.text) throw new Error('证据正文与库内快照不一致。');
}

function createEvidenceId(libraryId: string, noteId: string, snapshotId: string, lineFrom: number, lineTo: number, text: string): string {
  return `evidence-${sha256(`${libraryId}\u0000${noteId}\u0000${snapshotId}\u0000${lineFrom}\u0000${lineTo}\u0000${sha256(text)}`).slice(0, 24)}`;
}

function copyRecord(record: LibraryEvidenceRecord): LibraryEvidenceRecord {
  return {
    ...record,
    headingPath: [...record.headingPath],
    matchedTerms: [...record.matchedTerms],
    supports: [...record.supports],
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
