import { createHash } from 'node:crypto';
import type { AiJsonGenerationOptions } from './aiProvider';
import type { AiProviderConfig, AiProviderKind } from './aiTypes';
import { MaintenanceModelCallCoordinator } from './modelCallCoordinator';
import type { AssistantTokenUsage } from './tokenEstimator';
import {
  UserProfileExtractor,
  USER_PROFILE_EXTRACTOR_VERSION,
  UserProfileInvalidOutputError,
  isSensitiveProfileContent,
} from './userProfileExtractor';
import {
  UserProfileExtractionJobRepository,
  type UserProfileJobScheduleResult,
} from './userProfileExtractionJobRepository';
import { UserProfileMergeService } from './userProfileMergeService';
import type {
  UserProfileExtractionJob,
  UserProfileExtractionScheduleInput,
  UserProfileQueueDiagnostics,
  UserProfileUpdateReceipt,
} from './userProfileTypes';

const PROFILE_EXTRACTION_MAX_OUTPUT_TOKENS = 800;

export type UserProfileExtractionModelResolution = {
  ready: true;
  providerConfig: AiProviderConfig;
  providerKind: AiProviderKind;
  model: string;
  contextWindowTokens: number;
} | {
  ready: false;
  code: string;
  message: string;
};

export interface UserProfileExtractionQueueOptions {
  resolveModel: (job: UserProfileExtractionJob) => UserProfileExtractionModelResolution;
  generateJson: (input: AiJsonGenerationOptions) => Promise<unknown>;
  onError?: (event: { jobId: string; code: string }) => void;
  onUpdated?: (event: UserProfileUpdateReceipt) => void;
  maintenanceCoordinator?: MaintenanceModelCallCoordinator;
}

/** One-call, single-concurrency lane that never joins the interactive answer promise. */
export class UserProfileExtractionQueue {
  private readonly maintenanceCoordinator: MaintenanceModelCallCoordinator;
  private readonly pendingJobIds: string[] = [];
  private readonly queuedJobIds = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;
  private stopped = false;
  private activeJobId: string | undefined;
  private lastSettledAt: string | undefined;
  private lastErrorCode: string | undefined;

  constructor(
    private readonly jobs: UserProfileExtractionJobRepository,
    private readonly extractor: UserProfileExtractor,
    private readonly mergeService: UserProfileMergeService,
    private readonly options: UserProfileExtractionQueueOptions,
  ) {
    this.maintenanceCoordinator = options.maintenanceCoordinator ?? new MaintenanceModelCallCoordinator({
      maxConcurrent: 1,
      maxModelCallsPerJob: 1,
      maxWallTimeMs: 20_000,
    });
    for (const jobId of this.jobs.recoverInterruptedJobs()) this.enqueue(jobId);
  }

  schedule(input: UserProfileExtractionScheduleInput): UserProfileJobScheduleResult {
    const result = this.jobs.schedule(input);
    if (result.shouldEnqueue && result.job) this.enqueue(result.job.jobId);
    return result;
  }

  retry(jobId: string): UserProfileExtractionJob {
    const job = this.jobs.prepareManualRetry(jobId);
    this.enqueue(job.jobId);
    return job;
  }

  cancelSession(sessionId: string): void {
    this.maintenanceCoordinator.cancelSession(sessionId);
  }

  abortAll(): void {
    this.stopped = true;
    this.maintenanceCoordinator.abortAll();
    this.pendingJobIds.length = 0;
    this.queuedJobIds.clear();
    this.resolveIdleWaiters();
  }

  waitForIdle(): Promise<void> {
    if (!this.draining && this.pendingJobIds.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  getDiagnostics(): UserProfileQueueDiagnostics {
    return {
      state: this.stopped ? 'stopped' : this.activeJobId || this.pendingJobIds.length ? 'running' : 'idle',
      queuedJobs: this.pendingJobIds.length,
      activeJobs: this.activeJobId ? 1 : 0,
      ...(this.activeJobId ? { activeJobId: this.activeJobId } : {}),
      ...(this.lastSettledAt ? { lastSettledAt: this.lastSettledAt } : {}),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  private enqueue(jobId: string): void {
    if (this.stopped || this.queuedJobIds.has(jobId)) return;
    this.queuedJobIds.add(jobId);
    this.pendingJobIds.push(jobId);
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const jobId = this.pendingJobIds.shift();
        if (!jobId) break;
        this.queuedJobIds.delete(jobId);
        this.activeJobId = jobId;
        try {
          await this.process(jobId);
        } finally {
          this.activeJobId = undefined;
        }
      }
    } finally {
      this.draining = false;
      if (!this.pendingJobIds.length) this.resolveIdleWaiters();
      else queueMicrotask(() => void this.drain());
    }
  }

  private async process(jobId: string): Promise<void> {
    const source = this.jobs.loadPendingSource(jobId);
    if (!source) return;
    // Secrets and protected-category statements never cross the provider
    // boundary. Conservatively skip the whole turn instead of attempting to
    // redact a fragment and risking a partial secret leak.
    if (isSensitiveProfileContent(source.userText)) {
      this.recordSettled(this.jobs.completeWithoutCall(jobId, { filteredSensitiveCount: 1 }));
      return;
    }
    const request = this.extractor.createRequest(source);
    const resolution = this.options.resolveModel(source.job);
    if (!resolution.ready) {
      this.safeFail(jobId, { status: 'blocked', code: resolution.code, message: resolution.message });
      return;
    }

    const claimed = this.jobs.claim(jobId, {
      extractorVersion: USER_PROFILE_EXTRACTOR_VERSION,
      inputHash: sha256(request.prompt),
      inputChars: request.prompt.length,
    });
    if (!claimed) return;

    const startedAt = Date.now();
    try {
      let usage: AssistantTokenUsage | undefined;
      let rawOutputChars = 0;
      const extracted = await this.extractor.extract(source, {
        generate: async (generationRequest) => {
          const value = await this.maintenanceCoordinator.run({
            jobId,
            sessionId: source.job.sessionId,
            callKind: 'user-profile-extract',
            prompt: generationRequest.prompt,
            contextWindowTokens: resolution.contextWindowTokens,
            providerKind: resolution.providerKind,
            model: resolution.model,
            requestedMaxOutputTokens: PROFILE_EXTRACTION_MAX_OUTPUT_TOKENS,
            execute: async ({ call, signal }) => this.options.generateJson({
              model: resolution.model,
              providerConfig: resolution.providerConfig,
              prompt: generationRequest.prompt,
              jsonSchema: generationRequest.jsonSchema,
              maxOutputTokens: call.plan.maxOutputTokens,
              contextWindowTokens: resolution.contextWindowTokens,
              timeoutMs: null,
              signal,
              callKind: 'user-profile-extract',
              onUsage: (nextUsage) => { usage = nextUsage; },
              onRawResponse: (text) => { rawOutputChars = [...text].length; },
            }),
          });
          const fallbackChars = [...safeJsonStringify(value)].length;
          return { value, outputChars: rawOutputChars || fallbackChars, ...(usage ? { usage } : {}) };
        },
      });
      const merged = this.mergeService.merge(source, extracted.observations);
      const completed = this.jobs.complete(jobId, {
        status: merged.acceptedCategories.length ? 'completed' : 'empty',
        outputHash: sha256(JSON.stringify({
          observations: extracted.observationCount,
          applied: merged.appliedCount,
          sensitive: merged.sensitiveFilteredCount,
          invalid: extracted.invalidCount + merged.invalidFilteredCount,
          categories: merged.acceptedCategories,
        })),
        observationCount: extracted.observationCount,
        appliedCount: merged.appliedCount,
        filteredSensitiveCount: merged.sensitiveFilteredCount,
        filteredInvalidCount: extracted.invalidCount + merged.invalidFilteredCount,
        outputChars: extracted.outputChars,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        durationMs: Date.now() - startedAt,
      });
      this.recordSettled(completed);
      if (completed.appliedCount > 0) {
        try {
          this.options.onUpdated?.({
            requestId: completed.sourceTurnId,
            updatedItemCount: completed.appliedCount,
            completedAt: completed.finishedAt ?? completed.updatedAt,
          });
        } catch {
          // Renderer receipts are best effort and never change the durable job result.
        }
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (isAbortError(error)) {
        this.safeFail(jobId, {
          status: 'unknown',
          code: 'call-status-unknown',
          message: '画像提取调用已中断，最终状态未知，未自动重复调用。',
          durationMs,
        });
      } else if (error instanceof UserProfileInvalidOutputError) {
        this.safeFail(jobId, {
          status: 'failed',
          code: error.code,
          message: '模型未返回可用的画像结构，请手动重试或更换模型。',
          durationMs,
        });
      } else {
        this.safeFail(jobId, {
          status: 'failed',
          code: 'provider-call-failed',
          message: '画像提取调用失败，可在用户信息中手动重试。',
          durationMs,
        });
      }
    }
  }

  private safeFail(
    jobId: string,
    input: Parameters<UserProfileExtractionJobRepository['fail']>[1],
  ): void {
    try {
      this.recordSettled(this.jobs.fail(jobId, input));
      this.lastErrorCode = input.code;
    } catch {
      this.options.onError?.({ jobId, code: 'job-state-write-failed' });
    }
  }

  private recordSettled(job: UserProfileExtractionJob): void {
    this.lastSettledAt = job.finishedAt ?? job.updatedAt;
    if (job.status === 'completed' || job.status === 'empty') this.lastErrorCode = undefined;
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
    || error instanceof Error && /aborted|abort|timeout/i.test(`${error.name} ${error.message}`);
}
