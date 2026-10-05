import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-assistant');
const turnFile = path.join(outDir, 'turn.cjs');
const typesFile = path.join(outDir, 'types.cjs');
const policyFile = path.join(outDir, 'policy.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const lexicalIndexFile = path.join(outDir, 'lexical-index.cjs');
const toolsFile = path.join(outDir, 'tools.cjs');
const capsuleFile = path.join(outDir, 'capsule.cjs');
const contextBudgetFile = path.join(outDir, 'context-budget.cjs');
const promptFile = path.join(outDir, 'prompt.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantTurn.ts')], outfile: turnFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantTurnTypes.ts')], outfile: typesFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNotePolicy.ts')], outfile: policyFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteLexicalIndex.ts')], outfile: lexicalIndexFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteTools.ts')], outfile: toolsFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteCapsule.ts')], outfile: capsuleFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteContextBudget.ts')], outfile: contextBudgetFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNotePrompt.ts')], outfile: promptFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { createKnowledgeAnswerPrompt } = await import(pathToFileURL(turnFile).href);
const { agentStopReasons, currentNoteContextModes, validateAssistantTurnRequest } = await import(pathToFileURL(typesFile).href);
const { DEFAULT_STRICT_SMALL_NOTE_POLICY, assertStrictSmallNoteAllowed, evaluateStrictSmallNotePolicy } = await import(pathToFileURL(policyFile).href);
const { CurrentNoteSnapshotCache, createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { CurrentNoteLexicalIndex } = await import(pathToFileURL(lexicalIndexFile).href);
const { createCurrentNoteTools, readCurrentNoteRange } = await import(pathToFileURL(toolsFile).href);
const { createNoteCapsule, serializeNoteCapsule } = await import(pathToFileURL(capsuleFile).href);
const { ContextBudgetManager } = await import(pathToFileURL(contextBudgetFile).href);
const { createCurrentNotePrompt } = await import(pathToFileURL(promptFile).href);

// This fixture deliberately places the only supporting fact past the legacy
// source cap. It documents the defect P1 must route around, rather than hiding
// it by silently increasing a generic prompt limit.
const longPrefix = '开头内容。'.repeat(900);
const tailEvidence = '尾部唯一证据：当前笔记的后半部分必须可以被检索到。';
const longCurrentNote = `${longPrefix}\n${tailEvidence}`;
assert.ok(longCurrentNote.indexOf(tailEvidence) > 4_000, 'fixture evidence must start beyond the legacy source cap');
const legacyPrompt = createKnowledgeAnswerPrompt('尾部有什么证据？', [], [{ title: '长笔记夹具', content: longCurrentNote }]);
assert.match(legacyPrompt, /开头内容/);
assert.doesNotMatch(legacyPrompt, /尾部唯一证据/);

const validCurrentNoteRequest = validateAssistantTurnRequest({
  requestId: 'current_note_p0_0001',
  intent: 'ask',
  scope: 'current-note',
  userText: '验证当前笔记边界',
  currentNotePath: 'C:/Notes/current.md',
  conversation: [],
});
assert.equal(validCurrentNoteRequest.scope, 'current-note');
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...validCurrentNoteRequest, currentNotePath: undefined }),
  /请先选择当前笔记/,
);
assert.deepEqual(currentNoteContextModes, ['direct-full', 'memory-reuse', 'react-search', 'structured-summary']);
assert.ok(agentStopReasons.includes('max-model-calls'));
assert.ok(agentStopReasons.includes('snapshot-stale'));

assert.deepEqual(DEFAULT_STRICT_SMALL_NOTE_POLICY, {
  maxCharacters: 1_200,
  maxLines: 30,
  maxTokens: 1_600,
  maxContextRatio: 0.08,
});
const largeNoteDecision = evaluateStrictSmallNotePolicy(
  { characters: 1_201, lineCount: 31, tokenEstimate: 1_601 },
  // A huge provider context and output allowance cannot promote a large note.
  { contextWindowTokens: 1_000_000, hasOutputAndHistoryReserve: true },
);
assert.equal(largeNoteDecision.allowed, false);
assert.deepEqual(largeNoteDecision.rejections, ['max-characters', 'max-lines', 'max-tokens']);
assert.throws(
  () => assertStrictSmallNoteAllowed(
    { characters: 1_201, lineCount: 31, tokenEstimate: 1_601 },
    { contextWindowTokens: 1_000_000, hasOutputAndHistoryReserve: true },
  ),
  /全文直读硬门槛/,
);
assert.equal(evaluateStrictSmallNotePolicy(
  { characters: 1_200, lineCount: 30, tokenEstimate: 1_600 },
  { contextWindowTokens: 20_000, hasOutputAndHistoryReserve: true },
).allowed, true);
assert.equal(evaluateStrictSmallNotePolicy(
  { characters: 1_200, lineCount: 30, tokenEstimate: 1_600 },
  { contextWindowTokens: 20_000, hasOutputAndHistoryReserve: false },
).allowed, false);

const fixtureMarkdown = `---
title: 当前笔记夹具
---

# 总览

当前笔记前言。

## 缓存策略

缓存策略要求稳定前缀，不能把长笔记全文放入模型。

~~~ts
const contentHash = createHash('sha256').update(markdown).digest('hex');
~~~

| 规则 | 结果 |
| --- | --- |
| 当前笔记 | 仅词法检索 |

> 引用窗口必须保留原始行号。

- 清单项 A
- 清单项 B

## 尾部证据

尾部唯一结论：块级索引必须检索到文档末尾。
`;
const fixtureHash = (await import('node:crypto')).createHash('sha256').update(fixtureMarkdown, 'utf8').digest('hex');
const fixtureHeadings = [
  { id: 'overview', level: 1, text: '总览', line: 5 },
  { id: 'cache', level: 2, text: '缓存策略', line: 9 },
  { id: 'tail', level: 2, text: '尾部证据', line: 26 },
];
const snapshotInput = {
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/architecture/current.md',
  title: '当前笔记夹具',
  contentHash: fixtureHash,
  markdown: fixtureMarkdown,
  headings: fixtureHeadings,
  revision: 7,
  createdAt: '2026-08-21T00:00:00.000Z',
};
const snapshot = createCurrentNoteSnapshot(snapshotInput);
assert.equal(snapshot.relativePath, 'architecture/current.md');
assert.equal(snapshot.lineCount, 29);
assert.deepEqual(snapshot.headings.find((heading) => heading.headingId === 'cache')?.path, ['总览', '缓存策略']);
assert.equal(snapshot.headings.find((heading) => heading.headingId === 'cache')?.lineTo, 25);
assert.ok(snapshot.blocks.some((block) => block.kind === 'code' && block.text.includes('contentHash')));
assert.ok(snapshot.blocks.some((block) => block.kind === 'table' && block.text.includes('| 当前笔记 |')));
assert.ok(snapshot.blocks.some((block) => block.kind === 'quote' && block.text.startsWith('> 引用窗口')));
assert.ok(snapshot.blocks.some((block) => block.kind === 'list' && block.text.includes('- 清单项 B')));
assert.ok(snapshot.blocks.every((block) => block.blockId.startsWith('block-') && block.blockHash.length === 64));
assert.throws(
  () => createCurrentNoteSnapshot({ ...snapshotInput, contentHash: '0'.repeat(64) }),
  /内容已变化/,
);
const snapshotCache = new CurrentNoteSnapshotCache(2);
const firstCachedSnapshot = snapshotCache.getOrCreate(snapshotInput);
assert.equal(snapshotCache.getOrCreate(snapshotInput), firstCachedSnapshot);
const changedMarkdown = `${fixtureMarkdown}\n新增内容。`;
const changedHash = (await import('node:crypto')).createHash('sha256').update(changedMarkdown, 'utf8').digest('hex');
const changedSnapshot = snapshotCache.getOrCreate({ ...snapshotInput, markdown: changedMarkdown, contentHash: changedHash });
assert.notEqual(changedSnapshot.snapshotId, firstCachedSnapshot.snapshotId);
assert.equal(snapshotCache.size, 2);
snapshotCache.invalidateNote(snapshotInput.notePath);
assert.equal(snapshotCache.size, 0);

const lexicalIndex = new CurrentNoteLexicalIndex(snapshot);
const tailHits = lexicalIndex.search('尾部唯一结论');
assert.ok(tailHits.some((hit) => hit.headingPath.at(-1) === '尾部证据' && hit.matchTypes.includes('exact')));
const identifierHits = lexicalIndex.search('contentHash');
assert.ok(identifierHits.some((hit) => hit.matchTypes.includes('identifier') && hit.snippet.includes('contentHash')));

const tools = createCurrentNoteTools(snapshot);
const noteMap = tools.getNoteMap('stats');
assert.equal(noteMap.headings.length, 3);
assert.equal(noteMap.structureCounts?.code, 1);
assert.equal(noteMap.structureCounts?.table, 1);
assert.ok(tools.searchNote(['尾部证据']).some((hit) => hit.lineFrom >= 26));
const codeRead = tools.readNoteRange({ lineFrom: 14, lineTo: 14 });
assert.match(codeRead.text, /^~~~ts\nconst contentHash/m);
assert.match(codeRead.text, /~~~$/m);
const nestedHeadingRead = tools.readNoteRange({ lineFrom: 25, lineTo: 25 });
assert.deepEqual(nestedHeadingRead.headingPath, ['总览', '缓存策略']);
assert.ok(tools.getNoteMap('terms').topTerms?.includes('缓存'));
assert.throws(() => tools.searchNote(['x']), /每个搜索词必须在 2 到 80/);
assert.throws(() => readCurrentNoteRange(snapshot, { lineFrom: 1, lineTo: 201 }), /读取行范围无效|单次最多读取/);

const smallMarkdown = `# 短笔记

这里是可全文发送的短笔记，包含 #缓存 和 [[相关笔记]]。

结论：稳定前缀可复用。`;
const smallHash = (await import('node:crypto')).createHash('sha256').update(smallMarkdown, 'utf8').digest('hex');
const smallSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/short.md',
  title: '短笔记',
  contentHash: smallHash,
  markdown: smallMarkdown,
  headings: [{ id: 'short', level: 1, text: '短笔记', line: 1 }],
  revision: 8,
  createdAt: '2026-08-21T00:00:00.000Z',
});
const directPrompt = createCurrentNotePrompt({
  snapshot: smallSnapshot,
  question: '结论是什么？',
  conversation: [{ role: 'user', content: '先前问题' }],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
});
const repeatedDirectPrompt = createCurrentNotePrompt({
  snapshot: smallSnapshot,
  question: '换一个问题会改变稳定前缀吗？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
});
const detailedDirectPrompt = createCurrentNotePrompt({
  snapshot: smallSnapshot,
  question: '请详细说明结论。',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
  answerDepth: 'detailed',
});
assert.equal(directPrompt.contextMode, 'direct-full');
assert.match(directPrompt.stablePrefix, /这里是可全文发送的短笔记/);
assert.equal(directPrompt.stablePrefix, repeatedDirectPrompt.stablePrefix);
assert.equal(directPrompt.prefixFingerprint, repeatedDirectPrompt.prefixFingerprint);
assert.equal(detailedDirectPrompt.prefixFingerprint, directPrompt.prefixFingerprint, '回答深度属于动态约束，不应破坏稳定前缀缓存');
assert.match(detailedDirectPrompt.prompt, /回答深度：详细/u);
assert.match(detailedDirectPrompt.prompt, /原理、关键步骤、示例、适用边界/u);
assert.ok(directPrompt.prompt.indexOf('[Zone A') < directPrompt.prompt.indexOf('[Zone B'));
assert.ok(directPrompt.prompt.indexOf('[Zone B') < directPrompt.prompt.indexOf('[Zone C'));
assert.ok(directPrompt.prompt.indexOf('[Zone C') < directPrompt.prompt.indexOf('[Zone D'));

const longMarkdown = `# 长笔记

${Array.from({ length: 80 }, () => '核心术语反复出现，用于确认 Capsule 只保留结构和高频词。').join('\n\n')}

SHOULD_NOT_BE_THE_FULL_NOTE_BODY`;
const longHash = (await import('node:crypto')).createHash('sha256').update(longMarkdown, 'utf8').digest('hex');
const longSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/long.md',
  title: '长笔记',
  contentHash: longHash,
  markdown: longMarkdown,
  headings: [{ id: 'long', level: 1, text: '长笔记', line: 1 }],
  revision: 9,
  createdAt: '2026-08-21T00:00:00.000Z',
});
const longPrompt = createCurrentNotePrompt({
  snapshot: longSnapshot,
  question: '长笔记里有什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 1_000_000,
});
assert.equal(longPrompt.contextMode, 'react-search');
assert.equal(longPrompt.strictSmallNote.allowed, false);
assert.ok(longPrompt.strictSmallNote.rejections.includes('max-characters'));
assert.doesNotMatch(longPrompt.stablePrefix, /SHOULD_NOT_BE_THE_FULL_NOTE_BODY/);
assert.deepEqual(createNoteCapsule(longSnapshot), createNoteCapsule(longSnapshot));
assert.equal(serializeNoteCapsule(createNoteCapsule(longSnapshot)), serializeNoteCapsule(createNoteCapsule(longSnapshot)));
const changedLongMarkdown = `${longMarkdown}\n内容发生变化。`;
const changedLongHash = (await import('node:crypto')).createHash('sha256').update(changedLongMarkdown, 'utf8').digest('hex');
const changedLongSnapshot = createCurrentNoteSnapshot({ ...{
  libraryPath: 'C:/Notes', notePath: 'C:/Notes/long.md', title: '长笔记', headings: [{ id: 'long', level: 1, text: '长笔记', line: 1 }], revision: 10, createdAt: '2026-08-21T00:00:00.000Z',
}, contentHash: changedLongHash, markdown: changedLongMarkdown });
const changedLongPrompt = createCurrentNotePrompt({ ...{
  question: '长笔记里有什么？', conversation: [], providerKind: 'ollama', model: 'qwen3', contextWindowTokens: 1_000_000,
}, snapshot: changedLongSnapshot });
assert.notEqual(longPrompt.prefixFingerprint, changedLongPrompt.prefixFingerprint);
const unknownWindowPrompt = createCurrentNotePrompt({
  snapshot: smallSnapshot,
  question: '未知窗口时会发送全文吗？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
});
assert.equal(unknownWindowPrompt.contextMode, 'react-search');
assert.doesNotMatch(unknownWindowPrompt.stablePrefix, /这里是可全文发送的短笔记/);
const constrainedBudget = new ContextBudgetManager({ contextWindowTokens: 4_000, reservedOutputTokens: 1_200, reservedHistoryTokens: 800, reservedDynamicTokens: 400 });
assert.equal(constrainedBudget.assessStablePrefix(1_600).fits, true);
assert.equal(constrainedBudget.assessStablePrefix(1_601).fits, false);
assert.equal(constrainedBudget.assessPrompt(2_800).fits, true);
assert.equal(constrainedBudget.assessPrompt(2_801).fits, false);

const appSource = await fs.readFile(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
const mainSource = await fs.readFile(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const generationTransportSource = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'aiGenerationTransport.ts'), 'utf8');
const openAiCompletionsSource = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'openAiCompletionsTransport.ts'), 'utf8');
const tokenEstimatorSource = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'tokenEstimator.ts'), 'utf8');
const assistantTypeSource = await fs.readFile(path.join(rootDir, 'electron', 'knowledge', 'assistantTurnTypes.ts'), 'utf8');
assert.match(assistantTypeSource, /export interface AssistantEvidenceCitation/);
assert.match(assistantTypeSource, /evidence\?: AssistantEvidenceCitation\[\]/);
assert.match(appSource, /request\.scope === 'current-note'[\s\S]{0,360}await flushPendingSave\(\)[\s\S]{0,240}currentNotePath: currentPathRef\.current/);
assert.match(mainSource, /ipcMain\.handle\('cancel-assistant-turn',[\s\S]{0,500}controller\.abort\(\)/);
const snapshotCreationOffset = mainSource.indexOf('const currentNoteSnapshot =');
const promptCreationOffset = mainSource.indexOf('const currentNotePrompt =');
assert.ok(
  snapshotCreationOffset >= 0 && promptCreationOffset > snapshotCreationOffset,
  'current-note prompt must use the frozen snapshot',
);
assert.match(mainSource, /createCurrentNoteSnapshotFromIndexedNote\(/);
assert.match(mainSource, /createCurrentNotePrompt\(/);
assert.match(mainSource, /contextMode: generationPrompt\.contextMode,[\s\S]{0,180}prefixFingerprint: generationPrompt\.prefixFingerprint/);
assert.match(mainSource, /generationPrompt = createCurrentNotePrompt\(\{/);
assert.match(generationTransportSource, /if \(!config\.remoteContentConsent\) throw new Error\('请先在设置中确认远程发送范围。'\)/);
assert.match(openAiCompletionsSource, /cached_input_tokens/);
assert.match(openAiCompletionsSource, /cachedInputTokens/);
assert.match(tokenEstimatorSource, /cachedInputTokens/);

const knowledgeDir = path.join(rootDir, 'electron', 'knowledge');
const currentNoteModules = (await fs.readdir(knowledgeDir))
  .filter((name) => /^currentNote.*\.ts$/u.test(name))
  .sort();
assert.ok(currentNoteModules.length > 0, 'current-note implementation modules must remain discoverable for the boundary check');
const forbiddenVectorTokens = ['searchEmbeddedSemantically', 'sqlite-vec', 'sqliteVec', 'embeddingModel'];
for (const moduleName of currentNoteModules) {
  const source = await fs.readFile(path.join(knowledgeDir, moduleName), 'utf8');
  for (const token of forbiddenVectorTokens) {
    assert.equal(source.includes(token), false, `${moduleName} must not depend on ${token}`);
  }
}

console.log('Current-note assistant P0/P1/P2 verification passed');
