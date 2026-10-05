import type { MaterialEmbeddingProfile } from '../electron/pipeline/materialEmbeddingTypes';

export type MaterialVectorGenerationState = 'BUILDING' | 'INTERRUPTED' | 'CANCELLED' | 'FAILED' | 'READY' | 'ACTIVE' | 'RETIRED';
export interface MaterialVectorGeneration {
  id: string;
  state: MaterialVectorGenerationState;
  profile: MaterialEmbeddingProfile;
  completed: number;
  total: number;
  evaluatedQueries: number;
  createdAt: string;
  error?: string;
}
