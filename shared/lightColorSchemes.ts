export const LIGHT_COLOR_SCHEME_IDS = ['green', 'blue', 'orange', 'gray', 'pink'] as const;
export type LightColorScheme = typeof LIGHT_COLOR_SCHEME_IDS[number];
export type BrandColorScale = [string, string, string, string, string, string, string, string, string, string];

interface LightColorSchemeDefinition {
  id: LightColorScheme;
  label: string;
  accent: string;
  canvas: string;
  panel: string;
  hover: string;
  selected: string;
  border: string;
  borderStrong: string;
  text: string;
  secondary: string;
  tertiary: string;
  focus: string;
}

/** 配色的唯一数据源；保留旧配置字段名，主进程、CSS 与 Mantine 共用。 */
export const LIGHT_COLOR_SCHEMES: readonly LightColorSchemeDefinition[] = [
  { id: 'green', label: '森林绿', accent: '#26745B', canvas: '#F5F8F6', panel: '#EDF3EF', hover: '#E5EFE8', selected: '#E3F0E8', border: '#D8E3DC', borderStrong: '#B9CDBF', text: '#24352C', secondary: '#55675C', tertiary: '#627367', focus: '#3E8C6F' },
  { id: 'blue', label: '雾蓝', accent: '#3268A8', canvas: '#F5F8FC', panel: '#EDF2F9', hover: '#E7EEF8', selected: '#E3EDF9', border: '#D9E3EF', borderStrong: '#B8CBE1', text: '#283649', secondary: '#586A81', tertiary: '#647287', focus: '#487BB5' },
  { id: 'orange', label: '暖橙', accent: '#B35C27', canvas: '#FCF8F3', panel: '#F7F0E7', hover: '#F7EBDD', selected: '#F9E6D7', border: '#EADDCF', borderStrong: '#DCC2AA', text: '#433429', secondary: '#786555', tertiary: '#7C695B', focus: '#B35C27' },
  { id: 'gray', label: '石墨灰', accent: '#5B6573', canvas: '#F7F8FA', panel: '#EEF0F3', hover: '#E9ECF1', selected: '#E6EAF0', border: '#DADEE5', borderStrong: '#BBC3CE', text: '#303742', secondary: '#5B6573', tertiary: '#69727F', focus: '#707C8D' },
  { id: 'pink', label: '玫瑰粉', accent: '#B34F78', canvas: '#FCF7F9', panel: '#F6EEF2', hover: '#F5E7EF', selected: '#F5E2EB', border: '#E9D9E1', borderStrong: '#D8B7C7', text: '#442F39', secondary: '#79606D', tertiary: '#806874', focus: '#B34F78' },
];

interface ColorSchemeDefinition extends LightColorSchemeDefinition {
  raised: string;
  fill: string;
}

/** 深色底板保持低饱和；文字主色与实心填充色分开，兼顾阅读和白字按钮。 */
export const DARK_COLOR_SCHEMES: readonly ColorSchemeDefinition[] = [
  { id: 'green', label: '森林绿', accent: '#83C8A5', fill: '#337C60', canvas: '#17201B', panel: '#1E2A23', raised: '#25342B', hover: '#2D3F33', selected: '#304D3C', border: '#364B3D', borderStrong: '#4F6B58', text: '#E8F0EA', secondary: '#B2C5B8', tertiary: '#95A99C', focus: '#96D7B7' },
  { id: 'blue', label: '雾蓝', accent: '#93B8E8', fill: '#3E70AD', canvas: '#181F2A', panel: '#202B3A', raised: '#293649', hover: '#304158', selected: '#2D4563', border: '#35465E', borderStrong: '#506B8D', text: '#E8EEF7', secondary: '#B6C4D9', tertiary: '#97AAC4', focus: '#B0CCF1' },
  { id: 'orange', label: '暖橙', accent: '#E5AE7E', fill: '#965829', canvas: '#241C18', panel: '#30251E', raised: '#3B2E24', hover: '#48362A', selected: '#543B28', border: '#513D2E', borderStrong: '#77583D', text: '#F3EAE1', secondary: '#D0BAA7', tertiary: '#B59980', focus: '#F0C49E' },
  { id: 'gray', label: '石墨灰', accent: '#B6C0D0', fill: '#5D6A7E', canvas: '#1C1F24', panel: '#252A32', raised: '#303640', hover: '#3B4350', selected: '#414D60', border: '#3D4551', borderStrong: '#5B687D', text: '#EBEEF3', secondary: '#BAC3D0', tertiary: '#9AA7BA', focus: '#D0D9E6' },
  { id: 'pink', label: '玫瑰粉', accent: '#DEA0BB', fill: '#A34F75', canvas: '#251B22', panel: '#32242D', raised: '#3E2D39', hover: '#4B3443', selected: '#57374A', border: '#523848', borderStrong: '#7C526A', text: '#F5E7EF', secondary: '#D2B4C4', tertiary: '#B991A5', focus: '#EDBDD2' },
];

/** 缺失或未知的旧配置回到森林绿，不改变用户的浅色/深色选择。 */
export function normalizeLightColorScheme(value: unknown): LightColorScheme {
  return LIGHT_COLOR_SCHEME_IDS.includes(value as LightColorScheme) ? value as LightColorScheme : 'green';
}

export function getLightColorScheme(value: unknown): LightColorSchemeDefinition {
  return LIGHT_COLOR_SCHEMES.find(scheme => scheme.id === normalizeLightColorScheme(value))!;
}

export function getColorScheme(theme: 'light' | 'dark', value: unknown): ColorSchemeDefinition {
  if (theme === 'dark') return DARK_COLOR_SCHEMES.find(scheme => scheme.id === normalizeLightColorScheme(value))!;
  const scheme = getLightColorScheme(value);
  return { ...scheme, raised: '#ffffff', fill: scheme.accent };
}

function mixHex(color: string, target: string, amount: number): string {
  const channel = (index: number) => Math.round(parseInt(color.slice(index, index + 2), 16) * (1 - amount) + parseInt(target.slice(index, index + 2), 16) * amount).toString(16).padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** 色阶索引 6 始终等于主色，让 Mantine 的浅色主按钮与原生控件一致。 */
export function getLightBrandColors(value: unknown): BrandColorScale {
  const scheme = getLightColorScheme(value);
  if (scheme.id === 'green') return ['#f1f8f4', '#e3f0e8', '#c6e0d2', '#9cc7b0', '#72ac90', '#4a9272', '#26745b', '#1f604a', '#194d3c', '#133d30'];
  return [mixHex(scheme.accent, '#ffffff', .96), scheme.selected, ...[.72, .54, .38, .18].map(amount => mixHex(scheme.accent, '#ffffff', amount)), scheme.accent, ...[.16, .30, .43].map(amount => mixHex(scheme.accent, '#000000', amount))] as BrandColorScale;
}

/** 深色主色位于索引 4，索引 6 保持实心控件所需的深填充色。 */
export function getBrandColors(theme: 'light' | 'dark', value: unknown): BrandColorScale {
  if (theme === 'light') return getLightBrandColors(value);
  const scheme = getColorScheme(theme, value);
  return [
    ...[.9, .75, .55, .3].map(amount => mixHex(scheme.accent, '#ffffff', amount)),
    scheme.accent,
    mixHex(scheme.accent, scheme.fill, .5),
    scheme.fill,
    ...[.16, .3, .43].map(amount => mixHex(scheme.fill, '#000000', amount)),
  ] as BrandColorScale;
}

/** 覆盖当前外观的界面颜色；AI、厂商标识、语法类别和任务状态保留语义色。 */
export function getColorSchemeTokens(theme: 'light' | 'dark', value: unknown): Record<string, string> {
  const scheme = getColorScheme(theme, value);
  const dark = theme === 'dark';
  return {
    '--surface-canvas': scheme.canvas,
    '--surface-panel': scheme.panel,
    '--surface-raised': scheme.raised,
    '--surface-hover': scheme.hover,
    '--surface-selected': scheme.selected,
    '--border-subtle': scheme.border,
    '--border-strong': scheme.borderStrong,
    '--text-primary': scheme.text,
    '--text-secondary': scheme.secondary,
    '--text-tertiary': scheme.tertiary,
    '--accent-primary': scheme.accent,
    '--accent-fill': scheme.fill,
    '--accent-focus': scheme.focus,
    '--accent-blue': 'var(--accent-primary)',
    '--quote-bg': dark ? (scheme.id === 'green' ? '#263a2e' : scheme.raised) : (scheme.id === 'green' ? '#f0f6f2' : mixHex(scheme.panel, '#ffffff', .22)),
    '--quote-border': !dark && scheme.id === 'green' ? '#b9d4c4' : scheme.borderStrong,
    '--quote-text': scheme.secondary,
    '--code-bg': dark ? (scheme.id === 'green' ? '#1e2c24' : scheme.panel) : (scheme.id === 'green' ? '#f1f5f3' : mixHex(scheme.panel, '#ffffff', .28)),
    '--code-border': scheme.border,
    '--code-text': scheme.text,
    '--code-comment': scheme.tertiary,
    '--document-paper-background': dark ? scheme.raised : '#ffffff',
    '--document-paper-ink': scheme.text,
    '--document-paper-border': dark ? scheme.borderStrong : scheme.border,
    '--graph-edge': dark ? (scheme.id === 'green' ? '#819c8a' : mixHex(scheme.accent, scheme.canvas, .35)) : (scheme.id === 'green' ? '#8ea498' : mixHex(scheme.accent, '#ffffff', .45)),
  };
}

export function getLightColorSchemeTokens(value: unknown): Record<string, string> {
  return getColorSchemeTokens('light', value);
}
