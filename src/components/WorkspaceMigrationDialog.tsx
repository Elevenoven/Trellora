import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Group, Modal, Progress, Stack, Text } from '@mantine/core';
import type { WorkspaceMigrationPreview, WorkspaceMigrationState, WorkspaceMigrationStatus } from '../../shared/workspaceMigration';
import { t, useI18n } from '../i18n';
import './settings/WorkspaceMigrationDialog.css';

interface Props {
  request: { sequence: number; mode: 'migrate' | 'open' };
  onBlockedChange: (blocked: boolean) => void;
  onDataChanged: (source?: string, target?: string) => Promise<void>;
}
const emptyStatus: WorkspaceMigrationStatus = { phase: 'idle', message: '', progress: 0, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, canCancel: false };
const activePhases = new Set(['preparing', 'copying', 'mapping', 'validating', 'switching']);
const stages = ['保存当前内容', '迁移文件', '关联历史与记忆', '校验数据', '启用新位置'];
const phaseIndex: Record<string, number> = { preparing: 0, copying: 1, mapping: 2, validating: 3, switching: 4, completed: 5 };
const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

/** A global modal stays mounted outside cached pages; backend completion and renderer refresh both precede unlocking. */
export default function WorkspaceMigrationDialog({ request, onBlockedChange, onDataChanged }: Props) {
  useI18n();
  const [preview, setPreview] = useState<WorkspaceMigrationPreview | null>(null);
  const [pending, setPending] = useState<WorkspaceMigrationPreview | null>(null);
  const [status, setStatus] = useState(emptyStatus);
  const [working, setWorking] = useState(false);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true), sequence = useRef(0);
  const returnRefreshRef = useRef<{ operationId: string; source?: string; target?: string } | null>(null);
  const callbacks = useRef({ onBlockedChange, onDataChanged });
  useEffect(() => { callbacks.current = { onBlockedChange, onDataChanged }; }, [onBlockedChange, onDataChanged]);
  const opened = Boolean(preview || pending || working || error || refreshNeeded);
  const busy = working || activePhases.has(status.phase);
  const operation = preview ?? pending;
  const receiveState = (state: WorkspaceMigrationState) => { setStatus(state.status); setPending(state.pending); };

  useEffect(() => {
    mounted.current = true;
    void window.electronAPI.getWorkspaceMigrationState().then(state => { if (mounted.current) receiveState(state); }).catch(failure => { if (mounted.current) setError(String(failure)); });
    const unsubscribe = window.electronAPI.onWorkspaceMigrationStatus(value => { if (mounted.current) setStatus(value); });
    return () => { mounted.current = false; unsubscribe(); callbacks.current.onBlockedChange(false); };
  }, []);
  useEffect(() => { callbacks.current.onBlockedChange(opened); }, [opened]);
  useEffect(() => {
    if (!opened) return;
    const blockShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && !['a', 'c'].includes(event.key.toLowerCase()))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', blockShortcut, true);
    return () => window.removeEventListener('keydown', blockShortcut, true);
  }, [opened]);

  useEffect(() => {
    if (!request.sequence || request.sequence === sequence.current) return;
    sequence.current = request.sequence;
    setError(undefined); setStatus(emptyStatus);
    if (request.mode === 'migrate') {
      setWorking(true);
      void window.electronAPI.previewWorkspaceMigration().then(value => { if (mounted.current) setPreview(value); }).catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (mounted.current) setWorking(false); });
    } else {
      setWorking(true);
      void window.electronAPI.openExistingWorkspace().then(async selected => { if (selected) await callbacks.current.onDataChanged(); }).catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (mounted.current) setWorking(false); });
    }
  }, [request]);

  const refresh = async (result: WorkspaceMigrationStatus) => {
    setRefreshNeeded(true);
    await callbacks.current.onDataChanged(result.sourcePath, result.targetPath);
    setRefreshNeeded(false); setPreview(null); setPending(null);
  };
  const start = async () => {
    if (!operation) return;
    setWorking(true); setError(undefined);
    try {
      const result = await window.electronAPI.startWorkspaceMigration(operation.operationId);
      setStatus(result);
      if (result.phase === 'completed') await refresh(result);
      else receiveState(await window.electronAPI.getWorkspaceMigrationState());
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWorking(false); }
  };
  const returnToOld = async () => {
    setWorking(true); setError(undefined);
    try {
      const needsRefresh = Boolean(operation && (pending || status.phase !== 'idle'));
      // Preview cancellation leaves the workspace untouched; recovery refreshes the actual before/after roots.
      if (needsRefresh && operation) {
        if (returnRefreshRef.current?.operationId !== operation.operationId) {
          const before = await window.electronAPI.getWorkspacePath();
          await window.electronAPI.abandonWorkspaceMigration(operation.operationId);
          returnRefreshRef.current = { operationId: operation.operationId, source: before ?? undefined, target: operation.sourcePath };
        }
        await callbacks.current.onDataChanged(returnRefreshRef.current.source, returnRefreshRef.current.target);
        returnRefreshRef.current = null;
      } else if (operation) await window.electronAPI.abandonWorkspaceMigration(operation.operationId);
      setPreview(null); setPending(null); setStatus(emptyStatus);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWorking(false); }
  };
  const displayProgress = status.phase === 'completed' && (working || refreshNeeded) ? 99 : status.progress;
  const title = pending && status.phase === 'interrupted' ? t('继续上次迁移') : status.phase === 'completed' && !working ? t('迁移完成') : request.mode === 'open' && !operation ? t('打开已有工作区') : t('更改数据存储位置');
  return <Modal opened={opened} onClose={() => undefined} title={title} centered size="lg" withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false} zIndex={10000} classNames={{ body: 'workspace-migration-body' }}>
    <Stack gap="md" data-workspace-migration-dialog data-testid="workspace-migration-dialog" data-phase={status.phase} aria-busy={busy}>
      {operation && <Box className="workspace-migration-locations">
        <Text size="xs" c="dimmed">{t('当前位置')}</Text><Text size="sm" className="workspace-migration-path">{operation.sourcePath}</Text>
        <Text size="xs" c="dimmed" mt="sm">{t('新位置')}</Text><Text size="sm" className="workspace-migration-path">{operation.targetPath}</Text>
      </Box>}
      {!busy && operation && <>
        <Text size="sm">{t('将迁移笔记、资料、附件、备份、会话、记忆和技能文件。')}</Text>
        <Group gap="lg"><Text size="sm">{t('{count} 个文件', { count: operation.fileCount })}</Text><Text size="sm">{formatBytes(operation.totalBytes)}</Text></Group>
        {operation.libraries.some(library => !library.internal) && <Text size="xs" c="dimmed">{t('以下外部库保留原位置，继续关联：')}{operation.libraries.filter(library => !library.internal).map(library => library.alias).join('、')}</Text>}
        <Text size="xs" c="dimmed">{t('完成后自动启用新位置。原目录保留为迁移前副本，模型配置和密钥继续沿用。')}</Text>
      </>}
      {(busy || status.phase === 'completed') && <>
        <Text size="sm" role="status" aria-live="polite">{status.phase === 'completed' && working ? t('正在加载新位置的数据。') : t(status.message || '正在读取工作区信息。')}</Text>
        <Progress value={displayProgress} animated={busy} aria-label={t('数据迁移进度')} data-testid="workspace-migration-progress" />
        <Group justify="space-between"><Text size="xs" c="dimmed">{status.phase === 'copying' ? `${formatBytes(status.completedBytes)} / ${formatBytes(status.totalBytes)}` : t('{completed} / {total} 个文件', { completed: status.completedFiles, total: status.totalFiles })}</Text><Text size="xs">{Math.floor(displayProgress)}%</Text></Group>
        {operation && <Box className="workspace-migration-stages">{stages.map((stage, index) => <Text key={stage} size="xs" data-state={index < (phaseIndex[status.phase] ?? 0) ? 'done' : index === phaseIndex[status.phase] ? 'active' : 'waiting'}>{t(stage)}</Text>)}</Box>}
        {status.currentFile && <Text size="xs" c="dimmed" className="workspace-migration-path">{status.currentFile}</Text>}
      </>}
      {pending && status.phase === 'interrupted' && <Alert color="yellow">{t(status.message)}</Alert>}
      {['failed', 'cancelled'].includes(status.phase) && <Alert color={status.phase === 'failed' ? 'red' : 'yellow'}>{t(status.message)}</Alert>}
      {error && <Alert color="red">{t(error)}</Alert>}
      <Group justify="flex-end">
        {busy ? status.canCancel && <Button variant="default" onClick={() => void window.electronAPI.cancelWorkspaceMigration().catch(failure => setError(String(failure)))}>{t('取消迁移')}</Button>
          : status.phase === 'completed' ? <>
            <Button variant="default" onClick={() => void window.electronAPI.openWorkspaceFolder()}>{t('打开新位置')}</Button>
            {refreshNeeded ? <Button onClick={() => { setWorking(true); setError(undefined); void refresh(status).catch(failure => setError(String(failure))).finally(() => setWorking(false)); }}>{t('重试加载')}</Button> : <Button onClick={() => setStatus(emptyStatus)}>{t('完成')}</Button>}
          </> : <>
            <Button variant="default" onClick={() => void returnToOld()}>{t(operation && (pending || status.phase !== 'idle') ? '继续使用原位置' : '取消')}</Button>
            {operation && <Button onClick={() => void start()}>{t(pending || ['failed', 'cancelled'].includes(status.phase) ? '继续迁移' : '开始迁移')}</Button>}
          </>}
      </Group>
    </Stack>
  </Modal>;
}
