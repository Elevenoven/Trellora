import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = process.cwd();
const markdownOnly = process.env.TRELLORA_EXPANSION_CASE === 'formatted-list';
const reportPath = path.resolve(`docs/verification/selection-expansion-${markdownOnly ? 'markdown-' : ''}real-models.json`);
const scriptPath = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const configPath = process.env.TRELLORA_EXPANSION_CONFIG_PATH || path.join(process.env.APPDATA || '', 'Electron/config.json');
  await fs.access(configPath);
  await fs.mkdir(path.resolve('.package-staging'), { recursive: true });
  const temporary = await fs.mkdtemp(path.resolve('.package-staging/expansion-real-'));
  try {
    const bundle = path.join(temporary, 'expansion.cjs');
    const stubs = { name: 'external-sources-disabled', setup(context) {
      const exports = {
        materialsLibrary: 'export const findMaterialsDocument=()=>undefined;export const listMaterialsDocuments=()=>[];',
        materialChunkSearch: 'export const readMaterialParentWindow=()=>[];export const searchMaterialChunks=async()=>({results:[]});',
        knowledgeBaseRag: 'export const retrieveKnowledgeBaseEvidence=async()=>({evidence:[]});',
      };
      for (const name of Object.keys(exports)) context.onResolve({ filter: new RegExp(`/${name}$`, 'u') }, () => ({ path: name, namespace: 'external-stub' }));
      context.onLoad({ filter: /.*/u, namespace: 'external-stub' }, ({ path }) => ({ contents: exports[path], loader: 'js' }));
    } };
    await build({ stdin: { contents: `
      export * from './electron/knowledge/selectionEditCoordinator';
      export * from './electron/knowledge/currentNoteSnapshot';
      export { configureAiProvider } from './electron/knowledge/aiProvider';
      export { createReActChatTransport } from './electron/knowledge/reactAgent/reactChatTransport';
    `, loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [stubs], outfile: bundle, logLevel: 'silent' });
    const userData = path.join(temporary, 'user-data');
    const runner = path.join(temporary, 'runner');
    await fs.mkdir(userData); await fs.mkdir(runner);
    await fs.copyFile(path.join(path.dirname(configPath), 'Local State'), path.join(userData, 'Local State'));
    await fs.writeFile(path.join(runner, 'package.json'), JSON.stringify({ name: 'trellora-expansion-verifier', version: '1.0.0', main: 'runner.cjs' }));
    await fs.writeFile(path.join(runner, 'runner.cjs'), `import(${JSON.stringify(pathToFileURL(scriptPath).href)}).catch(error=>{console.error(error.message);require('electron').app.exit(1)});`);
    const env = { ...process.env, TRELLORA_EXPANSION_CONFIG_PATH: configPath, TRELLORA_EXPANSION_BUNDLE: bundle, TRELLORA_EXPANSION_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [`--user-data-dir=${userData}`, runner], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code) process.exitCode = code;
  } finally {
    assert.ok(temporary.startsWith(path.resolve('.package-staging') + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  }
} else {
  const { app, safeStorage } = await import('electron');
  app.setPath('userData', process.env.TRELLORA_EXPANSION_USER_DATA);
  await app.whenReady();
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const stored = JSON.parse(await fs.readFile(process.env.TRELLORA_EXPANSION_CONFIG_PATH, 'utf8'));
    const api = await import(pathToFileURL(process.env.TRELLORA_EXPANSION_BUNDLE).href);
    const profiles = (stored.aiModelSettings?.profiles ?? []).filter((profile) => profile.config?.remoteContentConsent && profile.config.kind === 'openai-compatible' && stored.aiProfileSecrets?.[profile.id]).slice(0, 2);
    assert.ok(profiles.length, '没有可用于验收且已同意远程发送的模型。');
    const selectedText = '解析文本上传到 MinIO，元数据写入 MySQL。';
    const fact = '解析文本上传到 MinIO，artifact、block、table 元数据写入 MySQL。base64 图片与产物落在 MinIO，MySQL 只保留引用和 hash。结构节点写入 MySQL 后，可选同步到 Elasticsearch 导航索引和 Neo4j 图投影。索引任务验证解析任务 lineage 存在且已成功，保证索引只基于冻结的解析版本。';
    const base = `# 解析说明\n\n${selectedText}\n\n${fact}\n\n`;
    const exact = (size) => base + ('档案管理记录仅用于全文边界验收。\n\n'.repeat(size)).slice(0, size - Array.from(base).length);
    const cases = [
      { name: 'boundary-11999', markdown: exact(11999) },
      { name: 'boundary-12000', markdown: exact(12000) },
      { name: 'boundary-12001-tail', markdown: selectedText + '\n\n' + '无关档案记录。\n\n'.repeat(1300) + fact },
      { name: 'multiline-10000', markdown: base + '档案管理记录。\n\n'.repeat(250) + '补充档案文字。'.repeat(1050) },
      { name: 'technical-multi-paragraph', selectedText: '解析文本上传到 MinIO，artifact、block、table 元数据写入 MySQL；base64 图片与产物落在 MinIO，MySQL 只保留引用和 hash。\n\n结构节点写入 MySQL 后，可选同步到 Elasticsearch 导航索引和 Neo4j 图投影。' },
      { name: 'formatted-list', selectedText: '这份文档形成四层数据：\n原始文档与 Parent/Child Chunk；\nChunk 向量和关键词索引；\n实体、关系、Evidence、社区；\n跨文档 Canonical Entity、Relation Group 等派生索引。', selectedMarkdown: '这份文档形成四层数据：\n\n1. **原始文档**与 Parent/Child Chunk；\n2. Chunk 向量和关键词索引；\n3. 实体、关系、Evidence、社区；\n4. 跨文档 Canonical Entity、Relation Group 等派生索引。' },
    ];
    cases[2].markdown = selectedText + '\n\n' + '无关档案记录。\n\n'.repeat(2000).slice(0, 12001 - selectedText.length - 2 - fact.length - 2) + '\n\n' + fact;
    cases[3].markdown = cases[3].markdown.slice(0, 10000);
    cases[4].markdown = `# 解析与索引\n\n${cases[4].selectedText}\n\n## 索引约束\n\n索引任务验证解析任务 lineage 存在且已成功，保证索引只基于冻结的解析版本。管理员确认策略后创建 BUILD_INDEX 任务，并冻结 sourceParseTaskId；解析和索引是两个独立阶段。\n\n` + '档案处理过程记录。\n\n'.repeat(300);
    cases[5].markdown = `# GraphRAG 存储\n\n${cases[5].selectedMarkdown}\n\n## 分层说明\n\n原始文档保存来源，父块提供上下文，子块用于检索定位。Chunk 向量支持语义查询，关键词索引用于精确字面定位。实体与关系关联 Evidence 原文依据，社区组织相关实体。Canonical Entity 合并跨文档同一实体，Relation Group 组织规范实体之间的关系；这些派生索引仍保留原文依据。\n`;
    const results = [];
    for (const profile of profiles) {
      const config = { ...profile.config, apiKey: safeStorage.decryptString(Buffer.from(stored.aiProfileSecrets[profile.id], 'base64')) };
      api.configureAiProvider(config);
      for (const sample of cases.filter((sample) => !markdownOnly || sample.name === 'formatted-list')) {
        const markdown = sample.markdown;
        const snapshot = api.createCurrentNoteSnapshot({ libraryPath: path.resolve('.package-staging/acceptance-fixture'), notePath: path.resolve('.package-staging/acceptance-fixture/解析.md'), title: '解析流程', markdown,
          contentHash: createHash('sha256').update(markdown).digest('hex'), headings: [], revision: 1 });
        const request = api.createCurrentNoteSelectionEditRequest({ requestId: `real-${sample.name}`, action: 'expand', sourceSnapshotId: snapshot.snapshotId, snapshot, selectedText: sample.selectedText ?? selectedText });
        if (sample.selectedMarkdown) request.snapshot.markdownFragment = sample.selectedMarkdown;
        const start = Date.now();
        const trace = [];
        const native = api.createReActChatTransport(config, config.model);
        const transport = native ? { capability: 'native-tools', chat: async (provider, input) => {
          trace.push({ toolsEnabled: Boolean(input.tools.length), promptCharacters: JSON.stringify(input.messages).length });
          const response = await native.chat(provider, input);
          trace[trace.length - 1].toolNames = response.toolCalls.map((call) => call.name);
          return response;
        } } : undefined;
        try {
          const result = await api.runSelectionEditCoordinator({ request, snapshot, signal: AbortSignal.timeout(90000), isSnapshotCurrent: () => true,
            synthesis: { ...(sample.selectedText ? {} : { targetCharacters: 180 }), reasoningDepth: 'balanced', style: '专业说明' }, ...(transport ? { agentTransport: transport } : {}) });
          const record = { model: config.model, sample: sample.name, fullNoteCharacters: Array.from(markdown).length, context: result.receipt,
            length: result.qualityReceipt.lengthReceipt, execution: result.execution, issues: result.qualityReceipt.issues, passed: result.validation.passed,
            writebackKind: result.writebackKind, elapsedMs: Date.now() - start, trace, text: result.text };
          results.push(record);
          console.log(JSON.stringify({ model: record.model, sample: record.sample, contextMode: record.context.contextMode, actual: record.length.actualCharacters, minimum: record.length.minimumCharacters, passed: record.passed, calls: record.execution.modelCalls }));
          assert.equal(record.context.fullNoteIncluded, record.fullNoteCharacters <= 12000);
          assert.ok(record.execution.repairAttempts <= 1 && record.execution.modelCalls <= 6);
          assert.equal(result.writebackKind === 'inline-text', result.validation.passed && Boolean(result.text));
        } catch (error) {
          results.push({ model: config.model, sample: sample.name, error: error.message, elapsedMs: Date.now() - start, trace });
          console.log(JSON.stringify({ model: config.model, sample: sample.name, error: error.message }));
        }
      }
    }
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), boundary: 'real provider calls; current-note coordinator, not renderer acceptance', results }, null, 2));
    assert.ok(results.every((result) => !result.error), '部分真实模型运行失败，详见验收报告。');
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
}
