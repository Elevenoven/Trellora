import fs from 'node:fs';
import { assertExistingDirectory, getUniquePath, sanitizeEntryName } from './pathGuards';

export interface CreateLibraryDirectoryOptions {
  name: string;
  workspacePath: string;
  parentDirectoryPath?: string | null;
  now?: Date;
}

export interface CreatedLibraryDirectory {
  path: string;
  alias: string;
}

export function createLibraryDirectory(options: CreateLibraryDirectoryOptions): CreatedLibraryDirectory {
  const alias = sanitizeEntryName(options.name.trim());
  const hasCustomParent = Boolean(options.parentDirectoryPath?.trim());
  const parentDirectory = assertExistingDirectory(
    hasCustomParent ? options.parentDirectoryPath! : options.workspacePath,
  );
  const folderName = hasCustomParent
    ? alias
    : `${alias}-${formatLibraryTimestamp(options.now ?? new Date())}`;
  const libraryPath = getUniquePath(parentDirectory, folderName);

  fs.mkdirSync(libraryPath, { recursive: false });
  return { path: libraryPath, alias };
}

export function formatLibraryTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
