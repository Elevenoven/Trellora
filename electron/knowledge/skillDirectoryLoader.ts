import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getAiSkillWorkspacePath } from './aiSkillWorkspace';
import type { ResolvedSkillDefinitions } from './skillDefinitionResolver';

/**
 * 目录形态技能（P2）：`AI-Skill/<目录>/SKILL.md` 兼容 Claude/WeKnora 的
 * Agent Skills 目录格式——YAML frontmatter（name + description）+ 正文指令，
 * 目录内可携带附加文档供 read_skill 按 file_path 读取（只读，无脚本执行）。
 *
 * 失败语义与记忆信封一致：任何解析/校验异常只跳过该技能并记录原因，
 * 绝不失败回答；工作区目录缺失时返回空集。
 */

export const skillDirectoryMainFileName = 'SKILL.md';

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;
const MAX_SKILL_INSTRUCTION_CHARS = 12_000;
const MAX_DIRECTORY_SKILLS = 30;
const MAX_RESOURCE_FILES = 40;
const MAX_RESOURCE_DEPTH = 4;
/** 对齐 WeKnora 名称模式：字母（含汉字）、数字、连字符。 */
const skillNamePattern = /^[\p{L}\p{N}-]+$/u;
/** 技能元数据禁止 XML 标签，防止注入本项目的 XML 观察格式。 */
const xmlTagPattern = /<[^>]+>/u;
const reservedSkillNameWords = ['system', 'default', 'internal', 'core', 'base', 'root', 'admin'];
export const ignoredDirectoryNames = new Set(['node_modules', '__pycache__']);

export interface DirectorySkillEntry {
  id: string;
  name: string;
  description: string;
  /** SKILL.md 正文（Level 2 指令）。 */
  instruction: string;
  /** 技能目录绝对路径；read_skill 的 file_path 读取根。 */
  basePath: string;
}

export interface DirectorySkillSkip {
  directory: string;
  reason: string;
}

export interface DirectorySkillLoadOutcome {
  skills: DirectorySkillEntry[];
  skipped: DirectorySkillSkip[];
  /** 已在设置中停用而未加载的目录技能；不参与 catalog 也不算校验失败。 */
  disabled: DirectorySkillSkip[];
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  instructions: string;
}

/** 极简 frontmatter 解析：只取单行 `name:` / `description:`（支持成对引号）。 */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown | undefined {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) return undefined;
  let name = '';
  let description = '';
  for (const line of lines.slice(1, closingIndex)) {
    const match = line.match(/^(name|description)\s*:\s*(.*)$/i);
    if (!match) continue;
    const value = stripYamlScalar(match[2]);
    if (match[1].toLowerCase() === 'name') name = value;
    else description = value;
  }
  const instructions = lines.slice(closingIndex + 1).join('\n').trim();
  return { name, description, instructions };
}

function stripYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    if (value.startsWith('"')) {
      try {
        // formatSkillMarkdown 使用 JSON 标量写入 description；用同一语义解析，
        // 才能正确还原换行、制表符、反斜杠和 Unicode 转义。
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** 校验规则对齐 WeKnora：名称模式/长度/保留词 + 元数据禁 XML 标签。 */
export function validateDirectorySkillMetadata(parsed: ParsedSkillMarkdown): string | undefined {
  const name = parsed.name.trim();
  if (!name) return 'SKILL.md 缺少 name';
  if (name.length > MAX_SKILL_NAME_LENGTH) return `技能名超过 ${MAX_SKILL_NAME_LENGTH} 字符`;
  if (!skillNamePattern.test(name)) return '技能名只能包含字母、汉字、数字与连字符';
  const lowerCaseName = name.toLowerCase();
  for (const reserved of reservedSkillNameWords) {
    if (lowerCaseName.includes(reserved)) return `技能名包含保留词 ${reserved}`;
  }
  if (xmlTagPattern.test(name)) return '技能名不得包含 XML 标签';
  const description = parsed.description.trim();
  if (!description) return 'SKILL.md 缺少 description';
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) return `描述超过 ${MAX_SKILL_DESCRIPTION_LENGTH} 字符`;
  if (xmlTagPattern.test(description)) return '描述不得包含 XML 标签';
  if (!parsed.instructions) return 'SKILL.md 正文为空';
  return undefined;
}

/**
 * 扫描工作区 `AI-Skill/` 下的目录形态技能；只认含 SKILL.md（大小写不敏感）的子目录，
 * 顶层由 syncAiSkillsToWorkspace 管理的平铺 .md 不受影响。按目录名排序保证确定性。
 * `disabledNames`（小写技能名）来自 store 的 directorySkillOverrides，命中的技能
 * 不进 catalog，仅记录在 outcome.disabled 供追踪。
 */
export function loadDirectorySkills(
  workspacePath: string,
  options?: { disabledNames?: ReadonlySet<string> },
): DirectorySkillLoadOutcome {
  const outcome: DirectorySkillLoadOutcome = { skills: [], skipped: [], disabled: [] };
  const root = getAiSkillWorkspacePath(workspacePath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return outcome; // AI-Skill 目录不存在时静默返回空集。
  }
  const seenNames = new Map<string, string>();
  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ignoredDirectoryNames.has(entry.name)) continue;
    const basePath = path.join(root, entry.name);
    const mainFile = findSkillMainFile(basePath);
    if (!mainFile) continue; // 普通目录，不是技能。
    if (outcome.skills.length >= MAX_DIRECTORY_SKILLS) {
      outcome.skipped.push({ directory: entry.name, reason: `目录形态技能数量超过 ${MAX_DIRECTORY_SKILLS} 上限` });
      continue;
    }
    try {
      const parsed = parseSkillMarkdown(fs.readFileSync(mainFile, 'utf8'));
      if (!parsed) {
        outcome.skipped.push({ directory: entry.name, reason: 'SKILL.md 缺少 YAML frontmatter' });
        continue;
      }
      const invalidReason = validateDirectorySkillMetadata(parsed);
      if (invalidReason) {
        outcome.skipped.push({ directory: entry.name, reason: invalidReason });
        continue;
      }
      const name = parsed.name.trim();
      const nameKey = name.toLowerCase();
      if (options?.disabledNames?.has(nameKey)) {
        outcome.disabled.push({ directory: entry.name, reason: '已在设置中停用' });
        continue;
      }
      const conflict = seenNames.get(nameKey);
      if (conflict) {
        outcome.skipped.push({ directory: entry.name, reason: `技能名与目录 ${conflict} 重复` });
        continue;
      }
      seenNames.set(nameKey, entry.name);
      outcome.skills.push({
        id: `skill_file_${slugifyDirectoryName(entry.name)}`,
        name,
        description: parsed.description.trim(),
        instruction: truncateInstruction(parsed.instructions),
        basePath,
      });
    } catch (error) {
      outcome.skipped.push({ directory: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}

function findSkillMainFile(basePath: string): string | undefined {
  try {
    const match = fs.readdirSync(basePath).find((name) => name.toLowerCase() === skillDirectoryMainFileName.toLowerCase());
    return match ? path.join(basePath, match) : undefined;
  } catch {
    return undefined;
  }
}

function slugifyDirectoryName(directoryName: string): string {
  // 请求标识只允许 ASCII；中文目录用稳定哈希，避免菜单可选却无法提交。
  if (/^[A-Za-z0-9_-]{1,60}$/.test(directoryName)) return directoryName;
  const slug = directoryName
    .replace(/[^A-Za-z0-9_-]/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'directory'}-${createHash('sha256').update(directoryName).digest('hex').slice(0, 16)}`;
}

function truncateInstruction(instructions: string): string {
  if (instructions.length <= MAX_SKILL_INSTRUCTION_CHARS) return instructions;
  return `${instructions.slice(0, MAX_SKILL_INSTRUCTION_CHARS)}\n…（正文过长，已截断）`;
}

/**
 * 列举技能目录内的附加文件（相对路径、正斜杠）；跳过 SKILL.md、隐藏项与
 * node_modules，限深限量，保证 <available_files> 清单体积可控。
 */
export function listSkillResourceFiles(basePath: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, relativePrefix: string, depth: number) => {
    if (depth > MAX_RESOURCE_DEPTH || files.length >= MAX_RESOURCE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (files.length >= MAX_RESOURCE_FILES) return;
      if (entry.name.startsWith('.') || ignoredDirectoryNames.has(entry.name)) continue;
      const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relative, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() !== skillDirectoryMainFileName.toLowerCase()) {
        files.push(relative);
      }
    }
  };
  walk(basePath, '', 1);
  return files;
}

/** read_skill 的 file_path 只允许读取文本类文档；脚本与二进制一律拒绝。 */
export const allowedResourceExtensions = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml']);

export interface SkillResourceReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/** 安全读取技能附加文件：拒绝绝对路径、`..` 穿越与技能目录之外的落点。 */
export function readSkillResourceFile(basePath: string, requestedPath: string): SkillResourceReadResult {
  const normalized = requestedPath.trim().replace(/\\/g, '/');
  if (!normalized) return { ok: false, error: 'file_path 不能为空' };
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('~')) {
    return { ok: false, error: 'file_path 必须是技能目录内的相对路径' };
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    return { ok: false, error: 'file_path 不得包含空段或 ..' };
  }
  const resolvedRoot = path.resolve(basePath);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { ok: false, error: 'file_path 超出技能目录边界' };
  }
  if (!allowedResourceExtensions.has(path.extname(candidate).toLowerCase())) {
    return { ok: false, error: '仅支持读取 md/txt/csv/tsv/json/yaml 等文本文件' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return { ok: false, error: `未找到文件 ${normalized}` };
  }
  if (!stat.isFile()) return { ok: false, error: `${normalized} 不是文件` };
  const content = fs.readFileSync(candidate, 'utf8');
  if (content.includes('\u0000')) return { ok: false, error: `${normalized} 疑似二进制文件，已拒绝读取` };
  return { ok: true, content };
}

export interface MergedKnowledgeSkillSources {
  skills: ResolvedSkillDefinitions;
  skillInstructionById: Map<string, string>;
  skillResourceRootById: Map<string, string>;
  /** 实际并入目录的目录形态技能数。 */
  mergedDirectoryCount: number;
  /** 与设置技能重名被放弃的目录形态技能。 */
  nameConflicts: DirectorySkillSkip[];
}

/**
 * 合并设置技能（UI 管理）与目录形态技能：设置技能优先，同名目录技能放弃并入
 * （大小写不敏感）；合并目录供助手菜单统一选择，再由入口限定本轮已选项。
 */
export function mergeKnowledgeSkillSources(input: {
  resolved: ResolvedSkillDefinitions;
  configInstructionById: ReadonlyMap<string, string>;
  directorySkills: readonly DirectorySkillEntry[];
}): MergedKnowledgeSkillSources {
  const existingNames = new Set(
    [...input.resolved.catalog, ...input.resolved.selected].map((skill) => skill.name.trim().toLowerCase()),
  );
  const catalog = [...input.resolved.catalog];
  const skillInstructionById = new Map(input.configInstructionById);
  const skillResourceRootById = new Map<string, string>();
  const nameConflicts: DirectorySkillSkip[] = [];
  let mergedDirectoryCount = 0;
  for (const entry of input.directorySkills) {
    const nameKey = entry.name.trim().toLowerCase();
    if (existingNames.has(nameKey)) {
      nameConflicts.push({ directory: path.basename(entry.basePath), reason: `与设置技能「${entry.name}」重名，设置技能优先` });
      continue;
    }
    existingNames.add(nameKey);
    catalog.push({ id: entry.id, name: entry.name, description: entry.description });
    skillInstructionById.set(entry.id, entry.instruction);
    skillResourceRootById.set(entry.id, entry.basePath);
    mergedDirectoryCount += 1;
  }
  return {
    skills: { selected: input.resolved.selected, catalog },
    skillInstructionById,
    skillResourceRootById,
    mergedDirectoryCount,
    nameConflicts,
  };
}
