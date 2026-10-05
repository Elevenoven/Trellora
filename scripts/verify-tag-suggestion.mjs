import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-tag-suggestion', 'tag-suggestion.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'tagSuggestion.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
const { applyConfirmedTags } = await import(pathToFileURL(outFile).href);

const result = applyConfirmedTags('---\ntitle: Alpha\ntags: [existing]\n---\n\n# Alpha\n', ['existing', '#suggested']);
assert.deepEqual(result.tags, ['existing', 'suggested']);
assert.match(result.markdown, /tags:\n  - existing\n  - suggested/);
assert.match(result.markdown, /# Alpha/);
assert.equal(applyConfirmedTags(result.markdown, ['suggested']).markdown, result.markdown);
console.log('Confirmed tag application verification passed');
