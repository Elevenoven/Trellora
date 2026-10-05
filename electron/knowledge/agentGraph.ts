import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AiInsightPayload } from './aiTypes';
import type { LearningPlanStep, OrganizationSuggestionGroup } from './libraryAiTypes';
import type { NoteAnalysisPayload } from './noteAnalysisTypes';

export type KnowledgeAgentTask =
  | { type: 'summary'; markdown: string; model: string }
  | { type: 'tags'; markdown: string; model: string }
  | { type: 'analyze'; markdown: string; model: string; currentTags: string[]; libraryTags: string[] }
  | { type: 'answer'; question: string; model: string; sources: Array<{ title: string; content: string }> }
  | { type: 'plan'; goal: string; model: string; sources: Array<{ title: string; content: string }> }
  | { type: 'organize'; model: string; notes: Array<{ title: string; tags: string[]; headings: string[] }> };

export type KnowledgeAgentResult =
  | { type: 'summary'; summary: string; keyPoints: string[] }
  | { type: 'tags'; suggestedTags: string[] }
  | ({ type: 'analyze' } & NoteAnalysisPayload)
  | { type: 'answer'; answer: string; sources: string[] }
  | { type: 'plan'; steps: LearningPlanStep[]; sources: string[] }
  | { type: 'organize'; groups: OrganizationSuggestionGroup[]; nextActions: string[] };

export interface KnowledgeAgentDependencies {
  summarize(task: Extract<KnowledgeAgentTask, { type: 'summary' }>): Promise<AiInsightPayload>;
  suggestTags(task: Extract<KnowledgeAgentTask, { type: 'tags' }>): Promise<AiInsightPayload>;
  analyze(task: Extract<KnowledgeAgentTask, { type: 'analyze' }>): Promise<NoteAnalysisPayload>;
  answer(task: Extract<KnowledgeAgentTask, { type: 'answer' }>): Promise<string>;
  plan(task: Extract<KnowledgeAgentTask, { type: 'plan' }>): Promise<LearningPlanStep[]>;
  organize(task: Extract<KnowledgeAgentTask, { type: 'organize' }>): Promise<{ groups: OrganizationSuggestionGroup[]; nextActions: string[] }>;
}

const AgentState = Annotation.Root({
  task: Annotation<KnowledgeAgentTask>,
  result: Annotation<KnowledgeAgentResult | null>({ default: () => null }),
});

export function createKnowledgeAgentGraph(dependencies: KnowledgeAgentDependencies) {
  return new StateGraph(AgentState)
    .addNode('supervisor', () => ({}))
    .addNode('summary_agent', async (state) => {
      const task = expectTask(state.task, 'summary');
      const insight = await dependencies.summarize(task);
      return { result: { type: 'summary', summary: insight.summary, keyPoints: insight.keyPoints } };
    })
    .addNode('tag_agent', async (state) => {
      const task = expectTask(state.task, 'tags');
      const insight = await dependencies.suggestTags(task);
      return { result: { type: 'tags', suggestedTags: insight.suggestedTags } };
    })
    .addNode('analysis_agent', async (state) => ({ result: { type: 'analyze', ...await dependencies.analyze(expectTask(state.task, 'analyze')) } }))
    .addNode('assistant_agent', async (state) => {
      const task = expectTask(state.task, 'answer');
      return { result: { type: 'answer', answer: await dependencies.answer(task), sources: task.sources.map((source) => source.title) } };
    })
    .addNode('planning_agent', async (state) => {
      const task = expectTask(state.task, 'plan');
      return { result: { type: 'plan', steps: await dependencies.plan(task), sources: task.sources.map((source) => source.title) } };
    })
    .addNode('organization_agent', async (state) => {
      const task = expectTask(state.task, 'organize');
      const result = await dependencies.organize(task);
      return { result: { type: 'organize', ...result } };
    })
    .addEdge(START, 'supervisor')
    .addConditionalEdges('supervisor', (state) => ({
      summary: 'summary_agent',
      tags: 'tag_agent',
      analyze: 'analysis_agent',
      answer: 'assistant_agent',
      plan: 'planning_agent',
      organize: 'organization_agent',
    })[state.task.type])
    .addEdge('summary_agent', END)
    .addEdge('tag_agent', END)
    .addEdge('analysis_agent', END)
    .addEdge('assistant_agent', END)
    .addEdge('planning_agent', END)
    .addEdge('organization_agent', END)
    .compile();
}

export async function runKnowledgeAgent(dependencies: KnowledgeAgentDependencies, task: KnowledgeAgentTask): Promise<KnowledgeAgentResult> {
  const output = await createKnowledgeAgentGraph(dependencies).invoke({ task });
  if (!output.result) throw new Error('知识 Agent 未返回结果。');
  return output.result;
}

function expectTask<Type extends KnowledgeAgentTask['type']>(
  task: KnowledgeAgentTask,
  type: Type,
): Extract<KnowledgeAgentTask, { type: Type }> {
  if (task.type !== type) throw new Error(`Supervisor Agent 将任务错误分配给 ${type}。`);
  return task as Extract<KnowledgeAgentTask, { type: Type }>;
}
