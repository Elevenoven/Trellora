import type { Selection } from '@tiptap/pm/state';

export interface CodeBlockTextRange {
  from: number;
  to: number;
}

/** Returns the editable text range when the selection is inside one code block. */
export function getCurrentCodeBlockTextRange(selection: Selection): CodeBlockTextRange | null {
  const { $from, $to } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'codeBlock') continue;
    if ($to.depth < depth || $to.node(depth) !== $from.node(depth)) return null;
    return { from: $from.start(depth), to: $from.end(depth) };
  }
  return null;
}
