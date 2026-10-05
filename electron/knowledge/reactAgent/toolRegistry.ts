import type { ReActToolSchema } from './reactChatTransport';
import type { AssistantPublicToolResultView } from '../assistantTurnTypes';
import type { AiTransportImage } from '../aiGenerationTransport';

/** 工具执行结果：观察文本喂回模型，事件信息对外发布。 */
export interface ReActToolExecution {
  ok: boolean;
  /** 写入 tool message 的观察文本（引擎会再走观察预算截断）。 */
  observation: string;
  /** 面向用户的事件消息（toolEvents / 详细轨迹）。 */
  message: string;
  referenceCount?: number;
  /** 渲染安全的结构化结果投影（调试轨道展示）；工具侧负责截断上限。 */
  publicResults?: AssistantPublicToolResultView[];
  /** 工具命中并安全物化的视觉证据；引擎只把它并入本轮 user 消息，不写进历史或轨迹。 */
  images?: AiTransportImage[];
}

/**
 * 注册进引擎的工具定义。description 必须写清"何时用/何时不用/参数
 * 怎么填"（方案 §4.1），由提示词之外的第二层教学承担。
 */
export interface ReActTool<TContext = unknown> {
  name: string;
  description: string;
  /** JSON Schema；registry 做轻量必填/类型校验后原样下发给各 provider。 */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: TContext) => Promise<ReActToolExecution>;
}

type JsonSchemaLike = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
};

/** 轻量参数校验：只覆盖必填、基础类型与数组元素类型，拒绝明显畸形输入。 */
export function validateToolArguments(name: string, schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const spec = schema as JsonSchemaLike;
  if (spec.type && spec.type !== 'object') return `工具 ${name} 的参数必须是对象。`;
  const properties = spec.properties ?? {};
  for (const required of spec.required ?? []) {
    if (!(required in args) || args[required] === undefined || args[required] === null) {
      return `工具 ${name} 缺少必填参数 ${required}。`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property || value === undefined || value === null) continue;
    if (property.type === 'string' && typeof value !== 'string') return `工具 ${name} 的参数 ${key} 必须是字符串。`;
    if (property.type === 'number' && typeof value !== 'number') return `工具 ${name} 的参数 ${key} 必须是数字。`;
    if (property.type === 'boolean' && typeof value !== 'boolean') return `工具 ${name} 的参数 ${key} 必须是布尔值。`;
    if (property.type === 'array' && !Array.isArray(value)) return `工具 ${name} 的参数 ${key} 必须是数组。`;
    if (property.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return `工具 ${name} 的参数 ${key} 必须是对象。`;
    if (property.type === 'array' && Array.isArray(value)) {
      const itemSpec = (property as JsonSchemaLike & { items?: JsonSchemaLike }).items;
      if (itemSpec?.type) {
        for (const item of value) {
          const mismatch = itemSpec.type === 'string' ? typeof item !== 'string'
            : itemSpec.type === 'number' ? typeof item !== 'number'
            : false;
          if (mismatch) return `工具 ${name} 的参数 ${key} 的数组元素必须是 ${itemSpec.type}。`;
        }
      }
    }
  }
  return undefined;
}

/** 重复动作签名：工具名 + 参数归一化 JSON（方案 §3.2）。 */
export function reactToolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}::${JSON.stringify(sortPlainObject(args))}`;
}

function sortPlainObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPlainObject);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortPlainObject(source[key]);
    return sorted;
  }
  return value;
}

/**
 * 工具注册表：负责注册、查找、参数校验与 Schema 下发。引擎保持无状态，
 * 每轮由入口装配（对标 WeKnora ToolRegistry + buildToolsForLLM）。
 */
export class ReActToolRegistry<TContext = unknown> {
  private readonly tools = new Map<string, ReActTool<TContext>>();

  register(tool: ReActTool<TContext>): void {
    if (this.tools.has(tool.name)) throw new Error(`工具 ${tool.name} 重复注册。`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ReActTool<TContext> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 下发给传输层的工具 Schema 列表。 */
  schemas(): ReActToolSchema[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  validate(call: { name: string; arguments: Record<string, unknown> }): string | undefined {
    const tool = this.tools.get(call.name);
    if (!tool) return `未知工具 ${call.name}；可用工具：${this.names().join('、') || '（无）'}。`;
    return validateToolArguments(tool.name, tool.parameters, call.arguments);
  }
}
