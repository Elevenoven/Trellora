import type { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorClipboardContent } from '../../shared/editorClipboard';
import type { EditorPreferences } from '../../shared/editorPreferences';
import { markdownToHtml } from '../utils/markdown';

const formattedClipboardSelector = 'h1,h2,h3,h4,h5,h6,strong,b,em,i,s,del,a[href],ul,ol,blockquote,pre,code,table,img,hr,[data-pm-slice],[data-type]';
const markdownSyntaxPattern = /(^|\n) {0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}(?:\n|$))|[*_`~]|!?\[[^\]\n]+\]\(|\[\[|\$/;

function hasClipboardFormatting(html: string): boolean {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return Boolean(dom.querySelector(formattedClipboardSelector));
}

/** Insert literal text without HTML parsing or input/paste-rule metadata. */
export function pasteLiteralText(editor: Editor, text: string): void {
  if (!editor.isEditable || !text) return;
  const { state } = editor;
  const normalized = text.replace(/\r\n?/g, '\n');
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const inSource = state.selection.$from.parent.type.spec.code || ['formulaBlock', 'inlineFormula'].includes(state.selection.$from.parent.type.name);
  const lines = normalized.split('\n');
  const slice = inSource || lines.length === 1
    ? new Slice(Fragment.from(state.schema.text(normalized, marks)), 0, 0)
    : new Slice(Fragment.fromArray(lines.map(line => state.schema.nodes.paragraph.create(null, line ? state.schema.text(line, marks) : undefined))), 1, 1);
  editor.view.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
}

/** Both keyboard and context-menu text pass through this same policy. */
export function pasteClipboardText(editor: Editor, data: EditorClipboardContent, mode: EditorPreferences['editorPasteMode']): void {
  const inSource = editor.state.selection.$from.parent.type.spec.code || ['formulaBlock', 'inlineFormula'].includes(editor.state.selection.$from.parent.type.name);
  if (mode === 'preserve-format' && !inSource) {
    // Parse Markdown sources once, while keeping rich clipboard HTML and explicit plain paste intact.
    const text = clipboardPlainText(data);
    if (editor.storage.editorPreferences.editorMarkdownAutoConvert && markdownSyntaxPattern.test(text)
      && (!data.html || !hasClipboardFormatting(data.html))) {
      const html = markdownToHtml(text, { taskListMode: 'editor' });
      if (hasClipboardFormatting(html)) {
        editor.view.pasteHTML(html);
        return;
      }
    }
    if (data.html) editor.view.pasteHTML(data.html);
    else pasteLiteralText(editor, text);
  } else {
    const text = clipboardPlainText(data);
    pasteLiteralText(editor, text);
  }
}

/** Clipboard HTML without a text flavor still has a plain-text representation. */
export function clipboardPlainText(data: Pick<EditorClipboardContent, 'text' | 'html'>): string {
  if (data.text || !data.html) return data.text;
  const dom = document.createElement('div');
  dom.innerHTML = data.html;
  dom.querySelectorAll('script,style').forEach(node => node.remove());
  dom.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  dom.querySelectorAll('p,div,li,tr').forEach(node => node.append('\n'));
  return dom.textContent ?? '';
}
