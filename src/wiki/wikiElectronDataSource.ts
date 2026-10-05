import type { MaterialsDocument, MaterialsLibrarySummary, PipelineDocumentStatus, WikiSiblingOrderErrorCode } from '../electron';
import type { WikiSiblingOrderCommit, WikiWorkspaceSnapshot } from './wikiTypes';

export type WikiOutlineState = 'ready' | 'processing' | 'pending' | 'failed';

export interface WikiLibraryDocument extends MaterialsDocument {
  outlineState: WikiOutlineState;
  outlineLabel: string;
  outlineHint: string;
}

const pipelineStageOrder = ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'] as const;

export async function listWikiKnowledgeBases(): Promise<MaterialsLibrarySummary[]> {
  requireElectronApi();
  return window.electronAPI.listMaterialsLibraries();
}

export async function listWikiLibraryDocuments(libraryPath: string): Promise<WikiLibraryDocument[]> {
  requireElectronApi();
  const [documents, statuses] = await Promise.all([
    window.electronAPI.listMaterialsDocuments(libraryPath),
    window.electronAPI.getMaterialsPipelineStatus(libraryPath),
  ]);
  const statusByDocumentId = new Map(statuses.map((status) => [status.documentId, status]));
  return documents.map((document) => ({
    ...document,
    ...resolveOutlineState(statusByDocumentId.get(document.id)),
  }));
}

export async function loadWikiWorkspace(
  library: MaterialsLibrarySummary,
  document: WikiLibraryDocument,
): Promise<WikiWorkspaceSnapshot> {
  requireElectronApi();
  const outline = await window.electronAPI.getWikiDocumentOutline(library.path, document.id);
  return {
    document: {
      id: outline.documentId,
      title: outline.title,
      sourceName: document.name,
      description: `${library.alias} · ${outline.description}`,
      updatedAt: outline.updatedAt,
      nodeCount: outline.nodes.length,
    },
    mode: 'guided',
    orderPersistence: 'local',
    siblingOrderRevisions: { ...outline.orderRevisions },
    nodes: outline.nodes.map((node) => ({
      id: node.id,
      documentId: outline.documentId,
      parentId: node.parentId,
      title: node.title,
      order: node.order,
      depth: node.depth,
      kind: node.kind ?? ('source' as const),
      status: 'complete' as const,
      markdown: node.markdown,
      sourceRef: {
        sourceName: document.name,
        sourcePath: document.absolutePath,
        headingId: node.sourceHeadingId,
        updatedAt: outline.updatedAt,
      },
    })),
    generationJob: null,
    nodeAi: {},
  };
}

export class WikiSiblingOrderCommitError extends Error {
  readonly code: WikiSiblingOrderErrorCode;

  constructor(
    code: WikiSiblingOrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WikiSiblingOrderCommitError';
    this.code = code;
  }
}

export async function reorderElectronWikiSiblingNodes(
  libraryPath: string,
  documentId: string,
  parentId: string,
  orderedNodeIds: string[],
  expectedRevision: string,
): Promise<WikiSiblingOrderCommit> {
  requireElectronApi();
  const result = await window.electronAPI.reorderWikiSiblingNodes(libraryPath, {
    documentId,
    parentId,
    orderedNodeIds,
    expectedRevision,
  });
  if (!result.ok) throw new WikiSiblingOrderCommitError(result.error.code, result.error.message);
  return {
    parentId: result.parentId,
    orderedNodeIds: result.orderedNodeIds,
    revision: result.revision,
    persistence: 'local',
  };
}

export function isWikiSiblingOrderConflict(error: unknown): boolean {
  return error instanceof WikiSiblingOrderCommitError
    && (error.code === 'WIKI_ORDER_CONFLICT' || error.code === 'WIKI_ORDER_SOURCE_STALE');
}

function resolveOutlineState(status: PipelineDocumentStatus | undefined): Pick<WikiLibraryDocument, 'outlineState' | 'outlineLabel' | 'outlineHint'> {
  if (!status) {
    return { outlineState: 'pending', outlineLabel: '待索引', outlineHint: '尚未读取到文档处理状态。' };
  }
  const stageIndex = pipelineStageOrder.indexOf(status.stage);
  const treeIndex = pipelineStageOrder.indexOf('tree');
  const treeSucceeded = status.stages?.tree?.status === 'SUCCEEDED';
  const treeIsCurrent = status.state === 'SUCCEEDED' || stageIndex > treeIndex;
  if (treeSucceeded && treeIsCurrent) {
    return { outlineState: 'ready', outlineLabel: '已索引', outlineHint: '结构树目录可用。' };
  }
  if (stageIndex <= treeIndex && (status.state === 'FAILED' || status.state === 'FAILED_RETRYABLE')) {
    return {
      outlineState: 'failed',
      outlineLabel: '处理失败',
      outlineHint: status.error?.message ?? '结构树处理失败，请在资料库中重试。',
    };
  }
  if (stageIndex <= treeIndex && ['QUEUED', 'RUNNING', 'INTERRUPTED'].includes(status.state)) {
    return { outlineState: 'processing', outlineLabel: '处理中', outlineHint: '结构树正在生成，完成后即可打开。' };
  }
  return { outlineState: 'pending', outlineLabel: '待索引', outlineHint: '请先在资料库完成文档结构处理。' };
}

function requireElectronApi(): void {
  if (!window.electronAPI) throw new Error('桌面数据桥接不可用，请重新启动 Trellora。');
}
