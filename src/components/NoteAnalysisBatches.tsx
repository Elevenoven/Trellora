import { getAppLanguage, t, useI18n } from '../i18n';
import { useState } from 'react';
import { Badge, Button, Collapse, Group, Text, UnstyledButton } from '@mantine/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { NoteAnalysis, NoteAnalysisBatchResult, NoteAnalysisRunDetail } from '../electron';

const stateLabels: Record<NoteAnalysisRunDetail['state'], string> = { queued: '等待分析', running: '正在分析', partial: '部分完成', completed: '已完成', failed: '分析失败', cancelled: '已取消', stale: '内容已更新' };
const batchLabels: Record<NoteAnalysisBatchResult['status'], string> = { pending: '等待分析', running: '正在分析', 'retrying-length': '长度重试', succeeded: '已完成', failed: '失败', cancelled: '已取消' };

/** 批次列表完全来自主进程产物，折叠仅影响展示，不裁切保存的摘要。 */
export default function NoteAnalysisBatches({ analysis, run, onCancel, onResume }: { analysis: NoteAnalysis | null; run?: NoteAnalysisRunDetail | null; onCancel?: () => Promise<void>; onResume?: () => Promise<void> }) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const [operation, setOperation] = useState<'cancel' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const batches = run?.batches ?? analysis?.batches ?? [];
  if (!batches.length) return null;
  const completed = run?.completedBatches ?? analysis?.completedBatches ?? batches.length;
  const total = run?.totalBatches ?? analysis?.totalBatches ?? batches.length;
  const fullDocument = (run?.processingMode ?? analysis?.processingMode) === 'full-document';
  const preparation = run?.preparationStats ?? analysis?.preparationStats;
  const requests = batches.reduce((count, batch) => count + batch.generationAttempts, 0);
  const running = run?.state === 'running' || run?.state === 'queued';
  const canResume = run && !running && run.state !== 'completed' && run.state !== 'stale' && !run.isStale;
  const perform = async (kind: 'cancel' | 'resume') => {
    setOperation(kind);
    setError(null);
    try {
      await (kind === 'cancel' ? onCancel?.() : onResume?.());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setOperation(null);
    }
  };
  return <div className="note-analysis-batches">
    {run ? <Group className="note-analysis-progress" gap={6} justify="space-between">
      <Text size="xs" c="dimmed" role="status">{fullDocument ? t("全文分析") : t("分批分析")} · {run.isStale ? t("内容已更新") : t(stateLabels[run.state])} · {completed}/{total}{fullDocument ? '' : t(" 批")}</Text>
      {running && onCancel ? <Button variant="subtle" color="gray" size="compact-xs" loading={operation === 'cancel'} onClick={() => void perform('cancel')}>{t("取消")}</Button> : null}
      {canResume && onResume ? <Button variant="light" size="compact-xs" loading={operation === 'resume'} onClick={() => void perform('resume')}>{t("恢复分析")}</Button> : null}
    </Group> : null}
    {run && run.state !== 'completed' && analysis ? <Text size="xs" c="dimmed">{t("新版分析尚未完成，上方保留上一次完成的概览。")}</Text> : null}
    {run?.error ? <Text size="xs" c="red" role="alert">{run.error.message}</Text> : null}
    {error ? <Text size="xs" c="red" role="alert">{error}</Text> : null}
    <UnstyledButton className="note-overview-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span>{fullDocument ? t("全文来源与摘要") : t("批次总结")} · {completed}/{total} {t("· 模型请求")} {requests} {t("次")}</span>
      <span>{expanded ? t("收起") : t("展开")}{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
    </UnstyledButton>
    <Collapse in={expanded}>
      {preparation ? <Text size="xs" c="dimmed">{t("有效正文")} {preparation.originalBodyCharacters.toLocaleString(getAppLanguage())} {t("→ 清洗后")} {preparation.cleanedBodyCharacters.toLocaleString(getAppLanguage())} {t("字")}{preparation.duplicateBlocks ? t(" · 合并 {0} 个重复块", { '0': preparation.duplicateBlocks }) : ''}{preparation.removedBlocks ? t(" · 移除 {0} 个无效块", { '0': preparation.removedBlocks }) : ''}</Text> : null}
      <div className="note-analysis-batch-list">{[...batches].sort((left, right) => left.batchIndex - right.batchIndex).map((batch) => <article className="note-analysis-batch" key={batch.batchId}>
        <Group justify="space-between" gap={5} wrap="nowrap"><Text size="xs" fw={600}>{fullDocument ? t("全文分析") : t("第 {0} 批", { '0': batch.batchIndex + 1 })}</Text><Badge size="xs" color={batch.status === 'failed' ? 'red' : 'gray'} variant="light">{t(batchLabels[batch.status])}</Badge></Group>
        <Text size="xs" className="note-analysis-batch-source">{batch.sourceLabel}</Text>
        <Text size="xs" c="dimmed">{t("清洗后输入")} {batch.inputCharacterCount.toLocaleString(getAppLanguage())} {t("字 · 请求")} {batch.generationAttempts} {t("次")}</Text>
        {batch.sections?.length ? <details className="note-analysis-batch-summary"><summary>{t("查看合并来源 ·")} {batch.sections.length} {t("个章节／正文区间")}</summary>{batch.sections.map((section, index) => <div key={index}>
          <Text size="xs" fw={500}>{section.headingPath.join(' / ') || t("章前／无标题正文")}</Text>
          <Text size="xs" c="dimmed">{t("原文行：")}{section.coreSpans.map(span => `${span.lineFrom}–${span.lineTo}${span.partCount ? t("（第{0}/{1}部分）", { '0': span.partIndex, '1': span.partCount }) : ''}`).join('、')}</Text>
          {section.duplicateSpans.length ? <Text size="xs" c="dimmed">{t("相同内容已合并，重复来源行：")}{section.duplicateSpans.map(span => `${span.lineFrom}–${span.lineTo}`).join('、')}</Text> : null}
        </div>)}</details> : <Text size="xs" c="dimmed">{t("核心行：")}{batch.coreSpans.map(span => `${span.lineFrom}–${span.lineTo}`).join('、')}</Text>}
        {batch.overlapCharacterCount ? <Text size="xs" c="dimmed">{t("承接上批末尾")} {batch.overlapCharacterCount} {t("字")}</Text> : null}
        {batch.summary ? <>
          {batch.summaryCharacterCount && batch.summaryCharacterCount > 400 ? <details className="note-analysis-batch-summary"><summary>{t("查看完整摘要 ·")} {batch.summaryCharacterCount} {t("字")}</summary><Text size="xs" className="note-analysis-summary-text">{batch.summary}</Text></details> : <Text size="xs" className="note-analysis-summary-text">{batch.summary}</Text>}
          {batch.keyPoints.length ? <details className="note-analysis-batch-summary"><summary>{batch.keyPoints.length} {t("个关键要点")}</summary><ul className="note-key-points">{batch.keyPoints.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul></details> : null}
          {batch.lengthHandling === 'truncated' ? <Text size="xs" c="dimmed">{t("长度重试后仍超长，已按首尾截取为 750 字。")}</Text> : null}
          {batch.lengthHandling === 'structured-over-limit-accepted' ? <Text size="xs" c="dimmed">{t("章节摘要按长度重试结果保留 ·")} {batch.summaryCharacterCount} {t("字。")}</Text> : null}
          {batch.lengthHandling === 'retry-within-limit' ? <Text size="xs" c="dimmed">{t("长度重试后完成 ·")} {batch.summaryCharacterCount} {t("字。")}</Text> : null}
        </> : null}
        {batch.error ? <Text size="xs" c="red">{batch.error.message}</Text> : null}
      </article>)}</div>
    </Collapse>
  </div>;
}
