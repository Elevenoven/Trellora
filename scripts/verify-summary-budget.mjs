import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const rootDir = process.cwd();
const summaryFile = path.join(rootDir, '.package-staging', 'verify-context', 'summary.cjs');
const budgetFile = path.join(rootDir, '.package-staging', 'verify-context', 'summary-budget.cjs');
const snapshotFile = path.join(rootDir, '.package-staging', 'verify-context', 'snapshot.cjs');
await mkdir(path.dirname(summaryFile), { recursive: true });
if (process.env.MENGHAN_SUMMARY_BUDGET_PREBUILT !== '1') {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteSummaryOrchestrator.ts')], outfile: summaryFile, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'summaryRunBudget.ts')], outfile: budgetFile, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}
const { runCurrentNoteSummary } = await import(pathToFileURL(summaryFile).href);
const { SummaryRunBudget } = await import(pathToFileURL(budgetFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);

const markdown = `# A\nA 内容。\n\n# B\nB 内容。\n\n# C\nC 内容。`;
const libraryPath = path.join(rootDir, '.package-staging', 'summary-budget-fixture');
const snapshot = createCurrentNoteSnapshot({
  libraryPath,
  notePath: path.join(libraryPath, 'summary.md'),
  title: '预算夹具',
  contentHash: sha256(markdown),
  markdown,
  headings: [
    { id: 'a', level: 1, text: 'A', line: 1 },
    { id: 'b', level: 1, text: 'B', line: 4 },
    { id: 'c', level: 1, text: 'C', line: 7 },
  ],
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});

const repository = createRepository();
let modelCalls = 0;
const driver = {
  async summarizeSection() {
    modelCalls += 1;
    return { summary: '章节摘要', keyPoints: ['可验证观点'] };
  },
  async reduce() {
    modelCalls += 1;
    return { summary: '完整摘要', keyPoints: ['完整结果'] };
  },
};

const blocked = await runCurrentNoteSummary({
  ...summaryInput(repository, driver),
  summaryBudget: new SummaryRunBudget({ maxModelCalls: 2 }),
}, 'summary-complete');
assert.equal(blocked.completeness, 'not-found');
assert.ok(blocked.checkpoint);
assert.equal(modelCalls, 0, '最坏调用数预检失败时不能发送模型请求');
assert.equal(JSON.stringify(blocked.checkpoint).includes(markdown), false, 'checkpoint 不得复制原始笔记');

const resumed = await runCurrentNoteSummary({
  ...summaryInput(repository, driver),
  summaryCheckpoint: blocked.checkpoint,
  summaryBudget: new SummaryRunBudget({ maxModelCalls: 8 }),
}, 'summary-complete');
assert.equal(resumed.completeness, 'complete');
assert.equal(resumed.coverage.completed, 3);
assert.equal(resumed.summaryBudget.modelCalls, 4);
assert.equal(modelCalls, 4);

console.log('SummaryRunBudget verification passed');

function summaryInput(digestRepository, summaryDriver) {
  return {
    snapshot,
    question: '请完整总结当前笔记。',
    providerKind: 'ollama',
    model: 'fixture-model',
    driver: summaryDriver,
    digestRepository,
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    contextWindowTokens: 16_384,
  };
}

function createRepository() {
  const values = new Map();
  return {
    findReusable({ sectionHash }) {
      return values.get(sectionHash);
    },
    save(input) {
      const digest = {
        digestId: `digest-${input.sectionId}`,
        noteContentHash: input.contentHash,
        sectionId: input.sectionId,
        sectionHash: input.sectionHash,
        headingPath: [...input.headingPath],
        lineFrom: input.lineFrom,
        lineTo: input.lineTo,
        providerFingerprint: input.providerFingerprint,
        model: input.model,
        digestVersion: 1,
        status: input.status,
        summary: input.digest.summary,
        keyPoints: input.digest.keyPoints.map((point) => ({ text: point.text, sourceRefs: point.sourceRefs.map((sourceRef) => ({ ...sourceRef })) })),
      };
      values.set(input.sectionHash, digest);
      return digest;
    },
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
