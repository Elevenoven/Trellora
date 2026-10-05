import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, type KnowledgeToolContext } from '../knowledgeToolContext';
import type { ResolvedSkillDefinitions } from '../skillDefinitionResolver';
import { listSkillResourceFiles, readSkillResourceFile } from '../skillDirectoryLoader';

/** read_skill(file_path) 返回内容上限；超出截断并附提示，避免观察爆炸。 */
const MAX_RESOURCE_FILE_CONTENT_CHARS = 6_000;

/**
 * read_skill（Skill 接入 L2）：按需加载技能的完整指令。工厂形态携带本轮
 * 解析出的技能快照；目录契约不含正文（verify-context-runtime-admission-pressure
 * 断言），指令全文由入口经 skillInstructionById 单独注入。
 *
 * P2 扩展：目录形态技能（AI-Skill/<name>/SKILL.md）经 skillResourceRootById
 * 携带资源根，可按 file_path 读取附加文档（只读、白名单扩展名、禁止目录穿越）。
 *
 * 技能不是证据：不登记证据台账、不分配引用号；观察正常计入观察预算。
 * 轮内去重靠闭包 Set（对齐证据块 seen 语义），重复加载返回短提示省 token。
 */
export function createReadSkillTool(
  skills: ResolvedSkillDefinitions,
  skillInstructionById: ReadonlyMap<string, string>,
  skillResourceRootById: ReadonlyMap<string, string> = new Map(),
): ReActTool<KnowledgeToolContext> {
  const loadedSkillIds = new Set<string>();
  const loadedResourceFiles = new Set<string>();
  const allSkills = skills.catalog;

  const resolveSkill = (requested: string) => {
    const normalized = requested.trim();
    if (!normalized) return undefined;
    const lowerCase = normalized.toLowerCase();
    return allSkills.find((skill) => skill.name.trim().toLowerCase() === lowerCase)
      ?? allSkills.find((skill) => skill.id === normalized);
  };

  return {
    name: 'read_skill',
    description: [
      '按名称加载「可用技能目录」中某个技能的完整指令（渐进式披露 L2）。',
      '适用：用户请求匹配某技能描述中的触发条件时，先调用本工具加载指令再作答。',
      '不适用：检索知识库内容——技能只约束作答方式，不提供任何资料证据。',
      'skill_name 传目录中列出的技能名；同一技能只需加载一次，加载后直接遵循其指令。',
      '部分技能附带补充文档：加载指令时观察内会列出 <available_files>，',
      '可用 file_path（技能目录内相对路径）读取其中的文本文件；两个参数同时传入时优先读文件。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          maxLength: 60,
          description: '要加载的技能名称（与可用技能目录中的名称一致）',
        },
        file_path: {
          type: 'string',
          maxLength: 200,
          description: '技能目录内附加文件的相对路径（来自该技能观察中的 <available_files>，仅限文本文件）',
        },
      },
      required: [],
    },
    execute: async (args): Promise<ReActToolExecution> => {
      const skillName = typeof args.skill_name === 'string' ? args.skill_name : '';
      const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
      const skill = resolveSkill(skillName);
      if (!skill) {
        const available = allSkills.map((entry) => entry.name).join('、') || '（无）';
        return {
          ok: false,
          observation: `<tool_error>未找到技能「${escapeXmlText(skillName.trim() || '（空）')}」。可用技能：${escapeXmlText(available)}。</tool_error>`,
          message: `未找到技能「${skillName.trim()}」`,
        };
      }
      const resourceRoot = skillResourceRootById.get(skill.id);
      // file_path 模式：读取技能附加文档（仅目录形态技能有资源根）。
      if (filePath) {
        if (!resourceRoot) {
          return {
            ok: false,
            observation: `<tool_error>技能「${escapeXmlText(skill.name)}」不附带可读取的文件。</tool_error>`,
            message: `技能「${skill.name}」无附加文件`,
          };
        }
        const result = readSkillResourceFile(resourceRoot, filePath);
        if (!result.ok) {
          return {
            ok: false,
            observation: `<tool_error>${escapeXmlText(result.error ?? '文件读取失败')}</tool_error>`,
            message: result.error ?? '文件读取失败',
          };
        }
        const resourceKey = `${skill.id}:${filePath}`;
        if (loadedResourceFiles.has(resourceKey)) {
          return {
            ok: true,
            observation: `<skill_file skill="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(filePath)}" status="already_loaded">该文件内容已在上文读取过，请直接使用。</skill_file>`,
            message: `技能文件 ${filePath} 已读取过`,
          };
        }
        loadedResourceFiles.add(resourceKey);
        let content = result.content ?? '';
        let truncatedSuffix = '';
        if (content.length > MAX_RESOURCE_FILE_CONTENT_CHARS) {
          content = content.slice(0, MAX_RESOURCE_FILE_CONTENT_CHARS);
          truncatedSuffix = '\n…（文件过长，已截断）';
        }
        const observation = compactObservationText(
          `<skill_file skill="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(filePath)}">\n`
          + `${escapeXmlText(content)}${truncatedSuffix}\n</skill_file>`,
        );
        return { ok: true, observation, message: `已读取技能文件 ${filePath}` };
      }
      if (loadedSkillIds.has(skill.id)) {
        const hint = resourceRoot ? '如需补充文档，可用 file_path 读取 <available_files> 中列出的文件。' : '';
        return {
          ok: true,
          observation: `<skill name="${escapeXmlAttribute(skill.name)}" status="already_loaded">该技能指令已在上文加载过，请直接遵循，无需重复加载。${escapeXmlText(hint)}</skill>`,
          message: `技能「${skill.name}」已加载过`,
        };
      }
      const instruction = (skillInstructionById.get(skill.id) ?? '').trim();
      if (!instruction) {
        return {
          ok: false,
          observation: `<tool_error>技能「${escapeXmlText(skill.name)}」的指令内容缺失，无法加载。</tool_error>`,
          message: `技能「${skill.name}」指令缺失`,
        };
      }
      loadedSkillIds.add(skill.id);
      // 目录形态技能附带的补充文档清单（L3 只读形态）：随指令一并披露，引导按需读取。
      const resourceFiles = resourceRoot ? listSkillResourceFiles(resourceRoot) : [];
      const filesBlock = resourceFiles.length > 0
        ? `\n<available_files>${escapeXmlText(resourceFiles.join('\n'))}</available_files>`
        : '';
      const remaining = allSkills.filter((entry) => entry.id !== skill.id && !loadedSkillIds.has(entry.id));
      const remainingLine = remaining.length > 0
        ? `\n<remaining_skills>${escapeXmlText(remaining.map((entry) => entry.name).join('、'))}</remaining_skills>`
        : '';
      const observation = compactObservationText(
        `<skill name="${escapeXmlAttribute(skill.name)}" id="${escapeXmlAttribute(skill.id)}">\n`
        + `<description>${escapeXmlText(skill.description)}</description>\n`
        + `<instructions>\n${escapeXmlText(instruction)}\n</instructions>${filesBlock}\n`
        + `</skill>${remainingLine}`,
      );
      return {
        ok: true,
        observation,
        message: `已加载技能「${skill.name}」`,
      };
    },
  };
}
