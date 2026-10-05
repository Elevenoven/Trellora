import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getSchema } from '@tiptap/core';
import { splitBlock } from '@tiptap/pm/commands';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-table-double-enter');
const outFile = path.join(outDir, 'tableDoubleEnterExit.mjs');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'tableDoubleEnterExit.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@tiptap/core', '@tiptap/pm/state'],
});

const { exitTableOnSecondEnter } = await import(pathToFileURL(outFile).href);
const schema = getSchema([
  StarterKit,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
]);

function tableDocument(lastCellBlocks = [{ type: 'paragraph', content: [{ type: 'text', text: '最后一个文字' }] }]) {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一列' }] }] },
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二列' }] }] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容' }] }] },
            { type: 'tableCell', content: lastCellBlocks },
          ],
        },
      ],
    }],
  });
}

function findTextEnd(document, text) {
  let result = -1;
  document.descendants((node, position) => {
    if (node.isText && node.text === text) result = position + node.nodeSize;
  });
  assert.notEqual(result, -1, `Missing text fixture: ${text}`);
  return result;
}

function findEmptyParagraphPosition(document) {
  let result = -1;
  document.descendants((node, position) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) result = position + 1;
  });
  assert.notEqual(result, -1, 'Missing trailing empty paragraph fixture.');
  return result;
}

function applyCommand(state, command) {
  let nextState = state;
  const handled = command(state, transaction => {
    nextState = state.apply(transaction);
  });
  return { handled, state: nextState };
}

const initialDocument = tableDocument();
let state = EditorState.create({
  doc: initialDocument,
  selection: TextSelection.create(initialDocument, findTextEnd(initialDocument, '最后一个文字')),
});
assert.equal(
  exitTableOnSecondEnter(state),
  false,
  'The first Enter at the end of text must keep Tiptap\'s normal in-cell split behavior.',
);

let commandResult = applyCommand(state, splitBlock);
assert.equal(commandResult.handled, true, 'The first Enter must create an empty paragraph in the last cell.');
state = commandResult.state;
assert.equal(state.selection.$from.parent.type.name, 'paragraph');
assert.equal(state.selection.$from.parent.content.size, 0);

commandResult = applyCommand(state, exitTableOnSecondEnter);
assert.equal(commandResult.handled, true, 'The second Enter must exit the bottom-right cell.');
state = commandResult.state;
assert.equal(state.doc.childCount, 2, 'The editor must contain the table followed by a paragraph.');
assert.equal(state.doc.lastChild?.type.name, 'paragraph');
assert.equal(state.selection.$from.depth, 1, 'The cursor must be in a top-level paragraph.');
assert.equal(state.selection.$from.parent, state.doc.lastChild);
const lastCell = state.doc.firstChild?.lastChild?.lastChild;
assert.equal(lastCell?.childCount, 1, 'The temporary empty paragraph must be removed from the cell.');
assert.equal(lastCell?.textContent, '最后一个文字');

const nonLastCellDoc = schema.nodeFromJSON({
  type: 'doc',
  content: [{
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [
        {
          type: 'tableCell',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '不是末格' }] },
            { type: 'paragraph' },
          ],
        },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '末格' }] }] },
      ],
    }],
  }],
});
const nonLastCellState = EditorState.create({
  doc: nonLastCellDoc,
  selection: TextSelection.create(nonLastCellDoc, findEmptyParagraphPosition(nonLastCellDoc)),
});
assert.equal(
  exitTableOnSecondEnter(nonLastCellState),
  false,
  'An empty paragraph in a non-final cell must keep normal in-cell Enter behavior.',
);

const emptyLastCellDoc = tableDocument([{ type: 'paragraph' }]);
const emptyLastCellState = EditorState.create({
  doc: emptyLastCellDoc,
  selection: TextSelection.create(emptyLastCellDoc, findEmptyParagraphPosition(emptyLastCellDoc)),
});
assert.equal(
  exitTableOnSecondEnter(emptyLastCellState),
  false,
  'A previously empty last cell must not exit on a single Enter.',
);

console.log('Table double-Enter verification passed');
