import type { SavedEditorImage } from '../electron';
export { toEditorImageUrl } from '../../shared/editorImageProtocol';

export type ClipboardImageSource =
  | { kind: 'file'; file: File }
  | { kind: 'local-path'; sourcePath: string };

export const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;
const supportedImageExtensionPattern = /\.(?:png|jpe?g|gif|webp)$/i;
const supportedDataImagePattern = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;

export function getClipboardImageSources(dataTransfer: DataTransfer): ClipboardImageSource[] {
  const files = getImageFiles(dataTransfer);
  if (files.length > 0) return files.map((file) => ({ kind: 'file', file }));

  const html = dataTransfer.getData('text/html');
  const htmlSources = extractImageSourcesFromHtml(html);
  if (htmlSources.length > 0 && isImageOnlyHtml(html)) {
    const sources = htmlSources.flatMap(toClipboardImageSource);
    if (sources.length > 0) return deduplicateSources(sources);
  }

  const localPaths = extractLocalImagePathsFromMarkdown(dataTransfer.getData('text/plain'));
  return deduplicateSources(localPaths.map((sourcePath) => ({ kind: 'local-path', sourcePath })));
}

export function getDroppedImageSources(dataTransfer: DataTransfer): ClipboardImageSource[] {
  return getImageFiles(dataTransfer).map((file) => ({ kind: 'file', file }));
}

export function extractLocalImagePathsFromMarkdown(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const destinations: string[] = [];
  const withoutImages = trimmed.replace(
    /!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|(?:file:\/\/\/|[a-z]:[\\/])[^)\r\n]+)\s*\)/gi,
    (_match, rawDestination: string) => {
      const destination = normalizeMarkdownImageDestination(rawDestination);
      const localPath = destination ? toLocalImagePath(destination) : null;
      if (localPath) destinations.push(localPath);
      return '';
    },
  );

  return withoutImages.trim() === '' ? destinations : [];
}

export function formatSavedEditorImageMarkdown(saved: SavedEditorImage): string {
  const alt = saved.fileName
    .replace(/\.[^.]+$/, '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
  return `![${alt}](${saved.markdownPath})`;
}

function getImageFiles(dataTransfer: DataTransfer): File[] {
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedImageFile(file)));
  const candidates = itemFiles.length > 0
    ? itemFiles
    : Array.from(dataTransfer.files ?? []).filter(isSupportedImageFile);

  const seen = new Set<string>();
  return candidates.filter((file) => {
    const key = `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSupportedImageFile(file: File): boolean {
  return /^(?:image\/(?:png|jpeg|gif|webp))$/i.test(file.type)
    || supportedImageExtensionPattern.test(file.name);
}

function extractImageSourcesFromHtml(html: string): string[] {
  if (!html) return [];
  const sources: string[] = [];
  const imagePattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(html)) !== null) {
    const source = decodeBasicHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (source) sources.push(source);
  }
  return sources;
}

function isImageOnlyHtml(html: string): boolean {
  const remainingText = html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, '')
    .trim();
  return remainingText === '';
}

function toClipboardImageSource(source: string): ClipboardImageSource[] {
  const dataFile = fileFromDataImageUrl(source);
  if (dataFile) return [{ kind: 'file', file: dataFile }];
  const sourcePath = toLocalImagePath(source);
  return sourcePath ? [{ kind: 'local-path', sourcePath }] : [];
}

function fileFromDataImageUrl(source: string): File | null {
  if (source.length > Math.ceil(MAX_EDITOR_IMAGE_BYTES * 4 / 3) + 256) return null;
  const match = source.match(supportedDataImagePattern);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const extension = match[1].toLowerCase() === 'image/jpeg'
      ? 'jpg'
      : match[1].slice('image/'.length).toLowerCase();
    return new File([bytes], `clipboard.${extension}`, { type: match[1].toLowerCase() });
  } catch {
    return null;
  }
}

function normalizeMarkdownImageDestination(rawDestination: string): string | null {
  const withoutAngles = rawDestination.trim().replace(/^<|>$/g, '');
  const match = withoutAngles.match(/^(.+?\.(?:png|jpe?g|gif|webp))(?:\s+["'][^"']*["'])?$/i);
  return match?.[1]?.trim() ?? null;
}

function toLocalImagePath(source: string): string | null {
  const trimmed = source.trim();
  let localPath: string;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
      localPath = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(localPath)) localPath = localPath.slice(1);
      localPath = localPath.replace(/\//g, '\\');
    } catch {
      return null;
    }
  } else if (/^[a-z]:[\\/]/i.test(trimmed)) {
    localPath = trimmed.replace(/\//g, '\\');
  } else {
    return null;
  }

  return supportedImageExtensionPattern.test(localPath) ? localPath : null;
}

function deduplicateSources(sources: ClipboardImageSource[]): ClipboardImageSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.kind === 'file'
      ? `file:${source.file.name}\u0000${source.file.type}\u0000${source.file.size}\u0000${source.file.lastModified}`
      : `path:${source.sourcePath.toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
