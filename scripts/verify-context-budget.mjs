import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-context-budget');
const files = {
  window: path.join(outDir, 'window.cjs'),
  gate: path.join(outDir, 'gate.cjs'),
  scheduler: path.join(outDir, 'scheduler.cjs'),
  error: path.join(outDir, 'error.cjs'),
  coordinator: path.join(outDir, 'coordinator.cjs'),
};

if (process.env.MENGHAN_CONTEXT_BUDGET_PREBUILT !== '1') {
  await Promise.all([
    build({ entryPoints: [path.join(rootDir, 'shared', 'effectiveContextWindow.ts')], outfile: files.window, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallBudget.ts')], outfile: files.gate, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'currentNoteContextBudget.ts')], outfile: files.scheduler, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiProviderError.ts')], outfile: files.error, bundle: true, platform: 'node', format: 'cjs' }),
    build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'modelCallCoordinator.ts')], outfile: files.coordinator, bundle: true, platform: 'node', format: 'cjs' }),
  ]);
}

const { resolveEffectiveContextWindow, CONSERVATIVE_CONTEXT_WINDOW_TOKENS } = await import(pathToFileURL(files.window).href);
const { ModelCallBudgetGate } = await import(pathToFileURL(files.gate).href);
const { PromptBudgetScheduler } = await import(pathToFileURL(files.scheduler).href);
const { AI_CONTEXT_OVERFLOW, createAiProviderHttpError, isAiContextOverflow } = await import(pathToFileURL(files.error).href);
const { ModelCallCoordinator } = await import(pathToFileURL(files.coordinator).href);

const defaultWindow = resolveEffectiveContextWindow();
assert.equal(defaultWindow.tokens, CONSERVATIVE_CONTEXT_WINDOW_TOKENS);
assert.equal(defaultWindow.tokens, 200_000);
assert.equal(defaultWindow.source, 'conservative-default');
assert.equal(defaultWindow.confidence, 'estimated');
assert.equal(defaultWindow.runtimeProfile.runtimeProfileId, 'conservative-200k');

const providerWindow = resolveEffectiveContextWindow({ discoveredModelWindow: 32_768, discoveredSource: 'provider', configuredModelWindow: 64_000 });
assert.equal(providerWindow.tokens, 32_768);
assert.equal(providerWindow.source, 'provider');

const cappedWindow = resolveEffectiveContextWindow({ discoveredModelWindow: 64_000, discoveredSource: 'ollama', configuredModelWindow: 16_000 });
assert.equal(cappedWindow.tokens, 16_000);
assert.equal(cappedWindow.source, 'configured');

const defaultPlan = new PromptBudgetScheduler().plan({ prompt: '当前问题：如何保存？', callKind: 'decide' });
assert.equal(defaultPlan.contextWindowTokens, 200_000);
assert.equal(defaultPlan.maxOutputTokens, 4_096);
assert.equal(defaultPlan.safetyReserveTokens, 6_250);
assert.equal(defaultPlan.maxPromptTokens, 189_654);

const scheduler = new PromptBudgetScheduler();
const smallPlan = scheduler.plan({ prompt: '当前问题：如何保存？', contextWindowTokens: 16_384, callKind: 'decide' });
assert.equal(smallPlan.maxOutputTokens, 2_048);
assert.equal(smallPlan.safetyReserveTokens, 2_048);
assert.equal(smallPlan.maxPromptTokens, 12_288);
assert.equal(smallPlan.fits, true);
const oversizedPlan = scheduler.plan({ prompt: '甲'.repeat(13_000), contextWindowTokens: 16_384, callKind: 'decide' });
assert.equal(oversizedPlan.fits, false);

const gate = new ModelCallBudgetGate({ maxModelCalls: 8, maxWallTimeMs: 60_000 });
const plannerTicket = gate.reserve({ callKind: 'plan', budgetKind: 'react-turn' });
assert.ok(plannerTicket);
gate.markSent(plannerTicket);
for (let index = 0; index < 6; index += 1) {
  const ticket = gate.reserve({ callKind: 'decide', budgetKind: 'react-turn' });
  assert.ok(ticket);
  gate.markSent(ticket);
}
assert.equal(gate.modelCalls, 7);
assert.equal(gate.reserve({ callKind: 'decide', budgetKind: 'react-turn' }), undefined);
const finalTicket = gate.reserve({ callKind: 'synthesize', budgetKind: 'react-turn' });
assert.ok(finalTicket);
assert.equal(finalTicket.remainingModelCallsAfterSend, 0);
gate.markSent(finalTicket);
assert.equal(gate.modelCalls, 8);

const unboundedGate = new ModelCallBudgetGate({ maxModelCalls: 2, startedAt: 0 });
assert.equal(unboundedGate.deadlineAtMs, undefined);
const unboundedTicket = unboundedGate.reserve({ callKind: 'decide', budgetKind: 'react-turn' });
assert.ok(unboundedTicket);
assert.equal(unboundedTicket.deadlineAt, undefined);

const overflow = createAiProviderHttpError(413, 'maximum context length is 32768 tokens');
assert.equal(overflow.code, AI_CONTEXT_OVERFLOW);
assert.equal(overflow.providerLimitTokens, 32768);
assert.equal(isAiContextOverflow(overflow), true);

const coordinatorGate = new ModelCallBudgetGate({ maxModelCalls: 8, maxWallTimeMs: 60_000 });
const coordinator = new ModelCallCoordinator(coordinatorGate, 16_384, 'react-turn');
const routeCall = coordinator.prepare({ callKind: 'route-classify', prompt: '只输出 route JSON' });
assert.equal(routeCall.ready, true);
const rejectedCall = coordinator.prepare({ callKind: 'decide', prompt: '甲'.repeat(13_000) });
assert.equal(rejectedCall.ready, false);
assert.equal(rejectedCall.reason, 'context-budget');
assert.equal(coordinatorGate.modelCalls, 1, 'Prompt veto 不能消费未发送票据');

console.log('Context budget verification passed');
