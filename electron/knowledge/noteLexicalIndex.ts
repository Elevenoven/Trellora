import MiniSearch from 'minisearch';
import type { IndexedNote } from '../noteIndex';
import { normalizeTechnicalTerm, rejectsNumericVersionMismatch, resolveFuzzyRatio } from './lexicalMatchPolicy';

export interface NoteSearchDocument {
  id: string;
  title: string;
  path: string;
  content: string;
}

export type NoteLexicalIndex = MiniSearch<NoteSearchDocument>;

const SEARCH_RUN_PATTERN = /\p{Script=Han}+|[a-z0-9]+(?:[._:/-][a-z0-9]+)*(?:\+\+|#)?/gu;
const HAN_RUN_PATTERN = /^\p{Script=Han}+$/u;
const TECHNICAL_COMPONENT_SEPARATOR = /[._:/-]+/gu;

/**
 * Token contract shared by current-library and cross-library MiniSearch indexes.
 * Han bigrams never cross punctuation or field boundaries; technical identifiers
 * keep their exact normalized form while also exposing useful components.
 */
export function tokenizeNoteSearchText(value: string): string[] {
  const normalized = normalizeTechnicalTerm(value);
  if (!normalized) return [];

  const tokens: string[] = [];
  for (const match of normalized.matchAll(SEARCH_RUN_PATTERN)) {
    const run = match[0];
    if (HAN_RUN_PATTERN.test(run)) {
      const characters = Array.from(run);
      tokens.push(...characters);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`);
      }
      continue;
    }

    const expanded = new Set<string>([run]);
    for (const component of run.split(TECHNICAL_COMPONENT_SEPARATOR)) {
      if (component.length >= 2 && component !== run) expanded.add(component);
    }
    tokens.push(...expanded);
  }

  return tokens;
}

export function createNoteLexicalIndex(): NoteLexicalIndex {
  return new MiniSearch<NoteSearchDocument>({
    fields: ['title', 'content'],
    storeFields: ['title', 'path', 'content'],
    tokenize: tokenizeNoteSearchText,
    searchOptions: {
      boost: { title: 2 },
      fuzzy: (term: string) => resolveFuzzyRatio(term),
    },
  });
}

export function toNoteSearchDocument(
  note: Pick<IndexedNote, 'path' | 'title' | 'plainText' | 'tags'>,
): NoteSearchDocument {
  return {
    id: note.path,
    title: note.title,
    path: note.path,
    content: `${note.plainText}\n${note.tags.join(' ')}`,
  };
}

export function searchNoteLexically(index: NoteLexicalIndex, query: string) {
  return index
    .search(query, {
      prefix: true,
      fuzzy: (term: string) => resolveFuzzyRatio(term),
    })
    .filter((result) => !rejectsNumericVersionMismatch(query, `${result.title}\n${result.content}`));
}
