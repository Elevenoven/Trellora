import type { ContextMaterial } from './contextRuntimeTypes';

export type ToolCapabilityPhase = 'navigation' | 'reading' | 'evidence-extension' | 'attachment-search' | 'attachment-read';

export interface ToolCapabilityDefinition {
  name: string;
  description: string;
  phase: ToolCapabilityPhase;
  source: 'current-note' | 'attachment';
  arguments: string;
}

const definitions: readonly ToolCapabilityDefinition[] = Object.freeze([
  { name: 'get_note_map', description: '读取当前笔记的章节、统计或词元地图，仅用于导航。', phase: 'navigation', source: 'current-note', arguments: 'detail=outline|stats|terms' },
  { name: 'search_note', description: '按关键词定位当前笔记的候选片段，仅用于导航。', phase: 'navigation', source: 'current-note', arguments: 'terms:string[], limit:1-20, cursor:string|null' },
  { name: 'read_note_range', description: '读取已经定位的 Markdown 行范围原文。', phase: 'reading', source: 'current-note', arguments: 'lineFrom:integer, lineTo:integer' },
  { name: 'read_note_section', description: '按地图或 Capsule 中的章节标识读取原文。', phase: 'reading', source: 'current-note', arguments: 'headingId:string, cursor:integer|null' },
  { name: 'expand_evidence', description: '扩展已取得 evidenceId 周围的原文上下文。', phase: 'evidence-extension', source: 'current-note', arguments: 'evidenceId:string, beforeLines:integer, afterLines:integer' },
  { name: 'search_attachment', description: '在用户明确选择的文本附件中定位匹配范围。', phase: 'attachment-search', source: 'attachment', arguments: 'query:string, attachmentIds:string[]' },
  { name: 'read_attachment_range', description: '读取搜索命中或用户明确要求的附件行范围。', phase: 'attachment-read', source: 'attachment', arguments: 'attachmentId:string, lineFrom:integer, lineTo:integer' },
]);

export function listToolCapabilities(source?: ToolCapabilityDefinition['source']): ToolCapabilityDefinition[] {
  return definitions.filter((definition) => !source || definition.source === source).map((definition) => ({ ...definition }));
}

export function isToolCapabilityActive(
  name: string,
  activePhases: ReadonlySet<ToolCapabilityPhase> | readonly ToolCapabilityPhase[],
): boolean {
  const phases = activePhases instanceof Set ? activePhases : new Set(activePhases);
  return definitions.some((definition) => definition.name === name && phases.has(definition.phase));
}

export function renderToolCapabilityPrompt(input: {
  source: ToolCapabilityDefinition['source'];
  activePhases: readonly ToolCapabilityPhase[];
}): string {
  const catalog = listToolCapabilities(input.source);
  const active = catalog.filter((definition) => input.activePhases.includes(definition.phase));
  return [
    '[工具能力目录 · 名称与短描述]',
    ...catalog.map((definition) => `- ${definition.name} [${definition.phase}]: ${definition.description}`),
    '',
    '[当前阶段已激活工具定义]',
    ...(active.length
      ? active.map((definition) => `- ${definition.name}(${definition.arguments})`)
      : ['- 无']),
    '未列入“已激活工具定义”的工具即使出现在目录中也不可调用，主进程会拒绝执行。',
  ].join('\n');
}

export function createToolCapabilityMaterials(input: {
  source: ToolCapabilityDefinition['source'];
  activePhases: readonly ToolCapabilityPhase[];
  idPrefix: string;
}): ContextMaterial[] {
  const catalog = listToolCapabilities(input.source);
  const materials: ContextMaterial[] = [
    {
      id: `${input.idPrefix}:catalog`,
      zone: 'agent-state',
      channel: 'system',
      trust: 'trusted-state',
      content: ['[工具能力目录]', ...catalog.map((definition) => `- ${definition.name}: ${definition.description}`)].join('\n'),
      priority: 88,
      protected: true,
      compressStrategy: 'none',
      source: { kind: 'tool-capability-catalog', id: input.source, version: 'tool-catalog-v1' },
      stalePolicy: 'keep',
      overflowPolicy: 'fail',
      admission: {
        kind: 'tool-catalog',
        key: input.source,
        activeByDefault: true,
        activationReason: '常驻能力目录仅包含名称和短描述。',
      },
      cache: { stability: 'stable', prefixEligible: false },
    },
  ];
  for (const definition of catalog) {
    materials.push({
      id: `${input.idPrefix}:definition:${definition.name}`,
      zone: 'agent-state',
      channel: 'system',
      trust: 'trusted-state',
      content: `[工具定义] ${definition.name}(${definition.arguments})\n${definition.description}`,
      priority: 84,
      protected: input.activePhases.includes(definition.phase),
      compressStrategy: 'none',
      source: { kind: 'tool-capability-definition', id: definition.name, version: 'tool-definition-v1' },
      stalePolicy: 'refresh',
      overflowPolicy: 'fail',
      admission: {
        kind: 'tool-definition',
        key: definition.name,
        phase: definition.phase,
        activeByDefault: false,
        activationReason: `阶段 ${definition.phase} 激活。`,
      },
      cache: { stability: 'turn', prefixEligible: false },
    });
  }
  return materials;
}
