/** File byte versions are independent of the knowledge index's decoded-text hash. */
export interface NoteDiskVersion {
  diskHash: string;
  byteLength: number;
  mtimeMs: number;
}

export interface NoteEditSnapshot {
  libraryPath: string;
  path: string;
  editSessionId: string;
  content: string;
  version: NoteDiskVersion;
}

export interface SaveNoteRequest {
  editSessionId: string;
  requestId: string;
  editRevision: number;
  expectedDiskHash: string;
  content: string;
}

export type SaveNoteResult =
  | { status: 'committed' | 'unchanged'; requestId: string; editRevision: number; version: NoteDiskVersion; indexState: 'pending' | 'current' | 'degraded'; content?: string }
  | { status: 'conflict'; requestId: string; code: 'NOTE_VERSION_CONFLICT' | 'NOTE_MISSING'; currentVersion?: NoteDiskVersion; message: string }
  | { status: 'failed'; requestId: string; code: string; message: string; retryable: boolean };

export interface NoteMutationRequest extends Omit<SaveNoteRequest, 'content'> {
  action: 'tags' | 'restore';
  tags?: string[];
  backupId?: string;
}

export interface NoteCloseRequest { requestId: string }
export interface NoteCloseResponse extends NoteCloseRequest { ok: boolean }
export interface NoteSaveState { editSessionId?: string; editRevision?: number; diskHash?: string; indexState: 'pending' | 'current' | 'degraded'; message?: string }

export interface NoteIndexChanged {
  libraryPath: string;
  libraryGeneration: number;
  indexRevision: number;
  changes: Array<{ kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }>;
  changedFields: Array<'content' | 'title' | 'tags' | 'links' | 'tree'>;
  source: 'application' | 'external' | 'mixed' | 'reconcile';
  nodes: Array<{ path: string; name: string; title?: string; isDirectory: boolean; kind: string; extension?: string }>;
  orders?: Record<string, string[]>;
}
