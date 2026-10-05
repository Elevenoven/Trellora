import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `context-admission-pressure-${process.pid}-${Date.now()}`);
const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'menghan-context-phase1-'));
const outputs = Object.fromEntries(['catalog', 'skills', 'attachments', 'loader', 'pressure', 'breaker'].map((name) => [name, path.join(stagingRoot, `${name}.cjs`)]));

mkdirSync(stagingRoot, { recursive: true });
try {
  await Promise.all([
    bundle('electron/knowledge/toolCapabilityCatalog.ts', outputs.catalog),
    bundle('electron/knowledge/skillDefinitionResolver.ts', outputs.skills),
    bundle('electron/knowledge/attachmentContextProvider.ts', outputs.attachments),
    bundle('electron/knowledge/lazyContextLoader.ts', outputs.loader),
    bundle('electron/knowledge/contextPressureController.ts', outputs.pressure),
    bundle('electron/knowledge/contextPressureCircuitBreaker.ts', outputs.breaker),
  ]);
  const catalogModule = await load(outputs.catalog);
  const skillModule = await load(outputs.skills);
  const attachmentModule = await load(outputs.attachments);
  const { LazyContextLoader } = await load(outputs.loader);
  const { ContextArtifactStore, ContextPressureController } = await load(outputs.pressure);
  const { ContextPressureCircuitBreaker, createContextMaterialFingerprint } = await load(outputs.breaker);

  const navigationPrompt = catalogModule.renderToolCapabilityPrompt({ source: 'current-note', activePhases: ['navigation'] });
  assert.match(navigationPrompt, /read_note_range \[reading\]/u, '目录必须保留未激活工具的短描述');
  assert.match(navigationPrompt, /get_note_map\(detail=/u, '当前阶段定义必须展开');
  assert.doesNotMatch(navigationPrompt, /read_note_range\(lineFrom/u, '未激活阶段不得展开参数定义');
  assert.equal(catalogModule.isToolCapabilityActive('read_note_range', ['navigation']), false);

  const resolvedSkills = skillModule.resolveSkillDefinitions([
    skill('selected', '显式 Skill', '把会议内容整理为行动项。', 'SELECTED_BODY_SENTINEL'),
    skill('hidden', '未选择 Skill', '只展示这一句短描述。', 'UNSELECTED_SECRET_BODY'),
  ], ['selected']);
  assert.equal(resolvedSkills.selected.length, 1);
  assert.equal(JSON.stringify(resolvedSkills.catalog).includes('UNSELECTED_SECRET_BODY'), false, 'Skill 目录不得带入正文');
  assert.equal(resolvedSkills.selected[0].instruction, 'SELECTED_BODY_SENTINEL');

  const attachmentPath = path.join(workspaceRoot, 'phase1-attachment.md');
  const attachmentText = ['ATTACHMENT_HEAD_SENTINEL', ...Array.from({ length: 150 }, (_, index) => `第 ${index + 1} 行普通内容`), '关键术语：pressure episode 与材料指纹', 'ATTACHMENT_TAIL_SENTINEL'].join('\n');
  writeFileSync(attachmentPath, attachmentText, 'utf8');
  const attachmentProvider = new attachmentModule.AttachmentContextProvider([{ kind: 'text', attachmentId: 'text-fixture-pressure-01', path: attachmentPath, name: 'phase1-attachment.md' }]);
  const [metadata] = attachmentProvider.listMetadata();
  const metadataPrompt = attachmentModule.renderAttachmentMetadata(metadata);
  assert.doesNotMatch(metadataPrompt, /ATTACHMENT_(?:HEAD|TAIL)_SENTINEL/u, '附件元数据不得携带正文');
  assert.doesNotMatch(metadataPrompt, new RegExp(escapeRegExp(workspaceRoot), 'u'), '附件元数据不得携带绝对路径');
  const [hit] = attachmentProvider.search('pressure episode 材料指纹');
  assert.ok(hit, '附件搜索应返回有界范围');
  const range = attachmentProvider.readRange(hit);
  assert.match(range.text, /pressure episode/u);
  assert.ok(range.lineTo - range.lineFrom < 80);
  assert.ok(range.text.length <= 4_000);
  assert.notEqual(range.text, readFileSync(attachmentPath, 'utf8'), '范围读取不得退化为整文件投影');

  const admissionEnvelope = envelope(workspaceRoot, 16_384, [
    material('policy', 'stable-policy', 'system', 'trusted-policy', '固定策略', { protected: true }),
    material('tool-catalog', 'agent-state', 'system', 'trusted-state', 'TOOL_CATALOG', { protected: true, admission: admission('tool-catalog', 'current-note', true) }),
    material('tool-nav', 'agent-state', 'system', 'trusted-state', 'NAV_DEF', { admission: admission('tool-definition', 'get_note_map', false, 'navigation') }),
    material('tool-read', 'agent-state', 'system', 'trusted-state', 'READ_DEF_SENTINEL', { admission: admission('tool-definition', 'read_note_range', false, 'reading') }),
    material('skill-desc', 'project-context', 'system', 'trusted-policy', 'SKILL_DESCRIPTION', { protected: true, admission: admission('skill-description', 'skills', true) }),
    material('skill-selected', 'project-context', 'system', 'trusted-policy', 'SELECTED_BODY_SENTINEL', { protected: true, admission: admission('skill-body', 'selected', false) }),
    material('skill-hidden', 'project-context', 'system', 'trusted-policy', 'UNSELECTED_SECRET_BODY', { admission: admission('skill-body', 'hidden', false) }),
    material('attachment-meta', 'dynamic-evidence', 'user', 'untrusted-evidence', metadataPrompt, { admission: admission('attachment-metadata', metadata.attachmentId, true) }),
    material('attachment-body', 'dynamic-evidence', 'user', 'untrusted-evidence', 'UNREAD_ATTACHMENT_BODY', { admission: admission('attachment-content', metadata.attachmentId, false) }),
    material('question', 'current-request', 'user', 'untrusted-memory', '当前问题', { protected: true }),
  ]);
  const admitted = new LazyContextLoader().admit(admissionEnvelope, { activePhases: ['navigation'], selectedSkillIds: ['selected'] });
  const admittedText = admitted.envelope.materials.map((entry) => entry.content).join('\n');
  assert.match(admittedText, /NAV_DEF/u);
  assert.match(admittedText, /SELECTED_BODY_SENTINEL/u);
  assert.doesNotMatch(admittedText, /READ_DEF_SENTINEL|UNSELECTED_SECRET_BODY|UNREAD_ATTACHMENT_BODY/u);
  assert.equal(admitted.diagnostics.deferredMaterials, 3);

  const artifactStore = new ContextArtifactStore(workspaceRoot);
  const breaker = new ContextPressureCircuitBreaker();
  const pressureEnvelope = envelope(workspaceRoot, 16_384, [
    material('policy', 'stable-policy', 'system', 'trusted-policy', '策'.repeat(900), { protected: true }),
    material('conversation', 'conversation-hot', 'user', 'untrusted-memory', '会'.repeat(2_000)),
    material('question', 'current-request', 'user', 'untrusted-memory', '当前问题', { protected: true }),
    material('tool-large', 'tool-observation', 'tool', 'untrusted-evidence', '大'.repeat(4_000), { toolName: 'search_note', lifecycle: lifecycle(10, 'completed', true) }),
    material('tool-stale', 'tool-observation', 'tool', 'untrusted-evidence', '旧'.repeat(500), { toolName: 'search_note', lifecycle: lifecycle(1, 'stale', true) }),
    material('duplicate-a', 'dynamic-evidence', 'user', 'untrusted-evidence', '重'.repeat(1_000), { compressStrategy: 'reference' }),
    material('duplicate-b', 'dynamic-evidence', 'user', 'untrusted-evidence', '重'.repeat(1_000), { compressStrategy: 'reference' }),
    material('cold-evidence', 'dynamic-evidence', 'user', 'untrusted-evidence', '证'.repeat(5_000), { compressStrategy: 'reference', contentHash: 'cold-hash' }),
    material('trace-1', 'agent-state', 'user', 'trusted-state', '轨'.repeat(1_500), { lifecycle: lifecycle(1, 'completed', true), sourceKind: 'planner-trace' }),
    material('trace-2', 'agent-state', 'user', 'trusted-state', '迹'.repeat(1_500), { lifecycle: lifecycle(2, 'completed', true), sourceKind: 'planner-trace' }),
    material('drop-filler', 'dynamic-evidence', 'user', 'untrusted-evidence', '填'.repeat(3_000), { overflowPolicy: 'drop' }),
  ]);
  const originalConversation = pressureEnvelope.materials.find((entry) => entry.id === 'conversation').content;
  const pressureController = new ContextPressureController({ artifactStore, artifactThresholdTokens: 500, canReadSource: () => true });
  const relieved = pressureController.relieveNonConversation({ envelope: pressureEnvelope, circuitBreaker: breaker });
  const actionKinds = relieved.actions.map((action) => action.kind);
  assert.equal(relieved.actions[0].level, 0, '大型 Tool 输出必须在 P0 立即 Artifact 化');
  assert.ok(actionKinds.includes('old-tool-cleanup'));
  assert.ok(actionKinds.includes('cold-reference'));
  assert.ok(actionKinds.includes('trace-state'));
  assert.equal(relieved.envelope.materials.some((entry) => entry.id === 'tool-stale'), false);
  assert.equal(relieved.envelope.materials.find((entry) => entry.id === 'conversation').content, originalConversation, 'P1/P2 不得改写会话材料');
  const artifactAction = relieved.actions.find((action) => action.kind === 'artifact-reference');
  assert.ok(artifactAction?.artifactId);
  const artifact = artifactStore.read({ sessionId: pressureEnvelope.scope.sessionId, turnId: pressureEnvelope.scope.turnId, artifactId: artifactAction.artifactId });
  assert.equal(artifact.sha256.length, 64);
  assert.equal(relieved.diagnostics.materialFingerprint, createContextMaterialFingerprint(pressureEnvelope));
  assert.ok(relieved.diagnostics.finalUWindow < relieved.diagnostics.initialUWindow);
  assert.ok(relieved.diagnostics.actions.every((action) => action.releasedTokens >= 0));

  const zeroGainEnvelope = envelope(workspaceRoot, 16_384, [
    material('policy', 'stable-policy', 'system', 'trusted-policy', '固定策略', { protected: true }),
    material('conversation', 'conversation-hot', 'user', 'untrusted-memory', '会'.repeat(12_500)),
    material('question', 'current-request', 'user', 'untrusted-memory', '问题', { protected: true }),
  ], 'zero-session');
  const zeroBreaker = new ContextPressureCircuitBreaker();
  pressureController.relieveNonConversation({ envelope: zeroGainEnvelope, circuitBreaker: zeroBreaker });
  const repeated = pressureController.relieveNonConversation({ envelope: zeroGainEnvelope, circuitBreaker: zeroBreaker });
  assert.ok(repeated.diagnostics.skippedZeroGainActions.includes('p1-tool-cleanup'), '同指纹零收益动作必须跳过');
  assert.equal(repeated.diagnostics.stoppedReason, 'repeated-zero-gain');

  console.log('Context admission and P1/P2 pressure verification passed');
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}

function envelope(workspaceId, effectiveContextTokens, materials, sessionId = 'phase1-session') {
  return {
    schemaVersion: 1,
    route: 'chat',
    callKind: 'chat',
    scope: { workspaceId, sessionId, turnId: 'phase1-turn' },
    windowProfile: {
      providerId: 'fixture-provider', modelId: 'fixture-model', runtimeProfileId: 'custom', physicalContextTokens: effectiveContextTokens,
      physicalSource: 'provider', productCapMode: 'follow-model', productCeilingTokens: effectiveContextTokens,
      effectiveContextTokens, autoCompactAtTokens: Math.floor(effectiveContextTokens * 0.92), reservedOutputTokens: 1_000, safetyTokens: 500, warnings: [],
    },
    materials,
    invariants: [],
    stateVector: {},
  };
}

function material(id, zone, channel, trust, content, options = {}) {
  return {
    id, zone, channel, trust, content, priority: options.priority ?? 50, protected: options.protected ?? false,
    compressStrategy: options.compressStrategy ?? 'none',
    source: { kind: options.sourceKind ?? 'phase1-fixture', id, version: 'v1', ...(options.contentHash ? { contentHash: options.contentHash } : {}) },
    stalePolicy: 'keep', overflowPolicy: options.overflowPolicy ?? (options.protected ? 'fail' : 'compress'),
    cache: { stability: zone === 'stable-policy' ? 'stable' : 'turn', prefixEligible: zone === 'stable-policy' },
    ...(options.admission ? { admission: options.admission } : {}),
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
  };
}

function admission(kind, key, activeByDefault, phase) {
  return { kind, key, activeByDefault, activationReason: `${kind} fixture`, ...(phase ? { phase } : {}) };
}

function lifecycle(sequence, status, rereadable) {
  return { sequence, status, rereadable, activeDependency: false };
}

function skill(id, name, description, instruction) {
  return { id, name, description, instruction, generationStyle: 'balanced', enabled: true, system: false };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bundle(relativePath, outfile) {
  return build({ entryPoints: [path.join(rootDir, relativePath)], outfile, bundle: true, platform: 'node', format: 'cjs' });
}

function load(filePath) {
  return import(pathToFileURL(filePath).href);
}
