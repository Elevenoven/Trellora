import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { assertInsideDirectory } from './pathGuards';
import { atomicWriteJson, safeSegment } from './pipeline/pathLayout';
import { getLibraryMetaDirectory } from './treeOrder';

const MAX_OUTLINE_NODES = 3_000;
const MAX_NODE_MARKDOWN_CHARS = 80_000;
const MAX_SOURCE_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_ORDER_FILE_BYTES = 2 * 1024 * 1024;

export interface WikiDocumentOutlineNode {
  id: string;
  parentId: string | null;
  title: string;
  order: number;
  depth: number;
  markdown: string;
  sourceHeadingId: string;
  sourceLineNo: number;
  /** 节点来源：'source' 为结构树原生章节（缺省）；'derived' 为 AI 拆分落库的派生节点（方案 §6）。 */
  kind?: 'source' | 'derived';
}

export interface WikiDocumentOutline {
  documentId: string;
  title: string;
  description: string;
  updatedAt: string;
  contentHash: string;
  orderRevisions: Record<string, string>;
  nodes: WikiDocumentOutlineNode[];
}

export type WikiSiblingOrderErrorCode =
  | 'WIKI_ORDER_CONFLICT'
  | 'WIKI_ORDER_INVALID'
  | 'WIKI_ORDER_SAVE_FAILED'
  | 'WIKI_ORDER_SOURCE_STALE';

export interface WikiSiblingOrderRequest {
  documentId: string;
  parentId: string;
  orderedNodeIds: string[];
  expectedRevision: string;
}

export type WikiSiblingOrderResult =
  | {
    ok: true;
    documentId: string;
    parentId: string;
    orderedNodeIds: string[];
    revision: string;
    updatedAt: string;
  }
  | {
    ok: false;
    error: {
      code: WikiSiblingOrderErrorCode;
      message: string;
      diagnostic?: string;
    };
  };

interface WikiOutlineInput {
  documentId: string;
  documentName: string;
  contentHash: string;
  structurePath: string;
  markdownPath?: string;
  lineLayoutPath?: string;
  updatedAt: string;
}

interface StructureRecord {
  nodeId?: unknown;
  parentId?: unknown;
  type?: unknown;
  text?: unknown;
  firstLineNo?: unknown;
  indent?: unknown;
}

interface OutlineDraft extends Omit<WikiDocumentOutlineNode, 'markdown'> {
  content: string[];
  contentChars: number;
  truncated: boolean;
}

interface WikiSectionBounds {
  startLine: number;
  endLine: number;
}

interface WikiSiblingOrderOverride {
  orderedNodeIds: string[];
  revision: string;
  updatedAt: string;
}

interface WikiSiblingOrderFile {
  schemaVersion: 1;
  documentId: string;
  contentHash: string;
  branches: Record<string, WikiSiblingOrderOverride>;
}

const orderWriteQueues = new Map<string, Promise<unknown>>();

/**
 * Read the committed structure-tree artifact and project only document-title
 * and heading nodes into the Wiki graph. Body records are attached to the
 * nearest preceding heading for the read-only detail pane; source files are
 * never read or modified here.
 */
export async function readWikiDocumentOutline(input: WikiOutlineInput): Promise<WikiDocumentOutline> {
  const fallbackTitle = path.basename(input.documentName, path.extname(input.documentName)) || input.documentName;
  const rootId = wikiNodeId(input.documentId, 'n-root');
  const root: OutlineDraft = {
    id: rootId,
    parentId: null,
    title: fallbackTitle,
    order: 0,
    depth: 0,
    sourceHeadingId: 'n-root',
    sourceLineNo: 0,
    content: [],
    contentChars: 0,
    truncated: false,
  };
  const drafts: OutlineDraft[] = [root];
  const draftsById = new Map<string, OutlineDraft>([[root.id, root]]);
  const visibleIdByStructureId = new Map<string, string>([['n-root', root.id]]);
  const sectionDrafts: OutlineDraft[] = [];
  const siblingCounts = new Map<string, number>();
  let activeDraft = root;
  let sourceLine = 0;

  const stream = fs.createReadStream(input.structurePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      sourceLine += 1;
      if (!line.trim()) continue;
      let record: StructureRecord;
      try {
        record = JSON.parse(line) as StructureRecord;
      } catch {
        throw new Error(`结构树第 ${sourceLine} 行不是有效 JSON，请重新处理该文档。`);
      }
      const type = typeof record.type === 'string' ? record.type : '';
      const structureId = typeof record.nodeId === 'string' ? record.nodeId : '';
      const text = typeof record.text === 'string' ? record.text.trim() : '';

      if (type === 'DOCUMENT_ROOT') {
        if (structureId) visibleIdByStructureId.set(structureId, root.id);
        continue;
      }
      if (type === 'DOCUMENT_TITLE') {
        if (text) root.title = text;
        root.sourceHeadingId = structureId || root.sourceHeadingId;
        root.sourceLineNo = positiveInteger(record.firstLineNo);
        if (structureId) visibleIdByStructureId.set(structureId, root.id);
        activeDraft = root;
        continue;
      }
      if (type === 'HEADING') {
        if (!structureId || !text) continue;
        if (drafts.length >= MAX_OUTLINE_NODES) {
          throw new Error(`文档目录超过 ${MAX_OUTLINE_NODES} 个节点，暂时无法在 Wiki 中完整展示。`);
        }
        const structureParentId = typeof record.parentId === 'string' ? record.parentId : 'n-root';
        const parentId = visibleIdByStructureId.get(structureParentId) ?? root.id;
        const parent = draftsById.get(parentId) ?? root;
        const order = (siblingCounts.get(parent.id) ?? 0) + 1;
        siblingCounts.set(parent.id, order);
        const draft: OutlineDraft = {
          id: wikiNodeId(input.documentId, structureId),
          parentId: parent.id,
          title: text,
          order,
          depth: parent.depth + 1,
          sourceHeadingId: structureId,
          sourceLineNo: positiveInteger(record.firstLineNo),
          content: [],
          contentChars: 0,
          truncated: false,
        };
        drafts.push(draft);
        draftsById.set(draft.id, draft);
        visibleIdByStructureId.set(structureId, draft.id);
        sectionDrafts.push(draft);
        activeDraft = draft;
        continue;
      }

      const markdown = formatStructureContent(type, text, record.indent);
      if (markdown !== null) appendNodeContent(activeDraft, markdown);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  const sourceLines = readSourceMarkdownLines(input.markdownPath);
  const blankBeforeLines = readBlankBeforeLines(input.lineLayoutPath);
  const boundedDrafts = sectionDrafts.filter((draft) => draft.sourceLineNo > 0);
  const boundedIndexById = new Map(boundedDrafts.map((draft, index) => [draft.id, index]));
  const sectionBounds = collectSectionBounds(boundedDrafts, boundedIndexById, root, draftsById, sourceLines);
  const nodes = drafts.map((draft): WikiDocumentOutlineNode => ({
    id: draft.id,
    parentId: draft.parentId,
    title: draft.title,
    order: draft.order,
    depth: draft.depth,
      sourceHeadingId: draft.sourceHeadingId,
      sourceLineNo: draft.sourceLineNo,
      markdown: renderNodeMarkdown(
        draft,
        sourceLines,
        sectionBounds.get(draft.id),
        blankBeforeLines,
        (target) => renderSynthesizedSubtree(target, root, boundedDrafts, boundedIndexById, draftsById),
      ),
    }));
  return {
    documentId: input.documentId,
    title: root.title,
    description: `来自结构树索引 · ${nodes.length} 个目录节点`,
    updatedAt: input.updatedAt,
    contentHash: input.contentHash,
    orderRevisions: createOrderRevisions(input.contentHash, nodes),
    nodes,
  };
}

/**
 * Merge the app-owned sibling order overlay into a freshly read structure
 * outline. Invalid or stale overlays are ignored so Wiki browsing remains
 * available even when metadata is damaged or the source structure changed.
 */
export function applyWikiSiblingOrderOverrides(
  libraryPath: string,
  outline: WikiDocumentOutline,
): WikiDocumentOutline {
  const saved = readSiblingOrderFile(libraryPath, outline.documentId);
  if (!saved || saved.documentId !== outline.documentId || saved.contentHash !== outline.contentHash) {
    return outline;
  }

  let nodes = outline.nodes;
  const revisions = { ...outline.orderRevisions };
  Object.entries(saved.branches).forEach(([parentId, branch]) => {
    const currentIds = getOrderedSiblingIds(nodes, parentId);
    if (!hasSameNodeSet(currentIds, branch.orderedNodeIds)) return;
    nodes = applySiblingOrder(nodes, parentId, branch.orderedNodeIds);
    revisions[parentId] = branch.revision;
  });
  return { ...outline, nodes, orderRevisions: revisions };
}

/**
 * Persist one complete sibling ordering behind an optimistic revision check.
 * Writes are serialized per document and committed with an atomic rename.
 */
export async function reorderWikiSiblingNodes(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiSiblingOrderRequest;
  now?: Date;
}): Promise<WikiSiblingOrderResult> {
  const queueKey = siblingOrderPath(input.libraryPath, input.outline.documentId);
  return enqueueOrderWrite(queueKey, () => persistSiblingOrder(input));
}

function persistSiblingOrder(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiSiblingOrderRequest;
  now?: Date;
}): WikiSiblingOrderResult {
  const { outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return orderFailure('WIKI_ORDER_INVALID', 'Wiki 文档标识与当前目录不一致。');
  }
  if (!request.parentId || !request.expectedRevision || !Array.isArray(request.orderedNodeIds)) {
    return orderFailure('WIKI_ORDER_INVALID', '章节排序请求不完整。');
  }
  if (request.orderedNodeIds.length > MAX_OUTLINE_NODES || new Set(request.orderedNodeIds).size !== request.orderedNodeIds.length) {
    return orderFailure('WIKI_ORDER_INVALID', '章节排序包含重复或过多节点。');
  }

  const currentOutline = applyWikiSiblingOrderOverrides(input.libraryPath, outline);
  const currentIds = getOrderedSiblingIds(currentOutline.nodes, request.parentId);
  if (currentIds.length === 0 || !currentOutline.nodes.some((node) => node.id === request.parentId)) {
    return orderFailure('WIKI_ORDER_CONFLICT', '章节结构已变化，请重新加载当前分支后再试。');
  }
  if (!hasSameNodeSet(currentIds, request.orderedNodeIds)) {
    return orderFailure('WIKI_ORDER_CONFLICT', '同级章节集合已变化，请重新加载当前分支后再试。');
  }
  const currentRevision = currentOutline.orderRevisions[request.parentId];
  if (!currentRevision || currentRevision !== request.expectedRevision) {
    return orderFailure('WIKI_ORDER_CONFLICT', '章节顺序已被其他窗口更新，请重新加载当前分支后再试。');
  }
  if (currentIds.every((nodeId, index) => request.orderedNodeIds[index] === nodeId)) {
    return {
      ok: true,
      documentId: outline.documentId,
      parentId: request.parentId,
      orderedNodeIds: [...currentIds],
      revision: currentRevision,
      updatedAt: input.now?.toISOString() ?? new Date().toISOString(),
    };
  }

  const updatedAt = input.now?.toISOString() ?? new Date().toISOString();
  const nextRevision = crypto.randomUUID();
  const saved = readSiblingOrderFile(input.libraryPath, outline.documentId);
  const branches = collectCurrentBranches(outline, saved);
  branches[request.parentId] = {
    orderedNodeIds: [...request.orderedNodeIds],
    revision: nextRevision,
    updatedAt,
  };

  try {
    const filePath = siblingOrderPath(input.libraryPath, outline.documentId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, {
      schemaVersion: 1,
      documentId: outline.documentId,
      contentHash: outline.contentHash,
      branches,
    } satisfies WikiSiblingOrderFile);
  } catch (error) {
    return orderFailure(
      'WIKI_ORDER_SAVE_FAILED',
      '章节顺序未保存，请检查知识库目录权限后重试。',
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    ok: true,
    documentId: outline.documentId,
    parentId: request.parentId,
    orderedNodeIds: [...request.orderedNodeIds],
    revision: nextRevision,
    updatedAt,
  };
}

function collectCurrentBranches(
  outline: WikiDocumentOutline,
  saved: WikiSiblingOrderFile | null,
): Record<string, WikiSiblingOrderOverride> {
  const branches = Object.create(null) as Record<string, WikiSiblingOrderOverride>;
  if (!saved || saved.documentId !== outline.documentId || saved.contentHash !== outline.contentHash) return branches;
  Object.entries(saved.branches).forEach(([parentId, branch]) => {
    const currentIds = getOrderedSiblingIds(outline.nodes, parentId);
    if (hasSameNodeSet(currentIds, branch.orderedNodeIds)) branches[parentId] = branch;
  });
  return branches;
}

function readSiblingOrderFile(libraryPath: string, documentId: string): WikiSiblingOrderFile | null {
  const filePath = siblingOrderPath(libraryPath, documentId);
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_ORDER_FILE_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WikiSiblingOrderFile>;
    if (value.schemaVersion !== 1 || typeof value.documentId !== 'string' || typeof value.contentHash !== 'string') return null;
    if (!value.branches || typeof value.branches !== 'object' || Array.isArray(value.branches)) return null;
    const branches = Object.create(null) as Record<string, WikiSiblingOrderOverride>;
    for (const [parentId, candidate] of Object.entries(value.branches)) {
      if (!isSiblingOrderOverride(candidate)) continue;
      branches[parentId] = candidate;
    }
    return { schemaVersion: 1, documentId: value.documentId, contentHash: value.contentHash, branches };
  } catch {
    return null;
  }
}

function siblingOrderPath(libraryPath: string, documentId: string): string {
  return assertInsideDirectory(
    path.join(getLibraryMetaDirectory(libraryPath), 'wiki', `${safeSegment(documentId)}.sibling-order.json`),
    libraryPath,
    'Wiki 顺序元数据路径无效。',
  );
}

function isSiblingOrderOverride(value: unknown): value is WikiSiblingOrderOverride {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WikiSiblingOrderOverride>;
  return Array.isArray(record.orderedNodeIds)
    && record.orderedNodeIds.length <= MAX_OUTLINE_NODES
    && record.orderedNodeIds.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0 && nodeId.length <= 2_048)
    && new Set(record.orderedNodeIds).size === record.orderedNodeIds.length
    && typeof record.revision === 'string'
    && record.revision.length > 0
    && record.revision.length <= 128
    && typeof record.updatedAt === 'string';
}

function createOrderRevisions(contentHash: string, nodes: WikiDocumentOutlineNode[]): Record<string, string> {
  const parentIds = new Set(nodes.flatMap((node) => node.parentId ? [node.parentId] : []));
  return Object.fromEntries([...parentIds].map((parentId) => [
    parentId,
    hashOrderRevision(contentHash, parentId, getOrderedSiblingIds(nodes, parentId)),
  ]));
}

function hashOrderRevision(contentHash: string, parentId: string, orderedNodeIds: string[]): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ contentHash, parentId, orderedNodeIds }))
    .digest('hex');
}

function getOrderedSiblingIds(nodes: WikiDocumentOutlineNode[], parentId: string): string[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

function hasSameNodeSet(currentIds: string[], requestedIds: string[]): boolean {
  const requested = new Set(requestedIds);
  return currentIds.length === requestedIds.length
    && requested.size === requestedIds.length
    && currentIds.every((nodeId) => requested.has(nodeId));
}

function applySiblingOrder(
  nodes: WikiDocumentOutlineNode[],
  parentId: string,
  orderedNodeIds: string[],
): WikiDocumentOutlineNode[] {
  const orderById = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index + 1]));
  return nodes.map((node) => {
    const order = node.parentId === parentId ? orderById.get(node.id) : undefined;
    return order === undefined ? node : { ...node, order };
  });
}

function orderFailure(
  code: WikiSiblingOrderErrorCode,
  message: string,
  diagnostic?: string,
): WikiSiblingOrderResult {
  return { ok: false, error: { code, message, ...(diagnostic ? { diagnostic } : {}) } };
}

async function enqueueOrderWrite<T>(queueKey: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = orderWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  orderWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (orderWriteQueues.get(queueKey) === current) orderWriteQueues.delete(queueKey);
  }
}

function wikiNodeId(documentId: string, sourceNodeId: string): string {
  return `wiki:${documentId}:${sourceNodeId}`;
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/*
 * Structure-tree list records keep the author's original marker in `text` and
 * the leading column count in `indent`; re-emitting them verbatim preserves
 * nesting, while marker-less records get a canonical bullet.
 */
const structureListMarkerPattern = /^(?:[-*+]\s+\S|\d{1,9}[.)]\s+\S)/;
const structureQuoteMarkerPattern = /^ {0,3}>/;

function formatStructureContent(type: string, text: string, indent?: unknown): string | null {
  if (type === 'NOISE' || type === 'DOCUMENT_ROOT' || type === 'DOCUMENT_TITLE' || type === 'HEADING') return null;
  if (type === 'BLANK') return '';
  if (!text) return null;
  if (type === 'LIST_ITEM') {
    const nesting = ' '.repeat(Math.min(typeof indent === 'number' && Number.isInteger(indent) ? Math.max(indent, 0) : 0, 16));
    return structureListMarkerPattern.test(text) ? `${nesting}${text}` : `${nesting}- ${text}`;
  }
  if (type === 'QUOTE') return structureQuoteMarkerPattern.test(text) ? text : `> ${text}`;
  if (type === 'SEPARATOR') return '---';
  return text;
}

function appendNodeContent(draft: OutlineDraft, markdown: string): void {
  if (draft.truncated) return;
  const nextChars = draft.contentChars + markdown.length;
  if (nextChars > MAX_NODE_MARKDOWN_CHARS) {
    draft.content.push('', '> 本章节内容较长，Wiki 预览已截断；目录结构不受影响。');
    draft.truncated = true;
    return;
  }
  draft.content.push(markdown);
  draft.contentChars = nextChars;
}

function readSourceMarkdownLines(markdownPath: string | undefined): string[] | null {
  if (!markdownPath) return null;
  try {
    if (!fs.existsSync(markdownPath) || fs.statSync(markdownPath).size > MAX_SOURCE_MARKDOWN_BYTES) return null;
    return fs.readFileSync(markdownPath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  } catch {
    return null;
  }
}

/**
 * The parse artifacts compact blank lines away; the line layout remembers where
 * they were. Restoring them keeps sliced sections valid standard Markdown.
 */
function readBlankBeforeLines(lineLayoutPath: string | undefined): Set<number> | null {
  if (!lineLayoutPath) return null;
  try {
    if (!fs.existsSync(lineLayoutPath) || fs.statSync(lineLayoutPath).size > MAX_SOURCE_MARKDOWN_BYTES) return null;
    const blankBefore = new Set<number>();
    for (const line of fs.readFileSync(lineLayoutPath, 'utf8').split('\n')) {
      if (!line.includes('"blankBefore":true')) continue;
      const match = /"lineNo":\s*(\d+)/.exec(line);
      if (match) blankBefore.add(Number(match[1]));
    }
    return blankBefore;
  } catch {
    return null;
  }
}

/**
 * Map every outline node to the physical line range it occupies in the parsed
 * document.md, so the detail pane can render the original standard Markdown
 * (code fences, tables and lists intact) instead of a per-line reconstruction.
 * A chapter's range always runs through its complete descendant subtree. This
 * lets a parent detail show its own introduction followed by every child
 * section, while stopping before the next sibling chapter.
 */
function collectSectionBounds(
  boundedDrafts: OutlineDraft[],
  boundedIndexById: Map<string, number>,
  root: OutlineDraft,
  draftsById: Map<string, OutlineDraft>,
  sourceLines: string[] | null,
): Map<string, WikiSectionBounds> {
  const bounds = new Map<string, WikiSectionBounds>();
  if (!sourceLines) return bounds;
  const documentEnd = sourceLines.length + 1;
  bounds.set(root.id, {
    startLine: 1,
    endLine: documentEnd,
  });
  boundedDrafts.forEach((draft) => {
    bounds.set(draft.id, {
      startLine: draft.sourceLineNo,
      endLine: subtreeEndLine(draft, boundedDrafts, boundedIndexById, draftsById, documentEnd),
    });
  });
  return bounds;
}

function isDescendantDraft(
  candidate: OutlineDraft,
  ancestor: OutlineDraft,
  draftsById: Map<string, OutlineDraft>,
): boolean {
  let parentId = candidate.parentId;
  let guard = 0;
  while (parentId && guard < MAX_OUTLINE_NODES) {
    if (parentId === ancestor.id) return true;
    parentId = draftsById.get(parentId)?.parentId ?? null;
    guard += 1;
  }
  return false;
}

function subtreeEndLine(
  draft: OutlineDraft,
  boundedDrafts: OutlineDraft[],
  boundedIndexById: Map<string, number>,
  draftsById: Map<string, OutlineDraft>,
  documentEnd: number,
): number {
  const startIndex = boundedIndexById.get(draft.id);
  // The root is not part of the heading run, so its subtree is the document.
  if (startIndex === undefined) return documentEnd;
  let end = startIndex + 1;
  while (end < boundedDrafts.length && isDescendantDraft(boundedDrafts[end], draft, draftsById)) end += 1;
  return boundedDrafts[end]?.sourceLineNo ?? documentEnd;
}

function renderSynthesizedSubtree(
  target: OutlineDraft,
  root: OutlineDraft,
  boundedDrafts: OutlineDraft[],
  boundedIndexById: Map<string, number>,
  draftsById: Map<string, OutlineDraft>,
): string {
  const sources = target.id === root.id ? [root, ...boundedDrafts] : collectSubtreeRun(target, boundedDrafts, boundedIndexById, draftsById);
  const parts: string[] = [];
  let chars = 0;
  const append = (entry: string): boolean => {
    const separatorChars = parts.length > 0 ? LINE_BREAK.length : 0;
    if (chars + separatorChars + entry.length > MAX_NODE_MARKDOWN_CHARS) {
      parts.push('', '> 本章节内容较长，Wiki 预览已截断；目录结构不受影响。');
      return false;
    }
    parts.push(entry);
    chars += separatorChars + entry.length;
    return true;
  };
  for (const draft of sources) {
    const headingLevel = Math.min(6, Math.max(1, draft.depth - target.depth + 1));
    if (parts.length > 0 && !append('')) break;
    if (!append(`${'#'.repeat(headingLevel)} ${draft.title}`)) break;
    if (draft.content.length > 0 && !append('')) break;
    for (const entry of draft.content) {
      if (!append(entry)) return collapseBlankRuns(stabilizeMarkdownBlocks(parts).join(LINE_BREAK)).trim();
    }
  }
  return collapseBlankRuns(stabilizeMarkdownBlocks(parts).join(LINE_BREAK)).trim();
}

function collectSubtreeRun(
  target: OutlineDraft,
  boundedDrafts: OutlineDraft[],
  boundedIndexById: Map<string, number>,
  draftsById: Map<string, OutlineDraft>,
): OutlineDraft[] {
  const startIndex = boundedIndexById.get(target.id);
  if (startIndex === undefined) return [target];
  const run = [target];
  for (let index = startIndex + 1; index < boundedDrafts.length && isDescendantDraft(boundedDrafts[index], target, draftsById); index += 1) {
    run.push(boundedDrafts[index]);
  }
  return run;
}

const sourceCodeFencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function trackSourceCodeFence(line: string, activeMarker: string | null): string | null {
  const match = sourceCodeFencePattern.exec(line);
  if (!match) return activeMarker;
  const marker = match[1];
  if (activeMarker === null) return marker;
  if (marker[0] === activeMarker[0] && marker.length >= activeMarker.length && !match[2].trim()) return null;
  return activeMarker;
}

const stabilizedTableRowPattern = /^\s*\|.*\|\s*$/;

/**
 * Restored or synthesized blank lines must not split a code fence or a table
 * row run: standard Markdown cannot represent those blocks with gaps, so the
 * offending blank lines are dropped instead of breaking the block.
 */
function stabilizeMarkdownBlocks(lines: string[]): string[] {
  const stabilized: string[] = [];
  let fenceMarker: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      const previous = stabilized[stabilized.length - 1];
      const next = lines[index + 1];
      if (fenceMarker !== null) continue;
      if (
        previous !== undefined
        && next !== undefined
        && stabilizedTableRowPattern.test(previous)
        && stabilizedTableRowPattern.test(next)
      ) continue;
      stabilized.push(line);
      continue;
    }
    fenceMarker = trackSourceCodeFence(line, fenceMarker);
    stabilized.push(line);
  }
  return stabilized;
}

function renderSourceSection(
  sourceLines: string[],
  bounds: WikiSectionBounds,
  blankBeforeLines: Set<number> | null,
): string {
  const collected: string[] = [];
  let chars = 0;
  let truncated = false;
  let fenceMarker: string | null = null;
  const endLine = Math.min(bounds.endLine, sourceLines.length + 1);
  for (let lineNo = Math.max(bounds.startLine, 1); lineNo < endLine; lineNo += 1) {
    const line = sourceLines[lineNo - 1];
    const restoreBlank = blankBeforeLines?.has(lineNo) ?? false;
    if (chars + line.length + (restoreBlank ? 2 : 1) > MAX_NODE_MARKDOWN_CHARS) {
      truncated = true;
      break;
    }
    if (restoreBlank) collected.push('');
    collected.push(line);
    chars += line.length + (restoreBlank ? 2 : 1);
    fenceMarker = trackSourceCodeFence(line, fenceMarker);
  }
  const stabilized = stabilizeMarkdownBlocks(collected);
  if (truncated) {
    // Close an interrupted fence so the truncation notice stays prose.
    if (fenceMarker) stabilized.push(fenceMarker);
    stabilized.push('', '> 本章节内容较长，Wiki 预览已截断；目录结构不受影响。');
  }
  return stabilized.join('\n').trim();
}

function renderNodeMarkdown(
  draft: OutlineDraft,
  sourceLines: string[] | null,
  bounds: WikiSectionBounds | undefined,
  blankBeforeLines: Set<number> | null,
  synthesizedSubtree: (target: OutlineDraft) => string,
): string {
  if (sourceLines && bounds) {
    const section = renderSourceSection(sourceLines, bounds, blankBeforeLines);
    if (section) return section;
  }
  const section = synthesizedSubtree(draft);
  return section || `# ${draft.title}\n\n当前目录节点没有独立正文。`;
}

const LINE_BREAK = '\n';
const MAX_BLANK_RUN = 3;

function collapseBlankRuns(text: string): string {
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of text.split(LINE_BREAK)) {
    blankRun = line.trim() ? 0 : blankRun + 1;
    if (blankRun <= MAX_BLANK_RUN) collapsed.push(line);
  }
  return collapsed.join(LINE_BREAK);
}
