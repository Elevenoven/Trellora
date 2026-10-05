import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const bundledSkillNames: Readonly<Record<string, string>> = {
  'builtin-knowledge': 'builtin-knowledge',
  'builtin-learning': 'builtin-learning',
  'builtin-organize': 'builtin-organize',
  'generate-experiment-report': '实验报告生成',
  'generate-study-doc': '学习文档生成',
};

/** 只补齐缺失的内置技能；保留用户编辑、模板和启停登记。 */
export function ensureBundledSkills(workspacePath: string, bundleRoot: string): void {
  const root = path.join(path.resolve(workspacePath), 'AI-Skill');
  fs.mkdirSync(root, { recursive: true });
  for (const directory of Object.keys(bundledSkillNames)) {
    const destination = path.join(root, directory);
    if (fs.existsSync(destination)) continue;
    const source = path.join(bundleRoot, directory);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`内置技能“${bundledSkillNames[directory]}”缺失，请重新安装应用。`);
    const temporary = path.join(root, `.builtin-${randomUUID()}`);
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: false });
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

/** 来源标签只匹配应用发布的目录及技能名。 */
export function isBundledSkill(basePath: string, name: string): boolean {
  return bundledSkillNames[path.basename(basePath)] === name;
}
