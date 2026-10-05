import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const rootDir = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const indexHtml = read('index.html');

function createDocument({ storedMode, storedScheme, darkSystem }) {
  return new JSDOM(indexHtml, {
    url: 'http://localhost',
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: darkSystem }),
      });
      if (storedMode) window.localStorage.setItem('trellora-theme-mode', storedMode);
      if (storedScheme) window.localStorage.setItem('trellora-light-color-scheme', storedScheme);
    },
  });
}

const darkStart = createDocument({ storedMode: 'dark', darkSystem: false });
assert.equal(darkStart.window.document.documentElement.dataset.theme, 'dark');
assert.equal(darkStart.window.document.documentElement.dataset.mantineColorScheme, 'dark');
assert.equal(darkStart.window.document.documentElement.style.colorScheme, 'dark');

const systemStart = createDocument({ storedMode: 'system', darkSystem: true });
assert.equal(systemStart.window.document.documentElement.dataset.theme, 'dark');

const themeModulePath = path.join(rootDir, '.package-staging', 'verify-theme-transition', 'theme.mjs');
const paletteModulePath = path.join(rootDir, '.package-staging', 'verify-theme-transition', 'palettes.mjs');
await build({ entryPoints: [path.join(rootDir, 'shared', 'lightColorSchemes.ts')], outfile: paletteModulePath, bundle: true, platform: 'node', format: 'esm' });
const { LIGHT_COLOR_SCHEMES, DARK_COLOR_SCHEMES, getBrandColors, getColorSchemeTokens } = await import(pathToFileURL(paletteModulePath).href);
for (const theme of ['light', 'dark']) for (const scheme of theme === 'dark' ? DARK_COLOR_SCHEMES : LIGHT_COLOR_SCHEMES) {
  const startup = createDocument({ storedMode: theme, storedScheme: scheme.id, darkSystem: true });
  const root = startup.window.document.documentElement;
  assert.equal(root.dataset.theme, theme);
  assert.equal(root.dataset.lightColorScheme, scheme.id);
  const expectedStyle = startup.window.document.createElement('div').style;
  expectedStyle.backgroundColor = scheme.canvas;
  assert.equal(root.style.backgroundColor, expectedStyle.backgroundColor, '启动背景与共享色板一致');
  assert.equal(getBrandColors(theme, scheme.id)[theme === 'dark' ? 4 : 6].toLowerCase(), scheme.accent.toLowerCase());
  startup.window.close();
}
const invalidScheme = createDocument({ storedScheme: '__proto__', darkSystem: false });
assert.equal(invalidScheme.window.document.documentElement.dataset.lightColorScheme, 'green');
invalidScheme.window.close();
await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'theme.ts')],
  outfile: themeModulePath,
  bundle: true,
  platform: 'browser',
  format: 'esm',
});

const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
globalThis.window = darkStart.window;
globalThis.document = darkStart.window.document;
try {
  const { applyAppearance, applyColorScheme, getDocumentLightColorScheme, getDocumentTheme, resolveTheme, THEME_MODE_STORAGE_KEY, LIGHT_COLOR_SCHEME_STORAGE_KEY } = await import(`${pathToFileURL(themeModulePath).href}?${Date.now()}`);
  assert.equal(getDocumentTheme(), 'dark');
  assert.equal(resolveTheme('system'), 'light');
  applyAppearance({ theme: 'light', lightColorScheme: 'pink', density: 'compact' });
  assert.equal(darkStart.window.document.documentElement.dataset.density, 'compact');
  assert.equal(darkStart.window.localStorage.getItem(THEME_MODE_STORAGE_KEY), 'light');
  assert.equal(darkStart.window.localStorage.getItem(LIGHT_COLOR_SCHEME_STORAGE_KEY), 'pink');
  for (const scheme of LIGHT_COLOR_SCHEMES) {
    applyColorScheme('light', scheme.id);
    assert.equal(getDocumentLightColorScheme(), scheme.id);
    for (const [key, value] of Object.entries(getColorSchemeTokens('light', scheme.id))) {
      assert.equal(document.documentElement.style.getPropertyValue(key), value);
    }
    applyColorScheme('dark', scheme.id);
    assert.equal(getDocumentLightColorScheme(), scheme.id);
    for (const [key, value] of Object.entries(getColorSchemeTokens('dark', scheme.id))) {
      assert.equal(document.documentElement.style.getPropertyValue(key), value, '深色完整替换浅色覆盖');
    }
  }
} finally {
  globalThis.window = previousWindow;
  globalThis.document = previousDocument;
  darkStart.window.close();
  systemStart.window.close();
}

const application = read('src/Application.tsx');
const app = read('src/App.tsx');
const settings = read('src/components/SettingsPanel.tsx');
const css = read('src/styles/theme.css');

assert.match(application, /root\.dataset\.theme = theme/);
assert.match(application, /root\.dataset\.mantineColorScheme = theme/);
assert.match(application, /root\.style\.backgroundColor = getColorScheme\(theme, scheme\)\.canvas/);
assert.match(application, /documentWithViewTransition\.startViewTransition/);
assert.match(application, /prefers-reduced-motion: reduce/);
assert.match(app, /replaceAppPreferences\(optimisticPreferences\);\s+synchronizeAppearance\(optimisticPreferences\);/);
assert.match(settings, /const saveAppearancePreference/);
assert.match(settings, /onChange=\{saveAppearancePreference\}/);
assert.match(css, /::view-transition-old\(root\)/);
assert.match(css, /180ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
assert.doesNotMatch(css, /transition:\s*all\b/);

console.log('Theme transition verification passed');
