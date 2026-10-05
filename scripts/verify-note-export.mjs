import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'note-export-'));
try {
  const entry = path.join(temporary, 'export.cjs');
  await build({ entryPoints: ['electron/noteExport.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const { assertExportDestination, writeExportFile, exportNoteFile, renderNotePdf } = createRequire(import.meta.url)(entry);
  const library = path.join(temporary, 'library'); await fs.mkdir(library);
  const source = path.join(library, '中文原笔记.md'), target = path.join(temporary, '导出副本.md');
  const original = Buffer.from('---\ntitle: 中文原笔记\n---\n\n# 正文\n\n![本地图片](image/a.png)\n');
  await fs.writeFile(source, original);
  await writeExportFile(target, original, source);
  assert.deepEqual(await fs.readFile(target), original);
  assert.deepEqual(await fs.readFile(source), original);
  await assert.rejects(writeExportFile(source, Buffer.from('不可覆盖'), source), /原笔记/);
  const alias = path.join(temporary, '硬链接.md'); await fs.link(source, alias);
  await assert.rejects(assertExportDestination(alias, source), /同一个文件/);
  const aliasDirectory = path.join(temporary, '目录链接'); await fs.symlink(library, aliasDirectory, 'junction');
  await assert.rejects(assertExportDestination(path.join(aliasDirectory, '中文原笔记.md'), source), /原笔记/);

  // 新导出写入失败时，已有副本和原笔记都保留，且没有临时文件残留。
  const previousExport = Buffer.from('已存在的完整导出副本'); await fs.writeFile(target, previousExport);
  const open = fs.open, rename = fs.rename;
  for (const phase of ['write', 'sync', 'replace']) {
    try {
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).includes('.trellora-export-')) {
          if (phase === 'write') handle.writeFile = async () => { throw Object.assign(new Error('模拟导出写失败'), { code: 'EIO' }); };
          if (phase === 'sync') handle.sync = async () => { throw Object.assign(new Error('模拟导出同步失败'), { code: 'EIO' }); };
        }
        return handle;
      };
      if (phase === 'replace') fs.rename = async () => { throw Object.assign(new Error('模拟导出替换失败'), { code: 'EACCES' }); };
      await assert.rejects(writeExportFile(target, Buffer.from('新导出副本'), source));
    } finally { fs.open = open; fs.rename = rename; }
    assert.deepEqual(await fs.readFile(target), previousExport);
    assert.deepEqual(await fs.readFile(source), original);
    assert.equal((await fs.readdir(temporary)).some(name => name.startsWith('.trellora-export-')), false);
  }
  await assert.rejects(exportNoteFile({}, { format: 'exe', content: '', sourcePath: source, defaultName: 'bad' }), /参数无效/);
  await assert.rejects(exportNoteFile({}, { format: 'md', content: 'x'.repeat(40 * 1024 * 1024 + 1), sourcePath: source, defaultName: 'large' }), /40 MB/);
  await assert.rejects(renderNotePdf('<html><head></head><body>无效 HTML</body></html>'), /HTML 无效/);
  console.log('Note export verified: exact UTF-8 Markdown, original/alias protection, complete replacement, write/sync/replace failure preservation, input limits and temporary-file cleanup.');
} finally {
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
