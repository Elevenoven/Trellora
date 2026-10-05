import { t, useI18n } from '../../i18n';
import { Button, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { FileQuestion, RefreshCw } from 'lucide-react';

interface WikiEmptyStateProps {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  title?: string;
  description?: string;
}

export default function WikiEmptyState({ loading, error, onRetry, title, description }: WikiEmptyStateProps) {
  useI18n();
  return (
    <Stack className="wiki-empty-state" align="center" justify="center" gap="sm">
      {loading ? <Loader color="teal" size="sm" /> : <ThemeIcon variant="light" color="gray" size={42}><FileQuestion size={22} /></ThemeIcon>}
      <Text size="sm" fw={650}>{loading ? t("正在加载 Wiki 骨架") : error ? t("Wiki 加载失败") : title ?? t("没有可展示的 Wiki 文档")}</Text>
      {error || description ? <Text size="xs" c="dimmed">{error ?? description}</Text> : null}
      {error && onRetry ? <Button size="xs" variant="default" leftSection={<RefreshCw size={14} />} onClick={onRetry}>{t("重新加载")}</Button> : null}
    </Stack>
  );
}
