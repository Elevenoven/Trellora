import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const rootDir = process.cwd();
const scriptPath = fileURLToPath(import.meta.url);
const stagingDir = path.join(rootDir, '.package-staging', 'verify-wiki-agent-real-models');
const agentBundle = path.join(stagingDir, 'wiki-agent-real.cjs');
const reportPath = path.join(stagingDir, 'report.json');
const runnerAppDir = path.join(stagingDir, 'electron-runner');
const runnerUserDataDir = path.join(stagingDir, 'electron-user-data');

if (!process.versions.electron) {
  await runParent();
} else {
  await runElectronChild();
}

async function runParent() {
  const electronPath = path.join(rootDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.equal(existsSync(electronPath), true, `Electron runtime does not exist: ${electronPath}`);
  const configPath = process.env.TRELLORA_R4_CONFIG_PATH
    || path.join(process.env.APPDATA || '', 'Electron', 'config.json');
  assert.equal(existsSync(configPath), true, `Trellora model settings do not exist: ${configPath}`);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  await buildAgentBundle();
  createElectronRunner();
  prepareSafeStorageRuntime(configPath);

  const childEnv = {
    ...process.env,
    TRELLORA_R4_CONFIG_PATH: configPath,
    TRELLORA_R4_USER_DATA_PATH: runnerUserDataDir,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${runnerUserDataDir}`, runnerAppDir], {
    cwd: rootDir,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  rmSync(runnerUserDataDir, { recursive: true, force: true });
  rmSync(runnerAppDir, { recursive: true, force: true });
  rmSync(agentBundle, { force: true });
  if (exitCode !== 0) process.exitCode = exitCode;
}

function prepareSafeStorageRuntime(configPath) {
  const localStatePath = path.join(path.dirname(configPath), 'Local State');
  assert.equal(existsSync(localStatePath), true, `Electron safeStorage state does not exist: ${localStatePath}`);
  mkdirSync(runnerUserDataDir, { recursive: true });
  copyFileSync(localStatePath, path.join(runnerUserDataDir, 'Local State'));
}

function createElectronRunner() {
  mkdirSync(runnerAppDir, { recursive: true });
  writeFileSync(path.join(runnerAppDir, 'package.json'), JSON.stringify({
    name: 'trellora-r4-real-model-verifier',
    version: '1.0.0',
    main: 'runner.cjs',
  }), 'utf8');
  writeFileSync(path.join(runnerAppDir, 'runner.cjs'), [
    `const { pathToFileURL } = require('node:url');`,
    `import(pathToFileURL(${JSON.stringify(scriptPath)}).href).catch((error) => {`,
    `  console.error(error?.stack ?? String(error));`,
    `  process.exitCode = 1;`,
    `  require('electron').app.quit();`,
    `});`,
  ].join('\n'), 'utf8');
}

async function buildAgentBundle() {
  const stubPlugin = {
    name: 'wiki-real-model-fixture',
    setup(context) {
      const stub = (filter, name) => context.onResolve({ filter }, () => ({ path: name, namespace: 'wiki-r4-stub' }));
      stub(/materialsLibrary$/u, 'materials-library');
      stub(/pipeline\/materialChunkSearch$/u, 'material-chunk-search');
      stub(/knowledge\/rerankAdapters$/u, 'rerank-adapters');
      stub(/knowledge\/assistantTurn$/u, 'assistant-turn');
      stub(/knowledge\/assistantDocumentAttachmentParser$/u, 'assistant-document-attachment-parser');
      stub(/knowledge\/attachmentContextProvider$/u, 'attachment-context-provider');
      stub(/knowledge\/modelCallCoordinator$/u, 'model-call-coordinator');
      stub(/knowledge\/knowledgeBaseRag$/u, 'knowledge-base-rag');
      stub(/wikiSplitProposal$/u, 'wiki-split-proposal');

      context.onLoad({ filter: /.*/u, namespace: 'wiki-r4-stub' }, (args) => ({
        loader: 'js',
        contents: {
          'materials-library': `export const findMaterialsDocument = () => ({ name: 'R4-恢复与资源.md', absolutePath: 'C:/r4/R4-恢复与资源.md' });`,
          'material-chunk-search': `export const readMaterialDocumentIndexStats = () => ({ parentChunks: 4 });`,
          'rerank-adapters': `export const resolveRerankRuntime = () => ({ enabled: false });`,
          'assistant-turn': `export const streamKnowledgeAnswer = async () => { throw new Error('R4 fallback must inject streamAnswer.'); };`,
          'assistant-document-attachment-parser': `
            export const parseAssistantDocumentAttachments = async () => ({
              documentTextByAttachmentId: new Map(), documentImagesByAttachmentId: new Map(), dispose() {},
            });
            export const materializeAssistantDocumentImages = () => [];
            export const collectAiTransportImageHashes = () => new Set();
          `,
          'attachment-context-provider': `
            export class AttachmentContextProvider {
              listMetadata() { return []; }
              search() { return []; }
              readRange() { return undefined; }
              selectDocumentImages() { return []; }
            }
            export const renderAttachmentMetadata = () => '';
            export const renderAttachmentRange = () => '';
            export const renderDocumentImageTransportIndex = () => '';
          `,
          'model-call-coordinator': `export class ModelCallPreparationError extends Error { constructor(reason) { super(String(reason)); this.reason = reason; } }`,
          'wiki-split-proposal': `export const generateWikiSplitProposal = async () => [];`,
          'knowledge-base-rag': `
            function createEvidence(kind) {
              if (kind === 'availability') return {
                documentId: 'doc-r4', childChunkId: 'child-availability', parentChunkId: 'parent-availability', parentOrdinal: 9,
                text: '资源可用性要求：核心索引服务月度可用率不低于 99.9%，超过 30 秒不可用视为一次中断。',
                sourceText: '资源可用性要求：核心索引服务月度可用率不低于 99.9%，超过 30 秒不可用视为一次中断。',
                score: 0.96, hitChildren: 1, methods: ['semantic'],
                sectionContext: '章节路径：R4 验收手册 / 资源可用性\\n章节：资源可用性',
              };
              if (kind === 'checksum') return {
                documentId: 'doc-r4', childChunkId: 'child-checksum', parentChunkId: 'parent-checksum', parentOrdinal: 4,
                text: '恢复校验码为 DELTA-42，仅用于确认恢复窗口已重新建立。',
                sourceText: '恢复校验码为 DELTA-42，仅用于确认恢复窗口已重新建立。',
                score: 0.95, hitChildren: 1, methods: ['semantic'],
                sectionContext: '章节路径：R4 验收手册 / 当前章节 / 附录 A\\n章节：附录 A',
              };
              return {
                documentId: 'doc-r4', childChunkId: 'child-current', parentChunkId: 'parent-current', parentOrdinal: 3,
                text: '第一次恢复退避为 7 秒，第二次为 31 秒；租约在 47 秒后失效；恢复窗口最长 120 秒。',
                sourceText: '第一次恢复退避为 7 秒，第二次为 31 秒；租约在 47 秒后失效；恢复窗口最长 120 秒。',
                score: 0.97, hitChildren: 1, methods: ['semantic'],
                sectionContext: '章节路径：R4 验收手册 / 当前章节\\n章节：当前章节',
              };
            }

            export async function retrieveKnowledgeBaseEvidence(input) {
              const inputs = globalThis.__wikiR4RetrievalInputs ??= [];
              const query = String(input.query ?? input.searchQuery ?? '').trim();
              const sectionNodeIds = Array.isArray(input.sectionNodeIds) ? [...input.sectionNodeIds] : undefined;
              inputs.push({ query, documentIds: [...(input.documentIds ?? [])], sectionNodeIds });
              const caseId = globalThis.__wikiR4CaseId;
              inputs[inputs.length - 1].caseId = caseId;
              const normalized = query.toLowerCase();
              const documentScope = sectionNodeIds === undefined || sectionNodeIds.includes('heading-availability');
              let evidence = [];
              if (caseId !== 'no-answer' && normalized.includes('量子') === false) {
                if (caseId === 'first-miss') {
                  if ((globalThis.__wikiR4CompletedSearchBatches ?? 0) >= 1) evidence = [createEvidence('checksum')];
                } else if (/资源|可用|availability/u.test(normalized)) {
                  if (documentScope) evidence = [createEvidence('availability')];
                } else {
                  evidence = [createEvidence('current')];
                }
              }
              const children = evidence.map((entry) => ({
                chunkId: entry.childChunkId,
                sectionContext: entry.sectionContext,
                sectionPath: [{ nodeId: entry.parentChunkId === 'parent-availability' ? 'heading-availability' : entry.parentChunkId === 'parent-checksum' ? 'heading-checksum' : 'heading-current' }],
              }));
              return {
                evidence, children, parentCandidateCount: evidence.length,
                rerank: { enabled: false, applied: false, gatedOut: 0, allGatedOut: false },
                used: '综合搜索', vectorIndexed: true, indexedChunks: 4,
                channelContribution: { vector: evidence.length, fts: evidence.length, graph: 0 },
              };
            }
            export function mergeKnowledgeBaseRetrievals(outcomes, topK) {
              if (globalThis.__wikiR4CaseId === 'first-miss') {
                globalThis.__wikiR4CompletedSearchBatches = (globalThis.__wikiR4CompletedSearchBatches ?? 0) + 1;
              }
              const first = outcomes[0] ?? {
                evidence: [], children: [], parentCandidateCount: 0,
                rerank: { enabled: false, applied: false, gatedOut: 0, allGatedOut: false },
                used: '综合搜索', vectorIndexed: true, indexedChunks: 4,
                channelContribution: { vector: 0, fts: 0, graph: 0 },
              };
              return {
                ...first,
                evidence: outcomes.flatMap((item) => item.evidence).slice(0, topK),
                children: outcomes.flatMap((item) => item.children ?? []),
              };
            }
          `,
        }[args.path],
      }));
    },
  };

  await build({
    stdin: {
      contents: [
        `export { runWikiNodeAgentTurn } from './electron/wiki/wikiNodeAgentTurn.ts';`,
        `export { createReActChatTransport } from './electron/knowledge/reactAgent/reactChatTransport.ts';`,
      ].join('\n'),
      resolveDir: rootDir,
      sourcefile: 'verify-wiki-real-model-entry.ts',
    },
    outfile: agentBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    plugins: [stubPlugin],
  });
}

async function runElectronChild() {
  const { app, safeStorage } = await import('electron');
  const isolatedUserDataPath = process.env.TRELLORA_R4_USER_DATA_PATH;
  assert.ok(isolatedUserDataPath, 'R4 isolated Electron userData path is unavailable.');
  await app.whenReady();
  let failed = false;
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Electron safeStorage is unavailable; real model credentials cannot be read safely.');
    const profiles = readConfiguredProfiles(safeStorage);
    assert.ok(profiles.length >= 2, `R4 requires at least two configured native-tool profiles; found ${profiles.length}.`);
    const agent = await import(pathToFileURL(agentBundle).href);
    const report = await runAcceptance(agent, profiles.slice(0, 2));
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    assert.equal(report.ok, true, `R4 real-model acceptance failed: ${report.failures.join('; ')}`);
    console.log(`Wiki R4 real-model verification passed (${report.models.map((entry) => entry.model).join(', ')}; ${report.summary.caseCount} cases; report: ${reportPath})`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    failed = true;
  } finally {
    if (failed) app.exit(1);
    else app.quit();
  }
}

function readConfiguredProfiles(safeStorage) {
  const configPath = process.env.TRELLORA_R4_CONFIG_PATH;
  assert.ok(configPath && existsSync(configPath), 'Trellora model settings path is unavailable.');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const settings = config.aiModelSettings;
  const secrets = config.aiProfileSecrets;
  if (!settings || !Array.isArray(settings.profiles) || !secrets || typeof secrets !== 'object') return [];
  return settings.profiles.flatMap((profile) => {
    const providerConfig = profile?.config;
    const encrypted = secrets[profile?.id];
    if (providerConfig?.kind !== 'openai-compatible'
      || providerConfig?.api !== 'openai-completions'
      || providerConfig?.remoteContentConsent !== true
      || !providerConfig?.endpoint
      || !providerConfig?.model
      || typeof encrypted !== 'string') return [];
    try {
      const apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (!apiKey.trim()) {
        console.warn(`R4 profile ${profile.id} has an empty decrypted credential.`);
        return [];
      }
      const preferredSecondaries = providerConfig.provider === 'qwen'
        ? ['qwen3.7-max', 'qwen3.8-flash', 'qwen3.7-plus']
        : [];
      const availableNames = new Set((providerConfig.availableModels ?? []).map((entry) => entry?.name).filter(Boolean));
      const models = [
        providerConfig.model,
        ...preferredSecondaries.filter((model) => model !== providerConfig.model && availableNames.has(model)).slice(0, 1),
      ];
      return models.map((model) => ({
        id: `${profile.id}_${model.replace(/[^A-Za-z0-9_-]/gu, '_')}`,
        label: model === providerConfig.model ? String(profile.label || model) : `${profile.label || providerConfig.provider} · ${model}`,
        config: { ...providerConfig, model, apiKey },
      }));
    } catch (error) {
      console.warn(`R4 profile ${profile.id} credential could not be decrypted: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
}

async function runAcceptance(agent, profiles) {
  const cases = createCases();
  const modelReports = [];
  for (const profile of profiles) {
    console.log(`R4 real-model suite: ${profile.label} (${profile.config.model})`);
    const caseReports = [];
    for (const fixture of cases) {
      const report = await runCase(agent, profile, fixture);
      caseReports.push(report);
      console.log(`  ${report.ok ? 'PASS' : 'FAIL'} ${fixture.id}: scope=${report.finalScope}, cycles=${report.retrievalCycles}, completeness=${report.completeness}${report.failures.length ? `, ${report.failures.join('|')}` : ''}`);
    }
    modelReports.push({
      profileId: profile.id,
      label: profile.label,
      provider: profile.config.provider ?? 'custom',
      api: profile.config.api,
      model: profile.config.model,
      cases: caseReports,
    });
  }

  const fallback = await runFallbackCase(agent, profiles[0]);
  console.log(`  ${fallback.ok ? 'PASS' : 'FAIL'} no-function-calling-fallback: scope=${fallback.finalScope}, cycles=${fallback.retrievalCycles}`);
  const allCases = modelReports.flatMap((entry) => entry.cases);
  const directCases = allCases.filter((entry) => ['ordinary', 'short', 'pronoun'].includes(entry.id));
  const escalationCases = allCases.filter((entry) => ['cross-auto', 'cross-explicit'].includes(entry.id));
  const summary = {
    caseCount: allCases.length + 1,
    unnecessaryDocumentSearchRate: rate(directCases.filter((entry) => entry.documentSearchCount > 0).length, directCases.length),
    documentEscalationRecall: rate(escalationCases.filter((entry) => entry.ok && entry.finalScope === 'document').length, escalationCases.length),
    averageRetrievalCycles: average(allCases.map((entry) => entry.retrievalCycles)),
    retrievalCycleLimitViolationCount: allCases.filter((entry) => entry.retrievalCycles > 5).length + (fallback.retrievalCycles > 5 ? 1 : 0),
    firstMissPrematureStopCount: allCases.filter((entry) => entry.id === 'first-miss'
      && (entry.retrievalCycles < 1 || entry.completeness !== 'complete' || !/DELTA\s*-\s*42/iu.test(entry.answer))).length,
    outOfDocumentEvidenceCount: allCases.reduce((sum, entry) => sum + entry.outOfDocumentEvidenceCount, 0) + fallback.outOfDocumentEvidenceCount,
    genericIntroRegressionCount: allCases.filter((entry) => entry.genericIntro).length + (fallback.genericIntro ? 1 : 0),
  };
  const failures = [
    ...(summary.unnecessaryDocumentSearchRate === 0 ? [] : [`unnecessary-document-search-rate:${summary.unnecessaryDocumentSearchRate}`]),
    ...(summary.documentEscalationRecall === 1 ? [] : [`document-escalation-recall:${summary.documentEscalationRecall}`]),
    ...(summary.retrievalCycleLimitViolationCount === 0 ? [] : [`retrieval-cycle-limit-violations:${summary.retrievalCycleLimitViolationCount}`]),
    ...(summary.firstMissPrematureStopCount === 0 ? [] : [`first-miss-premature-stops:${summary.firstMissPrematureStopCount}`]),
    ...(summary.outOfDocumentEvidenceCount === 0 ? [] : [`out-of-document-evidence:${summary.outOfDocumentEvidenceCount}`]),
    ...(summary.genericIntroRegressionCount === 0 ? [] : [`generic-intro-regressions:${summary.genericIntroRegressionCount}`]),
    ...allCases.filter((entry) => !entry.ok).map((entry) => `${entry.model}:${entry.id}:${entry.failures.join('|')}`),
    ...(fallback.ok ? [] : [`${fallback.model}:fallback:${fallback.failures.join('|')}`]),
  ];
  return { generatedAt: new Date().toISOString(), ok: failures.length === 0, failures, models: modelReports, fallback, summary };
}

async function runCase(agent, profile, fixture) {
  globalThis.__wikiR4CaseId = fixture.id;
  globalThis.__wikiR4RetrievalInputs = [];
  globalThis.__wikiR4CompletedSearchBatches = 0;
  const events = [];
  const traces = [];
  const controller = new AbortController();
  const outcome = await withTimeout(agent.runWikiNodeAgentTurn(createAgentInput({
    profile,
    fixture,
    controller,
    events,
    traces,
    streamAnswer: createRemoteStreamAnswer(agent, profile),
  })), 120_000, controller, `${profile.config.model}/${fixture.id}`);
  assert.ok(outcome.result && outcome.metrics, `${profile.config.model}/${fixture.id} returned no result.`);
  const answer = outcome.result.answer.trim();
  const inputs = globalThis.__wikiR4RetrievalInputs;
  const scope = outcome.result.wikiScopeResult;
  const failures = fixture.validate({ answer, outcome, inputs });
  if (outcome.degraded) failures.push(`native-tools-degraded:${outcome.metrics.stopDetail ?? 'unknown'}`);
  const outOfDocumentEvidenceCount = inputs.filter((entry) => entry.documentIds.some((documentId) => documentId !== 'doc-r4')).length;
  if (scope.retrievalCyclesUsed > 5) failures.push('retrieval-cycle-limit');
  if (outOfDocumentEvidenceCount > 0) failures.push('out-of-document-evidence');
  const genericIntro = isGenericIntro(answer);
  if (genericIntro) failures.push('generic-intro');
  return {
    id: fixture.id,
    model: profile.config.model,
    ok: failures.length === 0,
    failures,
    answer,
    completeness: outcome.result.completeness,
    initialScope: scope.initialScope,
    finalScope: scope.finalScope,
    retrievalCycles: scope.retrievalCyclesUsed,
    localSearchCount: scope.localSearchCount,
    documentSearchCount: scope.documentSearchCount,
    stopReason: scope.stopReason,
    degraded: Boolean(outcome.degraded),
    stopDetail: outcome.metrics.stopDetail ?? null,
    citationNodeIds: outcome.result.knowledgeBaseCitations.map((citation) => citation.nodeId ?? null),
    outOfDocumentEvidenceCount,
    genericIntro,
    deltaResetCount: events.filter((entry) => entry.type === 'delta-reset').length,
    detailedTraceCount: traces.length,
  };
}

async function runFallbackCase(agent, profile) {
  const fixture = createCases().find((entry) => entry.id === 'cross-auto');
  assert.ok(fixture);
  globalThis.__wikiR4CaseId = 'fallback';
  globalThis.__wikiR4RetrievalInputs = [];
  const controller = new AbortController();
  const events = [];
  const outcome = await withTimeout(agent.runWikiNodeAgentTurn(createAgentInput({
    profile: {
      ...profile,
      config: { kind: 'ollama', api: 'ollama-chat', endpoint: 'http://127.0.0.1:1', model: 'no-native-tools-fixture' },
    },
    fixture: { ...fixture, id: 'fallback' },
    controller,
    events,
    traces: [],
    streamAnswer: createRemoteStreamAnswer(agent, profile),
  })), 120_000, controller, `${profile.config.model}/fallback`);
  assert.equal(outcome.degraded, true);
  assert.ok(outcome.result && outcome.metrics);
  const answer = outcome.result.answer.trim();
  const failures = [];
  if (!/99\s*\.\s*9\s*[％%]/u.test(answer)) failures.push('missing-availability-answer');
  if (outcome.result.wikiScopeResult.finalScope !== 'document') failures.push('missing-document-escalation');
  if (!answer.startsWith('> 检索能力受限')) failures.push('missing-degraded-notice');
  const fallbackInputs = globalThis.__wikiR4RetrievalInputs;
  const outOfDocumentEvidenceCount = fallbackInputs.filter((entry) => entry.documentIds.some((documentId) => documentId !== 'doc-r4')).length;
  if (outOfDocumentEvidenceCount > 0) failures.push('out-of-document-evidence');
  const genericIntro = isGenericIntro(answer);
  if (genericIntro) failures.push('generic-intro');
  return {
    id: 'no-function-calling-fallback',
    model: profile.config.model,
    ok: failures.length === 0,
    failures,
    answer,
    completeness: outcome.result.completeness,
    initialScope: outcome.result.wikiScopeResult.initialScope,
    finalScope: outcome.result.wikiScopeResult.finalScope,
    retrievalCycles: outcome.result.wikiScopeResult.retrievalCyclesUsed,
    localSearchCount: outcome.result.wikiScopeResult.localSearchCount,
    documentSearchCount: outcome.result.wikiScopeResult.documentSearchCount,
    stopReason: outcome.result.wikiScopeResult.stopReason,
    outOfDocumentEvidenceCount,
    genericIntro,
    eventCount: events.length,
  };
}

function createCases() {
  const grounded = (pattern, failure) => ({ answer, outcome }) => [
    ...(pattern.test(answer) ? [] : [failure]),
    ...(outcome.result.completeness === 'complete' ? [] : ['not-complete']),
  ];
  return [
    { id: 'ordinary', question: '第一次恢复退避是多少秒？', conversation: [], validate: grounded(/7\s*秒/u, 'missing-7-seconds') },
    { id: 'short', question: '租约多久失效？', conversation: [], validate: grounded(/47\s*秒/u, 'missing-47-seconds') },
    {
      id: 'pronoun', question: '那第二次呢？',
      conversation: [{ role: 'user', content: '第一次恢复退避是多少秒？' }, { role: 'assistant', content: '第一次恢复退避是 7 秒。' }],
      validate: grounded(/31\s*秒/u, 'missing-31-seconds'),
    },
    {
      id: 'first-miss', question: '只根据本节回答：恢复时用于确认窗口重新建立的标识是什么？', conversation: [],
      validate: ({ answer, outcome, inputs }) => [
        ...(/DELTA\s*-\s*42/iu.test(answer) ? [] : ['missing-delta-42']),
        ...(outcome.result.wikiScopeResult.retrievalCyclesUsed >= 1 ? [] : ['missing-first-search']),
        ...(inputs.length >= 1 ? [] : ['missing-retrieval-attempt']),
        ...(outcome.result.completeness === 'complete' ? [] : ['not-complete']),
      ],
    },
    {
      id: 'cross-auto', question: '资源可用性是什么？', conversation: [],
      validate: ({ answer, outcome }) => [
        ...(/99\s*\.\s*9\s*[％%]/u.test(answer) ? [] : ['missing-availability-answer']),
        ...(outcome.result.wikiScopeResult.finalScope === 'document' ? [] : ['missing-document-escalation']),
        ...(outcome.result.wikiScopeResult.usedOtherSections ? [] : ['missing-other-section-marker']),
        ...(outcome.result.completeness === 'complete' ? [] : ['not-complete']),
      ],
    },
    {
      id: 'cross-explicit', question: '全文哪里说明了资源可用性？', conversation: [],
      validate: ({ answer, outcome }) => [
        ...(/99\s*\.\s*9\s*[％%]/u.test(answer) ? [] : ['missing-availability-answer']),
        ...(outcome.result.wikiScopeResult.initialScope === 'document' ? [] : ['not-document-first']),
        ...(outcome.result.completeness === 'complete' ? [] : ['not-complete']),
      ],
    },
    {
      id: 'node-locked', question: '只根据本节回答：资源可用性是什么？', conversation: [],
      validate: ({ answer, outcome }) => [
        ...(!/99\s*\.\s*9\s*[％%]/u.test(answer) ? [] : ['leaked-other-section-answer']),
        ...(outcome.result.wikiScopeResult.documentSearchCount === 0 ? [] : ['node-lock-searched-document']),
        ...(outcome.result.wikiScopeResult.finalScope === 'subtree' ? [] : ['node-lock-expanded']),
      ],
    },
    {
      id: 'no-answer', question: '本文对量子密钥轮换周期有什么规定？', conversation: [],
      validate: ({ answer, outcome }) => [
        ...(/没有找到|未找到|没有.*规定|无法回答/u.test(answer) ? [] : ['missing-honest-no-answer']),
        ...(outcome.result.completeness !== 'complete' ? [] : ['unexpected-complete']),
      ],
    },
  ];
}

function createAgentInput({ profile, fixture, controller, events, traces, streamAnswer }) {
  const wikiTarget = { libraryPath: 'C:/r4', documentId: 'doc-r4', nodeId: 'wiki:doc-r4:current', actionKind: 'free' };
  return {
    event: {},
    request: {
      requestId: `wiki_r4_${profile.id}_${fixture.id}_${Date.now().toString(36)}`,
      intent: 'ask', scope: 'wiki-node', userText: fixture.question, conversation: fixture.conversation, wikiTarget,
    },
    controller,
    wikiTarget,
    outline: createOutline(),
    model: profile.config.model,
    provider: profile.config.kind,
    providerConfig: profile.config,
    contextWindowTokens: profile.config.contextWindowTokens ?? 64_000,
    modelCallCoordinator: {
      prepare: ({ callKind }) => ({
        ready: true,
        call: {
          ticket: { id: `r4-${callKind}-${Date.now().toString(36)}`, callKind },
          plan: { maxOutputTokens: 2_000, rawPromptTokens: 900, predictedPromptTokens: 900, calibrationMultiplier: 1 },
        },
      }),
    },
    onDetailedTrace: (entry) => traces.push(entry),
    store: {},
    emitTurnEvent: (entry) => events.push(entry),
    prepareMaterialSearchContext: async (_libraryPath, query) => ({ targetPath: 'C:/r4', queryTerms: [query] }),
    ...(streamAnswer ? { streamAnswer } : {}),
  };
}

function createOutline() {
  return {
    documentId: 'doc-r4', title: 'R4 验收手册', description: 'Wiki AgentRAG R4 fixture',
    updatedAt: '2026-09-07T00:00:00.000Z', contentHash: 'r4-hash', orderRevisions: {},
    nodes: [
      { id: 'wiki:doc-r4:root', parentId: null, title: 'R4 验收手册', order: 0, depth: 0, markdown: '', sourceHeadingId: 'root', sourceLineNo: 1, kind: 'source' },
      { id: 'wiki:doc-r4:current', parentId: 'wiki:doc-r4:root', title: '当前章节', order: 1, depth: 1, markdown: '第一次恢复退避为 7 秒，第二次为 31 秒。租约在 47 秒后失效。恢复窗口最长 120 秒。', sourceHeadingId: 'heading-current', sourceLineNo: 2, kind: 'source' },
      { id: 'wiki:doc-r4:checksum', parentId: 'wiki:doc-r4:current', title: '附录 A', order: 1, depth: 2, markdown: '恢复校验码为 DELTA-42，仅用于确认恢复窗口已重新建立。', sourceHeadingId: 'heading-checksum', sourceLineNo: 3, kind: 'source' },
      { id: 'wiki:doc-r4:availability', parentId: 'wiki:doc-r4:root', title: '资源可用性', order: 2, depth: 1, markdown: '核心索引服务月度可用率不低于 99.9%。', sourceHeadingId: 'heading-availability', sourceLineNo: 4, kind: 'source' },
    ],
  };
}

function isGenericIntro(answer) {
  return /我是\s*Trellora|Trellora\s*的\s*Wiki\s*章节问答助手|您好[！!，,].*助手/iu.test(answer);
}

function createRemoteStreamAnswer(agent, profile) {
  const transport = agent.createReActChatTransport(profile.config, profile.config.model);
  assert.ok(transport, `${profile.config.model} does not expose a native chat transport.`);
  return async (input) => {
    const response = await transport.chat(profile.config, {
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      tools: [],
      model: profile.config.model,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onDelta: input.onDelta,
    });
    return { answer: response.content, contextUsage: toContextUsage(response.usage) };
  };
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function average(values) {
  return values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function toContextUsage(usage) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
    contextWindowTokens: 64_000,
    estimated: !usage,
    source: usage ? 'provider' : 'estimate',
  };
}

async function withTimeout(promise, timeoutMs, controller, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Timed out after ${timeoutMs} ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
