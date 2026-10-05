import { getAppLanguage, localizeOptions, t, useI18n } from '../../i18n';
import { ActionIcon, Alert, Badge, Button, Checkbox, Divider, Group, Paper, ScrollArea, Select, Stack, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { Check, Copy, FileText, LoaderCircle, Play, Settings2, Sparkles, Square, X } from 'lucide-react';
import { useState } from 'react';
import type { SelectionExpansionSettings } from '../../electron';
import { primarySelectionEditQualityIssue, selectionEditQualityIssueLabel } from '../../../electron/knowledge/selectionEditQuality';
import type { SelectionExpansionDraftSession } from '../../editor/selectionExpansion';
import { copyPlainText } from '../../utils/clipboard';
import ExpansionReceipt from '../selection-edit/ExpansionReceipt';
import MarkdownContent from '../MarkdownContent';
import { resolveExpansionTarget } from '../../../shared/selectionExpansionPolicy';

interface SelectionExpansionWorkspaceProps {
  session: SelectionExpansionDraftSession;
  onChange: (settings: SelectionExpansionSettings) => void;
  onSaveDefaults: (settings: SelectionExpansionSettings) => Promise<void>;
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
  onApply: () => void;
  onClose: () => void;
}

const styleOptions = [
  { value: 'preserve', label: '沿用原文' },
  { value: 'professional', label: '专业说明' },
  { value: 'academic', label: '学术严谨' },
  { value: 'plain', label: '通俗解释' },
  { value: 'proposal', label: '方案文档' },
];

const audienceOptions = [
  { value: 'preserve', label: '沿用原文' },
  { value: 'beginner', label: '初学者' },
  { value: 'professional', label: '专业人员' },
  { value: 'manager', label: '管理者' },
];

const reasoningOptions = [
  { value: 'fast', label: '快速' },
  { value: 'standard', label: '标准' },
  { value: 'deep', label: '深入' },
];

const sourceKindLabels = {
  'current-note': '当前笔记',
  'note-library': '同库 Markdown',
  materials: '资料库',
  web: '联网来源',
} as const;

const candidateReadStateLabels = {
  candidate: '仅定位',
  'deep-read': '已深读',
  skipped: '未读取',
} as const;

export default function SelectionExpansionWorkspace({ session, onChange, onSaveDefaults, onStart, onCancel, onApply, onClose }: SelectionExpansionWorkspaceProps) {
  useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const { settings, capabilities, snapshot, writeback } = session;
  const isRunning = session.status === 'planning' || session.status === 'researching' || session.status === 'synthesizing';
  const isComplete = session.status === 'completed' || session.status === 'partial' || session.status === 'not-found';
  const validation = session.result?.validation;
  const qualityReceipt = session.result?.qualityReceipt;
  const execution = session.result?.execution;
  const receipt = session.result?.receipt;
  const receiptCandidates = receipt?.candidates ?? [];
  const receiptUsed = receipt?.used ?? [];
  const receiptSkipped = receipt?.skipped ?? [];
  const receiptConflicts = receipt?.conflicts ?? [];
  const qualityIssue = primarySelectionEditQualityIssue(qualityReceipt);
  const validationMessage = validation && !validation.passed
    ? qualityIssue
      ? selectionEditQualityIssueLabel(qualityIssue)
      : validation.warnings[0]
      ?? validation.protectedAnchorLosses[0]
      ?? validation.unsupportedClaims[0]
      ?? t("该建议缺少可直接写回的验证结果，请复制后人工核对。")
    : undefined;
  const canApplyResult = (writeback.mode === 'inline-text' || writeback.mode === 'block-markdown')
    && qualityReceipt?.validation === 'passed'
    && validation?.passed === true;
  const selectedCharacters = Array.from(snapshot.selectedText.replace(/\s/gu, '')).length;
  const targetLengthValue = settings.targetLength.mode === 'ratio'
    ? String(settings.targetLength.ratio)
    : 'custom';
  const sourceLabel = snapshot.currentPath.split(/[\\/]/u).pop() || t("当前笔记");
  const unverifiedWebCandidates = receiptCandidates.filter((item) => item.sourceKind === 'web' && item.pageVerified !== true);
  const update = (patch: Partial<SelectionExpansionSettings>) => onChange({ ...settings, ...patch });
  const updateSources = (patch: Partial<SelectionExpansionSettings['sources']>) => {
    onChange({ ...settings, sources: { ...settings.sources, ...patch } });
  };

  return (
    <Stack className="selection-expansion-workspace" gap={0} aria-label={t("选区扩写优化")}>
      <ScrollArea className="selection-expansion-workspace-body" type="auto" scrollbarSize={8} style={{ flex: '1 1 auto', minHeight: 0 }}>
        <Stack gap="sm" p="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="xs" wrap="nowrap"><Sparkles size={18} /><div><Text fw={700} size="sm">{t("选区扩写优化")}</Text><Text size="xs" c="dimmed">{t("结合当前笔记上下文生成可审阅扩写稿")}</Text></div></Group>
        <Tooltip label={t("关闭选区扩写")}><ActionIcon variant="subtle" color="gray" aria-label={t("关闭选区扩写")} onClick={onClose}><X size={16} /></ActionIcon></Tooltip>
      </Group>

      <Paper withBorder p="sm" radius="md">
        <Group gap="xs" mb={4}><FileText size={14} /><Text size="xs" fw={600}>{sourceLabel} {t("· 选中")} {selectedCharacters.toLocaleString(getAppLanguage())} {t("字")}</Text></Group>
        <Text size="xs" c="dimmed" lineClamp={3}>{snapshot.selectedText}</Text>
      </Paper>

      <Divider label={t("本次扩写设置")} labelPosition="center" />
      <Select
        label={t("目标长度")}
        value={targetLengthValue}
        data={[
          { value: '1.3', label: t("轻度 · 约 1.3×") },
          { value: '1.8', label: t("标准 · 约 1.8×") },
          { value: '2.5', label: t("深度 · 约 2.5×") },
          { value: 'custom', label: t("自定义目标字符数") },
        ]}
        disabled={isRunning}
        onChange={(value) => {
          if (value === 'custom') update({ targetLength: { mode: 'characters', characters: Math.max(100, resolveExpansionTarget(snapshot.selectedText)) } });
          if (value === '1.3' || value === '1.8' || value === '2.5') update({ targetLength: { mode: 'ratio', ratio: Number(value) as 1.3 | 1.8 | 2.5 } });
        }}
      />
      {settings.targetLength.mode === 'characters' ? <TextInput label={t("目标有效字符数")} type="number" min={100} max={40_000} value={String(settings.targetLength.characters)} disabled={isRunning} onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isInteger(next) && next >= 100 && next <= 40_000) update({ targetLength: { mode: 'characters', characters: next } });
      }} /> : null}
      <Select label={t("写作风格")} value={settings.style} data={localizeOptions(styleOptions)} disabled={isRunning} onChange={(value) => value && update({ style: value as SelectionExpansionSettings['style'] })} />
      <Select label={t("目标读者")} value={settings.audience} data={localizeOptions(audienceOptions)} disabled={isRunning} onChange={(value) => value && update({ audience: value as SelectionExpansionSettings['audience'] })} />
      <Select label={t("思考强度")} value={settings.reasoningDepth} data={localizeOptions(reasoningOptions)} disabled={isRunning} onChange={(value) => value && update({ reasoningDepth: value as SelectionExpansionSettings['reasoningDepth'] })} />

      <Stack gap={4}>
        <Text size="sm" fw={500}>{t("证据范围")}</Text>
        <Checkbox label={t("当前笔记")} checked={settings.sources.currentNote} disabled={isRunning || !capabilities.sources.currentNote} onChange={(event) => updateSources({ currentNote: event.currentTarget.checked })} />
        <Checkbox label={t("同库 Markdown")} checked={settings.sources.noteLibrary} disabled={isRunning || !capabilities.sources.noteLibrary} onChange={(event) => updateSources({ noteLibrary: event.currentTarget.checked })} />
        <Checkbox label={t("资料库")} checked={settings.sources.materialsLibrary} disabled={isRunning || !capabilities.sources.materialsLibrary} onChange={(event) => updateSources({ materialsLibrary: event.currentTarget.checked })} />
        <Checkbox label={t("联网补充")} checked={settings.sources.web !== 'off'} disabled={isRunning || !capabilities.sources.web} onChange={(event) => updateSources({ web: event.currentTarget.checked ? 'inherit' : 'off' })} />
        <Checkbox label={t("个性化术语与表达")} checked={settings.sources.personalization} disabled={isRunning || !capabilities.sources.personalization} onChange={(event) => updateSources({ personalization: event.currentTarget.checked })} />
        <Text size="xs" c="dimmed">{t("联网默认关闭；开启后仅把全文核验成功的网页作为事实证据。个性化只影响措辞和术语，不会成为事实依据。")}</Text>
        <Text size="xs" c="dimmed">{t("当前灰度：")}{capabilities.mode}{t("。只显示已经具备取证与校验能力的来源。")}</Text>
      </Stack>
      <Textarea label={t("自定义要求")} value={settings.customInstruction} maxLength={capabilities.limits.maxCustomInstructionCharacters} autosize minRows={2} disabled={isRunning} onChange={(event) => update({ customInstruction: event.currentTarget.value })} placeholder={t("例如：补充适合作为方案说明的过渡与边界条件")} />

      {isRunning ? <Alert color="blue" variant="light" icon={<LoaderCircle className="spin" size={16} />}>
        {session.message || t("正在执行扩写任务…")}
      </Alert> : null}
      {session.status === 'error' ? <Alert color="red" variant="light">{session.error || t("扩写优化未能完成。")}</Alert> : null}
      {actionError ? <Alert color="red" variant="light">{actionError}</Alert> : null}
      {writeback.mode === 'copy-only' ? <Alert color="yellow" variant="light">{writeback.message}</Alert> : null}
      {validationMessage ? <Alert color="yellow" variant="light">{validationMessage}</Alert> : null}
      {session.status === 'cancelled' ? <Alert color="gray" variant="light">{t("已取消本次扩写任务，原文没有改动。")}</Alert> : null}
      {session.status === 'stale' ? <Alert color="red" variant="light">{t("当前笔记已变化，本次结果已失效；原文没有改动。")}</Alert> : null}
      {session.plan ? <Paper withBorder p="sm" radius="md">
        <Text size="xs" fw={600} mb={4}>{t("证据计划")}{session.plan.fallback ? t("（保守回退）") : ''}</Text>
        <Stack gap={2}>{session.plan.goals.map((goal) => <Text key={goal.goalId} size="xs">• {goal.question}</Text>)}</Stack>
      </Paper> : null}
      {session.evidence.length > 0 ? <Paper withBorder p="sm" radius="md">
        <Text size="xs" fw={600} mb={4}>{t("已深读原文 ·")} {session.evidence.length} {t("条")}</Text>
        <Stack gap={5}>{session.evidence.map((item) => <Paper key={item.evidenceId} withBorder p="xs" radius="sm">
          <Text size="xs" fw={600}>{t(sourceKindLabels[item.sourceKind])} · {item.title}</Text>
          <Text size="xs" c="dimmed">{item.locator}</Text>
          {item.sourceKind === 'web' ? <Text size="xs" c={item.pageVerified ? 'teal' : 'yellow'}>{item.pageVerified ? t("已全文核验，可作为网页事实证据。") : t("检索摘要，未全文核验，不作为事实证据。")}</Text> : null}
          <Text size="xs" c="dimmed" lineClamp={2}>{item.content}</Text>
        </Paper>)}</Stack>
      </Paper> : null}
      {receipt ? <Paper withBorder p="sm" radius="md">
        <Text size="xs" fw={600} mb={4}>{t("本次上下文回执")}</Text>
        <Stack gap={2}>
          <ExpansionReceipt context={receipt} />
          <Text size="xs" c="dimmed">{receipt.fullNoteMode === 'strict-direct'
            ? t("已按严格小笔记门槛读取当前笔记全文。")
            : t("已完成 {0} 条来源定位，并仅对其中 {1} 条执行原文深读。", { '0': receiptCandidates.length, '1': receiptUsed.length })}</Text>
          <Text size="xs" c="dimmed">{t("已纳入合成：")}{receiptUsed.length} {t("条已验证原文；候选摘要不会进入生成上下文。")}</Text>
          {receipt.personalization?.requested ? <Text size="xs" c="dimmed">{t("个性化：")}{receipt.personalization.applied ? t("已受控应用 {0} 条措辞/术语偏好，不作为事实证据。", { '0': receipt.personalization.itemCount }) : receipt.personalization.reason ?? t("本次未应用。")}</Text> : null}
          {receiptSkipped.length > 0 ? <Text size="xs" c="dimmed">{t("未读取：")}{receiptSkipped.map((item) => item.reason).join('；')}</Text> : null}
        </Stack>
      </Paper> : null}
      {qualityReceipt ? <Paper withBorder p="sm" radius="md">
        <Group justify="space-between" align="center" mb={4}>
          <Text size="xs" fw={600}>{t("结果校验")}</Text>
          <Badge size="xs" variant="light" color={qualityReceipt.validation === 'passed' ? 'teal' : 'yellow'}>
            {qualityReceipt.validation === 'passed' ? t("可写回") : t("仅可复制")}
          </Badge>
        </Group>
        <Stack gap={2}>
          <Text size="xs" c="dimmed">{t("生成：")}{qualityReceipt.generation === 'complete' ? t("完成") : qualityReceipt.generation === 'partial' ? t("已生成，待人工核对") : t("没有安全可用的正文")}{t("；计划目标与原文关联：")}{qualityReceipt.evidenceCoverage === 'complete' ? t("已关联") : qualityReceipt.evidenceCoverage === 'partial' ? t("部分关联") : qualityReceipt.evidenceCoverage === 'none' ? t("未关联") : t("本次不要求")}</Text>
          <ExpansionReceipt quality={qualityReceipt} />
          {execution ? <Text size="xs" c="dimmed">{t("实际执行：")}{execution.path === 'react' ? t("研究 Agent") : t("直接生成")} · {execution.rounds} {t("轮 · 模型")} {execution.modelCalls} {t("次 · 工具")} {execution.toolCalls} {t("次 · 修复")} {execution.repairAttempts} {t("次")}</Text> : null}
          {qualityReceipt.issues.map((issue) => <Text key={issue.code} size="xs" c="yellow">• {selectionEditQualityIssueLabel(issue)}</Text>)}
        </Stack>
      </Paper> : null}
      {receiptCandidates.length ? <Paper withBorder p="sm" radius="md">
        <Text size="xs" fw={600} mb={4}>{t("来源定位")}</Text>
        <Stack gap={5}>{receiptCandidates.map((item) => <Paper key={item.candidateId} withBorder p="xs" radius="sm">
          <Text size="xs" fw={600}>{t(sourceKindLabels[item.sourceKind])} · {item.title} · {t(candidateReadStateLabels[item.readState])}</Text>
          <Text size="xs" c="dimmed">{item.locator}</Text>
          {item.sourceKind === 'web' ? <Text size="xs" c={item.pageVerified ? 'teal' : 'yellow'}>{item.pageVerified ? t("已全文核验") : t("检索摘要 · 未全文核验")}</Text> : null}
          <Text size="xs" c="dimmed" lineClamp={1}>{item.retrievalMethod}{item.reason ? ` · ${item.reason}` : ''}</Text>
        </Paper>)}</Stack>
      </Paper> : null}
      {unverifiedWebCandidates.length ? <Alert color="yellow" variant="light">
        <Text size="xs">{t("有")} {unverifiedWebCandidates.length} {t("条网页候选未完成全文核验；它们不会进入事实证据或直接写回。")}</Text>
      </Alert> : null}
      {receiptConflicts.length ? <Alert color="yellow" variant="light">
        <Text size="xs" fw={600} mb={3}>{t("可能存在来源表述差异")}</Text>
        <Stack gap={2}>{receiptConflicts.map((item) => <Text key={item.conflictId} size="xs">{item.summary}</Text>)}</Stack>
      </Alert> : null}
      {isComplete ? <Paper withBorder p="sm" radius="md">
        <Group justify="space-between" mb={4}><Text size="xs" fw={600}>{t("扩写建议")}{qualityReceipt?.generation === 'partial' ? t("（待人工核对）") : ''}</Text>{session.result?.text ? <Group gap={2}><Button size="compact-xs" variant="subtle" leftSection={<Copy size={13} />} onClick={() => void copyPlainText(session.result!.text)}>{t("复制")}</Button>{canApplyResult ? <Button size="compact-xs" leftSection={<Check size={13} />} onClick={onApply}>{t("替换选区")}</Button> : null}</Group> : null}</Group>
        {session.result?.text ? <MarkdownContent className="assistant-markdown-content" content={session.result.text} disableApplicationLinks showCodeCopyActions /> : <Text size="sm">{t("没有找到可用于扩写的已深读本地证据。")}</Text>}
      </Paper> : null}
        </Stack>
      </ScrollArea>
      <Group className="selection-expansion-workspace-actions" justify="space-between">
        <Button variant="default" leftSection={<Settings2 size={15} />} disabled={isRunning} onClick={() => void onSaveDefaults(settings)}>{t("保存为默认")}</Button>
        {isRunning
          ? <Button color="red" variant="light" leftSection={<Square size={15} />} onClick={() => { setActionError(null); void onCancel().catch((error) => setActionError(error instanceof Error ? error.message : t("取消扩写任务失败。"))); }}>{t("停止")}</Button>
          : <Button leftSection={isComplete ? <Sparkles size={15} /> : <Play size={15} />} onClick={() => { setActionError(null); void onStart().catch((error) => setActionError(error instanceof Error ? error.message : t("扩写优化未能启动。"))); }}>{isComplete ? t("按此设置重新生成") : t("开始扩写")}</Button>}
      </Group>
    </Stack>
  );
}
