import { normalizeAppLanguage, type AppLanguage } from './appLanguage';
import { normalizeLightColorScheme, type LightColorScheme } from './lightColorSchemes';

export const STARTUP_APPEARANCE_ARGUMENT = '--trellora-startup-appearance=';

/** 首帧只接收外观元数据，不携带路径、模型配置或凭据。 */
export interface StartupAppearance {
  theme: 'light' | 'dark';
  themeMode: 'system' | 'light' | 'dark';
  lightColorScheme: LightColorScheme;
  language: AppLanguage;
}

/** 解析主进程提供的启动快照；缺失或损坏时继续使用已有缓存。 */
export function readStartupAppearance(args: readonly string[]): StartupAppearance | null {
  const argument = args.find(value => value.startsWith(STARTUP_APPEARANCE_ARGUMENT));
  if (!argument) return null;
  try {
    const value = JSON.parse(decodeURIComponent(argument.slice(STARTUP_APPEARANCE_ARGUMENT.length)));
    if (!value || (value.theme !== 'light' && value.theme !== 'dark')) return null;
    return {
      theme: value.theme,
      themeMode: ['system', 'light', 'dark'].includes(value.themeMode) ? value.themeMode : 'system',
      lightColorScheme: normalizeLightColorScheme(value.lightColorScheme),
      language: normalizeAppLanguage(value.language),
    };
  } catch { return null; }
}
