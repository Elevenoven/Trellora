import type { NoteEditSnapshot, SaveNoteRequest, SaveNoteResult } from '../../shared/noteSave';

export type NoteSaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';
export interface NoteSaveView { status: NoteSaveStatus; message?: string; frozen: boolean; path?: string; indexState?: 'current' | 'pending' | 'degraded' }

/** Keep the newest draft separate from the immutable in-flight request. */
export class NoteSaveController {
  snapshot?: NoteEditSnapshot;
  content = '';
  revision = 0;
  persistedRevision = 0;
  private pendingRequest?: SaveNoteRequest;
  private pendingMutation?: () => Promise<SaveNoteResult>;
  private flushPromise?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private status: NoteSaveStatus = 'clean';
  private frozen = false;
  private readonly freezeReasons = new Set<string>();
  private message?: string;
  private projection: 'current' | 'pending' | 'degraded' = 'current';
  private projectionRevision = 0;
  private readonly save: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
  private readonly changed: (view: NoteSaveView) => void;

  constructor(save: (request: SaveNoteRequest) => Promise<SaveNoteResult>, changed: (view: NoteSaveView) => void) {
    this.save = save;
    this.changed = changed;
  }

  get dirty(): boolean { return this.status === 'conflict' || this.revision !== this.persistedRevision || Boolean(this.pendingMutation) || Boolean(this.pendingRequest) || Boolean(this.flushPromise); }
  get blocked(): boolean { return this.frozen; }
  get saving(): boolean { return Boolean(this.flushPromise); }

  open(snapshot: NoteEditSnapshot): void {
    this.cancelTimer();
    const revision = this.snapshot?.editSessionId === snapshot.editSessionId ? this.revision : 0;
    this.snapshot = snapshot;
    this.content = snapshot.content;
    this.revision = this.persistedRevision = revision;
    this.projectionRevision = revision;
    this.projection = 'current';
    this.pendingRequest = undefined;
    this.pendingMutation = undefined;
    this.status = 'clean';
    this.message = undefined;
    this.notify();
  }

  edit(content: string, delay: number): void {
    if (this.frozen || !this.snapshot || content === this.content) return;
    this.content = content;
    this.revision++;
    if (this.status !== 'conflict') this.status = 'dirty';
    this.cancelTimer();
    if (this.status !== 'conflict') this.timer = setTimeout(() => { void this.flush(); }, delay);
    this.notify();
  }

  /** Wait for all edits, including a request that already left the renderer. */
  flush(): Promise<boolean> {
    this.cancelTimer();
    if (this.flushPromise) return this.flushPromise;
    if (this.status === 'conflict') return Promise.resolve(false);
    const task = this.performFlush().finally(() => { this.flushPromise = undefined; this.notify(); });
    this.flushPromise = task;
    return task;
  }

  private async performFlush(): Promise<boolean> {
    if (this.pendingMutation && !await this.finishMutation()) return false;
    while (this.snapshot && (this.revision !== this.persistedRevision || this.pendingRequest)) {
      const snapshot = this.snapshot;
      const request = this.pendingRequest ?? { editSessionId: snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: this.revision, expectedDiskHash: snapshot.version.diskHash, content: this.content };
      this.pendingRequest = request;
      this.status = 'saving';
      this.notify();
      let result: SaveNoteResult;
      try { result = await this.save(request); }
      catch (error) { this.status = 'error'; this.message = error instanceof Error ? error.message : String(error); this.notify(); return false; }
      this.pendingRequest = undefined;
      if (result.status === 'conflict' || result.status === 'failed') {
        this.status = result.status === 'conflict' ? 'conflict' : 'error';
        this.message = result.message;
        this.notify();
        return false;
      }
      snapshot.version = result.version;
      this.persistedRevision = request.editRevision;
      if (request.editRevision > this.projectionRevision) this.projection = result.indexState;
      this.message = this.projection === 'degraded' ? '内容已保存，索引更新失败。' : undefined;
    }
    this.status = 'clean';
    this.notify();
    return true;
  }

  /** Mutations and closing freeze edits before draining the existing draft. */
  async mutate<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (this.frozen) return undefined;
    this.freeze(true);
    try { if (!await this.flush()) return undefined; return await action(); }
    finally { this.freeze(false); }
  }

  nextMutation(): Omit<SaveNoteRequest, 'content'> {
    if (!this.snapshot) throw new Error('请先打开笔记。');
    return { editSessionId: this.snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: ++this.revision, expectedDiskHash: this.snapshot.version.diskHash };
  }

  /** Retain mutation identity when IPC fails after a possible disk commit. */
  async commitMutation(operation: (request: Omit<SaveNoteRequest, 'content'>) => Promise<SaveNoteResult>): Promise<boolean> {
    if (!this.frozen) throw new Error('修改笔记前必须冻结编辑并完成保存。');
    const request = this.nextMutation();
    this.pendingMutation = () => operation(request);
    return this.finishMutation();
  }
  private async finishMutation(): Promise<boolean> {
    try {
      const result = await this.pendingMutation!();
      this.pendingMutation = undefined;
      return this.acceptMutation(result);
    } catch (error) { this.status = 'error'; this.message = String(error); this.notify(); return false; }
  }

  acceptMutation(result: SaveNoteResult): boolean {
    if (result.status === 'failed' || result.status === 'conflict') { this.status = result.status === 'conflict' ? 'conflict' : 'error'; this.message = result.message; this.notify(); return false; }
    if (this.snapshot) { this.snapshot.version = result.version; this.snapshot.content = result.content ?? this.content; }
    if (this.revision === result.editRevision) this.content = result.content ?? this.content;
    this.persistedRevision = result.editRevision;
    if (result.editRevision > this.projectionRevision) this.projection = result.indexState;
    this.status = this.revision === this.persistedRevision ? 'clean' : 'dirty';
    this.message = this.projection === 'degraded' ? '内容已保存，索引更新失败。' : undefined;
    this.notify();
    return true;
  }

  conflict(message: string): void { this.cancelTimer(); this.status = 'conflict'; this.message = message; this.notify(); }
  indexState(message?: string): void { this.message = message; this.projection = message ? 'degraded' : 'current'; this.projectionRevision = this.persistedRevision; this.notify(); }
  acknowledgeIndex(state: 'current' | 'pending' | 'degraded', revision: number, message?: string): void {
    if (revision < this.revision || revision < this.persistedRevision || revision < this.projectionRevision || this.status === 'conflict' || this.status === 'error') return;
    this.projectionRevision = revision; this.projection = state; this.message = message; this.notify();
  }
  reset(): void { this.cancelTimer(); this.snapshot = undefined; this.pendingRequest = undefined; this.pendingMutation = undefined; this.revision = this.persistedRevision = 0; this.content = ''; this.status = 'clean'; this.notify(); }
  freeze(value: boolean, reason = 'default'): void { if (value) this.freezeReasons.add(reason); else this.freezeReasons.delete(reason); this.frozen = this.freezeReasons.size > 0; this.notify(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private notify(): void { this.changed({ status: this.status, message: this.message, frozen: this.frozen, path: this.snapshot?.path, indexState: this.projection }); }
}
