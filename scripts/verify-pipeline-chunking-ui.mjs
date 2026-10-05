import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const tempDir = mkdtempSync(path.join(root, '.chunking-ui-test-'));
const entry = path.join(tempDir, 'entry.ts');
const output = path.join(tempDir, 'chunking-draft.cjs');
const modalOutput = path.join(tempDir, 'chunking-modal.js');

try {
  const draftModule = path.relative(tempDir, path.join(root, 'src', 'utils', 'chunkingStrategyDraft.ts')).replace(/\\/g, '/');
  writeFileSync(entry, `
    export { RECOMMENDED_CHUNKING_DRAFT, cloneChunkingDraft, validateChunkingDraft } from ${JSON.stringify(draftModule.startsWith('.') ? draftModule : `./${draftModule}`)};
  `, 'utf8');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' });
  await build({
    entryPoints: [path.join(root, 'src', 'components', 'ChunkingStrategyConfigModal.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: modalOutput,
    external: ['react', '@mantine/core', 'lucide-react'],
    logLevel: 'silent',
  });
  const api = await import(`${pathToFileUrl(output)}?v=${Date.now()}`);

  assert.equal(api.RECOMMENDED_CHUNKING_DRAFT.mode, 'recommended', '新资料库必须默认采用系统推荐');
  const cancelledDraft = api.cloneChunkingDraft();
  cancelledDraft.mode = 'custom';
  cancelledDraft.parentMaxChars = 999;
  assert.equal(api.RECOMMENDED_CHUNKING_DRAFT.mode, 'recommended', '取消草稿配置不能改写默认值');
  assert.equal(api.RECOMMENDED_CHUNKING_DRAFT.parentMaxChars, 3500, '取消草稿配置不能持久化长度边界');

  const invalid = api.cloneChunkingDraft({ ...api.RECOMMENDED_CHUNKING_DRAFT, mode: 'custom', parentMinChars: 3600, childStrategies: ['LLM'], llmEnabled: false, regexPattern: '' });
  invalid.parentStrategies = ['REGEX'];
  const errors = api.validateChunkingDraft(invalid);
  assert.ok(errors.parent && errors.regex && errors.llm, '字段错误必须在 Parent、正则和 LLM 输入处定位');

  const modal = readFileSync(path.join(root, 'src', 'components', 'ChunkingStrategyConfigModal.tsx'), 'utf8');
  const materials = readFileSync(path.join(root, 'src', 'components', 'MaterialsView.tsx'), 'utf8');
  const main = readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
  assert.match(modal, /按页切块依赖解析产物的页码覆盖率/, '缺少 PAGE 兼容性警告');
  assert.match(modal, /模型.*不可用|尚未选择聊天模型/, '缺少模型阻塞原因');
  assert.match(modal, /requestAnimationFrame\(\(\) => firstInvalidRef\.current\?\.focus\(\)\)/, '缺少字段错误后的焦点回归');
  assert.match(modal, /仅使当前资料库/, '缺少当前知识库影响范围说明');
  assert.match(materials, /saveLibraryChunkingConfig\(selectedLibrary\.path, config\)/, '已有知识库未接入按库保存');
  assert.match(main, /enqueuePending\(targetPath\)/, '保存策略后未重新安排当前资料库');

  console.log('verify-pipeline-chunking-ui: recommended draft, cancelled draft isolation, field errors, PAGE/model guidance, focus return, and current-library replan wiring passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function pathToFileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}
