import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const fixtureDir = path.join(rootDir, 'scripts', 'fixtures', 'assistant-plan-execute', 'fixture-v1');
const manifestPath = path.join(fixtureDir, 'manifest.json');
const questionsPath = path.join(fixtureDir, 'questions.json');
const notePath = path.join(fixtureDir, 'notes', 'fixture-note.md');
const outDir = path.join(rootDir, '.package-staging', 'assistant-plan-benchmark');
const graphFile = path.join(outDir, 'graph.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const lexicalIndexFile = path.join(outDir, 'lexical-index.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');
const planDriverFile = path.join(outDir, 'plan-driver.cjs');
const reportPath = path.join(outDir, 'baseline-v1.json');

await fs.mkdir(outDir, { recursive: true });
await Promise.all([
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')],
    outfile: graphFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')],
    outfile: snapshotFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')],
    outfile: lexicalIndexFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')],
    outfile: memoryFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
  build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'searchPlanDriver.ts')],
    outfile: planDriverFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  }),
]);

const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { CurrentNoteLexicalIndex } = await import(pathToFileURL(lexicalIndexFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);
const { createCurrentNotePlanDriver } = await import(pathToFileURL(planDriverFile).href);

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const questions = JSON.parse(await fs.readFile(questionsPath, 'utf8'));
const noteMarkdown = await fs.readFile(notePath, 'utf8');

assert.deepEqual(Object.keys(manifest).sort(), ['encoding', 'files', 'fixtureVersion', 'questionsFile'].sort());
assert.equal(manifest.fixtureVersion, 1);
assert.equal(manifest.encoding, 'utf-8');
assert.equal(manifest.questionsFile, 'questions.json');
assert.ok(Array.isArray(manifest.files));

function compareCodePointStrings(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

const manifestPaths = manifest.files.map((entry) => entry.path);
assert.deepEqual(manifestPaths, [...manifestPaths].sort(compareCodePointStrings));
assert.equal(manifestPaths.includes('manifest.json'), false);
assert.deepEqual(manifestPaths, ['notes/fixture-note.md', 'questions.json']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

for (const entry of manifest.files) {
  assert.match(entry.path, /^(?:notes\/[^/]+\.md|questions\.json)$/u);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
  const bytes = await fs.readFile(path.join(fixtureDir, ...entry.path.split('/')));
  assert.equal(sha256(bytes), entry.sha256, `fixture hash mismatch: ${entry.path}`);
}

const questionKeys = [
  'allowedCompleteness',
  'category',
  'expectedGoalShape',
  'expectedRoute',
  'id',
  'question',
  'requiredEvidenceSlots',
];
assert.equal(questions.length, 20);
assert.deepEqual(
  [...new Set(questions.map((question) => question.category))].sort(),
  ['comparison', 'lexical-variation', 'no-answer-or-conflict', 'single-fact'].sort(),
);
for (const category of ['single-fact', 'comparison', 'lexical-variation', 'no-answer-or-conflict']) {
  assert.equal(questions.filter((question) => question.category === category).length, 5, `${category} must contain five questions`);
}
assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
for (const question of questions) {
  assert.deepEqual(Object.keys(question).sort(), questionKeys.sort());
  assert.match(question.id, /^q(?:0[1-9]|1[0-9]|20)$/u);
  assert.equal(question.expectedRoute, 'react-search');
  assert.ok(Array.isArray(question.allowedCompleteness) && question.allowedCompleteness.length > 0);
  assert.ok(Array.isArray(question.requiredEvidenceSlots));
  assert.equal(typeof question.expectedGoalShape, 'object');
}

const headingSources = noteMarkdown.split(/\r?\n/u).flatMap((line, index) => {
  const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
  return match ? [{ id: `heading-${index + 1}`, level: match[1].length, text: match[2], line: index + 1 }] : [];
});
const contentHash = sha256(Buffer.from(noteMarkdown, 'utf8'));
const snapshot = createCurrentNoteSnapshot({
  libraryPath: fixtureDir,
  notePath,
  title: 'Plan-and-Execute ReAct Fixture',
  contentHash,
  markdown: noteMarkdown,
  headings: headingSources,
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const lexicalIndex = new CurrentNoteLexicalIndex(snapshot);

const searchTermsByQuestionId = {
  q01: [['Flyway']],
  q02: [['current-note-structure-v1']],
  q03: [['SpringBoot']],
  q04: [['NER']],
  q05: [['1.2.3']],
  q06: [['Alpha'], ['Beta']],
  q07: [['Atlas'], ['Beacon']],
  q08: [['Mercury'], ['Venus']],
  q09: [['Index-A'], ['Index-B']],
  q10: [['Blue'], ['Green']],
  q11: [['Ner']],
  q12: [['Spingboot']],
  q13: [['Spring']],
  q14: [['RBG']],
  q15: [['命名实体识别']],
  q16: [['Kafka']],
  q17: [['1.2.4']],
  q18: [['RBG']],
  q19: [['系统配置'], ['运维记录']],
  q20: [['流程记录'], ['审计记录']],
};
assert.deepEqual(Object.keys(searchTermsByQuestionId).sort(), questions.map((question) => question.id).sort());

function evidenceIdsFromPrompt(prompt) {
  return [...new Set([...prompt.matchAll(/evidence-[a-f0-9]{24}/gu)].map((match) => match[0]))];
}

function buildStubActions(question) {
  const shouldReadEvidence = question.expectedGoalShape.requiresConflict || question.allowedCompleteness.includes('complete');
  return searchTermsByQuestionId[question.id].flatMap((terms) => {
    const hits = lexicalIndex.search(terms.join(' '), 8);
    const actions = [{ kind: 'search', terms }];
    if (shouldReadEvidence && hits[0]) actions.push({ kind: 'read', lineFrom: hits[0].lineFrom, lineTo: hits[0].lineTo });
    return actions;
  });
}

function createDeterministicStubDriver(question) {
  const actions = buildStubActions(question);
  let decisionIndex = 0;
  const finalCompleteness = question.expectedGoalShape.requiresConflict
    ? 'partial'
    : question.allowedCompleteness.includes('complete') ? 'complete' : 'not-found';
  return {
    async decide({ prompt }) {
      const next = actions[decisionIndex];
      decisionIndex += 1;
      if (next?.kind === 'search') {
        return {
          type: 'tool',
          tool: 'search_note',
          arguments: { terms: next.terms, limit: 8 },
          publicRationale: '定位当前笔记中的相关原文。',
        };
      }
      if (next?.kind === 'read') {
        return {
          type: 'tool',
          tool: 'read_note_range',
          arguments: { lineFrom: next.lineFrom, lineTo: next.lineTo },
          publicRationale: '读取命中范围的原文证据。',
        };
      }
      const citations = finalCompleteness === 'not-found' ? [] : evidenceIdsFromPrompt(prompt);
      return {
        type: 'answer',
        answer: finalCompleteness === 'complete' ? '确定性 stub 已读取所需原文。' : '确定性 stub 未形成无冲突的完整结论。',
        citations,
        completeness: finalCompleteness,
      };
    },
    async synthesize() {
      throw new Error('baseline stub should finish in the deterministic decision loop');
    },
  };
}

async function runQuestion(question) {
  const questionStartedAt = performance.now();
  const lexicalStartedAt = performance.now();
  const lexicalHits = lexicalIndex.search(searchTermsByQuestionId[question.id][0].join(' '), 8);
  const lexicalElapsedMs = Number((performance.now() - lexicalStartedAt).toFixed(3));
  const result = await runCurrentNoteAgent({
    snapshot,
    question: question.question,
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-stub',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver: createDeterministicStubDriver(question),
    memory: new NoteConversationMemory(),
    memoryScopeKey: `fixture-v1:${question.id}`,
    isSnapshotCurrent: () => true,
  });
  const elapsedMs = Number((performance.now() - questionStartedAt).toFixed(3));
  assert.equal(result.contextMode, question.expectedRoute, `${question.id} route drifted`);
  assert.ok(question.allowedCompleteness.includes(result.completeness), `${question.id} completeness is not allowed`);
  assert.ok(result.evidence.length >= question.requiredEvidenceSlots.length, `${question.id} lacks required evidence slots`);
  assert.ok(result.agentStats.modelCalls <= 8);
  assert.ok(result.toolStats.calls <= DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls);
  return {
    questionId: question.id,
    category: question.category,
    route: result.contextMode,
    modelCalls: result.agentStats.modelCalls,
    toolCalls: result.toolStats.calls,
    stopReason: result.agentStats.stopReason,
    completeness: result.completeness,
    evidenceCount: result.evidence.length,
    lexicalHitCount: lexicalHits.length,
    lexicalElapsedMs,
    elapsedMs,
  };
}

async function runCurrentNoteComparisonRegression(question) {
  const subjectTerms = searchTermsByQuestionId[question.id];
  assert.equal(subjectTerms.length, 2, `${question.id} comparison must have two subject searches`);
  const ranges = subjectTerms.map((terms) => {
    const hit = lexicalIndex.search(terms.join(' '), 8)[0];
    assert.ok(hit, `${question.id} must have a lexical hit for ${terms.join(' ')}`);
    return { lineFrom: hit.lineFrom, lineTo: hit.lineTo };
  });
  const goalId = `goal-${question.id}`;
  const requirementIds = [`req-${question.id}-a`, `req-${question.id}-b`];
  const planner = createCurrentNotePlanDriver({
    async generateJson() {
      return {
        goals: [{
          goalId,
          question: question.question,
          evidenceKind: 'comparison',
          requirements: subjectTerms.map((terms, index) => ({
            requirementId: requirementIds[index],
            label: `${terms[0]} 的比较证据`,
            subject: terms[0],
            minEvidence: 1,
          })),
          queryTerms: subjectTerms.flat(),
        }],
      };
    },
  });
  let decisionIndex = 0;
  const events = [];
  const driver = {
    async decide({ prompt }) {
      decisionIndex += 1;
      if (decisionIndex === 1 || decisionIndex === 3) {
        const subjectIndex = decisionIndex === 1 ? 0 : 1;
        return {
          type: 'tool',
          goalId,
          tool: 'search_note',
          arguments: { terms: subjectTerms[subjectIndex], limit: 8 },
          publicRationale: `定位 ${subjectTerms[subjectIndex][0]} 的原文。`,
        };
      }
      if (decisionIndex === 2 || decisionIndex === 4) {
        const subjectIndex = decisionIndex === 2 ? 0 : 1;
        return {
          type: 'tool',
          goalId,
          tool: 'read_note_range',
          arguments: ranges[subjectIndex],
          publicRationale: `读取 ${subjectTerms[subjectIndex][0]} 的原文。`,
        };
      }
      const evidenceIds = evidenceIdsFromPrompt(prompt);
      const planVersion = Number(prompt.match(/planVersion=(\d+)/u)?.[1]);
      return {
        type: 'answer',
        answer: 'Planner 比较 stub 已分别读取两个对象的原文。',
        citations: evidenceIds,
        completeness: 'complete',
        planPatch: {
          baseVersion: planVersion,
          activeGoalId: null,
          goalUpdates: [{
            goalId,
            status: 'covered',
            evidenceBindings: requirementIds.map((requirementId, index) => ({ requirementId, evidenceIds: [evidenceIds[index]] })),
          }],
        },
      };
    },
    async synthesize() {
      throw new Error(`${question.id} current-note comparison should finish in the decision loop`);
    },
  };
  const result = await runCurrentNoteAgent({
    snapshot,
    question: question.question,
    conversation: [],
    providerKind: 'ollama',
    model: 'fixture-stub',
    contextWindowTokens: 20_000,
    signal: new AbortController().signal,
    driver,
    planMode: 'current-note',
    planner,
    memory: new NoteConversationMemory(),
    memoryScopeKey: `fixture-v1:current-note:${question.id}`,
    isSnapshotCurrent: () => true,
    onToolEvent: (event) => events.push(event),
  });
  assert.equal(result.completeness, 'complete', `${question.id} current-note comparison must complete`);
  assert.equal(result.searchPlan?.status, 'completed');
  assert.equal(result.toolStats.calls, 4);
  assert.equal(result.evidence.length, 2);
  for (const terms of subjectTerms) {
    assert.equal(
      events.some((event) => {
        const inputSummary = event.inputSummary?.toLocaleLowerCase('en-US') ?? '';
        return event.tool === 'search_note'
          && event.state === 'started'
          && terms.every((term) => inputSummary.includes(term.toLocaleLowerCase('en-US')));
      }),
      true,
      `${question.id} must start the ${terms.join(' ')} search`,
    );
  }
  const bindings = result.searchPlan?.goals[0].evidenceBindings ?? [];
  assert.equal(bindings.length, 2);
  assert.notEqual(bindings[0].evidenceIds[0], bindings[1].evidenceIds[0]);
}

for (const question of questions.filter((candidate) => /^q(?:06|07|08|09|10)$/u.test(candidate.id))) {
  await runCurrentNoteComparisonRegression(question);
}

const warmupPasses = 3;
for (let pass = 0; pass < warmupPasses; pass += 1) {
  for (const question of questions) await runQuestion(question);
}

const samples = [];
const samplesPerQuestion = 30;
for (const question of questions) {
  for (let sampleIndex = 0; sampleIndex < samplesPerQuestion; sampleIndex += 1) {
    samples.push({ sampleIndex: sampleIndex + 1, ...(await runQuestion(question)) });
  }
}
assert.equal(samples.length, 600);

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;
  return {
    count: values.length,
    average: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
    min: sorted[0],
    max: sorted.at(-1),
    p95: sorted[p95Index],
    p95Index,
    p95Formula: 'sorted[ceil(0.95*n)-1]',
  };
}

const perQuestion = questions.map((question) => {
  const questionSamples = samples.filter((sample) => sample.questionId === question.id);
  const first = questionSamples[0];
  for (const sample of questionSamples) {
    assert.equal(sample.route, first.route);
    assert.equal(sample.modelCalls, first.modelCalls);
    assert.equal(sample.toolCalls, first.toolCalls);
    assert.equal(sample.stopReason, first.stopReason);
    assert.equal(sample.completeness, first.completeness);
  }
  return {
    questionId: question.id,
    category: question.category,
    expectedRoute: question.expectedRoute,
    allowedCompleteness: question.allowedCompleteness,
    requiredEvidenceSlots: question.requiredEvidenceSlots,
    sampleCount: questionSamples.length,
    route: first.route,
    modelCalls: first.modelCalls,
    toolCalls: first.toolCalls,
    stopReason: first.stopReason,
    completeness: first.completeness,
    lexicalElapsedMs: summarize(questionSamples.map((sample) => sample.lexicalElapsedMs)),
    elapsedMs: summarize(questionSamples.map((sample) => sample.elapsedMs)),
  };
});

function readGit(command) {
  try {
    return execFileSync('git', command, { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const report = {
  schemaVersion: 'assistant-plan-baseline-v1',
  generatedAt: new Date().toISOString(),
  purpose: 'checkout-local feature report; not a cross-machine golden value',
  checkout: {
    head: readGit(['rev-parse', 'HEAD']),
    statusShort: readGit(['status', '--short']),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  mode: 'off',
  driver: 'deterministic-stub',
  fixture: {
    fixtureVersion: manifest.fixtureVersion,
    questionsFile: manifest.questionsFile,
    manifestSha256: sha256(await fs.readFile(manifestPath)),
    files: manifest.files,
    questionCount: questions.length,
  },
  warmup: {
    passes: warmupPasses,
    questionCount: questions.length,
    excludedQuestionSamples: warmupPasses * questions.length,
  },
  sampling: {
    samplesPerQuestion,
    questionCount: questions.length,
    questionLevelSamples: samples.length,
    p95Formula: 'sorted[ceil(0.95*n)-1]',
  },
  aggregate: {
    elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
    lexicalElapsedMs: summarize(samples.map((sample) => sample.lexicalElapsedMs)),
  },
  perQuestion,
  samples,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Current-note off baseline written: ${path.relative(rootDir, reportPath).replace(/\\/gu, '/')}`);
