import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createParseImageSink, PARSE_IMAGES_DIRECTORY_NAME } from './parseImages';

const MAX_DOCX_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 64 * 1024 * 1024;

interface WorkerInput {
  inputPath: string;
  outputDir: string;
  sourceName: string;
}

interface ParseBlock {
  schemaVersion: 1;
  blockId: string;
  order: number;
  kind: string;
  text: string;
  rawText: string;
  source: { engine: 'mammoth'; line: number };
  parentBlockId: null;
  attributes: Record<string, string | number | boolean>;
}

interface CompactMarkdownLine {
  text: string;
  blankBefore: boolean;
}

interface HtmlNodeLike {
  nodeName: string;
  outerHTML: string;
  querySelector(selector: string): HtmlNodeLike | null;
  querySelectorAll(selector: string): ArrayLike<HtmlNodeLike>;
  getAttribute(name: string): string | null;
  innerHTML: string;
}

void run(workerData as WorkerInput).catch((error: unknown) => {
  parentPort?.postMessage({
    ok: false,
    code: error instanceof MammothWorkerError ? error.code : 'MAMMOTH_PARSE_FAILED',
    message: error instanceof MammothWorkerError ? error.message : `Mammoth 解析 DOCX 失败：${error instanceof Error ? error.message : String(error)}`,
    diagnostic: error instanceof Error ? error.stack : undefined,
    retryable: error instanceof MammothWorkerError ? error.retryable : true,
  });
  parentPort?.close();
});

async function run(input: WorkerInput): Promise<void> {
  const source = path.resolve(input.inputPath);
  const output = path.resolve(input.outputDir);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new MammothWorkerError('SOURCE_NOT_FOUND', '原始 DOCX 不存在或不可读。', false);
  if (path.extname(source).toLowerCase() !== '.docx') throw new MammothWorkerError('UNSUPPORTED_FORMAT', 'Mammoth 仅支持 DOCX 文档。', false);
  if (stat.size > MAX_DOCX_BYTES) throw new MammothWorkerError('DOCX_TOO_LARGE', 'DOCX 超过 128 MiB 的本地解析上限。', false);

  let imageCount = 0;
  const sink = createParseImageSink(output);
  const result = await mammoth.convertToHtml({ path: source }, {
    includeDefaultStyleMap: true,
    includeEmbeddedStyleMap: true,
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async (image) => {
      imageCount += 1;
      let buffer: Buffer;
      try {
        const raw = await image.read();
        buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'base64');
      } catch {
        return { src: `mammoth-image://${imageCount}` };
      }
      const saved = sink.saveBuffer(buffer, image.contentType, {
        kind: 'docx-embedded',
        ref: `word/media/image${imageCount}`,
      });
      return { src: saved ?? `mammoth-image://${imageCount}` };
    }),
  });
  if (result.value.length > MAX_OUTPUT_CHARACTERS) throw new MammothWorkerError('DOCX_OUTPUT_TOO_LARGE', 'DOCX 转换后的内容超过 64 MiB 上限。', false);

  const turndown = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    headingStyle: 'atx',
    strongDelimiter: '**',
  });
  turndown.use(gfm);
  turndown.addRule('mammoth-simple-table', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => serializeMarkdownTable(node as unknown as HtmlNodeLike, turndown),
  });
  turndown.addRule('mammoth-image', {
    filter: 'img',
    replacement: (_content, node) => {
      const imageNode = node as unknown as HtmlNodeLike;
      const src = imageNode.getAttribute('src') ?? '';
      if (src.startsWith(`${PARSE_IMAGES_DIRECTORY_NAME}/`)) {
        const alt = imageNode.getAttribute('alt') ?? '';
        return `![${alt}](${src})`;
      }
      return '[内嵌图片]';
    },
  });
  const compacted = compactMarkdown(turndown.turndown(result.value));
  const markdown = compacted.markdown;
  if (markdown.length > MAX_OUTPUT_CHARACTERS) throw new MammothWorkerError('DOCX_OUTPUT_TOO_LARGE', 'DOCX 转换后的 Markdown 超过 64 MiB 上限。', false);

  const { blocks, lineLayout } = buildLineArtifacts(compacted.lines);
  const warnings = result.messages.map((message) => message.message).filter(Boolean);
  const counts = {
    sourceBytes: stat.size,
    markdownChars: markdown.length,
    lines: lineLayout.length,
    blocks: blocks.length,
    blankLinesRemoved: compacted.blankLinesRemoved,
    headings: blocks.filter((block) => block.kind === 'heading').length,
    listItems: blocks.filter((block) => block.kind === 'list_item').length,
    tableRows: blocks.filter((block) => block.kind === 'table').length,
    images: sink.savedCount(),
    imagesSkipped: sink.skippedCount(),
    warnings: warnings.length,
  };

  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'document.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(output, 'line-layout.jsonl'), toJsonl(lineLayout), 'utf8');
  fs.writeFileSync(path.join(output, 'blocks.jsonl'), toJsonl(blocks), 'utf8');
  fs.writeFileSync(path.join(output, 'parse-report.json'), JSON.stringify({
    schemaVersion: 1,
    stage: 'parse',
    engine: 'mammoth',
    engineVersion: '1.12.1',
    sourceName: input.sourceName,
    sourceExtension: '.docx',
    counts,
    warnings,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  sink.writeManifest(output);
  parentPort?.postMessage({ ok: true, counts });
  parentPort?.close();
}

function serializeMarkdownTable(table: HtmlNodeLike, turndown: TurndownService): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  const rowCells = rows.map((row) => Array.from(row.querySelectorAll('th,td')));
  const cells = rowCells.flat();
  const isSimple = rows.length > 0
    && cells.length > 0
    && cells.every((cell) => !cell.querySelector('table') && !cell.getAttribute('rowspan') && !cell.getAttribute('colspan'));
  if (!isSimple) return `\n\n${table.outerHTML}\n\n`;

  const columnCount = Math.max(...rowCells.map((row) => row.length));
  const markdownRows = rowCells.map((cellsInRow) => {
    const values = cellsInRow.map((cell) => turndown
      .turndown(cell.innerHTML)
      .trim()
      .replace(/\r\n?/gu, '\n')
      .replace(/\s*\n+\s*/gu, '<br>')
      .replace(/(^|[^\\])\|/gu, '$1\\|'));
    while (values.length < columnCount) values.push('');
    return `| ${values.join(' | ')} |`;
  });
  const delimiter = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
  return `\n\n${[markdownRows[0], delimiter, ...markdownRows.slice(1)].join('\n')}\n\n`;
}

function compactMarkdown(value: string): { markdown: string; lines: CompactMarkdownLine[]; blankLinesRemoved: number } {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const compact: CompactMarkdownLine[] = [];
  let blankPending = false;
  let blankLinesRemoved = 0;
  for (const lineValue of lines) {
    const line = lineValue.replace(/[ \t]+$/gu, '');
    if (!line.trim()) {
      if (compact.length > 0) blankPending = true;
      blankLinesRemoved += 1;
      continue;
    }
    compact.push({ text: line, blankBefore: blankPending });
    blankPending = false;
  }
  return {
    markdown: compact.length > 0 ? `${compact.map((line) => line.text).join('\n')}\n` : '',
    lines: compact,
    blankLinesRemoved,
  };
}

function buildLineArtifacts(lines: CompactMarkdownLine[]): { blocks: ParseBlock[]; lineLayout: Array<Record<string, number | boolean>> } {
  const blocks: ParseBlock[] = [];
  const lineLayout: Array<Record<string, number | boolean>> = [];
  for (const [index, line] of lines.entries()) {
    const rawText = line.text;
    const order = blocks.length + 1;
    const kind = inferBlockKind(rawText);
    blocks.push({
      schemaVersion: 1,
      blockId: `b-${String(order).padStart(6, '0')}`,
      order,
      kind,
      text: rawText,
      rawText,
      source: { engine: 'mammoth', line: index + 1 },
      parentBlockId: null,
      attributes: kind === 'heading' ? { level: Math.min(rawText.match(/^#+/u)?.[0].length ?? 1, 6) } : {},
    });
    lineLayout.push({ schemaVersion: 1, lineNo: order, blankBefore: line.blankBefore });
  }
  return { blocks, lineLayout };
}

function inferBlockKind(text: string): string {
  if (/^#{1,6}\s+/u.test(text)) return 'heading';
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/u.test(text)) return 'list_item';
  if (/^\s*>\s?/u.test(text)) return 'quote';
  if (/^\s*\|.*\|\s*$/u.test(text)) return 'table';
  if (/^\s*```/u.test(text)) return 'code';
  if (/!\[[^\]]*\]\(images\//u.test(text)) return 'image';
  if (text.includes('[内嵌图片]')) return 'image';
  return 'paragraph';
}

function toJsonl(values: unknown[]): string {
  return values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
}

class MammothWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'MammothWorkerError';
  }
}
