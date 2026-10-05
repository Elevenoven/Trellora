import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// 执行组件的真实回调，固定 await 的完成顺序，验证准备期的请求所有权。
const source = await readFile('src/components/KnowledgePanel.tsx', 'utf8');
const tree = ts.createSourceFile('KnowledgePanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['startTurn', 'startNewAssistantSession', 'restoreAssistantSession'].includes(node.name.getText(tree))) callbacks.set(node.name.getText(tree), node.initializer);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(callbacks.size, 3, 'must execute the production send and session callbacks');
const executable = ts.transpileModule([...callbacks].map(([name, callback]) => `globalThis.${name}=${callback.getText(tree)};`).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function harness({ currentNote = false, prepareSend } = {}) {
  const creations = [], submissions = [], adopted = [], alerts = [];
  let requestNumber = 0;
  const pendingSession = () => { const task = deferred(); creations.push(task); return task.promise; };
  const context = {
    Error,
    props: { libraryPath: 'C:/fixture', noteMeta: { title: '合同' },
      ...(prepareSend ? { onboarding: { sendDisabled: false, prepareSend } } : {}),
      ...(!currentNote ? { workspaceMemory: { onCreateSession: pendingSession, onSessionCreated: session => adopted.push(session) } } : {}),
      onStartAssistantTurn: async request => { submissions.push(request); },
    },
    draft: '待发送问题', attachments: [{ name: '合同.md', kind: 'text' }], messages: [],
    activeRequestIdRef: { current: null }, turnContextKey: 'context-1', turnContextKeyRef: { current: 'context-1' },
    assistantSessionId: null, isDataSourceWorkspace: !currentNote, isContextLocked: false,
    notePath: currentNote ? 'C:/fixture/合同.md' : null, intent: 'ask', scope: 'chat', contextSources: [],
    selectedModelProfileId: 'fixture-model', thinkingMode: 'simple', answerDepth: 'auto', selectedSkillIds: [],
    createAssistantRequestId: () => `fixture_request_${++requestNumber}`,
    getDraftScopeLabel: () => '本次使用：无', getConversationHistory: () => [], t: text => text,
    resetAssistantStream() {}, scrollMessagesToBottom() {},
    setActiveRequestId: value => { context.activeRequestId = value; },
    setAssistantSessionId: value => { context.assistantSessionId = value; },
    setMessages: update => { context.messages = update(context.messages); },
    setDraft: value => { context.draft = value; }, clearAttachments: () => { context.attachments = []; },
    setDebugMemory: value => { context.debugMemory = value; }, refreshedDebugTurnRef: { current: null },
    setIntent: value => { context.intent = value; }, setScope: value => { context.scope = value; },
    setContextSources: value => { context.contextSources = value; },
    cancelAndSettleActiveTurn: () => { context.activeRequestIdRef.current = null; context.activeRequestId = null; },
    refreshAssistantMemory: async () => {},
    window: { alert: message => alerts.push(message), electronAPI: { createAssistantMemorySession: pendingSession, getAssistantMemorySession: pendingSession } },
  };
  vm.runInNewContext(executable, context);
  return { context, creations, submissions, adopted, alerts,
    cancel: () => { context.activeRequestIdRef.current = null; context.activeRequestId = null; },
    newSession: () => { context.activeRequestIdRef.current = null; context.activeRequestId = null; context.assistantSessionId = null; context.messages = []; },
  };
}

{
  const test = harness();
  const first = test.context.startTurn(), duplicate = test.context.startTurn();
  assert.equal(test.creations.length, 1);
  assert.ok(test.context.activeRequestIdRef.current, 'the lock must exist before the first await');
  test.creations[0].resolve({ sessionId: 'first-session' });
  await Promise.all([first, duplicate]);
  assert.equal(test.submissions.length, 1); assert.equal(test.context.messages.length, 2);
}
{
  const test = harness();
  const first = test.context.startTurn(); test.cancel();
  test.creations[0].resolve({ sessionId: 'cancelled-session' }); await first;
  assert.equal(test.submissions.length, 0); assert.equal(test.adopted.length, 0);
  assert.equal(test.context.draft, '待发送问题'); assert.equal(test.context.attachments.length, 1);
}
for (const lateResult of ['resolve', 'reject']) {
  const test = harness();
  const old = test.context.startTurn(); test.newSession();
  const next = test.context.startTurn(undefined, '新会话问题');
  test.creations[1].resolve({ sessionId: 'new-session' }); await next;
  const owner = test.context.activeRequestIdRef.current;
  if (lateResult === 'resolve') test.creations[0].resolve({ sessionId: 'obsolete-session' });
  else test.creations[0].reject(new Error('obsolete failure'));
  await old;
  assert.equal(test.context.activeRequestIdRef.current, owner);
  assert.equal(test.context.assistantSessionId, 'new-session');
  assert.deepEqual(test.submissions.map(request => request.userText), ['新会话问题']);
  assert.equal(test.alerts.length, 0);
}
{
  const test = harness();
  const failed = test.context.startTurn(); test.creations[0].reject(new Error('创建失败')); await failed;
  assert.equal(test.context.activeRequestIdRef.current, null); assert.equal(test.context.activeRequestId, null);
  assert.equal(test.context.draft, '待发送问题'); assert.equal(test.context.attachments.length, 1);
  assert.deepEqual(test.alerts, ['创建失败']); assert.equal(test.context.messages.length, 0);
  const retry = test.context.startTurn(); test.creations[1].resolve({ sessionId: 'retry-session' }); await retry;
  assert.equal(test.submissions.length, 1);
}
{
  const test = harness();
  const changed = test.context.startTurn(); test.context.turnContextKeyRef.current = 'context-2';
  test.creations[0].resolve({ sessionId: 'obsolete-context' }); await changed;
  assert.equal(test.adopted.length, 0); assert.equal(test.submissions.length, 0);
  assert.equal(test.context.activeRequestIdRef.current, null);
}
{
  const test = harness({ currentNote: true });
  const refresh = deferred(); test.context.refreshAssistantMemory = () => refresh.promise;
  const first = test.context.startTurn(); test.creations[0].resolve({ sessionId: 'note-session' });
  await Promise.resolve(); test.cancel(); refresh.resolve(); await first;
  assert.equal(test.submissions.length, 0); assert.equal(test.context.draft, '待发送问题');
}
{
  const test = harness({ prepareSend: async () => undefined }); await test.context.startTurn();
  assert.equal(test.context.activeRequestIdRef.current, null); assert.equal(test.context.activeRequestId, null);
  assert.equal(test.context.draft, '待发送问题'); assert.equal(test.submissions.length, 0);
}
for (const operation of ['startNewAssistantSession', 'restoreAssistantSession']) for (const lateResult of ['resolve', 'reject']) {
  const test = harness({ currentNote: true });
  const transition = test.context[operation]({ sessionId: 'old-history' });
  await test.context.startTurn(); assert.equal(test.creations.length, 1, 'session navigation must also occupy preparation');
  test.cancel();
  const next = test.context.startTurn(undefined, '切换取消后的问题');
  test.creations[1].resolve({ sessionId: 'new-session' }); await next;
  const owner = test.context.activeRequestIdRef.current;
  if (lateResult === 'resolve') test.creations[0].resolve({ sessionId: 'obsolete-session', turns: { items: [] } });
  else test.creations[0].reject(new Error('obsolete navigation failure'));
  await transition;
  assert.equal(test.context.activeRequestIdRef.current, owner); assert.equal(test.context.assistantSessionId, 'new-session');
  assert.equal(test.context.messages.length, 2); assert.equal(test.submissions.length, 1);
  assert.equal(test.alerts.length, 0);
}
for (const operation of ['startNewAssistantSession', 'restoreAssistantSession']) {
  const test = harness({ currentNote: true });
  const transition = test.context[operation]({ sessionId: 'history' });
  test.creations[0].reject(new Error('会话操作失败')); await transition;
  assert.equal(test.context.activeRequestIdRef.current, null); assert.equal(test.context.activeRequestId, null);
  assert.equal(test.context.draft, '待发送问题'); assert.equal(test.context.attachments.length, 1);
  assert.deepEqual(test.alerts, ['会话操作失败']);
}
console.log('Assistant preparation ownership passed: double send, cancel, context change, late success/error, retry, current-note refresh/new/restore, onboarding refusal');
