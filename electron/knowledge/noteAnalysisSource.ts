import { createHash } from 'node:crypto';
import { parseNoteFrontmatter } from '../../shared/frontmatter';

/**
 * Tags are a reviewable outcome of note analysis. Applying approved tags must
 * not make an otherwise unchanged analysis look stale, so the fingerprint
 * deliberately excludes the frontmatter `tags` field.
 */
export function getNoteAnalysisSourceHash(markdown: string): string {
  try {
    const parsed = parseNoteFrontmatter(markdown);
    const { tags: _tags, ...frontmatter } = parsed.data;
    const source = JSON.stringify({ frontmatter: toStableValue(frontmatter), content: parsed.content });
    return createHash('sha256').update(source, 'utf8').digest('hex');
  } catch {
    // A malformed frontmatter block must not prevent a user from editing or
    // analysing the remaining note. Fall back to the original source.
    return createHash('sha256').update(markdown, 'utf8').digest('hex');
  }
}

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStableValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second, 'en-US'))
      .map(([key, item]) => [key, toStableValue(item)]));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return String(value ?? '');
}
