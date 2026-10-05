import type { AssistantAttachment, WikiAiMemory } from '../electron';
import type {
  WikiAiMessage,
  WikiActionKind,
  WikiBuildMode,
  WikiChapterTask,
  WikiDataSource,
  WikiDocumentSummary,
  WikiEvent,
  WikiGenerationJob,
  WikiMapNode,
  WikiNodeAiRequestOptions,
  WikiNodeCitation,
  WikiNodeDraft,
  WikiNodeQuestionsView,
  WikiOperationOutcome,
  WikiSiblingOrderCommit,
  WikiWorkspaceSnapshot,
} from './wikiTypes';
import { collectWikiDescendantIds, getWikiNodePath, reorderWikiSiblings } from './wikiViewState';

type WikiMockScenario = 'complete' | 'partial' | 'stale' | 'ai-unavailable';

export function createMockWikiDataSource(): WikiDataSource {
  const scenario = normalizeScenario(import.meta.env.VITE_WIKI_MOCK_SCENARIO);
  return new MockWikiDataSource(scenario);
}

class MockWikiDataSource implements WikiDataSource {
  private readonly workspaces = new Map<string, WikiWorkspaceSnapshot>();
  private readonly memoriesByDocument = new Map<string, WikiAiMemory[]>();
  private readonly activeMemoryIdByNode = new Map<string, string>();
  private readonly cancelledOperations = new Set<string>();
  private readonly scenario: WikiMockScenario;
  private operationCounter = 0;
  private derivedNodeCounter = 0;
  private orderRevisionCounter = 0;
  private memoryCounter = 0;

  constructor(scenario: WikiMockScenario) {
    this.scenario = scenario;
    createMockWorkspaces(scenario).forEach((workspace) => this.workspaces.set(workspace.document.id, workspace));
  }

  attachWorkspace(workspace: WikiWorkspaceSnapshot): void {
    this.workspaces.set(workspace.document.id, cloneWorkspace(workspace));
  }

  async listDocuments(): Promise<WikiDocumentSummary[]> {
    await pause(80);
    return [...this.workspaces.values()].map((workspace) => ({ ...workspace.document }));
  }

  async loadWorkspace(documentId: string): Promise<WikiWorkspaceSnapshot> {
    await pause(100);
    return cloneWorkspace(this.requireWorkspace(documentId));
  }

  async setMode(documentId: string, mode: WikiBuildMode): Promise<void> {
    this.requireWorkspace(documentId).mode = mode;
  }

  async *startFullGeneration(documentId: string): AsyncIterable<WikiEvent> {
    const workspace = this.requireWorkspace(documentId);
    const operationId = this.nextOperationId('full');
    const chapters = workspace.nodes
      .filter((node) => node.parentId === workspace.nodes.find((candidate) => candidate.parentId === null)?.id)
      .slice(0, 5);
    const tasks = chapters.map((chapter, index): WikiChapterTask => ({
      id: `chapter-task:${chapter.id}`,
      chapterNodeId: chapter.id,
      title: chapter.title,
      status: 'queued',
      progress: 0,
      stage: `等待章节任务 ${index + 1}`,
    }));
    const job: WikiGenerationJob = {
      id: `wiki-job:${documentId}`,
      operationId,
      status: 'running',
      stage: '正在拆分章节任务',
      progress: 0,
      etaSeconds: 62,
      tasks,
    };
    workspace.generationJob = cloneJob(job);
    let seq = 0;
    yield createEvent(operationId, ++seq, { type: 'operation-started', kind: 'full-generation', job: cloneJob(job) });

    for (const task of tasks) {
      task.status = 'running';
      task.progress = 8;
      task.stage = '正在读取章节上下文';
      yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
    }

    const progressSteps = [28, 56, 82, 100];
    for (const progress of progressSteps) {
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        await pause(95);
        const task = tasks[taskIndex];
        if (!task) continue;
        if (this.cancelledOperations.has(operationId)) {
          yield* this.finishCancelledGeneration(workspace, operationId, seq, tasks);
          return;
        }

        const shouldFail = this.scenario === 'partial' && taskIndex === 2 && progress === 82;
        if (shouldFail) {
          task.status = 'failed';
          task.progress = 68;
          task.stage = '章节分析失败';
          task.error = '演示场景：章节上下文超过当前 Mock 预算。';
          const failedChapter = setNodeStatus(workspace, task.chapterNodeId, 'failed');
          yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
          if (failedChapter) yield createEvent(operationId, ++seq, { type: 'nodes-upserted', nodes: [failedChapter] });
          continue;
        }
        if (task.status === 'failed') continue;

        task.progress = progress;
        task.status = progress === 100 ? 'complete' : 'running';
        task.stage = progress < 56 ? '正在提炼章节结构' : progress < 100 ? '正在合并节点草稿' : '章节已完成';
        const chapter = setNodeStatus(workspace, task.chapterNodeId, progress === 100 ? 'complete' : 'running');
        yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
        if (chapter) yield createEvent(operationId, ++seq, { type: 'nodes-upserted', nodes: [chapter] });

        if (progress === 100) {
          const derivedNode = this.createGeneratedChild(workspace, task.chapterNodeId, taskIndex);
          yield createEvent(operationId, ++seq, { type: 'nodes-upserted', nodes: [derivedNode] });
        }
      }
    }

    const outcome: WikiOperationOutcome = tasks.some((task) => task.status === 'failed') ? 'partial' : 'complete';
    workspace.generationJob = {
      ...job,
      status: outcome,
      stage: outcome === 'complete' ? 'Wiki 已生成' : '部分章节需要重试',
      progress: Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length),
      etaSeconds: null,
      tasks: tasks.map((task) => ({ ...task })),
    };
    yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'full-generation', outcome });
  }

  async *retryChapter(documentId: string, taskId: string): AsyncIterable<WikiEvent> {
    const workspace = this.requireWorkspace(documentId);
    const currentJob = workspace.generationJob;
    const currentTask = currentJob?.tasks.find((task) => task.id === taskId);
    if (!currentJob || !currentTask) return;

    const operationId = this.nextOperationId('retry');
    const nextJob = cloneJob({ ...currentJob, operationId, status: 'running', stage: '正在重试失败章节' });
    const task = nextJob.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    let seq = 0;
    yield createEvent(operationId, ++seq, { type: 'operation-started', kind: 'chapter-retry', job: nextJob });

    for (const progress of [16, 48, 78, 100]) {
      await pause(140);
      if (this.cancelledOperations.has(operationId)) {
        task.status = 'cancelled';
        task.stage = '重试已停止';
        yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
        yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'chapter-retry', outcome: 'cancelled' });
        return;
      }
      task.progress = progress;
      task.status = progress === 100 ? 'complete' : 'running';
      task.stage = progress === 100 ? '章节已完成' : '正在重新分析章节';
      task.error = undefined;
      yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
    }

    const chapter = setNodeStatus(workspace, task.chapterNodeId, 'complete');
    const derivedNode = this.createGeneratedChild(workspace, task.chapterNodeId, currentJob.tasks.indexOf(currentTask));
    if (chapter) yield createEvent(operationId, ++seq, { type: 'nodes-upserted', nodes: [chapter, derivedNode] });
    workspace.generationJob = {
      ...nextJob,
      status: 'complete',
      stage: 'Wiki 已生成',
      progress: 100,
      etaSeconds: null,
      tasks: nextJob.tasks.map((item) => item.id === task.id ? { ...task } : item),
    };
    yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'chapter-retry', outcome: 'complete' });
  }

  async *analyzeNode(documentId: string, nodeId: string, prompt: string, _actionKind?: WikiActionKind, attachments: AssistantAttachment[] = [], _options: WikiNodeAiRequestOptions = {}): AsyncIterable<WikiEvent> {
    const workspace = this.requireWorkspace(documentId);
    const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const operationId = this.nextOperationId('node');
    let seq = 0;
    yield createEvent(operationId, ++seq, { type: 'operation-started', kind: 'node-analysis', nodeId });

    const userMessage: WikiAiMessage = {
      id: `${operationId}:user`,
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments: [...attachments] } : {}),
    };
    yield createEvent(operationId, ++seq, { type: 'message-added', nodeId, message: userMessage });

    if (this.scenario === 'ai-unavailable') {
      await pause(220);
      yield createEvent(operationId, ++seq, {
        type: 'operation-finished',
        kind: 'node-analysis',
        nodeId,
        outcome: 'failed',
        error: '演示场景：尚未配置可用模型。',
      });
      return;
    }

    const answerParts = [
      `### ${node.title}分析\n\n`,
      `本节的核心目标是把 **${node.title}** 转换为可执行的运维检查项，并保留对原文标题的引用关系。\n\n`,
      '- 先确认输入信号和影响范围\n- 再按优先级检查关键指标\n- 最后记录处理结论与回退条件',
    ];
    let answer = '';
    for (const part of answerParts) {
      await pause(220);
      if (this.cancelledOperations.has(operationId)) {
        yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'node-analysis', nodeId, outcome: 'cancelled' });
        return;
      }
      answer += part;
      const streaming = answer.length < answerParts.join('').length;
      yield createEvent(operationId, ++seq, {
        type: 'message-added',
        nodeId,
        message: {
          id: `${operationId}:assistant`,
          role: 'assistant',
          content: answer,
          createdAt: new Date().toISOString(),
          streaming,
          ...(streaming ? {} : { citations: createMockCitations(workspace, node) }),
        },
      });
    }

    const draft: WikiNodeDraft = {
      id: `${operationId}:draft`,
      nodeId,
      title: `${node.title}检查清单`,
      markdown: answer,
      proposedChildren: ['确认现象与影响范围', '核对关键指标', '记录结论与回退条件'],
      status: 'pending',
    };
    this.saveMockAiMemory(documentId, node, prompt, answer);
    yield createEvent(operationId, ++seq, { type: 'draft-ready', nodeId, draft });
    yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'node-analysis', nodeId, outcome: 'complete' });
  }

  async cancelOperation(operationId: string): Promise<void> {
    this.cancelledOperations.add(operationId);
  }

  async addDerivedNode(documentId: string, parentId: string, title: string): Promise<WikiMapNode> {
    const workspace = this.requireWorkspace(documentId);
    const parent = workspace.nodes.find((node) => node.id === parentId);
    if (!parent) throw new Error('找不到父节点');
    const node = createNode({
      documentId,
      id: `derived:${++this.derivedNodeCounter}`,
      parentId,
      title,
      depth: parent.depth + 1,
      order: workspace.nodes.filter((candidate) => candidate.parentId === parentId).length + 1,
      kind: 'derived',
      status: 'complete',
      markdown: `## ${title}\n\n这是当前前端会话中的派生节点，不会回写原文。`,
      sourceName: workspace.document.sourceName,
    });
    workspace.nodes.push(node);
    workspace.document.nodeCount = workspace.nodes.length;
    return { ...node };
  }

  async renameDerivedNode(documentId: string, nodeId: string, title: string): Promise<WikiMapNode> {
    const node = this.requireWorkspace(documentId).nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'derived') throw new Error('来源节点不能重命名');
    node.title = title;
    return { ...node };
  }

  async deleteDerivedNode(documentId: string, nodeId: string): Promise<string[]> {
    const workspace = this.requireWorkspace(documentId);
    const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'derived') throw new Error('来源节点不能删除');
    const deletedIds = [nodeId, ...collectWikiDescendantIds(workspace.nodes, nodeId)];
    workspace.nodes = workspace.nodes.filter((candidate) => !deletedIds.includes(candidate.id));
    workspace.document.nodeCount = workspace.nodes.length;
    return deletedIds;
  }

  async listAiMemories(documentId: string): Promise<WikiAiMemory[]> {
    return [...(this.memoriesByDocument.get(documentId) ?? [])]
      .sort(compareAiMemories);
  }

  async createAiMemory(documentId: string, nodeId: string): Promise<WikiAiMemory> {
    const node = this.requireWorkspace(documentId).nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error('找不到要新建对话的 Wiki 章节');
    const now = new Date().toISOString();
    const memory: WikiAiMemory = {
      id: `mock-memory:${++this.memoryCounter}`,
      nodeId,
      title: `${node.title} · 新对话`,
      pinned: false,
      conversation: [],
      createdAt: now,
      updatedAt: now,
    };
    const memories = this.memoriesByDocument.get(documentId) ?? [];
    this.memoriesByDocument.set(documentId, [...memories, memory]);
    this.activeMemoryIdByNode.set(memoryKey(documentId, nodeId), memory.id);
    return { ...memory, conversation: [] };
  }

  async renameAiMemory(documentId: string, memoryId: string, title: string): Promise<WikiAiMemory> {
    const memories = this.memoriesByDocument.get(documentId) ?? [];
    const target = memories.find((memory) => memory.id === memoryId);
    const normalizedTitle = title.trim();
    if (!target || !normalizedTitle) throw new Error('找不到要重命名的 Wiki AI 记忆');
    target.title = normalizedTitle;
    target.updatedAt = new Date().toISOString();
    return { ...target, conversation: [...target.conversation] };
  }

  async setAiMemoryPinned(documentId: string, memoryId: string, pinned: boolean): Promise<WikiAiMemory> {
    const memories = this.memoriesByDocument.get(documentId) ?? [];
    const target = memories.find((memory) => memory.id === memoryId);
    if (!target) throw new Error('找不到要置顶的 Wiki AI 记忆');
    target.pinned = pinned;
    target.updatedAt = new Date().toISOString();
    return { ...target, conversation: [...target.conversation] };
  }

  async deleteAiMemory(documentId: string, memoryId: string): Promise<void> {
    const memories = this.memoriesByDocument.get(documentId) ?? [];
    const target = memories.find((memory) => memory.id === memoryId);
    if (!target) throw new Error('找不到要删除的 Wiki AI 记忆');
    const remaining = memories.filter((memory) => memory.id !== memoryId);
    this.memoriesByDocument.set(documentId, remaining);
    const key = memoryKey(documentId, target.nodeId);
    if (this.activeMemoryIdByNode.get(key) === memoryId) {
      const next = [...remaining]
        .filter((memory) => memory.nodeId === target.nodeId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (next) this.activeMemoryIdByNode.set(key, next.id);
      else this.activeMemoryIdByNode.delete(key);
    }
  }

  async getNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView> {
    return this.mockNodeQuestions(documentId, nodeId);
  }

  async refreshNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView> {
    return this.mockNodeQuestions(documentId, nodeId);
  }

  private async mockNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView> {
    await pause(120);
    const workspace = this.requireWorkspace(documentId);
    const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return { questions: [], degraded: true };
    return {
      questions: [
        `${node.title}的核心要点是什么？`,
        `${node.title}有哪些关键步骤或结论？`,
        `${node.title}与其他章节有什么关联？`,
      ],
      degraded: false,
    };
  }

  private saveMockAiMemory(documentId: string, node: WikiMapNode, prompt: string, answer: string): void {
    const memories = this.memoriesByDocument.get(documentId) ?? [];
    const key = memoryKey(documentId, node.id);
    const activeMemoryId = this.activeMemoryIdByNode.get(key);
    const previous = memories.find((memory) => memory.id === activeMemoryId)
      ?? [...memories].filter((memory) => memory.nodeId === node.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const conversation = [...(previous?.conversation ?? []), { role: 'user' as const, content: prompt }, { role: 'assistant' as const, content: answer }].slice(-6);
    const now = new Date().toISOString();
    const memory: WikiAiMemory = previous
      ? { ...previous, conversation, updatedAt: now }
      : {
        id: `mock-memory:${++this.memoryCounter}`,
        nodeId: node.id,
        title: node.title,
        pinned: false,
        conversation,
        createdAt: now,
        updatedAt: now,
      };
    this.memoriesByDocument.set(documentId, previous
      ? memories.map((candidate) => candidate.id === memory.id ? memory : candidate)
      : [...memories, memory]);
    this.activeMemoryIdByNode.set(key, memory.id);
  }

  async reorderSiblingNodes(
    documentId: string,
    parentId: string,
    orderedNodeIds: string[],
    expectedRevision: string,
  ): Promise<WikiSiblingOrderCommit> {
    await pause(80);
    const workspace = this.requireWorkspace(documentId);
    if (workspace.siblingOrderRevisions[parentId] !== expectedRevision) {
      throw new Error('Mock 章节顺序已变化，请重新加载后再试。');
    }
    workspace.nodes = reorderWikiSiblings(workspace.nodes, parentId, orderedNodeIds);
    const revision = `mock-order-${++this.orderRevisionCounter}`;
    workspace.siblingOrderRevisions[parentId] = revision;
    return { parentId, orderedNodeIds: [...orderedNodeIds], revision, persistence: 'session' };
  }

  private requireWorkspace(documentId: string): WikiWorkspaceSnapshot {
    const workspace = this.workspaces.get(documentId);
    if (!workspace) throw new Error(`未知 Wiki 文档：${documentId}`);
    return workspace;
  }

  private nextOperationId(prefix: string): string {
    return `mock-${prefix}-${++this.operationCounter}`;
  }

  private createGeneratedChild(workspace: WikiWorkspaceSnapshot, parentId: string, index: number): WikiMapNode {
    const existing = workspace.nodes.find((node) => node.id === `generated:${parentId}`);
    if (existing) return { ...existing, status: 'complete' };
    const parent = workspace.nodes.find((node) => node.id === parentId);
    const titles = ['关键检查路径', '告警处置要点', '风险隔离建议', '配置核查清单', '验收与回退条件'];
    const node = createNode({
      documentId: workspace.document.id,
      id: `generated:${parentId}`,
      parentId,
      title: titles[index] ?? 'AI 分析要点',
      depth: (parent?.depth ?? 0) + 1,
      order: 99,
      kind: 'derived',
      status: 'complete',
      markdown: `## ${titles[index] ?? 'AI 分析要点'}\n\n由整篇生成 Mock 任务产生，应用后仍不会修改源文档。`,
      sourceName: workspace.document.sourceName,
    });
    workspace.nodes.push(node);
    return node;
  }

  private async *finishCancelledGeneration(
    workspace: WikiWorkspaceSnapshot,
    operationId: string,
    currentSeq: number,
    tasks: WikiChapterTask[],
  ): AsyncIterable<WikiEvent> {
    let seq = currentSeq;
    for (const task of tasks) {
      if (task.status === 'complete' || task.status === 'failed') continue;
      task.status = 'cancelled';
      task.stage = '任务已停止';
      yield createEvent(operationId, ++seq, { type: 'task-updated', task: { ...task } });
    }
    workspace.generationJob = workspace.generationJob ? { ...workspace.generationJob, status: 'cancelled', tasks } : null;
    yield createEvent(operationId, ++seq, { type: 'operation-finished', kind: 'full-generation', outcome: 'cancelled' });
  }
}

function compareAiMemories(left: WikiAiMemory, right: WikiAiMemory): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

function memoryKey(documentId: string, nodeId: string): string {
  return `${documentId}:${nodeId}`;
}

/** Mock 回答引用（方案 §11：事件序列对齐 Electron 映射，供浏览器开发态预览折叠 UI）。 */
function createMockCitations(workspace: WikiWorkspaceSnapshot, node: WikiMapNode): WikiNodeCitation[] {
  const nodePath = getWikiNodePath(workspace.nodes, node.id).map((item) => item.title);
  return [
    { reference: 0, nodePath, ordinal: 0, preview: `${node.title} 节点直载全文（Mock 预览）。` },
    { reference: 1, nodePath, ordinal: 3, preview: `来自 ${node.title} 子章节的父块证据（Mock 预览）。` },
  ];
}

function createMockWorkspaces(scenario: WikiMockScenario): WikiWorkspaceSnapshot[] {
  const primaryDocument: WikiDocumentSummary = {
    id: 'core-network-ops',
    title: '5G 核心网运维手册',
    sourceName: '5G核心网运维手册.md',
    description: '核心网日常运维、故障处理与变更检查规范',
    updatedAt: '2026-08-28T09:30:00.000Z',
    nodeCount: 18,
  };
  const nodes = createPrimaryNodes(primaryDocument, scenario);
  primaryDocument.nodeCount = nodes.length;

  const secondaryDocument: WikiDocumentSummary = {
    id: 'edge-integration',
    title: '边缘节点接入指南',
    sourceName: '边缘节点接入指南.md',
    description: '边缘节点部署、接入验证与回退流程',
    updatedAt: '2026-08-25T14:10:00.000Z',
    nodeCount: 7,
  };
  const secondaryNodes = [
    createSourceNode(secondaryDocument, 'edge-root', null, '边缘节点接入指南', 0, 0),
    createSourceNode(secondaryDocument, 'edge-preflight', 'edge-root', '1 接入前检查', 1, 1),
    createSourceNode(secondaryDocument, 'edge-network', 'edge-root', '2 网络与证书配置', 1, 2),
    createSourceNode(secondaryDocument, 'edge-deploy', 'edge-root', '3 节点部署', 1, 3),
    createSourceNode(secondaryDocument, 'edge-verify', 'edge-root', '4 接入验证', 1, 4),
    createSourceNode(secondaryDocument, 'edge-rollback', 'edge-root', '5 回退方案', 1, 5),
    createSourceNode(secondaryDocument, 'edge-audit', 'edge-verify', '验证记录与审计', 2, 1),
  ];
  secondaryDocument.nodeCount = secondaryNodes.length;

  return [
    {
      document: primaryDocument,
      mode: null,
      nodes,
      orderPersistence: 'session',
      siblingOrderRevisions: createMockOrderRevisions(nodes),
      generationJob: null,
      nodeAi: {},
    },
    {
      document: secondaryDocument,
      mode: null,
      nodes: secondaryNodes,
      orderPersistence: 'session',
      siblingOrderRevisions: createMockOrderRevisions(secondaryNodes),
      generationJob: null,
      nodeAi: {},
    },
  ];
}

function createMockOrderRevisions(nodes: WikiMapNode[]): Record<string, string> {
  const parentIds = new Set(nodes.flatMap((node) => node.parentId ? [node.parentId] : []));
  return Object.fromEntries([...parentIds].map((parentId) => [parentId, `mock-order:${parentId}:0`]));
}

function createPrimaryNodes(document: WikiDocumentSummary, scenario: WikiMockScenario): WikiMapNode[] {
  const nodes = [
    createSourceNode(document, 'core-root', null, document.title, 0, 0),
    createSourceNode(document, 'topology', 'core-root', '1 网络拓扑', 1, 1),
    createSourceNode(document, 'alarms', 'core-root', '2 常见告警', 1, 2),
    createSourceNode(document, 'signaling', 'core-root', '3 信令风暴处置', 1, 3),
    createSourceNode(document, 'load-balance', 'core-root', '4 负载均衡配置', 1, 4),
    createSourceNode(document, 'health-check', 'core-root', '5 健康检查规范', 1, 5),
    createSourceNode(document, 'history-report', 'core-root', '6 历史告警统计', 1, 6),
    createSourceNode(document, 'interface-doc', 'core-root', '7 接口文档', 1, 7),
    createSourceNode(document, 'topology-logical', 'topology', '1.1 逻辑拓扑', 2, 1),
    createSourceNode(document, 'topology-physical', 'topology', '1.2 物理链路', 2, 2),
    createSourceNode(document, 'alarm-categories', 'alarms', '2.1 告警分类', 2, 1),
    createSourceNode(document, 'alarm-high-frequency', 'alarms', '2.2 高频告警处理', 2, 2),
    createSourceNode(document, 'alarm-suppression', 'alarms', '2.3 告警屏蔽规则', 2, 3),
    createSourceNode(document, 'signaling-detect', 'signaling', '3.1 风暴识别', 2, 1),
    createSourceNode(document, 'signaling-isolate', 'signaling', '3.2 隔离与恢复', 2, 2),
    createSourceNode(document, 'load-strategy', 'load-balance', '4.1 分流策略', 2, 1),
    createSourceNode(document, 'health-daily', 'health-check', '5.1 日常巡检', 2, 1),
    createSourceNode(document, 'health-change', 'health-check', '5.2 变更后验证', 2, 2),
  ];
  if (scenario === 'stale') nodes.find((node) => node.id === 'health-check')!.status = 'stale';
  return nodes;
}

function createSourceNode(
  document: WikiDocumentSummary,
  id: string,
  parentId: string | null,
  title: string,
  depth: number,
  order: number,
): WikiMapNode {
  return createNode({
    documentId: document.id,
    id,
    parentId,
    title,
    depth,
    order,
    kind: 'source',
    status: 'idle',
    markdown: createSourceMarkdown(title),
    sourceName: document.sourceName,
  });
}

function createNode(input: {
  documentId: string;
  id: string;
  parentId: string | null;
  title: string;
  depth: number;
  order: number;
  kind: WikiMapNode['kind'];
  status: WikiMapNode['status'];
  markdown: string;
  sourceName: string;
}): WikiMapNode {
  return {
    id: input.id,
    documentId: input.documentId,
    parentId: input.parentId,
    title: input.title,
    depth: input.depth,
    order: input.order,
    kind: input.kind,
    status: input.status,
    markdown: input.markdown,
    sourceRef: {
      sourceName: input.sourceName,
      headingId: input.id,
      updatedAt: '2026-08-28T09:30:00.000Z',
    },
  };
}

function createSourceMarkdown(title: string): string {
  return `# ${title}\n\n> 本页内容来自前端 Mock 快照，用于验证 Wiki 阅读与分析工作流。\n\n## 目标\n\n说明 **${title}** 的适用范围、检查入口与处理边界。\n\n## 操作要点\n\n1. 确认当前环境、版本和影响范围。\n2. 按章节检查关键指标与依赖状态。\n3. 记录操作结果，异常时按回退条件处理。\n\n## 注意事项\n\n- 所有变更先在维护窗口内确认。\n- AI 生成内容默认作为草稿，不修改本段原文。`;
}

function setNodeStatus(workspace: WikiWorkspaceSnapshot, nodeId: string, status: WikiMapNode['status']): WikiMapNode | null {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  node.status = status;
  return { ...node };
}

function createEvent<T extends Omit<WikiEvent, 'operationId' | 'seq' | 'timestamp'>>(
  operationId: string,
  seq: number,
  event: T,
): WikiEvent {
  return { ...event, operationId, seq, timestamp: new Date().toISOString() } as unknown as WikiEvent;
}

function cloneWorkspace(workspace: WikiWorkspaceSnapshot): WikiWorkspaceSnapshot {
  return {
    document: { ...workspace.document },
    mode: workspace.mode,
    nodes: workspace.nodes.map((node) => ({ ...node, sourceRef: { ...node.sourceRef } })),
    orderPersistence: workspace.orderPersistence,
    siblingOrderRevisions: { ...workspace.siblingOrderRevisions },
    generationJob: workspace.generationJob ? cloneJob(workspace.generationJob) : null,
    nodeAi: Object.fromEntries(Object.entries(workspace.nodeAi).map(([key, state]) => [key, {
      ...state,
      messages: state.messages.map((message) => ({ ...message })),
      draft: state.draft ? { ...state.draft, proposedChildren: [...state.draft.proposedChildren] } : null,
    }])),
  };
}

function cloneJob(job: WikiGenerationJob): WikiGenerationJob {
  return { ...job, tasks: job.tasks.map((task) => ({ ...task })) };
}

function normalizeScenario(value: unknown): WikiMockScenario {
  return value === 'partial' || value === 'stale' || value === 'ai-unavailable' ? value : 'complete';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
