import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getSchema } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { JSDOM } from 'jsdom';

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-writeback-bundle.mjs');
const schema = getSchema([StarterKit, Link]);
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const documentJson = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading text' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Before ' },
        { type: 'text', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }], text: 'linked' },
        { type: 'text', text: ' after' },
      ],
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List item' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] }] },
    { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'const value = 1;' }] },
  ],
};

function locateTextRange(doc, text) {
  let range = null;
  doc.descendants((node, position) => {
    if (range || !node.isText || !node.text) return;
    const offset = node.text.indexOf(text);
    if (offset >= 0) range = { from: position + offset, to: position + offset + text.length };
  });
  assert.ok(range, `Fixture text not found: ${text}`);
  return range;
}

function createHarness(selectionRange, source = documentJson) {
  const doc = schema.nodeFromJSON(source);
  const editor = {
    schema,
    state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, selectionRange.from, selectionRange.to) }),
    view: {
      coordsAtPos: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
      dispatch: (transaction) => {
        editor.state = editor.state.apply(transaction);
      },
    },
  };
  return editor;
}

function createSnapshot(actions, editor, expansion = false) {
  const factory = expansion ? actions.createSelectionExpansionSnapshot : actions.createSelectionSnapshot;
  const snapshot = factory({ editor, editorSessionId: 'editor-fixture', currentPath: 'fixtures.md', docRevision: 0 });
  assert.ok(snapshot, 'Fixture must create a selection snapshot.');
  return snapshot;
}

function replaceAndAssertStructure(actions, text, replacement, expectedBlockType) {
  const initialDoc = schema.nodeFromJSON(documentJson);
  const editor = createHarness(locateTextRange(initialDoc, text));
  const snapshot = createSnapshot(actions, editor);
  const before = actions.createDocumentStructureSignature(editor.state.doc);
  assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'inline-text', `${expectedBlockType} should permit bounded inline replacement.`);
  actions.replaceSelectionWithText(editor, snapshot, replacement);
  assert.equal(actions.createDocumentStructureSignature(editor.state.doc), before, `${expectedBlockType} structure must survive replacement.`);
  assert.equal(editor.state.doc.textContent.includes(replacement), true, `${expectedBlockType} replacement must be written.`);
}

try {
  await fs.rm(bundlePath, { force: true });
  await build({
    entryPoints: [path.join(rootDir, 'src', 'editor', 'selectionActions.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  });
  const actions = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  replaceAndAssertStructure(actions, 'Heading text', 'Updated heading', 'heading');
  replaceAndAssertStructure(actions, 'List item', 'Updated list item', 'list');
  replaceAndAssertStructure(actions, 'Quoted text', 'Updated quotation', 'blockquote');
  replaceAndAssertStructure(actions, 'const value = 1;', 'const value = 2;', 'code block');

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const editor = createHarness(locateTextRange(initialDoc, 'Heading text'));
    const snapshot = createSnapshot(actions, editor);
    assert.deepEqual(snapshot.structure.headingPath.map((heading) => heading.text), ['Heading text'], 'The snapshot must retain the enclosing heading path for later saved-note location.');
    assert.deepEqual(snapshot.structure.blockKinds, [], 'A text-only inline selection must not pretend to contain block nodes.');
  }

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const editor = createHarness(locateTextRange(initialDoc, 'linked'));
    const snapshot = createSnapshot(actions, editor);
    assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'inline-text', 'A uniformly marked link selection should be replaceable.');
    actions.replaceSelectionWithText(editor, snapshot, 'updated link');
    let foundLink = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'updated link') foundLink = node.marks.some((mark) => mark.type.name === 'link');
    });
    assert.equal(foundLink, true, 'Replacement text must retain the uniform link mark.');
  }

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const from = locateTextRange(initialDoc, 'Before').from;
    const to = locateTextRange(initialDoc, 'linked').to;
    const editor = createHarness({ from, to });
    const snapshot = createSnapshot(actions, editor);
    assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'copy-only', 'Mixed plain and link marks must not receive a lossy replacement.');
    assert.equal(snapshot.structure.writeback.code, 'mixed-marks');
    assert.throws(() => actions.replaceSelectionWithText(editor, snapshot, 'replacement'), /复制建议/u);
  }

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const from = locateTextRange(initialDoc, 'Heading text').from;
    const to = locateTextRange(initialDoc, 'Before').to;
    const editor = createHarness({ from, to });
    const snapshot = createSnapshot(actions, editor, true);
    assert.equal(snapshot.structure.selectionKind, 'cross-block');
    assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'block-markdown', 'Cross-block expansion must use the constrained Markdown writer.');
    actions.replaceSelectionWithText(editor, snapshot, '## Expanded heading\n\nExpanded opening paragraph.');
    assert.equal(editor.state.doc.textContent.includes('Expanded heading'), true, 'Cross-block replacement must write the Markdown heading.');
    assert.equal(editor.state.doc.textContent.includes('Expanded opening paragraph.'), true, 'Cross-block replacement must write the Markdown paragraph.');
    assert.equal(editor.state.doc.textContent.includes('linked after'), true, 'Content outside the cross-block selection must remain intact.');
    assert.equal(editor.state.doc.textContent.includes('List item'), true, 'Following blocks outside the selection must remain intact.');
  }

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const from = locateTextRange(initialDoc, 'Heading text').from;
    const to = locateTextRange(initialDoc, 'linked').to;
    const editor = createHarness({ from, to });
    const snapshot = createSnapshot(actions, editor, true);
    assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'block-markdown', 'Formatted expansion supports links without flattening them.');
    assert.equal(actions.getSelectionWritebackCapability(snapshot, false).mode, 'copy-only', 'Plain-text actions still cannot replace cross-block links.');
    actions.replaceSelectionWithMarkdown(editor, snapshot, '## Expanded heading\n\nBefore [linked](https://example.com)');
    assert.ok(editor.state.doc.textContent.includes(' after'), 'Unselected suffix must survive formatted replacement.');
    assert.ok(editor.state.doc.toJSON().content[1].content.some((node) => node.marks?.some((mark) => mark.type === 'link' && mark.attrs.href === 'https://example.com')), JSON.stringify(editor.state.doc.toJSON()));
  }

  {
    const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const source = { type: 'doc', content: [paragraph('保留前文。'), paragraph('这份文档形成四层数据：'),
      { type: 'orderedList', attrs: { start: 1 }, content: ['原始文档', '向量索引', '实体关系', '跨文档索引'].map((text) => ({ type: 'listItem', content: [paragraph(text)] })) },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '保留后文' }] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const untouched = 1;' }] }] };
    const doc = schema.nodeFromJSON(source);
    const editor = createHarness({ from: locateTextRange(doc, '这份文档').from, to: locateTextRange(doc, '跨文档索引').to }, source);
    const snapshot = createSnapshot(actions, editor, true);
    const markdown = '这份文档形成四层数据：\n\n1. **原始文档**与 `Parent/Child Chunk`；\n2. **向量索引**和关键词索引；\n3. **实体关系**及 Evidence；\n4. **跨文档索引**与 Canonical Entity。';
    actions.replaceSelectionWithMarkdown(editor, snapshot, markdown);
    const result = editor.state.doc.toJSON();
    assert.equal(result.content[0].content[0].text, '保留前文。');
    const list = result.content.find((node) => node.type === 'orderedList');
    assert.equal(list.content.length, 4, 'The four list items must remain distinct');
    assert.ok(list.content[0].content[0].content.some((node) => node.marks?.some((mark) => mark.type === 'bold')));
    assert.ok(list.content[0].content[0].content.some((node) => node.marks?.some((mark) => mark.type === 'code')));
    assert.deepEqual(result.content.at(-2), doc.toJSON().content.at(-2), 'The following heading must remain unchanged');
    assert.deepEqual(result.content.at(-1), doc.toJSON().content.at(-1), 'Code outside the selection must remain unchanged');
    const insertedEditor = createHarness({ from: snapshot.from, to: snapshot.to }, source);
    const insertedSnapshot = createSnapshot(actions, insertedEditor, true);
    actions.insertMarkdownBelowSelection(insertedEditor, insertedSnapshot, markdown);
    const inserted = insertedEditor.state.doc.toJSON();
    assert.equal(inserted.content.filter((node) => node.type === 'orderedList').length, 2, 'Insert below preserves the original list');
    assert.equal(inserted.content.at(-3).type, 'orderedList', 'Insert after the last selected list, before the following heading');
  }

  {
    const source = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留前缀 ' }, { type: 'text', text: '原文重点', marks: [{ type: 'bold' }] }, { type: 'text', text: ' 和说明 保留后缀' }] }] };
    const doc = schema.nodeFromJSON(source);
    const editor = createHarness({ from: locateTextRange(doc, '原文重点').from, to: locateTextRange(doc, ' 和说明').to }, source);
    const snapshot = createSnapshot(actions, editor, true);
    assert.equal(actions.getSelectionWritebackCapability(snapshot, false).mode, 'copy-only');
    actions.replaceSelectionWithMarkdown(editor, snapshot, '**原文重点**和 `补充说明`');
    assert.equal(editor.state.doc.textContent, '保留前缀 原文重点和 补充说明 保留后缀');
    assert.ok(editor.state.doc.toJSON().content[0].content.some((node) => node.marks?.some((mark) => mark.type === 'code')));
  }

  {
    const doc = schema.nodeFromJSON(documentJson);
    const editor = createHarness(locateTextRange(doc, 'const value = 1;'));
    const snapshot = createSnapshot(actions, editor, true);
    actions.replaceSelectionWithMarkdown(editor, snapshot, '```typescript\nconst html = "<div>";\n```');
    assert.equal(editor.state.doc.lastChild.textContent, 'const html = "<div>";', 'Code fences must not become literal code content or lose angle brackets');
  }

  {
    const source = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '第一行' }, { type: 'hardBreak' }, { type: 'text', text: '第二行' },
    ] }] };
    const doc = schema.nodeFromJSON(source);
    const editor = createHarness({ from: 1, to: doc.content.size - 1 }, source);
    const snapshot = createSnapshot(actions, editor, true);
    assert.equal(actions.getSelectionWritebackCapability(snapshot).mode, 'block-markdown');
    actions.replaceSelectionWithMarkdown(editor, snapshot, '**第一行**补充说明  \n*第二行*补充说明和 ~~旧措辞~~');
    const nodes = editor.state.doc.firstChild.content.content;
    assert.ok(nodes.some((node) => node.type.name === 'hardBreak'), 'Explicit Markdown line breaks survive replacement');
    for (const name of ['bold', 'italic', 'strike']) assert.ok(nodes.some((node) => node.marks.some((mark) => mark.type.name === name)), `${name} survives replacement`);
  }

  {
    const initialDoc = schema.nodeFromJSON(documentJson);
    const range = locateTextRange(initialDoc, 'linked');
    const editor = createHarness(range);
    const snapshot = createSnapshot(actions, editor);
    const changedSource = structuredClone(documentJson);
    changedSource.content[1].content[1].marks[0].attrs.href = 'https://changed.example.com';
    const changedDoc = schema.nodeFromJSON(changedSource);
    editor.state = EditorState.create({ schema, doc: changedDoc, selection: TextSelection.create(changedDoc, range.from, range.to) });
    assert.equal(actions.isSelectionSnapshotCurrent({ editor, snapshot, editorSessionId: 'editor-fixture', currentPath: 'fixtures.md', docRevision: 0 }), false, 'A same-text mark change must invalidate the snapshot.');
  }

  console.log('Selection edit writeback verification passed');
} finally {
  await fs.rm(bundlePath, { force: true });
}
