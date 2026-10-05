import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-block-boundary');
const outFile = path.join(outDir, 'blockBoundary.mjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'blockBoundary.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@tiptap/core', '@tiptap/pm/state'],
});

const {
  appendTrailingParagraph,
  deleteBoundaryBlockAtStart,
} = await import(pathToFileURL(outFile).href);

const schema = getSchema([
  StarterKit,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
]);

const boundaryFixtures = [
  {
    name: 'code block',
    node: { type: 'codeBlock', content: [{ type: 'text', text: 'const ready = true;' }] },
  },
  {
    name: 'quote',
    node: {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用内容' }] }],
    },
  },
  {
    name: 'table',
    node: {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1-1' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1-2' }] }] },
        ],
      }],
    },
  },
];

function firstTextblockPosition(document) {
  if (document.firstChild?.isTextblock) return 1;

  let result = -1;
  document.firstChild?.descendants((node, position) => {
    if (result < 0 && node.isTextblock) result = position + 2;
  });
  assert.notEqual(result, -1, 'Fixture must expose a first editable position.');
  return result;
}

for (const fixture of boundaryFixtures) {
  const document = schema.nodeFromJSON({
    type: 'doc',
    content: [fixture.node, { type: 'paragraph' }],
  });
  let state = EditorState.create({
    doc: document,
    selection: TextSelection.create(document, firstTextblockPosition(document)),
  });
  const handled = deleteBoundaryBlockAtStart(state, transaction => {
    state = state.apply(transaction);
  });
  assert.equal(handled, true, `${fixture.name} must be removable from its first cursor position.`);
  assert.equal(state.doc.childCount, 1, `${fixture.name} deletion must remove the complete top-level block.`);
  assert.equal(state.doc.firstChild?.type.name, 'paragraph');
  assert.equal(state.selection.$from.parent.type.name, 'paragraph');

  const blockOnlyDocument = schema.nodeFromJSON({ type: 'doc', content: [fixture.node] });
  const blockOnlyState = EditorState.create({ doc: blockOnlyDocument });
  const trailingTransaction = appendTrailingParagraph(blockOnlyState);
  assert.ok(trailingTransaction, `${fixture.name} must receive a trailing paragraph at the end of the note.`);
  const stateWithTrailingParagraph = blockOnlyState.apply(trailingTransaction);
  assert.equal(stateWithTrailingParagraph.doc.lastChild?.type.name, 'paragraph');
  assert.equal(appendTrailingParagraph(stateWithTrailingParagraph), null, 'Trailing paragraphs must not duplicate.');
}

const interiorCodeDocument = schema.nodeFromJSON({
  type: 'doc',
  content: [boundaryFixtures[0].node, { type: 'paragraph' }],
});
const interiorCodeState = EditorState.create({
  doc: interiorCodeDocument,
  selection: TextSelection.create(interiorCodeDocument, 2),
});
assert.equal(
  deleteBoundaryBlockAtStart(interiorCodeState),
  false,
  'Backspace inside block content must retain normal text deletion.',
);

console.log('Block boundary verification passed');
