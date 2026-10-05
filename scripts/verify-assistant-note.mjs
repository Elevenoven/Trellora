import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-assistant-note-'));
try {
  const entry = path.join(temporary, 'assistant-note.cjs');
  const serviceEntry = path.join(temporary, 'note-save-service.cjs');
  await Promise.all([
    build({ entryPoints: ['electron/assistantNote.ts'], outfile: entry, platform: 'node', bundle: true, format: 'cjs', logLevel: 'silent' }),
    build({ entryPoints: ['electron/noteSaveService.ts'], outfile: serviceEntry, platform: 'node', bundle: true, format: 'cjs', logLevel: 'silent' }),
  ]);
  const { createAssistantNote } = await import(pathToFileURL(entry).href);
  const { NoteSaveService } = await import(pathToFileURL(serviceEntry).href);
  const library = path.join(temporary, '笔记库');
  await fs.mkdir(path.join(library, '历史笔记'), { recursive: true });
  await fs.writeFile(path.join(library, '历史笔记', '未命名[8].md'), '已有笔记');
  const markdown = '# 会议纪要\n\n| 部门 | 金额 |\n| --- | ---: |\n| 华北销售部 | 12800 |\n\n```ts\nconst amount = 12800;\n```\n\n$$\na^2+b^2=c^2\n$$\n\n- [ ] 复核金额  \n保留换行\n';
  const service = new NoteSaveService({ getLibraryPath: () => library, committed: async () => {} });
  const create = (title = '') => service.structure(library, () => createAssistantNote(library, title, markdown));
  const first = await create();
  assert.equal(first.title, '未命名[9]');
  assert.equal(await fs.readFile(first.path, 'utf8'), markdown, 'Markdown is saved without serialization or trimming');
  await fs.unlink(first.path);
  const second = await create();
  assert.equal(second.title, '未命名[10]', 'deleted numbers are never reused');
  const restarted = new NoteSaveService({ getLibraryPath: () => library, committed: async () => {} });
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => restarted.structure(library, () => createAssistantNote(library, '', markdown))));
  assert.deepEqual(concurrent.map(note => note.title), ['未命名[11]', '未命名[12]', '未命名[13]']);
  const named = await create('会议纪要.md');
  assert.equal(named.title, '会议纪要');
  await fs.writeFile(named.path, '# 用户已有编辑\n');
  assert.equal((await create('会议纪要')).title, '会议纪要[1]');
  assert.equal((await create('会议纪要')).title, '会议纪要[2]');
  assert.equal(await fs.readFile(named.path, 'utf8'), '# 用户已有编辑\n', 'existing notes are never overwritten');
  for (const title of ['../越界', 'CON', 'a:b', '末尾.', 'x'.repeat(151)]) await assert.rejects(create(title));
  const otherLibrary = path.join(temporary, '第二个笔记库');
  await fs.mkdir(otherLibrary);
  assert.equal((await createAssistantNote(otherLibrary, '', markdown)).title, '未命名[1]', 'numbering belongs to the chosen library');
  console.log('Assistant note verified: exact Markdown, nested-name collisions, persistent increasing numbers, deletion, restart, concurrent saves, custom-title collisions, invalid titles, and separate libraries.');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
