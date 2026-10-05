import type { CurrentNotePublicQueryTerm, CurrentNotePublicSearchPlan } from './assistantTurnTypes';
import { SEARCH_QUERY_TERM_PROJECTION_LIMIT, type SearchPlan } from './searchPlanTypes';

const MAX_PUBLIC_FINAL_QUERY_TERMS = SEARCH_QUERY_TERM_PROJECTION_LIMIT;

export function projectPublicSearchPlan(plan: SearchPlan, evidenceIds: ReadonlySet<string>): CurrentNotePublicSearchPlan {
  const activeGoal = plan.activeGoalId ? plan.goals.find((goal) => goal.goalId === plan.activeGoalId) : undefined;
  return {
    version: plan.version,
    originalQuestion: sanitizePlanText(plan.originalQuestion, 240),
    status: plan.status,
    ...(activeGoal ? { activeGoalLabel: publicGoalLabel(activeGoal.question) } : {}),
    goals: plan.goals.map((goal) => {
      const boundEvidenceIds = new Set([
        ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
        ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
      ]);
      return {
        label: publicGoalLabel(goal.question || goal.requirements[0]?.label || '当前核实目标'),
        status: goal.status,
        evidenceCount: [...boundEvidenceIds].filter((evidenceId) => evidenceIds.has(evidenceId)).length,
        evidenceKind: goal.evidenceKind,
        requirements: goal.requirements.map((requirement) => ({
          label: sanitizePlanText(requirement.label, 120),
          minEvidence: requirement.minEvidence,
        })),
        queryTermCount: goal.queryTerms.length,
        queryTerms: projectHeadAndTail(goal.queryTerms, SEARCH_QUERY_TERM_PROJECTION_LIMIT).map((queryTerm) => projectQueryTerm(queryTerm)),
      };
    }),
  };
}

export function sanitizeQueryTerms(terms: readonly string[]): string[] {
  return [...new Set(terms
    .map((term) => sanitizePlanText(term, 64))
    .filter(Boolean))].slice(0, MAX_PUBLIC_FINAL_QUERY_TERMS);
}

function projectQueryTerm(queryTerm: { term: string; source: CurrentNotePublicQueryTerm['source'] }): CurrentNotePublicQueryTerm {
  return { term: sanitizePlanText(queryTerm.term, 64), source: queryTerm.source };
}

function projectHeadAndTail<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const headCount = Math.ceil(limit / 2);
  return [...values.slice(0, headCount), ...values.slice(-(limit - headCount))];
}

function publicGoalLabel(value: string): string {
  const label = sanitizePlanText(value, 120);
  return label.length > 72 ? `${label.slice(0, 71)}…` : label;
}

function sanitizePlanText(value: string, maxLength: number): string {
  return value
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '[本地路径已省略]')
    .replace(/\\\\[^\s]+/gu, '[本地路径已省略]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}
