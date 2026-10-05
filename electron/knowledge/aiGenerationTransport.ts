import type { AssistantThinkingMode } from './assistantTurnTypes';
import type { AssistantTokenUsage } from './tokenEstimator';
import type { AiProviderConfig } from './aiTypes';

export type AiStructuredOutputTransport = 'native-json-schema' | 'tool-call' | 'json-object';

/**
 * 本轮直传 VLM 的图片输入（开发方案 §6.4 / §8 Phase 3）。
 * dataUrl 为渲染进程 FileReader 生成的完整 `data:<mime>;base64,<payload>`；
 * 各 Transport 按厂商格式消费：OpenAI 直接用 dataUrl，Anthropic / Google / Ollama 需要拆出 base64。
 */
export interface AiTransportImage {
  dataUrl: string;
  mimeType: string;
  name: string;
}

/**
 * 从 data URL 拆出 base64 载荷与 MIME。非 data URL（理论不该出现，Phase 1 已校验前缀）时
 * 退化为把整串当 base64、用传入 mimeType，保证不抛异常中断生成。
 */
export function splitImageDataBase64(image: AiTransportImage): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+)[^,]*,([\s\S]*)$/u.exec(image.dataUrl);
  if (match) return { mimeType: match[1].trim() || image.mimeType, base64: match[2] };
  return { mimeType: image.mimeType, base64: image.dataUrl };
}

export interface AiStructuredOutputRequest {
  transport: AiStructuredOutputTransport;
  strictToolSchema: boolean;
  schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

export interface AiGenerationTransportInput {
  model: string;
  prompt: string;
  /** Trusted application policy. Providers receive this through their native system-instruction field. */
  systemPrompt?: string;
  /** Sampling temperature selected by the assistant generation policy. */
  temperature?: number;
  format?: 'json';
  structuredOutput?: AiStructuredOutputRequest;
  timeoutMs?: number | null;
  maxOutputTokens?: number;
  thinkingMode?: AssistantThinkingMode;
  /** 多模态图片输入；仅在视觉模型 + 本轮带图片附件时出现，纯文本轮次省略以保持请求体不变。 */
  images?: AiTransportImage[];
  signal?: AbortSignal;
  onFinishReason?: (reason: string | undefined) => void;
}

export type AiStreamingTransportInput = Omit<AiGenerationTransportInput, 'format' | 'structuredOutput'> & {
  onDelta: (text: string) => void;
  /** 模型深度思考（reasoning）增量；提供商未返回思考内容时不会触发。 */
  onThinkingDelta?: (text: string) => void;
};

export interface AiGenerationTransport {
  generate: (config: AiProviderConfig, input: AiGenerationTransportInput) => Promise<{ text: string; usage?: AssistantTokenUsage }>;
  stream: (config: AiProviderConfig, input: AiStreamingTransportInput) => Promise<AssistantTokenUsage | undefined>;
}

export function assertRemoteGenerationRequest(config: AiProviderConfig, selectedModel: string): string {
  if (!config.remoteContentConsent) throw new Error('请先在设置中确认远程发送范围。');
  if (!config.apiKey) throw new Error('请先在设置中保存 API 密钥。');
  const model = selectedModel.trim() || config.model;
  if (!model) throw new Error('请先在设置中选择模型。');
  return model;
}

export function createGenerationRequestSignal(input: Pick<AiGenerationTransportInput, 'signal' | 'timeoutMs'>): AbortSignal | undefined {
  if (input.timeoutMs === null) return input.signal;
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 60_000);
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}

export function normalizeGenerationEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function readNonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;
}

export function resolveGenerationTemperature(value: number | undefined, fallback = 0.2): number {
  const temperature = value ?? fallback;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new Error('模型温度必须在 0 到 1 之间。');
  }
  return temperature;
}
