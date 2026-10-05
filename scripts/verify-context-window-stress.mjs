import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-context-window-stress');
const files = {
  projector: path.join(outDir, 'projector.cjs'),
  tools: path.join(outDir, 'tools.cjs'),
  snapshot: path.join(outDir, 'snapshot.cjs'),
  scheduler: path.join(outDir, 'scheduler.cjs'),
  calibration: path.join(outDir, 'calibration.cjs'),
};

if (process.env.MENGHAN_CONTEXT_WINDOW_STRESS_PREBUILT !== '1') {
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'planAwarePromptProjector.ts')], outfile: files.projector, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteTools.ts')], outfile: files.tools, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: files.snapshot, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteContextBudget.ts')], outfile: files.scheduler, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'tokenCalibration.ts')], outfile: files.calibration, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}

const { PlanAwarePromptProjector, deriveEvidenceProtectionSet, DEFAULT_SYNTHESIZE_JSON_SCHEMA } = await import(pathToFileURL(files.projector).href);
const { createCurrentNoteTools } = await import(pathToFileURL(files.tools).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(files.snapshot).href);
const { PromptBudgetScheduler } = await import(pathToFileURL(files.scheduler).href);
const { TokenCalibrationStore } = await import(pathToFileURL(files.calibration).href);

const evidence = Array.from({ length: 48 }, (_, index) => {
  const hex = index.toString(16).padStart(24, '0');
  return {
    evidenceId: `evidence-${hex}`,
    noteId: 'stress-note',
    lineFrom: index * 4 + 1,
    lineTo: index * 4 + 3,
    contentHash: `hash-${index}`,
    text: `第 ${index} 条原文证据：${'用于压力测试的确定性内容。'.repeat(120)}`,
  };
});
const goals = Array.from({ length: 4 }, (_, goalIndex) => {
  const first = goalIndex * 8;
  const requirementId = `req-${goalIndex + 1}`;
  const ordinary = evidence.slice(first, first + 3).map((record) => record.evidenceId);
  const supports = evidence.slice(first + 3, first + 4).map((record) => record.evidenceId);
  const contradicts = evidence.slice(first + 4, first + 5).map((record) => record.evidenceId);
  return {
    goalId: `goal-${goalIndex + 1}`,
    question: `压力目标 ${goalIndex + 1}`,
    evidenceKind: 'fact',
    requirements: [{ requirementId, label: `目标 ${goalIndex + 1} 的原文依据`, minEvidence: 2 }],
    queryTerms: [{ term: `目标${goalIndex + 1}`, source: 'planner' }],
    status: goalIndex === 0 ? 'conflicted' : 'covered',
    evidenceBindings: [{ requirementId, evidenceIds: ordinary }],
    conflictBindings: goalIndex === 0 ? [{ requirementId, supportsEvidenceIds: supports, contradictsEvidenceIds: contradicts }] : [],
  };
});
const plan = {
  planId: 'plan-context-stress',
  version: 4,
  originalQuestion: '验证不同窗口下的最小充分证据投影。',
  goals,
  activeGoalId: goals[0].goalId,
  status: 'active',
  revisionCount: 1,
  goalUpdateCount: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

const projector = new PlanAwarePromptProjector();
const protection = deriveEvidenceProtectionSet(plan, evidence, 'synthesize');
assert.ok(protection.conflictEvidenceIds.includes(goals[0].conflictBindings[0].supportsEvidenceIds[0]));
assert.ok(protection.conflictEvidenceIds.includes(goals[0].conflictBindings[0].contradictsEvidenceIds[0]));
assert.equal(new Set(protection.protectedEvidenceIds).size, protection.protectedEvidenceIds.length);

for (const contextWindowTokens of [32_768, 65_536, 131_072]) {
  let previousTokens = Number.MAX_SAFE_INTEGER;
  for (const projectionLevel of [0, 1, 3, 4]) {
    const projection = projector.build({
      callKind: 'synthesize',
      stablePrefix: '[固定策略] 只依据当前作用域。',
      question: plan.originalQuestion,
      plan,
      baseVersion: plan.version,
      evidence,
      projectionLevel,
      outputSchema: DEFAULT_SYNTHESIZE_JSON_SCHEMA,
    });
    const schedule = new PromptBudgetScheduler().plan({
      prompt: projection.prompt,
      contextWindowTokens,
      callKind: 'synthesize',
      calibrationMultiplier: 1.1,
    });
    assert.ok(schedule.predictedPromptTokens <= previousTokens, `${contextWindowTokens}K projection must not grow after compression level ${projectionLevel}`);
    previousTokens = schedule.predictedPromptTokens;
    assert.ok(projection.protectedEvidenceIds.includes(goals[0].conflictBindings[0].supportsEvidenceIds[0]));
    assert.ok(projection.protectedEvidenceIds.includes(goals[0].conflictBindings[0].contradictsEvidenceIds[0]));
    assert.equal(projection.promptStats.callKind, 'synthesize');
  }
}

const markdown = ['# 分页夹具', ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 行：稳定分页内容。`)].join('\n');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/stress.md',
  title: '分页夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings: [{ id: 'section', level: 1, text: '分页夹具', line: 1 }],
  revision: 1,
});
const tools = createCurrentNoteTools(snapshot);
const firstPage = tools.readNoteSection({ headingId: 'section' }, { maxTokens: 24, maxLines: 8 });
assert.ok(firstPage.nextCursor, 'dynamic section quota must return a stable cursor');
const secondPage = tools.readNoteSection({ headingId: 'section', cursor: firstPage.nextCursor }, { maxTokens: 24, maxLines: 8 });
assert.equal(secondPage.lineFrom, firstPage.nextCursor);
assert.ok(secondPage.lineFrom > firstPage.lineFrom);

const calibration = new TokenCalibrationStore();
const key = { providerKind: 'openai-compatible', model: 'stress-model', callKind: 'synthesize' };
assert.equal(calibration.getMultiplier(key), 1.05);
calibration.observe({ key, locallyEstimatedTokens: 100, providerInputTokens: 140 });
assert.ok(calibration.getMultiplier(key) <= 1.35);
assert.ok(calibration.getMultiplier(key) > 1.05);

console.log('Context window stress verification passed: 32K/64K/128K, L3/L4, conflict protection, pagination, calibration');
