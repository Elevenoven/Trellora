/**
 * Wiki 节点快捷动作契约（方案 §5）。
 *
 * 本模块为纯类型 + 纯字符串常量，不引入任何 Node/Electron 运行时依赖，
 * 因此主进程与渲染进程都可安全导入（渲染进程仅按 `import type` 消费
 * `WikiActionKind`，菜单文案作为 UI 拷贝留在渲染进程侧）。
 */

/** 自由问答 + 六个快捷动作；'free' 为默认问答，不注入动作输出契约。 */
export const wikiActionKinds = [
  'free',
  'summarize',
  'key-conclusions',
  'troubleshooting',
  'review-outline',
  'split-children',
  'cross-links',
] as const;

export type WikiActionKind = typeof wikiActionKinds[number];

/** 快捷动作菜单定义（渲染进程 UI 拷贝的单一事实来源）。 */
export interface WikiQuickActionDefinition {
  id: WikiActionKind;
  label: string;
}

/**
 * 「总结本节」的输出策略：正文长度按源章节规模自适应，但永远不靠机械截断实现。
 * 字符数以可见中文正文为口径；Markdown 标记和引用号不计入目标长度。
 */
export interface WikiSummaryPolicy {
  sourceChars: number;
  targetMinChars: number;
  targetMaxChars: number;
  hardMaxChars: number;
  /** 用于服务商容量保护，不能替代可见正文长度约束。 */
  maxOutputTokens: number;
  requiresExpandedReading: boolean;
}

export const WIKI_SUMMARY_HARD_MAX_CHARS = 2_000;

export function resolveWikiSummaryPolicy(sourceChars: number): WikiSummaryPolicy {
  const safeSourceChars = Math.max(0, Math.floor(sourceChars));
  if (safeSourceChars <= 3_000) {
    return { sourceChars: safeSourceChars, targetMinChars: 300, targetMaxChars: 600, hardMaxChars: 800, maxOutputTokens: 1_400, requiresExpandedReading: false };
  }
  if (safeSourceChars <= 6_000) {
    return { sourceChars: safeSourceChars, targetMinChars: 600, targetMaxChars: 1_000, hardMaxChars: 1_200, maxOutputTokens: 1_800, requiresExpandedReading: false };
  }
  if (safeSourceChars <= 10_000) {
    return { sourceChars: safeSourceChars, targetMinChars: 600, targetMaxChars: 1_200, hardMaxChars: 1_400, maxOutputTokens: 2_000, requiresExpandedReading: true };
  }
  if (safeSourceChars <= 30_000) {
    return { sourceChars: safeSourceChars, targetMinChars: 1_000, targetMaxChars: 1_600, hardMaxChars: 1_800, maxOutputTokens: 2_600, requiresExpandedReading: true };
  }
  return { sourceChars: safeSourceChars, targetMinChars: 1_400, targetMaxChars: 1_900, hardMaxChars: WIKI_SUMMARY_HARD_MAX_CHARS, maxOutputTokens: 3_072, requiresExpandedReading: true };
}

/**
 * 六个快捷动作的菜单文案（保持现有中文不变，方案 §5）。
 * 顺序即菜单展示顺序；'free' 不出现在菜单里（对应自由输入框）。
 */
export const WIKI_QUICK_ACTIONS: readonly WikiQuickActionDefinition[] = [
  { id: 'summarize', label: '总结本节' },
  { id: 'key-conclusions', label: '提炼关键结论' },
  { id: 'troubleshooting', label: '生成排障步骤' },
  { id: 'review-outline', label: '生成复习提纲' },
  { id: 'split-children', label: '拆分为子节点' },
  { id: 'cross-links', label: '找出与其他章节的关联' },
];

export function isWikiActionKind(value: unknown): value is WikiActionKind {
  return typeof value === 'string' && (wikiActionKinds as readonly string[]).includes(value);
}

/**
 * 按 actionKind 产出注入 `<action_contract>` 的输出格式硬约束（方案 §5）。
 * 'free' 返回空串（不额外约束，走通用问答规范）。
 *
 * @param documentSearchAvailable cross-links 依赖 wiki_search_document；
 *   该工具未注册（P1/P2）时降级为"在已检索证据内说明关联"，避免诱导模型调用不存在的工具。
 */
export function buildWikiActionContract(
  actionKind: WikiActionKind,
  options: { documentSearchAvailable?: boolean; documentSearchCompleted?: boolean; summaryPolicy?: WikiSummaryPolicy } = {},
): string {
  switch (actionKind) {
    case 'summarize': {
      const summary = options.summaryPolicy ?? resolveWikiSummaryPolicy(0);
      const coverageRule = summary.requiresExpandedReading
        ? `当前节点正文约 ${summary.sourceChars} 字符，超过直载阈值。必须先用 wiki_read_node 按 char_offset 分页深读当前节点正文；在已覆盖关键段落和后续窗口前不得仅依据首尾节选直接总结。若章节过长而本轮读取预算不足，明确说明未覆盖的范围，不能假装已通读全文。`
        : `当前节点正文约 ${summary.sourceChars} 字符，已完整直载；可直接基于全文总结，必要时再用 wiki_read_node 核对细节。`;
      return [
        '<action_contract>',
        '  <task>总结本节</task>',
        '  <format>',
        '    1. 用「核心结论」概括本章节的目标、结论和适用边界。',
        '    2. 用「关键内容」按独立主题、规则、步骤或风险分组展开；不限制要点条数，每条可写 1–3 句。主题较多时优先用二级标题归类，而非压缩遗漏。',
        '    3. 原文存在时，再补充「关键参数 / 步骤」和「异常、回退与注意事项」；原文没有则不要凑项。',
        '  </format>',
        `  <length>可见正文通常写 ${summary.targetMinChars}–${summary.targetMaxChars} 字；内容本身较少时允许更短，但不得为了凑字数补写事实。可见正文不得超过 ${summary.hardMaxChars} 字；达到上限前应优先合并重复表述，不得机械截断句子。</length>`,
        `  <coverage>${coverageRule}</coverage>`,
        '  <constraint>只依据本章节直载全文与工具检索到的证据，事实句尾标注引用号 [n]；不得引入本章节之外的推测。</constraint>',
        '</action_contract>',
      ].join('\n');
    }
    case 'key-conclusions':
      return [
        '<action_contract>',
        '  <task>提炼关键结论</task>',
        '  <format>输出编号结论列表（1. 2. 3. …），每条不超过 60 字，且句尾带引用号 [n]。</format>',
        '  <constraint>只提炼本章节明确陈述的结论或判断，不得推测或补写未出现的结论；若本章节没有明确结论，如实说明。</constraint>',
        '</action_contract>',
      ].join('\n');
    case 'troubleshooting':
      return [
        '<action_contract>',
        '  <task>生成排障步骤</task>',
        '  <format>',
        '    输出有序排障步骤，依次包含：',
        '    1.「现象确认」：如何判断确实遇到了该问题。',
        '    2.「检查 / 操作」：逐步列出排查与处理动作，每步一句可执行的指令。',
        '    3.「回退条件」：满足什么条件时应停止或回退。',
        '  </format>',
        '  <constraint>步骤只能来自本章节证据并标注引用号 [n]；若本章节不含排障 / 故障处理语义，如实说明「本章节未涉及排障内容」，禁止编造通用步骤。</constraint>',
        '</action_contract>',
      ].join('\n');
    case 'review-outline':
      return [
        '<action_contract>',
        '  <task>生成复习提纲</task>',
        '  <format>输出层级复习提纲（至多 3 层缩进）；每个叶子节点写成一个可自答的复习问句，覆盖本章节主要知识点。</format>',
        '  <constraint>提纲内容必须源自本章节；问句应能通过本章节证据自答，不得指向章节外内容。</constraint>',
        '</action_contract>',
      ].join('\n');
    case 'split-children':
      return [
        '<action_contract>',
        '  <task>拆分为子节点</task>',
        '  <format>',
        '    1. 先用一小段说明拆分依据：本章节包含哪几个可独立的子主题、为什么这样切分。',
        '    2. 用有序列表列出建议的子节点标题（每个不超过 20 字），并为每个标题附一句不超过 60 字的内容概述。',
        '  </format>',
        '  <constraint>不要在此展开每个子节点的完整正文，子节点正文将由后续结构化步骤单独产出；标题与概述必须来自本章节证据。</constraint>',
        '</action_contract>',
      ].join('\n');
    case 'cross-links':
      return options.documentSearchAvailable
        ? [
          '<action_contract>',
          '  <task>找出与其他章节的关联</task>',
          '  <format>',
          '    按「关联到的其他章节」分组输出 bullet：每组先写关联章节的标题，再写关联点，并在句尾标注引用号 [n]。',
          '  </format>',
          `  <constraint>${options.documentSearchCompleted
            ? '系统已完成跨章节检索；只能使用 fallback_search_results 中已有的其他章节证据，不得请求或假装再次调用工具。'
            : '必须至少调用一次 wiki_search_document 检索本章节之外的内容；'}若没有命中任何关联，如实说明「未找到与其他章节的明确关联」，禁止编造。</constraint>`,
          '</action_contract>',
        ].join('\n')
        : [
          '<action_contract>',
          '  <task>找出与其他章节的关联</task>',
          '  <format>基于本章节证据，说明本章节在主题、术语或结论上可能与文档其他部分存在的关联，按关联点分条列出并标注引用号 [n]。</format>',
          '  <constraint>跨章节检索能力当前不可用，只能依据本章节已检索到的证据作合理说明，并明确标注这是基于本章节的推断；不得编造其他章节的具体内容。</constraint>',
          '</action_contract>',
        ].join('\n');
    case 'free':
    default:
      return '';
  }
}

/** cross-links 动作需要跨章节检索工具（wiki_search_document，P3 注册）。 */
export function wikiActionRequiresDocumentSearch(actionKind: WikiActionKind): boolean {
  return actionKind === 'cross-links';
}
