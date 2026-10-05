import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-prompt-budget.cjs');

try {
  await fs.rm(bundlePath, { force: true });
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditPromptBudget.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const budget = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const config = {
    kind: 'ollama',
    model: 'fixture-model',
    contextWindowTokens: 4_096,
    contextWindowTokensSource: 'user',
  };
  const fitting = budget.assertSelectionEditPromptFitsContext({
    config,
    model: 'fixture-model',
    action: 'polish',
    selectedText: '字'.repeat(1_000),
    prompt: `任务：润色\n<selected_text>${'字'.repeat(1_000)}</selected_text>`,
  });
  assert.ok(fitting.totalTokens <= 4_096, '1,000 个中文编辑单位在 4K 窗口且无额外证据时应可发送。');
  assert.throws(() => budget.assertSelectionEditPromptFitsContext({
    config,
    model: 'fixture-model',
    action: 'polish',
    selectedText: '字'.repeat(1_000),
    prompt: `任务：润色\n<selected_text>${'字'.repeat(1_000)}</selected_text>\n<verified_evidence>${'证'.repeat(3_500)}</verified_evidence>`,
  }), /超过当前模型 4,096 token 的上下文窗口/u, '最终拼入证据后超过模型窗口必须在发送前阻止。');
  console.log('Selection edit prompt-budget verification passed');
} finally {
  await fs.rm(bundlePath, { force: true });
}
