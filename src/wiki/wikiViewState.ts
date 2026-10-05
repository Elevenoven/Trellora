import type {
  WikiEvent,
  WikiGenerationJob,
  WikiMapNode,
  WikiNodeAiState,
  WikiWorkspaceSnapshot,
} from './wikiTypes';

export function createEmptyNodeAiState(nodeId: string): WikiNodeAiState {
  return {
    nodeId,
    operationId: null,
    status: 'idle',
    messages: [],
    draft: null,
  };
}

export function collectVisibleWikiNodes(nodes: WikiMapNode[]): WikiMapNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => {
      let parentId = node.parentId;
      while (parentId) {
        const parent = nodeById.get(parentId);
        if (!parent || parent.collapsed) return false;
        parentId = parent.parentId;
      }
      return true;
    })
    .sort(compareWikiNodes);
}

export function collectWikiDescendantIds(nodes: WikiMapNode[], nodeId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  nodes.forEach((node) => {
    if (!node.parentId) return;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  });

  const result: string[] = [];
  const pending = [...(childrenByParent.get(nodeId) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    result.push(current);
    pending.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}

export function collectWikiSelectionBranchIds(nodes: WikiMapNode[], nodeId: string): string[] {
  return [
    ...getWikiNodePath(nodes, nodeId).map((node) => node.id),
    ...collectWikiDescendantIds(nodes, nodeId),
  ];
}

export function getWikiNodePath(nodes: WikiMapNode[], nodeId: string): WikiMapNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const path: WikiMapNode[] = [];
  let current = nodeById.get(nodeId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? nodeById.get(current.parentId) : undefined;
  }
  return path;
}

export function getOrderedWikiSiblingIds(nodes: WikiMapNode[], parentId: string): string[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort(compareWikiNodes)
    .map((node) => node.id);
}

export function reorderWikiSiblings(
  nodes: WikiMapNode[],
  parentId: string,
  orderedNodeIds: string[],
): WikiMapNode[] {
  const currentSiblingIds = getOrderedWikiSiblingIds(nodes, parentId);
  const requestedIds = new Set(orderedNodeIds);
  const sameSiblingSet = currentSiblingIds.length === orderedNodeIds.length
    && requestedIds.size === orderedNodeIds.length
    && currentSiblingIds.every((nodeId) => requestedIds.has(nodeId));
  if (!sameSiblingSet) {
    throw new Error('章节结构已变化，无法应用当前排序，请重新加载后再试。');
  }

  const orderByNodeId = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index + 1]));
  return nodes.map((node) => {
    const order = orderByNodeId.get(node.id);
    return order === undefined ? node : { ...node, order };
  });
}

export interface WikiSiblingOrderChange {
  parentId: string;
  previousOrderedNodeIds: string[];
  orderedNodeIds: string[];
}

export function collectWikiSiblingOrderChanges(
  previousNodes: WikiMapNode[],
  currentNodes: WikiMapNode[],
): WikiSiblingOrderChange[] {
  const parentIds = new Set<string>();
  previousNodes.forEach((node) => { if (node.parentId) parentIds.add(node.parentId); });
  currentNodes.forEach((node) => { if (node.parentId) parentIds.add(node.parentId); });
  const changes: WikiSiblingOrderChange[] = [];
  parentIds.forEach((parentId) => {
    const previousOrderedNodeIds = getOrderedWikiSiblingIds(previousNodes, parentId);
    const orderedNodeIds = getOrderedWikiSiblingIds(currentNodes, parentId);
    const sameOrder = previousOrderedNodeIds.length === orderedNodeIds.length
      && previousOrderedNodeIds.every((nodeId, index) => orderedNodeIds[index] === nodeId);
    if (!sameOrder) changes.push({ parentId, previousOrderedNodeIds, orderedNodeIds });
  });
  return changes;
}

export function reduceWikiEvent(snapshot: WikiWorkspaceSnapshot, event: WikiEvent): WikiWorkspaceSnapshot {
  if (event.type === 'operation-started') {
    if (event.kind === 'full-generation' || event.kind === 'chapter-retry') {
      return event.job ? { ...snapshot, generationJob: cloneJob(event.job) } : snapshot;
    }
    if (!event.nodeId) return snapshot;
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    return {
      ...snapshot,
      nodeAi: {
        ...snapshot.nodeAi,
        [event.nodeId]: { ...current, operationId: event.operationId, status: 'running', lastError: undefined, retrieval: undefined },
      },
    };
  }

  if (event.type === 'task-updated') {
    const currentJob = snapshot.generationJob;
    if (!currentJob) return snapshot;
    const tasks = currentJob.tasks.map((task) => task.id === event.task.id ? { ...event.task } : task);
    return {
      ...snapshot,
      generationJob: {
        ...currentJob,
        tasks,
        progress: calculateTaskProgress(tasks),
        stage: event.task.stage,
        etaSeconds: calculateEtaSeconds(tasks),
      },
    };
  }

  if (event.type === 'nodes-upserted') {
    const nextNodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    event.nodes.forEach((node) => nextNodes.set(node.id, { ...nextNodes.get(node.id), ...node }));
    return { ...snapshot, nodes: [...nextNodes.values()].sort(compareWikiNodes) };
  }

  if (event.type === 'message-added') {
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    const existingIndex = current.messages.findIndex((message) => message.id === event.message.id);
    const messages = existingIndex >= 0
      ? current.messages.map((message, index) => index === existingIndex ? event.message : message)
      : [...current.messages, event.message];
    return {
      ...snapshot,
      nodeAi: { ...snapshot.nodeAi, [event.nodeId]: { ...current, messages } },
    };
  }

  if (event.type === 'retrieval-updated') {
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    return {
      ...snapshot,
      nodeAi: { ...snapshot.nodeAi, [event.nodeId]: { ...current, retrieval: event.retrieval } },
    };
  }

  if (event.type === 'draft-ready') {
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    return {
      ...snapshot,
      nodeAi: { ...snapshot.nodeAi, [event.nodeId]: { ...current, draft: event.draft } },
    };
  }

  if (event.type === 'questions-loading') {
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    return {
      ...snapshot,
      nodeAi: { ...snapshot.nodeAi, [event.nodeId]: { ...current, questionsStatus: 'loading' } },
    };
  }

  if (event.type === 'questions-ready') {
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    const ready = !event.degraded && event.questions.length > 0;
    return {
      ...snapshot,
      nodeAi: {
        ...snapshot.nodeAi,
        [event.nodeId]: {
          ...current,
          suggestedQuestions: event.questions,
          questionsStatus: ready ? 'ready' : 'degraded',
        },
      },
    };
  }

  if (event.type === 'operation-finished') {
    if (event.kind === 'full-generation' || event.kind === 'chapter-retry') {
      if (!snapshot.generationJob) return snapshot;
      return {
        ...snapshot,
        generationJob: {
          ...snapshot.generationJob,
          status: event.outcome,
          progress: event.outcome === 'complete' ? 100 : snapshot.generationJob.progress,
          etaSeconds: null,
          stage: event.outcome === 'failed' && event.error ? event.error : getOutcomeLabel(event.outcome),
        },
      };
    }
    if (!event.nodeId) return snapshot;
    const current = snapshot.nodeAi[event.nodeId] ?? createEmptyNodeAiState(event.nodeId);
    return {
      ...snapshot,
      nodeAi: {
        ...snapshot.nodeAi,
        [event.nodeId]: {
          ...current,
          operationId: null,
          status: event.outcome === 'complete' ? 'complete' : event.outcome === 'cancelled' ? 'cancelled' : 'failed',
          lastError: event.outcome === 'failed' && event.error ? event.error : undefined,
        },
      },
    };
  }

  return snapshot;
}

export function updateWikiNode(snapshot: WikiWorkspaceSnapshot, nodeId: string, patch: Partial<WikiMapNode>): WikiWorkspaceSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
  };
}

export function replaceWikiNodeAiState(snapshot: WikiWorkspaceSnapshot, state: WikiNodeAiState): WikiWorkspaceSnapshot {
  return { ...snapshot, nodeAi: { ...snapshot.nodeAi, [state.nodeId]: state } };
}

function compareWikiNodes(left: WikiMapNode, right: WikiMapNode): number {
  if (left.depth !== right.depth) return left.depth - right.depth;
  if (left.order !== right.order) return left.order - right.order;
  return left.title.localeCompare(right.title, 'zh-CN');
}

function calculateTaskProgress(tasks: WikiGenerationJob['tasks']): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length);
}

function calculateEtaSeconds(tasks: WikiGenerationJob['tasks']): number | null {
  const pendingProgress = tasks.reduce((sum, task) => sum + (100 - task.progress), 0);
  return pendingProgress > 0 ? Math.max(8, Math.ceil(pendingProgress / 8)) : null;
}

function cloneJob(job: WikiGenerationJob): WikiGenerationJob {
  return { ...job, tasks: job.tasks.map((task) => ({ ...task })) };
}

function getOutcomeLabel(outcome: WikiGenerationJob['status']): string {
  if (outcome === 'complete') return 'Wiki 已生成';
  if (outcome === 'partial') return '部分章节需要重试';
  if (outcome === 'cancelled') return '生成已停止';
  if (outcome === 'failed') return '生成失败';
  return '生成中';
}
