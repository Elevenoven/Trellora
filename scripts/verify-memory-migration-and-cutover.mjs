import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `wk-m9-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(workspaceDir, { recursive: true });
  transpileTestModules([
    'shared/assistantReleaseDefaults.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/memory/memoryLegacyContract.ts',
    'electron/knowledge/memory/memoryCutover.ts',
    'electron/knowledge/assistantSessionScope.ts',
    'electron/knowledge/qaMemoryTypes.ts',
    'electron/knowledge/structuredOutputContract.ts',
    'electron/knowledge/qaConversationCheckpoint.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/qaCanonicalHistory.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/conversationArchiveContract.ts',
    'electron/knowledge/qaMemoryRepository.ts',
  ]);
  const cutover = await load('electron/knowledge/memory/memoryCutover.ts');
  assert.equal(cutover.normalizeMemoryProjectionMode(undefined), 'canonical');
  assert.equal(cutover.normalizeMemoryProjectionMode('legacy'), 'legacy');
  assert.equal(cutover.normalizeMemoryProjectionRouteMode('inherit'), 'inherit');
  assert.equal(cutover.normalizeMemoryProjectionRouteMode(undefined), 'inherit', '旧偏好升级后 route 必须继承全局开关');
  assert.equal(cutover.normalizeMemoryProjectionRouteMode('observe'), 'observe');
  assert.deepEqual(cutover.selectMemoryProjection('canonical', 'old', 'new'), {
    mode: 'canonical', activeReader: 'canonical', active: 'new', shadow: 'old',
  });
  assert.deepEqual(cutover.selectMemoryProjection('observe', 'old', 'new'), {
    mode: 'observe', activeReader: 'legacy', active: 'old', shadow: 'new',
  });

  const emptyContext = (source, materials = []) => ({
    materials,
    version: source,
    diagnostics: { source, loadedTurns: 0, loadedSummaries: 0, recalledTurns: 0, staleItems: 0 },
  });
  const canonicalHistory = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'search_memory', arguments: { query: '偏好' } }] },
    { role: 'tool', content: '命中', toolCallId: 'call-1', toolName: 'search_memory' },
    { role: 'assistant', content: '回答' },
  ];
  const observation = cutover.recordMemoryCutoverObservation({
    route: 'chat',
    mode: 'canonical',
    sessionId: 'assistant-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    legacyContext: emptyContext('legacy'),
    canonicalContext: emptyContext('canonical', [{
      id: 'l2-1', zone: 'conversation-hot', channel: 'user', trust: 'untrusted-memory', content: '最近对话',
      priority: 1, protected: false, compressStrategy: 'checkpoint', source: { kind: 'qa-turn', id: 'turn-1' },
      stalePolicy: 'keep', overflowPolicy: 'compress', provenance: { sessionId: 'assistant-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', turnSeqs: [1] },
      cache: { stability: 'session', prefixEligible: false },
    }]),
    canonicalHistory,
    recallItemIds: ['memory-b', 'memory-a', 'memory-a'],
    readDiagnostics: { legacyReadMs: 0, canonicalReadMs: 2 },
  });
  assert.equal(observation.activeReader, 'canonical');
  assert.equal(observation.scopeLeakCount.canonical, 0);
  assert.equal(observation.duplicateContentCount.canonical, 0);
  assert.equal(observation.toolAtomicityViolations.canonical, 0);
  assert.deepEqual(observation.recalledItemIds, ['memory-a', 'memory-b']);
  const report = cutover.getMemoryCutoverReport();
  assert.equal(report.defaultMode, 'canonical');
  assert.deepEqual(report.routeOrder, ['chat', 'knowledge-base', 'current-note-direct', 'current-note-react']);
  assert.deepEqual(report.hardViolations, {
    scopeLeaks: 0,
    duplicateCanonicalContent: 0,
    orphanCanonicalToolResults: 0,
    doubleProjection: 0,
  });

  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { QaMemoryRepository } = await load('electron/knowledge/qaMemoryRepository.ts');
  const sessionId = 'assistant-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  owner = new QaMemoryDatabase();
  let repository = new QaMemoryRepository(owner, workspaceDir);
  repository.ensureSession(sessionId, 'chat');
  repository.startTurn(sessionId, { turnId: 'wk-m9-turn', userText: '记住我的偏好', scopeLabel: '聊天', route: 'chat' });
  repository.finalizeTurn(sessionId, 'wk-m9-turn', {
    type: 'answer', answer: '已经记住。', provider: 'ollama', model: 'fixture', sourceNotes: [], retrievalMode: 'none', interactionRoute: 'chat',
  });
  const database = owner.getDatabase(workspaceDir);
  const now = new Date('2026-09-08T00:00:00.000Z').toISOString();
  database.prepare(`INSERT INTO memory_workspace_settings (workspace_id, enabled, created_at, updated_at) VALUES ('workspace', 1, ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO memory_subjects (workspace_id, principal_id, created_at, updated_at) VALUES ('workspace', 'principal', ?, ?)`).run(now, now);
  database.prepare(`
    INSERT INTO memory_extraction_jobs (
      id, workspace_id, principal_id, status, due_at, claimed_sessions_json, created_at, updated_at
    ) VALUES ('wk-m9-job', 'workspace', 'principal', 'queued', ?, ?, ?, ?)
  `).run(now, JSON.stringify([sessionId]), now, now);
  owner.closeAll();
  owner = new QaMemoryDatabase();
  repository = new QaMemoryRepository(owner, workspaceDir);
  assert.equal(repository.loadRecentCompleteTurns(sessionId).length, 1, '完整轮次必须在重启后恢复');
  assert.equal(owner.getDatabase(workspaceDir).prepare(`SELECT COUNT(*) AS count FROM memory_extraction_jobs WHERE id = 'wk-m9-job' AND status = 'queued'`).get().count, 1, 'durable job 必须在重启后恢复');

  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const preloadSource = readFileSync(path.join(rootDir, 'electron/preload.ts'), 'utf8');
  const rendererTypes = readFileSync(path.join(rootDir, 'src/electron.d.ts'), 'utf8');
  const orchestratorSource = readFileSync(path.join(rootDir, 'electron/knowledge/qaMemoryOrchestrator.ts'), 'utf8');
  const preferencesSource = readFileSync(path.join(rootDir, 'electron/appPreferences.ts'), 'utf8');
  const releaseDefaultsSource = readFileSync(path.join(rootDir, 'shared/assistantReleaseDefaults.ts'), 'utf8');
  const summarySegment = mainSource.slice(mainSource.indexOf('if (currentNoteSummaryMode && currentNoteSnapshot)'), mainSource.indexOf('const useCurrentNoteAgent'));
  const reactSegment = mainSource.slice(mainSource.indexOf('const useCurrentNoteAgent'), mainSource.indexOf("emitAssistantTurnEvent(event, { requestId: request.requestId, type: 'status', message: '正在生成回答…'"));
  const directSegment = mainSource.slice(mainSource.indexOf('const currentNoteDirectMemoryProjectionMode'), mainSource.indexOf('function resolveQaContextRuntimeMode'));
  assert.match(summarySegment, /canonicalSummaryTurn/u, 'current-note summary 必须写入 canonical turn');
  assert.doesNotMatch(summarySegment, /scopedMemoryRepository\.startTurn|scopedMemoryRepository\.finalizeTurn/u, 'current-note summary 不得继续写旧 turn');
  assert.doesNotMatch(reactSegment, /scopedMemoryRepository\.startTurn|scopedMemoryRepository\.finalizeTurn/u, 'current-note ReAct 不得继续写旧 turn');
  assert.doesNotMatch(directSegment, /directScopedMemoryRepository\.startTurn|directScopedMemoryRepository\.finalizeTurn/u, 'current-note Direct 不得继续写旧 turn');
  assert.doesNotMatch(mainSource, /assistant-workspace-memory:/u, 'legacy workspace memory IPC 必须关闭');
  assert.doesNotMatch(preloadSource, /AssistantWorkspaceSession|assistant-workspace-memory:/u);
  assert.doesNotMatch(rendererTypes, /AssistantWorkspaceSession|createAssistantWorkspaceSession/u);
  assert.doesNotMatch(mainSource, /user-profile:/u, 'legacy user-profile IPC 必须关闭');
  assert.doesNotMatch(preloadSource, /user-profile:/u, 'legacy user-profile IPC 不得继续暴露');
  assert.doesNotMatch(rendererTypes, /getUserProfileOverview|retryUserProfileExtraction/u);
  assert.doesNotMatch(mainSource, /new UserProfileExtractionQueue/u, '旧画像队列不得在应用启动时恢复写入');
  assert.match(orchestratorSource, /loadCanonical\(memoryRequest\)/u);
  assert.match(orchestratorSource, /legacy-reader:disabled-after-cutover/u);
  assert.doesNotMatch(orchestratorSource, /userProfileExtractionQueue\.schedule/u, '旧画像提炼不得继续写入');
  assert.match(preferencesSource, /\.\.\.ASSISTANT_RELEASE_DEFAULTS/u);
  assert.match(releaseDefaultsSource, /assistantMemoryProjectionMode: 'canonical'/u);
  for (const routeField of ['Chat', 'KnowledgeBase', 'CurrentNoteDirect', 'CurrentNoteReact']) {
    assert.match(releaseDefaultsSource, new RegExp(`assistantMemoryProjection${routeField}Mode: 'inherit'`, 'u'));
  }
  for (const routeField of ['Chat', 'KnowledgeBase', 'CurrentNoteDirect', 'CurrentNoteReact']) {
    assert.match(preferencesSource, new RegExp(`assistantMemoryProjection${routeField}Mode`, 'u'));
  }

  console.log('WK-M9 single-projection cutover, rollback flags, diagnostics, legacy IPC retirement, and restart recovery passed');
} finally {
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function transpileTestModules(relativePaths) {
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const outputPath = modulePath(relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
      fileName: sourcePath,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    writeFileSync(outputPath, output.outputText, 'utf8');
  }
}

function load(relativePath) {
  return import(pathToFileURL(modulePath(relativePath)).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  if (!path.resolve(target).toLocaleLowerCase('en-US').startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
