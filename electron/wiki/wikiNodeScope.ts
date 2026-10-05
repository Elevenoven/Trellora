import type { WikiDocumentOutlineNode } from '../wikiOutline';

/**
 * Wiki 节点作用域计算（方案 §3.1）。
 *
 * 关键事实：chunk 的 `sectionPath` 末位 nodeId 即该 chunk 所属章节的结构树 nodeId，
 * 与 outline 节点的 `sourceHeadingId` 同源。因此"节点子树归属"等价于：
 * chunk 的 sectionPath 末位 nodeId ∈ 节点自身及其全部后代标题节点的 sourceHeadingId 集合。
 */

interface WikiNodeIndex {
  byId: Map<string, WikiDocumentOutlineNode>;
  childrenByParent: Map<string, WikiDocumentOutlineNode[]>;
}

function indexOutlineNodes(nodes: readonly WikiDocumentOutlineNode[]): WikiNodeIndex {
  const byId = new Map<string, WikiDocumentOutlineNode>();
  const childrenByParent = new Map<string, WikiDocumentOutlineNode[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  return { byId, childrenByParent };
}

/** 按 id 查找节点；不存在返回 undefined（调用方给出中文可操作错误）。 */
export function findWikiNode(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode | undefined {
  return nodes.find((node) => node.id === nodeId);
}

/** 根节点（parentId 为 null）作用域为整篇文档，检索时不下发 sectionNodeIds 过滤。 */
export function isWikiRootNode(node: WikiDocumentOutlineNode | undefined): boolean {
  return Boolean(node && node.parentId === null);
}

/** 节点的直接子节点（按 order 升序）。 */
export function collectWikiChildNodes(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode[] {
  const { childrenByParent } = indexOutlineNodes(nodes);
  return [...(childrenByParent.get(nodeId) ?? [])].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

/**
 * 收集节点子树（含自身）的全部 sourceHeadingId。
 * 该集合作为 searchMaterialChunks 的 sectionNodeIds，实现章节子树级作用域过滤。
 * 根节点返回整篇文档全部标题的 sourceHeadingId；调用方对根节点应改为不过滤（见 isWikiRootNode）。
 */
export function collectSubtreeHeadingIds(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): string[] {
  const { byId, childrenByParent } = indexOutlineNodes(nodes);
  const target = byId.get(nodeId);
  if (!target) return [];
  const headingIds: string[] = [];
  const seen = new Set<string>();
  const stack: WikiDocumentOutlineNode[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as WikiDocumentOutlineNode;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.sourceHeadingId) headingIds.push(current.sourceHeadingId);
    for (const child of childrenByParent.get(current.id) ?? []) stack.push(child);
  }
  return headingIds;
}

/**
 * 收集节点子树（含自身）的全部节点，按深度优先、同级 order 升序返回。
 * wiki_grep_node 用它在本章节子树内逐节点字面检索原文（含 markdown）。
 */
export function collectWikiSubtreeNodes(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode[] {
  const { byId, childrenByParent } = indexOutlineNodes(nodes);
  const target = byId.get(nodeId);
  if (!target) return [];
  const result: WikiDocumentOutlineNode[] = [];
  const seen = new Set<string>();
  const stack: WikiDocumentOutlineNode[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as WikiDocumentOutlineNode;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    result.push(current);
    const children = [...(childrenByParent.get(current.id) ?? [])].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    );
    // 逆序入栈，保证出栈为文档顺序（同级 order 升序的深度优先）。
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return result;
}

/**
 * 计算「整篇文档 − 当前子树」的 sourceHeadingId 集合（方案 §4.3）。
 * 作为 wiki_search_document 的 sectionNodeIds：跨章节检索只召回当前节点子树之外的章节，
 * 维持作用域纪律。派生节点（kind:'derived'）无对应 chunk，跳过；excludeHeadingIds 为当前子树集合。
 * 调用方需先处理根节点（sectionNodeIds 为 undefined 时整篇即当前作用域，无跨章节可言）。
 */
export function collectCrossNodeHeadingIds(
  nodes: readonly WikiDocumentOutlineNode[],
  excludeHeadingIds: readonly string[] | undefined,
): string[] {
  const exclude = new Set(excludeHeadingIds ?? []);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'derived') continue;
    const headingId = node.sourceHeadingId;
    if (!headingId || exclude.has(headingId) || seen.has(headingId)) continue;
    seen.add(headingId);
    result.push(headingId);
  }
  return result;
}

/**
 * 判断 nodeId 是否等于 ancestorId 或是其后代（含自身）。
 * wiki_read_node 用它把深读范围限定在当前节点子树内，维持作用域纪律。
 */
export function isWikiNodeDescendantOf(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
  ancestorId: string,
): boolean {
  const { byId } = indexOutlineNodes(nodes);
  let current = byId.get(nodeId);
  let guard = 0;
  while (current && guard < nodes.length + 1) {
    if (current.id === ancestorId) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return false;
}

/** 节点面包屑（根 → 目标节点的标题链），用于 runtime_context 与引用来源展示。 */
export function getWikiNodeBreadcrumb(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): string[] {
  const { byId } = indexOutlineNodes(nodes);
  const path: string[] = [];
  let current = byId.get(nodeId);
  let guard = 0;
  while (current && guard < nodes.length + 1) {
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return path;
}

/** 以 " › " 连接的面包屑字符串；空路径返回空串。 */
export function formatWikiNodePath(breadcrumb: readonly string[]): string {
  return breadcrumb.join(' › ');
}
