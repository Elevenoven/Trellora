import { useEffect, useState } from 'react';
import { t, useI18n } from '../../i18n';
import type { MemorySaveReceipt, MemoryTurnStatus } from '../../../electron/knowledge/memory/memoryTypes';
import { memoryFailureMessage } from '../../../shared/memoryFailure';

/** Actual per-turn state, independently projected from recall usage and the original explicit-save receipt. */
export default function MemoryTurnStatusBadge({ turnId, settled, receipt }: { turnId: string; settled: boolean; receipt?: MemorySaveReceipt }) {
  useI18n();
  const [status, setStatus] = useState<MemoryTurnStatus | null>(null);
  useEffect(() => {
    if (!settled || !window.electronAPI.getLongTermMemoryTurnStatus) return;
    let mounted = true;
    const refresh = () => void window.electronAPI.getLongTermMemoryTurnStatus([turnId]).then(rows => {
      if (mounted) setStatus(rows[0] ?? null);
    }).catch(() => { /* State is not inferred when transport is unavailable. */ });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, [turnId, settled]);
  if (!status) return receipt ? <span className="assistant-profile-update-receipt" role="status" data-testid="memory-save-receipt">
    {t(receipt.status === 'saved' && receipt.itemStatus === 'archived' ? '已保存，因容量限制未生效'
      : ({ saved: '已保存到长期记忆', pending: '已提交待确认，原记忆继续生效', disabled: '长期记忆已关闭，本次未保存', failed: '长期记忆保存失败，请重试' } as const)[receipt.status])}
  </span> : null;
  const extraction = status.extraction;
  const pending = extraction.currentItems?.find(item => item.status === 'pending');
  const currentActive = extraction.currentItems?.filter(item => item.status === 'active').length;
  const inactiveLabels = [...new Set(extraction.currentItems?.flatMap(item => {
    const labels = { deleted: '保存项已删除', cleared: '保存项已清空', superseded: '保存项已被替代', archived: '保存项已归档' } as const;
    return item.status === 'active' || item.status === 'pending' ? [] : [t(labels[item.status])];
  }))];
  const jumpId = pending?.id ?? (status.explicit?.currentStatus === 'pending' ? status.explicit.itemId : undefined);
  let label: string;
  if (extraction.status === 'waiting') label = t('等待自动提炼');
  else if (extraction.status === 'running') label = t('正在提炼');
  else if (extraction.status === 'retry') label = t('自动提炼待重试') + ' · ' + t(memoryFailureMessage(extraction.reason));
  else if (extraction.status === 'failed') label = t(memoryFailureMessage(extraction.reason));
  else if (extraction.status === 'stale') label = t('记忆已清空，本轮不会重新写入');
  else if (extraction.status === 'disabled') label = t(extraction.reason === 'memory_disabled' ? '本轮不自动提炼：长期记忆已关闭'
    : extraction.reason === 'legacy_baseline' ? '旧轮次按迁移基线跳过，未重新提炼'
    : extraction.reason === 'explicit_only' ? '本轮不自动提炼：仅明确保存' : extraction.reason === 'MEMORY_PROTOCOL_UPGRADE_REQUIRED' ? '自动提炼正在升级' : '本轮不自动提炼：来源或入口未授权');
  else if (pending) label = t('自动提炼已完成，有记忆待确认');
  else if (currentActive ?? extraction.summary?.active) label = t('已保存 {0} 条长期记忆', { '0': String(currentActive ?? extraction.summary?.active) });
  else if (inactiveLabels.length) label = inactiveLabels.join(' · ');
  else if (extraction.summary?.archived) label = t('已提炼，保存项因容量限制未生效');
  else if (!extraction.summary) label = t('已完成提炼，旧版未记录条目明细');
  else label = t('已提炼，无新增有效记忆');
  if (extraction.status === 'applied' && (pending || currentActive) && inactiveLabels.length) label += ' · ' + inactiveLabels.join(' · ');
  const explicitState = status.explicit ? t(({ active: '已保存到长期记忆', pending: '已提交待确认，原记忆继续生效',
    deleted: '保存项已删除', cleared: '保存项已清空', superseded: '保存项已被替代', archived: '保存项已归档' } as const)[status.explicit.currentStatus])
    : receipt?.status === 'failed' ? t('长期记忆保存失败，请重试') : '';
  const title = extraction.nextDueAt ? t('下次计划时间：') + new Date(extraction.nextDueAt).toLocaleString() : undefined;
  return <span className="assistant-profile-update-receipt" role="status" data-testid="memory-extraction-status" title={title}>
    {explicitState ? <span data-testid="memory-save-receipt">{explicitState}</span> : null}
    {explicitState ? (extraction.status === 'disabled' || extraction.status === 'stale' ? '' : ' · ' + label) : label}{!status.memoryEnabled && (extraction.status === 'applied' || status.explicit) ? ' · ' + t('长期记忆当前已关闭') : ''}
    {jumpId ? <button type="button" className="assistant-message-copy-button" onClick={() => window.dispatchEvent(new CustomEvent('trellora:review-memory', { detail: { itemId: jumpId } }))}>{t('审查记忆')}</button> : null}
  </span>;
}
