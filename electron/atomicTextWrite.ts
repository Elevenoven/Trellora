import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteDiskVersion } from '../shared/noteSave';
import { decodeTextBuffer } from './textFile';

export class NoteFileError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

export function byteHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** One stable byte read supplies both the editor text and its optimistic version. */
export async function readNoteBytes(filePath: string): Promise<{ bytes: Buffer; content: string; version: NoteDiskVersion }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await fs.open(filePath, 'r');
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const named = await fs.stat(filePath);
      if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && after.ino === named.ino && after.size === named.size && after.mtimeMs === named.mtimeMs && after.ctimeMs === named.ctimeMs) {
        return { bytes, content: decodeTextBuffer(bytes), version: { diskHash: byteHash(bytes), byteLength: bytes.length, mtimeMs: after.mtimeMs } };
      }
    } finally { await handle.close(); }
  }
  throw new NoteFileError('NOTE_READ_UNSTABLE', '笔记正在被其他程序修改，请稍后重试。', true);
}

/** Replace only after a complete, synced sibling exists; never unlink the original. */
export async function atomicTextWrite(filePath: string, content: string, validate: () => Promise<void>, timing?: (phase: string, durationMs: number) => void): Promise<NoteDiskVersion> {
  return atomicByteWrite(filePath, Buffer.from(content, 'utf8'), validate, timing);
}

/** 外部文档提交已经按原编码生成的字节；原笔记调用仍固定 UTF-8。 */
export async function atomicByteWrite(filePath: string, bytes: Buffer, validate: () => Promise<void>, timing?: (phase: string, durationMs: number) => void): Promise<NoteDiskVersion> {
  const temporary = path.join(path.dirname(filePath), `.trellora-save-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let started = performance.now();
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    await handle.close();
    handle = undefined;
    timing?.('temporary-write-sync', performance.now() - started);
    for (let attempt = 0; ; attempt++) {
      started = performance.now();
      await validate();
      timing?.('version-check', performance.now() - started);
      started = performance.now();
      try { await fs.rename(temporary, filePath); timing?.('replace', performance.now() - started); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    return { diskHash: byteHash(bytes), byteLength: bytes.length, mtimeMs: stat.mtimeMs };
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
