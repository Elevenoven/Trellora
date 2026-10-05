import type { AiProviderConfig } from '../aiTypes';
import type { AiTransportImage } from '../aiGenerationTransport';
import type { AssistantThinkingMode } from '../assistantTurnTypes';
import type { AssistantTokenUsage } from '../tokenEstimator';
import { resolveAiModelDescriptor } from '../aiModelCapabilities';
import { chatAnthropicMessages, chatGoogleContent, chatOpenAiCompletion, chatOpenAiResponse } from './reactChatAdapters';

/** 模型发起的一次工具调用；id 由引擎或传输层保证在本轮会话内唯一。 */
export interface ReActToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * ReAct 循环内的统一消息形态。传输层负责把它映射到各 provider 的
 * messages / contents / input 结构以及 tool_calls / tool_result /
 * functionResponse 协议块。
 */
export interface ReActChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** OpenAI-compatible provider reasoning_content; never merged into content. */
  reasoningContent?: string;
  /** 仅本轮 user 消息携带的 VLM 图片；多轮工具调用会随该消息重新发送以保留视觉上下文。 */
  images?: AiTransportImage[];
  /** assistant 消息：模型本轮请求执行的工具调用。 */
  toolCalls?: ReActToolCall[];
  /** tool 消息：对应 assistant 消息中的某个 toolCall.id。 */
  toolCallId?: string;
  /** tool 消息：被调用工具名；Google functionResponse 需要按名回填。 */
  toolName?: string;
}

/** 注册给模型的工具定义（name / description / JSON Schema）。 */
export interface ReActToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ReActChatRequest {
  messages: ReActChatMessage[];
  tools: ReActToolSchema[];
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** 用户为本轮选择的思考强度；仅业务决策与终答请求透传。 */
  thinkingMode?: AssistantThinkingMode;
  /** null 表示禁用供应商超时，仅保留调用方取消。 */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** 模型回答文本增量；提供时传输层走 SSE 流式并逐块回调（UI 流式投影）。 */
  onDelta?: (text: string) => void;
  /** 模型深度思考（reasoning）增量；提供商未返回思考内容时不会触发。 */
  onThinkingDelta?: (text: string) => void;
  /** 模型本次响应开始输出工具调用增量；调用方据此停转文本并收回已流式内容。 */
  onToolCallStart?: () => void;
}

export interface ReActChatResponse {
  content: string;
  /** Present only when the provider explicitly returns reasoning_content. */
  reasoningContent?: string;
  toolCalls: ReActToolCall[];
  usage?: AssistantTokenUsage;
}

/**
 * native-tools：provider 原生支持多轮 messages + function calling。
 * 本地 Ollama 等无原生工具调用的链路不产出传输层，由引擎走 JSON 仿真。
 */
export interface ReActChatTransport {
  capability: 'native-tools';
  chat: (config: AiProviderConfig, input: ReActChatRequest) => Promise<ReActChatResponse>;
}

/**
 * 按线协议（而非供应商身份）分派 chat 传输；Ollama 返回 undefined，
 * 调用方据此降级到 JSON 仿真回退（方案 §6.2）。
 */
export function createReActChatTransport(config: AiProviderConfig, model: string): ReActChatTransport | undefined {
  if (config.kind === 'ollama') return undefined;
  const descriptor = resolveAiModelDescriptor(config, model);
  switch (descriptor.api) {
    case 'openai-completions':
      return { capability: 'native-tools', chat: chatOpenAiCompletion };
    case 'openai-responses':
      return { capability: 'native-tools', chat: chatOpenAiResponse };
    case 'anthropic-messages':
      return { capability: 'native-tools', chat: chatAnthropicMessages };
    case 'google-generate-content':
      return { capability: 'native-tools', chat: chatGoogleContent };
    case 'ollama-chat':
      return undefined;
  }
}
