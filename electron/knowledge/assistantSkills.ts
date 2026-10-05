import type { AiExtensionsSettings, AiSkill } from './aiTypes';
import { loadDirectorySkills, mergeKnowledgeSkillSources } from './skillDirectoryLoader';
import { resolveSkillDefinitions } from './skillDefinitionResolver';
import { isBundledSkill } from './bundledSkills';

/** 助手菜单与本轮提示词共用启用目录；设置中的同名技能优先。 */
export function loadAssistantSkills(workspacePath: string, settings: AiExtensionsSettings) {
  const disabledNames = new Set(Object.entries(settings.directorySkillOverrides ?? {})
    .filter(([, value]) => !value.enabled).map(([name]) => name.toLowerCase()));
  const directoryOutcome = loadDirectorySkills(workspacePath, { disabledNames });
  const configNames = new Set(settings.skills.map((skill) => skill.name.trim().toLowerCase()));
  const merged = mergeKnowledgeSkillSources({
    resolved: resolveSkillDefinitions(settings.skills),
    configInstructionById: new Map(settings.skills.filter((skill) => skill.enabled).map((skill) => [skill.id, skill.instruction])),
    directorySkills: directoryOutcome.skills.filter((skill) => !configNames.has(skill.name.toLowerCase())),
  });
  const configById = new Map(settings.skills.filter((skill) => skill.enabled).map((skill) => [skill.id, skill]));
  const directoryById = new Map(directoryOutcome.skills.map((skill) => [skill.id, skill]));
  const available: AiSkill[] = merged.skills.catalog.map((entry) => configById.get(entry.id) ?? {
    ...entry,
    instruction: merged.skillInstructionById.get(entry.id) ?? '',
    generationStyle: 'balanced',
    enabled: true,
    system: isBundledSkill(directoryById.get(entry.id)!.basePath, entry.name),
  });
  return { available, merged, directoryOutcome };
}

/** 每轮重新校验已选技能；未选技能不进入提示词或 read_skill 的可读范围。 */
export function resolveAssistantSkillSelection(snapshot: ReturnType<typeof loadAssistantSkills>, skillIds: readonly string[] = []) {
  const resolved = resolveSkillDefinitions(snapshot.available, skillIds);
  const selectedIds = new Set(resolved.selected.map((skill) => skill.id));
  const byId = new Map(snapshot.available.map((skill) => [skill.id, skill]));
  return {
    selectedSkills: resolved.selected.map((skill) => byId.get(skill.id)!),
    skills: { ...resolved, catalog: resolved.catalog.filter((skill) => selectedIds.has(skill.id)) },
    skillInstructionById: new Map([...snapshot.merged.skillInstructionById].filter(([id]) => selectedIds.has(id))),
    skillResourceRootById: new Map([...snapshot.merged.skillResourceRootById].filter(([id]) => selectedIds.has(id))),
  };
}
