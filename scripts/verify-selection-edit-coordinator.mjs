import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-validator-bundle.cjs');
const profilesBundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-profiles-bundle.cjs');

try {
  await Promise.all([fs.rm(bundlePath, { force: true }), fs.rm(profilesBundlePath, { force: true })]);
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditValidator.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditProfiles.ts')],
      outfile: profilesBundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
  ]);
  const { validateSelectionEditOutput } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const profiles = await import(`${pathToFileURL(profilesBundlePath).href}?v=${Date.now()}`);
  const evidence = [{
    evidenceId: 'evidence-1',
    sourceKind: 'current-note',
    title: '当前笔记',
    locator: '当前笔记 L4-L4',
    content: '恢复窗口规定第一次自动重试前等待 7 秒。',
    sourceContentHash: 'a'.repeat(64),
    textHash: 'b'.repeat(64),
    goalIds: ['goal-1'],
    readVerified: true,
  }];
  const validate = (action, selectedText, candidateText, extra = {}) => validateSelectionEditOutput({
    action,
    selectedText,
    candidateText,
    evidence: extra.evidence ?? [],
    targetLanguage: extra.targetLanguage,
    protectedAnchorKinds: profiles.selectionEditProfiles[action].protectedAnchorKinds,
  });

  const polish = validate('polish', '请在 2026-09-09 打开 https://example.test/a。', '请于 2026-09-09 打开 https://example.test/a。');
  assert.equal(polish.passed, true, '润色必须保留日期和 URL 锚点。');
  assert.deepEqual(polish.issues, [], '润色成功基线不应产生结构化质量问题。');

  const shorten = validate('shorten', '恢复窗口用于描述自动重试前需要等待的时间。', '恢复窗口描述重试等待时间。');
  assert.equal(shorten.passed, true, '精简必须确实短于原文。');
  assert.ok('恢复窗口描述重试等待时间。'.length < '恢复窗口用于描述自动重试前需要等待的时间。'.length);

  const expand = validate('expand', '请说明恢复窗口。', '恢复窗口规定第一次自动重试前等待 7 秒。', { evidence });
  assert.equal(expand.passed, true, '扩写的新增说明必须能映射到已读证据。');
  assert.deepEqual(expand.issues, [], '有已读证据支撑的扩写不应产生质量问题。');

  const proofread = validate('proofread', '恢復窗口等待 7 秒。', '恢复窗口等待 7 秒。');
  assert.equal(proofread.passed, true, '校对的小改动应通过。');
  const broadProofread = validate('proofread', '恢复窗口等待 7 秒。', '平台将按照全新的调度架构在更多业务场景中动态重试。');
  assert.equal(broadProofread.passed, false, '校对不能大幅改写。');

  const explain = validate('explain', '恢复窗口。', '恢复窗口规定第一次自动重试前等待 7 秒。', { evidence });
  assert.equal(explain.passed, true, '解释的新增事实必须来自已读证据。');

  const translate = validate('translate', '运行 `task --id {{name}}`，访问 [文档](https://example.test/docs)。', 'Run `task --id {{name}}` and visit [docs](https://example.test/docs).', { targetLanguage: '英语' });
  assert.equal(translate.passed, true, '翻译必须保留代码、链接目标和占位符，并符合目标语言。');

  const custom = validate('custom', '当前版本为 2026。', '当前版本为 2027。');
  assert.equal(custom.passed, false, '自定义编辑不能偷偷新增具体事实。');

  const unsupported = validate('expand', '请说明恢复窗口。', '恢复窗口会在全球 500 个节点中自动恢复。');
  assert.equal(unsupported.passed, false, '没有已读证据的扩写不得一键应用。');
  assert.ok(unsupported.unsupportedClaims.length > 0);
  assert.deepEqual(unsupported.issues.map((issue) => issue.code), ['UNSUPPORTED_ADDITION'], '确有新增内容但没有已读证据时，必须报告新增内容无原文依据；计划覆盖由终答质量门单独判断。');

  const unchangedExpansion = validate('expand', '词频饱和', '词频饱和', { evidence });
  assert.equal(unchangedExpansion.passed, false, '只复述原选区的扩写必须失败。');
  assert.deepEqual(unchangedExpansion.issues.map((issue) => issue.code), ['EXPAND_NOT_LONGER'], '只复述原选区必须归类为生成结果失败，而不是证据不足。');
  assert.deepEqual(unchangedExpansion.unsupportedClaims, [], '只复述原选区没有新增 claim，不得伪造证据不足问题。');

  const unchangedExpansionWithoutEvidence = validate('expand', '词频饱和', '词频饱和');
  assert.deepEqual(unchangedExpansionWithoutEvidence.issues.map((issue) => issue.code), ['EXPAND_NOT_LONGER'], '即使没有证据，只复述原文仍应优先稳定归类为扩写未变长。');
  assert.deepEqual(unchangedExpansionWithoutEvidence.unsupportedClaims, [], '没有新增内容时不得产生无证据 claim。');

  const unsupportedWithEvidence = validate('expand', '请说明恢复窗口。', '请说明恢复窗口。平台将在全球 500 个节点中持续切换。', { evidence });
  assert.deepEqual(unsupportedWithEvidence.issues.map((issue) => issue.code), ['UNSUPPORTED_ADDITION'], '已有证据但新增句无法关联时，必须报告无依据新增。');

  const anchorLoss = validate('polish', '请在 2026-09-09 打开页面。', '请打开页面。');
  assert.deepEqual(anchorLoss.issues.map((issue) => issue.code), ['PROTECTED_ANCHOR_LOST'], '丢失受保护锚点必须提供稳定问题代码。');

  assert.equal(profiles.selectionEditProfiles.polish.defaultWritebackMode, 'replace');
  assert.equal(profiles.selectionEditProfiles.shorten.defaultWritebackMode, 'replace');
  assert.equal(profiles.selectionEditProfiles.expand.defaultWritebackMode, 'insert-below');
  assert.equal(profiles.selectionEditProfiles.proofread.defaultWritebackMode, 'replace');
  assert.equal(profiles.selectionEditProfiles.explain.defaultWritebackMode, 'insert-below');
  assert.equal(profiles.selectionEditProfiles.translate.defaultWritebackMode, 'replace');
  assert.equal(profiles.selectionEditProfiles.custom.defaultWritebackMode, 'copy-only');

  const coordinator = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'selectionEditCoordinator.ts'), 'utf8');
  const main = await fs.readFile(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  const transform = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'selectionTransform.ts'), 'utf8');
  const expansion = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'selectionExpansionCoordinator.ts'), 'utf8');
  assert.match(coordinator, /runSelectionEditCoordinator/, '七类动作必须通过统一协调器。');
  assert.match(coordinator, /collectSelectionEditCurrentNoteContext/, '当前笔记取证必须由统一协调器调用。');
  assert.match(coordinator, /validateSelectionEditOutput/, '生成结果必须在统一协调器内确定性校验。');
  assert.doesNotMatch(coordinator, /runReActLoop/, '协调器不得直接复制 ReAct 循环，必须经任务运行时复用。');
  assert.match(coordinator, /runSelectionEditAgentRuntime/, 'RA-2 研究型编辑必须经独立任务运行时复用 ReAct。');
  assert.match(coordinator, /resolveSelectionEditResearchMode/, 'RA-2 必须由显式灰度开关决定是否进入研究型编辑。');
  assert.match(coordinator, /researchMode !== 'direct'/, '默认 direct 时不得额外调用研究型 Agent。');
  assert.match(coordinator, /currentNoteFullyPreloaded/, 'RA-3 必须让严格小笔记全文预加载跳过重复 Agent 读取。');
  assert.match(coordinator, /route === 'extended-research' \|\| route === 'current-note-research'/, 'RA-3 研究型 Agent 必须能服务当前笔记和扩展研究路由。');
  assert.match(coordinator, /request\.allowedSources\.noteLibrary && Boolean\(input\.extendedSources\?\.noteLibrary\)/, 'RA-3 必须允许已就绪的同库笔记进入研究型 Agent。');
  assert.match(coordinator, /WEB_PAGE_UNVERIFIED/, '未全文核验网页来源必须投影稳定问题代码。');
  assert.match(coordinator, /: emptyPersonalization\(\)/, '未启用个性化时也必须提供完整的空资料对象。');
  assert.match(coordinator, /function emptyPersonalization\(\): SelectionEditPersonalization/, '空个性化资料必须包含 items 与 receipt。');
  assert.match(coordinator, /assertRunning\(input\)/, '读取和生成后的竞态必须复核冻结快照。');
  assert.match(transform, /runSelectionEditCoordinator/, '旧普通编辑 IPC 必须仅作统一协调器适配。');
  assert.match(expansion, /runSelectionEditCoordinator/, '旧扩写 IPC 必须仅作统一协调器适配。');
  assert.match(main, /const selectionEditTasks = new Map<string, AbortController>\(\)/, '两类旧入口必须共享取消注册表。');
  assert.match(main, /const selectionTransformTasks = selectionEditTasks/, '旧普通编辑取消入口必须指向统一注册表。');
  assert.match(main, /const selectionExpansionTasks = selectionEditTasks/, '旧扩写取消入口必须指向统一注册表。');

  console.log('Selection edit coordinator verification passed');
} finally {
  await Promise.all([fs.rm(bundlePath, { force: true }), fs.rm(profilesBundlePath, { force: true })]);
}
