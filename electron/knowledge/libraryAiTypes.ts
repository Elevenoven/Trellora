export interface LearningPlanStep {
  title: string;
  rationale: string;
  sourceTitles: string[];
}

export interface LearningPlan {
  goal: string;
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  steps: LearningPlanStep[];
}

export interface OrganizationSuggestionGroup {
  title: string;
  noteTitles: string[];
  rationale: string;
}

export interface OrganizationSuggestion {
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  groups: OrganizationSuggestionGroup[];
  nextActions: string[];
}
import type { AiProviderKind } from './aiTypes';
