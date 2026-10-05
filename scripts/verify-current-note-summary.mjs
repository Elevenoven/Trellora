import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-current-note-summary-${process.pid}-${Date.now()}`);
const libraryDir = path.join(outDir, 'library');
mkdirSync(libraryDir, { recursive: true });

const outputs = process.env.MENGHAN_CURRENT_NOTE_SUMMARY_PREBUILT === '1'
  ? Object.fromEntries(Object.entries({ summary: 'summary.cjs', digest: 'digest.cjs', memory: 'memory.cjs', database: 'database.cjs', snapshot: 'snapshot.cjs', budget: 'summary-budget.cjs' }).map(([key, file]) => [key, path.join(rootDir, '.package-staging', 'verify-context', file)]))
  : {
    summary: path.join(outDir, 'summary.cjs'),
    digest: path.join(outDir, 'digest.cjs'),
    memory: path.join(outDir, 'memory.cjs'),
    database: path.join(outDir, 'database.cjs'),
    snapshot: path.join(outDir, 'snapshot.cjs'),
    budget: path.join(outDir, 'summary-budget.cjs'),
  };
if (process.env.MENGHAN_CURRENT_NOTE_SUMMARY_PREBUILT !== '1') {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteSummaryOrchestrator.ts')], outfile: outputs.summary, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteDerivedDigestRepository.ts')], outfile: outputs.digest, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryRepository.ts')], outfile: outputs.memory, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryDatabase.ts')], outfile: outputs.database, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: outputs.snapshot, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'summaryRunBudget.ts')], outfile: outputs.budget, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}

const { buildNoteSummarySections, classifyCurrentNoteSummaryIntent, runCurrentNoteSummary } = await import(pathToFileURL(outputs.summary).href);
const { NoteDerivedDigestRepository, SectionDigestPurityGuard } = await import(pathToFileURL(outputs.digest).href);
const { AssistantMemoryRepository } = await import(pathToFileURL(outputs.memory).href);
const { AssistantMemoryDatabase } = await import(pathToFileURL(outputs.database).href);
const { createCurrentNoteSnapshot } = await import(pathToFileURL(outputs.snapshot).href);
const { SummaryRunBudget } = await import(pathToFileURL(outputs.budget).href);

const compatibilityLibraryDir = path.join(outDir, 'compatibility-library');
const migratedOwner = new AssistantMemoryDatabase();
const migratedDatabase = migratedOwner.getDatabase(compatibilityLibraryDir);
assert.equal(migratedDatabase.pragma('user_version', { simple: true }), 7, '摘要夹具必须使用当前受支持的独立记忆库结构');
assert.equal(migratedDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'assistant_section_digests'").get().count, 1);
migratedOwner.closeAll();

assert.equal(classifyCurrentNoteSummaryIntent('请完整总结当前笔记。'), 'summary-complete');
assert.equal(classifyCurrentNoteSummaryIntent('请用三句话快速概括当前笔记。'), 'summary-quick');
assert.equal(classifyCurrentNoteSummaryIntent('这一节的缓存策略是什么？'), undefined);

const markdown = `# 总览
这是总览章节的唯一内容。

## 缓存
未变化章节应当复用章节摘要。

## 纯度
共享摘要不得读取会话问题或证据编号。

# 验收
完整总结必须覆盖每个非空章节。
`;
const snapshot = createSnapshot(markdown, 1);
const owner = new AssistantMemoryDatabase();
const memoryRepository = new AssistantMemoryRepository(owner, libraryDir);
const digestRepository = new NoteDerivedDigestRepository(owner, memoryRepository, libraryDir);
const mapPrompts = [];
const reducePrompts = [];
const driver = createDriver(mapPrompts, reducePrompts);

const first = await runCurrentNoteSummary(summaryInput(snapshot, driver, digestRepository), 'summary-complete');
const sections = buildNoteSummarySections(snapshot);
assert.equal(first.contextMode, 'structured-summary');
assert.equal(first.coverage.total, sections.length);
assert.equal(first.coverage.completed, sections.length, `完整总结必须覆盖每个非空章节：${JSON.stringify({ coverage: first.coverage, agentStats: first.agentStats, summaryBudget: first.summaryBudget, checkpoint: first.checkpoint })}`);
assert.equal(first.coverage.generated, sections.length);
assert.equal(first.coverage.reused, 0);
assert.equal(first.evidence.length, sections.length, '最终结果必须携带当前快照新物化的章节引用');
assert.ok(first.answer.includes(`已覆盖 ${sections.length}/${sections.length}`));
assert.equal(mapPrompts.length, sections.length, '首次完整总结必须逐节读取');
assert.ok(mapPrompts.every((prompt) => prompt.includes('章节原文') && !prompt.includes('用户请求') && !prompt.includes('历史会话')));
assert.ok(reducePrompts.length >= 1);
assert.ok(reducePrompts.every((prompt) => !prompt.includes(markdown) && prompt.includes('章节摘要')), 'Reduce 禁止重新注入整篇原文');

const database = owner.getDatabase(libraryDir);
assert.equal(database.pragma('user_version', { simple: true }), 7);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_section_digests WHERE scope = 'note-derived' AND status = 'complete'").get().count, sections.length);
const serializedDigests = database.prepare("SELECT group_concat(digest_json, '\n') AS value FROM assistant_section_digests").get().value;
assert.ok(!serializedDigests.includes('请完整总结当前笔记'), '共享缓存不得存储用户问题');
assert.ok(!serializedDigests.includes('assistant-session-'), '共享缓存不得存储会话标识');
assert.ok(!serializedDigests.includes(markdown), '共享缓存不得复制章节原文');

const purityGuard = new SectionDigestPurityGuard();
assert.throws(() => purityGuard.assertWrite({
  libraryId: snapshot.libraryId,
  relativePath: snapshot.relativePath,
  contentHash: snapshot.contentHash,
  sectionId: 'part-1-1',
  sectionHash: sha256('section'),
  headingPath: ['总览'],
  lineFrom: 1,
  lineTo: 2,
  providerFingerprint: 'ollama|fixture',
  model: 'fixture',
  status: 'complete',
  digest: {
    summary: '不应写入。',
    keyPoints: [{ text: '不应写入。', sourceRefs: [{ blockId: 'section-part-1-1', lineFrom: 1, lineTo: 2, textHash: sha256('# 总览\n这是总览章节的唯一内容。') }] }],
    sessionId: 'assistant-session-leak',
  },
}), /不得包含会话|纯笔记/u);

const mapCountBeforeReuse = mapPrompts.length;
const reduceCountBeforeReuse = reducePrompts.length;
const second = await runCurrentNoteSummary(summaryInput(snapshot, driver, digestRepository), 'summary-complete');
assert.equal(second.coverage.generated, 0);
assert.equal(second.coverage.reused, sections.length, '相同章节必须复用缓存');
assert.equal(mapPrompts.length, mapCountBeforeReuse, '命中缓存时不能再次发送章节原文');
assert.ok(reducePrompts.length > reduceCountBeforeReuse, '最终 Reduce 必须针对本次请求重新生成');

const changedMarkdown = markdown.replace('未变化章节应当复用章节摘要。', '只修改这一节时应只重算该节摘要。');
const changedSnapshot = createSnapshot(changedMarkdown, 2);
const mapCountBeforeChange = mapPrompts.length;
const reduceCountBeforeChange = reducePrompts.length;
const changed = await runCurrentNoteSummary(summaryInput(changedSnapshot, driver, digestRepository), 'summary-complete');
assert.equal(changed.coverage.generated, 1, '只改一节时只能重算该节 Map');
assert.equal(changed.coverage.reused, buildNoteSummarySections(changedSnapshot).length - 1);
assert.equal(mapPrompts.length, mapCountBeforeChange + 1);
assert.ok(reducePrompts.length > reduceCountBeforeChange, '内容 hash 更新后必须重新执行最终 Reduce');
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_section_digests WHERE status = 'stale'").get().count, 1, '同一章节的旧摘要应标记为 stale');

const quick = await runCurrentNoteSummary(summaryInput(changedSnapshot, driver, digestRepository), 'summary-quick');
assert.equal(quick.coverage.completed, 0);
assert.match(quick.answer, /未逐节覆盖全文/u);

const puritySnapshot = createSnapshot('# 临时摘要\n\n这节用于验证纯度失败后的降级。\n', 3, 'P5 纯度.md');
const leakyDriver = {
  async summarizeSection() {
    return { summary: '本轮仍可生成总结。', keyPoints: ['assistant-session-should-not-cache'] };
  },
  async reduce() {
    return { summary: '纯度失败时仅使用本轮临时摘要。', keyPoints: ['共享缓存没有写入敏感标识。'] };
  },
};
const temporary = await runCurrentNoteSummary(summaryInput(puritySnapshot, leakyDriver, digestRepository), 'summary-complete');
assert.equal(temporary.coverage.completed, 1, '纯度失败不能中断本轮完整覆盖');
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_section_digests WHERE digest_json LIKE ?").get('%assistant-session-should-not-cache%').count, 0, '纯度失败的摘要不得写入共享缓存');

const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const panelSource = readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
assert.match(mainSource, /classifyCurrentNoteSummaryIntent/);
assert.match(mainSource, /runCurrentNoteSummary/);
const summaryRouteSource = mainSource.slice(mainSource.indexOf('if (currentNoteSummaryMode && currentNoteSnapshot)'), mainSource.indexOf('const useCurrentNoteAgent'));
assert.match(summaryRouteSource, /canonicalSummaryTurn/);
assert.match(summaryRouteSource, /route: 'current-note-react'/);
assert.doesNotMatch(summaryRouteSource, /scopedMemoryRepository\.startTurn|scopedMemoryRepository\.finalizeTurn/);
assert.match(panelSource, /完整总结当前笔记/);
assert.match(panelSource, /快速概括当前笔记/);
owner.closeAll();

console.log('Current-note summary P5 verification passed');

function createSnapshot(source, revision, fileName = 'P5 总结.md') {
  return createCurrentNoteSnapshot({
    libraryPath: libraryDir,
    notePath: path.join(libraryDir, fileName),
    title: 'P5 总结',
    contentHash: sha256(source),
    markdown: source,
    headings: [
      { id: 'overview', level: 1, text: '总览', line: 1 },
      { id: 'cache', level: 2, text: '缓存', line: 4 },
      { id: 'purity', level: 2, text: '纯度', line: 7 },
      { id: 'acceptance', level: 1, text: '验收', line: 10 },
    ],
    revision,
    createdAt: '2026-08-21T00:00:00.000Z',
  });
}

function summaryInput(currentSnapshot, driverInput, repository) {
  return {
    snapshot: currentSnapshot,
    question: '请完整总结当前笔记。',
    providerKind: 'ollama',
    model: 'fixture-model',
    driver: driverInput,
    digestRepository: repository,
    signal: new AbortController().signal,
    isSnapshotCurrent: () => true,
    summaryBudget: new SummaryRunBudget({ maxModelCalls: 32, maxWallTimeMs: 120_000 }),
  };
}

function createDriver(mapLog, reduceLog) {
  return {
    async summarizeSection({ prompt }) {
      mapLog.push(prompt);
      const title = prompt.match(/标题路径：(.*)/u)?.[1] ?? '[]';
      return { summary: `章节摘要 ${title}`, keyPoints: ['该章节包含可验证的 P5 规则。'] };
    },
    async reduce({ prompt }) {
      reduceLog.push(prompt);
      return { summary: 'P5 使用逐节 Map 与章节摘要 Reduce 完成总结。', keyPoints: ['完整模式覆盖每个非空章节。', '未变化章节复用缓存。'] };
    },
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
