import { Marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { toEditorImageUrl } from '../../shared/editorImageProtocol';
import { createRelaxedStrongExtension, createWikiLinkExtension, prepareMarkdownDocument } from './markdownExtensions';
import { createMathMarkdownExtension } from './markdownMath';

const htmlNotePattern = /^<(article|blockquote|div|h[1-6]|ol|p|pre|table|ul)\b/i;
const searchMarkPattern = /<mark[^>]*>([\s\S]*?)<\/mark>/gi;
const orderedListStartAttributePattern = /\sstart\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const blockElementPattern = /^\s*<(address|article|aside|blockquote|div|dl|figure|h[1-6]|hr|ol|p|pre|table|ul)\b/i;
const preservedBlankLineToken = 'MENGHAN_PRESERVED_BLANK_LINE_7D3A';
const preservedBlankLineHtml = '<p data-menghan-blank-line="true"></p>';

export interface MarkdownAssetContext {
    currentPath?: string | null;
    libraryPath?: string | null;
    externalAssetUrls?: Record<string, string>;
}

export type TaskListInteractionMode = 'editor' | 'readonly';

export interface MarkdownRenderContext extends MarkdownAssetContext {
  taskListMode?: TaskListInteractionMode;
}

export type MarkdownLineAnchorKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'listItem'
  | 'code'
  | 'thematicBreak'
  | 'tableRow';

export interface MarkdownLineAnchor {
  line: number;
  kind: MarkdownLineAnchorKind;
  text: string;
}

export interface MarkdownLineTarget {
  line: number;
  element: HTMLElement;
}

export function isProbablyHtmlNote(content: string): boolean {
  return htmlNotePattern.test(content.trim());
}

export function stripSearchMarks(html: string): string {
  return html.replace(searchMarkPattern, '$1');
}

export function markdownToHtml(markdown: string, renderContext?: MarkdownRenderContext): string {
  const parser = new Marked(
    createWikiLinkExtension(),
    createRelaxedStrongExtension(),
    createMathMarkdownExtension((token) => {
      const block = token.type === 'markdownMathBlock';
      const tag = block ? 'div' : 'span';
      return `<${tag} data-type="${block ? 'formulaBlock' : 'inlineFormula'}" data-math-source="${escapeHtml(token.text)}" data-math-markdown="${escapeHtml(token.raw)}" data-math-delimiter="${escapeHtml(token.delimiter)}" data-math-display="${token.displayMode}"><code>${escapeHtml(token.text)}</code></${tag}>${block ? '\n' : ''}`;
    }),
  );
  return markdownToHtmlWithParser(
    markdown,
    (preparedMarkdown) => parser.parse(preparedMarkdown, {
      async: false,
      breaks: false,
      gfm: true,
    }) as string,
    renderContext,
  );
}

export function markdownToHtmlWithParser(
  markdown: string,
  parser: (preparedMarkdown: string) => string,
  renderContext?: MarkdownRenderContext,
): string {
  const html = parser(preserveExtraBlankLines(normalizeLegacyTableCellCodeBlocks(markdown)));
  const taskListMode = renderContext?.taskListMode ?? 'editor';
  return normalizeImageSources(
    normalizeOrderedListStarts(normalizeTaskListMarkup(html, taskListMode)),
    renderContext,
  );
}

export function contentToEditorHtml(content: string, assetContext?: MarkdownAssetContext): string {
  const body = prepareMarkdownDocument(content, 'strip').markdown;
  if (body === '') return '';
  return isProbablyHtmlNote(body)
    ? normalizeImageSources(normalizeOrderedListStarts(body), assetContext)
    : markdownToHtml(body, { ...assetContext, taskListMode: 'editor' });
}

/** Keep validated source metadata outside the editable body and preserve its exact bytes. */
export function htmlToMarkdown(html: string, originalMarkdown = ''): string {
  const cleanHtml = normalizeOrderedListStarts(stripSearchMarks(html));
  const turndown = createTurndownService();
  const body = restorePreservedBlankLines(normalizeMarkdownSpacing(turndown.turndown(cleanHtml)));
  const originalBody = prepareMarkdownDocument(originalMarkdown, 'strip').markdown;
  const header = originalMarkdown.slice(0, originalMarkdown.length - originalBody.length);
  const separator = header && body && !header.endsWith('\n') ? '\n' : '';
  return header + separator + body;
}

/**
 * Browsers and pasted HTML can carry an empty or non-numeric ordered-list
 * start attribute. Letting it reach Tiptap/Turndown turns every marker into
 * `NaN.`. Removing only invalid start attributes preserves valid custom starts.
 */
export function normalizeOrderedListStarts(html: string): string {
  return html.replace(/<ol\b([^>]*)>/gi, (tag, attributes: string) => {
    const normalizedAttributes = attributes.replace(
      orderedListStartAttributePattern,
      (attribute, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
        const rawStart = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();
        return /^[+-]?\d+$/.test(rawStart) ? attribute : '';
      },
    );

    return `<ol${normalizedAttributes}>`;
  });
}

function createTurndownService(): TurndownService {
  const turndown = new TurndownService({
    blankReplacement: (_content, node) => (
      node.nodeName === 'P' && isEmptyEditorParagraph(node as HTMLElement)
        ? `\n\n${preservedBlankLineToken}\n\n`
        : ''
    ),
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    fence: '```',
    headingStyle: 'atx',
    hr: '---',
    strongDelimiter: '**',
  });

  turndown.use(gfm);

  // Literal text from plain paste must survive Markdown parsing, including HTML tags/entities.
  // This applies to text nodes only; code, formulas and explicit HTML/table rules keep their syntax.
  const escapeMarkdownText = turndown.escape.bind(turndown);
  turndown.escape = (text) => escapeMarkdownText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // Backslash breaks survive whitespace cleanup; table cells use their own <br> serializer.
  turndown.addRule('explicitLineBreak', {
    filter: 'br',
    replacement: (_content, node) => (
      (node as HTMLElement).closest('td, th') ? '  \n' : '\\' + '\n'
    ),
  });

  turndown.addRule('formula', {
    filter: (node) => (
      ['formulaBlock', 'inlineFormula'].includes((node as HTMLElement).getAttribute?.('data-type') ?? '')
    ),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const source = element.querySelector(':scope > code')?.textContent ?? element.textContent ?? '';
      const block = element.getAttribute('data-type') === 'formulaBlock';
      const original = element.getAttribute('data-math-markdown');
      const delimiter = element.getAttribute('data-math-delimiter') || (block ? '$$' : '$');
      const closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
      const math = original && source === element.getAttribute('data-math-source')
        ? original
        : `${delimiter}${block ? '\n' : ''}${source}${block ? '\n' : ''}${closing}`;
      return block ? `\n\n${math}\n\n` : math;
    },
  });

  turndown.addRule('tiptapTable', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => serializeMarkdownTable(node as HTMLTableElement, turndown),
  });

  turndown.addRule('tiptapTaskItem', {
    filter: (node) => (
      node.nodeName === 'LI'
      && (node as HTMLElement).getAttribute('data-type') === 'taskItem'
    ),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const checked = element.getAttribute('data-checked') === 'true'
        || element.querySelector('input[type="checkbox"]')?.hasAttribute('checked')
        || (element.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked
        || false;
      const body = element.querySelector(':scope > div') ?? element;
      const bodyMarkdown = turndown
        .turndown(body.innerHTML)
        .trim()
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n/g, '\n  ');

      return `\n- [${checked ? 'x' : ' '}] ${bodyMarkdown}\n`;
    },
  });

  turndown.addRule('fencedCodeBlockWithLanguage', {
    filter: (node) => (
      node.nodeName === 'PRE'
      && node.firstChild?.nodeName === 'CODE'
    ),
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.firstElementChild as HTMLElement | null;
      const rawCode = code?.textContent ?? '';
      const language = getCodeBlockLanguage(pre, code);
      const normalizedCode = rawCode.replace(/\n$/, '');

      return `\n\n\`\`\`${language}\n${normalizedCode}\n\`\`\`\n\n`;
    },
  });

  turndown.addRule('wikiLink', {
    filter: (node) => (
      node.nodeName === 'A'
      && Boolean((node as HTMLElement).getAttribute('data-wiki-link'))
    ),
    replacement: (content, node) => {
      const element = node as HTMLElement;
      const target = element.getAttribute('data-wiki-link')?.trim() ?? '';
      const alias = element.getAttribute('data-wiki-alias')?.trim() || content.trim();
      if (!target) return content;
      if (alias && alias !== target) return `[[${target}|${alias}]]`;
      return `[[${target}]]`;
    },
  });

  turndown.addRule('menghanImage', {
    filter: (node) => (
      node.nodeName === 'IMG'
      && Boolean((node as HTMLElement).getAttribute('data-menghan-relative'))
    ),
    replacement: (_content, node) => {
      const element = node as HTMLImageElement;
      const alt = element.getAttribute('alt') ?? '';
      const relativePath = element.getAttribute('data-menghan-relative') ?? element.getAttribute('src') ?? '';
      return relativePath ? `![${alt}](${relativePath})` : '';
    },
  });

  return turndown;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tiptap serializes tables as `table > colgroup + tbody` and wraps cell
 * content in paragraphs. turndown-plugin-gfm does not recognize that shape,
 * so it keeps the complete table as HTML. Serialize simple tables ourselves;
 * keep merged/nested tables as HTML because GFM cannot represent them without
 * losing row/column span information.
 */
function serializeMarkdownTable(table: HTMLTableElement, turndown: TurndownService): string {
  const rows = Array.from(table.rows);
  const cells = rows.flatMap((row) => Array.from(row.cells));
  const isSimpleTable = rows.length > 0
    && cells.length > 0
    && cells.every((cell) => cell.rowSpan === 1 && cell.colSpan === 1 && !cell.querySelector('table'));
  if (!isSimpleTable) return `\n\n${table.outerHTML}\n\n`;

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const markdownRows = rows.map((row) => {
    const rowCells = Array.from(row.cells).map((cell) => serializeMarkdownTableCell(cell, turndown));
    while (rowCells.length < columnCount) rowCells.push('');
    return `| ${rowCells.join(' | ')} |`;
  });
  const headerCells = Array.from(rows[0].cells);
  const delimiter = `| ${Array.from({ length: columnCount }, (_, index) => markdownTableDelimiter(headerCells[index])).join(' | ')} |`;

  // GFM requires a header row. Headerless pasted/legacy tables therefore use
  // their first row as the header instead of falling back to raw HTML.
  return `\n\n${[markdownRows[0], delimiter, ...markdownRows.slice(1)].join('\n')}\n\n`;
}

function serializeMarkdownTableCell(cell: HTMLTableCellElement, turndown: TurndownService): string {
  if (isEmptyTableCell(cell)) return '';

  const markdown = unwrapTableCellCodeBlock(turndown
    .turndown(cell.innerHTML)
    .trim()
  );

  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n+\s*/g, '<br>')
    .replace(/(^|[^\\])\|/g, '$1\\|');
}

function isEmptyTableCell(cell: HTMLTableCellElement): boolean {
  const children = Array.from(cell.children);
  if (children.length === 0) return !(cell.textContent ?? '').length;

  return children.every((child) => (
    (child.nodeName === 'P' && isEmptyEditorParagraph(child as HTMLElement))
    || (child.nodeName === 'PRE' && !(child.textContent ?? '').length)
  ));
}

/**
 * GFM tables cannot contain block-level fenced code. Flatten a code block
 * which occupies an entire table cell before converting its remaining line
 * breaks to HTML breaks.
 */
function unwrapTableCellCodeBlock(markdown: string): string {
  const match = markdown.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1].trim() : markdown;
}

/**
 * Older table serialization converted a fenced block in a cell into
 * `\`\`\`<br>...<br>\`\`\``. Treat that exact legacy form as normal table-cell
 * content while rendering, without modifying the note source on disk.
 */
function normalizeLegacyTableCellCodeBlocks(markdown: string): string {
  return markdown
    .split(/(\r?\n)/)
    .map((segment) => (
      /^\s*\|.*\|\s*$/.test(segment)
        ? segment.replace(
          /(^|\|)(\s*)```(?:<br\s*\/?>)+([\s\S]*?)(?:<br\s*\/?>)+```(\s*)(?=\||$)/gi,
          (_match, boundary: string, leadingSpace: string, content: string, trailingSpace: string) => (
            `${boundary}${leadingSpace}${content.trim()}${trailingSpace}`
          ),
        )
        : segment
    ))
    .join('');
}

function markdownTableDelimiter(cell: HTMLTableCellElement | undefined): string {
  const alignment = (cell?.getAttribute('align') ?? cell?.style.textAlign ?? '').trim().toLowerCase();
  if (alignment === 'left') return ':---';
  if (alignment === 'center') return ':---:';
  if (alignment === 'right') return '---:';
  return '---';
}

function getCodeBlockLanguage(pre: HTMLElement, code: HTMLElement | null): string {
  const explicitLanguage = pre.getAttribute('data-language')
    ?? code?.getAttribute('data-language')
    ?? '';
  if (explicitLanguage) return explicitLanguage;

  const className = `${pre.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`;
  const match = className.match(/(?:^|\s)language-([\w-]+)/);
  return match?.[1] ?? '';
}

export function normalizeTaskListMarkup(html: string, mode: TaskListInteractionMode): string {
  const withTaskItems = html.replace(
    /<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g,
    (_match, inputAttributes: string, body: string) => {
      const checked = /\bchecked(?:=|[\s>]|$)/i.test(inputAttributes);
      const normalizedBody = blockElementPattern.test(body) ? body.trim() : `<p>${body.trim()}</p>`;
      const accessibleLabel = checked ? '已完成任务' : '未完成任务';
      const readonlyAttributes = mode === 'readonly' ? ' disabled="disabled"' : '';
      return `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}"><label><input type="checkbox" aria-label="${accessibleLabel}"${readonlyAttributes}${checked ? ' checked="checked"' : ''}></label><div>${normalizedBody}</div></li>`;
    },
  );

  return withTaskItems.replace(
    /<ul>\s*((?:<li data-type="taskItem"[\s\S]*?<\/li>\s*)+)<\/ul>/g,
    `<ul data-type="taskList" data-task-mode="${mode}">$1</ul>`,
  );
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

interface PositionedMarkdownNode {
  type?: string;
  value?: string;
  alt?: string;
  children?: PositionedMarkdownNode[];
  position?: {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
  };
}

/**
 * Return source-line anchors for the Markdown blocks that have a visible
 * counterpart in Tiptap. Parent and child nodes may intentionally share a
 * line (for example a list item and its first paragraph); the renderer maps
 * both and keeps only the first visible marker for that source line.
 */
export function getMarkdownLineAnchors(markdown: string): MarkdownLineAnchor[] {
  const body = prepareMarkdownDocument(markdown, 'strip').markdown;
  if (!body.trim() || isProbablyHtmlNote(body)) return [];

  // Metadata has no rendered nodes; body anchors still point to full-source line numbers.
  const lineOffset = markdown.slice(0, markdown.length - body.length).split('\n').length - 1;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as PositionedMarkdownNode;
  const anchors: MarkdownLineAnchor[] = [];

  const collect = (node: PositionedMarkdownNode) => {
    const kind = toMarkdownLineAnchorKind(node.type);
    const line = node.position?.start?.line;
    if (kind && typeof line === 'number') {
      anchors.push({
        line: line + lineOffset,
        kind,
        text: markdownNodeText(node),
      });
    }
    node.children?.forEach(collect);
  };

  tree.children?.forEach(collect);
  return anchors;
}

const markdownLineAnchorSelectors: Record<MarkdownLineAnchorKind, string> = {
  heading: 'h1, h2, h3, h4, h5, h6',
  paragraph: 'p',
  blockquote: 'blockquote',
  listItem: 'li',
  code: 'pre',
  thematicBreak: 'hr',
  tableRow: 'tr',
};

export function mapMarkdownLineTargets(markdown: string, root: ParentNode): MarkdownLineTarget[] {
  const anchors = getMarkdownLineAnchors(markdown);
  const pools = new Map<MarkdownLineAnchorKind, { candidates: HTMLElement[]; cursor: number }>();
  const seenLines = new Set<number>();
  const targets: MarkdownLineTarget[] = [];

  for (const anchor of anchors) {
    let pool = pools.get(anchor.kind);
    if (!pool) {
      const candidates = [...root.querySelectorAll<HTMLElement>(markdownLineAnchorSelectors[anchor.kind])]
        .filter((candidate) => anchor.kind !== 'paragraph' || !candidate.closest('td, th'));
      pool = { candidates, cursor: 0 };
      pools.set(anchor.kind, pool);
    }

    const candidateIndex = findMarkdownLineCandidate(pool.candidates, pool.cursor, anchor.text);
    if (candidateIndex === -1) continue;
    const candidate = pool.candidates[candidateIndex];
    pool.cursor = candidateIndex + 1;
    if (seenLines.has(anchor.line)) continue;
    targets.push({ line: anchor.line, element: candidate });
    seenLines.add(anchor.line);
  }

  return targets;
}

export function findMarkdownLineTarget(
  markdown: string,
  root: ParentNode,
  targetLine: number,
): HTMLElement | undefined {
  let nearestBefore: MarkdownLineTarget | undefined;
  for (const target of mapMarkdownLineTargets(markdown, root)) {
    if (target.line === targetLine) return target.element;
    if (target.line > targetLine) return nearestBefore?.element ?? target.element;
    nearestBefore = target;
  }
  return nearestBefore?.element;
}

export function normalizeMarkdownSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-Hans-CN');
}

function findMarkdownLineCandidate(candidates: HTMLElement[], startIndex: number, anchorText: string): number {
  if (startIndex >= candidates.length) return -1;
  const normalizedAnchor = normalizeMarkdownSearchText(anchorText);
  if (!normalizedAnchor) return startIndex;
  const anchorProbe = normalizedAnchor.slice(0, 96);

  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidateText = normalizeMarkdownSearchText(
      candidates[index].innerText ?? candidates[index].textContent ?? '',
    );
    if (candidateText.includes(anchorProbe) || anchorProbe.includes(candidateText.slice(0, 72))) {
      return index;
    }
  }

  return startIndex;
}

function toMarkdownLineAnchorKind(type: string | undefined): MarkdownLineAnchorKind | null {
  switch (type) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'listItem':
    case 'code':
    case 'thematicBreak':
    case 'tableRow':
      return type;
    default:
      return null;
  }
}

function markdownNodeText(node: PositionedMarkdownNode): string {
  const ownText = node.value ?? node.alt ?? '';
  const childText = node.children?.map(markdownNodeText).filter(Boolean).join(' ') ?? '';
  return `${ownText} ${childText}`.replace(/\s+/g, ' ').trim();
}

function preserveExtraBlankLines(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as { children?: PositionedMarkdownNode[] };
  const children = tree.children ?? [];
  if (children.length === 0) {
    const blankLineCount = markdown.split('\n').length - 1;
    return Array.from({ length: blankLineCount }, () => preservedBlankLineHtml).join('\n\n');
  }

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const firstStartOffset = children[0].position?.start?.offset;
  if (typeof firstStartOffset === 'number' && firstStartOffset > 0) {
    const leadingBlankLineCount = markdown.slice(0, firstStartOffset).split('\n').length - 1;
    if (leadingBlankLineCount > 0) {
      replacements.push({
        start: 0,
        end: firstStartOffset,
        value: `${Array.from({ length: leadingBlankLineCount }, () => preservedBlankLineHtml).join('\n\n')}\n\n`,
      });
    }
  }

  for (let index = 1; index < children.length; index += 1) {
    const previousEnd = children[index - 1].position?.end;
    const currentStart = children[index].position?.start;
    if (
      typeof previousEnd?.offset !== 'number'
      || typeof previousEnd.line !== 'number'
      || typeof currentStart?.offset !== 'number'
      || typeof currentStart.line !== 'number'
    ) continue;

    const extraBlankLineCount = currentStart.line - previousEnd.line - 2;
    if (extraBlankLineCount <= 0) continue;
    const placeholders = Array.from({ length: extraBlankLineCount }, () => preservedBlankLineHtml).join('\n\n');
    replacements.push({
      start: previousEnd.offset,
      end: currentStart.offset,
      value: `\n\n${placeholders}\n\n`,
    });
  }

  const lastEndOffset = children.at(-1)?.position?.end?.offset;
  if (typeof lastEndOffset === 'number' && lastEndOffset < markdown.length) {
    const trailingNewlineCount = markdown.slice(lastEndOffset).split('\n').length - 1;
    const trailingBlankLineCount = Math.max(0, trailingNewlineCount - 1);
    if (trailingBlankLineCount > 0) {
      replacements.push({
        start: lastEndOffset,
        end: markdown.length,
        value: `\n\n${Array.from({ length: trailingBlankLineCount }, () => preservedBlankLineHtml).join('\n\n')}\n`,
      });
    }
  }

  return replacements
    .reverse()
    .reduce((result, replacement) => (
      `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`
    ), markdown);
}

function restorePreservedBlankLines(markdown: string): string {
  if (!markdown.includes(preservedBlankLineToken)) return markdown;

  const tokenPattern = new RegExp(
    `\\n*${preservedBlankLineToken}(?:\\n+${preservedBlankLineToken})*\\n*`,
    'g',
  );
  return markdown.replace(tokenPattern, (match, offset: number, source: string) => {
    const count = match.split(preservedBlankLineToken).length - 1;
    const hasContentBefore = source.slice(0, offset).trim().length > 0;
    const hasContentAfter = source.slice(offset + match.length).trim().length > 0;
    const newlineCount = hasContentBefore && hasContentAfter
      ? count + 2
      : hasContentBefore
        ? count + 1
        : count;
    return '\n'.repeat(newlineCount);
  });
}

function isEmptyEditorParagraph(element: HTMLElement): boolean {
  if (element.textContent?.length) return false;
  return Array.from(element.children).every((child) => (
    child.nodeName === 'BR'
    || (child.nodeName === 'SPAN' && !(child.textContent ?? '').length)
  ));
}

function normalizeImageSources(html: string, assetContext?: MarkdownAssetContext): string {
  if (assetContext?.externalAssetUrls) {
    const template = document.createElement('template'); template.innerHTML = html;
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      const src = img.getAttribute('src')!;
      const entry = Object.entries(assetContext.externalAssetUrls!).find(([href]) => href === src || decode(href) === decode(src));
      if (entry) { img.setAttribute('src', entry[1]); img.setAttribute('data-menghan-relative', entry[0]); }
    });
    return template.innerHTML;
  }
  if (!assetContext?.currentPath && !assetContext?.libraryPath) return html;

  return html.replace(/<img\b([^>]*?)\s+src="([^"]+)"([^>]*)>/gi, (match, before: string, src: string, after: string) => {
    if (!isRelativeImageSource(src)) return match;

    const absolutePath = resolveMarkdownImagePath(src, assetContext);
    if (!absolutePath) return match;

    const imageUrl = toEditorImageUrl(absolutePath);
    const relativeAttribute = ` data-menghan-relative="${escapeHtmlAttribute(src)}"`;
    const hasRelativeAttribute = /\sdata-menghan-relative=/i.test(match);
    return `<img${before} src="${imageUrl}"${hasRelativeAttribute ? '' : relativeAttribute}${after}>`;
  });
}

function isRelativeImageSource(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src)
    && !src.startsWith('/')
    && !/^[a-z]:[\\/]/i.test(src);
}

function resolveMarkdownImagePath(src: string, assetContext: MarkdownAssetContext): string | null {
  const normalizedSrc = src.replace(/\\/g, '/');
  const basePath = normalizedSrc.startsWith('attachments/')
    ? assetContext.libraryPath
    : getDirectoryName(assetContext.currentPath ?? '');
  if (!basePath) return null;

  return normalizePath(`${basePath.replace(/\\/g, '/')}/${normalizedSrc}`);
}

function getDirectoryName(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const index = normalizedPath.lastIndexOf('/');
  return index === -1 ? null : normalizedPath.slice(0, index);
}

function normalizePath(filePath: string): string {
  const isWindowsAbsolute = /^[a-z]:\//i.test(filePath);
  const segments: string[] = [];
  for (const part of filePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const normalized = segments.join('/');
  return isWindowsAbsolute ? normalized : `/${normalized}`;
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
