import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const root = process.cwd();
const staging = path.join(root, '.package-staging', `memory-maintenance-${process.pid}-${Date.now()}`);
const compiled = path.join(staging, 'compiled');
const owners = [];
const services = [];
const results = [];
const consolidationServices = [];
const databases = [];
try {
  transpileLocalModules(root, compiled, ['electron/knowledge/memory/memoryExtractionService.ts',
    'electron/knowledge/qaMemoryRepository.ts', 'electron/backup/physicalRestore.ts', 'electron/knowledge/memory/memoryConsolidationService.ts', 'electron/knowledge/memory/memoryTurnStatusService.ts']);
  const load = (file) => import(pathToFileURL(path.join(compiled, file.replace(/\.ts$/u, '.js'))).href);
  const { QaMemoryDatabase, migrateQaMemoryDatabase, QA_MEMORY_SCHEMA_VERSION } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { QaMemoryRepository } = await load('electron/knowledge/qaMemoryRepository.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { MemoryExtractionSourceRepository, claimSources } = await load('electron/knowledge/memory/memoryExtractionSourceRepository.ts');
  const { MemoryExtractionService } = await load('electron/knowledge/memory/memoryExtractionService.ts');
  const { runInImmediateTransaction } = await load('electron/knowledge/memory/memoryRepository.ts');
  const { MemoryExtractionScheduler } = await load('electron/knowledge/memory/memoryExtractionScheduler.ts');
  const { parseMemoryExtractionOutput } = await load('electron/knowledge/memory/memoryExtractor.ts');
  const { StructuredOutputContractError } = await load('electron/knowledge/structuredOutputContract.ts');
  const { MemoryTopicService } = await load('electron/knowledge/memory/memoryTopicService.ts');
  const { migratePhysicalDatabase } = await load('electron/backup/physicalRestore.ts');
  const { MemoryConsolidationService } = await load('electron/knowledge/memory/memoryConsolidationService.ts');
  const { MemoryTurnStatusService } = await load('electron/knowledge/memory/memoryTurnStatusService.ts');
  const { normalizeMemorySaveClaims } = await load('shared/memorySaveClaims.ts');
  const { classifyMemoryFailure, memoryFailureMessage } = await load('shared/memoryFailure.ts');
  const acknowledgement = '收到。已更新您的身份背景：您是 Python 程序员。';
  assert.doesNotMatch(normalizeMemorySaveClaims(acknowledgement), /已更新/u);
  assert.match(normalizeMemorySaveClaims(acknowledgement), /应用回执/u);
  for (const quote of ['“已更新您的身份背景”', '`已更新您的身份背景`', '> 已更新您的身份背景', '```text\n已更新您的身份背景\n```']) {
    assert.equal(normalizeMemorySaveClaims(quote), quote);
  }
  for (const [error, expected] of [[new SyntaxError('bad JSON'), 'INVALID_MODEL_OUTPUT'],
    [new StructuredOutputContractError('schema-validation', '格式不符'), 'INVALID_MODEL_OUTPUT'],
    [new Error('MEMORY_TASK_TIMEOUT'), 'MEMORY_TASK_TIMEOUT'], [new Error('SQLITE_FULL'), 'MEMORY_STORAGE_FAILED'],
    [new Error('401 api-key fixture-secret'), 'MEMORY_AUTH_FAILED'], [new Error('fetch failed'), 'MEMORY_NETWORK_FAILED']]) {
    assert.equal(classifyMemoryFailure(error), expected);
    assert.equal(memoryFailureMessage(expected).includes('fixture-secret'), false);
  }
  results.push('receipt-only acknowledgements preserve quotes/code; stable failure categories never expose provider secrets');
  function fixture(name, options = {}) {
    const workspace = path.join(staging, name);
    mkdirSync(workspace, { recursive: true });
    const owner = new QaMemoryDatabase(); owners.push(owner);
    const db = owner.getDatabase(workspace); databases.push(db);
    const resolver = new MemoryScopeResolver({ getActiveWorkspacePath: () => workspace,
      listRegisteredWorkspacePaths: () => [workspace], getPrincipalId: () => 'principal-a' });
    const scope = resolver.resolveActive().scope;
    const writer = new MemoryWriteService(owner, workspace);
    writer.updateWorkspaceConfig(scope, { enabled: true, writeMode: 'auto' });
    const routes = new Set(['chat', 'knowledge-base', 'current-note-direct', 'current-note-react']);
    const validator = (route, agent) => routes.has(route) && agent === 'default';
    const repo = new QaMemoryRepository(owner, workspace, { resolveScope: () => scope, isRouteEnabled: validator });
    const sources = new MemoryExtractionSourceRepository(db, validator);
    const session = repo.createSession('chat').sessionId;
    function start(id, route = 'chat') { repo.startTurn(session, { turnId: id, userText: `企业用户原话 ${id}`, scopeLabel: '', route }); }
    function finish(id, archiveScope = scope) { repo.finalizeTurn(session, id, { type: 'answer', answer: '答复', completeness: 'complete', sources: [] }, { archiveScope }); }
    const calls = [];
    const service = new MemoryExtractionService(owner, workspace, {
      revalidateScope: (persisted) => resolver.revalidatePersistedScope(persisted), isRouteEnabled: validator, automaticWriteReady: () => true,
      resolveModel: async () => ({ ready: true, model: 'fixture', providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:1', model: 'fixture' }, contextWindowTokens: 8192 }),
      generateJson: async (input) => { calls.push(input); const output = { schemaVersion: 2, topics: [], decisions: [] }; input.onRawResponse?.(JSON.stringify(output)); return output; },
      ...options,
    }); services.push(service);
    return { owner, workspace, db, scope, writer, routes, repo, sources, session, start, finish, service, calls,
      scheduler: new MemoryExtractionScheduler(owner, workspace) };
  }
  async function run(f, id) {
    f.service.scheduleAfterCompletedTurn(f.scope, { sessionId: f.session, messageId: id });
    const job = f.db.prepare(`SELECT id FROM memory_extraction_jobs WHERE status IN ('queued','retry') ORDER BY created_at DESC LIMIT 1`).get();
    assert.ok(job, 'must enqueue a trustworthy completed source');
    f.db.prepare(`UPDATE memory_extraction_jobs SET due_at = ? WHERE id = ?`).run(new Date().toISOString(), job.id);
    f.db.prepare(`UPDATE memory_extraction_pending_sources SET due_at = ?`).run(new Date().toISOString());
    f.service.start();
    await waitFor(() => {
      const status = f.db.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(job.id)?.status;
      return ['done', 'failed', 'stale', 'cancelled'].includes(status) || status === 'retry' && (f.service.stopped || f.service.maintenancePaused);
    });
    return f.scheduler.getJob(f.scope, job.id);
  }

  const ackFixture = fixture('acknowledgement');
  ackFixture.start('acknowledgement');
  ackFixture.repo.finalizeTurn(ackFixture.session, 'acknowledgement', { type: 'answer', answer: acknowledgement, completeness: 'complete', sources: [] }, { archiveScope: ackFixture.scope });
  assert.equal(ackFixture.db.prepare('SELECT assistant_text FROM qa_turns WHERE turn_id=?').get('acknowledgement').assistant_text, normalizeMemorySaveClaims(acknowledgement));
  assert.equal(ackFixture.db.prepare('SELECT user_text FROM qa_turns WHERE turn_id=?').get('acknowledgement').user_text, '企业用户原话 acknowledgement');
  const f = fixture('sources');
  f.start('A'); f.start('B');
  f.db.prepare(`UPDATE qa_turns SET created_at = '2026-01-01T00:00:00.000Z'`).run();
  f.finish('B'); await run(f, 'B'); f.finish('A'); await run(f, 'A');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n, 2);
  assert.equal(f.writer.getSubject(f.scope).extractCursorMessageId, 'B');
  assert.deepEqual(f.sources.eligible(f.scope, 0), []);
  results.push('T02 late completion, equal timestamps, once-only receipts, monotonic cursor');
  for (const id of ['foreign', 'unowned', 'observe', 'disabled-agent', 'replacement']) { f.start(id); f.finish(id); }
  f.db.prepare(`UPDATE qa_turns SET result_metadata_json = json_set(result_metadata_json, '$.memoryScope.principalId', 'principal-b') WHERE turn_id = 'foreign'`).run();
  f.db.prepare(`UPDATE qa_turns SET result_metadata_json = '{}' WHERE turn_id = 'unowned'`).run();
  f.db.prepare(`UPDATE qa_turns SET result_metadata_json = json_set(result_metadata_json, '$.route', 'current-note-direct') WHERE turn_id = 'observe'`).run();
  f.routes.delete('current-note-direct');
  f.db.prepare(`UPDATE qa_turns SET result_metadata_json = json_set(result_metadata_json, '$.memoryExtractionAgentId', 'unknown') WHERE turn_id = 'disabled-agent'`).run();
  f.db.prepare(`UPDATE qa_turns SET replaced_by_turn_id = 'B' WHERE turn_id = 'replacement'`).run();
  assert.deepEqual(f.sources.eligible(f.scope, 0), []);
  assert.deepEqual(f.sources.eligible(f.scope, 0, false).map((source) => source.messageId), ['A', 'B']);
  results.push('T01 owner, legacy, route, Agent and replacement isolation');
  f.start('before-clear'); const cleared = f.writer.clear(f.scope); f.finish('before-clear');
  assert.equal(cleared.memoryGeneration, 1);
  assert.deepEqual(f.sources.eligible(f.scope, 1), []);
  f.start('after-clear'); f.finish('after-clear'); await run(f, 'after-clear');
  assert.equal(f.db.prepare(`SELECT memory_generation FROM memory_extraction_turn_receipts WHERE turn_id = 'after-clear'`).get().memory_generation, 1);
  results.push('T03 start generation survives clear, new generation works');
  const crash = fixture('startup-sweep'); crash.start('durable'); crash.finish('durable');
  assert.equal(crash.db.prepare(`SELECT COUNT(*) AS n FROM memory_extraction_jobs`).get().n, 0);
  crash.service.start();
  const sweepJob = crash.db.prepare(`SELECT * FROM memory_extraction_jobs`).get(); assert.ok(sweepJob);
  await run(crash, 'durable');
  const failed = fixture('exhaustion', { resolveModel: async () => ({ ready: false, code: 'unavailable', message: 'fixture' }) });
  failed.start('failed'); failed.finish('failed'); const failedJob = await run(failed, 'failed');
  assert.equal(failedJob.attempts, 3); assert.equal(failedJob.claimedSources.length, 1);
  failed.service.start(); assert.equal(failed.db.prepare(`SELECT COUNT(*) AS n FROM memory_extraction_jobs`).get().n, 1);
  failed.start('fresh'); failed.finish('fresh'); await run(failed, 'fresh');
  assert.equal(failed.db.prepare(`SELECT COUNT(*) AS n FROM memory_extraction_jobs`).get().n, 2);
  assert.deepEqual(failed.scheduler.getJob(failed.scope, failedJob.id).claimedSources.map((source) => source.turnId), ['failed']);
  results.push('T04 startup gap recovery and exhausted fingerprint exclusion');
  const migration = fixture('migration'); migration.start('legacy'); migration.finish('legacy');
  const oldSources = migration.sources.eligible(migration.scope, 0);
  runInImmediateTransaction(migration.db, () => migration.sources.commit(migration.scope, 0, 'legacy-job', oldSources));
  migration.scheduler.schedule(migration.scope, migration.session);
  migration.db.exec(`DELETE FROM memory_extraction_turn_receipts; ALTER TABLE memory_extraction_jobs DROP COLUMN claimed_sources_json; PRAGMA user_version=9;`);
  migrateQaMemoryDatabase(migration.db); migrateQaMemoryDatabase(migration.db);
  assert.equal(migration.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n, 1);
  assert.equal(migration.db.prepare('SELECT outcome FROM memory_extraction_turn_receipts').get().outcome, 'legacy_baseline');
  assert.equal(migration.db.prepare('SELECT last_error FROM memory_extraction_jobs').get().last_error, 'LEGACY_EXTRACTION_ELIGIBILITY_UNKNOWN');
  assert.equal(migration.db.prepare('SELECT SUM(hits) AS n FROM memory_topic_stats').get().n, null);
  results.push('T05 repeatable migration baseline and legacy hold');
  const legacyFailed = fixture('legacy-failed'); legacyFailed.start('old-failed'); legacyFailed.finish('old-failed');
  legacyFailed.scheduler.schedule(legacyFailed.scope, legacyFailed.session);
  legacyFailed.db.exec(`UPDATE memory_extraction_jobs SET status='failed', attempts=3; ALTER TABLE memory_extraction_jobs DROP COLUMN claimed_sources_json; PRAGMA user_version=9;`);
  migrateQaMemoryDatabase(legacyFailed.db); migrateQaMemoryDatabase(legacyFailed.db);
  assert.equal(legacyFailed.db.prepare('SELECT last_error FROM memory_extraction_jobs').get().last_error, 'LEGACY_FAILURE_SOURCE_UNKNOWN');
  assert.equal(legacyFailed.service.getRuntimeStatus(legacyFailed.scope).migrationHeldJobs, 1);
  const mutation = fixture('source-fingerprint'); mutation.start('mutated'); mutation.finish('mutated');
  const captured = claimSources(mutation.sources.eligible(mutation.scope, 0), 0);
  mutation.db.prepare(`UPDATE qa_turns SET user_text = '用户修订后的完整原文' WHERE turn_id = 'mutated'`).run();
  assert.throws(() => mutation.sources.readClaim(mutation.scope, 0, captured), /SOURCE_CHANGED/u);
  results.push('source fingerprint rejects changes during await');

  const decision = (id) => ({ operation: 'add', targetItemId: null, relation: 'independent', evidenceQuote: `企业用户原话 ${id}`, kind: 'preference', content: '用户偏好中文企业案例', topic: '案例偏好', importance: 3, inferred: false, sourceMessageId: id, expiresAt: null });
  const valid = { schemaVersion: 2, topics: [], decisions: [decision('strict')] };
  for (const inferred of [undefined, 'false', null, 0]) {
    const value = structuredClone(valid); value.decisions[0].inferred = inferred;
    if (inferred === undefined) delete value.decisions[0].inferred;
    assert.throws(() => parseMemoryExtractionOutput(value, new Set(['strict'])));
  }
  for (const [key, value] of [['importance', 1.5], ['importance', 6], ['topic', 42], ['expiresAt', {}], ['sourceMessageId', 'foreign']]) {
    const output = structuredClone(valid); output.decisions[0][key] = value;
    assert.throws(() => parseMemoryExtractionOutput(output, new Set(['strict'])));
  }
  assert.throws(() => parseMemoryExtractionOutput({ ...valid, extra: true }, new Set(['strict'])));
  assert.throws(() => parseMemoryExtractionOutput({ ...valid, topics: [42] }, new Set(['strict'])));
  const invalidDate = structuredClone(valid); invalidDate.decisions[0].expiresAt = 'not-a-date';
  assert.equal(parseMemoryExtractionOutput(invalidDate, new Set(['strict'])).decisions[0].expiresAt, undefined);
  results.push('T07 strict schema required fields, types, extras and source IDs');
  for (const firstResponse of ['empty', 'length', 'schema', 'source']) {
    const budgets = []; const retry = fixture(`structured-${firstResponse}`, { generateJson: async (input) => {
      budgets.push(input.maxOutputTokens);
      if (budgets.length === 1 && firstResponse === 'empty') throw new Error('远程服务未返回内容。');
      if (budgets.length === 1 && firstResponse === 'schema') throw new StructuredOutputContractError('schema-validation', 'fixture invalid JSON contract');
      const allowedIds = input.jsonSchema.schema.properties.decisions.items.properties.sourceMessageId.enum;
      assert.deepEqual(allowedIds, ['structured']);
      if (budgets.length === 2 && firstResponse === 'source') assert.match(input.prompt, /上次输出未通过校验：sourceMessageId/u);
      if (budgets.length === 1 && firstResponse === 'source') {
        const invalid = { schemaVersion: 2, topics: [], decisions: [decision('foreign')] };
        input.onRawResponse?.(JSON.stringify(invalid)); return invalid;
      }
      const output = { schemaVersion: 2, topics: [], decisions: [] };
      input.onRawResponse?.(JSON.stringify(output)); input.onFinishReason?.(budgets.length === 1 ? 'length' : 'stop'); return output;
    } });
    retry.start('structured'); retry.finish('structured'); assert.equal((await run(retry, 'structured')).status, 'done');
    assert.deepEqual(budgets, [1200, 4000]);
  }
  results.push('T08 empty, truncated, schema and invalid source outputs retry with feedback at 4000 tokens; source enum stays scoped');
  let topicAttempts = 0;
  const atomic = fixture('topic-atomic', { generateJson: async (input) => {
    assert.equal(atomic.db.inTransaction, false, 'network awaits must occur outside transaction');
    if (input.callKind === 'memory-topic-merge') {
      topicAttempts++;
      if (topicAttempts <= 2) throw new Error('second topic network failure');
      return { normalizedKey: null };
    }
    const output = { schemaVersion: 2, topics: ['续贷客户', '风险额度'], decisions: [decision('atomic')] };
    input.onRawResponse?.(JSON.stringify(output)); return output;
  } });
  atomic.start('atomic'); atomic.finish('atomic'); const atomicJob = await run(atomic, 'atomic');
  assert.equal(atomicJob.attempts, 3); assert.equal(atomicJob.status, 'done');
  assert.deepEqual(atomic.db.prepare('SELECT hits FROM memory_topic_stats ORDER BY normalized_key').all().map((row) => row.hits), [1, 1]);
  assert.equal(atomic.db.prepare(`SELECT COUNT(*) AS n FROM memory_items`).get().n, 1);
  results.push('T09 second topic fails twice, successful segment counts once');
  const rollback = fixture('commit-rollback', { generateJson: async (input) => {
    const output = { schemaVersion: 2, topics: ['客户续贷'], decisions: [decision('rollback')] };
    input.onRawResponse?.(JSON.stringify(output)); return output;
  } });
  rollback.start('rollback'); rollback.finish('rollback');
  rollback.db.exec(`CREATE TRIGGER fixture_commit_failure BEFORE INSERT ON memory_extraction_turn_receipts BEGIN SELECT RAISE(ABORT, 'fixture disk error'); END;`);
  assert.equal((await run(rollback, 'rollback')).status, 'failed');
  for (const table of ['memory_items', 'memory_topic_stats', 'memory_extraction_turn_receipts']) assert.equal(rollback.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(rollback.writer.getSubject(rollback.scope).extractCursorMessageId, null);
  results.push('T09b receipt failure rolls back decisions, topics, promotions and cursor');
  const aliases = fixture('alias-dedup'); const topicService = new MemoryTopicService(aliases.owner, aliases.workspace);
  await topicService.recordTopics(aliases.scope, ['授信审批'], 0);
  const plans = await topicService.prepareTopics(aliases.scope, ['信贷审查', '贷款审批'], { resolveUncertainTopic: async () => '授信审批' });
  runInImmediateTransaction(aliases.db, () => topicService.applyTopics(aliases.scope, plans, 0));
  assert.equal(aliases.db.prepare('SELECT hits FROM memory_topic_stats').get().hits, 2);
  results.push('T10 aliases resolving to one concept increment once');
  const forgotten = fixture('ignored-tombstone', { generateJson: async (input) => {
    const output = { schemaVersion: 2, topics: [], decisions: [decision('forgotten')] }; input.onRawResponse?.(JSON.stringify(output)); return output;
  } });
  const removed = forgotten.writer.createManual(forgotten.scope, { kind: 'preference', content: decision('forgotten').content, topic: decision('forgotten').topic });
  forgotten.writer.delete(forgotten.scope, removed.item.id); forgotten.start('forgotten'); forgotten.finish('forgotten');
  assert.equal((await run(forgotten, 'forgotten')).status, 'done');
  assert.equal(forgotten.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, 0);
  assert.equal(forgotten.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n, 1);
  results.push('forgotten decision is ignored without resurrection or repeated extraction');
  for (const count of [41, 5]) {
    const bulk = fixture(`bounded-batch-${count}`);
    for (let i = 0; i < count; i++) {
      const id = `batch-${String(i).padStart(3, '0')}`; bulk.start(id); bulk.finish(id);
      if (count === 5) bulk.db.prepare('UPDATE qa_turns SET created_at=? WHERE turn_id=?').run(new Date(Date.UTC(2026, 0, 1, i * 2)).toISOString(), id);
    }
    const due = new Date(); bulk.scheduler.schedule(bulk.scope, bulk.session, { sources: claimSources(bulk.sources.eligible(bulk.scope, 0), 0), dueAt: due }); bulk.service.start();
    await waitFor(() => bulk.db.prepare("SELECT COUNT(*) AS n FROM memory_extraction_jobs WHERE status='done'").get().n === 1);
    const expected = count === 41 ? 40 : 3;
    assert.equal(bulk.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n, expected);
    const followup = bulk.db.prepare("SELECT due_at FROM memory_extraction_jobs WHERE status='queued'").get(); assert.ok(followup);
    const firstDone = bulk.db.prepare("SELECT finished_at FROM memory_extraction_jobs WHERE status='done'").get();
    assert.ok(Date.parse(followup.due_at) - Date.parse(firstDone.finished_at) >= 14000);
    assert.equal(bulk.db.prepare("SELECT COUNT(*) AS n FROM memory_extraction_pending_sources WHERE reason='backlog'").get().n, count - expected);
    const immediate = new Date().toISOString(); bulk.db.prepare("UPDATE memory_extraction_jobs SET due_at=? WHERE status='queued'").run(immediate); bulk.db.prepare('UPDATE memory_extraction_pending_sources SET due_at=?').run(immediate); bulk.service.start();
    await waitFor(() => bulk.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n === count);
    assert.equal(bulk.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_jobs').get().n, 2);
  }
  results.push('40-message and three-segment caps produce only confirmed 15-second backlog, then once-only completion');
  const partial = fixture('partial-segments', { generateJson: async (input) => {
    const segment = input.prompt.split('<new_user_messages>').at(-1).split('</new_user_messages>')[0];
    if (segment.includes('[part-2]')) throw new Error('segment two offline');
    const output = { schemaVersion: 2, topics: ['公司经营'], decisions: [] }; input.onRawResponse?.(JSON.stringify(output)); return output;
  } });
  partial.start('part-1'); partial.finish('part-1'); partial.start('part-2'); partial.finish('part-2');
  partial.db.prepare(`UPDATE qa_turns SET created_at = ? WHERE turn_id = ?`).run('2026-01-01T00:00:00.000Z', 'part-1');
  partial.db.prepare(`UPDATE qa_turns SET created_at = ? WHERE turn_id = ?`).run('2026-02-01T00:00:00.000Z', 'part-2');
  partial.service.scheduleAfterCompletedTurn(partial.scope, { sessionId: partial.session, messageId: 'part-2' });
  assert.equal((await run(partial, 'part-1')).status, 'failed');
  assert.deepEqual(partial.db.prepare('SELECT turn_id FROM memory_extraction_turn_receipts').all().map((row) => row.turn_id), ['part-1']);
  assert.equal(partial.db.prepare('SELECT hits FROM memory_topic_stats').get().hits, 1);
  results.push('T11 earlier segment survives and is excluded from later retries');
  for (const scenario of ['stop', 'pause', 'clear', 'switch', 'off', 'explicit-only']) {
    let release; let entered = false; let sentSignal;
    const race = fixture(`race-${scenario}`, { generateJson: async (input) => {
      entered = true; sentSignal = input.signal;
      await new Promise((resolve) => { release = resolve; }); // Deliberately ignores abort.
      const output = { schemaVersion: 2, topics: ['不得累计'], decisions: [decision('race')] };
      input.onRawResponse?.(JSON.stringify(output)); return output;
    } });
    race.start('race'); race.finish('race'); const running = run(race, 'race');
    await waitFor(() => entered);
    if (scenario === 'clear') { race.writer.clear(race.scope); release(); }
    else if (scenario === 'switch') { race.service.options.revalidateScope = () => undefined; release(); }
    else if (scenario === 'pause') { race.service.pauseForMaintenance(); }
    else if (scenario === 'off' || scenario === 'explicit-only') {
      race.writer.updateWorkspaceConfig(race.scope, scenario === 'off' ? { enabled: false } : { writeMode: 'explicit_only' });
      race.service.refreshConfiguration(race.scope);
    }
    else await race.service.stop();
    await running;
    if (['pause', 'stop', 'off', 'explicit-only'].includes(scenario)) assert.equal(sentSignal.aborted, true);
    release(); await new Promise((resolve) => setTimeout(resolve, 20));
    for (const table of ['memory_items', 'memory_topic_stats', 'memory_extraction_turn_receipts']) assert.equal(race.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${scenario} must suppress late writes`);
    assert.equal(race.service.maintenanceBusy, false);
    if (scenario === 'stop') {
      const oldJob = race.db.prepare('SELECT * FROM memory_extraction_jobs').get(); assert.equal(oldJob.status, 'retry'); assert.equal(oldJob.attempts, 1);
      race.service = new MemoryExtractionService(race.owner, race.workspace, { ...race.service.options, generateJson: async input => {
        const output = { schemaVersion: 2, topics: [], decisions: [] }; input.onRawResponse?.(JSON.stringify(output)); return output;
      } }); services.push(race.service);
      const resumed = await run(race, 'race'); assert.equal(resumed.id, oldJob.id); assert.equal(resumed.attempts, 2); assert.equal(resumed.status, 'done');
      assert.equal(race.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_jobs').get().n, 1);
    }
  }
  results.push('T13 stop, maintenance, clear, workspace switch, memory off and explicit-only suppress noncooperative late responses');
  const timeout = fixture('timeout', { limits: { extractionRequestTimeoutMs: 20, extractionJobTimeoutMs: 150 }, generateJson: async () => new Promise(() => {}) });
  timeout.start('timeout'); timeout.finish('timeout'); const timeoutJob = await run(timeout, 'timeout');
  assert.equal(timeoutJob.status, 'failed'); assert.equal(timeoutJob.attempts, 3);
  assert.match(timeoutJob.lastError, /TIMEOUT/u);
  assert.equal(timeout.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts').get().n, 0);
  results.push('T14 bounded timeout retains two background retries without receipts');
  const debounce = fixture('debounce'); debounce.start('debounce-1'); debounce.finish('debounce-1'); debounce.start('debounce-2'); debounce.finish('debounce-2');
  const t0 = new Date('2026-01-01T00:00:00.000Z'); const t30 = new Date(t0.getTime() + 30000);
  const debounceSources = debounce.sources.eligible(debounce.scope, 0);
  const initial = debounce.scheduler.schedule(debounce.scope, debounce.session, { now: t0, sources: claimSources([debounceSources[0]], 0) });
  const delayed = debounce.scheduler.schedule(debounce.scope, debounce.session, { now: t30, sources: claimSources([debounceSources[1]], 0) });
  assert.equal(initial.id, delayed.id); assert.equal(delayed.dueAt, '2026-01-01T00:02:00.000Z');
  assert.equal(debounce.writer.getSubject(debounce.scope).extractScheduledAt, delayed.dueAt);
  const claimed = debounce.scheduler.claimNextDue(() => ({ scope: debounce.scope, workspacePath: debounce.workspace }), new Date('2026-01-01T00:02:00.000Z'));
  assert.equal(claimed.claimedSources.length, 2);
  debounce.start('during-running'); debounce.finish('during-running');
  const incoming = debounce.sources.eligible(debounce.scope, 0).find((source) => source.messageId === 'during-running');
  debounce.scheduler.schedule(debounce.scope, debounce.session, { now: new Date('2026-01-01T00:02:30.000Z'), sources: claimSources([incoming], 0) });
  assert.deepEqual(debounce.scheduler.getJob(debounce.scope, claimed.id).claimedSources, claimed.claimedSources);
  debounce.db.prepare('UPDATE memory_subjects SET last_extracted_at=?').run('2026-01-01T00:02:40.000Z');
  debounce.scheduler.complete(debounce.scope, claimed.id, new Date('2026-01-01T00:02:40.000Z'));
  const followup = debounce.db.prepare(`SELECT due_at FROM memory_extraction_jobs WHERE status='queued'`).get();
  assert.equal(followup.due_at, '2026-01-01T00:07:40.000Z', 'new messages retain debounce and actual last-extraction minimum instead of 15s');
  results.push('T15 queued debounce persists; running claim stays fixed; new pending keeps normal due');
  const changed = fixture('changed-during-await', { generateJson: async (input) => {
    if (!changed.mutated) { changed.db.prepare(`UPDATE qa_turns SET user_text = '新版本原文' WHERE turn_id='change-A'`).run(); changed.mutated = true; }
    const output = { schemaVersion: 2, topics: [], decisions: [] }; input.onRawResponse?.(JSON.stringify(output)); return output;
  } });
  changed.start('change-A'); changed.finish('change-A'); changed.start('change-B'); changed.finish('change-B');
  changed.service.scheduleAfterCompletedTurn(changed.scope, { sessionId: changed.session, messageId: 'change-B' });
  const changedJob = await run(changed, 'change-A'); assert.equal(changedJob.status, 'stale'); assert.equal(changedJob.lastError, 'SOURCE_CHANGED');
  await waitFor(() => changed.db.prepare(`SELECT 1 FROM memory_extraction_turn_receipts WHERE turn_id='change-B'`).get());
  const successor = changed.db.prepare(`SELECT attempts FROM memory_extraction_jobs WHERE status='done'`).get(); assert.equal(successor.attempts, 2);
  assert.equal(changed.db.prepare(`SELECT carried_attempts FROM memory_extraction_pending_sources WHERE turn_id='change-A'`).get().carried_attempts, 0);
  results.push('T12 changed source gets new version due; unchanged successor inherits attempts');
  function proposalFixture(name, makeOutput) {
    const f = fixture(`proposal-${name}`, { generateJson: async input => {
      assert.equal(input.jsonSchema.schema.properties.schemaVersion.const, 2);
      const output = makeOutput(f, input); input.onRawResponse?.(JSON.stringify(output)); return output;
    } });
    f.old = f.writer.createManual(f.scope, { kind: 'profile', content: '我是程序员，主要做 Java 和 Agent 开发', topic: '身份' }).item;
    f.source = '我也在做 Python 开发';
    f.newDecision = () => ({ operation: 'add', targetItemId: null, relation: 'supplement', evidenceQuote: f.source,
      kind: 'profile', content: '我也在做 Python 开发', topic: '身份', importance: 4, inferred: false, sourceMessageId: 'proposal', expiresAt: null });
    f.run = async () => { f.start('proposal'); f.db.prepare('UPDATE qa_turns SET user_text=? WHERE turn_id=?').run(f.source, 'proposal'); f.finish('proposal'); return run(f, 'proposal'); };
    return f;
  }
  const addition = proposalFixture('supplement', f => ({ schemaVersion: 2, topics: [], decisions: [f.newDecision()] }));
  assert.equal((await addition.run()).status, 'done');
  assert.equal(addition.writer.list(addition.scope, { statuses: ['active'] }).items.length, 1);
  assert.equal(addition.db.prepare('SELECT status FROM memory_items WHERE id=?').get(addition.old.id).status, 'active');
  assert.equal(JSON.parse(addition.db.prepare("SELECT result_json FROM qa_turns WHERE turn_id='proposal'").get().result_json).memoryExtraction.pending, 1);
  for (const operation of ['update', 'delete']) {
    const f = proposalFixture(operation, f => ({ schemaVersion: 2, topics: [], decisions: [{ ...f.newDecision(), operation,
      targetItemId: f.old.id, relation: 'correction', content: operation === 'delete' ? f.old.content : '我现在只做 Python 开发' }] }));
    f.source = '我不再做 Java，请撤销之前的开发身份';
    assert.equal((await f.run()).status, 'done');
    assert.equal(f.db.prepare('SELECT status FROM memory_items WHERE id=?').get(f.old.id).status, 'active');
    assert.equal(f.writer.list(f.scope, { statuses: ['pending'] }).items[0].proposalAction, operation === 'update' ? 'replace' : 'retire');
    const summary = JSON.parse(f.db.prepare("SELECT result_json FROM qa_turns WHERE turn_id='proposal'").get().result_json).memoryExtraction;
    assert.equal(summary.active, 0); assert.equal(summary.pending, 1); assert.equal(summary.status, 'applied');
  }
  for (const invalid of ['foreign-target', 'pending-target', 'old-evidence', 'two-target-actions', 'duplicate-fact', 'old-protocol']) {
    const f = proposalFixture(invalid, f => {
      let d = f.newDecision();
      if (invalid === 'foreign-target') d = { ...d, operation: 'update', targetItemId: 'unshown-owner-target', relation: 'correction' };
      if (invalid === 'pending-target') d = { ...d, operation: 'update', targetItemId: f.pending.id, relation: 'correction' };
      if (invalid === 'old-evidence') d.evidenceQuote = f.old.content;
      const decisions = invalid === 'two-target-actions'
        ? [{ ...d, operation: 'update', targetItemId: f.old.id, relation: 'correction' }, { ...d, operation: 'delete', targetItemId: f.old.id, relation: 'correction', content: f.old.content }]
        : invalid === 'duplicate-fact' ? [d, { ...d }] : [d];
      return { schemaVersion: invalid === 'old-protocol' ? 1 : 2, topics: ['不得部分提交'], decisions };
    });
    if (invalid === 'pending-target') f.pending = f.writer.write(f.scope, { kind: 'profile', content: '待确认的其他身份', origin: 'extracted', operation: 'add', inferred: true, memoryGeneration: 0 }).item;
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n;
    assert.equal((await f.run()).status, 'failed');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, before);
    assert.equal(f.db.prepare('SELECT content,status FROM memory_items WHERE id=?').get(f.old.id).content, f.old.content);
    assert.equal(f.db.prepare('SELECT status FROM memory_items WHERE id=?').get(f.old.id).status, 'active');
    assert.equal(new MemoryTurnStatusService(f.owner, f.workspace, () => true).get(f.scope, ['proposal'])[0].extraction.reason, 'INVALID_MODEL_OUTPUT');
    for (const table of ['memory_topic_stats', 'memory_extraction_turn_receipts']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(JSON.parse(f.db.prepare("SELECT result_json FROM qa_turns WHERE turn_id='proposal'").get().result_json).memoryExtraction, undefined);
  }
  let targetRequests = 0;
  const editedTarget = proposalFixture('edited-target', f => {
    if (++targetRequests > 1) throw new Error('fixture provider offline after stale response');
    f.writer.updateManual(f.scope, f.old.id, { content: '人工更正后完整 Java 和 Agent 身份' });
    return { schemaVersion: 2, topics: ['不得部分提交'], decisions: [{ ...f.newDecision(), operation: 'update', relation: 'correction', targetItemId: f.old.id }] };
  });
  assert.equal((await editedTarget.run()).status, 'failed');
  assert.equal(editedTarget.writer.list(editedTarget.scope, { statuses: ['pending'] }).items.length, 0);
  assert.equal(editedTarget.writer.list(editedTarget.scope, { statuses: ['active'] }).items[0].writeProtection, 'user');
  results.push('v2 supplement retains Java/Agent; update/delete pending with durable outcomes; evidence/target/duplicate preflight and edited-target transactions commit zero on failure');
  const projection = new MemoryTurnStatusService(addition.owner, addition.workspace, () => true);
  let turnState = projection.get(addition.scope, ['proposal'])[0];
  assert.equal(turnState.extraction.status, 'applied'); assert.equal(turnState.extraction.summary.active, 0);
  assert.equal(turnState.extraction.currentItems[0].status, 'pending');
  const newId = turnState.extraction.summary.itemIds[0];
  addition.writer.confirm(addition.scope, newId);
  assert.equal(projection.get(addition.scope, ['proposal'])[0].extraction.currentItems[0].status, 'active');
  addition.writer.delete(addition.scope, newId);
  assert.equal(projection.get(addition.scope, ['proposal'])[0].extraction.currentItems[0].status, 'deleted');
  addition.writer.clear(addition.scope);
  assert.equal(projection.get(addition.scope, ['proposal'])[0].extraction.status, 'stale');
  assert.equal(addition.writer.list(addition.scope).items.length, 0);
  const foreignProjection = projection.get(f.scope, ['proposal']); assert.deepEqual(foreignProjection, []);
  const failedProjection = new MemoryTurnStatusService(failed.owner, failed.workspace, () => true).get(failed.scope, ['failed'])[0];
  assert.equal(failedProjection.extraction.status, 'failed'); assert.equal(failedProjection.extraction.reason, 'MODEL_UNAVAILABLE');
  const baselineProjection = new MemoryTurnStatusService(migration.owner, migration.workspace, () => true).get(migration.scope, ['legacy'])[0];
  assert.equal(baselineProjection.extraction.status, 'disabled'); assert.equal(baselineProjection.extraction.reason, 'legacy_baseline');
  results.push('per-turn projection distinguishes applied/current deleted/clear/failed; polling is read-only and cross-owner returns no data');
  if (!process.argv.includes('--extraction-only')) {
  function consolidationFixture(name, expiry1 = null, expiry2 = expiry1, options = {}) {
    const f = fixture(name);
    const first = f.writer.createManual(f.scope, { kind: 'preference', content: '偏好深色紧凑界面', expiresAt: expiry1 }).item;
    const second = f.writer.createManual(f.scope, { kind: 'preference', content: '喜欢深色紧凑布局', expiresAt: expiry2 }).item;
    const service = new MemoryConsolidationService(f.owner, f.workspace, { automaticWriteReady: () => true, ...options }); consolidationServices.push(service);
    return { ...f, first, second, consolidation: service };
  }
  const approval = { merge: true, content: '偏好深色且紧凑的界面布局', topic: '界面偏好', importance: 4 };
  for (const [firstExpiry, secondExpiry] of [[null, '2027-10-01T00:00:00Z'], ['2027-10-01T00:00:00Z', '2027-11-01T00:00:00Z']]) {
    const incompatible = consolidationFixture(`expiry-${consolidationServices.length}`, firstExpiry, secondExpiry);
    let reviewed = 0;
    const result = await incompatible.consolidation.consolidate(incompatible.scope, 'manual', async () => { reviewed++; return approval; });
    assert.equal(reviewed, 0); assert.equal(result.mergedClusters, 0); assert.equal(result.skippedExpiryClusters, 1);
  }
  const finite = consolidationFixture('finite-expiry', '2027-10-01T00:00:00Z');
  const finiteResult = await finite.consolidation.consolidate(finite.scope, 'manual', async () => approval);
  assert.equal(finiteResult.mergedClusters, 0); assert.equal(finiteResult.previews.length, 1);
  assert.equal(finite.writer.list(finite.scope, { statuses: ['active'] }).items.length, 2);
  finite.consolidation.approvePreview(finite.scope, finiteResult.previews[0].id, finiteResult.previews[0].fingerprint);
  assert.equal(finite.writer.list(finite.scope, { statuses: ['active'] }).items[0].expiresAt, '2027-10-01T00:00:00.000Z');
  assert.equal(finite.db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE status='superseded' AND superseded_by IS NOT NULL`).get().n, 2);
  results.push('T17 mixed expiry groups skip, matching finite expiry is inherited, lineage retained');
  const edited = consolidationFixture('edited-review');
  const editResult = await edited.consolidation.consolidate(edited.scope, 'manual', async () => {
    edited.writer.updateManual(edited.scope, edited.first.id, { content: '用户现在偏好浅色英文界面' }); return approval;
  });
  assert.equal(editResult.mergedClusters, 0);
  assert.throws(() => edited.consolidation.approvePreview(edited.scope, editResult.previews[0].id, editResult.previews[0].fingerprint), error => error.code === 'SOURCE_CHANGED');
  assert.equal(edited.writer.list(edited.scope, { statuses: ['active'] }).items.length, 2);
  const usage = consolidationFixture('usage-review');
  const usageResult = await usage.consolidation.consolidate(usage.scope, 'manual', async () => {
    usage.db.prepare(`UPDATE memory_items SET use_count=use_count+1, last_used_at=?, updated_at=? WHERE id=?`).run(new Date().toISOString(), new Date().toISOString(), usage.first.id); return approval;
  });
  usage.consolidation.approvePreview(usage.scope, usageResult.previews[0].id, usageResult.previews[0].fingerprint);
  assert.equal(usage.writer.list(usage.scope, { statuses: ['active'] }).items.length, 1, 'usage counters do not invalidate semantic snapshot');
  results.push('T18 semantic edits prevent merge; usage-only updates allow merge');
  const deleted = consolidationFixture('deleted-review');
  const deleteResult = await deleted.consolidation.consolidate(deleted.scope, 'manual', async () => { deleted.writer.delete(deleted.scope, deleted.first.id); return approval; });
  assert.equal(deleteResult.mergedClusters, 0);
  assert.throws(() => deleted.consolidation.approvePreview(deleted.scope, deleteResult.previews[0].id, deleteResult.previews[0].fingerprint), error => error.code === 'SOURCE_CHANGED');
  assert.equal(deleted.writer.list(deleted.scope, { statuses: ['active'] }).items.length, 1);
  const expiresDuringReview = consolidationFixture('expires-during-review', new Date(Date.now() + 60).toISOString());
  const expiredResult = await expiresDuringReview.consolidation.consolidate(expiresDuringReview.scope, 'manual', async () => {
    await new Promise((resolve) => setTimeout(resolve, 80)); return approval;
  });
  assert.equal(expiredResult.mergedClusters, 0);
  assert.throws(() => expiresDuringReview.consolidation.approvePreview(expiresDuringReview.scope, expiredResult.previews[0].id, expiredResult.previews[0].fingerprint), error => error.code === 'SOURCE_EXPIRED');
  const pendingTarget = consolidationFixture('pending-target');
  pendingTarget.writer.write(pendingTarget.scope, { operation: 'replace', targetItemId: pendingTarget.first.id, expectedTargetFingerprint: pendingTarget.first.targetFingerprint, kind: 'preference', content: '待用户确认的其他偏好', topic: '界面偏好', origin: 'extracted', inferred: true, memoryGeneration: 0 });
  const pendingResult = await pendingTarget.consolidation.consolidate(pendingTarget.scope, 'manual', async () => approval);
  assert.equal(pendingResult.mergedClusters, 0);
  assert.throws(() => pendingTarget.consolidation.approvePreview(pendingTarget.scope, pendingResult.previews[0].id, pendingResult.previews[0].fingerprint), error => error.code === 'TARGET_CONFLICT');
  assert.equal(pendingTarget.writer.list(pendingTarget.scope, { statuses: ['pending'] }).items.length, 1);
  results.push('T19 expiry reached during review and pending target conflicts never merge');
  const concurrent = consolidationFixture('concurrent-consolidation'); let releaseConsolidation; let enteredConsolidation = false;
  const firstRun = concurrent.consolidation.consolidate(concurrent.scope, 'manual', async () => {
    enteredConsolidation = true; await new Promise((resolve) => { releaseConsolidation = resolve; }); return approval;
  });
  await waitFor(() => enteredConsolidation);
  const otherService = new MemoryConsolidationService(concurrent.owner, concurrent.workspace, { automaticWriteReady: () => true }); consolidationServices.push(otherService);
  assert.equal((await otherService.consolidate(concurrent.scope, 'automatic', async () => approval)).skipReason, 'busy');
  releaseConsolidation(); const concurrentResult = await firstRun;
  assert.equal(concurrentResult.mergedClusters, 0); assert.equal(concurrentResult.previews.length, 1);
  results.push('T20 automatic/manual share scope mutex across service instances');
  for (const action of ['stop', 'pause', 'clear', 'switch']) {
    const f = consolidationFixture(`consolidation-${action}`); let release; let entered = false;
    const running = f.consolidation.consolidate(f.scope, 'manual', async () => { entered = true; await new Promise((resolve) => { release = resolve; }); return approval; });
    await waitFor(() => entered);
    if (action === 'stop') await f.consolidation.stop();
    else if (action === 'pause') f.consolidation.pauseForMaintenance();
    else if (action === 'clear') { f.writer.clear(f.scope); release(); }
    else { f.consolidation.options.revalidateScope = () => false; release(); }
    const outcome = await running; assert.equal(outcome.skipReason, 'cancelled'); assert.equal(outcome.mergedClusters, 0);
    release(); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(f.consolidation.maintenanceBusy, false);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE status='superseded'`).get().n, 0);
  }
  const conTimeout = consolidationFixture('consolidation-timeout', null, null, { limits: { consolidationClusterTimeoutMs: 20, consolidationTotalTimeoutMs: 80 } });
  assert.equal((await conTimeout.consolidation.consolidate(conTimeout.scope, 'manual', async () => new Promise(() => {}))).skipReason, 'timeout');
  results.push('T21 consolidation cancellation, generation, workspace and typed timeout');
  const background = consolidationFixture('background-confirmation');
  for (let index = 0; index < 4; index++) background.writer.createManual(background.scope, { kind: 'preference', content: `偏好深色紧凑界面布局 ${index}` });
  background.db.prepare("UPDATE memory_items SET write_protection='none' WHERE workspace_id=?").run(background.scope.workspaceId);
  let backgroundReviews = 0;
  const backgroundResult = await background.consolidation.consolidate(background.scope, 'automatic', async () => { backgroundReviews++; return approval; });
  assert.equal(backgroundResult.skipReason, 'review_required'); assert.equal(backgroundReviews, 0);
  assert.equal(background.writer.list(background.scope, { statuses: ['active'] }).items.length, 6);
  assert.throws(() => background.writer.mergeApproved(background.scope, [background.first.id, background.second.id],
    { kind: 'preference', content: approval.content }), error => error.code === 'USER_REVIEW_REQUIRED');
  results.push('background cannot merge even six unprotected memories; central merge requires exact user review');
  await Promise.all(consolidationServices.map((service) => service.stop()));
  }
  const runtime = fixture('runtime-status');
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).modelState, 'unknown');
  runtime.routes.clear();
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.every((route) => route.reason === 'route_disabled'), true);
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.every((route) => !route.readEnabled && route.readReason === 'route_disabled'), true);
  runtime.routes.add('chat');
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.filter((route) => route.eligible).length, 1);
  runtime.start('runtime'); runtime.finish('runtime'); await run(runtime, 'runtime');
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).modelState, 'ready');
  runtime.writer.updateWorkspaceConfig(runtime.scope, { extractModelId: 'new-model' });
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).modelState, 'unknown');
  runtime.writer.updateWorkspaceConfig(runtime.scope, { writeMode: 'explicit_only' });
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.every((route) => route.reason === 'explicit_only'), true);
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.find((route) => route.route === 'chat').readEnabled, true);
  runtime.writer.setPrincipalEnabled(runtime.scope, false);
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.every((route) => route.reason === 'memory_disabled'), true);
  assert.equal(runtime.service.getRuntimeStatus(runtime.scope).routes.every((route) => !route.readEnabled), true);
  assert.equal(failed.service.getRuntimeStatus(failed.scope).modelState, 'unavailable');
  results.push('T06 four-route status distinguishes observe, auto gates, unknown/validated/unavailable model');
  const retryQueue = fixture('retry-pending'); retryQueue.start('old'); retryQueue.finish('old'); retryQueue.start('new'); retryQueue.finish('new');
  const queueSources = retryQueue.sources.eligible(retryQueue.scope, 0);
  const scheduler = retryQueue.scheduler;
  scheduler.schedule(retryQueue.scope, retryQueue.session, { sources: claimSources([queueSources.find((source) => source.messageId === 'old')], 0), dueAt: t0, now: t0, modelHint: { profileId: 'model_old_source', modelId: 'old-model' } });
  const revalidate = () => ({ scope: retryQueue.scope, workspacePath: retryQueue.workspace });
  const attempt1 = scheduler.claimNextDue(revalidate, t0); scheduler.fail(retryQueue.scope, attempt1.id, 'provider failed', t0);
  scheduler.schedule(retryQueue.scope, retryQueue.session, { sources: claimSources([queueSources.find((source) => source.messageId === 'new')], 0), now: t30, modelHint: { profileId: 'model_new_source', modelId: 'new-model' } });
  const attempt2 = scheduler.claimNextDue(revalidate, t30); assert.equal(attempt2.attempts, 2); assert.deepEqual(attempt2.claimedSources.map((source) => source.turnId), ['old']);
  assert.equal(attempt2.sourceModelId, 'old-model');
  scheduler.fail(retryQueue.scope, attempt2.id, 'provider failed', t30);
  const attempt3 = scheduler.claimNextDue(revalidate, t30); scheduler.fail(retryQueue.scope, attempt3.id, 'provider failed', t30);
  const newJob = retryQueue.db.prepare(`SELECT * FROM memory_extraction_jobs WHERE status='queued'`).get();
  assert.equal(newJob.attempts, 0); assert.equal(newJob.due_at, '2026-01-01T00:02:00.000Z');
  const newClaim = scheduler.claimNextDue(revalidate, new Date(newJob.due_at)); assert.deepEqual(newClaim.claimedSources.map((source) => source.turnId), ['new']);
  assert.equal(newClaim.attempts, 1);
  assert.equal(newClaim.sourceModelId, 'new-model');
  scheduler.complete(retryQueue.scope, newClaim.id, new Date(newJob.due_at));
  assert.equal(retryQueue.sources.eligible(retryQueue.scope, 0).some((source) => source.messageId === 'old'), false);
  results.push('T16 external messages do not reset retry budget or join old claim');
  const relocated = fixture('relocated'); relocated.start('processed'); relocated.finish('processed'); await run(relocated, 'processed');
  relocated.start('pending'); relocated.finish('pending');
  const restoreTarget = relocated.writer.createManual(relocated.scope, { kind: 'profile', content: '恢复前的 Java 与 Agent 身份' }).item;
  const restoreProposal = relocated.writer.write(relocated.scope, { kind: 'profile', content: '恢复前待确认的 Python 更正', origin: 'extracted', operation: 'replace',
    targetItemId: restoreTarget.id, expectedTargetFingerprint: restoreTarget.targetFingerprint, memoryGeneration: 0 }).item;
  const originalClaim = claimSources(relocated.sources.eligible(relocated.scope, 0), 0);
  relocated.scheduler.schedule(relocated.scope, relocated.session, { sources: originalClaim, dueAt: t0, now: t0 });
  const oldClaim = relocated.scheduler.claimNextDue(() => ({ scope: relocated.scope, workspacePath: relocated.workspace }), t0);
  relocated.scheduler.fail(relocated.scope, oldClaim.id, 'temporary failure', t0);
  const targetPath = path.join(staging, 'relocated-target'); mkdirSync(targetPath, { recursive: true });
  const targetResolver = new MemoryScopeResolver({ getActiveWorkspacePath: () => targetPath, listRegisteredWorkspacePaths: () => [targetPath], getPrincipalId: () => 'principal-target' });
  const target = targetResolver.resolveActive();
  migratePhysicalDatabase(relocated.db, { sourceScope: relocated.scope, target, roots: [{ source: relocated.workspace, target: targetPath }], libraries: [], warnings: new Set() });
  const targetSources = new MemoryExtractionSourceRepository(relocated.db, () => true);
  assert.deepEqual(targetSources.eligible(target.scope, 0).map((source) => source.messageId), ['pending']);
  const rebound = relocated.scheduler.getJob(target.scope, oldClaim.id);
  assert.equal(rebound.attempts, 1); assert.equal(targetSources.readClaim(target.scope, 0, rebound.claimedSources).length, 1);
  assert.equal(relocated.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_turn_receipts WHERE workspace_id=? AND principal_id=?').get(target.scope.workspaceId, target.scope.principalId).n, 1);
  const restoredWriter = new MemoryWriteService(relocated.owner, relocated.workspace);
  const proposalContext = restoredWriter.getProposalContext(target.scope, restoreProposal.id);
  assert.equal(proposalContext.invalidReason, null); assert.equal(proposalContext.currentTarget.id, restoreTarget.id);
  assert.equal(proposalContext.proposal.replacesSnapshot.content, restoreTarget.content);
  results.push('physical restore rebinds receipts and matching claim fingerprints while preserving retry budget');
  for (const db of databases) { assert.equal(db.pragma('user_version', { simple: true }), QA_MEMORY_SCHEMA_VERSION); assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
  for (const check of results) console.log(`PASS ${check}`);
  mkdirSync(path.join(root, 'docs/verification'), { recursive: true });
  writeFileSync(path.join(root, process.argv.includes('--extraction-only') ? 'docs/verification/memory-extraction-v2-regression.json' : 'docs/verification/memory-maintenance.json'), JSON.stringify({ verifiedAt: new Date().toISOString(),
    method: 'actual repositories/services with isolated SQLite databases and controlled clocks/model fixtures; actual dependency graph transpilation',
    checks: results, databaseCount: databases.length, databaseIntegrity: 'all quick_check=ok and foreign_key_check empty', schemaVersion: QA_MEMORY_SCHEMA_VERSION,
    originalUserDataModified: false, containsSecretsOrAnswers: false }, null, 2));
} finally {
  await Promise.all(consolidationServices.map((service) => service.stop()));
  await Promise.all(services.map((service) => service.stop()));
  for (const owner of owners) owner.closeAll();
  assert.ok(path.resolve(staging).startsWith(path.resolve(root, '.package-staging') + path.sep));
  rmSync(staging, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('memory maintenance state transition timed out');
}
