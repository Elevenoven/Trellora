import type { AiSkill } from './aiTypes';

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
}

export interface SelectedSkillDefinition extends SkillCatalogEntry {
  instruction: string;
}

export interface ResolvedSkillDefinitions {
  catalog: SkillCatalogEntry[];
  selected: SelectedSkillDefinition[];
}

/** Keeps discovery text bounded while the selected instruction remains intact. */
export function deriveSkillDescription(name: string, instruction: string): string {
  const normalized = instruction.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  if (!normalized) return `${name.trim() || 'AI Skill'} 的工作方式与适用边界。`;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}…`;
}

export function resolveSkillDefinitions(
  availableSkills: readonly AiSkill[],
  selectedSkillIds: readonly string[] = [],
): ResolvedSkillDefinitions {
  const enabled = availableSkills.filter((skill) => skill.enabled);
  const byId = new Map(enabled.map((skill) => [skill.id, skill]));
  const selectedIds = [...new Set(selectedSkillIds)];
  if (selectedIds.length > 3) throw new Error('每次最多选择 3 个 AI 助手 Skill。');
  const selected = selectedIds.map((id): SelectedSkillDefinition => {
    const skill = byId.get(id);
    if (!skill) throw new Error('所选 AI 助手技能不存在或已停用。');
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description || deriveSkillDescription(skill.name, skill.instruction),
      instruction: skill.instruction,
    };
  });
  return {
    catalog: enabled.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || deriveSkillDescription(skill.name, skill.instruction),
    })),
    selected,
  };
}
