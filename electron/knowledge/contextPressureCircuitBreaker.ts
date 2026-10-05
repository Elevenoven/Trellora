import { createHash } from 'node:crypto';
import type { ContextEnvelope, ContextPressureActionDiagnostics } from './contextRuntimeTypes';

interface PressureEpisodeState {
  pressureEpisodeId: string;
  fingerprint: string;
  windowTokens: number;
  zeroGainActions: Set<string>;
  consecutiveIneffectiveGains: number;
  updatedAt: number;
}

export interface PressureEpisodeHandle {
  pressureEpisodeId: string;
  materialFingerprint: string;
  minPressureGainTokens: number;
  shouldSkip(actionKey: string): boolean;
  record(actionKey: string, action: Pick<ContextPressureActionDiagnostics, 'beforeTokens' | 'afterTokens'>): {
    ineffective: boolean;
    tripped: boolean;
  };
}

const MAX_EPISODES = 100;

/** In-process episode memory only. It never mutates Prompt authority or conversation state. */
export class ContextPressureCircuitBreaker {
  private readonly episodes = new Map<string, PressureEpisodeState>();

  begin(input: { envelope: ContextEnvelope; fingerprint?: string }): PressureEpisodeHandle {
    const fingerprint = input.fingerprint ?? createContextMaterialFingerprint(input.envelope);
    const windowTokens = input.envelope.windowProfile.effectiveContextTokens;
    const sessionKey = hash(`${input.envelope.scope.sessionId ?? input.envelope.scope.turnId ?? 'anonymous'}\u0000${input.envelope.route}`);
    let state = this.episodes.get(sessionKey);
    if (!state || state.fingerprint !== fingerprint || windowTokens > state.windowTokens) {
      state = {
        pressureEpisodeId: `pressure-${hash(`${sessionKey}\u0000${fingerprint}\u0000${windowTokens}`).slice(0, 24)}`,
        fingerprint,
        windowTokens,
        zeroGainActions: new Set(),
        consecutiveIneffectiveGains: 0,
        updatedAt: Date.now(),
      };
      this.episodes.set(sessionKey, state);
      this.trim();
    }
    state.updatedAt = Date.now();
    const minPressureGainTokens = Math.max(2_048, Math.floor(windowTokens * 0.01));
    return {
      pressureEpisodeId: state.pressureEpisodeId,
      materialFingerprint: fingerprint,
      minPressureGainTokens,
      shouldSkip: (actionKey) => state!.zeroGainActions.has(actionKey),
      record: (actionKey, action) => {
        const gain = Math.max(0, action.beforeTokens - action.afterTokens);
        if (gain === 0) state!.zeroGainActions.add(actionKey);
        if (gain < minPressureGainTokens) state!.consecutiveIneffectiveGains += 1;
        else state!.consecutiveIneffectiveGains = 0;
        state!.updatedAt = Date.now();
        return { ineffective: gain < minPressureGainTokens, tripped: state!.consecutiveIneffectiveGains >= 2 };
      },
    };
  }

  clear(): void {
    this.episodes.clear();
  }

  private trim(): void {
    if (this.episodes.size <= MAX_EPISODES) return;
    const oldest = [...this.episodes.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [key] of oldest.slice(0, this.episodes.size - MAX_EPISODES)) this.episodes.delete(key);
  }
}

export function createContextMaterialFingerprint(envelope: ContextEnvelope): string {
  return hash(JSON.stringify({
    route: envelope.route,
    callKind: envelope.callKind,
    materials: [...envelope.materials]
      .map((material) => ({
        id: material.id,
        zone: material.zone,
        channel: material.channel,
        source: material.source,
        contentHash: hash(material.content),
        lifecycle: material.lifecycle,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
