/** WEKNORA_PARITY_HARDENING: bounds await even when a provider ignores AbortSignal; late results cannot enter commit. */
export class MemoryTask {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.timer = setTimeout(() => this.abort('MEMORY_TASK_TIMEOUT'), timeoutMs);
  }

  abort(reason = 'MEMORY_TASK_CANCELLED'): void { this.controller.abort(new Error(reason)); }
  assertActive(): void { this.controller.signal.throwIfAborted(); }
  dispose(): void { clearTimeout(this.timer); }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    this.assertActive();
    const child = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { child.abort(this.controller.signal.reason); reject(this.controller.signal.reason); };
      this.controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { const error = new Error('MEMORY_REQUEST_TIMEOUT'); child.abort(error); reject(error); }, timeoutMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { child.signal.throwIfAborted(); return operation(child.signal); }), cancelled]);
      this.assertActive();
      return value;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) this.controller.signal.removeEventListener('abort', abort);
    }
  }
}
