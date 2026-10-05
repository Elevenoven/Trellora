import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-editor-mermaid');
const outFile = path.join(outDir, 'code-block-node-view.cjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let previewWidth = 800;
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return this.classList?.contains('mermaid-editor-preview') ? previewWidth : 0;
  },
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'CodeBlockNodeView.tsx')],
  outfile: outFile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@codemirror/*',
    '@replit/codemirror-lang-csharp',
  ],
  plugins: [{
    name: 'mock-editor-mermaid-dependencies',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'verify-editor-mermaid' }));
      buildContext.onLoad({ filter: /^mermaid$/, namespace: 'verify-editor-mermaid' }, () => ({
        loader: 'js',
        contents: `
          const stats = globalThis.__editorMermaidStats ??= { themes: [], calls: 0, parseCalls: [], renderHostConnected: [], renderHostIsBody: [] };
          const mermaid = {
            initialize(options) { stats.themes.push(options.theme); },
            async parse(source, options) {
              stats.parseCalls.push({ source, options });
              return source.includes('BROKEN_MERMAID') ? false : { diagramType: 'flowchart' };
            },
            async render(id, source, renderHost) {
              stats.calls += 1;
              stats.renderHostConnected.push(renderHost?.isConnected ?? null);
              stats.renderHostIsBody.push(renderHost === document.body);
              if (source.includes('RUNTIME_FAILURE')) {
                const errorSurface = document.createElement('div');
                errorSurface.dataset.mermaidGlobalError = 'true';
                (renderHost ?? document.body).append(errorSurface);
                throw new Error('mock renderer details');
              }
              const viewBox = source.includes('WIDE_DIAGRAM') ? '0 0 1200 240' : '0 0 200 600';
              return { svg: '<svg data-editor-mermaid-id="' + id + '" data-source="' + encodeURIComponent(source) + '" viewBox="' + viewBox + '"></svg>' };
            },
          };
          export default mermaid;
        `,
      }));
      buildContext.onResolve({ filter: /^@tiptap\/react$/ }, () => ({ path: 'tiptap-react', namespace: 'verify-editor-mermaid' }));
      buildContext.onLoad({ filter: /^tiptap-react$/, namespace: 'verify-editor-mermaid' }, () => ({
        loader: 'js',
        contents: `
          import { createElement } from 'react';
          export const NodeViewWrapper = ({ as: Tag = 'div', children, ...props }) => createElement(Tag, props, children);
          export const NodeViewContent = ({ as: Tag = 'div', children, ...props }) => createElement(Tag, props, children);
        `,
      }));
    },
  }],
});

const require = createRequire(import.meta.url);
const { default: CodeBlockNodeView } = require(outFile);

const mount = document.createElement('div');
document.body.append(mount);
const root = createRoot(mount);

function node(language, textContent) {
  return { attrs: { language }, textContent };
}

async function renderCodeBlock(nextNode, delay = 280) {
  await act(async () => {
    root.render(React.createElement(CodeBlockNodeView, { node: nextNode }));
  });
  if (delay > 0) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, delay));
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

const validSource = 'flowchart TD\n  A[开始] --> B[完成]';
await renderCodeBlock(node('mermaid', validSource));
const initialSvg = mount.querySelector('svg[data-editor-mermaid-id]');
assert.ok(initialSvg, 'A Mermaid code block must render an SVG in the editor.');
assert.equal(decodeURIComponent(initialSvg?.getAttribute('data-source') ?? ''), validSource);
assert.ok(Number.parseFloat(initialSvg?.style.height ?? '') <= 354, 'Tall diagrams must fit the bounded preview height instead of being enlarged to full width.');
assert.ok(Number.parseFloat(initialSvg?.style.width ?? '') < previewWidth, 'A narrow vertical diagram must not be stretched across the editor width.');
assert.ok(Number.parseFloat(initialSvg?.dataset.fitScale ?? '') > 0, 'Fitted diagrams must expose the applied scale for diagnostics.');
assert.ok(mount.querySelector('.mermaid-editor-preview'), 'The editor must keep a dedicated Mermaid preview surface.');
assert.ok(mount.querySelector('.mermaid-editor-source code.language-mermaid'), 'The Mermaid source must remain an editable code surface.');
const expandButton = mount.querySelector('button[aria-label="全屏查看 Mermaid 图表"]');
assert.ok(expandButton, 'A rendered Mermaid editor preview must expose a detail-view button.');
await act(async () => {
  expandButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
});
const diagramViewer = document.querySelector('dialog.mermaid-diagram-viewer');
assert.ok(diagramViewer?.hasAttribute('open'), 'The Mermaid detail view must open in a modal dialog.');
assert.ok(diagramViewer?.querySelector('svg[data-editor-mermaid-id]'), 'The detail view must retain the rendered SVG for inspection.');
await act(async () => {
  diagramViewer?.querySelector('button[aria-label="关闭 Mermaid 图表查看器"]')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
});
assert.equal(document.querySelector('dialog.mermaid-diagram-viewer'), null, 'Closing the Mermaid detail view must remove its modal dialog.');

await act(async () => {
  document.documentElement.dataset.theme = 'dark';
  await Promise.resolve();
});
await act(async () => {
  await new Promise(resolve => setTimeout(resolve, 280));
  await Promise.resolve();
  await Promise.resolve();
});
assert.equal(globalThis.__editorMermaidStats.themes.at(-1), 'dark', 'Theme changes must re-render editor Mermaid diagrams.');

await renderCodeBlock(node('mermaid', 'flowchart LR\n  WIDE_DIAGRAM --> B'));
const wideSvg = mount.querySelector('svg[data-editor-mermaid-id]');
const initialWideWidth = Number.parseFloat(wideSvg?.style.width ?? '');
assert.ok(initialWideWidth <= previewWidth, 'Wide diagrams must initially fit the editor width.');
previewWidth = 420;
await act(async () => {
  window.dispatchEvent(new dom.window.Event('resize'));
  await Promise.resolve();
});
const resizedWideWidth = Number.parseFloat(wideSvg?.style.width ?? '');
assert.ok(resizedWideWidth <= previewWidth, 'Diagram scale must update when the editor becomes narrower.');
assert.ok(resizedWideWidth < initialWideWidth, 'A narrower editor must reduce the fitted Mermaid width.');

const renderCallsBeforeBrokenSource = globalThis.__editorMermaidStats.calls;
await renderCodeBlock(node('mermaid', 'BROKEN_MERMAID'));
const errorText = mount.querySelector('.mermaid-editor-preview-error')?.textContent ?? '';
assert.match(errorText, /Mermaid 渲染失败，请检查图表语法。/);
assert.equal(globalThis.__editorMermaidStats.calls, renderCallsBeforeBrokenSource, 'Invalid Mermaid source must not reach the renderer.');
assert.ok(
  globalThis.__editorMermaidStats.parseCalls.some(({ source, options }) => source.includes('BROKEN_MERMAID') && options?.suppressErrors === true),
  'Syntax validation must suppress Mermaid global parse errors.',
);

await renderCodeBlock(node('mermaid', 'flowchart TD\n  RUNTIME_FAILURE --> B'));
assert.match(mount.querySelector('.mermaid-editor-preview-error')?.textContent ?? '', /Mermaid 渲染失败，请检查图表语法。/);
assert.equal(document.querySelector('[data-mermaid-global-error="true"]'), null, 'Mermaid error diagrams must never be attached to the document body.');
assert.ok(
  globalThis.__editorMermaidStats.renderHostConnected.every(value => value === true)
    && globalThis.__editorMermaidStats.renderHostIsBody.every(value => value === false),
  'Mermaid must render through an attached but isolated host so layout succeeds without altering the page.',
);

await act(async () => root.unmount());
mount.remove();
console.log('Editor Mermaid rendering verification passed');
