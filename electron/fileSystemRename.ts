import fs from 'node:fs';

/** Retry brief Windows file-scanner locks; persistent errors still trigger caller rollback. */
export function renameWithWindowsRetry(sourcePath: string, targetPath: string): void {
  const attempts = process.platform === 'win32' ? 6 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === attempts - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Let Windows directory notifications settle between attempts without blocking the event loop. */
export async function renameWithWindowsRetryAsync(sourcePath: string, targetPath: string, validate?: () => void, retry?: { attempts: number; delayMs: number }): Promise<void> {
  const attempts = process.platform === 'win32' ? retry?.attempts ?? 6 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      validate?.();
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, retry?.delayMs ?? 50));
    }
  }
}
