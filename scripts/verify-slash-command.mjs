import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-slash-command');
const outFile = path.join(outDir, 'slashCommand.cjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'editor', 'slashCommand.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { filterSlashCommands, slashCommandItems } = await import(pathToFileURL(outFile).href);
assert.equal(slashCommandItems.length, 10);
assert.deepEqual(filterSlashCommands('h2').map((item) => item.id), ['heading-2']);
assert.equal(filterSlashCommands('待办')[0].id, 'task-list');
assert.equal(filterSlashCommands('代码')[0].id, 'code-block');
assert.equal(filterSlashCommands('不存在').length, 0);
assert.equal(new Set(slashCommandItems.map((item) => item.id)).size, slashCommandItems.length);

console.log('Slash command verification passed: command catalog, aliases, Chinese search, and unique identifiers');
