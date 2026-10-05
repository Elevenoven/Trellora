import { Extension } from '@tiptap/core';
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type DispatchTransaction = (transaction: Transaction) => void;

const boundaryBlockTypes = new Set(['blockquote', 'codeBlock', 'table']);

function isAtFirstPositionOfTopLevelBlock(selection: TextSelection): boolean {
  const $cursor = selection.$cursor;
  if (!$cursor || $cursor.depth < 1 || $cursor.parentOffset !== 0) return false;

  for (let depth = 1; depth < $cursor.depth; depth += 1) {
    if ($cursor.index(depth) !== 0) return false;
  }

  return boundaryBlockTypes.has($cursor.node(1).type.name);
}

/**
 * Removes a table, code block, or quote when Backspace is pressed at its very
 * first editable position. Text deletion everywhere else stays untouched.
 */
export function deleteBoundaryBlockAtStart(
  state: EditorState,
  dispatch?: DispatchTransaction,
): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  if (!isAtFirstPositionOfTopLevelBlock(selection)) return false;
  if (!dispatch) return true;

  const $cursor = selection.$cursor;
  if (!$cursor) return false;

  const blockFrom = $cursor.before(1);
  const blockTo = $cursor.after(1);
  const transaction = state.tr.delete(blockFrom, blockTo);

  if (transaction.doc.childCount === 0) {
    const paragraph = state.schema.nodes.paragraph?.create();
    if (paragraph) transaction.insert(0, paragraph);
  }

  const selectionPosition = Math.min(blockFrom, transaction.doc.content.size);
  transaction
    .setSelection(Selection.near(transaction.doc.resolve(selectionPosition), 1))
    .scrollIntoView();
  dispatch(transaction);
  return true;
}

export function appendTrailingParagraph(state: EditorState): Transaction | null {
  const lastNode = state.doc.lastChild;
  if (!lastNode || !boundaryBlockTypes.has(lastNode.type.name)) return null;

  const paragraph = state.schema.nodes.paragraph?.create();
  return paragraph ? state.tr.insert(state.doc.content.size, paragraph) : null;
}

export const BlockBoundary = Extension.create({
  name: 'menghanBlockBoundary',
  priority: 1_200,

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteBoundaryBlockAtStart(
        this.editor.state,
        transaction => this.editor.view.dispatch(transaction),
      ),
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        const hasUserDocumentChange = transactions.some(transaction => (
          transaction.docChanged && transaction.getMeta('addToHistory') !== false
        ));
        return hasUserDocumentChange ? appendTrailingParagraph(newState) : null;
      },
    })];
  },
});
