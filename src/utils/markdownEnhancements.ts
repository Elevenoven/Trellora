import mermaid from 'mermaid';
import { common, createLowlight } from 'lowlight';
import { copyPlainText } from './clipboard';
import { enhanceHeadingAnchors } from './headingAnchors';
import type { ResolvedTheme } from './theme';

export interface MarkdownEnhancementOptions {
  resolvedTheme: ResolvedTheme;
  showCodeCopyActions?: boolean;
  renderMermaid?: boolean;
  interactive?: boolean;
  signal?: AbortSignal;
  yieldControl?: (signal?: AbortSignal) => Promise<void>;
}

export const markdownEnhancementLimits = {
  maxCodeBlockCharacters: 100_000,
  totalHighlightCharacters: 300_000,
  enhancementBatchSize: 10,
  mermaidConcurrency: 2,
  maxMermaidPngDimension: 4_096,
  maxMermaidPngPixels: 16_000_000,
} as const;

let nextMermaidDiagramId = 0;
const syntaxHighlighter = createLowlight(common);
const languageAliases: Record<string, string> = {
  c: 'c',
  'c++': 'cpp',
  cs: 'csharp',
  html: 'xml',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  txt: 'plaintext',
  yml: 'yaml',
};

interface HighlightNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HighlightNode[];
}

/** Apply the DOM-only enhancements shared by the live preview and HTML export. */
export async function enhanceMarkdownContainer(
  container: HTMLElement,
  options: MarkdownEnhancementOptions,
): Promise<void> {
  if (options.signal?.aborted) return;
  const yieldControl = options.yieldControl ?? yieldMarkdownEnhancementTask;

  enhanceHeadingAnchors(container);
  await wrapMarkdownTables(container, yieldControl, options.signal);
  if (options.signal?.aborted) return;

  const codeBlocks = [...container.querySelectorAll<HTMLElement>('pre code')];
  const regularCodeBlocks = codeBlocks.filter((block) => options.renderMermaid === false || !block.classList.contains('language-mermaid'));
  let highlightedCharacters = 0;
  let highlightBudgetExhausted = false;

  for (let index = 0; index < regularCodeBlocks.length; index += 1) {
    if (options.signal?.aborted) return;
    const block = regularCodeBlocks[index];
    const remainingBudget = highlightBudgetExhausted
      ? 0
      : markdownEnhancementLimits.totalHighlightCharacters - highlightedCharacters;
    highlightedCharacters += highlightCodeBlock(
      block,
      remainingBudget,
    );
    if (block.dataset.highlightSkipped === 'budget') highlightBudgetExhausted = true;
    if (options.showCodeCopyActions) addCodeTools(block);

    if ((index + 1) % markdownEnhancementLimits.enhancementBatchSize === 0) {
      await yieldControl(options.signal);
    }
  }

  if (options.signal?.aborted) return;
  const mermaidBlocks = options.renderMermaid === false ? [] : codeBlocks.filter((block) => block.classList.contains('language-mermaid'));
  if (mermaidBlocks.length === 0) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: options.resolvedTheme === 'dark' ? 'dark' : 'default',
  });

  await renderMermaidBlocks(container, mermaidBlocks, {
    interactive: options.interactive ?? false,
    signal: options.signal,
    yieldControl,
  });
}

const codeLanguageLabels: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  go: 'Go',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  php: 'PHP',
  plaintext: '纯文本',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  shell: 'Shell',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

function addCodeTools(block: HTMLElement): void {
  const pre = block.closest('pre');
  if (!pre || pre.querySelector(':scope > .markdown-code-copy-button')) return;

  const language = block.dataset.highlightedLanguage ?? 'plaintext';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'markdown-code-language-label';
  languageLabel.textContent = codeLanguageLabels[language] ?? language.toUpperCase();
  languageLabel.setAttribute('aria-label', `代码语言：${languageLabel.textContent}`);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'markdown-code-copy-button';
  button.dataset.state = 'idle';
  button.setAttribute('aria-label', '复制代码');
  button.setAttribute('aria-live', 'polite');
  button.title = '复制代码';
  button.textContent = '复制代码';

  let resetTimer: number | undefined;
  button.addEventListener('click', () => {
    const source = getCodeBlockCopyText(block.textContent ?? '');
    void copyPlainText(source).then((copied) => {
      window.clearTimeout(resetTimer);
      button.dataset.state = copied ? 'success' : 'error';
      button.textContent = copied ? '已复制' : '复制失败';
      button.title = button.textContent;
      button.setAttribute('aria-label', button.textContent);
      resetTimer = window.setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.state = 'idle';
        button.textContent = '复制代码';
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
      }, 1_800);
    });
  });

  pre.classList.add('has-code-copy-action');
  pre.appendChild(languageLabel);
  pre.appendChild(button);
}

function getCodeBlockCopyText(source: string): string {
  return source.replace(/\r?\n$/, '');
}

function highlightCodeBlock(block: HTMLElement, remainingBudget: number): number {
  const source = block.textContent ?? '';
  if (!source) {
    block.dataset.highlightedLanguage = 'plaintext';
    return 0;
  }
  if (source.length > markdownEnhancementLimits.maxCodeBlockCharacters) {
    block.dataset.highlightedLanguage = 'plaintext';
    block.dataset.highlightSkipped = 'size';
    return 0;
  }
  if (source.length > remainingBudget) {
    block.dataset.highlightedLanguage = 'plaintext';
    block.dataset.highlightSkipped = 'budget';
    return 0;
  }

  const declaredLanguage = [...block.classList]
    .find((className) => className.startsWith('language-'))
    ?.slice('language-'.length)
    .toLowerCase();
  const language = declaredLanguage ? languageAliases[declaredLanguage] ?? declaredLanguage : null;

  try {
    const hasRegisteredLanguage = Boolean(language && syntaxHighlighter.registered(language));
    const highlighted = hasRegisteredLanguage && language
      ? syntaxHighlighter.highlight(language, source)
      : syntaxHighlighter.highlightAuto(source);
    const fragment = document.createDocumentFragment();
    appendHighlightNodes(fragment, highlighted.children as HighlightNode[]);
    if (fragment.textContent !== source) {
      block.dataset.highlightedLanguage = 'plaintext';
      return source.length;
    }
    block.replaceChildren(fragment);
    block.classList.add('hljs');
    block.dataset.highlightedLanguage = hasRegisteredLanguage
      ? language ?? 'plaintext'
      : highlighted.data?.language ?? 'plaintext';
  } catch {
    block.dataset.highlightedLanguage = 'plaintext';
  }
  return source.length;
}

function appendHighlightNodes(parent: Node, nodes: HighlightNode[]): void {
  nodes.forEach((node) => {
    if (node.type === 'text') {
      parent.appendChild(document.createTextNode(node.value ?? ''));
      return;
    }
    if (node.type !== 'element') return;

    const span = document.createElement('span');
    const classNames = Array.isArray(node.properties?.className)
      ? node.properties.className
      : [node.properties?.className];
    classNames
      .filter((className): className is string => typeof className === 'string' && /^hljs-[\w-]+$/.test(className))
      .forEach((className) => span.classList.add(className));
    appendHighlightNodes(span, node.children ?? []);
    parent.appendChild(span);
  });
}

async function wrapMarkdownTables(
  container: HTMLElement,
  yieldControl: NonNullable<MarkdownEnhancementOptions['yieldControl']>,
  signal?: AbortSignal,
): Promise<void> {
  const tables = [...container.querySelectorAll<HTMLTableElement>('table')];
  for (let index = 0; index < tables.length; index += 1) {
    if (signal?.aborted) return;
    const table = tables[index];
    if (!table.parentElement?.classList.contains('markdown-table-scroll')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll';
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', '可横向滚动的表格');
      wrapper.tabIndex = 0;
      table.before(wrapper);
      wrapper.appendChild(table);
    }
    if ((index + 1) % markdownEnhancementLimits.enhancementBatchSize === 0) {
      await yieldControl(signal);
    }
  }
}

interface MermaidRenderOptions {
  interactive: boolean;
  signal?: AbortSignal;
  yieldControl: NonNullable<MarkdownEnhancementOptions['yieldControl']>;
}

async function renderMermaidBlocks(
  container: HTMLElement,
  blocks: HTMLElement[],
  options: MermaidRenderOptions,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(markdownEnhancementLimits.mermaidConcurrency, blocks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!options.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= blocks.length) return;
      await renderMermaidBlock(container, blocks[index], options);
      await options.yieldControl(options.signal);
    }
  });
  await Promise.all(workers);
}

async function renderMermaidBlock(
  container: HTMLElement,
  block: HTMLElement,
  options: MermaidRenderOptions,
): Promise<void> {
  const source = block.textContent ?? '';
  const pre = block.closest('pre');
  if (!pre) return;

  try {
    const id = `menghan-mermaid-${++nextMermaidDiagramId}`;
    const { svg, bindFunctions } = await mermaid.render(id, source);
    if (options.signal?.aborted || !container.contains(pre)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-preview';
    const canvas = document.createElement('div');
    canvas.className = 'mermaid-preview-canvas';
    canvas.innerHTML = svg;
    wrapper.appendChild(canvas);
    pre.replaceWith(wrapper);
    bindFunctions?.(canvas);

    const renderedSvg = canvas.querySelector<SVGSVGElement>('svg');
    if (renderedSvg) {
      applyMermaidScale(renderedSvg, 1, true);
      if (options.interactive) wrapper.prepend(createMermaidToolbar(renderedSvg));
    }
  } catch {
    if (options.signal?.aborted || !container.contains(pre)) return;
    pre.replaceWith(createMermaidError(source));
  }
}

function createMermaidToolbar(svg: SVGSVGElement): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Mermaid 图表工具');
  toolbar.dataset.markdownExportExclude = 'true';
  let scale = 1;
  let fitToWidth = true;

  const status = document.createElement('span');
  status.className = 'mermaid-toolbar-status';
  status.setAttribute('aria-live', 'polite');
  const scaleLabel = document.createElement('output');
  scaleLabel.className = 'mermaid-toolbar-scale';
  scaleLabel.textContent = '适应';
  scaleLabel.setAttribute('aria-live', 'polite');

  const updateScale = (delta: number) => {
    fitToWidth = false;
    scale = Math.min(4, Math.max(0.25, scale + delta));
    applyMermaidScale(svg, scale, false);
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  toolbar.append(
    createMermaidToolButton('−', '缩小图表', 'zoom-out', () => updateScale(-0.25)),
    scaleLabel,
    createMermaidToolButton('+', '放大图表', 'zoom-in', () => updateScale(0.25)),
    createMermaidToolButton('↔', '适应宽度', 'fit', () => {
      fitToWidth = true;
      scale = 1;
      applyMermaidScale(svg, scale, fitToWidth);
      scaleLabel.textContent = '适应';
    }),
  );

  const spacer = document.createElement('span');
  spacer.className = 'mermaid-toolbar-spacer';
  toolbar.append(spacer, status);
  toolbar.append(
    createMermaidToolButton('SVG', '复制 SVG', 'copy-svg', () => {
      try {
        void copyPlainText(serializeMermaidSvg(svg)).then((copied) => {
          status.textContent = copied ? 'SVG 已复制' : '复制失败';
        });
      } catch {
        status.textContent = '复制失败';
      }
    }),
    createMermaidToolButton('PNG', '导出 PNG', 'export-png', () => {
      status.textContent = '正在生成 PNG';
      void exportMermaidPng(svg).then(
        () => { status.textContent = 'PNG 已导出'; },
        () => { status.textContent = 'PNG 导出失败'; },
      );
    }),
  );
  return toolbar;
}

function createMermaidToolButton(
  label: string,
  accessibleLabel: string,
  action: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mermaid-toolbar-button';
  button.dataset.action = action;
  button.setAttribute('aria-label', accessibleLabel);
  button.title = accessibleLabel;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function applyMermaidScale(svg: SVGSVGElement, scale: number, fitToWidth: boolean): void {
  svg.style.width = fitToWidth ? '100%' : `${Math.round(scale * 100)}%`;
  svg.style.maxWidth = fitToWidth ? '100%' : 'none';
  svg.style.height = 'auto';
  svg.dataset.fitToWidth = fitToWidth ? 'true' : 'false';
  svg.dataset.scale = String(scale);
}

function createMermaidError(source: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mermaid-preview mermaid-error';
  const message = document.createElement('p');
  message.className = 'mermaid-error-message';
  message.textContent = 'Mermaid 渲染失败，请检查图表语法。';

  const sourceDetails = document.createElement('details');
  sourceDetails.className = 'mermaid-source-details';
  const summary = document.createElement('summary');
  summary.textContent = '查看 Mermaid 源码';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  sourceDetails.append(summary, pre);
  wrapper.append(message, sourceDetails);
  return wrapper;
}

function serializeMermaidSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const Serializer = svg.ownerDocument.defaultView?.XMLSerializer;
  if (!Serializer) throw new Error('当前环境不支持 SVG 序列化。');
  return new Serializer().serializeToString(clone);
}

async function exportMermaidPng(svg: SVGSVGElement): Promise<void> {
  const view = svg.ownerDocument.defaultView;
  if (!view?.URL?.createObjectURL) throw new Error('当前环境不支持 PNG 导出。');
  const serialized = serializeMermaidSvg(svg);
  const sourceUrl = view.URL.createObjectURL(new view.Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = await loadImage(view, sourceUrl);
    const size = resolveMermaidPngSize(svg, image.naturalWidth, image.naturalHeight);
    const canvas = svg.ownerDocument.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PNG 画布。');
    context.drawImage(image, 0, 0, size.width, size.height);
    const png = await canvasToBlob(canvas);
    downloadBlob(svg.ownerDocument, png, 'mermaid-diagram.png');
  } finally {
    view.URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(view: Window, source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = view.document.createElement('img');
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG 无法转换为 PNG。'));
    image.src = source;
  });
}

function resolveMermaidPngSize(
  svg: SVGSVGElement,
  imageWidth: number,
  imageHeight: number,
): { width: number; height: number } {
  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  const sourceWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : imageWidth || 1_200;
  const sourceHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : imageHeight || 800;
  const dimensionScale = Math.min(
    2,
    markdownEnhancementLimits.maxMermaidPngDimension / Math.max(sourceWidth, sourceHeight),
  );
  const pixelScale = Math.sqrt(
    markdownEnhancementLimits.maxMermaidPngPixels / Math.max(1, sourceWidth * sourceHeight),
  );
  const scale = Math.max(0.01, Math.min(dimensionScale, pixelScale));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败。'));
    }, 'image/png');
  });
}

function downloadBlob(document: Document, blob: Blob, fileName: string): void {
  const view = document.defaultView;
  if (!view?.URL?.createObjectURL) throw new Error('当前环境不支持文件导出。');
  const url = view.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
}

async function yieldMarkdownEnhancementTask(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const schedulerWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    const finish = () => {
      if (idleHandle !== undefined) schedulerWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    signal?.addEventListener('abort', finish, { once: true });
    if (schedulerWindow.requestIdleCallback) {
      idleHandle = schedulerWindow.requestIdleCallback(finish, { timeout: 32 });
    } else {
      timeoutHandle = window.setTimeout(finish, 0);
    }
  });
}
