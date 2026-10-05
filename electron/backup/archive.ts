import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import type { BackupManifest } from '../../shared/workspaceBackup';
import { assertInsideDirectory } from '../pathGuards';

export const BACKUP_LIMITS = { entries: 50_002, expandedBytes: 256 * 1024 ** 3, manifestBytes: 16 * 1024 ** 2, settingsBytes: 1024 ** 2 };

export function validArchivePath(value: string): string {
  if (!value || value.length > 1024 || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || Array.from(part).some(char => char.charCodeAt(0) < 32) || /[<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('备份包含有不安全或不兼容 Windows 的文件路径。');
  return value;
}

async function visitArchive(file: string, signal: AbortSignal, visitor: (zip: yauzl.ZipFile, entry: yauzl.Entry) => Promise<void>): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error || !zip ? reject(error ?? new Error('备份包无法读取。')) : resolve(zip)));
  await new Promise<void>((resolve, reject) => {
    let count = 0, expanded = 0; const names = new Set<string>(); let settled = false;
    const abort = () => fail(new Error('备份或恢复已取消。'));
    const finish = (error?: unknown) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); zip.close(); error ? reject(error) : resolve(); };
    const fail = (error: unknown) => finish(error);
    signal.addEventListener('abort', abort, { once: true });
    zip.on('error', fail); zip.on('end', () => finish());
    zip.on('entry', entry => {
      void (async () => {
        signal.throwIfAborted(); validArchivePath(entry.fileName);
        const canonical = entry.fileName.normalize('NFC').toLowerCase();
        if (names.has(canonical)) throw new Error('备份包含有重复文件路径。'); names.add(canonical);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if ((mode && mode !== 0x8000) || (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error('备份包含有链接、加密文件或不支持的压缩方式。');
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || ++count > BACKUP_LIMITS.entries || (expanded += entry.uncompressedSize) > BACKUP_LIMITS.expandedBytes) throw new Error('备份包超过恢复上限：最多 50000 个数据文件、展开后 256 GiB。请分库备份。');
        await visitor(zip, entry); zip.readEntry();
      })().catch(fail);
    });
    if (signal.aborted) abort(); else zip.readEntry();
  });
}
function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('备份条目无法读取。')) : resolve(stream)));
}
async function readSmall(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error('备份清单或设置文件过大。');
  const stream = await openEntry(zip, entry); const chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of stream) { signal.throwIfAborted(); size += chunk.length; if (size > limit) throw new Error('备份元数据展开大小超过上限。'); chunks.push(chunk); } } finally { stream.destroy(); }
  return Buffer.concat(chunks);
}
export function validateManifest(value: unknown): BackupManifest {
  const m = value as BackupManifest;
  if (!m || m.schemaVersion !== 1) throw new Error('备份格式版本不兼容，请使用支持该版本的 Trellora。');
  if (!/^[a-f0-9-]{36}$/u.test(m.backupId) || !['manual', 'daily'].includes(m.kind) || typeof m.appVersion !== 'string' || typeof m.createdAt !== 'string' || !m.sourceScope || typeof m.sourceScope.workspaceId !== 'string' || typeof m.sourceScope.principalId !== 'string' || !Array.isArray(m.roots) || !m.roots.length || m.roots.length > 1000 || !Array.isArray(m.registrations) || m.registrations.length > 1000 || !Array.isArray(m.files) || m.files.length > 50_000 || !Array.isArray(m.omitted)) throw new Error('备份清单格式无效。');
  const roots = new Set<string>(); let workspaces = 0;
  for (const root of m.roots) { if (!/^root-\d{1,4}$/u.test(root.id) || roots.has(root.id) || !['workspace', 'library'].includes(root.kind) || typeof root.sourcePath !== 'string' || !path.isAbsolute(root.sourcePath) || typeof root.label !== 'string') throw new Error('备份根目录清单无效。'); roots.add(root.id); if (root.kind === 'workspace') workspaces++; }
  if (workspaces !== 1) throw new Error('备份必须包含唯一工作区。');
  const workspace = m.roots.find(root => root.kind === 'workspace')!;
  if (workspace.workspaceRelativePath) validArchivePath(workspace.workspaceRelativePath);
  if (!Array.isArray(m.directories) || m.directories.length > 50_000) throw new Error('备份目录清单无效或过大。');
  const directories = new Set<string>();
  for (const directory of m.directories) { if (!roots.has(directory.rootId)) throw new Error('备份目录根无效。'); validArchivePath(directory.relativePath); const key = `${directory.rootId}/${directory.relativePath}`.normalize('NFC').toLowerCase(); if (directories.has(key)) throw new Error('备份清单含有重复目录。'); directories.add(key); }
  const names = new Set<string>(); let total = 0;
  for (const file of m.files) { if (!roots.has(file.rootId) || typeof file.relativePath !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256) || (total += file.size) > BACKUP_LIMITS.expandedBytes) throw new Error('备份文件清单无效或超出大小上限。'); validArchivePath(file.relativePath); const key = `${file.rootId}/${file.relativePath}`.normalize('NFC').toLowerCase(); if (names.has(key)) throw new Error('备份清单含有重复文件。'); names.add(key); }
  if (m.sourceWorkspacePath !== undefined && (typeof m.sourceWorkspacePath !== 'string' || !path.isAbsolute(m.sourceWorkspacePath))) throw new Error('备份源工作区路径无效。');
  for (const file of names) { if (directories.has(file)) throw new Error('备份中的文件与目录路径发生冲突。'); const parts = file.split('/'); for (let index = 1; index < parts.length; index++) if (names.has(parts.slice(0, index).join('/'))) throw new Error('备份文件路径的上级也是文件，无法恢复。'); }
  for (const r of m.registrations) { if (!roots.has(r.rootId) || !['note', 'materials'].includes(r.kind) || typeof r.relativePath !== 'string' || typeof r.alias !== 'string' || (r.sourcePath !== undefined && (typeof r.sourcePath !== 'string' || !path.isAbsolute(r.sourcePath)))) throw new Error('备份注册关系无效。'); if (r.relativePath) validArchivePath(r.relativePath); }
  return m;
}
export async function readBackupManifest(file: string, signal: AbortSignal): Promise<BackupManifest> {
  let manifest: BackupManifest | undefined;
  await visitArchive(file, signal, async (zip, entry) => { if (entry.fileName === 'manifest.json') manifest = validateManifest(JSON.parse((await readSmall(zip, entry, BACKUP_LIMITS.manifestBytes, signal)).toString('utf8'))); });
  if (!manifest) throw new Error('备份包缺少 manifest.json。'); return manifest;
}
/** Checks metadata and real expanded bytes before publication; destination is always controlled staging. */
export async function verifyBackupArchive(file: string, manifest: BackupManifest, signal: AbortSignal, destination?: string, progress?: (completed: number, total: number) => void): Promise<Record<string, unknown>> {
  if (destination) {
    for (const root of manifest.roots) await fs.promises.mkdir(assertInsideDirectory(path.join(destination, 'roots', root.id), destination), { recursive: true });
    for (const directory of manifest.directories) await fs.promises.mkdir(assertInsideDirectory(path.join(destination, 'roots', directory.rootId, ...directory.relativePath.split('/')), destination), { recursive: true });
  }
  const expected = new Map(manifest.files.map(item => [`roots/${item.rootId}/${item.relativePath}`, item]));
  let checked = 0, metadataManifest = false, metadataSettings = false; let settings: Record<string, unknown> = {};
  await visitArchive(file, signal, async (zip, entry) => {
    if (entry.fileName === 'manifest.json') { const actual = validateManifest(JSON.parse((await readSmall(zip, entry, BACKUP_LIMITS.manifestBytes, signal)).toString('utf8'))); if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('备份清单在读取期间发生变化。'); metadataManifest = true; return; }
    if (entry.fileName === 'settings/safe-settings.json') { settings = JSON.parse((await readSmall(zip, entry, BACKUP_LIMITS.settingsBytes, signal)).toString('utf8')); if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('备份设置格式无效。'); metadataSettings = true; return; }
    const item = expected.get(entry.fileName);
    if (!item || item.size !== entry.uncompressedSize) throw new Error('备份包条目与清单不一致。');
    expected.delete(entry.fileName); const stream = await openEntry(zip, entry); const hash = crypto.createHash('sha256'); let size = 0;
    const guard = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > item.size) { callback(new Error('备份文件展开大小与清单不符。')); return; } hash.update(chunk); callback(null, chunk); } });
    let target: string | undefined;
    if (destination) { target = assertInsideDirectory(path.join(destination, 'roots', item.rootId, ...item.relativePath.split('/')), destination); await fs.promises.mkdir(path.dirname(target), { recursive: true }); target = assertInsideDirectory(target, destination); }
    try { await pipeline(stream, guard, target ? fs.createWriteStream(target, { flags: 'wx' }) : new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { signal }); }
    finally { stream.destroy(); guard.destroy(); }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error('备份文件校验失败，文件可能损坏。');
    progress?.(++checked, manifest.files.length);
  });
  if (expected.size || !metadataManifest || !metadataSettings) throw new Error('备份包存在缺失文件。');
  return settings;
}
