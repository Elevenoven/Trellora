import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-agent-runtime', 'runtime.cjs');
await build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'agentRuntime.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] });
const { runLocalKnowledgeAgent } = await import(pathToFileURL(outFile).href);

const ollama = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const prompt = JSON.parse(body).prompt;
    response.setHeader('content-type', 'application/json');
    if (prompt.includes('Trellora的知识分析助手')) {
      response.end(JSON.stringify({ response: '{"summary":"统一分析","keyPoints":["一次调用"],"tagCandidates":[{"name":"知识管理","confidence":"high","evidence":"笔记明确讨论知识管理"}]}' }));
    } else if (prompt.includes('Create a concise learning path')) {
      response.end(JSON.stringify({ response: '{"steps":[{"title":"Start","rationale":"Foundation","sourceTitles":["Alpha"]}]}' }));
    } else if (prompt.includes('Suggest a conservative organization')) {
      response.end(JSON.stringify({ response: '{"groups":[{"title":"Core","noteTitles":["Alpha"],"rationale":"Related"}],"nextActions":["Review tags"]}' }));
    } else if (prompt.includes('private local knowledge assistant')) {
      response.end(JSON.stringify({ response: 'Grounded answer [Alpha]' }));
    } else {
      response.end(JSON.stringify({ response: '{"summary":"Local summary","keyPoints":["Point"],"suggestedTags":["local"]}' }));
    }
  });
});
await new Promise((resolve) => ollama.listen(11434, '127.0.0.1', resolve));

try {
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'summary', model: 'test', markdown: '# A' }), { type: 'summary', summary: 'Local summary', keyPoints: ['Point'] });
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'tags', model: 'test', markdown: '# A' }), { type: 'tags', suggestedTags: ['local'] });
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'analyze', model: 'test', markdown: '# Trellora\n\n本地优先知识管理。', currentTags: ['existing'], libraryTags: ['知识管理'] }), {
    type: 'analyze',
    summary: '统一分析',
    keyPoints: ['一次调用'],
    tagCandidates: [{ name: '知识管理', confidence: 'high', evidence: '笔记明确讨论知识管理' }],
  });
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'answer', model: 'test', question: 'What?', sources: [{ title: 'Alpha', content: 'A' }] }), { type: 'answer', answer: 'Grounded answer [Alpha]', sources: ['Alpha'] });
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'plan', model: 'test', goal: 'Learn A', sources: [{ title: 'Alpha', content: 'A' }] }), { type: 'plan', steps: [{ title: 'Start', rationale: 'Foundation', sourceTitles: ['Alpha'] }], sources: ['Alpha'] });
  assert.deepEqual(await runLocalKnowledgeAgent({ type: 'organize', model: 'test', notes: [{ title: 'Alpha', tags: ['local'], headings: ['A'] }] }), { type: 'organize', groups: [{ title: 'Core', noteTitles: ['Alpha'], rationale: 'Related' }], nextActions: ['Review tags'] });
} finally {
  await new Promise((resolve, reject) => ollama.close((error) => error ? reject(error) : resolve()));
}

console.log('LangGraph agent runtime verification passed');
process.exit(0);
