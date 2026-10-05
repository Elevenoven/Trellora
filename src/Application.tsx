import { useCallback, useMemo, useRef, useState } from 'react';
import { createTheme, defaultVariantColorsResolver, MantineProvider } from '@mantine/core';
import App from './App';
import { applyColorScheme, getDocumentLightColorScheme, getDocumentTheme, type ResolvedTheme } from './utils/theme';
import { getBrandColors, getColorScheme, type LightColorScheme } from '../shared/lightColorSchemes';
import { finishStartupSplash } from './utils/startupSplash';

type ViewTransitionHandle = {
  finished: Promise<void>;
  skipTransition?: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

const createMantineTheme = (theme: ResolvedTheme, scheme: LightColorScheme) => createTheme({
  fontFamily: 'var(--font-main)',
  headings: { fontFamily: 'var(--font-main)' },
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 4 },
  autoContrast: true,
  components: {
    Button: { defaultProps: { variant: 'filled' } },
  },
  variantColorResolver: (input) => {
    // 实心主按钮使用独立的填充色，保证深色主题下白色文字仍清晰。
    if (input.variant === 'filled' && (input.color ?? input.theme.primaryColor) === 'brand') {
      return {
        background: 'var(--accent-fill)',
        hover: 'color-mix(in srgb, var(--accent-fill) 88%, #000000)',
        color: 'var(--text-on-accent)',
        border: '1px solid transparent',
      };
    }
    return defaultVariantColorsResolver(input);
  },
  colors: {
    brand: getBrandColors(theme, scheme),
  },
  defaultRadius: 'md',
});

export default function Application() {
  const [colorScheme, setColorScheme] = useState<ResolvedTheme>(getDocumentTheme);
  const [lightColorScheme, setLightColorScheme] = useState<LightColorScheme>(getDocumentLightColorScheme);
  const mantineTheme = useMemo(() => createMantineTheme(colorScheme, lightColorScheme), [colorScheme, lightColorScheme]);
  const activeThemeTransitionRef = useRef<ViewTransitionHandle | null>(null);
  const themeCommitSequenceRef = useRef(0);

  const commitResolvedTheme = useCallback((theme: ResolvedTheme, scheme: LightColorScheme) => {
    const commitSequence = ++themeCommitSequenceRef.current;
    activeThemeTransitionRef.current?.skipTransition?.();
    activeThemeTransitionRef.current = null;
    const root = document.documentElement;
    const isAlreadyApplied = root.dataset.theme === theme
      && root.dataset.lightColorScheme === scheme
      && root.dataset.mantineColorScheme === theme
      && root.style.colorScheme === theme;

    const applyThemeAttributes = () => {
      // 保存失败或连续切换时，已取消的过渡回调不能覆盖最新配色。
      if (themeCommitSequenceRef.current !== commitSequence) return;
      root.dataset.theme = theme;
      root.dataset.mantineColorScheme = theme;
      root.style.colorScheme = theme;
      root.style.backgroundColor = getColorScheme(theme, scheme).canvas;
      applyColorScheme(theme, scheme);
      setColorScheme(theme);
      setLightColorScheme(scheme);
    };

    if (isAlreadyApplied) {
      delete root.dataset.themeTransition;
      setColorScheme(theme);
      setLightColorScheme(scheme);
      return;
    }

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const documentWithViewTransition = document as ViewTransitionDocument;
    if (root.dataset.startupState === 'loading' || prefersReducedMotion || !documentWithViewTransition.startViewTransition) {
      delete root.dataset.themeTransition;
      applyThemeAttributes();
      return;
    }

    root.dataset.themeTransition = 'true';
    const transition = documentWithViewTransition.startViewTransition(applyThemeAttributes);
    activeThemeTransitionRef.current = transition;
    void transition.finished.catch(() => undefined).then(() => {
      if (activeThemeTransitionRef.current !== transition) return;
      activeThemeTransitionRef.current = null;
      delete root.dataset.themeTransition;
    });
  }, []);

  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={colorScheme}>
      <App onResolvedThemeChange={commitResolvedTheme} onStartupReady={finishStartupSplash} />
    </MantineProvider>
  );
}
