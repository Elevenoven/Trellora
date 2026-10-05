import { parseNoteFrontmatter, stringifyNoteFrontmatter } from '../../shared/frontmatter';

export function applyConfirmedTags(markdown: string, suggestedTags: string[]): { markdown: string; tags: string[] } {
  const parsed = parseNoteFrontmatter(markdown);
  const existing = normalizeTags(parsed.data.tags);
  const tags = [...new Set([...existing, ...normalizeTags(suggestedTags)])];
  if (!tags.length || tags.length === existing.length) return { markdown, tags: existing };
  return { markdown: stringifyNoteFrontmatter(parsed.content, { ...parsed.data, tags }), tags };
}

function normalizeTags(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return candidates.flatMap((candidate) => {
    const tag = String(candidate).trim().replace(/^#/, '').slice(0, 80);
    return tag ? [tag] : [];
  });
}
