import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', `verify-current-note-citations-${process.pid}-${Date.now()}`);
mkdirSync(outDir, { recursive: true });
const snapshotOutput = path.join(outDir, 'snapshot.cjs');
const guardOutput = path.join(outDir, 'citation-guard.cjs');
const ledgerOutput = path.join(outDir, 'ledger.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteSnapshot.ts')], outfile: snapshotOutput, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantCitationGuard.ts')], outfile: guardOutput, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteEvidenceLedger.ts')], outfile: ledgerOutput, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { createCurrentNoteSnapshot } = await import(pathToFileURL(snapshotOutput).href);
const { validateAssistantCitationAgainstSnapshot } = await import(pathToFileURL(guardOutput).href);
const { CurrentNoteEvidenceLedger } = await import(pathToFileURL(ledgerOutput).href);
const markdown = '# P6 引用\n\n这是一段可校验的引用原文。\n\n第二段内容。\n';
const snapshot = createCurrentNoteSnapshot({
  libraryPath: outDir,
  notePath: path.join(outDir, 'P6 引用.md'),
  title: 'P6 引用',
  contentHash: sha256(markdown),
  markdown,
  headings: [{ id: 'p6', level: 1, text: 'P6 引用', line: 1 }],
  revision: 1,
  createdAt: '2026-08-21T00:00:00.000Z',
});
const citation = {
  evidenceId: 'evidence-p6-fixture',
  notePath: snapshot.notePath,
  contentHash: snapshot.contentHash,
  headingPath: ['P6 引用'],
  lineFrom: 3,
  lineTo: 3,
  quoteHash: sha256('这是一段可校验的引用原文。'),
  preview: '这是一段可校验的引用原文。',
};

assert.deepEqual(validateAssistantCitationAgainstSnapshot(citation, snapshot), { status: 'valid' });
assert.equal(validateAssistantCitationAgainstSnapshot({ ...citation, contentHash: sha256('changed') }, snapshot).status, 'stale', '内容哈希变化时不能定位');
assert.equal(validateAssistantCitationAgainstSnapshot({ ...citation, lineTo: snapshot.lineCount + 1 }, snapshot).status, 'stale', '越界行号不能定位');
assert.equal(validateAssistantCitationAgainstSnapshot({ ...citation, quoteHash: sha256('wrong') }, snapshot).status, 'stale', '原文哈希变化时不能定位');

const sourceBlock = snapshot.blocks.find((block) => block.lineFrom === 3) ?? snapshot.blocks[0];
assert.ok(sourceBlock, '引用 fixture 必须包含可读取原文块');
const ledger = new CurrentNoteEvidenceLedger(snapshot);
const sourceRecord = ledger.add({
  blockIds: [sourceBlock.blockId],
  headingPath: sourceBlock.headingPath,
  lineFrom: sourceBlock.lineFrom,
  lineTo: sourceBlock.lineTo,
  text: sourceBlock.text,
  matchedTerms: ['阶段6'],
  supports: ['原文定位投影'],
  sourceToolCallId: 'stage6-citation-tool',
  admission: 'explicit-read',
}).record;
assert.deepEqual(
  ledger.toCitations([sourceRecord.evidenceId]).map((current) => current.evidenceId),
  [sourceRecord.evidenceId],
  'Ledger 中的原文记录应可投影为界面定位信息',
);
for (const rejectedId of ['artifact-batch-stage6', 'evidence-foreign-session', 'evidence-stale-snapshot']) {
  assert.deepEqual(
    ledger.toCitations([rejectedId]),
    [],
    `${rejectedId} 不在当前 Ledger 时不生成界面定位信息`,
  );
}

const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const preloadSource = readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
const declarationSource = readFileSync(path.join(rootDir, 'src', 'electron.d.ts'), 'utf8');
const appSource = readFileSync(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
const panelSource = readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
const editorSource = readFileSync(path.join(rootDir, 'src', 'components', 'Editor.tsx'), 'utf8');
const styleSource = readFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), 'utf8');
assert.match(mainSource, /assistant-citation:validate/);
assert.match(mainSource, /validateAssistantEvidenceCitation\(value\)/);
assert.match(preloadSource, /validateAssistantCitation/);
assert.match(declarationSource, /validateAssistantCitation/);
assert.match(appSource, /handleNavigateAssistantCitation/);
assert.match(appSource, /flushPendingSave\(\)/);
assert.match(appSource, /lineFrom:\s*citation\.lineFrom/);
assert.match(appSource, /lineTo:\s*citation\.lineTo/);
assert.match(panelSource, /AssistantCitationList/);
assert.match(panelSource, /引用 \{citations\.length\} 条/);
assert.doesNotMatch(panelSource, /citation\.preview/);
assert.doesNotMatch(panelSource, /result\.sourceNotes\.length/);
assert.match(editorSource, /findEditorLineTarget\(content,\s*editor\.view\.dom,\s*lineFrom\)/);
assert.match(editorSource, /const lineTarget = hasLineTarget[\s\S]*?if \(lineTarget\) \{[\s\S]*?flashAndScroll\(lineTarget\);[\s\S]*?return;/);
assert.match(editorSource, /const normalizedTarget = normalizeSearchText\(fallbackText\)/, '仅在行号无法映射时回退到引用预览文本');
assert.match(editorSource, /menghan-search-target/);
assert.match(styleSource, /assistant-citation-link/);
assert.match(styleSource, /::highlight\(menghan-search-target\)/);

console.log('Current-note source-link projection and navigation verification passed');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
