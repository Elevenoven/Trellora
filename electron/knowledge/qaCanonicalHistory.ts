import type { AssistantAttachment, AssistantConversationMessage } from './assistantTurnTypes';
import { MEMORY_CONSTANTS } from './memory/memoryConstants';
import type {
  QaAgentMessage,
  QaAgentMessageInput,
  QaCanonicalHistoryMessage,
  QaRecentCompleteTurn,
  QaTurnAttachmentDescriptor,
} from './qaMemoryTypes';

export const QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE =
  '[Previous retrieval result omitted — knowledge base may have changed. Please perform a fresh search.]';

const RETRIEVAL_TOOL_NAMES = new Set([
  'knowledge_search',
  'grep_chunks',
  'list_knowledge_chunks',
  'get_document_info',
  'graph_local_search',
  'graph_global_search',
  'web_search',
  'web_fetch',
  'get_note_map',
  'search_note',
  'read_note_range',
  'read_note_section',
  'expand_evidence',
  'search_conversations',
]);

/** Mirrors WeKnora's non-greedy complete-block removal and trims the answer. */
export function stripInlineThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/giu, '').trim();
}

export function calculateQaHistoryMessageOverfetch(historyTurns: number): number {
  if (!Number.isSafeInteger(historyTurns) || historyTurns < 0) {
    throw new Error('最近历史轮数必须是非负整数。');
  }
  return Math.max(
    historyTurns * MEMORY_CONSTANTS.conversationHistory.overfetchMultiplier,
    MEMORY_CONSTANTS.conversationHistory.overfetchMinimumMessages,
  );
}

export function describeAssistantAttachments(
  attachments: readonly AssistantAttachment[] | undefined,
): QaTurnAttachmentDescriptor[] {
  return (attachments ?? []).map((attachment) => ({
    attachmentId: attachment.attachmentId,
    kind: attachment.kind,
    name: attachment.name,
    ...(attachment.kind === 'image' || attachment.kind === 'document'
      ? { mimeType: attachment.mimeType }
      : {}),
    sizeBytes: attachment.sizeBytes,
  }));
}

export function renderQaHistoricalUserContent(
  userText: string,
  attachments: readonly QaTurnAttachmentDescriptor[],
): string {
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const files = attachments.filter((attachment) => attachment.kind !== 'image');
  const sections = [userText];
  if (images.length > 0) {
    sections.push([
      '[用户上传图片]',
      ...images.map((attachment) => `- ${attachment.name}（${attachment.mimeType ?? 'image'}，${attachment.sizeBytes} bytes）`),
    ].join('\n'));
  }
  if (files.length > 0) {
    sections.push([
      '[用户上传附件]',
      ...files.map((attachment) => `- ${attachment.name}（${attachment.mimeType ?? attachment.kind}，${attachment.sizeBytes} bytes）`),
    ].join('\n'));
  }
  return sections.filter((section) => section.trim()).join('\n\n');
}

/**
 * Validates the cross-table invariant before a transaction writes messages.
 * Every call must have exactly one later tool result in call order, and no
 * tool message may reference a call from another turn.
 */
export function validateQaAgentMessageInputs(messages: readonly QaAgentMessageInput[]): void {
  const pendingCalls: Array<{ id: string; name: string }> = [];
  const seenCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pendingCalls.length > 0) throw new Error('Agent tool call 缺少对应结果。');
      for (const call of message.toolCalls ?? []) {
        const callId = call.callId.trim();
        const toolName = call.toolName.trim();
        if (!callId || !toolName || seenCallIds.has(callId)) throw new Error('Agent tool call 标识或名称无效。');
        assertJsonObject(call.arguments, 'Agent tool call 参数');
        seenCallIds.add(callId);
        pendingCalls.push({ id: callId, name: toolName });
      }
      if ((message.toolCallId ?? '').trim()) throw new Error('assistant step 不得携带 toolCallId。');
      continue;
    }

    const expected = pendingCalls.shift();
    const toolCallId = message.toolCallId?.trim() ?? '';
    if (!expected || !toolCallId || toolCallId !== expected.id) {
      throw new Error('Agent tool result 未按 call_seq 匹配当前 turn 的 tool call。');
    }
    if (message.toolName?.trim() && message.toolName.trim() !== expected.name) {
      throw new Error('Agent tool result 的工具名称与 tool call 不一致。');
    }
    if (!(message.content ?? '').trim() && message.artifactRef === undefined) {
      throw new Error('Agent tool result 必须包含正文或 artifact 引用。');
    }
    if (message.toolCalls?.length) throw new Error('tool step 不得再声明 tool call。');
    if (message.reasoningContent?.trim()) throw new Error('tool step 不得携带 reasoning_content。');
    if (message.artifactRef !== undefined) assertJsonObject(message.artifactRef, 'Agent artifact 引用');
  }
  if (pendingCalls.length > 0) throw new Error('Agent tool call 缺少对应结果。');
}

export function validateQaStoredAgentMessages(messages: readonly QaAgentMessage[]): boolean {
  if (!messages.every((message, index) => message.messageSeq === index)) return false;
  try {
    validateQaAgentMessageInputs(messages.map((message) => ({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.artifactRef ? { artifactRef: message.artifactRef } : {}),
      toolCalls: message.toolCalls.map((call) => ({
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.arguments,
      })),
    })));
    return true;
  } catch {
    return false;
  }
}

export function projectQaRecentTurnsToHistoryMessages(
  turns: readonly QaRecentCompleteTurn[],
  options: { retainRetrievalHistory?: boolean } = {},
): QaCanonicalHistoryMessage[] {
  const retainRetrievalHistory = options.retainRetrievalHistory
    ?? MEMORY_CONSTANTS.conversationHistory.retainRetrievalHistoryByDefault;
  const result: QaCanonicalHistoryMessage[] = [];
  for (const turn of turns) {
    result.push({
      role: 'user',
      content: renderQaHistoricalUserContent(turn.userText, turn.metadata.attachments),
    });
    let finalReasoningContent = '';
    const ignoredFinalAnswerCallIds = new Set<string>();
    for (const message of turn.agentMessages) {
      if (message.role === 'assistant') {
        if (message.toolCalls.length === 0 && !message.content.trim() && message.reasoningContent.trim()) {
          finalReasoningContent = message.reasoningContent;
          continue;
        }
        const replayableToolCalls = message.toolCalls.filter((call) => {
          if (call.toolName !== 'final_answer') return true;
          ignoredFinalAnswerCallIds.add(call.callId);
          return false;
        });
        if (message.toolCalls.length > 0 && replayableToolCalls.length === 0) continue;
        result.push({
          role: 'assistant',
          content: message.content,
          ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
          ...(replayableToolCalls.length > 0 ? {
            toolCalls: replayableToolCalls.map((call) => ({
              id: call.callId,
              name: call.toolName,
              arguments: call.arguments,
            })),
          } : {}),
        });
        continue;
      }
      if (message.toolCallId && ignoredFinalAnswerCallIds.has(message.toolCallId)) continue;
      if (message.toolName === 'final_answer') continue;
      const content = !retainRetrievalHistory && message.toolName && RETRIEVAL_TOOL_NAMES.has(message.toolName)
        ? QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE
        : message.content;
      result.push({
        role: 'tool',
        content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.artifactRef ? { artifactRef: message.artifactRef } : {}),
      });
    }
    result.push({
      role: 'assistant',
      content: turn.assistantText,
      ...(finalReasoningContent ? { reasoningContent: finalReasoningContent } : {}),
    });
  }
  return result;
}

/** Direct routes consume the same selected turns, projected to Q/A messages. */
export function projectQaRecentTurnsToConversation(
  turns: readonly QaRecentCompleteTurn[],
): AssistantConversationMessage[] {
  return turns.flatMap((turn) => [
    {
      role: 'user' as const,
      content: renderQaHistoricalUserContent(turn.userText, turn.metadata.attachments),
    },
    { role: 'assistant' as const, content: turn.assistantText },
  ]);
}

/** Selects only complete user/assistant pairs and keeps the newest N pairs. */
export function selectQaRecentCompleteConversation(
  messages: readonly AssistantConversationMessage[],
  historyTurns = MEMORY_CONSTANTS.conversationHistory.recentCompleteTurns,
): AssistantConversationMessage[] {
  if (!Number.isSafeInteger(historyTurns) || historyTurns < 0) throw new Error('最近历史轮数无效。');
  if (historyTurns === 0) return [];
  const pairs: Array<[AssistantConversationMessage, AssistantConversationMessage]> = [];
  let pendingUser: AssistantConversationMessage | undefined;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === 'user') {
      pendingUser = { role: 'user', content };
      continue;
    }
    if (!pendingUser) continue;
    pairs.push([pendingUser, { role: 'assistant', content }]);
    pendingUser = undefined;
  }
  return pairs.slice(-historyTurns).flatMap(([user, assistant]) => [user, assistant]);
}

/** Merges legacy fallback and canonical histories, preferring the later copy. */
export function mergeQaRecentCompleteConversations(
  histories: readonly (readonly AssistantConversationMessage[])[],
  historyTurns = MEMORY_CONSTANTS.conversationHistory.recentCompleteTurns,
): AssistantConversationMessage[] {
  const orderedPairs: Array<[AssistantConversationMessage, AssistantConversationMessage]> = [];
  for (const history of histories) {
    const selected = selectQaRecentCompleteConversation(history, Number.MAX_SAFE_INTEGER);
    for (let index = 0; index < selected.length; index += 2) {
      const user = selected[index];
      const assistant = selected[index + 1];
      if (!user || !assistant) continue;
      const signature = `${user.content}\0${assistant.content}`;
      const duplicateIndex = orderedPairs.findIndex(([oldUser, oldAssistant]) => (
        `${oldUser.content}\0${oldAssistant.content}` === signature
      ));
      if (duplicateIndex >= 0) orderedPairs.splice(duplicateIndex, 1);
      orderedPairs.push([user, assistant]);
    }
  }
  return orderedPairs.slice(-historyTurns).flatMap(([user, assistant]) => [user, assistant]);
}

export function createQaAgentMessageInputs(
  messages: readonly Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    toolName?: string;
  }>,
): QaAgentMessageInput[] {
  const result = messages.flatMap((message): QaAgentMessageInput[] => {
    if (message.role !== 'assistant' && message.role !== 'tool') return [];
    if (message.role === 'tool') {
      return [{
        role: 'tool',
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
      }];
    }
    return [{
      role: 'assistant',
      content: message.content,
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      toolCalls: (message.toolCalls ?? []).map((call) => ({
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
      })),
    }];
  });
  validateQaAgentMessageInputs(result);
  return result;
}

function assertJsonObject(value: Record<string, unknown>, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
  JSON.stringify(value);
}
