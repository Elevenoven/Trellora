import { createDocument, type Editor } from '@tiptap/core';

export function replaceContentWithoutHistory(editor: Editor, html: string): void {
  const document = createDocument(html, editor.schema);
  const transaction = editor.state.tr
    .replaceWith(0, editor.state.doc.content.size, document)
    .setMeta('preventUpdate', true)
    .setMeta('addToHistory', false);
  editor.view.dispatch(transaction);
}
