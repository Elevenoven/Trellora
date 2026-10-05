import { useEffect, useId, useState } from 'react';
import { Alert, Badge, Box, Button, Checkbox, Code, Group, Paper, Progress, Stack, Switch, Text, ThemeIcon } from '@mantine/core';
import { Archive, FolderOpen, Save } from 'lucide-react';
import type { BackupStatus } from '../../shared/workspaceBackup';
import { t, useI18n } from '../i18n';

export default function WorkspaceBackupSettings() {
  useI18n();
  const snapshotSwitchId = useId();
  const [status, setStatus] = useState<BackupStatus>();
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.electronAPI.getWorkspaceBackupStatus().then(value => { if (alive) { setStatus(value); setTarget(value.configuration.targetDirectory); setSelected(value.configuration.externalLibraries); setEnabled(value.configuration.enabled); } }).catch(() => { if (alive) setError(t('备份状态读取失败，请稍后重试。')); });
    const unsubscribe = window.electronAPI.onWorkspaceBackupStatus(value => { if (alive) setStatus(value); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  const busy = status && !['idle', 'completed', 'failed'].includes(status.phase);
  const run = async (operation: 'save' | 'backup') => {
    setSaving(true); setError(undefined);
    try {
      if (operation === 'save') setStatus(await window.electronAPI.configureWorkspaceBackup({ enabled, targetDirectory: target, externalLibraries: selected }));
      else setStatus(await window.electronAPI.startWorkspaceBackup({ targetDirectory: target, externalLibraries: selected }));
    } catch (failure) { setError(failure instanceof Error ? t(failure.message) : t('备份失败，请检查目录后重试。')); }
    finally { setSaving(false); }
  };
  return <Paper withBorder radius="md" className="workspace-settings-card" data-testid="workspace-backup-settings">
    <Group gap="sm" wrap="nowrap" className="workspace-settings-heading">
      <ThemeIcon variant="light" color="gray" size={32} radius="md"><Archive size={17} /></ThemeIcon>
      <Text fw={650} size="sm">{t('整库备份与每日快照')}</Text>
    </Group>
    <Text size="xs" c="dimmed" mt={8} lh={1.6}>{t('完整备份包含工作区、选中的外部库、附件、笔记近期备份、会话和记忆原文。密钥不会导出。')}</Text>

    <Box className="workspace-settings-block">
      <Text size="xs" fw={600} mb={8}>{t('备份范围')}</Text>
      <Stack gap={0} className="workspace-settings-sources">
        {status?.sources.map(source => <Checkbox
          key={`${source.kind}:${source.path}`}
          className="workspace-settings-source"
          disabled={busy || source.internal || !source.exists}
          checked={source.exists && (source.internal || selected.includes(source.path))}
          label={<Box>
            <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
              <Text size="xs" fw={550} className="workspace-settings-source-name">{source.alias}</Text>
              <Badge className="workspace-settings-source-badge" size="xs" variant="light" color={source.exists && source.internal ? 'teal' : 'gray'}>{!source.exists ? t('库已不存在，不会包含') : source.internal ? t('随工作区备份') : t('外部库')}</Badge>
            </Group>
            <Text size="xs" c="dimmed" className="workspace-settings-source-path" mt={3}>{source.path}</Text>
          </Box>}
          onChange={event => { const checked = event.currentTarget.checked; setSelected(current => checked ? [...current, source.path] : current.filter(file => file !== source.path)); }}
        />)}
        {status && !status.sources.length && <Text size="xs" c="dimmed" p="sm">{t('工作区：')}{status.workspacePath}</Text>}
      </Stack>
    </Box>

    <Box className="workspace-settings-block">
      <Text size="xs" fw={600} mb={8}>{t('备份目录')}</Text>
      <Box className="workspace-settings-location" data-empty={!target || undefined}>
        {target ? <Code block className="workspace-settings-path">{target}</Code> : <Text size="xs" c="dimmed" className="workspace-settings-copy">{t('请选择源目录之外的独立位置')}</Text>}
        <Button size="xs" variant="default" leftSection={<FolderOpen size={14} />} disabled={busy} onClick={() => void window.electronAPI.chooseBackupTarget().then(value => value && setTarget(value))}>{t('选择备份目录')}</Button>
      </Box>
    </Box>

    <Box className="workspace-settings-snapshot">
      <Box className="workspace-settings-copy">
        <Text component="label" htmlFor={snapshotSwitchId} size="xs" fw={600}>{t('应用运行时每日自动快照')}</Text>
        <Text size="xs" c="dimmed" mt={5} lh={1.6}>{t('每天最多一份，保留最近 7 份成功的自动快照。手动备份不自动删除；应用关闭期间不会执行。')}</Text>
      </Box>
      <Switch id={snapshotSwitchId} aria-label={t('应用运行时每日自动快照')} checked={enabled} disabled={busy} onChange={event => setEnabled(event.currentTarget.checked)} />
    </Box>

    <Group className="workspace-settings-actions" justify="space-between" gap="sm">
      <Text size="xs" c="dimmed">{status?.configuration.lastSuccessfulAt ? <>{t('最近成功时间：')}{new Date(status.configuration.lastSuccessfulAt).toLocaleString()}</> : null}</Text>
      <Group gap="xs">
        {busy && <Button size="xs" color="red" variant="subtle" onClick={() => void window.electronAPI.cancelWorkspaceBackup()}>{t('取消备份')}</Button>}
        <Button size="xs" variant="default" leftSection={<Save size={14} />} disabled={busy} loading={saving && !busy} onClick={() => void run('save')}>{t('保存快照设置')}</Button>
        <Button size="xs" leftSection={<Archive size={14} />} disabled={!target || busy} onClick={() => void run('backup')}>{t('立即备份')}</Button>
      </Group>
    </Group>
    <Stack gap="sm" className="workspace-settings-feedback">
      {busy && <Progress value={status.total ? status.completed / status.total * 100 : 0} animated />}
      {status?.message && <Alert color={status.phase === 'failed' ? 'red' : 'blue'}>{t(status.message)}</Alert>}
      {status?.outputPath && <Code block className="workspace-settings-path">{status.outputPath}</Code>}
      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  </Paper>;
}
