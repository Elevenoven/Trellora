import type { AiSkillGenerationStyle } from './aiTypes';

export const ASSISTANT_GENERATION_TEMPERATURES: Record<AiSkillGenerationStyle, number> = {
  factual: 0.2,
  balanced: 0.4,
  creative: 0.7,
};

/**
 * Evidence-grounded answers stay deterministic regardless of selected Skills.
 * For ordinary chat, factual constraints take precedence over creative ones so
 * combining multiple Skills cannot silently weaken a stricter answer contract.
 */
export function resolveAssistantAnswerTemperature(input: {
  grounded: boolean;
  skills?: Array<Pick<{ generationStyle: AiSkillGenerationStyle }, 'generationStyle'>>;
}): number {
  if (input.grounded) return ASSISTANT_GENERATION_TEMPERATURES.factual;
  const styles = new Set((input.skills ?? []).map((skill) => skill.generationStyle));
  if (styles.has('factual')) return ASSISTANT_GENERATION_TEMPERATURES.factual;
  if (styles.has('creative')) return ASSISTANT_GENERATION_TEMPERATURES.creative;
  return ASSISTANT_GENERATION_TEMPERATURES.balanced;
}
