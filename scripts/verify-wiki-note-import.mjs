import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { launchNoteTest, waitFor } from './electron-note-test-session.mjs';

const root = process.cwd();
const staging = path.join(root, '.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'wiki-note-import-'));
let session;
try {
  const frontmatterFile = path.join(temporary, 'frontmatter.cjs');
  await build({ entryPoints: ['shared/frontmatter.ts'], outfile: frontmatterFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const matter = (await import(pathToFileURL(frontmatterFile).href)).default.parseNoteFrontmatter;
  const sourceLibraryPath = path.join(temporary, 'materials');
  const targetLibraryPath = path.join(temporary, 'notes');
  const parseDirectory = path.join(sourceLibraryPath, '.menghan-meta', 'parse');
  await fs.mkdir(path.join(parseDirectory, 'images'), { recursive: true });
  await fs.mkdir(targetLibraryPath);
  const sourceFile = path.join(sourceLibraryPath, '中石油项目需求.pdf');
  const originalBytes = Buffer.from('%PDF source is read-only');
  await fs.writeFile(sourceFile, originalBytes);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=', 'base64');
  const imageHash = crypto.createHash('sha256').update(image).digest('hex');
  const imageRef = `images/${imageHash}.png`;
  await fs.writeFile(path.join(parseDirectory, imageRef), image);
  const completeBody = `# 中石油项目需求\n正文\n![项目图](${imageRef})\n${'完整正文。'.repeat(20_000)}\n末尾必须完整保留\n`;
  await fs.writeFile(path.join(parseDirectory, 'document.md'), completeBody);
  await fs.writeFile(path.join(parseDirectory, 'line-layout.jsonl'), '{"lineNo":2,"blankBefore":true}\n');
  await fs.writeFile(path.join(parseDirectory, 'images-manifest.json'), JSON.stringify({ schemaVersion: 1, stage: 'parse', images: [{ name: `${imageHash}.png`, relativePath: imageRef, sha256: imageHash, bytes: image.length, mime: 'image/png', origin: { kind: 'mineru-zip', ref: 'figure.png' } }], skipped: [] }));
  await fs.writeFile(path.join(targetLibraryPath, '中石油项目需求.md'), '# 用户已有的同名笔记\n');
  const modulePath = path.join(temporary, 'import.cjs');
  await build({ entryPoints: ['electron/wiki/wikiNoteImport.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { importWikiDocumentAsNote } = (await import(pathToFileURL(modulePath).href)).default;
  const input = { sourceLibraryPath, targetLibraryPath, parseDirectory, documentName: '中石油项目需求.pdf', documentId: 'real-document', contentHash: 'source-version-1' };
  const imported = await importWikiDocumentAsNote(input);
  assert.equal(imported.created, true);
  assert.notEqual(path.basename(imported.path), '中石油项目需求.md');
  const exported = await fs.readFile(imported.path, 'utf8');
  const parsed = matter(exported);
  assert.match(parsed.content, /# 中石油项目需求\n\n正文/);
  assert.match(parsed.content, /末尾必须完整保留/);
  assert.ok(parsed.content.length > 80_000, 'Import must use the full document, beyond Wiki preview limits.');
  const copiedRef = /!\[项目图\]\(([^)]+)\)/.exec(parsed.content)[1];
  assert.deepEqual(await fs.readFile(path.join(targetLibraryPath, copiedRef)), image);
  await fs.writeFile(imported.path, `${exported}\n用户后续编辑\n`);
  assert.deepEqual(await importWikiDocumentAsNote(input), { path: imported.path, created: false });
  assert.match(await fs.readFile(imported.path, 'utf8'), /用户后续编辑/);
  assert.equal(await fs.readFile(path.join(targetLibraryPath, '中石油项目需求.md'), 'utf8'), '# 用户已有的同名笔记\n');
  assert.deepEqual(await fs.readFile(sourceFile), originalBytes);
  const nextVersion = await importWikiDocumentAsNote({ ...input, contentHash: 'source-version-2' });
  assert.notEqual(nextVersion.path, imported.path);
  assert.equal(nextVersion.created, true);
  console.log('Wiki note import verified: complete parsed PDF body, restored blank lines, copied images, name collisions, edited-note reuse, source versions, original unchanged.');

  if (process.argv.includes('--electron')) await verifyElectronFlow();
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function verifyElectronFlow() {
  const appRoot = path.join(temporary, 'app');
  const userData = path.join(appRoot, 'user-data');
  const mainEntry = path.join(appRoot, 'dist-electron', 'main.js');
  const libraries = [path.join(appRoot, 'notes-a'), path.join(appRoot, 'notes-b')];
  const materials = path.join(appRoot, 'materials');
  for (const directory of [userData, path.dirname(mainEntry), ...libraries, path.join(materials, 'documents')]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(libraries[0], '原有笔记.md'), '# 原有笔记\n');
  await fs.writeFile(path.join(materials, 'documents', '真实Wiki文档.md'), '# 真实Wiki文档\n\n## 项目需求\n\n从资料库打开的完整正文。\n\n## 验收要求\n\n结尾验收内容。\n');
  const now = new Date().toISOString();
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath: libraries[0], activeLibraryPath: libraries[0], workspacePath: path.join(appRoot, 'workspace'),
    libraries: libraries.map((library, index) => ({ path: library, alias: index ? '目标笔记库' : '原笔记库', addedAt: now, lastOpenedAt: now })),
    materialsLibraries: [{ path: materials, alias: '真实资料库', icon: 'file', origin: 'created', addedAt: now, lastOpenedAt: now }],
    activeMaterialsLibraryPath: materials,
  }));
  await fs.symlink(path.join(root, 'pipeline-python'), path.join(appRoot, 'pipeline-python'), 'junction');
  await fs.cp(path.join(root, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], outfile: mainEntry, bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], logLevel: 'silent', plugins: [{ name: 'hidden-test-window', setup(builder) { builder.onLoad({ filter: /electron[\\/]main\.ts$/ }, async ({ path: file }) => { const source = await fs.readFile(file, 'utf8'); assert.ok(source.includes('mainWindow = new BrowserWindow({')); return { contents: source.replace('mainWindow = new BrowserWindow({', 'mainWindow = new BrowserWindow({ show: false,'), loader: 'ts', resolveDir: path.dirname(file) }; }); } }] }),
    ...['preload', 'externalWebPreload'].map((name) => build({ entryPoints: [`electron/${name}.ts`], outfile: path.join(path.dirname(mainEntry), `${name}.js`), bundle: true, platform: 'node', external: ['electron'], logLevel: 'silent' })),
    build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js'), bundle: true, platform: 'node', logLevel: 'silent' }),
    build({ entryPoints: ['electron/pipeline/mammothWorker.ts'], outfile: path.join(path.dirname(mainEntry), 'mammothWorker.js'), bundle: true, platform: 'node', logLevel: 'silent' }),
  ]);
  session = await launchNoteTest({ mainEntry, userData });
  const document = (await session.evaluate(`window.electronAPI.listMaterialsDocuments(${JSON.stringify(materials)})`))[0];
  await session.evaluate(`window.electronAPI.startMaterialsPipeline(${JSON.stringify(materials)}, ${JSON.stringify(document.id)})`);
  await waitFor(async () => {
    const statuses = await session.evaluate(`window.electronAPI.getMaterialsPipelineStatus(${JSON.stringify(materials)})`);
    const status = statuses.find((item) => item.documentId === document.id);
    if (status?.stages?.tree?.status === 'SUCCEEDED') return true;
    if (['FAILED', 'FAILED_RETRYABLE', 'WAITING_CONFIG'].includes(status?.state)) throw new Error(JSON.stringify({ stage: status.stage, state: status.state, error: status.error }));
    return false;
  }, 'real Markdown pipeline structure', 60_000);
  await navigate('Wiki');
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.wiki-document-list-item[data-state=ready]'))"), 'Wiki document list');
  await session.evaluate("document.querySelector('.wiki-document-list-item[data-state=ready]').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.wiki-outline-pane .wiki-outline-link'))"), 'outline');
  await session.evaluate("document.querySelector('.wiki-outline-pane .wiki-outline-link').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.wiki-document-actions button:not(:disabled)'))"), 'real source open button');
  await session.evaluate("document.querySelector('.wiki-document-actions button').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[role=dialog] input')?.value)"), 'Mantine library chooser');
  assert.equal(await session.evaluate("document.querySelector('[role=dialog] input').value"), '原笔记库');
  assert.equal(await session.evaluate('window.electronAPI.getLibraryPath()'), libraries[0]);
  assert.equal((await fs.readdir(libraries[1])).filter((file) => file.endsWith('.md')).length, 0);
  await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === '取消').click()");
  await waitFor(() => session.evaluate("!document.querySelector('[role=dialog]')"), 'cancel chooser');
  await session.evaluate("document.querySelector('.wiki-document-actions button').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[role=dialog] input')?.value)"), 'reopen chooser');
  await session.evaluate("document.querySelector('[role=dialog] input').click()");
  await waitFor(() => session.evaluate("Boolean([...document.querySelectorAll('[role=option]')].find(option => option.textContent === '目标笔记库'))"), 'target library option');
  await session.evaluate("[...document.querySelectorAll('[role=option]')].find(option => option.textContent === '目标笔记库').click()");
  await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === '打开笔记').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.notes-main-view:not([hidden])') && document.querySelector('.tiptap')?.textContent?.includes('结尾验收内容'))"), 'imported document open in notes');
  assert.equal(await session.evaluate('window.electronAPI.getLibraryPath()'), libraries[1]);
  assert.equal((await fs.readdir(libraries[1])).filter((file) => file.endsWith('.md')).length, 1);
  await navigate('Wiki');
  await session.evaluate("document.querySelector('.wiki-document-actions button').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('[role=dialog] input')?.value === '目标笔记库')"), 'choose destination again');
  await session.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === '打开笔记').click()");
  await waitFor(() => session.evaluate("Boolean(document.querySelector('.notes-main-view:not([hidden])'))"), 'reused note open');
  assert.equal((await fs.readdir(libraries[1])).filter((file) => file.endsWith('.md')).length, 1);
  const rejected = await session.evaluate(`window.electronAPI.importWikiDocumentToNoteLibrary(${JSON.stringify(materials)}, ${JSON.stringify(document.id)}, 'stale-hash', ${JSON.stringify(libraries[1])}).then(() => false, () => true)`);
  assert.equal(rejected, true, 'Main process must reject stale source identity.');
  console.log('Electron flow verified: real Wiki source, Mantine chooser before writes, cancel, second-library selection, library activation, note editor, repeated open, stale-source rejection.');
}

async function navigate(label) {
  await session.evaluate(`document.querySelector('.app-nav-item[aria-label=${JSON.stringify(label)}]').click()`);
}
