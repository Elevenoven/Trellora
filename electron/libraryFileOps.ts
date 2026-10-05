import fs from 'fs';
import path from 'path';
import { stripKnownTextExtension } from './fileTypes';
import { renameWithWindowsRetryAsync } from './fileSystemRename';
import { moveNoteBackupDirectory, prepareNoteBackupPathMove, type NoteBackupPathMove } from './noteBackups';
import {
  appendEntryToDirectoryOrder,
  placeEntryInDirectoryOrder,
  removeEntryFromSavedOrders,
  saveDirectoryOrder,
  loadTreeOrder,
  writeTreeOrder,
  getLibraryMetaDirectory,
  type TreeOrderState,
} from './treeOrder';
import {
  assertExistingDirectory,
  assertInsideDirectory,
  getUniquePath,
  sanitizeEntryName,
} from './pathGuards';

export interface MovePosition {
  type: 'inside' | 'before' | 'after';
  siblingPath?: string;
}

export { saveDirectoryOrder };

export function createFolderInLibrary(libraryPath: string, parentDirectoryPath: string | null, name: string): string {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = parentDirectoryPath
    ? assertInsideDirectory(parentDirectoryPath, library)
    : library;
  assertExistingDirectory(parentDirectory);

  const safeName = sanitizeEntryName(name);
  const folderPath = getUniquePath(parentDirectory, safeName);
  fs.mkdirSync(folderPath, { recursive: false });
  appendEntryToDirectoryOrder(library, parentDirectory, folderPath);
  return folderPath;
}

export async function renameEntryInLibrary(libraryPath: string, oldPath: string, newName: string): Promise<string | null> {
  const library = assertExistingDirectory(libraryPath);
  const resolvedOldPath = assertInsideDirectory(oldPath, library);
  if (!fs.existsSync(resolvedOldPath)) return null;

  const isDirectory = fs.statSync(resolvedOldPath).isDirectory();
  const safeName = sanitizeEntryName(newName);
  const extension = isDirectory ? '' : path.extname(resolvedOldPath);
  const baseName = isDirectory ? safeName : stripKnownTextExtension(safeName);
  const finalName = isDirectory ? baseName : `${baseName}${extension}`;
  const newPath = path.join(path.dirname(resolvedOldPath), finalName);

  if (fs.existsSync(newPath)) {
    throw new Error('已存在同名文件或文件夹。');
  }

  await moveWithOrder(library, resolvedOldPath, newPath, () => {
    removeEntryFromSavedOrders(library, resolvedOldPath);
    appendEntryToDirectoryOrder(library, path.dirname(newPath), newPath);
  });
  return newPath;
}

export async function moveEntryInLibrary(
  libraryPath: string,
  sourcePath: string,
  targetDirectoryPath: string,
  position: MovePosition = { type: 'inside' },
): Promise<string | null> {
  const library = assertExistingDirectory(libraryPath);
  const resolvedSourcePath = assertInsideDirectory(sourcePath, library);
  if (!fs.existsSync(resolvedSourcePath)) return null;

  const targetDirectory = resolveMoveTargetDirectory(library, targetDirectoryPath, position);
  const sourceStat = fs.statSync(resolvedSourcePath);
  if (sourceStat.isDirectory()) {
    const relativeTarget = path.relative(resolvedSourcePath, targetDirectory);
    if (relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))) {
      throw new Error('不能将文件夹移动到自身内部。');
    }
  }

  const newPath = path.join(targetDirectory, path.basename(resolvedSourcePath));
  if (path.resolve(newPath) === path.resolve(resolvedSourcePath)) {
    if ((position.type === 'before' || position.type === 'after') && position.siblingPath) {
      const siblingPath = assertInsideDirectory(position.siblingPath, library);
      if (path.resolve(siblingPath) !== path.resolve(resolvedSourcePath)) {
        placeEntryInDirectoryOrder(
          library,
          targetDirectory,
          resolvedSourcePath,
          siblingPath,
          position.type,
        );
      }
    }
    return resolvedSourcePath;
  }
  if (fs.existsSync(newPath)) {
    throw new Error('目标文件夹中已存在同名文件或文件夹。');
  }

  await moveWithOrder(library, resolvedSourcePath, newPath, () => {
    removeEntryFromSavedOrders(library, resolvedSourcePath);
    if ((position.type === 'before' || position.type === 'after') && position.siblingPath) {
      placeEntryInDirectoryOrder(library, targetDirectory, newPath, position.siblingPath, position.type);
    } else {
      appendEntryToDirectoryOrder(library, targetDirectory, newPath);
    }
  });
  return newPath;
}

function resolveMoveTargetDirectory(libraryPath: string, targetDirectoryPath: string, position: MovePosition): string {
  if (position.type === 'before' || position.type === 'after') {
    if (!position.siblingPath) throw new Error('排序移动时缺少相邻项目路径。');
    const siblingPath = assertInsideDirectory(position.siblingPath, libraryPath);
    if (!fs.existsSync(siblingPath)) throw new Error('相邻项目不存在。');
    return path.dirname(siblingPath);
  }

  const targetDirectory = assertInsideDirectory(targetDirectoryPath, libraryPath);
  return assertExistingDirectory(targetDirectory);
}

/** A failed order write must not expose an unreported filesystem rename to the watcher. */
async function moveWithOrder(library: string, source: string, target: string, update: () => void): Promise<void> {
  await recoverLibraryPathMove(library);
  const order = loadTreeOrder(library);
  const backup = prepareNoteBackupPathMove(library, source, target);
  const journal = pathMoveJournalPath(library);
  assertInsideDirectory(path.dirname(journal), library);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const handle = fs.openSync(journal, 'wx');
  try { fs.writeFileSync(handle, JSON.stringify({ version: 1, source, target, backup, order })); fs.fsyncSync(handle); }
  catch (error) { fs.closeSync(handle); fs.unlinkSync(journal); throw error; }
  fs.closeSync(handle);
  try {
    await renameWithWindowsRetryAsync(source, target, () => assertMovePaths(library, source, target));
    if (backup) await moveNoteBackupDirectory(library, backup);
    update();
    fs.unlinkSync(journal);
  }
  catch (error) {
    // If rollback fails, retain the synced journal for the next library activation.
    await recoverLibraryPathMove(library);
    throw error;
  }
}

function pathMoveJournalPath(library: string): string {
  return assertInsideDirectory(path.join(getLibraryMetaDirectory(library), 'note-path-move.json'), library);
}

/** Recheck physical ancestors and destination ownership after every asynchronous retry. */
function assertMovePaths(library: string, source: string, target: string): void {
  assertInsideDirectory(source, library);
  assertInsideDirectory(target, library);
  if (fs.existsSync(target)) throw new Error('目标路径已被其他文件占用，已停止移动。');
}

/** Recover unfinished filesystem/order/backup moves before the library is indexed. */
export async function recoverLibraryPathMove(library: string): Promise<void> {
  const journal = pathMoveJournalPath(library);
  if (!fs.existsSync(journal)) return;
  const stat = fs.lstatSync(journal);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw new Error('笔记移动恢复记录无效，请保留文件并检查笔记库。');
  const record = JSON.parse(fs.readFileSync(journal, 'utf8')) as { version: number; source: string; target: string; order: TreeOrderState; backup: NoteBackupPathMove | null };
  if (record.version !== 1 || typeof record.source !== 'string' || typeof record.target !== 'string'
    || record.order?.version !== 1 || !record.order.directories || typeof record.order.directories !== 'object'
    || !Object.values(record.order.directories).every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw new Error('笔记移动恢复记录格式无效。');
  const source = assertInsideDirectory(record.source, library), target = assertInsideDirectory(record.target, library);
  for (const entry of [source, target]) {
    const relative = path.relative(path.resolve(library), entry);
    if (!relative || relative.split(path.sep).some(part => part.startsWith('.'))) throw new Error('笔记移动恢复路径无效。');
  }
  if (record.backup) {
    const root = fs.realpathSync(library);
    const expected = (entry: string) => path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(library), entry));
    if (record.backup.from !== expected(source) || record.backup.to !== expected(target)) throw new Error('备份移动恢复路径无效。');
  }
  const sourceExists = fs.existsSync(source), targetExists = fs.existsSync(target);
  if (sourceExists === targetExists) throw new Error('笔记移动恢复遇到路径冲突，请保留现有文件后检查。');
  if (targetExists) await renameWithWindowsRetryAsync(target, source, () => assertMovePaths(library, target, source));
  if (record.backup) await moveNoteBackupDirectory(library, { from: record.backup.to, to: record.backup.from });
  writeTreeOrder(library, record.order);
  fs.unlinkSync(journal);
}

/** Metadata/index rollback uses the same journaled file and history movement. */
export async function restoreEntryPath(library: string, source: string, target: string, order: TreeOrderState): Promise<void> {
  await moveWithOrder(library, source, target, () => writeTreeOrder(library, order));
}
