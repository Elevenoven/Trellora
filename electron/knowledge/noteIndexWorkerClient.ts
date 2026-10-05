import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IndexedNote, NoteIndex } from '../noteIndex';

/** One reusable local parser worker; failed requests are retried by the coordinator. */
export class NoteIndexWorkerClient {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly workerPath = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'noteIndexWorker.js')) {}
  scan(library: string): Promise<NoteIndex> { return this.call({ method: 'scan', path: library }) as Promise<NoteIndex>; }
  parse(filePath: string, content: string, mtimeMs: number): Promise<IndexedNote> { return this.call({ method: 'parse', path: filePath, content, mtimeMs }) as Promise<IndexedNote>; }
  async close(): Promise<void> { const worker = this.worker; this.worker = undefined; this.rejectAll(new Error('索引解析器已关闭。')); if (worker) await worker.terminate(); }
  private call(request: Record<string, unknown>): Promise<unknown> {
    if (!this.worker) {
      const worker = new Worker(this.workerPath);
      this.worker = worker;
      worker.on('message', (reply) => {
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.value);
      });
      worker.on('error', (error) => { this.rejectAll(error); if (this.worker === worker) this.worker = undefined; });
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.rejectAll(new Error('索引解析器意外退出。')); } });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ ...request, id });
    });
  }
  private rejectAll(error: Error): void { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); } this.pending.clear(); }
}
