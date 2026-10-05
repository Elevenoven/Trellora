import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.package-staging', 'verify-library-adjacent-section');
const libraryDir = path.join(stagingDir, 'library');
const graphBundle = path.join(stagingDir, 'libraryPlanAgentGraph.cjs');
const noteIndexBundle = path.join(stagingDir, 'noteIndex.cjs');
const actionBundle = path.join(stagingDir, 'libraryStructuredActionDriver.cjs');
const ledgerBundle = path.join(stagingDir, 'libraryEvidenceLedger.cjs');
const contractBundle = path.join(stagingDir, 'structuredOutputContract.cjs');

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(libraryDir, { recursive: true });
const longPlanningBody = Array.from(
  { length: 120 },
  (_, index) => `Planning 长章节第 ${String(index + 1).padStart(3, '0')} 行：保存足够长的确定性原文，用于验证主进程读取额度、分页边界和 nextCursor。`,
).join('\n');
fs.writeFileSync(path.join(libraryDir, 'adjacent-sections.md'), [
  '# Agent',
  '',
  'Agent 父章节正文。',
  '',
  '## Memory',
  '',
  'Memory 保存已核验事实。',
  '',
  '## Tools',
  '',
  'Tools 负责受控执行。',
  '',
  '### Shell',
  '',
  'Shell 是 Tools 下唯一的三级章节。',
  '',
  '## Planning',
  '',
  longPlanningBody,
  '',
  '## Security',
  '',
  'Security 限制跨会话和跨快照访问。',
].join('\n'), 'utf8');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryPlanAgentGraph.ts')], outfile: graphBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')], outfile: noteIndexBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryStructuredActionDriver.ts')], outfile: actionBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryEvidenceLedger.ts')], outfile: ledgerBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'structuredOutputContract.ts')], outfile: contractBundle, bundle: true, platform: 'node', format: 'cjs' }),
]);

const {
  createLibraryNoteSnapshotMap,
  createLibraryNoteTools,
  runLibraryPlanAgent,
} = await import(pathToFileURL(graphBundle).href);
const { buildNoteIndex } = await import(pathToFileURL(noteIndexBundle).href);
const {
  LIBRARY_DECIDE_JSON_SCHEMA,
  LIBRARY_SYNTHESIZE_JSON_SCHEMA,
  libraryToolNames,
  parseLibraryAgentAction,
} = await import(pathToFileURL(actionBundle).href);
const { LibraryEvidenceLedger } = await import(pathToFileURL(ledgerBundle).href);
const {
  assertSupportedStructuredOutputSchema,
  validateStructuredOutputValue,
} = await import(pathToFileURL(contractBundle).href);

const index = buildNoteIndex(libraryDir);
assert.equal(index.notes.length, 1);
const goalId = 'goal-adjacent-section';
const createSnapshotMap = (sessionId) => createLibraryNoteSnapshotMap({
  libraryPath: libraryDir,
  index,
  sessionId,
  revision: 1,
  indexState: 'latest',
});
const firstSnapshotMap = createSnapshotMap('session-adjacent-direct');
const firstRecord = [...firstSnapshotMap.records.values()][0];
assert.ok(firstRecord);
const headingByText = (record, text) => {
  const heading = record.localSnapshot.headings.find((candidate) => candidate.text === text);
  assert.ok(heading, `missing heading ${text}`);
  return heading;
};
const agentHeading = headingByText(firstRecord, 'Agent');
const memoryHeading = headingByText(firstRecord, 'Memory');
const toolsHeading = headingByText(firstRecord, 'Tools');
const shellHeading = headingByText(firstRecord, 'Shell');
const planningHeading = headingByText(firstRecord, 'Planning');
const securityHeading = headingByText(firstRecord, 'Security');

const directTools = createLibraryNoteTools(firstSnapshotMap, firstSnapshotMap.sessionId);
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, toolsHeading.headingId, 'previous')?.headingId, memoryHeading.headingId);
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, toolsHeading.headingId, 'next')?.headingId, planningHeading.headingId);
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, shellHeading.headingId, 'previous'), undefined, 'H3 must not jump to an H2 cousin');
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, shellHeading.headingId, 'next'), undefined, 'a lone H3 has no same-parent sibling');
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, memoryHeading.headingId, 'previous'), undefined);
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, securityHeading.headingId, 'next'), undefined);
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, agentHeading.headingId, 'previous'), undefined);
assert.throws(() => directTools.findAdjacentSection(firstRecord.noteId, 'missing-heading', 'next'), /章节锚点/u);
assert.throws(() => directTools.findAdjacentSection(firstRecord.noteId, toolsHeading.headingId, 'sideways'), /方向/u);
assert.throws(() => createLibraryNoteTools(firstSnapshotMap, 'wrong-session').findAdjacentSection(firstRecord.noteId, toolsHeading.headingId, 'next'), /会话/u);

const decideSchema = JSON.parse(LIBRARY_DECIDE_JSON_SCHEMA);
const synthesizeSchema = JSON.parse(LIBRARY_SYNTHESIZE_JSON_SCHEMA);
const schemaToolNames = decideSchema.properties.tool.anyOf[0].enum;
assert.doesNotThrow(() => assertSupportedStructuredOutputSchema(decideSchema));
assert.doesNotThrow(() => assertSupportedStructuredOutputSchema(synthesizeSchema));
assert.deepEqual(schemaToolNames, [...libraryToolNames], 'Schema and parser allowlists must be identical');
assert.equal(schemaToolNames.includes('read_library_adjacent_section'), true);
const adjacentArgumentSchema = decideSchema.properties.arguments.anyOf[0].anyOf.find((candidate) => candidate.required?.includes('direction'));
assert.deepEqual(adjacentArgumentSchema.required, ['evidenceId', 'direction']);
assert.deepEqual(adjacentArgumentSchema.properties.direction.enum, ['previous', 'next']);
assert.equal(synthesizeSchema.properties.type.const, 'answer');
const strictAdjacentAction = {
  type: 'tool',
  goalId,
  tool: 'read_library_adjacent_section',
  arguments: { evidenceId: 'evidence-000000000000000000000000', direction: 'previous' },
  publicRationale: '读取前一同级章节',
  answer: null,
  citations: null,
  completeness: null,
  planPatch: null,
};
assert.deepEqual(validateStructuredOutputValue(decideSchema, strictAdjacentAction), []);
assert.equal(validateStructuredOutputValue(decideSchema, {
  ...strictAdjacentAction,
  arguments: { ...strictAdjacentAction.arguments, noteId: firstRecord.noteId },
}).length > 0, true, 'strict schema must reject model-supplied noteId');
assert.deepEqual(parseLibraryAgentAction(strictAdjacentAction).arguments, strictAdjacentAction.arguments);
const strictAnswerAction = { type: 'answer', answer: '没有相邻章节。', citations: [], completeness: 'not-found', planPatch: null };
assert.deepEqual(validateStructuredOutputValue(synthesizeSchema, strictAnswerAction), []);
assert.equal(parseLibraryAgentAction(strictAnswerAction).completeness, 'not-found');
const nullableCursorAction = parseLibraryAgentAction({
  ...strictAdjacentAction,
  tool: 'read_library_note_section',
  arguments: { noteId: firstRecord.noteId, headingId: toolsHeading.headingId, cursor: null },
});
assert.deepEqual(nullableCursorAction.arguments, { noteId: firstRecord.noteId, headingId: toolsHeading.headingId });
const sanitizedAdjacentAction = parseLibraryAgentAction({
  type: 'tool',
  goalId,
  tool: 'read_library_adjacent_section',
  arguments: {
    evidenceId: 'evidence-000000000000000000000000',
    direction: 'previous',
    noteId: firstRecord.noteId,
    headingId: toolsHeading.headingId,
    lineFrom: 1,
    path: 'forged/path.md',
  },
  publicRationale: '读取前一同级章节',
});
assert.deepEqual(sanitizedAdjacentAction.arguments, {
  evidenceId: 'evidence-000000000000000000000000',
  direction: 'previous',
});

const toolsSection = directTools.readNoteSection(firstRecord.noteId, { headingId: toolsHeading.headingId });
const createEvidenceInput = (anchorHeadingId) => ({
  noteId: firstRecord.noteId,
  headingPath: toolsSection.headingPath,
  anchorHeadingId,
  lineFrom: toolsSection.lineFrom,
  lineTo: toolsSection.lineTo,
  text: toolsSection.text,
  matchedTerms: [],
  supports: [],
  sourceToolCallId: 'direct-ledger-test',
});
const identityLedgerA = new LibraryEvidenceLedger(firstSnapshotMap, firstSnapshotMap.sessionId, 72_000);
const identityLedgerB = new LibraryEvidenceLedger(firstSnapshotMap, firstSnapshotMap.sessionId, 72_000);
const toolsIdentity = identityLedgerA.add(createEvidenceInput(toolsHeading.headingId)).record.evidenceId;
const memoryIdentity = identityLedgerB.add(createEvidenceInput(memoryHeading.headingId)).record.evidenceId;
assert.equal(toolsIdentity, memoryIdentity, 'anchorHeadingId must not change evidence identity');

const mergeLedger = new LibraryEvidenceLedger(firstSnapshotMap, firstSnapshotMap.sessionId, 72_000);
const anchoredTools = mergeLedger.add(createEvidenceInput(toolsHeading.headingId)).record;
const expandedRange = directTools.readNoteRange(firstRecord.noteId, {
  lineFrom: Math.max(1, anchoredTools.lineFrom - 1),
  lineTo: anchoredTools.lineTo,
});
const expandedTools = mergeLedger.add({
  noteId: firstRecord.noteId,
  headingPath: anchoredTools.headingPath,
  anchorHeadingId: anchoredTools.anchorHeadingId,
  lineFrom: expandedRange.lineFrom,
  lineTo: expandedRange.lineTo,
  text: expandedRange.text,
  matchedTerms: [],
  supports: [],
  sourceToolCallId: 'direct-expand-test',
}).record;
assert.equal(expandedTools.anchorHeadingId, toolsHeading.headingId, 'expanded evidence must inherit the original anchor');
assert.equal(directTools.findAdjacentSection(firstRecord.noteId, expandedTools.anchorHeadingId, 'previous')?.headingId, memoryHeading.headingId);

const createPlan = () => ({
  planId: 'plan-adjacent-section',
  version: 1,
  originalQuestion: '读取证据的相邻章节',
  goals: [{
    goalId,
    question: '核实相邻章节原文',
    evidenceKind: 'fact',
    requirements: [{ requirementId: 'req-adjacent', label: '相邻章节原文', minEvidence: 1 }],
    queryTerms: [{ term: 'Agent', source: 'planner' }, { term: 'Tools', source: 'planner' }, { term: 'Planning', source: 'planner' }],
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
});
const tool = (name, argumentsValue) => ({
  type: 'tool',
  goalId,
  tool: name,
  arguments: argumentsValue,
  publicRationale: `验证 ${name}`,
});
const extractProjectedEvidenceIds = (prompt) => [
  ...new Set([...prompt.matchAll(/^evidence-[a-f0-9]{24}/gmu)].map((match) => match[0])),
];

async function runAdjacentScenario({ sourceHeadingText, direction, expandBeforeAdjacent = false, mutateSnapshot = false }) {
  const sessionId = `session-${sourceHeadingText}-${direction}-${expandBeforeAdjacent}-${mutateSnapshot}`;
  const snapshotMap = createSnapshotMap(sessionId);
  const record = [...snapshotMap.records.values()][0];
  const sourceHeading = headingByText(record, sourceHeadingText);
  const toolEvents = [];
  const receivedSchemas = [];
  const prompts = [];
  let step = 0;
  let sourceEvidenceId;
  let postAdjacentPrompt = '';
  const adjacentStep = expandBeforeAdjacent ? 3 : 2;
  const result = await runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: '读取证据的相邻章节',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    contextWindowTokens: 16_384,
    signal: new AbortController().signal,
    planner: { plan: async () => createPlan() },
    driver: {
      async decide(input) {
        prompts.push(input.prompt);
        receivedSchemas.push(input.jsonSchema);
        if (step === 0) {
          step += 1;
          return tool('search_note_library', { limit: 8 });
        }
        if (step === 1) {
          step += 1;
          return tool('read_library_note_section', { noteId: record.noteId, headingId: sourceHeading.headingId });
        }
        const evidenceIds = extractProjectedEvidenceIds(input.prompt);
        if (!sourceEvidenceId) sourceEvidenceId = evidenceIds[0];
        assert.ok(sourceEvidenceId, 'source read must create evidence before adjacent navigation');
        if (expandBeforeAdjacent && step === 2) {
          step += 1;
          return tool('expand_library_evidence', { evidenceId: sourceEvidenceId, beforeLines: 1, afterLines: 0 });
        }
        if (step === adjacentStep) {
          sourceEvidenceId = evidenceIds[0] ?? sourceEvidenceId;
          if (mutateSnapshot) record.contentHash = `stale-${record.contentHash}`;
          step += 1;
          return tool('read_library_adjacent_section', { evidenceId: sourceEvidenceId, direction });
        }
        postAdjacentPrompt = input.prompt;
        step += 1;
        return {
          type: 'answer',
          answer: '相邻章节验证结束。',
          citations: evidenceIds,
          completeness: evidenceIds.length ? 'partial' : 'not-found',
        };
      },
      async synthesize() {
        throw new Error('adjacent scenarios should answer atomically');
      },
    },
    searchMode: 'keyword',
    search: {
      keywordSearch: () => [{ path: index.notes[0].path, title: index.notes[0].title, score: 1, snippet: 'adjacent fixture', terms: ['Agent'] }],
      semanticSearch: async () => [],
    },
    isSnapshotCurrent: () => true,
    sectionRankShadowMode: 'off',
    sectionRankNavigationMode: 'off',
    onToolEvent: (event) => toolEvents.push(event),
  });
  return { postAdjacentPrompt, prompts, receivedSchemas, result, sourceEvidenceId, toolEvents };
}

const previous = await runAdjacentScenario({ sourceHeadingText: 'Tools', direction: 'previous', expandBeforeAdjacent: true });
assert.equal(previous.result.evidence.length, 2);
assert.equal(previous.result.evidence.some((evidence) => evidence.headingPath.at(-1) === 'Memory'), true);
assert.match(previous.postAdjacentPrompt, new RegExp(`direction=previous headingId=${memoryHeading.headingId}`, 'u'));
assert.equal(previous.toolEvents.some((event) => event.tool === 'read_library_adjacent_section' && event.state === 'completed'), true);
assert.equal(previous.receivedSchemas.every((schema) => schema?.name === 'library_decide'), true);
assert.deepEqual(previous.receivedSchemas[0]?.schema.properties.tool.anyOf[0].enum, [...libraryToolNames]);

const next = await runAdjacentScenario({ sourceHeadingText: 'Tools', direction: 'next' });
assert.equal(next.result.evidence.length, 2);
const planningEvidence = next.result.evidence.find((evidence) => evidence.headingPath.at(-1) === 'Planning');
assert.ok(planningEvidence);
assert.equal(planningEvidence.lineTo < planningHeading.lineTo, true, 'long adjacent section must be paged by the existing read limits');
assert.match(next.postAdjacentPrompt, /nextCursor=\d+/u);

const shellPrevious = await runAdjacentScenario({ sourceHeadingText: 'Shell', direction: 'previous' });
assert.equal(shellPrevious.result.evidence.length, 1);
assert.match(shellPrevious.postAdjacentPrompt, /相邻同级章节 not-found/u);
assert.equal(shellPrevious.toolEvents.some((event) => event.tool === 'read_library_adjacent_section' && event.state === 'completed'), true);

const boundary = await runAdjacentScenario({ sourceHeadingText: 'Memory', direction: 'previous' });
const boundarySnapshot = createSnapshotMap('session-boundary-length');
const boundaryRecord = [...boundarySnapshot.records.values()][0];
const boundaryTools = createLibraryNoteTools(boundarySnapshot, boundarySnapshot.sessionId);
const boundaryMemory = headingByText(boundaryRecord, 'Memory');
const boundarySourceLength = boundaryTools.readNoteSection(boundaryRecord.noteId, { headingId: boundaryMemory.headingId }).text.length;
assert.equal(boundary.result.evidence.length, 1);
assert.equal(boundary.result.toolStats.readCharacters, boundarySourceLength, 'not-found must add zero evidence characters');
assert.match(boundary.postAdjacentPrompt, /direction=previous/u);

const stale = await runAdjacentScenario({ sourceHeadingText: 'Tools', direction: 'next', mutateSnapshot: true });
assert.equal(stale.toolEvents.some((event) => event.tool === 'read_library_adjacent_section' && event.state === 'rejected'), true);
assert.equal(stale.result.evidence.length, 0, 'stale evidence must fail final SHA-256/snapshot verification');

async function runForgedEvidenceScenario(evidenceId, sessionId) {
  const snapshotMap = createSnapshotMap(sessionId);
  const record = [...snapshotMap.records.values()][0];
  const toolEvents = [];
  let step = 0;
  return runLibraryPlanAgent({
    snapshotMap,
    sessionId,
    question: '伪造相邻证据',
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-model',
    signal: new AbortController().signal,
    planner: { plan: async () => createPlan() },
    driver: {
      async decide() {
        if (step === 0) {
          step += 1;
          return tool('search_note_library', { limit: 8 });
        }
        if (step === 1) {
          step += 1;
          return tool('read_library_adjacent_section', { evidenceId, direction: 'next' });
        }
        return { type: 'answer', answer: '伪造证据已拒绝。', citations: [], completeness: 'not-found' };
      },
      async synthesize() { throw new Error('forged scenario should answer atomically'); },
    },
    searchMode: 'keyword',
    search: {
      keywordSearch: () => [{ path: index.notes[0].path, title: index.notes[0].title, score: 1, terms: ['Agent'] }],
      semanticSearch: async () => [],
    },
    isSnapshotCurrent: () => true,
    onToolEvent: (event) => toolEvents.push(event),
  }).then((result) => ({ result, toolEvents, record }));
}

const forged = await runForgedEvidenceScenario('evidence-000000000000000000000000', 'session-forged-evidence');
assert.equal(forged.result.evidence.length, 0);
assert.equal(forged.toolEvents.some((event) => event.tool === 'read_library_adjacent_section' && event.state === 'rejected'), true);
const crossSession = await runForgedEvidenceScenario(previous.sourceEvidenceId, 'session-cross-session-evidence');
assert.equal(crossSession.result.evidence.length, 0);
assert.equal(crossSession.toolEvents.some((event) => event.tool === 'read_library_adjacent_section' && event.state === 'rejected'), true);
await assert.rejects(
  runLibraryPlanAgent({ snapshotMap: firstSnapshotMap, sessionId: 'wrong-session' }),
  /会话/u,
);

console.log(JSON.stringify({
  verifier: 'library-adjacent-section-v1',
  schema: { toolCount: schemaToolNames.length, adjacentRegistered: schemaToolNames.includes('read_library_adjacent_section') },
  topology: {
    toolsPrevious: memoryHeading.headingId,
    toolsNext: planningHeading.headingId,
    shellPrevious: 'not-found',
    shellNext: 'not-found',
  },
  ledger: {
    anchorExcludedFromIdentity: toolsIdentity === memoryIdentity,
    expandAnchorPreserved: expandedTools.anchorHeadingId === toolsHeading.headingId,
  },
  executor: {
    previousEvidenceCount: previous.result.evidence.length,
    nextEvidenceCount: next.result.evidence.length,
    longSectionNextCursor: /nextCursor=\d+/u.test(next.postAdjacentPrompt),
    boundaryNotFoundCharacters: boundary.result.toolStats.readCharacters,
  },
  rejected: { forged: true, crossSession: true, stale: true, invalidDirection: true },
}, null, 2));
console.log('Library adjacent-section verification passed');
