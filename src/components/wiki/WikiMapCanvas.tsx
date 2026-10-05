import { t, useI18n } from '../../i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WikiMapInteractionMode, WikiMapNode } from '../../wiki/wikiTypes';
import { createWikiBranchColorMap } from '../../wiki/wikiBranchColors';
import {
  collectVisibleWikiNodes,
  collectWikiDescendantIds,
  collectWikiSelectionBranchIds,
} from '../../wiki/wikiViewState';
import {
  applyWikiBranchDrag,
  createWikiSiblingReorderPreview,
  getWikiNodeSize,
  layoutWikiGraph,
  type WikiLayoutPoint,
  type WikiMeasuredHeights,
} from '../../wiki/wikiLayout';
import WikiMapNodeComponent, { type WikiFlowNode, type WikiMapNodeData } from './WikiMapNode';
import WikiCurveEdge, { type WikiFlowEdge } from './WikiCurveEdge';

interface WikiMapCanvasProps {
  nodes: WikiMapNode[];
  questionReadyNodeIds: Set<string>;
  selectedNodeId: string | null;
  searchQuery: string;
  layoutRevision: number;
  interactionMode: WikiMapInteractionMode;
  reorderSaving: boolean;
  focusRequest: { nodeId: string; revision: number } | null;
  onSelectNode: (nodeId: string) => void;
  onToggleCollapsed: (nodeId: string) => void;
  onReorderSiblings: (parentId: string, orderedNodeIds: string[], anchorNodeId: string) => void;
  onCancelReorder: () => void;
  onOpenContextMenu: (nodeId: string, x: number, y: number) => void;
  onCloseContextMenu: () => void;
}

interface DragState {
  nodeId: string;
  parentId: string;
  originPosition: WikiLayoutPoint;
  originPositions: Map<string, WikiLayoutPoint>;
  orderedSiblingIds: string[];
  insertionIndex: number;
}

interface HierarchyDragState {
  nodeId: string;
  lastPosition: WikiLayoutPoint;
}

interface PendingViewportAnchor {
  nodeId: string;
  screenPosition: WikiLayoutPoint;
}

const PLACEHOLDER_NODE_ID = 'wiki-reorder-placeholder';
const HORIZONTAL_DRAG_TOLERANCE = 18;
const nodeTypes = { wikiNode: WikiMapNodeComponent };
const edgeTypes = { wikiCurve: WikiCurveEdge };

export default function WikiMapCanvas(props: WikiMapCanvasProps) {
  useI18n();
  return (
    <ReactFlowProvider>
      <WikiMapCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WikiMapCanvasInner({
  nodes: modelNodes,
  questionReadyNodeIds,
  selectedNodeId,
  searchQuery,
  layoutRevision,
  interactionMode,
  reorderSaving,
  focusRequest,
  onSelectNode,
  onToggleCollapsed,
  onReorderSiblings,
  onCancelReorder,
  onOpenContextMenu,
  onCloseContextMenu,
}: WikiMapCanvasProps) {
  useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState<WikiFlowNode>([]);
  // Wiki edges are derived from the chapter tree and cannot be edited by React Flow.
  // Keeping them application-owned avoids selection changes racing with a layout refresh.
  const [edges, setEdges] = useState<WikiFlowEdge[]>([]);
  const { fitView, flowToScreenPosition, getViewport, setViewport } = useReactFlow<WikiFlowNode, WikiFlowEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const firstLayoutRef = useRef(true);
  const lastLayoutKeyRef = useRef('');
  const dragStateRef = useRef<DragState | null>(null);
  const hierarchyDragStateRef = useRef<HierarchyDragState | null>(null);
  const pendingViewportAnchorRef = useRef<PendingViewportAnchor | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [measuredRevision, setMeasuredRevision] = useState(0);
  const visibleModelNodes = useMemo(() => collectVisibleWikiNodes(modelNodes), [modelNodes]);
  const branchColors = useMemo(() => createWikiBranchColorMap(modelNodes), [modelNodes]);
  const structureKey = useMemo(
    () => visibleModelNodes.map((node) => `${node.id}:${node.parentId ?? 'root'}:${node.order}`).join('|'),
    [visibleModelNodes],
  );
  const selectedBranchIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    return new Set(collectWikiSelectionBranchIds(modelNodes, selectedNodeId));
  }, [modelNodes, selectedNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const nodeIds = visibleModelNodes.map((node) => node.id);
    if (!canvas || nodeIds.length === 0) return;

    let refreshFrame: number | null = null;
    const refreshEdgeAnchors = () => {
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        updateNodeInternals(nodeIds);
      });
    };
    const observer = new ResizeObserver(refreshEdgeAnchors);
    observer.observe(canvas);
    refreshEdgeAnchors();
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
    };
  }, [structureKey, updateNodeInternals, visibleModelNodes]);

  const handleNodeSizeMeasured = useCallback((nodeId: string, height: number) => {
    if (measuredHeightsRef.current.get(nodeId) === height) return;
    measuredHeightsRef.current.set(nodeId, height);
    setMeasuredRevision((revision) => revision + 1);
  }, []);

  const measuredSizeOf = useCallback((node: WikiMapNode | undefined) => (
    node ? getWikiNodeSize(node, measuredHeightsRef.current) : { width: 208, height: 56 }
  ), []);

  const rememberViewportAnchor = useCallback((nodeId: string, position: WikiLayoutPoint) => {
    const size = measuredSizeOf(modelNodes.find((node) => node.id === nodeId));
    pendingViewportAnchorRef.current = {
      nodeId,
      screenPosition: flowToScreenPosition({
        x: position.x + size.width / 2,
        y: position.y + size.height / 2,
      }),
    };
  }, [flowToScreenPosition, measuredSizeOf, modelNodes]);

  const handleKeyboardReorder = useCallback((nodeId: string, direction: -1 | 1) => {
    if (interactionMode !== 'reorder' || reorderSaving) return;
    const modelNode = modelNodes.find((node) => node.id === nodeId);
    if (!modelNode?.parentId) return;
    const orderedSiblingIds = modelNodes
      .filter((node) => node.parentId === modelNode.parentId)
      .sort(compareModelNodes)
      .map((node) => node.id);
    const currentIndex = orderedSiblingIds.indexOf(nodeId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= orderedSiblingIds.length) return;
    const nextOrderedIds = [...orderedSiblingIds];
    [nextOrderedIds[currentIndex], nextOrderedIds[nextIndex]] = [nextOrderedIds[nextIndex], nextOrderedIds[currentIndex]];
    const flowNode = nodes.find((node) => node.id === nodeId);
    if (flowNode) rememberViewportAnchor(nodeId, flowNode.position);
    onReorderSiblings(modelNode.parentId, nextOrderedIds, nodeId);
  }, [interactionMode, modelNodes, nodes, onReorderSiblings, rememberViewportAnchor, reorderSaving]);

  useEffect(() => {
    const nextLayoutKey = `${structureKey}:${layoutRevision}:${measuredRevision}`;
    const childCounts = new Map<string, number>();
    modelNodes.forEach((node) => {
      if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    });
    const query = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const createNodeData = (node: WikiMapNode): WikiMapNodeData => ({
      node,
      branchColor: branchColors.get(node.id) ?? 'var(--accent-primary)',
      childCount: childCounts.get(node.id) ?? 0,
      hasSuggestedQuestions: questionReadyNodeIds.has(node.id),
      selected: node.id === selectedNodeId,
      dimmed: Boolean(selectedNodeId && !selectedBranchIds.has(node.id) && node.id !== selectedNodeId),
      searchMatch: Boolean(query && node.title.toLocaleLowerCase('zh-CN').includes(query)),
      reorderMode: interactionMode === 'reorder',
      reorderSaving,
      dragging: false,
      reorderDimmed: false,
      placeholder: false,
      dropIndicator: null,
      onNodeSizeMeasured: handleNodeSizeMeasured,
      onToggleCollapsed,
      onKeyboardReorder: handleKeyboardReorder,
      onKeyboardContextMenu: onOpenContextMenu,
    });

    if (lastLayoutKeyRef.current === nextLayoutKey) {
      const nodeById = new Map(visibleModelNodes.map((node) => [node.id, node]));
      setNodes((currentNodes) => configureNodeInteraction(currentNodes
        .filter((flowNode) => flowNode.id !== PLACEHOLDER_NODE_ID)
        .map((flowNode) => {
          const node = nodeById.get(flowNode.id);
          return node ? { ...flowNode, data: createNodeData(node), selected: node.id === selectedNodeId } : flowNode;
        }), interactionMode, reorderSaving, measuredHeightsRef.current));
      setEdges((currentEdges) => currentEdges.map((edge) => ({
        ...edge,
        data: edge.data ? {
          ...edge.data,
          branchColor: branchColors.get(edge.target) ?? 'var(--accent-primary)',
          highlighted: Boolean(selectedNodeId && selectedBranchIds.has(edge.source) && selectedBranchIds.has(edge.target)),
          dragging: false,
        } : edge.data,
      })));
      return;
    }

    lastLayoutKeyRef.current = nextLayoutKey;
    const layout = layoutWikiGraph(visibleModelNodes, measuredHeightsRef.current);
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]));
    const nextNodes = configureNodeInteraction(visibleModelNodes.map((node): WikiFlowNode => ({
      id: node.id,
      type: 'wikiNode',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: createNodeData(node),
      selected: node.id === selectedNodeId,
      width: measuredSizeOf(node).width,
      height: measuredSizeOf(node).height,
    })), interactionMode, reorderSaving, measuredHeightsRef.current);
    setNodes(nextNodes);
    setEdges(layout.edges.map((edge): WikiFlowEdge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'wikiCurve',
      data: {
        branchColor: branchColors.get(edge.target) ?? 'var(--accent-primary)',
        highlighted: Boolean(selectedNodeId && selectedBranchIds.has(edge.source) && selectedBranchIds.has(edge.target)),
        dragging: false,
        settling: true,
      },
    })));

    if (settleFrameRef.current !== null) window.cancelAnimationFrame(settleFrameRef.current);
    settleFrameRef.current = window.requestAnimationFrame(() => {
      settleFrameRef.current = null;
      setEdges((currentEdges) => currentEdges.map((edge) => ({
        ...edge,
        data: edge.data ? { ...edge.data, settling: false } : edge.data,
      })));
    });

    const pendingAnchor = pendingViewportAnchorRef.current;
    const anchoredNode = pendingAnchor ? nextNodes.find((node) => node.id === pendingAnchor.nodeId) : null;
    if (pendingAnchor && anchoredNode) {
      const size = measuredSizeOf(anchoredNode.data.node);
      const currentScreenPosition = flowToScreenPosition({
        x: anchoredNode.position.x + size.width / 2,
        y: anchoredNode.position.y + size.height / 2,
      });
      const viewport = getViewport();
      void setViewport({
        x: viewport.x + pendingAnchor.screenPosition.x - currentScreenPosition.x,
        y: viewport.y + pendingAnchor.screenPosition.y - currentScreenPosition.y,
        zoom: viewport.zoom,
      }, { duration: 0 });
      pendingViewportAnchorRef.current = null;
    } else if (firstLayoutRef.current) {
      firstLayoutRef.current = false;
      window.setTimeout(() => void fitView({ padding: 0.16, duration: 0 }), 0);
    }
  }, [branchColors, fitView, flowToScreenPosition, getViewport, handleKeyboardReorder, handleNodeSizeMeasured, interactionMode, layoutRevision, measuredRevision, measuredSizeOf, modelNodes, onOpenContextMenu, onToggleCollapsed, questionReadyNodeIds, reorderSaving, searchQuery, selectedBranchIds, selectedNodeId, setEdges, setNodes, setViewport, structureKey, visibleModelNodes]);

  useEffect(() => () => {
    if (settleFrameRef.current !== null) window.cancelAnimationFrame(settleFrameRef.current);
  }, []);

  useEffect(() => {
    if (interactionMode !== 'reorder') {
      dragStateRef.current = null;
      hierarchyDragStateRef.current = null;
      setNodes((currentNodes) => configureNodeInteraction(currentNodes
        .filter((node) => node.id !== PLACEHOLDER_NODE_ID)
        .map((node) => ({
          ...node,
          data: { ...node.data, dragging: false, reorderDimmed: false, dropIndicator: null },
        })), 'browse', false, measuredHeightsRef.current));
      setEdges((currentEdges) => currentEdges.map((edge) => ({
        ...edge,
        data: edge.data ? { ...edge.data, dragging: false } : edge.data,
      })));
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelReorder();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [interactionMode, onCancelReorder, setEdges, setNodes]);

  useEffect(() => {
    if (!focusRequest) return;
    const visibleIds = new Set([focusRequest.nodeId, ...collectWikiDescendantIds(modelNodes, focusRequest.nodeId)]);
    const focusNodes = nodes.filter((node) => visibleIds.has(node.id));
    if (focusNodes.length > 0) void fitView({ nodes: focusNodes, padding: 0.28, duration: 260 });
  }, [fitView, focusRequest, modelNodes, nodes]);

  const handleNodeDragStart: OnNodeDrag<WikiFlowNode> = useCallback((_event, node) => {
    if (reorderSaving) return;
    hierarchyDragStateRef.current = {
      nodeId: node.id,
      lastPosition: { ...node.position },
    };
    if (interactionMode !== 'reorder' || !node.data.node.parentId) return;
    const parentId = node.data.node.parentId;
    const orderedSiblingIds = modelNodes
      .filter((candidate) => candidate.parentId === parentId)
      .sort(compareModelNodes)
      .map((candidate) => candidate.id);
    const draggedBranchIds = new Set([
      node.id,
      ...collectWikiDescendantIds(visibleModelNodes, node.id),
    ]);
    dragStateRef.current = {
      nodeId: node.id,
      parentId,
      originPosition: { ...node.position },
      originPositions: new Map(),
      orderedSiblingIds,
      insertionIndex: orderedSiblingIds.indexOf(node.id),
    };
    setNodes((currentNodes) => {
      if (dragStateRef.current?.nodeId === node.id) {
        dragStateRef.current.originPositions = new Map(currentNodes.map((candidate) => [
          candidate.id,
          { ...candidate.position },
        ]));
      }
      const activeNode = currentNodes.find((candidate) => candidate.id === node.id) ?? node;
      const placeholder: WikiFlowNode = {
        ...activeNode,
        id: PLACEHOLDER_NODE_ID,
        position: { ...node.position },
        selected: false,
        selectable: false,
        focusable: false,
        draggable: false,
        extent: undefined,
        data: {
          ...activeNode.data,
          selected: false,
          dragging: false,
          reorderDimmed: false,
          placeholder: true,
          dropIndicator: null,
        },
      };
      const nextNodes = currentNodes
        .filter((candidate) => candidate.id !== PLACEHOLDER_NODE_ID)
        .map((candidate) => ({
          ...candidate,
          data: {
            ...candidate.data,
            dragging: candidate.id === node.id,
            reorderDimmed: candidate.id !== parentId
              && !draggedBranchIds.has(candidate.id)
              && candidate.data.node.parentId !== parentId,
            dropIndicator: null,
          },
        }));
      return [...nextNodes, placeholder];
    });
    setEdges((currentEdges) => currentEdges.map((edge) => ({
      ...edge,
      data: edge.data ? {
        ...edge.data,
        dragging: draggedBranchIds.has(edge.source) || draggedBranchIds.has(edge.target),
      } : edge.data,
    })));
  }, [interactionMode, modelNodes, reorderSaving, setEdges, setNodes, visibleModelNodes]);

  const handleNodeDrag: OnNodeDrag<WikiFlowNode> = useCallback((_event, node) => {
    const hierarchyDragState = hierarchyDragStateRef.current;
    if (!hierarchyDragState || node.id !== hierarchyDragState.nodeId) return;
    const dragState = dragStateRef.current;
    setNodes((currentNodes) => {
      if (dragState && node.id === dragState.nodeId) {
        const originLayoutNodes = [...dragState.originPositions].map(([id, position]) => ({ id, position }));
        const preview = createWikiSiblingReorderPreview(
          visibleModelNodes,
          originLayoutNodes,
          dragState.parentId,
          dragState.nodeId,
          node.position,
        );
        hierarchyDragState.lastPosition = { ...node.position };
        if (!preview) return currentNodes;
        dragState.insertionIndex = preview.insertionIndex;
        const previewPositionById = new Map(preview.nodes.map((candidate) => [candidate.id, candidate.position]));
        const remainingSiblingIds = dragState.orderedSiblingIds.filter((nodeId) => nodeId !== dragState.nodeId);
        const indicatorNodeId = dragState.insertionIndex < remainingSiblingIds.length
          ? remainingSiblingIds[dragState.insertionIndex]
          : remainingSiblingIds.at(-1);
        const indicatorPosition = dragState.insertionIndex < remainingSiblingIds.length ? 'before' : 'after';
        return currentNodes.map((candidate) => ({
          ...candidate,
          position: candidate.id === PLACEHOLDER_NODE_ID
            ? preview.placeholderPosition
            : previewPositionById.get(candidate.id) ?? candidate.position,
          data: {
            ...candidate.data,
            dropIndicator: candidate.id === indicatorNodeId ? indicatorPosition : null,
          },
        }));
      }

      const movedLayoutNodes = applyWikiBranchDrag(
        visibleModelNodes,
        currentNodes
          .filter((candidate) => candidate.id !== PLACEHOLDER_NODE_ID)
          .map((candidate) => ({ id: candidate.id, position: candidate.position })),
        node.id,
        hierarchyDragState.lastPosition,
        node.position,
      );
      hierarchyDragState.lastPosition = { ...node.position };
      const movedPositionById = new Map(movedLayoutNodes.map((candidate) => [candidate.id, candidate.position]));
      return currentNodes.map((candidate) => ({
        ...candidate,
        position: movedPositionById.get(candidate.id) ?? candidate.position,
      }));
    });
  }, [setNodes, visibleModelNodes]);

  const handleNodeDragStop: OnNodeDrag<WikiFlowNode> = useCallback((_event, node) => {
    hierarchyDragStateRef.current = null;
    const dragState = dragStateRef.current;
    if (!dragState || node.id !== dragState.nodeId) return;
    const nextOrderedIds = dragState.orderedSiblingIds.filter((nodeId) => nodeId !== dragState.nodeId);
    nextOrderedIds.splice(dragState.insertionIndex, 0, dragState.nodeId);
    const orderChanged = nextOrderedIds.some((nodeId, index) => nodeId !== dragState.orderedSiblingIds[index]);
    rememberViewportAnchor(node.id, dragState.originPosition);
    setNodes((currentNodes) => currentNodes
      .filter((candidate) => candidate.id !== PLACEHOLDER_NODE_ID)
      .map((candidate) => ({
        ...candidate,
        position: !orderChanged
          ? dragState.originPositions.get(candidate.id) ?? candidate.position
          : candidate.position,
        data: {
          ...candidate.data,
          dragging: false,
          reorderDimmed: false,
          dropIndicator: null,
        },
      })));
    setEdges((currentEdges) => currentEdges.map((edge) => ({
      ...edge,
      data: edge.data ? { ...edge.data, dragging: false } : edge.data,
    })));
    dragStateRef.current = null;
    if (orderChanged) {
      onReorderSiblings(dragState.parentId, nextOrderedIds, dragState.nodeId);
    } else {
      pendingViewportAnchorRef.current = null;
    }
  }, [onReorderSiblings, rememberViewportAnchor, setEdges, setNodes]);

  const handleNodeClick: NodeMouseHandler<WikiFlowNode> = (_event, node) => onSelectNode(node.id);
  const handleNodeContextMenu: NodeMouseHandler<WikiFlowNode> = (event, node) => {
    event.preventDefault();
    onOpenContextMenu(node.id, event.clientX, event.clientY);
  };

  const reorderMode = interactionMode === 'reorder';
  return (
    <div
      ref={canvasRef}
      className={`wiki-map-canvas ${reorderMode ? 'reorder-mode' : 'browse-mode'}`}
      aria-label={reorderMode ? t("Wiki 章节导图，调整同级章节顺序") : t("Wiki 章节导图，浏览模式")}
    >
      <ReactFlow<WikiFlowNode, WikiFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={onCloseContextMenu}
        nodesDraggable={!reorderSaving}
        nodesConnectable={false}
        elementsSelectable={false}
        selectNodesOnDrag={false}
        disableKeyboardA11y
        deleteKeyCode={null}
        autoPanOnNodeDrag={!reorderMode}
        nodeDragThreshold={3}
        panOnDrag
        zoomOnScroll
        minZoom={0.28}
        maxZoom={1.8}
        defaultEdgeOptions={{ selectable: false, focusable: false }}
      >
        <Background gap={24} size={1} className="wiki-map-background" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(node) => (node as WikiFlowNode).data.branchColor}
          maskColor="color-mix(in srgb, var(--text-primary) 8%, transparent)"
        />
      </ReactFlow>
    </div>
  );
}

function configureNodeInteraction(
  nodes: WikiFlowNode[],
  interactionMode: WikiMapInteractionMode,
  reorderSaving: boolean,
  measured: WikiMeasuredHeights,
): WikiFlowNode[] {
  const siblingsByParentId = new Map<string, WikiFlowNode[]>();
  nodes.forEach((node) => {
    const parentId = node.data.node.parentId;
    if (!parentId || node.id === PLACEHOLDER_NODE_ID) return;
    const siblings = siblingsByParentId.get(parentId) ?? [];
    siblings.push(node);
    siblingsByParentId.set(parentId, siblings);
  });
  return nodes.map((node) => {
    const parentId = node.data.node.parentId;
    const reorderable = interactionMode === 'reorder'
      && !reorderSaving
      && Boolean(parentId)
      && node.id !== PLACEHOLDER_NODE_ID;
    const freelyDraggable = interactionMode === 'browse'
      && !reorderSaving
      && node.id !== PLACEHOLDER_NODE_ID;
    const siblings = parentId ? siblingsByParentId.get(parentId) ?? [] : [];
    const siblingYPositions = siblings.map((sibling) => sibling.position.y);
    const nodeSize = getWikiNodeSize(node.data.node, measured);
    const minY = siblingYPositions.length > 0 ? Math.min(...siblingYPositions) - nodeSize.height : node.position.y;
    const maxY = siblingYPositions.length > 0 ? Math.max(...siblingYPositions) + nodeSize.height : node.position.y;
    return {
      ...node,
      draggable: freelyDraggable || reorderable,
      extent: reorderable ? [
        [node.position.x - HORIZONTAL_DRAG_TOLERANCE, minY],
        // React Flow treats extent as the bounds of the whole node box. The right
        // edge must therefore include the node width, otherwise it clamps the node
        // left as soon as reorder mode applies the extent.
        [node.position.x + nodeSize.width + HORIZONTAL_DRAG_TOLERANCE, maxY],
      ] : undefined,
      data: { ...node.data, reorderMode: interactionMode === 'reorder' },
    };
  });
}

function compareModelNodes(left: WikiMapNode, right: WikiMapNode): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.title.localeCompare(right.title, 'zh-CN');
}
