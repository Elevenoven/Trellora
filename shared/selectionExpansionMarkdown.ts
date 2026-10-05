import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  children?: MarkdownNode[];
}
const parser = unified().use(remarkParse).use(remarkGfm);

/** Remove the transport envelope while preserving the document's Markdown and code. */
export function normalizeExpansionMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim()
    .replace(/^<final_answer>\s*([\s\S]*?)\s*<\/final_answer>$/u, '$1').trim();
}

/** Length is measured on the rendered text; Markdown markers and link destinations do not pad it. */
export function expansionMarkdownText(value: string): string {
  const text = (node: MarkdownNode): string => {
    if (node.type === 'image') return node.value ?? '';
    if (node.value !== undefined) return node.value;
    const separator = ['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'].includes(node.type) ? '\n' : '';
    return (node.children ?? []).map(text).join(separator);
  };
  return text(parser.parse(normalizeExpansionMarkdown(value)) as MarkdownNode);
}

/** A formatted source must not silently become an unformatted summary. */
export function expansionMarkdownFormatLosses(source: string, candidate: string): string[] {
  const formats = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const walk = (node: MarkdownNode): void => {
      const kind = node.type === 'heading' ? `heading-${node.depth}`
        : node.type === 'list' ? node.ordered ? 'ordered-list' : 'bullet-list'
          : ['listItem', 'blockquote', 'code', 'inlineCode', 'strong', 'emphasis', 'delete', 'link', 'table', 'break'].includes(node.type) ? node.type : undefined;
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      node.children?.forEach(walk);
    };
    walk(parser.parse(value) as MarkdownNode);
    return counts;
  };
  const actual = formats(candidate);
  return [...formats(source)].filter(([kind, count]) => (actual.get(kind) ?? 0) < count).map(([kind]) => kind);
}

export function hasExpansionRawHtml(value: string): boolean {
  const containsHtml = (node: MarkdownNode): boolean => node.type === 'html' || Boolean(node.children?.some(containsHtml));
  return containsHtml(parser.parse(value) as MarkdownNode);
}
