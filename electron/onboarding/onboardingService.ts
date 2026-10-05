import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AiModelProfile, AiProviderConfig } from '../knowledge/aiTypes';
import type { OnboardingAction, OnboardingPracticeBinding, OnboardingProgress, OnboardingState, OnboardingUpdate } from '../../shared/onboarding';

interface OnboardingPorts {
  read: () => unknown;
  write: (progress: OnboardingProgress) => void;
  hasUsage: () => boolean;
  profiles: () => AiModelProfile[];
  defaultProfileId: () => string;
  paths: () => { workspacePath: string; libraryPath: string | null };
  notify: (state: OnboardingState) => void;
}

interface TestRecord { token: string; fingerprint: string; available?: boolean }
interface PracticeRequest { senderId: number; sessionId: string; profileId: string; fingerprint: string }
const actions: readonly OnboardingAction[] = ['start', 'acknowledge-menus', 'skip-ai', 'defer', 'resume', 'dismiss', 'finish', 'show-ai', 'show-question'];
const statuses = ['pending', 'active', 'deferred', 'completed', 'dismissed'];
const steps = ['menus', 'ai', 'question'];

/** Migrate once without turning legacy completion into completion of the new course. */
export function migrateOnboarding(value: unknown, hasUsage: boolean): OnboardingProgress {
  const previous = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (previous.version === 2) {
    const progress = previous.progress as OnboardingProgress['progress'] | undefined;
    if (!statuses.includes(String(previous.status)) || !steps.includes(String(previous.currentStep))
      || !Number.isSafeInteger(previous.revision) || Number(previous.revision) < 0
      || !progress || !['pending', 'done'].includes(progress.menus)
      || !['pending', 'skipped', 'done'].includes(progress.ai) || !['pending', 'done'].includes(progress.question)) {
      throw new Error('引导状态无效，请从设置中重试。');
    }
    // Whitelist persisted fields, including when reading an older renderer's result.
    return {
      version: 2, flowVersion: 1, revision: Number(previous.revision),
      status: previous.status as OnboardingProgress['status'], currentStep: previous.currentStep as OnboardingProgress['currentStep'],
      progress: { ...progress }, sampleImported: Boolean(previous.sampleImported),
      updatedAt: typeof previous.updatedAt === 'string' ? previous.updatedAt : new Date().toISOString(),
      ...(typeof previous.selectedProfileId === 'string' ? { selectedProfileId: previous.selectedProfileId } : {}),
      ...(typeof previous.practiceSessionId === 'string' ? { practiceSessionId: previous.practiceSessionId } : {}),
      ...(typeof previous.successfulRequestId === 'string' ? { successfulRequestId: previous.successfulRequestId } : {}),
      ...(typeof previous.completedAt === 'string' ? { completedAt: previous.completedAt } : {}),
    };
  }
  const legacyPending = previous.version === 1 && previous.status === 'pending';
  const legacyEnded = previous.version === 1 && ['skipped', 'completed'].includes(String(previous.status));
  return {
    version: 2, flowVersion: 1, revision: 0,
    status: legacyEnded || (!legacyPending && (hasUsage || previous.sampleImported)) ? 'dismissed' : 'pending',
    currentStep: 'menus', progress: { menus: 'pending', ai: 'pending', question: 'pending' },
    sampleImported: Boolean(previous.sampleImported), updatedAt: new Date().toISOString(),
  };
}

/** Tests and request attestations remain process-local and never contain a plaintext key. */
export class OnboardingService {
  private progress?: OnboardingProgress;
  private readonly salt = randomBytes(32);
  private readonly tests = new Map<string, TestRecord>();
  private readonly requests = new Map<string, PracticeRequest>();
  private readonly bindings = new Map<number, { sessionId: string; profileId: string }>();
  private readonly savedFingerprints = new Map<string, string>();

  constructor(private readonly ports: OnboardingPorts) {}

  initialize(): OnboardingState {
    const value = this.ports.read();
    const progress = migrateOnboarding(value, value ? false : this.ports.hasUsage());
    if (!value || (value as { version?: unknown }).version !== 2) this.ports.write(progress);
    this.progress = progress;
    for (const profile of this.ports.profiles()) this.savedFingerprints.set(profile.id, this.fingerprint(profile.config));
    return this.get();
  }

  /** The saved connection is rechecked each read; a historical check is not runtime readiness. */
  get(): OnboardingState {
    if (!this.progress) return this.initialize();
    const profiles = this.ports.profiles();
    const selectedId = this.progress.selectedProfileId ?? this.ports.defaultProfileId();
    const preferred = profiles.find(item => item.id === selectedId);
    const profile = preferred && this.isConfigured(preferred.config) ? preferred
      : profiles.find(item => item.id === this.ports.defaultProfileId() && this.isConfigured(item.config))
        ?? profiles.find(item => this.isConfigured(item.config)) ?? preferred;
    const configured = profile && this.isConfigured(profile.config);
    const record = profile ? this.tests.get(profile.id) : undefined;
    const matches = profile && record?.fingerprint === this.fingerprint(profile.config);
    const state = !configured ? 'missing' : matches && record?.available === true ? 'tested'
      : matches && record?.available === false ? 'failed' : 'saved-unverified';
    return { ...this.progress, progress: { ...this.progress.progress }, ...this.ports.paths(),
      connection: { profileId: profile?.id ?? null, state, testAttempted: Boolean(matches && record?.available !== undefined) } };
  }

  update(input: OnboardingUpdate): OnboardingState {
    if (!input || !actions.includes(input.action)) throw new Error('引导操作无效。');
    this.checkRevision(input.expectedRevision);
    const state = this.get();
    if (state.status === 'completed') {
      if (input.action === 'finish') return state;
      throw new Error('引导已完成，请使用重新查看入口。');
    }
    const next = { ...this.progress!, progress: { ...state.progress } };
    switch (input.action) {
      case 'start': case 'resume': next.status = 'active'; break;
      case 'defer': next.status = 'deferred'; break;
      case 'dismiss': next.status = 'dismissed'; break;
      case 'acknowledge-menus':
        if (state.status !== 'active' || state.currentStep !== 'menus') throw new Error('请先开始菜单介绍。');
        next.progress.menus = 'done'; next.currentStep = 'ai'; break;
      case 'skip-ai':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        next.progress.ai = 'skipped'; next.currentStep = 'question'; break;
      case 'show-ai':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        next.currentStep = 'ai'; break;
      case 'show-question':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        if (state.connection.state === 'missing') throw new Error('请先保存当前模型设置。');
        next.currentStep = 'question';
        if (state.connection.state === 'tested') next.progress.ai = 'done';
        else next.progress.ai = 'pending';
        break;
      case 'finish':
        if (state.progress.menus !== 'done' || state.progress.ai !== 'done' || state.progress.question !== 'done'
          || !state.successfulRequestId || state.connection.state !== 'tested') throw new Error('请先使用当前模型完成一次提问。');
        next.status = 'completed'; next.completedAt = new Date().toISOString(); break;
    }
    return this.commit(next);
  }

  selectProfile(profileId: string): OnboardingState {
    if (!this.ports.profiles().some(profile => profile.id === profileId)) throw new Error('请先保存这条模型连接。');
    const state = this.get();
    if (state.selectedProfileId === profileId) return state;
    return this.commit({ ...this.progress!, selectedProfileId: profileId,
      ...(state.status === 'completed' ? {} : { successfulRequestId: undefined, progress: { ...state.progress, ai: 'pending' as const, question: 'pending' as const } }) });
  }

  /** Invalidation also fences responses from a test started before the user edited its draft. */
  invalidateDraft(profileId: string): OnboardingState {
    this.tests.delete(profileId);
    return this.publish();
  }

  beginTest(profileId: string, config: AiProviderConfig): string {
    const token = randomUUID();
    this.tests.set(profileId, { token, fingerprint: this.fingerprint(config) });
    return token;
  }

  finishTest(profileId: string, token: string, available: boolean): void {
    const record = this.tests.get(profileId);
    if (!record || record.token !== token) return;
    this.tests.set(profileId, { ...record, available });
    this.publish();
  }

  profilesSaved(profileId?: string): OnboardingState {
    const state = this.get();
    const profiles = this.ports.profiles();
    const selected = profiles.find(profile => profile.id === state.selectedProfileId);
    const changed = state.selectedProfileId && (!selected || this.savedFingerprints.get(selected.id) !== this.fingerprint(selected.config));
    this.savedFingerprints.clear();
    for (const profile of profiles) this.savedFingerprints.set(profile.id, this.fingerprint(profile.config));
    if (changed && state.status !== 'completed') this.commit({ ...this.progress!, successfulRequestId: undefined,
      progress: { ...state.progress, ai: 'pending', question: 'pending' } });
    if (profileId) this.selectProfile(profileId);
    return this.publish();
  }

  /** The caller verifies that this is an owned, empty chat session before binding. */
  bindPractice(senderId: number, input: OnboardingPracticeBinding): OnboardingState {
    this.checkRevision(input.expectedRevision);
    const state = this.get();
    if (state.status !== 'completed' && (state.status !== 'active' || state.currentStep !== 'question')) throw new Error('请先配置模型并进入第一次提问。');
    const profile = this.ports.profiles().find(item => item.id === input.profileId);
    if (!profile || !this.isConfigured(profile.config)) throw new Error('选定的语言模型尚未配置。');
    this.bindings.set(senderId, { sessionId: input.sessionId, profileId: profile.id });
    if (state.status === 'completed') return state;
    return this.commit({ ...this.progress!, practiceSessionId: input.sessionId, selectedProfileId: profile.id });
  }

  /** Freeze the actual resolved model at send time, not the default model at completion time. */
  beginPracticeRequest(senderId: number, input: { requestId: string; sessionId?: string; scope: string; profile: AiModelProfile; webSearch?: string }): boolean {
    const binding = this.bindings.get(senderId);
    const state = this.get();
    if (!binding || binding.sessionId !== input.sessionId || binding.profileId !== input.profile.id || input.scope !== 'chat'
      || input.webSearch !== 'off' || !['active', 'deferred', 'completed'].includes(state.status)) return false;
    this.requests.set(input.requestId, { senderId, ...binding, fingerprint: this.fingerprint(input.profile.config) });
    return true;
  }

  isPracticeRequest(senderId: number, requestId: string): boolean {
    return this.requests.get(requestId)?.senderId === senderId;
  }

  /** Only the normal main-process chat finalization calls this after successful persistence. */
  completePractice(senderId: number, requestId: string, input: { answer: string; persisted: boolean; sessionId?: string; complete: boolean }): void {
    const request = this.requests.get(requestId);
    if (!request || request.senderId !== senderId || !input.persisted || !input.complete
      || !input.answer.trim() || input.sessionId !== request.sessionId) return;
    const state = this.get();
    if (state.status === 'completed' || state.status === 'dismissed' || state.practiceSessionId !== request.sessionId || state.selectedProfileId !== request.profileId) return;
    if (state.successfulRequestId === requestId && state.progress.question === 'done') return;
    const profile = this.ports.profiles().find(item => item.id === request.profileId);
    if (!profile || this.fingerprint(profile.config) !== request.fingerprint) return;
    this.tests.set(profile.id, { token: randomUUID(), fingerprint: request.fingerprint, available: true });
    this.commit({ ...this.progress!, successfulRequestId: requestId, progress: { ...state.progress, ai: 'done', question: 'done' } });
  }

  forgetRequest(senderId: number, requestId: string): void {
    if (this.requests.get(requestId)?.senderId === senderId) this.requests.delete(requestId);
  }

  sampleImported(): OnboardingState { return this.commit({ ...this.progress!, sampleImported: true }); }

  private isConfigured(config: AiProviderConfig): boolean {
    if (!config.model?.trim()) return false;
    try { const url = new URL(config.endpoint || (config.kind === 'ollama' ? 'http://127.0.0.1:11434' : '')); if (!['http:', 'https:'].includes(url.protocol)) return false; } catch { return false; }
    return config.kind === 'ollama' || Boolean(config.apiKey?.trim() && config.remoteContentConsent);
  }

  private fingerprint(config: AiProviderConfig): string {
    return createHmac('sha256', this.salt).update(JSON.stringify({
      kind: config.kind, provider: config.kind === 'ollama' ? undefined : config.provider ?? 'custom',
      api: config.kind === 'ollama' ? 'ollama-chat' : config.api ?? 'openai-completions', endpoint: (config.endpoint || (config.kind === 'ollama' ? 'http://127.0.0.1:11434' : '')).trim().replace(/\/+$/, ''),
      model: config.model?.trim(), apiKey: config.kind === 'ollama' ? undefined : config.apiKey?.trim(), consent: config.kind === 'ollama' ? undefined : Boolean(config.remoteContentConsent),
      contextWindowTokens: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
    })).digest('hex');
  }

  private checkRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision !== this.get().revision) throw new Error('引导进度已更新，请重试当前操作。');
  }

  private commit(next: OnboardingProgress): OnboardingState {
    const updated = { ...next, revision: this.get().revision + 1, updatedAt: new Date().toISOString() };
    this.ports.write(updated); // Do not advance in-memory progress when persistence fails.
    this.progress = updated;
    return this.publish();
  }

  private publish(): OnboardingState { const state = this.get(); this.ports.notify(state); return state; }
}
