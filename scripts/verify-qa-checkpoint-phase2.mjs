import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `verify-qa-checkpoint-phase2-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const bundleDir = path.join(stagingRoot, 'bundles');
const bundles = {
  checkpoint: path.join(bundleDir, 'qaConversationCheckpoint.cjs'),
  residual: path.join(bundleDir, 'residualConversationBudget.cjs'),
  database: path.join(bundleDir, 'qaMemoryDatabase.cjs'),
  repository: path.join(bundleDir, 'qaMemoryRepository.cjs'),
};
let owner;
let verificationPassed = false;

try {
  mkdirSync(bundleDir, { recursive: true });
  await Promise.all([
    bundle('electron/knowledge/qaConversationCheckpoint.ts', bundles.checkpoint),
    bundle('electron/knowledge/residualConversationBudget.ts', bundles.residual),
    bundle('electron/knowledge/qaMemoryDatabase.ts', bundles.database),
    bundle('electron/knowledge/qaMemoryRepository.ts', bundles.repository),
  ]);
  const checkpointModule = await import(pathToFileURL(bundles.checkpoint).href);
  const residualModule = await import(pathToFileURL(bundles.residual).href);
  const databaseModule = await import(pathToFileURL(bundles.database).href);
  const repositoryModule = await import(pathToFileURL(bundles.repository).href);
  verifyPureContracts(checkpointModule, residualModule);

  const { QaMemoryDatabase, getQaMemoryDatabasePath, QA_MEMORY_SCHEMA_VERSION } = databaseModule;
  const { QaMemoryRepository } = repositoryModule;
  owner = new QaMemoryDatabase();
  let repository = new QaMemoryRepository(owner, workspaceDir);
  const sessionId = 'assistant-session-33333333-3333-4333-8333-333333333333';
  repository.ensureSession(sessionId, 'chat');
  addTurn(repository, sessionId, 1, longText('第一轮完整问题'), longText('第一轮完整回答'), 'complete');
  addTurn(repository, sessionId, 2, '失败轮不应进入 Checkpoint 来源', '', 'error');
  addTurn(
    repository,
    sessionId,
    3,
    longText('更正：配置文件不是 app.js，而是 config.ts，日期是 2026-08-27，窗口为 128K'),
    longText('已按更正记录，仍需确认部署结果'),
    'partial',
  );
  addTurn(repository, sessionId, 4, longText('第四轮需要继续调查'), longText('尚未找到完整证据'), 'not-found');

  const databasePath = getQaMemoryDatabasePath(workspaceDir);
  const database = owner.getDatabase(workspaceDir);
  assert.equal(database.pragma('user_version', { simple: true }), QA_MEMORY_SCHEMA_VERSION);
  const originalTurnFingerprint = fingerprintTurns(database, sessionId);
  owner.closeAll();
  owner = undefined;

  // Simulate an already-deployed profile-v5 database that has not received the
  // additive Checkpoint shape yet. Re-opening must snapshot it before upgrade.
  const deployedV5 = new Database(databasePath);
  deployedV5.exec(`
    DROP TABLE qa_memory_compaction_runs;
    DROP TABLE qa_memory_checkpoints;
    PRAGMA user_version = 5;
  `);
  deployedV5.close();

  owner = new QaMemoryDatabase();
  repository = new QaMemoryRepository(owner, workspaceDir);
  const upgraded = owner.getDatabase(workspaceDir);
  assert.equal(tableExists(upgraded, 'qa_memory_checkpoints'), true);
  assert.equal(tableExists(upgraded, 'qa_memory_compaction_runs'), true);
  assert.equal(tableExists(upgraded, 'qa_summaries'), true, '旧摘要表必须保留用于回滚与审计');
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(fingerprintTurns(upgraded, sessionId), originalTurnFingerprint, '迁移不得修改完整 Turn');
  const backupDirectory = path.join(workspaceDir, 'ConversationMemory', 'backups');
  const backups = readdirSync(backupDirectory).filter((name) => name.endsWith('.db'));
  assert.equal(backups.length, 1, '缺少 Checkpoint 表的既有 v5 库必须先生成一个迁移备份');
  const backup = new Database(path.join(backupDirectory, backups[0]), { readonly: true, fileMustExist: true });
  assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(tableExists(backup, 'qa_memory_checkpoints'), false, '备份必须是升级前快照');
  assert.equal(fingerprintTurns(backup, sessionId), originalTurnFingerprint);
  backup.close();

  const turns = repository.loadMemorableTurnsAfter(sessionId, 0);
  assert.deepEqual(turns.map((turn) => turn.turnSeq), [1, 3, 4]);
  const firstSource = turns.slice(0, 2);
  const firstCandidate = checkpointModule.buildQaFallbackCheckpointCandidate({
    sessionId,
    selectedTurns: firstSource,
    originalShortTermCapacity: 80_000,
    modelProfile: 'phase2-test',
  });
  assert.ok(firstCandidate.summaryTokens <= firstCandidate.summaryHardMaxTokens);
  assert.ok(firstCandidate.compressionRatio <= 0.20);
  assert.match(firstCandidate.summaryText, /config\.ts/u);
  assert.match(firstCandidate.summaryText, /2026-08-27/u);
  assert.match(firstCandidate.summaryText, /用户纠正/u);
  const firstCommit = repository.commitConversationCheckpointCas({
    sessionId,
    expectedCheckpointVersion: 0,
    expectedCoveredThroughSeq: 0,
    sourceTurnSeqs: [1, 3],
    candidate: firstCandidate,
  });
  assert.equal(firstCommit.status, 'committed');
  assert.equal(firstCommit.checkpoint.coveredThroughSeq, 3);
  assert.equal(fingerprintTurns(upgraded, sessionId), originalTurnFingerprint, 'Checkpoint 提交不得修改 qa_turns');

  const staleCommit = repository.commitConversationCheckpointCas({
    sessionId,
    expectedCheckpointVersion: 0,
    expectedCoveredThroughSeq: 0,
    sourceTurnSeqs: [1, 3],
    candidate: firstCandidate,
  });
  assert.deepEqual({ status: staleCommit.status, reason: staleCommit.reason }, { status: 'conflict', reason: 'base-changed' });

  const firstCheckpoint = repository.getConversationCheckpoint(sessionId);
  const fourthTurn = repository.loadMemorableTurnsAfter(sessionId, 3)[0];
  const secondCandidate = checkpointModule.buildQaFallbackCheckpointCandidate({
    sessionId,
    previousCheckpoint: firstCheckpoint,
    selectedTurns: [fourthTurn],
    originalShortTermCapacity: 80_000,
  });
  addTurn(repository, sessionId, 5, longText('来源范围之后的新问题'), longText('新问题回答'), 'complete');
  const secondCommit = repository.commitConversationCheckpointCas({
    sessionId,
    expectedCheckpointVersion: 1,
    expectedCoveredThroughSeq: 3,
    sourceTurnSeqs: [4],
    candidate: secondCandidate,
  });
  assert.equal(secondCommit.status, 'committed', 'source_to 之后的新 Turn 不应导致 CAS 冲突');
  assert.equal(secondCommit.checkpoint.coveredThroughSeq, 4);

  const fifthTurn = repository.loadMemorableTurnsAfter(sessionId, 4)[0];
  const thirdCandidate = checkpointModule.buildQaFallbackCheckpointCandidate({
    sessionId,
    previousCheckpoint: secondCommit.checkpoint,
    selectedTurns: [fifthTurn],
    originalShortTermCapacity: 80_000,
  });
  upgraded.prepare(`UPDATE qa_turns SET assistant_text = assistant_text || '（来源已变化）' WHERE session_id = ? AND turn_seq = 5`).run(sessionId);
  const sourceConflict = repository.commitConversationCheckpointCas({
    sessionId,
    expectedCheckpointVersion: 2,
    expectedCoveredThroughSeq: 4,
    sourceTurnSeqs: [5],
    candidate: thirdCandidate,
  });
  assert.deepEqual({ status: sourceConflict.status, reason: sourceConflict.reason }, { status: 'conflict', reason: 'source-changed' });

  const audit = repository.createCompactionRun({
    runId: 'checkpoint-run-done',
    sessionId,
    baseCheckpointVersion: 2,
    sourceFromSeq: 5,
    sourceToSeq: 5,
    sourceHash: thirdCandidate.payload.sourceHash,
    sourceTokens: thirdCandidate.sourceTokens,
    targetTokens: thirdCandidate.targetTokens,
  });
  assert.equal(audit.status, 'running');
  assert.equal(repository.finishCompactionRun({ runId: audit.runId, status: 'conflict', errorCode: 'CAS_CONFLICT' }).status, 'conflict');
  repository.createCompactionRun({
    runId: 'checkpoint-run-interrupted',
    sessionId,
    baseCheckpointVersion: 2,
    sourceFromSeq: 5,
    sourceToSeq: 5,
    sourceHash: thirdCandidate.payload.sourceHash,
    sourceTokens: thirdCandidate.sourceTokens,
    targetTokens: thirdCandidate.targetTokens,
  });
  assert.equal(repository.recoverInterruptedCompactionRuns(), 1);
  assert.equal(repository.listCompactionRuns(sessionId).find((run) => run.runId === 'checkpoint-run-interrupted').status, 'interrupted');

  repository.deleteSession(sessionId);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM qa_memory_checkpoints WHERE session_id = ?').get(sessionId).count, 0);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM qa_memory_compaction_runs WHERE session_id = ?').get(sessionId).count, 0);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  verificationPassed = true;
  console.log('QA checkpoint Phase 2 verification passed: v5 backup/migration, full Turns, residual prefix, dual 20%, fallback and CAS');
} finally {
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function verifyPureContracts(checkpoint, residual) {
  const budget128 = residual.calculateResidualConversationBudget({
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
    safetyReserveTokens: 4_096,
    optimizedNonConversationTokens: 30_000,
    checkpointTokens: 1_000,
    rawConversationTokens: 70_000,
  });
  const budget256 = residual.calculateResidualConversationBudget({
    contextWindowTokens: 262_144,
    maxOutputTokens: 8_192,
    safetyReserveTokens: 4_096,
    optimizedNonConversationTokens: 30_000,
    checkpointTokens: 1_000,
    rawConversationTokens: 70_000,
  });
  assert.equal(budget128.C, budget128.hardMaxPromptTokens - budget128.N);
  assert.equal(budget128.H, budget128.C - budget128.M);
  assert.ok(budget256.H > budget128.H);
  assert.equal(budget128.reentryReserve, budget128.hardConversationPool - budget128.targetConversationPool);

  const turns = [
    pureTurn(1, 'PREFIX_HEAD_SENTINEL', 'A'.repeat(1_200)),
    pureTurn(3, '第二个可记忆终态，seq 2 是失败轮', 'B'.repeat(1_200)),
    pureTurn(4, '最近完整轮', 'TAIL_SENTINEL_' + 'C'.repeat(1_200)),
  ];
  const firstTokens = checkpoint.calculateQaCheckpointSourceTokens({ selectedTurns: turns.slice(0, 1) });
  const secondTokens = checkpoint.calculateQaCheckpointSourceTokens({ selectedTurns: turns.slice(0, 2) });
  const suffixTokens = checkpoint.calculateQaCheckpointSourceTokens({ selectedTurns: turns.slice(2) });
  const targets = checkpoint.calculateQaCheckpointTargets(50_000, secondTokens);
  const selection = residual.selectOldestQaConversationPrefix({
    turns,
    coveredThroughSeq: 0,
    previousCheckpointTokens: 0,
    originalShortTermCapacity: 50_000,
    targetConversationPoolTokens: targets.summaryTargetTokens + suffixTokens,
  });
  assert.deepEqual(selection.selectedPrefix.map((turn) => turn.turnSeq), [1, 3]);
  assert.deepEqual(selection.recentSuffix.map((turn) => turn.turnSeq), [4]);
  assert.ok(firstTokens < secondTokens);
  assert.match(checkpoint.renderQaCheckpointSourceTurn(turns[0]), /PREFIX_HEAD_SENTINEL/u);
  assert.match(checkpoint.renderQaCheckpointSourceTurn(turns[2]), /TAIL_SENTINEL_/u);
  assert.throws(() => residual.selectOldestQaConversationPrefix({
    turns: [turns[1], turns[0]],
    coveredThroughSeq: 0,
    previousCheckpointTokens: 0,
    originalShortTermCapacity: 50_000,
    targetConversationPoolTokens: 1_000,
  }), /升序/u);

  const hash = checkpoint.calculateQaCheckpointSourceHash({ selectedTurns: turns });
  const changedHash = checkpoint.calculateQaCheckpointSourceHash({
    selectedTurns: [{ ...turns[0], assistantText: `${turns[0].assistantText}!` }, ...turns.slice(1)],
  });
  assert.notEqual(hash, changedHash, '来源文本变化一个字符也必须改变哈希');

  const fallback = checkpoint.buildQaFallbackCheckpointCandidate({
    sessionId: 'assistant-session-99999999-9999-4999-8999-999999999999',
    selectedTurns: turns,
    originalShortTermCapacity: 50_000,
  });
  assert.ok(fallback.summaryTokens <= fallback.summaryHardMaxTokens);
  assert.ok(fallback.summaryTokens / fallback.sourceTokens <= 0.20);
  const semantic = semanticFromPayload(fallback.payload);
  assert.throws(() => checkpoint.createQaConversationCheckpointCandidate({
    sessionId: fallback.payload.sessionId,
    selectedTurns: turns,
    originalShortTermCapacity: 50_000,
    output: { ...semantic, extra: true },
  }), /Schema|额外字段/u);
}

function semanticFromPayload(payload) {
  return {
    userGoals: payload.userGoals,
    activeConstraints: payload.activeConstraints,
    decisions: payload.decisions,
    userCorrections: payload.userCorrections,
    resolvedTopics: payload.resolvedTopics,
    unresolvedTopics: payload.unresolvedTopics,
    referencedArtifacts: payload.referencedArtifacts,
    recentHandoff: payload.recentHandoff,
  };
}

function pureTurn(turnSeq, userText, assistantText) {
  return {
    turnId: `pure-turn-${turnSeq}`,
    turnSeq,
    userText,
    assistantText,
    scopeLabel: '直接聊天',
    status: 'complete',
    createdAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:00:01.000Z',
  };
}

function addTurn(repository, sessionId, turnSeq, userText, assistantText, status) {
  const turnId = `checkpoint-turn-${turnSeq}`;
  const started = repository.startTurn(sessionId, { turnId, userText, scopeLabel: '直接聊天' });
  assert.equal(started.turnSeq, turnSeq);
  if (status === 'error') repository.finishAbortedTurn(sessionId, turnId, 'error');
  else repository.finalizeTurn(sessionId, turnId, answerResult(assistantText, status));
}

function answerResult(answer, completeness) {
  return {
    type: 'answer',
    answer,
    provider: 'openai',
    model: 'phase2-test',
    sourceNotes: [],
    retrievalMode: 'none',
    completeness,
  };
}

function longText(prefix) {
  return `${prefix}：${'完整会话正文'.repeat(900)}`;
}

function fingerprintTurns(database, sessionId) {
  const rows = database.prepare(`
    SELECT turn_id, turn_seq, user_text, assistant_text, status, result_json
    FROM qa_turns WHERE session_id = ? ORDER BY turn_seq ASC
  `).all(sessionId);
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(rootDir, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
  assert.equal(existsSync(outfile), true);
}
