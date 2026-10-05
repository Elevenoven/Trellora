import type {
  ContextChannel,
  ContextEnvelope,
  ContextMaterial,
  ContextProjection,
  ContextTrust,
} from './contextRuntimeTypes';

const stablePrefixZones = new Set(['stable-policy', 'project-context', 'output-contract']);

export interface ContextProjectionOccurrenceRequirement {
  label: string;
  value: string;
  channel?: Extract<ContextChannel, 'system' | 'user'>;
}

export function isContextTrustChannelAllowed(trust: ContextTrust, channel: ContextChannel): boolean {
  if (trust === 'trusted-policy') return channel === 'system';
  if (trust === 'trusted-state') return channel === 'system' || channel === 'user';
  if (trust === 'untrusted-memory') return channel === 'user';
  return channel === 'user' || channel === 'tool';
}

export function collectContextEnvelopeInvariantViolations(envelope: ContextEnvelope): string[] {
  const violations: string[] = [];
  if (envelope.schemaVersion !== 1) violations.push('ContextEnvelope schemaVersion 必须为 1。');
  if (!envelope.scope.workspaceId.trim()) violations.push('ContextEnvelope workspaceId 不能为空。');
  if (!envelope.windowProfile.providerId.trim() || !envelope.windowProfile.modelId.trim()) violations.push('Runtime Profile 缺少 Provider 或 Model 标识。');
  if (!Number.isSafeInteger(envelope.windowProfile.effectiveContextTokens) || envelope.windowProfile.effectiveContextTokens < 1) violations.push('Runtime Profile effectiveContextTokens 必须是正整数。');

  const ids = new Set<string>();
  for (const material of envelope.materials) {
    if (!material.id.trim()) violations.push('ContextMaterial id 不能为空。');
    else if (ids.has(material.id)) violations.push(`ContextMaterial id 重复：${material.id}`);
    ids.add(material.id);
    violations.push(...collectMaterialInvariantViolations(material));
  }
  return violations;
}

export function assertContextEnvelopeInvariants(envelope: ContextEnvelope): void {
  const violations = collectContextEnvelopeInvariantViolations(envelope);
  if (violations.length) throw new Error(violations.join(' '));
}

export function collectContextProjectionInvariantViolations(
  envelope: ContextEnvelope,
  projection: ContextProjection,
  requirements: readonly ContextProjectionOccurrenceRequirement[] = [],
): string[] {
  const violations = collectContextEnvelopeInvariantViolations(envelope);
  if (!/^[a-f0-9]{64}$/u.test(projection.stablePrefixFingerprint)) violations.push('稳定前缀指纹必须是 SHA-256。');
  if (projection.included.length + projection.omitted.length !== envelope.materials.length) violations.push('Projection 的 included/omitted 数量与候选材料不一致。');
  if (new Set(projection.included.map((material) => material.id)).size !== projection.included.length) violations.push('Projection included 中存在重复 Material。');
  if (projection.included.some((material, index) => material.order !== index)) violations.push('Projection Material 顺序编号不连续。');

  const lastUserMaterial = [...projection.included].reverse().find((material) => material.channel === 'user');
  if (projection.included.some((material) => material.channel === 'user' && material.zone === 'current-request')
    && lastUserMaterial?.zone !== 'current-request') {
    violations.push('当前问题必须位于 User Channel 动态内容末端。');
  }

  for (const requirement of requirements) {
    const target = requirement.channel === 'system'
      ? projection.systemPrompt
      : requirement.channel === 'user'
        ? projection.userPrompt
        : `${projection.systemPrompt}\n${projection.userPrompt}`;
    const occurrences = countExactOccurrences(target, requirement.value);
    if (occurrences !== 1) violations.push(`${requirement.label}必须恰好出现一次，实际 ${occurrences} 次。`);
  }
  return violations;
}

export function assertContextProjectionInvariants(
  envelope: ContextEnvelope,
  projection: ContextProjection,
  requirements: readonly ContextProjectionOccurrenceRequirement[] = [],
): void {
  const violations = collectContextProjectionInvariantViolations(envelope, projection, requirements);
  if (violations.length) throw new Error(violations.join(' '));
}

function collectMaterialInvariantViolations(material: ContextMaterial): string[] {
  const violations: string[] = [];
  if (!isContextTrustChannelAllowed(material.trust, material.channel)) violations.push(`Material ${material.id} 的 Trust/Channel 组合非法。`);
  if (material.zone === 'user-profile') {
    if (material.channel !== 'user' || material.trust !== 'untrusted-memory') violations.push(`Material ${material.id} 的用户画像必须位于 User Channel 且保持 untrusted-memory。`);
    if (material.protected) violations.push(`Material ${material.id} 的用户画像不得标记为受保护材料。`);
    if (material.cache.prefixEligible) violations.push(`Material ${material.id} 的用户画像不得进入稳定前缀。`);
    if (material.source.kind !== 'user-profile') violations.push(`Material ${material.id} 的用户画像来源类型无效。`);
    if (material.provenance?.evidenceIds?.length) violations.push(`Material ${material.id} 的用户画像不得声明知识库证据身份。`);
  } else if (material.source.kind === 'user-profile') {
    violations.push(`Material ${material.id} 不得把用户画像伪装为其他 Context Zone。`);
  }
  if (!material.content.trim()) violations.push(`Material ${material.id} 内容不能为空。`);
  if (!Number.isFinite(material.priority)) violations.push(`Material ${material.id} priority 无效。`);
  if (material.diagnosticCandidateTokens !== undefined
    && (!Number.isSafeInteger(material.diagnosticCandidateTokens) || material.diagnosticCandidateTokens < 0)) {
    violations.push(`Material ${material.id} 的诊断候选 Token 无效。`);
  }
  if (material.admission) {
    if (!material.admission.key.trim()) violations.push(`Material ${material.id} 的准入 key 不能为空。`);
    if (!material.admission.activationReason.trim()) violations.push(`Material ${material.id} 的准入原因不能为空。`);
    if (material.admission.kind === 'tool-definition' && !material.admission.phase?.trim()) {
      violations.push(`Material ${material.id} 的工具定义缺少阶段。`);
    }
  }
  if (material.lifecycle?.sequence !== undefined
    && (!Number.isSafeInteger(material.lifecycle.sequence) || material.lifecycle.sequence < 0)) {
    violations.push(`Material ${material.id} 的生命周期序号无效。`);
  }
  if (!material.source.kind.trim() || !material.source.id.trim() || !material.source.version.trim()) violations.push(`Material ${material.id} 来源标识不完整。`);
  if (material.channel === 'tool' && !material.toolName?.trim()) violations.push(`Tool Material ${material.id} 缺少 toolName。`);
  if (material.cache.prefixEligible) {
    if (material.channel !== 'system') violations.push(`Material ${material.id} 不是 System Channel，不能进入稳定前缀。`);
    if (!stablePrefixZones.has(material.zone)) violations.push(`Material ${material.id} 的 Zone 不能进入稳定前缀。`);
    if (material.cache.stability !== 'stable') violations.push(`Material ${material.id} 不是 stable，不能进入稳定前缀。`);
  }
  return violations;
}

function countExactOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= value.length - needle.length) {
    const found = value.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}
