import path from 'node:path';
import { getFileTypeInfo } from '../fileTypes';
import type { DocumentOpenRequest } from '../../shared/documentSession';

const valueSwitches = new Set(['user-data-dir', 'remote-debugging-port', 'remote-debugging-address', 'inspect', 'inspect-brk', 'lang', 'log-file', 'js-flags', 'app', 'type', 'enable-features', 'disable-features', 'trace-startup-file', 'profile-directory']);
const booleanSwitches = new Set(['no-sandbox', 'disable-gpu', 'disable-dev-shm-usage', 'enable-logging', 'trace-warnings', 'trace-startup']);
/** 开发入口和参数值不作为文档；相对路径始终使用该次启动的工作目录。 */
export function parseDocumentArguments(argv: string[], cwd: string, packaged: boolean, entryPath?: string): string[] {
  const files: string[] = []; let literal = false;
  const entry = !packaged ? path.resolve(cwd, entryPath ?? argv[1] ?? '') : undefined;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index];
    if (!literal && value === '--') { literal = true; continue; }
    if (!literal && value.startsWith('-')) {
      const name = value.replace(/^-+/, '').split('=')[0];
      if (!value.includes('=') && (valueSwitches.has(name) || !booleanSwitches.has(name)) && argv[index + 1] && !argv[index + 1].startsWith('-')) index++;
      continue;
    }
    if (value && !value.includes('\0') && getFileTypeInfo(value)) { const file = path.resolve(cwd, value); if (entry?.toLowerCase() !== file.toLowerCase()) files.push(file); }
  }
  return files;
}

/** 启动请求在服务就绪前保留；所有来源复用会话服务的真实文件和边界校验。 */
export class OpenRequestRouter {
  private waiting: string[] = [];
  private ready = false;
  private task: Promise<void> = Promise.resolve();
  private failures: { displayPath: string; message: string }[] = [];
  constructor(private readonly options: { enqueue: (file: string) => Promise<DocumentOpenRequest>; changed: () => void; entryPath?: string }) {}
  collect(argv: string[], cwd: string, packaged: boolean): void { this.defer(parseDocumentArguments(argv, cwd, packaged, this.options.entryPath)); }
  private defer(files: string[]): void {
    for (const file of files) if (!this.waiting.some(prior => prior.toLowerCase() === file.toLowerCase())) {
      if (this.waiting.length >= 200) { this.failures.push({ displayPath: file, message: '待打开文件过多，请分批打开。' }); break; }
      this.waiting.push(file);
    }
    if (this.ready) void this.flush();
  }
  async submit(files: string[]): Promise<DocumentOpenRequest[]> {
    const requests: DocumentOpenRequest[] = [];
    for (const file of files) requests.push(await this.options.enqueue(file));
    if (requests.length) this.options.changed(); return requests;
  }
  start(): void { this.ready = true; void this.flush(); }
  async flush(): Promise<void> {
    if (!this.ready) return;
    this.task = this.task.then(async () => {
      const files = this.waiting.splice(0); let changed = false;
      for (const file of files) try { await this.options.enqueue(file); changed = true; } catch (error) { this.failures.push({ displayPath: file, message: (error as Error).message }); changed = true; }
      if (changed) this.options.changed();
    });
    return this.task;
  }
  takeFailures(): { displayPath: string; message: string }[] { const failures = this.failures; this.failures = []; return failures; }
  async drop(files: string[]): Promise<void> { this.defer(files); await this.flush(); }
}
