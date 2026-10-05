import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-ai-model-settings', 'settings.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiSettings.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
const { defaultExtensionsSettings, redactModelSettings, validateExtensionsSettings, validateModelSettingsInput } = await import(pathToFileURL(outFile).href);

const input = validateModelSettingsInput({
  defaultProfileId: 'model_local_0001',
  profiles: [
    { id: 'model_local_0001', label: '本地问答', config: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextWindowTokens: 4_096, contextWindowTokensSource: 'user', availableModels: [{ name: 'qwen3:8b', contextWindowTokens: 8_192 }] } },
    { id: 'model_remote_0002', label: '远程问答', config: { kind: 'openai-compatible', provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1', apiKey: 'secret', model: 'deepseek-chat', contextWindowTokens: 1_000_000, availableModels: [{ name: 'deepseek-chat', contextWindowTokens: 131_072, maxOutputTokens: 8_192, reasoning: true }], remoteContentConsent: true } },
  ],
});
assert.equal(input.profiles.length, 2);
assert.equal(input.profiles[0].config.contextWindowTokens, 4_096);
assert.equal(input.profiles[0].config.contextWindowTokensSource, 'user');
assert.equal(input.profiles[0].config.availableModels?.[0]?.contextWindowTokens, 8_192);
assert.equal(input.profiles[1].config.contextWindowTokens, undefined, '旧版自动写入且未标记 user 的窗口不得冒充用户上限');
assert.equal(input.profiles[1].config.availableModels?.[0]?.contextWindowTokens, undefined, '旧版目录中无来源的 Fixed128K 必须失效');
assert.equal(input.profiles[0].config.api, 'ollama-chat');
assert.equal(input.profiles[1].config.api, 'openai-completions');
assert.equal(input.profiles[1].config.availableModels?.[0]?.maxOutputTokens, 8_192);
assert.equal(input.profiles[1].config.availableModels?.[0]?.reasoning, true);
const nativeProviders = validateModelSettingsInput({
  defaultProfileId: 'model_openai_0001',
  profiles: [
    { id: 'model_openai_0001', label: 'OpenAI', config: { kind: 'openai-compatible', provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6', remoteContentConsent: true } },
    { id: 'model_claude_0002', label: 'Claude', config: { kind: 'openai-compatible', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', remoteContentConsent: true } },
    { id: 'model_gemini_0003', label: 'Gemini', config: { kind: 'openai-compatible', provider: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-pro', remoteContentConsent: true } },
  ],
});
assert.deepEqual(nativeProviders.profiles.map((profile) => profile.config.api), ['openai-responses', 'anthropic-messages', 'google-generate-content']);
const explicitCompatibility = validateModelSettingsInput({
  defaultProfileId: 'model_openai_compat',
  profiles: [{ id: 'model_openai_compat', label: 'OpenAI 网关', config: { kind: 'openai-compatible', provider: 'openai', api: 'openai-completions', endpoint: 'https://gateway.example.com/v1', model: 'gpt-5.6', remoteContentConsent: true } }],
});
assert.equal(explicitCompatibility.profiles[0].config.api, 'openai-completions', '显式兼容网关协议必须保留。');
const generated = validateModelSettingsInput({
  defaultProfileId: 'model_qwen_0001',
  profiles: [{ id: 'model_qwen_0001', label: '', config: { kind: 'openai-compatible', provider: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-27b', contextWindowTokens: 131_072, contextWindowTokensSource: 'user', apiKey: 'secret', remoteContentConsent: true } }],
});
assert.equal(generated.profiles[0].label, '通义千问（百炼）_qwen3.8-27b');
assert.equal(generated.profiles[0].config.contextWindowTokens, 131_072);
const legacyProfile = validateModelSettingsInput({
  ...input,
  profiles: [{ ...input.profiles[0], enabled: false }],
});
assert.equal('enabled' in legacyProfile.profiles[0], false);
const migratedGenerated = validateModelSettingsInput({
  ...generated,
  profiles: [{ ...generated.profiles[0], label: '远程默认模型' }],
});
assert.equal(migratedGenerated.profiles[0].label, '通义千问（百炼）_qwen3.8-27b');
const safe = redactModelSettings(input, (id) => id === 'model_remote_0002');
assert.equal(safe.profiles[1].config.hasApiKey, true);
assert.equal('apiKey' in safe.profiles[1].config, false);
await assert.rejects(async () => validateModelSettingsInput({ ...input, defaultProfileId: 'model_missing_0003' }), /默认模型档案必须存在/);

const extensions = validateExtensionsSettings({
  ...defaultExtensionsSettings(),
  skills: [...defaultExtensionsSettings().skills, { id: 'skill_custom_0001', name: '核对', instruction: '输出检查清单。', enabled: true, system: false }],
  mcpServers: [{ id: 'mcp_local_0001', name: '本地工具', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', 'server'], toolAllowlist: ['search'] }],
});
assert.equal(extensions.skills.length, defaultExtensionsSettings().skills.length + 1);
assert.equal('mcpServers' in extensions, false, '旧连接字段不应继续进入技能配置');
assert.equal(extensions.skills.at(-1).name, '核对', '迁移旧配置时应保留用户技能');
assert.equal('mcpServers' in defaultExtensionsSettings(), false);

console.log('AI model settings verification passed');
