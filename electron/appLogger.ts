import fs from 'node:fs';
import path from 'node:path';

export interface SafeLogEntry { at: string; level: 'info' | 'warn' | 'error'; module: string; code: string; taskId?: string; }

/** Persist only allowlisted identifiers; provider messages, prompts and bodies never enter this log. */
export class AppLogger {
  private entries: SafeLogEntry[] = [];
  private writing = false;
  degraded = false;
  constructor(private readonly directory: () => string, private readonly maxBytes = 5 * 1024 * 1024, private readonly files = 5) {}

  record(level: SafeLogEntry['level'], module: string, code: string, taskId?: string): void {
    const identifier = (value: string) => /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : 'UNKNOWN';
    const entry: SafeLogEntry = { at: new Date().toISOString(), level, module: identifier(module), code: identifier(code), ...(taskId ? { taskId: identifier(taskId) } : {}) };
    this.entries.push(entry);
    this.entries = this.entries.slice(-100);
    if (this.writing) return;
    this.writing = true;
    try {
      const directory = this.directory();
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'application.ndjson');
      const line = `${JSON.stringify(entry)}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.maxBytes) {
        for (let index = this.files - 1; index >= 1; index--) {
          const from = index === 1 ? file : `${file}.${index - 1}`;
          const to = `${file}.${index}`;
          if (fs.existsSync(to)) fs.unlinkSync(to);
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
      }
      fs.appendFileSync(file, line, 'utf8');
      this.degraded = false;
    } catch { this.degraded = true; }
    finally { this.writing = false; }
  }

  /** Include persisted safe errors after a cold restart, without copying detailed assistant traces. */
  recent(): SafeLogEntry[] {
    try {
      const file = path.join(this.directory(), 'application.ndjson');
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      return lines.slice(-100).flatMap(line => {
        try {
          const entry = JSON.parse(line) as SafeLogEntry;
          if (!['info', 'warn', 'error'].includes(entry.level) || !/^[a-zA-Z0-9:_-]{1,128}$/.test(entry.code)) return [];
          return [{ at: String(entry.at).slice(0, 30), level: entry.level, module: /^[a-zA-Z0-9:_-]{1,128}$/.test(entry.module) ? entry.module : 'UNKNOWN', code: entry.code }];
        } catch { return []; }
      });
    } catch { return [...this.entries]; }
  }
}

/** Diagnostics retain the service location but strip credentials, query parameters and fragments. */
export function safeServiceEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return undefined; }
}
