export class PipelineStageError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly diagnostic?: string;

  constructor(code: string, message: string, retryable = true, diagnostic?: string) {
    super(message);
    this.name = 'PipelineStageError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

export function isPipelineStageError(error: unknown): error is PipelineStageError {
  return Boolean(
    error
      && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string'
      && typeof (error as { retryable?: unknown }).retryable === 'boolean',
  );
}
