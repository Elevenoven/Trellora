import type { EditorView } from '@tiptap/pm/view';
interface RectEdges { top: number; right: number; bottom: number; left: number }

/** Convert CSS-zoom-local DOM/selection rectangles to window viewport pixels. */
export function getNoteViewportRect(rect: RectEdges, element?: HTMLElement | null) {
  const surface = element?.closest<HTMLElement>('.editor-container, .source-editor-zoom');
  const zoom = Number(surface?.style.zoom) || 1;
  const bounds = surface?.getBoundingClientRect();
  // Electron versions differ in whether DOMRect includes CSS zoom. Measure instead of sniffing.
  const nativeScale = surface?.offsetWidth && bounds?.width ? bounds.width / surface.offsetWidth : 1;
  const factor = zoom / nativeScale;
  const top = rect.top * factor, right = rect.right * factor;
  const bottom = rect.bottom * factor, left = rect.left * factor;
  return { top, right, bottom, left, width: right - left, height: bottom - top };
}

/** Browser caret hit testing uses window pixels and avoids zoom-sensitive ProseMirror fallbacks. */
export function getNotePositionAtPoint(view: EditorView, point: { left: number; top: number }): number | null {
  const range = view.dom.ownerDocument.caretRangeFromPoint?.(point.left, point.top);
  if (range && view.dom.contains(range.startContainer)) {
    try { return view.posAtDOM(range.startContainer, range.startOffset); } catch { /* NodeView headers use the editor fallback. */ }
  }
  return view.posAtCoords(point)?.pos ?? null;
}
