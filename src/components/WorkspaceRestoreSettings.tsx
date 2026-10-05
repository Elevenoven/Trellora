import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Group, Paper, Progress, Stack, Text, ThemeIcon } from '@mantine/core';
import { FolderOpen, RotateCcw } from 'lucide-react';
import type { RestorePreview, RestoreStatus, RestoredConnectionHints } from '../../shared/workspaceBackup';
import { t, useI18n } from '../i18n';

export default function WorkspaceRestoreSettings({ onWorkspaceDataChanged }: { onWorkspaceDataChanged: () => Promise<void> }) {
  useI18n();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [pending, setPending] = useState<RestorePreview[]>([]);
  const [status, setStatus] = useState<RestoreStatus>();
  const [paused, setPaused] = useState<string[]>([]);
  const [hints, setHints] = useState<RestoredConnectionHints | null>(null);
  const [preferences, setPreferences] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true), refreshRevision = useRef(0);
  const refresh = async () => { const revision = ++refreshRevision.current; const [operations, roots, restored] = await Promise.all([window.electronAPI.getPendingWorkspaceRestores(), window.electronAPI.getRestorePausedRoots(), window.electronAPI.getRestoredConnectionHints()]); if (!mounted.current || revision !== refreshRevision.current) return; setPending(operations); setPaused(roots); setHints(restored); };
  useEffect(() => { mounted.current = true; void refresh().catch(() => { if (mounted.current) setError(t('恢复状态读取失败。')); }); const unsubscribe = window.electronAPI.onWorkspaceRestoreStatus(value => { if (mounted.current) setStatus(value); }); return () => { mounted.current = false; unsubscribe(); }; }, []);
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : t('恢复失败，请检查备份与目录权限。')); } finally { setBusy(false); } };
  return <Paper withBorder radius="md" className="workspace-settings-card" data-testid="workspace-restore-settings"><Stack gap="sm">
    <Box className="workspace-settings-restore-header">
      <Box className="workspace-settings-copy">
        <Group gap="sm" wrap="nowrap" className="workspace-settings-heading">
          <ThemeIcon variant="light" color="gray" size={32} radius="md"><RotateCcw size={17} /></ThemeIcon>
          <Text fw={650} size="sm">{t('从完整备份恢复')}</Text>
        </Group>
        <Text size="xs" c="dimmed" mt={8} lh={1.6}>{t('恢复会创建独立的新目录并登记新库，保留当前工作区。只支持 Trellora 完整备份；密钥需要重新填写。')}</Text>
      </Box>
      <Button className="workspace-settings-restore-action" size="xs" variant="default" leftSection={<FolderOpen size={14} />} disabled={busy} onClick={() => void run(async () => { setStatus(undefined); setPreview(await window.electronAPI.previewWorkspaceRestore()); })}>{t('选择备份并预览')}</Button>
    </Box>
    {preview && <Stack gap="xs" className="workspace-settings-restore-preview">
      <Text size="sm">{t('备份版本：')}{preview.manifest.appVersion} · {new Date(preview.manifest.createdAt).toLocaleString()} · {preview.manifest.files.length} {t('个文件')}</Text>
      <Text size="xs" style={{ overflowWrap: 'anywhere' }}>{t('恢复目标：')}{preview.targetDirectory}</Text>
      {preview.targets.map(root => <Text key={root.rootId} size="xs" style={{ overflowWrap: 'anywhere' }}>{root.sourcePath} → {root.targetPath}</Text>)}
      {preview.warnings.map((warning, index) => <Text key={index} size="xs" c="dimmed">{t(warning)}</Text>)}
      <Checkbox checked={preferences} disabled={busy} onChange={event => setPreferences(event.currentTarget.checked)} label={t('同时导入外观与编辑偏好')} />
      <Button size="xs" disabled={busy} onClick={() => void run(async () => { setStatus(await window.electronAPI.startWorkspaceRestore(preview.operationId, preferences)); await onWorkspaceDataChanged(); })}>{t('确认恢复到新目录')}</Button>
    </Stack>}
    {pending.map(item => <Group key={item.operationId}><Text size="xs" style={{ overflowWrap: 'anywhere', flex: 1 }}>{t('未完成的恢复：')}{item.targetDirectory}</Text><Button size="xs" variant="light" disabled={busy} onClick={() => void run(async () => { setPreview(item); setStatus(await window.electronAPI.startWorkspaceRestore(item.operationId, false)); await onWorkspaceDataChanged(); })}>{t('继续恢复')}</Button></Group>)}
    {busy && <><Progress value={status?.total ? status.completed / status.total * 100 : 0} animated /><Button size="xs" variant="subtle" color="red" onClick={() => void window.electronAPI.cancelWorkspaceRestore()}>{t('取消恢复')}</Button></>}
    {status && <Alert color={status.phase === 'failed' ? 'red' : 'blue'}>{t(status.message)}</Alert>}
    {status?.phase === 'completed' && <Button size="xs" variant="light" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.openRestoredWorkspace(status.workspacePath); await onWorkspaceDataChanged(); })}>{t('切换到恢复的工作区')}</Button>}
    {paused.length > 0 && <Alert color="yellow"><Stack gap="xs"><Text size="sm">{t('恢复的后台处理保持暂停；笔记和已有历史可以使用。重新配置服务后可主动恢复。')}</Text><Button size="xs" variant="light" disabled={busy} onClick={() => void run(() => window.electronAPI.resumeRestoredTasks())}>{t('恢复后台处理')}</Button></Stack></Alert>}
    {hints && <Stack gap="xs"><Text size="sm" fw={600}>{t('备份中的模型连接')}</Text><Text size="xs" c="dimmed">{t('这些信息供重新配置时参考；当前连接未被覆盖，密钥需要重新填写。')}</Text>{hints.aiModelSettings?.profiles.map(profile => <Text key={profile.id} size="xs" style={{ overflowWrap: 'anywhere' }}>{profile.label} · {profile.config.model} · {profile.config.endpoint}</Text>)}{hints.modelHub?.providers.filter(provider => provider.endpoint).map(provider => <Text key={provider.id} size="xs" style={{ overflowWrap: 'anywhere' }}>{provider.label} · {provider.endpoint}</Text>)}{hints.parsing?.mineruEndpoint && <Text size="xs" style={{ overflowWrap: 'anywhere' }}>MinerU · {hints.parsing.mineruEndpoint}</Text>}</Stack>}
    {error && <Alert color="red">{t(error)}</Alert>}
  </Stack></Paper>;
}
