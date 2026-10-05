import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedNote } from '../noteIndex';
import { estimateTokenCount } from './tokenEstimator';
import { buildCurrentNoteStructure, type CurrentNoteEvidenceBlock, type CurrentNoteHeadingRange, type CurrentNoteHeadingSource } from './currentNoteStructure';

export const CURRENT_NOTE_INDEX_VERSION = 'current-note-structure-v2';

export interface CurrentNoteSnapshot {
  snapshotId: string;
  libraryId: string;
  notePath: string;
  relativePath: string;
  title: string;
  contentHash: string;
  revision: number;
  markdown: string;
  lineOffsets: number[];
  lineCount: number;
  tokenEstimate: number;
  headings: CurrentNoteHeadingRange[];
  blocks: CurrentNoteEvidenceBlock[];
  createdAt: string;
}

export interface CurrentNoteSnapshotInput {
  libraryPath: string;
  notePath: string;
  title: string;
  contentHash: string;
  markdown: string;
  headings: readonly CurrentNoteHeadingSource[];
  revision: number;
  indexVersion?: string;
  createdAt?: string;
}

/** Returns the immutable source block owned by this snapshot. */
export function getCurrentNoteSnapshotBlock(
  snapshot: CurrentNoteSnapshot,
  blockId: string,
): CurrentNoteSnapshot['blocks'][number] | undefined {
  return snapshot.blocks.find((block) => block.blockId === blockId);
}

export function createCurrentNoteSnapshot(input: CurrentNoteSnapshotInput): CurrentNoteSnapshot {
  const libraryPath = path.resolve(input.libraryPath);
  const notePath = path.resolve(input.notePath);
  const relativePath = path.relative(libraryPath, notePath).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error('当前笔记不在已打开的笔记库中。');
  }
  const calculatedHash = sha256(input.markdown);
  if (input.contentHash !== calculatedHash) throw new Error('当前笔记内容已变化，请保存后重试。');
  const structure = buildCurrentNoteStructure({
    markdown: input.markdown,
    contentHash: calculatedHash,
    headings: input.headings,
  });
  const libraryId = `library-${sha256(normalizePath(libraryPath)).slice(0, 24)}`;
  const indexVersion = input.indexVersion ?? CURRENT_NOTE_INDEX_VERSION;
  const snapshotId = `snapshot-${sha256(`${libraryId}\u0000${relativePath}\u0000${calculatedHash}\u0000${indexVersion}`).slice(0, 24)}`;
  return {
    snapshotId,
    libraryId,
    notePath,
    relativePath,
    title: input.title.trim() || path.basename(notePath, path.extname(notePath)),
    contentHash: calculatedHash,
    revision: input.revision,
    markdown: input.markdown,
    lineOffsets: structure.lineOffsets,
    lineCount: structure.lineCount,
    tokenEstimate: estimateTokenCount(input.markdown),
    headings: structure.headings,
    blocks: structure.blocks,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function createCurrentNoteSnapshotFromIndexedNote(input: {
  libraryPath: string;
  note: IndexedNote;
  revision: number;
  indexVersion?: string;
  createdAt?: string;
}): CurrentNoteSnapshot {
  return createCurrentNoteSnapshot({
    libraryPath: input.libraryPath,
    notePath: input.note.path,
    title: input.note.title,
    contentHash: input.note.contentHash,
    markdown: input.note.rawMarkdown,
    headings: input.note.headings,
    revision: input.revision,
    ...(input.indexVersion ? { indexVersion: input.indexVersion } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

/**
 * A library-wide revision may advance because another note changed. Compare
 * the indexed identity of this note so unrelated saves do not stale its turn.
 */
export function matchesCurrentNoteSnapshot(
  snapshot: CurrentNoteSnapshot,
  note: Pick<IndexedNote, 'path' | 'contentHash'> | undefined,
): boolean {
  return Boolean(note
    && normalizePath(path.resolve(note.path)) === normalizePath(snapshot.notePath)
    && note.contentHash === snapshot.contentHash);
}

/**
 * Keeps immutable snapshots by content hash. A changed note gets a new cache
 * entry, so in-flight work can retain its old evidence coordinates safely.
 */
export class CurrentNoteSnapshotCache {
  private readonly entries = new Map<string, CurrentNoteSnapshot>();
  private readonly maxEntries: number;

  constructor(maxEntries = 24) {
    this.maxEntries = maxEntries;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('快照缓存容量无效。');
  }

  getOrCreate(input: CurrentNoteSnapshotInput): CurrentNoteSnapshot {
    const key = snapshotCacheKey(input);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const snapshot = createCurrentNoteSnapshot(input);
    this.entries.set(key, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
    return snapshot;
  }

  invalidateNote(notePath: string): void {
    const normalizedPath = path.resolve(notePath);
    for (const [key, snapshot] of this.entries) {
      if (snapshot.notePath === normalizedPath) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function snapshotCacheKey(input: CurrentNoteSnapshotInput): string {
  return [path.resolve(input.notePath), input.contentHash, input.indexVersion ?? CURRENT_NOTE_INDEX_VERSION].join('\u0000');
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').toLocaleLowerCase('en-US');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
