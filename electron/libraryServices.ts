import fs from 'fs';
import path from 'path';
import { assertInsideDirectory } from './pathGuards';
import { getNoteBackupDirectory, listNoteBackups, pruneNoteBackups, type BackupEntry } from './noteBackups';
export type { BackupEntry } from './noteBackups';

export interface SavedEditorImage {
  markdownPath: string;
  absolutePath: string;
  fileName: string;
}

export interface BackupOptions {
  now?: Date;
  minIntervalMs?: number;
  /** 兼容旧入口；保留数量固定为三份，此参数不再改变窗口。 */
  maxBackups?: number;
}

const editorImageDirectoryName = 'image';
const markdownExtensions = new Set(['.md', '.markdown']);
export const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;
const defaultBackupIntervalMs = 5 * 60 * 1000;

export function ensureBackupBeforeSave(
  filePath: string,
  nextContent: string,
  libraryPath: string,
  options: BackupOptions = {},
): BackupEntry | null {
  assertInsideDirectory(filePath, libraryPath);
  if (!fs.existsSync(filePath)) return null;

  const currentContent = fs.readFileSync(filePath, 'utf8');
  if (currentContent === nextContent) return null;

  const backups = listBackupsForNote(filePath, libraryPath);
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? defaultBackupIntervalMs;
  const latestBackup = backups[0];
  if (latestBackup) {
    const elapsed = now.getTime() - parseBackupTimestamp(latestBackup.createdAt).getTime();
    if (elapsed >= 0 && elapsed < minIntervalMs) return null;
  }

  const backupDir = getNoteBackupDirectory(filePath, libraryPath);

  const createdAt = formatBackupTimestamp(now);
  let backupPath = path.join(backupDir, `${createdAt}.md`);
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(backupDir, `${createdAt}-${counter}.md`);
    counter++;
  }

  const handle = fs.openSync(backupPath, 'wx');
  try { fs.writeFileSync(handle, fs.readFileSync(filePath)); fs.fsyncSync(handle); }
  catch (error) { fs.closeSync(handle); fs.unlinkSync(backupPath); throw error; }
  fs.closeSync(handle);
  pruneNoteBackups(filePath, libraryPath);

  return {
    id: path.basename(backupPath, '.md'),
    createdAt,
    path: backupPath,
  };
}

export function listBackupsForNote(filePath: string, libraryPath: string): BackupEntry[] {
  return listNoteBackups(filePath, libraryPath);
}


export function saveEditorImageToLibrary(
  libraryPath: string,
  notePath: string,
  bytes: Buffer | Uint8Array,
  now = new Date(),
): SavedEditorImage {
  const resolvedLibraryPath = path.resolve(libraryPath);
  const resolvedNotePath = path.resolve(notePath);
  if (!isInsideDirectory(resolvedNotePath, resolvedLibraryPath)) {
    throw new Error('当前笔记路径超出笔记库。');
  }
  if (!markdownExtensions.has(path.extname(resolvedNotePath).toLowerCase())) {
    throw new Error('只有 Markdown 笔记可以粘贴图片。');
  }
  if (!fs.existsSync(resolvedNotePath) || !fs.statSync(resolvedNotePath).isFile()) {
    throw new Error('找不到当前 Markdown 笔记。');
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0) throw new Error('剪贴板图片为空。');
  if (buffer.length > MAX_EDITOR_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');

  const imageType = detectEditorImageType(buffer);
  if (!imageType) {
    throw new Error('只支持 PNG、JPEG、GIF 或 WebP 图片。');
  }

  const imageDirectory = path.join(resolvedLibraryPath, editorImageDirectoryName);
  assertInsideDirectory(imageDirectory, resolvedLibraryPath, '图片保存路径超出当前笔记库或包含链接。');
  if (fs.existsSync(imageDirectory) && !fs.statSync(imageDirectory).isDirectory()) {
    throw new Error('笔记库中的 image 已存在，但它不是文件夹。');
  }
  fs.mkdirSync(imageDirectory, { recursive: true });

  const baseName = `image-${formatEditorImageTimestamp(now)}`;
  let finalName = `${baseName}${imageType.extension}`;
  let absolutePath = path.join(imageDirectory, finalName);
  let counter = 1;
  while (fs.existsSync(absolutePath)) {
    finalName = `${baseName}-${counter}${imageType.extension}`;
    absolutePath = path.join(imageDirectory, finalName);
    counter++;
  }

  if (!isInsideDirectory(absolutePath, resolvedLibraryPath)) {
    throw new Error('图片保存路径超出当前笔记库。');
  }

  let temporaryPath = path.join(imageDirectory, `.${finalName}.tmp`);
  counter = 1;
  while (fs.existsSync(temporaryPath)) {
    temporaryPath = path.join(imageDirectory, `.${finalName}.${counter}.tmp`);
    counter++;
  }

  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  const markdownPath = path.relative(path.dirname(resolvedNotePath), absolutePath).replace(/\\/g, '/');

  return {
    markdownPath,
    absolutePath,
    fileName: finalName,
  };
}

export function getLibraryRelativePath(filePath: string, libraryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(filePath));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('路径位于当前笔记库之外。');
  }
  return relativePath;
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseBackupTimestamp(timestamp: string): Date {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!match) return new Date(0);

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function formatEditorImageTimestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function detectEditorImageType(bytes: Buffer): { extension: '.png' | '.jpg' | '.gif' | '.webp' } | null {
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return { extension: '.png' };

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg' };
  }

  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return { extension: '.gif' };

  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return { extension: '.webp' };

  return null;
}

function isInsideDirectory(candidatePath: string, parentPath: string): boolean {
  try { assertInsideDirectory(candidatePath, parentPath); return true; }
  catch { return false; }
}
