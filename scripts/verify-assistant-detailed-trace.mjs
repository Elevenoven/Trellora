import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-assistant-detailed-trace');
const bundleFile = path.join(outDir, 'assistant-detailed-trace.cjs');
await build({
  entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantDetailedTrace.ts')],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS,
  AssistantDetailedTrace,
  createAssistantPublicModelText,
} = await import(pathToFileURL(bundleFile).href);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'menghan-assistant-trace-'));
try {
  const trace = new AssistantDetailedTrace(tempRoot, 'request-detail-001', new Date('2026-08-24T04:00:00.000Z'));
  trace.record({
    stage: 'model',
    action: 'model-decide',
    status: 'completed',
    callKind: 'decide',
    input: {
      prompt: '回答 NER。Authorization: Bearer private-token',
      apiKey: 'sk-private',
      inputTokens: 1234,
      attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,PRIVATE_IMAGE_BYTES' }],
    },
    output: { rawResponse: '{"type":"answer"}' },
    elapsedMs: 42,
  });
  trace.record({
    stage: 'plan-commit',
    action: 'commit-plan-answer',
    status: 'rejected',
    input: { completeness: 'complete', citations: [] },
    output: { ok: false, message: 'complete answer 必须引用原文。' },
    errorCode: 'provider-timeout',
  });
  await trace.flush();

  const records = fs.readFileSync(trace.filePath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
  assert.equal(records[0].requestId, 'request-detail-001');
  assert.equal(records[0].input.apiKey, '[REDACTED]');
  assert.equal(records[0].input.inputTokens, 1234, 'token 统计不能被敏感字段规则误删');
  assert.equal(records[0].input.prompt.includes('private-token'), false);
  assert.equal(records[0].input.prompt.includes('[REDACTED]'), true);
  assert.equal(records[0].input.attachments[0].dataUrl, '[BINARY_DATA_REDACTED]');
  assert.equal(fs.readFileSync(trace.filePath, 'utf8').includes('PRIVATE_IMAGE_BYTES'), false, '图片 dataUrl 不得进入详细日志文件。');
  assert.equal(records[0].output.rawResponse, '{"type":"answer"}');
  assert.equal(records[1].errorCode, 'provider-timeout');

  const publicPrompt = createAssistantPublicModelText(
    `PROMPT-START\nAuthorization: Bearer private-token\nE:\\Private Notes\\secret.md\n<think>private chain</think>\n${'x'.repeat(600)}\nPROMPT-END`,
    320,
  );
  assert.equal(publicPrompt.truncated, true);
  assert.ok(publicPrompt.originalCharacters > 600);
  assert.match(publicPrompt.text, /PROMPT-START/u);
  assert.match(publicPrompt.text, /PROMPT-END/u);
  assert.match(publicPrompt.text, /已省略中间/u);
  assert.doesNotMatch(publicPrompt.text, /private-token|Private Notes|private chain/u);
  assert.match(publicPrompt.text, /\[REDACTED\]|本地路径已省略|隐藏思考已省略/u);
  assert.equal(ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS, 32_000);

  const mainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'aiProvider.ts'), 'utf8');
  const graphSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts'), 'utf8');
  const panelSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
  const styleSource = fs.readFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), 'utf8');
  assert.match(mainSource, /assistant-detailed-trace/u);
  assert.match(mainSource, /generateJsonWithTrace/u);
  assert.match(mainSource, /type: 'model'/u, '每次 ReAct 模型调用必须实时发布 renderer-safe 事件');
  assert.match(mainSource, /callKind === 'decide' \|\| callKind === 'synthesize'/u);
  assert.match(mainSource, /modelEvents: publicModelEvents/u, '完成事件必须保留本次运行中的模型轮次');
  assert.match(providerSource, /onRawResponse\?\./u, '原始模型内容必须在 JSON 解析前可写入日志');
  assert.doesNotMatch(graphSource, /local-plan-commit-validation/u, '当前笔记最终答案不得再经过本地 plan commit gate');
  assert.match(graphSource, /mirror-model-answer-to-plan/u);
  assert.match(graphSource, /react-tool/u);
  assert.match(graphSource, /synthesize-model-output/u);
  assert.match(panelSource, /getTraceFileName\(trace\.filePath\)/u, '轨迹文件区域应显示短文件名，完整路径只保留在 title 中');
  assert.match(panelSource, /assistant-debug-trace-section/u, '全过程轨迹应具有独立布局边界');
  assert.match(panelSource, /本轮已发生上下文压缩/u, '真实上下文压缩必须在回答和调试轨道中给出可见提示');
  assert.match(panelSource, /“首尾预览”只影响调试显示/u, '压缩提示必须明确区分真实送模压缩与 UI 首尾预览');
  assert.match(styleSource, /\.assistant-context-compression-notice\s*\{/u, '压缩提示必须拥有独立的可见状态样式');
  assert.match(styleSource, /\.assistant-debug-section\s*\{[\s\S]*?flex:\s*0 0 auto;/u, '调试分区不得在纵向滚动容器中收缩并覆盖后续内容');
  assert.match(styleSource, /\.assistant-debug-rail\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/u, '调试轨道必须是单一纵向主滚动区域');
  assert.match(styleSource, /\.assistant-debug-heading\s*\{[\s\S]*?position:\s*sticky;/u, '滚动轨迹时应保留面板身份标题');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('assistant detailed trace verification passed');
