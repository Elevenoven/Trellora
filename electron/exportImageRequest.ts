import { net } from 'electron';

/** Electron 31 cancels fetch manual redirects; expose net.request redirects for validation. */
export function requestExportImage(url: string, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    let delivered = false, closed = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fail = (error: Error) => {
      options.signal?.removeEventListener('abort', abort);
      if (!delivered) reject(error);
      if (streamController && !closed) { closed = true; streamController.error(error); }
    };
    const abort = () => { fail(new Error('网络图片请求已取消。')); request.abort(); };
    request.on('error', fail);
    request.once('abort', () => fail(new Error('网络图片请求已取消。')));
    request.once('redirect', (status, _method, redirectUrl) => {
      delivered = true;
      options.signal?.removeEventListener('abort', abort);
      resolve(new Response(null, { status, headers: { location: redirectUrl } }));
      request.abort();
    });
    request.once('response', response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          response.on('data', (bytes: Buffer) => { if (!closed) controller.enqueue(new Uint8Array(bytes)); });
          response.once('end', () => { options.signal?.removeEventListener('abort', abort); if (!closed) { closed = true; controller.close(); } });
          response.once('error', fail);
          response.once('aborted', () => fail(new Error('网络图片响应被中断。')));
        },
        cancel() { options.signal?.removeEventListener('abort', abort); closed = true; request.abort(); },
      });
      delivered = true;
      if ([204, 205, 304].includes(response.statusCode)) { void body.cancel(); resolve(new Response(null, { status: response.statusCode, headers })); }
      else resolve(new Response(body, { status: response.statusCode, headers }));
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort(); else request.end();
  });
}
