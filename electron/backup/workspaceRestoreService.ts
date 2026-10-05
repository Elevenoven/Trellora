import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BackupFile, BackupManifest, RestorePreview, RestoreStatus } from '../../shared/workspaceBackup';
import type { TrustedMemoryScopeContext } from '../knowledge/memory/memoryTypes';
import { assertInsideDirectory } from '../pathGuards';
import { assertSeparateBackupTarget, hashFile, safeBackupSettings } from './snapshot';
import { readBackupManifest, validateManifest, verifyBackupArchive } from './archive';
import { assertRestoredDatabase, migrateMetadataFile, migratePhysicalDatabase, type PhysicalRestoreContext } from './physicalRestore';
import { writeRestorePause } from './restorePause';
import { renameWithWindowsRetryAsync } from '../fileSystemRename';
import { loadSqliteVec } from '../loadSqliteVec';
import { QA_MEMORY_SCHEMA_VERSION } from '../knowledge/qaMemoryDatabase';

type Phase = 'preview' | 'extracting' | 'migrating' | 'validated' | 'published' | 'registered' | 'completed' | 'failed';
interface Journal { version: 1; id: string; archive: string; parent: string; manifest: BackupManifest; phase: Phase; warnings: string[]; stagedFiles?: BackupFile[]; settings?: Record<string, unknown>; importPreferences?: boolean; error?: string }
/** Publication and registration are separate durable commits; recovery never merges into an existing root. */
export class WorkspaceRestoreService {
  private readonly operations = new Map<string, Journal>();
  private controller?: AbortController;
  private running?: Promise<RestoreStatus>;
  constructor(private readonly options: {
    userDataPath: string; version: string; protectedRoots: () => string[];
    resolveTarget: (finalWorkspace: string) => TrustedMemoryScopeContext;
    register: (preview: RestorePreview, workspacePath: string, preferences?: Record<string, unknown>) => Promise<void>;
    acquireRoots: (roots: string[]) => void;
    onStatus: (status: RestoreStatus) => void;
  }) { this.loadJournals(); }
  get busy(): boolean { return Boolean(this.running); }
  private paths(journal: Journal) {
    const parent = path.resolve(journal.parent);
    return { stage: assertInsideDirectory(path.join(parent, `.trellora-restore-${journal.id}`), parent), final: assertInsideDirectory(path.join(parent, `Trellora-restored-${journal.id}`), parent) };
  }
  private journalPath(id: string): string { if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('恢复操作标识无效。'); return assertInsideDirectory(path.join(this.options.userDataPath, 'restore-operations', `${id}.json`), this.options.userDataPath); }
  private save(journal: Journal): void {
    const file = this.journalPath(journal.id); fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.partial`; const handle = fs.openSync(temporary, 'w'); try { fs.writeFileSync(handle, JSON.stringify(journal), 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file); this.operations.set(journal.id, journal);
  }
  private loadJournals(): void {
    const directory = path.join(this.options.userDataPath, 'restore-operations'); if (!fs.existsSync(directory)) return;
    for (const file of fs.readdirSync(directory).filter(file => /^[a-f0-9-]{36}\.json$/u.test(file))) {
      try {
        const target = assertInsideDirectory(path.join(directory, file), this.options.userDataPath); if (fs.statSync(target).size > 40 * 1024 ** 2) continue;
        const value = JSON.parse(fs.readFileSync(target, 'utf8')) as Journal;
        if (value.version !== 1 || `${value.id}.json` !== file || !path.isAbsolute(value.parent) || !path.isAbsolute(value.archive) || !['preview', 'extracting', 'migrating', 'validated', 'published', 'registered', 'completed', 'failed'].includes(value.phase)) continue;
        validateManifest(value.manifest); this.paths(value); this.operations.set(value.id, value);
      } catch { /* An invalid local journal grants no filesystem permission. */ }
    }
  }
  private previewOf(journal: Journal): RestorePreview {
    const { final } = this.paths(journal);
    return { operationId: journal.id, manifest: journal.manifest, targetDirectory: final, targets: journal.manifest.roots.map(root => ({ rootId: root.id, sourcePath: root.sourcePath, targetPath: path.join(final, 'roots', root.id) })), warnings: journal.warnings };
  }
  private generatedFiles(journal: Journal): Array<Pick<BackupFile, 'rootId' | 'relativePath'>> {
    const workspace = journal.manifest.roots.find(root => root.kind === 'workspace')!;
    const files = [
      { rootId: workspace.id, relativePath: [workspace.workspaceRelativePath, '.menghan-meta', 'restored-connections.json'].filter(Boolean).join('/') },
      { rootId: workspace.id, relativePath: [workspace.workspaceRelativePath, '.menghan-meta', 'restore-paused.json'].filter(Boolean).join('/') },
      ...journal.manifest.registrations.map(item => ({ rootId: item.rootId, relativePath: [item.relativePath, '.menghan-meta', 'restore-paused.json'].filter(Boolean).join('/') })),
    ];
    return [...new Map(files.map(file => [`${file.rootId}/${file.relativePath}`, file])).values()];
  }
  private validateStagedFiles(journal: Journal): void {
    const key = (file: Pick<BackupFile, 'rootId' | 'relativePath'>) => `${file.rootId}/${file.relativePath}`;
    const original = new Set(journal.manifest.files.map(key));
    const expected = new Set([...original, ...this.generatedFiles(journal).map(key)]);
    const files = journal.stagedFiles ?? [];
    if (files.length !== expected.size || new Set(files.map(key)).size !== expected.size || files.some(file => !expected.has(key(file)))) throw new Error('恢复暂存文件清单不完整。');
    // Generated pause markers and safe hints are included without raising the public archive limit.
    validateManifest({ ...journal.manifest, files: files.filter(file => original.has(key(file))) });
    validateManifest({ ...journal.manifest, files: files.filter(file => !original.has(key(file))) });
  }
  pending(): RestorePreview[] { return [...this.operations.values()].filter(item => !['completed', 'preview'].includes(item.phase)).map(item => this.previewOf(item)); }
  async preview(archive: string, parent: string): Promise<RestorePreview> {
    if (this.busy) throw new Error('请先等待当前恢复任务结束。');
    const selectedParent = assertSeparateBackupTarget(parent, this.options.protectedRoots());
    if (!fs.statSync(selectedParent).isDirectory()) throw new Error('请选择现有且可写的恢复父目录。');
    const manifest = await readBackupManifest(archive, AbortSignal.timeout(30_000));
    const major = (version: string) => Number(/^v?(\d+)\./u.exec(version)?.[1]);
    if (!Number.isFinite(major(manifest.appVersion)) || major(manifest.appVersion) > major(this.options.version)) throw new Error('备份来自较新的主版本，请升级应用后恢复。');
    const journal: Journal = { version: 1, id: randomUUID(), archive: path.resolve(archive), parent: selectedParent, manifest, phase: 'preview', warnings: [...manifest.omitted, '远程处理任务保持暂停，密钥与远程授权需要重新设置。'] };
    this.save(journal); return this.previewOf(journal);
  }
  start(id: string, importPreferences = false): Promise<RestoreStatus> {
    if (this.busy) return Promise.reject(new Error('已有恢复任务正在执行。'));
    const journal = this.operations.get(id); if (!journal) return Promise.reject(new Error('恢复预览已经失效，请重新选择备份。'));
    const controller = new AbortController(); this.controller = controller;
    journal.importPreferences = importPreferences === true;
    const task = this.execute(journal, controller.signal).finally(() => { this.running = undefined; this.controller = undefined; }); this.running = task; return task;
  }
  cancel(): void { this.controller?.abort(); }
  async shutdown(): Promise<void> { this.cancel(); await this.running?.catch(() => undefined); }
  private async execute(journal: Journal, signal: AbortSignal): Promise<RestoreStatus> {
    const preview = this.previewOf(journal), { stage, final } = this.paths(journal);
    const workspaceRoot = journal.manifest.roots.find(root => root.kind === 'workspace')!;
    const workspacePath = path.join(final, 'roots', workspaceRoot.id, ...(workspaceRoot.workspaceRelativePath?.split('/') ?? []));
    const publish = (phase: RestoreStatus['phase'], message: string, completed = 0) => { const status: RestoreStatus = { operationId: journal.id, phase, message, completed, total: journal.manifest.files.length, workspacePath, targetDirectory: final, warnings: journal.warnings }; this.options.onStatus(status); return status; };
    try {
      const publishedRoots = ['published', 'registered', 'completed'].includes(journal.phase);
      assertSeparateBackupTarget(journal.parent, this.options.protectedRoots().filter(root => !publishedRoots || (() => { const relative = path.relative(final, root); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); })()));
      this.options.acquireRoots([journal.parent]);
      signal.throwIfAborted();
      if (journal.phase === 'validated' && fs.existsSync(stage) && !fs.existsSync(final) && journal.stagedFiles) {
        this.validateStagedFiles(journal);
        const receipt = JSON.parse(fs.readFileSync(assertInsideDirectory(path.join(stage, '.restore-operation.json'), journal.parent), 'utf8'));
        if (receipt.operationId !== journal.id || receipt.validated !== true) throw new Error('恢复暂存目录的校验回执无效。');
        for (const file of journal.stagedFiles) {
          const target = assertInsideDirectory(path.join(stage, 'roots', file.rootId, ...file.relativePath.split('/')), stage);
          if (fs.statSync(target).size !== file.size || await hashFile(target, signal) !== file.sha256) throw new Error('恢复暂存数据已经改变，请重新选择备份恢复。');
        }
        await renameWithWindowsRetryAsync(stage, final, () => { signal.throwIfAborted(); if (fs.existsSync(final)) throw new Error('目标恢复目录已存在，未覆盖。'); }, { attempts: 21, delayMs: 250 }); journal.phase = 'published'; this.save(journal);
      }
      if (!['published', 'registered', 'completed'].includes(journal.phase)) {
        if (fs.existsSync(final)) {
          // Rename may have committed immediately before the journal write was interrupted.
          const marker = path.join(final, '.restore-operation.json');
          const receipt = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : undefined;
          if (receipt?.operationId !== journal.id || receipt?.validated !== true) throw new Error('目标恢复目录已存在，未覆盖。');
          journal.phase = 'published'; this.save(journal);
        } else {
          if (fs.existsSync(stage)) {
            const marker = path.join(stage, '.restore-operation.json');
            if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).operationId !== journal.id) throw new Error('恢复暂存目录归属不明，未清理。');
            await fs.promises.rm(assertInsideDirectory(stage, journal.parent), { recursive: true, force: true });
          }
          fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, '.restore-operation.json'), JSON.stringify({ operationId: journal.id }), { flag: 'wx' });
          journal.phase = 'extracting'; this.save(journal); publish('validating', '正在核对并展开备份到独立暂存目录。');
          journal.settings = await verifyBackupArchive(journal.archive, journal.manifest, signal, stage, completed => publish('validating', '正在核对备份文件。', completed));
          const warnings = new Set(journal.warnings); const roots = preview.targets.map(root => ({ source: root.sourcePath, target: root.targetPath }));
          const libraries = journal.manifest.registrations.map(registration => ({ source: registration.sourcePath ?? path.join(journal.manifest.roots.find(root => root.id === registration.rootId)!.sourcePath, ...registration.relativePath.split('/').filter(Boolean)), target: path.join(final, 'roots', registration.rootId, ...registration.relativePath.split('/').filter(Boolean)) }));
          roots.push(...libraries); if (journal.manifest.sourceWorkspacePath) roots.push({ source: journal.manifest.sourceWorkspacePath, target: workspacePath });
          const context: PhysicalRestoreContext = { sourceScope: journal.manifest.sourceScope, target: this.options.resolveTarget(workspacePath), roots, libraries, warnings };
          journal.phase = 'migrating'; this.save(journal); publish('restoring', '正在迁移路径与本机记忆身份，保留原文、历史关系和删除状态。');
          for (const file of journal.manifest.files) {
            signal.throwIfAborted(); const relative = file.relativePath;
            const target = assertInsideDirectory(path.join(stage, 'roots', file.rootId, ...relative.split('/')), stage);
            if (/(?:^|\/)\.menghan-meta\/(?:index|assistant-memory)\.db$|(?:^|\/)ConversationMemory\/(?:qa-memory|conversation-memory)\.db$/u.test(relative)) {
              const database = new Database(target);
              try {
                const version = Number(database.pragma('user_version', { simple: true }));
                if ((relative.endsWith('/qa-memory.db') && version > QA_MEMORY_SCHEMA_VERSION) || (relative.endsWith('/assistant-memory.db') && version > 7) || (relative.endsWith('/conversation-memory.db') && version > 1)) throw new Error('数据库来自较新版本，请升级应用后恢复。');
                if (relative.endsWith('/index.db')) {
                  const metadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_meta'").get();
                  const schema = metadata ? database.prepare("SELECT value FROM system_meta WHERE key='schema_version'").get() as { value?: string } | undefined : undefined;
                  if (schema?.value && Number(schema.value) > 6) throw new Error('数据库来自较新版本，请升级应用后恢复。');
                  loadSqliteVec(database);
                }
                migratePhysicalDatabase(database, context); assertRestoredDatabase(database); database.pragma('wal_checkpoint(TRUNCATE)');
              } finally { database.close(); }
            } else if (/(?:^|\/)\.menghan-meta\//u.test(relative) && /\.jsonl?$/u.test(relative)) {
              if (relative.endsWith('/cloud-authorization.json')) fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, documents: {} }));
              else await migrateMetadataFile(target, context, signal);
            }
          }
          for (const registration of journal.manifest.registrations) {
            const directory = assertInsideDirectory(path.join(stage, 'roots', registration.rootId, ...registration.relativePath.split('/').filter(Boolean)), stage);
            if (!fs.statSync(directory).isDirectory()) throw new Error('备份登记的库目录无效，未发布恢复结果。');
          }
          const raw = journal.settings ?? {}; const parsing = raw.parsing as { mineruEndpoint?: unknown } | undefined;
          const safe = safeBackupSettings(raw.preferences && typeof raw.preferences === 'object' ? raw.preferences as Record<string, unknown> : {}, raw.aiModelSettings, { mineruEndpoint: typeof parsing?.mineruEndpoint === 'string' ? parsing.mineruEndpoint : '' }, raw.modelHub);
          const hints = assertInsideDirectory(path.join(stage, path.relative(final, workspacePath), '.menghan-meta', 'restored-connections.json'), stage); fs.mkdirSync(path.dirname(hints), { recursive: true }); fs.writeFileSync(hints, JSON.stringify({ modelHub: safe.modelHub, aiModelSettings: safe.aiModelSettings, parsing: safe.parsing, credentialsRequired: true }));
          for (const root of [workspacePath, ...libraries.map(item => item.target)]) writeRestorePause(path.join(stage, path.relative(final, root)), journal.id);
          journal.stagedFiles = [];
          const stagedFiles = new Map([...journal.manifest.files, ...this.generatedFiles(journal)].map(file => [`${file.rootId}/${file.relativePath}`, file]));
          for (const file of stagedFiles.values()) { const target = assertInsideDirectory(path.join(stage, 'roots', file.rootId, ...file.relativePath.split('/')), stage); journal.stagedFiles.push({ ...file, size: fs.statSync(target).size, sha256: await hashFile(target, signal) }); }
          this.validateStagedFiles(journal);
          fs.writeFileSync(path.join(stage, '.restore-operation.json'), JSON.stringify({ operationId: journal.id, validated: true }));
          journal.warnings = [...warnings]; journal.phase = 'validated'; this.save(journal); signal.throwIfAborted();
          if (fs.existsSync(final)) throw new Error('目标恢复目录已存在，未覆盖。');
          await renameWithWindowsRetryAsync(stage, final, () => { signal.throwIfAborted(); if (fs.existsSync(final)) throw new Error('目标恢复目录已存在，未覆盖。'); assertInsideDirectory(stage, journal.parent); assertInsideDirectory(final, journal.parent); }, { attempts: 21, delayMs: 250 }); journal.phase = 'published'; this.save(journal);
        }
      }
      if (!fs.existsSync(final)) throw new Error('已发布的恢复目录缺失，请检查磁盘后重试。');
      // Registration is idempotent. A crash after publication leaves files and an explicit resumable journal.
      await this.options.register(this.previewOf(journal), workspacePath, journal.importPreferences ? journal.settings : undefined);
      journal.phase = 'registered'; this.save(journal); journal.phase = 'completed'; delete journal.error; this.save(journal);
      return publish('completed', '恢复完成。已登记新库；原工作区保留。远程任务仍暂停。', journal.manifest.files.length);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      journal.error = signal.aborted ? '恢复已取消，现有工作区未改变。' : code === 'ENOSPC' ? '磁盘空间不足，请清理空间后重试。' : ['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ? '恢复目录无法发布或写入，请关闭占用程序并检查权限后继续恢复。暂存结果与现有数据已保留。' : error instanceof Error ? error.message : '恢复失败，请检查备份与目录权限。';
      if (signal.aborted && !fs.existsSync(final) && fs.existsSync(stage)) {
        try {
          const marker = assertInsideDirectory(path.join(stage, '.restore-operation.json'), journal.parent);
          if (fs.statSync(marker).size > 1024 || JSON.parse(fs.readFileSync(marker, 'utf8')).operationId !== journal.id) throw new Error('恢复暂存目录归属不明，未清理。');
          await fs.promises.rm(assertInsideDirectory(stage, journal.parent), { recursive: true, force: true });
          delete journal.stagedFiles; journal.phase = 'failed';
        } catch { journal.warnings.push('取消后暂存目录未能清理，将在继续恢复时重新检查。'); }
      }
      // Keep published state so registration recovery never republishes or deletes user files.
      if (!['validated', 'published', 'registered', 'completed'].includes(journal.phase)) journal.phase = 'failed';
      this.save(journal); return publish('failed', journal.error);
    }
  }
}
