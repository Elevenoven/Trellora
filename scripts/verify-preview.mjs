import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-preview');
const outFile = path.join(outDir, 'preview.cjs');
const headingAnchorsOutFile = path.join(outDir, 'heading-anchors.cjs');
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'markdown-rendering');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'preview.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'headingAnchors.ts')],
  outfile: headingAnchorsOutFile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
});

const require = createRequire(import.meta.url);
const { createStandaloneHtml, renderPreviewHtml, renderPreviewHtmlWithDiagnostics } = require(outFile);
const { createHeadingAnchorIds, enhanceHeadingAnchors } = require(headingAnchorsOutFile);

const aiMathMarkdown = readFileSync(path.join(fixtureDir, 'ai-math-emphasis.md'), 'utf8');
const aiMathRoot = new JSDOM(`<body>${renderPreviewHtml(aiMathMarkdown)}</body>`).window.document;
assert.equal(aiMathRoot.querySelectorAll('.katex').length, 13, 'AI inline, display, bracket and table formulas must all render.');
assert.equal(aiMathRoot.querySelectorAll('.katex-display').length, 3);
assert.deepEqual([...aiMathRoot.querySelectorAll('.katex-error')].map(node => node.textContent), []);
assert.equal(aiMathRoot.querySelectorAll('strong').length, 5, 'Spaced bold and Chinese punctuation boundaries must render consistently.');
const protectedMathRoot = new JSDOM(`<body>${renderPreviewHtml('价格 $5 and $10；转义 \\$x\\$；`$x$ ** 原文 **`\n\n```md\n$$\nx^2\n$$\n** 原文 **\n```')}</body>`).window.document;
assert.equal(protectedMathRoot.querySelectorAll('.katex, strong').length, 0);
assert.equal(protectedMathRoot.querySelector('pre code')?.textContent, '$$\nx^2\n$$\n** 原文 **\n');
const invalidMathRoot = new JSDOM(`<body>${renderPreviewHtml('错误公式 $\\frac{1}{$；后续**正常加粗**。')}</body>`).window.document;
assert.ok(invalidMathRoot.querySelector('.katex-error'), 'Invalid TeX must remain visible without breaking the rest of the note.');
assert.equal(invalidMathRoot.querySelector('strong')?.textContent, '正常加粗');

const fullFeatureMarkdown = readFileSync(path.join(fixtureDir, 'full-feature.md'), 'utf8');
const unsafeMarkdown = readFileSync(path.join(fixtureDir, 'unsafe-input.md'), 'utf8');
const assetContext = {
  currentPath: 'C:\\Notes\\docs\\full-feature.md',
  libraryPath: 'C:\\Notes',
};

const fullFeatureHtml = renderPreviewHtml(fullFeatureMarkdown, {
  ...assetContext,
  frontmatter: 'strip',
});
const fullFeatureDom = new JSDOM(`<body>${fullFeatureHtml}</body>`);
const fullFeatureDocument = fullFeatureDom.window.document;
globalThis.document = fullFeatureDocument;
enhanceHeadingAnchors(fullFeatureDocument.body);

assert.equal(fullFeatureDocument.querySelector('h1')?.textContent, 'Markdown 渲染全功能基线');
assert.equal(
  [...fullFeatureDocument.querySelectorAll('h2')]
    .filter((heading) => heading.textContent === '重复标题')
    .length,
  2,
  'The baseline must retain duplicate headings for later stable-anchor coverage.',
);
assert.deepEqual(
  [...fullFeatureDocument.querySelectorAll('h2')]
    .filter((heading) => heading.textContent === '重复标题')
    .map((heading) => heading.id),
  ['重复标题', '重复标题-2'],
  'Duplicate heading ids must use the shared stable suffix rule.',
);
assert.equal(
  fullFeatureDocument.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]').length,
  fullFeatureDocument.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
  'Every rendered heading must receive a DOM id.',
);
assert.equal(
  fullFeatureDocument.querySelectorAll('.markdown-heading-anchor').length,
  fullFeatureDocument.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
  'Every rendered heading must expose a keyboard-focusable permanent link.',
);
assert.deepEqual(
  createHeadingAnchorIds(['Title', 'Title', 'Title-2', '']),
  ['title', 'title-2', 'title-2-2', 'heading-4'],
  'Explicit suffixed headings and empty headings must not collide.',
);
assert.doesNotMatch(fullFeatureDocument.body.textContent ?? '', /title: Markdown 渲染全功能基线/,
  'A note preview must not render valid Frontmatter as body content.');
assert.ok(fullFeatureDocument.querySelector('table'), 'The complete fixture must render its GFM table.');
assert.equal(fullFeatureDocument.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]').length, 2);
assert.equal(
  fullFeatureDocument.querySelector('ul[data-type="taskList"] input[type="checkbox"]')?.disabled,
  true,
  'Preview task-list inputs must be read-only.',
);
assert.equal(
  fullFeatureDocument.querySelector('ul[data-type="taskList"]')?.getAttribute('data-task-mode'),
  'readonly',
);
assert.ok(fullFeatureDocument.querySelector('code.language-ts'));
assert.ok(fullFeatureDocument.querySelector('code.language-mermaid'));
assert.ok(fullFeatureDocument.querySelector('.katex'));
assert.ok(fullFeatureDocument.querySelector('.callout-warning'));
assert.ok(fullFeatureDocument.querySelector('.footnotes'));
assert.equal(
  fullFeatureDocument.querySelector('a[data-wiki-link="产品设计"]')?.textContent,
  'Trellora 产品设计',
);
assert.equal(
  fullFeatureDocument.querySelector('img[alt="相对图片"]')?.getAttribute('data-menghan-relative'),
  'images/fixture.png',
);

const legacyTablePreviewHtml = renderPreviewHtml([
  '| ```<br><br>11<br><br>``` | ```<br><br>111<br><br>``` |',
  '| --- | --- |',
  '| ```<br><br>1<br><br>``` | ```<br><br>2<br><br>``` |',
].join('\n'));
const legacyTablePreviewDocument = new JSDOM(`<body>${legacyTablePreviewHtml}</body>`).window.document;
assert.deepEqual(
  [...legacyTablePreviewDocument.querySelectorAll('th, td')].map((cell) => cell.textContent),
  ['11', '111', '1', '2'],
  'Preview must repair table-cell fences saved by the previous serializer.',
);
assert.equal(legacyTablePreviewDocument.querySelector('table code'), null,
  'Preview must not expose legacy table-cell fences as inline code.',
);

const standaloneHtml = createStandaloneHtml('Markdown 渲染全功能基线', fullFeatureDocument.body.innerHTML);
assert.match(standaloneHtml, /^<!doctype html>/);
assert.match(standaloneHtml, /<title>Markdown 渲染全功能基线<\/title>/);
assert.match(standaloneHtml, /id="重复标题-2"/,
  'Standalone export must use the same duplicate heading id as the preview and outline.');
assert.match(standaloneHtml, /class="language-mermaid"/,
  'Standalone export currently keeps Mermaid source code instead of embedding rendered SVG.');
assert.doesNotMatch(standaloneHtml, /<svg[^>]*data-mermaid/i);
assert.doesNotMatch(standaloneHtml, /katex\.min\.css/,
  'Standalone export currently does not package KaTeX styles; phase R5 will replace this baseline.');

const unsafeHtml = renderPreviewHtml(unsafeMarkdown, assetContext);
const unsafeDom = new JSDOM(`<body>${unsafeHtml}</body>`);
const unsafeDocument = unsafeDom.window.document;
assert.equal(unsafeDocument.querySelector('script, iframe'), null,
  'Sanitized preview HTML must remove script and iframe content.');
assert.ok(unsafeDocument.querySelector('form'),
  'DOMPurify currently retains forms; this fixture records the remaining HTML-hardening gap.');
assert.equal(unsafeDocument.querySelector('[onerror], [onclick], [onload]'), null,
  'Sanitized preview HTML must remove inline event handlers.');
assert.doesNotMatch(unsafeHtml, /javascript:/i);
assert.doesNotMatch(unsafeHtml, /trellora-unsafe:/i);
const outsideImage = unsafeDocument.querySelector('img[alt="越界路径"]');
assert.equal(outsideImage?.getAttribute('data-menghan-relative'), '../../outside.png');
assert.equal(
  outsideImage?.getAttribute('src'),
  'menghan-image://local/C%3A%2Foutside.png',
  'Preview normalization records the requested path; the image protocol remains responsible for rejecting paths outside the library.',
);

const html = renderPreviewHtml(`
> [!warning]
> Careful now

Inline math $x^2$

Footnote ref[^1]

[^1]: Footnote body

[[Page|Page alias]]
`);

assert.match(html, /callout-warning/);
assert.match(html, /Careful now/);
assert.match(html, /katex/);
assert.match(html, /footnotes/);
assert.match(html, /Footnote body/);
assert.match(html, /data-wiki-link="Page"/);
assert.match(html, />Page alias<\/a>/);

const validFrontmatter = `---
title: R4 验证
tags:
  - markdown
---

# 正文
`;
const strippedFrontmatter = renderPreviewHtmlWithDiagnostics(validFrontmatter, { frontmatter: 'strip' });
assert.deepEqual(strippedFrontmatter.diagnostics, []);
assert.match(strippedFrontmatter.html, /<h1>正文<\/h1>/);
assert.doesNotMatch(strippedFrontmatter.html, /R4 验证|<hr>/);
assert.match(
  renderPreviewHtml(validFrontmatter),
  /R4 验证/,
  'AI-style rendering must preserve Frontmatter-looking Markdown unless the surface explicitly requests stripping.',
);

const horizontalRuleHtml = renderPreviewHtml('第一段\n\n---\n\n第二段', { frontmatter: 'strip' });
assert.match(horizontalRuleHtml, /<hr>/, 'A thematic break outside the document header must retain normal Markdown behavior.');

const invalidFrontmatter = renderPreviewHtmlWithDiagnostics(`---
title: [缺少闭合括号
---

# 仍然显示
`, { frontmatter: 'strip' });
assert.equal(invalidFrontmatter.diagnostics.length, 1);
assert.equal(invalidFrontmatter.diagnostics[0].code, 'frontmatter-invalid');
assert.match(invalidFrontmatter.html, /缺少闭合括号/);
assert.match(invalidFrontmatter.html, /仍然显示/);

const unclosedFrontmatter = renderPreviewHtmlWithDiagnostics('---\ntitle: 未闭合\n# 仍然显示', { frontmatter: 'strip' });
assert.equal(unclosedFrontmatter.diagnostics[0]?.code, 'frontmatter-unclosed');
assert.match(unclosedFrontmatter.html, /仍然显示/);

const footnoteHtml = renderPreviewHtml(`重复引用[^detail]，再次引用[^detail]，未定义[^missing]。

[^detail]: 第一段包含 **粗体**
    续行包含 [链接](https://example.com/docs)

    第二段
`);
const footnoteDom = new JSDOM(`<body>${footnoteHtml}</body>`);
const footnoteDocument = footnoteDom.window.document;
const footnoteReferences = [...footnoteDocument.querySelectorAll('.footnote-ref')];
assert.equal(footnoteReferences.length, 2);
assert.notEqual(footnoteReferences[0].id, footnoteReferences[1].id,
  'Every repeated footnote reference must receive a unique DOM id.');
const footnoteItem = footnoteDocument.querySelector('.footnotes li');
assert.ok(footnoteItem?.querySelector('strong'));
assert.equal(footnoteItem?.querySelector('a[href="https://example.com/docs"]')?.textContent, '链接');
assert.match(footnoteItem?.textContent ?? '', /续行包含/);
assert.match(footnoteItem?.textContent ?? '', /第二段/);
assert.deepEqual(
  [...footnoteItem.querySelectorAll('.footnote-backref')].map((link) => link.getAttribute('href')),
  footnoteReferences.map((reference) => `#${reference.id}`),
);
assert.match(footnoteDocument.body.textContent ?? '', /未定义\[\^missing\]/,
  'An undefined footnote reference must remain literal text.');

const calloutHtml = renderPreviewHtml(`> [!question] **自定义标题**
> Callout 正文包含相对图片：![示意图](images/callout.png)
`, {
  currentPath: 'C:\\Notes\\docs\\callout.md',
  libraryPath: 'C:\\Notes',
});
const calloutDom = new JSDOM(`<body>${calloutHtml}</body>`);
const calloutDocument = calloutDom.window.document;
assert.equal(calloutDocument.querySelector('.callout-question .callout-title strong')?.textContent, '自定义标题');
assert.equal(
  calloutDocument.querySelector('.callout-question img')?.getAttribute('src'),
  'menghan-image://local/C%3A%2FNotes%2Fdocs%2Fimages%2Fcallout.png',
  'A relative image inside a Callout must use the current document directory.',
);
assert.equal(
  calloutDocument.querySelector('.callout-question img')?.getAttribute('data-menghan-relative'),
  'images/callout.png',
);

const literalMarkersHtml = renderPreviewHtml(`外部 Wiki：[[Live Page]]。

行内代码：\`[[Inline Page]] [^literal] > [!note]\`

转义文本：\\[\\[Escaped Page\\]\\] 和 \\[\\^literal\\]

\`\`\`md
[[Fenced Page]]
[^literal]
> [!note]
> fenced callout
\`\`\`

[^literal]: 外部定义
`);
const literalMarkersDom = new JSDOM(`<body>${literalMarkersHtml}</body>`);
const literalMarkersDocument = literalMarkersDom.window.document;
assert.deepEqual(
  [...literalMarkersDocument.querySelectorAll('a[data-wiki-link]')].map((link) => link.dataset.wikiLink),
  ['Live Page'],
  'Only a live Wiki marker outside code and escaped text may be tokenized.',
);
const fencedCode = literalMarkersDocument.querySelector('code.language-md');
assert.match(fencedCode?.textContent ?? '', /\[\[Fenced Page\]\]/);
assert.match(fencedCode?.textContent ?? '', /\[\^literal\]/);
assert.match(fencedCode?.textContent ?? '', /> \[!note\]/);
assert.equal(fencedCode?.querySelector('a, sup, .callout'), null);
assert.match(literalMarkersDocument.body.textContent ?? '', /\[\[Escaped Page\]\]/);
assert.equal(literalMarkersDocument.querySelectorAll('.callout').length, 0);
assert.equal(literalMarkersDocument.querySelectorAll('.footnote-ref').length, 0);

const imageHtml = renderPreviewHtml(
  '![截图](image/image-1.png)',
  { currentPath: 'C:\\Notes\\Root.md', libraryPath: 'C:\\Notes' },
);
assert.match(imageHtml, /src="menghan-image:\/\/local\/C%3A%2FNotes%2Fimage%2Fimage-1\.png"/);
assert.match(imageHtml, /data-menghan-relative="image\/image-1\.png"/);
assert.doesNotMatch(
  renderPreviewHtml('<img src="javascript:alert(1)" alt="unsafe">'),
  /javascript:/i,
  'Allowing the internal image protocol must not make script URLs valid.',
);

const oneMegabyteMarkdown = `# 1 MB 文档\n\n${'大文档正文'.repeat(210_000)}`;
const oneMegabyteHtml = renderPreviewHtml(oneMegabyteMarkdown);
assert.match(oneMegabyteHtml, /<h1>1 MB 文档<\/h1>/);
assert.ok(oneMegabyteHtml.length > 1_000_000, 'The preview baseline must retain a complete 1 MB Markdown document.');

console.log('Preview verification passed');
