import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseNoteFrontmatter, stringifyNoteFrontmatter } from '../../shared/frontmatter';
import { assertExistingDirectory, assertInsideDirectory, getUniquePath, sanitizeEntryName } from '../pathGuards';
import { readParseImagesManifest, rewriteMarkdownImageReferences } from '../pipeline/parseImages';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

interface WikiNoteImportInput {
  sourceLibraryPath: string;
  targetLibraryPath: string;
  documentId: string;
  contentHash: string;
  documentName: string;
  parseDirectory: string;
}

/** 从已校验的完整 parse 产物创建笔记；同源同版本复用，保留笔记编辑和同名文件。 */
export async function importWikiDocumentAsNote(input: WikiNoteImportInput): Promise<{ path: string; created: boolean }> {
  const targetLibrary = fs.realpathSync(assertExistingDirectory(input.targetLibraryPath));
  const sourceLibrary = fs.realpathSync(assertExistingDirectory(input.sourceLibraryPath));
  const parseDirectory = assertInsideDirectory(fs.realpathSync(input.parseDirectory), sourceLibrary);
  for (const entry of fs.readdirSync(targetLibrary, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const notePath = path.join(targetLibrary, entry.name);
    if (fs.statSync(notePath).size > MAX_DOCUMENT_BYTES + 65536) continue;
    try {
      const source = parseNoteFrontmatter(fs.readFileSync(notePath, 'utf8')).data.wiki_source as { libraryPath?: string; documentId?: string; contentHash?: string } | undefined;
      if (source?.libraryPath === sourceLibrary && source.documentId === input.documentId && source.contentHash === input.contentHash) {
        return { path: notePath, created: false };
      }
    } catch { /* 无效的已有 frontmatter 不影响导入，也不能覆盖该笔记。 */ }
  }

  const markdownPath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, 'document.md')), parseDirectory);
  if (fs.statSync(markdownPath).size > MAX_DOCUMENT_BYTES) throw new Error('文档解析正文超过 16 MB，暂时无法转为笔记。');
  const lines = fs.readFileSync(markdownPath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const layoutPath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, 'line-layout.jsonl')), parseDirectory);
  const blankBefore = new Set<number>();
  for (const line of fs.readFileSync(layoutPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { lineNo?: number; blankBefore?: boolean };
    if (record.blankBefore && Number.isInteger(record.lineNo) && record.lineNo! > 0) blankBefore.add(record.lineNo!);
  }
  let markdown = lines.flatMap((line, index) => blankBefore.has(index + 1) ? ['', line] : [line]).join('\n');
  if (!markdown.trim()) throw new Error('文档解析正文为空，请先在资料库重新处理。');

  const createdFiles: string[] = [];
  try {
    const imageManifest = readParseImagesManifest(parseDirectory);
    const rewrites = new Map<string, string>();
    if (imageManifest?.images.length) {
      const sourceKey = crypto.createHash('sha256').update(`${sourceLibrary}\0${input.documentId}`).digest('hex').slice(0, 16);
      const imageDirectory = assertInsideDirectory(path.join(targetLibrary, 'image', 'wiki', sourceKey), targetLibrary);
      // 检查每个已存在的父目录，避免通过符号链接把附件写到笔记库外。
      let parent = targetLibrary;
      for (const segment of ['image', 'wiki', sourceKey]) {
        parent = path.join(parent, segment);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent);
        assertInsideDirectory(fs.realpathSync(parent), targetLibrary);
      }
      for (const image of imageManifest.images) {
        const sourcePath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, image.relativePath)), parseDirectory);
        const bytes = fs.readFileSync(sourcePath);
        if (bytes.length !== image.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
          throw new Error('文档图片产物已变化，请先重新处理文档。');
        }
        const imageName = `${image.sha256}${path.extname(image.name)}`;
        const imagePath = assertInsideDirectory(path.join(imageDirectory, imageName), imageDirectory);
        if (fs.existsSync(imagePath)) {
          assertInsideDirectory(fs.realpathSync(imagePath), targetLibrary);
          if (crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex') !== image.sha256) {
            throw new Error('笔记库内的同名图片已变化，无法导入。');
          }
        } else {
          fs.copyFileSync(sourcePath, imagePath, fs.constants.COPYFILE_EXCL);
          createdFiles.push(imagePath);
        }
        rewrites.set(image.relativePath, path.relative(targetLibrary, imagePath).replace(/\\/g, '/'));
      }
    }
    markdown = rewriteMarkdownImageReferences(markdown, rewrites);
    const parsed = parseNoteFrontmatter(markdown);
    const content = stringifyNoteFrontmatter(parsed.content, {
      ...parsed.data,
      wiki_source: { libraryPath: sourceLibrary, documentId: input.documentId, contentHash: input.contentHash, sourceName: input.documentName },
    });
    const baseName = sanitizeEntryName(path.parse(input.documentName).name);
    const notePath = getUniquePath(targetLibrary, `${baseName}.md`);
    const handle = await fs.promises.open(notePath, 'wx');
    createdFiles.push(notePath);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return { path: notePath, created: true };
  } catch (error) {
    for (const createdPath of createdFiles.reverse()) {
      try { fs.unlinkSync(createdPath); } catch { /* 清理本次新增文件，保留原始错误。 */ }
    }
    throw error;
  }
}
