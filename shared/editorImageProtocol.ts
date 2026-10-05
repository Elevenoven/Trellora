export const EDITOR_IMAGE_PROTOCOL = 'menghan-image';

const editorImageProtocolHost = 'local';

export function toEditorImageUrl(absolutePath: string): string {
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  return `${EDITOR_IMAGE_PROTOCOL}://${editorImageProtocolHost}/${encodeURIComponent(normalizedPath)}`;
}

export function parseEditorImageUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${EDITOR_IMAGE_PROTOCOL}:`
      || url.hostname !== editorImageProtocolHost
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) return null;

    const encodedPath = url.pathname.replace(/^\/+/, '');
    if (!encodedPath) return null;

    const decodedPath = decodeURIComponent(encodedPath);
    if (decodedPath.includes('\0')) return null;
    if (!/^(?:[a-z]:\/|\/)/i.test(decodedPath)) return null;
    return decodedPath;
  } catch {
    return null;
  }
}
