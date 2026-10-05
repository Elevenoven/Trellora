import type { Editor } from '@tiptap/core';
import { getNoteViewportRect } from './editorCoordinates';
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Fragment, Slice, type Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentToEditorHtml, htmlToMarkdown } from '../utils/markdown';
import { normalizeSelectionProjection } from '../../shared/selectionExpansionPolicy';
import type { SelectionLocatorCapture } from '../../shared/selectionLocatorTypes';
import { hasExpansionRawHtml } from '../../shared/selectionExpansionMarkdown';

export interface FloatingRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface BlockRange {
    from: number;
    to: number;
    type: string;
}

export interface BlockSnapshot extends BlockRange {
    text: string;
    rect: FloatingRect;
}

/**
 * A generated plain-text suggestion may only replace a simple text selection.
 * Cross-block expansion may use the constrained Markdown-to-Slice writer;
 * all other rich selections stay review/copy-only.
 */
export type SelectionWritebackMode = 'inline-text' | 'block-markdown' | 'copy-only';

export type SelectionWritebackBlockCode =
    | 'cross-block-selection'
    | 'inline-structure'
    | 'mixed-marks'
    | 'slice-roundtrip-failed'
    | 'snapshot-structure-changed';

export interface SelectionWritebackCapability {
    mode: SelectionWritebackMode;
    code?: SelectionWritebackBlockCode;
    message: string;
}

export interface SelectionMarkSnapshot {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface SelectionHeadingLocator {
    id: string;
    level: number;
    text: string;
    from: number;
}

/**
 * Renderer-side structural receipt captured with the legacy selection
 * snapshot. It is deliberately serializable so SE-3 can promote it into the
 * main-process SelectionSnapshotV2 after the saved-note locator is available.
 */
export interface SelectionStructureSnapshot {
    version: 1;
    selectionKind: 'single-textblock' | 'cross-block';
    sliceJson: unknown;
    canonicalSliceJson: string;
    markdownFragment: string;
    blockKinds: string[];
    headingPath: SelectionHeadingLocator[];
    selectedStructureSignature: string;
    documentStructureSignature: string;
    preservedMarks: SelectionMarkSnapshot[];
    writeback: SelectionWritebackCapability;
    plainTextWriteback?: SelectionWritebackCapability;
}

export interface SelectionSnapshot {
    editorSessionId: string;
    currentPath: string;
    from: number;
    to: number;
    selectedText: string;
    docRevision: number;
    block: BlockSnapshot;
    rect: FloatingRect;
    structure: SelectionStructureSnapshot;
    /** Local-only projection; never send full editor text through IPC. */
    locatorSeed?: { documentText: string; textOffset: number };
}

export type BlockTransform =
    | 'paragraph'
    | 'heading-1'
    | 'heading-2'
    | 'heading-3'
    | 'heading-4'
    | 'heading-5'
    | 'heading-6'
    | 'blockquote'
    | 'bullet-list'
    | 'ordered-list'
    | 'task-list'
    | 'code-block';

export interface PopupPosition {
    left: number;
    top: number;
}

export interface PointerAnchor {
    x: number;
    y: number;
}

const horizontalInset = 8;
const verticalInset = 8;
const supportedBlockMarkdownNodes = new Set([
    'paragraph',
    'heading',
    'blockquote',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'codeBlock',
]);
const supportedBlockMarkdownMarks = new Set(['bold', 'italic', 'strike', 'code', 'link']);

export function findBlockRange(editor: Editor, position: number): BlockRange | null {
    const { doc } = editor.state;
    const safePosition = Math.max(1, Math.min(position, Math.max(1, doc.content.size)));
    const $pos = doc.resolve(safePosition);
    let fallback: BlockRange | null = null;

    for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        const from = $pos.before(depth);
        const to = $pos.after(depth);
        const candidate = { from, to, type: node.type.name };
        if (node.type.name === 'listItem') return candidate;
        if (!fallback && (node.isTextblock || node.isBlock)) fallback = candidate;
    }

    return fallback;
}

export function getFloatingRect(editor: Editor, from: number, to: number): FloatingRect {
    const maxPosition = Math.max(1, editor.state.doc.content.size);
    const start = getNoteViewportRect(editor.view.coordsAtPos(Math.max(1, Math.min(from, maxPosition))), editor.view.dom);
    const end = getNoteViewportRect(editor.view.coordsAtPos(Math.max(1, Math.min(to, maxPosition))), editor.view.dom);
    return {
        top: Math.min(start.top, end.top),
        right: Math.max(start.right, end.right),
        bottom: Math.max(start.bottom, end.bottom),
        left: Math.min(start.left, end.left),
    };
}

export function createBlockSnapshot(editor: Editor, position: number): BlockSnapshot | null {
    const range = findBlockRange(editor, position);
    if (!range) return null;
    return {
        ...range,
        text: editor.state.doc.textBetween(range.from, range.to, '\n').trim(),
        rect: getFloatingRect(editor, Math.min(range.from + 1, range.to), range.to),
    };
}

export function createSelectionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): SelectionSnapshot | null {
    const { editor, editorSessionId, currentPath, docRevision } = input;
    const { from, to, empty, $from, $to } = editor.state.selection;
    if (empty || !$from.parent.isTextblock || $from.parent !== $to.parent) return null;
    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return null;
    const block = createBlockSnapshot(editor, from);
    if (!block) return null;
    return createStructuredSelectionSnapshot({ editor, editorSessionId, currentPath, docRevision, from, to, selectedText, block });
}

/**
 * 允许跨段落选择；扩写结果会通过受限 Markdown-to-Slice 写回器替换
 * 正文、标题、引用、列表、链接和代码块。表格、图片和公式等复杂结构仍
 * 保持仅复制，避免跨块写回造成数据丢失。
 */
export function createSelectionExpansionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): SelectionSnapshot | null {
    const { editor, editorSessionId, currentPath, docRevision } = input;
    const { from, to, empty } = editor.state.selection;
    if (empty) return null;
    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return null;
    const block = createBlockSnapshot(editor, from);
    if (!block) return null;
    return createStructuredSelectionSnapshot({
        editor,
        editorSessionId,
        currentPath,
        docRevision,
        from,
        to,
        selectedText,
        block,
        allowBlockMarkdownWriteback: true,
    });
}

export function isSelectionSnapshotCurrent(input: {
    editor: Editor;
    snapshot: SelectionSnapshot;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): boolean {
    const { editor, snapshot, editorSessionId, currentPath, docRevision } = input;
    if (snapshot.editorSessionId !== editorSessionId || snapshot.currentPath !== currentPath || snapshot.docRevision !== docRevision) return false;
    if (snapshot.from < 1 || snapshot.to > editor.state.doc.content.size || snapshot.from >= snapshot.to) return false;
    if (editor.state.doc.textBetween(snapshot.from, snapshot.to, '\n') !== snapshot.selectedText) return false;
    return isSelectionStructureCurrent(editor, snapshot);
}

export function getSameBlockContext(editor: Editor, snapshot: SelectionSnapshot, maxCharacters = 400): { before: string; after: string } {
    const before = editor.state.doc.textBetween(snapshot.block.from, snapshot.from, '\n').slice(-Math.floor(maxCharacters / 2));
    const after = editor.state.doc.textBetween(snapshot.to, snapshot.block.to, '\n').slice(0, maxCharacters - before.length);
    return { before, after };
}

/** Exposes the captured decision to preview surfaces without duplicating schema checks. */
export function getSelectionWritebackCapability(snapshot: SelectionSnapshot, formatted = true): SelectionWritebackCapability {
    return formatted ? snapshot.structure.writeback : snapshot.structure.plainTextWriteback ?? snapshot.structure.writeback;
}

/**
 * Build a serializable Slice receipt and determine whether a plain-text result
 * can be written without changing the document's block/mark structure.
 */
export function createSelectionStructureSnapshot(
    editor: Editor,
    from: number,
    to: number,
    allowBlockMarkdownWriteback = false,
): SelectionStructureSnapshot {
    const slice = editor.state.doc.slice(from, to);
    const sliceJson = slice.toJSON();
    const canonicalSliceJson = stableJson(sliceJson);
    const { $from, $to } = editor.state.selection;
    const sameTextblock = $from.parent.isTextblock && $from.parent === $to.parent;
    const inlinePlan = resolveInlineWritebackPlan(slice, sameTextblock, allowBlockMarkdownWriteback);
    const roundTripValid = isSliceRoundTripValid(editor, sliceJson, canonicalSliceJson);
    const writeback = !roundTripValid
        ? copyOnly('slice-roundtrip-failed', '原始选区结构无法校验，请复制建议后手动处理。')
        : inlinePlan.writeback;

    return {
        version: 1,
        selectionKind: sameTextblock ? 'single-textblock' : 'cross-block',
        sliceJson,
        canonicalSliceJson,
        markdownFragment: sliceToMarkdown(editor, slice),
        blockKinds: collectBlockKinds(slice),
        headingPath: collectHeadingPath(editor.state.doc, from),
        selectedStructureSignature: createSliceStructureSignature(slice),
        documentStructureSignature: createDocumentStructureSignature(editor.state.doc),
        preservedMarks: inlinePlan.preservedMarks,
        writeback,
        plainTextWriteback: resolveInlineWritebackPlan(slice, sameTextblock, false).writeback,
    };
}

/**
 * Performs a canonical Slice round-trip and compares the current selection
 * structure, not merely its text. This catches same-text mark and inline-node
 * changes that `doc.textBetween()` cannot see.
 */
export function isSelectionStructureCurrent(editor: Editor, snapshot: SelectionSnapshot): boolean {
    try {
        const restored = Slice.fromJSON(editor.schema, snapshot.structure.sliceJson as never);
        if (stableJson(restored.toJSON()) !== snapshot.structure.canonicalSliceJson) return false;
        const currentSlice = editor.state.doc.slice(snapshot.from, snapshot.to);
        if (stableJson(currentSlice.toJSON()) !== snapshot.structure.canonicalSliceJson) return false;
        return createDocumentStructureSignature(editor.state.doc) === snapshot.structure.documentStructureSignature;
    } catch {
        return false;
    }
}

/** Structural signature excludes text content but retains blocks, attrs, marks, and inline atoms. */
export function createDocumentStructureSignature(doc: ProseMirrorNode): string {
    return createNodeStructureSignature(doc);
}

function createStructuredSelectionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
    from: number;
    to: number;
    selectedText: string;
    block: BlockSnapshot;
    allowBlockMarkdownWriteback?: boolean;
}): SelectionSnapshot {
    const { editor, editorSessionId, currentPath, docRevision, from, to, selectedText, block, allowBlockMarkdownWriteback } = input;
    return {
        editorSessionId,
        currentPath,
        from,
        to,
        selectedText,
        docRevision,
        block,
        rect: getFloatingRect(editor, from, to),
        structure: createSelectionStructureSnapshot(editor, from, to, allowBlockMarkdownWriteback),
        locatorSeed: {
            documentText: normalizeSelectionProjection(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')),
            textOffset: normalizeSelectionProjection(editor.state.doc.textBetween(0, from, '\n')).length,
        },
    };
}

/** Freeze the actual selected occurrence without exporting the full editor text. */
export async function createSelectionLocatorCapture(snapshot: SelectionSnapshot): Promise<SelectionLocatorCapture> {
    if (!snapshot.locatorSeed) throw new Error('选区定位信息已失效，请重新选择文字。');
    const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
        editorSessionId: snapshot.editorSessionId, docRevision: snapshot.docRevision, from: snapshot.from, to: snapshot.to,
        textOffset: snapshot.locatorSeed.textOffset, documentTextHash: await hash(snapshot.locatorSeed.documentText),
        selectedTextHash: await hash(snapshot.selectedText), canonicalSliceJson: snapshot.structure.canonicalSliceJson,
        markdownFragment: snapshot.structure.markdownFragment, selectionStructureSignature: snapshot.structure.selectedStructureSignature,
        documentStructureSignature: snapshot.structure.documentStructureSignature,
        blockKinds: [...snapshot.structure.blockKinds], rect: { ...snapshot.rect },
    };
}

function sliceToMarkdown(editor: Editor, slice: Slice): string {
    if (typeof document === 'undefined') return '';
    const container = document.createElement('div');
    const serializer = DOMSerializer.fromSchema(editor.schema);
    container.appendChild(serializer.serializeFragment(slice.content));
    return htmlToMarkdown(container.innerHTML).trim();
}

export function replaceSelectionWithText(editor: Editor, snapshot: SelectionSnapshot, text: string): void {
    const capability = getSelectionWritebackCapability(snapshot);
    if (!isSelectionStructureCurrent(editor, snapshot)) {
        throw new Error('原文结构已变化，请重新选择文字后再生成。');
    }

    if (capability.mode === 'block-markdown') {
        replaceSelectionWithBlockMarkdown(editor, snapshot, text);
        return;
    }
    if (capability.mode !== 'inline-text') throw new Error(capability.message);

    const inlineText = normalizeInlineText(text);
    if (!inlineText) throw new Error('建议内容为空，无法替换。');

    const marks = restorePreservedMarks(editor, snapshot.structure.preservedMarks);
    const replacement = new Slice(Fragment.from(editor.schema.text(inlineText, marks)), 0, 0);
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    if (createDocumentStructureSignature(transaction.doc) !== snapshot.structure.documentStructureSignature) {
        throw new Error('替换会改变标题、列表、引用、代码或标记结构，已改为仅可复制。');
    }
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

/** Parse expansion Markdown without flattening its marks or block structure. */
export function replaceSelectionWithMarkdown(editor: Editor, snapshot: SelectionSnapshot, markdown: string): void {
    if (!isSelectionStructureCurrent(editor, snapshot)) throw new Error('原文结构已变化，请重新选择文字后再生成。');
    const capability = getSelectionWritebackCapability(snapshot);
    if (capability.mode === 'copy-only') throw new Error(capability.message);
    let replacement = parseBlockMarkdownSlice(editor, markdown);
    const $from = editor.state.doc.resolve(snapshot.from);
    const $to = editor.state.doc.resolve(snapshot.to);
    if ($from.sameParent($to) && $from.parent.isTextblock && replacement.content.childCount === 1) {
        const block = replacement.content.firstChild!;
        if (block.isTextblock) {
            if ($from.parent.type.name === 'codeBlock') {
                const code = block.type.name === 'codeBlock' ? block.textContent.replace(/\n$/u, '') : block.textContent;
                if (!code) throw new Error('代码内容为空，无法替换。');
                replacement = new Slice(Fragment.from(editor.schema.text(code)), 0, 0);
            } else {
                const inherited = restorePreservedMarks(editor, snapshot.structure.preservedMarks);
                const nodes: ProseMirrorNode[] = [];
                block.content.forEach((node) => {
                    let marks = node.marks;
                    for (const mark of inherited) if (!marks.some((item) => item.type === mark.type)) marks = mark.addToSet(marks);
                    nodes.push(node.mark(marks));
                });
                replacement = new Slice(Fragment.fromArray(nodes), 0, 0);
            }
        }
    } else if ($from.sameParent($to) && $from.depth > 1) {
        throw new Error('列表项、引用或表格单元格内请使用行内格式，或重新选中完整块后替换。');
    }
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    transaction.doc.check();
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

/** Insert Markdown after the last selected top-level block, including a whole list. */
export function insertMarkdownBelowSelection(editor: Editor, snapshot: SelectionSnapshot, markdown: string): void {
    if (!isSelectionStructureCurrent(editor, snapshot)) throw new Error('原文结构已变化，请重新选择文字后再生成。');
    const replacement = parseBlockMarkdownSlice(editor, markdown);
    const $end = editor.state.doc.resolve(snapshot.to);
    const position = $end.depth ? $end.after(1) : snapshot.to;
    const transaction = editor.state.tr.insert(position, replacement.content).scrollIntoView();
    transaction.doc.check();
    editor.view.dispatch(transaction);
}

function replaceSelectionWithBlockMarkdown(editor: Editor, snapshot: SelectionSnapshot, text: string): void {
    const replacement = parseBlockMarkdownSlice(editor, text);
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    try {
        transaction.doc.check();
    } catch {
        throw new Error('扩写结果无法保持文档结构，请复制建议后手动处理。');
    }
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

function parseBlockMarkdownSlice(editor: Editor, value: string): Slice {
    const markdown = value.replace(/\r\n?/g, '\n').trim();
    if (!markdown) throw new Error('建议内容为空，无法替换。');
    if (hasExpansionRawHtml(markdown)) {
        throw new Error('扩写结果包含不支持的 HTML，请复制建议后手动处理。');
    }
    if (typeof document === 'undefined') throw new Error('当前环境不支持结构化扩写写回。');

    const container = document.createElement('div');
    container.innerHTML = contentToEditorHtml(markdown);
    const parser = ProseMirrorDOMParser.fromSchema(editor.schema);
    const replacement = parser.parseSlice(container);
    if (!isSupportedBlockMarkdownSlice(replacement)) {
        throw new Error('扩写结果包含表格、图片、公式或其他不支持的结构，请复制建议后手动处理。');
    }

    const canonicalMarkdown = sliceToMarkdown(editor, replacement);
    const canonicalContainer = document.createElement('div');
    canonicalContainer.innerHTML = contentToEditorHtml(canonicalMarkdown);
    const canonical = parser.parseSlice(canonicalContainer);
    if (stableJson(canonical.toJSON()) !== stableJson(replacement.toJSON())) {
        throw new Error('扩写结果结构无法稳定解析，请复制建议后手动处理。');
    }
    return replacement;
}

export function insertTextBelowBlock(editor: Editor, block: BlockRange, text: string): void {
    const paragraphs = normalizeParagraphs(text);
    if (paragraphs.length === 0) throw new Error('建议内容为空，无法插入。');
    const paragraphType = editor.schema.nodes.paragraph;
    if (!paragraphType) throw new Error('当前编辑器不支持插入正文块。');
    const nodes = paragraphs.map((paragraph) => paragraphType.create(null, paragraph ? editor.schema.text(paragraph) : undefined));
    editor.view.dispatch(editor.state.tr.insert(block.to, Fragment.fromArray(nodes)).scrollIntoView());
}

export function positionPopup(anchor: FloatingRect, width: number, height: number, preferAbove = true): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const desiredLeft = anchor.left + (anchor.right - anchor.left) / 2 - width / 2;
    const left = Math.max(horizontalInset, Math.min(desiredLeft, viewportWidth - width - horizontalInset));
    const above = anchor.top - height - 8;
    const below = anchor.bottom + 8;
    const top = preferAbove && above >= verticalInset
        ? above
        : Math.max(verticalInset, Math.min(below, viewportHeight - height - verticalInset));
    return { left, top };
}

export function positionPopupAtPointer(anchor: PointerAnchor, width: number, height: number): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const rightSide = anchor.x + 12;
    const preferredLeft = rightSide + width <= viewportWidth - horizontalInset
        ? rightSide
        : anchor.x - width - 12;
    return {
        left: Math.max(horizontalInset, Math.min(preferredLeft, viewportWidth - width - horizontalInset)),
        top: Math.max(verticalInset, Math.min(anchor.y - 16, viewportHeight - height - verticalInset)),
    };
}

export function positionPopupBeside(anchor: FloatingRect, width: number, height: number): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const rightSide = anchor.right + 6;
    const preferredLeft = rightSide + width <= viewportWidth - horizontalInset
        ? rightSide
        : anchor.left - width - 6;
    return {
        left: Math.max(horizontalInset, Math.min(preferredLeft, viewportWidth - width - horizontalInset)),
        top: Math.max(verticalInset, Math.min(anchor.top - 7, viewportHeight - height - verticalInset)),
    };
}

function normalizeInlineText(value: string): string {
    return value.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function normalizeParagraphs(value: string): string[] {
    return value
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean);
}

function resolveInlineWritebackPlan(slice: Slice, sameTextblock: boolean, allowBlockMarkdownWriteback: boolean): {
    preservedMarks: SelectionMarkSnapshot[];
    writeback: SelectionWritebackCapability;
} {
    if (!sameTextblock) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) {
            return {
                preservedMarks: [],
                writeback: { mode: 'block-markdown', message: '可将扩写结果按 Markdown 块结构写回选区。' },
            };
        }
        return {
            preservedMarks: [],
            writeback: copyOnly('cross-block-selection', allowBlockMarkdownWriteback
                ? '跨块选区包含表格、图片、公式或其他复杂结构，请复制建议后手动处理。'
                : '跨块选区暂不支持纯文本替换，请复制建议后手动处理。'),
        };
    }

    const textNodes: ProseMirrorNode[] = [];
    let containsInlineStructure = false;
    visitFragment(slice.content, (node) => {
        if (node.isText) {
            textNodes.push(node);
            return;
        }
        containsInlineStructure = true;
    });

    if (containsInlineStructure || textNodes.length === 0) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) return {
            preservedMarks: [],
            writeback: { mode: 'block-markdown', message: '可按 Markdown 保留选区的文字格式和换行。' },
        };
        return {
            preservedMarks: [],
            writeback: copyOnly('inline-structure', '选区包含换行、图片或其他内联结构，请复制建议后手动处理。'),
        };
    }

    const firstMarks = textNodes[0]?.marks ?? [];
    const markSignature = createMarksSignature(firstMarks);
    if (textNodes.some((node) => createMarksSignature(node.marks) !== markSignature)) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) return {
            preservedMarks: [],
            writeback: { mode: 'block-markdown', message: '可按 Markdown 保留选区的文字格式。' },
        };
        return {
            preservedMarks: [],
            writeback: copyOnly('mixed-marks', '选区混合了不同链接或文字标记，请复制建议后手动处理。'),
        };
    }

    return {
        preservedMarks: firstMarks.map(toMarkSnapshot),
        writeback: { mode: 'inline-text', message: '可安全替换选区。' },
    };
}

function isSupportedBlockMarkdownSlice(slice: Slice): boolean {
    if (slice.content.size === 0) return false;
    let supported = true;
    visitFragment(slice.content, (node) => {
        if (node.isBlock && !supportedBlockMarkdownNodes.has(node.type.name)) {
            supported = false;
            return;
        }
        if (!node.isBlock && !node.isText && node.type.name !== 'hardBreak') {
            supported = false;
            return;
        }
        if (node.isText && node.marks.some((mark) => !supportedBlockMarkdownMarks.has(mark.type.name))) {
            supported = false;
        }
        if (node.marks.some((mark) => mark.type.name === 'link'
            && /^[a-z][a-z\d+.-]*:/iu.test(String(mark.attrs.href))
            && !/^(https?|mailto|tel):/iu.test(String(mark.attrs.href)))) supported = false;
    });
    return supported;
}

function copyOnly(code: SelectionWritebackBlockCode, message: string): SelectionWritebackCapability {
    return { mode: 'copy-only', code, message };
}

function isSliceRoundTripValid(editor: Editor, sliceJson: unknown, canonicalSliceJson: string): boolean {
    try {
        const restored = Slice.fromJSON(editor.schema, sliceJson as never);
        return stableJson(restored.toJSON()) === canonicalSliceJson;
    } catch {
        return false;
    }
}

function restorePreservedMarks(editor: Editor, markSnapshots: SelectionMarkSnapshot[]): Mark[] {
    return markSnapshots.map((mark) => {
        const markType = editor.schema.marks[mark.type];
        if (!markType) throw new Error(`当前编辑器不支持恢复 ${mark.type} 标记。`);
        return markType.create(mark.attrs ?? null);
    });
}

function toMarkSnapshot(mark: Mark): SelectionMarkSnapshot {
    const serialized = mark.toJSON();
    return serialized.attrs ? { type: serialized.type, attrs: { ...serialized.attrs } } : { type: serialized.type };
}

function collectBlockKinds(slice: Slice): string[] {
    const kinds = new Set<string>();
    visitFragment(slice.content, (node) => {
        if (node.isBlock) kinds.add(node.type.name);
    });
    return [...kinds];
}

function collectHeadingPath(doc: ProseMirrorNode, selectionFrom: number): SelectionHeadingLocator[] {
    const headings = new Map<number, SelectionHeadingLocator>();
    doc.forEach((node, from) => {
        if (from > selectionFrom || node.type.name !== 'heading') return;
        const level = Number(node.attrs.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) return;
        for (const existingLevel of headings.keys()) {
            if (existingLevel >= level) headings.delete(existingLevel);
        }
        headings.set(level, {
            id: `pm-heading-${from}`,
            level,
            text: node.textContent,
            from,
        });
    });
    return [...headings.values()].sort((left, right) => left.level - right.level);
}

function createSliceStructureSignature(slice: Slice): string {
    const children: string[] = [];
    slice.content.forEach((node) => appendStructureSignature(children, node));
    return `slice(${slice.openStart},${slice.openEnd})[${children.join(',')}]`;
}

function createNodeStructureSignature(node: ProseMirrorNode): string {
    if (node.isText) return `text<${createMarksSignature(node.marks)}>`;
    const children: string[] = [];
    node.forEach((child) => appendStructureSignature(children, child));
    return `${node.type.name}${stableJson(node.attrs)}[${children.join(',')}]`;
}

function appendStructureSignature(target: string[], node: ProseMirrorNode): void {
    const signature = createNodeStructureSignature(node);
    if (node.isText && target[target.length - 1] === signature) return;
    target.push(signature);
}

function createMarksSignature(marks: readonly Mark[]): string {
    return marks.map((mark) => stableJson(mark.toJSON())).join('|');
}

function visitFragment(fragment: Fragment, visitor: (node: ProseMirrorNode) => void): void {
    fragment.forEach((node) => {
        visitor(node);
        if (!node.isText) visitFragment(node.content, visitor);
    });
}

function stableJson(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
