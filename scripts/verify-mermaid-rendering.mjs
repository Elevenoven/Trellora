import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-mermaid-rendering');
const markdownContentOutFile = path.join(outDir, 'markdown-content.cjs');
const markdownPreviewOutFile = path.join(outDir, 'markdown-preview.cjs');
const markdownLinksOutFile = path.join(outDir, 'markdown-links.cjs');
const markdownEnhancementsOutFile = path.join(outDir, 'markdown-enhancements.cjs');
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'markdown-rendering');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let scrolledHeadingId = null;
let scrolledElement = null;
HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
  scrolledHeadingId = this.id;
  scrolledElement = this;
};
let copiedText = null;
let shouldCopy = true;
document.execCommand = (command) => {
  if (command !== 'copy' || !shouldCopy) return false;
  copiedText = document.querySelector('textarea')?.value ?? null;
  return true;
};

await build({
  entryPoints: {
    'markdown-content': path.join(rootDir, 'src', 'components', 'MarkdownContent.tsx'),
    'markdown-preview': path.join(rootDir, 'src', 'components', 'MarkdownPreview.tsx'),
    'markdown-links': path.join(rootDir, 'src', 'utils', 'markdownLinks.ts'),
    'markdown-enhancements': path.join(rootDir, 'src', 'utils', 'markdownEnhancements.ts'),
  },
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  loader: { '.css': 'text' },
  plugins: [{
    name: 'mock-mermaid',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'verify-mermaid' }));
      buildContext.onLoad({ filter: /^mermaid$/, namespace: 'verify-mermaid' }, () => ({
        loader: 'js',
        contents: `
          const stats = globalThis.__verifyMermaidStats ??= { active: 0, maxActive: 0, calls: 0, delayMs: 0 };
          const mermaid = {
            initialize() {},
            async render(id, source) {
              stats.active += 1;
              stats.calls += 1;
              stats.maxActive = Math.max(stats.maxActive, stats.active);
              try {
                if (stats.delayMs) await new Promise((resolve) => setTimeout(resolve, stats.delayMs));
                if (source.includes('BROKEN_MERMAID')) throw new Error('mock Mermaid parse error');
                return { svg: '<svg data-mermaid-id="' + id + '" data-mermaid-source="' + encodeURIComponent(source) + '" viewBox="0 0 640 360"></svg>' };
              } finally {
                stats.active -= 1;
              }
            },
          };
          export default mermaid;
        `,
      }));
    },
  }],
});

const require = createRequire(import.meta.url);
const { default: MarkdownContent } = require(markdownContentOutFile);
const { default: MarkdownPreview } = require(markdownPreviewOutFile);
const { parseRelativeMarkdownLinkHref } = require(markdownLinksOutFile);
const { enhanceMarkdownContainer, markdownEnhancementLimits } = require(markdownEnhancementsOutFile);
const fullFeatureMarkdown = readFileSync(path.join(fixtureDir, 'full-feature.md'), 'utf8');
const unsafeMarkdown = readFileSync(path.join(fixtureDir, 'unsafe-input.md'), 'utf8');

async function renderIntoDocument(element) {
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, reactRoot };
}

async function unmountFromDocument(rendered) {
  await act(async () => rendered.reactRoot.unmount());
  rendered.container.remove();
}

const mount = document.createElement('div');
document.body.append(mount);
const root = createRoot(mount);
const diagram = 'flowchart TD\n  A[开始] --> B[完成]';
const typedCode = 'const answer: number = 42;';
const inferredCode = '# 文档唯一标识\ndocumentId = 501';
const plainChineseCode = '根据招标文件要求，投标保证金应在开标前缴纳。\n未按规定缴纳投标保证金的，投标文件可能被拒绝。';

await act(async () => {
  root.render(React.createElement(MarkdownContent, {
    content: `# 标题\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n\`\`\`ts\n${typedCode}\n\`\`\`\n\n\`\`\`\n${inferredCode}\n\`\`\`\n\n\`\`\`\n${plainChineseCode}\n\`\`\``,
    showCodeCopyActions: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const svg = mount.querySelector('svg[data-mermaid-source]');
assert.ok(svg, 'Mermaid fenced code block should be replaced by an SVG');
assert.equal(decodeURIComponent(svg?.getAttribute('data-mermaid-source') ?? ''), `${diagram}\n`);
assert.equal(mount.querySelector('pre code.language-mermaid'), null, 'Raw Mermaid code should not remain after rendering');
assert.equal(mount.querySelector('h1')?.textContent, '标题', 'Normal Markdown should still render before Mermaid processing');
const mermaidToolbar = mount.querySelector('.mermaid-toolbar');
assert.ok(mermaidToolbar, 'Live Mermaid diagrams must expose an interactive toolbar.');
assert.equal(mermaidToolbar.getAttribute('role'), 'toolbar');
assert.equal(mermaidToolbar.dataset.markdownExportExclude, 'true');
const mermaidZoomIn = mermaidToolbar.querySelector('[data-action="zoom-in"]');
const mermaidFit = mermaidToolbar.querySelector('[data-action="fit"]');
assert.ok(mermaidZoomIn && mermaidFit);
mermaidZoomIn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(svg.dataset.fitToWidth, 'false');
assert.equal(svg.dataset.scale, '1.25');
mermaidFit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(svg.dataset.fitToWidth, 'true');
assert.equal(svg.dataset.scale, '1');
await act(async () => {
  mermaidToolbar.querySelector('[data-action="copy-svg"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.match(copiedText ?? '', /<svg[^>]*data-mermaid-source=/, 'The Mermaid SVG copy action must copy serialized SVG source.');
assert.equal(mermaidToolbar.querySelector('.mermaid-toolbar-status')?.textContent, 'SVG 已复制');

const typescriptBlock = mount.querySelector('pre code.language-ts');
assert.ok(typescriptBlock?.classList.contains('hljs'), 'Declared TypeScript code should be syntax highlighted');
assert.equal(typescriptBlock?.dataset.highlightedLanguage, 'typescript');
assert.ok(typescriptBlock?.querySelector('.hljs-keyword'), 'TypeScript keywords should receive token classes');
assert.ok(typescriptBlock?.querySelector('.hljs-number'), 'TypeScript numbers should receive token classes');

const inferredBlock = [...mount.querySelectorAll('pre code.hljs')]
  .find((block) => !block.classList.contains('language-ts'));
assert.equal(inferredBlock?.dataset.highlightedLanguage, 'ini', 'Unlabelled configuration code should be detected');
assert.ok(inferredBlock?.querySelector('.hljs-comment'), 'Detected comments should receive token classes');
assert.ok(inferredBlock?.querySelector('.hljs-attr'), 'Detected field names should receive token classes');

const plainChineseBlock = [...mount.querySelectorAll('pre code')]
  .find((block) => block.textContent?.trim() === plainChineseCode);
assert.ok(plainChineseBlock, 'Unrecognised code must keep its original text when automatic highlighting returns no nodes');
assert.equal(plainChineseBlock?.dataset.highlightedLanguage, 'plaintext');

const copyButton = typescriptBlock?.closest('pre')?.querySelector('.markdown-code-copy-button');
assert.ok(copyButton, 'Rendered AI code blocks should expose their copy action.');
assert.equal(copyButton.getAttribute('aria-live'), 'polite');
assert.equal(
  typescriptBlock?.closest('pre')?.querySelector('.markdown-code-language-label')?.textContent,
  'TypeScript',
);
assert.equal(
  inferredBlock?.closest('pre')?.querySelector('.markdown-code-language-label')?.textContent,
  'INI',
);
assert.equal(
  plainChineseBlock?.closest('pre')?.querySelector('.markdown-code-language-label')?.textContent,
  '纯文本',
);
assert.equal(
  typescriptBlock?.textContent,
  `${typedCode}\n`,
  'The rendered code fixture must contain the structural Markdown fence line break.',
);
await act(async () => {
  copyButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.equal(copiedText, typedCode, 'The code-copy action must not include the Markdown fence line break.');
assert.equal(copyButton.dataset.state, 'success');
assert.equal(copyButton.getAttribute('aria-label'), '已复制');

shouldCopy = false;
const failureButton = plainChineseBlock?.closest('pre')?.querySelector('.markdown-code-copy-button');
assert.ok(failureButton, 'Every copy-enabled code block must expose the shared copy action.');
await act(async () => {
  failureButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.equal(failureButton.dataset.state, 'error');
assert.equal(failureButton.getAttribute('aria-label'), '复制失败');
shouldCopy = true;

await act(async () => new Promise((resolve) => setTimeout(resolve, 1_900)));
assert.equal(copyButton.dataset.state, 'idle', 'Copy feedback must automatically return to its idle state.');
assert.equal(copyButton.getAttribute('aria-label'), '复制代码');

await act(async () => root.unmount());

const streamingMarkdown = `| 阶段 | 状态 |\n| --- | --- |\n| 检索 | 进行中 |\n\n\`\`\`ts\nconst streaming = true;\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``;
const streamingRendered = await renderIntoDocument(React.createElement(MarkdownContent, {
  content: streamingMarkdown,
  showCodeCopyActions: true,
  isStreaming: true,
}));
const streamingRoot = streamingRendered.container.querySelector('.markdown-rendered-content');
assert.ok(streamingRoot, 'A streaming answer must render through the shared Markdown surface.');
assert.equal(streamingRendered.container.querySelector('.markdown-table-scroll'), null,
  'Streaming answers must postpone table wrappers that would reshape the live DOM.');
assert.equal(streamingRendered.container.querySelector('.markdown-code-copy-button'), null,
  'Streaming answers must postpone code actions until the final render.');
assert.equal(streamingRendered.container.querySelector('svg[data-mermaid-source]'), null,
  'Streaming answers must postpone Mermaid replacement until the final render.');

await act(async () => {
  streamingRendered.reactRoot.render(React.createElement(MarkdownContent, {
    content: `${streamingMarkdown}\n\n补充内容`,
    showCodeCopyActions: true,
    isStreaming: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.equal(streamingRendered.container.querySelector('.markdown-rendered-content'), streamingRoot,
  'Growing stream content must preserve the outer Markdown DOM node.');
assert.match(streamingRendered.container.querySelector('.markdown-rendered-content')?.textContent ?? '', /补充内容/,
  'Growing stream content must become visible before the terminal render.');

await act(async () => {
  streamingRendered.reactRoot.render(React.createElement(MarkdownContent, {
    content: `${streamingMarkdown}\n\n补充内容`,
    showCodeCopyActions: true,
    isStreaming: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
assert.equal(streamingRendered.container.querySelector('.markdown-rendered-content'), streamingRoot,
  'The final render must enhance content without replacing the outer Markdown DOM node.');
assert.ok(streamingRendered.container.querySelector('.markdown-table-scroll'),
  'The final render must restore table overflow handling.');
assert.ok(streamingRendered.container.querySelector('.markdown-code-copy-button'),
  'The final render must restore code actions.');
assert.ok(streamingRendered.container.querySelector('svg[data-mermaid-source]'),
  'The final render must restore Mermaid diagrams.');
await unmountFromDocument(streamingRendered);

const largeCode = 'x'.repeat(100_001);
const largeCodeRendered = await renderIntoDocument(React.createElement(MarkdownContent, {
  content: `\`\`\`txt\n${largeCode}\n\`\`\``,
  showCodeCopyActions: true,
}));
const largeCodeBlock = largeCodeRendered.container.querySelector('pre code');
assert.equal(largeCodeBlock?.dataset.highlightSkipped, 'size');
assert.equal(largeCodeBlock?.dataset.highlightedLanguage, 'plaintext');
assert.equal(largeCodeBlock?.classList.contains('hljs'), false,
  'Oversized code blocks must skip syntax highlighting.');
assert.equal(
  largeCodeRendered.container.querySelector('.markdown-code-language-label')?.textContent,
  '纯文本',
);
assert.ok(largeCodeRendered.container.querySelector('.markdown-code-copy-button'));
await unmountFromDocument(largeCodeRendered);

const imageRendered = await renderIntoDocument(React.createElement(MarkdownContent, {
  content: '![流程图说明](https://example.com/diagram.png)',
}));
const previewImage = imageRendered.container.querySelector('img[alt="流程图说明"]');
assert.ok(previewImage);
await act(async () => {
  previewImage.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
let imageViewer = document.querySelector('.markdown-image-viewer');
assert.ok(imageViewer?.hasAttribute('open'), 'Clicking a Markdown image must open the top-level image viewer.');
assert.equal(imageViewer.querySelector('figcaption')?.textContent, '流程图说明');
await act(async () => {
  imageViewer.querySelector('[aria-label="放大图片"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
assert.equal(imageViewer.querySelector('.markdown-image-viewer-scale')?.textContent, '125%');
await act(async () => {
  imageViewer.querySelector('.markdown-image-viewer-canvas')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
});
assert.equal(document.querySelector('.markdown-image-viewer'), null, 'Clicking the empty image canvas must close the viewer.');

await act(async () => {
  previewImage.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
imageViewer = document.querySelector('.markdown-image-viewer');
assert.ok(imageViewer);
await act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
assert.equal(document.querySelector('.markdown-image-viewer'), null, 'Escape must close the image viewer.');
await unmountFromDocument(imageRendered);

const tableContainer = document.createElement('div');
tableContainer.innerHTML = '<table><thead><tr><th>列 A</th><th>列 B</th></tr></thead><tbody><tr><td>内容</td><td>内容</td></tr></tbody></table>';
await enhanceMarkdownContainer(tableContainer, {
  resolvedTheme: 'light',
  yieldControl: async () => undefined,
});
const tableScroller = tableContainer.querySelector('.markdown-table-scroll');
assert.ok(tableScroller?.querySelector(':scope > table'));
assert.equal(tableScroller.getAttribute('role'), 'region');
assert.equal(tableScroller.getAttribute('tabindex'), '0');

const budgetContainer = document.createElement('div');
for (let index = 0; index < 5; index += 1) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-txt';
  code.textContent = 'x'.repeat(75_001);
  pre.appendChild(code);
  budgetContainer.appendChild(pre);
}
await enhanceMarkdownContainer(budgetContainer, {
  resolvedTheme: 'light',
  yieldControl: async () => undefined,
});
assert.deepEqual(
  [...budgetContainer.querySelectorAll('code')].map((code) => code.dataset.highlightSkipped ?? null),
  [null, null, null, 'budget', 'budget'],
  'Once the page highlight budget is exhausted, every later code block must safely remain plain text.',
);

const workloadContainer = document.createElement('div');
for (let index = 0; index < 100; index += 1) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-js';
  code.textContent = `const value${index} = ${index};`;
  pre.appendChild(code);
  workloadContainer.appendChild(pre);
}
for (let index = 0; index < 8; index += 1) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = `flowchart TD\n  A${index} --> B${index}`;
  pre.appendChild(code);
  workloadContainer.appendChild(pre);
}
const mermaidStats = globalThis.__verifyMermaidStats;
Object.assign(mermaidStats, { active: 0, maxActive: 0, calls: 0, delayMs: 5 });
let yieldedTasks = 0;
await enhanceMarkdownContainer(workloadContainer, {
  resolvedTheme: 'light',
  interactive: true,
  yieldControl: async () => { yieldedTasks += 1; },
});
assert.ok(yieldedTasks >= Math.floor(100 / markdownEnhancementLimits.enhancementBatchSize),
  'A 100-code-block document must divide enhancement work into multiple scheduled batches.');
assert.equal(workloadContainer.querySelectorAll('pre code.language-js').length, 100);
assert.equal(workloadContainer.querySelectorAll('.mermaid-preview svg').length, 8);
assert.equal(workloadContainer.querySelectorAll('.mermaid-toolbar').length, 8);
assert.ok(mermaidStats.maxActive <= markdownEnhancementLimits.mermaidConcurrency,
  'Mermaid rendering must never exceed the configured concurrency limit.');
Object.assign(mermaidStats, { active: 0, maxActive: 0, calls: 0, delayMs: 0 });

assert.deepEqual(
  parseRelativeMarkdownLinkHref('../related.md#english-heading'),
  { path: '../related.md', fragment: 'english-heading' },
);
assert.deepEqual(
  parseRelativeMarkdownLinkHref('notes/方案.markdown#重复标题-2'),
  { path: 'notes/方案.markdown', fragment: '重复标题-2' },
);
assert.equal(parseRelativeMarkdownLinkHref('C:/outside.md'), null, 'Drive-absolute paths must not become app links.');
assert.equal(parseRelativeMarkdownLinkHref('/outside.md'), null, 'Root-absolute paths must not become app links.');
assert.equal(parseRelativeMarkdownLinkHref('custom:outside.md'), null, 'Unknown protocols must not become app links.');

const componentSurfaces = [
  {
    name: 'assistant-answer',
    element: React.createElement(MarkdownContent, {
      className: 'assistant-markdown-content',
      content: fullFeatureMarkdown,
      currentPath: 'C:\\Notes\\assistant-answer.md',
      libraryPath: 'C:\\Notes',
      showCodeCopyActions: true,
    }),
    expectsCopyAction: true,
  },
  {
    name: 'wiki-answer',
    element: React.createElement(MarkdownContent, {
      className: 'wiki-markdown-content',
      content: fullFeatureMarkdown,
      currentPath: 'C:\\Notes\\wiki-answer.md',
      libraryPath: 'C:\\Notes',
      showCodeCopyActions: true,
    }),
    expectsCopyAction: true,
  },
];

for (const surface of componentSurfaces) {
  const rendered = await renderIntoDocument(surface.element);
  assert.equal(rendered.container.querySelector('h1')?.textContent, 'Markdown 渲染全功能基线',
    `${surface.name} must render the shared complete fixture.`);
  assert.ok(rendered.container.querySelector('svg[data-mermaid-source]'),
    `${surface.name} must post-process Mermaid diagrams.`);
  assert.equal(Boolean(rendered.container.querySelector('.markdown-code-copy-button')), surface.expectsCopyAction,
    `${surface.name} code-copy baseline changed unexpectedly.`);
  assert.ok(
    [...rendered.container.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]')]
      .every((input) => input.disabled),
    `${surface.name} task inputs must remain read-only.`,
  );
  assert.equal(
    rendered.container.querySelectorAll('.markdown-code-language-label').length,
    rendered.container.querySelectorAll('.markdown-code-copy-button').length,
    `${surface.name} copy-enabled code blocks must expose reliable language labels.`,
  );
  await unmountFromDocument(rendered);
}

let openedWikiTarget = null;
let openedRelativeTarget = null;
for (const surface of [
  {
    name: 'note-preview',
    expectsCopyAction: true,
    currentPath: 'C:\\Notes\\notes\\feature.md',
    previewProps: {
      headingJump: {
        heading: { id: '重复标题-2', level: 2, text: '重复标题', line: 1, index: -1 },
        nonce: 1,
      },
      highlightTerm: '重复标题',
      showCodeCopyActions: true,
      onOpenWikiLink: (target) => { openedWikiTarget = target; },
      onOpenRelativeMarkdownLink: (target) => { openedRelativeTarget = target; },
    },
  },
  {
    name: 'materials-preview',
    expectsCopyAction: false,
    currentPath: 'C:\\Notes\\materials\\feature.md',
    previewProps: { disableApplicationLinks: true },
  },
]) {
  let outline = [];
  scrolledHeadingId = null;
  const rendered = await renderIntoDocument(React.createElement(MarkdownPreview, {
    content: fullFeatureMarkdown,
    currentPath: surface.currentPath,
    libraryPath: 'C:\\Notes',
    onOutlineChange: (headings) => { outline = headings; },
    ...surface.previewProps,
  }));
  assert.equal(rendered.container.querySelector('h1')?.textContent, 'Markdown 渲染全功能基线',
    `${surface.name} must render the shared complete fixture.`);
  assert.ok(rendered.container.querySelector('svg[data-mermaid-source]'),
    `${surface.name} must post-process Mermaid diagrams.`);
  assert.equal(Boolean(rendered.container.querySelector('.markdown-code-copy-button')), surface.expectsCopyAction,
    `${surface.name} code-copy capability must match its surface policy.`);
  assert.ok(
    [...rendered.container.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]')]
      .every((input) => input.disabled),
    `${surface.name} task inputs must remain read-only.`,
  );
  const domHeadings = [...rendered.container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  assert.ok(domHeadings.every((heading) => Boolean(heading.id)),
    `${surface.name} must assign ids to every rendered heading.`);
  assert.deepEqual(outline.map((heading) => heading.id), domHeadings.map((heading) => heading.id),
    `${surface.name} outline ids must match rendered DOM ids.`);
  assert.equal(outline.filter((heading) => heading.text === '重复标题').length, 2,
    `${surface.name} outline must retain both duplicate headings.`);
  assert.deepEqual(
    outline.filter((heading) => heading.text === '重复标题').map((heading) => heading.id),
    ['重复标题', '重复标题-2'],
    `${surface.name} duplicate headings must use stable suffixes.`,
  );
  assert.equal(rendered.container.querySelectorAll('.markdown-heading-anchor').length, domHeadings.length,
    `${surface.name} must expose one permanent link per heading.`);

  const wikiLink = rendered.container.querySelector('a[data-wiki-link="产品设计"]');
  const relativeLink = rendered.container.querySelector('a[href="../related.md#english-heading"]');
  assert.ok(wikiLink && relativeLink, `${surface.name} must render application links from the fixture.`);

  if (surface.name === 'note-preview') {
    assert.ok(rendered.container.querySelectorAll('.markdown-search-match').length >= 2,
      'Main preview must highlight every literal search-term match without changing the HTML source string.');
    assert.equal(scrolledHeadingId, '重复标题-2', 'Cross-note fragment jumps must resolve by the shared heading id.');
    const fragmentLink = [...rendered.container.querySelectorAll('a[href]')]
      .find((anchor) => decodeURIComponent(anchor.getAttribute('href')) === '#重复标题-2');
    assert.ok(fragmentLink, 'Note preview must retain duplicate-heading fragment links.');
    scrolledHeadingId = null;
    const fragmentEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    fragmentLink.dispatchEvent(fragmentEvent);
    assert.equal(fragmentEvent.defaultPrevented, true);
    assert.equal(scrolledHeadingId, '重复标题-2');
    const duplicateHeading = rendered.container.querySelector('#重复标题-2');
    assert.ok(duplicateHeading?.classList.contains('markdown-heading-target'));
    scrolledHeadingId = null;
    const permalinkEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    duplicateHeading.querySelector('.markdown-heading-anchor').dispatchEvent(permalinkEvent);
    assert.equal(permalinkEvent.defaultPrevented, true);
    assert.equal(scrolledHeadingId, '重复标题-2', 'Permanent links must use the same duplicate heading id.');

    const footnoteLink = rendered.container.querySelector('a[href="#fn-baseline"]');
    const footnoteEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    footnoteLink.dispatchEvent(footnoteEvent);
    assert.equal(footnoteEvent.defaultPrevented, false, 'Non-heading fragments must retain native browser navigation.');

    wikiLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    relativeLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(openedWikiTarget, '产品设计');
    assert.deepEqual(openedRelativeTarget, { path: '../related.md', fragment: 'english-heading' });
    assert.equal(rendered.container.querySelector('a[href="https://example.com/guide"]')?.getAttribute('aria-disabled'), null,
      'Guarded HTTP(S) links must remain available to Electron navigation policy.');
  } else {
    assert.equal(wikiLink.getAttribute('aria-disabled'), 'true');
    assert.equal(relativeLink.getAttribute('aria-disabled'), 'true');
    const disabledEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    relativeLink.dispatchEvent(disabledEvent);
    assert.equal(disabledEvent.defaultPrevented, true, 'Materials preview must not execute app navigation.');
  }
  await unmountFromDocument(rendered);
}

const englishHeadingLine = fullFeatureMarkdown.split(/\r?\n/).findIndex((line) => line === '## English Heading') + 1;
scrolledHeadingId = null;
scrolledElement = null;
const lineNavigationRendered = await renderIntoDocument(React.createElement(MarkdownPreview, {
  content: fullFeatureMarkdown,
  currentPath: 'C:\\Notes\\notes\\feature.md',
  libraryPath: 'C:\\Notes',
  scrollTarget: {
    lineFrom: englishHeadingLine,
    lineTo: englishHeadingLine,
    text: 'English Heading',
    nonce: 2,
  },
  onOutlineChange: () => undefined,
}));
assert.equal(scrolledHeadingId, 'english-heading', 'Preview citation navigation must prefer the source line target.');
assert.ok(scrolledElement?.classList.contains('search-target-flash'),
  'Preview citation targets must receive a visible location cue.');
await unmountFromDocument(lineNavigationRendered);

const unsafeRendered = await renderIntoDocument(React.createElement(MarkdownContent, {
  content: unsafeMarkdown,
  currentPath: 'C:\\Notes\\docs\\unsafe-input.md',
  libraryPath: 'C:\\Notes',
}));
const mermaidErrorText = unsafeRendered.container.querySelector('.mermaid-error')?.textContent ?? '';
assert.match(mermaidErrorText, /Mermaid 渲染失败，请检查图表语法。/,
  'Invalid Mermaid source must fail locally without breaking the remaining Markdown surface.');
assert.doesNotMatch(mermaidErrorText, /mock Mermaid parse error/,
  'Mermaid failures must not expose low-level diagnostics in rendered content.');
assert.match(
  unsafeRendered.container.querySelector('.mermaid-source-details code')?.textContent ?? '',
  /BROKEN_MERMAID/,
  'A failed Mermaid diagram must retain a safe source-view entry.',
);
assert.equal(unsafeRendered.container.querySelector('script, iframe'), null);
assert.ok(unsafeRendered.container.querySelector('form'),
  'The component baseline must expose the same retained-form hardening gap as renderPreviewHtml.');
await unmountFromDocument(unsafeRendered);

console.log('Markdown diagram and syntax highlighting verification passed');
