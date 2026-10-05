import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { rewriteMarkdownImageReferences } from './parseImages';
import { PipelineStageError } from './stageErrors';

export interface TextStageProgress {
  completed: number;
  total?: number;
  message: string;
}

export interface TextStageResult {
  counts: Record<string, number>;
}

/**
 * Direct text parsing is deliberately line-streamed. The original file stays
 * the source of truth; the stage only writes normalized local artifacts and
 * keeps rawText on each block for later line/signal provenance.
 */
export async function runDirectTextParse(params: {
  inputPath: string;
  outputDir: string;
  extension: string;
  engine?: 'direct' | 'mineru';
  sourceName?: string;
  signal: AbortSignal;
  onProgress?: (progress: TextStageProgress) => void;
  /** 已采纳进 images/ 的引用映射，逐行改写 markdown 保证产物自包含。 */
  imageRewrites?: ReadonlyMap<string, string>;
  extraCounts?: Record<string, number>;
}): Promise<TextStageResult> {
  if (!fs.existsSync(params.inputPath) || !fs.statSync(params.inputPath).isFile()) {
    throw new PipelineStageError('SOURCE_NOT_FOUND', '原始文本不存在或不可读。', false);
  }

  fs.mkdirSync(params.outputDir, { recursive: true });
  const markdownPath = path.join(params.outputDir, 'document.md');
  const lineLayoutPath = path.join(params.outputDir, 'line-layout.jsonl');
  const blocksPath = path.join(params.outputDir, 'blocks.jsonl');
  const reportPath = path.join(params.outputDir, 'parse-report.json');
  const markdown = fs.createWriteStream(markdownPath, { encoding: 'utf8' });
  const lineLayout = fs.createWriteStream(lineLayoutPath, { encoding: 'utf8' });
  const blocks = fs.createWriteStream(blocksPath, { encoding: 'utf8' });
  const input = fs.createReadStream(params.inputPath, { encoding: 'utf8' });
  let lineNumber = 0;
  let blockCount = 0;
  let nonBlankLines = 0;
  let renderedLines = 0;
  let blankLinesRemoved = 0;
  let blankBefore = false;
  let markdownChars = 0;
  let maxLineChars = 0;

  try {
    for await (const lineValue of readLines(input)) {
      throwIfAborted(params.signal);
      const rawText = stripBom(String(lineValue));
      const text = params.imageRewrites && params.imageRewrites.size > 0
        ? rewriteMarkdownImageReferences(normalizeTextLine(rawText), params.imageRewrites)
        : normalizeTextLine(rawText);
      lineNumber += 1;
      maxLineChars = Math.max(maxLineChars, rawText.length);
      if (!text.trim()) {
        if (renderedLines > 0) {
          blankBefore = true;
          blankLinesRemoved += 1;
        }
        continue;
      }
      renderedLines += 1;
      await writeWithBackpressure(markdown, `${text}\n`);
      await writeWithBackpressure(lineLayout, `${JSON.stringify({ schemaVersion: 1, lineNo: renderedLines, blankBefore })}\n`);
      markdownChars += text.length + 1;
      nonBlankLines += 1;
      blockCount += 1;
      await writeWithBackpressure(blocks, `${JSON.stringify({
        schemaVersion: 1,
        blockId: `b-${String(blockCount).padStart(6, '0')}`,
        order: blockCount,
        kind: inferTextBlockKind(text),
        text,
        rawText,
        source: { engine: params.engine ?? 'direct', line: lineNumber },
        parentBlockId: null,
        attributes: { extension: params.extension },
      })}\n`);
      blankBefore = false;
      if (lineNumber === 1 || lineNumber % 100 === 0) {
        params.onProgress?.({ completed: lineNumber, message: `正在直读第 ${lineNumber} 行。` });
      }
    }
    throwIfAborted(params.signal);
    await Promise.all([finishStream(markdown), finishStream(lineLayout), finishStream(blocks)]);
    const counts = {
      lines: lineNumber,
      blocks: blockCount,
      nonBlankLines,
      renderedLines,
      blankLinesRemoved,
      markdownChars,
      maxLineChars,
      sourceBytes: fs.statSync(params.inputPath).size,
      ...(params.extraCounts ?? {}),
    };
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1,
      stage: 'parse',
      engine: params.engine ?? 'direct',
      sourceName: params.sourceName ?? path.basename(params.inputPath),
      sourceExtension: params.extension,
      counts,
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    params.onProgress?.({ completed: lineNumber, total: lineNumber, message: '文本直读缓存已生成。' });
    return { counts };
  } catch (error) {
    input.destroy();
    markdown.destroy();
    lineLayout.destroy();
    blocks.destroy();
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('DIRECT_READ_FAILED', `文本直读失败：${error instanceof Error ? error.message : String(error)}`, true, error instanceof Error ? error.stack : undefined);
  }
}

export async function runMarkdownArtifactParse(params: {
  inputPath: string;
  outputDir: string;
  engine?: 'direct' | 'mineru';
  sourceName?: string;
  signal: AbortSignal;
  onProgress?: (progress: TextStageProgress) => void;
  extraCounts?: Record<string, number>;
}): Promise<TextStageResult> {
  return runDirectTextParse({ ...params, extension: '.md' });
}

function normalizeTextLine(value: string): string {
  const filtered = Array.from(value).filter((character) => {
    const code = character.charCodeAt(0);
    return code !== 0x00 && code !== 0x0b && code !== 0x0c && code !== 0x85;
  }).join('');
  return filtered.replace(/[ \t]+$/u, '');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function inferTextBlockKind(text: string): string {
  if (/^#{1,6}\s+/.test(text)) return 'heading';
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(text)) return 'list_item';
  if (/^\s*>\s?/.test(text)) return 'quote';
  if (/^\s*\|.*\|\s*$/.test(text)) return 'table';
  if (/!\[[^\]]*\]\(images\//.test(text)) return 'image';
  return 'paragraph';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PipelineStageError('STAGE_CANCELLED', '解析任务已取消。', true);
}

function finishStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
    stream.end();
  });
}

async function writeWithBackpressure(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (stream.write(chunk)) return;
  await once(stream, 'drain');
}

async function* readLines(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      newlineIndex = pending.indexOf('\n');
    }
  }
  if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
}
