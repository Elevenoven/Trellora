import {
  ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS,
  ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS,
  createAssistantPublicModelText,
} from '../assistantDetailedTrace';
import type { AssistantPublicModelEvent } from '../assistantTurnTypes';
import type { ReActModelRoundEvent } from './reactEngineTypes';

export function projectReActModelRoundEvent(event: ReActModelRoundEvent): AssistantPublicModelEvent {
  return {
    callId: `react-native-model-${event.round}`,
    round: event.round,
    callKind: event.callKind,
    state: event.state,
    input: createAssistantPublicModelText(
      renderReActMessages(event.messages),
      ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS,
    ),
    ...(event.inputCompression ? {
      inputCompression: {
        ...event.inputCompression,
        actions: event.inputCompression.actions.map((action) => ({ ...action })),
      },
    } : {}),
    ...(event.response ? {
      output: createAssistantPublicModelText(
        renderReActResponse(event.response),
        ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS,
      ),
    } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
  };
}

function renderReActMessages(messages: ReActModelRoundEvent['messages']): string {
  return messages.map((message) => {
    const label = message.role === 'tool' && message.toolName
      ? `tool:${message.toolName}`
      : message.role;
    const imageNote = message.images?.length
      ? `\n[${message.images.length} 个图片附件已省略]`
      : '';
    const toolCalls = message.toolCalls?.length
      ? `\n${JSON.stringify(message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })), null, 2)}`
      : '';
    return `[${label}]\n${message.content}${imageNote}${toolCalls}`;
  }).join('\n\n');
}

function renderReActResponse(response: NonNullable<ReActModelRoundEvent['response']>): string {
  const sections: string[] = [];
  if (response.content.trim()) sections.push(response.content);
  if (response.toolCalls.length) {
    sections.push(`[工具调用]\n${JSON.stringify(response.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments,
    })), null, 2)}`);
  }
  return sections.join('\n\n') || '模型未返回可展示的文本或工具调用。';
}
