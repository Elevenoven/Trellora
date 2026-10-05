import type { NoteAnalysisBatchPlan, NoteAnalysisLengthHandling, NoteAnalysisPayload, NoteAnalysisTagCandidate } from './noteAnalysisTypes';

export const NOTE_ANALYSIS_POLICY_VERSION = 'note-analysis-full-packed-clean-v2';
export const NOTE_ANALYSIS_PROMPT_VERSION = 'note-analysis-sections-clean-v2';
export const NOTE_ANALYSIS_MAX_INPUT = 12_000;
export const NOTE_ANALYSIS_OVERLAP = 750;
export const NOTE_ANALYSIS_FULL_INPUT_TOKENS = 16_000;

/** 按统一换行后的 Unicode 字符计数；源码坐标仍保留原始 UTF-16 offset。 */
export function countNoteAnalysisCharacters(text: string): number {
  return Array.from(text.replace(/\r\n|\r/gu, '\n')).length;
}

export function normalizeNoteAnalysisSummary(text: string): string {
  return text.replace(/\r\n|\r/gu, '\n').trim();
}

/** 仅用于无标题摘要的第二次超长结果，连接换行也计入750字预算。 */
export function truncateNoteAnalysisSummary(text: string): string {
  const characters = Array.from(normalizeNoteAnalysisSummary(text));
  if (characters.length <= 750) return characters.join('');
  return `${characters.slice(0, 224).join('')}\n${characters.slice(-525).join('')}`;
}

export function finishNoteAnalysisLength(summary: string, mode: NoteAnalysisBatchPlan['mode'], retried: boolean): { summary: string; lengthHandling: NoteAnalysisLengthHandling } {
  const normalized = normalizeNoteAnalysisSummary(summary);
  if (countNoteAnalysisCharacters(normalized) <= 1_000) {
    return { summary: normalized, lengthHandling: retried ? 'retry-within-limit' : 'within-limit' };
  }
  if (!retried) throw new Error('超长摘要必须先执行一次4000字长度重试。');
  return mode === 'structured'
    ? { summary: normalized, lengthHandling: 'structured-over-limit-accepted' }
    : { summary: truncateNoteAnalysisSummary(normalized), lengthHandling: 'truncated' };
}

/** 保留未经截断的摘要，确保长度重试观察到真实模型输出。 */
export function parseNoteAnalysisBatchPayload(value: unknown, currentTags: readonly string[]): NoteAnalysisPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型没有返回有效的分析JSON。');
  const input = value as Record<string, unknown>;
  if (typeof input.summary !== 'string' || !input.summary.trim() || !Array.isArray(input.keyPoints) || !Array.isArray(input.tagCandidates)) {
    throw new Error('模型返回的摘要、关键要点或标签格式无效。');
  }
  const existing = new Set(currentTags.map((tag) => tag.toLocaleLowerCase('zh-Hans-CN')));
  const candidates = new Map<string, NoteAnalysisTagCandidate>();
  for (const entry of input.tagCandidates) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.replace(/^#/, '').replace(/\s+/gu, ' ').trim().slice(0, 48) : '';
    const evidence = typeof candidate.evidence === 'string' ? candidate.evidence.replace(/\s+/gu, ' ').trim().slice(0, 160) : '';
    const key = name.toLocaleLowerCase('zh-Hans-CN');
    if (!name || !evidence || existing.has(key) || candidates.has(key)) continue;
    candidates.set(key, { name, evidence, confidence: candidate.confidence === 'high' || candidate.confidence === 'low' ? candidate.confidence : 'medium' });
    if (candidates.size === 5) break;
  }
  return {
    summary: normalizeNoteAnalysisSummary(input.summary),
    keyPoints: input.keyPoints.filter((point): point is string => typeof point === 'string').map((point) => point.trim().slice(0, 220)).filter(Boolean).slice(0, 8),
    tagCandidates: [...candidates.values()],
  };
}
