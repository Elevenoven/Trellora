import { t, useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Button, Code, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { AlertTriangle, ArrowUpRight, Plus, Settings2 } from 'lucide-react';
import { DEFAULT_MATERIALS_ICON_ID, MATERIALS_ICON_OPTIONS } from '../utils/materialsIcons';
import type { LibraryChunkingConfig, LibrarySummary } from '../electron';
import ChunkingStrategyConfigModal from './ChunkingStrategyConfigModal';
import { RECOMMENDED_CHUNKING_DRAFT, cloneChunkingDraft } from '../utils/chunkingStrategyDraft';

export type MaterialsLibraryModalMode = 'create' | 'upgrade';

interface CreateMaterialsLibraryModalProps {
  opened: boolean;
  mode: MaterialsLibraryModalMode;
  workspacePath: string | null;
  noteLibraries: LibrarySummary[];
  initialUpgradePath: string | null;
  onClose: () => void;
  onModeChange: (mode: MaterialsLibraryModalMode) => void;
  onCreate: (name: string, icon: string, chunkingConfig: LibraryChunkingConfig) => Promise<void>;
  onUpgrade: (libraryPath: string, icon: string, chunkingConfig: LibraryChunkingConfig) => Promise<void>;
}

export default function CreateMaterialsLibraryModal({
  opened,
  mode,
  workspacePath,
  noteLibraries,
  initialUpgradePath,
  onClose,
  onModeChange,
  onCreate,
  onUpgrade,
}: CreateMaterialsLibraryModalProps) {
  useI18n();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(DEFAULT_MATERIALS_ICON_ID);
  const [upgradePath, setUpgradePath] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunkingDraft, setChunkingDraft] = useState<LibraryChunkingConfig>(() => cloneChunkingDraft());
  const [chunkingConfigOpened, setChunkingConfigOpened] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setName('');
    setIcon(DEFAULT_MATERIALS_ICON_ID);
    setUpgradePath(initialUpgradePath);
    setError(null);
    setChunkingDraft(cloneChunkingDraft(RECOMMENDED_CHUNKING_DRAFT));
    setChunkingConfigOpened(false);
  }, [opened, initialUpgradePath]);

  const submit = async () => {
    setError(null);
    if (mode === 'create') {
      if (!name.trim()) {
        setError('请输入资料库名称。');
        return;
      }
      setIsSubmitting(true);
      try {
        await onCreate(name.trim(), icon, chunkingDraft);
      } catch (createError) {
        setError(toMessage(createError, '创建资料库失败。'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!upgradePath) {
      setError('请选择要升级的笔记库。');
      return;
    }
    setIsSubmitting(true);
    try {
      await onUpgrade(upgradePath, icon, chunkingDraft);
    } catch (upgradeError) {
      setError(toMessage(upgradeError, '升级资料库失败。'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const upgradeOptions = noteLibraries.map((library) => ({
    value: library.path,
    label: `${library.alias} · ${library.noteCount} 篇笔记`,
  }));

  return (
    <Modal opened={opened} onClose={onClose} title={mode === 'create' ? t("新建资料库") : t("升级为资料库")} centered size="md">
      <Stack gap="lg">
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(value) => onModeChange(value as MaterialsLibraryModalMode)}
          data={[
            { value: 'create', label: t("新建空白资料库") },
            { value: 'upgrade', label: t("由笔记库升级") },
          ]}
        />

        {mode === 'create' ? (
          <TextInput
            label={t("资料库名称")}
            placeholder={t("例如：论文档案")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoFocus
            required
          />
        ) : (
          <>
            <Select
              label={t("选择笔记库")}
              placeholder={t("选择要升级为资料库的笔记库")}
              data={upgradeOptions}
              value={upgradePath}
              onChange={setUpgradePath}
              searchable
              nothingFoundMessage={t("没有可升级的笔记库")}
            />
            <Alert variant="light" color="orange" icon={<ArrowUpRight size={16} />}>
              {t("升级会在工作区新建知识库文件夹并复制笔记文档，笔记库保留；资料库只读，更新需删除后重新上传。")}
            </Alert>
          </>
        )}

        <Stack gap="xs">
          <Text size="sm" fw={650}>{t("资料库图标")}</Text>
          <Group gap={8}>
            {MATERIALS_ICON_OPTIONS.map((option) => (
              <Tooltip key={option.id} label={option.label} withArrow>
                <ActionIcon
                  variant={icon === option.id ? 'filled' : 'light'}
                  color={option.color}
                  size="lg"
                  radius="md"
                  aria-label={option.label}
                  onClick={() => setIcon(option.id)}
                >
                  <option.Icon size={16} />
                </ActionIcon>
              </Tooltip>
            ))}
          </Group>
        </Stack>

        <PaperlessChunkingSummary
          mode={chunkingDraft.mode}
          onConfigure={() => setChunkingConfigOpened(true)}
        />

        <Stack gap={4}>
          <Text size="xs" c="dimmed">{t("存放位置")}</Text>
          <Code block className="create-library-path">
            {workspacePath ? t("{0} / knowledge-base / 名称-时间戳 / documents", { '0': workspacePath }) : t("工作区尚未设置")}
          </Code>
        </Stack>

        {error ? <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>{error}</Alert> : null}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>{t("取消")}</Button>
          <Button
            leftSection={mode === 'create' ? <Plus size={16} /> : <ArrowUpRight size={16} />}
            loading={isSubmitting}
            onClick={() => void submit()}
          >
            {mode === 'create' ? t("创建资料库") : t("升级为资料库")}
          </Button>
        </Group>
      </Stack>
      <ChunkingStrategyConfigModal
        opened={chunkingConfigOpened}
        title={t("为新资料库配置切块策略")}
        initialConfig={chunkingDraft}
        onClose={() => setChunkingConfigOpened(false)}
        onSave={(config) => { setChunkingDraft(config); }}
      />
    </Modal>
  );
}

function PaperlessChunkingSummary({ mode, onConfigure }: { mode: LibraryChunkingConfig['mode']; onConfigure: () => void }) {
  useI18n();
  return (
    <Alert color="blue" variant="light" icon={<Settings2 size={16} />}>
      <Group justify="space-between" align="center" wrap="wrap" gap="xs">
        <Stack gap={0}>
          <Text size="sm" fw={650}>{mode === 'recommended' ? t("默认采用系统推荐的父子切块") : t("已选择自定义父子切块策略")}</Text>
          <Text size="xs">{t("未配置时不会增加操作；你也可在创建前按文档类型调整策略。")}</Text>
        </Stack>
        <Button size="compact-xs" variant="white" leftSection={<Settings2 size={13} />} onClick={onConfigure}>{t("配置策略")}</Button>
      </Group>
    </Alert>
  );
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
