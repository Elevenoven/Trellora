import type { RerankAdapter } from '../knowledge/rerankAdapters';
import type { KnowledgeAgentSessionState } from '../knowledge/knowledgeTools/knowledgeSessionState';
import type { KnowledgeToolContext, KnowledgeToolRetrievalContext } from '../knowledge/knowledgeToolContext';
import type { WikiDocumentOutlineNode } from '../wikiOutline';
import type { WikiScopePolicy, WikiScopeState } from './wikiScopePolicy';

/**
 * Wiki 节点工具的运行时上下文（方案 §4）。
 *
 * 由 wikiNodeAgentTurn 入口装配后传入：检索依赖通过 prepareQueryContext 回调
 * 解耦（对应 main.ts 的 prepareMaterialSearchContext），引用号台账与观察预算
 * 复用知识库的 KnowledgeAgentSessionState。
 */
export interface WikiToolContext {
  libraryPath: string;
  /** 当前 Wiki 文档 id；wiki 工具固定按 [documentId] 限定召回文档集合。 */
  documentId: string;
  documentName: string;
  /** 当前节点 id（形如 wiki:<documentId>:<structureNodeId>）。 */
  nodeId: string;
  /**
   * 当前节点子树的 sourceHeadingId 集合，作为 sectionNodeIds 下发检索层；
   * 根节点（整篇文档）为 undefined，表示不做章节过滤。
   */
  sectionNodeIds: string[] | undefined;
  /** 完整 outline 节点，供 wiki_read_node / wiki_get_node_info 在内存中投影。 */
  outlineNodes: WikiDocumentOutlineNode[];
  /** 本轮范围状态；检索包装器在每次搜索执行前后更新计数并实施升级门控。 */
  scopeState: WikiScopeState;
  scopePolicy: WikiScopePolicy;
  session: KnowledgeAgentSessionState;
  signal: AbortSignal;
  prepareQueryContext: (query: string) => Promise<KnowledgeToolRetrievalContext>;
  rerank: { enabled: boolean; adapter?: RerankAdapter };
  /** 复用知识库持久化图片的安全解析与本轮 VLM 预算。 */
  resolveEvidenceVisuals?: KnowledgeToolContext['resolveEvidenceVisuals'];
  /** 检索阶段状态提示（接 assistant-turn 的 status 事件）。 */
  onStage?: (message: string) => void;
  /** Wiki 检索周期、范围升级与拒绝原因的详细轨迹。 */
  onScopeTrace?: (entry: {
    action: string;
    status: 'started' | 'completed' | 'rejected';
    output?: Record<string, unknown>;
    error?: unknown;
  }) => void;
}
