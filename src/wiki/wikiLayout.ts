import type { WikiMapNode } from './wikiTypes';

export interface WikiLayoutPoint {
  x: number;
  y: number;
}

export interface WikiLayoutNode {
  id: string;
  position: WikiLayoutPoint;
}

export interface WikiLayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface WikiLayoutResult {
  nodes: WikiLayoutNode[];
  edges: WikiLayoutEdge[];
}

export interface WikiNodeSize {
  width: number;
  height: number;
}

export interface WikiSubtreeVerticalBounds {
  top: number;
  bottom: number;
}

export interface WikiSiblingReorderPreview {
  nodes: WikiLayoutNode[];
  orderedNodeIds: string[];
  insertionIndex: number;
  placeholderPosition: WikiLayoutPoint;
}

export type WikiMeasuredHeights = ReadonlyMap<string, number>;

const ROOT_NODE_SIZE: WikiNodeSize = { width: 208, height: 56 };
const CHAPTER_NODE_SIZE: WikiNodeSize = { width: 184, height: 52 };
const VERTICAL_NODE_GAP = 28;
const HORIZONTAL_LAYER_GAP = 96;
const LAYOUT_PADDING = { top: 48, left: 64 };
// 节点盒子的固定垂直开销：上下 padding 12 + 边框 2 + 状态行 16。
const NODE_VERTICAL_CHROME = 30;
const TITLE_LINE_HEIGHT = 15;
const TITLE_BOX_WIDTH = { root: 148, chapter: 124 };
const CJK_CHAR_WIDTH = 12;
const LATIN_CHAR_WIDTH = 7;
const SPACE_CHAR_WIDTH = 4;
const CURVE_MIN_CONTROL = 24;
const CURVE_MAX_CONTROL = 96;

export function getWikiNodeSize(node: WikiMapNode, measured?: WikiMeasuredHeights): WikiNodeSize {
  const base = node.parentId ? CHAPTER_NODE_SIZE : ROOT_NODE_SIZE;
  const measuredHeight = measured?.get(node.id);
  if (typeof measuredHeight === 'number' && measuredHeight > 0) {
    return { width: base.width, height: measuredHeight };
  }
  return { width: base.width, height: estimateWikiNodeHeight(node) };
}

export function estimateWikiNodeHeight(node: WikiMapNode): number {
  const base = node.parentId ? CHAPTER_NODE_SIZE : ROOT_NODE_SIZE;
  const maxWidth = node.parentId ? TITLE_BOX_WIDTH.chapter : TITLE_BOX_WIDTH.root;
  const lines = estimateTitleLines(node.title, maxWidth);
  return Math.max(base.height, NODE_VERTICAL_CHROME + lines * TITLE_LINE_HEIGHT);
}

export function createWikiCurvePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const gap = targetX - sourceX;
  const control = gap > 0
    ? Math.max(CURVE_MIN_CONTROL, Math.min(CURVE_MAX_CONTROL, gap / 2))
    : CURVE_MIN_CONTROL * 2;
  return [
    `M ${round(sourceX)} ${round(sourceY)}`,
    `C ${round(sourceX + control)} ${round(sourceY)},`,
    `${round(targetX - control)} ${round(targetY)},`,
    `${round(targetX)} ${round(targetY)}`,
  ].join(' ');
}

export function layoutWikiGraph(nodes: WikiMapNode[], measured?: WikiMeasuredHeights): WikiLayoutResult {
  const layoutNodes = layoutWikiTree(nodes, measured);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = nodes
    .filter((node) => node.parentId && nodeById.has(node.parentId))
    .map((node) => ({
      id: `wiki-edge:${node.parentId}:${node.id}`,
      source: node.parentId as string,
      target: node.id,
    }));
  return { nodes: layoutNodes, edges };
}

/**
 * Tidy tree 布局（思维导图 / 逻辑结构图审美）：
 * - 每层一列，列宽取该层最宽节点；
 * - 叶子按顺序消耗垂直光标，父节点垂直居中于其孩子子树跨度；
 * - 因此同级子树天然不重叠，父节点不再悬在子树顶部。
 */
export function layoutWikiTree(nodes: WikiMapNode[], measured?: WikiMeasuredHeights): WikiLayoutNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParentId = buildChildrenByParentId(nodes, nodeById);
  const depthById = new Map<string, number>();
  const depthOf = (node: WikiMapNode): number => {
    const cached = depthById.get(node.id);
    if (cached !== undefined) return cached;
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    const depth = parent ? depthOf(parent) + 1 : 0;
    depthById.set(node.id, depth);
    return depth;
  };

  const columnWidths: number[] = [];
  nodes.forEach((node) => {
    const depth = depthOf(node);
    const width = getWikiNodeSize(node, measured).width;
    columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, width);
  });
  const columnXs: number[] = [];
  let cursorX = LAYOUT_PADDING.left;
  columnWidths.forEach((width, depth) => {
    columnXs[depth] = cursorX;
    cursorX += width + HORIZONTAL_LAYER_GAP;
  });

  const positionById = new Map<string, WikiLayoutPoint>();
  let cursorY = LAYOUT_PADDING.top;
  const place = (node: WikiMapNode, depth: number): WikiSubtreeVerticalBounds => {
    const size = getWikiNodeSize(node, measured);
    const children = childrenByParentId.get(node.id) ?? [];
    if (children.length === 0) {
      const y = cursorY;
      cursorY += size.height + VERTICAL_NODE_GAP;
      positionById.set(node.id, { x: columnXs[depth] ?? cursorX, y });
      return { top: y, bottom: y + size.height };
    }
    const childBounds = children.map((child) => place(child, depth + 1));
    const top = Math.min(...childBounds.map((bounds) => bounds.top));
    const bottom = Math.max(...childBounds.map((bounds) => bounds.bottom));
    const y = (top + bottom) / 2 - size.height / 2;
    positionById.set(node.id, { x: columnXs[depth] ?? cursorX, y });
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + size.height) };
  };

  const roots = nodes
    .filter((node) => !node.parentId || !nodeById.has(node.parentId))
    .sort(compareWikiMapNodes);
  roots.forEach((root) => {
    place(root, depthOf(root));
  });
  nodes
    .filter((node) => !positionById.has(node.id))
    .sort(compareWikiMapNodes)
    .forEach((node) => {
      const size = getWikiNodeSize(node, measured);
      positionById.set(node.id, { x: columnXs[depthOf(node)] ?? LAYOUT_PADDING.left, y: cursorY });
      cursorY += size.height + VERTICAL_NODE_GAP;
    });

  return nodes.map((node) => ({
    id: node.id,
    position: positionById.get(node.id) ?? { x: 0, y: 0 },
  }));
}

export function applyWikiBranchDrag(
  nodes: WikiMapNode[],
  layoutNodes: WikiLayoutNode[],
  draggedNodeId: string,
  previousPosition: WikiLayoutPoint,
  nextPosition: WikiLayoutPoint,
): WikiLayoutNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const positionById = new Map(layoutNodes.map((node) => [node.id, { ...node.position }]));
  if (!nodeById.has(draggedNodeId) || !positionById.has(draggedNodeId)) return layoutNodes;
  const childrenByParentId = buildChildrenByParentId(nodes, nodeById);
  const deltaX = nextPosition.x - previousPosition.x;
  const deltaY = nextPosition.y - previousPosition.y;
  shiftSubtreePositions(
    draggedNodeId,
    deltaX,
    deltaY,
    childrenByParentId,
    positionById,
    new Set([draggedNodeId]),
  );
  positionById.set(draggedNodeId, { ...nextPosition });

  const visitedPathIds = new Set<string>();
  let pathNodeId = draggedNodeId;
  while (!visitedPathIds.has(pathNodeId)) {
    visitedPathIds.add(pathNodeId);
    const parentId = nodeById.get(pathNodeId)?.parentId;
    if (!parentId) break;
    pushAdjacentSiblingSubtrees(
      parentId,
      pathNodeId,
      deltaY,
      childrenByParentId,
      nodeById,
      positionById,
    );
    // 保持思维导图审美：父节点始终垂直居中于孩子子树跨度。
    centerParentOnChildren(parentId, childrenByParentId, nodeById, positionById);
    pathNodeId = parentId;
  }

  return layoutNodes.map((node) => ({
    ...node,
    position: positionById.get(node.id) ?? node.position,
  }));
}

export function createWikiSiblingReorderPreview(
  nodes: WikiMapNode[],
  layoutNodes: WikiLayoutNode[],
  parentId: string,
  draggedNodeId: string,
  nextPosition: WikiLayoutPoint,
): WikiSiblingReorderPreview | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParentId = buildChildrenByParentId(nodes, nodeById);
  const orderedSiblings = childrenByParentId.get(parentId) ?? [];
  const draggedNode = nodeById.get(draggedNodeId);
  const draggedPosition = layoutNodes.find((node) => node.id === draggedNodeId)?.position;
  if (!draggedNode || draggedNode.parentId !== parentId || !draggedPosition) return null;

  const draggedBounds = getSubtreeVerticalBounds(draggedNodeId, childrenByParentId, nodeById, new Map(layoutNodes.map((node) => [node.id, node.position])));
  if (!draggedBounds) return null;
  const deltaY = nextPosition.y - draggedPosition.y;
  const draggedCenterY = (draggedBounds.top + draggedBounds.bottom) / 2 + deltaY;
  const remainingSiblings = orderedSiblings.filter((node) => node.id !== draggedNodeId);
  const insertionIndex = remainingSiblings.findIndex((sibling) => {
    const bounds = getSubtreeVerticalBounds(sibling.id, childrenByParentId, nodeById, new Map(layoutNodes.map((node) => [node.id, node.position])));
    return Boolean(bounds && draggedCenterY < (bounds.top + bounds.bottom) / 2);
  });
  const safeInsertionIndex = insertionIndex < 0 ? remainingSiblings.length : insertionIndex;
  const orderedNodeIds = remainingSiblings.map((node) => node.id);
  orderedNodeIds.splice(safeInsertionIndex, 0, draggedNodeId);

  const orderByNodeId = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const previewModelNodes = nodes.map((node) => (
    node.parentId === parentId && orderByNodeId.has(node.id)
      ? { ...node, order: orderByNodeId.get(node.id) as number }
      : node
  ));
  const alignedNodes = layoutWikiTree(previewModelNodes);
  const placeholderPosition = alignedNodes.find((node) => node.id === draggedNodeId)?.position;
  if (!placeholderPosition) return null;
  const translatedNodes = translateWikiSubtree(
    previewModelNodes,
    alignedNodes,
    draggedNodeId,
    nextPosition.x - placeholderPosition.x,
    nextPosition.y - placeholderPosition.y,
  );
  return {
    nodes: translatedNodes,
    orderedNodeIds,
    insertionIndex: safeInsertionIndex,
    placeholderPosition: { ...placeholderPosition },
  };
}

function translateWikiSubtree(
  nodes: WikiMapNode[],
  layoutNodes: WikiLayoutNode[],
  subtreeRootId: string,
  deltaX: number,
  deltaY: number,
): WikiLayoutNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParentId = buildChildrenByParentId(nodes, nodeById);
  const positionById = new Map(layoutNodes.map((node) => [node.id, { ...node.position }]));
  shiftSubtreePositions(subtreeRootId, deltaX, deltaY, childrenByParentId, positionById);
  return layoutNodes.map((node) => ({
    ...node,
    position: positionById.get(node.id) ?? node.position,
  }));
}

function centerParentOnChildren(
  parentId: string,
  childrenByParentId: Map<string, WikiMapNode[]>,
  nodeById: Map<string, WikiMapNode>,
  positionById: Map<string, WikiLayoutPoint>,
): void {
  const parent = nodeById.get(parentId);
  const parentPosition = positionById.get(parentId);
  if (!parent || !parentPosition) return;
  const bounds = (childrenByParentId.get(parentId) ?? [])
    .map((child) => getSubtreeVerticalBounds(child.id, childrenByParentId, nodeById, positionById))
    .filter((candidate): candidate is WikiSubtreeVerticalBounds => Boolean(candidate));
  if (bounds.length === 0) return;
  const top = Math.min(...bounds.map((candidate) => candidate.top));
  const bottom = Math.max(...bounds.map((candidate) => candidate.bottom));
  parentPosition.y = (top + bottom) / 2 - getWikiNodeSize(parent).height / 2;
}

function buildChildrenByParentId(
  nodes: WikiMapNode[],
  nodeById: Map<string, WikiMapNode>,
): Map<string, WikiMapNode[]> {
  const childrenByParentId = new Map<string, WikiMapNode[]>();
  nodes.forEach((node) => {
    if (!node.parentId || !nodeById.has(node.parentId)) return;
    const children = childrenByParentId.get(node.parentId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentId, children);
  });
  childrenByParentId.forEach((children) => children.sort(compareWikiMapNodes));
  return childrenByParentId;
}

function shiftSubtreePositions(
  subtreeRootId: string,
  deltaX: number,
  deltaY: number,
  childrenByParentId: Map<string, WikiMapNode[]>,
  positionById: Map<string, WikiLayoutPoint>,
  skippedIds = new Set<string>(),
): void {
  const pendingIds = [subtreeRootId];
  const visitedIds = new Set<string>();
  while (pendingIds.length > 0) {
    const nodeId = pendingIds.shift() as string;
    if (visitedIds.has(nodeId)) continue;
    visitedIds.add(nodeId);
    const position = positionById.get(nodeId);
    if (position && !skippedIds.has(nodeId)) {
      position.x += deltaX;
      position.y += deltaY;
    }
    for (const child of childrenByParentId.get(nodeId) ?? []) pendingIds.push(child.id);
  }
}

function pushAdjacentSiblingSubtrees(
  parentId: string,
  pathNodeId: string,
  deltaY: number,
  childrenByParentId: Map<string, WikiMapNode[]>,
  nodeById: Map<string, WikiMapNode>,
  positionById: Map<string, WikiLayoutPoint>,
): void {
  if (deltaY === 0) return;
  const siblings = childrenByParentId.get(parentId) ?? [];
  const pathIndex = siblings.findIndex((node) => node.id === pathNodeId);
  const pathBounds = getSubtreeVerticalBounds(pathNodeId, childrenByParentId, nodeById, positionById);
  if (pathIndex < 0 || !pathBounds) return;

  if (deltaY < 0) {
    let nextSubtreeTop = pathBounds.top;
    for (let index = pathIndex - 1; index >= 0; index -= 1) {
      const sibling = siblings[index];
      const siblingBounds = getSubtreeVerticalBounds(sibling.id, childrenByParentId, nodeById, positionById);
      if (!siblingBounds) continue;
      const overflow = siblingBounds.bottom + VERTICAL_NODE_GAP - nextSubtreeTop;
      if (overflow > 0) {
        shiftSubtreePositions(sibling.id, 0, -overflow, childrenByParentId, positionById);
      }
      const shiftedBounds = getSubtreeVerticalBounds(sibling.id, childrenByParentId, nodeById, positionById);
      if (shiftedBounds) nextSubtreeTop = shiftedBounds.top;
    }
    return;
  }

  let previousSubtreeBottom = pathBounds.bottom;
  for (let index = pathIndex + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    const siblingBounds = getSubtreeVerticalBounds(sibling.id, childrenByParentId, nodeById, positionById);
    if (!siblingBounds) continue;
    const overflow = previousSubtreeBottom + VERTICAL_NODE_GAP - siblingBounds.top;
    if (overflow > 0) {
      shiftSubtreePositions(sibling.id, 0, overflow, childrenByParentId, positionById);
    }
    const shiftedBounds = getSubtreeVerticalBounds(sibling.id, childrenByParentId, nodeById, positionById);
    if (shiftedBounds) previousSubtreeBottom = shiftedBounds.bottom;
  }
}

function getSubtreeVerticalBounds(
  subtreeRootId: string,
  childrenByParentId: Map<string, WikiMapNode[]>,
  nodeById: Map<string, WikiMapNode>,
  positionById: Map<string, WikiLayoutPoint>,
): WikiSubtreeVerticalBounds | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const pendingIds = [subtreeRootId];
  const visitedIds = new Set<string>();
  while (pendingIds.length > 0) {
    const nodeId = pendingIds.shift() as string;
    if (visitedIds.has(nodeId)) continue;
    visitedIds.add(nodeId);
    const node = nodeById.get(nodeId);
    const position = positionById.get(nodeId);
    if (node && position) {
      top = Math.min(top, position.y);
      bottom = Math.max(bottom, position.y + getWikiNodeSize(node).height);
    }
    for (const child of childrenByParentId.get(nodeId) ?? []) pendingIds.push(child.id);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

function estimateTitleLines(title: string, maxWidth: number): number {
  let width = 0;
  for (const char of title) {
    if (char.codePointAt(0)! >= 0x2e80) width += CJK_CHAR_WIDTH;
    else if (/\s/.test(char)) width += SPACE_CHAR_WIDTH;
    else width += LATIN_CHAR_WIDTH;
  }
  return Math.min(2, Math.max(1, Math.ceil(width / maxWidth)));
}

function compareWikiMapNodes(left: WikiMapNode, right: WikiMapNode): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.title.localeCompare(right.title, 'zh-CN');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
