export interface CreateAssistantNoteRequest {
  libraryPath: string;
  title?: string;
  content: string;
}

export interface CreateAssistantNoteResult {
  libraryPath: string;
  path: string;
  title: string;
}

/** Empty titles are allocated by the main process; explicit titles must be valid Windows filenames. */
export function normalizeAssistantNoteTitle(value: string): string {
  const title = value.trim().replace(/\.md$/iu, '').trim();
  if (!title) return '';
  if (title.length > 150 || /[<>:"/\\|?*\u0000-\u001f]/u.test(title)
    || /[. ]$/u.test(title) || title === '.' || title === '..'
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) {
    throw new Error('标题不能包含文件名非法字符、保留名称，且不能超过 150 个字符。');
  }
  return title;
}
