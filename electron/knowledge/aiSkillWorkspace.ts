import fs from 'node:fs';
import path from 'node:path';
import type { AiExtensionsSettings, AiSkill } from './aiTypes';
import { ensureBundledSkills } from './bundledSkills';

export const aiSkillWorkspaceDirectoryName = 'AI-Skill';
const managedBy = 'menghan-notes';

export function getAiSkillWorkspacePath(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), aiSkillWorkspaceDirectoryName);
}

/**
 * Keep assistant skills as readable workspace files. The Electron store remains
 * the validated runtime configuration; these files are a stable discovery
 * surface for later local AI capabilities and for users to inspect or back up.
 */
export function syncAiSkillsToWorkspace(workspacePath: string, settings: AiExtensionsSettings, builtinSkillsPath?: string): void {
  if (builtinSkillsPath) ensureBundledSkills(workspacePath, builtinSkillsPath);
  const directory = getAiSkillWorkspacePath(workspacePath);
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);

  const expectedFiles = new Set(settings.skills.map((skill) => getAiSkillFileName(skill)));
  for (const skill of settings.skills) {
    writeUtf8Atomically(path.join(directory, getAiSkillFileName(skill)), formatAiSkillFile(skill));
  }

  // Only remove files created by this synchronizer. Manually added materials in
  // AI-Skill stay intact so future agent integrations can add their own files.
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || expectedFiles.has(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (isManagedAiSkillFile(filePath)) fs.unlinkSync(filePath);
  }
}

export function getAiSkillFileName(skill: Pick<AiSkill, 'id'>): string {
  if (!/^skill_(builtin_[a-z]+|[A-Za-z0-9_-]{8,80})$/.test(skill.id)) throw new Error('AI 助手技能标识无效，无法写入工作区。');
  return `${skill.id}.md`;
}

function formatAiSkillFile(skill: AiSkill): string {
  return `---\nmanagedBy: "${managedBy}"\nid: ${JSON.stringify(skill.id)}\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nenabled: ${skill.enabled ? 'true' : 'false'}\ngenerationStyle: ${JSON.stringify(skill.generationStyle)}\nsource: ${JSON.stringify(skill.system ? 'builtin' : 'custom')}\nschemaVersion: 3\n---\n\n# ${skill.name}\n\n## 能力描述\n\n${skill.description.trim()}\n\n## 工作约束\n\n${skill.instruction.trim()}\n`;
}

function isManagedAiSkillFile(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').startsWith(`---\nmanagedBy: "${managedBy}"\n`);
  } catch {
    return false;
  }
}

function writeUtf8Atomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}
