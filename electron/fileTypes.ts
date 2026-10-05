import path from 'path';

export type FileKind = 'markdown' | 'text';

export interface FileTypeInfo {
  extension: string;
  kind: FileKind;
}
export const markdownExtensions = new Set(['.md', '.markdown']);

export const supportedTextExtensions = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.sh',
  '.bat',
  '.ps1',
  '.sql',
]);

export function getNormalizedExtension(filePathOrName: string): string {
  return path.extname(filePathOrName).toLowerCase();
}

export function isMarkdownFile(filePathOrName: string): boolean {
  return markdownExtensions.has(getNormalizedExtension(filePathOrName));
}

export function isSupportedTextFile(filePathOrName: string): boolean {
  return supportedTextExtensions.has(getNormalizedExtension(filePathOrName));
}

export function getFileTypeInfo(filePathOrName: string): FileTypeInfo | null {
  const extension = getNormalizedExtension(filePathOrName);
  if (!supportedTextExtensions.has(extension)) return null;
  return {
    extension,
    kind: markdownExtensions.has(extension) ? 'markdown' : 'text',
  };
}

export function stripKnownTextExtension(fileName: string): string {
  const extension = getNormalizedExtension(fileName);
  if (!extension || !supportedTextExtensions.has(extension)) return fileName;
  return fileName.slice(0, -extension.length);
}

export function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;

  const hasUtf8Bom = buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
  const hasUtf16Bom = buffer.length >= 2
    && (
      (buffer[0] === 0xff && buffer[1] === 0xfe)
      || (buffer[0] === 0xfe && buffer[1] === 0xff)
    );

  if (hasUtf8Bom || hasUtf16Bom) return true;

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;

  let controlCharacters = 0;
  for (const byte of sample) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedControl) controlCharacters++;
  }

  return controlCharacters / sample.length < 0.03;
}
