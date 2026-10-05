import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import { normalizeSelectionProjection } from '../../shared/selectionExpansionPolicy';
import type { SelectionLocatorCapture } from '../../shared/selectionLocatorTypes';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import type { SelectionSnapshotV2 } from './selectionEditTypes';

interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  data?: { alias?: string };
  position?: { start: { line: number }; end: { line: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm)
  .use(remarkWikiLink as never, { aliasDivider: '|' });

/** Validate the bounded, renderer-owned selection receipt before source lookup. */
export function validateSelectionLocatorCapture(value: unknown): SelectionLocatorCapture | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('选区定位信息格式无效。');
  const v = value as Record<string, unknown>;
  const string = (key: string, max = 200_000): string => {
    if (typeof v[key] !== 'string' || (v[key] as string).length > max) throw new Error('选区定位字段无效。');
    return v[key] as string;
  };
  const integer = (key: string): number => {
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) throw new Error('选区定位坐标无效。');
    return v[key] as number;
  };
  const documentTextHash = string('documentTextHash', 64);
  const selectedTextHash = string('selectedTextHash', 64);
  if (![documentTextHash, selectedTextHash].every((hash) => /^[a-f0-9]{64}$/u.test(hash))) throw new Error('选区定位哈希无效。');
  const canonicalSliceJson = string('canonicalSliceJson');
  try { JSON.parse(canonicalSliceJson); } catch { throw new Error('选区结构数据无效。'); }
  const rect = v.rect as SelectionLocatorCapture['rect'];
  if (!rect || !['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(rect[key as keyof typeof rect]))) throw new Error('选区显示坐标无效。');
  if (!Array.isArray(v.blockKinds) || v.blockKinds.length > 100 || v.blockKinds.some((kind) => typeof kind !== 'string' || kind.length > 80)) throw new Error('选区块类型无效。');
  const capture: SelectionLocatorCapture = {
    editorSessionId: string('editorSessionId', 200), docRevision: integer('docRevision'),
    from: integer('from'), to: integer('to'), textOffset: integer('textOffset'), documentTextHash, selectedTextHash,
    canonicalSliceJson, markdownFragment: string('markdownFragment'),
    selectionStructureSignature: string('selectionStructureSignature'), documentStructureSignature: string('documentStructureSignature'),
    blockKinds: [...v.blockKinds] as string[], rect: { ...rect },
  };
  if (capture.to <= capture.from) throw new Error('选区范围不能为空。');
  return capture;
}

/** Map a validated text projection to source lines, including repeated passages. */
export function locateSelectionInSnapshot(snapshot: CurrentNoteSnapshot, selectedText: string, capture: SelectionLocatorCapture): SelectionSnapshotV2 {
  const parts: Array<{ text: string; from: number; to: number }> = [];
  const nodeText = (node: SourceNode): string => {
    if (node.type === 'image' || node.type === 'yaml' || node.type === 'toml') return '';
    if (node.type === 'wikiLink') return node.data?.alias ?? node.value ?? '';
    return node.value ?? (node.children ?? []).map(nodeText).join('');
  };
  const walk = (node: SourceNode): void => {
    if (['paragraph', 'heading', 'code', 'tableCell'].includes(node.type)) {
      const text = normalizeSelectionProjection(nodeText(node));
      if (text && node.position) parts.push({ text, from: node.position.start.line, to: node.position.end.line });
    } else if (node.type !== 'yaml' && node.type !== 'toml') (node.children ?? []).forEach(walk);
  };
  // Editor renders display formulas as raw text blocks; preserve those values
  // rather than interpreting LaTeX underscores as Markdown emphasis.
  const projectedMarkdown = snapshot.markdown.replace(/(^|\n)\$\$[ \t]*\r?\n([\s\S]*?)\r?\n\$\$(?=\r?\n|$)/gu,
    (_match, prefix: string, source: string) => `${prefix}~~~~~formula\n${source}\n~~~~~`);
  walk(parser.parse(projectedMarkdown) as unknown as SourceNode);
  const projection = parts.map((part) => part.text).join('');
  const selected = normalizeSelectionProjection(selectedText);
  const end = capture.textOffset + selected.length;
  if (hash(projection) !== capture.documentTextHash || hash(selectedText) !== capture.selectedTextHash
    || !selected || projection.slice(capture.textOffset, end) !== selected) {
    throw new Error('无法确认选区在已保存笔记中的位置，请保存后重新选择文字。');
  }
  let offset = 0;
  const covered = parts.filter((part) => {
    const start = offset;
    offset += part.text.length;
    return start < end && offset > capture.textOffset;
  });
  if (!covered.length) throw new Error('无法确认选区原文行范围。');
  const lineFrom = covered[0].from;
  const lineTo = covered[covered.length - 1].to;
  const heading = snapshot.headings.filter((entry) => entry.lineFrom <= lineFrom && entry.lineTo >= lineFrom).at(-1);
  return {
    ...capture, libraryId: snapshot.libraryId, currentPath: snapshot.notePath, noteContentHash: snapshot.contentHash,
    selectedText, sliceJson: JSON.parse(capture.canonicalSliceJson) as unknown, lineFrom, lineTo,
    headingPath: heading ? heading.path.map((text, index) => ({ id: `${heading.headingId}:${index}`, text })) : [],
  };
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
