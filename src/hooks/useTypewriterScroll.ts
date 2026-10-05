import { useEffect, useRef } from 'react';
import { hasVisibleOverlay } from '../editor/visibleOverlay';
import { getNoteViewportRect } from '../editor/editorCoordinates';

export interface TypewriterTarget {
  scroller: HTMLElement;
  content: HTMLElement;
  caret: { top: number; bottom: number } | null;
  collapsed: boolean;
  requestMeasure?: () => void;
}

/** View-only caret following; navigation, manual scrolling and IME always take precedence. */
export function useTypewriterScroll({ enabled, active, getTarget, layoutKey, navigationKey, zoom = 1 }: {
  enabled: boolean; active: boolean; getTarget: () => TypewriterTarget | null;
  layoutKey: string; navigationKey: string; zoom?: number;
}) {
  const pausedUntil = useRef(0);
  const navigationPaused = useRef(false);
  const navigationRef = useRef(navigationKey);
  useEffect(() => {
    if (navigationRef.current !== navigationKey) navigationPaused.current = true;
    navigationRef.current = navigationKey;
  }, [navigationKey]);
  useEffect(() => {
    if (!enabled || !active) return;
    let frame = 0, composing = false, dragging = false;
    const initial = getTarget();
    if (!initial) return;
    const { scroller, content } = initial;
    const oldTop = content.style.paddingTop, oldBottom = content.style.paddingBottom;
    const measure = () => {
      const padding = Math.max(40, getNoteViewportRect(scroller.getBoundingClientRect(), scroller).height / (2 * zoom));
      content.style.paddingTop = `${padding}px`;
      content.style.paddingBottom = `${padding}px`;
      initial.requestMeasure?.();
    };
    const follow = () => {
      frame = 0;
      if (composing || dragging || navigationPaused.current || performance.now() < pausedUntil.current) return;
      if (!content.contains(document.activeElement)) return;
      if (hasVisibleOverlay('[role="dialog"], .selection-floating-toolbar, .selection-context-menu, .selection-edit-launcher, .selection-edit-suggestion, .code-language-popover, .cm-search, .cm-tooltip')) return;
      const target = getTarget();
      if (!target?.caret || !target.collapsed) return;
      const rect = getNoteViewportRect(scroller.getBoundingClientRect(), scroller);
      const delta = (target.caret.top + target.caret.bottom) / 2 - (rect.top + rect.height / 2);
      if (Math.abs(delta) < 2) return;
      // The source scroller may be inside CSS zoom, while the rich-text viewport is not.
      const scale = rect.height / scroller.clientHeight || 1;
      scroller.scrollTop += delta / scale;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(follow); };
    const resume = (event: Event) => {
      if (event instanceof KeyboardEvent && (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)) return;
      navigationPaused.current = false;
      schedule();
    };
    const startComposition = () => { composing = true; };
    const endComposition = () => { composing = false; resume(new Event('input')); };
    const manualScroll = () => { pausedUntil.current = performance.now() + 1000; };
    const pointerDown = () => { dragging = true; manualScroll(); };
    const pointerUp = () => { dragging = false; };
    const resize = () => { measure(); schedule(); };
    const observer = new ResizeObserver(resize);
    observer.observe(scroller);
    measure(); schedule();
    content.addEventListener('input', resume);
    content.addEventListener('keyup', resume);
    content.addEventListener('compositionstart', startComposition);
    content.addEventListener('compositionend', endComposition);
    scroller.addEventListener('wheel', manualScroll, { passive: true });
    scroller.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      content.style.paddingTop = oldTop; content.style.paddingBottom = oldBottom;
      initial.requestMeasure?.();
      content.removeEventListener('input', resume); content.removeEventListener('keyup', resume);
      content.removeEventListener('compositionstart', startComposition); content.removeEventListener('compositionend', endComposition);
      scroller.removeEventListener('wheel', manualScroll); scroller.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp);
    };
  }, [enabled, active, getTarget, layoutKey, zoom]);
}
