import { createHash } from 'node:crypto';
import { parseFrontmatterMapping } from '../../shared/frontmatter';
import { unified } from 'unified';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkWikiLink from 'remark-wiki-link';
import { visit } from 'unist-util-visit';
import { parseFragment } from 'parse5';
import type { KnowledgeHeading, KnowledgeWikiLink, MarkdownKnowledgeFacts } from './types';

interface AstNode {
  type: string;
  value?: string;
  depth?: number;
  children?: AstNode[];
  data?: {
    alias?: string;
  };
  position?: {
    start?: {
      line?: number;
    };
    end?: {
      line?: number;
    };
  };
}

export interface MarkdownTextBlock {
  heading?: string;
  text: string;
}

export type MarkdownEvidenceBlockKind = 'frontmatter' | 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table';

export interface MarkdownEvidenceBlock {
  kind: MarkdownEvidenceBlockKind;
  lineFrom: number;
  lineTo: number;
  text: string;
}

interface HtmlAstNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlAstNode[];
  sourceCodeLocation?: {
    startLine?: number;
  };
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkWikiLink as never, { aliasDivider: '|' });

const inlineTagPattern = /(^|[\s([{，。；：、])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]}，。；：、,.!?])/gu;

export const KNOWLEDGE_PARSER_VERSION = '2.0.1';

export function extractMarkdownKnowledgeFacts(markdown: string): MarkdownKnowledgeFacts {
  const tree = parser.parse(normalizeLegacyAtxHeadings(markdown)) as AstNode;
  const headingCandidates: Array<Omit<KnowledgeHeading, 'id' | 'index'>> = [];
  const tags = new Set<string>();
  const outgoingLinks: KnowledgeWikiLink[] = [];
  const textFragments: string[] = [];
  let frontmatter: Record<string, unknown> = {};

  visit(tree as never, (node: AstNode) => node.type === 'yaml', (node: AstNode) => {
    frontmatter = {
      ...frontmatter,
      ...parseFrontmatter(node.value ?? ''),
    };
  });

  for (const tag of normalizeFrontmatterTags(frontmatter.tags)) {
    tags.add(tag);
  }

  visit(tree as never, (node: AstNode) => node.type === 'heading', (node: AstNode) => {
    const text = getNodeText(node).trim();
    const depth = node.depth;
    if (!text || !depth || depth < 1 || depth > 6) return;
    headingCandidates.push({
      level: depth as KnowledgeHeading['level'],
      text,
      line: node.position?.start?.line ?? 1,
    });
  });

  visit(tree as never, (node: AstNode) => node.type === 'html', (node: AstNode) => {
    const html = node.value ?? '';
    if (!html) return;
    const fragment = parseFragment(html, { sourceCodeLocationInfo: true }) as unknown as HtmlAstNode;
    collectHtmlHeadingCandidates(fragment, node.position?.start?.line ?? 1, headingCandidates);
  });

  visit(tree as never, (node: AstNode) => node.type === 'wikiLink', (node: AstNode) => {
    const target = node.value?.trim();
    const alias = node.data?.alias?.trim();
    if (!target) return;
    outgoingLinks.push(alias && alias !== target ? { target, alias } : { target });
  });

  visit(tree as never, (node: AstNode) => node.type === 'text', (node: AstNode) => {
    const value = node.value ?? '';
    if (!value) return;
    textFragments.push(value);
    collectInlineTags(value, tags);
  });

  visit(tree as never, (node: AstNode) => node.type === 'inlineCode' || node.type === 'code', (node: AstNode) => {
    if (node.value) textFragments.push(node.value);
  });

  const headings = headingCandidates
    .sort((first, second) => first.line - second.line)
    .map((heading, index) => ({
      ...heading,
      id: slugifyHeading(heading.text, index),
      index,
    }));

  return {
    frontmatter: normalizeFrontmatter(frontmatter),
    headings,
    tags: [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    outgoingLinks,
    plainText: textFragments.join('\n').replace(/\s+/g, ' ').trim(),
    contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
  };
}

export function extractMarkdownTextBlocks(markdown: string): MarkdownTextBlock[] {
  const tree = parser.parse(normalizeLegacyAtxHeadings(markdown)) as AstNode;
  const blocks: MarkdownTextBlock[] = [];
  let heading: string | undefined;

  for (const node of tree.children ?? []) {
    if (node.type === 'yaml' || node.type === 'toml') continue;
    if (node.type === 'heading') {
      const nextHeading = getNodeText(node).replace(/\s+/g, ' ').trim();
      if (nextHeading) heading = nextHeading;
      continue;
    }
    const text = node.type === 'html'
      ? getHtmlNodeText(parseFragment(node.value ?? '') as unknown as HtmlAstNode)
      : getNodeText(node);
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized) blocks.push(heading ? { heading, text: normalized } : { text: normalized });
  }
  return blocks;
}

/**
 * Keeps top-level Markdown structures intact so callers can later read the
 * original source range rather than a flattened plain-text projection.
 */
export function extractMarkdownEvidenceBlocks(markdown: string): MarkdownEvidenceBlock[] {
  const normalizedMarkdown = normalizeLegacyAtxHeadings(markdown);
  const tree = parser.parse(normalizedMarkdown) as AstNode;
  const lines = markdown.split(/\r\n|\n|\r/u);
  const blocks: MarkdownEvidenceBlock[] = [];

  for (const node of tree.children ?? []) {
    const kind = toEvidenceBlockKind(node.type);
    const lineFrom = node.position?.start?.line;
    const lineTo = node.position?.end?.line;
    if (!kind || !lineFrom || !lineTo) continue;
    const boundedFrom = Math.max(1, Math.min(lineFrom, lines.length));
    const boundedTo = Math.max(boundedFrom, Math.min(lineTo, lines.length));
    const text = lines.slice(boundedFrom - 1, boundedTo).join('\n');
    if (!text.trim()) continue;
    blocks.push({ kind, lineFrom: boundedFrom, lineTo: boundedTo, text });
  }

  return blocks;
}

function toEvidenceBlockKind(type: string): MarkdownEvidenceBlockKind | null {
  if (type === 'yaml' || type === 'toml') return 'frontmatter';
  if (type === 'heading') return 'heading';
  if (type === 'paragraph' || type === 'html') return 'paragraph';
  if (type === 'list') return 'list';
  if (type === 'blockquote') return 'quote';
  if (type === 'code') return 'code';
  if (type === 'table') return 'table';
  return null;
}

function collectHtmlHeadingCandidates(
  node: HtmlAstNode,
  markdownStartLine: number,
  candidates: Array<Omit<KnowledgeHeading, 'id' | 'index'>>,
): void {
  const tagName = node.tagName?.toLowerCase();
  if (tagName === 'pre' || tagName === 'code') return;

  if (tagName && /^h[1-6]$/.test(tagName)) {
    const text = getHtmlNodeText(node).replace(/\s+/g, ' ').trim();
    if (text) {
      candidates.push({
        level: Number(tagName.slice(1)) as KnowledgeHeading['level'],
        text,
        line: markdownStartLine + (node.sourceCodeLocation?.startLine ?? 1) - 1,
      });
    }
    return;
  }

  for (const child of node.childNodes ?? []) {
    collectHtmlHeadingCandidates(child, markdownStartLine, candidates);
  }
}

function getHtmlNodeText(node: HtmlAstNode): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(getHtmlNodeText).join('');
}

function normalizeLegacyAtxHeadings(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? '';
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }

    if (!fence) {
      lines[index] = line.replace(/^( {0,3}#{1,6})(?=[^\s#])/u, '$1 ');
    }
  }

  return lines.join('');
}

function parseFrontmatter(value: string): Record<string, unknown> {
  if (!value.trim()) return {};

  try {
    return parseFrontmatterMapping(value);
  } catch {
    return {};
  }
}

function normalizeFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeFrontmatterValue(entry)]),
  );
}

function normalizeFrontmatterValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(normalizeFrontmatterValue);
  if (value && typeof value === 'object') return normalizeFrontmatter(value as Record<string, unknown>);
  return value;
}

function normalizeFrontmatterTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map((tag) => normalizeTag(String(tag))).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map(normalizeTag).filter(Boolean);
  return [];
}

function collectInlineTags(value: string, tags: Set<string>): void {
  inlineTagPattern.lastIndex = 0;
  for (const match of value.matchAll(inlineTagPattern)) {
    const tag = normalizeTag(match[2] ?? '');
    if (tag) tags.add(tag);
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '');
}

function getNodeText(node: AstNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(getNodeText).join('');
}

function slugifyHeading(text: string, index: number): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `heading-${index + 1}`;
}
