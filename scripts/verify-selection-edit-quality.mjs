import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-selection-edit-quality');
const qualityBundle = path.join(outDir, 'quality.cjs');
const coordinatorBundle = path.join(outDir, 'coordinator.cjs');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const coordinatorStubs = {
  name: 'selection-edit-quality-coordinator-stubs',
  setup(context) {
    const resolve = (filter, name) => context.onResolve({ filter }, () => ({ path: name, namespace: 'selection-edit-quality-stub' }));
    resolve(/aiProvider$/u, 'ai-provider');
    resolve(/selectionEditSources\/currentNoteSource$/u, 'current-note-source');
    resolve(/selectionEditSources\/extendedSources$/u, 'extended-sources');
    resolve(/selectionEditSources\/personalizationSource$/u, 'personalization-source');
    resolve(/selectionEditAgentRuntime$/u, 'agent-runtime');
    resolve(/selectionEditResearchMode$/u, 'research-mode');
    resolve(/tokenEstimator$/u, 'token-estimator');
    resolve(/currentNoteStructure$/u, 'current-note-structure');
    context.onLoad({ filter: /.*/u, namespace: 'selection-edit-quality-stub' }, (args) => ({
      loader: 'js',
      contents: {
        'ai-provider': `
          let calls = 0;
          const outputs = [
            '请说明恢复窗口。',
            '恢复窗口规定第一次自动重试前等待 7 秒。',
            '请说明恢复窗口。',
            '请说明恢复窗口。',
          ];
          export const getAiProviderConfig = () => ({ kind: 'ollama', model: 'quality-test-model' });
          export const getAiProviderRuntimeConfig = getAiProviderConfig;
          export const getKnownRemoteModelContextWindow = () => undefined;
          export const generateAiText = async () => outputs[calls++] ?? '请说明恢复窗口。';
          export const getGenerationCalls = () => calls;
        `,
        'current-note-source': `
          export const collectSelectionEditCurrentNoteContext = () => ({
            evidence: [{
              evidenceId: 'evidence-1', sourceKind: 'current-note', title: '当前笔记', locator: '当前笔记 / L2-L2',
              content: '恢复窗口规定第一次自动重试前等待 7 秒。', sourceContentHash: 'a'.repeat(64), textHash: 'b'.repeat(64),
              goalIds: ['goal-1', 'goal-2'], readVerified: true,
            }],
            receipt: { planned: [], used: [], skipped: [], candidates: [], conflicts: [], personalization: { requested: false, applied: false, itemCount: 0 }, fullNoteMode: 'map-and-read' },
          });
        `,
        'extended-sources': `export const collectSelectionEditExtendedSources = async () => ({ evidence: [], receipt: { planned: [], used: [], skipped: [], candidates: [], conflicts: [], personalization: { requested: false, applied: false, itemCount: 0 }, fullNoteMode: 'not-requested' } });`,
        'personalization-source': `export const collectSelectionEditPersonalization = () => ({ items: [], receipt: { requested: false, applied: false, itemCount: 0 } });`,
        'agent-runtime': `export const resolveSelectionEditAgentBudget = () => ({ maxToolCalls: 8 }); export const runSelectionEditAgentRuntime = async () => ({ kind: 'unavailable', reason: 'fixture' });`,
        'research-mode': `export const resolveSelectionEditResearchMode = () => 'direct';`,
        'token-estimator': `export const estimateTokenCount = (value) => Math.ceil(Array.from(value).length / 2);`,
        'current-note-structure': `export const tokenizeCurrentNoteText = () => ['恢复窗口'];`,
      }[args.path],
    }));
  },
};

try {
  await Promise.all([
    build({
      stdin: {
        contents: [
          `export { applySelectionEditQualityGate, primarySelectionEditQualityIssue, selectionEditQualityIssueLabel } from './electron/knowledge/selectionEditQuality.ts';`,
          `export { validateSelectionEditOutput } from './electron/knowledge/selectionEditValidator.ts';`,
          `export { selectionEditProfiles } from './electron/knowledge/selectionEditProfiles.ts';`,
        ].join('\n'),
        resolveDir: rootDir,
        sourcefile: 'verify-selection-edit-quality-entry.ts',
      },
      outfile: qualityBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
    build({
      stdin: {
        contents: `export { createCurrentNoteSelectionEditRequest, runSelectionEditCoordinator } from './electron/knowledge/selectionEditCoordinator.ts';`,
        resolveDir: rootDir,
        sourcefile: 'verify-selection-edit-quality-coordinator-entry.ts',
      },
      outfile: coordinatorBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [coordinatorStubs],
      logLevel: 'silent',
    }),
  ]);
  const quality = await import(`${pathToFileURL(qualityBundle).href}?v=${Date.now()}`);
  const coordinator = await import(`${pathToFileURL(coordinatorBundle).href}?v=${Date.now()}`);
  let checks = 0;
  const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
  const ok = (value, label) => { assert.ok(value, label); checks += 1; };
  const evidence = [{
    evidenceId: 'evidence-1', sourceKind: 'current-note', title: '当前笔记', locator: '当前笔记 / L2-L2',
    content: '恢复窗口规定第一次自动重试前等待 7 秒。', sourceContentHash: 'a'.repeat(64), textHash: 'b'.repeat(64),
    goalIds: ['goal-1'], readVerified: true,
  }];
  const validate = (selectedText, candidateText, items = evidence) => quality.validateSelectionEditOutput({
    action: 'expand', selectedText, candidateText, evidence: items,
    protectedAnchorKinds: quality.selectionEditProfiles.expand.protectedAnchorKinds,
  });

  const unchanged = quality.applySelectionEditQualityGate({
    action: 'expand', selectedText: '词频饱和', candidateText: '词频饱和', targetCharacters: 12,
    requiredGoalIds: ['goal-1'], evidence, validation: validate('词频饱和', '词频饱和'),
  });
  equal(quality.primarySelectionEditQualityIssue(unchanged.receipt)?.code, 'EXPAND_NOT_LONGER', '只返回原词必须优先归类为扩写长度失败');
  equal(quality.selectionEditQualityIssueLabel(quality.primarySelectionEditQualityIssue(unchanged.receipt)), '扩写未达到目标长度', '长度失败必须展示精确中文原因');

  const targetShort = quality.applySelectionEditQualityGate({
    action: 'expand', selectedText: '恢复窗口。', candidateText: '恢复窗口说明。', targetCharacters: 20,
    requiredGoalIds: [], evidence: [{ ...evidence[0], content: '恢复窗口说明。' }],
    validation: validate('恢复窗口。', '恢复窗口说明。', [{ ...evidence[0], content: '恢复窗口说明。' }]),
  });
  equal(quality.primarySelectionEditQualityIssue(targetShort.receipt)?.code, 'TARGET_LENGTH_MISSED', '变长但低于目标区间必须单独标记目标长度失败');
  equal(quality.selectionEditQualityIssueLabel(quality.primarySelectionEditQualityIssue(targetShort.receipt)), '扩写未达到目标长度', '目标区间失败沿用一致的用户提示');

  const unsupported = quality.applySelectionEditQualityGate({
    action: 'expand', selectedText: '请说明恢复窗口。', candidateText: '恢复窗口将在全球 500 个节点中自动恢复。',
    requiredGoalIds: [], evidence: [], validation: validate('请说明恢复窗口。', '恢复窗口将在全球 500 个节点中自动恢复。', []),
  });
  equal(quality.primarySelectionEditQualityIssue(unsupported.receipt)?.code, 'UNSUPPORTED_ADDITION', '新增句没有证据时不得冒充计划覆盖失败');
  equal(quality.selectionEditQualityIssueLabel(quality.primarySelectionEditQualityIssue(unsupported.receipt)), '新增内容缺少原文依据', '无依据新增必须展示精确中文原因');

  const coverage = quality.applySelectionEditQualityGate({
    action: 'expand', selectedText: '请说明恢复窗口。', candidateText: '恢复窗口规定第一次自动重试前等待 7 秒。',
    requiredGoalIds: ['goal-1', 'goal-2'], evidence, validation: validate('请说明恢复窗口。', '恢复窗口规定第一次自动重试前等待 7 秒。'),
  });
  equal(coverage.receipt.issues.map((issue) => issue.code), ['EVIDENCE_GOAL_UNCOVERED'], '只有计划目标缺失时才产生证据覆盖问题');
  equal(quality.selectionEditQualityIssueLabel(quality.primarySelectionEditQualityIssue(coverage.receipt)), '证据覆盖不足', '计划覆盖失败必须展示证据覆盖不足');

  const webValidation = quality.validateSelectionEditOutput({
    action: 'polish', selectedText: '保持原文。', candidateText: '保持原文。', evidence: [],
    protectedAnchorKinds: quality.selectionEditProfiles.polish.protectedAnchorKinds,
  });
  const web = quality.applySelectionEditQualityGate({
    action: 'polish', selectedText: '保持原文。', candidateText: '保持原文。', requiredGoalIds: [],
    evidence: [{ ...evidence[0], sourceKind: 'web', pageVerified: false }], validation: webValidation,
  });
  equal(web.receipt.issues.map((issue) => issue.code), ['WEB_PAGE_UNVERIFIED'], '未全文核验网页必须阻止直接写回');

  const snapshot = {
    libraryPath: 'C:/quality-notes', notePath: 'C:/quality-notes/test.md', contentHash: 'c'.repeat(64),
    snapshotId: 'snapshot-1', markdown: '请说明恢复窗口。\n\n恢复窗口规定第一次自动重试前等待 7 秒。', tokenEstimate: 20,
  };
  const request = coordinator.createCurrentNoteSelectionEditRequest({
    requestId: 'selection-quality-0001', action: 'expand', sourceSnapshotId: snapshot.snapshotId, snapshot,
    selectedText: '请说明恢复窗口。', contextScope: 'current-note',
  });
  const repaired = await coordinator.runSelectionEditCoordinator({
    request, snapshot, signal: new AbortController().signal, isSnapshotCurrent: () => true,
  });
  equal(repaired.execution, { path: 'direct', rounds: 2, modelCalls: 2, toolCalls: 0, repairAttempts: 1 }, '结果必须携带真实直接链修复次数');
  equal(repaired.qualityReceipt.validation, 'passed', '修复后的建议必须重新通过终答质量门');
  equal(repaired.writebackKind, 'inline-text', '只有修复后验证通过才允许写回');

  const failedAfterRepair = await coordinator.runSelectionEditCoordinator({
    request: { ...request, requestId: 'selection-quality-0002' }, snapshot,
    signal: new AbortController().signal, isSnapshotCurrent: () => true,
  });
  equal(failedAfterRepair.execution, { path: 'direct', rounds: 2, modelCalls: 2, toolCalls: 0, repairAttempts: 1 }, '第二次仍失败时不得继续无限修复');
  equal(failedAfterRepair.qualityReceipt.validation, 'failed', '修复耗尽后的失败必须保留质量状态');
  equal(failedAfterRepair.writebackKind, 'copy-only', '修复耗尽后的失败绝不允许直接写回');

  const workspace = fs.readFileSync(path.join(rootDir, 'src', 'components', 'assistant', 'SelectionExpansionWorkspace.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
  const main = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  ok(workspace.includes("qualityReceipt?.validation === 'passed'"), '扩写工作区必须以质量回执决定是否显示替换选区');
  ok(!workspace.includes('result?.completeness'), '扩写工作区不得再用旧 completeness 推断失败原因');
  ok(app.includes('isSelectionExpansionTerminalStatus(current.status)'), 'Renderer 必须丢弃终态后的后到事件');
  ok(app.includes("event.type === 'stale'"), 'Renderer 必须把 stale 作为终态处理');
  ok(main.includes('let terminal = false;') && main.includes('controller.signal.aborted && payload.type !== \'cancelled\''), '主进程必须在取消后阻止后到状态或完成事件');

  console.log(`selection-edit-quality 验证通过：${checks} 项断言（质量状态、一次修复、写回与终态事件）。`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
