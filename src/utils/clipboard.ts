/**
 * Copies plain text through the modern Clipboard API when available, with a
 * focused-document fallback for packaged or permission-restricted contexts.
 */
export async function copyPlainText(value: string): Promise<boolean> {
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Electron can deny Clipboard API access for a rendered local document.
      // Fall through to the focused-document fallback in that case.
    }
  }

  if (typeof document === 'undefined') return false;

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}
