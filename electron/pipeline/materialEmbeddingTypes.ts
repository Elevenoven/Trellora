import crypto from 'node:crypto';

export const MATERIAL_EMBEDDING_SCHEMA_VERSION = 1 as const;
export const MATERIAL_DOCUMENT_INPUT_VERSION = 'material-chunk-text-v1' as const;
export const MATERIAL_QUERY_INPUT_VERSION = 'material-query-text-v1' as const;
export const MATERIAL_VECTOR_TYPE = 'float32' as const;
export const MATERIAL_DISTANCE_METRIC = 'cosine' as const;
export const MATERIAL_ENCODING_FORMAT = 'float' as const;

export type MaterialEmbeddingTransportKind = 'ollama' | 'openai-compatible';
export type MaterialEmbeddingProfileState = 'UNBOUND' | 'LOCKED' | 'LEGACY_UNBOUND';

export type MaterialEmbeddingProfileErrorCode =
  | 'EMBEDDING_PROFILE_INVALID'
  | 'EMBEDDING_PROFILE_REQUIRED'
  | 'EMBEDDING_PROFILE_LOCKED'
  | 'EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION'
  | 'EMBEDDING_PROFILE_SCHEMA_INVALID'
  | 'EMBEDDING_PROFILE_VECTOR_SCHEMA_CONFLICT'
  | 'EMBEDDING_PROFILE_VECTOR_TABLE_MISSING'
  | 'EMBEDDING_PROBE_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_CREDENTIAL_REQUIRED'
  | 'EMBEDDING_CONSENT_REQUIRED'
  | 'EMBEDDING_PROFILE_MISMATCH';

export type MaterialEmbeddingAdapterErrorCode =
  | 'EMBEDDING_INPUT_INVALID'
  | 'EMBEDDING_PROFILE_MISMATCH'
  | 'EMBEDDING_AUTH_FAILED'
  | 'EMBEDDING_RATE_LIMITED'
  | 'EMBEDDING_TIMEOUT'
  | 'EMBEDDING_NETWORK_ERROR'
  | 'EMBEDDING_BATCH_TOO_LARGE'
  | 'EMBEDDING_MODEL_UNAVAILABLE'
  | 'EMBEDDING_RESPONSE_INVALID'
  | 'EMBEDDING_MODEL_MISMATCH'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_CANCELLED'
  | 'EMBEDDING_DB_WRITE_FAILED'
  | 'EMBEDDING_DB_READBACK_FAILED'
  | 'EMBEDDING_HTTP_ERROR';

export interface MaterialEmbeddingCandidate {
  schemaVersion: typeof MATERIAL_EMBEDDING_SCHEMA_VERSION;
  sourceId: string;
  transportKind: MaterialEmbeddingTransportKind;
  endpointIdentity: string;
  requestedModel: string;
  requestedDimensions?: number;
  vectorType: typeof MATERIAL_VECTOR_TYPE;
  distanceMetric: typeof MATERIAL_DISTANCE_METRIC;
  encodingFormat: typeof MATERIAL_ENCODING_FORMAT;
  truncateInputs: boolean;
  documentInputVersion: string;
  queryInputVersion: string;
}

export interface MaterialEmbeddingProbeResult {
  vectorDimension: number;
  responseModel?: string;
}

export interface MaterialEmbeddingBatchResult {
  vectors: number[][];
  responseModel?: string;
  dimension: number;
  usage?: { inputTokens?: number; totalTokens?: number };
  requestId?: string;
}

export interface MaterialEmbeddingProfile extends MaterialEmbeddingCandidate {
  profileHash: string;
  state: 'LOCKED';
  responseModel?: string;
  vectorDimension: number;
  lockedAt: string;
  appVersion: string;
}

export interface MaterialEmbeddingProfileTestResult {
  state: 'TESTED';
  candidate: MaterialEmbeddingCandidate;
  responseModel?: string;
  vectorDimension: number;
  profileHash: string;
}

export interface MaterialEmbeddingLegacyState {
  vectorTableExists: boolean;
  vectorRowCount: number;
  storedModel?: string;
  storedDimension?: number;
}

export interface MaterialEmbeddingProfileStatus {
  state: MaterialEmbeddingProfileState;
  profile?: MaterialEmbeddingProfile;
  legacy?: MaterialEmbeddingLegacyState;
}

export class MaterialEmbeddingProfileError extends Error {
  readonly code: MaterialEmbeddingProfileErrorCode;
  readonly retryable: boolean;
  readonly diagnostic?: string;

  constructor(code: MaterialEmbeddingProfileErrorCode, message: string, diagnostic?: string, retryable = false) {
    super(message);
    this.name = 'MaterialEmbeddingProfileError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

export class MaterialEmbeddingAdapterError extends Error {
  readonly code: MaterialEmbeddingAdapterErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: MaterialEmbeddingAdapterErrorCode, message: string, options: { retryable?: boolean; status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'MaterialEmbeddingAdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface MaterialEmbeddingRequestSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

export function createMaterialEmbeddingRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): MaterialEmbeddingRequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('embedding request timeout'));
  }, normalizedTimeout);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export function normalizeMaterialEmbeddingCandidate(input: unknown): MaterialEmbeddingCandidate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型候选配置格式无效。');
  }

  const record = input as Record<string, unknown>;
  const schemaVersion = record.schemaVersion === undefined ? MATERIAL_EMBEDDING_SCHEMA_VERSION : record.schemaVersion;
  if (schemaVersion !== MATERIAL_EMBEDDING_SCHEMA_VERSION) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型候选配置版本不受支持。');
  }

  const sourceId = readRequiredText(record.sourceId, '向量模型来源');
  const transportKind = record.transportKind;
  if (transportKind !== 'ollama' && transportKind !== 'openai-compatible') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型传输类型无效。');
  }
  const endpointIdentity = normalizeEndpointIdentity(record.endpointIdentity);
  const requestedModel = readRequiredText(record.requestedModel, '向量模型名称');
  const requestedDimensions = readOptionalDimension(record.requestedDimensions);
  const vectorType = record.vectorType === undefined ? MATERIAL_VECTOR_TYPE : record.vectorType;
  const distanceMetric = record.distanceMetric === undefined ? MATERIAL_DISTANCE_METRIC : record.distanceMetric;
  const encodingFormat = record.encodingFormat === undefined ? MATERIAL_ENCODING_FORMAT : record.encodingFormat;
  if (vectorType !== MATERIAL_VECTOR_TYPE || distanceMetric !== MATERIAL_DISTANCE_METRIC || encodingFormat !== MATERIAL_ENCODING_FORMAT) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '当前仅支持 float32、cosine、float 向量配置。');
  }
  if (typeof record.truncateInputs !== 'boolean') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量截断策略必须明确指定。');
  }

  return {
    schemaVersion: MATERIAL_EMBEDDING_SCHEMA_VERSION,
    sourceId,
    transportKind,
    endpointIdentity,
    requestedModel,
    ...(requestedDimensions === undefined ? {} : { requestedDimensions }),
    vectorType: MATERIAL_VECTOR_TYPE,
    distanceMetric: MATERIAL_DISTANCE_METRIC,
    encodingFormat: MATERIAL_ENCODING_FORMAT,
    truncateInputs: record.truncateInputs,
    documentInputVersion: readRequiredText(record.documentInputVersion, '文档向量输入版本'),
    queryInputVersion: readRequiredText(record.queryInputVersion, '查询向量输入版本'),
  };
}

export function normalizeEndpointIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址不能为空。');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址格式无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址只支持 HTTP 或 HTTPS。');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址不得包含账号、密钥、查询参数或片段。');
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function computeMaterialEmbeddingProfileHash(input: {
  candidate: MaterialEmbeddingCandidate;
  responseModel?: string;
  vectorDimension: number;
}): string {
  const identity = {
    schemaVersion: input.candidate.schemaVersion,
    sourceId: input.candidate.sourceId,
    transportKind: input.candidate.transportKind,
    endpointIdentity: input.candidate.endpointIdentity,
    requestedModel: input.candidate.requestedModel,
    ...(input.responseModel ? { responseModel: input.responseModel } : {}),
    ...(input.candidate.requestedDimensions === undefined ? {} : { requestedDimensions: input.candidate.requestedDimensions }),
    vectorDimension: input.vectorDimension,
    vectorType: input.candidate.vectorType,
    distanceMetric: input.candidate.distanceMetric,
    encodingFormat: input.candidate.encodingFormat,
    truncateInputs: input.candidate.truncateInputs,
    documentInputVersion: input.candidate.documentInputVersion,
    queryInputVersion: input.candidate.queryInputVersion,
  };
  return crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

export function createLockedMaterialEmbeddingProfile(input: {
  candidate: MaterialEmbeddingCandidate;
  responseModel?: string;
  vectorDimension: number;
  lockedAt?: string;
  appVersion?: string;
}): MaterialEmbeddingProfile {
  const candidate = normalizeMaterialEmbeddingCandidate(input.candidate);
  const responseModel = normalizeOptionalText(input.responseModel);
  const vectorDimension = normalizeVectorDimension(input.vectorDimension);
  if (candidate.requestedDimensions !== undefined && candidate.requestedDimensions !== vectorDimension) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_DIMENSION_MISMATCH', '模型返回维度与候选配置不一致。');
  }
  return {
    ...candidate,
    profileHash: computeMaterialEmbeddingProfileHash({ candidate, responseModel, vectorDimension }),
    state: 'LOCKED',
    ...(responseModel ? { responseModel } : {}),
    vectorDimension,
    lockedAt: input.lockedAt ?? new Date().toISOString(),
    appVersion: input.appVersion?.trim() || 'unknown',
  };
}

export function normalizeVectorDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65_536) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '模型返回的向量维度无效。');
  }
  return value;
}

function readRequiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', `${label}不能为空且长度不能超过 512。`);
  }
  return value.trim();
}

function readOptionalDimension(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeVectorDimension(value);
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, item]) => [key, sortCanonicalValue(item)]));
}
