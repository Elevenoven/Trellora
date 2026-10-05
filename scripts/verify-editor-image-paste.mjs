import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-editor-image-paste');
const outFile = path.join(outDir, 'editorImageClipboard.mjs');
const protocolOutFile = path.join(outDir, 'editorImageProtocol.mjs');
mkdirSync(outDir, { recursive: true });

const appSource = readFileSync(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
const editorSource = readFileSync(path.join(rootDir, 'src', 'components', 'Editor.tsx'), 'utf8');
const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const preloadSource = readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
const electronTypesSource = readFileSync(path.join(rootDir, 'src', 'electron.d.ts'), 'utf8');
const imageProtocolSource = readFileSync(path.join(rootDir, 'electron', 'editorImageProtocol.ts'), 'utf8');

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'editorImageClipboard.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
});

await build({
  entryPoints: [path.join(rootDir, 'shared', 'editorImageProtocol.ts')],
  outfile: protocolOutFile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
});

const {
  extractLocalImagePathsFromMarkdown,
  formatSavedEditorImageMarkdown,
  getClipboardImageSources,
  toEditorImageUrl,
} = await import(pathToFileURL(outFile).href);
const { parseEditorImageUrl } = await import(pathToFileURL(protocolOutFile).href);

assert.match(editorSource, /handlePaste:\s*\(view, event\)[\s\S]*?getClipboardImageSources\(event\.clipboardData\)/u);
assert.doesNotMatch(editorSource, /onPaste=\{handlePaste\}/u, 'Tiptap must own the paste interception before its default HTML parser runs.');
assert.match(appSource, /ref=\{sourceEditorRef\}[\s\S]*?onPaste=\{\(event\)/u, 'Source mode must share the image paste workflow.');
assert.match(preloadSource, /saveEditorImage:[\s\S]*?save-editor-image/u);
assert.match(mainSource, /(?:ipcMain\.handle|registerAppHandler)\('save-editor-image'[\s\S]*?assertInsideDirectory\(input\.notePath, libraryPath\)/u);
assert.match(electronTypesSource, /saveEditorImage:\s*\(request:\s*SaveEditorImageRequest\)/u);
assert.match(mainSource, /registerEditorImageProtocolScheme\(\)/u);
assert.match(mainSource, /registerEditorImageProtocol\(\(\) =>/u);
assert.match(imageProtocolSource, /protocol\.handle\(EDITOR_IMAGE_PROTOCOL/u);
assert.match(imageProtocolSource, /assertInsideDirectory\(realRequestedPath, realLibraryPath/u);

const dataTransfer = (html, text) => ({
  items: [],
  files: [],
  getData: (type) => type === 'text/html' ? html : type === 'text/plain' ? text : '',
});

assert.deepEqual(
  getClipboardImageSources(dataTransfer(
    '<p><img src="file:///C:/Users/Eleven/AppData/Roaming/Typora/typora-user-images/image-1.png"></p>',
    '![image-1](C:\\Users\\Eleven\\AppData\\Roaming\\Typora\\typora-user-images\\image-1.png)',
  )),
  [{ kind: 'local-path', sourcePath: 'C:\\Users\\Eleven\\AppData\\Roaming\\Typora\\typora-user-images\\image-1.png' }],
  'An image-only Typora HTML clipboard must import its local image instead of pasting the absolute path.',
);

assert.deepEqual(
  extractLocalImagePathsFromMarkdown('![截图](C:\\Users\\Eleven\\Pictures\\shot.webp)'),
  ['C:\\Users\\Eleven\\Pictures\\shot.webp'],
);
assert.deepEqual(
  extractLocalImagePathsFromMarkdown('说明文字\n\n![截图](C:\\Users\\Eleven\\Pictures\\shot.webp)'),
  [],
  'Mixed text and images must fall back to the normal paste path to avoid dropping clipboard text.',
);
assert.deepEqual(
  getClipboardImageSources(dataTransfer(
    '<p>说明文字</p><p><img src="file:///C:/Users/Eleven/Pictures/shot.png"></p>',
    '说明文字',
  )),
  [],
  'Mixed HTML must not be replaced with an image-only paste.',
);

assert.equal(
  formatSavedEditorImageMarkdown({
    absolutePath: 'C:\\Notes\\image\\image-1.png',
    markdownPath: '../image/image-1.png',
    fileName: 'image-1.png',
  }),
  '![image-1](../image/image-1.png)',
);
assert.equal(
  toEditorImageUrl('C:\\Notes\\image\\image-1.png'),
  'menghan-image://local/C%3A%2FNotes%2Fimage%2Fimage-1.png',
);
assert.equal(
  parseEditorImageUrl('menghan-image://local/C%3A%2FNotes%2Fimage%2Fimage-1.png'),
  'C:/Notes/image/image-1.png',
);
assert.equal(parseEditorImageUrl('menghan-image://local/..%2Fsecret.png'), null);
assert.equal(parseEditorImageUrl('menghan-image://remote/C%3A%2FNotes%2Fimage%2Fimage-1.png'), null);

console.log('Editor image paste verification passed');
