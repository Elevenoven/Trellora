import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `user-profile-extraction-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const compiledEntry = path.join(stagingRoot, 'profile-runtime.cjs');
const sourceEntry = path.join(stagingRoot, 'profile-runtime.ts');
let owner;
let queue;
let verificationPassed = false;

try {
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(sourceEntry, `
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/qaMemoryDatabase.ts'))};
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/userProfileRepository.ts'))};
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/userProfileExtractionJobRepository.ts'))};
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/userProfileExtractor.ts'))};
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/userProfileMergeService.ts'))};
    export * from ${JSON.stringify(path.join(rootDir, 'electron/knowledge/userProfileExtractionQueue.ts'))};
  `, 'utf8');
  buildSync({
    entryPoints: [sourceEntry],
    outfile: compiledEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
  const runtime = await import(pathToFileURL(compiledEntry).href);
  const {
    QaMemoryDatabase,
    UserProfileRepository,
    UserProfileExtractionJobRepository,
    UserProfileExtractor,
    UserProfileMergeService,
    UserProfileExtractionQueue,
  } = runtime;

  owner = new QaMemoryDatabase();
  const profileRepository = new UserProfileRepository(owner, workspaceDir);
  const jobRepository = new UserProfileExtractionJobRepository(owner, workspaceDir);
  const mergeService = new UserProfileMergeService(owner, workspaceDir);
  profileRepository.saveSettings({ autoExtractEnabled: true, allowChat: true, allowKnowledgeBase: true });
  const database = owner.getDatabase(workspaceDir);
  const providerCalls = [];
  const updateReceipts = [];
  const failureAttempts = new Map();
  let releaseDeferred;
  let blockedProfileAvailable = false;

  queue = new UserProfileExtractionQueue(
    jobRepository,
    new UserProfileExtractor(),
    mergeService,
    {
      resolveModel: (job) => job.modelProfileId === 'blocked-profile' && !blockedProfileAvailable
        ? { ready: false, code: 'consent-required', message: '远程内容发送确认未启用，画像提取未调用模型。' }
        : {
            ready: true,
            providerConfig: { kind: 'ollama', model: job.modelId },
            providerKind: 'ollama',
            model: job.modelId,
            contextWindowTokens: job.contextWindowTokens,
          },
      generateJson: async (input) => {
        const userText = readXmlBlock(input.prompt, 'current_user_message');
        providerCalls.push({ userText, callKind: input.callKind, maxOutputTokens: input.maxOutputTokens });
        if (userText.includes('等待后台')) await new Promise((resolve) => { releaseDeferred = resolve; });
        const failures = failureAttempts.get(userText) ?? 0;
        if (userText.includes('失败一次') && failures === 0) {
          failureAttempts.set(userText, failures + 1);
          throw new Error('synthetic provider failure with private diagnostics');
        }
        const value = fakeObservations(userText);
        input.onUsage?.({ inputTokens: 111, outputTokens: 22, totalTokens: 133 });
        input.onRawResponse?.(JSON.stringify(value));
        return value;
      },
      onUpdated: (receipt) => updateReceipts.push(receipt),
    },
  );

  const teacher = scheduleTurn(database, queue, { id: 'teacher', seq: 1, scope: 'chat', userText: '我是老师。' });
  const duplicateTeacher = queue.schedule(scheduleInput('teacher', 'profile-main', 'chat'));
  assert.equal(duplicateTeacher.created, false, '同一轮只允许一个逻辑任务');
  scheduleTurn(database, queue, { id: 'programmer', seq: 2, scope: 'chat', userText: '我也是程序员。' });
  const knowledge = scheduleTurn(database, queue, { id: 'knowledge', seq: 3, scope: 'knowledge-base', userText: '我主要用 Windows 开发。' });
  const sensitive = scheduleTurn(database, queue, { id: 'sensitive', seq: 4, scope: 'chat', userText: '我的 API Key 是 sk-super-secret-123456789。' });
  scheduleTurn(database, queue, { id: 'sensitive-output', seq: 5, scope: 'chat', userText: '我是普通用户。' });
  scheduleTurn(database, queue, { id: 'bad-evidence', seq: 6, scope: 'chat', userText: '我喜欢简洁回答。' });
  scheduleTurn(database, queue, { id: 'third-party', seq: 7, scope: 'chat', userText: '我的朋友是医生。' });
  const failed = scheduleTurn(database, queue, { id: 'failed', seq: 8, scope: 'chat', userText: '我是测试工程师，失败一次。' });
  const blocked = scheduleTurn(database, queue, { id: 'blocked', seq: 9, scope: 'chat', userText: '我使用 TypeScript。', modelProfileId: 'blocked-profile' });
  const startedAt = Date.now();
  const deferred = scheduleTurn(database, queue, { id: 'deferred', seq: 10, scope: 'chat', userText: '我是设计师，等待后台。' });
  assert.ok(Date.now() - startedAt < 100, '安排画像任务不得等待模型返回');

  await waitUntil(() => jobRepository.getJob(deferred.job.jobId).status === 'running' && typeof releaseDeferred === 'function');
  assert.equal(jobRepository.getJob(teacher.job.jobId).status, 'completed');
  assert.equal(jobRepository.getJob(knowledge.job.jobId).scope, 'knowledge-base');
  assert.equal(jobRepository.getJob(failed.job.jobId).status, 'failed', '失败后不得自动再次调用');
  assert.equal(jobRepository.getJob(failed.job.jobId).attemptCount, 1);
  assert.equal(jobRepository.getJob(blocked.job.jobId).status, 'blocked');
  assert.equal(jobRepository.getJob(blocked.job.jobId).attemptCount, 0, '模型不可用时不得计为已发送调用');
  assert.equal(jobRepository.getJob(sensitive.job.jobId).status, 'empty');
  assert.equal(jobRepository.getJob(sensitive.job.jobId).attemptCount, 0, '敏感输入不得跨过 Provider 边界');
  releaseDeferred();
  await queue.waitForIdle();
  assert.ok(updateReceipts.some((receipt) => receipt.requestId === 'turn-teacher' && receipt.updatedItemCount > 0), '成功合并后必须发送无正文的画像更新回执');
  assert.equal(updateReceipts.some((receipt) => receipt.requestId === 'turn-sensitive'), false, '敏感输入不得产生画像更新回执');
  assert.deepEqual(Object.keys(updateReceipts[0]).sort(), ['completedAt', 'requestId', 'updatedItemCount'], '回执不得携带画像正文');
  assert.equal(queue.getDiagnostics().state, 'idle');

  const callsBeforeRetry = providerCalls.length;
  queue.retry(failed.job.jobId);
  await queue.waitForIdle();
  const retriedFailure = jobRepository.getJob(failed.job.jobId);
  assert.equal(retriedFailure.status, 'completed');
  assert.equal(retriedFailure.attemptCount, 2);
  assert.equal(retriedFailure.failedAttemptCount, 1);
  assert.equal(retriedFailure.manualRetryNo, 1);
  assert.equal(providerCalls.length, callsBeforeRetry + 1, '只有手动重试可以增加第二次调用');

  blockedProfileAvailable = true;
  queue.retry(blocked.job.jobId);
  await queue.waitForIdle();
  assert.equal(jobRepository.getJob(blocked.job.jobId).status, 'completed');
  assert.equal(jobRepository.getJob(blocked.job.jobId).manualRetryNo, 1);

  const overview = profileRepository.getOverview();
  const occupations = overview.items
    .filter((item) => item.itemKey === 'occupation' && item.status === 'active')
    .map((item) => item.valueText)
    .sort();
  assert.deepEqual(occupations, ['老师', '测试工程师', '程序员', '设计师'].sort(), '多值职业画像必须动态并存');
  assert.ok(overview.items.some((item) => item.itemKey === 'operating_system' && item.valueText === 'Windows'));
  assert.ok(overview.items.some((item) => item.itemKey === 'programming_language' && item.valueText === 'TypeScript'));
  assert.equal(overview.items.some((item) => /secret|医生/iu.test(item.valueText)), false, '敏感和第三方观察不得写入画像');
  assert.equal(searchProfileTables(database, 'sk-super-secret-123456789'), 0, '敏感内容不得进入画像、证据、修订或任务审计');
  assert.ok(overview.extraction.stats.totalCalls >= 10);
  assert.equal(overview.extraction.stats.failedCalls, 1);
  assert.equal(overview.extraction.stats.manualRetries, 2);
  assert.ok(overview.extraction.stats.filteredSensitive >= 1);
  assert.ok(overview.extraction.stats.filteredInvalid >= 2);
  assert.ok(overview.extraction.recentJobs.length > 0 && overview.extraction.recentJobs.length <= 10);

  const teacherSource = {
    job: jobRepository.getJob(teacher.job.jobId),
    userText: '我是老师。',
    existingItems: [],
  };
  const teacherObservation = fakeObservations('我是老师。').observations[0];
  assert.equal(mergeService.merge(teacherSource, [teacherObservation]).appliedCount, 0);
  assert.equal(mergeService.merge(teacherSource, [teacherObservation]).appliedCount, 0);
  const teacherItem = profileRepository.getOverview().items.find((item) => item.itemKey === 'occupation' && item.valueText === '老师');
  assert.ok(teacherItem);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_profile_evidence WHERE item_id = ? AND source_turn_id = ?').get(teacherItem.itemId, 'turn-teacher').count, 1);
  assert.ok(providerCalls.every((call) => call.callKind === 'user-profile-extract' && call.maxOutputTokens <= 800));
  assert.equal(providerCalls.some((call) => call.userText.includes('API Key')), false);

  verifyStaticIntegration();
  verificationPassed = true;
  console.log('User profile extraction Phase 2 verification passed');
} finally {
  queue?.abortAll();
  owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function scheduleTurn(database, queue, input) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT OR IGNORE INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES ('profile-extraction-session', 'chat', '画像提取测试', NULL, 0, 0, 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, replaced_by_turn_id,
      user_text, assistant_text, scope_label, status, user_tokens, assistant_tokens,
      result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, 'profile-extraction-session', ?, ?, 1, NULL, ?, '已回答', ?,
              'complete', 0, 0, '{}', '{}', ?, ?)
  `).run(
    `turn-${input.id}`,
    input.seq,
    `turn-${input.id}`,
    input.userText,
    input.scope === 'knowledge-base' ? '个人知识库' : '无',
    now,
    now,
  );
  database.prepare('UPDATE qa_sessions SET last_turn_seq = ?, updated_at = ? WHERE session_id = ?')
    .run(input.seq, now, 'profile-extraction-session');
  return queue.schedule(scheduleInput(input.id, input.modelProfileId ?? 'profile-main', input.scope));
}

function scheduleInput(id, modelProfileId, scope) {
  return {
    sourceTurnId: `turn-${id}`,
    sessionId: 'profile-extraction-session',
    scope,
    modelProfileId,
    providerId: 'ollama',
    modelId: 'profile-test-model',
    contextWindowTokens: 16_384,
  };
}

function fakeObservations(userText) {
  if (userText.includes('老师')) return output('professional', 'occupation', '老师', '我是老师。');
  if (userText.includes('程序员')) return output('professional', 'occupation', '程序员', '我也是程序员。');
  if (userText.includes('Windows')) return output('technical-environment', 'operating_system', 'Windows', '我主要用 Windows 开发。');
  if (userText.includes('API Key')) return output('identity', 'self_description', 'API Key 是 sk-super-secret-123456789', '我的 API Key 是 sk-super-secret-123456789。');
  if (userText.includes('普通用户')) return output('identity', 'self_description', '工资 100 万', '我是普通用户。');
  if (userText.includes('简洁')) return output('communication', 'response_style', '简洁', '用户偏好简洁回答');
  if (userText.includes('朋友')) return output('professional', 'occupation', '医生', '我的朋友是医生。');
  if (userText.includes('测试工程师')) return output('professional', 'occupation', '测试工程师', '我是测试工程师，失败一次。');
  if (userText.includes('TypeScript')) return output('technical-environment', 'programming_language', 'TypeScript', '我使用 TypeScript。');
  if (userText.includes('设计师')) return output('professional', 'occupation', '设计师', '我是设计师，等待后台。');
  return { schemaVersion: 1, observations: [] };
}

function output(category, key, value, evidenceQuote) {
  return {
    schemaVersion: 1,
    observations: [{ category, key, value, assertion: 'explicit', stability: 'stable', confidence: 0.98, evidenceQuote }],
  };
}

function readXmlBlock(prompt, name) {
  return prompt.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, 'u'))?.[1] ?? '';
}

function searchProfileTables(database, needle) {
  const rows = [
    ...database.prepare('SELECT value_text AS text FROM user_profile_items').all(),
    ...database.prepare('SELECT excerpt AS text FROM user_profile_evidence').all(),
    ...database.prepare("SELECT COALESCE(before_json, '') || COALESCE(after_json, '') AS text FROM user_profile_revisions").all(),
    ...database.prepare("SELECT error_code || error_message || input_hash || output_hash AS text FROM user_profile_extraction_jobs").all(),
  ];
  return rows.filter((row) => String(row.text).includes(needle)).length;
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for profile extraction state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function verifyStaticIntegration() {
  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const orchestratorSource = readFileSync(path.join(rootDir, 'electron/knowledge/qaMemoryOrchestrator.ts'), 'utf8');
  const budgetSource = readFileSync(path.join(rootDir, 'electron/knowledge/currentNoteContextBudget.ts'), 'utf8');
  const preloadSource = readFileSync(path.join(rootDir, 'electron/preload.ts'), 'utf8');
  assert.match(budgetSource, /'user-profile-extract': 800/u);
  assert.doesNotMatch(orchestratorSource, /userProfileExtractionQueue\.schedule/u, 'WK-M9 后旧画像提炼不得继续写入');
  assert.match(mainSource, /scheduleAfterCompletedTurn/u, '统一 L4 提炼链路必须保留');
  assert.match(mainSource, /scope: 'knowledge-base'[\s\S]*scope: 'chat'/u);
  assert.doesNotMatch(mainSource, /user-profile:/u, '旧画像 IPC 必须关闭');
  assert.doesNotMatch(preloadSource, /user-profile:/u, '旧画像 IPC 不得继续暴露给 renderer');
}
