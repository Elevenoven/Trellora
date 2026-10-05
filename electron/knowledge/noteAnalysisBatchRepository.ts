import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { saveNoteAnalysisInDatabase, withKnowledgeDatabase } from './metaDatabase';
import type { NoteAnalysis, NoteAnalysisBatchPlan, NoteAnalysisBatchResult, NoteAnalysisRunDetail, NoteAnalysisRunState } from './noteAnalysisTypes';
import type { NoteAnalysisRunInput } from './noteAnalysisBatchPrompt';
import { NOTE_ANALYSIS_POLICY_VERSION, NOTE_ANALYSIS_PROMPT_VERSION } from './noteAnalysisLengthPolicy';
import { noteAnalysisTextHash } from './noteAnalysisBatchPlanner';
import { prepareNoteAnalysisInput } from './noteAnalysisInputPreparation';

interface RunRow { run_json: string; state: NoteAnalysisRunState; updated_at: string; is_current: number }

/** 概览专用任务表；不写助手记忆表，所有更新使用主进程的短事务。 */
export class NoteAnalysisBatchRepository {
  readonly libraryPath: string;

  constructor(libraryPath: string) {
    this.libraryPath = libraryPath;
  }

  create(notePath: string, sourceHash: string, providerFingerprint: string, input: NoteAnalysisRunInput, plans: NoteAnalysisBatchPlan[]): NoteAnalysisRunDetail {
    const preparedDocument = input.preparedDocument ?? prepareNoteAnalysisInput(input.markdown);
    const now = new Date().toISOString();
    const run: NoteAnalysisRunDetail = {
      runId: randomUUID(), notePath, sourceHash, inputTextHash: noteAnalysisTextHash(input.markdown), policyVersion: NOTE_ANALYSIS_POLICY_VERSION, promptVersion: NOTE_ANALYSIS_PROMPT_VERSION,
      planHash: noteAnalysisTextHash(JSON.stringify(plans)), providerFingerprint, provider: input.config.kind, model: input.config.model ?? '', state: 'queued', totalBatches: plans.length, completedBatches: 0, createdAt: now, updatedAt: now,
      batches: plans.map((plan) => ({ ...plan, status: 'pending', keyPoints: [], tagCandidates: [], generationAttempts: 0 })),
      processingMode: plans[0]?.processingMode ?? 'batched', preparationVersion: preparedDocument.version, preparationStats: preparedDocument.stats,
    };
    withKnowledgeDatabase(this.libraryPath, (database) => database.transaction(() => {
      database.prepare('UPDATE note_analysis_runs SET is_current = 0 WHERE note_path = ?').run(notePath);
      const { batches: _batches, ...metadata } = run;
      // 明确列出可落盘字段，调用方即使误传apiKey也不会进入任务快照。
      const { apiKey: _secret, ...safeConfig } = input.config as NoteAnalysisRunInput['config'] & { apiKey?: string };
      database.prepare('INSERT INTO note_analysis_runs(run_id,note_path,source_hash,state,run_json,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(run.runId, notePath, sourceHash, run.state, JSON.stringify(metadata), JSON.stringify({ ...input, preparedDocument, config: safeConfig }), now, now);
      const insert = database.prepare('INSERT INTO note_analysis_batches(run_id,batch_id,batch_index,result_json) VALUES(?,?,?,?)');
      for (const batch of run.batches) insert.run(run.runId, batch.batchId, batch.batchIndex, JSON.stringify(batch));
    })());
    return run;
  }

  get(runId: string): NoteAnalysisRunDetail | null {
    return withKnowledgeDatabase(this.libraryPath, (database) => this.read(database, runId));
  }

  getLatest(notePath: string): NoteAnalysisRunDetail | null {
    return withKnowledgeDatabase(this.libraryPath, (database) => {
      const row = database.prepare('SELECT run_id FROM note_analysis_runs WHERE note_path = ? AND is_current = 1').get(notePath) as { run_id: string } | undefined;
      return row ? this.read(database, row.run_id) : null;
    });
  }

  getInput(runId: string): NoteAnalysisRunInput {
    return withKnowledgeDatabase(this.libraryPath, (database) => {
      const row = database.prepare('SELECT input_json FROM note_analysis_runs WHERE run_id = ?').get(runId) as { input_json: string } | undefined;
      if (!row) throw new Error('找不到笔记分析任务。');
      return JSON.parse(row.input_json) as NoteAnalysisRunInput;
    });
  }

  isCurrent(runId: string): boolean {
    return withKnowledgeDatabase(this.libraryPath, (database) => Boolean(database.prepare('SELECT 1 FROM note_analysis_runs WHERE run_id = ? AND is_current = 1').get(runId)));
  }

  setState(runId: string, state: NoteAnalysisRunState, error?: NoteAnalysisRunDetail['error']): NoteAnalysisRunDetail {
    return withKnowledgeDatabase(this.libraryPath, (database) => database.transaction(() => {
      const run = this.read(database, runId);
      if (!run) throw new Error('找不到笔记分析任务。');
      run.state = state;
      run.updatedAt = new Date().toISOString();
      run.error = error;
      if (state === 'cancelled' || state === 'stale') for (const batch of run.batches) {
        if (batch.status === 'succeeded' || batch.status === 'failed') continue;
        batch.status = 'cancelled';
        database.prepare('UPDATE note_analysis_batches SET result_json = ? WHERE run_id = ? AND batch_id = ?').run(JSON.stringify(batch), runId, batch.batchId);
      }
      this.writeRun(database, run);
      return run;
    })());
  }

  /** 结果与完成计数同一事务提交；晚到的取消／过期响应不写入成功。 */
  saveBatch(runId: string, batch: NoteAnalysisBatchResult): NoteAnalysisRunDetail {
    return withKnowledgeDatabase(this.libraryPath, (database) => database.transaction(() => {
      const run = this.read(database, runId);
      if (!run) throw new Error('找不到笔记分析任务。');
      if (run.state === 'cancelled' || run.state === 'stale' || !this.currentInDatabase(database, runId)) return run;
      const index = run.batches.findIndex((entry) => entry.batchId === batch.batchId);
      if (index < 0) throw new Error('批次不属于当前分析任务。');
      run.batches[index] = batch;
      database.prepare('UPDATE note_analysis_batches SET result_json = ? WHERE run_id = ? AND batch_id = ?').run(JSON.stringify(batch), runId, batch.batchId);
      run.completedBatches = run.batches.filter((entry) => entry.status === 'succeeded').length;
      run.updatedAt = new Date().toISOString();
      this.writeRun(database, run);
      return run;
    })());
  }

  /** 核对当前任务后原子发布最终产物，不接受部分批次或旧run覆盖。 */
  complete(runId: string, analysis: Omit<NoteAnalysis, 'generatedAt'>): NoteAnalysis {
    return withKnowledgeDatabase(this.libraryPath, (database) => database.transaction(() => {
      const run = this.read(database, runId);
      if (!run || run.state !== 'running' || !this.currentInDatabase(database, runId) || run.completedBatches !== run.totalBatches) throw new Error('笔记分析任务已取消、过期或尚未完成。');
      const result = saveNoteAnalysisInDatabase(database, analysis);
      run.state = 'completed';
      run.updatedAt = result.generatedAt;
      this.writeRun(database, run);
      return result;
    })());
  }

  /** 仅在新进程首次打开本库时调用；保留成功批次，重置遗留在途批次。 */
  recoverInterrupted(): void {
    withKnowledgeDatabase(this.libraryPath, (database) => database.transaction(() => {
      const rows = database.prepare("SELECT run_id FROM note_analysis_runs WHERE state IN ('queued','running')").all() as { run_id: string }[];
      for (const row of rows) {
        const run = this.read(database, row.run_id)!;
        run.state = 'partial';
        run.updatedAt = new Date().toISOString();
        for (const batch of run.batches) if (batch.status === 'running' || batch.status === 'retrying-length') {
          batch.status = 'pending';
          database.prepare('UPDATE note_analysis_batches SET result_json = ? WHERE run_id = ? AND batch_id = ?').run(JSON.stringify(batch), run.runId, batch.batchId);
        }
        this.writeRun(database, run);
      }
    })());
  }

  private currentInDatabase(database: Database.Database, runId: string): boolean {
    return Boolean(database.prepare('SELECT 1 FROM note_analysis_runs WHERE run_id = ? AND is_current = 1').get(runId));
  }

  private read(database: Database.Database, runId: string): NoteAnalysisRunDetail | null {
    const row = database.prepare('SELECT run_json,state,updated_at,is_current FROM note_analysis_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
    if (!row) return null;
    const batches = (database.prepare('SELECT result_json FROM note_analysis_batches WHERE run_id = ? ORDER BY batch_index').all(runId) as { result_json: string }[]).map((entry) => JSON.parse(entry.result_json) as NoteAnalysisBatchResult);
    return { ...JSON.parse(row.run_json), state: row.state, updatedAt: row.updated_at, batches } as NoteAnalysisRunDetail;
  }

  private writeRun(database: Database.Database, run: NoteAnalysisRunDetail): void {
    const { batches: _batches, ...metadata } = run;
    database.prepare('UPDATE note_analysis_runs SET state = ?, run_json = ?, updated_at = ? WHERE run_id = ?').run(run.state, JSON.stringify(metadata), run.updatedAt, run.runId);
  }
}
