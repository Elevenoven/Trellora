import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, Modal, Paper, Progress, Select, Stack, Text, TextInput } from '@mantine/core';
import type { MaterialVectorGeneration } from '../../../shared/materialVectorGenerations';
import type { MaterialEmbeddingCandidate, MaterialEmbeddingProfileStatus, MaterialEmbeddingProfileTestResult, ModelHub } from '../../electron';
import { t, useI18n } from '../../i18n';

const stateLabels = { BUILDING: '正在构建', INTERRUPTED: '构建已中断', CANCELLED: '已取消', FAILED: '构建失败', READY: '已验证，待切换', ACTIVE: '当前使用', RETIRED: '已保留，可回滚' };

/** 新模型经过探测、独立构建和读回验证后，用户才能明确切换激活的索引代际。 */
export default function MaterialVectorGenerationsPanel({ libraryPath, status, hub, onChanged }: {
  libraryPath: string; status: MaterialEmbeddingProfileStatus | null; hub: ModelHub | null; onChanged: () => Promise<void>;
}) {
  useI18n();
  const [opened, setOpened] = useState(false), [source, setSource] = useState('ollama'), [model, setModel] = useState('');
  const [rows, setRows] = useState<MaterialVectorGeneration[]>([]), [tested, setTested] = useState<MaterialEmbeddingProfileTestResult>();
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [selection, setSelection] = useState<MaterialVectorGeneration>();
  const refresh = useCallback(async () => { setRows(await window.electronAPI.listMaterialVectorGenerations(libraryPath)); }, [libraryPath]);
  useEffect(() => {
    if (!opened) return;
    let disposed = false;
    const load = () => void window.electronAPI.listMaterialVectorGenerations(libraryPath).then(value => { if (!disposed) setRows(value); }).catch(value => { if (!disposed) setError(value.message); });
    load(); const timer = window.setInterval(load, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [libraryPath, opened]);
  const candidate = useMemo<MaterialEmbeddingCandidate | undefined>(() => {
    if (!hub || !model.trim()) return undefined;
    const endpoint = source === 'ollama' ? hub.ollamaEndpoint || 'http://127.0.0.1:11434' : hub.providers.find(provider => provider.id === source)?.endpoint;
    if (!endpoint) return undefined;
    return { schemaVersion: 1, sourceId: source, transportKind: source === 'ollama' ? 'ollama' : 'openai-compatible', endpointIdentity: endpoint,
      requestedModel: model.trim(), vectorType: 'float32', distanceMetric: 'cosine', encodingFormat: 'float', truncateInputs: source === 'ollama', documentInputVersion: 'material-chunk-text-v1', queryInputVersion: 'material-query-text-v1' };
  }, [hub, model, source]);
  useEffect(() => { setTested(undefined); }, [candidate]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); } catch (value) { setError(value instanceof Error ? value.message : t('索引代际操作失败。')); }
    finally { setBusy(false); }
  };
  const building = rows.some(row => row.state === 'BUILDING');
  if (status?.state !== 'LOCKED') return null;
  return <>
    <Group justify="flex-end"><Button size="xs" variant="subtle" onClick={() => { setSource(status.profile?.sourceId ?? 'ollama'); setModel(status.profile?.requestedModel ?? ''); setOpened(true); }}>{t('管理索引代际')}</Button></Group>
    <Modal opened={opened} onClose={() => !busy && setOpened(false)} title={t('向量模型与索引代际')} size="lg" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">{t('新模型会重新处理全部资料块。构建期间保留当前索引，验证完成后手动切换；旧代际保留用于回滚。')}</Text>
        {error && <Alert color="red" role="alert">{t(error)}</Alert>}
        <Select label={t('新代际模型来源')} aria-label={t('新代际模型来源')} value={source} disabled={busy || building}
          data={[{ value: 'ollama', label: t('本地 Ollama') }, ...(hub?.providers.filter(provider => !provider.generationOnly).map(provider => ({ value: provider.id, label: provider.label })) ?? [])]} onChange={value => value && setSource(value)} />
        <TextInput label={t('新代际模型名称')} aria-label={t('新代际模型名称')} value={model} disabled={busy || building} onChange={event => setModel(event.currentTarget.value)} />
        <Group><Button variant="default" disabled={!candidate || building} loading={busy} onClick={() => void perform(async () => setTested(await window.electronAPI.testMaterialEmbeddingProfile(libraryPath, candidate!)))}>{t('测试新模型')}</Button>
          <Button disabled={!tested || !candidate || building} loading={busy} onClick={() => void perform(() => window.electronAPI.createMaterialVectorGeneration(libraryPath, candidate!))}>{t('构建新代际')}</Button>
          {tested && <Text size="xs">{tested.vectorDimension} {t('维 · cosine · float32')}</Text>}
        </Group>
        {rows.map(row => <Paper key={row.id} withBorder p="sm" radius="sm" data-generation-id={row.id}>
          <Stack gap="xs"><Group justify="space-between"><Text size="sm" fw={600}>{row.profile.requestedModel}</Text><Badge color={row.state === 'FAILED' ? 'red' : row.state === 'ACTIVE' ? 'teal' : 'gray'}>{t(stateLabels[row.state])}</Badge></Group>
            <Text size="xs" c="dimmed">{row.profile.sourceId} · {row.profile.vectorDimension} {t('维')} · {row.completed}/{row.total}</Text>
            {row.state === 'BUILDING' && <Progress value={row.total ? row.completed / row.total * 100 : 0} />}
            {row.error && <Text size="xs" c="red">{t(row.error)}</Text>}
            <Group justify="flex-end">
              {row.state === 'BUILDING' && <Button size="xs" variant="default" disabled={busy} onClick={() => void perform(() => window.electronAPI.cancelMaterialVectorGeneration(libraryPath, row.id))}>{t('取消构建')}</Button>}
              {['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(row.state) && <Button size="xs" variant="default" disabled={busy || building} onClick={() => void perform(() => window.electronAPI.resumeMaterialVectorGeneration(libraryPath, row.id))}>{t('继续构建')}</Button>}
              {['READY', 'RETIRED'].includes(row.state) && <Button size="xs" disabled={busy || building} onClick={() => setSelection(row)}>{t(row.state === 'READY' ? '切换到此代际' : '回滚到此代际')}</Button>}
            </Group>
          </Stack>
        </Paper>)}
      </Stack>
    </Modal>
    <Modal opened={Boolean(selection)} onClose={() => !busy && setSelection(undefined)} title={t('确认切换索引代际')} centered>
      <Stack><Text size="sm">{t('切换后，文档索引与查询向量都使用这个模型。当前代际会保留；资料或切块变化后，旧快照需要重新构建。')}</Text>
        {error && <Alert color="red" role="alert">{t(error)}</Alert>}
        <Text fw={600}>{selection?.profile.requestedModel} · {selection?.profile.vectorDimension} {t('维')}</Text>
        <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setSelection(undefined)}>{t('返回修改')}</Button><Button loading={busy} onClick={() => void perform(async () => { await window.electronAPI.activateMaterialVectorGeneration(libraryPath, selection!.id); setSelection(undefined); await onChanged(); })}>{t('确认切换')}</Button></Group>
      </Stack>
    </Modal>
  </>;
}
