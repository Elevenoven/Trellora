import type { AiProviderConfig } from './aiTypes';
import type { NoteAnalysis, NoteAnalysisBatchResult, NoteAnalysisProgress, NoteAnalysisRunDetail, NoteAnalysisTagCandidate } from './noteAnalysisTypes';
import { NoteAnalysisBatchRepository } from './noteAnalysisBatchRepository';
import { noteAnalysisProviderFingerprint, createNoteAnalysisBatchPrompt, noteAnalysisOutputBudget, noteAnalysisPromptFits, noteAnalysisFullDocumentFits, type NoteAnalysisRunInput } from './noteAnalysisBatchPrompt';
import { planNoteAnalysisBatches, planFullNoteAnalysis } from './noteAnalysisBatchPlanner';
import { prepareNoteAnalysisInput, readPreparedNoteAnalysisSpans, NOTE_ANALYSIS_PREPARATION_VERSION } from './noteAnalysisInputPreparation';
import { countNoteAnalysisCharacters, finishNoteAnalysisLength, parseNoteAnalysisBatchPayload, NOTE_ANALYSIS_POLICY_VERSION, NOTE_ANALYSIS_PROMPT_VERSION } from './noteAnalysisLengthPolicy';

interface ModelRequest {
  prompt: string;
  signal: AbortSignal;
  providerConfig: AiProviderConfig;
  model: string;
  maxOutputTokens: number;
}

interface RunExecution {
  repository: NoteAnalysisBatchRepository;
  runId: string;
  input: NoteAnalysisRunInput;
  config: AiProviderConfig;
  isSourceCurrent: () => boolean;
  onProgress: (progress: NoteAnalysisProgress) => void;
  controller: AbortController;
  promise?: Promise<void>;
}

interface RunStart {
  repository: NoteAnalysisBatchRepository;
  notePath: string;
  sourceHash: string;
  input: NoteAnalysisRunInput;
  config: AiProviderConfig;
  isSourceCurrent: () => boolean;
  onProgress: (progress: NoteAnalysisProgress) => void;
}

/** 所有概览任务共享三请求并发池；每轮等待三批完成，结果各自即时提交。 */
export class NoteAnalysisBatchOrchestrator {
  get maintenanceBusy(): boolean { return this.executions.size > 0; }
  private readonly executions = new Map<string, RunExecution>();
  private activeRequests = 0;
  private readonly waiters: Array<() => void> = [];

  private readonly generateJson: (request: ModelRequest) => Promise<unknown>;

  constructor(generateJson: (request: ModelRequest) => Promise<unknown>) {
    this.generateJson = generateJson;
  }

  start(request: RunStart): NoteAnalysisRunDetail {
    const current = request.repository.getLatest(request.notePath);
    const fingerprint = noteAnalysisProviderFingerprint(request.config);
    if (current && current.policyVersion === NOTE_ANALYSIS_POLICY_VERSION && current.promptVersion === NOTE_ANALYSIS_PROMPT_VERSION && !this.executions.get(current.runId)?.controller.signal.aborted && this.executions.has(current.runId) && current.sourceHash === request.sourceHash && current.providerFingerprint === fingerprint) return current;
    if (current && this.executions.has(current.runId)) this.cancel(request.repository, current.runId);
    // 每次启动冻结清洗结果；长度重试、断点恢复不会重新清洗或换一份正文。
    const input = { ...request.input, preparedDocument: prepareNoteAnalysisInput(request.input.markdown) };
    const full = planFullNoteAnalysis(input.markdown, input.preparedDocument);
    let limit = 12_000;
    let plans = noteAnalysisFullDocumentFits(input, full) ? [full] : planNoteAnalysisBatches(input.markdown, limit, input.preparedDocument);
    while (!plans.every((batch) => noteAnalysisPromptFits(input, batch, plans.length))) {
      limit = Math.floor(limit * 0.75);
      if (limit < 256) throw new Error('当前模型窗口无法容纳分析提示词及4000字重试预算，请选择窗口更大的模型。');
      plans = planNoteAnalysisBatches(input.markdown, limit, input.preparedDocument);
    }
    const run = request.repository.create(request.notePath, request.sourceHash, fingerprint, input, plans);
    this.launch({ ...request, input, runId: run.runId, controller: new AbortController() });
    return request.repository.get(run.runId)!;
  }

  async resume(repository: NoteAnalysisBatchRepository, runId: string, config: AiProviderConfig, isSourceCurrent: () => boolean, onProgress: RunExecution['onProgress']): Promise<NoteAnalysisRunDetail> {
    const active = this.executions.get(runId);
    if (active && !active.controller.signal.aborted) return repository.get(runId)!;
    // 取消后的请求先退出，避免同一run的新旧执行器交错保存或释放并发名额。
    await active?.promise;
    const run = repository.get(runId);
    if (!run || !repository.isCurrent(runId)) throw new Error('找不到当前可恢复的分析任务。');
    if (this.executions.has(runId)) return run;
    if (run.state === 'completed') return run;
    if (!isSourceCurrent()) { repository.setState(runId, 'stale'); throw new Error('笔记内容已变化，请重新分析。'); }
    if (run.policyVersion !== NOTE_ANALYSIS_POLICY_VERSION || run.promptVersion !== NOTE_ANALYSIS_PROMPT_VERSION || noteAnalysisProviderFingerprint(config) !== run.providerFingerprint) throw new Error('模型或分析规则已变化，请重新分析。');
    const input = repository.getInput(runId);
    if (input.preparedDocument?.version !== NOTE_ANALYSIS_PREPARATION_VERSION) throw new Error('清洗规则已变化，请重新分析。');
    this.launch({ repository, runId, input, config: { ...input.config, apiKey: config.apiKey }, isSourceCurrent, onProgress, controller: new AbortController() });
    return repository.get(runId)!;
  }

  cancel(repository: NoteAnalysisBatchRepository, runId: string): boolean {
    const run = repository.get(runId);
    if (!run || run.state === 'completed') return false;
    this.executions.get(runId)?.controller.abort();
    const cancelled = repository.setState(runId, 'cancelled');
    this.emit(this.executions.get(runId), cancelled);
    return true;
  }

  async waitForCompletion(repository: NoteAnalysisBatchRepository, runId: string): Promise<NoteAnalysisRunDetail> {
    await this.executions.get(runId)?.promise;
    const run = repository.get(runId);
    if (!run || run.state !== 'completed') throw new Error(run?.error?.message || (run?.state === 'cancelled' ? '笔记分析已取消。' : '笔记分析未完成，可从已保存批次恢复。'));
    return run;
  }

  shutdown(): void {
    for (const execution of this.executions.values()) this.cancel(execution.repository, execution.runId);
  }

  private launch(execution: RunExecution): void {
    this.executions.set(execution.runId, execution);
    execution.promise = this.execute(execution).finally(() => {
      if (this.executions.get(execution.runId) === execution) this.executions.delete(execution.runId);
    });
  }

  private assertActive(execution: RunExecution): void {
    if (execution.controller.signal.aborted) throw new Error('笔记分析已取消。');
    if (!execution.repository.isCurrent(execution.runId) || !execution.isSourceCurrent()) {
      execution.repository.setState(execution.runId, 'stale');
      execution.controller.abort();
      throw new Error('笔记内容或当前任务已变化。');
    }
  }

  private emit(execution: RunExecution | undefined, run: NoteAnalysisRunDetail, batch?: NoteAnalysisBatchResult): void {
    try {
      execution?.onProgress({ runId: run.runId, notePath: run.notePath, sourceHash: run.sourceHash, state: run.state, totalBatches: run.totalBatches, completedBatches: run.completedBatches, ...(batch ? { batchIndex: batch.batchIndex, batchStatus: batch.status } : {}), ...(run.error ? { error: run.error } : {}) });
    } catch {
      // 窗口关闭等通知失败不改变已经落库的任务结果。
    }
  }

  private async execute(execution: RunExecution): Promise<void> {
    const { repository, runId } = execution;
    try {
      this.assertActive(execution);
      let run = repository.setState(runId, 'running');
      this.emit(execution, run);
      const pending = run.batches.filter((batch) => batch.status !== 'succeeded');
      for (let offset = 0; offset < pending.length; offset += 3) {
        this.assertActive(execution);
        const wave = await Promise.allSettled(pending.slice(offset, offset + 3).map((batch) => this.executeBatch(execution, batch, run.totalBatches)));
        this.assertActive(execution);
        run = repository.get(runId)!;
        if (wave.some((result) => result.status === 'rejected') || run.batches.some((batch) => batch.status === 'failed')) {
          const error = run.batches.find((batch) => batch.status === 'failed')?.error ?? { code: 'batch-failed', message: '部分批次分析失败，请恢复任务。' };
          this.emit(execution, repository.setState(runId, run.completedBatches ? 'partial' : 'failed', error));
          return;
        }
      }
      this.assertActive(execution);
      run = repository.get(runId)!;
      repository.complete(runId, aggregateNoteAnalysis(run, execution.input));
      this.emit(execution, repository.get(runId)!);
    } catch (error) {
      const run = repository.get(runId);
      if (run && run.state !== 'cancelled' && run.state !== 'stale') {
        this.emit(execution, repository.setState(runId, run.completedBatches ? 'partial' : 'failed', { code: 'analysis-failed', message: this.errorMessage(error, execution.config) }));
      } else if (run) this.emit(execution, run);
    }
  }

  private async executeBatch(execution: RunExecution, original: NoteAnalysisBatchResult, total: number): Promise<void> {
    const signal = execution.controller.signal;
    const release = await this.acquire(signal);
    const batch: NoteAnalysisBatchResult = { ...original, error: undefined };
    try {
      this.assertActive(execution);
      batch.status = 'running';
      batch.generationAttempts += 1;
      this.emit(execution, execution.repository.saveBatch(execution.runId, batch), batch);
      const request = { providerConfig: execution.config, model: execution.config.model ?? '', signal, maxOutputTokens: noteAnalysisOutputBudget(execution.config) };
      let payload = parseNoteAnalysisBatchPayload(await this.generateJson({ ...request, prompt: createNoteAnalysisBatchPrompt(execution.input, batch, total) }), execution.input.currentTags);
      this.assertActive(execution);
      batch.firstSummaryCharacterCount = countNoteAnalysisCharacters(payload.summary);
      const retried = batch.firstSummaryCharacterCount > 1_000;
      if (retried) {
        batch.status = 'retrying-length';
        batch.generationAttempts += 1;
        this.emit(execution, execution.repository.saveBatch(execution.runId, batch), batch);
        payload = parseNoteAnalysisBatchPayload(await this.generateJson({ ...request, prompt: createNoteAnalysisBatchPrompt(execution.input, batch, total, batch.firstSummaryCharacterCount) }), execution.input.currentTags);
        this.assertActive(execution);
        batch.retrySummaryCharacterCount = countNoteAnalysisCharacters(payload.summary);
      }
      const result = finishNoteAnalysisLength(payload.summary, batch.mode, retried);
      Object.assign(batch, payload, result, { status: 'succeeded', summaryCharacterCount: countNoteAnalysisCharacters(result.summary), generatedAt: new Date().toISOString() });
      this.emit(execution, execution.repository.saveBatch(execution.runId, batch), batch);
    } catch (error) {
      if (!signal.aborted) {
        batch.status = 'failed';
        batch.error = { code: 'batch-failed', message: this.errorMessage(error, execution.config) };
        this.emit(execution, execution.repository.saveBatch(execution.runId, batch), batch);
      }
      throw error;
    } finally {
      release();
    }
  }

  private errorMessage(error: unknown, config: AiProviderConfig): string {
    const message = error instanceof Error ? error.message : '笔记分析失败，请重试。';
    return config.apiKey ? message.split(config.apiKey).join('[redacted]') : message;
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error('笔记分析已取消。');
    const release = () => { this.activeRequests -= 1; this.waiters.shift()?.(); };
    if (this.activeRequests >= 3) await new Promise<void>((resolve, reject) => {
      const ready = () => { this.activeRequests += 1; signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = this.waiters.indexOf(ready); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('笔记分析已取消。')); };
      signal.addEventListener('abort', abort, { once: true });
      this.waiters.push(ready);
    });
    else this.activeRequests += 1;
    if (signal.aborted) { release(); throw new Error('笔记分析已取消。'); }
    return release;
  }
}

/** 全批完成后才按源码顺序发布；标签权重使用核心单位，避免overlap重复加权。 */
export function aggregateNoteAnalysis(run: NoteAnalysisRunDetail, input: NoteAnalysisRunInput): Omit<NoteAnalysis, 'generatedAt'> {
  const document = input.preparedDocument ?? prepareNoteAnalysisInput(input.markdown);
  const batches = [...run.batches].sort((first, second) => first.batchIndex - second.batchIndex);
  if (!batches.length || batches.some((batch) => batch.status !== 'succeeded' || !batch.summary)) throw new Error('全部批次成功后才能发布完整概览。');
  const rank = { high: 3, medium: 2, low: 1 };
  const candidates = new Map<string, { candidate: NoteAnalysisTagCandidate; sources: Set<string>; first: number }>();
  const existing = new Set(input.currentTags.map((tag) => tag.toLocaleLowerCase('zh-Hans-CN')));
  for (const batch of batches) for (const candidate of batch.tagCandidates) {
    const key = candidate.name.toLocaleLowerCase('zh-Hans-CN');
    if (existing.has(key)) continue;
    const prior = candidates.get(key);
    const entry = prior ?? { candidate: { ...candidate, evidence: `${batch.sourceLabel} ${candidate.evidence}`, sourceBatchIds: [] }, sources: new Set<string>(), first: batch.batchIndex };
    if (prior && rank[candidate.confidence] > rank[entry.candidate.confidence]) entry.candidate = { ...candidate, evidence: `${batch.sourceLabel} ${candidate.evidence}`, sourceBatchIds: entry.candidate.sourceBatchIds };
    entry.candidate.sourceBatchIds!.push(batch.batchId);
    const matched = batch.coreSpans.filter((span) => {
      const core = readPreparedNoteAnalysisSpans(document, [span]).toLocaleLowerCase('zh-Hans-CN');
      return core.includes(key) || core.includes(candidate.evidence.toLocaleLowerCase('zh-Hans-CN'));
    });
    if (matched.length) for (const span of matched) entry.sources.add(span.unitId);
    else entry.sources.add(`evidence:${candidate.evidence.toLocaleLowerCase('zh-Hans-CN')}`);
    candidates.set(key, entry);
  }
  return {
    notePath: run.notePath, sourceHash: run.sourceHash, provider: run.provider, model: run.model,
    summary: run.processingMode === 'full-document' ? batches[0].summary! : batches.map((batch) => `${batch.sourceLabel}\n${batch.summary}`).join('\n\n'),
    keyPoints: [...new Set(batches.flatMap((batch) => batch.keyPoints))].slice(0, 8),
    tagCandidates: [...candidates.values()].sort((first, second) => rank[second.candidate.confidence] - rank[first.candidate.confidence] || second.sources.size - first.sources.size || first.first - second.first).slice(0, 5).map((entry) => entry.candidate),
    analysisVersion: 2, runId: run.runId, totalBatches: batches.length, completedBatches: batches.length, batches,
    processingMode: run.processingMode, preparationVersion: run.preparationVersion, preparationStats: run.preparationStats,
  };
}
