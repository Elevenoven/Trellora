export const APP_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type AppLanguage = typeof APP_LANGUAGES[number];

/** 旧配置与不支持的语言统一回退到简体中文。 */
export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}
