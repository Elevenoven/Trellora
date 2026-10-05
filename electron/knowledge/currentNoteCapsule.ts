import type { CurrentNoteSnapshot } from './currentNoteSnapshot';

export const CURRENT_NOTE_CAPSULE_SCHEMA_VERSION = 1;

export interface NoteCapsule {
  schemaVersion: typeof CURRENT_NOTE_CAPSULE_SCHEMA_VERSION;
  title: string;
  contentHash: string;
  lineCount: number;
  headings: Array<{ id: string; path: string[]; lineFrom: number; lineTo: number }>;
  tags: string[];
  wikiLinks: string[];
  topTerms: string[];
  structuralStats: Record<string, number>;
}

const MAX_CAPSULE_HEADINGS = 120;
const MAX_CAPSULE_TAGS = 40;
const MAX_CAPSULE_WIKI_LINKS = 40;
const MAX_CAPSULE_TOP_TERMS = 20;

/** Builds a local, repeatable note descriptor. It never asks a model to summarize. */
export function createNoteCapsule(snapshot: CurrentNoteSnapshot): NoteCapsule {
  const structuralCounts = new Map<string, number>();
  const termCounts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    structuralCounts.set(block.kind, (structuralCounts.get(block.kind) ?? 0) + 1);
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }
  const headings = snapshot.headings.slice(0, MAX_CAPSULE_HEADINGS).map((heading) => ({
    id: heading.headingId,
    path: [...heading.path],
    lineFrom: heading.lineFrom,
    lineTo: heading.lineTo,
  }));
  const structuralStats = Object.fromEntries([
    ...structuralCounts.entries(),
    ['headingsTotal', snapshot.headings.length],
    ['headingsIncluded', headings.length],
    ['headingsTruncated', snapshot.headings.length > headings.length ? 1 : 0],
  ].sort(([first], [second]) => compareText(first, second)));
  const topTerms = [...termCounts.entries()]
    .sort(([firstTerm, firstCount], [secondTerm, secondCount]) => secondCount - firstCount || compareText(firstTerm, secondTerm))
    .slice(0, MAX_CAPSULE_TOP_TERMS)
    .map(([term]) => term);
  return {
    schemaVersion: CURRENT_NOTE_CAPSULE_SCHEMA_VERSION,
    title: snapshot.title,
    contentHash: snapshot.contentHash,
    lineCount: snapshot.lineCount,
    headings,
    tags: extractTags(snapshot.markdown).slice(0, MAX_CAPSULE_TAGS),
    wikiLinks: extractWikiLinks(snapshot.markdown).slice(0, MAX_CAPSULE_WIKI_LINKS),
    topTerms,
    structuralStats,
  };
}

/** Fixed field order and newlines make this safe to use in a cacheable prefix. */
export function serializeNoteCapsule(capsule: NoteCapsule): string {
  return [
    `schemaVersion: ${capsule.schemaVersion}`,
    `title: ${JSON.stringify(capsule.title)}`,
    `contentHash: ${capsule.contentHash}`,
    `lineCount: ${capsule.lineCount}`,
    'headings:',
    ...capsule.headings.map((heading) => `- ${JSON.stringify({ id: heading.id, path: heading.path, lineFrom: heading.lineFrom, lineTo: heading.lineTo })}`),
    `tags: ${JSON.stringify(capsule.tags)}`,
    `wikiLinks: ${JSON.stringify(capsule.wikiLinks)}`,
    `topTerms: ${JSON.stringify(capsule.topTerms)}`,
    `structuralStats: ${JSON.stringify(capsule.structuralStats)}`,
  ].join('\n');
}

function extractTags(markdown: string): string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[\s(（])#([\p{L}\p{N}_/-]{1,48})/gmu)) values.add(match[1]);
  return [...values].sort(compareText);
}

function extractWikiLinks(markdown: string): string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/!?\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]+)?(?:\|[^\]\r\n]+)?\]\]/gu)) {
    const target = match[1].replace(/\s+/gu, ' ').trim();
    if (target) values.add(target);
  }
  return [...values].sort(compareText);
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
