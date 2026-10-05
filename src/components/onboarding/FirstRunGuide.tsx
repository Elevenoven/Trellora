import { useEffect, useState } from 'react';
import { Alert, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { OnboardingState } from '../../../shared/onboarding';
import { t, useI18n } from '../../i18n';

/** Resume the same progress; completed users can review without resetting it. */
export default function FirstRunGuide({ onOpen }: { onOpen: () => void }) {
  useI18n();
  const [state, setState] = useState<OnboardingState>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.electronAPI.getOnboardingState().then(next => { if (alive) setState(next); }).catch(() => { if (alive) setError(true); });
    const unsubscribe = window.electronAPI.onOnboardingStateChanged(next => { if (alive) setState(next); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  return <Paper withBorder p="md" radius="md"><Stack gap="sm">
    <Text size="sm">{t('认识菜单、连接 AI，再完成第一次提问。')}</Text>
    <Group justify="space-between"><Text size="xs" c="dimmed">{state?.status === 'completed' ? t('引导已完成') : state?.progress.menus === 'done' ? t('已保存你的引导进度') : t('三步开始使用 Trellora')}</Text><Button size="xs" onClick={onOpen}>{state?.status === 'completed' ? t('重新查看引导') : state?.status === 'deferred' || state?.status === 'active' ? t('继续引导') : t('开始引导')}</Button></Group>
    {error && <Alert color="red">{t('引导状态读取失败，请重试。')}</Alert>}
  </Stack></Paper>;
}
