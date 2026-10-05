import fs from 'node:fs';
import path from 'node:path';
import { getFileTypeInfo } from './fileTypes';

export interface LibraryRegistration {
  path: string;
  alias: string;
  addedAt: string;
  lastOpenedAt: string;
}

export interface LibrarySummary extends LibraryRegistration {
  exists: boolean;
  isActive: boolean;
  noteCount: number;
  attachmentCount: number;
}

interface LibraryRegistryStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

const librariesKey = 'libraries';
const activeLibraryKey = 'activeLibraryPath';
const legacyLibraryKey = 'libraryPath';
const ignoredDirectories = new Set(['.git', '.menghan-backups', '.menghan-meta', 'node_modules', '_attachments']);

export function listRegisteredLibraries(store: LibraryRegistryStore): LibraryRegistration[] {
  const stored = normalizeRegistrations(store.get(librariesKey));
  const legacyPath = normalizePath(store.get(legacyLibraryKey));
  if (!legacyPath || stored.some((library) => library.path === legacyPath)) return stored;

  const now = new Date().toISOString();
  const migrated = [
    ...stored,
    {
      path: legacyPath,
      alias: path.basename(legacyPath) || '未命名笔记库',
      addedAt: now,
      lastOpenedAt: now,
    },
  ];
  store.set(librariesKey, migrated);
  store.set(activeLibraryKey, legacyPath);
  return migrated;
}

export function registerAndActivateLibrary(
  store: LibraryRegistryStore,
  libraryPath: string,
  now = new Date(),
  alias?: string,
): string {
  const normalizedPath = path.resolve(libraryPath);
  const registrations = listRegisteredLibraries(store);
  const current = registrations.find((library) => library.path === normalizedPath);
  const timestamp = now.toISOString();
  const normalizedAlias = alias?.trim() || undefined;
  const next = current
    ? registrations.map((library) => library.path === normalizedPath
      ? { ...library, lastOpenedAt: timestamp, ...(normalizedAlias ? { alias: normalizedAlias } : {}) }
      : library)
    : [
      ...registrations,
      {
        path: normalizedPath,
        alias: normalizedAlias ?? (path.basename(normalizedPath) || '未命名笔记库'),
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      },
    ];

  store.set(librariesKey, next);
  store.set(activeLibraryKey, normalizedPath);
  store.set(legacyLibraryKey, normalizedPath);
  return normalizedPath;
}

export function activateRegisteredLibrary(
  store: LibraryRegistryStore,
  libraryPath: string,
  now = new Date(),
): string {
  const normalizedPath = path.resolve(libraryPath);
  const registrations = listRegisteredLibraries(store);
  if (!registrations.some((library) => library.path === normalizedPath)) {
    throw new Error('该笔记库尚未注册，请先添加笔记库。');
  }
  return registerAndActivateLibrary(store, normalizedPath, now);
}

export function removeRegisteredLibrary(store: LibraryRegistryStore, libraryPath: string): LibraryRegistration[] {
  const normalizedPath = path.resolve(libraryPath);
  const next = listRegisteredLibraries(store).filter((library) => library.path !== normalizedPath);
  store.set(librariesKey, next);
  if (normalizePath(store.get(activeLibraryKey)) === normalizedPath || normalizePath(store.get(legacyLibraryKey)) === normalizedPath) {
    store.delete(activeLibraryKey);
    store.delete(legacyLibraryKey);
  }
  return next;
}

export function summarizeRegisteredLibraries(
  store: LibraryRegistryStore,
  activePath: string | null,
): LibrarySummary[] {
  const normalizedActivePath = activePath ? path.resolve(activePath) : null;
  return listRegisteredLibraries(store).map((library) => {
    const exists = isReadableDirectory(library.path);
    const isActive = normalizedActivePath === library.path;
    const counts = exists ? countLibraryFiles(library.path) : { noteCount: 0, attachmentCount: 0 };
    return {
      ...library,
      exists,
      isActive,
      ...counts,
    };
  });
}

function normalizeRegistrations(value: unknown): LibraryRegistration[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const libraryPath = normalizePath(record.path);
    if (!libraryPath || seen.has(libraryPath)) return [];
    seen.add(libraryPath);
    const now = new Date().toISOString();
    return [{
      path: libraryPath,
      alias: typeof record.alias === 'string' && record.alias.trim() ? record.alias.trim() : path.basename(libraryPath) || '未命名笔记库',
      addedAt: typeof record.addedAt === 'string' && record.addedAt ? record.addedAt : now,
      lastOpenedAt: typeof record.lastOpenedAt === 'string' && record.lastOpenedAt ? record.lastOpenedAt : now,
    }];
  });
}

function normalizePath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? path.resolve(value) : null;
}

function isReadableDirectory(libraryPath: string): boolean {
  try {
    if (!fs.statSync(libraryPath).isDirectory()) return false;
    fs.accessSync(libraryPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function countLibraryFiles(libraryPath: string): { noteCount: number; attachmentCount: number } {
  let noteCount = 0;
  const attachmentCount = 0;
  const walk = (directoryPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(path.join(directoryPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (getFileTypeInfo(entry.name)) noteCount += 1;
    }
  };
  walk(libraryPath);
  return { noteCount, attachmentCount };
}
