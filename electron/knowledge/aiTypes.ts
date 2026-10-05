export interface AiInsightPayload {
  summary: string;
  keyPoints: string[];
  suggestedTags: string[];
}

export type AiProviderKind = 'ollama' | 'openai-compatible';

export type AiRemoteProviderId = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'moonshot' | 'qwen' | 'zhipu' | 'siliconflow' | 'openrouter' | 'custom';

/**
 * Wire protocol used by a generation model. Provider identity and protocol are
 * intentionally separate so multiple vendors can share one transport adapter.
 */
export type AiGenerationApi =
  | 'ollama-chat'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content';

export interface AiInsight extends AiInsightPayload {
  notePath: string;
  contentHash: string;
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
  contextWindowTokens?: number;
  contextWindowSource?: 'provider' | 'ollama';
  maxOutputTokens?: number;
  reasoning?: boolean;
}

export interface AiProviderConfig {
  kind: AiProviderKind;
  provider?: AiRemoteProviderId;
  api?: AiGenerationApi;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  /** Present only when the user explicitly set a cap in Settings. */
  contextWindowTokens?: number;
  contextWindowTokensSource?: 'user';
  embeddingModel?: string;
  availableModels?: OllamaModel[];
  remoteContentConsent?: boolean;
}

export interface AiProviderStatus {
  available: boolean;
  endpoint: string;
  models: OllamaModel[];
  message?: string;
}

export interface AiModelProfile {
  id: string;
  label: string;
  config: AiProviderConfig;
}

export type AiProviderConfigView = Omit<AiProviderConfig, 'apiKey'> & { hasApiKey: boolean };

export interface AiModelProfileView {
  id: string;
  label: string;
  config: AiProviderConfigView;
}

export interface AiModelSettings {
  schemaVersion: 1;
  defaultProfileId: string;
  profiles: AiModelProfileView[];
}

export interface AiModelSettingsInput {
  defaultProfileId: string;
  profiles: AiModelProfile[];
}

export type AiSkillGenerationStyle = 'factual' | 'balanced' | 'creative';

export interface AiSkill {
  id: string;
  name: string;
  /** Short discovery text. The full instruction is injected only after selection. */
  description: string;
  instruction: string;
  generationStyle: AiSkillGenerationStyle;
  enabled: boolean;
  system: boolean;
}

/** 目录形态技能（AI-Skill/<name>/SKILL.md）的管理状态，按 frontmatter name 记录。 */
export interface DirectorySkillOverride {
  enabled: boolean;
  /** 通过应用导入时记录的时间（ISO）；用户手动放置的技能没有该字段。 */
  importedAt?: string;
}

export interface AiExtensionsSettings {
  schemaVersion: 1;
  skills: AiSkill[];
  /** 目录技能启停/来源登记；字段缺省或名字不在表中时视为启用。 */
  directorySkillOverrides?: Record<string, DirectorySkillOverride>;
}

export type AiSkillImportKind = 'folder' | 'zip' | 'markdown';

export interface SkillImportResult {
  ok: boolean;
  skillName?: string;
  resourceFileCount?: number;
  /** 面向用户的中文失败原因；ok 为 false 时存在（用户取消对话框除外）。 */
  error?: string;
}

export interface SkillFormCreateInput {
  name: string;
  description: string;
  instruction: string;
}

export interface SkillDocumentUpdateResult {
  ok: boolean;
  error?: string;
}

export interface SkillExportResult {
  ok: boolean;
  /** 用户在保存对话框中取消时为 true，不视为错误。 */
  canceled?: boolean;
  error?: string;
}

export interface DirectorySkillOverviewEntry {
  name: string;
  description: string;
  /** SKILL.md 正文（供设置页查看；与 read_skill 加载内容一致）。 */
  instruction: string;
  /** 技能目录内附加文本文件数量。 */
  resourceFileCount: number;
  enabled: boolean;
  system: boolean;
  importedAt?: string;
}

export interface DirectorySkillIssue {
  directory: string;
  reason: string;
}

/** 设置页「AI 助手技能」的目录技能总览（loadDirectorySkills + store 登记状态投影）。 */
export interface AiSkillsOverview {
  directorySkills: DirectorySkillOverviewEntry[];
  /** 校验失败/超限未加载的目录技能。 */
  skipped: DirectorySkillIssue[];
  /** 与设置技能重名而被放弃并入的目录技能（运行期不生效）。 */
  nameConflicts: DirectorySkillIssue[];
}

export interface AssistantAiOptions {
  profiles: Array<Pick<AiModelProfileView, 'id' | 'label'> & { kind: AiProviderKind; provider?: AiRemoteProviderId; model?: string; contextWindowTokens?: number }>;
  skills: Array<Pick<AiSkill, 'id' | 'name' | 'description' | 'enabled' | 'system'>>;
  defaultProfileId: string;
}
