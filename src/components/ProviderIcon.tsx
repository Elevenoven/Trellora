import { Ban, Plug } from 'lucide-react';
import openai from '../assets/providers/openai.svg';
import anthropic from '../assets/providers/anthropic.svg';
import google from '../assets/providers/gemini-color.svg';
import deepseek from '../assets/providers/deepseek-color.svg';
import moonshot from '../assets/providers/moonshot.svg';
import qwen from '../assets/providers/qwen-color.svg';
import zhipu from '../assets/providers/zhipu-color.svg';
import siliconflow from '../assets/providers/siliconcloud-color.svg';
import jina from '../assets/providers/jina.svg';
import voyage from '../assets/providers/voyage.svg';
import openrouter from '../assets/providers/openrouter.svg';
import ollama from '../assets/providers/ollama.svg';
import duckduckgo from '../assets/providers/duckduckgo.svg';
import searxng from '../assets/providers/searxng-color.svg';
import tavily from '../assets/providers/tavily-color.svg';
import baidu from '../assets/providers/baidu-color.svg';
import './ProviderIcon.css';

const providerAssets: Record<string, { src: string; monochrome?: boolean; color?: string }> = {
  openai: { src: openai, monochrome: true },
  anthropic: { src: anthropic, monochrome: true },
  google: { src: google },
  deepseek: { src: deepseek },
  moonshot: { src: moonshot, monochrome: true },
  qwen: { src: qwen },
  zhipu: { src: zhipu },
  siliconflow: { src: siliconflow },
  jina: { src: jina, monochrome: true },
  voyage: { src: voyage, monochrome: true },
  openrouter: { src: openrouter, monochrome: true },
  ollama: { src: ollama, monochrome: true },
  duckduckgo: { src: duckduckgo, monochrome: true, color: '#de5833' },
  searxng: { src: searxng },
  tavily: { src: tavily },
  baidu: { src: baidu },
};

/** 只按连接的厂商 ID 显示标识；自定义名称与模型名称不参与推断。 */
export default function ProviderIcon({ provider, size = 20 }: { provider?: string; size?: number }) {
  const asset = provider && Object.hasOwn(providerAssets, provider) ? providerAssets[provider] : undefined;
  return <span className="provider-icon" data-provider={provider ?? 'custom'} aria-hidden="true" style={{ width: size, height: size, color: asset?.color }}>
    {asset ? asset.monochrome
      ? <span className="provider-icon-mark" style={{ maskImage: `url("${asset.src}")` }} />
      : <img className="provider-icon-image" src={asset.src} alt="" />
      : provider === 'none' ? <Ban size={size} /> : <Plug size={size} />}
  </span>;
}
