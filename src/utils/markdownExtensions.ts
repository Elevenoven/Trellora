import type { MarkedExtension, Token, Tokens } from 'marked';
import { parseFrontmatterMapping } from '../../shared/frontmatter';

export type MarkdownFrontmatterMode = 'preserve' | 'strip';

export interface MarkdownDiagnostic {
  code: 'frontmatter-invalid' | 'frontmatter-unclosed';
  severity: 'warning';
  message: string;
}

export interface PreparedMarkdownDocument {
  markdown: string;
  diagnostics: MarkdownDiagnostic[];
}

interface FootnoteDefinition {
  id: string;
  domId: string;
  html: string;
  referenceIds: string[];
}

interface FootnoteDefinitionToken extends Tokens.Generic {
  type: 'footnoteDefinition';
  definitionId: string;
  primary: boolean;
  tokens: Token[];
}

interface FootnoteReferenceToken extends Tokens.Generic {
  type: 'footnoteReference';
  definitionId: string;
}

interface CalloutToken extends Tokens.Generic {
  type: 'callout';
  calloutType: string;
  titleTokens: Token[];
  tokens: Token[];
}

const frontmatterOpeningPattern = /^\uFEFF?---[ \t]*\r?\n/;
const frontmatterClosingPattern = /^---[ \t]*(?:\r?\n|$)/m;
const footnoteReferencePattern = /^\[\^([^\]\r\n]+)\]/;
const wikiLinkPattern = /^\[\[([^\]|\r\n]+?)(?:\|([^\]\r\n]+?))?\]\]/;
const supportedCalloutTypes = new Set([
  'note',
  'info',
  'tip',
  'warning',
  'danger',
  'todo',
  'question',
  'success',
  'failure',
  'bug',
  'example',
  'quote',
]);

export function prepareMarkdownDocument(
  markdown: string,
  frontmatter: MarkdownFrontmatterMode = 'preserve',
): PreparedMarkdownDocument {
  if (frontmatter === 'preserve') return { markdown, diagnostics: [] };

  const opening = frontmatterOpeningPattern.exec(markdown);
  if (!opening) return { markdown, diagnostics: [] };

  const remaining = markdown.slice(opening[0].length);
  const closing = frontmatterClosingPattern.exec(remaining);
  if (!closing) {
    return {
      markdown,
      diagnostics: [{
        code: 'frontmatter-unclosed',
        severity: 'warning',
        message: 'Frontmatter 缺少闭合分隔符，已按原文显示。',
      }],
    };
  }

  const frontmatterSource = remaining.slice(0, closing.index);
  try {
    const parsed = parseFrontmatterMapping(frontmatterSource);
    if (parsed !== undefined && !isPlainRecord(parsed)) {
      throw new TypeError('Frontmatter root must be a mapping.');
    }

    return {
      markdown: remaining.slice(closing.index + closing[0].length),
      diagnostics: [],
    };
  } catch {
    return {
      markdown,
      diagnostics: [{
        code: 'frontmatter-invalid',
        severity: 'warning',
        message: 'Frontmatter 解析失败，已按原文显示。',
      }],
    };
  }
}

export function createWikiLinkExtension(): MarkedExtension {
  return {
    extensions: [{
      name: 'wikiLink',
      level: 'inline',
      start(src) {
        const index = src.indexOf('[[');
        return index >= 0 ? index : undefined;
      },
      tokenizer(src) {
        const match = wikiLinkPattern.exec(src);
        if (!match) return undefined;

        const target = match[1].trim();
        if (!target) return undefined;
        return {
          type: 'wikiLink',
          raw: match[0],
          target,
          alias: match[2]?.trim() || undefined,
        };
      },
      renderer(token) {
        const target = String(token.target);
        const alias = typeof token.alias === 'string' ? token.alias : undefined;
        const label = alias || target;
        return `<a href="menghan://wiki/${encodeURIComponent(target)}" data-wiki-link="${escapeHtmlAttribute(target)}"${alias ? ` data-wiki-alias="${escapeHtmlAttribute(alias)}"` : ''}>${escapeHtmlText(label)}</a>`;
      },
    }],
  };
}

/** Accept AI emphasis with inner spaces or Chinese text next to a closing punctuation mark. */
export function createRelaxedStrongExtension(): MarkedExtension {
  return {
    extensions: [{
      name: 'relaxedStrong',
      level: 'inline',
      start(src) {
        return /(?<![\\*])\*\*(?!\*)/.exec(src)?.index;
      },
      tokenizer(src) {
        if (!src.startsWith('**') || src.startsWith('***')) return undefined;
        // Skip escapes and complete code spans when looking for the closing marker.
        const candidate = /^\*\*((?:\\[^\r\n]|(`+)[^\r\n]*?\2(?!`)|[^\\`\r\n])*?)\*\*(?!\*)/.exec(src);
        if (!candidate || !candidate[1].trim() || candidate[1].startsWith('*')) return undefined;
        return {
          type: 'relaxedStrong',
          raw: candidate[0],
          tokens: this.lexer.inlineTokens(candidate[1]),
        };
      },
      renderer(token) {
        return `<strong>${this.parser.parseInline(token.tokens as Token[])}</strong>`;
      },
    }],
  };
}

export function createPreviewMarkdownExtension(): MarkedExtension {
  const definitions = new Map<string, FootnoteDefinition>();
  let nextDefinitionIndex = 1;

  return {
    extensions: [
      {
        name: 'footnoteDefinition',
        level: 'block',
        start(src) {
          const match = /\n\[\^[^\]\r\n]+\]:/.exec(src);
          return match ? match.index + 1 : undefined;
        },
        tokenizer(src) {
          const parsed = readFootnoteDefinition(src);
          if (!parsed) return undefined;

          const existing = definitions.get(parsed.id);
          const primary = !existing;
          if (primary) {
            definitions.set(parsed.id, {
              id: parsed.id,
              domId: createFootnoteDomId(parsed.id, nextDefinitionIndex, definitions),
              html: '',
              referenceIds: [],
            });
            nextDefinitionIndex += 1;
          }

          return {
            type: 'footnoteDefinition',
            raw: parsed.raw,
            definitionId: parsed.id,
            primary,
            tokens: this.lexer.blockTokens(parsed.markdown),
          } satisfies FootnoteDefinitionToken;
        },
        renderer(token) {
          const definitionToken = token as FootnoteDefinitionToken;
          const definition = definitions.get(definitionToken.definitionId);
          if (definition && definitionToken.primary) {
            definition.html = this.parser.parse(definitionToken.tokens);
          }
          return '';
        },
        childTokens: ['tokens'],
      },
      {
        name: 'callout',
        level: 'block',
        start(src) {
          const match = /\n {0,3}>[ \t]?\[![a-z]/i.exec(src);
          return match ? match.index + 1 : undefined;
        },
        tokenizer(src) {
          const parsed = readCallout(src);
          if (!parsed || !supportedCalloutTypes.has(parsed.type)) return undefined;
          return {
            type: 'callout',
            raw: parsed.raw,
            calloutType: parsed.type,
            titleTokens: this.lexer.inlineTokens(parsed.title || parsed.type.toUpperCase()),
            tokens: this.lexer.blockTokens(parsed.markdown),
          } satisfies CalloutToken;
        },
        renderer(token) {
          const calloutToken = token as CalloutToken;
          const title = this.parser.parseInline(calloutToken.titleTokens);
          const body = this.parser.parse(calloutToken.tokens);
          return `<div class="callout callout-${calloutToken.calloutType}"><div class="callout-title">${title}</div><div class="callout-content">${body}</div></div>\n`;
        },
        childTokens: ['titleTokens', 'tokens'],
      },
      {
        name: 'footnoteReference',
        level: 'inline',
        start(src) {
          const index = src.indexOf('[^');
          return index >= 0 ? index : undefined;
        },
        tokenizer(src) {
          const match = footnoteReferencePattern.exec(src);
          if (!match) return undefined;
          const id = match[1].trim();
          if (!definitions.has(id)) return undefined;
          return {
            type: 'footnoteReference',
            raw: match[0],
            definitionId: id,
          } satisfies FootnoteReferenceToken;
        },
        renderer(token) {
          const referenceToken = token as FootnoteReferenceToken;
          const definition = definitions.get(referenceToken.definitionId);
          if (!definition) return token.raw;

          const referenceSuffix = definition.referenceIds.length === 0
            ? ''
            : `-${definition.referenceIds.length + 1}`;
          const referenceId = `fnref-${definition.domId.slice(3)}${referenceSuffix}`;
          definition.referenceIds.push(referenceId);
          return `<sup id="${referenceId}" class="footnote-ref"><a href="#${definition.domId}">[${escapeHtmlText(definition.id)}]</a></sup>`;
        },
      },
    ],
    hooks: {
      postprocess(html) {
        if (definitions.size === 0) return html;
        const items = [...definitions.values()].map((definition) => {
          const backlinks = definition.referenceIds.map((referenceId, index) => (
            `<a href="#${referenceId}" class="footnote-backref" aria-label="返回脚注 ${escapeHtmlAttribute(definition.id)} 的第 ${index + 1} 个引用">↩</a>`
          )).join(' ');
          return `<li id="${definition.domId}">${definition.html}${backlinks ? `<span class="footnote-backrefs">${backlinks}</span>` : ''}</li>`;
        }).join('');
        return `${html}<section class="footnotes"><hr><ol>${items}</ol></section>`;
      },
    },
  };
}

function readFootnoteDefinition(src: string): { id: string; markdown: string; raw: string } | undefined {
  const first = readLine(src, 0);
  const match = /^\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/.exec(first.line);
  if (!match) return undefined;

  const id = match[1].trim();
  if (!id) return undefined;
  const body = [match[2]];
  let offset = first.end;

  while (offset < src.length) {
    const current = readLine(src, offset);
    if (isIndentedContinuation(current.line)) {
      body.push(stripContinuationIndent(current.line));
      offset = current.end;
      continue;
    }

    if (/^[ \t]*$/.test(current.line)) {
      const next = readLine(src, current.end);
      if (current.end < src.length && isIndentedContinuation(next.line)) {
        body.push('');
        offset = current.end;
        continue;
      }
    }
    break;
  }

  return {
    id,
    markdown: body.join('\n').trimEnd(),
    raw: src.slice(0, offset),
  };
}

function readCallout(src: string): { type: string; title: string; markdown: string; raw: string } | undefined {
  const block = /^(?: {0,3}>[^\r\n]*(?:\r?\n|$))+/.exec(src);
  if (!block) return undefined;

  const lines = block[0].replace(/\r?\n$/, '').split(/\r?\n/);
  const marker = /^ {0,3}>[ \t]?\[!([a-z][\w-]*)\](?:[+-])?(?:[ \t]+(.*))?[ \t]*$/i.exec(lines[0]);
  if (!marker) return undefined;

  return {
    type: marker[1].toLowerCase(),
    title: marker[2]?.trim() ?? '',
    markdown: lines.slice(1).map((line) => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n'),
    raw: block[0],
  };
}

function readLine(source: string, offset: number): { line: string; end: number } {
  const remainder = source.slice(offset);
  const newline = /\r?\n/.exec(remainder);
  if (!newline) return { line: remainder, end: source.length };
  return {
    line: remainder.slice(0, newline.index),
    end: offset + newline.index + newline[0].length,
  };
}

function isIndentedContinuation(line: string): boolean {
  return /^(?: {2,}|\t)/.test(line);
}

function stripContinuationIndent(line: string): string {
  if (line.startsWith('\t')) return line.slice(1);
  const spaces = /^ +/.exec(line)?.[0].length ?? 0;
  return line.slice(Math.min(spaces, spaces >= 4 ? 4 : 2));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createFootnoteDomId(
  id: string,
  fallbackIndex: number,
  definitions: ReadonlyMap<string, FootnoteDefinition>,
): string {
  const normalized = id
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = `fn-${normalized || fallbackIndex}`;
  const occupied = new Set([...definitions.values()].map((definition) => definition.domId));
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
