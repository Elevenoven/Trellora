import { editorPreferenceKeys } from '../../shared/editorPreferences';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import * as yazl from 'yazl';
import type { BackupManifest, BackupRegistration, BackupRoot } from '../../shared/workspaceBackup';
import { assertInsideDirectory, resolveRealAncestors } from '../pathGuards';
import { safeServiceEndpoint } from '../appLogger';
import { validArchivePath, verifyBackupArchive, BACKUP_LIMITS } from './archive';

const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
export function assertSeparateBackupTarget(target: string, sourceRoots: string[]): string {
  const real = resolveRealAncestors(target);
  for (const source of sourceRoots.map(resolveRealAncestors)) if (inside(source, real) || inside(real, source)) throw new Error('备份目标必须是源工作区和库之外的独立目录，且不能包含源目录。');
  return real;
}
export function planBackupRoots(workspacePath: string, libraries: Array<{ path: string; alias: string; kind: 'note' | 'materials'; icon?: string; origin?: 'created' | 'upgraded' }>): { roots: BackupRoot[]; registrations: BackupRegistration[] } {
  const workspace = resolveRealAncestors(workspacePath);
  const paths = [...new Set([workspace, ...libraries.map(library => resolveRealAncestors(library.path))])].sort((a, b) => a.length - b.length);
  const top = paths.filter(candidate => !paths.some(parent => parent !== candidate && inside(parent, candidate)));
  const roots: BackupRoot[] = top.map((sourcePath, index) => ({ id: `root-${index}`, sourcePath, kind: inside(sourcePath, workspace) ? 'workspace' : 'library', label: sourcePath === workspace ? '工作区' : path.basename(sourcePath), ...(inside(sourcePath, workspace) ? { workspaceRelativePath: path.relative(sourcePath, workspace).split(path.sep).join('/') } : {}) }));
  const registrations = libraries.map(library => { const real = resolveRealAncestors(library.path); const root = roots.find(candidate => inside(candidate.sourcePath, real))!; return { kind: library.kind, alias: library.alias, sourcePath: path.resolve(library.path), rootId: root.id, relativePath: path.relative(root.sourcePath, real).split(path.sep).join('/'), ...(library.icon ? { icon: library.icon } : {}), ...(library.origin ? { origin: library.origin } : {}) }; });
  return { roots, registrations };
}
export const isApplicationDatabase = (relativePath: string) => /(?:^|\/)\.menghan-meta\/(?:index|assistant-memory)\.db$/u.test(relativePath) || /(?:^|\/)ConversationMemory\/(?:qa-memory|conversation-memory)\.db$/u.test(relativePath);
const ignored = (relative: string) => /(?:^|\/)\.menghan-meta\/\.trellora-use\.lock(?:\/|$)/u.test(relative) || /(?:^|\/)\.menghan-meta\/restore-paused\.json$/u.test(relative);

interface SourceFile { relativePath: string; absolutePath: string; size: number; modified: number; changed: number }
async function inventory(root: string, signal: AbortSignal, directories?: string[]): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  async function walk(directory: string) {
    signal.throwIfAborted();
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); const relativePath = path.relative(root, file).split(path.sep).join('/');
      if (ignored(relativePath)) continue;
      validArchivePath(relativePath); const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('备份源包含符号链接或 junction。请使用实际文件目录后重试。');
      assertInsideDirectory(file, root);
      if (stat.isDirectory()) { directories?.push(relativePath); await walk(file); }
      else if (stat.isFile()) { result.push({ relativePath, absolutePath: file, size: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs }); if (result.length > 50_000) throw new Error('文件数量超过单个备份上限，请分库备份。'); }
      else throw new Error('备份源包含无法复制的特殊文件。');
    }
  }
  await walk(root); return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
export async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file);
  try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk); } } finally { stream.destroy(); }
  return hash.digest('hex');
}
/** Captures all application databases through SQLite's online backup API, never by live DB/WAL copying. */
export async function captureSnapshot(options: { manifest: Omit<BackupManifest, 'files' | 'directories' | 'omitted'>; directory: string; signal: AbortSignal; onProgress?: (completed: number, total: number) => void }): Promise<BackupManifest> {
  const manifest: BackupManifest = { ...options.manifest, files: [], directories: [], omitted: ['应用使用锁', '应用数据库对应 WAL/SHM', '远程凭据与 safeStorage 密文', '恢复任务暂停标记'] };
  const initial = new Map<string, SourceFile[]>();
  let totalBytes = 0, total = 0, completed = 0;
  for (const root of manifest.roots) { const directories: string[] = []; const files = await inventory(root.sourcePath, options.signal, directories); manifest.directories.push(...directories.map(relativePath => ({ rootId: root.id, relativePath }))); initial.set(root.id, files); total += files.length; totalBytes += files.reduce((sum, file) => sum + file.size, 0); }
  if (manifest.directories.length > 50_000) throw new Error('目录数量超过单个备份上限，请分库备份。');
  if (total > 50_000 || totalBytes > BACKUP_LIMITS.expandedBytes) throw new Error('源数据超过单个备份的文件数量或 256 GiB 大小上限。');
  for (const root of manifest.roots) {
    const files = initial.get(root.id)!;
    for (const file of files) {
      options.signal.throwIfAborted();
      if (/-(?:wal|shm)$/u.test(file.relativePath) && isApplicationDatabase(file.relativePath.replace(/-(?:wal|shm)$/u, ''))) continue;
      const destination = assertInsideDirectory(path.join(options.directory, 'roots', root.id, ...file.relativePath.split('/')), options.directory);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      let version: number | undefined;
      if (isApplicationDatabase(file.relativePath)) {
        const database = new Database(file.absolutePath, { readonly: true, fileMustExist: true });
        try { version = Number(database.pragma('user_version', { simple: true })); await database.backup(destination, { progress: () => { options.signal.throwIfAborted(); return 200; } }); }
        finally { database.close(); }
      } else {
        let matched = false;
        for (let attempt = 0; attempt < 2 && !matched; attempt++) {
          const before = await fs.promises.stat(file.absolutePath); const hash = await hashFile(file.absolutePath, options.signal);
          await fs.promises.copyFile(file.absolutePath, destination);
          const after = await fs.promises.stat(file.absolutePath);
          matched = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && hash === await hashFile(destination, options.signal);
        }
        if (!matched) throw new Error('备份期间源文件被外部程序修改，请等待修改完成后重试。');
      }
      const size = (await fs.promises.stat(destination)).size;
      manifest.files.push({ rootId: root.id, relativePath: file.relativePath, size, sha256: await hashFile(destination, options.signal), ...(version !== undefined ? { databaseVersion: version } : {}) });
      options.onProgress?.(++completed, total);
    }
    const finalDirectories: string[] = [];
    const final = await inventory(root.sourcePath, options.signal, finalDirectories);
    // A read-only SQLite connection can create an empty WAL/SHM pair. An empty
    // WAL contains no commits; nonempty WAL and DB changes still fail this gate.
    const stable = (list: SourceFile[]) => JSON.stringify(list.filter(file => !(isApplicationDatabase(file.relativePath.slice(0, -4)) && (file.relativePath.endsWith('-shm') || (file.relativePath.endsWith('-wal') && file.size === 0)))).map(file => [file.relativePath, file.size, file.modified, file.changed]));
    if (stable(files) !== stable(final) || JSON.stringify(finalDirectories.sort()) !== JSON.stringify(manifest.directories.filter(directory => directory.rootId === root.id).map(directory => directory.relativePath).sort())) {
      const before = new Map(files.map(file => [file.relativePath, JSON.stringify([file.size, file.modified, file.changed])]));
      const after = new Map(final.map(file => [file.relativePath, JSON.stringify([file.size, file.modified, file.changed])]));
      const changes = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).slice(0, 3);
      throw Object.assign(new Error(`备份期间源目录内容发生变化，请关闭外部编辑程序后重试。${changes.length ? ` 变化文件：${changes.join('、')}` : ''}`), { code: 'BACKUP_SOURCE_CHANGED' });
    }
  }
  return manifest;
}
/** Only explicitly supported connection and preference fields leave userData. */
export function safeBackupSettings(preferences: Record<string, unknown>, modelSettings: unknown, parsing: { mineruEndpoint: string }, modelHub?: unknown): Record<string, unknown> {
  const allowed = [...editorPreferenceKeys, 'schemaVersion', 'theme', 'lightColorScheme', 'density', 'language', 'startupBehavior', 'externalLinkOpenMode', 'backupRetention', 'defaultEditorMode', 'autosaveDelayMs', 'previewPreference', 'leftSidebarWidth', 'knowledgePanelWidth'];
  const source = modelSettings as { defaultProfileId?: unknown; profiles?: Array<{ id: unknown; label?: unknown; name?: unknown; config: Record<string, unknown> }> } | undefined;
  const configFields = ['kind', 'provider', 'api', 'model', 'temperature', 'topP', 'maxOutputTokens'];
  const hub = modelHub as { ollamaEndpoint?: unknown; providers?: Array<Record<string, unknown>>; slots?: Record<string, Record<string, unknown>> } | undefined;
  const stringFields = (object: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.filter(key => typeof object[key] === 'string').map(key => [key, object[key]]));
  return { schemaVersion: 1, preferences: Object.fromEntries(allowed.filter(key => Object.hasOwn(preferences, key) && ['string', 'number', 'boolean'].includes(typeof preferences[key])).map(key => [key, preferences[key]])), aiModelSettings: { defaultProfileId: typeof source?.defaultProfileId === 'string' ? source.defaultProfileId : '', profiles: (Array.isArray(source?.profiles) ? source.profiles : []).flatMap(profile => typeof profile.id === 'string' && typeof (profile.label ?? profile.name) === 'string' && profile.config && typeof profile.config === 'object' ? [{ id: profile.id, label: profile.label ?? profile.name, config: { ...Object.fromEntries(configFields.filter(key => ['string', 'number', 'boolean'].includes(typeof profile.config[key])).map(key => [key, profile.config[key]])), endpoint: safeServiceEndpoint(String(profile.config.endpoint ?? '')), remoteContentConsent: false } }] : []) }, modelHub: { ollamaEndpoint: safeServiceEndpoint(typeof hub?.ollamaEndpoint === 'string' ? hub.ollamaEndpoint : ''), remoteConsent: false, providers: (Array.isArray(hub?.providers) ? hub.providers : []).map(provider => ({ ...stringFields(provider, ['id', 'label', 'api']), endpoint: safeServiceEndpoint(typeof provider.endpoint === 'string' ? provider.endpoint : '') })), slots: Object.fromEntries(['generation', 'embedding', 'rerank'].map(slot => [slot, stringFields(hub?.slots?.[slot] ?? {}, ['source', 'model'])])) }, parsing: { mineruEndpoint: safeServiceEndpoint(parsing.mineruEndpoint), cloudParsingConsent: false }, credentialsRequired: true };
}
export async function packSnapshot(options: { directory: string; target: string; manifest: BackupManifest; settings: Record<string, unknown>; signal: AbortSignal; onProgress?: (completed: number, total: number) => void }): Promise<void> {
  const partial = `${options.target}.partial`; const zip = new yazl.ZipFile();
  const zipOutput = zip.outputStream as Readable;
  let output: Promise<void> | undefined;
  let ownsPartial = false;
  const manifest = Buffer.from(JSON.stringify(options.manifest)); const settings = Buffer.from(JSON.stringify(options.settings));
  if (manifest.length > BACKUP_LIMITS.manifestBytes || settings.length > BACKUP_LIMITS.settingsBytes) throw new Error('备份清单或设置超过大小上限，请分库备份。');
  try {
    const destination = fs.createWriteStream(partial, { flags: 'wx' }); destination.once('open', () => { ownsPartial = true; });
    output = pipeline(zipOutput, destination, { signal: options.signal });
    zip.on('error', error => zipOutput.destroy(error));
    zip.addBuffer(manifest, 'manifest.json'); zip.addBuffer(settings, 'settings/safe-settings.json');
    for (const file of options.manifest.files) zip.addFile(path.join(options.directory, 'roots', file.rootId, ...file.relativePath.split('/')), `roots/${file.rootId}/${file.relativePath}`);
    zip.end({ forceZip64Format: true, comment: '' }); await output;
    await verifyBackupArchive(partial, options.manifest, options.signal, undefined, options.onProgress);
    options.signal.throwIfAborted();
    if (fs.existsSync(options.target)) throw new Error('备份目标文件已经存在，请更换文件名。');
    await fs.promises.rename(partial, options.target);
  } catch (error) { zipOutput.destroy(error instanceof Error ? error : new Error('备份打包失败。')); await output?.catch(() => undefined); if (ownsPartial) await fs.promises.rm(partial, { force: true }); throw error; }
}
