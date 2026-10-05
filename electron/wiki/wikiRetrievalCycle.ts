import { escapeXmlAttribute, escapeXmlText } from '../knowledge/knowledgeToolContext';
import type { ReActTool, ReActToolExecution } from '../knowledge/reactAgent/toolRegistry';
import type { WikiSearchRange } from './wikiScopePolicy';
import type { WikiToolContext } from './wikiToolContext';

export interface WikiFallbackQueryInput {
  originalQuestion: string;
  resolvedQuestion: string;
  subQuestions?: readonly string[];
  explicitSectionTitles?: readonly string[];
}

/**
 * 为检索类工具叠加 Wiki 专属周期与范围门控。参数本身不合法时仍交给原工具返回
 * 既有错误，避免把“参数错误”错误计为一次真实检索周期。
 */
export function createWikiScopedSearchTool(
  tool: ReActTool<WikiToolContext>,
  range: WikiSearchRange,
): ReActTool<WikiToolContext> {
  return {
    ...tool,
    execute: async (args, ctx) => {
      if (!hasExecutableWikiSearchArgs(tool.name, args)) return tool.execute(args, ctx);

      const decision = ctx.scopePolicy.beginSearch({ toolName: tool.name, range, args });
      if (!decision.allowed) {
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'rejected',
          output: {
            tool: tool.name,
            range,
            blockReason: decision.blockReason,
            cycles: ctx.scopeState.retrievalCycleCount,
            maxCycles: ctx.scopeState.maxRetrievalCycles,
          },
          error: decision.message,
        });
        return {
          ok: false,
          observation: `<tool_error code="${escapeXmlAttribute(decision.blockReason ?? 'scope-policy')}">${escapeXmlText(decision.message)}</tool_error>`,
          message: decision.message,
          referenceCount: 0,
        };
      }

      ctx.onStage?.(`正在执行第 ${decision.cycle}/${ctx.scopeState.maxRetrievalCycles} 个检索周期（${range === 'document' ? '本文其他章节' : '当前章节'}）…`);
      ctx.onScopeTrace?.({
        action: 'wiki-retrieval-cycle',
        status: 'started',
        output: {
          tool: tool.name,
          range,
          cycle: decision.cycle,
          maxCycles: ctx.scopeState.maxRetrievalCycles,
          scopeEscalated: decision.scopeEscalated === true,
        },
      });
      if (decision.scopeEscalated) {
        ctx.onScopeTrace?.({
          action: 'wiki-scope-escalation',
          status: 'completed',
          output: {
            from: 'subtree',
            to: 'document',
            reason: ctx.scopeState.escalationReason,
            cycle: decision.cycle,
          },
        });
      }

      try {
        const execution = await tool.execute(args, ctx);
        const newEvidenceCount = execution.referenceCount ?? 0;
        ctx.scopePolicy.completeSearch({ range, ok: execution.ok, newEvidenceCount });
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'completed',
          output: {
            tool: tool.name,
            range,
            cycle: decision.cycle,
            ok: execution.ok,
            newEvidenceCount,
            totalCycles: ctx.scopeState.retrievalCycleCount,
          },
        });
        return appendCycleObservation(execution, range, decision.cycle ?? ctx.scopeState.retrievalCycleCount, ctx.scopeState.maxRetrievalCycles);
      } catch (error) {
        ctx.scopePolicy.completeSearch({ range, ok: false, newEvidenceCount: 0 });
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'rejected',
          output: { tool: tool.name, range, cycle: decision.cycle },
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * 降级链路使用问题改写的真实产物生成有限查询队列。去重后最多 5 条；不足 5 条
 * 就按实际条数结束，不机械填满。
 */
export function buildWikiFallbackQueries(input: WikiFallbackQueryInput): string[] {
  const candidates = [
    ...(input.explicitSectionTitles ?? []).map((title) => `${title}：${input.resolvedQuestion}`),
    ...(input.subQuestions ?? []),
    input.resolvedQuestion,
    input.originalQuestion,
  ];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    const query = candidate.trim();
    if (!query) continue;
    const key = query.toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query.slice(0, 120));
    if (queries.length >= 5) break;
  }
  return queries;
}

function hasExecutableWikiSearchArgs(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'wiki_grep_node') return typeof args.pattern === 'string' && args.pattern.trim().length > 0;
  if (toolName === 'wiki_node_search' || toolName === 'wiki_search_document') {
    return Array.isArray(args.queries) && args.queries.some((item) => typeof item === 'string' && item.trim().length > 0);
  }
  return true;
}

function appendCycleObservation(
  execution: ReActToolExecution,
  range: WikiSearchRange,
  cycle: number,
  maxCycles: number,
): ReActToolExecution {
  return {
    ...execution,
    observation: `${execution.observation}\n<retrieval_cycle current="${cycle}" max="${maxCycles}" range="${range}" new_evidence="${execution.referenceCount ?? 0}" />`,
    message: `第 ${cycle}/${maxCycles} 个检索周期：${execution.message}`,
  };
}
