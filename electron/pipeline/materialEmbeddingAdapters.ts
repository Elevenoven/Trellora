import { embedOllamaBatch } from '../knowledge/ollamaClient';
import { embedRemoteBatch } from '../knowledge/remoteModelClient';
import {
  MaterialEmbeddingProfileError,
  normalizeEndpointIdentity,
  type MaterialEmbeddingBatchResult,
  type MaterialEmbeddingCandidate,
  type MaterialEmbeddingProfile,
  type MaterialEmbeddingProbeResult,
} from './materialEmbeddingTypes';

export { embedOllamaBatch } from '../knowledge/ollamaClient';
export { embedRemoteBatch } from '../knowledge/remoteModelClient';

export interface EmbeddingBatchRequest {
  profile: MaterialEmbeddingCandidate | MaterialEmbeddingProfile;
  texts: string[];
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface MaterialEmbeddingAdapter {
  probe(candidate: MaterialEmbeddingCandidate, signal: AbortSignal): Promise<MaterialEmbeddingProbeResult>;
  embedBatch(request: EmbeddingBatchRequest): Promise<MaterialEmbeddingBatchResult>;
}

export type MaterialEmbeddingRuntimeSource =
  | { kind: 'ollama'; endpoint?: string }
  | { kind: 'remote'; endpoint: string; apiKey: string };

export function createMaterialEmbeddingAdapter(source: MaterialEmbeddingRuntimeSource): MaterialEmbeddingAdapter {
  const adapter = createSourceAdapter(source);
  const assertSource = (profile: MaterialEmbeddingCandidate | MaterialEmbeddingProfile) => {
    const expectedTransport = source.kind === 'ollama' ? 'ollama' : 'openai-compatible';
    if (profile.transportKind !== expectedTransport || normalizeEndpointIdentity(source.endpoint || profile.endpointIdentity) !== profile.endpointIdentity) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '向量适配器连接与当前索引代际不一致，请重新检索。');
    }
  };
  return {
    probe: async (candidate, signal) => { assertSource(candidate); return adapter.probe(candidate, signal); },
    embedBatch: async request => { assertSource(request.profile); return adapter.embedBatch(request); },
  };
}

function createSourceAdapter(source: MaterialEmbeddingRuntimeSource): MaterialEmbeddingAdapter {
  if (source.kind === 'ollama') {
    return {
      probe: async (candidate, signal) => {
        const result = await embedOllamaBatch({
          endpoint: source.endpoint ?? candidate.endpointIdentity,
          model: candidate.requestedModel,
          texts: ['Trellora 向量模型探测文本：仅用于确认返回维度，不写入资料库。'],
          signal,
          expectedModel: candidate.requestedModel,
          requestedDimensions: candidate.requestedDimensions,
          truncateInputs: candidate.truncateInputs,
        });
        return { vectorDimension: result.dimension, ...(result.responseModel ? { responseModel: result.responseModel } : {}) };
      },
      embedBatch: (request) => embedOllamaBatch({
        endpoint: source.endpoint ?? request.profile.endpointIdentity,
        model: request.profile.requestedModel,
        texts: request.texts,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        expectedModel: 'responseModel' in request.profile && request.profile.responseModel ? request.profile.responseModel : request.profile.requestedModel,
        requestedDimensions: request.profile.requestedDimensions ?? ('vectorDimension' in request.profile ? request.profile.vectorDimension : undefined),
        truncateInputs: request.profile.truncateInputs,
      }),
    };
  }

  return {
    probe: async (candidate, signal) => {
      const result = await embedRemoteBatch({
        endpoint: source.endpoint,
        apiKey: source.apiKey,
        model: candidate.requestedModel,
        texts: ['Trellora 向量模型探测文本：仅用于确认返回维度，不写入资料库。'],
        signal,
        expectedModel: candidate.requestedModel,
        requestedDimensions: candidate.requestedDimensions,
      });
      return { vectorDimension: result.dimension, ...(result.responseModel ? { responseModel: result.responseModel } : {}) };
    },
    embedBatch: (request) => embedRemoteBatch({
      endpoint: source.endpoint,
      apiKey: source.apiKey,
      model: request.profile.requestedModel,
      texts: request.texts,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      expectedModel: 'responseModel' in request.profile && request.profile.responseModel ? request.profile.responseModel : request.profile.requestedModel,
      requestedDimensions: request.profile.requestedDimensions ?? ('vectorDimension' in request.profile ? request.profile.vectorDimension : undefined),
    }),
  };
}
