import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellora-note-batches-'));
try {
  const output = path.join(temporaryRoot, 'planner.cjs');
  const lengthOutput = path.join(temporaryRoot, 'length.cjs');
  const tagsOutput = path.join(temporaryRoot, 'tags.cjs');
  const sourceOutput = path.join(temporaryRoot, 'source.cjs');
  const preparationOutput = path.join(temporaryRoot, 'preparation.cjs');
  await Promise.all([
    build({ entryPoints: ['electron/knowledge/noteAnalysisBatchPlanner.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: ['electron/knowledge/noteAnalysisLengthPolicy.ts'], outfile: lengthOutput, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: ['electron/knowledge/tagSuggestion.ts'], outfile: tagsOutput, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: ['electron/knowledge/noteAnalysisSource.ts'], outfile: sourceOutput, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: ['electron/knowledge/noteAnalysisInputPreparation.ts'], outfile: preparationOutput, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
  const { planNoteAnalysisBatches, planFullNoteAnalysis, readNoteAnalysisSpans } = await import(pathToFileURL(output).href);
  const { prepareNoteAnalysisInput, readPreparedNoteAnalysisSpans } = await import(pathToFileURL(preparationOutput).href);
  const { countNoteAnalysisCharacters, finishNoteAnalysisLength, truncateNoteAnalysisSummary, parseNoteAnalysisBatchPayload } = await import(pathToFileURL(lengthOutput).href);
  const { applyConfirmedTags } = await import(pathToFileURL(tagsOutput).href);
  const { getNoteAnalysisSourceHash } = await import(pathToFileURL(sourceOutput).href);
  for (const text of ['没有末尾换行', '\n正文\n', '正文\r\n', '---\ntitle: 原有标题\n---\n\n正文']) {
    assert.equal(getNoteAnalysisSourceHash(applyConfirmedTags(text, ['财务']).markdown), getNoteAnalysisSourceHash(text), '新增或更新Frontmatter标签不能补换行使分析过期');
  }
  const plain = '这是企业资料的连续正文，没有标题。'.repeat(5_000) + '全文尾部验收标记：应收账款已经核对完成。';
  const plans = planNoteAnalysisBatches(plain);
  assert.ok(plans.length >= 7);
  assert.equal(plans.map((batch) => readNoteAnalysisSpans(plain, batch.coreSpans)).join(''), plain, '首尾原文必须逐字覆盖，不能只比长度');
  assert.ok(plans.at(-1).coreSpans.some((span) => plain.slice(span.startOffset, span.endOffset).includes('全文尾部验收标记')));
  for (const batch of plans) {
    assert.ok(batch.inputCharacterCount <= 12_000);
    assert.ok(batch.overlapCharacterCount <= 1_000);
    assert.equal(batch.inputCharacterCount, countNoteAnalysisCharacters(readPreparedNoteAnalysisSpans(prepareNoteAnalysisInput(plain), [...batch.contextSpans, ...batch.coreSpans])));
  }
  const structured = '---\ntags: [财务]\n---\n\n章前说明。\n\n# 第一章\n\n第一段。\n\n第二段。\n\n## 对账\n\n' + '未结清发票。'.repeat(5_000) + '\n\n```ts\n# 代码内标题\n```\n\n| 科目 | 金额 |\n| --- | --- |\n| 应收 | 800 |\n\n# 第二章\n\n最后一段。';
  const structuredPlans = planNoteAnalysisBatches(structured);
  assert.equal(structuredPlans[0].mode, 'structured');
  assert.ok(structuredPlans[0].sections.some(section => !section.headingPath.length));
  assert.ok(structuredPlans.some((batch) => batch.sourceLabel.includes('第一章')));
  assert.ok(structuredPlans.some(batch => batch.sections.some(section => section.headingPath.join('/').includes('第一章/对账'))));
  assert.ok(!structuredPlans.some(batch => batch.sections.some(section => section.headingPath.some(heading => heading.includes('代码内标题')))));
  assert.ok(structuredPlans.some((batch) => batch.coreSpans.some((span) => span.kind === 'table')));
  assert.ok(structuredPlans.some((batch) => batch.coreSpans.some((span) => span.partCount > 1)));
  assert.equal(structuredPlans.at(-1).sections.at(-1).headingPath[0], '第二章');
  assert.equal(planNoteAnalysisBatches('第一段。\n\n第二段。')[0].sourceLabel, '【正文块 1–2】');
  const manyTitles = Array.from({ length: 100 }, (_, index) => `# 第${index + 1}章\n\n项目${index + 1}：${'交付验收与财务复核。'.repeat(40)}`).join('\n\n');
  const packed = planNoteAnalysisBatches(manyTitles);
  assert.ok(packed.length < 6, '不能每个标题各调用一次');
  assert.ok(packed.every(batch => batch.sections.length > 1 && batch.overlapCharacterCount === 0));
  const small = manyTitles.slice(0, 8_000);
  const full = planFullNoteAnalysis(small);
  assert.equal(full.processingMode, 'full-document');
  assert.equal(full.overlapCharacterCount, 0);
  assert.ok(full.sections.length > 10);
  const repeated = '企业设备验收凭证已核对，合同金额120000元，税率13%，审批人王经理，保留金7%，整改32个工作日。'.repeat(2);
  const dirty = `# 核对\r\n\r\n${repeated}\t\r\n\r\n<!-- invisible-noise -->\r\n\r\n${repeated}\r\n\r\n${repeated.replace('120000', '120001')}\r\n\r\n# 核对\r\n\r\n${repeated}\r\n\r\n\`\`\`ts\r\n  const value = 120000;  \r\n  // keep-comment\r\n\`\`\`\r\n\r\n| 项目 | 金额 |\r\n| --- | --- |\r\n| 合同 | 120000 |\r\n`;
  const prepared = prepareNoteAnalysisInput(dirty);
  assert.equal(prepared.stats.duplicateBlocks, 1, '同名但不同章节也不能合并');
  assert.equal(prepared.stats.removedBlocks, 1);
  assert.ok(prepared.units.some(unit => unit.text.includes('120001')));
  const dirtyFull = planFullNoteAnalysis(dirty, prepared);
  const cleaned = readPreparedNoteAnalysisSpans(prepared, dirtyFull.coreSpans);
  assert.ok(!cleaned.includes('invisible-noise') && !cleaned.includes('\r'));
  assert.ok(cleaned.includes('  const value = 120000;  \n  // keep-comment'));
  assert.ok(cleaned.includes('| 合同 | 120000 |'));
  assert.equal(dirtyFull.sections.reduce((count, section) => count + section.duplicateSpans.length, 0), 1);
  const prose = '正文🙂\u200B\t\n\n\n\n数字120001与13%。\t  \n下一行。\t';
  const once = prepareNoteAnalysisInput(prose).units.map(unit => unit.text).join('\n\n');
  const twice = prepareNoteAnalysisInput(once).units.map(unit => unit.text).join('\n\n');
  assert.equal(twice, once, '清洗必须幂等');
  assert.ok(once.includes('13%。  \n下一行。'), '保留Markdown两个空格的硬换行');
  assert.ok(!once.includes('\u200B'));
  assert.equal(prepareNoteAnalysisInput('确认完成。\n\n确认完成。').stats.duplicateBlocks, 0, '短陈述不合并');
  assert.equal(prepareNoteAnalysisInput(`${repeated}\n\n# preamble\n\n${repeated}`).stats.duplicateBlocks, 0, '引言不能与恰好同名的实际章节合并');
  assert.throws(() => prepareNoteAnalysisInput('<!-- only comment -->'), /没有可分析/u);
  const balanced = planNoteAnalysisBatches('连续正文。'.repeat(2_600));
  assert.equal(balanced.length, 2);
  assert.ok(balanced.every(batch => batch.inputCharacterCount > 5_000), '不能留下不足两千字的尾批');
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = ('没有句号🙂'.repeat(2_100) + newline).repeat(3);
    const batches = planNoteAnalysisBatches(text);
    assert.equal(batches.map((batch) => readNoteAnalysisSpans(text, batch.coreSpans)).join(''), text);
    for (const batch of batches) for (const span of [...batch.coreSpans, ...batch.contextSpans]) {
      assert.ok(!/[\uD800-\uDBFF]$/u.test(text.slice(span.startOffset, span.endOffset)));
      assert.ok(!/^[\uDC00-\uDFFF]/u.test(text.slice(span.startOffset, span.endOffset)));
      assert.ok(!(text[span.endOffset - 1] === '\r' && text[span.endOffset] === '\n'));
    }
  }
  assert.equal(countNoteAnalysisCharacters('甲🙂\r\n乙'), 4);
  for (const size of [999, 1_000]) assert.equal(finishNoteAnalysisLength('字'.repeat(size), 'plain', false).lengthHandling, 'within-limit');
  assert.throws(() => finishNoteAnalysisLength('字'.repeat(1_001), 'plain', false));
  for (const size of [1_001, 4_500]) {
    const text = '首'.repeat(300) + '中'.repeat(size - 900) + '尾'.repeat(600);
    const plainResult = finishNoteAnalysisLength(text, 'plain', true);
    assert.equal(countNoteAnalysisCharacters(plainResult.summary), 750);
    assert.equal(plainResult.summary, '首'.repeat(224) + '\n' + '尾'.repeat(525));
    assert.equal(finishNoteAnalysisLength(text, 'structured', true).summary, text);
  }
  assert.equal(countNoteAnalysisCharacters(truncateNoteAnalysisSummary('🙂'.repeat(2_000))), 750);
  assert.equal(parseNoteAnalysisBatchPayload({ summary: '字'.repeat(4_500), keyPoints: [], tagCandidates: [] }, []).summary.length, 4_500);
  assert.throws(() => parseNoteAnalysisBatchPayload({ summary: '', keyPoints: [], tagCandidates: [] }, []));
  console.log('NB-1: full-text coverage, headings, overlap, source coordinates and length policy passed.');
} finally {
  const resolvedRoot = path.resolve(temporaryRoot);
  assert.ok(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolvedRoot).startsWith('trellora-note-batches-'));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
