import { createHash } from 'node:crypto';
import { estimateTokenCount } from './tokenEstimator';
import { assertContextEnvelopeInvariants, assertContextProjectionInvariants } from './contextProjectionInvariants';
import {
  CONTEXT_REQUEST_ENVELOPE_VERSION,
  type ContextChannel,
  type ContextEnvelope,
  type ContextMaterial,
  type ContextProjection,
  type ContextZone,
  type ProjectedContextMaterial,
} from './contextRuntimeTypes';

const channelOrder: Record<ContextChannel, number> = { system: 0, user: 1, tool: 2 };
const zoneOrder: Record<ContextZone, number> = {
  'stable-policy': 10,
  'project-context': 20,
  'user-profile': 30,
  'long-term-memory': 35,
  'output-contract': 40,
  'agent-state': 50,
  'conversation-summary': 60,
  'conversation-hot': 70,
  'conversation-recall': 80,
  'note-capsule': 90,
  'dynamic-evidence': 100,
  'tool-observation': 110,
  'current-request': 120,
};

export interface RenderContextEnvelopeOptions {
  requestEnvelopeVersion?: string;
}

export function renderContextEnvelope(
  envelope: ContextEnvelope,
  options: RenderContextEnvelopeOptions = {},
): ContextProjection {
  assertContextEnvelopeInvariants(envelope);
  const requestEnvelopeVersion = options.requestEnvelopeVersion?.trim() || CONTEXT_REQUEST_ENVELOPE_VERSION;
  const ordered = [...envelope.materials].sort(compareContextMaterial);
  const systemMaterials = ordered.filter((material) => material.channel === 'system');
  const userMaterials = ordered.filter((material) => material.channel === 'user');
  const toolMaterials = ordered.filter((material) => material.channel === 'tool');
  const systemPrompt = joinMaterialContents(systemMaterials);
  const userPrompt = joinMaterialContents(userMaterials);
  const toolMessages = toolMaterials.map((material) => ({
    name: material.toolName?.trim() || material.source.kind,
    content: material.content,
  }));
  const serializedBudgetText = serializeContextRoleMessagesForBudget(systemPrompt, userPrompt, toolMessages);
  const included: ProjectedContextMaterial[] = ordered.map((material, order) => ({
    id: material.id,
    zone: material.zone,
    channel: material.channel,
    trust: material.trust,
    priority: material.priority,
    protected: material.protected,
    source: { ...material.source },
    estimatedTokens: estimateTokenCount(material.content),
    contentSha256: sha256(material.content),
    order,
  }));
  const projection: ContextProjection = {
    systemPrompt,
    userPrompt,
    ...(toolMessages.length ? { toolMessages } : {}),
    serializedBudgetText,
    requestEnvelopeVersion,
    pressureLevel: 0,
    included,
    omitted: [],
    stats: {
      candidateMaterials: envelope.materials.length,
      includedMaterials: included.length,
      omittedMaterials: 0,
      systemMaterials: systemMaterials.length,
      userMaterials: userMaterials.length,
      toolMaterials: toolMaterials.length,
      systemTokens: estimateTokenCount(systemPrompt),
      userTokens: estimateTokenCount(userPrompt),
      toolTokens: toolMessages.reduce((total, message) => total + estimateTokenCount(message.name) + estimateTokenCount(message.content), 0),
      serializedTokens: estimateTokenCount(serializedBudgetText),
    },
    stablePrefixFingerprint: createStablePrefixFingerprint(envelope, requestEnvelopeVersion),
  };
  assertContextProjectionInvariants(envelope, projection);
  return projection;
}

export function createStablePrefixFingerprint(envelope: ContextEnvelope, requestEnvelopeVersion = CONTEXT_REQUEST_ENVELOPE_VERSION): string {
  const stableMaterials = [...envelope.materials]
    .filter((material) => material.cache.prefixEligible)
    .sort(compareContextMaterial)
    .map((material) => ({
      id: material.id,
      zone: material.zone,
      channel: material.channel,
      sourceKind: material.source.kind,
      sourceId: material.source.id,
      sourceVersion: material.source.version,
      content: normalizeStableContent(material.content),
    }));
  return sha256(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    requestEnvelopeVersion,
    materials: stableMaterials,
  }));
}

export function compareContextMaterial(first: ContextMaterial, second: ContextMaterial): number {
  return channelOrder[first.channel] - channelOrder[second.channel]
    || zoneOrder[first.zone] - zoneOrder[second.zone]
    || second.priority - first.priority
    || compareText(first.id, second.id)
    || compareText(first.source.id, second.source.id);
}

function joinMaterialContents(materials: readonly ContextMaterial[]): string {
  return materials.map((material) => material.content).join('\n\n');
}

/** Stable role serialization used by the scheduler, calibration key, and renderer. */
export function serializeContextRoleMessagesForBudget(
  systemPrompt: string,
  userPrompt: string,
  toolMessages: readonly { name: string; content: string }[],
): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`[role:system]\n${systemPrompt}`);
  if (userPrompt) parts.push(`[role:user]\n${userPrompt}`);
  for (const message of toolMessages) parts.push(`[role:tool name=${message.name}]\n${message.content}`);
  return parts.join('\n\n');
}

function normalizeStableContent(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .trim();
}

function compareText(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
