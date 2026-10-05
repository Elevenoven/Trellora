import type { AiGenerationApi, AiModelSettings, AiModelSettingsInput } from '../electron/knowledge/aiTypes';
import type { ModelHub, ModelHubPatch } from './modelHubTypes';

export interface ModelProviderPatch {
  endpoint?: string;
  api?: Exclude<AiGenerationApi, 'ollama-chat'>;
  apiKey?: string | null;
  models?: string[];
}

export type ModelConfigurationChange =
  | { kind: 'hub'; hubPatch?: ModelHubPatch; provider?: { id: string; patch: ModelProviderPatch } }
  | { kind: 'profiles'; settings: AiModelSettingsInput; hubPatch?: ModelHubPatch };

export interface ModelConnectionImpact {
  libraryPath: string;
  libraryName: string;
  model: string;
  previousEndpoint: string;
  nextEndpoint: string;
}

export type ModelConfigurationSaveResult =
  | { status: 'saved'; hub: ModelHub; modelSettings?: AiModelSettings }
  | { status: 'confirmation-required'; impacts: ModelConnectionImpact[]; confirmationToken: string };

export interface ModelProviderCatalogDraft {
  endpoint: string;
  apiKey?: string;
}
