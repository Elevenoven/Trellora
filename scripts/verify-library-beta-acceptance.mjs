import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixturePath = path.join(rootDir, 'scripts', 'fixtures', 'library-section-bm25', 'acceptance-v1.json');
const stagingDir = path.join(rootDir, '.package-staging', 'verify-library-beta-acceptance');
const libraryDir = path.join(stagingDir, 'library');
const rankerBundle = path.join(stagingDir, 'librarySectionRanker.cjs');
const snapshotBundle = path.join(stagingDir, 'currentNoteSnapshot.cjs');
const graphBundle = path.join(stagingDir, 'libraryPlanAgentGraph.cjs');
const noteIndexBundle = path.join(stagingDir, 'noteIndex.cjs');
const modeBundle = path.join(stagingDir, 'assistantMode.cjs');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(libraryDir, { recursive: true });
const fixtureBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
assert.equal(fixture.fixtureVersion, 1);
assert.equal(fixture.notes.length, 10, '固定验收集必须覆盖 10 篇笔记');
assert.equal(fixture.notes.filter((note) => note.repeatedHeading).length, 5, '固定验收集必须覆盖 5 篇重复标题笔记');
assert.equal(fixture.questions.length, 30, '固定验收集必须包含 30 个明确相关问题');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'librarySectionRanker.ts')], outfile: rankerBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryPlanAgentGraph.ts')], outfile: graphBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')], outfile: noteIndexBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMode.ts')], outfile: modeBundle, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { LibrarySectionRanker } = await import(pathToFileURL(rankerBundle).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotBundle).href);
const { createLibraryNoteSnapshotMap, runLibraryPlanAgent } = await import(pathToFileURL(graphBundle).href);
const { buildNoteIndex } = await import(pathToFileURL(noteIndexBundle).href);
const { normalizeAssistantModeConfig, shouldUseLibraryPlanner } = await import(pathToFileURL(modeBundle).href);

const snapshots = new Map();
for (const note of fixture.notes) {
  const markdown = renderNote(note);
  const notePath = path.join(libraryDir, `${note.noteKey}.md`);
  fs.writeFileSync(notePath, markdown, 'utf8');
  snapshots.set(note.noteKey, createCurrentNoteSnapshot({
    libraryPath: libraryDir,
    notePath,
    title: note.title,
    contentHash: sha256(markdown),
    markdown,
    headings: collectHeadings(note, markdown),
    revision: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
  }));
}

let hitCount = 0;
let returnedCandidateCount = 0;
let unrelatedCandidateCount = 0;
let repeatedHeadingHitCount = 0;
let repeatedHeadingQuestionCount = 0;
const rankers = new Map();
for (const [questionId, noteKey, expectedTopic, queryTerms] of fixture.questions) {
  const note = fixture.notes.find((candidate) => candidate.noteKey === noteKey);
  const snapshot = snapshots.get(noteKey);
  assert.ok(note && snapshot, `${questionId} 引用了不存在的 fixture note`);
  const ranker = rankers.get(noteKey) ?? new LibrarySectionRanker({ noteId: `note-${noteKey}`, snapshot });
  rankers.set(noteKey, ranker);
  const expectedHeadingId = headingId(noteKey, expectedTopic);
  const result = ranker.rankRelatedSections(toQueryTerms(queryTerms));
  const topIds = result.topSections.map((section) => section.headingId);
  if (topIds.includes(expectedHeadingId)) hitCount += 1;
  returnedCandidateCount += topIds.length;
  unrelatedCandidateCount += topIds.filter((candidateId) => candidateId !== expectedHeadingId).length;
  if (note.repeatedHeading) {
    repeatedHeadingQuestionCount += 1;
    if (topIds.includes(expectedHeadingId)) repeatedHeadingHitCount += 1;
  }
}

for (const [questionId, noteKey, queryTerms] of fixture.ambiguousQuestions) {
  const ranker = rankers.get(noteKey);
  assert.ok(ranker, `${questionId} 引用了不存在的重复标题笔记`);
  const result = ranker.rankRelatedSections(toQueryTerms(queryTerms));
  assert.equal(result.ambiguous, true, `${questionId} 必须明确标记 ambiguous`);
  assert.deepEqual(result.topSections, [], `${questionId} 不得按行号补齐 Top 3`);
}

const hitAt3 = hitCount / fixture.questions.length;
const unrelatedCandidateRate = returnedCandidateCount === 0 ? 0 : unrelatedCandidateCount / returnedCandidateCount;
const repeatedHeadingMisleadRate = 1 - repeatedHeadingHitCount / repeatedHeadingQuestionCount;
assert.ok(hitAt3 >= 0.9, `Hit@3 未达到 90%：${formatRate(hitAt3)}`);
assert.ok(unrelatedCandidateRate <= 0.05, `无关候选率超过 5%：${formatRate(unrelatedCandidateRate)}`);
assert.ok(repeatedHeadingMisleadRate <= 0.05, `高频同名标题误导率超过 5%：${formatRate(repeatedHeadingMisleadRate)}`);

assert.equal(normalizeAssistantModeConfig(undefined).assistantPlanMode, 'current-note', '阶段 5 不得改变默认 assistantPlanMode');
assert.equal(shouldUseLibraryPlanner('library-beta'), true);
assert.equal(shouldUseLibraryPlanner('current-note'), false);

const index = buildNoteIndex(libraryDir);
const observeRun = await runDeterministicLibraryBeta('observe', index);
const offRun = await runDeterministicLibraryBeta('off', index);
assert.equal(observeRun.result.agentStats.modelCalls, offRun.result.agentStats.modelCalls, '导航排序不得新增模型调用');
assert.equal(observeRun.result.toolStats.calls, offRun.result.toolStats.calls, '导航排序不得新增工具调用');
assert.ok(observeRun.result.toolStats.calls <= 10);
assert.ok(observeRun.result.toolStats.readCharacters <= 72_000);
const firstObservedRead = observeRun.toolEvents.find((event) => event.state === 'completed' && event.sectionNavigation?.candidates.length);
assert.ok(firstObservedRead, 'library-beta 运行必须产生推荐章节公开观察');
assert.equal(firstObservedRead.sectionNavigation.candidates.some((candidate) => candidate.headingPath.length > 0 && candidate.matchedTerms.includes('Section Ranking')), true);
assert.equal(firstObservedRead.contentPreviews?.every((preview) => preview.kind === 'evidence'), true, '推荐章节不得混入已读原文预览');
assert.equal(observeRun.result.evidence.length, 2, '推荐章节显式读取后才应新增第二条 Ledger evidence');
assert.equal(observeRun.traceEntries.some((entry) => entry.action === 'library-section-navigation-observation'), true);

console.log(JSON.stringify({
  verifier: 'library-beta-acceptance-v1',
  fixture: {
    version: fixture.fixtureVersion,
    sha256: sha256(fixtureBytes),
    notes: fixture.notes.length,
    repeatedHeadingNotes: fixture.notes.filter((note) => note.repeatedHeading).length,
    relevantQuestions: fixture.questions.length,
    ambiguousQuestions: fixture.ambiguousQuestions.length,
  },
  quality: {
    hitAt3: formatRate(hitAt3),
    unrelatedCandidateRate: formatRate(unrelatedCandidateRate),
    repeatedHeadingMisleadRate: formatRate(repeatedHeadingMisleadRate),
  },
  libraryBetaRuntime: {
    toolCalls: observeRun.result.toolStats.calls,
    modelCalls: observeRun.result.agentStats.modelCalls,
    evidenceCount: observeRun.result.evidence.length,
    navigationCandidateCount: firstObservedRead.sectionNavigation.candidates.length,
    candidateAndEvidenceSeparated: true,
    defaultAssistantPlanMode: normalizeAssistantModeConfig(undefined).assistantPlanMode,
  },
}, null, 2));
console.log('Library beta acceptance verification passed');

async function runDeterministicLibraryBeta(navigationMode, noteIndex) {
  const sessionId = `session-library-beta-${navigationMode}`;
  const snapshotMap = createLibraryNoteSnapshotMap({ libraryPath: libraryDir, index: noteIndex, sessionId, revision: 1, indexState: 'latest' });
  const retrievalRecord = [...snapshotMap.records.values()].find((record) => path.basename(record.localSnapshot.notePath) === 'retrieval.md');
  assert.ok(retrievalRecord);
  const sourceHeading = findHeadingByBody(retrievalRecord.localSnapshot, 'Candidate Recall');
  const targetHeading = findHeadingByBody(retrievalRecord.localSnapshot, 'Section Ranking');
  const toolEvents = [];
  const traceEntries = [];
  let step = 0;
  const result = await runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: 'Agent 中的 Section Ranking 如何工作？',
    conversation: [],
    providerKind: 'ollama',
    model: 'deterministic-library-beta-fixture',
    contextWindowTokens: 16_384,
    signal: new AbortController().signal,
    planner: { plan: async () => createPlan() },
    driver: {
      async decide(input) {
        if (step === 0) {
          step += 1;
          return tool('search_note_library', { limit: 8 });
        }
        if (step === 1) {
          step += 1;
          return tool('read_library_note_section', { noteId: retrievalRecord.noteId, headingId: sourceHeading.headingId });
        }
        if (step === 2) {
          if (navigationMode === 'observe') assert.match(input.prompt, new RegExp(`headingId=${escapeRegExp(targetHeading.headingId)}`, 'u'));
          step += 1;
          return tool('read_library_note_section', { noteId: retrievalRecord.noteId, headingId: targetHeading.headingId });
        }
        step += 1;
        return {
          type: 'answer',
          answer: '章节排序使用正文 BM25，并在显式读取后形成证据。',
          citations: extractEvidenceIds(input.prompt),
          completeness: 'partial',
        };
      },
      async synthesize() { throw new Error('deterministic library-beta fixture should answer directly'); },
    },
    searchMode: 'keyword',
    search: {
      keywordSearch: () => [{ path: retrievalRecord.localSnapshot.notePath, title: retrievalRecord.title, score: 1, snippet: 'Section Ranking', terms: ['Agent', 'Section Ranking'] }],
      semanticSearch: async () => [],
    },
    isSnapshotCurrent: () => true,
    sectionRankShadowMode: 'observe',
    sectionRankNavigationMode: navigationMode,
    onToolEvent: (event) => toolEvents.push(event),
    onDetailedTrace: (entry) => traceEntries.push(entry),
  });
  return { result, toolEvents, traceEntries };
}

function createPlan() {
  const goalId = 'goal-section-ranking';
  return {
    planId: 'plan-library-beta-acceptance',
    version: 1,
    originalQuestion: 'Agent 中的 Section Ranking 如何工作？',
    goals: [{
      goalId,
      question: '核实 Section Ranking',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'req-section-ranking', label: '章节排序原文', minEvidence: 1 }],
      queryTerms: [{ term: 'Agent', source: 'planner' }, { term: 'Section Ranking', source: 'planner' }],
      status: 'pending',
      evidenceBindings: [],
      conflictBindings: [],
    }],
    activeGoalId: goalId,
    status: 'active',
    revisionCount: 0,
    goalUpdateCount: 0,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function tool(name, argumentsValue) {
  return { type: 'tool', goalId: 'goal-section-ranking', tool: name, arguments: argumentsValue, publicRationale: `验证 ${name}` };
}

function renderNote(note) {
  return note.sections.flatMap(([_, label, body]) => [`# ${note.repeatedHeading ? 'Agent' : label}`, '', body, '']).join('\n').trimEnd() + '\n';
}

function collectHeadings(note, markdown) {
  let sectionIndex = 0;
  return markdown.split(/\r\n|\r|\n/u).flatMap((line, index) => {
    if (!/^#\s+/u.test(line)) return [];
    const [topic, label] = note.sections[sectionIndex];
    sectionIndex += 1;
    return [{ id: headingId(note.noteKey, topic), level: 1, text: note.repeatedHeading ? 'Agent' : label, line: index + 1, index: sectionIndex - 1 }];
  });
}

function findHeadingByBody(snapshot, marker) {
  const lines = snapshot.markdown.split(/\r\n|\r|\n/u);
  const heading = snapshot.headings.find((candidate) => lines.slice(candidate.lineFrom - 1, candidate.lineTo).join('\n').includes(marker));
  assert.ok(heading, `找不到包含 ${marker} 的章节`);
  return heading;
}

function extractEvidenceIds(prompt) {
  return [...new Set([...prompt.matchAll(/^evidence-[a-f0-9]{24}/gmu)].map((match) => match[0]))];
}

function toQueryTerms(terms) {
  return terms.map((term) => ({ term, source: 'planner' }));
}

function headingId(noteKey, topic) {
  return `${noteKey}-${topic}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function formatRate(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
