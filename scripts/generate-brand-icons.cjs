const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Encode the rendered PNG frames as a Windows ICO with transparent, size-specific images. */
function createIco(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...frames.map(frame => frame.png)]);
}

/** Rasterize the canonical SVG in an isolated, hidden Electron window without external services. */
async function renderIcons() {
  const { app, BrowserWindow } = require('electron');
  const source = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
  const imageUrl = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  const window = new BrowserWindow({
    show: false,
    width: 32,
    height: 32,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await window.loadURL('about:blank');
  const rendered = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(imageUrl)};
    await image.decode();
    return ${JSON.stringify([...sizes, 1024])}.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      return { size, data: canvas.toDataURL('image/png').split(',')[1] };
    });
  })()`);
  const frames = rendered.map(({ size, data }) => ({ size, png: Buffer.from(data, 'base64') }));
  fs.writeFileSync(path.join(root, 'build/icon.png'), frames.find(frame => frame.size === 1024).png);
  fs.writeFileSync(path.join(root, 'build/icon.ico'), createIco(frames.filter(frame => frame.size <= 256)));
  window.destroy();
  console.log(`Generated build/icon.png (1024px) and build/icon.ico (${sizes.join(', ')}px) from build/icon.svg.`);
  app.quit();
}

/** Launch the bundled Electron runtime and remove only the temporary profile created for this run. */
function launchRenderer() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, 'trellora-brand-icons-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, profile], {
    cwd: root, env, stdio: 'inherit', shell: false, windowsHide: true,
  });
  const cleanup = () => {
    if (path.dirname(profile) !== temporaryRoot || !path.basename(profile).startsWith('trellora-brand-icons-')) {
      throw new Error('Icon renderer temporary profile escaped its expected directory.');
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  child.once('error', error => { cleanup(); console.error(error); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
}

if (process.versions.electron) {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData', process.argv[2]);
  app.whenReady().then(renderIcons).catch(error => { console.error(error); app.exit(1); });
} else {
  launchRenderer();
}
