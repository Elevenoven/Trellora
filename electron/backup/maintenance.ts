import { randomUUID } from 'node:crypto';

export type MaintenancePhase = 'idle' | 'preparing' | 'capturing';
export interface MaintenanceParticipant { maintenanceBusy: boolean; pauseForMaintenance(): void; resumeAfterMaintenance(): void }

/** A main-process barrier covers new IPC, renderer drafts, background writers and watcher publication. */
export class MaintenanceBarrier {
  phase: MaintenancePhase = 'idle';
  private readonly active = new Set<Promise<unknown>>();
  private preparation?: { id: string; sender: number; resolve: (ok: boolean) => void };
  constructor(private readonly options: {
    prepareRenderer: (requestId: string) => number;
    changed: (phase: MaintenancePhase) => void;
    participants: () => MaintenanceParticipant[];
    drain: () => Promise<void>;
    stopWatching: () => Promise<void>;
    resumeWatching: () => Promise<void>;
    extraBusy: () => boolean;
    allowResume?: () => boolean;
  }) {}
  acknowledge(sender: number, requestId: string, ok: boolean): void { if (this.preparation?.sender === sender && this.preparation.id === requestId) this.preparation.resolve(ok === true); }
  invoke<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
    const control = channel.startsWith('backup:') || channel.startsWith('restore:') || channel.startsWith('workspace-migration:');
    const flushing = this.phase === 'preparing' && ['notes:save', 'notes:mutate', 'documents:update-draft'].includes(channel);
    if (this.phase !== 'idle' && !control && !flushing) return Promise.reject(new Error('正在备份或恢复，完成后即可继续操作。'));
    const promise = Promise.resolve().then(action);
    if (!control) { this.active.add(promise); void promise.then(() => this.active.delete(promise), () => this.active.delete(promise)); }
    return promise;
  }
  private setPhase(phase: MaintenancePhase): void { this.phase = phase; this.options.changed(phase); }
  async capture<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (this.phase !== 'idle') throw new Error('已有备份或恢复任务正在执行。');
    const participants = this.options.participants(); let watchingStopped = false;
    this.setPhase('preparing');
    try {
      participants.forEach(participant => participant.pauseForMaintenance());
      const requestId = randomUUID();
      const ok = await new Promise<boolean>((resolve, reject) => {
        const fail = () => finish(false, new Error('备份或恢复已取消。'));
        const timer = setTimeout(() => finish(false, new Error('当前窗口未能完成草稿保存，请检查保存状态后重试。')), 10_000);
        const finish = (result: boolean, error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', fail); error ? reject(error) : resolve(result); };
        signal.addEventListener('abort', fail, { once: true });
        try { this.preparation = { id: requestId, sender: this.options.prepareRenderer(requestId), resolve: finish }; }
        catch { finish(false, new Error('当前窗口不可用，请重新打开应用后重试。')); }
        if (signal.aborted) fail();
      });
      this.preparation = undefined;
      if (!ok) throw new Error('当前笔记存在未解决的保存冲突，请先处理后再备份。');
      this.setPhase('capturing');
      const deadline = Date.now() + 30_000;
      while (this.active.size || participants.some(participant => participant.maintenanceBusy) || this.options.extraBusy()) {
        signal.throwIfAborted(); if (Date.now() > deadline) throw new Error('当前任务尚未结束，请等待资料处理或模型任务完成后再备份。');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await this.options.drain(); signal.throwIfAborted();
      watchingStopped = true; await this.options.stopWatching();
      return await action();
    } finally {
      this.preparation = undefined;
      const resume = this.options.allowResume?.() !== false;
      try { if (watchingStopped && resume) await this.options.resumeWatching(); }
      finally { try { if (resume) for (const participant of participants) participant.resumeAfterMaintenance(); } finally { this.setPhase('idle'); } }
    }
  }
}
