import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listRegisteredLibraries } from './libraryRegistry';
import { formatLibraryTimestamp } from './libraryCreation';
import { assertExistingDirectory, assertInsideDirectory, getUniquePath, sanitizeEntryName } from './pathGuards';
import { isSupportedTextFile } from './fileTypes';
import { readTextFile } from './textFile';
import { saveLibraryChunkingConfig } from './pipeline/chunkingConfig';

export type MaterialsLibraryOrigin = 'created' | 'upgraded';
export type MaterialsVectorState = '未启用' | '待索引' | '已索引';
export type MaterialsDocumentVectorState = 'pending' | 'indexed';

export interface MaterialsLibraryRegistration {
  path: string;
  alias: string;
  icon: string;
  origin: MaterialsLibraryOrigin;
  addedAt: string;
  upgradedAt?: string;
  lastOpenedAt: string;
}

export interface MaterialsLibrarySummary extends MaterialsLibraryRegistration {
  exists: boolean;
  isActive: boolean;
  documentCount: number;
  totalSizeBytes: number;
  vectorState: MaterialsVectorState;
}

export interface MaterialsDocument {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  addedAt: string;
  contentHash: string;
  vectorState: MaterialsDocumentVectorState;
}

interface MaterialsManifestDocument {
  id: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  addedAt: string;
  contentHash: string;
  vectorState: MaterialsDocumentVectorState;
  vectorIndexedAt?: string;
}

interface MaterialsManifest {
  schemaVersion: 1;
  libraryId: string;
  documents: MaterialsManifestDocument[];
}

interface MaterialsRegistryStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

const materialsLibrariesKey = 'materialsLibraries';
const activeMaterialsLibraryKey = 'activeMaterialsLibraryPath';
const metaDirectoryName = '.menghan-meta';
const manifestFileName = 'materials-manifest.json';
const materialsRootDirectoryName = 'knowledge-base';
const materialsDocumentsDirectoryName = 'documents';
const materialsPreviewMaxBytes = 128 * 1024 * 1024;
export const defaultMaterialsIconId = 'file';
const ignoredDirectories = new Set(['.git', '.menghan-backups', metaDirectoryName, 'node_modules', '_attachments']);

export const materialsDocumentExtensions = new Set([
  '.md', '.markdown', '.txt', '.pdf',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.csv', '.html', '.htm', '.epub', '.json', '.yaml', '.yml', '.xml', '.log',
]);

// ---------------------------------------------------------------------------
// 注册表（CRUD，结构与笔记库注册表保持一致）
// ---------------------------------------------------------------------------

export function listMaterialsLibraries(store: MaterialsRegistryStore): MaterialsLibraryRegistration[] {
  const stored = store.get(materialsLibrariesKey);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  return stored.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const libraryPath = typeof record.path === 'string' && record.path.trim() ? path.resolve(record.path) : null;
    if (!libraryPath || seen.has(libraryPath)) return [];
    seen.add(libraryPath);
    const now = new Date().toISOString();
    const registration: MaterialsLibraryRegistration = {
      path: libraryPath,
      alias: typeof record.alias === 'string' && record.alias.trim() ? record.alias.trim() : path.basename(libraryPath) || '未命名资料库',
      icon: typeof record.icon === 'string' && record.icon.trim() ? record.icon.trim() : defaultMaterialsIconId,
      origin: record.origin === 'upgraded' ? 'upgraded' : 'created',
      addedAt: typeof record.addedAt === 'string' && record.addedAt ? record.addedAt : now,
      lastOpenedAt: typeof record.lastOpenedAt === 'string' && record.lastOpenedAt ? record.lastOpenedAt : now,
    };
    if (typeof record.upgradedAt === 'string' && record.upgradedAt) registration.upgradedAt = record.upgradedAt;
    return [registration];
  });
}

export function registerMaterialsLibrary(
  store: MaterialsRegistryStore,
  libraryPath: string,
  alias: string,
  origin: MaterialsLibraryOrigin,
  icon: string = defaultMaterialsIconId,
  now = new Date(),
): MaterialsLibraryRegistration {
  const normalizedPath = path.resolve(libraryPath);
  assertExistingDirectory(normalizedPath);
  const registrations = listMaterialsLibraries(store);
  const timestamp = now.toISOString();
  const normalizedAlias = sanitizeEntryName(alias) || path.basename(normalizedPath) || '未命名资料库';
  const normalizedIcon = icon.trim() || defaultMaterialsIconId;
  const existing = registrations.find((library) => library.path === normalizedPath);
  const next = existing
    ? registrations.map((library) => library.path === normalizedPath
      ? { ...library, alias: normalizedAlias, origin, icon: normalizedIcon, lastOpenedAt: timestamp, ...(origin === 'upgraded' ? { upgradedAt: timestamp } : {}) }
      : library)
    : [...registrations, {
      path: normalizedPath,
      alias: normalizedAlias,
      icon: normalizedIcon,
      origin,
      addedAt: timestamp,
      lastOpenedAt: timestamp,
      ...(origin === 'upgraded' ? { upgradedAt: timestamp } : {}),
    }];
  store.set(materialsLibrariesKey, next);
  store.set(activeMaterialsLibraryKey, normalizedPath);
  return next.find((library) => library.path === normalizedPath)!;
}

export function activateMaterialsLibrary(store: MaterialsRegistryStore, libraryPath: string, now = new Date()): string {
  const normalizedPath = path.resolve(libraryPath);
  const registrations = listMaterialsLibraries(store);
  if (!registrations.some((library) => library.path === normalizedPath)) {
    throw new Error('该资料库尚未注册，请先新建资料库。');
  }
  const next = registrations.map((library) => library.path === normalizedPath
    ? { ...library, lastOpenedAt: now.toISOString() }
    : library);
  store.set(materialsLibrariesKey, next);
  store.set(activeMaterialsLibraryKey, normalizedPath);
  return normalizedPath;
}

export function renameMaterialsLibrary(store: MaterialsRegistryStore, libraryPath: string, alias: string): MaterialsLibraryRegistration[] {
  const normalizedPath = path.resolve(libraryPath);
  const normalizedAlias = sanitizeEntryName(alias);
  if (!normalizedAlias) throw new Error('请输入资料库名称。');
  const registrations = listMaterialsLibraries(store);
  if (!registrations.some((library) => library.path === normalizedPath)) {
    throw new Error('该资料库尚未注册。');
  }
  const next = registrations.map((library) => library.path === normalizedPath ? { ...library, alias: normalizedAlias } : library);
  store.set(materialsLibrariesKey, next);
  return next;
}

export function removeMaterialsLibrary(store: MaterialsRegistryStore, libraryPath: string): MaterialsLibraryRegistration[] {
  const normalizedPath = path.resolve(libraryPath);
  const next = listMaterialsLibraries(store).filter((library) => library.path !== normalizedPath);
  store.set(materialsLibrariesKey, next);
  const activePath = store.get(activeMaterialsLibraryKey);
  if (typeof activePath === 'string' && path.resolve(activePath) === normalizedPath) {
    store.delete(activeMaterialsLibraryKey);
  }
  return next;
}

export function getActiveMaterialsLibraryPath(store: MaterialsRegistryStore): string | null {
  const activePath = store.get(activeMaterialsLibraryKey);
  return typeof activePath === 'string' && activePath.trim() ? path.resolve(activePath) : null;
}

/** 笔记库升级为资料库：在知识库根目录下新建「名称-时间戳」工作文件夹并复制笔记文档入库；笔记库本身保留。 */
export function upgradeRegisteredLibraryToMaterials(
  store: MaterialsRegistryStore,
  libraryPath: string,
  workspacePath: string,
  icon: string = defaultMaterialsIconId,
  now = new Date(),
  chunkingConfigDraft?: unknown,
): MaterialsLibraryRegistration {
  const normalizedPath = path.resolve(libraryPath);
  const noteRegistration = listRegisteredLibraries(store).find((library) => library.path === normalizedPath);
  if (!noteRegistration) throw new Error('该笔记库尚未注册，无法升级。');
  assertExistingDirectory(normalizedPath);

  const root = ensureMaterialsRoot(workspacePath);
  const created = createMaterialsLibraryDirectory(root, noteRegistration.alias, now, chunkingConfigDraft);
  try {
    copyLibraryDocuments(normalizedPath, materialsDocumentsDirectory(created.path));
    syncMaterialsManifest(created.path, now);
    return registerMaterialsLibrary(store, created.path, noteRegistration.alias, 'upgraded', icon, now);
  } catch (error) {
    // The directory was created by this operation and is not registered yet;
    // remove only this bounded, recoverable half-finished upgrade.
    if (fs.existsSync(created.path)) fs.rmSync(created.path, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 工作区知识库根目录与库工作文件夹
// ---------------------------------------------------------------------------

/** 工作区内专门的知识库根目录：<workspace>/knowledge-base。 */
export function materialsRootPath(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), materialsRootDirectoryName);
}

/** 确保知识库根目录存在并返回其路径。 */
export function ensureMaterialsRoot(workspacePath: string): string {
  const root = materialsRootPath(workspacePath);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 在知识库根目录下创建「名称-时间戳」工作文件夹，内含 documents 文档目录。 */
export function createMaterialsLibraryDirectory(rootPath: string, name: string, now = new Date(), chunkingConfigDraft?: unknown): { path: string; alias: string } {
  const root = assertExistingDirectory(path.resolve(rootPath));
  const alias = sanitizeEntryName(name.trim());
  if (!alias) throw new Error('请输入资料库名称。');
  const libraryPath = getUniquePath(root, `${alias}-${formatLibraryTimestamp(now)}`);
  fs.mkdirSync(libraryPath, { recursive: false });
  try {
    fs.mkdirSync(materialsDocumentsDirectory(libraryPath), { recursive: false });
    if (chunkingConfigDraft !== undefined) saveLibraryChunkingConfig(libraryPath, chunkingConfigDraft);
    return { path: libraryPath, alias };
  } catch (error) {
    if (fs.existsSync(libraryPath)) fs.rmSync(libraryPath, { recursive: true, force: true });
    throw error;
  }
}

/** 资料库的文档存放目录：<library>/documents。 */
export function materialsDocumentsDirectory(libraryPath: string): string {
  return path.join(libraryPath, materialsDocumentsDirectoryName);
}

export function summarizeMaterialsLibraries(store: MaterialsRegistryStore): MaterialsLibrarySummary[] {
  const activePath = getActiveMaterialsLibraryPath(store);
  return listMaterialsLibraries(store).map((library) => {
    const exists = isReadableDirectory(library.path);
    const documents = exists ? readMaterialsManifest(library.path)?.documents.filter((document) => documentExists(library.path, document)) ?? [] : [];
    const indexedCount = documents.filter((document) => document.vectorState === 'indexed').length;
    const vectorState: MaterialsVectorState = documents.length === 0
      ? '未启用'
      : indexedCount === documents.length ? '已索引' : '待索引';
    return {
      ...library,
      exists,
      isActive: activePath === library.path,
      documentCount: documents.length,
      totalSizeBytes: documents.reduce((total, document) => total + (document.sizeBytes || 0), 0),
      vectorState,
    };
  });
}

// ---------------------------------------------------------------------------
// 文档清单（为后续 sqlite-vec 向量化保留 contentHash 与 vectorState 字段）
// ---------------------------------------------------------------------------

export function materialsManifestPath(libraryPath: string): string {
  return path.join(libraryPath, metaDirectoryName, manifestFileName);
}

export function readMaterialsManifest(libraryPath: string): MaterialsManifest | null {
  const manifestPath = materialsManifestPath(libraryPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<MaterialsManifest>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.documents)) return null;
    return {
      schemaVersion: 1,
      libraryId: typeof parsed.libraryId === 'string' && parsed.libraryId ? parsed.libraryId : crypto.randomUUID(),
      documents: parsed.documents.filter(isValidManifestDocument),
    };
  } catch {
    return null;
  }
}

export function ensureMaterialsMeta(libraryPath: string): MaterialsManifest {
  const library = assertExistingDirectory(libraryPath);
  const manifest = readMaterialsManifest(library);
  if (manifest) return manifest;
  const created: MaterialsManifest = { schemaVersion: 1, libraryId: crypto.randomUUID(), documents: [] };
  writeMaterialsManifest(library, created);
  return created;
}

/** 扫描资料库目录，将新增文件登记为文档、移除已不存在的条目。 */
export function syncMaterialsManifest(libraryPath: string, now = new Date()): MaterialsDocument[] {
  const library = assertExistingDirectory(libraryPath);
  const manifest = ensureMaterialsMeta(library);
  const existingByRelativePath = new Map(manifest.documents.map((document) => [document.relativePath, document]));
  const scannedFiles = collectDocumentFiles(materialsDocumentsDirectory(library));
  const timestamp = now.toISOString();

  const nextDocuments: MaterialsManifestDocument[] = [];
  for (const absolutePath of scannedFiles) {
    const relativePath = toRelativePath(library, absolutePath);
    const existing = existingByRelativePath.get(relativePath);
    const stat = fs.statSync(absolutePath);
    if (existing && existing.sizeBytes === stat.size && documentExists(library, existing)) {
      if (existing.vectorState === 'indexed') {
        // 大小相同但内容变化时清单不会重建条目；已索引文档需校验哈希，内容变化即降级为待索引。
        const contentHash = hashFileContents(absolutePath);
        if (contentHash !== existing.contentHash) {
          nextDocuments.push({ ...existing, contentHash, vectorState: 'pending', vectorIndexedAt: undefined });
          continue;
        }
      }
      nextDocuments.push(existing);
      continue;
    }
    nextDocuments.push({
      id: existing?.id ?? crypto.randomUUID(),
      name: path.basename(absolutePath),
      relativePath,
      sizeBytes: stat.size,
      addedAt: existing?.addedAt ?? timestamp,
      contentHash: hashFileContents(absolutePath),
      vectorState: 'pending',
    });
  }

  const nextManifest: MaterialsManifest = { ...manifest, documents: nextDocuments };
  writeMaterialsManifest(library, nextManifest);
  return toDocuments(library, nextDocuments);
}

export function listMaterialsDocuments(libraryPath: string): MaterialsDocument[] {
  const library = assertExistingDirectory(libraryPath);
  return syncMaterialsManifest(library);
}

export function findMaterialsDocument(libraryPath: string, documentId: string): MaterialsDocument | null {
  const manifest = readMaterialsManifest(libraryPath);
  const entry = manifest?.documents.find((document) => document.id === documentId);
  if (!entry) return null;
  const absolutePath = assertInsideDirectory(path.join(libraryPath, entry.relativePath), libraryPath);
  return {
    ...entry,
    absolutePath,
    extension: path.extname(entry.name).toLowerCase(),
  };
}

/** 将外部文件复制进资料库 documents 目录（资料库只读，更新方式为删除后重新上传）。 */
export function importMaterialsDocuments(libraryPath: string, sourcePaths: string[], now = new Date()): MaterialsDocument[] {
  const library = assertExistingDirectory(libraryPath);
  const documentsDirectory = materialsDocumentsDirectory(library);
  fs.mkdirSync(documentsDirectory, { recursive: true });
  const skipped: string[] = [];
  for (const sourcePath of sourcePaths) {
    const resolvedSourcePath = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
      throw new Error(`找不到要上传的文件：${sourcePath}`);
    }
    if (!materialsDocumentExtensions.has(path.extname(resolvedSourcePath).toLowerCase())) {
      skipped.push(path.basename(resolvedSourcePath));
      continue;
    }
    const targetPath = getUniquePath(documentsDirectory, path.basename(resolvedSourcePath));
    fs.copyFileSync(resolvedSourcePath, targetPath);
  }
  if (skipped.length > 0) {
    throw new Error(`不支持的文件类型：${skipped.join('、')}`);
  }
  return syncMaterialsManifest(library, now);
}

/** 重命名资料文档（仅改文件名，不改动内容；无扩展名时保留原扩展名）。 */
export function renameMaterialsDocument(libraryPath: string, documentId: string, newName: string): MaterialsDocument[] {
  const library = assertExistingDirectory(libraryPath);
  const document = findMaterialsDocument(library, documentId);
  if (!document) throw new Error('找不到要重命名的资料文档。');

  const baseName = sanitizeEntryName(newName);
  if (!baseName) throw new Error('请输入文档名称。');
  const finalName = path.extname(baseName) ? baseName : `${baseName}${document.extension}`;
  const finalExtension = path.extname(finalName).toLowerCase();
  if (!materialsDocumentExtensions.has(finalExtension)) {
    throw new Error(`不支持的文件类型：${finalName}`);
  }

  const targetPath = path.join(path.dirname(document.absolutePath), finalName);
  if (path.resolve(targetPath) !== path.resolve(document.absolutePath)) {
    if (fs.existsSync(targetPath)) throw new Error('同名文档已存在。');
    fs.renameSync(document.absolutePath, targetPath);
  }

  const manifest = ensureMaterialsMeta(library);
  const nextDocuments = manifest.documents.map((entry) => entry.id === documentId
    ? { ...entry, name: finalName, relativePath: toRelativePath(library, targetPath) }
    : entry);
  writeMaterialsManifest(library, { ...manifest, documents: nextDocuments });
  return toDocuments(library, nextDocuments);
}

/** 回写资料文档的向量状态（vectors 阶段提交或流水线校准时调用）；状态未变化时不写盘。 */
export function markMaterialsDocumentVectorState(libraryPath: string, documentId: string, vectorState: MaterialsDocumentVectorState, now = new Date()): void {
  const manifest = readMaterialsManifest(libraryPath);
  if (!manifest || !manifest.documents.some((entry) => entry.id === documentId)) return;
  let changed = false;
  const nextDocuments = manifest.documents.map((entry) => {
    if (entry.id !== documentId || entry.vectorState === vectorState) return entry;
    changed = true;
    return vectorState === 'indexed'
      ? { ...entry, vectorState, vectorIndexedAt: now.toISOString() }
      : { ...entry, vectorState, vectorIndexedAt: undefined };
  });
  if (changed) writeMaterialsManifest(libraryPath, { ...manifest, documents: nextDocuments });
}

/** 读取资料文档文本内容；二进制文档（pdf/docx 等）返回 null。 */
export function readMaterialsDocumentText(libraryPath: string, documentId: string): string | null {
  const document = findMaterialsDocument(libraryPath, documentId);
  if (!document) throw new Error('找不到要阅读的资料文档。');
  if (!isSupportedTextFile(document.name)) return null;
  return readTextFile(document.absolutePath);
}

/** 读取允许在渲染进程内预览的二进制资料；只允许 PDF 和 DOCX。 */
export function readMaterialsDocumentBytes(libraryPath: string, documentId: string): Uint8Array | null {
  const document = findMaterialsDocument(libraryPath, documentId);
  if (!document) throw new Error('找不到要预览的资料文档。');
  if (document.extension !== '.pdf' && document.extension !== '.docx') return null;
  if (document.sizeBytes > materialsPreviewMaxBytes) {
    throw new Error('资料文件超过 128 MB，暂不直接预览；请先压缩或拆分文件。');
  }
  return new Uint8Array(fs.readFileSync(document.absolutePath));
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function writeMaterialsManifest(libraryPath: string, manifest: MaterialsManifest): void {
  const metaDirectory = path.join(libraryPath, metaDirectoryName);
  fs.mkdirSync(metaDirectory, { recursive: true });
  fs.writeFileSync(materialsManifestPath(libraryPath), JSON.stringify(manifest, null, 2), 'utf8');
}

function isValidManifestDocument(entry: unknown): entry is MaterialsManifestDocument {
  if (!entry || typeof entry !== 'object') return false;
  const record = entry as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.relativePath === 'string'
    && typeof record.contentHash === 'string'
    && (record.vectorState === 'pending' || record.vectorState === 'indexed');
}

function documentExists(libraryPath: string, document: MaterialsManifestDocument): boolean {
  try {
    return fs.statSync(path.join(libraryPath, document.relativePath)).isFile();
  } catch {
    return false;
  }
}

function toDocuments(libraryPath: string, documents: MaterialsManifestDocument[]): MaterialsDocument[] {
  return documents
    .map((document) => ({
      ...document,
      absolutePath: path.join(libraryPath, document.relativePath),
      extension: path.extname(document.name).toLowerCase(),
    }))
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt) || left.name.localeCompare(right.name, 'zh-CN'));
}

function collectDocumentFiles(libraryPath: string): string[] {
  const collected: string[] = [];
  const walk = (directoryPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(path.join(directoryPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (materialsDocumentExtensions.has(path.extname(entry.name).toLowerCase())) {
        collected.push(path.join(directoryPath, entry.name));
      }
    }
  };
  walk(libraryPath);
  return collected;
}

function toRelativePath(libraryPath: string, absolutePath: string): string {
  return path.relative(libraryPath, absolutePath).split(path.sep).join('/');
}

function hashFileContents(absolutePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

/** 递归复制源库中受支持的文档到目标 documents 目录，保留相对目录结构。 */
function copyLibraryDocuments(sourceLibraryPath: string, targetDocumentsDirectory: string): void {
  const walk = (directoryPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!materialsDocumentExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const relativeDirectory = path.relative(sourceLibraryPath, directoryPath);
      const targetDirectory = relativeDirectory ? path.join(targetDocumentsDirectory, relativeDirectory) : targetDocumentsDirectory;
      fs.mkdirSync(targetDirectory, { recursive: true });
      fs.copyFileSync(entryPath, getUniquePath(targetDirectory, entry.name));
    }
  };
  walk(sourceLibraryPath);
}

function isReadableDirectory(libraryPath: string): boolean {
  try {
    if (!fs.statSync(libraryPath).isDirectory()) return false;
    fs.accessSync(libraryPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
