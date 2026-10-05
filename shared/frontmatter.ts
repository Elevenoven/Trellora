import { dump, load } from 'js-yaml';

export const MAX_FRONTMATTER_BYTES = 64 * 1024;
export interface NoteFrontmatter { data: Record<string, unknown>; content: string }

/** Parse data only; executable language headers are never dispatched to an engine. */
export function parseNoteFrontmatter(markdown: string): NoteFrontmatter {
  const opening = /^\uFEFF?---([^\r\n]*)\r?\n/.exec(markdown);
  if (!opening) return { data: {}, content: markdown };
  const language = opening[1].trim().toLowerCase();
  if (!['', 'yaml', 'yml', 'json'].includes(language)) throw new Error('不支持的 Frontmatter 格式。');
  const remaining = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remaining);
  if (!closing) throw new Error('Frontmatter 缺少闭合分隔符。');
  const source = remaining.slice(0, closing.index);
  return { data: parseFrontmatterMapping(source, language === 'json'), content: remaining.slice(closing.index + closing[0].length) };
}

/** Bound metadata size and expansion before recursive consumers see YAML aliases. */
export function parseFrontmatterMapping(source: string, json = false): Record<string, unknown> {
  if (new TextEncoder().encode(source).byteLength > MAX_FRONTMATTER_BYTES) throw new Error('Frontmatter 超过 64 KB 上限。');
  const parsed: unknown = json ? JSON.parse(source) : load(source);
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed instanceof Date) throw new Error('Frontmatter 必须是键值对象。');
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const validate = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) throw new Error('Frontmatter 结构过于复杂。');
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    if (ancestors.has(value)) throw new Error('Frontmatter 不能包含循环引用。');
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Frontmatter 包含不允许的字段。');
      validate(child, depth + 1);
    }
    ancestors.delete(value);
  };
  validate(parsed, 0);
  return parsed as Record<string, unknown>;
}

/** Serialize metadata with the YAML data engine while preserving body bytes as text. */
export function stringifyNoteFrontmatter(content: string, data: Record<string, unknown>): string {
  return `---\n${dump(data, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n${content}`;
}
