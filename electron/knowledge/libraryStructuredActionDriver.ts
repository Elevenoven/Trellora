import type { SearchPlanPatch } from './searchPlanTypes';
import type { AssistantTokenUsage } from './tokenEstimator';
import type { ModelCallKind } from './modelCallBudget';
import {
  DEFAULT_DECIDE_JSON_SCHEMA,
  DEFAULT_SYNTHESIZE_JSON_SCHEMA,
  type StructuredOutputSchema,
} from './planAwarePromptProjector';

export const libraryToolNames = [
  'search_note_library',
  'get_library_note_map',
  'search_library_note_blocks',
  'read_library_note_range',
  'read_library_note_section',
  'expand_library_evidence',
  'read_library_adjacent_section',
] as const;

export type LibraryToolName = typeof libraryToolNames[number];

const libraryToolArgumentsSchema = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['limit'], properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'detail'], properties: { noteId: { type: 'string' }, detail: { enum: ['outline', 'stats', 'terms'] } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'limit'], properties: { noteId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'lineFrom', 'lineTo'], properties: { noteId: { type: 'string' }, lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'headingId', 'cursor'], properties: { noteId: { type: 'string' }, headingId: { type: 'string' }, cursor: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    { type: 'object', additionalProperties: false, required: ['evidenceId', 'beforeLines', 'afterLines'], properties: { evidenceId: { type: 'string' }, beforeLines: { type: 'integer' }, afterLines: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['evidenceId', 'direction'], properties: { evidenceId: { type: 'string' }, direction: { enum: ['previous', 'next'] } } },
  ],
} as const;

export const LIBRARY_DECIDE_JSON_SCHEMA = JSON.stringify(createLibraryDecideSchema());
export const LIBRARY_SYNTHESIZE_JSON_SCHEMA = DEFAULT_SYNTHESIZE_JSON_SCHEMA;

export type LibraryAgentAction =
  | {
    type: 'tool';
    goalId: string;
    tool: LibraryToolName;
    arguments: Record<string, unknown>;
    publicRationale: string;
    planPatch?: SearchPlanPatch;
  }
  | {
    type: 'answer';
    answer: string;
    citations: string[];
    completeness: 'complete' | 'partial' | 'not-found';
    planPatch?: SearchPlanPatch;
  };

export interface LibraryStructuredActionDriver {
  decide(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<LibraryAgentAction>;
  synthesize(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<Extract<LibraryAgentAction, { type: 'answer' }>>;
}

export function createLibraryStructuredActionDriver(input: {
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }) => Promise<unknown>;
}): LibraryStructuredActionDriver {
  return {
    async decide(request) {
      return parseLibraryAgentAction(await input.generateJson({ ...request, callKind: 'decide' }));
    },
    async synthesize(request) {
      const action = parseLibraryAgentAction(await input.generateJson({ ...request, callKind: 'synthesize' }));
      if (action.type !== 'answer') throw new Error('最终合成必须返回 answer 动作。');
      return action;
    },
  };
}

export function parseLibraryAgentAction(value: unknown): LibraryAgentAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型动作必须是 JSON 对象。');
  const action = value as Record<string, unknown>;
  if (action.type === 'tool') return parseToolAction(action);
  if (action.type === 'answer') return parseAnswerAction(action);
  throw new Error('模型动作类型无效。');
}

function parseToolAction(action: Record<string, unknown>): Extract<LibraryAgentAction, { type: 'tool' }> {
  if (typeof action.tool !== 'string' || !libraryToolNames.includes(action.tool as LibraryToolName)) throw new Error('模型请求了不允许的整库工具。');
  if (typeof action.goalId !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(action.goalId)) throw new Error('整库工具动作必须包含合法 goalId。');
  if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) throw new Error('工具参数必须是对象。');
  if (typeof action.publicRationale !== 'string') throw new Error('工具动作缺少公开说明。');
  const publicRationale = action.publicRationale.replace(/\s+/gu, ' ').trim();
  if (!publicRationale || publicRationale.length > 80) throw new Error('工具公开说明必须为 1 到 80 个字符。');
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  return {
    type: 'tool',
    goalId: action.goalId,
    tool: action.tool as LibraryToolName,
    arguments: sanitizeToolArguments(action.tool as LibraryToolName, action.arguments as Record<string, unknown>),
    publicRationale,
    ...(planPatch ? { planPatch } : {}),
  };
}

function sanitizeToolArguments(tool: LibraryToolName, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'search_note_library':
      return pickDefined(args, ['limit']);
    case 'get_library_note_map':
      return pickDefined(args, ['noteId', 'detail']);
    case 'search_library_note_blocks':
      return pickDefined(args, ['noteId', 'limit']);
    case 'read_library_note_range':
      return pickDefined(args, ['noteId', 'lineFrom', 'lineTo']);
    case 'read_library_note_section':
      return pickDefined(args, ['noteId', 'headingId', 'cursor']);
    case 'expand_library_evidence':
      return pickDefined(args, ['evidenceId', 'beforeLines', 'afterLines']);
    case 'read_library_adjacent_section':
      return pickDefined(args, ['evidenceId', 'direction']);
  }
}

function parseAnswerAction(action: Record<string, unknown>): Extract<LibraryAgentAction, { type: 'answer' }> {
  if (typeof action.answer !== 'string') throw new Error('回答动作缺少 answer。');
  const answer = action.answer.trim();
  if (!answer || answer.length > 12_000) throw new Error('回答长度无效。');
  if (!Array.isArray(action.citations) || action.citations.length > 32 || !action.citations.every((entry) => typeof entry === 'string')) throw new Error('回答引用格式无效。');
  if (action.completeness !== 'complete' && action.completeness !== 'partial' && action.completeness !== 'not-found') throw new Error('回答完整性标记无效。');
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  return {
    type: 'answer',
    answer,
    citations: [...new Set(action.citations.map((entry) => entry.trim()).filter(Boolean))],
    completeness: action.completeness,
    ...(planPatch ? { planPatch } : {}),
  };
}

function readPlanPatch(value: unknown): SearchPlanPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planPatch 必须是对象。');
  return value as SearchPlanPatch;
}

function pickDefined(args: Record<string, unknown>, allowedKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(allowedKeys.flatMap((key) => args[key] === undefined || args[key] === null ? [] : [[key, args[key]]]));
}

function createLibraryDecideSchema(): Record<string, unknown> {
  const schema = JSON.parse(DEFAULT_DECIDE_JSON_SCHEMA) as {
    properties?: Record<string, unknown>;
  };
  const toolSchema = schema.properties?.tool as { anyOf?: Array<{ enum?: string[] }> } | undefined;
  if (!toolSchema?.anyOf?.[0]?.enum || !schema.properties) throw new Error('整库动作 Schema 无法从基础契约构建。');
  schema.properties.tool = { anyOf: [{ enum: [...libraryToolNames] }, { type: 'null' }] };
  schema.properties.arguments = { anyOf: [libraryToolArgumentsSchema, { type: 'null' }] };
  return schema as Record<string, unknown>;
}
