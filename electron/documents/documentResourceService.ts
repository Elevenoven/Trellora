import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertInsideDirectory, resolveRealAncestors, sanitizeEntryName } from '../pathGuards';
import { collectDocumentReferences, rewriteDocumentReferences } from '../../shared/documentResourceManifest';
import { DocumentError } from './textCodec';

export const DOCUMENT_RESOURCE_SCHEME = 'trellora-resource';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024, MAX_RESOURCE_BYTES = 20 * 1024 * 1024, MAX_RESOURCES = 200;
const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export interface DraftAsset { reference: string; fileName: string }
export interface ResourcePublication { content: string; replacements: Record<string, string>; rollback: () => Promise<void> }
interface Context { displayPath: string; content: string; draftRevision: number }
interface State { roots: string[]; drafts: DraftAsset[] }

/** 授权仅适用于被正文引用的只读资源；发布回滚仅删除本次独占创建的文件。 */
export class DocumentResourceService {
  private readonly states = new Map<string, State>();
  private readonly grants = new Map<string, { sessionId: string; revision: number; filePath: string; root: string }>();
  constructor(private readonly options: { privateRoot: string; context: (id: string) => Context | undefined; protectedRoots: () => string[] }) {}
  private state(id: string): State { let value = this.states.get(id); if (!value) { value = { roots: [], drafts: [] }; this.states.set(id, value); } return value; }
  assets(id: string): DraftAsset[] { return structuredClone(this.state(id).drafts); }
  adopt(id: string, drafts: DraftAsset[]): void {
    if (!Array.isArray(drafts) || drafts.length > MAX_RESOURCES || drafts.some(asset => !asset || !/^trellora-draft:[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp)$/.test(asset.reference) || asset.fileName !== asset.reference.slice(15))) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '恢复草稿的图片记录无效。');
    this.state(id).drafts = structuredClone(drafts);
  }
  grantRoot(id: string, directory: string): void {
    if (!this.options.context(id)) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const root = resolveRealAncestors(path.resolve(directory));
    for (const protectedRoot of this.options.protectedRoots()) if (inside(root, resolveRealAncestors(protectedRoot))) throw new DocumentError('DOCUMENT_PROTECTED', '不能授权应用私有数据或资料库目录。');
    this.state(id).roots.push(root);
  }
  private async resolve(id: string, href: string): Promise<{ filePath: string; root: string; fragment: string }> {
    const context = this.options.context(id); if (!context) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const state = this.state(id);
    if (href.startsWith('trellora-draft:')) {
      const asset = state.drafts.find(value => value.reference === href);
      if (!asset) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '草稿图片未获授权。');
      return { filePath: assertInsideDirectory(path.join(this.options.privateRoot, asset.fileName), this.options.privateRoot), root: this.options.privateRoot, fragment: '' };
    }
    const [source, ...fragments] = href.split('#'); let decoded: string;
    try { decoded = decodeURIComponent(source).replace(/\\([ ()])/g, '$1'); } catch { throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '本地资源地址编码无效。'); }
    if (decoded.includes('\0') || /^(?!file:)[a-z][a-z\d+.-]*:/i.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '本地资源地址无效。');
    const base = path.dirname(context.displayPath), candidate = /^file:/i.test(decoded) ? fileURLToPath(decoded) : path.resolve(base, decoded);
    const automatic = !path.isAbsolute(decoded) && !/^file:/i.test(decoded) && inside(candidate, base);
    const root = [ ...(automatic ? [base] : []), ...state.roots ].find(directory => inside(candidate, directory) && inside(resolveRealAncestors(candidate), resolveRealAncestors(directory)));
    if (!root) throw new DocumentError('DOCUMENT_RESOURCE_DENIED', `本地资源需要选择目录授权：${href}`);
    const filePath = resolveRealAncestors(candidate);
    for (const protectedRoot of this.options.protectedRoots()) if (inside(filePath, resolveRealAncestors(protectedRoot))) throw new DocumentError('DOCUMENT_PROTECTED', '本地资源位于应用受保护目录。');
    const stat = await fs.stat(filePath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentError('DOCUMENT_RESOURCE_MISSING', `本地资源不存在：${href}`); throw error; });
    if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', `本地资源不是文件或超过 20 MiB：${href}`);
    return { filePath, root: resolveRealAncestors(root), fragment: fragments.length ? `#${fragments.join('#')}` : '' };
  }
  async openLink(id: string, href: string): Promise<string> {
    const context = this.options.context(id), decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    const reference = context && collectDocumentReferences(context.content).references.find(reference => !reference.image && decode(reference.href) === decode(href));
    if (!reference) throw new DocumentError('DOCUMENT_RESOURCE_DENIED', '链接不属于当前文档。');
    return (await this.resolve(id, reference.href)).filePath;
  }
  async preview(id: string): Promise<{ urls: Record<string, string>; issues: string[]; draftRevision: number }> {
    const context = this.options.context(id); if (!context) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    for (const [token, grant] of this.grants) if (grant.sessionId === id) this.grants.delete(token);
    const manifest = collectDocumentReferences(context.content), issues = [...manifest.unsupported], urls: Record<string, string> = {};
    if (manifest.references.length > MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多处理 200 个本地资源引用。');
    for (const reference of manifest.references) {
      if (!reference.image || urls[reference.href]) continue;
      try {
        const resource = await this.resolve(id, reference.href); if (!mime[path.extname(resource.filePath).toLowerCase()]) throw new Error('图片格式只支持 PNG、JPG、GIF、WebP。');
        const token = randomUUID(); this.grants.set(token, { sessionId: id, revision: context.draftRevision, filePath: resource.filePath, root: resource.root }); urls[reference.href] = `${DOCUMENT_RESOURCE_SCHEME}://resource/${token}`;
      } catch (error) { issues.push(`${reference.href}：${(error as Error).message}`); }
    }
    return { urls, issues, draftRevision: context.draftRevision };
  }
  async read(rawUrl: string, method = 'GET'): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = new URL(rawUrl), token = url.pathname.slice(1), grant = this.grants.get(token);
    if (method !== 'GET' || url.protocol !== `${DOCUMENT_RESOURCE_SCHEME}:` || url.hostname !== 'resource' || url.search || url.hash || url.username || url.password || url.port || !grant) throw new Error('资源授权无效。');
    const context = this.options.context(grant.sessionId);
    if (!context || context.draftRevision !== grant.revision || !inside(resolveRealAncestors(grant.filePath), grant.root)) throw new Error('资源授权已失效。');
    const mimeType = mime[path.extname(grant.filePath).toLowerCase()]; if (!mimeType) throw new Error('图片类型无效。');
    const bytes = await boundedRead(grant.filePath, MAX_IMAGE_BYTES); return { bytes: new Uint8Array(bytes), mimeType };
  }
  async addImage(id: string, bytes: Uint8Array, extension: string): Promise<{ markdownPath: string; fileName: string }> {
    if (!this.options.context(id)) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const ext = extension.toLowerCase(); if (!mime[ext] || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '图片格式不支持或超过 10 MiB。');
    if (this.state(id).drafts.length >= MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多暂存 200 张图片。');
    await fs.mkdir(this.options.privateRoot, { recursive: true });
    const fileName = `${randomUUID()}${ext}`, reference = `trellora-draft:${fileName}`, filePath = assertInsideDirectory(path.join(this.options.privateRoot, fileName), this.options.privateRoot);
    const handle = await fs.open(filePath, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.state(id).drafts.push({ reference, fileName }); return { markdownPath: reference, fileName };
  }
  async imageFromPath(id: string, source: string): Promise<{ markdownPath: string; fileName: string }> {
    const resolved = await this.resolve(id, source); return this.addImage(id, new Uint8Array(await boundedRead(resolved.filePath, MAX_IMAGE_BYTES)), path.extname(resolved.filePath));
  }
  async publish(id: string, content: string, target: string, copyAll: boolean): Promise<ResourcePublication> {
    const manifest = collectDocumentReferences(content), replacements: Record<string, string> = {}, created: { path: string; identity?: { ino: number; size: number; mtimeMs: number; ctimeMs: number } }[] = [];
    if (copyAll && manifest.unsupported.length) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', `无法可靠迁移这些本地引用：${manifest.unsupported.join('；')}`);
    if (manifest.references.length > MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多处理 200 个本地资源引用。');
    const directory = path.join(path.dirname(target), `${path.parse(target).name}.assets`); let directoryCreated = false;
    const rollback = async () => {
      let committedBody: Buffer | undefined;
      try { committedBody = await boundedRead(target, 20 * 1024 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      for (const file of created) {
        // 外部程序已改动产物或目标正文已引用它时，保留该文件。
        // UUID 在 UTF-8/GBK/GB18030 与 UTF-16 LE/BE 正文中都能识别；不因编码删掉引用中的资源。
        const marker = path.basename(file.path).slice(0, 36), utf16 = Buffer.from(marker, 'utf16le');
        if (committedBody && [Buffer.from(marker), utf16, Buffer.from(utf16).swap16()].some(bytes => committedBody.includes(bytes))) continue;
        const stat = await fs.stat(file.path).catch(() => undefined), prior = file.identity;
        if (stat && prior && stat.ino === prior.ino && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs && stat.ctimeMs === prior.ctimeMs) await fs.unlink(assertInsideDirectory(file.path, directory)).catch(() => undefined);
      }
      if (directoryCreated) await fs.rmdir(directory).catch(() => undefined);
    };
    try {
      // 全部预检后再写入；读入的冻结资源字节不在后续提交中换成外部新版本。
      const copies: { href: string; filePath: string; fragment: string; bytes: Buffer }[] = []; let totalBytes = 0;
      for (const reference of manifest.references) {
        if (replacements[reference.href] || copies.some(item => item.href === reference.href)) continue;
        if (!copyAll && !reference.href.startsWith('trellora-draft:')) continue;
        const resource = await this.resolve(id, reference.href);
        const bytes = await boundedRead(resource.filePath, reference.image ? MAX_IMAGE_BYTES : MAX_RESOURCE_BYTES);
        totalBytes += bytes.length; if (totalBytes > 64 * 1024 * 1024) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '本次资源总大小超过 64 MiB，请减少引用后重试。');
        copies.push({ href: reference.href, ...resource, bytes });
      }
      for (const item of copies) {
        assertInsideDirectory(directory, path.dirname(target)); try { await fs.mkdir(directory); directoryCreated = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const fileName = `${randomUUID()}-${sanitizeEntryName(path.basename(item.filePath))}`, destination = assertInsideDirectory(path.join(directory, fileName), directory);
        const handle = await fs.open(destination, 'wx'), owned: (typeof created)[number] = { path: destination }; created.push(owned);
        try { await handle.writeFile(item.bytes); await handle.sync(); } finally { owned.identity = await handle.stat().catch(() => undefined); await handle.close(); }
        replacements[item.href] = `${path.basename(directory)}/${fileName}${item.fragment}`;
      }
      return { content: rewriteDocumentReferences(content, replacements), replacements, rollback };
    } catch (error) { await rollback(); throw error; }
  }
  async release(id: string, keepDrafts = false): Promise<void> {
    const assets = this.states.get(id)?.drafts ?? []; this.states.delete(id);
    for (const [token, grant] of this.grants) if (grant.sessionId === id) this.grants.delete(token);
    if (!keepDrafts) for (const asset of assets) if (![...this.states.values()].some(state => state.drafts.some(value => value.fileName === asset.fileName))) await fs.unlink(assertInsideDirectory(path.join(this.options.privateRoot, asset.fileName), this.options.privateRoot)).catch(() => undefined);
  }
}
function inside(candidate: string, root: string): boolean { const relative = path.relative(root, candidate); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function boundedRead(filePath: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try { const before = await handle.stat(); if (!before.isFile() || before.size > limit) throw new Error('资源超过大小限制。'); const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await handle.read(bytes); const after = await handle.stat(), named = await fs.stat(filePath); if (bytesRead > limit || bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== named.ino || after.ctimeMs !== named.ctimeMs) throw new Error('资源在读取期间发生变化，请重试。'); return bytes.subarray(0, bytesRead); } finally { await handle.close(); }
}
