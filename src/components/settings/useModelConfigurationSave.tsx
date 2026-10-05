import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Modal, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import { AlertTriangle } from 'lucide-react';
import type { ModelConfigurationChange, ModelConfigurationSaveResult } from '../../../shared/modelConfiguration';
import { t, useI18n } from '../../i18n';

type Confirmation = Extract<ModelConfigurationSaveResult, { status: 'confirmation-required' }>;

export class ModelConfigurationSaveCancelled extends Error {
  constructor() {
    super('已取消保存，连接保持不变。');
    this.name = 'ModelConfigurationSaveCancelled';
  }
}

/** 确认待保存的完整草稿；服务端重新检查后才能提交，取消不会产生部分保存。 */
export function useModelConfigurationSave() {
  useI18n();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const resolver = useRef<((token: string | undefined) => void) | null>(null);
  useEffect(() => () => { resolver.current?.(undefined); resolver.current = null; }, []);

  const finishConfirmation = (token?: string) => {
    resolver.current?.(token);
    resolver.current = null;
    setConfirmation(null);
  };

  const save = async (change: ModelConfigurationChange) => {
    let token: string | undefined;
    for (;;) {
      const result = await window.electronAPI.saveModelConfiguration(change, token);
      if (result.status === 'saved') return result;
      if (resolver.current) throw new Error(t('请先处理当前连接变更。'));
      token = await new Promise<string | undefined>(resolve => {
        resolver.current = resolve;
        setConfirmation(result);
      });
      if (!token) throw new ModelConfigurationSaveCancelled();
    }
  };

  const dialog = <Modal opened={Boolean(confirmation)} onClose={() => finishConfirmation()} title={t('修改连接地址')} centered size="lg">
    <Stack gap="md">
      <Alert color="orange" variant="light" icon={<AlertTriangle size={18} />}>
        {t('以下资料库使用原连接地址。继续保存后，它们的语义检索将暂时不可用；综合搜索仍可使用原文与关键词检索。已有向量会保留，恢复原地址后可继续使用。')}
      </Alert>
      <ScrollArea.Autosize mah={320}>
        <Stack gap="sm">{confirmation?.impacts.map(impact => <Paper key={impact.libraryPath} withBorder p="sm" radius="sm">
          <Text size="sm" fw={650}>{impact.libraryName}</Text>
          <Text size="xs" c="dimmed">{impact.model}</Text>
          <Text size="xs" mt={6} style={{ overflowWrap: 'anywhere' }}>{t('原地址：{0}', { '0': impact.previousEndpoint })}</Text>
          <Text size="xs" style={{ overflowWrap: 'anywhere' }}>{t('新地址：{0}', { '0': impact.nextEndpoint })}</Text>
        </Paper>)}</Stack>
      </ScrollArea.Autosize>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => finishConfirmation()}>{t('返回修改')}</Button>
        <Button color="orange" onClick={() => finishConfirmation(confirmation?.confirmationToken)}>{t('继续保存')}</Button>
      </Group>
    </Stack>
  </Modal>;
  return { save, dialog };
}
