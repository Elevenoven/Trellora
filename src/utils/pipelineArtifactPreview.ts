export type ArtifactPreviewMode = 'structured' | 'text' | 'json';

export interface ArtifactPreviewSourceRow {
  lineNumber: number;
  text: string;
}

export type ArtifactPreviewItemKind = 'tree' | 'parent' | 'child' | 'raw';

export interface ArtifactPreviewItem {
  lineNumber: number;
  rawText: string;
  prettyJson: string;
  record: Record<string, unknown> | null;
  kind: ArtifactPreviewItemKind;
  id: string | null;
  parentId: string | null;
  type: string | null;
  text: string;
  depth: number | null;
  ordinal: number | null;
  charCount: number | null;
  childCount: number | null;
  firstLineNo: number | null;
  lastLineNo: number | null;
  confidence: number | null;
  boundaryReason: string | null;
  overlapChars: number | null;
  sectionContext: string | null;
  sectionPath: string[];
}

const STRUCTURED_TREE_FILES = new Set(['structure.jsonl']);
const STRUCTURED_CHUNK_FILES = new Set(['parents.jsonl', 'children.jsonl', 'chunks.jsonl']);

export function getArtifactPreviewModes(stage: string, fileName: string): ArtifactPreviewMode[] {
  if (supportsStructuredArtifactPreview(stage, fileName)) return ['structured', 'text', 'json'];
  return /\.jsonl?$/i.test(fileName) ? ['json'] : ['text'];
}

export function getDefaultArtifactPreviewMode(stage: string, fileName: string): ArtifactPreviewMode {
  return getArtifactPreviewModes(stage, fileName)[0];
}

export function supportsStructuredArtifactPreview(stage: string, fileName: string): boolean {
  const normalizedName = fileName.toLowerCase();
  return (stage === 'tree' && STRUCTURED_TREE_FILES.has(normalizedName))
    || (stage === 'chunks' && STRUCTURED_CHUNK_FILES.has(normalizedName));
}

export function buildArtifactPreviewItems(rows: ArtifactPreviewSourceRow[], fileName: string): ArtifactPreviewItem[] {
  return rows.map((row) => buildArtifactPreviewItem(row, fileName));
}

function buildArtifactPreviewItem(row: ArtifactPreviewSourceRow, fileName: string): ArtifactPreviewItem {
  const parsed = parseJsonRecord(row.text);
  const record = parsed.record;
  const kind = resolveItemKind(record, fileName);
  const sourceText = stringField(record, 'sourceText');
  const renderedText = stringField(record, 'text');
  return {
    lineNumber: row.lineNumber,
    rawText: row.text,
    prettyJson: parsed.prettyJson,
    record,
    kind,
    id: kind === 'tree'
      ? stringField(record, 'nodeId')
      : kind === 'parent'
        ? stringField(record, 'parentId')
        : stringField(record, 'chunkId') ?? stringField(record, 'childId'),
    parentId: kind === 'tree' ? stringField(record, 'parentId') : stringField(record, 'parentChunkId'),
    type: stringField(record, 'type'),
    text: (kind === 'parent' || kind === 'child' ? sourceText ?? renderedText : renderedText ?? sourceText) ?? row.text,
    depth: numberField(record, 'depth'),
    ordinal: numberField(record, 'ordinal'),
    charCount: numberField(record, 'charCount'),
    childCount: numberField(record, 'childCount'),
    firstLineNo: numberField(record, 'firstLineNo'),
    lastLineNo: numberField(record, 'lastLineNo'),
    confidence: numberField(record, 'confidence'),
    boundaryReason: stringField(record, 'boundaryReason'),
    overlapChars: numberField(record, 'overlapChars'),
    sectionContext: stringField(record, 'sectionContext'),
    sectionPath: sectionPathLabels(record?.sectionPath),
  };
}

function parseJsonRecord(rawText: string): { record: Record<string, unknown> | null; prettyJson: string } {
  try {
    const value: unknown = JSON.parse(rawText);
    return {
      record: isRecord(value) ? value : null,
      prettyJson: JSON.stringify(value, null, 2),
    };
  } catch {
    return { record: null, prettyJson: rawText };
  }
}

function resolveItemKind(record: Record<string, unknown> | null, fileName: string): ArtifactPreviewItemKind {
  const normalizedName = fileName.toLowerCase();
  if (normalizedName === 'structure.jsonl' || stringField(record, 'nodeId')) return 'tree';
  if (normalizedName === 'parents.jsonl') return 'parent';
  if (normalizedName === 'children.jsonl' || normalizedName === 'chunks.jsonl' || stringField(record, 'chunkId')) return 'child';
  return 'raw';
}

function sectionPathLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = stringField(item, 'text');
    return label ? [label] : [];
  });
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
