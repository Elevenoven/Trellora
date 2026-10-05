import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-agent-graph', 'agent-graph.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'agentGraph.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs' });
const { runKnowledgeAgent } = await import(pathToFileURL(outFile).href);

const calls = [];
const dependencies = {
  summarize: async () => { calls.push('summary'); return { summary: 'Summary', keyPoints: ['Point'], suggestedTags: [] }; },
  suggestTags: async () => { calls.push('tags'); return { summary: '', keyPoints: [], suggestedTags: ['tag'] }; },
  answer: async () => { calls.push('answer'); return 'Grounded answer'; },
  plan: async () => { calls.push('plan'); return [{ title: 'Start', rationale: 'Foundation', sourceTitles: ['Alpha'] }]; },
  organize: async () => { calls.push('organize'); return { groups: [{ title: 'Core', rationale: 'Related', noteTitles: ['Alpha'] }], nextActions: ['Review tags'] }; },
};

assert.deepEqual(await runKnowledgeAgent(dependencies, { type: 'summary', markdown: '# A', model: 'local' }), { type: 'summary', summary: 'Summary', keyPoints: ['Point'] });
assert.deepEqual(await runKnowledgeAgent(dependencies, { type: 'tags', markdown: '# A', model: 'local' }), { type: 'tags', suggestedTags: ['tag'] });
assert.deepEqual(await runKnowledgeAgent(dependencies, { type: 'answer', question: 'What?', model: 'local', sources: [{ title: 'Alpha', content: 'A' }] }), { type: 'answer', answer: 'Grounded answer', sources: ['Alpha'] });
assert.deepEqual(await runKnowledgeAgent(dependencies, { type: 'plan', goal: 'Learn A', model: 'local', sources: [{ title: 'Alpha', content: 'A' }] }), { type: 'plan', steps: [{ title: 'Start', rationale: 'Foundation', sourceTitles: ['Alpha'] }], sources: ['Alpha'] });
assert.deepEqual(await runKnowledgeAgent(dependencies, { type: 'organize', model: 'local', notes: [{ title: 'Alpha', tags: [], headings: [] }] }), { type: 'organize', groups: [{ title: 'Core', rationale: 'Related', noteTitles: ['Alpha'] }], nextActions: ['Review tags'] });
assert.deepEqual(calls, ['summary', 'tags', 'answer', 'plan', 'organize']);

console.log('LangGraph agent routing verification passed');
