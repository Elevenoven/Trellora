import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'trellora-onboarding-state-'));
const checks = [];
try {
  const bundle = path.join(temporary, 'onboarding.cjs');
  await build({ entryPoints: ['electron/onboarding/onboardingService.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
  const { OnboardingService, migrateOnboarding } = createRequire(import.meta.url)(bundle);
  const remote = { kind: 'openai-compatible', provider: 'custom', api: 'openai-completions', endpoint: 'https://model.example.test/v1', apiKey: 'KEY_MUST_NEVER_BE_PERSISTED', model: 'demo-model', remoteContentConsent: true };
  const fixture = (value = { version: 1, status: 'pending' }) => {
    let stored = value, failWrite = false;
    const profiles = [{ id: 'model-1', label: '测试连接', config: { ...remote } }];
    const service = new OnboardingService({ read: () => stored, write: value => { if (failWrite) throw new Error('DISK_WRITE_FAILED'); stored = structuredClone(value); }, hasUsage: () => false, profiles: () => profiles, defaultProfileId: () => 'model-1', paths: () => ({ workspacePath: 'workspace', libraryPath: null }), notify: () => {} });
    service.initialize();
    const action = name => service.update({ action: name, expectedRevision: service.get().revision });
    return { service, profiles, action, stored: () => stored, fail: value => { failWrite = value; } };
  };

  assert.equal(migrateOnboarding(undefined, false).status, 'pending');
  assert.equal(migrateOnboarding(undefined, true).status, 'dismissed');
  assert.equal(migrateOnboarding({ sampleImported: true }, false).status, 'dismissed');
  assert.equal(migrateOnboarding({ version: 1, status: 'pending' }, true).status, 'pending');
  for (const status of ['completed', 'skipped']) {
    const migrated = migrateOnboarding({ version: 1, status, sampleImported: true }, false);
    assert.equal(migrated.status, 'dismissed'); assert.equal(migrated.sampleImported, true);
    assert.equal(migrated.progress.question, 'pending');
  }
  const prior = fixture().stored();
  assert.deepEqual(migrateOnboarding(prior, true), prior);
  assert.throws(() => migrateOnboarding({ ...prior, revision: -1 }, false));
  checks.push('fresh/legacy migration, old completion does not claim the new course, v2 validation');

  const { service, profiles, action, stored, fail } = fixture();
  action('start'); action('acknowledge-menus'); action('defer');
  assert.equal(service.get().currentStep, 'ai');
  action('resume');
  const beforeFailure = service.get(); fail(true);
  assert.throws(() => action('skip-ai'), /DISK_WRITE_FAILED/); fail(false);
  assert.deepEqual(service.get(), beforeFailure);
  assert.throws(() => service.update({ action: 'defer', expectedRevision: 0 }), /进度已更新/);
  action('skip-ai'); assert.equal(service.get().progress.ai, 'skipped');
  assert.throws(() => action('finish')); action('show-ai');
  checks.push('pause/resume, skipped AI cannot complete, stale revision and failed writes do not advance progress');

  service.selectProfile('model-1');
  const outdated = service.beginTest('model-1', profiles[0].config);
  service.invalidateDraft('model-1'); service.finishTest('model-1', outdated, true);
  assert.equal(service.get().connection.state, 'saved-unverified');
  const first = service.beginTest('model-1', profiles[0].config);
  const latest = service.beginTest('model-1', profiles[0].config);
  service.finishTest('model-1', first, true); assert.equal(service.get().connection.testAttempted, false);
  service.finishTest('model-1', latest, false); assert.equal(service.get().connection.state, 'failed');
  action('show-question'); assert.equal(service.get().progress.ai, 'pending');
  service.bindPractice(11, { profileId: 'model-1', sessionId: 'practice-session', expectedRevision: service.get().revision });
  const start = (requestId, overrides = {}) => service.beginPracticeRequest(11, { requestId, sessionId: 'practice-session', scope: 'chat', profile: profiles[0], webSearch: 'off', ...overrides });
  assert.equal(start('other-session', { sessionId: 'different' }), false);
  assert.equal(start('kb-request', { scope: 'knowledge-base' }), false);
  assert.equal(start('web-request', { webSearch: 'on' }), false);
  assert.equal(start('practice-request'), true);
  const result = { answer: '完整回答', persisted: true, sessionId: 'practice-session', complete: true };
  service.completePractice(12, 'practice-request', result);
  service.completePractice(11, 'practice-request', { ...result, persisted: false });
  service.completePractice(11, 'practice-request', { ...result, complete: false });
  service.completePractice(11, 'practice-request', { ...result, answer: ' ' });
  assert.equal(service.get().progress.question, 'pending');
  profiles[0].config.model = 'changed-model'; service.profilesSaved();
  service.completePractice(11, 'practice-request', result);
  assert.equal(service.get().progress.question, 'pending');
  assert.equal(start('changed-request'), true);
  action('defer'); service.completePractice(11, 'changed-request', result);
  assert.equal(service.get().status, 'deferred'); assert.equal(service.get().progress.question, 'done');
  const successRevision = service.get().revision;
  service.completePractice(11, 'changed-request', result); assert.equal(service.get().revision, successRevision);
  action('resume'); action('finish');
  assert.equal(service.get().status, 'completed');
  const finalRevision = service.get().revision; action('finish'); assert.equal(service.get().revision, finalRevision);
  service.forgetRequest(11, 'changed-request'); assert.equal(service.isPracticeRequest(11, 'changed-request'), false);
  assert.equal(JSON.stringify(stored()).includes(remote.apiKey), false);
  assert.equal(JSON.stringify(stored()).includes('完整回答'), false);
  checks.push('catalog failure manual path, request ownership/scope, actual persistence, changed model, paused success, idempotent finish, no credentials or answers in progress');

  const cold = new OnboardingService({ read: stored, write: () => {}, hasUsage: () => false, profiles: () => profiles, defaultProfileId: () => 'model-1', paths: () => ({ workspacePath: 'workspace', libraryPath: null }), notify: () => {} });
  assert.equal(cold.initialize().status, 'completed');
  assert.equal(cold.get().connection.state, 'saved-unverified');
  checks.push('cold restart retains progress but never assumes a prior live connection test');

  const existing = fixture();
  existing.action('start'); existing.action('acknowledge-menus');
  assert.equal(existing.service.get().connection.state, 'saved-unverified');
  existing.action('show-question');
  assert.equal(existing.service.get().progress.ai, 'pending', 'saved model does not pretend to have passed a test');
  existing.action('show-ai'); existing.action('skip-ai');
  existing.service.bindPractice(21, { profileId: 'model-1', sessionId: 'existing-model-session', expectedRevision: existing.service.get().revision });
  assert.equal(existing.service.beginPracticeRequest(21, { requestId: 'existing-model-request', sessionId: 'existing-model-session', scope: 'chat', profile: existing.profiles[0], webSearch: 'off' }), true);
  assert.throws(() => existing.action('finish'), 'binding alone cannot complete the guide');
  existing.service.completePractice(21, 'existing-model-request', { ...result, sessionId: 'existing-model-session' });
  existing.action('finish'); assert.equal(existing.service.get().status, 'completed');
  const fallback = fixture();
  fallback.profiles.unshift({ id: 'blank-default', label: '空白连接', config: { kind: 'ollama', model: '' } });
  fallback.profiles[1].config.apiKey = '';
  assert.equal(fallback.service.get().connection.state, 'missing', 'remote model without a saved key remains a preview');
  fallback.profiles.push({ id: 'local-ready', label: '已有本地模型', config: { kind: 'ollama', model: 'installed-model' } });
  fallback.service.selectProfile('blank-default');
  assert.equal(fallback.service.get().connection.profileId, 'local-ready', 'an incomplete preferred profile does not hide a configured model');
  fallback.profiles.pop(); fallback.action('start'); fallback.action('acknowledge-menus'); fallback.action('skip-ai');
  assert.throws(() => fallback.service.bindPractice(21, { profileId: 'model-1', sessionId: 'empty', expectedRevision: fallback.service.get().revision }), /尚未配置/);
  checks.push('saved untested models can ask after setup or skip; only a persisted complete answer completes the guide; incomplete profiles never hide another configured model or enable an unconfigured remote model');
  mkdirSync('docs/verification', { recursive: true });
  writeFileSync('docs/verification/onboarding-state.json', JSON.stringify({ verifiedAt: new Date().toISOString(), method: 'main-process service with controlled ports; no live model', checks }, null, 2));
  console.log(`Onboarding state: ${checks.length} groups passed`);
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('trellora-onboarding-state-'));
  rmSync(temporary, { recursive: true, force: true });
}
