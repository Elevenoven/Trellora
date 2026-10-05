import fs from 'fs';
import path from 'path';
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import {
  EDITOR_IMAGE_PROTOCOL,
  parseEditorImageUrl,
} from '../shared/editorImageProtocol';
export { toEditorImageUrl } from '../shared/editorImageProtocol';
import { assertInsideDirectory } from './pathGuards';

const supportedEditorImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const editorImageMimeTypes: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface EditorImageDataUrl {
  dataUrl: string;
  byteLength: number;
}

export function registerEditorImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: EDITOR_IMAGE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

export function registerEditorImageProtocol(getCurrentLibraryPath: () => string | null): void {
  protocol.handle(EDITOR_IMAGE_PROTOCOL, async (request) => {
    if (request.method !== 'GET') return textResponse('Method not allowed', 405);

    const libraryPath = getCurrentLibraryPath();
    if (!libraryPath) return textResponse('Not found', 404);

    try {
      const imagePath = resolveEditorImageRequestPath(request.url, libraryPath);
      return await net.fetch(pathToFileURL(imagePath).href);
    } catch {
      return textResponse('Not found', 404);
    }
  });
}

export function resolveEditorImageRequestPath(rawUrl: string, libraryPath: string): string {
  const requestedPath = parseEditorImageUrl(rawUrl);
  if (!requestedPath) throw new Error('图片资源地址无效。');

  const resolvedLibraryPath = path.resolve(libraryPath);
  const resolvedRequestedPath = assertInsideDirectory(
    requestedPath,
    resolvedLibraryPath,
    '图片资源路径超出当前笔记库。',
  );
  if (!supportedEditorImageExtensions.has(path.extname(resolvedRequestedPath).toLowerCase())) {
    throw new Error('不支持该图片资源类型。');
  }

  const realLibraryPath = fs.realpathSync(resolvedLibraryPath);
  const realRequestedPath = fs.realpathSync(resolvedRequestedPath);
  assertInsideDirectory(realRequestedPath, realLibraryPath, '图片资源路径超出当前笔记库。');
  if (!fs.statSync(realRequestedPath).isFile()) throw new Error('图片资源不是文件。');
  return realRequestedPath;
}

export function readEditorImageDataUrl(
  rawUrl: string,
  libraryPath: string,
  maxBytes: number,
): EditorImageDataUrl {
  const imagePath = resolveEditorImageRequestPath(rawUrl, libraryPath);
  const stat = fs.statSync(imagePath);
  if (stat.size > maxBytes) throw new Error('单张导出图片不能超过 10 MB。请压缩图片后重试。');

  const extension = path.extname(imagePath).toLowerCase();
  const mimeType = editorImageMimeTypes[extension];
  if (!mimeType) throw new Error('不支持该图片资源类型。');
  const buffer = fs.readFileSync(imagePath);
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    byteLength: buffer.byteLength,
  };
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
