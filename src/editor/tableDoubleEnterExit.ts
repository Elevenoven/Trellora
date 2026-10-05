import { Extension } from '@tiptap/core';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type DispatchTransaction = (transaction: Transaction) => void;

interface TableSelectionDepths {
  table: number;
  row: number;
  cell: number;
}

function findTableSelectionDepths($cursor: TextSelection['$cursor']): TableSelectionDepths | null {
  if (!$cursor) return null;

  let table = -1;
  let row = -1;
  let cell = -1;

  for (let depth = $cursor.depth; depth > 0; depth -= 1) {
    const nodeName = $cursor.node(depth).type.name;
    if (cell < 0 && (nodeName === 'tableCell' || nodeName === 'tableHeader')) {
      cell = depth;
    } else if (cell >= 0 && row < 0 && nodeName === 'tableRow') {
      row = depth;
    } else if (row >= 0 && nodeName === 'table') {
      table = depth;
      break;
    }
  }

  if (table < 0 || row !== table + 1 || cell !== row + 1) return null;
  return { table, row, cell };
}

/**
 * Exits a table only from the empty paragraph produced by the first Enter at
 * the end of the bottom-right cell. Returning false preserves Tiptap's normal
 * Enter behavior everywhere else, including ordinary line breaks in cells.
 */
export function exitTableOnSecondEnter(
  state: EditorState,
  dispatch?: DispatchTransaction,
): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || !selection.$cursor) return false;

  const $cursor = selection.$cursor;
  const depths = findTableSelectionDepths($cursor);
  if (!depths) return false;

  const table = $cursor.node(depths.table);
  const row = $cursor.node(depths.row);
  const cell = $cursor.node(depths.cell);
  if ($cursor.index(depths.table) !== table.childCount - 1) return false;
  if ($cursor.index(depths.row) !== row.childCount - 1) return false;

  const blockDepth = depths.cell + 1;
  if ($cursor.depth !== blockDepth) return false;

  const blockIndex = $cursor.index(depths.cell);
  const currentBlock = $cursor.node(blockDepth);
  if (
    blockIndex === 0
    || blockIndex !== cell.childCount - 1
    || currentBlock.type.name !== 'paragraph'
    || currentBlock.content.size !== 0
    || $cursor.parentOffset !== 0
    || cell.child(blockIndex - 1).textContent.length === 0
  ) {
    return false;
  }

  const paragraph = state.schema.nodes.paragraph?.create();
  if (!paragraph) return false;
  if (!dispatch) return true;

  const emptyParagraphFrom = $cursor.before(blockDepth);
  const emptyParagraphTo = $cursor.after(blockDepth);
  const tableEnd = $cursor.after(depths.table);
  const transaction = state.tr.delete(emptyParagraphFrom, emptyParagraphTo);
  const exitPosition = transaction.mapping.map(tableEnd);

  transaction
    .insert(exitPosition, paragraph)
    .setSelection(TextSelection.create(transaction.doc, exitPosition + 1))
    .scrollIntoView();
  dispatch(transaction);
  return true;
}

export const TableDoubleEnterExit = Extension.create({
  name: 'menghanTableDoubleEnterExit',
  priority: 1_000,
  addKeyboardShortcuts() {
    return {
      Enter: () => exitTableOnSecondEnter(
        this.editor.state,
        transaction => this.editor.view.dispatch(transaction),
      ),
    };
  },
});
