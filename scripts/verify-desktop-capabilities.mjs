import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const root = mkdtempSync(path.join(os.tmpdir(), 'trellora-capabilities-'));
try {
  const outfile = path.join(root, 'capabilities.cjs');
  await build({ stdin: { contents: "export { UserCapabilities } from './electron/userCapabilities'; export { CloudAuthorization } from './electron/pipeline/cloudAuthorization'; export { runMineruPdfParse } from './electron/pipeline/mineruClient';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile });
  const { UserCapabilities, CloudAuthorization, runMineruPdfParse } = createRequire(import.meta.url)(outfile);
  const library = path.join(root, '中文资料库'); mkdirSync(library);
  const auth = new CloudAuthorization();
  const document = { id: 'pdf-1', contentHash: 'a'.repeat(64) };
  assert.equal(auth.has(library, document), false);
  auth.authorize(library, [document]);
  assert.equal(new CloudAuthorization().has(library, document), true);
  assert.equal(auth.has(library, { ...document, id: 'pdf-2' }), false);
  assert.equal(auth.has(library, { ...document, contentHash: 'b'.repeat(64) }), false);
  const source = path.join(library, '已变化.pdf'); writeFileSync(source, 'PDF_SOURCE_SENTINEL');
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected cloud request'); };
  try {
    await assert.rejects(runMineruPdfParse({ inputPath: source, outputDir: path.join(root, 'stage'), documentId: document.id, expectedContentHash: document.contentHash, endpoint: 'https://mineru.test/api/v4', apiKey: 'KEY_SENTINEL', signal: new AbortController().signal }), error => error.code === 'CLOUD_SOURCE_CHANGED');
    assert.equal(requests, 0, 'source mutation must fail before remote submission');
    assert.equal(readFileSync(source, 'utf8'), 'PDF_SOURCE_SENTINEL');
    assert.equal(crypto.createHash('sha256').update(readFileSync(source)).digest('hex').length, 64);
  } finally { globalThis.fetch = originalFetch; }
  const capabilities = new UserCapabilities();
  const config = { kind: 'openai-compatible', endpoint: 'https://service.test/v1', model: 'model', apiKey: 'KEY_SENTINEL', remoteContentConsent: true };
  const context = { generation: config, pdfConfigured: false, statuses: [], semanticConfigured: false };
  const state = () => capabilities.snapshot(context).capabilities.find(item => item.id === 'generation').state;
  assert.equal(state(), 'unverified');
  capabilities.rememberGeneration(config, { available: false, models: [], endpoint: config.endpoint }); assert.equal(state(), 'unreachable');
  capabilities.rememberGeneration(config, { available: true, models: [{ name: 'other' }], endpoint: config.endpoint }); assert.equal(state(), 'failed');
  capabilities.rememberGeneration(config, { available: true, models: [{ name: 'model' }], endpoint: config.endpoint }); assert.equal(state(), 'available');
  context.generation = { ...config, apiKey: 'CHANGED_KEY' }; assert.equal(state(), 'unverified');
  assert.doesNotMatch(JSON.stringify(capabilities.snapshot(context)), /KEY_SENTINEL|CHANGED_KEY/);
  const semanticContext = { ...context, libraryPath: library, documentId: 'doc-a', semanticConfigured: true, semanticIdentity: 'identity-a', semanticCurrent: false, statuses: [{ documentId: 'doc-a', state: 'FAILED', ftsIndex: { state: 'CURRENT' } }] };
  const semanticState = () => capabilities.snapshot(semanticContext).capabilities.find(item => item.id === 'materialSemantic').state;
  assert.equal(capabilities.snapshot(semanticContext).capabilities.find(item => item.id === 'materialFullText').state, 'available', 'a vector failure must not disable completed full text search');
  capabilities.rememberSemantic('identity-a', true); assert.equal(semanticState(), 'unverified', 'a connection receipt alone is not a searchable index');
  semanticContext.semanticCurrent = true; assert.equal(semanticState(), 'available');
  semanticContext.semanticIdentity = 'identity-after-key-change'; assert.equal(semanticState(), 'unverified');
  semanticContext.documentId = 'other-doc'; assert.equal(capabilities.snapshot(semanticContext).capabilities.find(item => item.id === 'materialFullText').state, 'unconfigured');
  console.log('capabilities: configured vs verified, configuration binding, private receipts, persistent PDF authorization and changed-source zero-upload passed');
} finally { assert.ok(root.startsWith(path.join(os.tmpdir(), 'trellora-capabilities-'))); rmSync(root, { recursive: true, force: true }); }
