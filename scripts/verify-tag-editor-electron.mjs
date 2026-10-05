import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { launchNoteTest, command, waitFor } from './electron-note-test-session.mjs';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'tag-editor-electron-'));
const library = path.join(temporary, 'library');
const userData = path.join(temporary, 'user-data');
const mainEntry = path.join(temporary, 'dist-electron', 'main.js');
const notePath = path.join(library, 'GRAPHRAG存储.md');
const tags = ['GraphRAG', '实体消歧', '知识图谱'];
let session;
let matter;

try {
  const frontmatterFile = path.join(temporary, 'frontmatter.cjs');
  await build({ entryPoints: ['shared/frontmatter.ts'], outfile: frontmatterFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  matter = (await import(pathToFileURL(frontmatterFile).href)).default.parseNoteFrontmatter;
  for (const directory of [library, userData, path.dirname(mainEntry)]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(notePath, '# GRAPHRAG存储\n\n文档正文\n');
  await fs.writeFile(path.join(library, '另一篇.md'), '---\ntags: [另一篇专属]\n---\n# 另一篇\n\n独立正文\n');
  await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({
    libraryPath: library, activeLibraryPath: library,
    libraries: [{ path: library, alias: '标签验收库', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }],
    workspacePath: path.join(temporary, 'workspace'),
    appPreferences: { defaultEditorMode: 'wysiwyg', autosaveDelayMs: 200 },
  }));
  await Promise.all([
    build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', external: ['electron', 'better-sqlite3'], outfile: mainEntry, logLevel: 'silent' }),
    build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'preload.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/knowledge/noteIndexWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'noteIndexWorker.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/externalWebPreload.ts'], bundle: true, platform: 'node', external: ['electron'], outfile: path.join(path.dirname(mainEntry), 'externalWebPreload.js'), logLevel: 'silent' }),
    build({ entryPoints: ['electron/pipeline/mammothWorker.ts'], bundle: true, platform: 'node', outfile: path.join(path.dirname(mainEntry), 'mammothWorker.js'), logLevel: 'silent' }),
    command(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(temporary, 'dist')]),
  ]);
  session = await launchNoteTest({ mainEntry, userData });
  await open('GRAPHRAG存储');
  for (const tag of tags) {
    await session.evaluate("document.querySelector('.note-add-tag-toggle').click()");
    await waitFor(() => session.evaluate("Boolean(document.querySelector('.note-tag-editor input')?.getClientRects().length)"), 'visible tag input');
    await session.evaluate("document.querySelector('.note-tag-editor input').focus()");
    await waitFor(() => session.evaluate("document.activeElement === document.querySelector('.note-tag-editor input')"), 'focused tag input');
    await session.send('Input.insertText', { text: tag });
    assert.equal(await session.evaluate("document.querySelector('.note-tag-editor input').value"), tag);
    await session.evaluate("document.querySelector('.note-tag-editor button[type=submit]').click()");
    await waitFor(() => session.evaluate(`[...document.querySelectorAll('.note-info-tags .note-tag-button')].some(node => node.textContent === ${JSON.stringify(`#${tag}`)})`), `visible tag ${tag}`);
    await assertTags(tags.slice(0, tags.indexOf(tag) + 1));
  }
  assert.equal(await session.evaluate("document.querySelector('.tiptap').innerText.trim()"), 'GRAPHRAG存储\n\n文档正文');
  assert.equal(await session.evaluate("document.querySelector('.tiptap').querySelectorAll('hr').length"), 0);
  await session.evaluate("document.querySelector('.tiptap').focus()");
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await session.send('Input.insertText', { text: '，编辑后标签仍在' });
  await waitFor(async () => (await fs.readFile(notePath, 'utf8')).includes('编辑后标签仍在'), 'edited body saved');
  await assertTags(tags);
  await mode('源码');
  assert.match(await session.evaluate("document.querySelector('.cm-content').innerText"), /tags:/);
  await mode('预览');
  assert.doesNotMatch(await session.evaluate("document.querySelector('.preview-content').innerText"), /tags:|实体消歧/);
  await mode('编辑');
  await assertTags(tags);
  await open('另一篇');
  assert.deepEqual(await visibleTags(), ['#另一篇专属']);
  assert.doesNotMatch(await session.evaluate("document.querySelector('.tiptap').innerText"), /GraphRAG|另一篇专属/);
  await open('GRAPHRAG存储');
  await assertTags(tags);
  await session.dispose();
  session = await launchNoteTest({ mainEntry, userData });
  await open('GRAPHRAG存储');
  await assertTags(tags);
  assert.match(await session.evaluate("document.querySelector('.tiptap').innerText"), /编辑后标签仍在/);
  console.log('Electron tag editor verified: tag application, right-panel tags, body-only rendering, edit/save, source/preview modes, note switching and restart.');
} catch (error) {
  console.error('Tag state:', await fs.readFile(notePath, 'utf8'), await session?.evaluate("({tags: document.querySelector('.note-info-tags')?.innerText, form: document.querySelector('.note-tag-editor')?.innerText, save: document.querySelector('.note-save-notice')?.outerHTML, editor: document.querySelector('.tiptap')?.innerText})").catch(() => undefined));
  console.error(error, session?.diagnostics());
  throw error;
} finally {
  await session?.dispose();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function open(title) {
  await waitFor(() => session.evaluate(`[...document.querySelectorAll('.file-tree-row')].some(node => node.textContent?.includes(${JSON.stringify(title)}))`), `tree ${title}`);
  await session.evaluate(`[...document.querySelectorAll('.file-tree-row')].find(node => node.textContent?.includes(${JSON.stringify(title)}))?.click()`);
  await waitFor(() => session.evaluate(`Boolean(document.querySelector('.tiptap')?.isContentEditable && document.querySelector('.knowledge-note-path')?.textContent?.trim() === ${JSON.stringify(`${title}.md`)} && document.querySelector('.note-save-notice')?.dataset.status === 'clean')`), `open ${title}`);
}

async function mode(label) {
  await session.evaluate(`[...document.querySelectorAll('.editor-mode-bar button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const selector = label === '源码' ? '.cm-content' : label === '预览' ? '.preview-content' : '.tiptap';
  await waitFor(() => session.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `mode ${label}`);
}

async function visibleTags() {
  return session.evaluate("[...document.querySelectorAll('.note-info-tags .note-tag-button')].map(node => node.textContent).sort()");
}

async function assertTags(expected) {
  await waitFor(async () => JSON.stringify(await visibleTags()) === JSON.stringify(expected.map(tag => `#${tag}`).sort()), 'right-panel tags');
  assert.deepEqual(matter(await fs.readFile(notePath, 'utf8')).data.tags, expected);
  assert.doesNotMatch(await session.evaluate("document.querySelector('.tiptap').innerText"), /tags:|实体消歧/);
}
