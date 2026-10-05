import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { assertInsideDirectory } from './pathGuards';
import { MemoryScopeResolver } from './knowledge/memory/memoryScope';
import { QA_MEMORY_SCHEMA_VERSION } from './knowledge/qaMemoryDatabase';
import { assertRestoredDatabase, migrateMetadataFile, migratePhysicalDatabase, type PhysicalRestoreContext } from './backup/physicalRestore';
import { loadSqliteVec } from './loadSqliteVec';
import type { MemoryScope } from './knowledge/memory/memoryTypes';

interface Input {
  directory: string;
  files: Array<{ relativePath: string; database: boolean }>;
  sourceScope: MemoryScope;
  targetPath: string;
  principalId: string;
  roots: PhysicalRestoreContext['roots'];
  libraries: PhysicalRestoreContext['libraries'];
}

/** Only the main process creates this worker. It maps staged copies and owns no userData, UI or live database handles. */
async function run(input: Input): Promise<void> {
  const target = new MemoryScopeResolver({ getActiveWorkspacePath: () => input.targetPath, listRegisteredWorkspacePaths: () => [input.targetPath], getPrincipalId: () => input.principalId }).resolveActive();
  const context: PhysicalRestoreContext = { sourceScope: input.sourceScope, target, roots: input.roots, libraries: input.libraries, warnings: new Set() };
  const signal = new AbortController().signal;
  for (const [index, file] of input.files.entries()) {
    const destination = assertInsideDirectory(path.join(input.directory, ...file.relativePath.split('/')), input.directory);
    parentPort?.postMessage({ completed: index, currentFile: file.relativePath });
    if (file.database) {
      const database = new Database(destination);
      try {
        const version = Number(database.pragma('user_version', { simple: true }));
        if ((file.relativePath.endsWith('/qa-memory.db') && version > QA_MEMORY_SCHEMA_VERSION) || (file.relativePath.endsWith('/assistant-memory.db') && version > 7) || (file.relativePath.endsWith('/conversation-memory.db') && version > 1)) throw new Error('数据库来自较新版本，请升级应用后再迁移。');
        if (file.relativePath.endsWith('/index.db')) {
          const metadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_meta'").get();
          const schema = metadata ? database.prepare("SELECT value FROM system_meta WHERE key='schema_version'").get() as { value?: string } | undefined : undefined;
          if (Number(schema?.value ?? 0) > 6) throw new Error('数据库来自较新版本，请升级应用后再迁移。');
          loadSqliteVec(database);
        }
        migratePhysicalDatabase(database, context); assertRestoredDatabase(database); database.pragma('wal_checkpoint(TRUNCATE)');
      } finally { database.close(); }
    } else if (/(?:^|\/)\.menghan-meta\//u.test(file.relativePath) && /\.jsonl?$/u.test(file.relativePath)) {
      // A terminated worker can leave the helper's unfinished JSONL output; source name collisions are rejected before copying.
      if (file.relativePath.endsWith('.jsonl')) await fs.promises.rm(`${destination}.restore-partial`, { force: true });
      await migrateMetadataFile(destination, context, signal);
    } else continue;
    const handle = await fs.promises.open(destination, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  }
  parentPort?.postMessage({ completed: input.files.length });
}

void run(workerData as Input).catch(error => { parentPort?.postMessage({ error: error instanceof Error ? error.message : '迁移处理线程失败。' }); process.exitCode = 1; });
