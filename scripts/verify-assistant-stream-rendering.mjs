import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-assistant-stream-rendering');
const outFile = path.join(outDir, 'assistant-stream-buffer.cjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

await build({
  entryPoints: [path.join(rootDir, 'src', 'components', 'assistant', 'useAssistantStreamBuffer.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
});

const require = createRequire(import.meta.url);
const {
  assistantStreamRenderPolicy,
  takeAssistantStreamFrame,
  useAssistantStreamBuffer,
} = require(outFile);

assert.deepEqual(assistantStreamRenderPolicy, {
  frameIntervalMs: 32,
  backlogDrainMs: 200,
  minimumCharsPerFrame: 12,
  maximumCharsPerFrame: 48,
});

assert.deepEqual(
  takeAssistantStreamFrame({ content: '短内容', thinking: '思考' }),
  {
    flush: { contentDelta: '短内容', thinkingDelta: '思考' },
    remaining: { content: '', thinking: '' },
  },
  'A short buffered delta should reach the next frame without artificial latency.',
);

const longContent = 'x'.repeat(240);
const firstFrame = takeAssistantStreamFrame({ content: longContent, thinking: '' });
assert.ok(firstFrame.flush.contentDelta.length >= assistantStreamRenderPolicy.minimumCharsPerFrame);
assert.ok(firstFrame.flush.contentDelta.length <= assistantStreamRenderPolicy.maximumCharsPerFrame);
assert.equal(firstFrame.flush.contentDelta + firstFrame.remaining.content, longContent,
  'Frame draining must preserve every streamed character in order.');

const surrogateContent = `${'x'.repeat(47)}😀尾`;
const surrogateFrame = takeAssistantStreamFrame({ content: surrogateContent, thinking: '' });
assert.equal(surrogateFrame.flush.contentDelta + surrogateFrame.remaining.content, surrogateContent);
assert.equal(surrogateFrame.flush.contentDelta.endsWith('\uD83D'), false,
  'A render frame must not split a UTF-16 surrogate pair.');
assert.equal(surrogateFrame.remaining.content.startsWith('\uDE00'), false,
  'A render frame must not begin with the second half of a surrogate pair.');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let clock = 1_000;
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => clock },
});
let nextAnimationFrameId = 1;
const animationFrames = new Map();
window.requestAnimationFrame = (callback) => {
  const id = nextAnimationFrameId;
  nextAnimationFrameId += 1;
  animationFrames.set(id, callback);
  return id;
};
window.cancelAnimationFrame = (id) => animationFrames.delete(id);

const runtimeFlushes = [];
let streamControls = null;
function StreamBufferHarness() {
  streamControls = useAssistantStreamBuffer((flush) => runtimeFlushes.push(flush));
  return null;
}
const runtimeRoot = createRoot(document.getElementById('root'));
await act(async () => runtimeRoot.render(React.createElement(StreamBufferHarness)));

const runNextAnimationFrame = async () => {
  const next = animationFrames.entries().next().value;
  assert.ok(next, 'A pending stream must schedule an animation frame.');
  const [id, callback] = next;
  animationFrames.delete(id);
  await act(async () => callback(clock));
};

await act(async () => streamControls.enqueue('runtime', 'content', 'x'.repeat(80)));
assert.equal(runtimeFlushes.length, 1,
  'The first streamed slice must become visible immediately instead of waiting behind the cadence scheduler.');
assert.equal(runtimeFlushes[0].contentDelta.length, 13,
  'The leading-edge flush must still use the bounded frame size.');
assert.equal(animationFrames.size, 1, 'Burst deltas must share one scheduled render frame.');
clock += 16;
await runNextAnimationFrame();
assert.equal(runtimeFlushes.length, 1);

clock += 16;
await runNextAnimationFrame();
assert.equal(runtimeFlushes.length, 2,
  'The buffer must release the next slice once the 32ms cadence is reached.');

await act(async () => {
  streamControls.reset('terminal');
  streamControls.enqueue('terminal', 'content', '最终内容');
  streamControls.flush('terminal');
});
assert.equal(runtimeFlushes.at(-1).contentDelta, '最终内容',
  'A terminal event must bypass cadence and flush all remaining text.');
assert.equal(animationFrames.size, 0, 'A terminal flush must cancel its scheduled frame.');
await act(async () => runtimeRoot.unmount());

const knowledgePanelSource = readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
const markdownContentSource = readFileSync(path.join(rootDir, 'src', 'components', 'MarkdownContent.tsx'), 'utf8');
const wikiDataSourceSource = readFileSync(path.join(rootDir, 'src', 'wiki', 'wikiElectronAgentDataSource.ts'), 'utf8');
const wikiAssistantTabSource = readFileSync(path.join(rootDir, 'src', 'components', 'wiki', 'WikiAssistantTab.tsx'), 'utf8');
const cssSource = readFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), 'utf8');

assert.match(knowledgePanelSource, /event\.type === 'delta'[\s\S]{0,180}enqueueAssistantStream\(event\.requestId, 'content', event\.text\)/,
  'Token events must enter the visual stream buffer before React message state.');
assert.match(knowledgePanelSource, /event\.type === 'thinking-delta'[\s\S]{0,180}enqueueAssistantStream\(event\.requestId, 'thinking', event\.text\)/,
  'Thinking events must use the same bounded visual buffer.');
assert.match(knowledgePanelSource, /event\.type === 'complete' \|\| event\.type === 'error' \|\| event\.type === 'cancelled'[\s\S]{0,120}flushAssistantStream\(event\.requestId\)/,
  'Every terminal event must synchronously flush buffered content.');
assert.match(knowledgePanelSource, /new ResizeObserver\(\(\) => \{[\s\S]{0,160}shouldStickToBottomRef\.current/,
  'Content growth must only drive scrolling while the user remains at the bottom.');
assert.match(knowledgePanelSource, /scroll\.scrollHeight - scroll\.scrollTop - scroll\.clientHeight <= 2/,
  'The sticky-bottom threshold must be explicit and small.');
assert.match(knowledgePanelSource, /if \(!force && !shouldStickToBottomRef\.current\) return;/,
  'A queued automatic scroll must remain cancellable when the user scrolls upward.');
assert.match(knowledgePanelSource, /className="assistant-scroll-to-bottom"/,
  'Leaving the bottom must expose a deliberate return-to-latest action.');
assert.match(knowledgePanelSource, /isStreaming=\{message\.state === 'streaming'\}/,
  'Assistant messages must tell Markdown rendering when the stream is still open.');

assert.doesNotMatch(markdownContentSource, /useDeferredValue/,
  'The 32ms stream buffer must be the only cadence owner; deferred content can starve live text.');
assert.match(markdownContentSource, /renderPreviewHtml\(content, \{ currentPath, libraryPath, frontmatter \}\)/,
  'Every buffered content frame must render the current text directly.');
assert.match(markdownContentSource, /if \(!container \|\| isStreaming\) return;/,
  'Expensive Markdown enhancements must pause while content is incomplete.');
assert.doesNotMatch(markdownContentSource, /<div[^>]+key=\{renderVersion\}/,
  'A growing answer must not remount its outer Markdown node.');

assert.match(wikiDataSourceSource, /assistantStreamRenderPolicy, takeAssistantStreamFrame/,
  'Wiki answers must reuse the Q&A visual stream policy instead of inventing another cadence.');
assert.match(wikiDataSourceSource, /takeAssistantStreamFrame\(\{ content: pendingAssistantText, thinking: pendingThinkingText \}\)/,
  'Wiki content and thinking bursts must pass through the shared bounded frame slicer.');
assert.match(wikiDataSourceSource, /finishTerminalMessageIfDrained\(\)/,
  'Wiki completion must wait until the visible stream backlog has drained.');
assert.match(wikiAssistantTabSource, /isStreaming=\{Boolean\(message\.streaming\)\}/,
  'Wiki Markdown must defer expensive enhancements while an answer is growing.');
assert.match(wikiAssistantTabSource, /new ResizeObserver\(\(\) => scheduleScrollToBottom\(\)\)/,
  'Wiki sticky scrolling must follow actual content growth.');
assert.match(wikiAssistantTabSource, /window\.requestAnimationFrame\(\(\) => \{/,
  'Wiki scrolling must coalesce burst updates into animation frames.');
assert.doesNotMatch(wikiAssistantTabSource, /behavior:\s*'smooth'/,
  'Wiki streaming must not restart a smooth-scroll animation for every answer frame.');

assert.match(cssSource, /\.assistant-conversation\s*\{[\s\S]{0,220}overflow:\s*hidden;/,
  'The conversation shell must not compete with the message viewport for scrolling.');
assert.match(cssSource, /\.assistant-message-list\s*\{[\s\S]{0,260}overflow-y:\s*auto;[\s\S]{0,120}scrollbar-gutter:\s*stable;/,
  'The message viewport must own vertical scrolling and reserve scrollbar space.');
assert.match(cssSource, /\.assistant-message\.assistant\s*\{[\s\S]{0,120}width:\s*100%;/,
  'Assistant answer width must stay stable while Markdown blocks grow.');

console.log('Assistant streaming render verification passed.');
