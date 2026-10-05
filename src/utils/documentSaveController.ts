import type { DocumentSnapshot, DocumentDraftRequest, DocumentDraftResult, DocumentSaveRequest, DocumentSaveResult, DocumentFormat } from '../../shared/documentSession';
import { rewriteDocumentReferences } from '../../shared/documentResourceManifest';

export interface DocumentTransport {
  updateDraft: (request: DocumentDraftRequest) => Promise<DocumentDraftResult>;
  save: (request: DocumentSaveRequest) => Promise<DocumentSaveResult>;
  saveAs: (request: DocumentSaveRequest) => Promise<DocumentSaveResult | null>;
}
/** 外部文件只手动提交；输入定时器仅更新应用私有恢复记录。 */
export class DocumentSaveController {
  snapshot?: DocumentSnapshot;
  content = '';
  revision = 0;
  persistedRevision = 0;
  status: 'clean' | 'dirty' | 'saving' | 'conflict' | 'error' = 'clean';
  message?: string;
  recoveryMessage?: string;
  private savedContent = '';
  private timer?: ReturnType<typeof setTimeout>;
  private syncing: Promise<void> = Promise.resolve();
  private saving?: Promise<boolean>;
  private pending?: { request: DocumentSaveRequest; mode: 'save' | 'saveAs' };
  private readonly transport: DocumentTransport;
  private readonly changed: () => void;
  constructor(transport: DocumentTransport, changed: () => void) { this.transport = transport; this.changed = changed; }
  get dirty(): boolean { return Boolean(this.snapshot && (this.content !== this.savedContent || this.pending || this.saving)); }
  get uncertain(): boolean { return Boolean(this.pending); }
  open(snapshot: DocumentSnapshot): void {
    this.cancelTimer(); this.snapshot = structuredClone(snapshot); this.content = snapshot.content;
    this.revision = snapshot.draftRevision; this.persistedRevision = snapshot.persistedRevision;
    this.savedContent = snapshot.persistedRevision < 0 ? '\u0000' : snapshot.content;
    this.pending = undefined; this.message = undefined; this.recoveryMessage = undefined; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
  }
  edit(content: string): void {
    if (!this.snapshot || content === this.content) return;
    this.content = content; this.revision++; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
    this.cancelTimer(); this.timer = setTimeout(() => { void this.synchronize().catch(() => undefined); }, 300);
  }
  acceptDraft(snapshot: DocumentSnapshot): void {
    if (snapshot.documentSessionId !== this.snapshot?.documentSessionId || snapshot.draftRevision < this.revision) throw new Error('文档已切换，AI 建议不能写入当前文件。');
    this.snapshot = structuredClone(snapshot); this.content = snapshot.content; this.revision = snapshot.draftRevision; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
  }
  request(): DocumentDraftRequest {
    if (!this.snapshot) throw new Error('请先打开独立文件。');
    return { documentSessionId: this.snapshot.documentSessionId, draftRevision: this.revision, content: this.content };
  }
  synchronize(): Promise<void> {
    this.cancelTimer(); if (!this.snapshot) return Promise.resolve();
    const request = this.request();
    this.syncing = this.syncing.catch(() => undefined).then(async () => {
      const result = await this.transport.updateDraft(request);
      if (request.documentSessionId !== this.snapshot?.documentSessionId) return;
      this.recoveryMessage = result.recoveryMessage; this.changed();
    });
    void this.syncing.catch(error => { this.message = `恢复草稿写入失败：${String(error)}`; this.status = 'error'; this.changed(); });
    return this.syncing;
  }
  save(mode: 'save' | 'saveAs' = 'save', formatOverride?: Partial<DocumentFormat>): Promise<boolean> {
    if (this.saving) return this.saving;
    if (!this.snapshot) return Promise.resolve(true);
    const task = this.performSave(mode, formatOverride).finally(() => { this.saving = undefined; this.changed(); });
    this.saving = task; return task;
  }
  private async performSave(mode: 'save' | 'saveAs', formatOverride?: Partial<DocumentFormat>): Promise<boolean> {
    try {
      await this.synchronize();
      const operation = this.pending ?? { mode, request: { ...this.request(), requestId: crypto.randomUUID(), expectedDiskHash: this.snapshot!.diskVersion.diskHash, formatOverride } };
      this.pending = operation; this.status = 'saving'; this.message = undefined; this.changed();
      const result = await this.transport[operation.mode](operation.request);
      this.pending = undefined;
      if (!result) { this.status = this.dirty ? 'dirty' : 'clean'; this.changed(); return false; }
      if (!('snapshot' in result)) { this.status = result.status === 'conflict' ? 'conflict' : 'error'; this.message = result.message; this.changed(); return false; }
      if (result.referenceReplacements) this.content = rewriteDocumentReferences(this.content, result.referenceReplacements);
      this.snapshot = { ...result.snapshot, content: this.content, draftRevision: this.revision };
      this.savedContent = result.committedContent ?? operation.request.content; this.persistedRevision = result.committedDraftRevision;
      this.recoveryMessage = result.recoveryMessage;
      this.status = this.content === this.savedContent ? 'clean' : 'dirty'; this.changed(); return true;
    } catch (error) { this.status = 'error'; this.message = String(error); this.changed(); return false; }
  }
  reset(): void { this.cancelTimer(); this.snapshot = undefined; this.pending = undefined; this.content = ''; this.message = undefined; this.recoveryMessage = undefined; this.status = 'clean'; this.changed(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
