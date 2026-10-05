import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-code-block-shortcuts');
const outFile = path.join(outDir, 'code-block-shortcuts.cjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'codeBlockShortcuts.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const require = createRequire(import.meta.url);
const { getCurrentCodeBlockTextRange } = require(outFile);
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    codeBlock: { content: 'text*', group: 'block', code: true },
    paragraph: { content: 'inline*', group: 'block' },
  },
});
const source = 'const answer = 42;';
const codeBlock = schema.nodes.codeBlock.create(null, schema.text(source));
const paragraph = schema.nodes.paragraph.create(null, schema.text('outside code'));
const documentNode = schema.nodes.doc.create(null, [codeBlock, paragraph]);

const selectionInsideCode = TextSelection.create(documentNode, 4);
const range = getCurrentCodeBlockTextRange(selectionInsideCode);
assert.deepEqual(range, { from: 1, to: source.length + 1 });
assert.equal(documentNode.textBetween(range.from, range.to, '\n'), source);

const selectionOutsideCode = TextSelection.create(documentNode, codeBlock.nodeSize + 2);
assert.equal(getCurrentCodeBlockTextRange(selectionOutsideCode), null);

console.log('Code block shortcut verification passed');
