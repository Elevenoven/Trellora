import fs from 'node:fs'
import path from 'node:path'

const distDir = path.resolve(process.argv[2] ?? 'dist')
const indexPath = path.join(distDir, 'index.html')
const documentPreviewPath = path.resolve('src', 'components', 'DocumentPreview.tsx')

if (!fs.existsSync(indexPath)) {
  throw new Error(`Missing renderer entry: ${indexPath}`)
}

const html = fs.readFileSync(indexPath, 'utf8')
const scriptMatch = html.match(
  /<script[^>]+type=["']module["'][^>]+src=["']\.\/assets\/(index-[^"']+\.js)["'][^>]*>/,
)
const styleMatch = html.match(
  /<link[^>]+rel=["']stylesheet["'][^>]+href=["']\.\/assets\/(index-[^"']+\.css)["'][^>]*>/,
)

if (!scriptMatch || !styleMatch) {
  throw new Error('Renderer entry is not the hashed Vite production output')
}

for (const assetName of [scriptMatch[1], styleMatch[1]]) {
  const assetPath = path.join(distDir, 'assets', assetName)
  if (!fs.existsSync(assetPath) || fs.statSync(assetPath).size === 0) {
    throw new Error(`Missing renderer asset: ${assetPath}`)
  }
}

const documentPreviewSource = fs.readFileSync(documentPreviewPath, 'utf8')
if (!documentPreviewSource.includes("from 'pdfjs-dist/legacy/build/pdf.mjs'")) {
  throw new Error('PDF preview must use the PDF.js legacy display build supported by the packaged Electron runtime')
}
if (!documentPreviewSource.includes("from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'")) {
  throw new Error('PDF preview must package the matching PDF.js legacy worker')
}

const pdfWorkerAsset = fs.readdirSync(path.join(distDir, 'assets'))
  .find((assetName) => /^pdf\.worker\.min-[^.]+\.mjs$/.test(assetName))
if (!pdfWorkerAsset) {
  throw new Error('Missing packaged PDF.js worker asset')
}

console.log(`Verified Vite renderer assets in ${distDir}`)
