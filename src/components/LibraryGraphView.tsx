import { getAppLanguage, t, useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Button, Checkbox, ScrollArea, Stack, Text } from '@mantine/core';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { forceCollide, type ForceManyBody } from 'd3-force';
import { ArrowLeft, Filter, LocateFixed, Map as MapIcon, MessageSquarePlus, Network, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import type { LibraryGraphVisualizationEntity, LibraryGraphVisualizationPayload, MaterialsDocument, MaterialsLibrarySummary } from '../electron';
import {
  applyDocumentFilter, buildCommunityDrillDown, communityNodeId, communityTitle, createCommunityViewElements,
  createEntityViewElements, entityNodeId, findCommunity, findEntity, getEntityRelatedEdges,
  getLibraryGraphEmptyState, type LibraryGraphViewMode,
} from '../utils/libraryGraphMapView';
import type { ResolvedTheme } from '../utils/theme';
import { relocateWorkspacePath, type WorkspaceDataChange } from '../utils/workspaceDataEvents';

interface LibraryGraphViewProps {
  /** 「就这个社区提问」：预填问题跳转问答区（引导走图谱全局检索）。 */
  onAskAboutCommunity: (libraryPath: string, question: string) => void;
  resolvedTheme: ResolvedTheme;
}

type SelectedTarget = { kind: 'entity'; key: string } | { kind: 'community'; id: string } | null;

interface GraphNode extends NodeObject {
  id: string;
  kind: 'entity' | 'community';
  label: string;
  size: number;
  color: string;
  ref: string;
}

interface GraphLink extends LinkObject<GraphNode> {
  id: string;
  width: number;
  kind: 'relation' | 'community' | 'hierarchy';
  label?: string;
}

function truncateLabel(label: string): string {
  return label.length > 14 ? `${label.slice(0, 14)}…` : label;
}

export default function LibraryGraphView({ onAskAboutCommunity, resolvedTheme }: LibraryGraphViewProps) {
  useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [libraries, setLibraries] = useState<MaterialsLibrarySummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [payload, setPayload] = useState<LibraryGraphVisualizationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LibraryGraphViewMode>('community');
  const [drillCommunityId, setDrillCommunityId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<MaterialsDocument[]>([]);
  /** 左侧文档多选筛选：空集合 = 不筛选（全部文档）。 */
  const [selectedDocIds, setSelectedDocIds] = useState<ReadonlySet<string>>(new Set());
  const [docFilterOpen, setDocFilterOpen] = useState(true);
  /** 抽拉面板宽度：右缘拖拽实时调整（与笔记库侧栏同款的左右拉动）。 */
  const [docFilterWidth, setDocFilterWidth] = useState(236);
  const [docFilterResizing, setDocFilterResizing] = useState(false);
  const docFilterDragRef = useRef<{ x: number; width: number } | null>(null);
  const [selected, setSelected] = useState<SelectedTarget>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LibraryGraphVisualizationEntity[]>([]);
  const [fallbackEntity, setFallbackEntity] = useState<LibraryGraphVisualizationEntity | null>(null);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [colors, setColors] = useState({ text: '#37352f', muted: '#787774', background: '#ffffff', edge: '#7b8190', accent: '#2f2f2c' });
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const engineStartRef = useRef(0);
  const engineDoneRef = useRef(true);
  /** 每次换图（载入/切模式/钻取）后标记未适配，布局收敛时自动 zoomToFit 一次。 */
  const fittedForDataRef = useRef(false);
  const librariesRevisionRef = useRef(0);
  const graphRevisionRef = useRef(0);
  const documentsRevisionRef = useRef(0);
  const refreshedGraphPathRef = useRef<{ path: string | null } | null>(null);
  const refreshedDocumentsPathRef = useRef<{ path: string | null } | null>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    const revision = ++librariesRevisionRef.current;
    void window.electronAPI.listMaterialsLibraries()
      .then((next) => {
        if (revision !== librariesRevisionRef.current) return;
        setLibraries(next);
        setSelectedPath((current) => current ?? next.find((library) => library.isActive)?.path ?? next[0]?.path ?? null);
      })
      .catch(() => { if (revision === librariesRevisionRef.current) setLibraries([]); });
    return () => { librariesRevisionRef.current += 1; };
  }, []);

  useEffect(() => {
    const changed = (event: Event) => {
      const { source, target, waitUntil } = (event as CustomEvent<WorkspaceDataChange>).detail;
      const revision = ++librariesRevisionRef.current;
      graphRevisionRef.current += 1;
      documentsRevisionRef.current += 1;
      setLoading(true);
      setError(null);
      const refresh = (async () => {
        const nextLibraries = await window.electronAPI.listMaterialsLibraries();
        const relocated = relocateWorkspacePath(selectedPath, source, target);
        const nextPath = nextLibraries.find(library => library.path === relocated)?.path
          ?? nextLibraries.find(library => library.isActive)?.path ?? nextLibraries[0]?.path ?? null;
        const [nextPayload, nextDocuments] = nextPath ? await Promise.all([
          window.electronAPI.getLibraryGraphVisualization(nextPath),
          window.electronAPI.listMaterialsDocuments(nextPath),
        ]) : [null, []];
        if (revision !== librariesRevisionRef.current) return;
        // Moving the same library retains filters and selection; the prefetched data avoids a second reset.
        if (selectedPath !== nextPath) {
          refreshedGraphPathRef.current = { path: nextPath };
          refreshedDocumentsPathRef.current = { path: nextPath };
        }
        if (!source || !target || nextPath !== relocated) {
          setSelected(null); setDrillCommunityId(null); setQuery(''); setSearchResults([]); setSelectedDocIds(new Set());
        }
        setLibraries(nextLibraries); setSelectedPath(nextPath); setPayload(nextPayload); setDocuments(nextDocuments);
      })().catch((failure: unknown) => {
        if (revision === librariesRevisionRef.current) setError(failure instanceof Error ? failure.message : t("无法读取图谱投影。"));
        throw failure;
      }).finally(() => { if (revision === librariesRevisionRef.current) setLoading(false); });
      waitUntil(refresh);
    };
    window.addEventListener('workspace-data-changed', changed);
    return () => window.removeEventListener('workspace-data-changed', changed);
  }, [selectedPath]);

  useEffect(() => {
    if (refreshedGraphPathRef.current?.path === selectedPath) { refreshedGraphPathRef.current = null; return; }
    if (!window.electronAPI || !selectedPath) { setPayload(null); return; }
    const revision = ++graphRevisionRef.current;
    let disposed = false;
    setLoading(true);
    setError(null);
    setPayload(null);
    setSelected(null);
    setDrillCommunityId(null);
    setQuery('');
    setSearchResults([]);
    setSelectedDocIds(new Set());
    void window.electronAPI.getLibraryGraphVisualization(selectedPath)
      .then((next) => { if (!disposed && revision === graphRevisionRef.current) setPayload(next); })
      .catch((reason: unknown) => { if (!disposed && revision === graphRevisionRef.current) setError(reason instanceof Error ? reason.message : t("无法读取图谱投影。")); })
      .finally(() => { if (!disposed && revision === graphRevisionRef.current) setLoading(false); });
    return () => { disposed = true; };
  }, [selectedPath, reloadToken]);

  useEffect(() => {
    if (!window.electronAPI?.onLibraryGraphUpdated || !selectedPath) return;
    return window.electronAPI.onLibraryGraphUpdated((updatedPath) => {
      if (updatedPath === selectedPath) setReloadToken((token) => token + 1);
    });
  }, [selectedPath]);

  // 左侧文档筛选面板的候选列表：随资料库切换重拉。
  useEffect(() => {
    if (refreshedDocumentsPathRef.current?.path === selectedPath) { refreshedDocumentsPathRef.current = null; return; }
    if (!window.electronAPI || !selectedPath) { setDocuments([]); return; }
    const revision = ++documentsRevisionRef.current;
    let disposed = false;
    void window.electronAPI.listMaterialsDocuments(selectedPath)
      .then((next) => { if (!disposed && revision === documentsRevisionRef.current) setDocuments(next); })
      .catch(() => { if (!disposed && revision === documentsRevisionRef.current) setDocuments([]); });
    return () => { disposed = true; };
  }, [selectedPath]);

  const filteredPayload = useMemo(
    () => (payload ? applyDocumentFilter(payload, selectedDocIds) : null),
    [payload, selectedDocIds],
  );

  const elements = useMemo(() => {
    if (!filteredPayload) return null;
    return mode === 'community'
      ? createCommunityViewElements(filteredPayload)
      : drillCommunityId
        ? buildCommunityDrillDown(filteredPayload, drillCommunityId)
        : createEntityViewElements(filteredPayload);
  }, [drillCommunityId, mode, filteredPayload]);

  const emptyState = getLibraryGraphEmptyState({ hasLibrary: Boolean(selectedPath), payload });

  // 筛选/钻取后画布可能一个节点都不剩：给空态文案而不是黑屏。
  const elementsEmpty = elements !== null && elements.nodes.length === 0;

  const showCanvas = !error && !loading && !emptyState && !elementsEmpty && Boolean(elements);

  useEffect(() => {
    const root = document.documentElement;
    const updateColors = () => {
      const rootStyles = getComputedStyle(root);
      setColors({
        text: rootStyles.getPropertyValue('--text-primary').trim() || '#37352f',
        muted: rootStyles.getPropertyValue('--text-secondary').trim() || '#787774',
        background: rootStyles.getPropertyValue('--bg-primary').trim() || '#ffffff',
        edge: rootStyles.getPropertyValue('--graph-edge').trim() || '#7b8190',
        accent: rootStyles.getPropertyValue('--accent-primary').trim() || '#2f2f2c',
      });
    };
    updateColors();
    // View Transition 可能晚于 resolvedTheme 更新根主题属性，实际提交后须重新读取画布颜色。
    const observer = new MutationObserver(updateColors);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-light-color-scheme'] });
    return () => observer.disconnect();
  }, [resolvedTheme]);

  useEffect(() => {
    if (!showCanvas) return;
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showCanvas]);

  const graphData = useMemo(() => {
    const nodes: GraphNode[] = (elements?.nodes ?? []).map((node) => ({ ...node }));
    const links: GraphLink[] = (elements?.edges ?? []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.width, kind: edge.kind, label: edge.label }));
    return { nodes, links };
  }, [elements]);

  const nodeIndex = useMemo(() => new Map(graphData.nodes.map((node) => [node.id, node])), [graphData]);

  useEffect(() => {
    engineStartRef.current = performance.now();
    engineDoneRef.current = false;
    fittedForDataRef.current = false;
  }, [graphData]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !selected) return;
    const nodeId = selected.kind === 'entity' ? entityNodeId(selected.key) : communityNodeId(selected.id);
    const node = nodeIndex.get(nodeId);
    if (!node || node.x === undefined || node.y === undefined) return;
    graph.centerAt(node.x, node.y, 500);
  }, [selected, graphData, nodeIndex]);

  // 力参数调优：默认斥力太弱导致社区内节点堆叠，加强斥力、拉长链接并加碰撞半径（给标签留空间）。
  // 社区视图断开的小连通分量更多，斥力/链接距离/碰撞半径再加大一档，与实体视图保持同等舒展度。
  // 依赖含 canvasSize：graphRef 要等 ForceGraph2D 挂载（canvasSize 由 0 变真实尺寸的那次渲染）后才可用，
  // 漏掉这个依赖会让首屏社区视图跑默认力（无碰撞互斥），节点互相重叠。
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const charge = graph.d3Force('charge') as ForceManyBody<GraphNode> | undefined;
    charge?.strength(mode === 'community' ? -320 : -220);
    const link = graph.d3Force('link') as { distance: (accessor: (rawLink: GraphLink) => number) => unknown } | undefined;
    link?.distance((rawLink) => (rawLink.kind === 'hierarchy' ? (mode === 'community' ? 95 : 80) : 52));
    graph.d3Force('collide', forceCollide<GraphNode>((node) => (node.size ?? 12) / 2 + (mode === 'community' ? 14 : 10)));
  }, [graphData, showCanvas, mode, canvasSize]);

  const selectedNodeId = selected
    ? (selected.kind === 'entity' ? entityNodeId(selected.key) : communityNodeId(selected.id))
    : null;

  const drawNode = (rawNode: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as GraphNode;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const radius = node.size / 2;
    // 只给选中节点轻微光晕，避免社区色覆盖相邻标签与关系线。
    ctx.save();
    ctx.shadowColor = node.color;
    ctx.shadowBlur = node.id === selectedNodeId ? 6 * globalScale : 0;
    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    if (node.id === selectedNodeId) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.font = `${11 / globalScale}px system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.text;
    ctx.fillText(truncateLabel(node.label), x, y + radius + 6 / globalScale);
  };

  // 关系文字贴线绘制：force-graph 绘制时把曲线控制点存在 link.__controlPoints，二次贝塞尔 t=0.5 即 0.25·P0+0.5·C+0.25·P1。
  const drawLinkLabel = (rawLink: LinkObject<GraphNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const link = rawLink as GraphLink & { __controlPoints?: [number, number] | null };
    if (!link.label || link.kind === 'hierarchy') return;
    if (globalScale < 0.7) return;
    const source = link.source as GraphNode;
    const target = link.target as GraphNode;
    if (source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return;
    const cp = link.__controlPoints;
    const midX = cp ? 0.25 * source.x + 0.5 * cp[0] + 0.25 * target.x : (source.x + target.x) / 2;
    const midY = cp ? 0.25 * source.y + 0.5 * cp[1] + 0.25 * target.y : (source.y + target.y) / 2;
    const fontSize = 9 / globalScale;
    ctx.font = `${fontSize}px system-ui, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pad = 2 / globalScale;
    const textWidth = ctx.measureText(link.label).width;
    ctx.fillStyle = `${colors.background}C7`;
    ctx.fillRect(midX - textWidth / 2 - pad, midY - fontSize / 2 - pad, textWidth + pad * 2, fontSize + pad * 2);
    ctx.fillStyle = colors.muted;
    ctx.fillText(link.label, midX, midY);
  };

  const paintNodeArea = (rawNode: NodeObject, paintColor: string, ctx: CanvasRenderingContext2D) => {
    const node = rawNode as GraphNode;
    ctx.fillStyle = paintColor;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, Math.max(node.size / 2, 6), 0, 2 * Math.PI);
    ctx.fill();
  };

  const handleNodeClick = (rawNode: NodeObject) => {
    const node = rawNode as GraphNode;
    const now = performance.now();
    if (node.kind === 'community') {
      setSelected({ kind: 'community', id: node.ref });
      // 双击社区 → 钻取成员实体子图（社区视图才有钻取）。
      if (lastTapRef.current?.id === node.id && now - lastTapRef.current.at < 360) {
        setDrillCommunityId(node.ref);
        setMode('entity');
        setSelected(null);
        lastTapRef.current = null;
        return;
      }
    } else {
      setSelected({ kind: 'entity', key: node.ref });
      setFallbackEntity(null);
    }
    lastTapRef.current = { id: node.id, at: now };
  };

  // 拖拽结束即固定（pin），避免松手后被力模拟拉回；右键解除固定。
  const handleNodeDragEnd = (rawNode: NodeObject) => {
    const node = rawNode as GraphNode;
    node.fx = node.x;
    node.fy = node.y;
  };

  const handleNodeRightClick = (rawNode: NodeObject, event: MouseEvent) => {
    event.preventDefault();
    const node = rawNode as GraphNode;
    node.fx = undefined;
    node.fy = undefined;
    graphRef.current?.d3ReheatSimulation();
  };

  const runSearch = async (text: string) => {
    setQuery(text);
    if (!window.electronAPI || !selectedPath || !text.trim()) { setSearchResults([]); return; }
    try {
      setSearchResults(await window.electronAPI.searchLibraryGraphEntities(selectedPath, text));
    } catch {
      setSearchResults([]);
    }
  };

  const locateSearchResult = (entity: LibraryGraphVisualizationEntity) => {
    setQuery(entity.mention);
    setSearchResults([]);
    setDrillCommunityId(null);
    if (mode === 'community') setMode('entity');
    // 实体不在当前筛选后的画布内时，用搜索结果本身填充详情抽屉。
    if (filteredPayload && !findEntity(filteredPayload, entity.canonicalKey)) setFallbackEntity(entity);
    setSelected({ kind: 'entity', key: entity.canonicalKey });
  };

  const returnOverview = () => {
    setDrillCommunityId(null);
    setSelected(null);
  };

  const toggleDocFilter = (docId: string, checked: boolean) => {
    setSelectedDocIds((current) => {
      const next = new Set(current);
      if (checked) next.add(docId);
      else next.delete(docId);
      return next;
    });
  };

  const handleDocFilterResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    docFilterDragRef.current = { x: event.clientX, width: docFilterWidth };
    setDocFilterResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDocFilterResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = docFilterDragRef.current;
    if (!start) return;
    setDocFilterWidth(Math.round(Math.min(420, Math.max(180, start.width + (event.clientX - start.x)))));
  };

  const handleDocFilterResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!docFilterDragRef.current) return;
    docFilterDragRef.current = null;
    setDocFilterResizing(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const status = payload?.status ?? null;
  const drillCommunity = drillCommunityId && filteredPayload ? findCommunity(filteredPayload, drillCommunityId) : null;
  const selectedEntity = selected?.kind === 'entity' && filteredPayload
    ? findEntity(filteredPayload, selected.key) ?? (fallbackEntity?.canonicalKey === selected.key ? fallbackEntity : null)
    : null;
  const selectedCommunity = selected?.kind === 'community' && filteredPayload ? findCommunity(filteredPayload, selected.id) : null;
  const relatedEdges = selectedEntity && filteredPayload ? getEntityRelatedEdges(filteredPayload, selectedEntity.canonicalKey) : [];

  return (
    <section className="library-graph-view" aria-label={t("资料库图谱地图")}>
      <header className="library-graph-toolbar">
        <div className="library-graph-title">
          <MapIcon size={18} />
          <div>
            <strong>{t("资料库图谱")}</strong>
            <span>
              {status
                ? t("{0} 实体 · {1} 边 · {2} 层 · 摘要覆盖 {3}/{4}", { '0': status.entityCount, '1': status.relationCount, '2': status.levels, '3': status.summaryCoverage, '4': status.communityCount })
                : loading ? t("正在读取图谱投影…") : t("未建立图谱投影")}
              {payload?.truncated ? t(" · 画布仅显示头部实体") : ''}
            </span>
          </div>
        </div>
        <select
          className="library-graph-library-select"
          aria-label={t("选择资料库")}
          value={selectedPath ?? ''}
          onChange={(event) => setSelectedPath(event.target.value || null)}
        >
          {libraries.length === 0 ? <option value="">{t("暂无资料库")}</option> : null}
          {libraries.map((library) => <option key={library.path} value={library.path}>{library.alias || library.path}</option>)}
        </select>
        <div className="library-graph-mode-switch" role="tablist" aria-label={t("层级切换")}>
          <button type="button" className={mode === 'community' ? 'active' : ''} onClick={() => { setMode('community'); setDrillCommunityId(null); }}>{t("社区视图")}</button>
          <button type="button" className={mode === 'entity' ? 'active' : ''} onClick={() => setMode('entity')}>{t("实体视图")}</button>
        </div>
        {/* 抽拉面板隐藏后，顶部保留拉出入口；展开时由面板头部按钮收起。 */}
        {docFilterOpen ? null : (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<PanelLeftOpen size={12} />}
            title={t("拉出左侧文档筛选面板")}
            onClick={() => setDocFilterOpen(true)}
          >
            {t("文档筛选")}
          </Button>
        )}
        <div className="library-graph-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => void runSearch(event.target.value)}
            placeholder={t("搜索实体定位")}
            aria-label={t("搜索图谱实体")}
          />
          {query.trim() && searchResults.length > 0 ? (
            <div className="library-graph-search-results">
              {searchResults.map((entity) => (
                <button key={entity.canonicalKey} type="button" onClick={() => locateSearchResult(entity)}>
                  <strong>{entity.mention || entity.canonicalKey}</strong>
                  <small>{entity.type} · degree {entity.degree}</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" className="library-graph-tool" onClick={() => graphRef.current?.zoomToFit(400, 42)}>
          <LocateFixed size={14} />{t("适配视图")}
        </button>
        {drillCommunityId ? (
          <button type="button" className="library-graph-tool" onClick={returnOverview}>
            <ArrowLeft size={14} />{t("返回全图")}
          </button>
        ) : null}
      </header>

      <div className="library-graph-disclaimer">
        {t("社区摘要只用于把握全局脉络，不能作为原文引用；回答请以资料原文证据为准。")}
      </div>

      <div
        className={`library-graph-body ${selectedEntity || selectedCommunity ? '' : 'details-hidden'} ${docFilterOpen ? '' : 'docfilter-hidden'} ${docFilterResizing ? 'docfilter-resizing' : ''}`}
        style={{ '--graph-docfilter-width': `${docFilterWidth}px` } as React.CSSProperties}
      >
        <aside className="library-graph-doc-filter" aria-hidden={!docFilterOpen}>
          <div className="library-graph-doc-filter-inner">
            <div className="library-graph-doc-filter-head" title={t("不勾选即显示全部文档")}>
              <Text size="xs" fw={650}>{t("文档筛选")}</Text>
              <span className="library-graph-doc-filter-count">
                {selectedDocIds.size > 0 ? `${selectedDocIds.size}/${documents.length}` : t("全部 {0}", { '0': documents.length })}
              </span>
              {selectedDocIds.size > 0 ? (
                <Button size="compact-xs" variant="subtle" onClick={() => setSelectedDocIds(new Set())}>{t("清空")}</Button>
              ) : null}
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                title={t("收起文档筛选面板")}
                aria-label={t("收起文档筛选面板")}
                onClick={() => setDocFilterOpen(false)}
              >
                <PanelLeftClose size={12} />
              </ActionIcon>
            </div>
            <ScrollArea.Autosize mah="100%" type="scroll" scrollbarSize={6}>
              <Stack gap={4} className="library-graph-doc-filter-list">
                {documents.length === 0 ? (
                  <Text size="xs" c="dimmed">{loading ? t("正在读取文档…") : t("暂无文档")}</Text>
                ) : documents.map((doc) => (
                  <Checkbox
                    key={doc.id}
                    size="xs"
                    label={<span className="library-graph-doc-filter-name" title={doc.name}>{doc.name}</span>}
                    checked={selectedDocIds.has(doc.id)}
                    onChange={(event) => toggleDocFilter(doc.id, event.currentTarget.checked)}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </div>
          <div
            className="library-graph-doc-filter-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("拖动调整文档筛选面板宽度")}
            title={t("拖动调整宽度 · 双击恢复默认")}
            onPointerDown={handleDocFilterResizeStart}
            onPointerMove={handleDocFilterResizeMove}
            onPointerUp={handleDocFilterResizeEnd}
            onPointerCancel={handleDocFilterResizeEnd}
            onDoubleClick={() => setDocFilterWidth(236)}
          />
        </aside>
        <main className="library-graph-canvas-wrap">
          {error ? (
            <GraphEmpty icon={<Network size={28} />} title={t("无法读取图谱")} description={error} />
          ) : emptyState === 'no-library' ? (
            <GraphEmpty icon={<MapIcon size={28} />} title={t("还没有资料库")} description={t("先在资料空间创建并处理一个资料库。")} />
          ) : emptyState === 'no-projection' ? (
            <GraphEmpty icon={<Network size={28} />} title={t("还没有图谱投影")} description={t("到资料流水线开启图谱增强并等待图装配完成。")} />
          ) : emptyState === 'no-entities' ? (
            <GraphEmpty icon={<Network size={28} />} title={t("图谱为空")} description={t("资料库尚未提取出实体与社区。")} />
          ) : loading ? (
            <GraphEmpty icon={<Network size={28} />} title={t("正在读取…")} description={t("正在读取图谱投影，请稍候。")} />
          ) : elementsEmpty ? (
            <GraphEmpty
              icon={<Filter size={28} />}
              title={selectedDocIds.size > 0 ? t("筛选结果为空") : t("钻取范围为空")}
              description={selectedDocIds.size > 0
                ? t("当前文档筛选下没有可显示的实体与社区，请调整或清空左侧筛选。")
                : t("该社区在画布头部实体内没有成员，返回全图或换个社区。")}
            />
          ) : (
            <div ref={containerRef} className="library-graph-canvas">
              {canvasSize.width > 0 ? (
                <ForceGraph2D<GraphNode, GraphLink>
                  ref={graphRef}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  graphData={graphData}
                  backgroundColor={colors.background}
                  nodeId="id"
                  nodeCanvasObject={drawNode}
                  nodePointerAreaPaint={paintNodeArea}
                  nodeLabel={(node) => {
                    // 画布标签走简洁命名，悬浮提示补全社区 id / 层级 / 成员数等完整信息。
                    if (node.kind === 'community' && filteredPayload) {
                      const community = findCommunity(filteredPayload, node.ref);
                      if (community) return t("{0} · level {1} · {2} 成员", { '0': communityTitle(community), '1': community.level, '2': community.memberCount });
                    }
                    return `${node.label}（${node.kind === 'community' ? t("社区") : t("实体")}）`;
                  }}
                  linkColor={(link) => (link.kind === 'hierarchy' ? `${colors.edge}8C` : `${colors.edge}B3`)}
                  linkWidth={(link) => (link.kind === 'hierarchy' ? 0.8 : Math.min(2.4, link.width))}
                  linkLineDash={(link) => (link.kind === 'hierarchy' ? [4, 3] : null)}
                  linkCurvature={0.12}
                  linkDirectionalParticles={(link) => (link.kind === 'hierarchy' ? 1 : 2)}
                  linkDirectionalParticleWidth={1.4}
                  linkDirectionalParticleSpeed={(link) => (link.kind === 'hierarchy' ? 0.003 : 0.005)}
                  linkDirectionalParticleColor={(link) => (typeof link.target === 'object' ? link.target.color : colors.accent)}
                  linkLabel={(link) => link.label || link.kind}
                  linkCanvasObjectMode={() => 'after'}
                  linkCanvasObject={drawLinkLabel}
                  warmupTicks={60}
                  cooldownTicks={140}
                  onNodeClick={handleNodeClick}
                  onNodeDragEnd={handleNodeDragEnd}
                  onNodeRightClick={handleNodeRightClick}
                  onNodeHover={(node) => { if (containerRef.current) containerRef.current.style.cursor = node ? 'pointer' : 'grab'; }}
                  onBackgroundClick={() => setSelected(null)}
                  onEngineStop={() => {
                    if (engineDoneRef.current) return;
                    engineDoneRef.current = true;
                    setLayoutMs(performance.now() - engineStartRef.current);
                    // 换图后视口还停在旧坐标，新子图会在视野外（钻取黑屏）；布局收敛后自动适配一次。
                    if (!fittedForDataRef.current) {
                      fittedForDataRef.current = true;
                      graphRef.current?.zoomToFit(400, 42);
                    }
                  }}
                />
              ) : null}
            </div>
          )}
          {drillCommunity ? <div className="library-graph-drill-caption">{t("正在钻取：")}{communityTitle(drillCommunity)}</div> : null}
        </main>

        {selectedEntity ? (
          <aside className="library-graph-details" aria-label={t("实体详情")}>
            <button type="button" className="library-graph-details-close" aria-label={t("关闭详情")} onClick={() => setSelected(null)}>×</button>
            <span className="library-graph-badge entity">{selectedEntity.type || t("实体")}</span>
            <h3>{selectedEntity.mention || selectedEntity.canonicalKey}</h3>
            <p className="library-graph-description">{selectedEntity.description || t("暂无描述。")}</p>
            <div className="library-graph-meta">degree {selectedEntity.degree} {t("· 社区")} {selectedEntity.communityId || t("未归属")}</div>
            <h4>{t("相关边")}</h4>
            <div className="library-graph-related">
              {relatedEdges.length ? relatedEdges.map(({ edge, otherKey }) => (
                <button key={`${edge.sourceKey}->${edge.targetKey}`} type="button" onClick={() => setSelected({ kind: 'entity', key: otherKey })}>
                  <strong>{otherKey}</strong>
                  <span>{edge.kinds.join('/') || t("关联")} {t("· 权重")} {edge.weight}</span>
                </button>
              )) : <div className="library-graph-detail-empty">{t("画布内没有相关边。")}</div>}
            </div>
          </aside>
        ) : null}

        {selectedCommunity ? (
          <aside className="library-graph-details" aria-label={t("社区详情")}>
            <button type="button" className="library-graph-details-close" aria-label={t("关闭详情")} onClick={() => setSelected(null)}>×</button>
            <span className="library-graph-badge community">level {selectedCommunity.level} {t("社区")}</span>
            <h3>{communityTitle(selectedCommunity)}</h3>
            <p className="library-graph-description">{selectedCommunity.summary || t("该社区还没有生成摘要（可能未开启摘要生成或生成失败）。")}</p>
            <div className="library-graph-meta">{selectedCommunity.memberCount} {t("个成员 ·")} {selectedCommunity.tokens} tokens</div>
            <div className="library-graph-details-actions">
              <button type="button" onClick={() => { setDrillCommunityId(selectedCommunity.communityId); setMode('entity'); setSelected(null); }}>{t("查看成员实体")}</button>
              <button
                type="button"
                className="primary"
                disabled={!selectedPath}
                onClick={() => selectedPath && onAskAboutCommunity(selectedPath, `请基于资料库图谱全局脉络，概括「${selectedCommunity.memberKeys[0] ?? selectedCommunity.communityId}」所在社区的主题与上下文，并说明它与库内其他主题的可能关联。`)}
              >
                <MessageSquarePlus size={14} />{t("就这个社区提问")}
              </button>
            </div>
            <h4>{t("成员（前 20）")}</h4>
            <div className="library-graph-related">
              {selectedCommunity.memberKeys.slice(0, 20).map((key) => (
                <button key={key} type="button" onClick={() => { setDrillCommunityId(selectedCommunity.communityId); setMode('entity'); setSelected({ kind: 'entity', key }); }}>
                  <strong>{key}</strong>
                </button>
              ))}
            </div>
          </aside>
        ) : null}
      </div>

      <footer className="library-graph-footer">
        <span>{t("只读视图：单击详情 · 双击社区钻取 · 拖拽固定节点 · 右键节点解除固定。")}</span>
        <span>
          {elements ? t("{0} 节点 · {1} 边", { '0': elements.nodes.length, '1': elements.edges.length }) : '—'}
          {selectedDocIds.size > 0 ? t(" · 文档筛选 {0}/{1}", { '0': selectedDocIds.size, '1': documents.length }) : ''}
          {layoutMs !== null ? t(" · 布局 {0}ms", { '0': layoutMs.toFixed(0) }) : ''}
          {status?.importedAt ? t(" · 投影 {0}", { '0': formatDate(status.importedAt) }) : ''}
        </span>
      </footer>
    </section>
  );
}

function GraphEmpty({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  useI18n();
  return (
    <div className="library-graph-empty">
      {icon}
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getAppLanguage());
}
