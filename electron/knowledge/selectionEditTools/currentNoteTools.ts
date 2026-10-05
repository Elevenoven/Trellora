import { CurrentNoteEvidenceLedger } from '../currentNoteEvidenceLedger';
import { getCurrentNoteSnapshotBlock } from '../currentNoteSnapshot';
import { createCurrentNoteTools } from '../currentNoteTools';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import type { SelectionEditResearchToolContext } from '../selectionEditAgentRuntime';
import { createExpansionRangeReader } from '../selectionExpansionRead';

const MAX_QUERY_TERMS = 6;
const MAX_QUERY_TERM_CHARS = 80;
const MAX_SEARCH_HITS = 6;
const MAX_MAP_HEADINGS = 48;
const MAX_READ_CHARS = 2_200;
const MAX_READ_LINES = 48;
const MAX_EVIDENCE_RECORDS = 4;

/**
 * RA-3 current-note tool admission. The factory closes over one immutable
 * snapshot; no filesystem or editor authority reaches the Agent.
 */
export function createSelectionEditCurrentNoteTools(
  initialContext: SelectionEditResearchToolContext,
): ReActTool<SelectionEditResearchToolContext>[] {
  const snapshot = initialContext.currentNoteSnapshot;
  if (!snapshot) return [];
  const tools = createCurrentNoteTools(snapshot);
  const readExpansionRange = createExpansionRangeReader(snapshot);
  const expansionRecords = new Set<string>();
  const ledger = new CurrentNoteEvidenceLedger(snapshot, Math.max(1, initialContext.session.remainingEvidenceCharacters), {
    enforceRawEvidenceChars: true,
    maxSourceEvidenceRecords: initialContext.adaptiveExpansion ? 8 : MAX_EVIDENCE_RECORDS,
  });

  return [
    {
      name: 'get_note_map',
      description: '读取当前笔记的受限章节地图，仅用于导航。它不返回正文，也不产生可支撑新增事实的证据。',
      parameters: {
        type: 'object',
        properties: { detail: { type: 'string', description: '可选：outline、stats 或 terms；默认 outline' } },
      },
      execute: async (args, context) => {
        assertCurrent(context);
        const detail = readMapDetail(args.detail);
        context.session.plan('current-note', '先读取当前笔记地图或搜索候选，再按候选受限深读原文。');
        context.onStatus?.('正在读取当前笔记章节地图…');
        const map = tools.getNoteMap(detail);
        const headings = map.headings.slice(0, MAX_MAP_HEADINGS)
          .map((heading) => `<heading id="${escape(heading.headingId)}" level="${heading.level}" from="${heading.lineFrom}" to="${heading.lineTo}">${escape(heading.path.join(' / '))}</heading>`)
          .join('');
        return {
          ok: true,
          observation: `<selection_current_note_map snapshot_id="${escape(snapshot.snapshotId)}" line_count="${map.lineCount}" detail="${detail}">${headings}</selection_current_note_map>\n<selection_research_note>地图只用于定位。要支撑新增事实，请先 search_note，再 read_note_range 深读候选原文。</selection_research_note>`,
          message: '已读取当前笔记章节地图。',
          referenceCount: 0,
        };
      },
    },
    {
      name: 'search_note',
      description: '在当前笔记不可变快照中按关键词定位候选块。候选摘要只用于导航；必须再调用 read_note_range 深读同一候选范围，才能成为证据。',
      parameters: {
        type: 'object',
        properties: {
          terms: { type: 'array', items: { type: 'string' }, description: `1 到 ${MAX_QUERY_TERMS} 个查询词` },
          limit: { type: 'number', description: `可选，1 到 ${MAX_SEARCH_HITS}` },
          ...(initialContext.adaptiveExpansion ? { cursor: { type: 'string', description: '可选，使用上一页返回的 next_cursor，保持 terms 和 limit 相同。' } } : {}),
        },
        required: ['terms'],
      },
      execute: async (args, context) => {
        assertCurrent(context);
        const terms = readTerms(args.terms);
        const limit = readLimit(args.limit, MAX_SEARCH_HITS);
        context.session.plan('current-note', '先搜索当前笔记候选，再受限深读候选范围。');
        context.onStatus?.(`正在定位当前笔记中与「${truncate(terms.join('、'), 28)}」相关的候选…`);
        const page = tools.searchNotePage(terms, limit, context.adaptiveExpansion && typeof args.cursor === 'string' ? args.cursor : undefined);
        const lines = [`<selection_current_note_candidates snapshot_id="${escape(snapshot.snapshotId)}">`];
        let count = 0;
        for (const hit of page.hits) {
          const block = getCurrentNoteSnapshotBlock(snapshot, hit.blockId);
          if (!block || block.lineFrom !== hit.lineFrom || block.lineTo !== hit.lineTo) continue;
          context.session.recordCurrentNoteCandidate({
            snapshotId: snapshot.snapshotId,
            contentHash: snapshot.contentHash,
            blockId: hit.blockId,
            title: snapshot.title,
            headingPath: hit.headingPath,
            lineFrom: hit.lineFrom,
            lineTo: hit.lineTo,
            queryTerms: terms,
            goalIds: goalIdsForTerms(context, terms),
            score: hit.score,
          });
          count += 1;
          lines.push(`  <candidate block_id="${escape(hit.blockId)}" from="${hit.lineFrom}" to="${hit.lineTo}" score="${hit.score.toFixed(3)}">${escape(truncate(hit.snippet, 360))}</candidate>`);
        }
        lines.push('</selection_current_note_candidates>');
        if (context.adaptiveExpansion && page.nextCursor) lines.push(`<next_cursor>${escape(page.nextCursor)}</next_cursor>`);
        lines.push(`<selection_research_note>${count > 0 ? '候选仅用于定位；请用 read_note_range 读取其中一个候选行范围。编辑选区本身不能作为新增事实证据。' : '没有找到候选；请更换合法查询词。'}</selection_research_note>`);
        return { ok: true, observation: lines.join('\n'), message: `当前笔记定位 ${count} 个候选。`, referenceCount: 0 };
      },
    },
    {
      name: 'read_note_range',
      description: '深读本轮 search_note 已返回的当前笔记候选行范围。范围必须落在候选块内且不能与待编辑选区重叠；成功后才登记为证据。',
      parameters: {
        type: 'object',
        properties: {
          line_from: { type: 'number', description: '此前候选中的起始行号' },
          line_to: { type: 'number', description: '此前候选中的结束行号' },
          ...(initialContext.adaptiveExpansion ? { cursor: { type: 'string', description: '可选：上一页返回的 next_cursor；保持 line_from 与 line_to 为最初候选范围。' } } : {}),
        },
        required: ['line_from', 'line_to'],
      },
      execute: async (args, context) => {
        assertCurrent(context);
        const lineFrom = readLine(args.line_from, 'line_from');
        const lineTo = readLine(args.line_to, 'line_to');
        if (lineTo < lineFrom) return toolError('line_to 不能小于 line_from。', '当前笔记深读行范围无效。');
        const candidate = context.session.currentNoteCandidateForRange(snapshot.snapshotId, lineFrom, lineTo);
        if (!candidate) return toolError('深读范围必须来自本轮 search_note 的候选块。', '当前笔记深读目标不在本轮候选中。');
        if (context.session.remainingEvidenceCharacters < 1) {
          context.session.markCandidateSkipped(`current-note:${candidate.snapshotId}:${candidate.blockId}`, '本轮原文证据预算已用尽。');
          return toolError('本轮原文证据预算已用尽，请依据已深读内容保守完成。', '当前笔记证据预算已用尽。');
        }
        context.onStatus?.(`正在深读当前笔记第 ${lineFrom}–${lineTo} 行原文…`);
        const raw = context.adaptiveExpansion
          ? readExpansionRange(lineFrom, lineTo, args.cursor, Math.min(MAX_READ_CHARS, context.session.remainingEvidenceCharacters))
          : tools.readNoteRange({ lineFrom, lineTo }, {
          maxChars: Math.min(MAX_READ_CHARS, context.session.remainingEvidenceCharacters),
          maxLines: MAX_READ_LINES,
        });
        assertCurrent(context);
        if (overlapsSelection(context, raw.lineFrom, raw.lineTo)) {
          context.session.markCandidateSkipped(`current-note:${candidate.snapshotId}:${candidate.blockId}`, '待编辑选区不能被循环当作外部新增事实证据。');
          return toolError('待编辑选区属于编辑目标，不能作为外部新增事实证据。请读取其他候选范围。', '当前笔记深读范围与选区重叠。');
        }
        if (!raw.text.trim() || raw.text.length > context.session.remainingEvidenceCharacters) {
          context.session.markCandidateSkipped(`current-note:${candidate.snapshotId}:${candidate.blockId}`, '候选原文超过本轮受限读取预算。');
          return toolError('该候选原文超过本轮受限读取预算，请换一条候选。', '当前笔记候选超过深读上限。');
        }
        const recordKey = `${raw.lineFrom}:${raw.lineTo}:${'contentOffset' in raw ? raw.contentOffset : 0}`;
        if (context.adaptiveExpansion && !expansionRecords.has(recordKey) && expansionRecords.size >= 8) return toolError('本轮最多纳入 8 条当前笔记原文。', '当前笔记深读记录已达上限。');
        const added = context.adaptiveExpansion ? { record: raw } : ledger.add({
          blockIds: raw.blockIds,
          headingPath: raw.headingPath,
          lineFrom: raw.lineFrom,
          lineTo: raw.lineTo,
          text: raw.text,
          matchedTerms: [...candidate.queryTerms],
          supports: [...candidate.goalIds],
          sourceToolCallId: `selection-edit:current-note:${candidate.blockId}:read-range`,
          admission: 'explicit-read',
        });
        const registered = context.session.registerCurrentNoteEvidence({
          snapshotId: snapshot.snapshotId,
          contentHash: snapshot.contentHash,
          title: snapshot.title,
          headingPath: added.record.headingPath,
          lineFrom: added.record.lineFrom,
          lineTo: added.record.lineTo,
          text: added.record.text,
          ...('contentOffset' in raw ? { contentOffset: raw.contentOffset as number } : {}),
        });
        if (registered.added && context.adaptiveExpansion) expansionRecords.add(recordKey);
        if (registered.added) context.onEvidence?.(registered.item);
        return {
          ok: true,
          observation: `<selection_verified_current_note snapshot_id="${escape(snapshot.snapshotId)}" from="${added.record.lineFrom}" to="${added.record.lineTo}"><content>${escape(added.record.text)}</content></selection_verified_current_note>${context.adaptiveExpansion && raw.nextCursor ? `\n<next_cursor>${escape(String(raw.nextCursor))}</next_cursor>` : ''}\n<selection_research_note>这段原文已通过快照与行范围核验，可用于支撑新增事实。</selection_research_note>`,
          message: `已深读当前笔记第 ${added.record.lineFrom}–${added.record.lineTo} 行。`,
          referenceCount: registered.added ? 1 : 0,
        };
      },
    },
  ];
}

function assertCurrent(context: SelectionEditResearchToolContext): void {
  if (context.signal.aborted) throw new DOMException('已取消 AI 编辑任务。', 'AbortError');
  if (!context.isSnapshotCurrent()) throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
}

function readMapDetail(value: unknown): 'outline' | 'stats' | 'terms' {
  if (value === undefined) return 'outline';
  if (value === 'outline' || value === 'stats' || value === 'terms') return value;
  throw new Error('get_note_map 的 detail 必须是 outline、stats 或 terms。');
}

function readTerms(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUERY_TERMS) {
    throw new Error(`search_note 的 terms 必须包含 1 到 ${MAX_QUERY_TERMS} 个查询词。`);
  }
  const terms = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
  if (terms.length < 1 || terms.some((term) => term.length < 2 || term.length > MAX_QUERY_TERM_CHARS)) {
    throw new Error(`每个查询词必须在 2 到 ${MAX_QUERY_TERM_CHARS} 个字符之间。`);
  }
  return terms;
}

function readLimit(value: unknown, maximum: number): number {
  if (value === undefined) return Math.min(4, maximum);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`limit 必须是 1 到 ${maximum} 的整数。`);
  return value;
}

function readLine(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数。`);
  return value;
}

function goalIdsForTerms(context: SelectionEditResearchToolContext, terms: readonly string[]): string[] {
  const normalized = terms.map((term) => term.toLocaleLowerCase('zh-CN'));
  const matched = context.goals.filter((goal) => goal.queryTerms.some((term) => normalized.includes(term.toLocaleLowerCase('zh-CN'))));
  return (matched.length ? matched : context.goals).map((goal) => goal.goalId);
}

function overlapsSelection(context: SelectionEditResearchToolContext, lineFrom: number, lineTo: number): boolean {
  return lineFrom <= context.selectionLineTo && lineTo >= context.selectionLineFrom;
}

function toolError(observation: string, message: string): ReActToolExecution {
  return { ok: false, observation: `<selection_tool_error>${escape(observation)}</selection_tool_error>`, message };
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function escape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
