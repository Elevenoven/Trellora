import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.package-staging', 'verify-assistant-evidence-mode');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

await Promise.all([
  bundle('electron/knowledge/assistantMode.ts', 'assistant-mode.cjs'),
  bundle('electron/appPreferences.ts', 'app-preferences.cjs'),
]);

const modeModule = await import(pathToFileURL(path.join(stagingDir, 'assistant-mode.cjs')).href);
const preferencesModule = await import(pathToFileURL(path.join(stagingDir, 'app-preferences.cjs')).href);
const {
  assistantEvidenceProjectionModes,
  evidenceCompressionModes,
  normalizeAssistantEvidenceModeConfig,
} = modeModule;
const { defaultAppPreferences, normalizeAppPreferences } = preferencesModule;

assert.deepEqual(assistantEvidenceProjectionModes, ['minimal', 'all-retrieved']);
assert.deepEqual(evidenceCompressionModes, ['off', 'observe', 'enforce']);

const combinations = assistantEvidenceProjectionModes.flatMap((projectionMode) => evidenceCompressionModes.map((compressionMode) => ({
  projectionMode,
  compressionMode,
  ...normalizeAssistantEvidenceModeConfig({
    assistantEvidenceProjectionMode: projectionMode,
    evidenceCompressionMode: compressionMode,
  }),
})));

assert.equal(combinations.length, 6);
assert.deepEqual(
  combinations.map((entry) => [entry.projectionMode, entry.compressionMode, entry.assistantEvidenceProjectionMode, entry.evidenceCompressionMode]),
  [
    ['minimal', 'off', 'minimal', 'off'],
    ['minimal', 'observe', 'minimal', 'observe'],
    ['minimal', 'enforce', 'minimal', 'observe'],
    ['all-retrieved', 'off', 'all-retrieved', 'off'],
    ['all-retrieved', 'observe', 'all-retrieved', 'observe'],
    ['all-retrieved', 'enforce', 'all-retrieved', 'enforce'],
  ],
);

assert.deepEqual(
  normalizeAssistantEvidenceModeConfig({
    assistantEvidenceProjectionMode: 'invalid',
    evidenceCompressionMode: 'invalid',
  }),
  {
    assistantEvidenceProjectionMode: 'minimal',
    evidenceCompressionMode: 'observe',
  },
);

assert.equal(defaultAppPreferences.assistantEvidenceProjectionMode, 'minimal');
assert.equal(defaultAppPreferences.evidenceCompressionMode, 'observe');
assert.deepEqual(
  normalizeAppPreferences({
    assistantEvidenceProjectionMode: 'all-retrieved',
    evidenceCompressionMode: 'enforce',
  }).assistantEvidenceProjectionMode,
  'all-retrieved',
);
assert.equal(normalizeAppPreferences({ assistantEvidenceProjectionMode: 'invalid', evidenceCompressionMode: 'invalid' }).evidenceCompressionMode, 'observe');

console.log(JSON.stringify({
  ok: true,
  combinations: combinations.map(({ projectionMode, compressionMode, assistantEvidenceProjectionMode, evidenceCompressionMode }) => ({
    input: `${projectionMode}+${compressionMode}`,
    normalized: `${assistantEvidenceProjectionMode}+${evidenceCompressionMode}`,
  })),
  defaultMode: `${defaultAppPreferences.assistantEvidenceProjectionMode}+${defaultAppPreferences.evidenceCompressionMode}`,
}, null, 2));

async function bundle(entryPoint, fileName) {
  await build({
    entryPoints: [path.join(rootDir, entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(stagingDir, fileName),
    logLevel: 'silent',
  });
}
