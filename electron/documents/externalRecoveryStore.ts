import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentFormat, DocumentDiskVersion, DocumentRecent, DocumentRecovery } from '../../shared/documentSession';
import { EXTERNAL_TEXT_MAX_BYTES } from '../../shared/documentSession';
import { assertInsideDirectory } from '../pathGuards';
import type { DraftAsset } from './documentResourceService';

export interface RecoveryRecord extends DocumentRecovery { version: 1; content: string; format: DocumentFormat; diskVersion: DocumentDiskVersion; draftAssets?: DraftAsset[]; state: 'dirty' | 'clean' | 'discarded' | 'transferred' }
/** 私有缓存按会话身份保存；终态先落盘，迟到请求不能复活已放弃的草稿。 */
export class ExternalRecoveryStore {
  private readonly terminated = new Set<string>();
  constructor(readonly root: string) {}
  private recordPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('恢复标识无效。');
    return assertInsideDirectory(path.join(this.root, `${id}.json`), this.root);
  }
  private async publish(target: string, bytes: Buffer): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    assertInsideDirectory(target, this.root);
    const temporary = path.join(this.root, `.recovery-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      assertInsideDirectory(target, this.root); await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async write(record: RecoveryRecord): Promise<void> { await this.publish(this.recordPath(record.recoveryId), Buffer.from(JSON.stringify(record))); }
  async read(id: string): Promise<RecoveryRecord> {
    if (this.terminated.has(id)) throw new Error('草稿已处理或恢复记录无效。');
    const filePath = this.recordPath(id);
    if ((await fs.stat(filePath)).size > EXTERNAL_TEXT_MAX_BYTES * 6 + 16_384) throw new Error('恢复记录过大。');
    const record = JSON.parse(await fs.readFile(filePath, 'utf8')) as RecoveryRecord;
    if (record.version !== 1 || record.recoveryId !== id || record.state !== 'dirty' || typeof record.content !== 'string' || typeof record.displayPath !== 'string') throw new Error('草稿已处理或恢复记录无效。');
    if (!Number.isSafeInteger(record.draftRevision) || record.draftRevision < 0 || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || !record.format || !['utf8', 'utf16le', 'utf16be', 'gbk', 'gb18030'].includes(record.format.encoding) || !['none', 'utf8', 'utf16le', 'utf16be'].includes(record.format.bom) || (record.format.bom !== 'none' && record.format.bom !== record.format.encoding) || !['none', 'lf', 'crlf', 'cr', 'mixed'].includes(record.format.lineEnding) || !record.diskVersion || !/^[a-f0-9]{64}$/.test(record.diskVersion.diskHash) || record.diskHash !== record.diskVersion.diskHash || !Number.isFinite(record.diskVersion.mtimeMs) || !Number.isSafeInteger(record.diskVersion.byteLength) || record.diskVersion.byteLength < 0 || record.diskVersion.byteLength > EXTERNAL_TEXT_MAX_BYTES) throw new Error('恢复记录格式或磁盘版本无效。');
    return record;
  }
  async list(): Promise<DocumentRecovery[]> {
    let names: string[];
    try { names = await fs.readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => {
      try { const r = await this.read(name.slice(0, -5)); return { recoveryId: r.recoveryId, displayPath: r.displayPath, updatedAt: r.updatedAt, draftRevision: r.draftRevision, diskHash: r.diskHash }; } catch { return null; }
    }));
    return entries.filter((r): r is DocumentRecovery => Boolean(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** 关闭可降级为删除旧缓存；两种落盘方式都失败时，当前进程仍禁止恢复已结束的会话。 */
  async terminate(record: RecoveryRecord, state: 'clean' | 'discarded' | 'transferred', tolerateUnavailable = false): Promise<boolean> {
    let marked = false;
    try { await this.write({ ...record, state, content: '' }); marked = true; }
    catch (error) { if (!tolerateUnavailable) throw error; }
    if (tolerateUnavailable) this.terminated.add(record.recoveryId);
    try { await fs.rm(this.recordPath(record.recoveryId), { force: true }); return true; }
    catch { return marked; }
  }
  async backup(fileKey: string, bytes: Buffer): Promise<void> {
    const directory = assertInsideDirectory(path.join(this.root, 'versions', fileKey), this.root);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${Date.now()}-${randomUUID()}.bin`), handle = await fs.open(target, 'wx');
    try { try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { await fs.rm(target, { force: true }); throw error; }
  }
  async prune(fileKey: string): Promise<void> {
    const directory = assertInsideDirectory(path.join(this.root, 'versions', fileKey), this.root);
    const names = (await fs.readdir(directory)).filter(n => n.endsWith('.bin')).sort().reverse();
    await Promise.all(names.slice(3).map(name => fs.unlink(assertInsideDirectory(path.join(directory, name), directory))));
  }
  async recent(): Promise<DocumentRecent[]> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(assertInsideDirectory(path.join(this.root, 'recent.json'), this.root), 'utf8'));
      return Array.isArray(value) ? value.filter((item): item is DocumentRecent => item && typeof item.displayPath === 'string' && path.isAbsolute(item.displayPath) && typeof item.openedAt === 'string').slice(0, 20) : [];
    } catch { return []; }
  }
  async remember(displayPath: string): Promise<void> {
    const old = await this.recent();
    await this.publish(path.join(this.root, 'recent.json'), Buffer.from(JSON.stringify([{ displayPath, openedAt: new Date().toISOString() }, ...old.filter(r => r.displayPath !== displayPath)].slice(0, 20))));
  }
}
