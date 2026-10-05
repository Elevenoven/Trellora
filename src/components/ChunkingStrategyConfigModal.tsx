import { localizeOptions, t, useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { AlertTriangle, Bot, Check, FileStack, GitFork, Settings2, Sparkles } from 'lucide-react';
import type { AiProviderConfig, AiProviderStatus, ChildStrategyCode, LibraryChunkingConfig, ParentStrategyCode } from '../electron';
import { RECOMMENDED_CHUNKING_DRAFT, cloneChunkingDraft, type ChunkingDraftFieldErrors, validateChunkingDraft } from '../utils/chunkingStrategyDraft';

export interface ChunkingExecutionFact {
  effectiveParentStrategies?: string[];
  effectiveChildStrategies?: string[];
  fallbackReason?: string | null;
  parentLimits?: { minChars?: number; targetChars?: number; maxChars?: number };
  qualityLevel?: string;
}

interface ChunkingStrategyConfigModalProps {
  opened: boolean;
  title?: string;
  documentCount?: number;
  initialConfig?: LibraryChunkingConfig;
  executionFact?: ChunkingExecutionFact | null;
  onLoadConfig?: () => Promise<LibraryChunkingConfig>;
  onSave: (config: LibraryChunkingConfig) => Promise<void> | void;
  onClose: () => void;
}

type PrimaryParentStrategy = ParentStrategyCode;
type PrimaryChildStrategy = 'STRUCTURE' | 'RECURSIVE' | 'SEMANTIC' | 'LLM' | 'PAGE' | 'REGEX' | 'FIXED';

const PARENT_OPTIONS: Array<{ value: PrimaryParentStrategy; label: string }> = [
  { value: 'STRUCTURE', label: '结构切块' },
  { value: 'RECURSIVE', label: '递归切块' },
  { value: 'PAGE', label: '按页切块' },
  { value: 'REGEX', label: '正则切块' },
  { value: 'FIXED', label: '固定长度' },
];

const CHILD_OPTIONS: Array<{ value: PrimaryChildStrategy; label: string }> = [
  { value: 'SEMANTIC', label: '语义 → 递归' },
  { value: 'RECURSIVE', label: '递归切块' },
  { value: 'LLM', label: 'LLM → 递归' },
  { value: 'STRUCTURE', label: '保留结构单元' },
  { value: 'PAGE', label: '按页切块' },
  { value: 'REGEX', label: '正则切块' },
  { value: 'FIXED', label: '固定长度' },
];


export default function ChunkingStrategyConfigModal({
  opened,
  title = t("切块策略配置"),
  documentCount,
  initialConfig,
  executionFact,
  onLoadConfig,
  onSave,
  onClose,
}: ChunkingStrategyConfigModalProps) {
  useI18n();
  const [draft, setDraft] = useState<LibraryChunkingConfig>(() => cloneChunkingDraft(initialConfig));
  const [errors, setErrors] = useState<ChunkingDraftFieldErrors>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aiConfig, setAiConfig] = useState<AiProviderConfig | null>(null);
  const [aiStatus, setAiStatus] = useState<AiProviderStatus | null>(null);
  const firstInvalidRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setErrors({});
    setSaveError(null);
    setLoading(Boolean(onLoadConfig));
    const load = async () => {
      try {
        const config = onLoadConfig ? await onLoadConfig() : (initialConfig ?? RECOMMENDED_CHUNKING_DRAFT);
        if (!cancelled) setDraft(cloneChunkingDraft(config));
      } catch (error) {
        if (!cancelled) setSaveError(toMessage(error, t("读取切块策略失败，请关闭后重试。")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    void Promise.all([
      window.electronAPI?.getAiProviderConfig?.(),
      window.electronAPI?.getAiStatus?.(),
    ]).then(([config, status]) => {
      if (!cancelled) {
        setAiConfig(config ?? null);
        setAiStatus(status ?? null);
      }
    }).catch(() => {
      if (!cancelled) {
        setAiConfig(null);
        setAiStatus(null);
      }
    });
    return () => { cancelled = true; };
  }, [opened, initialConfig, onLoadConfig]);

  const parentStrategy = primaryParentStrategy(draft.parentStrategies);
  const childStrategy = primaryChildStrategy(draft.childStrategies);
  const pageSelected = draft.parentStrategies.includes('PAGE') || draft.childStrategies.includes('PAGE');
  const regexSelected = draft.parentStrategies.includes('REGEX') || draft.childStrategies.includes('REGEX');
  const llmSelected = draft.childStrategies.includes('LLM');
  const modelBlocker = useMemo(() => getModelBlocker(draft, aiConfig, aiStatus), [draft, aiConfig, aiStatus]);

  const update = (patch: Partial<LibraryChunkingConfig>) => setDraft((current) => ({ ...current, ...patch }));

  const selectMode = (value: string) => {
    if (value === 'recommended') {
      setDraft(cloneChunkingDraft(RECOMMENDED_CHUNKING_DRAFT));
      setErrors({});
      return;
    }
    setDraft((current) => ({
      ...current,
      mode: 'custom',
      parentStrategies: current.parentStrategies.length ? current.parentStrategies : ['STRUCTURE'],
      childStrategies: current.childStrategies.length ? current.childStrategies : ['SEMANTIC', 'RECURSIVE'],
    }));
  };

  const submit = async () => {
    const nextErrors = validateChunkingDraft(draft);
    setErrors(nextErrors);
    setSaveError(null);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => firstInvalidRef.current?.focus());
      return;
    }
    setSaving(true);
    try {
      await onSave(cloneChunkingDraft(draft));
      onClose();
    } catch (error) {
      setSaveError(toMessage(error, t("保存切块策略失败，请检查配置后重试。")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t(title)} centered size="xl" overlayProps={{ backgroundOpacity: 0.35, blur: 1 }}>
      <Stack gap="md" className="chunking-config-modal">
        <Paper withBorder radius="md" p="sm" className="chunking-context-rail">
          <Group gap="xs" wrap="nowrap" align="center">
            <div className="chunking-context-node"><FileStack size={15} /><span>Parent</span></div>
            <GitFork className="chunking-context-arrow" size={18} aria-hidden />
            <div className="chunking-context-node child"><Sparkles size={15} /><span>Child</span></div>
            <Stack gap={0} miw={0}>
              <Text size="xs" fw={650}>{t("父块保留章节上下文，子块负责精准召回")}</Text>
              <Text size="xs" c="dimmed">{t("每个 Child 自动携带所属章节路径；命中后始终可回到完整 Parent。")}</Text>
            </Stack>
          </Group>
        </Paper>

        <SegmentedControl
          fullWidth
          value={draft.mode}
          onChange={selectMode}
          data={[
            { value: 'recommended', label: t("系统推荐（默认）") },
            { value: 'custom', label: t("自定义策略") },
          ]}
        />

        {draft.mode === 'recommended' ? (
          <Alert icon={<Check size={16} />} color="teal" variant="light">
            {t("系统会优先按章节建立 Parent；根据文档质量，Child 自动采用语义 → 递归或递归策略。低质量文档仅在已启用且模型可用时建议 LLM → 递归。")}
          </Alert>
        ) : (
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label={t("父块边界策略")}
                description={t("面向回答上下文，尽量保留完整章节或较大的语义单元。")}
                data={localizeOptions(PARENT_OPTIONS)}
                value={parentStrategy}
                onChange={(value) => update({ parentStrategies: parentStrategiesFor(value as PrimaryParentStrategy) })}
                error={errors.strategies}
              />
              <Select
                label={t("子块检索策略")}
                description={t("面向召回，仍保留 Parent 的章节上下文。")}
                data={localizeOptions(CHILD_OPTIONS)}
                value={childStrategy}
                onChange={(value) => update({ childStrategies: childStrategiesFor(value as PrimaryChildStrategy) })}
                error={errors.strategies}
              />
            </SimpleGrid>

            {regexSelected ? (
              <TextInput
                label={t("边界正则表达式")}
                description={t("用于识别自然业务边界；仅支持 i、m 标志。")}
                placeholder={t("例如：^第[一二三四五六七八九十]+章")}
                value={draft.regexPattern}
                onChange={(event) => update({ regexPattern: event.currentTarget.value })}
                error={errors.regex}
              />
            ) : null}

            {pageSelected ? (
              <Alert icon={<AlertTriangle size={15} />} color="orange" variant="light">
                {t("按页切块依赖解析产物的页码覆盖率（当前要求至少")} {Math.round(draft.pageMinMetadataCoverage * 100)}{t("%）。Markdown、纯文本或没有稳定页码的文档会在执行时提示不兼容，不会静默改用其他策略。")}
              </Alert>
            ) : null}

            {llmSelected ? (
              <Stack gap="xs">
                <Switch
                  label={t("启用 LLM 智能切块")}
                  description={t("LLM 仅接收已清洗、受长度限制的文本；模型不可用时任务会明确阻塞，不会静默降级。")}
                  checked={draft.llmEnabled}
                  onChange={(event) => update({ llmEnabled: event.currentTarget.checked })}
                />
                {modelBlocker ? <Alert icon={<Bot size={15} />} color="orange" variant="light">{modelBlocker}</Alert> : <Alert icon={<Check size={15} />} color="teal" variant="light">{t("当前模型配置可用于 LLM 子块策略。")}</Alert>}
                {errors.llm ? <Text size="xs" c="red">{errors.llm}</Text> : null}
              </Stack>
            ) : null}
          </Stack>
        )}

        <Paper withBorder radius="md" p="sm">
          <Group justify="space-between" mb={6} wrap="wrap">
            <Text size="sm" fw={650}>{t("Parent 长度边界")}</Text>
            <Badge size="sm" variant="light" color="blue">{t("结构未扫描到章节时，至少按大窗口保留上下文")}</Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 4 }} spacing="sm">
            <NumberInput ref={firstInvalidRef} label={t("最低字数")} min={0} max={200000} value={draft.parentMinChars} onChange={(value) => update({ parentMinChars: numericValue(value, draft.parentMinChars) })} error={errors.parent} />
            <NumberInput label={t("目标字数")} min={1} max={200000} value={draft.parentTargetChars} onChange={(value) => update({ parentTargetChars: numericValue(value, draft.parentTargetChars) })} error={errors.parent} />
            <NumberInput label={t("最大字数")} min={1} max={200000} value={draft.parentMaxChars} onChange={(value) => update({ parentMaxChars: numericValue(value, draft.parentMaxChars) })} error={errors.parent} />
            <NumberInput label={t("上下文 overlap")} min={0} max={200000} value={draft.parentOverlapChars} onChange={(value) => update({ parentOverlapChars: numericValue(value, draft.parentOverlapChars) })} error={errors.parentOverlap} />
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt={6}>{t("递归优先按段落 → 行 → 句子 → 固定窗口查找边界；overlap 只在长度上限允许时复制相邻上下文。")}</Text>
        </Paper>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={650} mb={6}>{t("递归 / 语义子块长度")}</Text>
            <Group grow align="flex-start">
              <NumberInput label={t("最大字数")} min={1} max={200000} value={draft.childRecursiveMaxChars} onChange={(value) => update({ childRecursiveMaxChars: numericValue(value, draft.childRecursiveMaxChars) })} error={errors.childRecursive} />
              <NumberInput label="overlap" min={0} max={200000} value={draft.childRecursiveOverlapChars} onChange={(value) => update({ childRecursiveOverlapChars: numericValue(value, draft.childRecursiveOverlapChars) })} error={errors.childRecursive} />
            </Group>
          </Paper>
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={650} mb={6}>{t("语义变化阈值")}</Text>
            <Group grow align="flex-start">
              <NumberInput label={t("最小字数")} min={0} max={200000} value={draft.semanticMinChars} onChange={(value) => update({ semanticMinChars: numericValue(value, draft.semanticMinChars) })} />
              <NumberInput label={t("Jaccard 阈值")} min={0} max={1} step={0.01} decimalScale={2} value={draft.semanticSimilarityThreshold} onChange={(value) => update({ semanticSimilarityThreshold: numericValue(value, draft.semanticSimilarityThreshold) })} />
            </Group>
          </Paper>
        </SimpleGrid>

        <Paper withBorder radius="md" p="sm" className="chunking-plan-facts">
          <Text size="sm" fw={650} mb={4}>{t("配置计划 / 执行后事实")}</Text>
          <Text size="xs">{t("计划：Parent")} {strategyNames(draft.parentStrategies)}；Child {draft.mode === 'recommended' ? t("按质量自动推荐") : strategyNames(draft.childStrategies)}{t("；Parent 长度")} {draft.parentMinChars} / {draft.parentTargetChars} / {draft.parentMaxChars}。</Text>
          {executionFact ? (
            <Text size="xs" c="dimmed" mt={4}>{t("执行后：Parent")} {strategyNames(executionFact.effectiveParentStrategies ?? []) || t("未记录")}；Child {strategyNames(executionFact.effectiveChildStrategies ?? []) || t("未记录")}；{executionFact.fallbackReason ? t("已使用兜底：{0}", { '0': executionFact.fallbackReason }) : t("未触发结构兜底")}{executionFact.parentLimits ? t("；实际长度 {0} / {1} / {2}", { '0': executionFact.parentLimits.minChars ?? '-', '1': executionFact.parentLimits.targetChars ?? '-', '2': executionFact.parentLimits.maxChars ?? '-' }) : ''}。</Text>
          ) : (
            <Text size="xs" c="dimmed" mt={4}>{t("尚未有可展示的切块事实。保存后仅使当前资料库")} {documentCount ?? 0} {t("个文档的 chunks 及下游阶段重新安排，结构树可继续复用。")}</Text>
          )}
        </Paper>

        {saveError ? <Alert icon={<AlertTriangle size={15} />} color="red" variant="light">{saveError}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>{t("取消")}</Button>
          <Button leftSection={<Settings2 size={15} />} loading={saving || loading} onClick={() => void submit()}>{t("保存策略")}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function primaryParentStrategy(strategies: ParentStrategyCode[]): PrimaryParentStrategy {
  return strategies[0] ?? 'STRUCTURE';
}

function primaryChildStrategy(strategies: ChildStrategyCode[]): PrimaryChildStrategy {
  return strategies[0] ?? 'SEMANTIC';
}

function parentStrategiesFor(strategy: PrimaryParentStrategy): ParentStrategyCode[] {
  return [strategy];
}

function childStrategiesFor(strategy: PrimaryChildStrategy): ChildStrategyCode[] {
  if (strategy === 'SEMANTIC' || strategy === 'LLM') return [strategy, 'RECURSIVE'];
  return [strategy];
}

function strategyNames(strategies: string[]): string {
  const labels: Record<string, string> = { STRUCTURE: t("结构"), RECURSIVE: t("递归"), SEMANTIC: t("语义"), LLM: 'LLM', PAGE: t("按页"), REGEX: t("正则"), FIXED: t("固定长度") };
  return strategies.map((strategy) => labels[strategy] ?? strategy).join(' → ');
}

function getModelBlocker(draft: LibraryChunkingConfig, config: AiProviderConfig | null, status: AiProviderStatus | null): string | null {
  if (!draft.llmEnabled) return t("LLM 智能切块尚未启用。开启后仍需配置可用的聊天模型。");
  if (!config?.model) return t("尚未选择聊天模型，请在设置中完成模型配置后再运行。");
  if (config.kind === 'openai-compatible' && !config.hasApiKey) return t("远程模型尚未完成 API Key 配置，当前任务会保持等待配置。");
  if (status && !status.available) return status.message || t("模型服务当前不可用，请检查本机服务或网络配置。");
  return null;
}

function numericValue(value: string | number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
