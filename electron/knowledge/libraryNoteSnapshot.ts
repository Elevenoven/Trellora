import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedNote, NoteIndex } from '../noteIndex';
import { createCurrentNoteSnapshotFromIndexedNote, type CurrentNoteSnapshot } from './currentNoteSnapshot';

export const LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * The renderer/model-facing part of a library note snapshot.  It deliberately
 * has no absolute or relative path.  Paths stay on the main-process record.
 */
export interface LibraryNoteSnapshotDescriptor {
  schemaVersion: typeof LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION;
  libraryId: string;
  noteId: string;
  snapshotId: string;
  title: string;
  contentHash: string;
  revision: number;
  lineCount: number;
  headings: Array<{ headingId: string; path: string[]; lineFrom: number; lineTo: number }>;
  topTerms: string[];
}

export interface LibraryNoteSnapshotRecord extends LibraryNoteSnapshotDescriptor {
  /** Main-process-only source. Never serialize this record into a prompt. */
  readonly localSnapshot: CurrentNoteSnapshot;
}

export interface LibraryNoteSnapshotMap {
  libraryId: string;
  sessionId: string;
  revision: number;
  indexState: 'latest' | 'updating' | 'stale';
  notes: LibraryNoteSnapshotDescriptor[];
  readonly records: Map<string, LibraryNoteSnapshotRecord>;
}

/** Replaces the scoped snapshot contents after an index refresh without changing its session scope. */
export function replaceLibraryNoteSnapshotMap(target: LibraryNoteSnapshotMap, next: LibraryNoteSnapshotMap): void {
  if (target.libraryId !== next.libraryId || target.sessionId !== next.sessionId) throw new Error('不能把其他库或会话的快照写入当前范围。');
  target.revision = next.revision;
  target.indexState = next.indexState;
  target.notes = next.notes.map((note) => ({ ...note, headings: note.headings.map((heading) => ({ ...heading, path: [...heading.path] })), topTerms: [...note.topTerms] }));
  target.records.clear();
  for (const [noteId, record] of next.records) target.records.set(noteId, { ...record, headings: record.headings.map((heading) => ({ ...heading, path: [...heading.path] })), topTerms: [...record.topTerms] });
}

export function createLibraryNoteSnapshotMap(input: {
  libraryPath: string;
  index: NoteIndex;
  sessionId: string;
  revision: number;
  indexState?: LibraryNoteSnapshotMap['indexState'];
}): LibraryNoteSnapshotMap {
  const records = new Map<string, LibraryNoteSnapshotRecord>();
  let libraryId: string | undefined;
  for (const note of input.index.notes) {
    const localSnapshot = createCurrentNoteSnapshotFromIndexedNote({
      libraryPath: input.libraryPath,
      note,
      revision: input.revision,
    });
    libraryId ??= localSnapshot.libraryId;
    if (libraryId !== localSnapshot.libraryId) throw new Error('笔记库快照的 libraryId 不一致。');
    const noteId = createLibraryNoteId(localSnapshot.libraryId, note.path, input.libraryPath);
    const descriptor = toLibraryNoteSnapshotDescriptor(localSnapshot, noteId);
    records.set(noteId, { ...descriptor, localSnapshot });
  }
  const resolvedLibraryId = libraryId ?? createLibraryId(input.libraryPath);
  return {
    libraryId: resolvedLibraryId,
    sessionId: assertScopeId(input.sessionId, 'sessionId'),
    revision: input.revision,
    indexState: input.indexState ?? 'latest',
    notes: [...records.values()].map(stripLocalSnapshot),
    records,
  };
}

export function createLibraryNoteSnapshotFromIndexedNote(input: {
  libraryPath: string;
  note: IndexedNote;
  revision: number;
}): LibraryNoteSnapshotRecord {
  const localSnapshot = createCurrentNoteSnapshotFromIndexedNote(input);
  const noteId = createLibraryNoteId(localSnapshot.libraryId, input.note.path, input.libraryPath);
  return { ...toLibraryNoteSnapshotDescriptor(localSnapshot, noteId), localSnapshot };
}

export function getLibraryNoteRecord(map: LibraryNoteSnapshotMap, noteId: string, sessionId: string): LibraryNoteSnapshotRecord {
  if (map.sessionId !== sessionId) throw new Error('当前工具调用不属于本次助手会话。');
  const record = map.records.get(noteId);
  if (!record) throw new Error('noteId 不属于当前笔记库快照。');
  return record;
}

export function createLibraryId(libraryPath: string): string {
  return `library-${sha256(normalizePath(path.resolve(libraryPath))).slice(0, 24)}`;
}

export function createLibraryNoteId(libraryId: string, notePath: string, libraryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(notePath)).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error('笔记不在当前笔记库内。');
  }
  return `note-${sha256(`${libraryId}\u0000${normalizePath(relativePath)}`).slice(0, 24)}`;
}

export function toLibraryNoteSnapshotDescriptor(snapshot: CurrentNoteSnapshot, noteId: string): LibraryNoteSnapshotDescriptor {
  const counts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return {
    schemaVersion: LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION,
    libraryId: snapshot.libraryId,
    noteId,
    snapshotId: snapshot.snapshotId,
    title: snapshot.title,
    contentHash: snapshot.contentHash,
    revision: snapshot.revision,
    lineCount: snapshot.lineCount,
    headings: snapshot.headings.slice(0, 120).map((heading) => ({
      headingId: heading.headingId,
      path: [...heading.path],
      lineFrom: heading.lineFrom,
      lineTo: heading.lineTo,
    })),
    topTerms: [...counts.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'zh-Hans-CN'))
      .slice(0, 20)
      .map(([term]) => term),
  };
}

function stripLocalSnapshot(record: LibraryNoteSnapshotRecord): LibraryNoteSnapshotDescriptor {
  const { localSnapshot: _localSnapshot, ...descriptor } = record;
  return descriptor;
}

function assertScopeId(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{7,96}$/u.test(value)) throw new Error(`${label} 无效。`);
  return value;
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').toLocaleLowerCase('en-US');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
