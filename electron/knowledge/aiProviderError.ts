export const AI_CONTEXT_OVERFLOW = 'AI_CONTEXT_OVERFLOW' as const;

export class AiProviderError extends Error {
  readonly code: typeof AI_CONTEXT_OVERFLOW | 'AI_PROVIDER_REQUEST_FAILED';
  readonly status?: number;
  readonly providerLimitTokens?: number;

  constructor(input: {
    code: typeof AI_CONTEXT_OVERFLOW | 'AI_PROVIDER_REQUEST_FAILED';
    message: string;
    status?: number;
    providerLimitTokens?: number;
  }) {
    super(input.message);
    this.name = 'AiProviderError';
    this.code = input.code;
    this.status = input.status;
    this.providerLimitTokens = input.providerLimitTokens;
  }
}

export function isAiContextOverflow(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError && error.code === AI_CONTEXT_OVERFLOW;
}

export function createAiProviderHttpError(status: number, detail = ''): AiProviderError {
  const message = detail.replace(/\s+/gu, ' ').trim();
  const providerLimitTokens = readTokenLimit(message);
  if (looksLikeContextOverflow(message, status)) {
    return new AiProviderError({
      code: AI_CONTEXT_OVERFLOW,
      status,
      ...(providerLimitTokens ? { providerLimitTokens } : {}),
      message: '模型上下文长度超出服务商限制。',
    });
  }
  return new AiProviderError({
    code: 'AI_PROVIDER_REQUEST_FAILED',
    status,
    message: message ? `模型服务请求失败（HTTP ${status}）：${message.slice(0, 240)}` : `模型服务请求失败（HTTP ${status}）。`,
  });
}

export function createAiProviderMessageError(message: string): AiProviderError {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  if (looksLikeContextOverflow(normalized, 400)) {
    const providerLimitTokens = readTokenLimit(normalized);
    return new AiProviderError({
      code: AI_CONTEXT_OVERFLOW,
      ...(providerLimitTokens ? { providerLimitTokens } : {}),
      message: '模型上下文长度超出服务商限制。',
    });
  }
  return new AiProviderError({ code: 'AI_PROVIDER_REQUEST_FAILED', message: normalized || '模型服务请求失败。' });
}

function looksLikeContextOverflow(message: string, status: number): boolean {
  return status === 413
    || /(context|token|prompt).{0,40}(length|limit|maximum|exceed|too large|too long|window)/iu.test(message)
    || /(上下文|提示词).{0,20}(超出|过长|限制|窗口)/u.test(message);
}

function readTokenLimit(message: string): number | undefined {
  const match = message.match(/(?:maximum|limit|context|window|上限|限制)[^\d]{0,24}(\d{3,9})/iu);
  const value = match?.[1] ? Number(match[1]) : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
