import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { DocumentSnapshot, DocumentOpenRequest, DocumentOpenResult, DocumentEncoding, DocumentDraftRequest, DocumentDraftResult, DocumentSaveRequest, DocumentSaveResult, DocumentCloseRequest, DocumentCloseResult, DocumentJoinRequest, DocumentJoinResult, DocumentDiskVersion } from '../../shared/documentSession';
import { EXTERNAL_TEXT_MAX_BYTES, EXTERNAL_MARKDOWN_RENDER_MAX_BYTES } from '../../shared/documentSession';
import { getFileTypeInfo } from '../fileTypes';
import { resolveRealAncestors } from '../pathGuards';
import { atomicByteWrite, byteHash } from '../atomicTextWrite';
import { decodeDocument, encodeDocument, normalizeDocumentText, DocumentError } from './textCodec';
import { hasDocumentLocalReferences } from '../../shared/documentResources';
import { ExternalRecoveryStore, type RecoveryRecord } from './externalRecoveryStore';
import { DocumentResourceService, type ResourcePublication } from './documentResourceService';
import { rewriteDocumentReferences } from '../../shared/documentResourceManifest';

interface Session { sender: number; snapshot: DocumentSnapshot; savedContent: string; requests: Map<string, { fingerprint: string; task: Promise<unknown> }>; transfers: Map<string, { revision: number; path: string; hash: string }>; busy: number; recoveryId: string; aliases?: Record<string, string> }
export interface DocumentSessionServiceOptions {
  recoveryRoot: string;
  libraries: () => string[];
  protectedRoots: () => string[];
  claimPath?: (filePath: string) => void;
  onReleased?: (sessionId: string) => void;
  joinLibrary: (libraryPath: string, fileName: string, content: string, publishResources?: (target: string) => Promise<ResourcePublication>) => Promise<{ path: string; indexState: 'pending' | 'current' | 'degraded'; content?: string }>;
}
const inside = (candidate: string, root: string) => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const diskVersion = (bytes: Buffer, mtimeMs: number): DocumentDiskVersion => ({ diskHash: byteHash(bytes), byteLength: bytes.length, mtimeMs });
/** 另存后，迟到的旧草稿引用也必须直接映射到当前目录。 */
function mergeReferenceAliases(previous: Record<string, string> | undefined, next: Record<string, string>): Record<string, string> {
  const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  return { ...Object.fromEntries(Object.entries(previous ?? {}).map(([key, value]) => [key, Object.entries(next).find(([href]) => decode(href) === decode(value))?.[1] ?? value])), ...next };
}

/** 只管理外部会话；已登记库路由回现有保存链，所有写入绑定真实文件与窗口。 */
export class DocumentSessionService {
  readonly recovery: ExternalRecoveryStore;
  readonly resources: DocumentResourceService;
  private sessions = new Map<string, Session>();
  private pending = new Map<string, { sender: number; path: string }>();
  private files = new Map<string, Promise<unknown>>();
  private closed = new Map<string, number>();
  constructor(private readonly options: DocumentSessionServiceOptions) {
    this.recovery = new ExternalRecoveryStore(options.recoveryRoot);
    this.resources = new DocumentResourceService({ privateRoot: path.join(options.recoveryRoot, 'draft-assets'), context: id => this.sessions.get(id)?.snapshot, protectedRoots: options.protectedRoots });
  }

  private classify(filePath: string): { real: string; library?: string } {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath) || !getFileTypeInfo(filePath)) throw new DocumentError('DOCUMENT_TYPE_INVALID', '不支持该文本格式，请选择 Markdown、TXT 或支持的文本文件。');
    const real = resolveRealAncestors(path.resolve(filePath));
    const roots = this.options.protectedRoots().map(root => resolveRealAncestors(path.resolve(root)));
    if (roots.some(root => inside(real, root)) || real.split(path.sep).some(part => ['.menghan-meta', '.menghan-backups'].includes(part.toLowerCase()))) throw new DocumentError('DOCUMENT_PROTECTED', '应用数据、备份和资料库原件不能通过独立文件入口编辑。');
    const library = this.options.libraries().find(root => inside(real, resolveRealAncestors(path.resolve(root))));
    return { real, library };
  }
  async enqueue(sender: number, filePath: string): Promise<DocumentOpenRequest> {
    const { real } = this.classify(filePath);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new DocumentError('DOCUMENT_TYPE_INVALID', '目标不是普通文件。');
    if (stat.size > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', '独立文本文件不能超过 20 MiB。');
    const prior = [...this.pending.entries()].find(([, r]) => r.sender === sender && r.path === real);
    if (prior) return { requestId: prior[0], displayPath: real };
    if (this.listRequests(sender).length >= 200) throw new DocumentError('DOCUMENT_OPEN_LIMIT', '待打开文件最多保留 200 个，请先处理现有请求。');
    const requestId = randomUUID(); this.pending.set(requestId, { sender, path: real });
    return { requestId, displayPath: real };
  }
  listRequests(sender: number): DocumentOpenRequest[] { return [...this.pending].filter(([, r]) => r.sender === sender).map(([requestId, r]) => ({ requestId, displayPath: r.path })); }
  finishRequest(sender: number, id: string): void { if (this.pending.get(id)?.sender !== sender) throw new DocumentError('DOCUMENT_SESSION_INVALID', '打开请求已失效。'); this.pending.delete(id); }

  /** 读取最多上限加一字节，并复核命名目标身份，避免增长文件导致无界 readFile。 */
  private async read(filePath: string): Promise<{ bytes: Buffer; version: DocumentDiskVersion }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const real = this.classify(filePath).real;
      if (real !== filePath) throw new DocumentError('DOCUMENT_CONFLICT', '文件路径已变化，请重新打开。');
      const handle = await fs.open(real, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new DocumentError('DOCUMENT_TYPE_INVALID', '目标不是普通文件。');
        if (before.nlink > 1) throw new DocumentError('DOCUMENT_TYPE_INVALID', '首期不支持硬链接文件，请打开普通文件副本。');
        if (before.size > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', '独立文本文件不能超过 20 MiB。');
        const chunks: Buffer[] = []; let length = 0;
        for (;;) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, EXTERNAL_TEXT_MAX_BYTES + 1 - length));
          const { bytesRead } = await handle.read(chunk);
          if (!bytesRead) break;
          length += bytesRead;
          if (length > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', '文件增长后超过 20 MiB，请使用其他编辑器。');
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const after = await handle.stat(), named = await fs.stat(real);
        if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.ino === named.ino && after.dev === named.dev && after.ctimeMs === named.ctimeMs && length === after.size) {
          const bytes = Buffer.concat(chunks); return { bytes, version: diskVersion(bytes, after.mtimeMs) };
        }
      } finally { await handle.close(); }
    }
    throw new DocumentError('DOCUMENT_CONFLICT', '文件正在被其他程序修改，请稍后重新打开。', true);
  }
  private capabilities(content: string, kind: 'markdown' | 'text', writable = true) {
    const local = kind === 'markdown' && hasDocumentLocalReferences(content), render = Buffer.byteLength(content) <= EXTERNAL_MARKDOWN_RENDER_MAX_BYTES;
    return { canEdit: true, canSaveInPlace: writable, canSaveAs: true, canJoinLibrary: true, canUseWysiwyg: kind === 'markdown' && !local && render, canPreviewMarkdown: kind === 'markdown' && render, canUseDocumentAi: true, canUseLibraryFeatures: false as const, canWriteLocalAssets: kind === 'markdown' };
  }
  private clone(session: Session): DocumentSnapshot { return structuredClone(session.snapshot); }
  async openRequest(sender: number, id: string, encoding?: DocumentEncoding): Promise<DocumentOpenResult> {
    const request = this.pending.get(id);
    if (!request || request.sender !== sender) throw new DocumentError('DOCUMENT_SESSION_INVALID', '打开请求已失效，请重新选择文件。');
    const { real, library } = this.classify(request.path);
    if (library) return { status: 'library', libraryPath: library, filePath: real };
    const prior = [...this.sessions.values()].find(s => s.sender === sender && s.snapshot.displayPath === real);
    if (prior) return { status: 'opened', snapshot: this.clone(prior) };
    this.options.claimPath?.(real);
    const read = await this.read(real);
    let decoded;
    try { decoded = decodeDocument(read.bytes, encoding); } catch (error) {
      if (error instanceof DocumentError && error.code === 'DOCUMENT_ENCODING_REQUIRED') return { status: 'encoding-required', message: error.message };
      throw error;
    }
    const kind = getFileTypeInfo(real)!.kind;
    const stat = await fs.stat(real);
    const snapshot: DocumentSnapshot = { documentSessionId: randomUUID(), source: { kind: 'external' }, displayPath: real, fileKind: kind, content: decoded.content, format: decoded.format, diskVersion: read.version, draftRevision: 0, persistedRevision: 0, capabilities: this.capabilities(decoded.content, kind, Boolean(stat.mode & 0o200)) };
    const session: Session = { sender, snapshot, savedContent: decoded.content, requests: new Map(), transfers: new Map(), busy: 0, recoveryId: snapshot.documentSessionId };
    this.sessions.set(snapshot.documentSessionId, session);
    await this.recovery.remember(real).catch(() => undefined);
    return { status: 'opened', snapshot: this.clone(session) };
  }
  private session(sender: number, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.sender !== sender) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档编辑会话已失效，请重新打开。');
    return session;
  }
  displayPath(sender: number, id: string): string { return this.session(sender, id).snapshot.displayPath; }
  snapshot(sender: number, id: string): DocumentSnapshot { return this.clone(this.session(sender, id)); }
  previewResources(sender: number, id: string) { this.session(sender, id); return this.resources.preview(id); }
  grantResourceRoot(sender: number, id: string, root: string): void { this.session(sender, id); this.resources.grantRoot(id, root); }
  openResourceLink(sender: number, id: string, href: string) { this.session(sender, id); return this.resources.openLink(id, href).then(file => this.enqueue(sender, file)); }
  async addDraftImage(sender: number, id: string, input: { bytes?: Uint8Array; extension?: string; sourcePath?: string }) {
    const session = this.session(sender, id); if (session.snapshot.fileKind !== 'markdown') throw new DocumentError('DOCUMENT_TYPE_INVALID', '纯文本文件不能插入图片。');
    const image = input.sourcePath ? await this.resources.imageFromPath(id, input.sourcePath) : await this.resources.addImage(id, input.bytes!, input.extension!);
    await this.recovery.write(this.record(session)); return { ...image, absolutePath: image.markdownPath };
  }
  hasActive(sender: number): boolean { return [...this.sessions.values()].some(session => session.sender === sender); }
  private record(session: Session): RecoveryRecord {
    const s = session.snapshot;
    return { version: 1, recoveryId: session.recoveryId, displayPath: s.displayPath, updatedAt: new Date().toISOString(), draftRevision: s.draftRevision, diskHash: s.diskVersion.diskHash, content: s.content, format: s.format, diskVersion: s.diskVersion, draftAssets: this.resources.assets(s.documentSessionId), state: s.content !== session.savedContent ? 'dirty' : 'clean' };
  }
  private queue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.files.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.files.set(key, task); void task.finally(() => { if (this.files.get(key) === task) this.files.delete(key); }).catch(() => undefined); return task;
  }
  private validateDraft(request: DocumentDraftRequest): void {
    if (!request || typeof request.documentSessionId !== 'string' || !Number.isSafeInteger(request.draftRevision) || request.draftRevision < 0 || typeof request.content !== 'string' || request.content.length > EXTERNAL_TEXT_MAX_BYTES || Buffer.byteLength(request.content) > EXTERNAL_TEXT_MAX_BYTES * 3 || normalizeDocumentText(request.content) !== request.content) throw new DocumentError('DOCUMENT_REQUEST_INVALID', '文档草稿参数无效。');
  }
  /** 草稿先完成主进程版本校验；私有恢复缓存不可写不能阻止用户提交原件。 */
  private async persistRecovery(session: Session): Promise<DocumentDraftResult> {
    try { await this.recovery.write(this.record(session)); return { recoveryState: 'current' }; }
    catch { return { recoveryState: 'degraded', recoveryMessage: '恢复缓存暂不可用，修改仍可手动保存或另存。' }; }
  }
  updateDraft(sender: number, request: DocumentDraftRequest): Promise<DocumentDraftResult> {
    this.validateDraft(request); const session = this.session(sender, request.documentSessionId);
    return this.queue(`session:${request.documentSessionId}`, async () => {
      this.session(sender, request.documentSessionId);
      if (request.draftRevision < session.snapshot.draftRevision) return this.persistRecovery(session);
      const content = session.aliases ? rewriteDocumentReferences(request.content, session.aliases) : request.content;
      if (request.draftRevision === session.snapshot.draftRevision && content !== session.snapshot.content) throw new DocumentError('DOCUMENT_REVISION_STALE', '同一草稿版本的内容不能变化。');
      session.snapshot.content = content; session.snapshot.draftRevision = request.draftRevision;
      session.snapshot.capabilities = this.capabilities(request.content, session.snapshot.fileKind, session.snapshot.capabilities.canSaveInPlace);
      return this.persistRecovery(session);
    });
  }
  private operation<T>(session: Session, requestId: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new DocumentError('DOCUMENT_REQUEST_INVALID', '请求标识无效。');
    const prior = session.requests.get(requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new DocumentError('DOCUMENT_REQUEST_MISMATCH', '同一操作的重试参数不能变化。'); return prior.task as Promise<T>; }
    session.busy++;
    const task = Promise.resolve().then(action).finally(() => { session.busy--; });
    session.requests.set(requestId, { fingerprint, task }); return task;
  }
  private assertDraft(session: Session, request: DocumentDraftRequest): void {
    this.validateDraft(request);
    if (session.snapshot.draftRevision !== request.draftRevision || session.snapshot.content !== request.content) throw new DocumentError('DOCUMENT_REVISION_STALE', '草稿版本已变化，请同步最新内容后重试。', true);
  }
  private async assertExternal(filePath: string): Promise<void> {
    const c = this.classify(filePath);
    if (c.library || c.real !== filePath) throw new DocumentError('DOCUMENT_PROTECTED', '目标属于笔记库或路径已变化，请通过笔记库保存。');
  }
  private failure(request: DocumentSaveRequest, error: unknown): DocumentSaveResult {
    const e = error as { code?: string; message?: string; retryable?: boolean };
    const missing = e.code === 'ENOENT', conflict = missing || ['DOCUMENT_CONFLICT', 'NOTE_VERSION_CONFLICT'].includes(e.code ?? '');
    return { status: conflict ? 'conflict' : 'failed', requestId: request.requestId, documentSessionId: request.documentSessionId, code: missing ? 'DOCUMENT_MISSING' : e.code ?? 'DOCUMENT_SAVE_FAILED', message: missing ? '原文件已被删除，草稿已保留，请另存为。' : e.message ?? '文档保存失败，草稿已保留。', retryable: e.retryable === true || ['EACCES', 'EPERM', 'EBUSY'].includes(e.code ?? '') };
  }
  save(sender: number, request: DocumentSaveRequest): Promise<DocumentSaveResult> {
    const session = this.session(sender, request?.documentSessionId);
    const copied = structuredClone(request);
    return this.operation(session, copied.requestId, JSON.stringify(['save', copied]), async () => {
      try {
        this.assertDraft(session, copied);
        if (!/^[a-f0-9]{64}$/.test(copied.expectedDiskHash)) throw new DocumentError('DOCUMENT_REQUEST_INVALID', '磁盘版本无效。');
        const target = session.snapshot.displayPath;
        return await this.queue(target, async () => {
          await this.assertExternal(target);
          const current = await this.read(target);
          if (current.version.diskHash !== copied.expectedDiskHash) throw new DocumentError('DOCUMENT_CONFLICT', '原文件已被其他程序修改，草稿已保留，请重新加载或另存。');
          const unchanged = copied.content === session.savedContent && !copied.formatOverride;
          let version = current.version, format = session.snapshot.format, publication: ResourcePublication | undefined, backupWarning: string | undefined;
          if (!unchanged) {
            publication = session.snapshot.fileKind === 'markdown' ? await this.resources.publish(copied.documentSessionId, copied.content, target, false) : undefined;
            let replaced = false;
            try {
            const encoded = encodeDocument(publication?.content ?? copied.content, format, copied.formatOverride);
            if (encoded.bytes.length > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', '保存内容不能超过 20 MiB。');
            if (!(await fs.stat(target)).mode || !((await fs.stat(target)).mode & 0o200)) throw new DocumentError('DOCUMENT_PERMISSION_DENIED', '原文件为只读，草稿已保留，请另存为。');
            const fileKey = createHash('sha256').update(target).digest('hex');
            await this.recovery.backup(fileKey, current.bytes).catch(() => { backupWarning = '文件已保存，但本次历史副本未生成。'; });
            try { version = await atomicByteWrite(target, encoded.bytes, async () => { await this.assertExternal(target); if ((await this.read(target)).version.diskHash !== copied.expectedDiskHash) throw new DocumentError('DOCUMENT_CONFLICT', '提交前原文件已变化，草稿已保留。'); }); }
            catch (error) { await publication?.rollback(); throw error; }
            replaced = true;
            format = encoded.format;
            await this.recovery.prune(fileKey).catch(() => undefined);
            } catch (error) { if (!replaced) await publication?.rollback(); throw error; }
          }
          session.savedContent = publication?.content ?? copied.content; session.snapshot.diskVersion = version; session.snapshot.persistedRevision = copied.draftRevision; session.snapshot.format = format;
          if (publication) { session.aliases = mergeReferenceAliases(session.aliases, publication.replacements); session.snapshot.content = rewriteDocumentReferences(session.snapshot.content, publication.replacements); }
          // 只确认冻结请求的版本；继续输入产生的较新草稿仍保留在私有恢复记录。
          const recovery = await this.queue(`session:${copied.documentSessionId}`, () => this.persistRecovery(session));
          return { status: unchanged ? 'unchanged' : 'committed', requestId: copied.requestId, documentSessionId: copied.documentSessionId, committedDraftRevision: copied.draftRevision, snapshot: this.clone(session), committedContent: session.savedContent, referenceReplacements: publication?.replacements, recoveryMessage: [recovery.recoveryMessage, backupWarning].filter(Boolean).join('\n') || undefined, index: { kind: 'not-applicable' } };
        });
      } catch (error) { return this.failure(copied, error); }
    });
  }
  async saveAs(sender: number, request: DocumentSaveRequest, selectedPath: string, expectedTargetHash: string | null): Promise<DocumentSaveResult> {
    const session = this.session(sender, request.documentSessionId), copied = structuredClone(request);
    const classified = this.classify(selectedPath);
    if (classified.library) throw new DocumentError('DOCUMENT_LIBRARY_TARGET', '目标属于笔记库，请使用“加入笔记库”。');
    const target = classified.real;
    if (target === session.snapshot.displayPath) return this.save(sender, copied);
    return this.operation(session, copied.requestId, JSON.stringify(['save-as', copied, target, expectedTargetHash]), async () => {
      let publication: ResourcePublication | undefined, committed = false, backupWarning: string | undefined;
      try {
        this.assertDraft(session, copied);
        this.options.claimPath?.(target);
        publication = session.snapshot.fileKind === 'markdown' ? await this.resources.publish(copied.documentSessionId, copied.content, target, path.dirname(target) !== path.dirname(session.snapshot.displayPath)) : undefined;
        const encoded = encodeDocument(publication?.content ?? copied.content, session.snapshot.format, copied.formatOverride);
        if (encoded.bytes.length > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', '保存内容不能超过 20 MiB。');
        await this.queue(target, async () => {
          await this.assertExternal(target);
          if (expectedTargetHash === null) {
            const temporary = path.join(path.dirname(target), `.trellora-save-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx');
            try {
              try { await handle.writeFile(encoded.bytes); await handle.sync(); } finally { await handle.close(); }
              await this.assertExternal(target); await fs.link(temporary, target);
            } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
          } else {
            const existing = await this.read(target);
            if (!((await fs.stat(target)).mode & 0o200)) throw new DocumentError('DOCUMENT_PERMISSION_DENIED', '另存目标为只读，请选择其他路径。');
            if (existing.version.diskHash !== expectedTargetHash) throw new DocumentError('DOCUMENT_CONFLICT', '另存目标已变化，请重新选择目标。');
            const key = createHash('sha256').update(target).digest('hex');
            await this.recovery.backup(key, existing.bytes).catch(() => { backupWarning = '文件已保存，但本次历史副本未生成。'; });
            await atomicByteWrite(target, encoded.bytes, async () => { await this.assertExternal(target); if ((await this.read(target)).version.diskHash !== expectedTargetHash) throw new DocumentError('DOCUMENT_CONFLICT', '另存目标已变化，草稿已保留。'); });
            await this.recovery.prune(key).catch(() => undefined);
          }
        });
        committed = true;
        const stat = await fs.stat(target);
        session.snapshot.displayPath = target; session.snapshot.format = encoded.format; session.snapshot.fileKind = getFileTypeInfo(target)!.kind; session.snapshot.diskVersion = diskVersion(encoded.bytes, stat.mtimeMs); session.snapshot.persistedRevision = copied.draftRevision; session.savedContent = publication?.content ?? copied.content;
        if (publication) { session.aliases = mergeReferenceAliases(session.aliases, publication.replacements); session.snapshot.content = rewriteDocumentReferences(session.snapshot.content, publication.replacements); }
        session.snapshot.capabilities = this.capabilities(session.snapshot.content, session.snapshot.fileKind);
        const recovery = await this.queue(`session:${copied.documentSessionId}`, () => this.persistRecovery(session));
        await this.recovery.remember(target).catch(() => undefined);
        return { status: 'committed', requestId: copied.requestId, documentSessionId: copied.documentSessionId, committedDraftRevision: copied.draftRevision, snapshot: this.clone(session), committedContent: session.savedContent, referenceReplacements: publication?.replacements, recoveryMessage: [recovery.recoveryMessage, backupWarning].filter(Boolean).join('\n') || undefined, index: { kind: 'not-applicable' } };
      } catch (error) { if (!committed) await publication?.rollback(); return this.failure(copied, error); }
    });
  }
  async targetHash(sender: number, sessionId: string, target: string): Promise<string | null> {
    this.session(sender, sessionId);
    const classified = this.classify(target);
    if (classified.library) throw new DocumentError('DOCUMENT_LIBRARY_TARGET', '目标属于笔记库，请使用“加入笔记库”。');
    try { return (await this.read(classified.real)).version.diskHash; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async reopen(sender: number, id: string, revision: number, encoding?: DocumentEncoding, discard = false): Promise<DocumentSnapshot> {
    const session = this.session(sender, id);
    if (session.busy || session.snapshot.draftRevision !== revision || (!discard && session.snapshot.content !== session.savedContent)) throw new DocumentError('DOCUMENT_BUSY', '请先保存或放弃当前草稿，再重新读取文件。');
    const read = await this.read(session.snapshot.displayPath), decoded = decodeDocument(read.bytes, encoding);
    await this.recovery.terminate(this.record(session), 'clean');
    session.snapshot.content = decoded.content; session.savedContent = decoded.content; session.snapshot.format = decoded.format; session.snapshot.diskVersion = read.version; session.snapshot.draftRevision++; session.snapshot.persistedRevision = session.snapshot.draftRevision;
    session.snapshot.capabilities = this.capabilities(decoded.content, session.snapshot.fileKind);
    return this.clone(session);
  }
  async join(sender: number, request: DocumentJoinRequest): Promise<DocumentJoinResult> {
    const session = this.session(sender, request.documentSessionId);
    const copied = structuredClone(request);
    return this.operation(session, copied.requestId, JSON.stringify(['join', copied]), async () => {
      if (session.snapshot.draftRevision !== copied.draftRevision) throw new DocumentError('DOCUMENT_REVISION_STALE', '草稿版本已变化，请重试。');
      if (!this.options.libraries().includes(copied.libraryPath)) throw new DocumentError('DOCUMENT_LIBRARY_MISSING', '请选择已登记的笔记库。');
      const content = session.snapshot.content;
      if (Buffer.byteLength(content) > EXTERNAL_TEXT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE', 'UTF-8 副本超过 20 MiB，首期不能加入笔记库。');
      const result = await this.options.joinLibrary(copied.libraryPath, path.basename(session.snapshot.displayPath), content, session.snapshot.fileKind === 'markdown' ? target => this.resources.publish(copied.documentSessionId, content, target, true) : undefined);
      const transferToken = randomUUID(); session.transfers.set(transferToken, { revision: copied.draftRevision, path: result.path, hash: byteHash(Buffer.from(result.content ?? content, 'utf8')) });
      return { ...result, libraryPath: copied.libraryPath, draftRevision: copied.draftRevision, transferToken };
    });
  }
  async close(sender: number, request: DocumentCloseRequest): Promise<DocumentCloseResult> {
    if (this.closed.get(request.documentSessionId) === sender) return { closed: true };
    const session = this.session(sender, request.documentSessionId);
    return this.queue(`session:${request.documentSessionId}`, async () => {
      if (session.busy || session.snapshot.draftRevision !== request.draftRevision) throw new DocumentError('DOCUMENT_BUSY', '文档仍在处理或草稿已变化，请稍后重试。');
      if (!['saved', 'discard', 'transferred'].includes(request.reason)) throw new DocumentError('DOCUMENT_REQUEST_INVALID', '文档结束原因无效。');
      if (request.reason === 'saved' && session.snapshot.content !== session.savedContent) throw new DocumentError('DOCUMENT_DIRTY', '文档尚未保存，请先保存或放弃修改。');
      if (request.reason === 'transferred' && session.transfers.get(request.transferToken ?? '')?.revision !== request.draftRevision) throw new DocumentError('DOCUMENT_REVISION_STALE', '草稿转存凭证无效或版本已变化。');
      if (request.reason === 'transferred') {
        const receipt = session.transfers.get(request.transferToken!)!;
        if ((await this.read(receipt.path)).version.diskHash !== receipt.hash) throw new DocumentError('DOCUMENT_CONFLICT', '库内副本已变化，独立草稿继续保留。');
      }
      const cleaned = await this.recovery.terminate(this.record(session), request.reason === 'saved' ? 'clean' : request.reason === 'discard' ? 'discarded' : 'transferred', true);
      this.sessions.delete(request.documentSessionId); this.closed.set(request.documentSessionId, sender); this.options.onReleased?.(request.documentSessionId); await this.resources.release(request.documentSessionId);
      return { closed: true, ...(cleaned ? {} : { recoveryMessage: '文件会话已关闭，但旧恢复缓存未能清理。该旧草稿可能仍会在重启后的恢复列表中出现。' }) };
    });
  }
  async restore(sender: number, recoveryId: string): Promise<DocumentSnapshot> {
    if ([...this.sessions.values()].some(session => session.recoveryId === recoveryId && session.busy)) throw new DocumentError('DOCUMENT_BUSY', '原会话的保存仍在结束，请稍后恢复草稿。');
    const record = await this.recovery.read(recoveryId);
    const classified = this.classify(record.displayPath);
    if (classified.library) throw new DocumentError('DOCUMENT_PROTECTED', '草稿原路径现已属于笔记库，请先另行处理该恢复记录。');
    this.validateDraft({ documentSessionId: recoveryId, draftRevision: record.draftRevision, content: record.content });
    this.options.claimPath?.(classified.real);
    const id = randomUUID(), kind = getFileTypeInfo(record.displayPath)!.kind;
    const snapshot: DocumentSnapshot = { documentSessionId: id, source: { kind: 'external' }, displayPath: classified.real, fileKind: kind, content: record.content, format: record.format, diskVersion: record.diskVersion, draftRevision: record.draftRevision + 1, persistedRevision: -1, capabilities: this.capabilities(record.content, kind) };
    // 保持恢复时的磁盘 hash；已变化或缺失的原文件只能显式另存，不能自动覆盖。
    const session: Session = { sender, snapshot, savedContent: '\u0000', requests: new Map(), transfers: new Map(), busy: 0, recoveryId: id };
    this.resources.adopt(id, record.draftAssets ?? []);
    await this.recovery.write(this.record(session)); await this.recovery.terminate(record, 'transferred'); this.sessions.set(id, session); return this.clone(session);
  }
  hasDirty(sender: number): boolean { return [...this.sessions.values()].some(s => s.sender === sender && (s.snapshot.content !== s.savedContent || s.busy > 0)); }
  async drain(): Promise<void> { while (this.files.size || [...this.sessions.values()].some(s => s.busy)) { await Promise.allSettled([...this.files.values(), ...[...this.sessions.values()].flatMap(s => [...s.requests.values()].map(r => r.task))]); } }
  release(sender: number): void { for (const [id, s] of this.sessions) if (s.sender === sender && !s.busy) { this.sessions.delete(id); this.options.onReleased?.(id); void this.resources.release(id, true); } for (const [id, r] of this.pending) if (r.sender === sender) this.pending.delete(id); }
  /** 渲染进程重载时只释放捕获的旧会话，保留恢复记录及新渲染进程的会话。 */
  async detach(sender: number): Promise<void> {
    const abandoned = [...this.sessions].filter(([, session]) => session.sender === sender);
    // 同一 WebContents 重载后继续显示未处理请求；窗口销毁时由 release 清理。
    await Promise.allSettled(abandoned.flatMap(([, session]) => [...session.requests.values()].map(request => request.task)));
    await Promise.allSettled([...this.files.values()]);
    for (const [id, session] of abandoned) if (this.sessions.get(id) === session) { this.sessions.delete(id); this.options.onReleased?.(id); await this.resources.release(id, true); }
  }
}
