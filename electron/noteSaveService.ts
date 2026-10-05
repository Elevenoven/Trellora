import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteEditSnapshot, NoteSaveState, SaveNoteRequest, SaveNoteResult } from '../shared/noteSave';
import { atomicTextWrite, NoteFileError, readNoteBytes } from './atomicTextWrite';
import { getFileTypeInfo } from './fileTypes';
import { assertInsideDirectory } from './pathGuards';
import { createNoteBackup, pruneNoteBackups, type BackupEntry } from './noteBackups';

interface EditSession { sender: number; libraryPath: string; path: string; revision: number; requests: Map<string, { fingerprint: string; result: Promise<SaveNoteResult> }>; busy: number }
export interface NoteSaveServiceOptions {
  getLibraryPath: () => string | null;
  /** 兼容旧调用方；备份窗口现在固定为三份。 */
  backupRetention?: () => number;
  committed: (libraryPath: string, filePath: string, diskHash: string) => Promise<void>;
  state?: (sender: number, state: NoteSaveState) => void;
  timing?: (phase: string, durationMs: number) => void;
}

/** Owns editor authorization and application writes, while indexing remains a projection. */
export class NoteSaveService {
  private sessions = new Map<string, EditSession>();
  private writes = new Map<string, Promise<unknown>>();
  private structures = new Map<string, Promise<unknown>>();
  private projections = new Set<Promise<void>>();
  constructor(private readonly options: NoteSaveServiceOptions) {}

  async open(sender: number, filePath: string): Promise<NoteEditSnapshot> {
    const libraryPath = this.requireLibrary();
    const safePath = await this.safePath(libraryPath, filePath);
    const read = await readNoteBytes(safePath);
    const editSessionId = randomUUID();
    this.sessions.set(editSessionId, { sender, libraryPath, path: safePath, revision: 0, requests: new Map(), busy: 0 });
    return { libraryPath, path: safePath, editSessionId, content: read.content, version: read.version };
  }

  async refresh(sender: number, id: string): Promise<NoteEditSnapshot> {
    const session = this.session(sender, id);
    if (session.busy) throw new NoteFileError('NOTE_BUSY', '笔记仍在保存，请稍后重试。', true);
    const read = await readNoteBytes(await this.safePath(session.libraryPath, session.path));
    return { libraryPath: session.libraryPath, path: session.path, editSessionId: id, content: read.content, version: read.version };
  }

  close(sender: number, id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return true;
    if (session.sender !== sender || session.busy) return false;
    return this.sessions.delete(id);
  }

  pathForSession(sender: number, id: string): string { return this.session(sender, id).path; }

  release(sender: number): void { for (const [id, session] of this.sessions) if (session.sender === sender && !session.busy) this.sessions.delete(id); }

  /** Retry by request identity reuses the same commit; changed parameters are rejected. */
  save(sender: number, request: SaveNoteRequest, transform?: (current: string) => Promise<string> | string, operationKey = '', forceBackup = false): Promise<SaveNoteResult> {
    const fail = (code: string, message: string): Promise<SaveNoteResult> => Promise.resolve({ status: 'failed', requestId: request?.requestId ?? '', code, message, retryable: false });
    if (!request || typeof request.content !== 'string' || typeof request.requestId !== 'string' || !request.requestId || !Number.isSafeInteger(request.editRevision) || request.editRevision < 1 || !/^[a-f0-9]{64}$/.test(request.expectedDiskHash)) return fail('NOTE_REQUEST_INVALID', '笔记保存参数无效。');
    let session: EditSession;
    try { session = this.session(sender, request.editSessionId); } catch (error) { return fail('NOTE_SESSION_INVALID', (error as Error).message); }
    const fingerprint = JSON.stringify([request.editRevision, request.expectedDiskHash, request.content, operationKey, forceBackup]);
    const previous = session.requests.get(request.requestId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : fail('NOTE_REQUEST_MISMATCH', '同一次保存的重试参数不能变化。');
    session.busy++;
    const result = this.fileQueue(session.libraryPath, session.path, async (): Promise<SaveNoteResult> => {
      try {
        this.session(sender, request.editSessionId);
        if (request.editRevision <= session.revision) throw new NoteFileError('NOTE_REVISION_STALE', '该保存请求已过期，请使用最新编辑。');
        let started = performance.now();
        const safePath = await this.safePath(session.libraryPath, session.path);
        const current = await readNoteBytes(safePath);
        this.options.timing?.('version-read', performance.now() - started);
        if (current.version.diskHash !== request.expectedDiskHash) return { status: 'conflict', requestId: request.requestId, code: 'NOTE_VERSION_CONFLICT', currentVersion: current.version, message: '磁盘笔记已被其他程序修改，当前草稿已保留。' };
        const content = transform ? await transform(current.content) : request.content;
        let version = current.version;
        const unchanged = current.bytes.equals(Buffer.from(content, 'utf8'));
        if (!unchanged) {
          started = performance.now();
          await createNoteBackup(session.path, session.libraryPath, current.bytes, new Date(), forceBackup ? 0 : undefined);
          this.options.timing?.('backup', performance.now() - started);
          version = await atomicTextWrite(safePath, content, async () => {
            this.session(sender, request.editSessionId);
            await this.safePath(session.libraryPath, safePath);
            const check = await readNoteBytes(safePath);
            if (check.version.diskHash !== request.expectedDiskHash) throw new NoteFileError('NOTE_VERSION_CONFLICT', '磁盘笔记已发生变化，当前草稿已保留。');
          }, this.options.timing);
        }
        session.revision = request.editRevision;
        // 正文提交之前不删除任何旧备份；清理失败也不能把已提交的保存报告为失败。
        try { pruneNoteBackups(session.path, session.libraryPath); }
        catch (error) { console.warn('笔记已保存，旧备份清理暂未完成：', error); }
        const committed: SaveNoteResult = { status: unchanged ? 'unchanged' : 'committed', requestId: request.requestId, editRevision: request.editRevision, version, indexState: 'pending', ...(transform ? { content } : {}) };
        // Equal disk bytes do not prove a failed or pending index is current.
        const projection = Promise.resolve().then(() => this.options.committed(session.libraryPath, safePath, version.diskHash))
          .then(() => this.options.state?.(sender, { editSessionId: request.editSessionId, editRevision: request.editRevision, diskHash: version.diskHash, indexState: 'current' }))
          .catch(() => this.options.state?.(sender, { editSessionId: request.editSessionId, editRevision: request.editRevision, diskHash: version.diskHash, indexState: 'degraded', message: '内容已保存，索引更新失败，请重试索引。' }));
        this.projections.add(projection);
        void projection.finally(() => this.projections.delete(projection)).catch(() => undefined);
        return committed;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'NOTE_WRITE_FAILED';
        if (code === 'ENOENT' || code === 'NOTE_VERSION_CONFLICT') return { status: 'conflict', requestId: request.requestId, code: code === 'ENOENT' ? 'NOTE_MISSING' : code, message: code === 'ENOENT' ? '原笔记已被删除，当前草稿已保留，可另存为新笔记。' : (error as Error).message };
        return { status: 'failed', requestId: request.requestId, code, message: (error as Error).message, retryable: (error as NoteFileError).retryable ?? true };
      }
    }).finally(() => { session.busy--; });
    session.requests.set(request.requestId, { fingerprint, result });
    if (session.requests.size > 64) { const oldest = session.requests.keys().next().value; if (oldest) session.requests.delete(oldest); }
    return result;
  }

  /** Structural operations reserve the library before awaiting existing file writers. */
  async structure<T>(libraryPath: string, action: () => Promise<T> | T): Promise<T> {
    const library = path.resolve(libraryPath);
    const previous = this.structures.get(library) ?? Promise.resolve();
    const writers = [...this.writes.entries()].filter(([key]) => key.startsWith(`${library.toLowerCase()}\u0000`)).map(([, task]) => task);
    const task = previous.catch(() => undefined).then(() => Promise.allSettled(writers)).then(action);
    this.structures.set(library, task);
    try { return await task; } finally { if (this.structures.get(library) === task) this.structures.delete(library); }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.writes.values(), ...this.structures.values()]);
    await Promise.allSettled([...this.projections]);
  }

  /** 与保存共用单文件队列，让旧备份收敛到三份，避免读清单时清理尚未写完的备份。 */
  async listBackups(filePath: string): Promise<BackupEntry[]> {
    const library = this.requireLibrary();
    const safePath = await this.safePath(library, filePath);
    return this.fileQueue(library, safePath, async () => {
      if (this.requireLibrary() !== library) throw new NoteFileError('NOTE_LIBRARY_CHANGED', '笔记库已切换，请重新读取备份。');
      return pruneNoteBackups(await this.safePath(library, safePath), library);
    });
  }

  private fileQueue<T>(library: string, filePath: string, action: () => Promise<T>): Promise<T> {
    const key = `${library.toLowerCase()}\u0000${filePath.toLowerCase()}`;
    const task = Promise.allSettled([this.writes.get(key), this.structures.get(library)]).then(action);
    this.writes.set(key, task);
    void task.finally(() => { if (this.writes.get(key) === task) this.writes.delete(key); }).catch(() => undefined);
    return task;
  }

  private requireLibrary(): string { const library = this.options.getLibraryPath(); if (!library) throw new NoteFileError('NOTE_LIBRARY_MISSING', '请先打开笔记库。'); return path.resolve(library); }
  private session(sender: number, id: string): EditSession { const session = this.sessions.get(id); if (!session || session.sender !== sender || session.libraryPath !== this.requireLibrary()) throw new NoteFileError('NOTE_SESSION_INVALID', '笔记编辑会话已失效，请重新打开笔记。'); return session; }
  private async safePath(library: string, filePath: string): Promise<string> {
    if (typeof filePath !== 'string' || !getFileTypeInfo(filePath)) throw new NoteFileError('NOTE_TYPE_INVALID', '不支持的笔记文件。');
    assertInsideDirectory(filePath, library);
    const [root, real] = await Promise.all([fs.realpath(library), fs.realpath(filePath)]);
    assertInsideDirectory(real, root);
    if (!(await fs.stat(real)).isFile()) throw new NoteFileError('NOTE_TYPE_INVALID', '目标不是笔记文件。');
    return path.join(path.resolve(library), path.relative(root, real));
  }

}
