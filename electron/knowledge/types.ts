export interface KnowledgeHeading {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  index: number;
}

export interface KnowledgeWikiLink {
  target: string;
  alias?: string;
}

export interface MarkdownKnowledgeFacts {
  frontmatter: Record<string, unknown>;
  headings: KnowledgeHeading[];
  tags: string[];
  outgoingLinks: KnowledgeWikiLink[];
  plainText: string;
  contentHash: string;
}

export interface PersistedKnowledgeNote {
  path: string;
  relativePath: string;
  title: string;
  kind: string;
  extension: string;
  mtimeMs: number;
  facts: MarkdownKnowledgeFacts;
}

export interface IndexSyncResult {
  indexed: number;
  skipped: number;
  removed: number;
}

export interface VectorIndexEntry {
  notePath: string;
  contentHash: string;
  model: string;
  collection: string;
  pointId: string;
}
