const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const rootDir = process.cwd()
const stagingDir = path.join(rootDir, '.package-staging', 'verify-pdf-preview-runtime')
const htmlPath = path.join(stagingDir, 'index.html')

run().then(
  () => app.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error)
    app.exit(1)
  },
)

async function run() {
  let verificationWindow = null
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.mkdirSync(stagingDir, { recursive: true })
    app.setPath('userData', path.join(stagingDir, 'user-data'))
    app.setPath('sessionData', path.join(stagingDir, 'session-data'))
    await withTimeout(app.whenReady(), 10_000, 'Electron app readiness timed out')
    fs.writeFileSync(htmlPath, `<!doctype html>
<html data-theme="dark">
  <head>
    <link rel="stylesheet" href="./variables.css">
    <link rel="stylesheet" href="./theme.css">
    <style>.docx-wrapper > section.docx { background: white; color: black; }</style>
  </head>
  <body>
    <canvas id="page"></canvas>
    <div class="materials-docx-surface"><div class="docx-wrapper"><section class="docx"></section></div></div>
  </body>
</html>`, 'utf8')
    fs.copyFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), path.join(stagingDir, 'variables.css'))
    fs.copyFileSync(path.join(rootDir, 'src', 'styles', 'theme.css'), path.join(stagingDir, 'theme.css'))
    fs.copyFileSync(
      path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
      path.join(stagingDir, 'pdf.mjs'),
    )
    fs.copyFileSync(
      path.join(rootDir, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'),
      path.join(stagingDir, 'pdf.worker.min.mjs'),
    )

    verificationWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await withTimeout(verificationWindow.loadFile(htmlPath), 10_000, 'Electron verification page load timed out')

    const pdfBase64 = createMinimalPdf().toString('base64')
    const result = await withTimeout(verificationWindow.webContents.executeJavaScript(`
      (async () => {
        const pdfjs = await import('./pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', window.location.href).href;
        const bytes = Uint8Array.from(atob(${JSON.stringify(pdfBase64)}), (character) => character.charCodeAt(0));
        const loadingTask = pdfjs.getDocument({ data: bytes });

        try {
          const pdf = await Promise.race([
            loadingTask.promise,
            new Promise((_, reject) => window.setTimeout(() => reject(new Error('PDF worker startup timed out')), 10_000)),
          ]);
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 1 });
          const canvas = document.getElementById('page');
          const context = canvas.getContext('2d');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const eyeCareBackground = getComputedStyle(document.documentElement)
            .getPropertyValue('--document-paper-background')
            .trim();
          const eyeCareForeground = getComputedStyle(document.documentElement)
            .getPropertyValue('--document-paper-ink')
            .trim();
          await page.render({
            canvas,
            canvasContext: context,
            viewport,
            background: eyeCareBackground,
            pageColors: { background: eyeCareBackground, foreground: eyeCareForeground },
          }).promise;
          const eyeCareCornerPixel = Array.from(context.getImageData(0, 0, 1, 1).data);

          const originalCanvas = document.createElement('canvas');
          const originalContext = originalCanvas.getContext('2d');
          originalCanvas.width = Math.ceil(viewport.width);
          originalCanvas.height = Math.ceil(viewport.height);
          await page.render({ canvas: originalCanvas, canvasContext: originalContext, viewport, background: '#ffffff' }).promise;
          const originalCornerPixel = Array.from(originalContext.getImageData(0, 0, 1, 1).data);
          const docxPage = document.querySelector('.materials-docx-surface section.docx');
          const docxStyle = getComputedStyle(docxPage);
          page.cleanup();
          return {
            pages: pdf.numPages,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            toHex: typeof Uint8Array.prototype.toHex,
            eyeCareCornerPixel,
            originalCornerPixel,
            docxBackground: docxStyle.backgroundColor,
            docxInk: docxStyle.color,
            userAgent: navigator.userAgent,
          };
        } finally {
          void loadingTask.destroy().catch(() => undefined);
        }
      })()
    `, true), 20_000, 'Electron PDF preview verification timed out')

    if (result.pages !== 1 || result.canvasWidth <= 0 || result.canvasHeight <= 0 || result.toHex !== 'function') {
      throw new Error(`Unexpected PDF runtime result: ${JSON.stringify(result)}`)
    }
    if (result.eyeCareCornerPixel.join(',') !== '214,223,206,255') {
      throw new Error(`PDF eye-care background was not recolored: ${JSON.stringify(result.eyeCareCornerPixel)}`)
    }
    if (result.originalCornerPixel.join(',') !== '255,255,255,255') {
      throw new Error(`PDF original background was not preserved: ${JSON.stringify(result.originalCornerPixel)}`)
    }
    if (result.docxBackground !== 'rgb(214, 223, 206)' || result.docxInk !== 'rgb(41, 48, 41)') {
      throw new Error(`Word eye-care theme was not applied: ${JSON.stringify(result)}`)
    }
    console.log(`Document preview runtime verified: PDF ${result.pages} page at ${result.canvasWidth}x${result.canvasHeight}; Word ${result.docxBackground}; ${result.userAgent}`)
  } finally {
    if (verificationWindow && !verificationWindow.isDestroyed()) verificationWindow.destroy()
  }
}

function createMinimalPdf() {
  const stream = '1 1 1 rg\n0 0 612 792 re\nf\n0 0 0 rg\nBT\n/F1 24 Tf\n72 720 Td\n(PDF preview runtime test) Tj\nET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  ]

  let pdf = '%PDF-1.4\n%\x80\x81\x82\x83\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}
