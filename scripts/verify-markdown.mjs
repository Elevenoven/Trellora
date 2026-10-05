import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createDocument, getSchema } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-markdown');
const outFile = path.join(outDir, 'markdown.mjs');
const codeBlockOutFile = path.join(outDir, 'markdownCodeBlock.mjs');
const formulaBlockOutFile = path.join(outDir, 'formulaBlock.mjs');
const codeLanguagesOutFile = path.join(outDir, 'codeLanguages.mjs');
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'markdown-rendering');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

const frontmatterFile = path.join(outDir, 'frontmatter.mjs');
await build({ entryPoints: ['shared/frontmatter.ts'], outfile: frontmatterFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { parseNoteFrontmatter: matter } = await import(pathToFileURL(frontmatterFile).href);

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'markdown.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'markdownCodeBlock.ts')],
  outfile: codeBlockOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'formulaBlock.ts')],
  outfile: formulaBlockOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'codeLanguages.ts')],
  outfile: codeLanguagesOutFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

const {
  contentToEditorHtml,
  findMarkdownLineTarget,
  getMarkdownLineAnchors,
  htmlToMarkdown,
  isProbablyHtmlNote,
  markdownToHtml,
} = await import(pathToFileURL(outFile).href);
const {
  MarkdownCodeBlockLowlight,
  normalizePastedCodeBlockLanguages,
} = await import(pathToFileURL(codeBlockOutFile).href);
const { FormulaBlock, InlineFormula } = await import(pathToFileURL(formulaBlockOutFile).href);
const { normalizeCodeLanguage } = await import(pathToFileURL(codeLanguagesOutFile).href);

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
});

const metadataHeader = '\uFEFF---\r\n# 保留元数据注释\r\ntitle: GRAPHRAG存储\r\ntags:\r\n  - GraphRAG\r\n  - 实体消歧\r\nreviewed: false\r\n---\r\n';
const metadataSource = `${metadataHeader}\r\n# GRAPHRAG存储\n\n正文内容\n\n---\n\n后续正文\n`;
const metadataRoot = document.createElement('div');
metadataRoot.innerHTML = contentToEditorHtml(metadataSource);
assert.doesNotMatch(metadataRoot.textContent, /tags:|实体消歧|reviewed:/, 'Metadata must not appear in the editable body.');
assert.equal(metadataRoot.querySelectorAll('hr').length, 1, 'Body horizontal rules must remain visible.');
const metadataSchema = getSchema([StarterKit]);
const metadataDocument = createDocument(metadataRoot.innerHTML, metadataSchema);
const metadataSerializedRoot = document.createElement('div');
metadataSerializedRoot.appendChild(DOMSerializer.fromSchema(metadataSchema).serializeFragment(metadataDocument.content));
metadataSerializedRoot.querySelector('p').textContent = '编辑后的正文';
const metadataSaved = htmlToMarkdown(metadataSerializedRoot.innerHTML, metadataSource);
assert.ok(metadataSaved.startsWith(metadataHeader), 'Editing must preserve the exact metadata bytes, including BOM, comments and CRLF.');
assert.deepEqual(matter(metadataSaved).data, matter(metadataSource).data, 'Tags and other metadata must remain parseable after a real Tiptap round-trip.');
assert.match(matter(metadataSaved).content, /编辑后的正文/);
const metadataAnchors = getMarkdownLineAnchors(metadataSource);
const metadataHeadingLine = metadataSource.split(/\r?\n/).findIndex(line => line === '# GRAPHRAG存储') + 1;
assert.equal(metadataAnchors[0].line, metadataHeadingLine, 'Body anchors must retain the original source line numbers.');
assert.equal(metadataAnchors[0].kind, 'heading', 'Metadata must not produce editor or preview anchors.');
assert.equal(findMarkdownLineTarget(metadataSource, metadataRoot, metadataHeadingLine)?.textContent, 'GRAPHRAG存储');
assert.deepEqual(matter(htmlToMarkdown('<p>切换后的正文</p>', '---\ntags: [另一篇]\n---\n')).data.tags, ['另一篇'], 'Switching sources must use the new note metadata.');
assert.equal(contentToEditorHtml('---\ntags: [GraphRAG]\n---'), '', 'Metadata-only notes must have an empty editable body.');
assert.deepEqual(matter(htmlToMarkdown('<p>新增正文</p>', '---\ntags: [GraphRAG]\n---')).data.tags, ['GraphRAG'], 'A closing delimiter at EOF must remain valid when body text is added.');
assert.equal(htmlToMarkdown('<p>普通正文</p>', '# 无元数据\n'), htmlToMarkdown('<p>普通正文</p>'));
assert.match(contentToEditorHtml('---\ntags: [broken\n---\n# 正文'), /tags:/, 'Invalid metadata must stay visible for manual correction.');
assert.match(contentToEditorHtml('---\ntags: [GraphRAG]\n# 正文'), /tags:/, 'Unclosed metadata must stay visible for manual correction.');

const fullFeatureMarkdown = readFileSync(path.join(fixtureDir, 'full-feature.md'), 'utf8');
const fullFeatureHtml = markdownToHtml(fullFeatureMarkdown, {
  currentPath: 'C:\\Notes\\docs\\full-feature.md',
  libraryPath: 'C:\\Notes',
});
const fullFeatureRoot = document.createElement('div');
fullFeatureRoot.innerHTML = fullFeatureHtml;
assert.equal(fullFeatureRoot.querySelector('h1')?.textContent, 'Markdown 渲染全功能基线');
assert.equal(
  [...fullFeatureRoot.querySelectorAll('h2')].filter((heading) => heading.textContent === '重复标题').length,
  2,
);
assert.ok(fullFeatureRoot.querySelector('table'));
assert.equal(fullFeatureRoot.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]').length, 2);
assert.ok(
  [...fullFeatureRoot.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]')]
    .every((input) => !input.disabled),
  'Editor-mode Markdown conversion must keep task inputs editable.',
);
assert.ok(fullFeatureRoot.querySelector('code.language-ts'));
assert.ok(fullFeatureRoot.querySelector('code.language-mermaid'));
assert.equal(fullFeatureRoot.querySelector('a[data-wiki-link="产品设计"]')?.textContent, 'Trellora 产品设计');

const formulaEditorHtml = contentToEditorHtml('$$\nx^2 + y^2 = z^2\n$$\n');
assert.match(formulaEditorHtml, /data-type="formulaBlock"/, 'Display math must remain a dedicated editor block.');
assert.match(formulaEditorHtml, /<code>x\^2 \+ y\^2 = z\^2<\/code>/, 'Formula source must remain editable in the editor.');
assert.equal(
  htmlToMarkdown(formulaEditorHtml),
  '$$\nx^2 + y^2 = z^2\n$$\n',
  'A formula block must round-trip to standard display-math Markdown.',
);
const formulaSchema = getSchema([StarterKit.configure({ codeBlock: false }), FormulaBlock]);
const formulaDocument = createDocument(formulaEditorHtml, formulaSchema);
assert.equal(formulaDocument.firstChild?.type.name, 'formulaBlock', 'The editor must parse display math as a formula block.');
assert.equal(formulaDocument.firstChild?.textContent, 'x^2 + y^2 = z^2');
const serializedFormula = DOMSerializer.fromSchema(formulaSchema).serializeFragment(formulaDocument.content);
const serializedFormulaRoot = document.createElement('div');
serializedFormulaRoot.appendChild(serializedFormula);
const aiMathMarkdown = readFileSync(path.join(fixtureDir, 'ai-math-emphasis.md'), 'utf8');
const aiMathRoot = document.createElement('div');
aiMathRoot.innerHTML = contentToEditorHtml(aiMathMarkdown);
assert.equal(aiMathRoot.querySelectorAll('[data-type="formulaBlock"]').length, 2);
assert.equal(aiMathRoot.querySelectorAll('[data-type="inlineFormula"]').length, 11);
assert.ok([...aiMathRoot.querySelectorAll('strong')].some(node => node.textContent.includes('Modularity')));
assert.ok([...aiMathRoot.querySelectorAll('strong')].some(node => node.textContent === '局部移动（Local Moving）'));
assert.equal(aiMathRoot.querySelector('td strong')?.textContent.trim(), '模块度');
const aiMathSchema = getSchema([
  StarterKit, FormulaBlock, InlineFormula, Table, TableRow, TableCell, TableHeader,
]);
const aiMathDocument = createDocument(aiMathRoot.innerHTML, aiMathSchema);
const aiMathSerializedRoot = document.createElement('div');
aiMathSerializedRoot.appendChild(DOMSerializer.fromSchema(aiMathSchema).serializeFragment(aiMathDocument.content));
aiMathSerializedRoot.querySelector('h1').textContent += '（已编辑）';
const aiMathSaved = htmlToMarkdown(aiMathSerializedRoot.innerHTML, aiMathMarkdown);
for (const formula of aiMathRoot.querySelectorAll('[data-math-markdown]')) {
  assert.ok(aiMathSaved.includes(formula.dataset.mathMarkdown), 'An unrelated edit must keep the exact formula delimiters, whitespace and TeX source.');
}
const aiMathReopenedRoot = document.createElement('div');
aiMathReopenedRoot.innerHTML = contentToEditorHtml(aiMathSaved);
assert.equal(aiMathReopenedRoot.querySelectorAll('[data-type="inlineFormula"]').length, 11);
assert.equal(aiMathReopenedRoot.querySelectorAll('strong').length, aiMathRoot.querySelectorAll('strong').length);
const inlineToEdit = aiMathSerializedRoot.querySelector('[data-type="inlineFormula"] > code');
inlineToEdit.textContent = 'Q_{new}';
assert.ok(htmlToMarkdown(aiMathSerializedRoot.innerHTML).includes('$Q_{new}$'), 'Editing a formula must save the new source rather than the retained original.');
const protectedMath = [
  '价格 $5 and $10，预算 $20 USD $；转义 \\$x\\$。',
  '',
  '`$x$ ** 原文 **`',
  '',
  '```md',
  '$$',
  '\\frac{1}{2}',
  '$$',
  '** 原文 **',
  '```',
].join('\n');
const protectedMathRoot = document.createElement('div');
protectedMathRoot.innerHTML = contentToEditorHtml(protectedMath);
assert.equal(protectedMathRoot.querySelectorAll('[data-type="inlineFormula"], [data-type="formulaBlock"], strong').length, 0,
  'Currency, escaped delimiters and code examples must remain literal.');
assert.match(protectedMathRoot.querySelector('pre code').textContent, /\$\$\n\\frac\{1\}\{2\}\n\$\$/);
const complexStrongRoot = document.createElement('div');
complexStrongRoot.innerHTML = contentToEditorHtml('**示例 `$x$ **` 内容 **、***粗斜体***、**正常 *斜体* 加粗**、\\*\\*不加粗\\*\\*');
assert.equal(complexStrongRoot.querySelector('strong code')?.textContent, '$x$ **');
assert.equal(complexStrongRoot.querySelectorAll('strong em, em strong').length, 2);
assert.equal(complexStrongRoot.querySelectorAll('[data-type="inlineFormula"]').length, 0);
assert.equal(
  htmlToMarkdown(serializedFormulaRoot.innerHTML),
  '$$\nx^2 + y^2 = z^2\n$$\n',
  'A parsed formula block must persist its original display-math syntax.',
);
const hardBreakMarkdown = htmlToMarkdown('<p><strong>第一行</strong><br><em>第二行</em></p>');
assert.equal(hardBreakMarkdown, '**第一行**\\\n*第二行*\n', 'Explicit line breaks must survive Markdown whitespace cleanup.');
const hardBreakRoot = document.createElement('div');
hardBreakRoot.innerHTML = contentToEditorHtml(hardBreakMarkdown);
assert.equal(hardBreakRoot.querySelectorAll('br').length, 1, 'Reopening persisted Markdown must keep the explicit line break.');
assert.equal(
  fullFeatureRoot.querySelector('img[alt="相对图片"]')?.getAttribute('data-menghan-relative'),
  'images/fixture.png',
);
const fullFeatureAnchors = getMarkdownLineAnchors(fullFeatureMarkdown);
const englishHeadingLine = fullFeatureMarkdown.split(/\r?\n/).findIndex((line) => line === '## English Heading') + 1;
assert.equal(
  findMarkdownLineTarget(fullFeatureMarkdown, fullFeatureRoot, englishHeadingLine)?.textContent,
  'English Heading',
  'Source-line navigation must map to the matching rendered preview block.',
);
assert.equal(
  fullFeatureAnchors.filter((anchor) => anchor.kind === 'heading' && anchor.text === '重复标题').length,
  2,
  'The source-line baseline must distinguish duplicate headings even before DOM ids exist.',
);
for (const requiredAnchorKind of ['heading', 'paragraph', 'blockquote', 'listItem', 'code', 'thematicBreak', 'tableRow']) {
  assert.ok(
    [...fullFeatureAnchors, ...metadataAnchors].some((anchor) => anchor.kind === requiredAnchorKind),
    `The Markdown fixtures must exercise ${requiredAnchorKind} source-line anchors.`,
  );
}

const readonlyTaskRoot = document.createElement('div');
readonlyTaskRoot.innerHTML = markdownToHtml('- [ ] 待办\n- [x] 完成\n', { taskListMode: 'readonly' });
const readonlyTaskInputs = [...readonlyTaskRoot.querySelectorAll('input[type="checkbox"]')];
assert.equal(readonlyTaskRoot.querySelector('ul[data-type="taskList"]')?.getAttribute('data-task-mode'), 'readonly');
assert.ok(readonlyTaskInputs.every((input) => input.disabled), 'Readonly task inputs must be disabled.');
assert.deepEqual(readonlyTaskInputs.map((input) => input.getAttribute('aria-label')), ['未完成任务', '已完成任务']);

const tiptapHtml = `
<h1>标题</h1>
<p><strong>粗体</strong></p>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>待办</p></div></li>
  <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>已完成</p></div></li>
</ul>
<pre><code class="language-js">const name = "Trellora";
function hello() {
  console.log(name);
}</code></pre>
<table>
  <thead><tr><th>功能</th><th>状态</th></tr></thead>
  <tbody><tr><td>代码高亮</td><td>完成</td></tr></tbody>
</table>
<p><a href="menghan://wiki/B" data-wiki-link="B" data-wiki-alias="B 页面">B 页面</a></p>
`;

assert.equal(isProbablyHtmlNote(tiptapHtml), true);
assert.deepEqual(getMarkdownLineAnchors(tiptapHtml), [], 'Raw HTML notes must not expose Markdown source-line anchors.');

const lineAnchors = getMarkdownLineAnchors([
  '# 标题',
  '',
  '一段内容',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 引用内容',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| 功能 | 状态 |',
  '| --- | --- |',
  '| 行号 | 完成 |',
].join('\n'));
assert.deepEqual(
  lineAnchors.filter((anchor) => anchor.line === 5).map((anchor) => anchor.kind),
  ['listItem', 'paragraph'],
  'A list item and its paragraph must retain their shared source line so the renderer can keep only the first marker.',
);
assert.deepEqual(
  lineAnchors.filter((anchor) => anchor.line === 8).map((anchor) => anchor.kind),
  ['blockquote', 'paragraph'],
  'A blockquote and its paragraph must retain their shared source line for first-marker deduplication.',
);
assert.deepEqual(
  lineAnchors.filter((anchor) => anchor.kind === 'tableRow').map((anchor) => anchor.line),
  [14, 16],
  'Each rendered Markdown table row must keep its real source line.',
);

const markdown = htmlToMarkdown(tiptapHtml);
assert.match(markdown, /^# 标题/m);
assert.match(markdown, /\*\*粗体\*\*/);
assert.match(markdown, /- \[ \] 待办/);
assert.match(markdown, /- \[x\] 已完成/);
assert.match(markdown, /```js\nconst name = "Trellora";/);
assert.match(markdown, /\| 功能 \| 状态 \|/);
assert.match(markdown, /\| 代码高亮 \| 完成 \|/);
assert.match(markdown, /\[\[B\|B 页面\]\]/);

const tableSchema = getSchema([
  StarterKit,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
]);
const tableDocument = tableSchema.nodeFromJSON({
  type: 'doc',
  content: [{
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '功能' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '状态' }] }] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A | B' }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '完成' }] }] },
        ],
      },
    ],
  }],
});
const serializedTable = DOMSerializer.fromSchema(tableSchema).serializeFragment(tableDocument.content);
const serializedTableRoot = document.createElement('div');
serializedTableRoot.appendChild(serializedTable);
assert.match(serializedTableRoot.innerHTML, /<colgroup>/, 'Fixture must cover the real Tiptap table shape.');
assert.equal(
  htmlToMarkdown(serializedTableRoot.innerHTML),
  '| 功能 | 状态 |\n| --- | --- |\n| A \\| B | 完成 |\n',
  'A Tiptap table with colgroup must persist as a GFM pipe table.',
);

const emptyTableDocument = tableSchema.nodeFromJSON({
  type: 'doc',
  content: [{
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph' }] },
          { type: 'tableHeader', content: [{ type: 'paragraph' }] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [{ type: 'paragraph' }] },
          { type: 'tableCell', content: [{ type: 'paragraph' }] },
        ],
      },
    ],
  }],
});
const serializedEmptyTable = DOMSerializer.fromSchema(tableSchema).serializeFragment(emptyTableDocument.content);
const serializedEmptyTableRoot = document.createElement('div');
serializedEmptyTableRoot.appendChild(serializedEmptyTable);
assert.equal(
  htmlToMarkdown(serializedEmptyTableRoot.innerHTML),
  '|  |  |\n| --- | --- |\n|  |  |\n',
  'Empty paragraph cells must remain empty GFM cells instead of becoming preserved blank lines.',
);

const headerlessTable = '<table><colgroup><col><col></colgroup><tbody><tr><td><p>功能</p></td><td><p>状态</p></td></tr><tr><td><p>表格</p></td><td><p>完成</p></td></tr></tbody></table>';
assert.equal(
  htmlToMarkdown(headerlessTable),
  '| 功能 | 状态 |\n| --- | --- |\n| 表格 | 完成 |\n',
  'A simple legacy table must promote its first row to the required GFM header.',
);

const codeBlockInTable = '<table><tbody><tr><th><p>编号</p></th></tr><tr><td><pre><code>11</code></pre></td></tr></tbody></table>';
assert.equal(
  htmlToMarkdown(codeBlockInTable),
  '| 编号 |\n| --- |\n| 11 |\n',
  'A code block occupying a table cell must not serialize as a fenced block with literal <br> tags.',
);

const legacyTableCellRoot = document.createElement('div');
legacyTableCellRoot.innerHTML = markdownToHtml([
  '| ```<br><br>11<br><br>``` | ```<br><br>111<br><br>``` |',
  '| --- | --- |',
  '| ```<br><br>1<br><br>``` | ```<br><br>2<br><br>``` |',
].join('\n'));
assert.deepEqual(
  [...legacyTableCellRoot.querySelectorAll('th, td')].map((cell) => cell.textContent),
  ['11', '111', '1', '2'],
  'Existing malformed table-cell fences must render as their cell content.',
);
assert.equal(legacyTableCellRoot.querySelector('table code'), null,
  'Legacy table-cell fences must not render as inline code.');

const mergedTable = '<table><tbody><tr><th rowspan="2">功能</th><th>状态</th></tr><tr><td>完成</td></tr></tbody></table>';
assert.match(
  htmlToMarkdown(mergedTable),
  /<table>/,
  'Merged cells must remain HTML because GFM cannot preserve their spans.',
);

const malformedOrderedList = '<ol start="NaN"><li>第一项</li><li>第二项</li></ol>';
const normalizedEditorHtml = contentToEditorHtml(malformedOrderedList);
assert.match(normalizedEditorHtml, /^<ol><li>第一项<\/li>/);
assert.doesNotMatch(normalizedEditorHtml, /start\s*=\s*["']NaN["']/i);

const normalizedMarkdown = htmlToMarkdown(malformedOrderedList);
assert.match(normalizedMarkdown, /^1\.\s+第一项/m);
assert.match(normalizedMarkdown, /^2\.\s+第二项/m);
assert.doesNotMatch(normalizedMarkdown, /NaN\./);

const normalizedPreviewHtml = markdownToHtml(malformedOrderedList);
assert.doesNotMatch(normalizedPreviewHtml, /start\s*=\s*["']NaN["']/i);

const rootImageHtml = contentToEditorHtml(
  '![截图](image/image-20260826-172321-595.png)\n',
  { currentPath: 'C:\\Notes\\Root.md', libraryPath: 'C:\\Notes' },
);
assert.match(rootImageHtml, /src="menghan-image:\/\/local\/C%3A%2FNotes%2Fimage%2Fimage-20260826-172321-595\.png"/);
assert.match(rootImageHtml, /data-menghan-relative="image\/image-20260826-172321-595\.png"/);

const nestedImageHtml = contentToEditorHtml(
  '![截图](../image/image-20260826-172321-595.png)\n',
  { currentPath: 'C:\\Notes\\docs\\Design.md', libraryPath: 'C:\\Notes' },
);
assert.match(nestedImageHtml, /src="menghan-image:\/\/local\/C%3A%2FNotes%2Fimage%2Fimage-20260826-172321-595\.png"/);
assert.match(nestedImageHtml, /data-menghan-relative="\.\.\/image\/image-20260826-172321-595\.png"/);

const legacyAttachmentHtml = contentToEditorHtml(
  '![旧图片](attachments/legacy.png)\n',
  { currentPath: 'C:\\Notes\\docs\\Design.md', libraryPath: 'C:\\Notes' },
);
assert.match(legacyAttachmentHtml, /src="menghan-image:\/\/local\/C%3A%2FNotes%2Fattachments%2Flegacy\.png"/);
assert.match(
  htmlToMarkdown('<img src="file:///C:/Notes/image/example.png" alt="截图" data-menghan-relative="../image/example.png">'),
  /!\[截图\]\(\.\.\/image\/example\.png\)/,
  'Managed images must serialize their note-relative Markdown path instead of the display file URL.',
);

for (const markdownWithBlankLines of [
  '第一段\n\n\n第二段\n',
  '第一段\n\n\n\n第二段\n',
  '\n\n第一段\n',
  '第一段\n\n\n',
  '\n\n',
]) {
  assert.equal(
    htmlToMarkdown(markdownToHtml(markdownWithBlankLines)),
    markdownWithBlankLines,
    'WYSIWYG conversion must preserve each intentional blank line.',
  );
}
assert.equal(
  htmlToMarkdown('<p>第一段</p><p></p><p>第二段</p>'),
  '第一段\n\n\n第二段\n',
  'An empty Tiptap paragraph must remain an explicit Markdown blank line.',
);

const html = markdownToHtml(`
# 标题

\`\`\`ts
const answer: number = 42;
\`\`\`

| 功能 | 状态 |
| --- | --- |
| 表格 | 完成 |

[[B|B 页面]]
`);

assert.match(html, /<h1[^>]*>标题<\/h1>/);
assert.match(html, /class="language-ts"/);
assert.match(html, /<table>/);
assert.match(html, /<td>表格<\/td>/);
assert.match(html, /data-wiki-link="B"/);
assert.match(html, />B 页面<\/a>/);

const wikiBoundaryRoot = document.createElement('div');
wikiBoundaryRoot.innerHTML = markdownToHtml(`正文 [[Live Page|可打开]]

行内代码：\`[[Inline Page]]\`

转义文本：\\[\\[Escaped Page\\]\\]

\`\`\`md
[[Fenced Page]]
\`\`\`
`);
assert.deepEqual(
  [...wikiBoundaryRoot.querySelectorAll('a[data-wiki-link]')].map((link) => link.getAttribute('data-wiki-link')),
  ['Live Page'],
  'The shared Wiki tokenizer must ignore inline code, fenced code, and escaped markers.',
);
assert.equal(wikiBoundaryRoot.querySelector('a[data-wiki-link="Live Page"]')?.textContent, '可打开');
assert.match(wikiBoundaryRoot.querySelector('code.language-md')?.textContent ?? '', /\[\[Fenced Page\]\]/);
assert.match(wikiBoundaryRoot.textContent ?? '', /\[\[Escaped Page\]\]/);

const codeBlockSchema = getSchema([
  StarterKit.configure({ codeBlock: false }),
  MarkdownCodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
]);
const defaultTableCell = codeBlockSchema.nodes.tableCell.createAndFill();
assert.equal(
  defaultTableCell?.firstChild?.type.name,
  'paragraph',
  'A new table cell must default to a paragraph instead of an empty code block.',
);
const codeBlockDocument = createDocument(markdownToHtml('```ts\nconst answer: number = 42;\n```'), codeBlockSchema);
const parsedCodeBlock = codeBlockDocument.firstChild;
assert.equal(parsedCodeBlock?.type.name, 'codeBlock');
assert.equal(parsedCodeBlock?.attrs.language, 'ts');
assert.equal(normalizeCodeLanguage(parsedCodeBlock?.attrs.language), 'typescript');
assert.equal(parsedCodeBlock?.textContent, 'const answer: number = 42;\n');
const serializedCodeBlock = DOMSerializer
  .fromSchema(codeBlockSchema)
  .serializeFragment(codeBlockDocument.content);
const serializedCodeBlockRoot = document.createElement('div');
serializedCodeBlockRoot.append(serializedCodeBlock);
assert.equal(serializedCodeBlockRoot.querySelector('pre')?.dataset.language, 'ts');

const explicitPastedCode = normalizePastedCodeBlockLanguages(
  '<div data-lang="python"><pre><code>print("hello")</code></pre></div>',
  createLowlight(common),
);
const explicitPastedCodeRoot = document.createElement('div');
explicitPastedCodeRoot.innerHTML = explicitPastedCode;
assert.equal(
  explicitPastedCodeRoot.querySelector('pre')?.dataset.language,
  'python',
  'Pasted code blocks must preserve language metadata from their nearest external wrapper.',
);

const highlightedPastedCode = normalizePastedCodeBlockLanguages(
  '<pre><code data-highlighted-language="java">public class Demo {}</code></pre>',
  createLowlight(common),
);
const highlightedPastedCodeRoot = document.createElement('div');
highlightedPastedCodeRoot.innerHTML = highlightedPastedCode;
assert.equal(
  highlightedPastedCodeRoot.querySelector('pre')?.dataset.language,
  'java',
  'Pasted code blocks must retain language metadata emitted by syntax highlighters.',
);

const detectedPastedCode = normalizePastedCodeBlockLanguages(
  '<pre><code>SELECT id, name FROM users WHERE active = true;</code></pre>',
  createLowlight(common),
);
const detectedPastedCodeRoot = document.createElement('div');
detectedPastedCodeRoot.innerHTML = detectedPastedCode;
assert.equal(
  detectedPastedCodeRoot.querySelector('pre')?.dataset.language,
  'sql',
  'Unlabelled pasted code blocks must store the language detected by the editor highlighter.',
);
const detectedPastedCodeDocument = createDocument(detectedPastedCode, codeBlockSchema);
assert.equal(
  detectedPastedCodeDocument.firstChild?.attrs.language,
  'sql',
  'The detected pasted language must survive ProseMirror code-block parsing.',
);
assert.equal(
  detectedPastedCodeDocument.firstChild?.textContent,
  'SELECT id, name FROM users WHERE active = true;',
  'Language recovery must not alter pasted code text.',
);

console.log('Markdown conversion verification passed');
