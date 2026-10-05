import type { MemoryCitationSnapshot } from '../../shared/memoryCitations';

export function memoryCitationElementId(turnId: string, reference: number): string {
  return `assistant-memory-citation-${encodeURIComponent(turnId)}-${reference}`;
}

/** Links only registered memory references; knowledge/web [N] markers are independent. */
export function formatMemoryCitationMarkdown(content: string, memories: readonly MemoryCitationSnapshot[], turnId: string): string {
  const available = registeredMemories(memories);
  return mapMemoryCitationProse(content, (reference, marker) => available.has(reference)
    ? `<a href="#${memoryCitationElementId(turnId, reference)}" data-memory-reference="${reference}" aria-label="记忆 ${reference}" title="查看记忆 ${reference}">记忆${reference}</a>`
    : marker);
}

export function getReferencedMemoryCitations(content: string, memories: readonly MemoryCitationSnapshot[]): MemoryCitationSnapshot[] {
  const available = registeredMemories(memories);
  const found: MemoryCitationSnapshot[] = [];
  const seen = new Set<number>();
  mapMemoryCitationProse(content, (reference, marker) => {
    const memory = available.get(reference);
    if (memory && !seen.has(reference)) { seen.add(reference); found.push(memory); }
    return marker;
  });
  return found;
}

function registeredMemories(memories: readonly MemoryCitationSnapshot[]): Map<number, MemoryCitationSnapshot> {
  const available = new Map<number, MemoryCitationSnapshot>();
  const ambiguous = new Set<number>();
  for (const memory of memories) {
    const reference = memory.reference;
    if (!Number.isSafeInteger(reference) || !reference || reference < 1) continue;
    if (available.has(reference) && available.get(reference)?.itemId !== memory.itemId) ambiguous.add(reference);
    else available.set(reference, memory);
  }
  for (const reference of ambiguous) available.delete(reference);
  return available;
}

/** Preserve code, escaped text and Markdown links while reading actual prose markers. */
function mapMemoryCitationProse(content: string, transform: (reference: number, marker: string) => string): string {
  let fence: { character: string; length: number } | undefined;
  return content.split(/\r?\n/u).map((line) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && line.slice(delimiter[0].length).trim() === '') fence = undefined;
      return line;
    }
    if (fence || /^(?: {4}|\t)|^ {0,3}\[[^\]]+\]:/u.test(line)) return line;
    let output = '', index = 0;
    while (index < line.length) {
      if (line[index] === '\\') { output += line.slice(index, index + 2); index += 2; continue; }
      if (line[index] === '`') {
        const opening = /^`+/u.exec(line.slice(index))![0];
        const runs = /`+/gu; runs.lastIndex = index + opening.length;
        let closing: RegExpExecArray | null;
        let end = index + opening.length;
        while ((closing = runs.exec(line))) if (closing[0].length === opening.length) { end = closing.index + closing[0].length; break; }
        output += line.slice(index, end); index = end; continue;
      }
      if (line[index] === '<') {
        const htmlLink = /^<a\b[^>]*>[\s\S]*?<\/a>/iu.exec(line.slice(index));
        const tag = htmlLink ?? /^<[^>]*>/u.exec(line.slice(index));
        if (tag) { output += tag[0]; index += tag[0].length; continue; }
      }
      if (line[index] === '[' || (line[index] === '!' && line[index + 1] === '[')) {
        const linkEnd = markdownLinkEnd(line, index);
        if (linkEnd > index) { output += line.slice(index, linkEnd); index = linkEnd; continue; }
      }
      const marker = /^\[记忆(\d+)\]/u.exec(line.slice(index));
      if (marker) {
        const reference = Number(marker[1]);
        output += Number.isSafeInteger(reference) && reference > 0 ? transform(reference, marker[0]) : marker[0];
        index += marker[0].length;
      } else output += line[index++];
    }
    return output;
  }).join('\n');
}

function markdownLinkEnd(line: string, start: number): number {
  let index = start + (line[start] === '!' ? 1 : 0), depth = 0;
  for (; index < line.length; index++) {
    if (line[index] === '\\') { index++; continue; }
    if (line[index] === '[') depth++;
    else if (line[index] === ']' && --depth === 0) { index++; break; }
  }
  const opening = line[index];
  if (depth !== 0 || (opening !== '(' && opening !== '[')) return start;
  const closing = opening === '(' ? ')' : ']';
  depth = 1;
  for (index++; index < line.length; index++) {
    if (line[index] === '\\') { index++; continue; }
    if (line[index] === opening) depth++;
    else if (line[index] === closing && --depth === 0) return index + 1;
  }
  return start;
}
