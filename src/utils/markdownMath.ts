import katex from 'katex';
import type { MarkedExtension, Tokens } from 'marked';

export interface MarkdownMathToken extends Tokens.Generic {
  type: 'markdownMathBlock' | 'markdownMathInline';
  text: string;
  delimiter: '$' | '$$' | '\\(' | '\\[';
  displayMode: boolean;
}

/** Tokenize math outside code/escaped text; both editor and preview use this contract. */
export function createMathMarkdownExtension(render: (token: MarkdownMathToken) => string): MarkedExtension {
  return {
    extensions: ['block', 'inline'].map((level) => ({
      name: level === 'block' ? 'markdownMathBlock' : 'markdownMathInline',
      level: level as 'block' | 'inline',
      start(src: string) {
        const candidates = level === 'block' ? /^(?:\$\$|\\\[)/gm : /\$|\\[([]/g;
        for (const match of src.matchAll(candidates)) {
          if (isEscaped(src, match.index)) continue;
          if (readMath(src.slice(match.index), level === 'block')) return match.index;
        }
        return undefined;
      },
      tokenizer(src: string) {
        return readMath(src, level === 'block');
      },
      renderer(token: Tokens.Generic) {
        return render(token as MarkdownMathToken);
      },
    })),
  };
}

export function renderMathHtml(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    maxExpand: 1000,
  });
}

function readMath(src: string, block: boolean): MarkdownMathToken | undefined {
  const delimiter = src.startsWith('$$') ? '$$'
    : src.startsWith('$') ? '$'
      : src.startsWith('\\(') ? '\\('
        : src.startsWith('\\[') ? '\\[' : undefined;
  if (!delimiter || (block && delimiter !== '$$' && delimiter !== '\\[')) return undefined;
  if (src[delimiter.length] === '$') return undefined;
  const closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
  let end = src.indexOf(closing, delimiter.length);
  while (end >= 0 && isEscaped(src, end)) end = src.indexOf(closing, end + closing.length);
  if (end < 0 || (closing.startsWith('$') && src[end + closing.length] === '$')) return undefined;
  const inner = src.slice(delimiter.length, end);
  if (!inner.trim() || (!block && /[\r\n`]/.test(inner))) return undefined;
  if (block && !/^[ \t]*(?:\r?\n|$)/.test(src.slice(end + closing.length))) return undefined;
  // Escaped Wiki links/footnotes are ordinary Markdown, not bracket-delimited TeX.
  if (delimiter === '\\[' && (
    /^(?:\[|\\\[|\^)/.test(inner)
    || (!block && !/(?:\\[A-Za-z]+|[_^]\{|[=+*/-])/.test(inner))
  )) return undefined;
  // Do not pair separate dollar prices as math, e.g. "$5 and $10" or "$20 USD $".
  if (delimiter === '$' && /^\s*\d/.test(inner) && (
    /^\d/.test(src.slice(end + 1))
    || /^\s*\d[\d,.]*\s+[A-Za-z\u3400-\u9fff][^\\^_{}=+*/<>|]*$/.test(inner)
  )) return undefined;

  return {
    type: block ? 'markdownMathBlock' : 'markdownMathInline',
    raw: src.slice(0, end + closing.length),
    text: block
      ? inner.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '')
      : inner.trim(),
    delimiter,
    displayMode: delimiter === '$$' || delimiter === '\\[',
  };
}

function isEscaped(src: string, index: number): boolean {
  let backslashes = 0;
  while (src[index - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}
