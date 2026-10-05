import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-current-note-search-coverage');
const coverageFile = path.join(outDir, 'coverage.cjs');
const snapshotFile = path.join(outDir, 'snapshot.cjs');
const toolsFile = path.join(outDir, 'tools.cjs');
const evidenceFile = path.join(outDir, 'evidence.cjs');
const graphFile = path.join(outDir, 'graph.cjs');
const memoryFile = path.join(outDir, 'memory.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSearchCoverage.ts')], outfile: coverageFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteTools.ts')], outfile: toolsFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteEvidenceLedger.ts')], outfile: evidenceFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteAgentGraph.ts')], outfile: graphFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteConversationMemory.ts')], outfile: memoryFile, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { CurrentNoteSearchCoverageLedger } = await import(pathToFileURL(coverageFile).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotFile).href);
const { createCurrentNoteTools } = await import(pathToFileURL(toolsFile).href);
const { CurrentNoteEvidenceLedger } = await import(pathToFileURL(evidenceFile).href);
const { runCurrentNoteAgent, DEFAULT_CURRENT_NOTE_AGENT_BUDGET } = await import(pathToFileURL(graphFile).href);
const { NoteConversationMemory } = await import(pathToFileURL(memoryFile).href);

const markdown = `# NER 总览\n\nNER 是一种命名实体识别方法。\n\n## NER 定义\n\n定义方面：NER 从文本中识别人名、组织和地点。\n\n## NER 模型分类\n\n模型分类方面：规则、统计和神经网络模型各有取舍。\n\n## NER 评估\n\n评估方面：使用精确率、召回率和 F1。`;
const headings = collectHeadings(markdown);
const snapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/coverage.md',
  title: 'Coverage Ledger 夹具',
  contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  markdown,
  headings,
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
});
const tools = createCurrentNoteTools(snapshot);
const focusedScope = { mode: 'focused', coveragePolicy: 'sufficient', targetTopic: 'NER', targetAspects: ['定义'], origin: 'controller-fallback', confidence: 'low' };
const focused = new CurrentNoteSearchCoverageLedger(snapshot, focusedScope);
const focusedHits = tools.searchNote(['NER', '定义'], 8, focusedScope);
focused.recordSearch(undefined, focusedHits, 8);
assert.equal(focused.toModelSummary().status, 'insufficient', '只导航命中不能完成目标');
focused.recordSearch(undefined, focusedHits, 8, {
  candidateExhausted: false,
  nextCursor: 'coverage-next-page',
  plannedQueryTerms: ['NER', '定义'],
  executedQueryTerms: ['NER', '定义'],
});
const evidenceLedger = new CurrentNoteEvidenceLedger(snapshot, 24_000);
const definitionRange = tools.readNoteRange({ lineFrom: snapshot.headings[1].lineFrom, lineTo: snapshot.headings[1].lineTo });
const definitionEvidence = evidenceLedger.add({
  blockIds: definitionRange.blockIds,
  headingPath: definitionRange.headingPath,
  lineFrom: definitionRange.lineFrom,
  lineTo: definitionRange.lineTo,
  text: definitionRange.text,
  matchedTerms: ['NER'],
  supports: ['NER 定义'],
  sourceToolCallId: 'gate-read-1',
}).record;
focused.recordRead(undefined, { ...definitionEvidence, evidenceId: definitionEvidence.evidenceId });
assert.equal(focused.toModelSummary().status, 'complete', 'focused 读取原文证据后应可停止');
assert.equal(focused.toModelSummary().candidateTruncated, true, 'P7-03 sufficient 允许候选未遍历完时进入合成');
assert.match(focused.toModelSummary().reason, /进入合成的前提/u, 'Coverage complete 不得描述成最终答案已验证');
const focusedBeforeDuplicate = focused.toModelSummary().readHeadingCount;
focused.recordRead(undefined, { ...definitionEvidence, evidenceId: definitionEvidence.evidenceId });
assert.equal(focused.toModelSummary().readHeadingCount, focusedBeforeDuplicate, '重复读取不增加 distinct 章节覆盖');
assert.equal(focused.toModelSummary().evidenceCount, 1, '重复 evidenceId 不增加证据计数');

const nestedMarkdown = '# 父章节\n\n父级说明。\n\n## 子章节\n\nNER 子章节原文。\n\n## 兄弟章节\n\n其他原文。';
const nestedSnapshot = createCurrentNoteSnapshot({
  libraryPath: 'C:/Notes',
  notePath: 'C:/Notes/nested-coverage.md',
  title: 'Coverage 父子章节夹具',
  contentHash: createHash('sha256').update(nestedMarkdown, 'utf8').digest('hex'),
  markdown: nestedMarkdown,
  headings: collectHeadings(nestedMarkdown),
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
});
const nestedParent = nestedSnapshot.headings.find((heading) => heading.text === '父章节');
const nestedChild = nestedSnapshot.headings.find((heading) => heading.text === '子章节');
const nestedSibling = nestedSnapshot.headings.find((heading) => heading.text === '兄弟章节');
assert.ok(nestedParent && nestedChild && nestedSibling);
const nestedTools = createCurrentNoteTools(nestedSnapshot);
const explicitChildCoverage = new CurrentNoteSearchCoverageLedger(nestedSnapshot, focusedScope);
explicitChildCoverage.recordRead('nested-explicit', {
  snapshotId: nestedSnapshot.snapshotId,
  evidenceId: 'evidence-555555555555555555555555',
  blockIds: nestedSnapshot.blocks.map((block) => block.blockId),
  headingPath: nestedChild.path,
  lineFrom: nestedChild.lineFrom + 1,
  lineTo: nestedChild.lineTo,
  text: 'NER 子章节原文。',
  headingId: nestedChild.headingId,
});
assert.equal(explicitChildCoverage.toModelSummary('nested-explicit').readHeadingCount, 1, '明确 headingId 只能计入该章节，不能重复计入父章节');
const lineDerivedCoverage = new CurrentNoteSearchCoverageLedger(nestedSnapshot, focusedScope);
lineDerivedCoverage.recordRead('nested-line', {
  snapshotId: nestedSnapshot.snapshotId,
  evidenceId: 'evidence-666666666666666666666666',
  blockIds: [],
  headingPath: nestedChild.path,
  lineFrom: nestedChild.lineFrom + 1,
  lineTo: nestedChild.lineTo,
  text: 'NER 子章节原文。',
});
assert.equal(lineDerivedCoverage.toModelSummary('nested-line').readHeadingCount, 1, '无 headingId 时按最小范围、最深层级章节归属');
const nestedTopicRange = nestedTools.readNoteRange({ lineFrom: nestedChild.lineFrom, lineTo: nestedSibling.lineTo });
const nestedTopicCoverage = new CurrentNoteSearchCoverageLedger(nestedSnapshot, { ...focusedScope, mode: 'topic-wide', coveragePolicy: 'aspect-complete' });
nestedTopicCoverage.recordRead('nested-topic', {
  ...nestedTopicRange,
  evidenceId: 'evidence-777777777777777777777777',
});
assert.equal(nestedTopicCoverage.toModelSummary('nested-topic').readHeadingCount, 2, 'topic-wide 跨两个真实章节时应保留两个 distinct 章节');

assert.throws(
  () => focused.recordRead(undefined, { snapshotId: 'snapshot-stale', evidenceId: 'evidence-333333333333333333333333', blockIds: [], headingPath: [], lineFrom: 1, lineTo: 1, text: 'stale' }),
  /不属于当前笔记快照/u,
  '跨快照覆盖写入必须被主进程拒绝',
);
assert.throws(
  () => focused.recordRead(undefined, { evidenceId: 'not-an-evidence-id', blockIds: [], headingPath: [], lineFrom: 1, lineTo: 1, text: 'invalid' }),
  /证据标识无效/u,
  '非法 evidenceId 不能写入 Coverage Ledger',
);

const multiAspectScope = { mode: 'focused', coveragePolicy: 'sufficient', targetTopic: 'NER', targetAspects: ['定义', '模型分类'], origin: 'controller-fallback', confidence: 'low' };
const multiAspect = new CurrentNoteSearchCoverageLedger(snapshot, multiAspectScope);
multiAspect.recordRead('goal-multi', { ...definitionEvidence, evidenceId: definitionEvidence.evidenceId });
const multiAspectSufficient = multiAspect.toModelSummary('goal-multi');
assert.equal(multiAspectSufficient.status, 'complete', 'sufficient 策略应允许已有原文证据直接进入合成');
assert.equal(multiAspectSufficient.targetAspectCount, 0, 'sufficient 策略中的方面只用于导航，不作为强制完成清单');
assert.deepEqual(multiAspectSufficient.remainingAspects, []);
const [multiAspectPersistence] = multiAspect.toPersistence();
assert.ok(multiAspectPersistence, 'goal coverage 应生成持久化投影');
assert.equal(multiAspectPersistence.targetAspectCount, multiAspectScope.targetAspects.length, '持久化数量必须与 Search Scope 保持一致');
assert.deepEqual(multiAspectPersistence.coveredAspects, ['定义']);
assert.deepEqual(multiAspectPersistence.missingAspects, ['模型分类']);
assert.equal(
  multiAspectPersistence.coveredAspects.length + multiAspectPersistence.missingAspects.length,
  multiAspectPersistence.targetAspectCount,
  '持久化 covered/missing 集合必须完整分割 Search Scope 方面',
);
const multiAspectNeedsMoreEvidence = multiAspect.toModelSummary('goal-multi', 2);
assert.equal(multiAspectNeedsMoreEvidence.status, 'partial', '关闭方面清单后仍应遵守最小原文证据数量');
assert.match(multiAspectNeedsMoreEvidence.reason, /数量尚未满足/u);
const classificationRange = tools.readNoteRange({ lineFrom: snapshot.headings[2].lineFrom, lineTo: snapshot.headings[2].lineTo });
multiAspect.recordRead('goal-multi', {
  evidenceId: 'evidence-444444444444444444444444',
  blockIds: classificationRange.blockIds,
  headingPath: classificationRange.headingPath,
  lineFrom: classificationRange.lineFrom,
  lineTo: classificationRange.lineTo,
  text: classificationRange.text,
});
const multiAspectComplete = multiAspect.toModelSummary('goal-multi', 2);
assert.equal(multiAspectComplete.remainingAspects.length, 0);
assert.equal(multiAspectComplete.status, 'complete');

const topicScope = { mode: 'topic-wide', coveragePolicy: 'aspect-complete', targetTopic: 'NER', targetAspects: ['定义', '模型分类'], origin: 'user-explicit', confidence: 'high' };
const topic = new CurrentNoteSearchCoverageLedger(snapshot, topicScope);
const topicHits = tools.searchNote(['NER'], 1, topicScope);
topic.recordSearch('goal-topic', topicHits, 1);
const topicRange = tools.readNoteRange({ lineFrom: snapshot.headings[1].lineFrom, lineTo: snapshot.headings[1].lineTo });
topic.recordRead('goal-topic', { evidenceId: 'evidence-111111111111111111111111', blockIds: topicRange.blockIds, headingPath: topicRange.headingPath, lineFrom: topicRange.lineFrom, lineTo: topicRange.lineTo, text: topicRange.text });
const topicPartial = topic.toModelSummary('goal-topic');
assert.equal(topicPartial.status, 'partial', 'topic-wide 命中上限或只读一章不能 complete');
assert.equal(topicPartial.candidateTruncated, true, '达到 search limit 必须标记 candidateTruncated');
assert.ok(topicPartial.remainingAspects.includes('模型分类'));

const occurrenceScope = { mode: 'topic-wide', coveragePolicy: 'occurrence-complete', targetTopic: 'NER', targetAspects: [], origin: 'user-explicit', confidence: 'high' };
const occurrence = new CurrentNoteSearchCoverageLedger(snapshot, occurrenceScope);
occurrence.recordSearch('goal-occurrence', tools.searchNote(['NER'], 20, occurrenceScope), 20);
occurrence.recordRead('goal-occurrence', { evidenceId: 'evidence-222222222222222222222222', blockIds: snapshot.blocks.slice(0, 3).map((block) => block.blockId), headingPath: ['NER 总览'], lineFrom: 1, lineTo: 3, text: snapshot.markdown.slice(0, 80) });
assert.equal(occurrence.toModelSummary('goal-occurrence').status, 'partial', '无分页时 occurrence-complete 不能声称完成');

const summary = topic.toModelSummary('goal-topic');
assert.equal(typeof summary.discoveredHeadingCount, 'number');
assert.equal(typeof summary.readHeadingCount, 'number');
assert.equal(Object.isFrozen(summary), true, '模型可见摘要必须不可变');
assert.doesNotMatch(JSON.stringify(summary), /定义方面：NER 从文本中/u, '摘要不能携带原文导航片段');

const budgetResult = await runCurrentNoteAgent({
  snapshot,
  question: 'NER 都讲了什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: {
    async decide() {
      return { type: 'tool', tool: 'search_note', arguments: { terms: ['NER'], limit: 20 }, publicRationale: '定位主题相关章节。' };
    },
    async synthesize() {
      return { type: 'answer', answer: '模型尝试给出主题总结。', citations: [], completeness: 'complete' };
    },
  },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'coverage-gate',
  isSnapshotCurrent: () => true,
  budget: { ...DEFAULT_CURRENT_NOTE_AGENT_BUDGET, maxToolCalls: 1 },
});
assert.equal(budgetResult.toolStats.calls, 1, '工具循环必须使用共享预算，不能偷偷追加调用');
assert.equal(budgetResult.completeness, 'complete', '预算耗尽后模型合成结果不得再被 Coverage 改写');
assert.equal(budgetResult.answer, '模型尝试给出主题总结。');

let topicDecisions = 0;
const oneSectionTopicResult = await runCurrentNoteAgent({
  snapshot,
  question: 'NER 都讲了什么？',
  conversation: [],
  providerKind: 'ollama',
  model: 'qwen3',
  contextWindowTokens: 20_000,
  signal: new AbortController().signal,
  driver: {
    async decide({ prompt }) {
      topicDecisions += 1;
      if (topicDecisions === 1) return { type: 'tool', tool: 'search_note', arguments: { terms: ['NER'], limit: 20 }, publicRationale: '先定位主题候选。' };
      if (topicDecisions === 2) return { type: 'tool', tool: 'read_note_range', arguments: { lineFrom: snapshot.headings[1].lineFrom, lineTo: snapshot.headings[1].lineTo }, publicRationale: '读取一个章节的原文。' };
      const evidenceId = prompt.match(/evidence-[a-f0-9]{24}/u)?.[0];
      return { type: 'answer', answer: '只读取了一个章节。', citations: evidenceId ? [evidenceId] : [], completeness: 'complete' };
    },
    async synthesize() {
      return { type: 'answer', answer: '只读取了一个章节。', citations: [], completeness: 'complete' };
    },
  },
  memory: new NoteConversationMemory(),
  memoryScopeKey: 'coverage-topic-one-section',
  isSnapshotCurrent: () => true,
});
assert.equal(oneSectionTopicResult.completeness, 'complete', 'off 模式不得由 Coverage 观测数据改写合法引用答案');
assert.equal(oneSectionTopicResult.coverage?.status, 'partial', '主题综合问题只读一个章节时 Coverage 仍应如实记录 partial');

console.log('Current-note search coverage verification passed');

function collectHeadings(markdownText) {
  const lines = markdownText.split(/\r?\n/u);
  const headingsOut = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(lines[index]);
    if (!match) continue;
    headingsOut.push({ id: `fixture-heading-${String(headingsOut.length + 1).padStart(4, '0')}`, level: match[1].length, text: match[2].trim(), line: index + 1 });
  }
  return headingsOut;
}
