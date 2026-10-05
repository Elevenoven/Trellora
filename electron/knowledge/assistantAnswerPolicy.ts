import type { AssistantAnswerDepth } from './assistantTurnTypes';

const ANSWER_QUALITY_POLICY_TEXT = '回答质量要求：先直接回答核心问题，再根据问题类型补足理解或行动所需的信息；不要因为问题简短就只给一句话，也不要用空泛铺垫凑字数。回答前静默检查是否覆盖了关键概念、必要限定和用户真正要解决的问题。用户明确指定篇幅或格式时优先遵循。不要输出内部分析、问题分类或检查过程。';

const ANSWER_DEPTH_POLICY_TEXT: Record<AssistantAnswerDepth, string> = {
  auto: '回答深度：自适应。事实类问题给出直接结论和必要限定；定义类问题通常说明“是什么、关键机制或特征、典型用途”，必要时给一个简短示例；原因、步骤和比较类问题应覆盖关键依据、步骤或取舍。信息足够后停止，不机械拉长。',
  concise: '回答深度：简洁。结论优先，只保留理解或行动所需的信息；通常使用一至三段或不超过五个要点。即使简洁，也不能省略关键限定条件。',
  detailed: '回答深度：详细。先给结论或概览，再在相关时说明原理、关键步骤、示例、适用边界、限制或常见误区；使用清晰的小标题或列表组织，避免重复和无依据扩写。',
};

/** Shared answer-shape policy for every assistant route. */
export function formatAnswerDepthRules(answerDepth: AssistantAnswerDepth = 'auto'): string {
  return `${ANSWER_QUALITY_POLICY_TEXT}\n${ANSWER_DEPTH_POLICY_TEXT[answerDepth]}`;
}
