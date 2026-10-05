import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import { startupSplashPlugin } from './scripts/startupSplashPlugin'

const markdownExportFontQuery = '?markdown-export-inline'

function inlineMarkdownExportFonts(): Plugin {
  return {
    name: 'inline-markdown-export-fonts',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(markdownExportFontQuery)) return null
      const resolved = await this.resolve(
        source.slice(0, -markdownExportFontQuery.length),
        importer,
        { skipSelf: true },
      )
      return resolved ? `${resolved.id}${markdownExportFontQuery}` : null
    },
    async load(id) {
      if (!id.endsWith(markdownExportFontQuery)) return null
      const fontPath = id.slice(0, -markdownExportFontQuery.length)
      const dataUrl = `data:font/woff2;base64,${(await readFile(fontPath)).toString('base64')}`
      return `export default ${JSON.stringify(dataUrl)};`
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [startupSplashPlugin(), inlineMarkdownExportFonts(), react()],
  base: './', // Vital for Electron to load assets from file://
})
