import { t, useI18n } from '../../i18n';
import { Button, Group, Modal, Radio, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { ListTree, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WikiBuildMode } from '../../wiki/wikiTypes';

interface WikiStartModalProps {
  opened: boolean;
  documentTitle: string;
  onStart: (mode: WikiBuildMode) => void;
}

export default function WikiStartModal({ opened, documentTitle, onStart }: WikiStartModalProps) {
  useI18n();
  const [mode, setMode] = useState<WikiBuildMode>('guided');
  useEffect(() => { if (opened) setMode('guided'); }, [opened]);

  return (
    <Modal
      opened={opened}
      onClose={() => undefined}
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
      centered
      size={720}
      title={<div><Text fw={680}>{t("从哪里开始？")}</Text><Text size="sm" c="dimmed" mt={2}>{documentTitle}</Text></div>}
      classNames={{ content: 'wiki-start-modal', body: 'wiki-start-modal-body' }}
    >
      <Radio.Group value={mode} onChange={(value) => setMode(value as WikiBuildMode)} aria-label={t("Wiki 生成模式")}>
        <div className="wiki-start-mode-grid">
          <UnstyledButton className={`wiki-start-mode ${mode === 'guided' ? 'selected' : ''}`} onClick={() => setMode('guided')}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <ThemeIcon variant="light" color="teal" radius="sm" size={36}><ListTree size={19} /></ThemeIcon>
              <Radio value="guided" aria-label={t("按节点分析")} />
            </Group>
            <Stack gap={5} mt="md">
              <Text fw={680}>{t("按节点分析")}</Text>
              <Text size="sm" c="dimmed">{t("立即查看完整目录骨架，自己选择章节逐个分析。")}</Text>
            </Stack>
          </UnstyledButton>
          <UnstyledButton className={`wiki-start-mode ${mode === 'auto' ? 'selected' : ''}`} onClick={() => setMode('auto')}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <ThemeIcon variant="light" color="blue" radius="sm" size={36}><Sparkles size={19} /></ThemeIcon>
              <Radio value="auto" aria-label={t("AI 整篇生成")} />
            </Group>
            <Stack gap={5} mt="md">
              <Text fw={680}>{t("AI 整篇生成")}</Text>
              <Text size="sm" c="dimmed">{t("最多 5 个章节任务并行，完成的分支会逐步显示。")}</Text>
            </Stack>
          </UnstyledButton>
        </div>
      </Radio.Group>
      <Group justify="flex-end" mt="lg">
        <Button color="brand" leftSection={mode === 'guided' ? <ListTree size={16} /> : <Sparkles size={16} />} onClick={() => onStart(mode)}>
          {mode === 'guided' ? t("开始浏览") : t("生成完整 Wiki")}
        </Button>
      </Group>
    </Modal>
  );
}
