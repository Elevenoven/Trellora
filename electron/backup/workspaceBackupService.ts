import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupConfiguration, BackupManifest, BackupSource, BackupStatus } from '../../shared/workspaceBackup';
import { assertInsideDirectory } from '../pathGuards';
import { assertSeparateBackupTarget, captureSnapshot, packSnapshot, planBackupRoots } from './snapshot';
import { readBackupManifest } from './archive';

export interface BackupServiceContext {
  workspacePath: string;
  sourceScope: BackupManifest['sourceScope'];
  sources: Array<BackupSource & { icon?: string; origin?: 'created' | 'upgraded' }>;
  settings: Record<string, unknown>;
}
interface SettingsStore { get(key: string): unknown; set(key: string, value: unknown): void }
const day = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const defaults: BackupConfiguration = { enabled: false, targetDirectory: '', externalLibraries: [] };

/** One snapshot at a time; successful automatic archives alone participate in retention. */
export class WorkspaceBackupService {
  private controller?: AbortController;
  private running?: Promise<BackupStatus>;
  private state: Omit<BackupStatus, 'configuration' | 'workspacePath' | 'sources'> = { phase: 'idle', message: '', completed: 0, total: 0 };
  constructor(private readonly options: { store: SettingsStore; userDataPath: string; version: string; context: () => BackupServiceContext; capture: <T>(signal: AbortSignal, action: () => Promise<T>) => Promise<T>; acquireRoots: (roots: string[]) => void; onStatus: (status: BackupStatus) => void; onError: (code: string) => void }) {}
  get busy(): boolean { return Boolean(this.running); }
  configuration(): BackupConfiguration {
    const raw = this.options.store.get('desktopBackup') as Partial<BackupConfiguration> | undefined;
    return { ...defaults, enabled: raw?.enabled === true, targetDirectory: typeof raw?.targetDirectory === 'string' ? raw.targetDirectory : '', externalLibraries: Array.isArray(raw?.externalLibraries) ? raw.externalLibraries.filter(value => typeof value === 'string') : [], ...(typeof raw?.lastSuccessfulAt === 'string' ? { lastSuccessfulAt: raw.lastSuccessfulAt } : {}), ...(typeof raw?.lastSuccessfulPath === 'string' ? { lastSuccessfulPath: raw.lastSuccessfulPath } : {}), ...(typeof raw?.lastDailyDate === 'string' ? { lastDailyDate: raw.lastDailyDate } : {}), ...(typeof raw?.lastError === 'string' ? { lastError: raw.lastError } : {}) };
  }
  status(): BackupStatus { const context = this.options.context(); return { ...this.state, configuration: this.configuration(), workspacePath: context.workspacePath, sources: context.sources }; }
  private publish(patch: Partial<typeof this.state>): void { this.state = { ...this.state, ...patch }; this.options.onStatus(this.status()); }
  configure(patch: Pick<BackupConfiguration, 'enabled' | 'targetDirectory' | 'externalLibraries'>): BackupStatus {
    if (this.busy) throw new Error('请等待当前备份任务结束后再修改快照设置。');
    if (!patch || typeof patch.enabled !== 'boolean' || typeof patch.targetDirectory !== 'string' || !Array.isArray(patch.externalLibraries) || patch.externalLibraries.some(value => typeof value !== 'string')) throw new Error('快照配置无效。');
    const context = this.options.context();
    const selected = this.selectSources(context, patch.externalLibraries);
    const targetDirectory = patch.targetDirectory ? assertSeparateBackupTarget(patch.targetDirectory, [context.workspacePath, ...selected.map(source => source.path)]) : '';
    if (patch.enabled && !targetDirectory) throw new Error('请先选择独立的备份目标目录。');
    this.options.store.set('desktopBackup', { ...this.configuration(), ...patch, targetDirectory }); return this.status();
  }
  private selectSources(context: BackupServiceContext, selected: string[]): BackupServiceContext['sources'] {
    if (selected.some(file => !context.sources.some(source => path.resolve(source.path) === path.resolve(file)))) throw new Error('备份只能选择已经注册的笔记库或资料库。');
    const sources = context.sources.filter(source => source.internal ? source.exists : selected.some(file => path.resolve(file) === path.resolve(source.path)));
    if (sources.some(source => !source.exists)) throw new Error('选中的库已经不存在，请在备份范围中明确取消该库后重试。'); return sources;
  }
  start(request?: { targetDirectory?: string; externalLibraries?: string[] }, kind: 'manual' | 'daily' = 'manual'): Promise<BackupStatus> {
    if (this.running) return Promise.reject(new Error('已有备份任务正在执行。'));
    const controller = new AbortController(); this.controller = controller;
    const task = this.execute(controller.signal, request, kind).finally(() => { if (this.running === task) { this.running = undefined; this.controller = undefined; } });
    this.running = task; return task;
  }
  cancel(): void { this.controller?.abort(); }
  async shutdown(): Promise<void> { this.cancel(); await this.running?.catch(() => undefined); }
  private async execute(signal: AbortSignal, request: { targetDirectory?: string; externalLibraries?: string[] } | undefined, kind: 'manual' | 'daily'): Promise<BackupStatus> {
    const operationId = randomUUID(); const directory = assertInsideDirectory(path.join(this.options.userDataPath, 'backup-staging', operationId), this.options.userDataPath);
    try {
      const context = this.options.context(); const config = this.configuration();
      const selected = this.selectSources(context, request?.externalLibraries ?? config.externalLibraries);
      const plan = planBackupRoots(context.workspacePath, selected);
      const sourceRoots = plan.roots.map(root => root.sourcePath);
      const target = assertSeparateBackupTarget(request?.targetDirectory ?? config.targetDirectory, sourceRoots);
      if (!(request?.targetDirectory ?? config.targetDirectory)) throw new Error('请先选择独立的备份目标目录。');
      assertSeparateBackupTarget(directory, sourceRoots); this.options.acquireRoots(sourceRoots);
      await fs.promises.mkdir(directory, { recursive: true }); await fs.promises.mkdir(target, { recursive: true });
      const createdAt = new Date().toISOString(); const outputPath = path.join(target, `Trellora-${kind}-${day()}-${operationId}.zip`);
      this.publish({ operationId, phase: 'preparing', message: '正在保存草稿并等待在途写入结束。', completed: 0, total: 0, outputPath: undefined });
      const manifest = await this.options.capture(signal, async () => {
        this.publish({ phase: 'capturing', message: '正在捕获原文件与数据库一致性副本。' });
        return captureSnapshot({ directory, signal, manifest: { schemaVersion: 1, appVersion: this.options.version, createdAt, backupId: operationId, kind, ...plan, sourceScope: context.sourceScope, sourceWorkspacePath: context.workspacePath }, onProgress: (completed, total) => this.publish({ completed, total }) });
      });
      manifest.omitted.push(...context.sources.filter(source => !selected.includes(source)).map(source => `${source.exists ? '未选择的外部库' : '缺失库'}：${source.alias}`));
      this.publish({ phase: 'packing', message: '正在压缩并核对备份内容，可以继续编辑。', completed: 0, total: manifest.files.length });
      await packSnapshot({ directory, target: outputPath, manifest, settings: context.settings, signal, onProgress: (completed, total) => this.publish({ phase: 'validating', completed, total }) });
      try {
        this.options.store.set('desktopBackup', { ...this.configuration(), lastSuccessfulAt: new Date().toISOString(), lastSuccessfulPath: outputPath, lastError: undefined, ...(kind === 'daily' ? { lastDailyDate: day() } : {}) });
        if (kind === 'daily') await this.retainDaily(outputPath, operationId);
      } catch { this.options.onError('BACKUP_RECEIPT_PERSIST_FAILED'); }
      this.publish({ phase: 'completed', message: '备份已完成。完整备份包含笔记、附件与会话原文；请妥善保管。', outputPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = signal.aborted ? '备份已取消，已有成功备份未改变。' : code === 'ENOSPC' ? '磁盘空间不足，请清理目标或临时目录空间后重试。' : error instanceof Error && (!code || code.startsWith('BACKUP_')) ? error.message : '备份文件无法读取或写入，请检查目录权限和磁盘空间后重试。';
      this.options.onError(signal.aborted ? 'BACKUP_CANCELLED' : code ?? 'BACKUP_FAILED');
      this.options.store.set('desktopBackup', { ...this.configuration(), lastError: message });
      this.publish({ operationId, phase: 'failed', message, outputPath: undefined });
    } finally { if (fs.existsSync(directory)) await fs.promises.rm(assertInsideDirectory(directory, this.options.userDataPath), { recursive: true, force: true }); }
    return this.status();
  }
  async runDaily(): Promise<void> {
    const config = this.configuration(); if (!config.enabled || this.busy || config.lastDailyDate === day()) return;
    const record = this.options.store.get('desktopBackupAttempts') as { day?: string; count?: number; nextAt?: number } | undefined;
    const count = record?.day === day() ? Number(record.count ?? 0) : 0;
    if (count >= 3 || (record?.day === day() && Number(record.nextAt) > Date.now())) return;
    this.options.store.set('desktopBackupAttempts', { day: day(), count: count + 1, nextAt: Date.now() + [5, 15, 60][count] * 60_000 });
    await this.start(undefined, 'daily');
  }
  private async retainDaily(file: string, backupId: string): Promise<void> {
    const stored = this.options.store.get('desktopSnapshotHistory');
    const records = (Array.isArray(stored) ? stored : []).filter((record): record is { file: string; backupId: string } => record && typeof record.file === 'string' && typeof record.backupId === 'string');
    records.push({ file, backupId }); const remaining = records.slice(-7);
    this.options.store.set('desktopSnapshotHistory', records);
    for (const record of records.slice(0, -7)) {
      try {
        const expected = `Trellora-daily-`;
        if (!path.basename(record.file).startsWith(expected) || !path.basename(record.file).endsWith(`-${record.backupId}.zip`) || !/^[a-f0-9-]{36}$/u.test(record.backupId)) continue;
        const manifest = await readBackupManifest(record.file, AbortSignal.timeout(10_000));
        if (manifest.kind === 'daily' && manifest.backupId === record.backupId) await fs.promises.unlink(record.file);
      } catch { this.options.onError('SNAPSHOT_RETENTION_FAILED'); }
    }
    this.options.store.set('desktopSnapshotHistory', remaining);
  }
}
