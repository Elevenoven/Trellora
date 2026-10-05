import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-markdown-export');
const outFile = path.join(outDir, 'markdown-export.cjs');

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

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'markdownExport.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  loader: {
    '.css': 'text',
    '.woff2': 'dataurl',
  },
  plugins: [{
    name: 'mock-mermaid',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'verify-mermaid' }));
      buildContext.onLoad({ filter: /^mermaid$/, namespace: 'verify-mermaid' }, () => ({
        loader: 'js',
        contents: `
          const mermaid = {
            initialize() {},
            async render(id, source) {
              if (source.includes('BROKEN_MERMAID')) throw new Error('mock Mermaid parse error');
              return { svg: '<svg id="' + id + '" data-exported-mermaid="true"><text>' + source.replace(/[<>&]/g, '') + '</text></svg>' };
            },
          };
          export default mermaid;
        `,
      }));
    },
  }],
});

const require = createRequire(import.meta.url);
const {
  assertMarkdownExportHtmlSize,
  markdownExportLimits,
  renderMarkdownExport,
} = require(outFile);

const tinyPngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const currentPath = 'C:\\Notes\\docs\\export.md';
const libraryPath = 'C:\\Notes';

const html = await renderMarkdownExport({
  title: 'R3 <导出验证>',
  markdown: `
# R3 导出验证

本地图片：![截图](../images/fixture.png)

行内公式 $x^2 + y^2$。

- [x] 完成

| 列 A | 列 B | 列 C |
| --- | --- | --- |
| 内容 | 内容 | 内容 |

\`\`\`ts
const answer: number = 42;
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`mermaid
BROKEN_MERMAID
\`\`\`

[[内部笔记|内部链接]]

<img src="javascript:alert(1)" onerror="alert(1)">
`,
  currentPath,
  libraryPath,
  resolvedTheme: 'dark',
  resolveImageDataUrl: async (source) => {
    assert.match(source, /^menghan-image:\/\//);
    return { dataUrl: tinyPngDataUrl, byteLength: 68 };
  },
});

assert.match(html, /^<!doctype html>/);
assert.match(html, /<title>R3 &lt;导出验证&gt;<\/title>/);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /data-theme="dark"/);
assert.match(html, /data:image\/png;base64,/);
assert.match(html, /data:font\/woff2;base64,/);
assert.match(html, /class="katex"/);
assert.match(html, /class="hljs-/);
assert.match(html, /data-exported-mermaid="true"/);
assert.match(html, /Mermaid 渲染失败，请检查图表语法。/);
assert.doesNotMatch(html, /mock Mermaid parse error/);
assert.match(html, /查看 Mermaid 源码/);
assert.match(html, /class="markdown-table-scroll"/);
assert.match(html, /class="task-item task-item-checked"/);
assert.match(html, /id="r3-导出验证"/);
assert.doesNotMatch(html, /menghan-image:\/\//);
assert.doesNotMatch(html, /[A-Z]:\\/);
assert.doesNotMatch(html, /read-markdown-export-image|ipcRenderer|cdn\.jsdelivr|unpkg\.com/i);
assert.doesNotMatch(html, /fonts\/KaTeX_|katex\.min\.css/);
assert.doesNotMatch(html, /markdown-code-copy-button|markdown-code-language-label|markdown-heading-anchor|mermaid-toolbar/);
assert.doesNotMatch(html, /data-(?:menghan|wiki|navigation|highlighted|task-mode|type|checked)=/);
assert.doesNotMatch(html, /javascript:|onerror=/i);
assert.doesNotMatch(html, /<script/i);

let remoteReads = 0;
const remoteHtml = await renderMarkdownExport({ title: '网络图片', markdown: '![remote](https://example.test/image.png)\n\n![duplicate](https://example.test/image.png)',
  resolvedTheme: 'light', resolveImageDataUrl: async source => { assert.equal(source, 'https://example.test/image.png'); remoteReads++; return { dataUrl: tinyPngDataUrl, byteLength: 68 }; } });
assert.equal(remoteReads, 1);
assert.doesNotMatch(remoteHtml, /src="https?:/);
assert.equal(new JSDOM(remoteHtml).window.document.querySelectorAll('img[src^="data:"]').length, 2);
await assert.rejects(renderMarkdownExport({ title: '断网图片', markdown: '![offline](https://example.test/offline.png)', resolvedTheme: 'light',
  resolveImageDataUrl: async () => { throw new Error('网络不可用'); } }), /offline.png.*网络不可用/);

await assert.rejects(
  renderMarkdownExport({
    title: '单图超限',
    markdown: '![large](large.png)',
    currentPath,
    libraryPath,
    resolvedTheme: 'light',
    resolveImageDataUrl: async () => ({
      dataUrl: tinyPngDataUrl,
      byteLength: markdownExportLimits.maxImageBytes + 1,
    }),
  }),
  /单张图片.*超过 10 MB 上限/,
);

await assert.rejects(
  renderMarkdownExport({
    title: '图片总量超限',
    markdown: '![1](one.png)\n\n![2](two.png)\n\n![3](three.png)',
    currentPath,
    libraryPath,
    resolvedTheme: 'light',
    resolveImageDataUrl: async () => ({
      dataUrl: tinyPngDataUrl,
      byteLength: markdownExportLimits.maxImageBytes,
    }),
  }),
  /图片合计.*超过 25 MB 上限/,
);

assert.throws(
  () => assertMarkdownExportHtmlSize('x'.repeat(markdownExportLimits.maxHtmlBytes + 1)),
  /导出文件.*超过 40 MB 上限/,
);

const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const imageProtocolSource = readFileSync(path.join(rootDir, 'electron', 'editorImageProtocol.ts'), 'utf8');
const markdownExportSource = readFileSync(path.join(rootDir, 'src', 'utils', 'markdownExport.ts'), 'utf8');
const viteConfigSource = readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf8');
const sizeCheckIndex = mainSource.indexOf("Buffer.byteLength(html, 'utf8')");
const dialogIndex = mainSource.indexOf('dialog.showSaveDialog', sizeCheckIndex);
assert.ok(sizeCheckIndex >= 0 && dialogIndex > sizeCheckIndex,
  'Main process must reject oversized HTML before opening a destination or writing a file.');
assert.match(imageProtocolSource, /resolveEditorImageRequestPath\(rawUrl, libraryPath\)/,
  'Export image reads must reuse the existing real-path and library-boundary validator.');
assert.match(imageProtocolSource, /stat\.size > maxBytes/,
  'The main process must enforce the per-image limit before reading image bytes.');
assert.equal(
  [...markdownExportSource.matchAll(/\.woff2\?markdown-export-inline/g)].length,
  20,
  'Every KaTeX WOFF2 used by the export must opt into forced production inlining.',
);
assert.match(viteConfigSource, /inlineMarkdownExportFonts\(\)/,
  'The production build must provide the dedicated Markdown export font inliner.');
assert.match(viteConfigSource, /data:font\/woff2;base64/,
  'The production font inliner must emit data URLs rather than packaged asset paths.');

console.log('Markdown export verification passed');
