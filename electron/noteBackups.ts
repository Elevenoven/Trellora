import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NOTE_BACKUP_RETENTION } from '../shared/noteBackup';
import { getFileTypeInfo } from './fileTypes';
import { assertInsideDirectory } from './pathGuards';
import { renameWithWindowsRetry, renameWithWindowsRetryAsync } from './fileSystemRename';

export interface BackupEntry { id: string; createdAt: string; path: string }

/** 仅接受应用生成的日期和正整数冲突序号，其他文件始终保留。 */
function backupIdentity(name: string): { stamp: string; sequence: bigint; time: number } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([1-9]\d*))?\.md$/.exec(name);
  if (!match) return;
  const [, year, month, day, hour, minute, second, sequence] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (parts[0] < 1000 || utc.getUTCFullYear() !== parts[0] || utc.getUTCMonth() + 1 !== parts[1]
    || utc.getUTCDate() !== parts[2] || utc.getUTCHours() !== parts[3]
    || utc.getUTCMinutes() !== parts[4] || utc.getUTCSeconds() !== parts[5]) return;
  return { stamp: name.slice(0, 15), sequence: BigInt(sequence ?? '0'), time: new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime() };
}

/** 逐级拒绝备份树内的符号链接和 junction，不跟随它们读取或清理其他目录。 */
function checkDirectory(root: string, directory: string, create = false): boolean {
  assertInsideDirectory(directory, path.join(root, '.menghan-backups'), '备份目录超出允许范围或包含链接。');
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('备份目录不是普通文件夹，已停止操作以保护现有文件。');
    assertInsideDirectory(fs.realpathSync(current), root);
  }
  return true;
}

/** Full filenames own v2 histories; ambiguous legacy histories are never read or restored. */
function backupLocation(filePath: string, libraryPath: string): { root: string; directory: string; ambiguous: boolean } {
  assertInsideDirectory(filePath, libraryPath);
  const root = fs.realpathSync(libraryPath);
  const source = fs.realpathSync(filePath);
  assertInsideDirectory(source, root);
  if (!getFileTypeInfo(source) || !fs.statSync(source).isFile()) throw new Error('找不到可备份的笔记文件。');
  const relative = path.relative(root, source);
  if (['.menghan-backups', '.menghan-meta'].includes(relative.split(path.sep)[0])) throw new Error('不能对系统目录中的文件清理笔记备份。');
  const parsed = path.parse(relative);
  const siblings = fs.readdirSync(path.dirname(source), { withFileTypes: true }).filter((item) =>
    (item.isFile() || item.isSymbolicLink()) && getFileTypeInfo(item.name) && path.parse(item.name).name.toLowerCase() === parsed.name.toLowerCase());
  const directory = path.join(root, '.menghan-backups', '.v2', relative);
  const legacy = path.join(root, '.menghan-backups', parsed.dir, parsed.name);
  if (checkDirectory(root, legacy)) {
    const marker = path.join(legacy, '.trellora-legacy-ambiguous');
    if (siblings.length > 1 || fs.existsSync(marker)) {
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, '旧格式无法区分同名不同扩展名，禁止自动恢复。\n', { flag: 'wx' });
    } else if (!checkDirectory(root, directory)) {
      checkDirectory(root, path.dirname(directory), true);
      renameWithWindowsRetry(legacy, directory);
    }
  }
  return { root, directory, ambiguous: false };
}

export interface NoteBackupPathMove { from: string; to: string }

/** Migrate attributable legacy notes before reserving a whole file/folder backup subtree. */
export function prepareNoteBackupPathMove(libraryPath: string, sourcePath: string, targetPath: string): NoteBackupPathMove | null {
  const root = fs.realpathSync(libraryPath);
  assertInsideDirectory(sourcePath, libraryPath);
  assertInsideDirectory(targetPath, libraryPath);
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error('移动目录包含链接，已停止操作。');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) if (!child.startsWith('.')) visit(path.join(entry, child));
    } else if (getFileTypeInfo(entry)) backupLocation(entry, libraryPath);
  };
  visit(sourcePath);
  const from = path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(libraryPath), sourcePath));
  const to = path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(libraryPath), targetPath));
  const targetRelative = path.relative(path.resolve(libraryPath), targetPath);
  const legacyTarget = path.join(root, '.menghan-backups', fs.statSync(sourcePath).isDirectory()
    ? targetRelative : path.join(path.dirname(targetRelative), path.parse(targetRelative).name));
  if (checkDirectory(root, to) || checkDirectory(root, legacyTarget)) throw new Error('目标路径已有笔记历史，无法覆盖。请使用其他名称。');
  if (!checkDirectory(root, from)) return null;
  checkDirectory(root, path.dirname(to), true);
  return { from, to };
}

/** Used for both commit and rollback; no destination history may be overwritten. */
export async function moveNoteBackupDirectory(libraryPath: string, move: NoteBackupPathMove): Promise<void> {
  const root = fs.realpathSync(libraryPath);
  if (!checkDirectory(root, move.from)) return;
  if (checkDirectory(root, move.to)) throw new Error('目标路径已有笔记历史，已停止迁移。');
  checkDirectory(root, path.dirname(move.to), true);
  await renameWithWindowsRetryAsync(move.from, move.to, () => {
    if (!checkDirectory(root, move.from)) throw new Error('原备份目录发生变化，已停止迁移。');
    if (checkDirectory(root, move.to)) throw new Error('目标路径已有笔记历史，已停止迁移。');
  });
}

/** Reverse a completed application path change when index/metadata publication fails. */
export async function rollbackNoteBackupPath(libraryPath: string, previousPath: string, nextPath: string): Promise<void> {
  const root = fs.realpathSync(libraryPath);
  await moveNoteBackupDirectory(libraryPath, {
    from: path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(libraryPath), nextPath)),
    to: path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(libraryPath), previousPath)),
  });
}

/** 旧同步入口也使用同一目录校验，避免它绕过备份树的链接检查。 */
export function getNoteBackupDirectory(filePath: string, libraryPath: string): string {
  const { root, directory } = backupLocation(filePath, libraryPath);
  checkDirectory(root, directory, true);
  return directory;
}

/** 清单只包含普通、非硬链接的备份文件；按时间和数字序号从新到旧排序。 */
export function listNoteBackups(filePath: string, libraryPath: string): BackupEntry[] {
  const { root, directory } = backupLocation(filePath, libraryPath);
  if (!checkDirectory(root, directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && backupIdentity(item.name) && fs.lstatSync(path.join(directory, item.name)).nlink === 1)
    .map((item) => ({ id: item.name.slice(0, -3), createdAt: item.name.slice(0, 15), path: path.join(directory, item.name) }))
    .sort((a, b) => {
      const dateOrder = b.createdAt.localeCompare(a.createdAt);
      if (dateOrder) return dateOrder;
      const left = backupIdentity(`${a.id}.md`)!.sequence, right = backupIdentity(`${b.id}.md`)!.sequence;
      return left === right ? 0 : left > right ? -1 : 1;
    });
}

/** 删除前先验证保留的三份可读；只 unlink 已确认的旧文件，绝不递归删除目录。 */
export function pruneNoteBackups(filePath: string, libraryPath: string): BackupEntry[] {
  const location = backupLocation(filePath, libraryPath);
  const backups = listNoteBackups(filePath, libraryPath);
  const retained = backups.slice(0, NOTE_BACKUP_RETENTION);
  if (backups.length <= NOTE_BACKUP_RETENTION || location.ambiguous) return retained;
  const inspected = backups.map((backup) => ({ backup, stat: fs.lstatSync(backup.path) }));
  for (const backup of retained) {
    checkDirectory(location.root, location.directory);
    const stat = fs.lstatSync(backup.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('保留的备份发生变化，已停止清理。');
    fs.readFileSync(backup.path);
  }
  for (const { backup, stat: before } of inspected.slice(NOTE_BACKUP_RETENTION)) {
    checkDirectory(location.root, location.directory);
    if (path.dirname(backup.path) !== location.directory || !backupIdentity(path.basename(backup.path))) throw new Error('备份路径无效，已停止清理。');
    let current: fs.Stats;
    try { current = fs.lstatSync(backup.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs || current.size !== before.size) continue;
    fs.unlinkSync(backup.path);
  }
  return retained;
}

/** 按当前笔记的真实清单读取，拒绝路径穿越和被替换为链接的恢复文件。 */
export function readNoteBackup(filePath: string, libraryPath: string, id: string): Buffer {
  const backup = listNoteBackups(filePath, libraryPath).find((entry) => entry.id === id);
  if (!backup) throw new Error('找不到该备份。');
  const { root, directory } = backupLocation(filePath, libraryPath);
  checkDirectory(root, directory);
  const stat = fs.lstatSync(backup.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.relative(backup.path, fs.realpathSync(backup.path)) !== '') throw new Error('备份文件发生变化，无法恢复。');
  return fs.readFileSync(backup.path);
}

/** 原始字节完整写入并同步后才可清理；失败只撤销本次独占创建的文件。 */
export async function createNoteBackup(filePath: string, libraryPath: string, bytes: Buffer, now = new Date(), minIntervalMs = 5 * 60_000): Promise<BackupEntry | null> {
  const { root, directory } = backupLocation(filePath, libraryPath);
  checkDirectory(root, directory, true);
  const latest = listNoteBackups(filePath, libraryPath)[0];
  const elapsed = latest ? now.getTime() - backupIdentity(`${latest.id}.md`)!.time : Infinity;
  if (elapsed >= 0 && elapsed < minIntervalMs) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const temporary = path.join(directory, `.trellora-backup-${randomUUID()}.tmp`);
  const handle = await fs.promises.open(temporary, 'wx');
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    for (let sequence = 0; ; sequence++) {
      const id = `${stamp}${sequence ? `-${sequence}` : ''}`;
      const target = path.join(directory, `${id}.md`);
      checkDirectory(root, directory);
      // link 原子发布完整字节且不覆盖同名文件；临时链接删除后只剩一个正式入口。
      try { await fs.promises.link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      await fs.promises.unlink(temporary);
      return { id, createdAt: stamp, path: target };
    }
  } finally {
    checkDirectory(root, directory);
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
