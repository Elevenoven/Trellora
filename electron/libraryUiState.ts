import fs from 'fs';
import path from 'path';
import { assertInsideDirectory } from './pathGuards';
import { isSupportedTextFile } from './fileTypes';

export interface LibraryUiState {
  schemaVersion: 1;
  collapsedFolderPaths: string[];
  pinnedEntryPaths: string[];
}

export type LibraryUiStatePatch = Partial<Omit<LibraryUiState, 'schemaVersion'>>;

const schemaVersion = 1 as const;
const metadataDirectoryName = '.menghan-meta';
const stateFileName = 'ui-state.json';

export function getLibraryUiState(libraryPath: string): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const stored = readStoredState(library);
  const collapsedFolderPaths = stored
    ? sanitizeFolderPaths(library, stored.collapsedFolderPaths)
    : collectLibraryFolderPaths(library);
  const state: LibraryUiState = {
    schemaVersion,
    collapsedFolderPaths,
    pinnedEntryPaths: sanitizePinnedPaths(library, stored?.pinnedEntryPaths ?? []),
  };

  if (stored && (!arraysEqual(stored.collapsedFolderPaths, collapsedFolderPaths) || !arraysEqual(stored.pinnedEntryPaths, state.pinnedEntryPaths))) {
    writeLibraryUiState(library, state);
  }
  return state;
}

export function saveLibraryUiState(libraryPath: string, patch: LibraryUiStatePatch): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const current = getLibraryUiState(library);
  const next: LibraryUiState = {
    ...current,
    schemaVersion,
    collapsedFolderPaths: patch.collapsedFolderPaths === undefined
      ? current.collapsedFolderPaths
      : sanitizeFolderPaths(library, patch.collapsedFolderPaths, true),
    pinnedEntryPaths: patch.pinnedEntryPaths === undefined
      ? current.pinnedEntryPaths
      : sanitizePinnedPaths(library, patch.pinnedEntryPaths, true),
  };
  writeLibraryUiState(library, next);
  return next;
}

export function migrateLibraryUiStatePath(libraryPath: string, oldPath: string, newPath: string): void {
  const library = resolveLibrary(libraryPath);
  const resolvedOldPath = assertInsideDirectory(oldPath, library);
  const resolvedNewPath = assertInsideDirectory(newPath, library);
  const stored = readStoredState(library);
  if (!stored) return;
  const migratePath = (folderPath: string) => {
    const relative = path.relative(resolvedOldPath, folderPath);
    const isSameOrDescendant = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    return isSameOrDescendant ? path.join(resolvedNewPath, relative) : folderPath;
  };
  writeLibraryUiState(library, {
    ...stored,
    schemaVersion,
    collapsedFolderPaths: sanitizeFolderPaths(library, stored.collapsedFolderPaths.map(migratePath)),
    pinnedEntryPaths: sanitizePinnedPaths(library, stored.pinnedEntryPaths.map(migratePath)),
  });
}

export function pruneLibraryUiState(libraryPath: string): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const state = getLibraryUiState(library);
  return saveLibraryUiState(library, { collapsedFolderPaths: state.collapsedFolderPaths });
}

function resolveLibrary(libraryPath: string): string {
  const resolved = path.resolve(libraryPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('笔记库不存在。');
  }
  return resolved;
}

function readStoredState(libraryPath: string): LibraryUiState | null {
  const statePath = getStatePath(libraryPath);
  if (!fs.existsSync(statePath)) return null;
  try {
    const candidate = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<LibraryUiState>;
    if (candidate.schemaVersion !== schemaVersion || !Array.isArray(candidate.collapsedFolderPaths)) return null;
    return {
      schemaVersion,
      collapsedFolderPaths: candidate.collapsedFolderPaths.filter((entry): entry is string => typeof entry === 'string'),
      pinnedEntryPaths: Array.isArray(candidate.pinnedEntryPaths)
        ? candidate.pinnedEntryPaths.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writeLibraryUiState(libraryPath: string, state: LibraryUiState): void {
  const metadataDirectory = path.join(libraryPath, metadataDirectoryName);
  fs.mkdirSync(metadataDirectory, { recursive: true });
  const statePath = getStatePath(libraryPath);
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, statePath);
}

function sanitizeFolderPaths(libraryPath: string, folderPaths: string[], strict = false): string[] {
  const metadataDirectory = path.join(libraryPath, metadataDirectoryName);
  const valid = new Set<string>();
  for (const candidate of folderPaths) {
    if (typeof candidate !== 'string') continue;
    let resolved: string;
    try {
      resolved = assertInsideDirectory(candidate, libraryPath, '界面状态路径必须位于当前笔记库内。');
    } catch {
      if (strict) throw new Error('界面状态路径必须位于当前笔记库内。');
      continue;
    }
    if (resolved === libraryPath || resolved === metadataDirectory) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    valid.add(resolved);
  }
  return [...valid].sort((left, right) => left.localeCompare(right));
}

/** 只保留笔记库内仍存在的可见笔记或文件夹，兼容旧界面状态。 */
function sanitizePinnedPaths(libraryPath: string, entryPaths: string[], strict = false): string[] {
  if (!Array.isArray(entryPaths)) throw new Error('置顶列表格式无效。');
  const valid = new Set<string>();
  for (const candidate of entryPaths) {
    if (typeof candidate !== 'string') continue;
    let resolved: string;
    try {
      resolved = assertInsideDirectory(candidate, libraryPath, '置顶项目必须位于当前笔记库内。');
    } catch {
      if (strict) throw new Error('置顶项目必须位于当前笔记库内。');
      continue;
    }
    const relative = path.relative(libraryPath, resolved);
    if (!relative || relative.split(path.sep).some((part) => ['.menghan-meta', '.menghan-backups', '.git', 'node_modules'].includes(part))) continue;
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory() || (stat.isFile() && isSupportedTextFile(resolved))) valid.add(resolved);
  }
  return [...valid];
}

function collectLibraryFolderPaths(libraryPath: string): string[] {
  const result: string[] = [];
  const visit = (directoryPath: string) => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === metadataDirectoryName || entry.name === '.menghan-backups' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const childPath = path.join(directoryPath, entry.name);
      result.push(childPath);
      visit(childPath);
    }
  };
  visit(libraryPath);
  return result.sort((left, right) => left.localeCompare(right));
}

function getStatePath(libraryPath: string): string {
  return path.join(libraryPath, metadataDirectoryName, stateFileName);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
