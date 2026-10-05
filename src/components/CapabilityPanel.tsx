import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Text } from '@mantine/core';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '../../shared/userCapabilities';
import { t, useI18n } from '../i18n';
import './CapabilityPanel.css';

const labels: Record<CapabilityId, string> = { editing: '本地编辑', keywordSearch: '关键词搜索', generation: '智能回答', materialFullText: '资料全文搜索', materialSemantic: '资料语义检索', pdfParsing: 'PDF 云解析', documentWorker: '本地文档组件' };
const states: Record<CapabilityState, string> = { available: '可用', unconfigured: '未配置', unverified: '待检测', unreachable: '无法连接', processing: '处理中', failed: '失败' };

export default function CapabilityPanel({ libraryPath, documentId, onOpenSettings }: { libraryPath?: string; documentId?: string; onOpenSettings?: (section: 'model' | 'parsing') => void }) {
  useI18n();
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const generation = useRef({ active: false });
  const activeRequest = useRef<string>();
  useEffect(() => {
    const revision = { active: true }; generation.current = revision;
    setSnapshot(undefined); setError(undefined); setBusy(undefined);
    void window.electronAPI.getUserCapabilities({ libraryPath, documentId }).then(result => { if (revision.active) setSnapshot(result); }).catch(() => { if (revision.active) setError(t('能力状态读取失败，请刷新后重试。')); });
    return () => { revision.active = false; if (activeRequest.current) void window.electronAPI.cancelCapabilityProbe(activeRequest.current); };
  }, [libraryPath, documentId]);
  const probe = async (capability: 'generation' | 'documentWorker' | 'materialSemantic') => {
    const revision = generation.current;
    const requestId = crypto.randomUUID(); activeRequest.current = requestId;
    setBusy(capability); setError(undefined);
    try { const result = await window.electronAPI.probeUserCapability({ requestId, capability, libraryPath, documentId }); if (revision.active) setSnapshot(result); }
    catch { if (revision.active) setError(t('检测失败，请检查配置后重试。')); }
    finally { if (revision.active) { setBusy(undefined); activeRequest.current = undefined; } }
  };
  return (
    <Paper withBorder p="md" radius="md" className="capability-panel" data-testid="capability-panel">
      <Group className="capability-panel-header" justify="space-between" gap="xs">
        <Text size="sm" fw={650}>{t('功能状态')}</Text>
        {busy && <Button size="xs" variant="subtle" onClick={() => activeRequest.current && void window.electronAPI.cancelCapabilityProbe(activeRequest.current)}>{t('取消检测')}</Button>}
      </Group>
      {error && <Alert color="red" mb="sm">{error}</Alert>}
      {!snapshot && !error && <Text size="sm" c="dimmed">{t('读取中…')}</Text>}
      <div className="capability-panel-list" role="list">
        {snapshot?.capabilities.filter(item => libraryPath || !['materialFullText', 'materialSemantic'].includes(item.id)).map(item => (
          <div className="capability-panel-row" role="listitem" key={item.id}>
            <Text className="capability-panel-name" size="sm" fw={600}>{t(labels[item.id])}</Text>
            <Text className="capability-panel-message" size="xs" c="dimmed">{t(item.message)}</Text>
            <Badge className="capability-panel-state" data-state={item.state} size="sm" variant="light" radius="sm">{t(states[item.state])}</Badge>
            <div className="capability-panel-actions">
              {['generation', 'documentWorker', 'materialSemantic'].includes(item.id) && (
                <Button size="xs" variant="light" disabled={Boolean(busy)} loading={busy === item.id} aria-label={`${t(labels[item.id])} · ${t('检测')}`} onClick={() => void probe(item.id as 'generation' | 'documentWorker' | 'materialSemantic')}>{t('检测')}</Button>
              )}
              {onOpenSettings && ['pdfParsing', 'materialSemantic'].includes(item.id) && (
                <Button size="xs" variant="subtle" aria-label={`${t(labels[item.id])} · ${t('配置')}`} onClick={() => onOpenSettings(item.id === 'pdfParsing' ? 'parsing' : 'model')}>{t('配置')}</Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Paper>
  );
}
