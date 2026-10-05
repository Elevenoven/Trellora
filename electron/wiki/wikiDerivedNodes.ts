import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDirectory } from '../pathGuards';
import { atomicWriteJson, safeSegment } from '../pipeline/pathLayout';
import { getLibraryMetaDirectory } from '../treeOrder';
import type { WikiDocumentOutline, WikiDocumentOutlineNode } from '../wikiOutline';

/**
 * Wiki 派生节点持久化（方案 §6）。
 *
 * 派生节点是「拆分为子节点」等快捷动作经用户「应用」后落库的 AI 生成章节，
 * 存储在资料库元数据目录 `.menghan-meta/wiki/<docId>.derived-nodes.json`，
 * 绝不修改用户原始文件。以文档 `contentHash` 为失效键：源文档变化后整文件失效
 * （读取返回空集，不报错），保证派生节点不会挂到已变更的章节上。
 *
 * 写入沿用 `wikiOutline.ts` 的每文档写队列 + 原子改名模式，避免并发写损坏。
 */

const MAX_DERIVED_NODES = 500;
const MAX_DERIVED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DERIVED_TITLE_CHARS = 200;
const MAX_DERIVED_MARKDOWN_CHARS = 20_000;

export type WikiDerivedErrorCode =
  | 'WIKI_DERIVED_INVALID'
  | 'WIKI_DERIVED_PARENT_NOT_FOUND'
  | 'WIKI_DERIVED_SOURCE_PROTECTED'
  | 'WIKI_DERIVED_NODE_NOT_FOUND'
  | 'WIKI_DERIVED_LIMIT'
  | 'WIKI_DERIVED_SAVE_FAILED'
  | 'WIKI_DERIVED_SOURCE_STALE';

/** 落库的派生节点记录（不含 depth，depth 在合并时按父链计算）。 */
export interface WikiDerivedNode {
  id: string;
  parentId: string;
  title: string;
  order: number;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

interface WikiDerivedNodesFile {
  schemaVersion: 1;
  documentId: string;
  contentHash: string;
  nodes: WikiDerivedNode[];
}

/** 回传渲染进程的派生节点视图（含合并所需的 depth）。 */
export interface WikiDerivedNodeView {
  id: string;
  parentId: string;
  title: string;
  order: number;
  depth: number;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export type WikiDerivedNodeResult =
  | { ok: true; node: WikiDerivedNodeView }
  | { ok: false; error: { code: WikiDerivedErrorCode; message: string; diagnostic?: string } };

export type WikiDerivedDeleteResult =
  | { ok: true; deletedNodeIds: string[] }
  | { ok: false; error: { code: WikiDerivedErrorCode; message: string; diagnostic?: string } };

export interface WikiDerivedNodeRequest {
  documentId: string;
  parentId: string;
  title: string;
  markdown?: string;
}

export interface WikiDerivedRenameRequest {
  documentId: string;
  nodeId: string;
  title: string;
}

export interface WikiDerivedDeleteRequest {
  documentId: string;
  nodeId: string;
}

const derivedWriteQueues = new Map<string, Promise<unknown>>();

/**
 * 把派生节点合并进（已应用同级排序覆盖的）文档目录（方案 §6）。
 * contentHash 不匹配时整文件失效，返回原 outline；派生节点 `kind:'derived'`，
 * `sourceHeadingId` 取自身 id（结构树无此 id，故子树检索命中为空，仅靠直载 markdown 作答）。
 */
export function mergeWikiDerivedNodes(libraryPath: string, outline: WikiDocumentOutline): WikiDocumentOutline {
  const derived = readWikiDerivedNodes(libraryPath, outline.documentId, outline.contentHash);
  if (derived.length === 0) return outline;

  const sourceDepthById = new Map(outline.nodes.map((node) => [node.id, node.depth]));
  const derivedById = new Map(derived.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const depthOf = (id: string, stack: Set<string>): number => {
    const sourceDepth = sourceDepthById.get(id);
    if (sourceDepth !== undefined) return sourceDepth;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 1;
    const node = derivedById.get(id);
    if (!node) return 0;
    stack.add(id);
    const depth = depthOf(node.parentId, stack) + 1;
    stack.delete(id);
    memo.set(id, depth);
    return depth;
  };

  const derivedNodes: WikiDocumentOutlineNode[] = derived.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    order: node.order,
    depth: depthOf(node.id, new Set<string>()),
    markdown: node.markdown,
    sourceHeadingId: node.id,
    sourceLineNo: 0,
    kind: 'derived',
  }));
  return { ...outline, nodes: [...outline.nodes, ...derivedNodes] };
}

/** 新增派生节点；父节点须存在于（已合并派生节点的）outline，来源章节与派生章节均可作父。 */
export async function addWikiDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedNodeRequest;
  now?: Date;
}): Promise<WikiDerivedNodeResult> {
  const queueKey = derivedNodesPath(input.libraryPath, input.outline.documentId);
  return enqueueDerivedWrite(queueKey, () => persistAddDerivedNode(input));
}

/** 重命名派生节点；来源章节不可改名（WIKI_DERIVED_SOURCE_PROTECTED）。 */
export async function renameWikiDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedRenameRequest;
  now?: Date;
}): Promise<WikiDerivedNodeResult> {
  const queueKey = derivedNodesPath(input.libraryPath, input.outline.documentId);
  return enqueueDerivedWrite(queueKey, () => persistRenameDerivedNode(input));
}

/** 删除派生节点（级联全部后代）；来源章节不可删（WIKI_DERIVED_SOURCE_PROTECTED）。 */
export async function deleteWikiDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedDeleteRequest;
}): Promise<WikiDerivedDeleteResult> {
  const queueKey = derivedNodesPath(input.libraryPath, input.outline.documentId);
  return enqueueDerivedWrite(queueKey, () => persistDeleteDerivedNode(input));
}

function persistAddDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedNodeRequest;
  now?: Date;
}): WikiDerivedNodeResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_DERIVED_INVALID', 'Wiki 文档标识与当前目录不一致。') };
  }
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (!title) return { ok: false, error: failure('WIKI_DERIVED_INVALID', '派生节点标题不能为空。') };
  if (title.length > MAX_DERIVED_TITLE_CHARS) {
    return { ok: false, error: failure('WIKI_DERIVED_INVALID', `派生节点标题不能超过 ${MAX_DERIVED_TITLE_CHARS} 个字符。`) };
  }
  const parent = outline.nodes.find((node) => node.id === request.parentId);
  if (!parent) {
    return { ok: false, error: failure('WIKI_DERIVED_PARENT_NOT_FOUND', '父节点不存在或已随文档更新失效，请重新加载后再试。') };
  }

  const existing = readWikiDerivedNodes(libraryPath, outline.documentId, outline.contentHash);
  if (existing.length >= MAX_DERIVED_NODES) {
    return { ok: false, error: failure('WIKI_DERIVED_LIMIT', `派生节点数量已达上限 ${MAX_DERIVED_NODES} 个。`) };
  }
  // 次序排在同级（来源 + 派生）末尾：来源兄弟取自 outline，派生兄弟取自最新文件，避免并发写次序冲突。
  const sourceSiblingOrders = outline.nodes
    .filter((node) => node.parentId === request.parentId && node.kind !== 'derived')
    .map((node) => node.order);
  const derivedSiblingOrders = existing
    .filter((node) => node.parentId === request.parentId)
    .map((node) => node.order);
  const nextOrder = Math.max(0, ...sourceSiblingOrders, ...derivedSiblingOrders) + 1;

  const now = input.now?.toISOString() ?? new Date().toISOString();
  const newNode: WikiDerivedNode = {
    id: createDerivedNodeId(outline.documentId),
    parentId: request.parentId,
    title,
    order: nextOrder,
    markdown: (request.markdown ?? '').slice(0, MAX_DERIVED_MARKDOWN_CHARS),
    createdAt: now,
    updatedAt: now,
  };
  const writeError = writeDerivedNodesFile(libraryPath, outline.documentId, outline.contentHash, [...existing, newNode]);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, node: { ...newNode, depth: parent.depth + 1 } };
}

function persistRenameDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedRenameRequest;
  now?: Date;
}): WikiDerivedNodeResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_DERIVED_INVALID', 'Wiki 文档标识与当前目录不一致。') };
  }
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (!title) return { ok: false, error: failure('WIKI_DERIVED_INVALID', '派生节点标题不能为空。') };
  if (title.length > MAX_DERIVED_TITLE_CHARS) {
    return { ok: false, error: failure('WIKI_DERIVED_INVALID', `派生节点标题不能超过 ${MAX_DERIVED_TITLE_CHARS} 个字符。`) };
  }
  const existing = readWikiDerivedNodes(libraryPath, outline.documentId, outline.contentHash);
  const target = existing.find((node) => node.id === request.nodeId);
  if (!target) {
    const sourceNode = outline.nodes.find((node) => node.id === request.nodeId);
    if (sourceNode && sourceNode.kind !== 'derived') {
      return { ok: false, error: failure('WIKI_DERIVED_SOURCE_PROTECTED', '来源章节不可重命名，仅派生节点可编辑。') };
    }
    return { ok: false, error: failure('WIKI_DERIVED_NODE_NOT_FOUND', '派生节点不存在或已随文档更新失效。') };
  }
  const now = input.now?.toISOString() ?? new Date().toISOString();
  const updated: WikiDerivedNode = { ...target, title, updatedAt: now };
  const nextNodes = existing.map((node) => node.id === target.id ? updated : node);
  const writeError = writeDerivedNodesFile(libraryPath, outline.documentId, outline.contentHash, nextNodes);
  if (writeError) return { ok: false, error: writeError };
  const depth = outline.nodes.find((node) => node.id === target.id)?.depth
    ?? (outline.nodes.find((node) => node.id === target.parentId)?.depth ?? 0) + 1;
  return { ok: true, node: { ...updated, depth } };
}

function persistDeleteDerivedNode(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiDerivedDeleteRequest;
}): WikiDerivedDeleteResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_DERIVED_INVALID', 'Wiki 文档标识与当前目录不一致。') };
  }
  const existing = readWikiDerivedNodes(libraryPath, outline.documentId, outline.contentHash);
  const target = existing.find((node) => node.id === request.nodeId);
  if (!target) {
    const sourceNode = outline.nodes.find((node) => node.id === request.nodeId);
    if (sourceNode && sourceNode.kind !== 'derived') {
      return { ok: false, error: failure('WIKI_DERIVED_SOURCE_PROTECTED', '来源章节不可删除，仅派生节点可删除。') };
    }
    return { ok: false, error: failure('WIKI_DERIVED_NODE_NOT_FOUND', '派生节点不存在或已随文档更新失效。') };
  }
  // 级联收集全部后代（派生节点可嵌套），一并删除。
  const deleted = new Set<string>([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of existing) {
      if (node.parentId && deleted.has(node.parentId) && !deleted.has(node.id)) {
        deleted.add(node.id);
        changed = true;
      }
    }
  }
  const nextNodes = existing.filter((node) => !deleted.has(node.id));
  const writeError = writeDerivedNodesFile(libraryPath, outline.documentId, outline.contentHash, nextNodes);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, deletedNodeIds: [...deleted] };
}

/** 读取并校验派生节点文件；缺失、超限、版本/文档/内容哈希不匹配一律返回空集（整文件失效）。 */
export function readWikiDerivedNodes(libraryPath: string, documentId: string, contentHash: string): WikiDerivedNode[] {
  const filePath = derivedNodesPath(libraryPath, documentId);
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_DERIVED_FILE_BYTES) return [];
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WikiDerivedNodesFile>;
    if (value.schemaVersion !== 1 || value.documentId !== documentId || value.contentHash !== contentHash) return [];
    if (!Array.isArray(value.nodes)) return [];
    const nodes: WikiDerivedNode[] = [];
    for (const candidate of value.nodes) {
      const node = normalizeDerivedNode(candidate);
      if (node) nodes.push(node);
    }
    return nodes;
  } catch {
    return [];
  }
}

function writeDerivedNodesFile(
  libraryPath: string,
  documentId: string,
  contentHash: string,
  nodes: WikiDerivedNode[],
): { code: WikiDerivedErrorCode; message: string; diagnostic?: string } | null {
  try {
    const filePath = derivedNodesPath(libraryPath, documentId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, { schemaVersion: 1, documentId, contentHash, nodes } satisfies WikiDerivedNodesFile);
    return null;
  } catch (error) {
    return failure(
      'WIKI_DERIVED_SAVE_FAILED',
      '派生节点未保存，请检查知识库目录权限后重试。',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeDerivedNode(value: unknown): WikiDerivedNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || record.id.length > 512) return null;
  if (typeof record.parentId !== 'string' || !record.parentId || record.parentId.length > 512) return null;
  if (typeof record.title !== 'string' || !record.title.trim() || record.title.length > MAX_DERIVED_TITLE_CHARS) return null;
  if (typeof record.order !== 'number' || !Number.isFinite(record.order)) return null;
  if (typeof record.markdown !== 'string' || record.markdown.length > MAX_DERIVED_MARKDOWN_CHARS) return null;
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return null;
  return {
    id: record.id,
    parentId: record.parentId,
    title: record.title.trim(),
    order: record.order,
    markdown: record.markdown,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function derivedNodesPath(libraryPath: string, documentId: string): string {
  return assertInsideDirectory(
    path.join(getLibraryMetaDirectory(libraryPath), 'wiki', `${safeSegment(documentId)}.derived-nodes.json`),
    libraryPath,
    'Wiki 派生节点元数据路径无效。',
  );
}

function createDerivedNodeId(documentId: string): string {
  return `wiki:${documentId}:derived:${crypto.randomUUID()}`;
}

function failure(
  code: WikiDerivedErrorCode,
  message: string,
  diagnostic?: string,
): { code: WikiDerivedErrorCode; message: string; diagnostic?: string } {
  return { code, message, ...(diagnostic ? { diagnostic } : {}) };
}

async function enqueueDerivedWrite<T>(queueKey: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = derivedWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  derivedWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (derivedWriteQueues.get(queueKey) === current) derivedWriteQueues.delete(queueKey);
  }
}
