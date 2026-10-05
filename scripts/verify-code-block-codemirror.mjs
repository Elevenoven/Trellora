import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), 'utf8');

const nodeView = read('src', 'editor', 'CodeMirrorCodeBlockNodeView.ts');
const extension = read('src', 'editor', 'markdownCodeBlock.ts');
const editor = read('src', 'components', 'Editor.tsx');
const main = read('src', 'main.tsx');
const styles = read('src', 'styles', 'codeBlockEditor.css');
const variables = read('src', 'styles', 'variables.css');

assert.match(nodeView, /class CodeMirrorCodeBlockNodeView implements NodeView/,
  'Regular code blocks must use a standalone CodeMirror NodeView rather than a hidden ProseMirror contentDOM.');
assert.match(nodeView, /new CodeMirrorView\(/,
  'The NodeView must create a real CodeMirror editor instance.');
assert.match(nodeView, /const codeMirrorLanguageExtensions: Partial<Record<string, \(\) => Extension>>/,
  'The Markdown fence language must select from the supported CodeMirror language parsers.');
assert.match(nodeView, /typescript: \(\) => javascript\(\{ jsx: true, typescript: true \}\)/,
  'TypeScript fenced blocks must load a TypeScript-aware parser.');
assert.match(nodeView, /StateEffect\.reconfigure\.of/,
  'Changing a fenced language must reconfigure the existing CodeMirror instance.');
assert.match(nodeView, /if \(isMermaidCodeBlock\(node\)\) return false;/,
  'Switching a regular code block to Mermaid must recreate its dedicated diagram NodeView.');
assert.match(nodeView, /transaction\.insertText\(inserted\.toString\(\), offset \+ fromA, offset \+ toA\)/,
  'CodeMirror changes must be written back to the Tiptap document.');
assert.match(nodeView, /TextSelection\.create\(transaction\.doc, from, to\)/,
  'CodeMirror selection changes must keep the outer editor selection aligned.');
assert.match(nodeView, /indentWithTab/,
  'Tab inside a code block must indent code instead of moving focus.');
assert.match(nodeView, /maybeEscape\('line', -1\)/,
  'Arrow keys at a code-block boundary must be able to return to the rich-text editor.');
assert.match(nodeView, /exitCode\(/,
  'Mod+Enter must preserve the existing escape-from-code-block behavior.');
assert.match(nodeView, /header\.append\(this\.languageLabel\)/,
  '代码块标题只能保留左侧可读语言名。');
assert.doesNotMatch(nodeView, /const value = document\.createElement\('span'\)/,
  '代码块标题不能再渲染右侧重复的语言值。');

assert.match(extension, /isMermaidCodeBlock\(props\.node\)/,
  'Mermaid blocks must retain their dedicated React diagram NodeView.');
assert.match(extension, /createCodeMirrorCodeBlockNodeView\(props\.node, props\.view, props\.getPos\)/,
  'Only non-Mermaid code blocks may use the CodeMirror NodeView.');
assert.match(extension, /if \(!isMermaidCodeBlock\(newNode\)\) return false;/,
  'Switching a Mermaid block back to regular code must recreate the CodeMirror NodeView.');
assert.match(editor, /\[data-code-block\], pre/,
  'The language picker must discover both the new CodeMirror wrapper and legacy pre elements.');
assert.match(editor, /code: 'pre:not\(\.mermaid-editor-source\), \.code-block-node-view'/,
  'Markdown line navigation must recognize the new CodeMirror wrapper without duplicating Mermaid source blocks.');
assert.match(editor, /moveActiveCodeLanguageOption/,
  'The code-language picker must provide keyboard navigation for its matching language options.');
assert.match(editor, /event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'/,
  'ArrowUp and ArrowDown in the code-language input must move the active language option.');
assert.match(editor, /applyCodeLanguage\(activeCodeLanguageOption\?\.value \?\? event\.currentTarget\.value\)/,
  'Enter must apply the language currently highlighted by keyboard navigation.');
assert.doesNotMatch(editor, /\.slice\(0, 6\)/,
  '代码语言选择器不能只显示前六项。');
assert.match(main, /import '\.\/styles\/codeBlockEditor\.css'/,
  'The CodeMirror code-block styles must be bundled with the renderer.');
assert.match(styles, /\.ProseMirror \.code-block-node-view \{/,
  'The CodeMirror NodeView must have an isolated code-block container style.');
assert.match(styles, /\.cm-gutters/,
  'The CodeMirror line-number gutter must be styled for the app theme.');
assert.match(variables, /\.code-language-options\s*\{[\s\S]*?overflow-y: scroll;/,
  '完整代码语言列表必须提供可见的纵向滚动条。');

console.log('CodeMirror code-block verification passed');
