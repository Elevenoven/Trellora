import type { AiGenerationApi } from '../electron/knowledge/aiTypes';

export type ModelSlotId = 'generation' | 'embedding' | 'rerank';
export interface ModelSlot { source: string; model: string }
export interface ProviderConnection {
  id: string;
  label: string;
  endpoint: string;
  defaultEndpoint: string;
  api: Exclude<AiGenerationApi, 'ollama-chat'>;
  generationOnly: boolean;
  hasKey: boolean;
  models: string[];
  embeddingPresets: string[];
  rerankPresets: string[];
}
export interface ModelHub {
  ollamaEndpoint: string;
  ollamaEmbeddingPresets: string[];
  remoteConsent: boolean;
  providers: ProviderConnection[];
  slots: Record<ModelSlotId, ModelSlot>;
}
export interface ModelHubPatch {
  ollamaEndpoint?: string;
  remoteConsent?: boolean;
  slots?: Partial<Record<ModelSlotId, Partial<ModelSlot>>>;
}
