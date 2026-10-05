import type { MemorySearchResult } from '../memory/memoryRecallService';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';

export interface SearchMemoryToolRuntime {
  search(query: string, limit?: number): Promise<MemorySearchResult>;
}

/** M5 read-only L4 tool. It is created only when the main process enabled it. */
export function createSearchMemoryTool<TContext = unknown>(runtime: SearchMemoryToolRuntime): ReActTool<TContext> {
  return {
    name: 'search_memory',
    description: [
      '在当前用户已确认的长期记忆中搜索背景信息。',
      '适用：用户明确询问此前偏好、任务、事实或长期背景，且常驻记忆不足以回答时。',
      '不适用：检索知识库原文、当前笔记内容或网页资料；这些应使用对应证据工具。',
      'query 必填，为完整检索问题；limit 可选，范围 1–20，默认 10。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, description: '长期记忆检索问题' },
        limit: { type: 'number', minimum: 1, maximum: 20, description: '返回条数，默认 10，最大 20' },
      },
      required: ['query'],
    },
    execute: async (args): Promise<ReActToolExecution> => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { ok: false, observation: '<tool_error>search_memory 需要非空 query。</tool_error>', message: '长期记忆查询为空，已拒绝执行。' };
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : undefined;
      if (limit !== undefined && (limit < 1 || limit > 20)) {
        return { ok: false, observation: '<tool_error>search_memory 的 limit 必须是 1 到 20 的整数。</tool_error>', message: '长期记忆条数超出范围，已拒绝执行。' };
      }
      const result = await runtime.search(query, limit);
      if (!result.availability.enabled) {
        return {
          ok: false,
          observation: `<tool_error>长期记忆当前不可用：${result.availability.reason ?? 'unknown'}。</tool_error>`,
          message: '长期记忆当前不可用。',
        };
      }
      if (!result.items.length) {
        return { ok: true, observation: '<user_memory_search>\n</user_memory_search>', message: '长期记忆未命中。', referenceCount: 0 };
      }
      return {
        ok: true,
        observation: result.observation,
        message: `长期记忆命中 ${result.items.length} 条${result.vectorUsed ? '（词法与向量融合）' : '（词法召回）'}。`,
        referenceCount: result.items.length,
      };
    },
  };
}
