import type { ConversationSearchResult } from '../memory/conversationSearchService';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';

export interface SearchConversationsToolRuntime {
  search(query: string, limit?: number): Promise<ConversationSearchResult>;
}

/** WK-M6 read-only L3 tool. Scope and current-session exclusion are host-bound. */
export function createSearchConversationsTool<TContext = unknown>(
  runtime: SearchConversationsToolRuntime,
): ReActTool<TContext> {
  return {
    name: 'search_conversations',
    description: [
      '搜索当前用户在其他已完成会话中的历史原话。',
      '适用：用户提到“之前讨论过”“上次方案”等旧对话，而最近会话窗口不足时。',
      '不适用：把历史回答当作知识库事实引用；事实结论仍应重新检索原始资料。',
      'query 必填；limit 可选，范围 1–8，默认 5。当前会话由主进程自动排除。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, description: '要查找的旧对话内容' },
        limit: { type: 'number', minimum: 1, maximum: 8, description: '返回条数，默认 5，最大 8' },
      },
      required: ['query'],
    },
    execute: async (args): Promise<ReActToolExecution> => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          ok: false,
          observation: '<tool_error>search_conversations 需要非空 query。</tool_error>',
          message: '历史对话查询为空，已拒绝执行。',
        };
      }
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : undefined;
      if (limit !== undefined && (limit < 1 || limit > 8)) {
        return {
          ok: false,
          observation: '<tool_error>search_conversations 的 limit 必须是 1 到 8 的整数。</tool_error>',
          message: '历史对话条数超出范围，已拒绝执行。',
        };
      }
      const result = await runtime.search(query, limit);
      if (!result.availability.enabled) {
        return {
          ok: false,
          observation: `<tool_error>历史对话档案当前不可用：${result.availability.reason ?? 'unknown'}。</tool_error>`,
          message: '历史对话档案当前不可用。',
        };
      }
      if (!result.matches.length) {
        return {
          ok: true,
          observation: '<past_conversations>\n</past_conversations>',
          message: '其他会话中未找到匹配原话。',
          referenceCount: 0,
        };
      }
      return {
        ok: true,
        observation: result.observation,
        message: `在其他会话中找到 ${result.matches.length} 条历史原话${result.vectorUsed ? '（关键词与向量融合）' : '（关键词匹配）'}。`,
        referenceCount: result.matches.length,
      };
    },
  };
}
