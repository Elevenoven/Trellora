import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-search-pagination');
const toolsFile = path.join(outDir, 'tools.cjs');
const indexFile = path.join(outDir, 'index.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const graphFile = path.join(outDir, 'graph.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const coverageFile = path.join(outDir, 'coverage.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteTools.ts')], outfile: toolsFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')], outfile: indexFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSearchCoverage.ts')], outfile: coverageFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { createCurrentNoteTools, searchCurrentNotePage } = await import(pathToFileURL(toolsFile).href);
const { CurrentNoteLexicalIndex } = await import(pathToFileURL(indexFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { CurrentNoteSearchCoverageLedger } = await import(pathToFileURL(coverageFile).href);

const sections = Array.from({ length: 47 }, (_, index) => index + 1);
const markdownLines = ['# 分页夹具'];
for (const section of sections) {
  markdownLines.push(`## 第 ${section} 节`, `NER 分页证据 ${section}：这一处属于不可跳过的候选。`, `补充事实 ${section}。`);
}
const markdown = markdownLines.join('\n');
const lineOf = (value) => markdownLines.indexOf(value) + 1;
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/search-pagination.md',
  title: '分页夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings: [
    { id: 'root', level: 1, text: '分页夹具', line: 1 },
    ...sections.map((section) => ({ id: `section-${section}`, level: 2, text: `第 ${section} 节`, line: lineOf(`## 第 ${section} 节`) })),
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const scope = { mode: 'topic-wide', targetTopic: 'NER', targetAspects: [] };
const tools = createCurrentNoteTools(snapshot);

// The old array protocol stays capped at 20 and remains an array of hits.
const legacyHits = tools.searchNote(['NER'], 20, scope);
assert.equal(Array.isArray(legacyHits), true);
assert.equal(legacyHits.length, 20);
assert.equal('nextCursor' in legacyHits, false);

// A page walk is complete, deterministic, and has no duplicate or skipped hit.
const reference = new CurrentNoteLexicalIndex(snapshot).searchPage('NER', 200, 0, scope).hits;
const collected = [];
const seen = new Set();
let cursor;
let pageCount = 0;
let finalPage;
while (true) {
  const page = tools.searchNotePage(['NER'], 7, cursor, scope);
  pageCount += 1;
  assert.ok(page.hits.length <= 7);
  for (const hit of page.hits) {
    assert.equal(seen.has(hit.blockId), false, `duplicate hit ${hit.blockId}`);
    seen.add(hit.blockId);
    collected.push(hit);
  }
  if (page.nextCursor) {
    assert.match(page.nextCursor, /^search-cursor-[A-Za-z0-9_-]+$/u);
    assert.doesNotMatch(page.nextCursor, /NER|snapshot-/u, 'cursor must remain opaque');
    assert.equal(page.candidateExhausted, false);
    cursor = page.nextCursor;
    continue;
  }
  finalPage = page;
  break;
}
assert.ok(pageCount > 1);
assert.equal(finalPage.candidateExhausted, true);
assert.equal(finalPage.nextCursor, undefined);
assert.deepEqual(collected.map((hit) => hit.blockId), reference.map((hit) => hit.blockId));

// occurrence-complete remains partial until the final page and all page hits
// have corresponding reads accepted by the main-process Coverage Ledger.
const occurrenceScope = { mode: 'topic-wide', coveragePolicy: 'occurrence-complete', targetTopic: 'NER', targetAspects: [] };
const occurrenceLedger = new CurrentNoteSearchCoverageLedger(snapshot, occurrenceScope);
let occurrenceCursor;
let occurrenceReadCount = 0;
let occurrencePageCount = 0;
while (true) {
  const page = tools.searchNotePage(['NER'], 7, occurrenceCursor, occurrenceScope);
  occurrencePageCount += 1;
  occurrenceLedger.recordSearch('goal-occurrence', page.hits, 7, { candidateExhausted: page.candidateExhausted });
  for (const hit of page.hits) {
    occurrenceReadCount += 1;
    occurrenceLedger.recordRead('goal-occurrence', {
      snapshotId: snapshot.snapshotId,
      evidenceId: `evidence-${String(occurrenceReadCount).padStart(24, '0')}`,
      blockIds: [hit.blockId],
      headingPath: hit.headingPath,
      lineFrom: hit.lineFrom,
      lineTo: hit.lineTo,
      text: hit.snippet,
      ...(hit.headingId ? { headingId: hit.headingId } : {}),
    });
  }
  if (!page.nextCursor) {
    assert.equal(page.candidateExhausted, true);
    break;
  }
  assert.equal(occurrenceLedger.toModelSummary('goal-occurrence').status, 'partial');
  occurrenceCursor = page.nextCursor;
}
assert.ok(occurrencePageCount > 1);
const occurrenceSummary = occurrenceLedger.toModelSummary('goal-occurrence');
assert.equal(occurrenceSummary.status, 'complete', JSON.stringify(occurrenceSummary));

// A guessed cursor is rejected before it can navigate any candidate.
assert.throws(() => tools.searchNotePage(['NER'], 7, 'search-cursor-guessed', scope), /cursor/iu);

// A real cursor is bound to the normalized query, scope mode, and snapshot.
const firstPage = searchCurrentNotePage(new CurrentNoteLexicalIndex(snapshot), ['NER'], 7, undefined, scope);
assert.ok(firstPage.nextCursor);
assert.throws(() => searchCurrentNotePage(new CurrentNoteLexicalIndex(snapshot), ['RAG'], 7, firstPage.nextCursor, scope), /不匹配|cursor/iu);
assert.throws(() => searchCurrentNotePage(new CurrentNoteLexicalIndex(snapshot), ['NER'], 7, firstPage.nextCursor, { mode: 'focused' }), /不匹配|cursor/iu);
const changedMarkdown = `${markdown}\nNER 新快照证据。`;
const changedSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/search-pagination.md',
  title: '分页夹具',
  contentHash: createHash('sha256').update(changedMarkdown, 'utf8').digest('hex'),
  markdown: changedMarkdown,
  headings: [
    { id: 'root', level: 1, text: '分页夹具', line: 1 },
    ...sections.map((section) => ({ id: `section-${section}`, level: 2, text: `第 ${section} 节`, line: lineOf(`## 第 ${section} 节`) })),
  ],
  revision: 2,
  createdAt: '2026-08-22T00:00:00.000Z',
});
assert.notEqual(changedSnapshot.snapshotId, snapshot.snapshotId);
assert.throws(() => searchCurrentNotePage(new CurrentNoteLexicalIndex(changedSnapshot), ['NER'], 7, firstPage.nextCursor, scope), /不匹配|cursor/iu);

// The Plan runner uses the paging API; a second page is requested only with
// the exact cursor issued by the first page. Shared tool budget remains 6.
const planner = createCurrentNotePlanDriver({
  async generateJson() {
    return {
      goals: [{
        goalId: 'goal-pagination',
        question: '逐处列出 NER 候选。',
        evidenceKind: 'fact',
        requirements: [{ requirementId: 'req-pagination', label: 'NER 候选', minEvidence: 1 }],
        queryTerms: ['NER'],
      }],
      scope: { mode: 'topic-wide', coveragePolicy: 'occurrence-complete', targetTopic: 'NER', targetAspects: [] },
    };
  },
});
let decisionCalls = 0;
const planEvents = [];
const planDriver = {
  async decide({ prompt }) {
    decisionCalls += 1;
    const goalId = prompt.match(/activeGoalId=([A-Za-z][A-Za-z0-9:_-]{0,127})/u)?.[1] ?? 'goal-pagination';
    if (decisionCalls === 1) return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['NER'], limit: 7 }, publicRationale: '分页首屏' };
    if (decisionCalls === 2) {
      const cursorMatch = prompt.match(/goal-pagination=(search-cursor-[A-Za-z0-9_-]+)/u);
      assert.ok(cursorMatch, 'the Plan prompt must expose the main-process-issued nextCursor');
      return { type: 'tool', goalId, tool: 'search_note', arguments: { terms: ['NER'], limit: 7, cursor: cursorMatch[1] }, publicRationale: '分页续页' };
    }
    return { type: 'answer', answer: '预算内返回部分候选。', citations: [], completeness: 'partial' };
  },
  async synthesize() {
    return { type: 'answer', answer: '预算内返回部分候选。', citations: [], completeness: 'partial' };
  },
};
const planResult = await runCurrentNoteAgent({
  snapshot,
  question: '逐处列出 NER 候选。',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: planDriver,
  planner,
  planMode: 'current-note',
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'phase4-pagination',
  isSnapshotCurrent: () => true,
  onToolEvent: (event) => planEvents.push(event),
});
assert.equal(planEvents.filter((event) => event.tool === 'search_note' && event.state === 'completed').length, 2);
assert.equal(planResult.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls, true);
assert.equal(planResult.completeness, 'partial');

console.log('Current-note search pagination verification passed');
