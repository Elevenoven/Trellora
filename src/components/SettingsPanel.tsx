import { getAppLanguage, localizeOptions, t, useI18n } from '../i18n';
import CapabilityPanel from './CapabilityPanel';
import ReleaseCheck from './ReleaseCheck';
import FirstRunGuide from './onboarding/FirstRunGuide';
import type { OnboardingModelDraft } from './onboarding/OnboardingGuide';
import type { ModelConfigurationChange, ModelProviderCatalogDraft } from '../../shared/modelConfiguration';
import { ModelConfigurationSaveCancelled } from './settings/useModelConfigurationSave';
import WorkspaceBackupSettings from './WorkspaceBackupSettings';
import WorkspaceRestoreSettings from './WorkspaceRestoreSettings';
import './settings/WorkspaceSettings.css';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Alert, Accordion, Badge, Box, Button, Checkbox, Code, Divider, Group, Menu, Modal, NumberInput, Pagination, Paper, PasswordInput, ScrollArea, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, Textarea, TextInput, ThemeIcon, Transition, UnstyledButton } from '@mantine/core';
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, Cloud, Database, ExternalLink, FileText, Filter, FolderOpen, Github, Globe, Info, KeyRound, Monitor, Moon, Plus, RefreshCw, Rows3, Rows4, ScanText, Settings2, ShieldCheck, Sparkles, Sun, Trash2, UserRound } from 'lucide-react';
import type { AiExtensionsSettings, AiGenerationApi, AiModelProfile, AiModelSettings, AiModelSettingsInput, AiProviderConfig, AiProviderStatus, AiRemoteProviderId, AiSkillGenerationStyle, AiSkillImportKind, AiSkillsOverview, AppDiagnostics, AppPreferences, ModelHub, ModelSlotId, ParsingConfig, RemoteProviderModelsResult, SelectionExpansionSettings, WebSearchConfig, WebSearchConfigView, WebSearchProviderId, WebSearchProviderRequirement } from '../electron';
import type { ResolvedTheme } from '../utils/theme';
import { selectEmbeddingModelNames } from '../utils/embeddingModelOptions';
import { getDefaultModelProfileLabel, isGeneratedModelProfileLabel } from '../../shared/modelProfileLabel';
import { resolveEffectiveContextWindow } from '../../shared/effectiveContextWindow';
import { NOTE_BACKUP_RETENTION } from '../../shared/noteBackup';
import { APP_INFO } from '../../shared/appInfo';
import BrandMark from './BrandMark';
import ProviderIcon from './ProviderIcon';
import ProviderSelect from './ProviderSelect';
import { UserInformationSettings } from './settings/UserInformationSettings';
import LightColorSchemePicker from './settings/LightColorSchemePicker';
import EditorPreferencesSettings from './settings/EditorPreferencesSettings';

export type SettingsSection = 'general' | 'library' | 'editor' | 'user-information' | 'parsing' | 'web-search' | 'ai-writing' | 'model' | 'skills' | 'about';
type ModelSettingsTab = 'profiles' | 'config' | 'add';

/** Compared only in renderer memory; keys never enter guide state or logs. */
function modelDraftKey(config: AiProviderConfig): string {
  return JSON.stringify([config.kind, config.provider, config.api, config.endpoint?.trim(), config.model?.trim(), config.apiKey?.trim() || '', Boolean(config.remoteContentConsent), config.contextWindowTokens]);
}
const SKILL_LIBRARY_PAGE_SIZE = 5;

type SkillLibraryRow =
  | { kind: 'settings'; key: string; skill: AiExtensionsSettings['skills'][number] }
  | { kind: 'directory'; key: string; skill: AiSkillsOverview['directorySkills'][number] };

const skillGenerationStyleOptions: Array<{ value: AiSkillGenerationStyle; label: string }> = [
  { value: 'factual', label: '事实优先' },
  { value: 'balanced', label: '均衡表达' },
  { value: 'creative', label: '创意发散' },
];

const contextWindowPresetTokens = [16_384, 32_768, 65_536, 131_072, 262_144] as const;

type ConfiguredModelRow = {
  id: string;
  category: ModelSlotId;
  name: string;
  provider: string;
  providerId: string;
  model: string;
  isDefault: boolean;
};

interface SettingsPanelProps {
  guidedModel?: boolean;
  onOnboardingModelDraft?: (draft: OnboardingModelDraft) => void;
  onOpenOnboarding: () => void;
  initialSection: SettingsSection;
  sectionRequestId?: number;
  memoryReviewRequest?: { itemId: string; requestId: number };
  preferences: AppPreferences;
  resolvedTheme: ResolvedTheme;
  workspacePath: string | null;
  workspaceError: string | null;
  aiConfig: AiProviderConfig;
  aiModelSettings: AiModelSettings;
  aiExtensionsSettings: AiExtensionsSettings;
  modelHub: ModelHub;
  onClose: () => void;
  onAddLibrary: () => void;
  onSelectWorkspace: () => Promise<void>;
  onOpenWorkspace: () => Promise<void>;
  onWorkspaceDataChanged: () => Promise<void>;
  onSavePreferences: (patch: Partial<Omit<AppPreferences, 'schemaVersion'>>) => Promise<void>;
  onSaveAiModelSettings: (settings: AiModelSettingsInput) => Promise<AiModelSettings>;
  onSaveAiExtensionsSettings: (settings: AiExtensionsSettings) => Promise<void>;
  onFetchModelProviderModels: (id: string, draft?: ModelProviderCatalogDraft) => Promise<{ result: RemoteProviderModelsResult; hub: ModelHub }>;
  onSaveModelConfiguration: (change: ModelConfigurationChange) => Promise<ModelHub>;
}

const sections: Array<{ id: SettingsSection; label: string; group: string; icon: typeof Settings2 }> = [
  { id: 'general', label: '通用', group: '工作区配置', icon: Settings2 },
  { id: 'library', label: '工作区与备份', group: '工作区配置', icon: Database },
  { id: 'editor', label: '编辑器', group: '工作区配置', icon: FileText },
  { id: 'parsing', label: '文档解析', group: '文档处理', icon: ScanText },
  { id: 'web-search', label: '联网搜索', group: 'AI 设置', icon: Globe },
  { id: 'ai-writing', label: '选区扩写优化', group: 'AI 设置', icon: Sparkles },
  { id: 'model', label: '模型配置', group: 'AI 设置', icon: Bot },
  { id: 'skills', label: 'AI 助手技能', group: 'AI 设置', icon: Sparkles },
  { id: 'user-information', label: '个性化', group: 'AI 设置', icon: UserRound },
  { id: 'about', label: '关于与诊断', group: '系统', icon: Info },
];

const MODEL_PROFILE_PAGE_SIZE = 5;

const remoteProviders: Array<{ value: AiRemoteProviderId; label: string; endpoint: string; api: Exclude<AiGenerationApi, 'ollama-chat'>; embeddingPresets: string[] }> = [
  { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', api: 'openai-responses', embeddingPresets: ['text-embedding-3-small', 'text-embedding-3-large'] },
  { value: 'anthropic', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com', api: 'anthropic-messages', embeddingPresets: [] },
  { value: 'google', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generate-content', embeddingPresets: [] },
  { value: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', embeddingPresets: [] },
  { value: 'moonshot', label: 'Moonshot AI', endpoint: 'https://api.moonshot.cn/v1', api: 'openai-completions', embeddingPresets: [] },
  { value: 'qwen', label: '通义千问（百炼）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', embeddingPresets: ['text-embedding-v3', 'text-embedding-v2'] },
  { value: 'zhipu', label: '智谱 AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', embeddingPresets: ['embedding-3'] },
  { value: 'siliconflow', label: 'SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1', api: 'openai-completions', embeddingPresets: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'] },
  { value: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', embeddingPresets: [] },
  { value: 'custom', label: '自定义 OpenAI 兼容 API', endpoint: '', api: 'openai-completions', embeddingPresets: [] },
];

export default function SettingsPanel({
  guidedModel,
  onOnboardingModelDraft,
  onOpenOnboarding,
  initialSection,
  sectionRequestId,
  memoryReviewRequest,
  preferences,
  resolvedTheme,
  workspacePath,
  workspaceError,
  aiConfig,
  aiModelSettings,
  aiExtensionsSettings,
  modelHub,
  onClose,
  onSelectWorkspace,
  onOpenWorkspace,
  onWorkspaceDataChanged,
  onSavePreferences,
  onSaveAiModelSettings,
  onSaveAiExtensionsSettings,
  onFetchModelProviderModels,
  onSaveModelConfiguration,
}: SettingsPanelProps) {
  useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draftPreferences, setDraftPreferences] = useState(preferences);
  const [draftAi, setDraftAi] = useState(aiConfig);
  const [draftModelSettings, setDraftModelSettings] = useState<AiModelSettings>(aiModelSettings);
  const [draftModelHub, setDraftModelHub] = useState<ModelHub>(modelHub);
  const [selectedProfileId, setSelectedProfileId] = useState(aiModelSettings.defaultProfileId);
  const [modelProfilePage, setModelProfilePage] = useState(1);
  const [modelSettingsTab, setModelSettingsTab] = useState<ModelSettingsTab>(guidedModel ? 'config' : 'profiles');
  const [modelCategory, setModelCategory] = useState<ModelSlotId>('generation');
  const [draftExtensions, setDraftExtensions] = useState<AiExtensionsSettings>(aiExtensionsSettings);
  const [aiStatus, setAiStatus] = useState<AiProviderStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [draftParsing, setDraftParsing] = useState<ParsingConfig | null>(null);
  const [mineruKeyInput, setMineruKeyInput] = useState('');
  const [isSavingParsing, setIsSavingParsing] = useState(false);
  const [draftWebSearch, setDraftWebSearch] = useState<WebSearchConfigView | null>(null);
  const [draftSelectionExpansion, setDraftSelectionExpansion] = useState<SelectionExpansionSettings | null>(null);
  const [webSearchKeyPatches, setWebSearchKeyPatches] = useState<Partial<Record<WebSearchProviderId, string>>>({});
  const [webSearchEditor, setWebSearchEditor] = useState<{ providerId: WebSearchProviderId | null; isNew: boolean } | null>(null);
  const [editorKeyInput, setEditorKeyInput] = useState('');
  const [editorUrlInput, setEditorUrlInput] = useState('');
  const [editorExtras, setEditorExtras] = useState<Record<string, string>>({});
  const [isSavingWebSearch, setIsSavingWebSearch] = useState(false);
  const [isSavingSelectionExpansion, setIsSavingSelectionExpansion] = useState(false);
  const [isTestingWebSearch, setIsTestingWebSearch] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingLanguage, setIsSavingLanguage] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [viewingSkillId, setViewingSkillId] = useState<string | null>(null);
  const [savingSkillId, setSavingSkillId] = useState<string | null>(null);
  const [skillsOverview, setSkillsOverview] = useState<AiSkillsOverview | null>(null);
  const [skillLibraryPage, setSkillLibraryPage] = useState(1);
  const [viewingDirectoryName, setViewingDirectoryName] = useState<string | null>(null);
  const [importingSkill, setImportingSkill] = useState(false);
  const [editingDirectoryName, setEditingDirectoryName] = useState<string | null>(null);
  const [editingSkillDescription, setEditingSkillDescription] = useState('');
  const [editingSkillInstruction, setEditingSkillInstruction] = useState('');
  const [savingDirectorySkill, setSavingDirectorySkill] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customGenerationModel, setCustomGenerationModel] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDescription, setNewSkillDescription] = useState('');
  const [newSkillInstruction, setNewSkillInstruction] = useState('');
  const settingsInitializedRef = useRef(false);
  const draftPreferencesRef = useRef(preferences);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPreferenceKeysRef = useRef(new Map<keyof AppPreferences, number>());
  const [settledPreferenceSaves, setSettledPreferenceSaves] = useState(0);
  const appearanceSaveSequenceRef = useRef(0);
  const savedDraftKeys = useRef(new Map(aiModelSettings.profiles.map(profile => [profile.id, modelDraftKey(profile.config)])));
  const draftKey = modelDraftKey(draftAi);
  const liveDraft = useRef({ profileId: selectedProfileId, key: draftKey });
  const previousDraft = useRef({ profileId: selectedProfileId, key: draftKey });
  useLayoutEffect(() => { liveDraft.current = { profileId: selectedProfileId, key: draftKey }; }, [draftKey, selectedProfileId]);

  // Edits invalidate proof and late test responses; a saved-key redaction is exempt.
  useEffect(() => {
    const previous = previousDraft.current;
    previousDraft.current = { profileId: selectedProfileId, key: draftKey };
    if (previous.profileId === selectedProfileId && previous.key !== draftKey) {
      setAiStatus(null);
      void window.electronAPI.invalidateOnboardingConnection(selectedProfileId).catch(() => undefined);
    }
  }, [draftKey, selectedProfileId]);
  useEffect(() => {
    onOnboardingModelDraft?.({ profileId: selectedProfileId, dirty: savedDraftKeys.current.get(selectedProfileId) !== draftKey, busy: isTesting || isSaving || isFetchingModels });
  }, [draftKey, isFetchingModels, isSaving, isTesting, onOnboardingModelDraft, selectedProfileId]);

  useEffect(() => {
    if (settingsInitializedRef.current) return;
    settingsInitializedRef.current = true;
    setSection(initialSection);
    draftPreferencesRef.current = preferences;
    setDraftPreferences(preferences);
    const selected = aiModelSettings.profiles.find((profile) => profile.id === aiModelSettings.defaultProfileId) ?? aiModelSettings.profiles[0];
    setDraftModelSettings(aiModelSettings);
    setDraftModelHub(modelHub);
    setSelectedProfileId(selected?.id ?? '');
    setModelProfilePage(1);
    setModelSettingsTab(guidedModel ? 'config' : 'profiles');
    setModelCategory('generation');
    setDraftAi({ ...(selected?.config ?? aiConfig), apiKey: '', availableModels: selected?.config.availableModels ?? aiConfig.availableModels ?? [] });
    setDraftExtensions(aiExtensionsSettings);
    setCustomGenerationModel(false);
    setFeedback(null);
    setError(null);
    void Promise.all([
      window.electronAPI.getAiStatus().then(setAiStatus),
      window.electronAPI.getAppDiagnostics().then(setDiagnostics),
      window.electronAPI.getParsingConfig().then(setDraftParsing),
      window.electronAPI.getWebSearchConfig().then(setDraftWebSearch),
      window.electronAPI.getSelectionExpansionSettings().then(setDraftSelectionExpansion),
      window.electronAPI.getAiSkillsOverview().then(setSkillsOverview).catch(() => undefined),
    ]);
  }, [aiConfig, aiExtensionsSettings, aiModelSettings, guidedModel, initialSection, modelHub, preferences]);

  // 页面缓存后仍需响应来自其它入口（例如资料页“配置模型”）的目标分区。
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection, sectionRequestId]);

  // Cached settings must follow toolbar/import changes without overwriting queued drafts.
  useLayoutEffect(() => {
    setDraftPreferences(current => {
      const next = { ...current };
      let changed = false;
      for (const key of Object.keys(preferences) as Array<keyof AppPreferences>) {
        if (!pendingPreferenceKeysRef.current.has(key) && current[key] !== preferences[key]) {
          Object.assign(next, { [key]: preferences[key] }); changed = true;
        }
      }
      draftPreferencesRef.current = changed ? next : current;
      return changed ? next : current;
    });
  }, [preferences, settledPreferenceSaves]);

  useEffect(() => {
    if (!guidedModel) return;
    setSection('model'); setModelCategory('generation'); setModelSettingsTab('config');
  }, [guidedModel]);

  useEffect(() => {
    if (!feedback && !error) return undefined;
    const timeout = window.setTimeout(() => {
      setFeedback(null);
      setError(null);
    }, 2_400);
    return () => window.clearTimeout(timeout);
  }, [error, feedback]);

  const selectedProfile = useMemo(() => draftModelSettings.profiles.find((profile) => profile.id === selectedProfileId) ?? draftModelSettings.profiles[0], [draftModelSettings.profiles, selectedProfileId]);

  const skillLibraryRows = useMemo(() => {
    const rows: SkillLibraryRow[] = [
      ...draftExtensions.skills.map((skill) => ({ kind: 'settings' as const, key: `settings:${skill.id}`, skill })),
      ...(skillsOverview?.directorySkills ?? []).map((skill) => ({ kind: 'directory' as const, key: `directory:${skill.name}`, skill })),
    ];
    return rows;
  }, [draftExtensions.skills, skillsOverview?.directorySkills]);
  const skillLibraryPageCount = Math.max(1, Math.ceil(skillLibraryRows.length / SKILL_LIBRARY_PAGE_SIZE));
  const currentSkillLibraryPage = Math.min(skillLibraryPage, skillLibraryPageCount);
  const visibleSkillLibraryRows = skillLibraryRows.slice((currentSkillLibraryPage - 1) * SKILL_LIBRARY_PAGE_SIZE, currentSkillLibraryPage * SKILL_LIBRARY_PAGE_SIZE);

  useEffect(() => {
    setSkillLibraryPage((current) => Math.min(current, skillLibraryPageCount));
  }, [skillLibraryPageCount]);

  const modelNames = useMemo(() => {
    const names = aiStatus?.models.map((model) => model.name) ?? draftAi.availableModels?.map((model) => model.name) ?? [];
    return Array.from(new Set(names));
  }, [aiStatus?.models, draftAi.availableModels]);

  const contextWindowPreview = useMemo(() => {
    const model = draftAi.model?.trim() ?? '';
    const liveMetadata = aiStatus?.models.find((entry) => entry.name.trim() === model);
    const storedMetadata = draftAi.availableModels?.find((entry) => entry.name.trim() === model);
    return resolveEffectiveContextWindow({
      providerId: draftAi.kind === 'ollama' ? 'ollama' : draftAi.provider ?? 'custom',
      modelId: model,
      discoveredModelWindow: liveMetadata?.contextWindowTokens,
      discoveredSource: draftAi.kind === 'ollama' ? 'ollama' : 'provider',
      configuredModelWindow: draftAi.contextWindowTokensSource === 'user' ? draftAi.contextWindowTokens : undefined,
      knownModelWindow: storedMetadata?.contextWindowTokens,
      modelMaxOutputTokens: liveMetadata?.maxOutputTokens ?? storedMetadata?.maxOutputTokens,
    });
  }, [aiStatus?.models, draftAi.availableModels, draftAi.contextWindowTokens, draftAi.contextWindowTokensSource, draftAi.kind, draftAi.model, draftAi.provider]);

  const configuredModelRows = useMemo<ConfiguredModelRow[]>(() => [
    ...draftModelSettings.profiles.flatMap((profile) => profile.config.model ? [{
      id: profile.id,
      category: 'generation' as const,
      name: profile.label || '未命名连接',
      provider: profile.config.kind === 'ollama' ? '本地 Ollama' : remoteProviders.find((provider) => provider.value === profile.config.provider)?.label ?? '远程 API',
      providerId: profile.config.kind === 'ollama' ? 'ollama' : profile.config.provider ?? 'custom',
      model: profile.config.model,
      isDefault: profile.id === draftModelSettings.defaultProfileId,
    }] : []),
    ...(['embedding', 'rerank'] as const).flatMap((category) => {
      const slot = draftModelHub.slots[category];
      if (slot.source === 'none' || !slot.model) return [];
      return [{
        id: `model-hub:${category}`,
        category,
        name: getModelCategoryLabel(category),
        provider: slot.source === 'ollama' ? '本地 Ollama' : draftModelHub.providers.find((provider) => provider.id === slot.source)?.label ?? '远程 API',
        providerId: slot.source,
        model: slot.model,
        isDefault: false,
      }];
    }),
  ], [draftModelHub, draftModelSettings]);
  const modelProfilePageCount = Math.max(1, Math.ceil(configuredModelRows.length / MODEL_PROFILE_PAGE_SIZE));
  const visibleConfiguredModels = useMemo(() => {
    const start = (modelProfilePage - 1) * MODEL_PROFILE_PAGE_SIZE;
    return configuredModelRows.slice(start, start + MODEL_PROFILE_PAGE_SIZE);
  }, [configuredModelRows, modelProfilePage]);

  useEffect(() => {
    setModelProfilePage((current) => Math.max(1, Math.min(current, modelProfilePageCount)));
  }, [modelProfilePageCount]);

  const selectedRemoteProvider = useMemo<AiRemoteProviderId>(() => {
    if (draftAi.provider) return draftAi.provider;
    return remoteProviders.find((provider) => provider.endpoint && provider.endpoint === draftAi.endpoint)?.value ?? 'custom';
  }, [draftAi.endpoint, draftAi.provider]);

  const selectRemoteProvider = (providerId: AiRemoteProviderId) => {
    const provider = remoteProviders.find((item) => item.value === providerId) ?? remoteProviders[remoteProviders.length - 1];
    const providerChanged = provider.value !== selectedRemoteProvider;
    setDraftAi({ ...draftAi, provider: provider.value, api: provider.api, endpoint: provider.endpoint, model: '', contextWindowTokens: undefined, contextWindowTokensSource: undefined, availableModels: [], ...(providerChanged ? { apiKey: '', hasApiKey: false } : {}) });
    setAiStatus(null);
    setFeedback(null);
    setError(null);
  };

  const selectProfile = (profileId: string) => {
    const profile = draftModelSettings.profiles.find((entry) => entry.id === profileId);
    if (!profile) return;
    const profileIndex = configuredModelRows.findIndex((entry) => entry.category === 'generation' && entry.id === profileId);
    if (profileIndex >= 0) setModelProfilePage(Math.floor(profileIndex / MODEL_PROFILE_PAGE_SIZE) + 1);
    setModelSettingsTab('config');
    if (selectedProfileId) {
      setDraftModelSettings((current) => ({
        ...current,
        profiles: current.profiles.map((entry) => entry.id === selectedProfileId
          ? { ...entry, config: { ...draftAi, apiKey: draftAi.apiKey?.trim() || undefined, hasApiKey: entry.config.hasApiKey || Boolean(draftAi.apiKey?.trim()) } }
          : entry),
      }));
    }
    setSelectedProfileId(profileId);
    setDraftAi({ ...profile.config, apiKey: (profile.config as AiProviderConfig).apiKey ?? '', availableModels: profile.config.availableModels ?? [] });
    setAiStatus(null);
    setFeedback(null);
    setError(null);
  };

  const addModelProfile = () => {
    if (draftModelSettings.profiles.length >= 20) {
      setError(t("语言模型连接最多保存 20 个。"));
      return;
    }
    const id = createSettingsId('model');
    const profile: AiModelSettings['profiles'][number] = {
      id,
      label: '',
      config: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', availableModels: [], hasApiKey: false },
    };
    setDraftModelSettings((current) => ({
      ...current,
      profiles: [
        ...current.profiles.map((entry) => entry.id === selectedProfileId
          ? { ...entry, config: { ...draftAi, apiKey: draftAi.apiKey?.trim() || undefined, hasApiKey: entry.config.hasApiKey || Boolean(draftAi.apiKey?.trim()) } }
          : entry),
        profile,
      ],
    }));
    setSelectedProfileId(id);
    setModelProfilePage(1);
    setModelSettingsTab('config');
    setDraftAi(profile.config);
    setAiStatus(null);
  };

  const startAddModelConnection = () => {
    setModelSettingsTab('add');
    setFeedback(null);
    setError(null);
  };

  const chooseModelCategoryForAdd = (category: ModelSlotId) => {
    setModelCategory(category);
    setFeedback(null);
    setError(null);
    if (category === 'generation') addModelProfile();
    else setModelSettingsTab('config');
  };

  const updateSelectedProfile = (patch: Partial<Pick<AiModelProfile, 'label'>>) => {
    if (!selectedProfile) return;
    setDraftModelSettings((current) => ({ ...current, profiles: current.profiles.map((profile) => profile.id === selectedProfile.id ? { ...profile, ...patch } : profile) }));
  };

  const mergeSelectedProfileDraft = (profiles: AiModelSettings['profiles']) => profiles.map((profile) => profile.id === selectedProfileId
    ? { ...profile, label: selectedProfile?.label ?? profile.label, config: { ...draftAi, apiKey: draftAi.apiKey?.trim() || undefined, hasApiKey: profile.config.hasApiKey || Boolean(draftAi.apiKey?.trim()) } }
    : profile);

  const deleteModelProfile = (profileId: string) => {
    if (draftModelSettings.profiles.length <= 1 || profileId === draftModelSettings.defaultProfileId) return;
    const nextProfiles = mergeSelectedProfileDraft(draftModelSettings.profiles).filter((profile) => profile.id !== profileId);
    const nextProfile = nextProfiles.find((profile) => profile.id === draftModelSettings.defaultProfileId) ?? nextProfiles[0];
    setDraftModelSettings((current) => ({ ...current, profiles: nextProfiles }));
    setModelProfilePage((current) => Math.min(current, Math.max(1, Math.ceil(nextProfiles.length / MODEL_PROFILE_PAGE_SIZE))));
    if (selectedProfileId === profileId) {
      setSelectedProfileId(nextProfile.id);
      setDraftAi({ ...nextProfile.config, apiKey: '', availableModels: nextProfile.config.availableModels ?? [] });
      setAiStatus(null);
    }
  };

  const deleteSelectedProfile = () => {
    if (selectedProfile) deleteModelProfile(selectedProfile.id);
  };

  const buildModelSettingsInput = (): AiModelSettingsInput => ({
    defaultProfileId: draftModelSettings.defaultProfileId,
    profiles: draftModelSettings.profiles.map((profile) => profile.id === selectedProfileId
      ? { ...profile, config: { ...draftAi, apiKey: draftAi.apiKey?.trim() || undefined } }
      : { ...profile, config: { ...profile.config, apiKey: (profile.config as AiProviderConfig).apiKey } }),
  });

  const trackPreferenceSave = (patch: Partial<Omit<AppPreferences, 'schemaVersion'>>) => {
    const keys = Object.keys(patch) as Array<keyof AppPreferences>;
    for (const key of keys) pendingPreferenceKeysRef.current.set(key, (pendingPreferenceKeysRef.current.get(key) ?? 0) + 1);
    return () => {
      for (const key of keys) {
        const remaining = (pendingPreferenceKeysRef.current.get(key) ?? 1) - 1;
        if (remaining) pendingPreferenceKeysRef.current.set(key, remaining);
        else pendingPreferenceKeysRef.current.delete(key);
      }
      setSettledPreferenceSaves(count => count + 1);
    };
  };

  const savePreferencePatch = (patch: Partial<Omit<AppPreferences, 'schemaVersion'>>, successMessage = '设置已保存。'): Promise<void> => {
    const finishSave = trackPreferenceSave(patch);
    const previousPreferences = draftPreferencesRef.current;
    const nextPreferences = { ...previousPreferences, ...patch };
    draftPreferencesRef.current = nextPreferences;
    setDraftPreferences(nextPreferences);
    setError(null);
    setFeedback(null);
    const queuedSave = preferenceSaveQueueRef.current.then(async () => {
      try {
        await onSavePreferences(patch);
        setFeedback(successMessage);
      } catch (saveError) {
        setDraftPreferences((current) => {
          const restorePatch = Object.fromEntries(
            (Object.keys(patch) as Array<Exclude<keyof AppPreferences, 'schemaVersion'>>)
              .filter((key) => current[key] === nextPreferences[key])
              .map((key) => [key, previousPreferences[key]]),
          );
          const restoredPreferences = { ...current, ...restorePatch };
          draftPreferencesRef.current = restoredPreferences;
          return restoredPreferences;
        });
        setError(toMessage(saveError, t("设置保存失败。")));
      }
    }).finally(finishSave);
    preferenceSaveQueueRef.current = queuedSave;
    return queuedSave;
  };

  const saveAppearancePatch = (patch: Partial<Pick<AppPreferences, 'theme' | 'lightColorScheme'>>) => {
    const previousPreferences = draftPreferencesRef.current;
    if (Object.entries(patch).every(([key, value]) => previousPreferences[key as keyof AppPreferences] === value)) return;
    const finishSave = trackPreferenceSave(patch);
    const saveSequence = ++appearanceSaveSequenceRef.current;
    const nextPreferences = { ...previousPreferences, ...patch };
    draftPreferencesRef.current = nextPreferences;
    setDraftPreferences(nextPreferences);
    setError(null);
    setFeedback(null);
    void onSavePreferences(patch).then(
      () => {
        if (appearanceSaveSequenceRef.current === saveSequence) setFeedback(t("外观设置已保存。"));
      },
      (saveError) => {
        if (appearanceSaveSequenceRef.current !== saveSequence) return;
        const restoredPreferences = { ...draftPreferencesRef.current };
        // 只回退本次失败且未再次修改的字段，保留其他正在保存的偏好。
        for (const key of ['theme', 'lightColorScheme'] as const) {
          if (key in patch && restoredPreferences[key] === patch[key]) {
            Object.assign(restoredPreferences, { [key]: previousPreferences[key] });
          }
        }
        draftPreferencesRef.current = restoredPreferences;
        setDraftPreferences(restoredPreferences);
        setError(toMessage(saveError, t("外观设置失败。")));
      },
    ).finally(finishSave);
  };

  const saveAppearancePreference = (theme: AppPreferences['theme']) => saveAppearancePatch({ theme });

  const testConnection = async () => {
    const submitted = liveDraft.current;
    setIsTesting(true);
    setError(null);
    setFeedback(null);
    try {
      const status = await window.electronAPI.testAiProviderConfig(draftAi, { profileId: selectedProfileId });
      if (submitted.profileId !== liveDraft.current.profileId || submitted.key !== liveDraft.current.key) return;
      setAiStatus(status);
      setFeedback(status.available ? t("连接检测成功。") : status.message ?? t("连接不可用。"));
    } catch (testError) {
      if (submitted.profileId !== liveDraft.current.profileId || submitted.key !== liveDraft.current.key) return;
      setError(toMessage(testError, t("连接检测失败。")));
    } finally {
      setIsTesting(false);
    }
  };

  const fetchModels = async () => {
    const submitted = liveDraft.current;
    setIsFetchingModels(true);
    setError(null);
    setFeedback(null);
    try {
      const status = await window.electronAPI.fetchAiProviderModels({ ...draftAi, provider: selectedRemoteProvider }, { profileId: selectedProfileId });
      if (submitted.profileId !== liveDraft.current.profileId || submitted.key !== liveDraft.current.key) return;
      setAiStatus(status);
      if (!status.available) {
        setError(status.message ?? t("获取可用模型失败。"));
        return;
      }
      const selectedModel = draftAi.model && status.models.some((model) => model.name === draftAi.model)
        ? draftAi.model
        : status.models[0]?.name ?? '';
      setDraftAi((current) => ({
        ...current,
        provider: selectedRemoteProvider,
        availableModels: status.models,
        model: selectedModel,
      }));
      setFeedback(status.message ?? t("已获取可用模型。"));
    } catch (fetchError) {
      if (submitted.profileId !== liveDraft.current.profileId || submitted.key !== liveDraft.current.key) return;
      setError(toMessage(fetchError, t("获取可用模型失败。")));
    } finally {
      setIsFetchingModels(false);
    }
  };

  const saveAi = async () => {
    const submitted = liveDraft.current;
    setIsSaving(true);
    setError(null);
    try {
      const selectedConfig = draftAi.kind === 'openai-compatible' ? { ...draftAi, provider: selectedRemoteProvider } : draftAi;
      const selectedLabel = selectedProfile && !isGeneratedModelProfileLabel(selectedProfile.label)
        ? selectedProfile.label.trim()
        : getDefaultModelProfileLabel(selectedConfig);
      const draft = buildModelSettingsInput();
      draft.profiles = draft.profiles.map((profile) => profile.id === selectedProfileId ? { ...profile, label: selectedLabel, config: selectedConfig } : profile);
      const saved = await onSaveAiModelSettings(draft);
      for (const profile of saved.profiles) savedDraftKeys.current.set(profile.id, modelDraftKey(profile.config));
      const savedProfile = saved.profiles.find((profile) => profile.id === submitted.profileId);
      if (savedProfile && submitted.profileId === liveDraft.current.profileId && submitted.key === liveDraft.current.key) {
        const redacted = { ...savedProfile.config, apiKey: '' };
        previousDraft.current = { profileId: submitted.profileId, key: modelDraftKey(redacted) };
        setDraftModelSettings(saved);
        setDraftAi(redacted);
        if (guidedModel) await window.electronAPI.selectOnboardingProfile(submitted.profileId);
      }
      setFeedback(t("模型设置已保存。"));
    } catch (saveError) {
      if (saveError instanceof ModelConfigurationSaveCancelled) setFeedback(t(saveError.message));
      else setError(toMessage(saveError, t("模型设置保存失败。")));
    } finally {
      setIsSaving(false);
    }
  };

  const saveExtensions = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await onSaveAiExtensionsSettings(draftExtensions);
      setFeedback(t("技能设置已保存。"));
    } catch (saveError) {
      setError(toMessage(saveError, t("扩展设置保存失败。")));
    } finally {
      setIsSaving(false);
    }
  };

  const addSkill = async () => {
    const name = newSkillName.trim();
    const description = newSkillDescription.trim();
    const instruction = newSkillInstruction.trim();
    if (!name || !description || !instruction) {
      setError(t("请填写 AI 助手技能名称、能力描述和工作约束。"));
      return;
    }
    setIsSaving(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await window.electronAPI.createAiSkillFromForm({ name, description, instruction });
      if (!result.ok) throw new Error(result.error ?? t("技能创建失败。"));
      setNewSkillName('');
      setNewSkillDescription('');
      setNewSkillInstruction('');
      setEditingSkillId(null);
      setFeedback(t("已创建技能“{0}”，可在助手中选择使用。", { '0': result.skillName }));
      await loadSkillsOverview();
    } catch (saveError) {
      setError(toMessage(saveError, t("AI 助手 Skill 添加失败。")));
    } finally {
      setIsSaving(false);
    }
  };

  const updateSkill = (id: string, patch: Partial<Pick<AiExtensionsSettings['skills'][number], 'enabled' | 'name' | 'description' | 'instruction' | 'generationStyle'>>) => {
    setDraftExtensions((current) => ({ ...current, skills: current.skills.map((skill) => skill.id === id ? { ...skill, ...patch } : skill) }));
  };

  const saveSkillEnabled = async (id: string, enabled: boolean) => {
    if (savingSkillId) return;
    const previous = draftExtensions;
    const skill = previous.skills.find((entry) => entry.id === id);
    if (!skill || skill.enabled === enabled) return;
    const next = { ...previous, skills: previous.skills.map((entry) => entry.id === id ? { ...entry, enabled } : entry) };
    setDraftExtensions(next);
    setSavingSkillId(id);
    setError(null);
    setFeedback(null);
    try {
      await onSaveAiExtensionsSettings(next);
      setFeedback(t("已{0}“{1}”。", { '0': enabled ? t("启用") : t("停用"), '1': skill.name }));
    } catch (saveError) {
      setDraftExtensions(previous);
      setError(toMessage(saveError, t("技能状态保存失败。")));
    } finally {
      setSavingSkillId(null);
    }
  };

  const deleteSkill = async (id: string) => {
    const skill = draftExtensions.skills.find((entry) => entry.id === id);
    if (!skill || skill.system) return;
    const previous = draftExtensions;
    const next = { ...previous, skills: previous.skills.filter((entry) => entry.id !== id) };
    setIsSaving(true);
    setError(null);
    setFeedback(null);
    try {
      await onSaveAiExtensionsSettings(next);
      setDraftExtensions(next);
      setEditingSkillId(null);
      setFeedback(t("已删除“{0}”。", { '0': skill.name }));
    } catch (saveError) {
      setError(toMessage(saveError, t("删除 AI 助手 Skill 失败。")));
    } finally {
      setIsSaving(false);
    }
  };

  const loadSkillsOverview = async () => {
    try {
      setSkillsOverview(await window.electronAPI.getAiSkillsOverview());
    } catch {
      // 目录技能总览读取失败不阻塞设置页，仅保留旧数据。
    }
  };

  const importSkill = async (mode: AiSkillImportKind) => {
    if (importingSkill) return;
    setImportingSkill(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await window.electronAPI.importAiSkill(mode);
      if (result.ok) {
        setFeedback(t("已导入技能“{0}”，附加文件 {1} 个。", { '0': result.skillName, '1': result.resourceFileCount ?? 0 }));
        await loadSkillsOverview();
      } else if (result.error !== '已取消导入。') {
        setError(result.error ?? t("技能导入失败。"));
      }
    } catch (importError) {
      setError(toMessage(importError, t("技能导入失败。")));
    } finally {
      setImportingSkill(false);
    }
  };

  const saveDirectorySkillEnabled = async (name: string, enabled: boolean) => {
    if (savingSkillId) return;
    setSavingSkillId(name);
    setError(null);
    setFeedback(null);
    try {
      await window.electronAPI.setAiSkillEnabled(name, enabled);
      setSkillsOverview((current) => current ? { ...current, directorySkills: current.directorySkills.map((entry) => entry.name === name ? { ...entry, enabled } : entry) } : current);
      setFeedback(t("已{0}目录技能“{1}”。", { '0': enabled ? t("启用") : t("停用"), '1': name }));
    } catch (saveError) {
      setError(toMessage(saveError, t("目录技能启用状态保存失败。")));
    } finally {
      setSavingSkillId(null);
    }
  };

  const removeDirectorySkill = async (name: string) => {
    if (!window.confirm(t("确定删除目录技能“{0}”及其文件夹吗？此操作不可恢复。", { '0': name }))) return;
    setError(null);
    setFeedback(null);
    try {
      await window.electronAPI.removeAiSkill(name);
      setSkillsOverview((current) => current ? { ...current, directorySkills: current.directorySkills.filter((entry) => entry.name !== name) } : current);
      setFeedback(t("已删除目录技能“{0}”。", { '0': name }));
    } catch (deleteError) {
      setError(toMessage(deleteError, t("删除目录技能失败。")));
    }
  };

  const openDirectorySkillEditor = (name: string) => {
    const entry = skillsOverview?.directorySkills.find((item) => item.name === name);
    if (!entry) return;
    setEditingDirectoryName(name);
    setEditingSkillDescription(entry.description);
    setEditingSkillInstruction(entry.instruction);
  };

  const saveDirectorySkillDocument = async () => {
    if (!editingDirectoryName || savingDirectorySkill) return;
    setSavingDirectorySkill(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await window.electronAPI.updateAiSkillDocument(editingDirectoryName, editingSkillDescription, editingSkillInstruction);
      if (result.ok) {
        setEditingDirectoryName(null);
        setFeedback(t("已保存目录技能“{0}”。", { '0': editingDirectoryName }));
        await loadSkillsOverview();
      } else {
        setError(result.error ?? t("目录技能保存失败。"));
      }
    } catch (saveError) {
      setError(toMessage(saveError, t("目录技能保存失败。")));
    } finally {
      setSavingDirectorySkill(false);
    }
  };

  const exportDirectorySkill = async (name: string) => {
    setError(null);
    setFeedback(null);
    try {
      const result = await window.electronAPI.exportAiSkill(name);
      if (result.ok) setFeedback(t("已导出技能“{0}”为 zip 压缩包。", { '0': name }));
      else if (!result.canceled) setError(result.error ?? t("技能导出失败。"));
    } catch (exportError) {
      setError(toMessage(exportError, t("技能导出失败。")));
    }
  };

  const saveParsing = async () => {
    if (!draftParsing) return;
    if (!draftParsing.hasMineruKey && !mineruKeyInput.trim()) {
      setError(t("请输入 MinerU API Key。"));
      return;
    }
    if (draftParsing.mineruEndpoint.trim()) {
      try {
        const endpoint = new URL(draftParsing.mineruEndpoint.trim());
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('unsupported protocol');
      } catch {
        setError(t("MinerU API 地址必须是有效的 HTTP 或 HTTPS 地址。"));
        return;
      }
    }
    setIsSavingParsing(true);
    setFeedback(null);
    setError(null);
    try {
      const saved = await window.electronAPI.saveParsingConfig({
        mineruEndpoint: draftParsing.mineruEndpoint,
        mineruApiKey: mineruKeyInput.trim() || undefined,
      });
      setDraftParsing(saved);
      setMineruKeyInput('');
      setFeedback(t("MinerU 连接已保存，等待配置的 PDF 任务会自动继续。"));
    } catch (saveError) {
      setError(toMessage(saveError, t("MinerU 连接保存失败。")));
    } finally {
      setIsSavingParsing(false);
    }
  };

  const saveWebSearch = async () => {
    if (!draftWebSearch) return;
    const draft = draftWebSearch.config;
    if (draft.provider === 'searxng' && draft.enabled && !draft.searxngUrl.trim()) {
      setError(t("选择 SearXNG 时请先填写实例地址。"));
      return;
    }
    setIsSavingWebSearch(true);
    setFeedback(null);
    setError(null);
    try {
      const saved = await window.electronAPI.saveWebSearchConfig({
        enabled: draft.enabled,
        provider: draft.provider,
        maxResults: draft.maxResults,
        searxngUrl: draft.searxngUrl,
        zhipuApiKey: webSearchKeyPatches.zhipu,
        tavilyApiKey: webSearchKeyPatches.tavily,
        baiduApiKey: webSearchKeyPatches.baidu,
        providerExtras: draft.providerExtras,
      });
      setDraftWebSearch({ ...draftWebSearch, config: saved });
      setWebSearchKeyPatches({});
      setFeedback(saved.enabled ? t("联网搜索已启用；后续 AI 问答会按设置自动判断是否检索。") : t("联网搜索设置已保存，当前为关闭状态。"));
    } catch (saveError) {
      setError(toMessage(saveError, t("联网搜索设置保存失败。")));
    } finally {
      setIsSavingWebSearch(false);
    }
  };

  const testWebSearch = async () => {
    if (!draftWebSearch) return;
    setIsTestingWebSearch(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await window.electronAPI.testWebSearchProvider(draftWebSearch.config.provider);
      if (result.ok) setFeedback(result.message);
      else setError(result.message);
    } catch (testError) {
      setError(toMessage(testError, t("联网搜索连接测试失败。")));
    } finally {
      setIsTestingWebSearch(false);
    }
  };

  const openWebSearchEditor = (providerId: WebSearchProviderId | null, isNew: boolean) => {
    if (!draftWebSearch) return;
    setEditorKeyInput('');
    setEditorUrlInput(draftWebSearch.config.searxngUrl);
    setEditorExtras(providerId ? { ...(draftWebSearch.config.providerExtras[providerId] ?? {}) } : {});
    setWebSearchEditor({ providerId, isNew });
  };

  const applyWebSearchEditor = () => {
    if (!draftWebSearch || !webSearchEditor?.providerId) return;
    const providerId = webSearchEditor.providerId;
    const provider = draftWebSearch.providers.find((entry) => entry.id === providerId);
    let config = { ...draftWebSearch.config };
    if (providerId === 'searxng') config = { ...config, searxngUrl: editorUrlInput };
    else if (providerId !== 'duckduckgo' && editorKeyInput.trim()) {
      setWebSearchKeyPatches((previous) => ({ ...previous, [providerId]: editorKeyInput.trim() }));
      config = withWebSearchHasKey(config, providerId, true);
    }
    if (provider?.configFields?.length) config = { ...config, providerExtras: { ...config.providerExtras, [providerId]: editorExtras } };
    setDraftWebSearch({ ...draftWebSearch, config });
    setWebSearchEditor(null);
  };

  const removeWebSearchCredential = (providerId: WebSearchProviderId) => {
    if (!draftWebSearch || providerId === 'duckduckgo') return;
    let config = { ...draftWebSearch.config };
    if (providerId === 'searxng') config = { ...config, searxngUrl: '' };
    else {
      setWebSearchKeyPatches((previous) => ({ ...previous, [providerId]: '' }));
      config = withWebSearchHasKey(config, providerId, false);
    }
    if (config.provider === providerId) config = { ...config, provider: 'duckduckgo' };
    setDraftWebSearch({ ...draftWebSearch, config });
  };

  const saveSelectionExpansionDefaults = async () => {
    if (!draftSelectionExpansion) return;
    setIsSavingSelectionExpansion(true);
    setError(null);
    setFeedback(null);
    try {
      const saved = await window.electronAPI.saveSelectionExpansionSettings(draftSelectionExpansion);
      setDraftSelectionExpansion(saved);
      setFeedback(t("选区扩写优化默认设置已保存。"));
    } catch (saveError) {
      setError(toMessage(saveError, t("选区扩写优化设置保存失败。")));
    } finally {
      setIsSavingSelectionExpansion(false);
    }
  };

  return (
    <Box className="settings-page" component="section" aria-label={t("设置")}>
      <Group className="settings-page-header" justify="space-between" align="center" gap="md" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={34} radius="md" variant="light" color="brand"><Settings2 size={18} /></ThemeIcon>
          <Stack gap={0}>
            <Text fw={700} size="lg">{t("设置")}</Text>
          </Stack>
        </Group>
        <Button className="settings-page-back" variant="subtle" color="gray" leftSection={<ArrowLeft size={16} />} onClick={onClose}>{t("返回工作台")}</Button>
      </Group>
      <Tabs value={section} onChange={(value) => {
        if (!value) return;
        const nextSection = value as SettingsSection;
        setSection(nextSection);
        if (nextSection === 'model') setModelSettingsTab(guidedModel ? 'config' : 'profiles');
        setFeedback(null);
        setError(null);
      }} orientation="vertical" variant="default" keepMounted={false} className="settings-mantine-tabs">
        <Tabs.List className="settings-mantine-tabs-list" aria-label={t("设置分组")}>
          {sections.map((item, index) => {
            const Icon = item.icon;
            const previous = sections[index - 1];
            return <Fragment key={item.id}>
              {(!previous || previous.group !== item.group) ? <Text className="settings-mantine-nav-label" size="xs" fw={700}>{t(item.group)}</Text> : null}
              <Tabs.Tab className="settings-mantine-tab" value={item.id} leftSection={<Icon size={16} strokeWidth={1.8} />}>{t(item.label)}</Tabs.Tab>
            </Fragment>;
          })}
        </Tabs.List>

        <ScrollArea className="settings-mantine-scroll" type="auto" offsetScrollbars>
          <Box className="settings-mantine-content">
            <Tabs.Panel value="general">
              <SettingsSection group={t("工作区配置")} title={t("通用")}>
                <Accordion variant="contained"><Accordion.Item value="onboarding"><Accordion.Control>{t('首次使用引导')}</Accordion.Control><Accordion.Panel><FirstRunGuide onOpen={onOpenOnboarding} /></Accordion.Panel></Accordion.Item></Accordion>
                <SettingsField title={t("外观")}><Stack gap={6}><FlowToggle ariaLabel={t("外观")} options={[{ value: 'system', label: t("跟随系统"), icon: <Monitor size={14} strokeWidth={1.8} /> }, { value: 'light', label: t("浅色"), icon: <Sun size={14} strokeWidth={1.8} /> }, { value: 'dark', label: t("深色"), icon: <Moon size={14} strokeWidth={1.8} /> }]} value={draftPreferences.theme} onChange={saveAppearancePreference} /><Text size="xs" c="dimmed">{t("当前：")}{resolvedTheme === 'dark' ? t("深色") : t("浅色")}</Text></Stack></SettingsField>
                <SettingsField title={t('界面配色')} description={t('浅色和深色外观均生效，切换后自动保存。')}><LightColorSchemePicker theme={resolvedTheme} value={draftPreferences.lightColorScheme} onChange={(lightColorScheme) => saveAppearancePatch({ lightColorScheme })} /></SettingsField>
                <SettingsField title={t("界面密度")}><FlowToggle ariaLabel={t("界面密度")} options={[{ value: 'comfortable', label: t("舒适"), icon: <Rows3 size={14} strokeWidth={1.8} /> }, { value: 'compact', label: t("紧凑"), icon: <Rows4 size={14} strokeWidth={1.8} /> }]} value={draftPreferences.density} onChange={(density) => void savePreferencePatch({ density }, t("界面密度已保存。"))} /></SettingsField>
                <SettingsField title={t("语言")} description={t("切换后立即生效，并自动保存。")}><Select aria-label={t("语言")} value={draftPreferences.language} data={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]} allowDeselect={false} disabled={isSavingLanguage} onChange={(value) => {
                  if (!value || value === draftPreferencesRef.current.language) return;
                  setIsSavingLanguage(true);
                  void savePreferencePatch({ language: value as AppPreferences['language'] }, '语言设置已保存。').finally(() => setIsSavingLanguage(false));
                }} /></SettingsField>
                <SettingsField title={t("启动行为")}><Select aria-label={t("启动行为")} value={draftPreferences.startupBehavior} data={[{ value: 'library', label: t("打开笔记库") }, { value: 'last-note', label: t("恢复上次笔记") }]} onChange={(value) => value && void savePreferencePatch({ startupBehavior: value as AppPreferences['startupBehavior'] })} /></SettingsField>
                <SettingsField title={t("网页链接打开方式")}><Select aria-label={t("网页链接打开方式")} value={draftPreferences.externalLinkOpenMode} data={[{ value: 'in-app', label: t("应用内置网页（默认）") }, { value: 'system-default', label: t("电脑默认浏览器") }]} onChange={(value) => value && void savePreferencePatch({ externalLinkOpenMode: value as AppPreferences['externalLinkOpenMode'] })} /></SettingsField>
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="library">
              <Box className="workspace-settings-page">
                <SettingsSection group={t("工作区配置")} title={t("工作区与备份")}>
                  <Paper withBorder radius="md" className="workspace-settings-card">
                    <Group gap="sm" wrap="nowrap" className="workspace-settings-heading">
                      <ThemeIcon variant="light" color="gray" size={32} radius="md"><FolderOpen size={17} /></ThemeIcon>
                      <Text fw={650} size="sm">{t("工作区数据位置")}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" mt={8}>{t("默认创建的笔记库、资料库及会话记忆保存在这里。更改位置时，会迁移现有工作区数据。")}</Text>
                    <Box className="workspace-settings-location">
                      <Code block className="workspace-settings-path">{workspacePath ?? t("尚未设置工作区")}</Code>
                      <Button size="xs" variant="default" leftSection={<FolderOpen size={14} />} onClick={() => void onSelectWorkspace()}>{t("更改存储位置…")}</Button>
                    </Box>
                    <Group gap="xs" mt="xs">
                      <Button size="compact-xs" variant="subtle" onClick={() => void window.electronAPI.openWorkspaceFolder()}>{t('打开文件夹')}</Button>
                      <Button size="compact-xs" variant="subtle" onClick={() => void onOpenWorkspace()}>{t('打开其他工作区…')}</Button>
                    </Group>
                    {workspaceError ? <Text size="xs" c="red" mt="xs">{workspaceError}</Text> : null}
                    <Box className="workspace-settings-retention">
                      <Box className="workspace-settings-copy">
                        <Text fw={600} size="xs">{t("笔记历史备份")}</Text>
                        <Text size="xs" c="dimmed" mt={4} lh={1.6}>{t("每篇笔记按时间保留最新 3 份备份。新备份和正文保存成功后，自动删除窗口外的旧备份。")}</Text>
                      </Box>
                      <Badge variant="light" color="gray">{t("保留最新")} {NOTE_BACKUP_RETENTION} {t("份")}</Badge>
                    </Box>
                  </Paper>
                  <Box className="workspace-settings-backup-grid">
                    <WorkspaceBackupSettings />
                    <WorkspaceRestoreSettings onWorkspaceDataChanged={onWorkspaceDataChanged} />
                  </Box>
                </SettingsSection>
              </Box>
            </Tabs.Panel>

            <Tabs.Panel value="editor">
              <SettingsSection group={t("工作区配置")} title={t("编辑器")}>
                <SettingsField title={t("默认编辑模式")}><Select aria-label={t("默认编辑模式")} value={draftPreferences.defaultEditorMode} data={[{ value: 'wysiwyg', label: t("编辑") }, { value: 'preview', label: t("预览") }, { value: 'source', label: t("源码") }]} onChange={(value) => value && void savePreferencePatch({ defaultEditorMode: value as AppPreferences['defaultEditorMode'] })} /></SettingsField>
                <SettingsField title={t("自动保存延迟")} description={t("停止输入后自动保存。")}><Select aria-label={t("自动保存延迟")} value={String(draftPreferences.autosaveDelayMs)} data={[{ value: '500', label: t("0.5 秒") }, { value: '1000', label: t("1 秒") }, { value: '2000', label: t("2 秒") }, { value: '5000', label: t("5 秒") }]} onChange={(value) => value && void savePreferencePatch({ autosaveDelayMs: Number(value) })} /></SettingsField>
                <SettingsField title={t("预览偏好")}><Select aria-label={t("预览偏好")} value={draftPreferences.previewPreference} data={[{ value: 'rendered', label: t("应用内渲染") }, { value: 'source', label: t("Markdown 源码") }]} onChange={(value) => value && void savePreferencePatch({ previewPreference: value as AppPreferences['previewPreference'] })} /></SettingsField>
                <EditorPreferencesSettings preferences={draftPreferences} onSave={savePreferencePatch} />
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="parsing">
              <SettingsSection group={t("文档处理")} title={t("文档解析")}>
                <Paper withBorder radius="lg" p="lg" className="settings-model-card settings-parsing-card">
                  <Group className="settings-model-card-header" justify="space-between" align="center" wrap="wrap" gap="md">
                    <Group gap="sm" wrap="nowrap"><ThemeIcon size={36} radius="md" variant="light" color="teal"><ScanText size={18} /></ThemeIcon><Box><Text fw={700}>{t("按文件类型自动分流")}</Text></Box></Group>
                    <Badge variant="light" color="blue">{t("PDF 固定使用 MinerU")}</Badge>
                  </Group>
                  <Divider className="settings-model-card-divider" />
                  <Stack gap="sm" mt="md">
                    <Alert className="settings-privacy-alert" color="blue" variant="light" icon={<ShieldCheck size={18} />}>{t("文本资料直接读取；DOCX 由 Mammoth 在本机处理；只有 PDF 会发送到 MinerU。")}</Alert>
                    <Stack gap={0} className="settings-parsing-route-list">
                      <ParsingRouteRow title={t("文本类资料")} description={t("Markdown、TXT、JSON、CSV、YAML、HTML、XML、日志")} badge={t("直接读取 · 本地")} color="gray" />
                      <ParsingRouteRow title={t("Word 文档")} description={t("旧 DOC、PPT/PPTX、XLS/XLSX 与 EPUB 暂不支持，请先转换。")} badge={t("Mammoth · 本地")} color="teal" />
                      <ParsingRouteRow title={t("PDF 文档")} description={t("支持文字、扫描件、表格与公式。")} badge={t("MinerU · 云端")} color="orange" last />
                    </Stack>
                  </Stack>
                </Paper>

                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
                  <ParsingEngineCard
                    engine="mammoth"
                    icon={<FileText size={18} />}
                    title="Mammoth"
                    scope={t("本机处理 · 无需 API")}
                    suitable={t("提取 DOCX 的标题、段落、列表、表格和链接。")}
                    formats={['DOCX', t("标题 / 段落"), t("列表 / 表格"), t("链接 / 图片占位")]}
                    boundary={t("仅支持 DOCX，不保留分页和复杂版式。")}
                  />
                  <ParsingEngineCard
                    engine="mineru"
                    icon={<Cloud size={18} />}
                    title="MinerU"
                    scope={t("云端增强 · 需要 API Key")}
                    suitable={t("解析扫描件、多栏、表格、图片和公式。")}
                    formats={[t("文字型 PDF"), t("扫描 PDF"), t("表格 / 公式"), t("多栏 / 图文混排")]}
                    boundary={t("PDF 会上传至 MinerU，解析结果保存于本地。")}
                  />
                </SimpleGrid>

                <Paper withBorder radius="lg" p="lg" mt="md" className="settings-model-card settings-parsing-connection-card">
                  <Group className="settings-model-card-header" justify="space-between" align="center" wrap="wrap" gap="md">
                    <Group gap="sm" wrap="nowrap"><ThemeIcon size={36} radius="md" variant="light" color="orange"><KeyRound size={18} /></ThemeIcon><Box><Text fw={700}>{t("MinerU API 连接")}</Text></Box></Group>
                    <Badge variant="light" color={draftParsing?.hasMineruKey ? 'teal' : 'orange'}>{draftParsing?.hasMineruKey ? t("配置已完成") : t("待配置")}</Badge>
                  </Group>
                  <Divider className="settings-model-card-divider" />
                  {draftParsing ? <Stack gap={0} className="settings-model-card-content">
                    <SettingsField variant="plain" title={t("API 地址")} description={t("留空使用官方地址。")}><Group gap="xs" wrap="nowrap"><TextInput aria-label={t("MinerU API 地址")} style={{ flex: 1 }} value={draftParsing.mineruEndpoint} onChange={(event) => setDraftParsing({ ...draftParsing, mineruEndpoint: event.currentTarget.value })} placeholder={t("https://mineru.net/api/v4（官方默认）")} /><Button variant="subtle" color="gray" size="xs" onClick={() => setDraftParsing({ ...draftParsing, mineruEndpoint: '' })}>{t("恢复默认")}</Button></Group></SettingsField>
                    <SettingsField variant="plain" title="API Key" description={t("留空不会覆盖已保存密钥。")}><Stack gap="xs"><PasswordInput aria-label="MinerU API Key" value={mineruKeyInput} onChange={(event) => setMineruKeyInput(event.currentTarget.value)} placeholder={draftParsing.hasMineruKey ? t("已保存；留空保持不变") : t("请输入 MinerU API Key")} /></Stack></SettingsField>
                    <Group className="settings-actions-row" justify="flex-end" gap="sm"><Button leftSection={<CheckCircle2 size={16} />} loading={isSavingParsing} onClick={() => void saveParsing()}>{t("保存 MinerU 连接")}</Button></Group>
                  </Stack> : <Text size="sm" c="dimmed" mt="md">{t("正在读取 MinerU 连接状态…")}</Text>}
                </Paper>
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="web-search">
              <SettingsSection group={t("AI 设置")} title={t("联网搜索")}>
                {draftWebSearch ? <Stack gap="md">
                  <Text size="xs" c="dimmed">{t("搜索时仅发送提问关键词，不发送资料库正文。")}</Text>
                  <SettingsField title={t("功能总开关")}><Switch aria-label={t("启用联网搜索")} checked={draftWebSearch.config.enabled} onChange={(event) => setDraftWebSearch({ ...draftWebSearch, config: { ...draftWebSearch.config, enabled: event.currentTarget.checked } })} label={t("启用 AI 问答的联网搜索")} /></SettingsField>
                  <Box className="settings-profile-browser">
                    <Group justify="space-between" align="center" gap="md" wrap="wrap">
                      <Box>
                        <Group gap="xs"><Text fw={700}>{t("搜索服务商")}</Text><Badge size="sm" variant="light" color="gray">{draftWebSearch.providers.filter((provider) => isWebSearchConfigured(provider.id, draftWebSearch.config)).length}/{draftWebSearch.providers.length}</Badge></Group>

                      </Box>
                      <Button size="sm" variant="light" leftSection={<Plus size={15} />} disabled={draftWebSearch.providers.every((provider) => isWebSearchConfigured(provider.id, draftWebSearch.config))} onClick={() => openWebSearchEditor(null, true)}>{t("新增联网搜索连接")}</Button>
                    </Group>
                    <Table.ScrollContainer minWidth={680} mt="md">
                      <Table className="settings-profile-table" highlightOnHover withColumnBorders={false} verticalSpacing="sm">
                        <Table.Thead><Table.Tr><Table.Th>{t("服务商")}</Table.Th><Table.Th>{t("前置要求")}</Table.Th><Table.Th>{t("配置状态")}</Table.Th><Table.Th>{t("操作")}</Table.Th></Table.Tr></Table.Thead>
                        <Table.Tbody>
                          {draftWebSearch.providers.map((provider) => {
                            const configured = isWebSearchConfigured(provider.id, draftWebSearch.config);
                            const selected = draftWebSearch.config.provider === provider.id;
                            return <Table.Tr key={provider.id} className="settings-profile-row" data-selected={selected || undefined} aria-selected={selected} tabIndex={0} onClick={() => setDraftWebSearch({ ...draftWebSearch, config: { ...draftWebSearch.config, provider: provider.id } })} onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setDraftWebSearch({ ...draftWebSearch, config: { ...draftWebSearch.config, provider: provider.id } });
                              }
                            }}>
                              <Table.Td><Group gap="xs" wrap="nowrap"><ProviderIcon provider={provider.id} size={24} /><Box style={{ minWidth: 0 }}><Group gap="xs" wrap="nowrap"><Text fw={650} size="sm">{t(provider.label)}{provider.id === 'zhipu' ? t("（推荐）") : ''}</Text>{selected ? <Badge size="xs" variant="light" color="brand">{t("默认")}</Badge> : null}</Group></Box></Group></Table.Td>
                              <Table.Td><Badge size="xs" variant="outline" color="gray">{getWebSearchRequirementLabel(provider.requirements)}</Badge></Table.Td>
                              <Table.Td>{provider.id === 'searxng' && configured ? <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{draftWebSearch.config.searxngUrl}</Text> : <Badge size="xs" variant="light" color={configured ? 'teal' : 'gray'}>{configured ? (provider.requirements === 'none' ? t("免配置可用") : t("密钥已保存")) : t("未配置")}</Badge>}</Table.Td>
                              <Table.Td><Group className="settings-profile-actions" gap={4} wrap="nowrap"><Button size="xs" variant="subtle" onClick={(event) => { event.stopPropagation(); openWebSearchEditor(provider.id, false); }}>{t("配置")}</Button><Button size="xs" variant="subtle" color="red" disabled={!configured || provider.id === 'duckduckgo'} onClick={(event) => { event.stopPropagation(); removeWebSearchCredential(provider.id); }}>{t("删除")}</Button></Group></Table.Td>
                            </Table.Tr>;
                          })}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </Box>
                  <Modal opened={Boolean(webSearchEditor)} onClose={() => setWebSearchEditor(null)} title={webSearchEditor?.isNew ? t("新增联网搜索连接") : t("配置搜索服务商")} centered>
                    {webSearchEditor && draftWebSearch ? (() => {
                      const editorProvider = webSearchEditor.providerId ? draftWebSearch.providers.find((entry) => entry.id === webSearchEditor.providerId) : undefined;
                      return <Stack gap="sm">
                        {webSearchEditor.isNew ? <ProviderSelect label={t("服务商")} aria-label={t("新增联网搜索服务商")} placeholder={t("选择搜索服务商")} value={webSearchEditor.providerId} data={draftWebSearch.providers.filter((entry) => !isWebSearchConfigured(entry.id, draftWebSearch.config)).map((entry) => ({ value: entry.id, label: `${t(entry.label)} (${getWebSearchRequirementLabel(entry.requirements)})` }))} onChange={(value) => value && openWebSearchEditor(value as WebSearchProviderId, true)} /> : <Group gap="xs" wrap="nowrap">{editorProvider ? <><ProviderIcon provider={editorProvider.id} /><Text fw={600} size="sm">{t(editorProvider.label)}</Text></> : null}</Group>}
                        {editorProvider ? <Text size="xs" c="dimmed">{editorProvider.description}</Text> : null}
                        {editorProvider?.requirements === 'api-key' ? <Stack gap="xs"><PasswordInput aria-label={`${editorProvider.label} API Key`} value={editorKeyInput} onChange={(event) => setEditorKeyInput(event.currentTarget.value)} placeholder={isWebSearchConfigured(editorProvider.id, draftWebSearch.config) ? t("已保存；留空保持不变") : t("请输入 {0} API Key", { '0': editorProvider.label })} /></Stack> : null}
                        {editorProvider?.id === 'searxng' ? <TextInput aria-label={t("SearXNG 实例地址")} description={t("填写实例首页地址。")} value={editorUrlInput} onChange={(event) => setEditorUrlInput(event.currentTarget.value)} placeholder="https://searxng.example.com" /> : null}
                        {editorProvider?.configFields?.map((field) => <Select key={field.key} label={t(field.label)} description={field.description ? t(field.description) : undefined} aria-label={t(field.label)} value={editorExtras[field.key] ?? field.default} data={field.options.map((option) => ({ value: option.value, label: t(option.label) }))} onChange={(value) => value && setEditorExtras({ ...editorExtras, [field.key]: value })} />)}
                        <Group justify="flex-end"><Button disabled={!webSearchEditor.providerId} onClick={applyWebSearchEditor}>{webSearchEditor.isNew ? t("添加") : t("保存")}</Button></Group>
                      </Stack>;
                    })() : null}
                  </Modal>
                  <SettingsField title={t("单次搜索结果数")}><NumberInput aria-label={t("单次搜索结果数")} min={3} max={10} allowDecimal={false} value={draftWebSearch.config.maxResults} onChange={(value) => setDraftWebSearch({ ...draftWebSearch, config: { ...draftWebSearch.config, maxResults: typeof value === 'number' ? value : Number(value) || 6 } })} /></SettingsField>
                  <Group className="settings-actions-row" justify="flex-end" gap="sm">
                    <Button variant="light" loading={isTestingWebSearch} onClick={() => void testWebSearch()}>{t("测试连接")}</Button>
                    <Button leftSection={<CheckCircle2 size={16} />} loading={isSavingWebSearch} onClick={() => void saveWebSearch()}>{t("保存联网搜索设置")}</Button>
                  </Group>
                </Stack> : <Text size="sm" c="dimmed">{t("正在读取联网搜索设置…")}</Text>}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="ai-writing">
              <SettingsSection group={t("AI 设置")} title={t("选区扩写优化")}>
                {draftSelectionExpansion ? <Stack className="selection-expansion-settings" gap="md">
                  <Alert className="settings-privacy-alert" color="blue" variant="light" icon={<ShieldCheck size={18} />}>{t("当前版本只从当前笔记读取可复核证据。它会先规划证据目标，再根据命中的原文生成建议；不会自动替换你的笔记内容。")}</Alert>
                  <SettingsField title={t("目标长度")} description={t("按比例扩写，或指定目标字数。")}><Stack gap="sm"><Select aria-label={t("扩写目标长度")} value={draftSelectionExpansion.targetLength.mode === 'ratio' ? String(draftSelectionExpansion.targetLength.ratio) : 'custom'} data={[{ value: '1.3', label: t("轻度 · 约 1.3×") }, { value: '1.8', label: t("标准 · 约 1.8×") }, { value: '2.5', label: t("深度 · 约 2.5×") }, { value: 'custom', label: t("固定字符数") }]} onChange={(value) => {
                    if (value === 'custom') setDraftSelectionExpansion({ ...draftSelectionExpansion, targetLength: { mode: 'characters', characters: 800 } });
                    if (value === '1.3' || value === '1.8' || value === '2.5') setDraftSelectionExpansion({ ...draftSelectionExpansion, targetLength: { mode: 'ratio', ratio: Number(value) as 1.3 | 1.8 | 2.5 } });
                  }} />{draftSelectionExpansion.targetLength.mode === 'characters' ? <NumberInput aria-label={t("扩写目标有效字符数")} min={100} max={40_000} allowDecimal={false} value={draftSelectionExpansion.targetLength.characters} onChange={(value) => typeof value === 'number' && setDraftSelectionExpansion({ ...draftSelectionExpansion, targetLength: { mode: 'characters', characters: value } })} /> : null}</Stack></SettingsField>
                  <SimpleGrid className="selection-expansion-options" cols={{ base: 1, md: 3 }} spacing="md">
                    <SettingsField title={t("写作风格")}><Select aria-label={t("扩写写作风格")} value={draftSelectionExpansion.style} data={[{ value: 'preserve', label: t("沿用原文") }, { value: 'professional', label: t("专业说明") }, { value: 'academic', label: t("学术严谨") }, { value: 'plain', label: t("通俗解释") }, { value: 'proposal', label: t("方案文档") }]} onChange={(value) => value && setDraftSelectionExpansion({ ...draftSelectionExpansion, style: value as SelectionExpansionSettings['style'] })} /></SettingsField>
                    <SettingsField title={t("目标读者")} description={t("决定解释深度。")}><Select aria-label={t("扩写目标读者")} value={draftSelectionExpansion.audience} data={[{ value: 'preserve', label: t("沿用原文") }, { value: 'beginner', label: t("初学者") }, { value: 'professional', label: t("专业人员") }, { value: 'manager', label: t("管理者") }]} onChange={(value) => value && setDraftSelectionExpansion({ ...draftSelectionExpansion, audience: value as SelectionExpansionSettings['audience'] })} /></SettingsField>
                    <SettingsField title={t("思考强度")}><Select aria-label={t("扩写思考强度")} value={draftSelectionExpansion.reasoningDepth} data={[{ value: 'fast', label: t("快速") }, { value: 'standard', label: t("标准") }, { value: 'deep', label: t("深入") }]} onChange={(value) => value && setDraftSelectionExpansion({ ...draftSelectionExpansion, reasoningDepth: value as SelectionExpansionSettings['reasoningDepth'] })} /></SettingsField>
                  </SimpleGrid>
                  <SettingsField title={t("证据范围")} description={t("后续来源会随可用能力逐步开放。")}><Stack gap="xs"><Checkbox checked disabled label={t("当前笔记")} /><Text size="xs" c="dimmed">{t("同库 Markdown、资料库和联网补充尚未开放，因此不会因保存设置而被启用。")}</Text></Stack></SettingsField>
                  <SettingsField title={t("自定义要求")} description={t("补充本次扩写要求。")}><Textarea aria-label={t("扩写自定义要求")} value={draftSelectionExpansion.customInstruction} maxLength={500} minRows={3} autosize placeholder={t("例如：补充适合作为方案说明的过渡与边界条件")} onChange={(event) => setDraftSelectionExpansion({ ...draftSelectionExpansion, customInstruction: event.currentTarget.value })} /></SettingsField>
                  <Group className="settings-actions-row" justify="flex-end"><Button leftSection={<CheckCircle2 size={16} />} loading={isSavingSelectionExpansion} onClick={() => void saveSelectionExpansionDefaults()}>{t("保存扩写默认设置")}</Button></Group>
                </Stack> : <Text size="sm" c="dimmed">{t("正在读取选区扩写优化设置…")}</Text>}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="model">
              <SettingsSection group={t("AI 设置")} title={t("模型配置")}>
                <Box className="settings-model-content" pt="md">
                    <Transition mounted={modelSettingsTab === 'profiles'} transition="fade-right" duration={220} timingFunction="ease">
                      {(styles) => <Box style={styles} pt="lg"><ModelConnectionList rows={visibleConfiguredModels} totalRows={configuredModelRows.length} languageProfileCount={draftModelSettings.profiles.length} page={modelProfilePage} pageCount={modelProfilePageCount} selectedProfileId={selectedProfileId} selectedCategory={modelCategory} onPageChange={setModelProfilePage} onAdd={startAddModelConnection} onOpen={(row) => {
                        setModelCategory(row.category);
                        if (row.category === 'generation') selectProfile(row.id);
                        else setModelSettingsTab('config');
                      }} onDeleteProfile={deleteModelProfile} /></Box>}
                    </Transition>

                  <Transition mounted={modelSettingsTab === 'add'} transition="fade-left" duration={220} timingFunction="ease">
                    {(styles) => <Box style={styles} pt="lg" className="settings-add-model-connection">
                      <Group justify="space-between" align="center" mb="md">
                        <Button size="sm" variant="subtle" color="gray" leftSection={<ArrowLeft size={15} />} onClick={() => setModelSettingsTab('profiles')}>{t("返回模型列表")}</Button>
                        <Text size="sm" c="dimmed">{t("添加模型连接")}</Text>
                      </Group>
                      <Box className="settings-add-model-header"><Text fw={700}>{t("先选择模型类别")}</Text><Text size="xs" c="dimmed" mt={3}>{t("选择后进入对应的厂商和模型配置。")}</Text></Box>
                      <ModelCategoryPicker value={null} modelSettings={draftModelSettings} modelHub={draftModelHub} onChange={chooseModelCategoryForAdd} />
                    </Box>}
                  </Transition>

                  <Transition mounted={modelSettingsTab === 'config' && modelCategory === 'generation'} transition="fade-left" duration={220} timingFunction="ease">
                    {(styles) => <Box style={styles} pt="md">
                <Group justify="space-between" align="center" mb="md">
                  <Button size="sm" variant="subtle" color="gray" leftSection={<ArrowLeft size={15} />} onClick={() => setModelSettingsTab('profiles')}>{t("返回连接列表")}</Button>
                  <Text size="sm" c="dimmed">{t("语言模型")}</Text>
                </Group>
                <Paper withBorder radius="lg" p="xl" className="settings-model-card">
                  <Group className="settings-model-card-header" justify="space-between" align="center" wrap="nowrap" gap="md">
                    <Group gap="sm" wrap="nowrap"><ThemeIcon size={38} radius="md" variant="light" color="brand"><Bot size={19} /></ThemeIcon><Box><Text fw={700}>{selectedProfile?.label || getDefaultModelProfileLabel(draftAi)}</Text><Text size="xs" c="dimmed" mt={3}>{draftAi.kind === 'ollama' ? t("本地 Ollama") : remoteProviders.find((entry) => entry.value === selectedRemoteProvider)?.label ?? t("远程 API")}</Text></Box></Group>
                    <Badge variant="light" color={draftAi.kind === 'ollama' ? 'teal' : 'gray'}>{selectedProfile?.id === draftModelSettings.defaultProfileId ? t("默认") : draftAi.kind === 'ollama' ? t("本地") : t("远程 API")}</Badge>
                  </Group>
                  <Divider className="settings-model-card-divider" />
                  <Stack gap="lg" className="settings-model-card-content">
                    <SettingsField variant="plain" title={t("名称")}><Stack gap="xs"><TextInput aria-label={t("模型档案名称")} value={selectedProfile?.label ?? ''} placeholder={getDefaultModelProfileLabel(draftAi)} onChange={(event) => updateSelectedProfile({ label: event.currentTarget.value })} /><Group gap="xs"><Button size="xs" variant={selectedProfile?.id === draftModelSettings.defaultProfileId ? 'light' : 'default'} color="gray" disabled={!selectedProfile || selectedProfile.id === draftModelSettings.defaultProfileId} onClick={() => selectedProfile && setDraftModelSettings((current) => ({ ...current, defaultProfileId: selectedProfile.id }))}>{t("设为默认")}</Button><Button size="xs" variant="subtle" color="red" leftSection={<Trash2 size={14} />} disabled={!selectedProfile || selectedProfile.id === draftModelSettings.defaultProfileId || draftModelSettings.profiles.length <= 1} onClick={deleteSelectedProfile}>{t("删除连接")}</Button></Group></Stack></SettingsField>
                    <SettingsField variant="plain" title={t("连接方式")}><Select aria-label={t("使用方式")} value={draftAi.kind} data={[{ value: 'ollama', label: t("本地模型（Ollama）") }, { value: 'openai-compatible', label: t("远程 API") }]} onChange={(value) => {
                      if (!value) return;
                      const kind = value as AiProviderConfig['kind'];
                      const defaultProvider = remoteProviders[0];
                      setDraftAi(kind === 'openai-compatible'
                        ? { ...draftAi, kind, provider: draftAi.provider ?? defaultProvider.value, api: defaultProvider.api, endpoint: draftAi.endpoint || defaultProvider.endpoint, model: '', contextWindowTokens: undefined, contextWindowTokensSource: undefined, availableModels: [], remoteContentConsent: true }
                        : { ...draftAi, kind, provider: undefined, api: 'ollama-chat', model: '', contextWindowTokens: undefined, contextWindowTokensSource: undefined, availableModels: [], remoteContentConsent: true });
                      setAiStatus(null);
                    }} /></SettingsField>
                    {draftAi.kind === 'openai-compatible' ? <SettingsField variant="plain" title={t("API 厂商")} description={t("选择服务商后自动填入默认地址。")}><ProviderSelect aria-label={t("API 厂商")} value={selectedRemoteProvider} data={remoteProviders.map((provider) => ({ value: provider.value, label: t(provider.label) }))} onChange={(value) => value && selectRemoteProvider(value as AiRemoteProviderId)} /></SettingsField> : null}
                    <SettingsField variant="plain" title={draftAi.kind === 'ollama' ? t("Ollama 地址") : t("API 地址")} description={draftAi.kind === 'ollama' ? t("本地服务地址。") : t("支持代理或兼容网关。")}>{draftAi.kind === 'ollama' ? <TextInput aria-label={t("Ollama 地址")} value={draftAi.endpoint ?? ''} onChange={(event) => setDraftAi({ ...draftAi, endpoint: event.currentTarget.value })} placeholder="http://127.0.0.1:11434" /> : <Group gap="xs" wrap="nowrap"><TextInput aria-label={t("API 地址")} style={{ flex: 1 }} value={draftAi.endpoint ?? ''} onChange={(event) => setDraftAi({ ...draftAi, endpoint: event.currentTarget.value })} placeholder="https://api.openai.com/v1" /><Button variant="subtle" color="gray" size="xs" onClick={() => setDraftAi({ ...draftAi, endpoint: remoteProviders.find((provider) => provider.value === selectedRemoteProvider)?.endpoint ?? '' })}>{t("恢复默认")}</Button></Group>}</SettingsField>
                    {draftAi.kind === 'openai-compatible' ? <>
                      <SettingsField variant="plain" title="API Key" description={t("留空不会覆盖已保存密钥。")}><PasswordInput aria-label="API Key" value={draftAi.apiKey ?? ''} onChange={(event) => setDraftAi({ ...draftAi, apiKey: event.currentTarget.value })} placeholder={draftAi.hasApiKey ? t("已保存；留空保持不变") : t("请输入 API Key")} /></SettingsField>
                      <RemoteModelField variant="plain" value={draftAi.model ?? ''} models={modelNames} custom={customGenerationModel} loading={isFetchingModels} onCustomChange={setCustomGenerationModel} onChange={(model) => setDraftAi((current) => ({ ...current, model }))} onFetch={() => void fetchModels()} />
                    </> : <ModelField variant="plain" title={t("生成模型")} description={t("用于摘要、问答、实体提取和整理建议。")} value={draftAi.model ?? ''} models={modelNames} custom={customGenerationModel} onCustomChange={setCustomGenerationModel} onChange={(model) => setDraftAi((current) => ({ ...current, model }))} />}
                    <SettingsField variant="plain" title={t("上下文窗口")} description={t("自动识别模型窗口，可设置更低的使用上限。")}><Stack gap="xs"><Group gap="xs" align="end" wrap="wrap"><Select aria-label={t("用户上下文上限")} label={t("用户上限（可选）")} allowDeselect={false} value={draftAi.contextWindowTokensSource === 'user' && draftAi.contextWindowTokens ? String(draftAi.contextWindowTokens) : 'auto'} data={[
                      { value: 'auto', label: t("自动识别") },
                      ...contextWindowPresetTokens.map((tokens) => ({ value: String(tokens), label: formatContextWindowTokens(tokens) })),
                      ...(draftAi.contextWindowTokensSource === 'user' && draftAi.contextWindowTokens && !contextWindowPresetTokens.some((tokens) => tokens === draftAi.contextWindowTokens)
                        ? [{ value: String(draftAi.contextWindowTokens), label: t("{0}（现有设置）", { '0': formatContextWindowTokens(draftAi.contextWindowTokens) }) }]
                        : []),
                    ]} onChange={(value) => {
                      const tokens = value && value !== 'auto' ? Number(value) : undefined;
                      setDraftAi({ ...draftAi, contextWindowTokens: tokens, contextWindowTokensSource: tokens ? 'user' : undefined });
                    }} /><Badge variant="light" color={contextWindowPreview.confidence === 'estimated' ? 'orange' : 'teal'}>{t("有效")} {formatContextWindowTokens(contextWindowPreview.tokens)}</Badge></Group><Text size="xs" c="dimmed">{t("来源：")}{getContextWindowSourceLabel(contextWindowPreview.source)}</Text>{contextWindowPreview.warning ? <Text size="xs" c="orange">{contextWindowPreview.warning}</Text> : null}</Stack></SettingsField>
                    {guidedModel && draftAi.kind === 'openai-compatible' && <Text size="xs" c="dimmed">{t('提问内容会发送到你选择的远程模型服务。')}</Text>}
                    <Group className="settings-actions-row" gap="sm"><Button data-onboarding-anchor="test-model" variant="default" leftSection={<RefreshCw size={16} />} loading={isTesting} disabled={isSaving} onClick={() => void testConnection()}>{t("测试连接")}</Button><Button data-onboarding-anchor="save-model" leftSection={<CheckCircle2 size={16} />} loading={isSaving} disabled={isTesting} onClick={() => void saveAi()}>{t("保存模型设置")}</Button></Group>
                  </Stack>
                </Paper>
                    </Box>}
                  </Transition>

                  <Transition mounted={modelSettingsTab === 'config' && modelCategory !== 'generation'} transition="fade-left" duration={220} timingFunction="ease">
                    {(styles) => <Box style={styles} pt="md">
                      <Group justify="space-between" align="center" mb="md">
                        <Button size="sm" variant="subtle" color="gray" leftSection={<ArrowLeft size={15} />} onClick={() => setModelSettingsTab('profiles')}>{t("返回模型列表")}</Button>
                        <Text size="sm" c="dimmed">{getModelCategoryLabel(modelCategory)}</Text>
                      </Group>
                      <ModelHubCategoryPanel modelHub={draftModelHub} category={modelCategory} aiStatus={aiStatus} onFetchModelProviderModels={onFetchModelProviderModels} onSaveModelConfiguration={async (change) => { const saved = await onSaveModelConfiguration(change); setDraftModelHub(saved); return saved; }} setFeedback={setFeedback} setError={setError} />
                    </Box>}
                  </Transition>
                </Box>
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="skills">
              <SettingsSection group={t("AI 设置")} title={t("AI 助手技能")}>
                <Modal opened={Boolean(viewingSkillId)} onClose={() => setViewingSkillId(null)} title={t("技能详情")} centered>
                  {viewingSkillId ? (() => {
                    const skill = draftExtensions.skills.find((entry) => entry.id === viewingSkillId);
                    return skill ? <Stack gap="sm"><Group gap="xs"><Text fw={700}>{skill.name}</Text><Badge size="xs" variant="light" color={skill.system ? 'blue' : 'gray'}>{skill.system ? t("内置") : t("自定义")}</Badge><Badge size="xs" variant="outline" color="gray">{getSkillGenerationStyleLabel(skill.generationStyle)}</Badge></Group><Text size="xs" c="dimmed">{t("能力描述")}</Text><Text size="sm">{skill.description}</Text><Text size="xs" c="dimmed">{t("工作约束")}</Text><Paper withBorder radius="sm" p="sm"><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{skill.instruction}</Text></Paper></Stack> : null;
                  })() : null}
                </Modal>
                <Modal opened={Boolean(viewingDirectoryName)} onClose={() => setViewingDirectoryName(null)} title={t("技能详情")} centered>
                  {viewingDirectoryName ? (() => {
                    const skill = skillsOverview?.directorySkills.find((entry) => entry.name === viewingDirectoryName);
                    return skill ? <Stack gap="sm"><Group gap="xs"><Text fw={700}>{skill.name}</Text><Badge size="xs" variant="light" color={skill.importedAt ? 'grape' : 'gray'}>{skill.importedAt ? t("导入") : t("外部放置")}</Badge>{skill.resourceFileCount > 0 ? <Badge size="xs" variant="outline" color="gray">{skill.resourceFileCount} {t("个附加文件")}</Badge> : null}</Group><Text size="xs" c="dimmed">{t("能力描述（常驻技能目录）")}</Text><Text size="sm">{skill.description}</Text><Text size="xs" c="dimmed">{t("工作约束")}</Text><Paper withBorder radius="sm" p="sm"><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{skill.instruction}</Text></Paper></Stack> : null;
                  })() : null}
                </Modal>
                <Modal opened={Boolean(editingDirectoryName)} onClose={() => setEditingDirectoryName(null)} title={editingDirectoryName ? t("编辑目录技能：{0}", { '0': editingDirectoryName }) : t("编辑目录技能")} centered>
                  <Stack gap="sm">
                    <Text size="xs" c="dimmed">{t("技能名称与目录名保持一致（AI-Skill/")}{editingDirectoryName ?? ''}{t("/）；如需改名请直接重命名文件夹，会视为新技能。")}</Text>
                    <TextInput label={t("技能名称")} value={editingDirectoryName ?? ''} disabled />
                    <TextInput label={t("能力描述")} description={t("常驻技能目录；保持简短，不包含完整规则正文。")} aria-label={t("目录技能能力描述")} value={editingSkillDescription} onChange={(event) => setEditingSkillDescription(event.currentTarget.value)} />
                    <Textarea label={t("工作约束")} description={t("调用技能时使用。")} aria-label={t("目录技能工作约束")} minRows={4} maxRows={10} autosize value={editingSkillInstruction} onChange={(event) => setEditingSkillInstruction(event.currentTarget.value)} />
                    <Group justify="flex-end"><Button loading={savingDirectorySkill} onClick={() => void saveDirectorySkillDocument()}>{t("保存")}</Button></Group>
                  </Stack>
                </Modal>
                {editingSkillId === null ? <Box className="settings-profile-browser settings-skill-library">
                  <Group justify="space-between" align="center" gap="md" wrap="wrap">
                    <Box>
                      <Group gap="xs"><Text fw={700}>{t("技能库")}</Text><Badge size="sm" variant="light" color="gray">{skillLibraryRows.length}</Badge></Group>
                      <Text size="xs" c="dimmed" mt={4}>{t("启用后可在助手中选择，每轮最多 3 个；仅使用本轮选中技能的工作约束。")}</Text>
                    </Box>
                    <Group gap="xs">
                      <Button size="sm" variant="light" leftSection={<Plus size={15} />} onClick={() => setEditingSkillId('new')} disabled={Boolean(savingSkillId)}>{t("新建技能")}</Button>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target><Button size="sm" variant="default" leftSection={<FolderOpen size={15} />} loading={importingSkill}>{t("导入技能")}</Button></Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item onClick={() => void importSkill('folder')}>{t("选择文件夹（内含 SKILL.md）")}</Menu.Item>
                          <Menu.Item onClick={() => void importSkill('zip')}>{t("选择 .zip 技能包")}</Menu.Item>
                          <Menu.Item onClick={() => void importSkill('markdown')}>{t("选择 SKILL.md 文件")}</Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Group>
                  <Group justify="space-between" align="center" mt="md" gap="sm" wrap="wrap">
                    <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{workspacePath ? `${workspacePath}\\AI-Skill` : t("AI-Skill 文件夹")} {t("· 状态切换会立即保存")}</Text>
                  </Group>
                  {skillsOverview && (skillsOverview.skipped.length > 0 || skillsOverview.nameConflicts.length > 0) ? <Alert color="yellow" variant="light" icon={<AlertTriangle size={18} />} mt="sm" title={t("部分目录技能未生效")}><Stack gap={4}>{[...skillsOverview.skipped.map((issue) => `${issue.directory}：${issue.reason}`), ...skillsOverview.nameConflicts.map((issue) => `${issue.directory}：${issue.reason}`)].map((line) => <Text key={line} size="xs">{line}</Text>)}</Stack></Alert> : null}
                  <Box mt="md">
                    <Table className="settings-profile-table settings-skill-library-table" highlightOnHover withColumnBorders={false} verticalSpacing="sm">
                      <Table.Thead><Table.Tr><Table.Th>{t("技能")}</Table.Th><Table.Th>{t("能力描述")}</Table.Th><Table.Th>{t("状态")}</Table.Th><Table.Th>{t("操作")}</Table.Th></Table.Tr></Table.Thead>
                      <Table.Tbody>
                        {skillLibraryRows.length === 0 ? <Table.Tr><Table.Td colSpan={4}><Text size="sm" c="dimmed" ta="center" py="md">{t("还没有技能，可以新建或导入。")}</Text></Table.Td></Table.Tr> : visibleSkillLibraryRows.map((row) => <Table.Tr key={row.key}>
                          <Table.Td><Stack gap={6}><Text fw={650} size="sm" style={{ overflowWrap: 'anywhere' }}>{row.skill.name}</Text><Group gap={4}>{row.kind === 'settings' ? <Badge size="xs" variant="light" color="gray">{t("自定义")}</Badge> : <Badge size="xs" variant="light" color={row.skill.system ? 'blue' : row.skill.importedAt ? 'grape' : 'gray'}>{row.skill.system ? t("内置") : row.skill.importedAt ? t("导入") : t("自定义")}</Badge>}{row.kind === 'directory' && row.skill.resourceFileCount > 0 ? <Badge size="xs" variant="outline" color="gray">{row.skill.resourceFileCount} {t("个附加文件")}</Badge> : null}</Group></Stack></Table.Td>
                          <Table.Td><Text size="xs" c="dimmed" lineClamp={3} title={row.skill.description} style={{ overflowWrap: 'anywhere' }}>{row.skill.description}</Text></Table.Td>
                          <Table.Td>{row.kind === 'settings' ? <Switch size="sm" checked={row.skill.enabled} disabled={Boolean(savingSkillId)} onChange={(event) => void saveSkillEnabled(row.skill.id, event.currentTarget.checked)} aria-label={t("启用{0}", { '0': row.skill.name })} /> : <Switch size="sm" checked={row.skill.enabled} disabled={Boolean(savingSkillId)} onChange={(event) => void saveDirectorySkillEnabled(row.skill.name, event.currentTarget.checked)} aria-label={t("启用目录技能{0}", { '0': row.skill.name })} />}</Table.Td>
                          <Table.Td>{row.kind === 'settings' ? <Group className="settings-skill-actions" gap={4} wrap="wrap"><Button size="compact-xs" variant="subtle" color="gray" onClick={() => setViewingSkillId(row.skill.id)}>{t("查看")}</Button><Button size="compact-xs" variant="subtle" color="gray" disabled={Boolean(savingSkillId)} onClick={() => setEditingSkillId(row.skill.id)}>{t("编辑")}</Button></Group> : <Group className="settings-skill-actions" gap={4} wrap="wrap"><Button size="compact-xs" variant="subtle" color="gray" onClick={() => setViewingDirectoryName(row.skill.name)}>{t("查看")}</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={() => openDirectorySkillEditor(row.skill.name)}>{t("编辑")}</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={() => void window.electronAPI.revealAiSkill(row.skill.name)}>{t("打开目录")}</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={() => void exportDirectorySkill(row.skill.name)}>{t("导出")}</Button>{row.skill.importedAt && !row.skill.system ? <Button size="compact-xs" variant="subtle" color="red" onClick={() => void removeDirectorySkill(row.skill.name)}>{t("删除")}</Button> : null}</Group>}</Table.Td>
                        </Table.Tr>)}
                      </Table.Tbody>
                    </Table>
                  </Box>
                  {skillLibraryRows.length ? <Group className="settings-profile-pagination" justify="space-between" wrap="wrap" gap="sm"><Text size="xs" c="dimmed">{(currentSkillLibraryPage - 1) * SKILL_LIBRARY_PAGE_SIZE + 1}–{Math.min(currentSkillLibraryPage * SKILL_LIBRARY_PAGE_SIZE, skillLibraryRows.length)} / {skillLibraryRows.length}</Text><Pagination size="sm" total={skillLibraryPageCount} value={currentSkillLibraryPage} onChange={setSkillLibraryPage} /></Group> : null}
                </Box> : editingSkillId === 'new' ? <Paper withBorder radius="md" p="md">
                  <Stack gap="md">
                    <Group justify="space-between" align="center" wrap="wrap"><Button size="sm" variant="subtle" color="gray" leftSection={<ArrowLeft size={15} />} onClick={() => { setEditingSkillId(null); setNewSkillName(''); setNewSkillDescription(''); setNewSkillInstruction(''); }}>{t("返回技能列表")}</Button><Text size="sm" c="dimmed">{t("新建 AI 助手 Skill")}</Text></Group>
                    <TextInput label={t("技能名称")} aria-label={t("新 AI 助手技能名称")} value={newSkillName} onChange={(event) => setNewSkillName(event.currentTarget.value)} placeholder={t("例如：会议纪要")} />
                    <TextInput label={t("能力描述")} description={t("始终只在 Skill 目录中展示，用于选择，不加载正文。")} aria-label={t("新 AI 助手技能能力描述")} value={newSkillDescription} onChange={(event) => setNewSkillDescription(event.currentTarget.value)} placeholder={t("例如：把会议记录整理为结论和可执行待办。")} />
                    <Textarea label={t("工作约束")} description={t("选用技能时使用。")} aria-label={t("新 AI 助手技能工作约束")} value={newSkillInstruction} onChange={(event) => setNewSkillInstruction(event.currentTarget.value)} minRows={4} maxRows={8} autosize placeholder={t("例如：按议题、结论、待办和负责人整理；资料没有提及的信息必须标记为待确认。")} />
                    <Text size="xs" c="dimmed">{t("技能及附加文档保存在工作区 AI-Skill 文件夹，可随时编辑或导出。")}</Text>
                    <Group justify="flex-end"><Button leftSection={<Plus size={15} />} loading={isSaving} onClick={() => void addSkill()}>{t("创建技能")}</Button></Group>
                  </Stack>
                </Paper> : (() => {
                  const skill = draftExtensions.skills.find((entry) => entry.id === editingSkillId);
                  if (!skill) return null;
                  return <Paper withBorder radius="md" p="md">
                    <Stack gap="md">
                      <Group justify="space-between" align="center" wrap="wrap"><Button size="sm" variant="subtle" color="gray" leftSection={<ArrowLeft size={15} />} onClick={() => setEditingSkillId(null)}>{t("返回技能列表")}</Button><Text size="sm" c="dimmed">{t("配置 AI 助手 Skill")}</Text></Group>
                      <TextInput label={t("技能名称")} aria-label={t("{0}名称", { '0': skill.name })} value={skill.name} onChange={(event) => updateSkill(skill.id, { name: event.currentTarget.value })} />
                      <TextInput label={t("能力描述")} description={t("简要说明技能用途。")} aria-label={t("{0}能力描述", { '0': skill.name })} value={skill.description} onChange={(event) => updateSkill(skill.id, { description: event.currentTarget.value })} />
                      <Textarea label={t("工作约束")} description={t("选用技能时使用。")} aria-label={t("{0}工作约束", { '0': skill.name })} minRows={4} maxRows={8} autosize value={skill.instruction} onChange={(event) => updateSkill(skill.id, { instruction: event.currentTarget.value })} />
                      <Select label={t("生成风格")} description={t("仅影响普通聊天的表达方式。")} aria-label={t("{0}生成风格", { '0': skill.name })} value={skill.generationStyle} data={localizeOptions(skillGenerationStyleOptions)} onChange={(value) => value && updateSkill(skill.id, { generationStyle: value as AiSkillGenerationStyle })} />

                      <Group justify="space-between" wrap="wrap">{skill.system ? <span /> : <Button size="sm" variant="subtle" color="red" leftSection={<Trash2 size={14} />} loading={isSaving} onClick={() => void deleteSkill(skill.id)}>{t("删除 Skill")}</Button>}<Button loading={isSaving} onClick={() => void saveExtensions()}>{t("保存编辑")}</Button></Group>
                    </Stack>
                  </Paper>;
                })()}
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="user-information">
              <SettingsSection group={t("AI 设置")} title={t("用户记忆")}>
                <UserInformationSettings setFeedback={setFeedback} setError={setError} reviewRequest={memoryReviewRequest} />
              </SettingsSection>
            </Tabs.Panel>

            <Tabs.Panel value="about">
              <SettingsSection group={t("系统")} title={t("关于与诊断")}>
                <CapabilityPanel />
                <ReleaseCheck />
                <Paper withBorder radius="md" p="md" className="settings-about-card">
                  <Stack gap="sm">
                    <Group gap="sm"><BrandMark size={36} /><Text size="xl" fw={700}>{APP_INFO.name}</Text><Badge variant="light">v{APP_INFO.version}</Badge></Group>
                    <Text size="sm" c="dimmed" lh={1.6}>{t("Windows 本地优先 AI 知识工作台，集 Markdown 笔记、资料管理、知识检索与智能问答于一体。")}</Text>
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm"><AboutFact label={t("开发者")}>{APP_INFO.author}</AboutFact><AboutFact label={t("GitHub 仓库")} valueClassName="break-all">{APP_INFO.repositoryUrl.replace('https://github.com/', '')}</AboutFact></SimpleGrid>
                    <Group gap="sm" wrap="wrap">
                      <Button component="a" href={APP_INFO.repositoryUrl} target="_blank" rel="noopener noreferrer" variant="light" leftSection={<Github size={16} />}>{t("GitHub 源码")}</Button>
                      <Button component="a" href={`${APP_INFO.repositoryUrl}/releases`} target="_blank" rel="noopener noreferrer" variant="default" leftSection={<ExternalLink size={16} />}>{t("版本发布")}</Button>
                      <Button component="a" href={`${APP_INFO.repositoryUrl}/issues`} target="_blank" rel="noopener noreferrer" variant="default">{t("问题反馈")}</Button>
                    </Group>
                  </Stack>
                </Paper>
                <Paper withBorder radius="md" p="md" className="settings-about-card">
                  <Text size="sm" fw={600} mb="sm">{t("运行诊断")}</Text>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md"><AboutFact label={t("运行环境")}>{diagnostics ? `Electron ${diagnostics.electronVersion}` : t("读取中…")}</AboutFact><AboutFact label={t("系统平台")}>{diagnostics ? `${diagnostics.platform} ${diagnostics.architecture}` : t("读取中…")}</AboutFact><AboutFact label={t("已索引笔记")}>{diagnostics?.noteCount ?? 0}</AboutFact><AboutFact label={t("日志目录")} valueClassName="break-all">{diagnostics?.logsPath ?? t("读取中…")}</AboutFact></SimpleGrid>
                </Paper>
                <Group className="settings-actions-row" gap="sm"><Button variant="light" leftSection={<FolderOpen size={16} />} onClick={() => void window.electronAPI.openLogsDirectory()}>{t("打开日志目录")}</Button><Button variant="default" onClick={() => void window.electronAPI.exportDiagnosticReport().then((saved) => saved && setFeedback(t("诊断信息已导出。")))}>{t("导出诊断信息")}</Button></Group>
                <Accordion variant="contained" className="settings-license"><Accordion.Item value="license"><Accordion.Control>{t("项目许可与第三方依赖")}</Accordion.Control><Accordion.Panel><Stack gap="xs"><Text size="sm">{t("项目许可证：待确定，正式许可将以 GitHub 仓库中的 LICENSE 文件为准。")}</Text><Text size="sm">{t("第三方依赖包括 Electron、React、Tiptap / ProseMirror、CodeMirror、remark / unified、MiniSearch、SQLite、sqlite-vec、LangGraph、Cytoscape 等，各依赖遵循其自身许可证。")}</Text></Stack></Accordion.Panel></Accordion.Item></Accordion>
              </SettingsSection>
            </Tabs.Panel>

          </Box>
        </ScrollArea>
      </Tabs>
      <Transition mounted={Boolean(error || feedback)} transition="pop" duration={160} timingFunction="ease-out">
        {(styles) => error
          ? <Alert style={styles} className="settings-notification settings-error" color="red" variant="light" icon={<AlertTriangle size={18} />} role="alert">{error ? t(error) : null}</Alert>
          : <Alert style={styles} className="settings-notification settings-feedback" color="teal" variant="light" icon={<CheckCircle2 size={18} />} role="status">{feedback ? t(feedback) : null}</Alert>}
      </Transition>
    </Box>
  );
}

const modelCategoryOptions: Array<{ value: ModelSlotId; label: string; description: string; icon: ReactNode }> = [
  { value: 'generation', label: '语言模型', description: '摘要、问答与笔记整理', icon: <Bot size={18} /> },
  { value: 'embedding', label: 'Embedding', description: '语义索引与向量召回', icon: <Sparkles size={18} /> },
  { value: 'rerank', label: 'Rerank', description: '候选结果的精排模型', icon: <Filter size={18} /> },
];

function ModelCategoryPicker({ value, modelSettings, modelHub, onChange }: { value: ModelSlotId | null; modelSettings: AiModelSettings; modelHub: ModelHub; onChange: (value: ModelSlotId) => void }) {
  useI18n();
  return <Box className="settings-model-category-picker" role="radiogroup" aria-label={t("选择模型用途")}>
    {modelCategoryOptions.map((option) => <UnstyledButton key={option.value} className="settings-model-category-option" data-active={option.value === value || undefined} role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>
      <ThemeIcon className="settings-model-category-icon" size={30} radius="md" variant={option.value === value ? 'light' : 'transparent'} color="brand" aria-hidden="true">{option.icon}</ThemeIcon>
      <Box className="settings-model-category-copy">
        <Text component="span" fw={700} size="sm">{t(option.label)}</Text>
        <Text component="span" size="xs" c="dimmed" lineClamp={1}>{getModelCategorySummary(option.value, modelSettings, modelHub)}</Text>
      </Box>
    </UnstyledButton>)}
  </Box>;
}

function ParsingRouteRow({ title, description, badge, color, last = false }: { title: string; description: string; badge: string; color: string; last?: boolean }) {
  useI18n();
  return <Box className={`settings-parsing-route-row${last ? ' is-last' : ''}`}><Box className="settings-parsing-route-copy"><Text size="sm" fw={650}>{title}</Text><Text size="xs" c="dimmed" mt={4} lh={1.5}>{description}</Text></Box><Badge variant="light" color={color} className="settings-parsing-route-badge">{badge}</Badge></Box>;
}

function ParsingEngineCard({ engine, icon, title, scope, suitable, formats, boundary }: { engine: 'mammoth' | 'mineru'; icon: ReactNode; title: string; scope: string; suitable: string; formats: string[]; boundary: string }) {
  useI18n();
  const color = engine === 'mammoth' ? 'teal' : 'orange';
  return <Paper withBorder radius="lg" p="lg" className="settings-parsing-engine-card" data-engine={engine}>
    <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap"><Group gap="sm" wrap="nowrap"><ThemeIcon size={34} radius="md" variant="light" color={color}>{icon}</ThemeIcon><Box><Text fw={700}>{title}</Text><Text size="xs" c="dimmed" mt={2}>{scope}</Text></Box></Group><Badge size="xs" variant="light" color={color}>{engine === 'mammoth' ? t("轻量本地") : t("复杂 PDF")}</Badge></Group>
    <Text size="xs" c="dimmed" mt="lg">{t("更适合")}</Text>
    <Text size="sm" lh={1.65} mt={4}>{suitable}</Text>
    <Group gap={6} mt="md">{formats.map((format) => <Badge key={format} size="xs" variant="outline" color={color}>{format}</Badge>)}</Group>
    <Divider my="md" />
    <Text size="xs" c="dimmed" lh={1.55}>{boundary}</Text>
  </Paper>;
}

function getSkillGenerationStyleLabel(style: AiSkillGenerationStyle): string {
  return t(skillGenerationStyleOptions.find((option) => option.value === style)?.label ?? "均衡表达");
}

function formatContextWindowTokens(tokens: number): string {
  return tokens % 1_024 === 0 ? `${tokens / 1_024}K` : tokens.toLocaleString(getAppLanguage());
}

function getContextWindowSourceLabel(source: ReturnType<typeof resolveEffectiveContextWindow>['source']): string {
  if (source === 'provider') return t("服务商实时元数据");
  if (source === 'ollama') return t("Ollama 运行时");
  if (source === 'known-model') return t("模型目录");
  if (source === 'configured') return t("用户设置（待校验）");
  if (source === 'application-fixed') return 'Legacy Fixed128K';
  return t("未知模型保守值");
}

function getModelCategorySummary(category: ModelSlotId, modelSettings: AiModelSettings, modelHub: ModelHub): string {
  if (category === 'generation') {
    const profile = modelSettings.profiles.find((entry) => entry.id === modelSettings.defaultProfileId) ?? modelSettings.profiles[0];
    if (!profile) return t("未配置");
    const provider = profile.config.kind === 'ollama'
      ? t("本地 Ollama")
      : remoteProviders.find((entry) => entry.value === profile.config.provider)?.label ?? t("远程 API");
    return `${provider} · ${profile.config.model || t("未选择模型")}`;
  }

  const slot = modelHub.slots[category];
  if (slot.source === 'none') return t("未启用");
  const provider = slot.source === 'ollama'
    ? t("本地 Ollama")
    : modelHub.providers.find((entry) => entry.id === slot.source)?.label ?? t("远程 API");
  return `${provider} · ${slot.model || t("未选择模型")}`;
}

function getModelCategoryLabel(category: ModelSlotId): string {
  return t(modelCategoryOptions.find((option) => option.value === category)?.label ?? category);
}

function ModelConnectionList({ rows, totalRows, languageProfileCount, page, pageCount, selectedProfileId, selectedCategory, onPageChange, onAdd, onOpen, onDeleteProfile }: {
  rows: ConfiguredModelRow[];
  totalRows: number;
  languageProfileCount: number;
  page: number;
  pageCount: number;
  selectedProfileId: string;
  selectedCategory: ModelSlotId;
  onPageChange: (page: number) => void;
  onAdd: () => void;
  onOpen: (row: ConfiguredModelRow) => void;
  onDeleteProfile: (id: string) => void;
}) {
  useI18n();
  return <Box className="settings-profile-browser">
    <Group justify="space-between" align="center" gap="md" wrap="wrap">
      <Group gap="xs"><Text fw={700}>{t("已配置模型")}</Text><Badge size="sm" variant="light" color="gray">{totalRows}</Badge></Group>
      <Button size="sm" variant="light" leftSection={<Plus size={15} />} onClick={onAdd}>{t("添加连接")}</Button>
    </Group>
    {rows.length ? <Table.ScrollContainer minWidth={760} mt="md">
      <Table className="settings-profile-table" highlightOnHover withColumnBorders={false} verticalSpacing="sm">
        <Table.Thead><Table.Tr><Table.Th>{t("名称")}</Table.Th><Table.Th>{t("类型")}</Table.Th><Table.Th>{t("厂商")}</Table.Th><Table.Th>{t("模型")}</Table.Th><Table.Th>{t("操作")}</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {rows.map((row) => {
            const isLanguage = row.category === 'generation';
            const isSelected = isLanguage ? row.id === selectedProfileId : row.category === selectedCategory;
            return <Table.Tr key={row.id} className="settings-profile-row" data-selected={isSelected || undefined} aria-selected={isSelected} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(row);
              }
            }}>
              <Table.Td><Group gap="xs" wrap="nowrap"><ProviderIcon provider={row.providerId} size={24} /><Text fw={650} size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }} title={row.name}>{row.name}</Text>{row.isDefault ? <Badge size="xs" variant="light" color="blue">{t("默认")}</Badge> : null}</Group></Table.Td>
              <Table.Td><Badge size="sm" variant="light" color={row.category === 'generation' ? 'blue' : row.category === 'embedding' ? 'violet' : 'orange'}>{getModelCategoryLabel(row.category)}</Badge></Table.Td>
              <Table.Td><Text size="sm">{t(row.provider)}</Text></Table.Td>
              <Table.Td><Text size="sm" style={{ overflowWrap: 'anywhere' }} title={row.model}>{row.model}</Text></Table.Td>
              <Table.Td><Group className="settings-profile-actions" gap={4} wrap="nowrap"><Button size="xs" variant={isSelected ? 'light' : 'subtle'} onClick={(event) => { event.stopPropagation(); onOpen(row); }}>{t("配置")}</Button>{isLanguage ? <Button size="xs" variant="subtle" color="red" disabled={row.isDefault || languageProfileCount <= 1} onClick={(event) => { event.stopPropagation(); onDeleteProfile(row.id); }}>{t("删除")}</Button> : null}</Group></Table.Td>
            </Table.Tr>;
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer> : <Box className="settings-model-empty"><Text size="sm" fw={600}>{t("还没有配置模型")}</Text><Text size="xs" c="dimmed">{t("点击“添加连接”，先选择模型类别。")}</Text></Box>}
    {totalRows ? <Group className="settings-profile-pagination" justify="space-between" align="center" gap="sm" wrap="wrap"><Text size="xs" c="dimmed">{(page - 1) * MODEL_PROFILE_PAGE_SIZE + 1}–{Math.min(page * MODEL_PROFILE_PAGE_SIZE, totalRows)} / {totalRows}</Text>{pageCount > 1 ? <Pagination size="sm" total={pageCount} value={page} onChange={onPageChange} withEdges /> : null}</Group> : null}
  </Box>;
}

function ModelHubCategoryPanel({ modelHub, category, aiStatus, onFetchModelProviderModels, onSaveModelConfiguration, setFeedback, setError }: {
  modelHub: ModelHub;
  category: ModelSlotId;
  aiStatus: AiProviderStatus | null;
  onFetchModelProviderModels: (id: string, draft?: ModelProviderCatalogDraft) => Promise<{ result: RemoteProviderModelsResult; hub: ModelHub }>;
  onSaveModelConfiguration: (change: ModelConfigurationChange) => Promise<ModelHub>;
  setFeedback: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(modelHub);
  const [apiKey, setApiKey] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    setDraft(modelHub);
    setApiKey('');
    setCustomModel(false);
  }, [modelHub]);

  const slot = draft.slots[category];
  const isOllama = slot.source === 'ollama';
  const isDisabled = slot.source === 'none';
  const provider = draft.providers.find((entry) => entry.id === slot.source);
  const compatibleProviders = draft.providers.filter((entry) => category === 'generation' || !entry.generationOnly);
  const modelNames = useMemo(() => getModelHubModelNames(category, slot.model, slot.source, draft, provider, aiStatus), [aiStatus, category, draft, provider, slot.model, slot.source]);
  const modelIsListed = modelNames.includes(slot.model);
  const isCustom = customModel || Boolean(slot.model && !modelIsListed);
  const categoryMeta = localizeOptions(modelCategoryOptions).find((option) => option.value === category) ?? localizeOptions(modelCategoryOptions)[0];
  const sourceOptions = [
    ...(category === 'rerank' ? [{ value: 'none', label: t("暂不使用") }] : []),
    { value: 'ollama', label: t("本地模型（Ollama）") },
    ...compatibleProviders.map((entry) => ({ value: entry.id, label: t("远程 · {0}", { '0': entry.label }) })),
  ];

  const updateSlot = (patch: Partial<{ source: string; model: string }>) => setDraft((current) => ({ ...current, slots: { ...current.slots, [category]: { ...current.slots[category], ...patch } } }));
  const updateProvider = (patch: Partial<{ endpoint: string }>) => {
    if (!provider) return;
    setDraft((current) => ({ ...current, providers: current.providers.map((entry) => entry.id === provider.id ? { ...entry, ...patch } : entry) }));
  };

  const selectSource = (source: string) => {
    setError(null);
    setFeedback(null);
    setApiKey('');
    updateSlot({ source, model: '' });
  };

  const fetchModels = async () => {
    if (!provider) return;
    setIsFetching(true);
    setError(null);
    setFeedback(null);
    try {
      const sourceId = provider.id;
      const endpoint = provider.endpoint;
      const response = await onFetchModelProviderModels(sourceId, { endpoint, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (response.result.available) setDraft(current => ({ ...current, providers: current.providers.map(entry => entry.id === sourceId && entry.endpoint === endpoint ? { ...entry, models: response.result.models } : entry) }));
      if (!response.result.available) setError(response.result.message);
      else setFeedback(response.result.message);
    } catch (fetchError) {
      setError(toMessage(fetchError, t("获取远程模型失败。")));
    } finally {
      setIsFetching(false);
    }
  };

  const saveCategory = async () => {
    setIsSaving(true);
    setError(null);
    setFeedback(null);
    try {
      if (!isOllama && !isDisabled) {
        if (!provider) throw new Error(t("请选择远程模型厂商。"));
        if (!provider.hasKey && !apiKey.trim()) throw new Error(t("请填写 API Key，或先选择已保存密钥的厂商。"));
      }
      const saved = await onSaveModelConfiguration({
        kind: 'hub',
        ...(!isOllama && !isDisabled && provider ? { provider: { id: provider.id, patch: { endpoint: provider.endpoint, models: provider.models, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } } } : {}),
        hubPatch: {
          ...(isOllama ? { ollamaEndpoint: draft.ollamaEndpoint } : {}),
          slots: { [category]: { source: slot.source, model: isDisabled ? '' : slot.model } },
        },
      });
      setDraft(saved);
      setApiKey('');
      setFeedback(t("{0}配置已保存。", { '0': categoryMeta.label }));
    } catch (saveError) {
      if (saveError instanceof ModelConfigurationSaveCancelled) setFeedback(t(saveError.message));
      else setError(toMessage(saveError, t("{0}配置保存失败。", { '0': categoryMeta.label })));
    } finally {
      setIsSaving(false);
    }
  };

  return <Stack gap="md" className="settings-model-hub-panel">
    <Paper withBorder radius="md" p="lg" className="settings-model-role-card">
      <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
        <Group gap="xs"><ThemeIcon size={32} radius="md" variant="light" color={category === 'embedding' ? 'violet' : 'orange'}>{categoryMeta.icon}</ThemeIcon><Text fw={700}>{t(categoryMeta.label)} {t("配置")}</Text></Group>
        <Badge variant="light" color={isDisabled ? 'gray' : isOllama ? 'teal' : 'blue'}>{isDisabled ? t("未启用") : isOllama ? t("本地") : provider?.label ?? t("远程")}</Badge>
      </Group>
      <Divider my="md" />
      <Stack gap={0}>
        <SettingsField variant="plain" title={t("连接方式")}><Select aria-label={t("{0}使用方式", { '0': categoryMeta.label })} value={slot.source} data={sourceOptions} onChange={(value) => value && selectSource(value)} /></SettingsField>
        {isOllama ? <SettingsField variant="plain" title={t("Ollama 地址")}><TextInput aria-label={t("模型中枢 Ollama 地址")} value={draft.ollamaEndpoint} onChange={(event) => setDraft((current) => ({ ...current, ollamaEndpoint: event.currentTarget.value }))} placeholder="http://127.0.0.1:11434" /></SettingsField> : null}
        {!isOllama && !isDisabled ? <>
          <SettingsField variant="plain" title={t("API 厂商")} description={t("为当前用途选择服务商。")}><ProviderSelect aria-label={t("{0} API 厂商", { '0': categoryMeta.label })} value={provider?.id ?? null} data={compatibleProviders.map((entry) => ({ value: entry.id, label: entry.label }))} onChange={(value) => value && selectSource(value)} placeholder={t("请选择厂商")} /></SettingsField>
          <SettingsField variant="plain" title={t("API 地址")} description={t("支持代理或兼容网关。")}><Group gap="xs" wrap="nowrap"><TextInput aria-label={t("{0} API 地址", { '0': categoryMeta.label })} style={{ flex: 1 }} value={provider?.endpoint ?? ''} onChange={(event) => updateProvider({ endpoint: event.currentTarget.value })} placeholder="https://api.example.com/v1" /><Button variant="subtle" color="gray" size="xs" onClick={() => provider && updateProvider({ endpoint: provider.defaultEndpoint })}>{t("恢复默认")}</Button></Group></SettingsField>
          <SettingsField variant="plain" title="API Key" description={t("留空不会覆盖已保存密钥。")}><PasswordInput aria-label={`${t(categoryMeta.label)} API Key`} value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={provider?.hasKey ? t("已保存；留空保持不变") : t("请输入 API Key")} /></SettingsField>
        </> : null}
        {!isDisabled ? <SettingsField variant="plain" title={t("模型")} description={category === 'embedding' ? t("用于语义向量。") : t("用于候选结果精排。")}><Stack gap="sm"><Group align="flex-end" wrap="nowrap"><Select aria-label={t("{0}模型", { '0': categoryMeta.label })} style={{ flex: 1 }} value={isCustom ? null : slot.model || null} data={modelNames.map((model) => ({ value: model, label: model }))} placeholder={modelNames.length ? t("请选择模型") : isOllama ? t("请先启动 Ollama 并加载模型") : t("请先获取远程模型目录")} disabled={isCustom || modelNames.length === 0} onChange={(value) => updateSlot({ model: value ?? '' })} /><Button variant="light" leftSection={<RefreshCw size={16} />} loading={isFetching} disabled={isOllama || !provider} onClick={() => void fetchModels()}>{t("获取目录")}</Button></Group>{isCustom || modelNames.length === 0 ? <TextInput aria-label={t("自定义{0}模型", { '0': categoryMeta.label })} value={slot.model} onChange={(event) => updateSlot({ model: event.currentTarget.value })} placeholder={t("输入模型名称")} /> : null}<Switch size="sm" checked={isCustom} onChange={(event) => { setCustomModel(event.currentTarget.checked); if (!event.currentTarget.checked && !modelNames.includes(slot.model)) updateSlot({ model: '' }); }} label={t("自定义模型名")} /></Stack></SettingsField> : <Text size="sm" c="dimmed" py="md">{t("Rerank 当前未启用。")}</Text>}
      </Stack>
      <Group className="settings-actions-row" gap="sm"><Button leftSection={<CheckCircle2 size={16} />} loading={isSaving} onClick={() => void saveCategory()}>{t("保存配置")}</Button></Group>
      {category === 'embedding' && <Text size="xs" c="dimmed">{t('全局“嵌入”槽位只是新资料库的默认候选。已锁定资料库继续使用自己的模型绑定；修改默认模型不会重建已有向量。')}</Text>}
    </Paper>
  </Stack>;
}

function getModelHubModelNames(category: ModelSlotId, currentModel: string, source: string, hub: ModelHub, provider: ModelHub['providers'][number] | undefined, aiStatus: AiProviderStatus | null): string[] {
  const available = source === 'ollama' ? (aiStatus?.models.map((model) => model.name) ?? []) : (provider?.models ?? []);
  const presets = category === 'embedding'
    ? source === 'ollama' ? hub.ollamaEmbeddingPresets : provider?.embeddingPresets ?? []
    : category === 'rerank' ? provider?.rerankPresets ?? [] : [];
  const names = category === 'embedding' ? selectEmbeddingModelNames(available, presets) : [...presets, ...available];
  return Array.from(new Set([...names, ...(currentModel ? [currentModel] : [])]));
}

function SettingsSection({ group, title, description, children }: { group: string; title: string; description?: string; children: ReactNode }) {
  useI18n();
  return <Stack gap="lg" className="settings-section"><Box><Text className="settings-section-kicker" size="xs" fw={700} tt="uppercase" c="gray">{group}</Text><Text className="settings-section-title" fw={700} size="xl">{title}</Text>{description ? <Text size="sm" c="dimmed" mt={4}>{description}</Text> : null}</Box><Stack gap="md">{children}</Stack></Stack>;
}

function isWebSearchConfigured(providerId: WebSearchProviderId, config: WebSearchConfig): boolean {
  if (providerId === 'zhipu') return config.hasZhipuKey;
  if (providerId === 'tavily') return config.hasTavilyKey;
  if (providerId === 'baidu') return config.hasBaiduKey;
  if (providerId === 'searxng') return Boolean(config.searxngUrl.trim());
  return true;
}

function withWebSearchHasKey(config: WebSearchConfig, providerId: WebSearchProviderId, hasKey: boolean): WebSearchConfig {
  if (providerId === 'zhipu') return { ...config, hasZhipuKey: hasKey };
  if (providerId === 'tavily') return { ...config, hasTavilyKey: hasKey };
  if (providerId === 'baidu') return { ...config, hasBaiduKey: hasKey };
  return config;
}

function getWebSearchRequirementLabel(requirement: WebSearchProviderRequirement): string {
  if (requirement === 'none') return t("免密钥");
  if (requirement === 'api-key') return t("需 API Key");
  return t("需实例地址");
}

function SettingsField({ title, description, children, variant = 'card' }: { title: string; description?: string; children: ReactNode; variant?: 'card' | 'plain' }) {
  useI18n();
  const content = <Box className="settings-field-row"><Box className="settings-field-copy"><Text fw={600} size="sm">{title}</Text>{description ? <Text size="xs" c="dimmed" mt={4} lh={1.5}>{description}</Text> : null}</Box><Box className="settings-field-control">{children}</Box></Box>;
  return variant === 'plain' ? <Box className="settings-field-plain">{content}</Box> : <Paper withBorder radius="md" p="md" className="settings-field-card">{content}</Paper>;
}

type FlowToggleOption<T extends string> = { value: T; label: string; icon: ReactNode };

function FlowToggle<T extends string>({ ariaLabel, options, value, onChange }: { ariaLabel: string; options: FlowToggleOption<T>[]; value: T; onChange: (value: T) => void }) {
  useI18n();
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const toggleStyle = {
    '--flow-index': activeIndex,
    '--flow-count': options.length,
  } as CSSProperties;

  return <div className="settings-flow-toggle" style={toggleStyle} role="radiogroup" aria-label={ariaLabel}>
    <span className="settings-flow-toggle-indicator" aria-hidden="true" />
    {options.map((option) => <button key={option.value} type="button" className="settings-flow-toggle-option" data-active={option.value === value || undefined} role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}><span className="settings-flow-toggle-option-icon" aria-hidden="true">{option.icon}</span><span>{t(option.label)}</span></button>)}
  </div>;
}

function RemoteModelField({ value, models, custom, loading, onCustomChange, onChange, onFetch, variant }: { value: string; models: string[]; custom: boolean; loading: boolean; onCustomChange: (value: boolean) => void; onChange: (value: string) => void; onFetch: () => void; variant?: 'card' | 'plain' }) {
  useI18n();
  const options = Array.from(new Set(value ? [...models, value] : models)).map((model) => ({ value: model, label: model }));
  return <SettingsField variant={variant} title={t("模型")} description={t("从厂商目录选择，或输入自定义名称。")}><Stack gap="sm"><Group align="flex-end" wrap="nowrap"><Select aria-label={t("远程生成模型")} style={{ flex: 1 }} value={custom ? null : value || null} data={options} placeholder={models.length ? t("请选择模型") : t("请先获取模型目录")} disabled={custom || models.length === 0} onChange={(model) => onChange(model ?? '')} /><Button variant="light" leftSection={<RefreshCw size={16} />} loading={loading} onClick={onFetch}>{t("获取目录")}</Button></Group>{custom ? <TextInput aria-label={t("自定义远程生成模型")} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={t("输入模型名称")} /> : null}<Switch size="sm" checked={custom} onChange={(event) => onCustomChange(event.currentTarget.checked)} label={t("自定义模型名")} /></Stack></SettingsField>;
}

function ModelField({ title, description, value, models, custom, onCustomChange, onChange, variant }: { title: string; description: string; value: string; models: string[]; custom: boolean; onCustomChange: (value: boolean) => void; onChange: (value: string) => void; variant?: 'card' | 'plain' }) {
  useI18n();
  const options = Array.from(new Set(value ? [...models, value] : models)).map((model) => ({ value: model, label: model }));
  return <SettingsField variant={variant} title={title} description={description}><Stack gap="sm">{custom || models.length === 0 ? <TextInput aria-label={title} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={t("输入模型名称")} /> : <Select aria-label={title} value={value || null} data={options} placeholder={t("请选择模型")} onChange={(model) => onChange(model ?? '')} />}<Switch size="sm" checked={custom} onChange={(event) => onCustomChange(event.currentTarget.checked)} label={t("高级：自定义模型名")} /></Stack></SettingsField>;
}

function AboutFact({ label, valueClassName, children }: { label: string; valueClassName?: string; children: ReactNode }) {
  useI18n();
  return <Stack gap={3} className="settings-about-fact"><Text size="xs" c="dimmed">{label}</Text><Text size="sm" fw={600} className={valueClassName}>{children}</Text></Stack>;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function createSettingsId(prefix: 'model' | 'skill'): string {
  const source = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${source.slice(0, 24)}`;
}
