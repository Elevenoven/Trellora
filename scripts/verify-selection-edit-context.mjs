import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-context-bundle.cjs');
const snapshotBundlePath = path.join(rootDir, 'scripts', '.verify-selection-edit-context-snapshot-bundle.cjs');

try {
  await Promise.all([fs.rm(bundlePath, { force: true }), fs.rm(snapshotBundlePath, { force: true })]);
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditSources', 'currentNoteSource.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')],
      outfile: snapshotBundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
  ]);
  const { collectSelectionEditCurrentNoteContext } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const { createCurrentNoteSnapshot } = await import(`${pathToFileURL(snapshotBundlePath).href}?v=${Date.now()}`);

  const smallSnapshot = createSnapshot(createCurrentNoteSnapshot, [
    '# 小笔记',
    '',
    '选区对象：恢复窗口。',
    '',
    '恢复窗口用于说明一次自动恢复的等待时间。',
  ].join('\n'));
  const direct = collectSelectionEditCurrentNoteContext({
    snapshot: smallSnapshot,
    selectedText: '选区对象：恢复窗口。',
    goals: [{ goalId: 'goal-1', question: '恢复窗口的作用是什么？', queryTerms: ['恢复窗口'] }],
    capacity: { contextWindowTokens: 32_000, hasOutputAndHistoryReserve: true },
  });
  assert.equal(direct.receipt.fullNoteMode, 'strict-direct', 'known capacity may permit only a strict small note full read');
  assert.equal(direct.receipt.noteMap.read, true, 'the adapter must still obtain a structural map for the receipt');
  assert.equal(direct.evidence.length, 1, 'strict direct mode must admit one verified full-note record');
  assert.equal(direct.evidence[0].content, smallSnapshot.markdown, 'full-note evidence must be the immutable snapshot original');
  assert.equal(direct.evidence[0].readVerified, true);

  const unknownCapacity = collectSelectionEditCurrentNoteContext({
    snapshot: smallSnapshot,
    selectedText: '选区对象：恢复窗口。',
    goals: [{ goalId: 'goal-1', question: '恢复窗口的作用是什么？', queryTerms: ['恢复窗口'] }],
    capacity: { hasOutputAndHistoryReserve: true },
  });
  assert.equal(unknownCapacity.receipt.fullNoteMode, 'map-and-read', 'an unknown context window must never authorize direct full-note mode');
  assert.ok(unknownCapacity.receipt.strictSmallNote.rejections.includes('context-ratio'));
  assert.ok(unknownCapacity.receipt.candidateSearches.length > 0, 'non-direct mode must use paged candidate search');
  assert.ok(unknownCapacity.evidence.every((item) => item.readVerified), 'search candidates must become evidence only after raw materialization');

  const longSnapshot = createSnapshot(createCurrentNoteSnapshot, [
    '# 长笔记',
    '',
    '选区对象：请补充恢复窗口的解释。',
    '',
    '## 背景',
    '',
    '背景资料。'.repeat(320),
    '',
    '## 恢复策略',
    '',
    '恢复窗口规定第一次自动重试前等待 7 秒，第二次自动重试前等待 31 秒。',
    '',
    '## 其他说明',
    '',
    '这段文字不会作为恢复窗口的证据。',
  ].join('\n'));
  const searched = collectSelectionEditCurrentNoteContext({
    snapshot: longSnapshot,
    selectedText: '选区对象：请补充恢复窗口的解释。',
    goals: [{ goalId: 'goal-window', question: '恢复窗口有哪些等待规则？', queryTerms: ['恢复窗口', '自动重试'] }],
    capacity: { contextWindowTokens: 32_000, hasOutputAndHistoryReserve: true },
  });
  assert.equal(searched.receipt.fullNoteMode, 'map-and-read', 'a long note must never bypass map/search/read');
  assert.ok(searched.receipt.strictSmallNote.rejections.includes('max-characters'));
  assert.equal(searched.receipt.candidateSearches[0].candidateExhausted, true, 'the actual first page state must be recorded');
  assert.ok(searched.evidence.some((item) => item.content.includes('第一次自动重试前等待 7 秒')), 'only materialized source text may enter evidence');
  assert.ok(searched.receipt.used.every((item) => /^当前笔记 L\d+-L\d+$/u.test(item.locator)), 'receipt locators must be stable snapshot line ranges');
  assert.ok(searched.receipt.evidenceTokens <= searched.receipt.evidenceTokenBudget, 'deep-read evidence must remain within the source token budget');

  const overflow = collectSelectionEditCurrentNoteContext({
    snapshot: longSnapshot,
    selectedText: '选区对象：请补充恢复窗口的解释。',
    goals: [{ goalId: 'goal-window', question: '恢复窗口有哪些等待规则？', queryTerms: ['恢复窗口'] }],
    capacity: { contextWindowTokens: 32_000, hasOutputAndHistoryReserve: true },
    limits: { maxEvidenceCharacters: 1 },
  });
  assert.equal(overflow.receipt.evidenceCharacters, 0, 'a materialized block exceeding the evidence ceiling must not enter the ledger');
  assert.equal(overflow.evidence.length, 0);

  let currentChecks = 0;
  assert.throws(() => collectSelectionEditCurrentNoteContext({
    snapshot: longSnapshot,
    selectedText: '选区对象：请补充恢复窗口的解释。',
    goals: [{ goalId: 'goal-window', question: '恢复窗口有哪些等待规则？', queryTerms: ['恢复窗口'] }],
    capacity: { contextWindowTokens: 32_000, hasOutputAndHistoryReserve: true },
    isSnapshotCurrent: () => ++currentChecks < 2,
  }), /当前笔记内容已变化/u, 'a changed source hash must stop the context read before evidence admission');

  console.log('Selection edit current-note context verification passed');
} finally {
  await Promise.all([fs.rm(bundlePath, { force: true }), fs.rm(snapshotBundlePath, { force: true })]);
}

function createSnapshot(factory, markdown) {
  const hash = createHash('sha256').update(markdown, 'utf8').digest('hex');
  const headings = markdown.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    return match ? [{ id: `heading-${index + 1}`, level: match[1].length, text: match[2].trim(), line: index + 1 }] : [];
  });
  return factory({
    libraryPath: 'C:/fixture',
    notePath: 'C:/fixture/note.md',
    title: 'Fixture',
    contentHash: hash,
    markdown,
    headings,
    revision: 1,
    createdAt: '2026-09-09T00:00:00.000Z',
  });
}
