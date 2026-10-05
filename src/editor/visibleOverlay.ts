/** Hidden, mounted panels must not consume editor shortcuts or pause caret following. */
export function hasVisibleOverlay(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some(element =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  );
}
