import {
  SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS,
  SELECTION_EXPANSION_MAX_TARGET_CHARACTERS,
  SELECTION_EXPANSION_MIN_TARGET_CHARACTERS,
  selectionExpansionAudiences,
  selectionExpansionCapabilityModes,
  selectionExpansionCitationModes,
  selectionExpansionLengthRatios,
  selectionExpansionReasoningDepths,
  selectionExpansionStyles,
  type SelectionExpansionCapabilities,
  type SelectionExpansionCapabilityMode,
  type SelectionExpansionSettings,
  type SelectionExpansionSettingsPatch,
  type SelectionExpansionSourceSettings,
  type SelectionExpansionTargetLength,
} from './selectionExpansionTypes';

interface SettingsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const settingsStoreKey = 'selectionExpansionSettings';
export const selectionExpansionSettingsSchemaVersion = 2;

export const defaultSelectionExpansionSettings: SelectionExpansionSettings = {
  schemaVersion: selectionExpansionSettingsSchemaVersion,
  targetLength: { mode: 'ratio', ratio: 1.8 },
  style: 'preserve',
  audience: 'preserve',
  reasoningDepth: 'standard',
  sources: {
    currentNote: true,
    noteLibrary: false,
    materialsLibrary: false,
    web: 'off',
    personalization: false,
  },
  citationMode: 'source-cards',
  customInstruction: '',
};

export function readSelectionExpansionSettings(store: SettingsStore): SelectionExpansionSettings {
  const rawValue = store.get(settingsStoreKey);
  const settings = normalizeSelectionExpansionSettings(rawValue);
  // SE-7: old defaults may predate source switches and schemaVersion. Persist
  // the normalized v2 shape once, so later reads are deterministic and
  // migration is idempotent rather than merely a tolerant display fallback.
  if (rawValue !== undefined && JSON.stringify(rawValue) !== JSON.stringify(settings)) {
    store.set(settingsStoreKey, settings);
  }
  return settings;
}

export function saveSelectionExpansionSettings(
  store: SettingsStore,
  patch: unknown,
  capabilities: SelectionExpansionCapabilities,
): SelectionExpansionSettings {
  const current = readSelectionExpansionSettings(store);
  const next = applySelectionExpansionSettingsPatch(current, patch);
  assertSelectionExpansionSettingsSupported(next, capabilities);
  store.set(settingsStoreKey, next);
  return next;
}

/** 容错读取旧值；外部保存请求始终走严格 patch 校验。 */
export function normalizeSelectionExpansionSettings(value: unknown): SelectionExpansionSettings {
  try {
    return applySelectionExpansionSettingsPatch(defaultSelectionExpansionSettings, value ?? {});
  } catch {
    return { ...defaultSelectionExpansionSettings, sources: { ...defaultSelectionExpansionSettings.sources } };
  }
}

export function resolveSelectionExpansionCapabilities(
  rawMode = process.env.MENGHAN_SELECTION_EXPANSION_MODE,
): SelectionExpansionCapabilities {
  const mode: SelectionExpansionCapabilityMode = selectionExpansionCapabilityModes.includes(rawMode as SelectionExpansionCapabilityMode)
    ? rawMode as SelectionExpansionCapabilityMode
    : 'current-note';
  const enabled = mode !== 'off';
  const localSourcesEnabled = mode === 'local-sources' || mode === 'full';
  const se6SourcesEnabled = mode === 'full';
  return {
    mode,
    enabled,
    sources: {
      currentNote: enabled,
      // SE-5：只有显式 local-sources/full 灰度才公开已接入的本地扩展来源。
      noteLibrary: enabled && localSourcesEnabled,
      materialsLibrary: enabled && localSourcesEnabled,
      // SE-6：网页与个性化只能在 full 灰度中逐项显式打开。
      web: enabled && se6SourcesEnabled,
      personalization: enabled && se6SourcesEnabled,
    },
    limits: {
      maxSelectedCharacters: 20_000,
      minTargetCharacters: SELECTION_EXPANSION_MIN_TARGET_CHARACTERS,
      maxTargetCharacters: SELECTION_EXPANSION_MAX_TARGET_CHARACTERS,
      maxCustomInstructionCharacters: SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS,
    },
  };
}

export function assertSelectionExpansionSettingsSupported(
  settings: SelectionExpansionSettings,
  capabilities: SelectionExpansionCapabilities,
): void {
  if (!capabilities.enabled) throw new Error('选区扩写优化尚未启用。');
  if (settings.sources.currentNote && !capabilities.sources.currentNote) throw new Error('当前笔记证据来源尚未启用。');
  if (settings.sources.noteLibrary && !capabilities.sources.noteLibrary) throw new Error('同库 Markdown 证据来源尚未启用。');
  if (settings.sources.materialsLibrary && !capabilities.sources.materialsLibrary) throw new Error('资料库证据来源尚未启用。');
  if (settings.sources.web !== 'off' && !capabilities.sources.web) throw new Error('联网证据来源尚未启用。');
  if (settings.sources.personalization && !capabilities.sources.personalization) throw new Error('个性化用词来源尚未启用。');
  if (!settings.sources.currentNote && !settings.sources.noteLibrary && !settings.sources.materialsLibrary) {
    throw new Error('至少需要启用一个本地证据来源。');
  }
}

/** 主进程用于验证一次任务草稿；不会写入默认设置。 */
export function validateSelectionExpansionSettings(
  value: unknown,
  capabilities: SelectionExpansionCapabilities,
): SelectionExpansionSettings {
  const settings = applySelectionExpansionSettingsPatch(defaultSelectionExpansionSettings, value);
  assertSelectionExpansionSettingsSupported(settings, capabilities);
  return settings;
}

function applySelectionExpansionSettingsPatch(
  current: SelectionExpansionSettings,
  value: unknown,
): SelectionExpansionSettings {
  if (!isRecord(value)) throw new Error('扩写设置格式无效。');
  const allowedKeys = new Set([
    'schemaVersion',
    'targetLength',
    'style',
    'audience',
    'reasoningDepth',
    'modelProfileId',
    'sources',
    'citationMode',
    'customInstruction',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`扩写设置包含不支持的字段：${key}。`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== selectionExpansionSettingsSchemaVersion) {
    throw new Error('扩写设置版本不兼容。');
  }
  const patch = value as SelectionExpansionSettingsPatch;
  const modelProfileId = patch.modelProfileId === undefined
    ? current.modelProfileId
    : patch.modelProfileId === null
      ? undefined
      : readBoundedString(patch.modelProfileId, '模型档案标识', 160);
  return {
    schemaVersion: selectionExpansionSettingsSchemaVersion,
    targetLength: patch.targetLength === undefined ? current.targetLength : parseTargetLength(patch.targetLength),
    style: patch.style === undefined ? current.style : readEnum(patch.style, selectionExpansionStyles, '写作风格'),
    audience: patch.audience === undefined ? current.audience : readEnum(patch.audience, selectionExpansionAudiences, '目标读者'),
    reasoningDepth: patch.reasoningDepth === undefined ? current.reasoningDepth : readEnum(patch.reasoningDepth, selectionExpansionReasoningDepths, '思考强度'),
    ...(modelProfileId ? { modelProfileId } : {}),
    sources: patch.sources === undefined ? { ...current.sources } : parseSources(current.sources, patch.sources),
    citationMode: patch.citationMode === undefined ? current.citationMode : readEnum(patch.citationMode, selectionExpansionCitationModes, '引用展示'),
    customInstruction: patch.customInstruction === undefined
      ? current.customInstruction
      : readBoundedString(patch.customInstruction, '自定义要求', SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS),
  };
}

function parseTargetLength(value: unknown): SelectionExpansionTargetLength {
  if (!isRecord(value)) throw new Error('目标长度格式无效。');
  if (value.mode === 'ratio') {
    if (!selectionExpansionLengthRatios.includes(value.ratio as typeof selectionExpansionLengthRatios[number])) {
      throw new Error('目标长度比例无效。');
    }
    return { mode: 'ratio', ratio: value.ratio as typeof selectionExpansionLengthRatios[number] };
  }
  if (value.mode === 'characters') {
    if (typeof value.characters !== 'number' || !Number.isInteger(value.characters)
      || value.characters < SELECTION_EXPANSION_MIN_TARGET_CHARACTERS
      || value.characters > SELECTION_EXPANSION_MAX_TARGET_CHARACTERS) {
      throw new Error(`自定义目标字符数必须在 ${SELECTION_EXPANSION_MIN_TARGET_CHARACTERS} 到 ${SELECTION_EXPANSION_MAX_TARGET_CHARACTERS} 之间。`);
    }
    return { mode: 'characters', characters: value.characters };
  }
  throw new Error('目标长度模式无效。');
}

function parseSources(current: SelectionExpansionSourceSettings, value: unknown): SelectionExpansionSourceSettings {
  if (!isRecord(value)) throw new Error('证据范围格式无效。');
  const allowedKeys = new Set(['currentNote', 'noteLibrary', 'materialsLibrary', 'web', 'personalization']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`证据范围包含不支持的字段：${key}。`);
  }
  const readBoolean = (key: keyof Pick<SelectionExpansionSourceSettings, 'currentNote' | 'noteLibrary' | 'materialsLibrary' | 'personalization'>) => {
    const next = value[key];
    if (next === undefined) return current[key];
    if (typeof next !== 'boolean') throw new Error(`证据范围“${key}”必须为布尔值。`);
    return next;
  };
  const web = value.web === undefined ? current.web : readEnum(value.web, ['off', 'inherit', 'on'] as const, '联网范围');
  const personalization = value.personalization === undefined ? current.personalization : readBoolean('personalization');
  return {
    currentNote: readBoolean('currentNote'),
    noteLibrary: readBoolean('noteLibrary'),
    materialsLibrary: readBoolean('materialsLibrary'),
    web,
    personalization,
  };
}

function readEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label}无效。`);
  return value as T[number];
}

function readBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
