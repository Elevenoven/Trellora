import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDirectory } from '../pathGuards';
/** Physical restore state is outside WK-M schemas and survives application restarts. */
export function isRestorePaused(root: string): boolean { return fs.existsSync(path.join(root, '.menghan-meta', 'restore-paused.json')); }
export function writeRestorePause(root: string, operationId: string): void {
  const file = assertInsideDirectory(path.join(root, '.menghan-meta', 'restore-paused.json'), root);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, operationId, pausedAt: new Date().toISOString() }), 'utf8');
}
export function clearRestorePause(root: string): void { fs.rmSync(assertInsideDirectory(path.join(root, '.menghan-meta', 'restore-paused.json'), root), { force: true }); }
