import fs from 'fs';
import path from 'path';
import { assertExistingDirectory, assertInsideDirectory } from './pathGuards';

export interface TreeOrderState {
  version: 1;
  directories: Record<string, string[]>;
}

export interface OrderedTreeEntry {
  name: string;
  isDirectory: boolean;
}

const metaDirectoryName = '.menghan-meta';
const treeOrderFileName = 'tree-order.json';

export function getLibraryMetaDirectory(libraryPath: string): string {
  return assertInsideDirectory(path.join(path.resolve(libraryPath), metaDirectoryName), libraryPath);
}

export function getTreeOrderPath(libraryPath: string): string {
  return path.join(getLibraryMetaDirectory(libraryPath), treeOrderFileName);
}

export function loadTreeOrder(libraryPath: string): TreeOrderState {
  const orderPath = getTreeOrderPath(libraryPath);
  if (!fs.existsSync(orderPath)) return createEmptyTreeOrder();

  try {
    const parsed = JSON.parse(fs.readFileSync(orderPath, 'utf8')) as Partial<TreeOrderState>;
    if (parsed.version !== 1 || !parsed.directories || typeof parsed.directories !== 'object') {
      return createEmptyTreeOrder();
    }

    return {
      version: 1,
      directories: Object.fromEntries(
        Object.entries(parsed.directories)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, value.filter((item): item is string => typeof item === 'string')]),
      ),
    };
  } catch {
    return createEmptyTreeOrder();
  }
}

export function writeTreeOrder(libraryPath: string, order: TreeOrderState): void {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  fs.writeFileSync(getTreeOrderPath(libraryPath), `${JSON.stringify(order, null, 2)}\n`, 'utf8');
}

export function saveDirectoryOrder(libraryPath: string, parentDirectoryPath: string, orderedChildPaths: string[]): boolean {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  assertExistingDirectory(parentDirectory);

  const orderedNames = orderedChildPaths.map((childPath) => {
    const resolvedChildPath = assertInsideDirectory(childPath, library);
    if (path.dirname(resolvedChildPath) !== parentDirectory) {
      throw new Error('所有排序项目都必须位于目标文件夹内。');
    }
    return path.basename(resolvedChildPath);
  });

  const order = loadTreeOrder(library);
  order.directories[getDirectoryOrderKey(library, parentDirectory)] = orderedNames;
  writeTreeOrder(library, order);
  return true;
}

export function sortEntriesByTreeOrder<T extends OrderedTreeEntry>(
  entries: T[],
  libraryPath: string,
  parentDirectoryPath: string,
  order: TreeOrderState,
): T[] {
  const orderKey = getDirectoryOrderKey(libraryPath, parentDirectoryPath);
  const orderedNames = order.directories[orderKey] ?? [];
  const positions = new Map(orderedNames.map((name, index) => [name, index]));

  return [...entries].sort((a, b) => {
    const aPosition = positions.get(a.name);
    const bPosition = positions.get(b.name);

    if (aPosition !== undefined || bPosition !== undefined) {
      if (aPosition === undefined) return 1;
      if (bPosition === undefined) return -1;
      return aPosition - bPosition;
    }

    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function removeEntryFromSavedOrders(libraryPath: string, entryPath: string): void {
  const library = assertExistingDirectory(libraryPath);
  const entryName = path.basename(entryPath);
  const order = loadTreeOrder(library);
  let changed = false;

  for (const [directoryKey, names] of Object.entries(order.directories)) {
    const nextNames = names.filter((name) => name !== entryName);
    if (nextNames.length !== names.length) {
      order.directories[directoryKey] = nextNames;
      changed = true;
    }
  }

  if (changed) writeTreeOrder(library, order);
}

export function appendEntryToDirectoryOrder(libraryPath: string, parentDirectoryPath: string, entryPath: string): void {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  const entryName = path.basename(entryPath);
  const order = loadTreeOrder(library);
  const orderKey = getDirectoryOrderKey(library, parentDirectory);
  const existing = order.directories[orderKey] ?? [];
  order.directories[orderKey] = [...existing.filter((name) => name !== entryName), entryName];
  writeTreeOrder(library, order);
}

export function placeEntryInDirectoryOrder(
  libraryPath: string,
  parentDirectoryPath: string,
  entryPath: string,
  siblingPath: string,
  placement: 'before' | 'after',
): void {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  assertExistingDirectory(parentDirectory);
  const resolvedEntry = assertInsideDirectory(entryPath, library);
  const resolvedSibling = assertInsideDirectory(siblingPath, library);
  if (path.dirname(resolvedEntry) !== parentDirectory || path.dirname(resolvedSibling) !== parentDirectory) {
    throw new Error('排序项目必须位于同一个文件夹内。');
  }

  const order = loadTreeOrder(library);
  const entries = fs.readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => entry.name !== metaDirectoryName)
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  const orderedPaths = sortEntriesByTreeOrder(entries, library, parentDirectory, order)
    .map((entry) => path.join(parentDirectory, entry.name))
    .filter((childPath) => childPath !== resolvedEntry);
  const siblingIndex = orderedPaths.indexOf(resolvedSibling);
  if (siblingIndex === -1) throw new Error('相邻项目不存在。');
  orderedPaths.splice(placement === 'after' ? siblingIndex + 1 : siblingIndex, 0, resolvedEntry);
  saveDirectoryOrder(library, parentDirectory, orderedPaths);
}

export function getDirectoryOrderKey(libraryPath: string, directoryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(directoryPath)).replace(/\\/g, '/');
  return relativePath === '' ? '' : relativePath;
}

function createEmptyTreeOrder(): TreeOrderState {
  return {
    version: 1,
    directories: {},
  };
}
