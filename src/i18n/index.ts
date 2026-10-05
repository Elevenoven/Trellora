import { useSyncExternalStore } from 'react';
import { normalizeAppLanguage, type AppLanguage } from '../../shared/appLanguage';
import { english } from './en';

type TranslationValues = Record<string, string | number | null | undefined>;
let language: AppLanguage = 'zh-CN';
const listeners = new Set<() => void>();

/** 由已加载的应用偏好驱动语言；不另存一份偏好，也不重新挂载编辑器。 */
export function setAppLanguage(value: unknown): void {
  const next = normalizeAppLanguage(value);
  document.documentElement.lang = next;
  if (next === language) return;
  language = next;
  listeners.forEach(listener => listener());
}

/** 仅翻译应用文案；未知文本原样返回，保留服务端诊断和用户内容。 */
export function t(source: string, values?: TranslationValues): string {
  const message = language === 'en-US' && Object.hasOwn(english, source) ? english[source] : source;
  return values ? message.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key] ?? '') : match) : message;
}

export const getAppLanguage = (): AppLanguage => language;

/** 只映射选项的显示名称，保留协议值和附加字段。 */
export function localizeOptions<T extends { label: string }>(options: readonly T[]): T[] {
  return options.map(option => ({ ...option, label: t(option.label) }));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** 订阅语言变化，让缓存页面、弹窗和辅助组件也即时更新。 */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, () => language);
  return { language: locale, t };
}
