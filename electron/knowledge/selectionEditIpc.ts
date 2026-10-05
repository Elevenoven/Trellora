import { selectionEditActions, selectionEditContextScopes, type SelectionEditAction, type SelectionEditContextScope } from './selectionEditTypes';
import type { SelectionTransformContext, SelectionTransformResult } from './selectionTransformTypes';
import { assertSelectionEditWordLimit } from '../../shared/selectionEditLimits';
import type { SelectionLocatorCapture } from '../../shared/selectionLocatorTypes';
import { validateSelectionLocatorCapture } from './selectionEditLocator';

export { MAX_SELECTION_EDIT_WORDS, countSelectionEditWords } from '../../shared/selectionEditLimits';

const maxContextCharacters = 400;
const maxLanguageCharacters = 60;
const maxInstructionCharacters = 500;
const maxRequestIdCharacters = 128;

/**
 * Renderer-facing SE-7 transport. It deliberately exposes an editing intent,
 * not a source snapshot or model choice: Electron owns both boundaries.
 */
export interface SelectionEditRunRequest {
  requestId: string;
  action: SelectionEditAction;
  selectedText: string;
  context?: SelectionTransformContext;
  targetLanguage?: string;
  customInstruction?: string;
  currentPath?: string;
  contextScope: SelectionEditContextScope;
  selectionLocator?: SelectionLocatorCapture;
  expectedContentHash?: string;
}

/** The lightweight launcher needs only an apply-safe result projection. */
export type SelectionEditRunResult = SelectionTransformResult;

export const selectionEditRuntimeModes = ['unified', 'legacy'] as const;
export type SelectionEditRuntimeMode = typeof selectionEditRuntimeModes[number];

export function resolveSelectionEditRuntimeMode(
  rawMode = process.env.MENGHAN_SELECTION_EDIT_MODE,
): SelectionEditRuntimeMode {
  return selectionEditRuntimeModes.includes(rawMode as SelectionEditRuntimeMode)
    ? rawMode as SelectionEditRuntimeMode
    : 'unified';
}

export function validateSelectionEditRunRequest(value: unknown): SelectionEditRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('统一 AI 编辑请求格式无效。');
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'requestId',
    'action',
    'selectedText',
    'context',
    'targetLanguage',
    'customInstruction',
    'currentPath',
    'contextScope',
    'selectionLocator',
    'expectedContentHash',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`统一 AI 编辑请求包含不支持的字段：${key}。`);
  }

  const requestId = readString(input.requestId, '请求标识', maxRequestIdCharacters);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId)) throw new Error('请求标识格式无效。');
  if (typeof input.action !== 'string' || !selectionEditActions.includes(input.action as SelectionEditAction)) {
    throw new Error('不支持的 AI 编辑动作。');
  }
  const action = input.action as SelectionEditAction;
  const selectedText = readString(input.selectedText, '选中文字');
  if (!selectedText.trim()) throw new Error('请先选择要编辑的文字。');
  assertSelectionEditWordLimit(selectedText);
  const context = readContext(input.context);
  const targetLanguage = input.targetLanguage === undefined ? undefined : readString(input.targetLanguage, '目标语言', maxLanguageCharacters);
  const customInstruction = input.customInstruction === undefined
    ? undefined
    : readString(input.customInstruction, '自定义要求', maxInstructionCharacters);
  const currentPath = input.currentPath === undefined ? undefined : readString(input.currentPath, '当前笔记路径', 4_096);
  const contextScope = input.contextScope === undefined ? 'auto' : readContextScope(input.contextScope);
  const selectionLocator = validateSelectionLocatorCapture(input.selectionLocator);
  const expectedContentHash = input.expectedContentHash === undefined ? undefined : readString(input.expectedContentHash, '内容哈希', 64);
  if (expectedContentHash !== undefined && !/^[a-f0-9]{64}$/u.test(expectedContentHash)) throw new Error('内容哈希格式无效。');

  if (action === 'translate' && !targetLanguage?.trim()) throw new Error('翻译需要指定目标语言。');
  if (action === 'custom' && !customInstruction?.trim()) throw new Error('自定义编辑需要填写要求。');
  if (action !== 'translate' && targetLanguage) throw new Error('只有翻译操作可以指定目标语言。');
  if (action !== 'custom' && customInstruction) throw new Error('只有自定义操作可以填写编辑要求。');

  return {
    requestId,
    action,
    selectedText,
    ...(context ? { context } : {}),
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(customInstruction ? { customInstruction } : {}),
    ...(currentPath ? { currentPath } : {}),
    contextScope,
    ...(selectionLocator ? { selectionLocator } : {}),
    ...(expectedContentHash ? { expectedContentHash } : {}),
  };
}

function readContext(value: unknown): SelectionTransformContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上下文格式无效。');
  const record = value as Record<string, unknown>;
  const before = readString(record.before ?? '', '前文', maxContextCharacters);
  const after = readString(record.after ?? '', '后文', maxContextCharacters);
  if (before.length + after.length > maxContextCharacters) throw new Error('相邻上下文不能超过 400 字。');
  return before || after ? { before, after } : undefined;
}

function readContextScope(value: unknown): SelectionEditContextScope {
  if (typeof value === 'string' && selectionEditContextScopes.includes(value as SelectionEditContextScope)) {
    return value as SelectionEditContextScope;
  }
  throw new Error('上下文范围无效。');
}

function readString(value: unknown, label: string, maxLength?: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (maxLength !== undefined && value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}
