import { LibraryEvidenceLedger } from '../libraryEvidenceLedger';
import { getLibraryNoteRecord } from '../libraryNoteSnapshot';
import { createLibraryNoteTools, searchLibraryNoteCandidates } from '../libraryNoteTools';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import type { SelectionEditResearchToolContext } from '../selectionEditAgentRuntime';

const MAX_QUERY_CHARS = 160;
const MAX_QUERY_TERMS = 6;
const MAX_NOTE_CANDIDATES = 4;
const MAX_BLOCK_CANDIDATES = 4;
const MAX_MAP_HEADINGS = 48;
const MAX_READ_CHARS = 2_200;
const MAX_READ_LINES = 48;

/**
 * RA-3 same-library tool admission. Candidate IDs are session-bound opaque
 * IDs; only a range read verified by LibraryEvidenceLedger reaches the Agent
 * evidence session.
 */
export function createSelectionEditLibraryNoteTools(
  initialContext: SelectionEditResearchToolContext,
): ReActTool<SelectionEditResearchToolContext>[] {
  const runtime = initialContext.noteLibraryRuntime;
  if (!runtime) return [];
  const tools = createLibraryNoteTools(runtime.snapshotMap, runtime.sessionId);
  const ledger = new LibraryEvidenceLedger(
    runtime.snapshotMap,
    runtime.sessionId,
    Math.max(1, initialContext.session.remainingEvidenceCharacters),
  );

  return [
    {
      name: 'search_note_library',
      description: '在本轮已授权的同库笔记快照中定位候选笔记。标题和摘要仅用于导航；必须继续搜索块并读取具体行范围，才能形成证据。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: MAX_QUERY_CHARS, description: '与编辑目标相关的关键词组合' },
          limit: { type: 'number', description: `可选，1 到 ${MAX_NOTE_CANDIDATES}` },
        },
        required: ['query'],
      },
      execute: async (args, context) => {
        assertLibraryCurrent(context);
        const query = readQuery(args.query);
        const limit = readLimit(args.limit, MAX_NOTE_CANDIDATES);
        context.session.plan('note-library', '先定位同库笔记候选，再定位块并深读具体行范围。');
        context.onStatus?.(`正在定位同库笔记中与「${truncate(query, 28)}」相关的候选…`);
        const searched = await searchLibraryNoteCandidates({
          snapshotMap: runtime.snapshotMap,
          sessionId: runtime.sessionId,
          query,
          limit,
          callbacks: { keywordSearch: runtime.keywordSearch },
        });
        const lines = [`<selection_library_note_candidates session_id="${escape(runtime.sessionId)}">`];
        let count = 0;
        for (const candidate of searched.results) {
          const record = getLibraryNoteRecord(runtime.snapshotMap, candidate.noteId, runtime.sessionId);
          if (record.localSnapshot.notePath === runtime.currentNotePath) continue;
          context.session.recordLibraryNoteCandidate({
            noteId: candidate.noteId,
            snapshotId: record.snapshotId,
            contentHash: record.contentHash,
            title: record.title,
            relativePath: record.localSnapshot.relativePath,
            queryTerms: queryTerms(query),
            goalIds: goalIdsForQuery(context, query),
            score: candidate.score,
          });
          count += 1;
          lines.push(`  <candidate note_id="${escape(candidate.noteId)}" title="${escape(candidate.title)}" score="${candidate.score.toFixed(3)}">${escape(truncate(candidate.snippet ?? '', 360))}</candidate>`);
        }
        lines.push('</selection_library_note_candidates>');
        lines.push(`<selection_research_note>${count > 0 ? '候选笔记和摘要仅用于导航；请先 get_library_note_map 或 search_library_note_blocks，再用 read_library_note_range 深读具体行范围。' : '未找到同库笔记候选；请更换合法查询。'}</selection_research_note>`);
        return { ok: true, observation: lines.join('\n'), message: `同库笔记定位 ${count} 个候选。`, referenceCount: 0 };
      },
    },
    {
      name: 'get_library_note_map',
      description: '读取本轮 search_note_library 已返回候选笔记的章节地图，仅用于导航，不返回正文或形成证据。',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '此前候选中的 note_id' },
          detail: { type: 'string', description: '可选：outline、stats 或 terms；默认 outline' },
        },
        required: ['note_id'],
      },
      execute: async (args, context) => {
        assertLibraryCurrent(context);
        const noteId = readId(args.note_id, 'note_id');
        const candidate = context.session.libraryNoteCandidate(noteId);
        if (!candidate || !matchesLibraryCandidate(runtime, candidate)) return staleCandidateError(context, `note-library:${noteId}`);
        const detail = readMapDetail(args.detail);
        context.onStatus?.(`正在读取同库笔记「${candidate.title}」的章节地图…`);
        const map = tools.getNoteMap(noteId, detail);
        const headings = map.headings.slice(0, MAX_MAP_HEADINGS)
          .map((heading) => `<heading id="${escape(heading.headingId)}" level="${heading.level}" from="${heading.lineFrom}" to="${heading.lineTo}">${escape(heading.path.join(' / '))}</heading>`)
          .join('');
        return {
          ok: true,
          observation: `<selection_library_note_map note_id="${escape(noteId)}" snapshot_id="${escape(candidate.snapshotId)}" line_count="${map.lineCount}" detail="${detail}">${headings}</selection_library_note_map>\n<selection_research_note>地图只用于导航；新增事实仍需通过 search_library_note_blocks 后的具体行范围深读。</selection_research_note>`,
          message: `已读取同库笔记「${candidate.title}」章节地图。`,
          referenceCount: 0,
        };
      },
    },
    {
      name: 'search_library_note_blocks',
      description: '在本轮候选同库笔记内定位候选原文块。块摘要仅用于导航；必须再调用 read_library_note_range 深读对应行范围。',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '此前 search_note_library 返回的 note_id' },
          terms: { type: 'array', items: { type: 'string' }, description: `1 到 ${MAX_QUERY_TERMS} 个查询词` },
          limit: { type: 'number', description: `可选，1 到 ${MAX_BLOCK_CANDIDATES}` },
        },
        required: ['note_id', 'terms'],
      },
      execute: async (args, context) => {
        assertLibraryCurrent(context);
        const noteId = readId(args.note_id, 'note_id');
        const noteCandidate = context.session.libraryNoteCandidate(noteId);
        if (!noteCandidate || !matchesLibraryCandidate(runtime, noteCandidate)) return staleCandidateError(context, `note-library:${noteId}`);
        const terms = readTerms(args.terms);
        const limit = readLimit(args.limit, MAX_BLOCK_CANDIDATES);
        context.onStatus?.(`正在定位同库笔记「${noteCandidate.title}」中的候选原文块…`);
        const hits = tools.searchNoteBlocks(noteId, terms, limit);
        const lines = [`<selection_library_block_candidates note_id="${escape(noteId)}" snapshot_id="${escape(noteCandidate.snapshotId)}">`];
        let count = 0;
        for (const hit of hits) {
          context.session.recordLibraryBlockCandidate({
            noteId,
            snapshotId: noteCandidate.snapshotId,
            contentHash: noteCandidate.contentHash,
            blockId: hit.blockId,
            title: noteCandidate.title,
            headingPath: hit.headingPath,
            lineFrom: hit.lineFrom,
            lineTo: hit.lineTo,
            queryTerms: terms,
            goalIds: goalIdsForQuery(context, terms.join(' ')),
            score: hit.score,
          });
          count += 1;
          lines.push(`  <candidate block_id="${escape(hit.blockId)}" from="${hit.lineFrom}" to="${hit.lineTo}" score="${hit.score.toFixed(3)}">${escape(truncate(hit.snippet, 360))}</candidate>`);
        }
        lines.push('</selection_library_block_candidates>');
        lines.push(`<selection_research_note>${count > 0 ? '候选块不能支撑新增事实；请通过 read_library_note_range 深读其中一个具体行范围。' : '候选笔记内没有匹配块；可回到 search_note_library 调整查询。'}</selection_research_note>`);
        return { ok: true, observation: lines.join('\n'), message: `同库笔记「${noteCandidate.title}」定位 ${count} 个候选块。`, referenceCount: 0 };
      },
    },
    {
      name: 'read_library_note_range',
      description: '深读本轮 search_library_note_blocks 已返回的同库候选行范围。必须匹配候选块、快照和会话；成功后才可成为证据。',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '此前候选中的 note_id' },
          line_from: { type: 'number', description: '此前候选中的起始行号' },
          line_to: { type: 'number', description: '此前候选中的结束行号' },
        },
        required: ['note_id', 'line_from', 'line_to'],
      },
      execute: async (args, context) => {
        assertLibraryCurrent(context);
        const noteId = readId(args.note_id, 'note_id');
        const lineFrom = readLine(args.line_from, 'line_from');
        const lineTo = readLine(args.line_to, 'line_to');
        if (lineTo < lineFrom) return toolError('line_to 不能小于 line_from。', '同库笔记深读行范围无效。');
        const noteCandidate = context.session.libraryNoteCandidate(noteId);
        const blockCandidate = context.session.libraryBlockCandidateForRange(noteId, lineFrom, lineTo);
        if (!noteCandidate || !blockCandidate || !matchesLibraryCandidate(runtime, noteCandidate)) {
          return staleCandidateError(context, `note-library:${noteId}`);
        }
        if (context.session.remainingEvidenceCharacters < 1) {
          context.session.markCandidateSkipped(`note-library:${noteId}:${blockCandidate.blockId}`, '本轮原文证据预算已用尽。');
          return toolError('本轮原文证据预算已用尽，请依据已深读内容保守完成。', '同库笔记证据预算已用尽。');
        }
        context.onStatus?.(`正在深读同库笔记「${noteCandidate.title}」第 ${lineFrom}–${lineTo} 行原文…`);
        const raw = tools.readNoteRange(noteId, { lineFrom, lineTo }, {
          maxChars: Math.min(MAX_READ_CHARS, context.session.remainingEvidenceCharacters),
          maxLines: MAX_READ_LINES,
        });
        assertLibraryCurrent(context);
        if (!raw.text.trim() || raw.text.length > context.session.remainingEvidenceCharacters) {
          context.session.markCandidateSkipped(`note-library:${noteId}:${blockCandidate.blockId}`, '候选原文超过本轮受限读取预算。');
          return toolError('该候选原文超过本轮受限读取预算，请换一条候选。', '同库笔记候选超过深读上限。');
        }
        const added = ledger.add({
          noteId,
          headingPath: raw.headingPath,
          anchorHeadingId: tools.findDeepestHeadingIdAtLine(noteId, raw.lineFrom),
          lineFrom: raw.lineFrom,
          lineTo: raw.lineTo,
          text: raw.text,
          matchedTerms: blockCandidate.queryTerms,
          supports: blockCandidate.goalIds,
          sourceToolCallId: `selection-edit:note-library:${noteId}:${blockCandidate.blockId}:read-range`,
        });
        if (ledger.verifyEvidenceIds([added.record.evidenceId]).length !== 1) {
          context.session.markCandidateSkipped(`note-library:${noteId}:${blockCandidate.blockId}`, '深读后快照或原文哈希校验失败。');
          return toolError('同库笔记原文在深读后未通过快照校验，请重新检索。', '同库笔记证据校验失败。');
        }
        const registered = context.session.registerLibraryEvidence({
          noteId,
          snapshotId: noteCandidate.snapshotId,
          contentHash: noteCandidate.contentHash,
          title: noteCandidate.title,
          relativePath: noteCandidate.relativePath,
          headingPath: added.record.headingPath,
          lineFrom: added.record.lineFrom,
          lineTo: added.record.lineTo,
          text: added.record.text,
        });
        if (registered.added) context.onEvidence?.(registered.item);
        return {
          ok: true,
          observation: `<selection_verified_library_note note_id="${escape(noteId)}" snapshot_id="${escape(noteCandidate.snapshotId)}" from="${added.record.lineFrom}" to="${added.record.lineTo}"><content>${escape(added.record.text)}</content></selection_verified_library_note>\n<selection_research_note>这段同库原文已通过会话、快照、行范围和哈希核验，可用于支撑新增事实。</selection_research_note>`,
          message: `已深读同库笔记「${noteCandidate.title}」第 ${added.record.lineFrom}–${added.record.lineTo} 行。`,
          referenceCount: registered.added ? 1 : 0,
        };
      },
    },
  ];
}

function assertLibraryCurrent(context: SelectionEditResearchToolContext): void {
  if (context.signal.aborted) throw new DOMException('已取消 AI 编辑任务。', 'AbortError');
  if (!context.isSnapshotCurrent()) throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  if (context.noteLibraryRuntime?.isSnapshotCurrent && !context.noteLibraryRuntime.isSnapshotCurrent()) {
    throw new Error('同库笔记索引已变化，请重新选择文字后再生成。');
  }
}

function matchesLibraryCandidate(
  runtime: NonNullable<SelectionEditResearchToolContext['noteLibraryRuntime']>,
  candidate: NonNullable<ReturnType<SelectionEditResearchToolContext['session']['libraryNoteCandidate']>>,
): boolean {
  const record = runtime.snapshotMap.records.get(candidate.noteId);
  return Boolean(record && record.snapshotId === candidate.snapshotId && record.contentHash === candidate.contentHash);
}

function staleCandidateError(context: SelectionEditResearchToolContext, candidateId: string): ReActToolExecution {
  context.session.markCandidateSkipped(candidateId, '候选不属于当前会话或笔记快照已变化，需要重新检索。');
  return toolError('目标必须来自本轮稳定候选，且笔记快照未变化。请重新搜索。', '同库候选已失效。');
}

function readQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('query 必须是字符串。');
  const query = value.trim();
  if (query.length < 2 || query.length > MAX_QUERY_CHARS) throw new Error(`query 必须在 2 到 ${MAX_QUERY_CHARS} 个字符之间。`);
  return query;
}

function queryTerms(value: string): string[] {
  return [...new Set(value.split(/[\s,，、]+/u).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 80))].slice(0, MAX_QUERY_TERMS);
}

function readTerms(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUERY_TERMS) {
    throw new Error(`terms 必须包含 1 到 ${MAX_QUERY_TERMS} 个查询词。`);
  }
  const terms = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
  if (terms.length < 1 || terms.some((term) => term.length < 2 || term.length > 80)) throw new Error('每个查询词必须在 2 到 80 个字符之间。');
  return terms;
}

function readMapDetail(value: unknown): 'outline' | 'stats' | 'terms' {
  if (value === undefined) return 'outline';
  if (value === 'outline' || value === 'stats' || value === 'terms') return value;
  throw new Error('detail 必须是 outline、stats 或 terms。');
}

function readLimit(value: unknown, maximum: number): number {
  if (value === undefined) return Math.min(4, maximum);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`limit 必须是 1 到 ${maximum} 的整数。`);
  return value;
}

function readId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error(`${label} 无效。`);
  return value.trim();
}

function readLine(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数。`);
  return value;
}

function goalIdsForQuery(context: SelectionEditResearchToolContext, query: string): string[] {
  const terms = queryTerms(query).map((term) => term.toLocaleLowerCase('zh-CN'));
  const matched = context.goals.filter((goal) => goal.queryTerms.some((term) => terms.includes(term.toLocaleLowerCase('zh-CN'))));
  return (matched.length ? matched : context.goals).map((goal) => goal.goalId);
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
