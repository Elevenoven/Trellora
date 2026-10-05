import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'current-note-all-evidence');
const manifestPath = path.join(fixtureDir, 'manifest.json');
const scenarioPath = path.join(fixtureDir, 'scenario.json');
const notePath = path.join(fixtureDir, 'notes', 'all-evidence-baseline.md');
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-all-evidence-baseline');
const graphFile = path.join(outDir, 'current-note-agent-graph.cjs');
const snapshotFile = path.join(outDir, 'current-note-snapshot.cjs');
const planDriverFile = path.join(outDir, 'search-plan-driver.cjs');
const memoryFile = path.join(outDir, 'note-conversation-memory.cjs');
const capsuleFile = path.join(outDir, 'current-note-capsule.cjs');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')], outfile: planDriverFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteCapsule.ts')], outfile: capsuleFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { createNoteCapsule } = await import(pathToFileURL(capsuleFile).href);

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
const noteMarkdown = await fs.readFile(notePath, 'utf8');

assert.deepEqual(Object.keys(manifest).sort(), ['encoding', 'fixtureVersion', 'noteFile', 'scenarioFile'].sort());
assert.equal(manifest.fixtureVersion, 1);
assert.equal(manifest.encoding, 'utf-8');
assert.equal(manifest.noteFile, 'notes/all-evidence-baseline.md');
assert.equal(manifest.scenarioFile, 'scenario.json');
assert.equal(scenario.fixtureVersion, 1);
assert.ok(scenario.plannerOutput?.goals?.length === 2);
for (const marker of scenario.promptInjectionMarkers) assert.ok(noteMarkdown.includes(marker), `fixture missing prompt injection marker: ${marker}`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const headings = noteMarkdown.split(/\r?\n/u).flatMap((line, index) => {
  const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
  return match ? [{ id: `heading-${index + 1}`, level: match[1].length, text: match[2], line: index + 1 }] : [];
});
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: 'Current-note all-evidence baseline',
  contentHash: sha256(noteMarkdown),
  markdown: noteMarkdown,
  headings,
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
});
const evidenceBlocks = snapshot.blocks.filter((block) => block.text.includes('EvidenceAnchor'));
assert.equal(evidenceBlocks.length, 20, 'fixture must expose exactly 20 evidence blocks');

const planner = createCurrentNotePlanDriver({
  async generateJson() {
    plannerCalled = true;
    return scenario.plannerOutput;
  },
});

const toolEvents = [];
let decisionRound = 0;
let synthesisPrompt = '';
let plannerCalled = false;
const driver = {
  async decide() {
    decisionRound += 1;
    if (decisionRound === 1) {
      return {
        type: 'tool',
        tool: 'search_note',
        arguments: { terms: ['fixture-driver-term'], limit: 20 },
        publicRationale: '记录全量搜索命中基线。',
      };
    }
    const block = evidenceBlocks[scenario.readBlockIndexes[decisionRound - 2]];
    assert.ok(block, `missing fixture block for read round ${decisionRound}`);
    return {
      type: 'tool',
      tool: 'read_note_range',
      arguments: { lineFrom: block.lineFrom, lineTo: block.lineTo },
      publicRationale: '记录少量显式原文读取基线。',
    };
  },
  async synthesize({ prompt }) {
    synthesisPrompt = prompt;
    const evidenceIds = [...new Set(prompt.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
    return {
      type: 'answer',
      answer: '阶段 0 基线 stub 已记录搜索和显式读取边界。',
      citations: evidenceIds,
      completeness: 'partial',
    };
  },
};
try {
  await planner.plan({
    capsule: createNoteCapsule(snapshot),
    question: scenario.question,
    conversation: [],
    signal: new AbortController().signal,
  });
} catch (error) {
  throw new Error(`planner fixture contract failed: ${error instanceof Error ? error.message : String(error)}`);
}

const budget = {
  ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET,
  maxDecisionRounds: 4,
};
const result = await runCurrentNoteAgent({
  snapshot,
  question: scenario.question,
  conversation: [],
  providerKind: 'ollama',
  model: 'fixture-current-note-all-evidence',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver,
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'current-note-all-evidence:stage-0',
  isSnapshotCurrent: () => true,
  planMode: 'current-note',
  planner,
  budget,
  onToolEvent: (event) => toolEvents.push(event),
});

const plannerTerms = result.searchPlan?.goals.flatMap((goal) => goal.queryTerms.map((term) => term.term)) ?? [];
const requestedPlannerTerms = scenario.plannerOutput.goals.flatMap((goal) => goal.queryTerms);
const expectedAcceptedPlannerTerms = requestedPlannerTerms.map((term) => term.normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').trim().replace(/\s+/gu, ' '));
const executedSearchEvent = toolEvents.find((event) => event.tool === 'search_note' && event.state === 'started');
assert.ok(executedSearchEvent?.inputSummary, `search event missing: ${JSON.stringify(toolEvents)}`);
const executedTermsText = /^关键词：(.+?)；最多/gu.exec(executedSearchEvent.inputSummary)?.[1] ?? '';
const executedQueryTerms = executedTermsText.split('、').filter(Boolean);
const retrievedUniqueBlockCount = result.coverage?.matchedBlockCount ?? 0;
const explicitReadCount = toolEvents.filter((event) => event.tool === 'read_note_range' && event.state === 'completed').length;
const ledgerEvidenceCount = result.evidence.length;
const evidenceSections = [...synthesisPrompt.matchAll(/\[evidence\]\n/gu)];
assert.ok(evidenceSections.length >= 2, 'final synthesize prompt must expose an evidence directory and evidence body');
const synthesisBody = synthesisPrompt.slice(evidenceSections.at(-1).index + evidenceSections.at(-1)[0].length);
const synthesisRepresentedEvidenceIds = [...new Set(synthesisBody.match(/evidence-[a-f0-9]{24}/gu) ?? [])];
const synthesisRawEvidenceCount = ledgerEvidenceCount;
const synthesisRepresentedEvidenceCount = synthesisRepresentedEvidenceIds.length;

assert.deepEqual(plannerTerms, expectedAcceptedPlannerTerms, `accepted planner terms must be stable; plannerCalled=${plannerCalled}`);
assert.ok(requestedPlannerTerms.includes('EvidenceAnchor') && requestedPlannerTerms.includes('evidenceAnchor'));
assert.notDeepEqual(plannerTerms, requestedPlannerTerms, 'stage 0 must record the current case-normalization gap');
assert.deepEqual(executedQueryTerms, [...new Set(expectedAcceptedPlannerTerms)], 'executed search must deduplicate the current accepted planner terms');
assert.equal(retrievedUniqueBlockCount, 20, 'baseline search must find all 20 fixture blocks');
assert.equal(explicitReadCount, 2, 'baseline must read only two blocks explicitly');
assert.equal(ledgerEvidenceCount, 2, 'only explicitly read blocks may enter the current-note ledger');
assert.equal(result.contextMode, 'react-search');
assert.equal(result.completeness, 'partial');
assert.equal(synthesisRepresentedEvidenceCount < retrievedUniqueBlockCount, true, 'current synthesis representation must remain below retrieved coverage');
assert.equal(synthesisRepresentedEvidenceCount, synthesisRawEvidenceCount, '阶段 4 统一投影必须完整表示当前 Evidence Ledger');

const evidenceBudget = scenario.evidenceBudgetScenarios.map((entry) => ({
  ...entry,
  relationToCurrentRawEvidenceLimit: entry.rawEvidenceChars > DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars
    ? 'over'
    : entry.rawEvidenceChars / DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars > 0.95
      ? 'near'
      : 'below',
}));
assert.deepEqual(evidenceBudget.map((entry) => entry.relationToCurrentRawEvidenceLimit), ['below', 'near', 'over']);
assert.equal(evidenceBudget[1].rawEvidenceChars / DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars > 0.95, true);

const report = {
  schemaVersion: 'current-note-all-evidence-baseline-v1',
  purpose: 'Stage 0 fixture regression with the Stage 4 current-note context projection enabled.',
  fixture: {
    manifestSha256: sha256(await fs.readFile(manifestPath)),
    scenarioSha256: sha256(await fs.readFile(scenarioPath)),
    noteSha256: sha256(noteMarkdown),
    evidenceBlockCount: evidenceBlocks.length,
    promptInjectionFixture: true,
  },
  mode: 'minimal + enforce',
  metrics: {
    plannerQueryTermCount: requestedPlannerTerms.length,
    acceptedPlannerQueryTermCount: plannerTerms.length,
    executedQueryTermCount: executedQueryTerms.length,
    retrievedUniqueBlockCount,
    ledgerEvidenceCount,
    synthesisRawEvidenceCount,
    synthesisRepresentedEvidenceCount,
    predictedPromptTokens: result.promptStats?.predictedPromptTokens ?? null,
    maxPromptTokens: result.promptStats?.maxPromptTokens ?? null,
    finalCompleteness: result.completeness,
    finalCitationCount: result.evidence.length,
  },
  queryTermBaseline: {
    requestedPlannerTerms,
    acceptedPlannerTerms: plannerTerms,
    executedQueryTerms,
    currentNormalizationObservation: '大小写不同的原始 Planner 词在当前校验中归一化为同一执行词；阶段 0 只记录，不修复。',
  },
  execution: {
    decisionRounds: result.agentStats.decisionRounds,
    modelCalls: result.agentStats.modelCalls,
    toolCalls: result.toolStats.calls,
    stopReason: result.agentStats.stopReason,
    searchPlanStatus: result.searchPlan?.status ?? null,
  },
  evidenceBudgetLimit: DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars,
  evidenceBudget,
  metricDefinitions: {
    synthesisRawEvidenceCount: 'Evidence records available from the current-note ledger at final synthesis.',
    synthesisRepresentedEvidenceCount: 'Evidence IDs present in the final synthesize raw evidence body, excluding the evidence directory.',
  },
};
await fs.writeFile(path.join(outDir, 'baseline-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
