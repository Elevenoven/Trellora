export const PIPELINE_PROTOCOL_VERSION = 1;
export const PIPELINE_SCHEMA_VERSION = 1;
export const PIPELINE_ENGINE_VERSION = 'p5';

export type ParsingRoute = 'direct' | 'mammoth' | 'mineru' | 'unsupported';
export type PipelineStageId = 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities';
export type PipelineStageState =
  | 'IDLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED'
  | 'WAITING_CONFIG'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export interface PipelineError {
  code: string;
  message: string;
  diagnostic?: string;
  retryable: boolean;
}

export interface PipelineStageManifest {
  stageKey: string;
  status: PipelineStageState;
  jobId?: string;
  artifactPath?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  counts?: Record<string, number>;
  outputs?: Record<string, { relativePath: string; sha256: string; bytes: number }>;
  error?: PipelineError;
}

export interface PipelineManifest {
  schemaVersion: number;
  documentId: string;
  documentName: string;
  sourceContentHash: string;
  sourceRelativePath: string;
  route: ParsingRoute;
  engine: string;
  protocolVersion: number;
  pipelineFingerprint: string;
  updatedAt: string;
  stages: Partial<Record<PipelineStageId, PipelineStageManifest>>;
}

export type PipelineFtsIndexState = 'PENDING' | 'CURRENT' | 'MISSING' | 'STALE' | 'FAILED';

/** Electron 从 SQLite 实际读回的 FTS5 投影状态，不是 Python 阶段产物的静态映射。 */
export interface PipelineFtsIndexStatus {
  state: PipelineFtsIndexState;
  tokenizer: 'jieba-accurate-hmm-off';
  outputSchemaVersion: 3;
  expectedChunks: number;
  expectedKeywords: number;
  indexedChunks: number;
  ftsRows: number;
  indexedKeywords: number;
  indexedAt?: string;
  error?: PipelineError;
}

export interface PipelineDocumentStatus {
  libraryPath: string;
  documentId: string;
  documentName: string;
  extension: string;
  route: ParsingRoute;
  sourceContentHash: string;
  stage: PipelineStageId;
  state: PipelineStageState;
  artifactPath?: string;
  counts?: Record<string, number>;
  error?: PipelineError;
  stages?: Partial<Record<PipelineStageId, PipelineStageManifest>>;
  ftsIndex?: PipelineFtsIndexStatus;
  updatedAt: string;
}

export interface PipelineProgressEvent {
  libraryPath: string;
  documentId: string;
  jobId: string;
  stage: PipelineStageId;
  completed: number;
  total?: number;
  unit?: string;
  message: string;
}

export interface PipelineArtifactPreviewRow {
  lineNumber: number;
  text: string;
}

export interface PipelineArtifactPreview {
  documentId: string;
  stage: PipelineStageId;
  fileName: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  offset: number;
  limit: number;
  lineCount: number;
  hasMore: boolean;
  rows: PipelineArtifactPreviewRow[];
}

export interface PipelineKeywordPreviewOccurrence {
  start: number;
  end: number;
  sentenceIndex: number;
}

export interface PipelineKeywordPreviewItem {
  term: string;
  normalizedTerm: string;
  kind: string;
  rank: number;
  score: number;
  occurrences: PipelineKeywordPreviewOccurrence[];
  features: Record<string, number | boolean>;
  forcedTop1: boolean;
}

export interface PipelineKeywordPreviewRow {
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceLocations: string[];
  keywords: PipelineKeywordPreviewItem[];
  emptyReason: string | null;
}

export interface PipelineKeywordPreview {
  documentId: string;
  offset: number;
  limit: number;
  rowCount: number;
  hasMore: boolean;
  rows: PipelineKeywordPreviewRow[];
}

export interface PipelineVectorReport {
  schemaVersion: 1;
  documentId: string;
  stageKey: string;
  profileHash: string;
  sourceId: string;
  model: string;
  dimension: number;
  distanceMetric: 'cosine';
  counts: {
    chunks: number;
    indexed: number;
    skipped: number;
    failed: number;
    batches: number;
    retries: number;
  };
  usage: {
    available: boolean;
    inputTokens?: number;
    totalTokens?: number;
  };
  startedAt: string;
  completedAt: string;
}

export interface WorkerRunStageResult {
  artifactManifest: string;
  counts: Record<string, number>;
}

export interface MineruRuntimeConfig {
  endpoint: string;
  apiKey?: string;
  cloudParsingConsent: boolean;
}

export interface PipelineAmbiguityConfig {
  enabled: boolean;
  minConfidence: number;
  maxConfidence: number;
  maxCandidatesPerBatch: number;
  maxInputCharacters: number;
  timeoutMs: number;
  maxOutputTokens: number;
  promptVersion: string;
}

export interface PipelineStructureConfig {
  strategy: 'heading' | 'fixed';
  targetChars: number;
  overlapChars: number;
  minChars: number;
  maxChars: number;
}

export type ChunkingMode = 'recommended' | 'custom';

export type ChunkStrategyCode =
  | 'STRUCTURE'
  | 'RECURSIVE'
  | 'SEMANTIC'
  | 'LLM'
  | 'PAGE'
  | 'REGEX'
  | 'FIXED';

export type ParentStrategyCode = 'STRUCTURE' | 'RECURSIVE' | 'PAGE' | 'REGEX' | 'FIXED';
export type ChildStrategyCode = ChunkStrategyCode;

export interface LibraryChunkingConfig {
  schemaVersion: 2;
  mode: ChunkingMode;
  parentStrategies: ParentStrategyCode[];
  childStrategies: ChildStrategyCode[];
  parentMinChars: number;
  parentTargetChars: number;
  parentMaxChars: number;
  parentOverlapChars: number;
  childRecursiveMaxChars: number;
  childRecursiveOverlapChars: number;
  semanticMaxChars: number;
  semanticMinChars: number;
  semanticSimilarityThreshold: number;
  llmEnabled: boolean;
  llmMaxChars: number;
  llmTimeoutMs: number;
  llmMaxOutputTokens: number;
  llmPromptVersion: string;
  recommendLlmWhenLowQuality: boolean;
  pageMinMetadataCoverage: number;
  regexPattern: string;
  regexFlags: Array<'i' | 'm'>;
  regexBoundary: 'before' | 'after';
  regexKeepDelimiter: boolean;
  childFixedTargetChars: number;
  childFixedMinChars: number;
  childFixedMaxChars: number;
  childFixedOverlapChars: number;
  migration?: { source: 'pipelineStructure-v1'; migratedAt: string };
}

export interface LibraryLeidenConfig {
  resolution: number;
  maxDepth: number;
  minSplitSize: number;
  seed: number;
}

export interface LibraryGraphEnhancementConfig {
  schemaVersion: 1;
  enabled: boolean;
  maxChars: number;
  maxEntitiesPerChunk: number;
  maxRelationsPerChunk: number;
  promptVersion: string;
  llmTimeoutMs: number;
  llmMaxOutputTokens: number;
  /** 层级社区检测参数；只影响库级图装配（graphKey），不影响实体抽取缓存。 */
  leidenConfig: LibraryLeidenConfig;
  /** 社区摘要提示词版本；变化只失效摘要及其投影，不重跑实体抽取与图装配。 */
  summaryPromptVersion: string;
  /** 单次摘要上下文预算（token），下限 4000（适配本地小模型，方案 §3.3/§8）。 */
  summaryBudgetTokens: number;
  /** 全局检索默认社区层级（0–3，方案 §4.2），超出实际层数时钳制到最高层。 */
  globalSearchLevel: number;
  /** 别名仲裁（向量召回 + LLM 仲裁合并同义实体）；默认关闭，显式开启，影响图装配（入 graphKey）。 */
  aliasArbitrationEnabled: boolean;
}

export interface AmbiguityModelClient {
  provider: string;
  model: string;
  available: boolean;
  fingerprint?: string;
  generateJson: (input: {
    model: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
    signal: AbortSignal;
  }) => Promise<unknown>;
}
