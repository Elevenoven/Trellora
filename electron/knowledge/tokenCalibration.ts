import type { AssistantTokenUsage } from './tokenEstimator';

export const TOKEN_CALIBRATION_VERSION = 'estimator-v2-envelope-v1';

export interface TokenCalibrationKey {
  providerKind: string;
  model: string;
  callKind?: string;
  tokenizerVersion?: string;
  requestEnvelopeVersion?: string;
}

export interface TokenCalibrationSample {
  key: TokenCalibrationKey;
  locallyEstimatedTokens: number;
  providerInputTokens: number;
}

const MIN_CALIBRATION = 1.05;
const MAX_CALIBRATION = 1.35;
const EWMA_ALPHA = 0.25;

/**
 * Small in-process calibration cache. It deliberately has no persistence: a
 * request envelope or tokenizer version change must not reuse stale ratios.
 */
export class TokenCalibrationStore {
  private readonly ratios = new Map<string, number>();

  getMultiplier(key: TokenCalibrationKey): number {
    return this.ratios.get(createCalibrationKey(key)) ?? MIN_CALIBRATION;
  }

  observe(sample: TokenCalibrationSample): number {
    if (!Number.isSafeInteger(sample.locallyEstimatedTokens) || sample.locallyEstimatedTokens < 1) {
      return this.getMultiplier(sample.key);
    }
    if (!Number.isSafeInteger(sample.providerInputTokens) || sample.providerInputTokens < 1) {
      return this.getMultiplier(sample.key);
    }
    const key = createCalibrationKey(sample.key);
    const ratio = clamp(sample.providerInputTokens / sample.locallyEstimatedTokens, MIN_CALIBRATION, MAX_CALIBRATION);
    const next = clamp((this.ratios.get(key) ?? ratio) * (1 - EWMA_ALPHA) + ratio * EWMA_ALPHA, MIN_CALIBRATION, MAX_CALIBRATION);
    this.ratios.set(key, next);
    return next;
  }

  observeUsage(key: TokenCalibrationKey, localTokens: number, usage: AssistantTokenUsage | undefined): number {
    return usage?.inputTokens === undefined
      ? this.getMultiplier(key)
      : this.observe({ key, locallyEstimatedTokens: localTokens, providerInputTokens: usage.inputTokens });
  }

  fingerprint(key: TokenCalibrationKey): string {
    return `${createCalibrationKey(key)}:${this.getMultiplier(key).toFixed(4)}`;
  }
}

export const sharedTokenCalibrationStore = new TokenCalibrationStore();

function createCalibrationKey(key: TokenCalibrationKey): string {
  return [
    key.providerKind.trim().toLowerCase(),
    key.model.trim(),
    key.callKind?.trim() ?? '*',
    key.tokenizerVersion ?? TOKEN_CALIBRATION_VERSION,
    key.requestEnvelopeVersion ?? 'chat-completions-v1',
  ].join('\u0000');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
