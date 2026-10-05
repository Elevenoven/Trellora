import { parentPort } from 'node:worker_threads';
import { buildNoteIndex, parseNoteContent } from '../noteIndex';

/** CPU-heavy Markdown parsing and cold scans stay outside the Electron event loop. */
parentPort?.on('message', (request) => {
  try {
    const value = request.method === 'scan'
      ? buildNoteIndex(request.path)
      : parseNoteContent(request.path, request.content, request.mtimeMs);
    parentPort?.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
