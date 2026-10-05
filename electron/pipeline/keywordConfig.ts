import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './pathLayout';
import { KEYWORD_OUTPUT_SCHEMA_VERSION } from './keywordTypes';

export interface KeywordExtractionConfig {
  schemaVersion: 1;
  enabled: boolean;
  algorithm: 'hybrid-statistical';
  tokenizer: 'jieba';
  hmm: false;
  minScore: number;
  minKeywords: number;
  maxKeywords: number;
  maxCandidatesPerChunk: number;
  ngramMin: 1;
  ngramMax: number;
  textRank: {
    windowSize: number;
    damping: number;
    maxIterations: number;
    tolerance: number;
  };
  weights: {
    tfidf: number;
    textRank: number;
    position: number;
    sentenceSpread: number;
    sectionMatch: number;
    termQuality: number;
  };
  boilerplateDfRatio: number;
  allowOverlapFallback: boolean;
}

export interface KeywordConfigStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

export interface KeywordConfigHashContext {
  algorithmVersion: string;
  tokenizerVersion: string;
  baseDictionaryHash: string;
  libraryDictionaryHash: string;
  stopwordHash: string;
}

export interface KeywordResourceValidationError {
  code: 'KEYWORDS_CONFIG_INVALID' | 'KEYWORDS_RESOURCE_LIMIT';
  message: string;
  retryable: false;
}

export interface KeywordStageResources {
  config: KeywordExtractionConfig;
  dictionaryTerms: string[];
  stopwords: string[];
  dictionaryHash: string;
  stopwordHash: string;
  validationError?: KeywordResourceValidationError;
}

export const KEYWORD_ALGORITHM_VERSION = 'kw-1';
export const KEYWORD_TOKENIZER_VERSION = 'jieba-0.42.1';
const BUILTIN_STOPWORD_RESOURCE_VERSION = 'builtin-stopwords-v1';
const MAX_DICTIONARY_TERMS = 5_000;
const MAX_STOPWORDS = 10_000;
const MAX_DICTIONARY_BYTES = 512 * 1024;
const MAX_STOPWORDS_BYTES = 512 * 1024;
const MAX_RESOURCE_LINE_BYTES = 256;

const storeKey = 'pipelineKeywords';

export const DEFAULT_KEYWORD_EXTRACTION_CONFIG: KeywordExtractionConfig = {
  schemaVersion: 1,
  enabled: true,
  algorithm: 'hybrid-statistical',
  tokenizer: 'jieba',
  hmm: false,
  minScore: 0.28,
  minKeywords: 1,
  maxKeywords: 10,
  maxCandidatesPerChunk: 256,
  ngramMin: 1,
  ngramMax: 3,
  textRank: {
    windowSize: 4,
    damping: 0.85,
    maxIterations: 30,
    tolerance: 1e-6,
  },
  weights: {
    tfidf: 0.35,
    textRank: 0.25,
    position: 0.15,
    sentenceSpread: 0.10,
    sectionMatch: 0.10,
    termQuality: 0.05,
  },
  boilerplateDfRatio: 0.65,
  allowOverlapFallback: true,
};

export function readKeywordExtractionConfig(store: KeywordConfigStore): KeywordExtractionConfig {
  return normalizeKeywordExtractionConfig(store.get(storeKey));
}

export function saveKeywordExtractionConfig(store: KeywordConfigStore, patch: Partial<KeywordExtractionConfig>): KeywordExtractionConfig {
  const current = readKeywordExtractionConfig(store);
  const next = normalizeKeywordExtractionConfig({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  store.set(storeKey, next);
  return next;
}

export function normalizeKeywordExtractionConfig(value: unknown): KeywordExtractionConfig {
  const record = asRecord(value);
  const minKeywords = clampInt(record.minKeywords, DEFAULT_KEYWORD_EXTRACTION_CONFIG.minKeywords, 0, 5);
  const maxKeywords = clampInt(record.maxKeywords, DEFAULT_KEYWORD_EXTRACTION_CONFIG.maxKeywords, Math.max(1, minKeywords), 20);
  const ngramMax = clampInt(record.ngramMax, DEFAULT_KEYWORD_EXTRACTION_CONFIG.ngramMax, 1, 4);
  const textRank = asRecord(record.textRank);
  const weights = normalizeWeights(asRecord(record.weights));

  return {
    schemaVersion: 1,
    enabled: record.enabled !== false,
    algorithm: 'hybrid-statistical',
    tokenizer: 'jieba',
    hmm: false,
    minScore: clampNumber(record.minScore, DEFAULT_KEYWORD_EXTRACTION_CONFIG.minScore, 0, 1),
    minKeywords,
    maxKeywords,
    maxCandidatesPerChunk: clampInt(record.maxCandidatesPerChunk, DEFAULT_KEYWORD_EXTRACTION_CONFIG.maxCandidatesPerChunk, 32, 1024),
    ngramMin: 1,
    ngramMax,
    textRank: {
      windowSize: clampInt(textRank.windowSize, DEFAULT_KEYWORD_EXTRACTION_CONFIG.textRank.windowSize, 2, 10),
      damping: clampNumber(textRank.damping, DEFAULT_KEYWORD_EXTRACTION_CONFIG.textRank.damping, 0.5, 0.95),
      maxIterations: clampInt(textRank.maxIterations, DEFAULT_KEYWORD_EXTRACTION_CONFIG.textRank.maxIterations, 10, 100),
      tolerance: clampNumber(textRank.tolerance, DEFAULT_KEYWORD_EXTRACTION_CONFIG.textRank.tolerance, 1e-9, 0.1),
    },
    weights,
    boilerplateDfRatio: clampNumber(record.boilerplateDfRatio, DEFAULT_KEYWORD_EXTRACTION_CONFIG.boilerplateDfRatio, 0.4, 0.95),
    allowOverlapFallback: record.allowOverlapFallback !== false,
  };
}

export function keywordConfigHash(config: KeywordExtractionConfig, context: Partial<KeywordConfigHashContext> = {}): string {
  const normalized = normalizeKeywordExtractionConfig(config);
  return crypto.createHash('sha256').update(stableStringify({
    config: normalized,
    algorithmVersion: context.algorithmVersion ?? 'kw-1',
    tokenizerName: normalized.tokenizer,
    tokenizerVersion: context.tokenizerVersion ?? 'unresolved',
    baseDictionaryHash: context.baseDictionaryHash ?? 'unresolved',
    libraryDictionaryHash: context.libraryDictionaryHash ?? 'none',
    stopwordHash: context.stopwordHash ?? 'unresolved',
    outputSchemaVersion: KEYWORD_OUTPUT_SCHEMA_VERSION,
  })).digest('hex');
}

/**
 * Load only library-owned keyword resources. The worker receives the returned
 * arrays, never the resource paths, so a malformed file can be reported as a
 * stable stage error without widening the Python sidecar's filesystem access.
 */
export function readLibraryKeywordStageResources(libraryPath: string): KeywordStageResources {
  const metaDirectory = keywordMetaDirectory(libraryPath);
  let config = DEFAULT_KEYWORD_EXTRACTION_CONFIG;
  let validationError: KeywordResourceValidationError | undefined;
  const configPath = path.join(metaDirectory, 'keyword-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
      if (!isRecord(parsed)) throw new Error('关键词配置必须是 JSON 对象。');
      config = normalizeKeywordExtractionConfig(parsed);
    } catch (error) {
      validationError = resourceError('KEYWORDS_CONFIG_INVALID', `关键词配置文件无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const dictionary = readTermFile(path.join(metaDirectory, 'keyword-dictionary.txt'), '业务词典', 2, MAX_DICTIONARY_TERMS, MAX_DICTIONARY_BYTES, false);
  const stopwords = readTermFile(path.join(metaDirectory, 'keyword-stopwords.txt'), '自定义停用词', 1, MAX_STOPWORDS, MAX_STOPWORDS_BYTES, true);
  validationError ??= dictionary.error ?? stopwords.error;
  return {
    config,
    dictionaryTerms: dictionary.values,
    stopwords: stopwords.values,
    dictionaryHash: hashTerms(dictionary.values, dictionary.rawHash),
    stopwordHash: hashTerms(stopwords.values, `${BUILTIN_STOPWORD_RESOURCE_VERSION}:${stopwords.rawHash}`),
    ...(validationError ? { validationError } : {}),
  };
}

export function keywordStageConfigHash(resources: KeywordStageResources): string {
  return keywordConfigHash(resources.config, {
    algorithmVersion: KEYWORD_ALGORITHM_VERSION,
    tokenizerVersion: KEYWORD_TOKENIZER_VERSION,
    baseDictionaryHash: 'none',
    libraryDictionaryHash: resources.dictionaryHash,
    stopwordHash: resources.stopwordHash,
  });
}

export function saveLibraryKeywordConfig(libraryPath: string, patch: Partial<KeywordExtractionConfig>): KeywordExtractionConfig {
  const current = readLibraryKeywordStageResources(libraryPath);
  if (current.validationError?.code === 'KEYWORDS_CONFIG_INVALID') throw new Error(current.validationError.message);
  const next = normalizeKeywordExtractionConfig({ ...current.config, ...(patch && typeof patch === 'object' ? patch : {}) });
  fs.mkdirSync(keywordMetaDirectory(libraryPath), { recursive: true });
  atomicWriteJson(path.join(keywordMetaDirectory(libraryPath), 'keyword-config.json'), next);
  return next;
}

export function saveLibraryKeywordDictionary(libraryPath: string, content: string): KeywordStageResources {
  writeTermFile(keywordMetaDirectory(libraryPath), 'keyword-dictionary.txt', content, '业务词典', 2, MAX_DICTIONARY_TERMS, MAX_DICTIONARY_BYTES, false);
  return readLibraryKeywordStageResources(libraryPath);
}

export function saveLibraryKeywordStopwords(libraryPath: string, content: string): KeywordStageResources {
  writeTermFile(keywordMetaDirectory(libraryPath), 'keyword-stopwords.txt', content, '自定义停用词', 1, MAX_STOPWORDS, MAX_STOPWORDS_BYTES, true);
  return readLibraryKeywordStageResources(libraryPath);
}

export function keywordMetaDirectory(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta');
}

function readTermFile(filePath: string, label: string, minimumLength: number, maximumCount: number, maximumBytes: number, commentsAllowed: boolean): { values: string[]; rawHash: string; error?: KeywordResourceValidationError } {
  if (!fs.existsSync(filePath)) return { values: [], rawHash: 'none' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maximumBytes) return { values: [], rawHash: 'oversize', error: resourceError('KEYWORDS_RESOURCE_LIMIT', `${label}文件超过大小上限。`) };
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
    const parsed = parseTermContent(content, label, minimumLength, maximumCount, maximumBytes, commentsAllowed);
    return { values: parsed.values, rawHash: sha256(content), ...(parsed.error ? { error: parsed.error } : {}) };
  } catch (error) {
    return { values: [], rawHash: 'unreadable', error: resourceError('KEYWORDS_CONFIG_INVALID', `${label}文件无法读取：${error instanceof Error ? error.message : String(error)}`) };
  }
}

function writeTermFile(metaDirectory: string, fileName: string, content: string, label: string, minimumLength: number, maximumCount: number, maximumBytes: number, commentsAllowed: boolean): void {
  if (typeof content !== 'string') throw new Error(`${label}内容必须是文本。`);
  const parsed = parseTermContent(content, label, minimumLength, maximumCount, maximumBytes, commentsAllowed);
  if (parsed.error) throw new Error(parsed.error.message);
  fs.mkdirSync(metaDirectory, { recursive: true });
  const filePath = path.join(metaDirectory, fileName);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, parsed.normalizedContent, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function parseTermContent(content: string, label: string, minimumLength: number, maximumCount: number, maximumBytes: number, commentsAllowed: boolean): { values: string[]; normalizedContent: string; error?: KeywordResourceValidationError } {
  if (Buffer.byteLength(content, 'utf8') > maximumBytes) return { values: [], normalizedContent: '', error: resourceError('KEYWORDS_RESOURCE_LIMIT', `${label}文件超过大小上限。`) };
  const values: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || (commentsAllowed && line.startsWith('#'))) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_RESOURCE_LINE_BYTES) return { values: [], normalizedContent: '', error: resourceError('KEYWORDS_CONFIG_INVALID', `${label}包含过长词条。`) };
    const normalized = normalizeTerm(line);
    if (normalized.length < minimumLength || normalized.length > 64) return { values: [], normalizedContent: '', error: resourceError('KEYWORDS_CONFIG_INVALID', `${label}词条长度必须在 ${minimumLength}～64 个字符之间。`) };
    if (!seen.has(normalized)) {
      seen.add(normalized);
      values.push(line);
      if (values.length > maximumCount) return { values: [], normalizedContent: '', error: resourceError('KEYWORDS_RESOURCE_LIMIT', `${label}超过 ${maximumCount} 条上限。`) };
    }
  }
  return { values, normalizedContent: values.join('\n') + (values.length ? '\n' : '') };
}

function hashTerms(values: readonly string[], fallback: string): string {
  return sha256(values.length ? values.map(normalizeTerm).sort().join('\n') : fallback);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeTerm(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function resourceError(code: KeywordResourceValidationError['code'], message: string): KeywordResourceValidationError {
  return { code, message, retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeWeights(record: Record<string, unknown>): KeywordExtractionConfig['weights'] {
  const defaults = DEFAULT_KEYWORD_EXTRACTION_CONFIG.weights;
  const raw = {
    tfidf: clampNumber(record.tfidf, defaults.tfidf, 0, 1),
    textRank: clampNumber(record.textRank, defaults.textRank, 0, 1),
    position: clampNumber(record.position, defaults.position, 0, 1),
    sentenceSpread: clampNumber(record.sentenceSpread, defaults.sentenceSpread, 0, 1),
    sectionMatch: clampNumber(record.sectionMatch, defaults.sectionMatch, 0, 1),
    termQuality: clampNumber(record.termQuality, defaults.termQuality, 0, 1),
  };
  const total = Object.values(raw).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return { ...defaults };
  return {
    tfidf: raw.tfidf / total,
    textRank: raw.textRank / total,
    position: raw.position / total,
    sentenceSpread: raw.sentenceSpread / total,
    sectionMatch: raw.sectionMatch / total,
    termQuality: raw.termQuality / total,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
