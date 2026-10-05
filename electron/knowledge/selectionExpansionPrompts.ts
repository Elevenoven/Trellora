import { createSelectionLengthReceipt } from '../../shared/selectionExpansionPolicy';
import type { SelectionEditValidation } from './selectionEditTypes';

/** Gives both entrypoints the same measured writing goal before the first candidate. */
export function buildExpansionLengthInstruction(selectedText: string, targetCharacters: number | undefined): string {
  const length = createSelectionLengthReceipt(selectedText, '', targetCharacters);
  return `\n扩写长度要求：原文 ${length.originalCharacters} 个有效字符，目标 ${length.targetCharacters}，最低通过长度 ${length.minimumCharacters}。请围绕选区，用完整句展开已验证原文中的细节、关系和限定条件，争取达到目标；不要把扩写写成压缩摘要或只摘抄几句原文。长度统计不计空白、Markdown 标记和链接地址，不用重复句凑数，不增加无依据事实。`;
}

/** Only the selection fragment supplies formatting; full-note headings do not become the edit target. */
export function buildExpansionMarkdownInstruction(selectedMarkdown: string): string {
  return `\n输出可直接写回的 Markdown 正文。保留选区已有的段落、标题层级、有序/无序列表、列表项、引用、加粗、斜体、删除线、行内代码、链接地址及代码块语言；逐项扩写列表，不合并成一段摘要。代码围栏是正文格式，应保留；不要给整篇结果额外套 Markdown 围栏，不附加说明、HTML 或 JSON。\n<selected_markdown trust="untrusted">\n${escapeExpansionData(selectedMarkdown)}\n</selected_markdown>`;
}

/** The previous candidate is data; measured deficits are trusted repair constraints. */
export function buildExpansionRepairInstruction(selectedText: string, candidate: string, targetCharacters: number | undefined, validation: SelectionEditValidation): string {
  const length = createSelectionLengthReceipt(selectedText, candidate, targetCharacters);
  return `\n<repair_contract trust="trusted">\n这是唯一一次修复。原文 ${length.originalCharacters} 个有效字符；目标 ${length.targetCharacters}；最低通过长度 ${length.minimumCharacters}；上一版实际 ${length.actualCharacters}；距离最低通过长度还差 ${length.missingToMinimum}；距离目标还差 ${length.missingToTarget}。有效字符按 Unicode 字符计数，不计空白、Markdown 标记和链接地址。\n问题：${(validation.issues ?? []).map((issue) => issue.code).join('、')}。在上一版基础上补充已验证原文中的细节、关系与条件，输出完整的新 Markdown 正文，保留原文关键信息及格式，修复丢失的标题、列表、引用或文字标记。长度不足时，至少补足最低通过长度的缺口，并争取达到目标；把已有事实和关系展开成完整解释，不能再次原样返回上一版或删减后返回更短的摘要。不得堆叠重复句、填充空白或增加无依据事实。只扩写选中文字，全文与证据只提供上下文。\n</repair_contract>\n<previous_candidate trust="untrusted">\n${escapeExpansionData(candidate)}\n</previous_candidate>`;
}

export function escapeExpansionData(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
