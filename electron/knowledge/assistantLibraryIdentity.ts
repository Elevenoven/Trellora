import { createHash } from 'node:crypto';

export function createAssistantLibraryId(libraryPath: string): string {
  const normalized = libraryPath.replace(/\\/gu, '/').toLocaleLowerCase('en-US');
  return `library-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)}`;
}
