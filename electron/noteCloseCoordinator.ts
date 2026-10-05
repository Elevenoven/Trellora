import { randomUUID } from 'node:crypto';
import type { NoteCloseResponse } from '../shared/noteSave';

/** The first close is blocked synchronously; only a completed save handshake releases it. */
export class NoteCloseCoordinator {
  private pending?: { requestId: string; sender: number; finish: (ok: boolean) => void; timer?: ReturnType<typeof setTimeout> };
  allowed = false;
  constructor(private readonly drain: () => Promise<void>, private readonly failed: (message: string) => void) {}

  async request(sender: number, send: (requestId: string) => void, close: () => void): Promise<void> {
    if (this.pending || this.allowed) return;
    const requestId = randomUUID();
    const saved = new Promise<boolean>((finish) => { this.pending = { requestId, sender, finish }; });
    const timer = setTimeout(() => { this.pending?.finish(false); }, 10_000);
    if (this.pending) this.pending.timer = timer;
    try {
      send(requestId);
      if (!await saved) { this.failed('保存尚未完成，窗口保持打开。请处理保存提示后重试关闭。'); return; }
      await this.drain();
      this.allowed = true;
      close();
    } catch (error) {
      this.allowed = false;
      this.failed(`关闭前保存未完成，窗口保持打开：${String(error)}`);
    } finally { clearTimeout(timer); this.pending = undefined; }
  }

  respond(sender: number, response: NoteCloseResponse): void {
    if (response?.requestId === this.pending?.requestId && sender === this.pending?.sender) this.pending.finish(response.ok === true);
  }

  /** 人工保存选择没有 IO 超时；仅持有当前窗口的同一关闭握手。 */
  waitForUser(sender: number, requestId: string): void {
    if (this.pending?.sender === sender && this.pending.requestId === requestId) clearTimeout(this.pending.timer);
  }
  cancelPending(sender: number): void { if (this.pending?.sender === sender) this.pending.finish(false); }
}
