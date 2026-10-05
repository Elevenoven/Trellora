export interface ModelProfileLabelConfig {
  kind: 'ollama' | 'openai-compatible';
  provider?: string;
  model?: string;
  embeddingModel?: string;
}

const providerLabels: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  qwen: '通义千问（百炼）',
  zhipu: '智谱 AI',
  siliconflow: 'SiliconFlow',
  openrouter: 'OpenRouter',
  custom: '自定义 API',
};

const generatedProfileLabels = new Set(['新模型档案', '远程默认模型', '本地默认模型']);

export function getDefaultModelProfileLabel(config: ModelProfileLabelConfig): string {
  const provider = config.kind === 'ollama' ? 'Ollama' : providerLabels[config.provider ?? 'custom'] ?? '自定义 API';
  const version = config.model?.trim() || config.embeddingModel?.trim() || '未配置';
  return Array.from(`${provider}_${version}`).slice(0, 60).join('');
}

export function isGeneratedModelProfileLabel(label: string | undefined): boolean {
  const normalized = label?.trim() ?? '';
  return !normalized || generatedProfileLabels.has(normalized);
}
