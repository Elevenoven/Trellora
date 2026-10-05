import { createHash } from 'node:crypto';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
} from './contextMemoryTypes';
import type { ContextMaterial } from './contextRuntimeTypes';

export class ProjectContextAdapter implements ContextMemoryAdapter {
  readonly id = 'project-context';

  supports(): boolean {
    return true;
  }

  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    const project = request.projectContext;
    if (!project?.stablePolicy.trim()) return emptyResult(this.id);
    const materials: ContextMaterial[] = [
      {
        id: `project-policy:${request.route}`,
        zone: 'stable-policy',
        channel: 'system',
        trust: 'trusted-policy',
        content: project.stablePolicy,
        priority: 100,
        protected: true,
        compressStrategy: 'none',
        source: {
          kind: 'assistant-policy',
          id: request.route,
          version: project.version,
        },
        stalePolicy: 'keep',
        overflowPolicy: 'fail',
        cache: { stability: 'stable', prefixEligible: true },
      },
    ];
    const instructions = project.validatedInstructions?.trim();
    if (instructions) {
      materials.push({
        id: `project-instructions:${request.route}`,
        zone: 'project-context',
        channel: 'system',
        trust: 'trusted-policy',
        content: instructions,
        priority: 90,
        protected: true,
        compressStrategy: 'none',
        source: {
          kind: 'validated-project-instructions',
          id: request.route,
          version: project.version,
        },
        stalePolicy: 'refresh',
        overflowPolicy: 'fail',
        cache: { stability: 'stable', prefixEligible: true },
      });
    }
    if (project.skills?.catalog.length) {
      materials.push({
        id: `project-skill-catalog:${request.route}`,
        zone: 'project-context',
        channel: 'system',
        trust: 'trusted-policy',
        content: ['[可用 Skill 目录 · 仅描述]', ...project.skills.catalog.map((skill) => `- ${skill.name}: ${skill.description}`)].join('\n'),
        priority: 88,
        protected: true,
        compressStrategy: 'none',
        source: { kind: 'skill-description-catalog', id: request.route, version: project.version },
        stalePolicy: 'refresh',
        overflowPolicy: 'fail',
        admission: {
          kind: 'skill-description',
          key: request.route,
          activeByDefault: true,
          activationReason: 'Skill 目录只包含名称与短描述。',
        },
        cache: { stability: 'stable', prefixEligible: true },
      });
    }
    for (const skill of project.skills?.selected ?? []) {
      materials.push({
        id: `project-skill-body:${skill.id}`,
        zone: 'project-context',
        channel: 'system',
        trust: 'trusted-policy',
        content: `[已选择 Skill：${skill.name}]\n${skill.instruction}`,
        priority: 92,
        protected: true,
        compressStrategy: 'none',
        source: { kind: 'selected-skill-definition', id: skill.id, version: project.version },
        stalePolicy: 'refresh',
        overflowPolicy: 'fail',
        admission: {
          kind: 'skill-body',
          key: skill.id,
          // ProjectContext 中只会构造用户显式选中的正文，因此无需再次猜测选择状态。
          activeByDefault: true,
          activationReason: '用户显式选择该 Skill。',
        },
        cache: { stability: 'session', prefixEligible: false },
      });
    }
    return {
      materials,
      version: hashVersion(project.version, materials),
      diagnostics: {
        source: this.id,
        loadedTurns: 0,
        loadedSummaries: 0,
        recalledTurns: 0,
        staleItems: 0,
      },
    };
  }
}

function emptyResult(source: string): ContextMemoryResult {
  return {
    materials: [],
    version: `${source}:empty`,
    diagnostics: {
      source,
      loadedTurns: 0,
      loadedSummaries: 0,
      recalledTurns: 0,
      staleItems: 0,
    },
  };
}

function hashVersion(version: string, materials: readonly ContextMaterial[]): string {
  return createHash('sha256').update(JSON.stringify({
    version,
    materials: materials.map((material) => ({
      id: material.id,
      sourceVersion: material.source.version,
      content: material.content,
    })),
  }), 'utf8').digest('hex');
}
