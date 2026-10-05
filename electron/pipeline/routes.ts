import path from 'node:path';
import type { ParsingRoute } from './types';

export const directTextExtensions = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.log', '.xml', '.html', '.htm',
]);

export const mammothExtensions = new Set(['.docx']);

export function resolveParsingRoute(extensionOrName: string): ParsingRoute {
  const extension = normalizeExtension(extensionOrName);
  if (directTextExtensions.has(extension)) return 'direct';
  if (mammothExtensions.has(extension)) return 'mammoth';
  if (extension === '.pdf') return 'mineru';
  return 'unsupported';
}

export function isMammothFormat(extensionOrName: string): boolean {
  return mammothExtensions.has(normalizeExtension(extensionOrName));
}

function normalizeExtension(extensionOrName: string): string {
  const normalized = extensionOrName.trim().toLowerCase();
  return /^\.[a-z0-9]+$/u.test(normalized) ? normalized : path.extname(normalized);
}
