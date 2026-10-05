import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAssistantNoteTitle, type CreateAssistantNoteResult } from '../shared/assistantNote';
import { atomicTextWrite } from './atomicTextWrite';
import { assertInsideDirectory } from './pathGuards';

/** Caller holds the library structure queue. Preserve Markdown bytes and never replace an existing note. */
export async function createAssistantNote(libraryPath: string, rawTitle: string, content: string): Promise<CreateAssistantNoteResult> {
  const title = normalizeAssistantNoteTitle(rawTitle);
  const names = await collectNoteNames(libraryPath);
  const metaDirectory = assertInsideDirectory(path.join(libraryPath, '.menghan-meta'), libraryPath);
  const sequencePath = assertInsideDirectory(path.join(metaDirectory, 'ai-note-sequence.json'), libraryPath);
  let sequence = 0;
  if (!title) {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(sequencePath, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('lastUntitledIndex' in saved)
        || !Number.isSafeInteger(saved.lastUntitledIndex) || Number(saved.lastUntitledIndex) < 0) {
        throw new Error('未命名笔记的编号记录无效，请检查笔记库元数据。');
      }
      sequence = Number(saved.lastUntitledIndex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const match = /^未命名\[(\d+)\]\.md$/u.exec(name);
      if (match && Number.isSafeInteger(Number(match[1]))) sequence = Math.max(sequence, Number(match[1]));
    }
    await fs.mkdir(metaDirectory, { recursive: true });
  }
  let suffix = 0;
  if (title) {
    for (const name of names) {
      const prefix = `${title.toLocaleLowerCase()}[`;
      if (!name.startsWith(prefix) || !name.endsWith('].md')) continue;
      const value = Number(name.slice(prefix.length, -4));
      if (Number.isSafeInteger(value) && value > 0) suffix = Math.max(suffix, value);
    }
  }
  for (;;) {
    let candidateTitle: string;
    if (!title) {
      if (!Number.isSafeInteger(sequence + 1)) throw new Error('未命名笔记编号已超出可用范围。');
      sequence++;
      // Reserve before creating: deletion, restart, or a failed write must not reuse an allocated number.
      await atomicTextWrite(sequencePath, JSON.stringify({ version: 1, lastUntitledIndex: sequence }), async () => {
        assertInsideDirectory(sequencePath, libraryPath);
      });
      candidateTitle = `未命名[${sequence}]`;
    } else {
      candidateTitle = names.has(`${title}.md`.toLocaleLowerCase()) ? `${title}[${++suffix}]` : title;
    }
    const fileName = `${candidateTitle}.md`;
    if (names.has(fileName.toLocaleLowerCase())) continue;
    const notePath = assertInsideDirectory(path.join(libraryPath, fileName), libraryPath);
    let handle;
    try {
      handle = await fs.open(notePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      names.add(fileName.toLocaleLowerCase());
      continue;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(notePath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { libraryPath, path: notePath, title: candidateTitle };
  }
}

/** Include nested notes when allocating names, without traversing links or application metadata. */
async function collectNoteNames(directory: string, names = new Set<string>()): Promise<Set<string>> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '.menghan-meta' || entry.name === '.git') continue;
    if (entry.isDirectory()) await collectNoteNames(path.join(directory, entry.name), names);
    else if (entry.isFile() && /\.md$/iu.test(entry.name)) names.add(entry.name.toLocaleLowerCase());
  }
  return names;
}
