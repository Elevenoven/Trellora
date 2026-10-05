import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-import-files');
const outFile = path.join(outDir, 'importFiles.cjs');
const sourceDir = path.join(outDir, 'source');
const libraryDir = path.join(outDir, 'library');
const inboxDir = path.join(libraryDir, 'Inbox');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(sourceDir, { recursive: true });
mkdirSync(inboxDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

const mdSource = path.join(sourceDir, 'Daily.md');
const txtSource = path.join(sourceDir, 'Plain.txt');
const jsonSource = path.join(sourceDir, 'Data.json');
const binarySource = path.join(sourceDir, 'Image.png');

writeFileSync(mdSource, '# Daily\n\nhello', 'utf8');
writeFileSync(txtSource, 'plain text note', 'utf8');
writeFileSync(jsonSource, '{\n  "ok": true\n}', 'utf8');
writeFileSync(binarySource, Buffer.from([0, 159, 146, 150, 0, 1]));
writeFileSync(path.join(inboxDir, 'Daily.md'), '# Existing\n', 'utf8');

await build({
  entryPoints: [path.join(rootDir, 'electron', 'importFiles.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  importTextFilesToLibrary,
} = await import(pathToFileURL(outFile).href);

const imported = importTextFilesToLibrary({
  libraryPath: libraryDir,
  sourcePaths: [mdSource, txtSource, jsonSource],
  targetDirectoryPath: inboxDir,
});

assert.equal(imported.length, 3);
assert.deepEqual(imported.map((entry) => entry.name), ['Daily 1.md', 'Plain.txt', 'Data.json']);
assert.deepEqual(imported.map((entry) => entry.kind), ['markdown', 'text', 'text']);
assert.equal(readFileSync(path.join(inboxDir, 'Daily 1.md'), 'utf8'), '# Daily\n\nhello');
assert.equal(readFileSync(path.join(inboxDir, 'Plain.txt'), 'utf8'), 'plain text note');
assert.equal(readFileSync(path.join(inboxDir, 'Data.json'), 'utf8'), '{\n  "ok": true\n}');

assert.throws(
  () => importTextFilesToLibrary({
    libraryPath: libraryDir,
    sourcePaths: [binarySource],
    targetDirectoryPath: inboxDir,
  }),
  /不支持的文本文件/,
);

assert.throws(
  () => importTextFilesToLibrary({
    libraryPath: libraryDir,
    sourcePaths: [txtSource],
    targetDirectoryPath: path.dirname(libraryDir),
  }),
  /位于当前笔记库内/,
);

assert.equal(existsSync(path.join(inboxDir, 'Image.png')), false);

console.log('Import files verification passed');
