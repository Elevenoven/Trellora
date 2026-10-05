export interface ExportImage { dataUrl: string; byteLength: number }
type ImageFetch = (url: string, options: RequestInit) => Promise<Response>;
const imageTimeoutMs = 20_000;

/** Fetch only HTTP(S) image bytes, with bounded redirects, time and streamed size. */
export async function readRemoteExportImage(source: string, maxBytes: number, fetchImage: ImageFetch): Promise<ExportImage> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const validateUrl = (value: string): string => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('导出图片仅支持不含凭据的 HTTP/HTTPS 地址。');
    return url.href;
  };
  try {
    const operation = async (): Promise<ExportImage> => {
      let url = validateUrl(source);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await fetchImage(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('网络图片重定向次数过多或缺少目标地址。');
        url = validateUrl(new URL(location, url).href);
      }
      if (!response?.ok) throw new Error(`网络图片请求失败（HTTP ${response?.status ?? 0}）。`);
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) throw new Error('单张导出图片超过 10 MB 上限。');
      if (!response.body) throw new Error('网络图片响应为空。');
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        byteLength += next.value.byteLength;
        if (byteLength > maxBytes) throw new Error('单张导出图片超过 10 MB 上限。');
        chunks.push(Buffer.from(next.value));
      }
      const bytes = Buffer.concat(chunks);
      const mime = imageMime(bytes);
      if (!mime) throw new Error('网络图片不是支持的 PNG、JPEG、GIF 或 WebP 文件。');
      const declaredMime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (declaredMime?.startsWith('image/') && declaredMime !== mime) throw new Error('网络图片类型与实际内容不一致。');
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, byteLength };
    };
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('网络图片下载超时，请检查网络后重试。')); }, imageTimeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

/** MIME is derived from bytes, so error pages and SVG scripts cannot become inline images. */
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
}
