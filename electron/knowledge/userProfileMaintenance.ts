import type { ContextRuntimeObservationReport } from './contextRuntimeTypes';
import {
  USER_PROFILE_CATEGORIES,
  type UserProfileItem,
  type UserProfileMaintenanceDiagnostics,
  type UserProfileQueueDiagnostics,
} from './userProfileTypes';

const minimumSamplesForRecommendation = 5;

export function createUserProfileMaintenanceDiagnostics(input: {
  queue?: UserProfileQueueDiagnostics;
  observations: readonly ContextRuntimeObservationReport[];
  items: readonly UserProfileItem[];
}): UserProfileMaintenanceDiagnostics {
  const samples = input.observations.flatMap((report) => {
    const zone = report.diagnostics.zones.find((candidate) => candidate.zone === 'user-profile');
    return zone ? [{ candidate: zone.candidateTokens, final: zone.finalTokens }] : [];
  });
  const candidateValues = samples.map((sample) => sample.candidate).sort((left, right) => left - right);
  const totalCandidate = candidateValues.reduce((total, value) => total + value, 0);
  const totalFinal = samples.reduce((total, sample) => total + sample.final, 0);
  const recommendedTokenBudget = samples.length >= minimumSamplesForRecommendation
    ? clamp(roundUpTo64(percentile(candidateValues, 0.9) * 1.15), 128, 1_200)
    : undefined;

  return {
    queue: input.queue ?? { state: 'idle', queuedJobs: 0, activeJobs: 0 },
    contextUsage: {
      sampleCount: samples.length,
      averageCandidateTokens: samples.length ? Math.round(totalCandidate / samples.length) : 0,
      averageFinalTokens: samples.length ? Math.round(totalFinal / samples.length) : 0,
      peakCandidateTokens: candidateValues.at(-1) ?? 0,
      truncatedSamples: samples.filter((sample) => sample.final < sample.candidate).length,
      ...(recommendedTokenBudget !== undefined ? { recommendedTokenBudget } : {}),
      recommendationReason: recommendedTokenBudget === undefined
        ? `至少需要 ${minimumSamplesForRecommendation} 次真实画像投影后才给出预算建议。`
        : '按最近真实投影的候选 Token P90 加 15% 余量计算，且限制在 128–1200 Token。',
    },
    categories: USER_PROFILE_CATEGORIES.map((category) => {
      const items = input.items.filter((item) => item.category === category);
      return {
        category,
        activeItems: items.filter((item) => item.status === 'active').length,
        suggestedItems: items.filter((item) => item.status === 'suggested').length,
        evidenceCount: items.reduce((total, item) => total + item.sourceCount, 0),
      };
    }),
    categoryPolicy: 'fixed-whitelist',
  };
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

function roundUpTo64(value: number): number {
  return Math.ceil(Math.max(0, value) / 64) * 64;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
