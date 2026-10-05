import { runReActLoop } from './reactAgent/reactEngine';
import type { ReActChatTransport } from './reactAgent/reactChatTransport';
import type { ReActToolRegistry } from './reactAgent/toolRegistry';
import { resolveSelectionEditAgentBudget, type SelectionEditAgentRuntimeInput, type SelectionEditAgentRuntimeOutcome, type SelectionEditResearchToolContext } from './selectionEditAgentRuntime';
import { buildSelectionEditAgentQuestion, normalizeSelectionEditAgentAnswer, selectionEditAgentTerminalPolicy } from './selectionEditAgentPrompt';
import { assertSelectionEditPromptFitsContext } from './selectionEditPromptBudget';
import { buildExpansionRepairInstruction } from './selectionExpansionPrompts';
import type { SelectionEditValidation } from './selectionEditTypes';
import type { AiProviderConfig } from './aiTypes';
import { resolveExpansionThinkingMode } from './selectionExpansionContext';

/** Reuse the native ReAct engine for research, while reserving synthesis and repair calls. */
export async function runAdaptiveExpansionAgent(args: {
  input: SelectionEditAgentRuntimeInput; providerConfig: AiProviderConfig; model: string; transport: ReActChatTransport;
  context: SelectionEditResearchToolContext; registry: ReActToolRegistry<SelectionEditResearchToolContext>;
  systemPrompt: string; question: string; validate: (text: string) => SelectionEditValidation;
}): Promise<SelectionEditAgentRuntimeOutcome> {
  const { input, providerConfig, model, transport, context, registry, systemPrompt, question, validate } = args;
  const budget = resolveSelectionEditAgentBudget(input.options?.reasoningDepth);
  const maxCalls = budget.maxModelCalls ?? 6;
  const researchCalls = maxCalls - 2;
  let modelCalls = 0;
  let firstCandidate: string | undefined;
  let secondCandidate: string | undefined;
  let toolCalls = 0;
  let researchRounds = 0;
  const assertCurrent = () => {
    if (input.signal.aborted) throw new DOMException('已取消扩写任务。', 'AbortError');
    if (!input.isSnapshotCurrent()) throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  };
  const boundedTransport: ReActChatTransport = {
    capability: 'native-tools',
    chat: async (config, request) => {
      assertCurrent();
      const serialized = JSON.stringify({ messages: request.messages, tools: request.tools });
      const promptBudget = assertSelectionEditPromptFitsContext({ config, model, action: 'expand', selectedText: input.request.snapshot.selectedText, prompt: serialized, targetCharacters: input.options?.targetCharacters });
      modelCalls += 1;
      if (request.tools.length) researchRounds += 1;
      return transport.chat(config, { ...request, maxOutputTokens: promptBudget.maxOutputTokens, thinkingMode: resolveExpansionThinkingMode(config, model) });
    },
  };
  input.onStatus?.('正在通过 ReAct 定位并深读与选区相关的原文…');
  // One candidate-only seed lets fast mode spend its decision on an actual read.
  // It has the same candidate admission and tool budget as a native search call.
  let seedObservation = '';
  const terms = input.goals[0]?.queryTerms.filter((term) => term.length >= 2 && term.length <= 80).slice(0, 6) ?? [];
  if (context.currentNoteSnapshot && terms.length) {
    const search = registry.get('search_note');
    if (search) {
      assertCurrent();
      toolCalls += 1;
      const seed = await search.execute({ terms, limit: 6 }, context);
      seedObservation = `\n以下只是已核验的候选定位，必须深读后才能作为事实依据：\n${seed.observation}`;
    }
  }
  let researchWarning: string | undefined;
  try {
    await runReActLoop({
      systemPrompt, history: [], question: question + seedObservation, model, config: providerConfig, transport: boundedTransport,
      registry, toolContext: context, signal: input.signal, temperature: 0.25,
      budget: { ...budget, maxModelCalls: maxCalls - 1, maxToolCalls: Math.max(0, (budget.maxToolCalls ?? 8) - toolCalls), contextConsolidationThreshold: 0 },
      terminalPolicy: { ...selectionEditAgentTerminalPolicy, synthesisInstruction: '原文研究结束，仅输出 <final_answer> 包裹的选区扩写 Markdown，保留选区的标题、列表、引用和文字格式，代码块保留围栏及语言。不要编辑说明，不要调用工具。' },
      // Engine fallback synthesis is owned below, so it cannot spend reserved calls or leak a salvage summary.
      onModelCall: ({ callIndex }) => callIndex === Number.MAX_SAFE_INTEGER || modelCalls >= (firstCandidate === undefined ? researchCalls : maxCalls - 1)
        ? { ready: false, reason: 'expansion-synthesis-reserved' } : { ready: true },
      onBeforeFinalAnswer: ({ answer }) => {
        const candidate = normalizeSelectionEditAgentAnswer(answer, 'expand');
        if (firstCandidate !== undefined) { secondCandidate = candidate; return { accept: true }; }
        firstCandidate = candidate;
        const validation = validate(candidate);
        const needsRead = (validation.issues ?? []).some((issue) => ['EVIDENCE_GOAL_UNCOVERED', 'UNSUPPORTED_ADDITION'].includes(issue.code));
        if (!validation.passed && needsRead && modelCalls < maxCalls - 1) return {
          accept: false,
          nudge: buildExpansionRepairInstruction(input.request.snapshot.selectedText, candidate, input.options?.targetCharacters, validation)
            + '\n缺少已核验原文，请先继续搜索并深读；仍为最终修复预留一次模型调用。若现在输出第二版正文，它将计为唯一修复，不再生成第三版。',
        };
        return { accept: true };
      },
      onRound: ({ state }) => { if (state === 'started' || state === 'rejected') toolCalls += 1; },
    });
  } catch (error) {
    assertCurrent();
    if (firstCandidate === undefined) throw error;
    researchWarning = `补充研究未完成：${error instanceof Error ? error.message : String(error)}`;
  }
  assertCurrent();
  const evidence = [...input.preloadedEvidence, ...context.session.evidenceItems()];
  const synthesize = async (previous?: string, validation?: SelectionEditValidation): Promise<string> => {
    assertCurrent();
    if (modelCalls >= maxCalls) throw new Error('扩写模型调用预算已用尽。');
    const prompt = buildSelectionEditAgentQuestion({ request: input.request, goals: input.goals, preloadedEvidence: evidence, options: input.options, personalization: input.personalization })
      + '\n只扩写 selection_target 中的选中文字；全文和已深读原文只作为上下文。有效字符不计空白。只输出最终正文，保留原文锚点和事实。'
      + (previous !== undefined && validation ? buildExpansionRepairInstruction(input.request.snapshot.selectedText, previous, input.options?.targetCharacters, validation) : '');
    const response = await boundedTransport.chat(providerConfig, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], tools: [], model, signal: input.signal, temperature: 0.25,
    });
    assertCurrent();
    if (response.toolCalls.length) throw new Error('合成阶段返回了工具调用，请切换支持当前工具协议的模型。');
    return normalizeSelectionEditAgentAnswer(response.content, 'expand');
  };
  let text = secondCandidate ?? firstCandidate ?? (evidence.length ? await synthesize() : '');
  let validation = validate(text);
  let repairAttempts = secondCandidate === undefined ? 0 : 1;
  if (!repairAttempts && !validation.passed && evidence.length && (validation.issues ?? []).some((issue) => issue.retryable && !['EVIDENCE_GOAL_UNCOVERED', 'WEB_PAGE_UNVERIFIED'].includes(issue.code))) {
    input.onStatus?.('正在根据上一版正文与实际长度修复扩写（1/1）…');
    const beforeCalls = modelCalls;
    try {
      text = await synthesize(text, validation);
      validation = validate(text);
    } catch (error) {
      assertCurrent();
      validation.warnings.push(`修复未完成，保留上一版建议：${error instanceof Error ? error.message : String(error)}`);
      validation.passed = false;
    }
    repairAttempts = modelCalls > beforeCalls ? 1 : 0;
  }
  if (researchWarning) validation.warnings.push(researchWarning);
  return { kind: 'completed', text, evidence: context.session.evidenceItems(), receipt: context.session.receipt(), validation,
    rounds: researchRounds, modelCalls, toolCalls, repairAttempts };
}
