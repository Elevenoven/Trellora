import type { AppPreferences } from '../electron';
import { getColorSchemeTokens, normalizeLightColorScheme, type LightColorScheme } from '../../shared/lightColorSchemes';

export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODE_STORAGE_KEY = 'trellora-theme-mode';
export const LIGHT_COLOR_SCHEME_STORAGE_KEY = 'trellora-light-color-scheme';

function getStoredThemeMode(): AppPreferences['theme'] | null {
  try {
    const value = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return value === 'system' || value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function cacheThemeMode(theme: AppPreferences['theme']): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, theme);
  } catch {
    // Electron Store remains the source of truth. This small mirror only lets
    // index.html choose a correct canvas before React and IPC are ready.
  }
}

export function getDocumentLightColorScheme(): LightColorScheme {
  const scheme = document.documentElement.dataset.lightColorScheme;
  if (scheme) return normalizeLightColorScheme(scheme);
  try { return normalizeLightColorScheme(window.localStorage.getItem(LIGHT_COLOR_SCHEME_STORAGE_KEY)); }
  catch { return 'green'; }
}

/** 每次切换完整替换色板，避免浅深外观或不同配色之间残留颜色。 */
export function applyColorScheme(theme: ResolvedTheme, value: LightColorScheme): void {
  const root = document.documentElement;
  const scheme = normalizeLightColorScheme(value);
  for (const [key, color] of Object.entries(getColorSchemeTokens(theme, scheme))) {
    root.style.setProperty(key, color);
  }
  root.dataset.lightColorScheme = scheme;
}

export function resolveTheme(theme: AppPreferences['theme']): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getDocumentTheme(): ResolvedTheme {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark'
    ? theme
    : resolveTheme(getStoredThemeMode() ?? 'system');
}

export function applyAppearance(preferences: AppPreferences): ResolvedTheme {
  const resolvedTheme = resolveTheme(preferences.theme);
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  cacheThemeMode(preferences.theme);
  try { window.localStorage.setItem(LIGHT_COLOR_SCHEME_STORAGE_KEY, normalizeLightColorScheme(preferences.lightColorScheme)); }
  catch { /* 启动缓存不可写时，仍由 Electron Store 保存配色。 */ }
  return resolvedTheme;
}
