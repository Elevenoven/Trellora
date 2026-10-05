import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';

export const FineGrainedHistory = Extension.create({
  name: 'menghanFineGrainedHistory',
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        const hasUserDocumentChange = transactions.some((transaction) => (
          transaction.docChanged && transaction.getMeta('addToHistory') !== false
        ));
        return hasUserDocumentChange ? closeHistory(newState.tr) : null;
      },
    })];
  },
});
