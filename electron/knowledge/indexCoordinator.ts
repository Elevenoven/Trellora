import fs from 'node:fs/promises';
import path from 'node:path';
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import { buildNoteIndex, type FileNode, type IndexedNote, type NoteIndex } from '../noteIndex';
import { readNoteBytes } from '../atomicTextWrite';
import { getFileTypeInfo } from '../fileTypes';
import { loadTreeOrder, sortEntriesByTreeOrder } from '../treeOrder';
import { KnowledgeProjectionDatabase, synchronizeKnowledgeIndex } from './metaDatabase';
import { NoteIndexWorkerClient } from './noteIndexWorkerClient';
import { toNoteSearchDocument, type NoteSearchDocument } from './noteLexicalIndex';
import type { IndexSyncResult, PersistedKnowledgeNote } from './types';
import type { NoteIndexChanged } from '../../shared/noteSave';

export interface SearchIndexAdapter {
  removeAll(): void; add(document: NoteSearchDocument): void;
  has(id: string): boolean; replace(document: NoteSearchDocument): void; discard(id: string): void;
}
export type LibraryChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export interface LibraryChange { kind: LibraryChangeKind; path: string }
export interface CoordinatedIndexResult { noteIndex: NoteIndex; fileTree: FileNode[]; database: IndexSyncResult }
export type IndexChangeListener = (result: CoordinatedIndexResult, changes: LibraryChange[], delta?: NoteIndexChanged) => void;
const ignoredDirectoryNames = new Set(['.git', '.menghan-backups', '.menghan-meta', 'node_modules']);

/** One publication gate orders cold scans, watcher deltas and structural migrations. */
export class KnowledgeIndexCoordinator {
  private watcher?: FSWatcher;
  private library?: string;
  private generation = 0;
  private revision = 0;
  private gate: Promise<unknown> = Promise.resolve();
  private debounce?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private queued = new Map<string, LibraryChange>();
  private index?: NoteIndex;
  private database?: KnowledgeProjectionDatabase;
  private search?: SearchIndexAdapter | null;
  private listener?: IndexChangeListener;
  private initializing?: Promise<CoordinatedIndexResult>;
  private active = false;
  private hashes = new Map<string, string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private failures = new Map<string, number>();
  readonly metrics = { fullScans: 0, parses: 0, searchResets: 0, deltaWrites: 0, retries: 0 };
  constructor(private readonly log: (message: string) => void = () => undefined, private readonly parser = new NoteIndexWorkerClient()) {}
  get current(): NoteIndex | undefined { return this.index; }

  /** Compatibility for isolated legacy consumers. Application startup uses initialize(). */
  synchronize(libraryPath: string, searchIndex?: SearchIndexAdapter | null): CoordinatedIndexResult {
    this.metrics.fullScans++;
    const index = buildNoteIndex(libraryPath);
    const database = synchronizeKnowledgeIndex(libraryPath, index.notes.map((note) => persist(libraryPath, note)));
    this.library = path.resolve(libraryPath); this.search = searchIndex; this.active = true;
    this.install(index);
    this.log(`SQLite index synchronized: ${database.indexed} updated, ${database.skipped} unchanged, ${database.removed} removed`);
    return { noteIndex: index, fileTree: index.fileTree, database };
  }

  async initialize(libraryPath: string, search: SearchIndexAdapter | null, listener: IndexChangeListener): Promise<CoordinatedIndexResult> {
    const library = path.resolve(libraryPath);
    if (this.library === library && this.initializing) return this.initializing;
    if (this.library === library && this.index && this.watcher) { this.listener = listener; return this.result(); }
    await this.stopWatching();
    const generation = ++this.generation;
    this.library = library; this.search = search; this.listener = listener; this.active = true;
    const task = this.enqueue(async () => {
      await this.watch(library, generation);
      this.metrics.fullScans++;
      const index = await this.parser.scan(library);
      if (generation !== this.generation) throw new Error('笔记库已切换。');
      this.install(index);
      const database = synchronizeKnowledgeIndex(library, index.notes.map((note) => persist(library, note)));
      this.database = new KnowledgeProjectionDatabase(library);
      if (this.queued.size) { const changes = [...this.queued.values()]; this.queued.clear(); await this.applyNow(changes, 'external'); }
      return this.result(database);
    });
    this.initializing = task;
    try { return await task; } finally { if (this.initializing === task) this.initializing = undefined; }
  }

  startWatching(libraryPath: string, search: SearchIndexAdapter | null | undefined, listener: IndexChangeListener): void {
    this.search = search; this.listener = listener;
    if (this.watcher) return;
    this.library = path.resolve(libraryPath); this.active = true;
    this.database ??= new KnowledgeProjectionDatabase(this.library);
    void this.watch(this.library, ++this.generation);
  }
  update(changes: LibraryChange[], source: NoteIndexChanged['source'] = 'application'): Promise<void> {
    if (!this.active) return Promise.reject(new Error('内容已保存，索引正在切换或关闭。'));
    const generation = this.generation;
    return this.enqueue(async () => { if (generation === this.generation) await this.applyNow(changes, source); });
  }
  /** Hold watcher publication while a rename migrates metadata. */
  mutate<T>(action: () => Promise<{ value: T; changes: LibraryChange[]; moves?: Array<{ from: string; to: string }>; rollback?: () => Promise<void> }> | { value: T; changes: LibraryChange[]; moves?: Array<{ from: string; to: string }>; rollback?: () => Promise<void> }): Promise<T> {
    return this.enqueue(async () => {
      const result = await action();
      try { await this.applyNow(result.changes, 'application', result.moves); }
      catch (error) {
        if (!(error as Error & { projectionCommitted?: boolean }).projectionCommitted && result.rollback) { await result.rollback(); throw error; }
        // A completed filesystem operation remains completed while its projections recover.
        this.log(`文件操作已完成，索引稍后恢复：${String(error)}`);
      }
      return result.value;
    });
  }
  reorder(directory: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.index || !this.library) return;
      const children = directory === this.library ? this.index.fileTree : findNode(this.index.fileTree, directory)?.children;
      if (!children) return;
      children.splice(0, children.length, ...sortEntriesByTreeOrder(children, this.library, directory, loadTreeOrder(this.library)));
      this.listener?.(this.result(), [], { libraryPath: this.library, libraryGeneration: this.generation, indexRevision: ++this.revision,
        source: 'application', changedFields: ['tree'], changes: [], nodes: [], orders: { [directory]: children.map((node) => node.path) } });
    });
  }
  retry(filePath: string): Promise<void> { this.failures.delete(filePath); return this.update([{ kind: 'change', path: filePath }], 'reconcile'); }
  async awaitIndexedVersion(filePath: string, diskHash: string): Promise<'current' | 'superseded' | 'missing'> {
    const generation = this.generation;
    try {
      if ((await readNoteBytes(filePath)).version.diskHash !== diskHash) return 'superseded';
      const update = this.update([{ kind: 'change', path: filePath }], 'reconcile');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([update, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('内容已保存，索引尚未更新，请稍后重试。')), 5_000); })]); }
      finally { if (timer) clearTimeout(timer); }
      return generation === this.generation && this.hashes.get(filePath) === diskHash ? 'current' : 'superseded';
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  }
  async awaitCurrent(): Promise<void> { await this.gate; if (this.failures.size) throw new Error('内容已保存，索引暂不可用，请重试索引。'); }
  async reconcile(): Promise<void> { const library = this.library, search = this.search, listener = this.listener; if (!library || !listener) return; await this.stopWatching(); await this.initialize(library, search ?? null, listener); }
  async drain(): Promise<void> { await this.gate; }
  async shutdown(): Promise<void> { await this.stopWatching(); await this.parser.close(); }
  async stopWatching(): Promise<void> {
    this.active = false;
    ++this.generation;
    const watcher = this.watcher; this.watcher = undefined;
    if (this.debounce) clearTimeout(this.debounce); this.debounce = undefined;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear(); this.failures.clear(); this.queued.clear();
    if (watcher) await watcher.close();
    await this.gate.catch(() => undefined);
    this.gate = Promise.resolve();
    this.database?.close(); this.database = undefined; this.library = undefined; this.index = undefined; this.hashes.clear();
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> { const task = this.gate.catch(() => undefined).then(action); this.gate = task; return task; }
  private install(index: NoteIndex): void {
    this.index = index;
    if (this.search) { this.search.removeAll(); this.metrics.searchResets++; for (const note of index.notes) this.search.add(toNoteSearchDocument(note)); }
  }
  private result(database: IndexSyncResult = { indexed: 0, skipped: 0, removed: 0 }): CoordinatedIndexResult {
    if (!this.index) throw new Error('笔记索引尚未就绪。');
    return { noteIndex: this.index, fileTree: this.index.fileTree, database };
  }
  private async watch(library: string, generation: number): Promise<void> {
    // Windows recursive fs.watch reports relative paths without rescanning every sibling after an atomic rename.
    const watcher = watchDirectory(library, { recursive: true, encoding: 'utf8' });
    this.watcher = watcher;
    const queue = (filePath: string) => {
      if (generation !== this.generation || path.relative(library, filePath).split(path.sep).some((part) => part.startsWith('.') || ignoredDirectoryNames.has(part))) return;
      const changedPath = path.resolve(filePath);
      this.queued.set(changedPath, { kind: 'change', path: changedPath });
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        if (generation !== this.generation || !this.index || this.initializing) return;
        const changes = [...this.queued.values()]; this.queued.clear();
        void this.update(changes, 'external').catch((error) => this.log(`索引增量更新失败：${String(error)}`));
      }, 650);
    };
    const lostEvents = () => {
      if (this.reconcileTimer) return;
      this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; if (generation === this.generation) void this.reconcile().catch((error) => this.log(`监听校准失败：${String(error)}`)); }, 1_000);
    };
    watcher.on('change', (_event, filename) => { if (filename) queue(path.join(library, filename.toString())); else lostEvents(); });
    watcher.on('error', (error) => { this.log(`Workspace watcher failed: ${String(error)}`); lostEvents(); });
    // The native watch handle is installed synchronously before the cold parser starts.
  }
  private async applyNow(changes: LibraryChange[], source: NoteIndexChanged['source'], moves: Array<{ from: string; to: string }> = []): Promise<void> {
    if (!this.index || !this.library) throw new Error('笔记索引尚未就绪。');
    const library = this.library, generation = this.generation;
    const candidates = new Map<string, { note: IndexedNote; hash: string }>();
    const removed = new Set<string>(), nodes = new Map<string, FileNode>();
    const actual: LibraryChange[] = [], fields = new Set<NoteIndexChanged['changedFields'][number]>();
    const inspect = async (filePath: string): Promise<void> => {
      const relative = path.relative(library, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part.startsWith('.') || ignoredDirectoryNames.has(part))) return;
      let stat;
      try { stat = await fs.lstat(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        for (const note of this.index!.notes) if (note.path === filePath || note.path.startsWith(`${filePath}${path.sep}`)) removed.add(note.path);
        if (findNode(this.index!.fileTree, filePath)) { actual.push({ kind: 'unlink', path: filePath }); fields.add('tree'); }
        return;
      }
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (!findNode(this.index!.fileTree, filePath)) { nodes.set(filePath, { path: filePath, name: path.basename(filePath), kind: 'directory', isDirectory: true, children: [] }); actual.push({ kind: 'addDir', path: filePath }); fields.add('tree'); }
        for (const entry of await fs.readdir(filePath)) await inspect(path.join(filePath, entry));
        return;
      }
      if (!getFileTypeInfo(filePath)) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const read = await readNoteBytes(filePath), previous = this.index!.notesByPath[filePath];
        if (this.hashes.get(filePath) === read.version.diskHash && previous?.mtimeMs === read.version.mtimeMs) return;
        let note: IndexedNote;
        if (previous?.rawMarkdown === read.content) note = { ...previous, mtimeMs: read.version.mtimeMs };
        else { this.metrics.parses++; note = await this.parser.parse(filePath, read.content, read.version.mtimeMs); }
        if ((await readNoteBytes(filePath)).version.diskHash !== read.version.diskHash) continue;
        candidates.set(filePath, { note, hash: read.version.diskHash });
        if (!previous || previous.contentHash !== note.contentHash) {
          actual.push({ kind: previous ? 'change' : 'add', path: filePath }); fields.add('content');
          if (previous?.title !== note.title) fields.add('title');
          if (JSON.stringify(previous?.tags) !== JSON.stringify(note.tags)) fields.add('tags');
          if (JSON.stringify(previous?.outgoingLinks) !== JSON.stringify(note.outgoingLinks)) fields.add('links');
          if (!previous || previous.title !== note.title) { nodes.set(filePath, { path: filePath, name: path.basename(filePath), title: note.title, isDirectory: false, kind: note.kind, extension: note.extension }); fields.add('tree'); }
        }
        return;
      }
      throw new Error('笔记仍在被其他程序修改，索引将稍后重试。');
    };
    let projectionCommitted = false;
    try {
      for (const changedPath of new Set(changes.map((change) => path.resolve(change.path)))) await inspect(changedPath);
      if (generation !== this.generation) return;
      if (!candidates.size && !removed.size && !moves.length && !actual.length) { this.clearFailures(changes); return; }
      this.database ??= new KnowledgeProjectionDatabase(library);
      const database = this.database.apply([...candidates.values()].map(({ note }) => persist(library, note)), [...removed], moves);
      projectionCommitted = true;
      this.metrics.deltaWrites += candidates.size + removed.size;
      // Publish memory only after search succeeds; a failed search projection remains retryable.
      for (const filePath of removed) if (this.search?.has(filePath)) this.search.discard(filePath);
      for (const [filePath, { note }] of candidates) {
        const previous = this.index.notesByPath[filePath];
        if (!previous || previous.contentHash !== note.contentHash) { const document = toNoteSearchDocument(note); if (this.search?.has(filePath)) this.search.replace(document); else this.search?.add(document); }
      }
      for (const filePath of removed) { delete this.index.notesByPath[filePath]; this.hashes.delete(filePath); }
      if (removed.size) this.index.notes = this.index.notes.filter((note) => !removed.has(note.path));
      for (const [filePath, { note, hash }] of candidates) {
        const previous = this.index.notesByPath[filePath]; this.index.notesByPath[filePath] = note; this.hashes.set(filePath, hash);
        if (previous) this.index.notes[this.index.notes.indexOf(previous)] = note; else this.index.notes.push(note);
      }
      if (fields.has('tree')) {
        for (const change of actual.filter((change) => change.kind === 'unlink')) removeNode(this.index.fileTree, change.path);
        const order = loadTreeOrder(library); for (const node of nodes.values()) putNode(this.index.fileTree, node, library, order);
      }
      const orders: Record<string, string[]> = {};
      for (const change of actual.filter((change) => change.kind === 'add' || change.kind === 'addDir')) {
        const parent = path.dirname(change.path), children = parent === library ? this.index.fileTree : findNode(this.index.fileTree, parent)?.children;
        if (children) orders[parent] = children.map((node) => node.path);
      }
      if (actual.length) this.listener?.(this.result(database), actual, { libraryPath: library, libraryGeneration: generation, indexRevision: ++this.revision, changes: actual, changedFields: [...fields], source, nodes: [...nodes.values()], orders });
      this.clearFailures(changes);
    } catch (error) { for (const change of changes) this.scheduleRetry(change.path); if (projectionCommitted && error instanceof Error) Object.assign(error, { projectionCommitted: true }); throw error; }
  }
  private clearFailures(changes: LibraryChange[]): void {
    for (const change of changes) { this.failures.delete(change.path); const timer = this.retryTimers.get(change.path); if (timer) clearTimeout(timer); this.retryTimers.delete(change.path); }
  }
  private scheduleRetry(filePath: string): void {
    if (this.retryTimers.has(filePath)) return;
    const attempt = (this.failures.get(filePath) ?? 0) + 1;
    this.failures.set(filePath, attempt);
    if (attempt > 3) return;
    const generation = this.generation;
    this.retryTimers.set(filePath, setTimeout(() => { this.retryTimers.delete(filePath); if (generation !== this.generation) return; this.metrics.retries++; void this.update([{ kind: 'change', path: filePath }], 'reconcile').catch((error) => this.log(`索引重试失败：${String(error)}`)); }, [100, 300, 1_000][attempt - 1]));
  }
}
function persist(library: string, note: IndexedNote): PersistedKnowledgeNote {
  return { path: note.path, relativePath: path.relative(library, note.path).replace(/\\/g, '/'), title: note.title, kind: note.kind, extension: note.extension, mtimeMs: note.mtimeMs,
    facts: { frontmatter: note.frontmatter, headings: note.headings, tags: note.tags, outgoingLinks: note.outgoingLinks, plainText: note.plainText, contentHash: note.contentHash } };
}
function findNode(nodes: FileNode[], filePath: string): FileNode | undefined { for (const node of nodes) { if (node.path === filePath) return node; const found = node.children && findNode(node.children, filePath); if (found) return found; } return undefined; }
function removeNode(nodes: FileNode[], filePath: string): void { for (let index = nodes.length - 1; index >= 0; index--) { const node = nodes[index]; if (node.path === filePath) nodes.splice(index, 1); else if (node.children) removeNode(node.children, filePath); } }
function putNode(nodes: FileNode[], node: FileNode, library: string, order: ReturnType<typeof loadTreeOrder>): void {
  const parent = path.dirname(node.path), children = parent === library ? nodes : findNode(nodes, parent)?.children;
  if (!children) return;
  const previous = children.find((child) => child.path === node.path);
  if (previous) Object.assign(previous, { ...node, ...(previous.children ? { children: previous.children } : {}) }); else children.push(node);
  children.splice(0, children.length, ...sortEntriesByTreeOrder(children, library, parent, order));
}
