import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.package-staging', 'verify-library-section-performance');
const snapshotBundle = path.join(stagingDir, 'currentNoteSnapshot.cjs');
const toolsBundle = path.join(stagingDir, 'libraryNoteTools.cjs');
const budgetBundle = path.join(stagingDir, 'currentNoteAgentGraph.cjs');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'libraryNoteTools.ts')], outfile: toolsBundle, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: budgetBundle, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotBundle).href);
const { createLibraryNoteTools } = await import(pathToFileURL(toolsBundle).href);
const { DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(budgetBundle).href);

const sectionCount = 500;
const queryTermCount = 40;
const markdown = Array.from({ length: sectionCount }, (_, index) => {
  const ordinal = index + 1;
  const term = ordinal <= queryTermCount ? `term${String(ordinal).padStart(2, '0')}` : `background${String(ordinal).padStart(3, '0')}`;
  return `# Section ${String(ordinal).padStart(3, '0')}\n\n${term} corpus.`;
}).join('\n\n');
const snapshot = createCurrentNoteSnapshot({
  libraryPath: stagingDir,
  notePath: path.join(stagingDir, 'performance-500-sections.md'),
  title: 'Performance 500 Sections',
  contentHash: sha256(markdown),
  markdown,
  headings: collectHeadings(markdown),
  revision: 1,
  createdAt: '2026-08-27T00:00:00.000Z',
});
const noteId = 'note-performance-500-sections';
const snapshotMap = createSnapshotMap(noteId, snapshot);
const queryTerms = Array.from({ length: queryTermCount }, (_, index) => ({ term: `term${String(index + 1).padStart(2, '0')}`, source: 'planner' }));

// Warm the JavaScript engine only. The measured tools instance still has an empty Ranker/result cache.
createLibraryNoteTools(snapshotMap, snapshotMap.sessionId).rankRelatedSections(noteId, queryTerms);
const coldTools = createLibraryNoteTools(snapshotMap, snapshotMap.sessionId);
const coldStartedAt = performance.now();
const firstResult = coldTools.rankRelatedSections(noteId, queryTerms);
const coldElapsedMs = performance.now() - coldStartedAt;
assert.equal(firstResult.evaluatedSectionCount, sectionCount);
assert.equal(firstResult.processedQueryTermCount, queryTermCount);
assert.equal(firstResult.queryTermBatchCount, 5);

const cachedTools = createLibraryNoteTools(snapshotMap, snapshotMap.sessionId);
const coldCachedResult = cachedTools.rankRelatedSections(noteId, queryTerms);
const hotSamplesMs = [];
for (let index = 0; index < 100; index += 1) {
  const startedAt = performance.now();
  const hotResult = cachedTools.rankRelatedSections(noteId, queryTerms);
  hotSamplesMs.push(performance.now() - startedAt);
  assert.equal(hotResult, coldCachedResult, '相同 snapshot/query fingerprint 必须复用同一缓存结果');
}

const hotP95Ms = percentile(hotSamplesMs, 0.95);
const previewCharacters = firstResult.topSections.reduce((sum, section) => sum + section.preview.length, 0);
assert.ok(coldElapsedMs <= 100, `500 章节冷构建 + 排序超过 100ms：${coldElapsedMs.toFixed(3)}ms`);
assert.ok(hotP95Ms <= 20, `热缓存 p95 超过 20ms：${hotP95Ms.toFixed(3)}ms`);
assert.ok(previewCharacters <= 720, `Top 3 preview 超过 720 字符：${previewCharacters}`);
assert.equal(DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls, 10);
assert.equal(DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxSingleObservationChars, 12_000);
assert.equal(DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars, 72_000);

console.log(JSON.stringify({
  verifier: 'library-section-performance-v1',
  corpus: { sectionCount, queryTermCount, markdownCharacters: markdown.length },
  cold: { samples: 1, elapsedMs: Number(coldElapsedMs.toFixed(3)), cacheState: 'miss', engineWarmupExcluded: true },
  hotCache: summarize(hotSamplesMs),
  top3PreviewCharacters: previewCharacters,
  budgets: {
    maxToolCalls: DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxToolCalls,
    maxSingleObservationChars: DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxSingleObservationChars,
    maxRawEvidenceChars: DEFAULT_CURRENT_NOTE_AGENT_BUDGET.maxRawEvidenceChars,
  },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
}, null, 2));
console.log('Library section performance verification passed');

function createSnapshotMap(currentNoteId, currentSnapshot) {
  const descriptor = {
    schemaVersion: 1,
    libraryId: currentSnapshot.libraryId,
    noteId: currentNoteId,
    snapshotId: currentSnapshot.snapshotId,
    title: currentSnapshot.title,
    contentHash: currentSnapshot.contentHash,
    revision: currentSnapshot.revision,
    lineCount: currentSnapshot.lineCount,
    headings: currentSnapshot.headings.map((heading) => ({ headingId: heading.headingId, path: [...heading.path], lineFrom: heading.lineFrom, lineTo: heading.lineTo })),
    topTerms: [],
  };
  return {
    libraryId: currentSnapshot.libraryId,
    sessionId: 'session-performance-stage5',
    revision: currentSnapshot.revision,
    indexState: 'latest',
    notes: [descriptor],
    records: new Map([[currentNoteId, { ...descriptor, localSnapshot: currentSnapshot }]]),
  };
}

function collectHeadings(value) {
  return value.split(/\r\n|\r|\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (!match) return [];
    return [{ id: `performance-heading-${String(index + 1).padStart(4, '0')}`, level: match[1].length, text: match[2].trim(), line: index + 1 }];
  });
}

function summarize(samples) {
  return {
    samples: samples.length,
    averageMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((first, second) => first - second);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
