import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const types = read('electron', 'knowledge', 'selectionEditTypes.ts');
const profiles = read('electron', 'knowledge', 'selectionEditProfiles.ts');
const legacyTransform = read('electron', 'knowledge', 'selectionTransformTypes.ts');
const legacyExpansion = read('electron', 'knowledge', 'selectionExpansionTypes.ts');
const plan = read('docs', 'Trellora-2.0-上下文感知选区AI编辑统一开发方案.md');
const packageJson = read('package.json');

const expectedActions = ['polish', 'shorten', 'expand', 'proofread', 'explain', 'translate', 'custom'];
for (const action of expectedActions) {
  assert.match(types, new RegExp(`'${action}'`), `统一合同必须保留“${action}”动作。`);
  assert.match(profiles, new RegExp(`\\b${action}: \\{`), `动作画像必须定义“${action}”。`);
  assert.match(legacyTransform, new RegExp(`'${action}'`), `迁移前必须确认旧变换链仍含“${action}”。`);
}

assert.match(types, /selectionEditContextScopes = \['auto', 'nearby', 'current-note', 'extended'\]/, '统一合同必须固定四种上下文范围。');
assert.match(types, /selectionEditFactSourceKinds = \['current-note', 'note-library', 'materials', 'web'\]/, '事实来源与来源卡必须有固定枚举。');
assert.match(types, /selectionEditPreferenceSourceKinds = \['personalization'\]/, '个性化来源必须与事实来源分离。');
assert.match(types, /interface SelectionSnapshotV2/, 'SE-2 所需的结构化选区快照必须先有共享合同。');
assert.match(types, /noteContentHash: string/, '结构化选区快照必须绑定笔记内容哈希。');
assert.match(types, /markdownFragment: string/, '结构化选区快照必须保留 Markdown 片段。');
assert.match(types, /sliceJson: unknown/, '结构化选区快照必须预留 ProseMirror Slice 合同。');
assert.match(types, /interface SelectionContextReceipt/, '统一结果必须具备上下文收据。');
assert.match(types, /readVerified: boolean/, '候选来源必须显式区分是否已读核验。');
assert.match(types, /unsupportedClaims: string\[\]/, '结果验证必须能报告无证据支持的 claim。');
for (const issueCode of [
  'EXPAND_NOT_LONGER',
  'TARGET_LENGTH_MISSED',
  'PROTECTED_ANCHOR_LOST',
  'UNSUPPORTED_ADDITION',
  'EVIDENCE_GOAL_UNCOVERED',
  'WEB_PAGE_UNVERIFIED',
  'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
]) {
  assert.match(types, new RegExp(`'${issueCode}'`), `统一质量问题合同必须固定 ${issueCode}。`);
}
assert.match(types, /interface SelectionEditQualityIssue \{[\s\S]*?retryable: boolean;/, '结构化问题必须包含稳定代码、消息和可重试标记。');
assert.match(types, /interface SelectionEditQualityReceipt \{[\s\S]*?generation:[\s\S]*?evidenceCoverage:[\s\S]*?validation:[\s\S]*?issues:/, 'RA-0 必须冻结 RA-4 将使用的质量回执形状。');
assert.match(types, /issues: SelectionEditQualityIssue\[\]/, '现有验证结果必须同步投影结构化问题，供兼容期消费。');
assert.match(types, /selectionEditWritebackModes = \['replace', 'insert-below', 'copy-only'\]/, '统一合同必须固定三种写回偏好。');
assert.match(types, /selectionEditStages = \[/, '统一任务状态机必须有共享阶段合同。');
assert.doesNotMatch(types, /ipcMain|generateAiText|readTextFile|window\.electronAPI/, 'SE-0 类型合同不得引入运行时权力。');

assert.match(profiles, /satisfies Record<SelectionEditAction, SelectionEditActionProfile>/, '动作画像必须穷尽七种统一动作。');
assert.match(profiles, /expand: \{[\s\S]*?defaultWritebackMode: 'insert-below'[\s\S]*?evidencePolicy: 'require-for-new-facts'/, '扩写必须默认插入并要求新增事实有证据。');
assert.match(profiles, /explain: \{[\s\S]*?defaultWritebackMode: 'insert-below'[\s\S]*?evidencePolicy: 'require-for-new-facts'/, '解释必须默认插入并要求新增事实有证据。');
assert.match(profiles, /custom: \{[\s\S]*?contextStrategy: 'content-classified'[\s\S]*?defaultWritebackMode: 'copy-only'[\s\S]*?evidencePolicy: 'when-additive'/, '自定义动作必须先分类，默认不直接写回。');
assert.match(profiles, /web: false/, 'SE-0 默认不得假装网页来源已经可用。');
assert.match(profiles, /personalization: false/, 'SE-0 默认不得自动引入个性化记忆。');

assert.match(legacyExpansion, /sourceKind: SelectionEditFactSourceKind/, 'SE-5 后扩写兼容层必须保留真实的本地证据来源。');
assert.match(legacyExpansion, /locator: string/, 'SE-5 后扩写证据必须保留可定位的原文位置。');
assert.match(plan, /### SE-0：合同与基线/, '统一方案必须保留 SE-0 Gate。');
assert.match(plan, /每次只推进一个 `SE-\*` 阶段/, '统一方案必须禁止跨阶段推进。');
assert.match(packageJson, /"verify:selection-edit-contract": "node scripts\/verify-selection-edit-contract\.mjs"/, 'package.json 必须登记 SE-0 合同验证。');

console.log('Selection edit SE-0 contract verification passed');
