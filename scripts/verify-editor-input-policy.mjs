import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { closeHistory } from '@tiptap/pm/history';

const staging = path.resolve('.package-staging');
await fs.mkdir(staging, { recursive: true });
const temporary = await fs.mkdtemp(path.join(staging, 'editor-input-policy-'));
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ClipboardEvent = dom.window.ClipboardEvent ?? class extends dom.window.Event {};
let editor;
try {
  const bundle = path.join(temporary, 'policy.mjs');
  await build({ stdin: { contents: "export * from './src/editor/runtimeInputRules';export * from './src/editor/pastePolicy';export {htmlToMarkdown,contentToEditorHtml} from './src/utils/markdown';", resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  const { RuntimeEditorPreferences, withRuntimeInputRules, pasteLiteralText, pasteClipboardText, clipboardPlainText, htmlToMarkdown, contentToEditorHtml } = await import(pathToFileURL(bundle).href);
  editor = new Editor({ element: document.body.appendChild(document.createElement('div')), extensions: [
    RuntimeEditorPreferences,
    StarterKit.extend({ addExtensions() { return (this.parent?.() ?? []).map(child => withRuntimeInputRules(child)); } }).configure({}),
    TaskList, withRuntimeInputRules(TaskItem), Table, TableRow, TableCell, TableHeader,
  ], editorProps: { handleScrollToSelection: () => true }, content: '<p></p>' });
  const type = text => {
    for (const character of text) {
      const { from, to } = editor.state.selection;
      if (!editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, character))) editor.view.dispatch(editor.state.tr.insertText(character));
    }
  };
  const reset = (html = '<p></p>') => { editor.commands.setContent(html, false); editor.commands.setTextSelection(1); };

  for (const [text, node] of [['# ', 'heading'], ['> ', 'blockquote'], ['- ', 'bulletList'], ['1. ', 'orderedList'], ['``` ', 'codeBlock'], ['[ ] ', 'taskList']]) {
    reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = true; type(text);
    assert.ok(editor.isActive(node), `Enabled rule ${text} -> ${node}`);
    reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = false; type(text);
    assert.equal(editor.state.doc.firstChild.type.name, 'paragraph', `Disabled rule ${text}`);
    assert.equal(editor.state.doc.textContent, text);
  }
  for (const [text, mark] of [['**粗体**', 'bold'], ['*斜体*', 'italic'], ['~~删除~~', 'strike'], ['`代码`', 'code']]) {
    reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = true; type(text);
    assert.ok(editor.state.doc.firstChild.firstChild.marks.some(value => value.type.name === mark), `Enabled mark ${text}`);
    reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = false; type(text);
    assert.equal(editor.state.doc.textContent, text);
    assert.equal(editor.state.doc.firstChild.firstChild.marks.length, 0);
  }
  reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = true; type('--- ');
  assert.equal(editor.state.doc.firstChild.type.name, 'horizontalRule');
  reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = false; type('--- ');
  assert.equal(editor.state.doc.textContent, '--- ');
  editor.storage.editorPreferences.editorMarkdownAutoConvert = true;
  for (const enabled of [true, false]) {
    reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = enabled; type('```');
    editor.view.someProp('handleKeyDown', handler => handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })));
    assert.equal(editor.isActive('codeBlock'), enabled, 'Fence Enter follows the live preference');
    reset(); editor.view.dispatch(editor.state.tr.insertText('# '));
    editor.view.someProp('handleDOMEvents', handlers => handlers.compositionend?.(editor.view, new dom.window.CompositionEvent('compositionend')));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(editor.isActive('heading'), enabled, 'Composition end follows the live preference');
  }
  editor.storage.editorPreferences.editorMarkdownAutoConvert = true;
  const literal = '# 标题\n**字面文字**\n<b>字面 HTML</b> &copy;';
  reset(); pasteLiteralText(editor, literal);
  assert.equal(editor.state.doc.childCount, 3);
  const serialized = htmlToMarkdown(editor.getHTML(), '');
  editor.commands.setContent(contentToEditorHtml(serialized), false);
  assert.deepEqual([...Array(editor.state.doc.childCount)].map((_, i) => editor.state.doc.child(i).textContent), literal.split('\n'));
  assert.equal(editor.state.doc.firstChild.type.name, 'paragraph');
  assert.equal(editor.state.doc.child(1).firstChild.marks.length, 0);
  reset('<pre><code>原代码</code></pre>'); pasteLiteralText(editor, '# 一行\n**二行**');
  assert.equal(editor.state.doc.firstChild.type.name, 'codeBlock');
  assert.match(editor.state.doc.textContent, /^# 一行\n\*\*二行\*\*/);
  reset('<table><tbody><tr><td><p>单元格</p></td></tr></tbody></table>'); editor.commands.setTextSelection(4);
  pasteLiteralText(editor, '第一行\n第二行'); assert.equal(editor.state.doc.firstChild.type.name, 'table');
  assert.equal(editor.state.doc.firstChild.firstChild.childCount, 1); assert.match(editor.state.doc.textContent, /第一行第二行/);
  reset(); editor.view.dispatch(closeHistory(editor.state.tr)); const before = editor.state.doc; pasteClipboardText(editor, { text: '**普通文字**', html: '<p><strong>普通文字</strong></p>' }, 'plain-text');
  assert.equal(editor.state.doc.textContent, '**普通文字**'); assert.equal(editor.state.doc.firstChild.firstChild.marks.length, 0);
  editor.commands.undo(); assert.ok(editor.state.doc.eq(before), 'Literal paste is undoable');
  const markdown = '- **大约7—8年一次大换代**：平台更新。\n\n- **大约4—5年一次中期改款**：外观调整。\n\n比如A8现在是**第四代D5**。\n\n---\n\n## 年款说明';
  reset(); editor.view.dispatch(closeHistory(editor.state.tr)); const beforeMarkdown = editor.state.doc;
  pasteClipboardText(editor, { text: markdown, html: '' }, 'preserve-format');
  assert.equal(editor.state.doc.firstChild.type.name, 'bulletList', 'Markdown paste creates a real list');
  assert.equal(editor.state.doc.firstChild.childCount, 2);
  assert.match(editor.getHTML(), /<strong>第四代D5<\/strong>/);
  assert.match(editor.getHTML(), /<hr/);
  assert.match(editor.getHTML(), /<h2>年款说明<\/h2>/);
  const formattedMarkdown = editor.state.doc;
  const savedMarkdown = htmlToMarkdown(editor.getHTML());
  editor.commands.undo(); assert.ok(editor.state.doc.eq(beforeMarkdown), 'Markdown paste is one undo step');
  editor.commands.redo(); assert.ok(editor.state.doc.eq(formattedMarkdown), 'Markdown paste can be redone');
  editor.commands.setContent(contentToEditorHtml(savedMarkdown), false);
  assert.ok(editor.state.doc.eq(formattedMarkdown), 'Markdown paste formatting survives save and reload');
  reset(); pasteClipboardText(editor, { text: '**网页复制的原始Markdown**', html: '<p><span>**网页复制的原始Markdown**</span></p>' }, 'preserve-format');
  assert.equal(editor.state.doc.textContent, '网页复制的原始Markdown', 'Plain HTML wrappers do not hide Markdown');
  assert.equal(editor.state.doc.firstChild.firstChild.marks[0].type.name, 'bold');
  reset(); pasteClipboardText(editor, { text: '**另一个文本版本**', html: '<p><em>保留富文本</em></p>' }, 'preserve-format');
  assert.equal(editor.state.doc.textContent, '保留富文本', 'Existing rich clipboard HTML takes precedence');
  assert.equal(editor.state.doc.firstChild.firstChild.marks[0].type.name, 'italic');
  reset(); pasteClipboardText(editor, { text: '- [x] 完成\n- [ ] 待办\n\n| 项目 | 年款 |\n| --- | --- |\n| A8 | 2026 |\n\n```js\nconst value = "**源码**";\n```', html: '' }, 'preserve-format');
  assert.equal(editor.state.doc.firstChild.type.name, 'taskList');
  assert.equal(editor.state.doc.firstChild.firstChild.attrs.checked, true);
  assert.ok([...Array(editor.state.doc.childCount)].some((_, i) => editor.state.doc.child(i).type.name === 'table'));
  const pastedCode = editor.state.doc.lastChild;
  assert.equal(pastedCode.type.name, 'codeBlock');
  assert.equal(pastedCode.attrs.language, 'js');
  assert.equal(pastedCode.textContent.trimEnd(), 'const value = "**源码**";');
  reset('<p>前面替换后面</p>'); editor.commands.setTextSelection({ from: 3, to: 5 });
  pasteClipboardText(editor, { text: '**新内容**', html: '' }, 'preserve-format');
  assert.equal(editor.state.doc.textContent, '前面新内容后面', 'Paste replaces only the selected text');
  assert.match(editor.getHTML(), /前面<strong>新内容<\/strong>后面/);
  for (const mode of ['preserve-format', 'plain-text']) {
    reset('<pre><code>原代码</code></pre>');
    pasteClipboardText(editor, { text: markdown, html: '' }, mode);
    assert.equal(editor.state.doc.firstChild.type.name, 'codeBlock');
    assert.ok(editor.state.doc.textContent.startsWith(markdown), 'Source blocks keep Markdown literal');
  }
  reset(); editor.storage.editorPreferences.editorMarkdownAutoConvert = false;
  pasteClipboardText(editor, { text: markdown, html: '' }, 'preserve-format');
  assert.equal(editor.state.doc.firstChild.type.name, 'paragraph');
  assert.ok(editor.state.doc.textContent.includes('**第四代D5**'), 'Disabled Markdown conversion keeps source');
  assert.doesNotMatch(editor.getHTML(), /<strong>|<ul>|<hr|<h2>/);
  editor.storage.editorPreferences.editorMarkdownAutoConvert = true;
  reset(); pasteClipboardText(editor, { text: '普通文字\n路径 C:\\Notes\\a_b.md\n2 * 3 = 6', html: '' }, 'preserve-format');
  assert.equal(editor.state.doc.textContent, '普通文字路径 C:\\Notes\\a_b.md2 * 3 = 6');
  assert.doesNotMatch(editor.getHTML(), /<em>|<strong>/);
  assert.equal(clipboardPlainText({ text: '', html: '<p>第一行</p><p>第二行</p>' }), '第一行\n第二行\n');
  console.log('Editor input policy verified: runtime rules, Markdown paste/roundtrip/undo, rich/plain clipboard priority, source blocks and live preference.');
} finally {
  editor?.destroy(); dom.window.close();
  assert.equal(path.dirname(temporary), staging);
  await fs.rm(temporary, { recursive: true, force: true });
}
