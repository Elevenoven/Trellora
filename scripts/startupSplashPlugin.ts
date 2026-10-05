import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { LIGHT_COLOR_SCHEMES, DARK_COLOR_SCHEMES } from '../shared/lightColorSchemes';

/** 构建和开发共用首帧：内嵌品牌源 SVG、轻量样式与共享配色，不等待 JS 下载。 */
export function startupSplashPlugin(): Plugin {
  let root = '';
  return {
    name: 'trellora-startup-splash',
    configResolved(config) { root = config.root; },
    async transformIndexHtml() {
      const [css, icon, metadata] = await Promise.all([
        readFile(path.join(root, 'src/styles/startupSplash.css'), 'utf8'),
        readFile(path.join(root, 'build/icon.svg'), 'utf8'),
        readFile(path.join(root, 'package.json'), 'utf8'),
      ]);
      const version = String(JSON.parse(metadata).version).replace(/[^\w.+-]/g, '');
      const palettes = (['light', 'dark'] as const).flatMap(theme => (theme === 'dark' ? DARK_COLOR_SCHEMES : LIGHT_COLOR_SCHEMES).map(scheme => `:root[data-theme="${theme}"][data-light-color-scheme="${scheme.id}"] #startup-splash { --startup-canvas:${scheme.canvas}; --startup-text:${scheme.text}; --startup-secondary:${scheme.secondary}; --startup-accent:${scheme.accent}; --startup-border:${scheme.border}; }`)).join('\n');
      return [
        { tag: 'style', attrs: { id: 'startup-splash-styles' }, children: `${palettes}\n${css}`, injectTo: 'head' },
        { tag: 'section', attrs: { id: 'startup-splash', 'data-phase': 'loading', role: 'status', 'aria-live': 'polite', 'aria-label': 'Trellora' }, children: `<div class="startup-mark" aria-hidden="true">${icon}</div><h1>Trellora</h1><p class="startup-tagline" data-startup-copy="tagline">让知识彼此相连</p><div class="startup-loading"><span class="startup-status" data-startup-copy="status">正在打开工作空间</span><div class="startup-trace" aria-hidden="true"><span></span></div><button class="startup-retry" data-startup-copy="retry" type="button" hidden>重新加载</button></div><div class="startup-footer"><span data-startup-copy="footer">你的笔记，你的知识空间</span><span>v${version}</span></div>`, injectTo: 'body-prepend' },
        { tag: 'script', attrs: { id: 'startup-splash-copy' }, children: `if(document.documentElement.lang==='en-US'){const copy={tagline:'Connect your knowledge',status:'Opening your workspace',retry:'Reload',footer:'Your notes. Your knowledge.'};document.querySelectorAll('[data-startup-copy]').forEach(el=>{el.textContent=copy[el.dataset.startupCopy]});}`, injectTo: 'body' },
      ];
    },
  };
}
