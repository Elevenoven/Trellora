import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const staging = path.resolve('.package-staging'); mkdirSync(staging, { recursive: true }); const root = mkdtempSync(path.join(staging, 'release-check-'));
try {
  const file = path.join(root, 'check.mjs'); await build({ entryPoints: ['electron/releaseCheck.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file });
  const { compareVersions, ReleaseChecker } = await import(pathToFileURL(file).href);
  assert.equal(compareVersions('v1.10.0', '1.9.0'), 1); assert.equal(compareVersions('1.0.0', '1.0.0-beta.10'), 1); assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1); assert.equal(compareVersions('garbage', '1.0.0'), undefined);
  let calls = 0; const metadata = { tag_name: 'v1.10.0', draft: false, prerelease: false, html_url: 'https://github.com/Elevenoven/Trellora-plus/releases/tag/v1.10.0' };
  const checker = new ReleaseChecker({ repositoryUrl: 'https://github.com/Elevenoven/Trellora-plus', version: '1.9.0', fetch: async (_url, options) => { calls++; assert.ok(options.signal); assert.equal(Object.hasOwn(options.headers, 'Authorization'), false); return Response.json(metadata); } });
  const results = await Promise.all([checker.check(), checker.check()]); assert.equal(calls, 1); assert.equal(results[0].state, 'available'); assert.equal((await checker.check()).cached, true); assert.equal(calls, 1);
  for (const [response, code] of [[new Response('', { status: 404 }), 'NO_RELEASE'], [new Response('', { status: 429 }), 'RATE_LIMITED'], [Response.json({ ...metadata, prerelease: true }), 'INVALID_RELEASE'], [Response.json({ ...metadata, html_url: 'https://evil.example/download' }), 'INVALID_RELEASE'], [new Response('x'.repeat(1024 ** 2 + 1)), 'INVALID_RELEASE']]) {
    const failed = await new ReleaseChecker({ repositoryUrl: 'https://github.com/Elevenoven/Trellora-plus', version: '1.0.0', fetch: async () => response }).check(); assert.equal(failed.code, code);
  }
  const offline = await new ReleaseChecker({ repositoryUrl: 'https://github.com/Elevenoven/Trellora-plus', version: '1.0.0', fetch: async () => { throw new Error('offline'); } }).check(); assert.equal(offline.code, 'NETWORK_ERROR');
  console.log('release checks: semantic versions, stable-only metadata, concurrency/cache, no release, rate limit, offline, foreign URL and bounded response passed');
} finally { assert.ok(root.startsWith(staging + path.sep + 'release-check-')); rmSync(root, { recursive: true, force: true }); }
