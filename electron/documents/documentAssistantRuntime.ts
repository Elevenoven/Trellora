import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DocumentSnapshot } from '../../shared/documentSession';
import type { EffectiveContextWindow } from '../../shared/effectiveContextWindow';
import { extractHeadings } from '../noteIndex';
import { streamKnowledgeAnswer } from '../knowledge/assistantTurn';
import type { AssistantTurnRequest, AssistantTurnResult, CurrentNotePublicPlanEvent, CurrentNotePublicToolEvent } from '../knowledge/assistantTurnTypes';
import type { AiProviderConfig } from '../knowledge/aiTypes';
import type { AiJsonGenerationOptions } from '../knowledge/aiProvider';
import { createCurrentNoteSnapshot } from '../knowledge/currentNoteSnapshot';
import { createCurrentNotePrompt } from '../knowledge/currentNotePrompt';
import { runCurrentNoteAgent } from '../knowledge/currentNoteAgentGraph';
import { NoteConversationMemory } from '../knowledge/noteConversationMemory';
import { createStructuredActionDriver } from '../knowledge/structuredActionDriver';
import { createCurrentNotePlanDriver, type AssistantPlanMode } from '../knowledge/searchPlanDriver';
import { classifyCurrentNoteSummaryIntent, createNoteSummaryDriver, runCurrentNoteSummary } from '../knowledge/noteSummaryOrchestrator';
import { SECTION_DIGEST_VERSION, SectionDigestPurityGuard, type NoteDerivedDigestWrite } from '../knowledge/noteDerivedDigestRepository';
import { ModelCallPreparationError, type ModelCallCoordinator } from '../knowledge/modelCallCoordinator';
import type { AssistantDetailedTraceSink } from '../knowledge/assistantDetailedTrace';

/** 复用当前笔记引擎；文件父目录仅用于来源坐标，绝不注册、索引或检索目录。 */
export function createDocumentAssistantSnapshot(document: DocumentSnapshot) {
  const snapshot = createCurrentNoteSnapshot({
    libraryPath: path.dirname(document.displayPath),
    notePath: document.displayPath,
    title: path.basename(document.displayPath),
    contentHash: createHash('sha256').update(document.content, 'utf8').digest('hex'),
    markdown: document.content,
    headings: extractHeadings(document.content),
    revision: document.draftRevision,
  });
  const libraryId = `document-${document.documentSessionId}`;
  return { ...snapshot, libraryId, snapshotId: `snapshot-${createHash('sha256').update(`${libraryId}:${snapshot.contentHash}`).digest('hex').slice(0, 24)}` };
}

/** 已冻结的文件草稿独占本轮事实来源，不调用资料库检索或持久化会话记忆。 */
export async function runDocumentAssistant(input: {
  snapshot: ReturnType<typeof createDocumentAssistantSnapshot>;
  request: AssistantTurnRequest;
  providerConfig: AiProviderConfig;
  model: string;
  contextWindow: EffectiveContextWindow;
  skillInstructions: string[];
  signal: AbortSignal;
  coordinator: ModelCallCoordinator;
  planMode: AssistantPlanMode;
  isSnapshotCurrent: () => boolean;
  generateJson: (request: Omit<AiJsonGenerationOptions, 'model' | 'providerConfig' | 'thinkingMode'>) => Promise<unknown>;
  onDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onToolEvent: (event: CurrentNotePublicToolEvent) => void;
  onPlanEvent: (event: CurrentNotePublicPlanEvent) => void;
  onDetailedTrace: AssistantDetailedTraceSink;
}): Promise<Extract<AssistantTurnResult, { type: 'answer' }>> {
  const { snapshot, request, model, signal } = input;
  const startedAt = Date.now();
  const common = { snapshot, question: request.userText, conversation: request.conversation, providerKind: input.providerConfig.kind, model, contextWindowTokens: input.contextWindow.tokens, skillInstructions: input.skillInstructions, answerDepth: request.answerDepth };
  const prompt = createCurrentNotePrompt(common);
  const base = { type: 'answer' as const, provider: input.providerConfig.kind, model, sourceNotes: [{ path: snapshot.notePath, title: snapshot.title, snippet: snapshot.markdown.slice(0, 200), score: 1, methods: [], sourceType: 'note' as const }], retrievalMode: 'none' as const, interactionRoute: 'react' as const };
  input.onToolEvent({ tool: 'read_current_note', state: 'completed', message: `已读取当前文件《${snapshot.title}》的本轮草稿。` });
  const summaryMode = classifyCurrentNoteSummaryIntent(request.userText);
  if (summaryMode) {
    // 摘要只使用本轮临时产物，不在文件目录或已打开的库中写缓存。
    const guard = new SectionDigestPurityGuard();
    const summary = await runCurrentNoteSummary({
      snapshot, question: request.userText, providerKind: input.providerConfig.kind, model, signal,
      contextWindowTokens: input.contextWindow.tokens, isSnapshotCurrent: input.isSnapshotCurrent,
      driver: createNoteSummaryDriver({ generateJson: input.generateJson }),
      digestRepository: {
        findReusable: () => undefined,
        save: (value: NoteDerivedDigestWrite) => {
          guard.assertWrite(value);
          return { digestId: `document-digest-${randomUUID()}`, noteContentHash: value.contentHash, sectionId: value.sectionId, sectionHash: value.sectionHash, headingPath: [...value.headingPath], lineFrom: value.lineFrom, lineTo: value.lineTo, providerFingerprint: value.providerFingerprint, model: value.model, digestVersion: value.digestVersion ?? SECTION_DIGEST_VERSION, status: value.status, ...value.digest };
        },
      },
    }, summaryMode);
    input.onDelta(summary.answer);
    return { ...base, answer: summary.answer, contextUsage: summary.contextUsage, contextMode: summary.contextMode, evidence: summary.evidence, completeness: summary.completeness, toolStats: summary.toolStats, agentStats: summary.agentStats, prefixFingerprint: summary.prefixFingerprint, summaryCoverage: { mode: summary.mode, ...summary.coverage }, executionElapsedMs: Date.now() - startedAt };
  }
  if (prompt.contextMode === 'react-search') {
    const result = await runCurrentNoteAgent({
      ...common, signal, contextWindow: input.contextWindow, modelCallCoordinator: input.coordinator,
      driver: createStructuredActionDriver({ generateJson: input.generateJson }),
      planMode: input.planMode,
      planner: createCurrentNotePlanDriver({ generateJson: input.generateJson }),
      memory: new NoteConversationMemory(), memoryScopeKey: snapshot.libraryId,
      isSnapshotCurrent: input.isSnapshotCurrent,
      onToolEvent: input.onToolEvent, onPlanEvent: input.onPlanEvent, onDetailedTrace: input.onDetailedTrace,
    });
    input.onDelta(result.answer);
    return { ...base, answer: result.answer, contextUsage: result.contextUsage, contextMode: result.contextMode, evidence: result.evidence, completeness: result.completeness, toolStats: result.toolStats, agentStats: result.agentStats, prefixFingerprint: result.prefixFingerprint, executionElapsedMs: Date.now() - startedAt };
  }
  const prepared = input.coordinator.prepare({ callKind: 'direct', prompt: prompt.prompt });
  if (!prepared.ready) throw new ModelCallPreparationError(prepared.reason);
  const generation = await streamKnowledgeAnswer({
    ...common, sources: [], prompt: prompt.prompt, signal, providerConfig: input.providerConfig,
    thinkingMode: request.thinkingMode, contextWindow: input.contextWindow,
    preparedModelCall: prepared.call, modelCallKind: 'direct',
    onDelta: input.onDelta, onThinkingDelta: input.onThinkingDelta,
  });
  return { ...base, ...generation, contextMode: prompt.contextMode, prefixFingerprint: prompt.prefixFingerprint, executionElapsedMs: Date.now() - startedAt, ...(!input.isSnapshotCurrent() ? { isStale: true } : {}) };
}
