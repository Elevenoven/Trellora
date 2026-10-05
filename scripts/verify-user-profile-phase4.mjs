import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `user-profile-phase4-${process.pid}-${Date.now()}`);
const compiledRoot = path.join(stagingRoot, 'compiled');
const workspaceDir = path.join(stagingRoot, 'workspace');
const importWorkspaceDir = path.join(stagingRoot, 'import-workspace');
let owner;
let importedOwner;

try {
  transpileTestModules([
    'shared/effectiveContextWindow.ts',
    'electron/knowledge/assistantMode.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/userProfileTypes.ts',
    'electron/knowledge/userProfileLifecycle.ts',
    'electron/knowledge/userProfileExtractor.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/userProfileExtractionJobRepository.ts',
    'electron/knowledge/userProfileRepository.ts',
    'electron/knowledge/userProfileMaintenance.ts',
  ]);
  const databaseModule = await load('electron/knowledge/qaMemoryDatabase.js');
  const repositoryModule = await load('electron/knowledge/userProfileRepository.js');
  const maintenanceModule = await load('electron/knowledge/userProfileMaintenance.js');
  const typesModule = await load('electron/knowledge/userProfileTypes.js');
  const { QaMemoryDatabase } = databaseModule;
  const { UserProfileRepository, UserProfileRevisionConflictError } = repositoryModule;

  owner = new QaMemoryDatabase();
  const repository = new UserProfileRepository(owner, workspaceDir);
  repository.saveSettings({ useInQaContext: true });
  const database = owner.getDatabase(workspaceDir);
  assert.throws(
    () => repository.upsertItem(profileInput('identity', '访问 Token', 'sk-secret-1234567890', 'single')),
    /敏感信息/u,
    '手动录入也不得旁路敏感分类边界',
  );

  const chinese = repository.upsertItem(profileInput('identity', '回答语言', '中文', 'single'));
  seedSuggestedConflict(database, chinese, '英文');
  let overview = repository.getOverview();
  assert.equal(overview.counts.conflicts, 1, '单值活动项与候选项必须形成冲突组');
  assert.equal(overview.conflicts[0].items.length, 2);
  const english = overview.conflicts[0].items.find((item) => item.valueText === '英文');
  assert.ok(english);
  repository.resolveConflict({ itemId: english.itemId, expectedRevision: english.revision, decision: 'keep' });
  overview = repository.getOverview();
  assert.equal(overview.counts.conflicts, 0);
  assert.equal(overview.items.find((item) => item.itemId === english.itemId)?.status, 'active');
  assert.equal(overview.items.find((item) => item.itemId === chinese.itemId)?.status, 'superseded');

  const role = repository.upsertItem(profileInput('professional', '职业角色', '老师', 'multiple'));
  const updatedRole = repository.upsertItem({
    ...profileInput('professional', '职业角色', '程序员', 'multiple'),
    itemId: role.itemId,
    expectedRevision: role.revision,
  });
  const revisions = repository.listRevisions({ itemId: role.itemId, pageSize: 10 });
  assert.deepEqual(revisions.items.map((revision) => revision.revision), [2, 1]);
  const restoredRole = repository.rollbackItem({ itemId: role.itemId, targetRevision: 1, expectedRevision: updatedRole.revision });
  assert.equal(restoredRole.valueText, '老师');
  assert.equal(restoredRole.revision, 3);
  assert.equal(repository.listRevisions({ itemId: role.itemId }).items[0].action, 'restore');
  assert.throws(
    () => repository.rollbackItem({ itemId: role.itemId, targetRevision: 2, expectedRevision: updatedRole.revision }),
    UserProfileRevisionConflictError,
    '单项回滚必须执行乐观锁校验',
  );

  database.prepare('UPDATE user_profile_items SET expires_at = ? WHERE item_id = ?')
    .run(new Date(Date.now() - 86_400_000).toISOString(), role.itemId);
  overview = repository.getOverview();
  assert.equal(overview.counts.reviewDue, 1);
  assert.equal(repository.getContextSnapshot().items.some((item) => item.itemId === role.itemId), false, '过期项不得进入画像上下文');
  const reviewed = repository.reviewItem({ itemId: role.itemId, expectedRevision: restoredRole.revision, decision: 'keep' });
  assert.ok(reviewed.expiresAt && reviewed.expiresAt > new Date().toISOString());
  database.prepare('UPDATE user_profile_items SET expires_at = ? WHERE item_id = ?')
    .run(new Date(Date.now() - 86_400_000).toISOString(), role.itemId);
  const archived = repository.reviewItem({ itemId: role.itemId, expectedRevision: reviewed.revision, decision: 'archive' });
  assert.equal(archived.status, 'superseded');
  assert.equal(archived.temporalStatus, 'historical');

  const exported = repository.exportJson();
  assert.equal(exported.format, 'menghan-notes.user-profile');
  assert.equal(exported.version, 1);
  assert.ok(exported.items.every((item) => item.status === 'active'));
  assert.equal('evidence' in exported, false);
  assert.equal('settings' in exported, false, '导入导出不得静默迁移自动调用开关');

  importedOwner = new QaMemoryDatabase();
  const importedRepository = new UserProfileRepository(importedOwner, importWorkspaceDir);
  const documentWithSensitiveItem = {
    ...exported,
    items: [...exported.items, {
      category: 'identity', fieldLabel: '访问 Token', valueText: 'sk-secret-1234567890',
      cardinality: 'single', temporalStatus: 'current', status: 'active', userLocked: true,
    }],
  };
  const firstImport = importedRepository.importJson(documentWithSensitiveItem);
  assert.equal(firstImport.importedItems, exported.items.length);
  assert.equal(firstImport.rejectedItems, 1);
  const secondImport = importedRepository.importJson(exported);
  assert.equal(secondImport.importedItems, 0);
  assert.equal(secondImport.skippedItems, exported.items.length, '重复导入必须幂等跳过');

  const observations = [120, 180, 240, 300, 360].map((candidateTokens, index) => ({
    diagnostics: {
      zones: [{ zone: 'user-profile', candidateTokens, finalTokens: index === 4 ? 300 : candidateTokens }],
    },
  }));
  const diagnostics = maintenanceModule.createUserProfileMaintenanceDiagnostics({
    queue: { state: 'running', queuedJobs: 2, activeJobs: 1 },
    observations,
    items: repository.getOverview().items,
  });
  assert.equal(diagnostics.queue.queuedJobs, 2);
  assert.equal(diagnostics.contextUsage.sampleCount, 5);
  assert.equal(diagnostics.contextUsage.truncatedSamples, 1);
  assert.ok(diagnostics.contextUsage.recommendedTokenBudget >= 128 && diagnostics.contextUsage.recommendedTokenBudget <= 1200);
  assert.equal(diagnostics.categoryPolicy, 'fixed-whitelist');
  assert.equal(diagnostics.categories.length, typesModule.USER_PROFILE_CATEGORIES.length, '分类诊断不得扩展 v5 白名单');

  verifyUiAndIpcBoundary();
  console.log('User profile Phase 4 verification passed');
} finally {
  owner?.closeAll();
  importedOwner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

function profileInput(category, fieldLabel, valueText, cardinality) {
  return { category, fieldLabel, valueText, cardinality, temporalStatus: 'current', userLocked: true };
}

function seedSuggestedConflict(database, activeItem, valueText) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO user_profile_items (
      item_id, profile_id, category, item_key, field_label, value_text,
      normalized_value, cardinality, temporal_status, assertion_kind,
      status, confidence, stability, user_locked, source_count, revision,
      created_at, updated_at
    ) VALUES ('phase4-conflict', 'default', ?, ?, ?, ?, ?, 'single', 'current',
              'inferred', 'suggested', 0.72, 'long-term', 0, 1, 1, ?, ?)
  `).run(activeItem.category, activeItem.itemKey, activeItem.fieldLabel, valueText, valueText.toLowerCase(), now, now);
}

function verifyUiAndIpcBoundary() {
  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const queueSource = readFileSync(path.join(rootDir, 'electron/knowledge/userProfileExtractionQueue.ts'), 'utf8');
  const turnTypesSource = readFileSync(path.join(rootDir, 'electron/knowledge/assistantTurnTypes.ts'), 'utf8');
  const pageSource = readFileSync(path.join(rootDir, 'src/components/settings/UserInformationSettings.tsx'), 'utf8');
  const chatSource = readFileSync(path.join(rootDir, 'src/components/KnowledgePanel.tsx'), 'utf8');
  const stylesSource = readFileSync(path.join(rootDir, 'src/styles/variables.css'), 'utf8');
  assert.doesNotMatch(mainSource, /user-profile:/u, 'WK-M9 后旧画像 IPC 必须关闭');
  assert.match(mainSource, /memory:export/u);
  assert.match(mainSource, /memory:import/u);
  assert.match(queueSource, /onUpdated\?\./u);
  assert.match(turnTypesSource, /type: 'profile-updated'/u);
  assert.match(chatSource, /画像已更新 \{message\.profileUpdatedCount\} 项/u);
  assert.match(stylesSource, /\.assistant-profile-update-receipt/u);
  assert.match(pageSource, /集中管理画像、偏好、事实、任务和兴趣/u);
  assert.match(pageSource, /待确认/u);
  assert.match(pageSource, /importLongTermMemory/u);
  assert.match(pageSource, /listLongTermMemoryDocuments/u);
  assert.match(pageSource, /待确认内容不会进入回答/u);
}

function transpileTestModules(relativePaths) {
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const outputPath = path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
      fileName: sourcePath,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    writeFileSync(outputPath, output.outputText, 'utf8');
  }
}

function load(relativePath) {
  return import(pathToFileURL(path.join(compiledRoot, relativePath)).href);
}
