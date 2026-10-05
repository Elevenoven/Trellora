import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

const unclaimedEscapes = new WeakSet<KeyboardEvent>();

/** ProseMirror prevents Escape by default even when no editor plugin handles it. */
export const RichTextEscapeBoundary = Extension.create({
  name: 'richTextEscapeBoundary',
  priority: -10_000,
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleKeyDown: (_view, event) => {
      if (event.key === 'Escape' && !event.isComposing) unclaimedEscapes.add(event);
      return false;
    } } })];
  },
});

/** Real editor handlers still win; only ProseMirror's final fallback is ignored. */
export function canHandleEditorEscape(event: KeyboardEvent): boolean {
  return !event.isComposing && (!event.defaultPrevented || unclaimedEscapes.has(event));
}

/** Clear the fallback marker so this key cannot close a second UI layer. */
export function consumeEditorEscape(event: KeyboardEvent): void {
  unclaimedEscapes.delete(event);
  event.preventDefault();
}
