import { Button, Group, Modal, Paper, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { t, useI18n } from '../../i18n';
import type { MemoryProposalContext, MemoryProposalReview } from '../../../electron/knowledge/memory/memoryTypes';
import { reviewReasonLabel } from './memoryPresentation';

/** Keep the displayed snapshots fixed until confirmation; the main process rejects changes that occur while this dialog is open. */
export function MemoryProposalReviewDialog({ context, busy, error, onClose, onConfirm, onReject, onEdit }: {
  context: MemoryProposalContext;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (review: MemoryProposalReview) => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  useI18n();
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [reviewNow, setReviewNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setReviewNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const { proposal } = context;
  const target = proposal.proposalAction === 'add' ? context.availableTargets.find(item => item.id === selectedTargetId) : context.currentTarget;
  const action = proposal.proposalAction !== 'add' ? proposal.proposalAction ?? 'add' : target ? 'replace' : 'add';
  const oldContent = target?.content ?? proposal.replacesSnapshot?.content;
  const expired = proposal.expiresAt !== null && Date.parse(proposal.expiresAt) <= reviewNow;
  const invalid = proposal.status !== 'pending' || !!context.invalidReason || expired;
  const confirm = () => {
    if (!proposal.proposalFingerprint || invalid) return;
    onConfirm({ expectedAction: action, expectedProposalFingerprint: proposal.proposalFingerprint,
      ...(proposal.proposalAction === 'add' && target ? { targetItemId: target.id, expectedTargetFingerprint: target.targetFingerprint } : {}) });
  };
  return <Modal opened onClose={onClose} title={t('审查长期记忆')} centered size="lg">
    <Stack gap="sm" data-testid="memory-proposal-review">
      <Text size="sm">{action === 'retire' ? t('确认后撤销以下记忆，不新增有效事实。') : action === 'replace' ? t('确认后以新正文替换旧记忆。请保留仍然有效的其他事实。') : t('确认后新增独立记忆，现有记忆继续生效。')}</Text>
      {proposal.proposalAction === 'add' ? <Select label={t('保存方式')} value={selectedTargetId ?? 'independent'}
        data={[{ value: 'independent', label: t('新增独立记忆') }, ...context.availableTargets.map(item => ({ value: item.id, label: t('替换：') + item.content }))]}
        onChange={value => setSelectedTargetId(value === 'independent' ? null : value)} disabled={busy || invalid} searchable /> : null}
      {oldContent ? <Paper withBorder p="sm"><Text size="xs" c="dimmed">{action === 'retire' ? t('待撤销的旧记忆') : t('旧记忆')}</Text><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{oldContent}</Text></Paper> : null}
      {action !== 'retire' ? <Paper withBorder p="sm"><Text size="xs" c="dimmed">{t('待确认的新正文')}</Text><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{proposal.content}</Text></Paper> : null}
      <Paper withBorder p="sm"><Text size="xs" c="dimmed">{t('来源原话')}</Text><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{context.sourceQuote ?? t('没有可验证的用户原话来源')}</Text></Paper>
      <Text size="xs" c="dimmed">{t('原因：')}{reviewReasonLabel(proposal.reviewReason)} · {t('有效期：')}{proposal.expiresAt ? new Date(proposal.expiresAt).toLocaleString() : t('长期')}</Text>
      {invalid ? <Text c="orange" size="sm">{t('提案或原记忆已变化、过期，请关闭并刷新。')}</Text> : null}
      {error ? <Text c="red" size="sm" role="alert">{error}</Text> : null}
      <Group justify="flex-end">
        {action !== 'retire' ? <Button variant="subtle" onClick={onEdit} disabled={busy || invalid}>{t('编辑新正文')}</Button> : null}
        <Button variant="default" onClick={onReject} disabled={busy || proposal.status !== 'pending'}>{t('拒绝提案')}</Button>
        <Button onClick={confirm} loading={busy} disabled={invalid || !proposal.proposalFingerprint} data-testid="memory-review-confirm">{action === 'retire' ? t('确认撤销') : action === 'replace' ? t('确认替换') : t('确认新增')}</Button>
      </Group>
    </Stack>
  </Modal>;
}
