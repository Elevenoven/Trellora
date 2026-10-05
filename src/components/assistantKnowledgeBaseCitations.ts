import type { AssistantKnowledgeBaseCitation, AssistantWebCitation } from '../electron';

const citationPattern = /\[(\d+)\](?!\()/gu;
const inlineCodePattern = /(`[^`]*`)/gu;
const fencePattern = /^\s*(`{3,}|~{3,})/u;

export function knowledgeBaseCitationElementId(reference: number): string {
  return `knowledge-base-citation-${reference}`;
}

/**
 * Only turn recognized citation markers in normal Markdown prose into links.
 * Code samples keep their original text, even if they happen to contain [3].
 * 联网引用与知识库引用共享同一引用号序列（联网搜索设计方案 §7.2）。
 */
export function formatKnowledgeBaseCitationMarkdown(
  content: string,
  citations: AssistantKnowledgeBaseCitation[],
  webCitations: ReadonlyArray<{ reference: number }> = [],
): string {
  const availableReferences = new Set([
    ...citations.map((citation) => citation.reference),
    ...webCitations.map((citation) => citation.reference),
  ]);
  return mapCitationProse(content, (reference, marker) => (
    availableReferences.has(reference)
      ? `<a href="#${knowledgeBaseCitationElementId(reference)}" aria-label="引用 ${reference}" title="查看引用 ${reference}">${reference}</a>`
      : marker
  ));
}

/** Returns only the evidence actually cited in the generated answer, in appearance order. */
export function getReferencedKnowledgeBaseCitations(
  content: string,
  citations: AssistantKnowledgeBaseCitation[],
): AssistantKnowledgeBaseCitation[] {
  const citationsByReference = new Map(citations.map((citation) => [citation.reference, citation]));
  const references: AssistantKnowledgeBaseCitation[] = [];
  const seen = new Set<number>();
  mapCitationProse(content, (reference, marker) => {
    const citation = citationsByReference.get(reference);
    if (citation && !seen.has(reference)) {
      seen.add(reference);
      references.push(citation);
    }
    return marker;
  });
  return references;
}

/** 终答实际引用到的网页证据，按出现顺序（联网搜索设计方案 §7.2）。 */
export function getReferencedWebCitations(
  content: string,
  webCitations: AssistantWebCitation[],
): AssistantWebCitation[] {
  const citationsByReference = new Map(webCitations.map((citation) => [citation.reference, citation]));
  const references: AssistantWebCitation[] = [];
  const seen = new Set<number>();
  mapCitationProse(content, (reference, marker) => {
    const citation = citationsByReference.get(reference);
    if (citation && !seen.has(reference)) {
      seen.add(reference);
      references.push(citation);
    }
    return marker;
  });
  return references;
}

function mapCitationProse(content: string, mapMarker: (reference: number, marker: string) => string): string {
  let inFence = false;
  return content.split(/\r?\n/u).map((line) => {
    if (fencePattern.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.split(inlineCodePattern).map((part, index) => (
      index % 2 === 1
        ? part
        : part.replace(citationPattern, (marker, digits: string) => {
          const reference = Number(digits);
          return Number.isSafeInteger(reference) && reference > 0 ? mapMarker(reference, marker) : marker;
        })
    )).join('');
  }).join('\n');
}
